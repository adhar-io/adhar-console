import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Card,
  CardBody,
  CardHeader,
  DonutGauge,
  Skeleton,
  Sparkline,
  StatusBadge,
  type StatusKind,
} from '@adhar/shell-ui'
import { kube } from '@adhar/api-clients/k8s'
import type { KubeList } from '@adhar/api-clients/k8s'
import { cn } from '@adhar/utils'
import { age, formatBytes } from '../data/format.ts'
import { composedRefs, type XrLike } from '../data/xr-ops.ts'
import { lastValue, promInstant, promRange, scalarOf, toPoints } from '../data/prom.ts'
import {
  backupPhaseKind,
  CNPG_GVR,
  cnpgClusterRef,
  databaseQueries,
  formatPercent,
  formatRate,
  lagStatus,
  sortBackups,
  summarizeCnpg,
  type CnpgBackup,
  type CnpgCluster,
} from '../data/database-insight.ts'

/**
 * The management view of a `Database` XR: what the composed CloudNativePG
 * cluster is doing right now and how it has been behaving.
 *
 * Layered so each part degrades on its own:
 *  - topology, replication, backup, storage and certificates come from the
 *    CNPG `Cluster` status (10s poll) — present whenever the database exists;
 *  - the backup history is the cluster's `Backup` objects;
 *  - traffic (connections, transactions, cache hit, size) and replication lag
 *    come from the `cnpg_*` series in Prometheus — when Prometheus is not
 *    reachable the tiles say so and everything above stays.
 *
 * A Database composed on another engine (the Redis-backed variant) has no
 * CNPG cluster and renders nothing here; the generic drawer still shows it.
 */

type RangeKey = '15m' | '1h' | '6h'
const RANGES: Record<RangeKey, { seconds: number; step: number }> = {
  '15m': { seconds: 900, step: 15 },
  '1h': { seconds: 3600, step: 30 },
  '6h': { seconds: 21_600, step: 120 },
}

export function DatabaseInsightSection({ xr, cluster }: { xr: XrLike; cluster?: string }) {
  const ref = cnpgClusterRef(composedRefs(xr))
  if (!ref?.name) return null
  const ns = ref.namespace ?? xr.metadata.namespace
  return <CnpgInsight name={ref.name} namespace={ns} cluster={cluster} />
}

function CnpgInsight({ name, namespace, cluster }: { name: string; namespace?: string; cluster?: string }) {
  const [range, setRange] = useState<RangeKey>('1h')

  const clusterQ = useQuery({
    queryKey: ['platform', 'cnpg', 'cluster', cluster ?? '-', namespace ?? '-', name],
    queryFn: () => kube.get<CnpgCluster>(CNPG_GVR.cluster, namespace, name, { cluster }),
    refetchInterval: 10_000,
    retry: false,
  })

  const backupsQ = useQuery({
    queryKey: ['platform', 'cnpg', 'backups', cluster ?? '-', namespace ?? '-', name],
    queryFn: () =>
      kube.list<CnpgBackup>(CNPG_GVR.backup, { namespace, cluster, labelSelector: `cnpg.io/cluster=${name}` }),
    refetchInterval: 30_000,
    retry: false,
    select: (list: KubeList<CnpgBackup>) => sortBackups(list.items ?? []),
  })

  const summary = clusterQ.data ? summarizeCnpg(clusterQ.data) : undefined
  const q = databaseQueries(name, namespace ?? 'default')

  const seriesQ = useQuery({
    queryKey: ['platform', 'cnpg', 'series', cluster ?? '-', namespace ?? '-', name, range],
    queryFn: async () => {
      const cfg = RANGES[range]
      const [connections, transactions, cacheHit, size, rowsWritten, rowsRead] = await Promise.all([
        promRange(q.connections, cfg),
        promRange(q.transactions, cfg),
        promRange(q.cacheHit, cfg),
        promRange(q.size, cfg),
        promRange(q.rowsWritten, cfg),
        promRange(q.rowsRead, cfg),
      ])
      return {
        connections: connections[0],
        transactions: transactions[0],
        cacheHit: cacheHit[0],
        size: size[0],
        rowsWritten: rowsWritten[0],
        rowsRead: rowsRead[0],
      }
    },
    refetchInterval: 30_000,
    retry: false,
    enabled: Boolean(summary),
  })

  const instantQ = useQuery({
    queryKey: ['platform', 'cnpg', 'instant', cluster ?? '-', namespace ?? '-', name],
    queryFn: async () => {
      const [maxConn, lag, archiveFail, deadlocks] = await Promise.all([
        promInstant(q.maxConnections),
        promInstant(q.replicationLag),
        promInstant(q.archiveFailures),
        promInstant(q.deadlocks),
      ])
      return {
        maxConnections: scalarOf(maxConn),
        replicationLag: scalarOf(lag),
        archiveFailures: scalarOf(archiveFail),
        deadlocks: scalarOf(deadlocks),
      }
    },
    refetchInterval: 30_000,
    retry: false,
    enabled: Boolean(summary),
  })

  const metricsDown = seriesQ.isError || instantQ.isError
  const metricsError = (seriesQ.error ?? instantQ.error) as Error | undefined

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-content">Database</div>
            <div className="mt-0.5 text-xs text-content-muted">
              CloudNativePG cluster <span className="font-mono">{name}</span>
              {summary?.majorVersion ? ` · PostgreSQL ${summary.majorVersion}` : ''}
            </div>
          </div>
          {summary ? (
            <div title={summary.phaseReason} className="inline-flex">
              <StatusBadge kind={summary.phaseKind}>{summary.phase}</StatusBadge>
            </div>
          ) : clusterQ.isError ? (
            <StatusBadge kind="unknown">Cluster not readable</StatusBadge>
          ) : (
            <Skeleton width={120} height={22} rounded="lg" />
          )}
        </div>
      </CardHeader>
      <CardBody>
        {clusterQ.isError ? (
          <div className="text-sm text-content-muted">
            The composed cluster <span className="font-mono">{name}</span> could not be read:{' '}
            {(clusterQ.error as Error)?.message ?? 'unknown error'}. It may still be provisioning, or your role
            cannot read <span className="font-mono">clusters.postgresql.cnpg.io</span>.
          </div>
        ) : !summary ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={92} rounded="lg" />)}
          </div>
        ) : (
          <div className="space-y-5">
            {/* ─── Health at a glance ─── */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <InsightTile
                label="Instances"
                kind={summary.readyInstances >= summary.instances && summary.instances > 0 ? 'healthy' : 'degraded'}
                value={`${summary.readyInstances}/${summary.instances}`}
                caption={summary.primary ? `primary ${summary.primary}` : 'no primary elected'}
                detail={summary.primarySince ? `primary for ${age(summary.primarySince)}` : undefined}
              />
              <InsightTile
                label="Replication"
                kind={summary.replication.kind}
                value={summary.replication.replicas === 0 ? '1 node' : `${summary.replication.replicas} replica${
                  summary.replication.replicas === 1 ? '' : 's'
                }`}
                caption={summary.replication.label}
                detail={
                  summary.replication.replicas > 0
                    ? `lag ${lagStatus(instantQ.data?.replicationLag, summary.replication.replicas).label}` +
                      (summary.timeline !== undefined ? ` · timeline ${summary.timeline}` : '')
                    : summary.timeline !== undefined
                      ? `timeline ${summary.timeline}`
                      : undefined
                }
              />
              <InsightTile
                label="Backup"
                kind={summary.backup.kind}
                value={summary.backup.enabled
                  ? summary.backup.lastSuccessful ? age(summary.backup.lastSuccessful) : '—'
                  : 'off'}
                caption={summary.backup.label}
                detail={summary.backup.firstRecoverabilityPoint
                  ? `recoverable since ${age(summary.backup.firstRecoverabilityPoint)} ago` +
                    (summary.backup.retention ? ` · keeps ${summary.backup.retention}` : '')
                  : summary.backup.retention
                    ? `keeps ${summary.backup.retention}`
                    : undefined}
              />
              <InsightTile
                label="Storage"
                kind={summary.storage.kind}
                value={summary.storage.size ?? '—'}
                caption={summary.storage.pvcCount > 0
                  ? `${summary.storage.healthyPvc}/${summary.storage.pvcCount} volumes healthy`
                  : 'no volumes reported'}
                detail={summary.certificates.daysLeft !== undefined
                  ? `TLS ${summary.certificates.daysLeft < 0 ? 'EXPIRED' : `renews in ${summary.certificates.daysLeft}d`}`
                  : undefined}
                detailKind={summary.certificates.kind}
              />
            </div>

            {/* ─── Traffic ─── */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">Traffic</div>
                <div className="inline-flex rounded-lg border border-edge-default p-0.5" role="tablist" aria-label="Window">
                  {(Object.keys(RANGES) as RangeKey[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="tab"
                      aria-selected={range === k}
                      onClick={() => setRange(k)}
                      className={cn(
                        'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
                        range === k
                          ? 'bg-surface-raised text-content shadow-sm'
                          : 'text-content-muted hover:text-content',
                      )}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>
              {metricsDown ? (
                <div className="rounded-xl border border-dashed border-edge-default px-4 py-3 text-xs text-content-muted">
                  Traffic metrics unavailable — {metricsError?.message ?? 'Prometheus did not answer'}. Topology,
                  backups and certificates above come from the cluster itself and are current.
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <ConnectionsTile
                    current={lastValue(seriesQ.data?.connections)}
                    max={instantQ.data?.maxConnections}
                    points={toPoints(seriesQ.data?.connections)}
                    loading={seriesQ.isLoading}
                  />
                  <SeriesTile
                    label="Transactions"
                    value={formatRate(lastValue(seriesQ.data?.transactions), ' tx/s')}
                    points={toPoints(seriesQ.data?.transactions)}
                    color="#2563eb"
                    loading={seriesQ.isLoading}
                    caption={`rows ${formatRate(lastValue(seriesQ.data?.rowsWritten), '')} written · ${
                      formatRate(lastValue(seriesQ.data?.rowsRead), '')
                    } read /s`}
                  />
                  <SeriesTile
                    label="Cache hit"
                    value={formatPercent(lastValue(seriesQ.data?.cacheHit))}
                    points={toPoints(seriesQ.data?.cacheHit)}
                    color={(lastValue(seriesQ.data?.cacheHit) ?? 1) < 0.9 ? '#d97706' : '#059669'}
                    loading={seriesQ.isLoading}
                    caption={instantQ.data?.deadlocks
                      ? `${formatRate(instantQ.data.deadlocks, '')} deadlocks/s`
                      : 'shared buffers vs disk reads'}
                  />
                  <SeriesTile
                    label="Size on disk"
                    value={lastValue(seriesQ.data?.size) !== undefined
                      ? formatBytes(lastValue(seriesQ.data?.size) as number)
                      : '—'}
                    points={toPoints(seriesQ.data?.size)}
                    color="#7c3aed"
                    loading={seriesQ.isLoading}
                    caption={summary.storage.size ? `of ${summary.storage.size} volume` : 'all databases'}
                    warn={instantQ.data?.archiveFailures
                      ? `${instantQ.data.archiveFailures} WAL archive failure${
                        instantQ.data.archiveFailures === 1 ? '' : 's'
                      }`
                      : undefined}
                  />
                </div>
              )}
            </div>

            {/* ─── Members + endpoints ─── */}
            <div className="grid gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-content-subtle">Instances</div>
                <div className="overflow-hidden rounded-xl border border-edge-default">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-raised text-[11px] uppercase tracking-wide text-content-subtle">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Instance</th>
                        <th className="px-3 py-2 text-left font-medium">Role</th>
                        <th className="px-3 py-2 text-left font-medium">State</th>
                        <th className="px-3 py-2 text-left font-medium">Timeline</th>
                        <th className="px-3 py-2 text-left font-medium">Volume</th>
                        <th className="px-3 py-2 text-left font-medium">Address</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-edge-default">
                      {summary.members.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-3 py-3 text-content-muted">No instances reported yet.</td>
                        </tr>
                      ) : (
                        summary.members.map((m) => (
                          <tr key={m.name}>
                            <td className="px-3 py-2 font-mono">{m.name}</td>
                            <td className="px-3 py-2">
                              <StatusBadge kind={m.role === 'primary' ? 'info' : 'unknown'} dot={false}>
                                {m.role}
                              </StatusBadge>
                            </td>
                            <td className="px-3 py-2">
                              <StatusBadge kind={m.healthy ? 'healthy' : 'degraded'}>
                                {m.healthy ? 'healthy' : 'not ready'}
                              </StatusBadge>
                            </td>
                            <td className="px-3 py-2 font-mono">{m.timeline ?? '—'}</td>
                            <td className="px-3 py-2">
                              <span className={m.pvcHealthy ? 'text-content' : 'text-rose-600 dark:text-rose-300'}>
                                {m.pvcHealthy ? 'bound' : 'unhealthy'}
                              </span>
                            </td>
                            <td className="px-3 py-2 font-mono text-content-muted">{m.ip ?? '—'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="lg:col-span-2">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-content-subtle">Endpoints</div>
                <div className="divide-y divide-edge-default rounded-xl border border-edge-default px-3">
                  <EndpointRow label="Read / write" host={summary.endpoints.rw} namespace={namespace} />
                  <EndpointRow label="Read only" host={summary.endpoints.ro} namespace={namespace} />
                  <EndpointRow label="Any" host={summary.endpoints.r} namespace={namespace} />
                </div>
                {summary.image ? (
                  <div className="mt-2 truncate font-mono text-[11px] text-content-subtle" title={summary.image}>
                    {summary.image}
                  </div>
                ) : null}
              </div>
            </div>

            {/* ─── Backups ─── */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">Backups</div>
                {summary.backup.destination ? (
                  <div className="truncate font-mono text-[11px] text-content-subtle" title={summary.backup.destination}>
                    {summary.backup.destination}
                    {summary.backup.target ? ` · from ${summary.backup.target}` : ''}
                  </div>
                ) : null}
              </div>
              {!summary.backup.enabled ? (
                <div className="rounded-xl border border-dashed border-edge-default px-4 py-3 text-xs text-content-muted">
                  No object-store backup is configured for this database. Set{' '}
                  <span className="font-mono">parameters.enableBackup: true</span> to get a daily base backup and
                  continuous WAL archiving.
                </div>
              ) : backupsQ.isError ? (
                <div className="text-xs text-content-muted">Backup history not readable.</div>
              ) : (backupsQ.data?.length ?? 0) === 0 ? (
                <div className="text-xs text-content-muted">
                  {backupsQ.isLoading ? 'Loading…' : 'No backup objects yet — the first scheduled run has not happened.'}
                </div>
              ) : (
                <ul className="divide-y divide-edge-default rounded-xl border border-edge-default">
                  {backupsQ.data!.slice(0, 5).map((b) => (
                    <li key={b.metadata.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <StatusBadge kind={backupPhaseKind(b.status?.phase)}>{b.status?.phase ?? 'pending'}</StatusBadge>
                        <span className="truncate font-mono">{b.metadata.name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-content-muted">
                        <span>{b.spec?.method ?? 'barmanObjectStore'}</span>
                        <span title={b.status?.startedAt ?? b.metadata.creationTimestamp}>
                          {age(b.status?.startedAt ?? b.metadata.creationTimestamp)} ago
                        </span>
                        {b.status?.error ? (
                          <span className="max-w-[18rem] truncate text-rose-600 dark:text-rose-300" title={b.status.error}>
                            {b.status.error}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/* ───── tiles ───── */

const VALUE_TONE: Record<StatusKind, string> = {
  healthy: 'text-emerald-700 dark:text-emerald-300',
  degraded: 'text-rose-700 dark:text-rose-300',
  failed: 'text-rose-700 dark:text-rose-300',
  progressing: 'text-sky-700 dark:text-sky-300',
  paused: 'text-amber-700 dark:text-amber-300',
  unknown: 'text-content',
  info: 'text-content',
}

function InsightTile({
  label,
  kind,
  value,
  caption,
  detail,
  detailKind,
}: {
  label: string
  kind: StatusKind
  value: string
  caption: string
  detail?: string
  detailKind?: StatusKind
}) {
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">{label}</div>
        <StatusBadge kind={kind} dot pulse={false}>
          {kind === 'healthy' ? 'ok' : kind === 'info' || kind === 'unknown' ? '·' : kind}
        </StatusBadge>
      </div>
      <div className={cn('mt-2 font-mono text-[22px] font-semibold tabular-nums leading-none', VALUE_TONE[kind])}>
        {value}
      </div>
      <div className="mt-1.5 text-xs text-content-muted">{caption}</div>
      {detail ? (
        <div
          className={cn(
            'mt-0.5 text-[11px]',
            detailKind && detailKind !== 'healthy' && detailKind !== 'unknown' && detailKind !== 'info'
              ? VALUE_TONE[detailKind]
              : 'text-content-subtle',
          )}
        >
          {detail}
        </div>
      ) : null}
    </div>
  )
}

function SeriesTile({
  label,
  value,
  points,
  color,
  caption,
  warn,
  loading,
}: {
  label: string
  value: string
  points: ReturnType<typeof toPoints>
  color: string
  caption?: string
  warn?: string
  loading: boolean
}) {
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">{label}</div>
      {loading ? (
        <Skeleton className="mt-2" width={90} height={24} />
      ) : (
        <div className="mt-1.5 font-mono text-[20px] font-semibold tabular-nums leading-none text-content">{value}</div>
      )}
      <div className="mt-2 h-9">
        {loading ? <Skeleton height={36} /> : points.length > 1 ? (
          <Sparkline points={points} color={color} height={36} width="100%" />
        ) : (
          <div className="flex h-full items-center text-[11px] text-content-subtle">no samples in window</div>
        )}
      </div>
      {warn ? (
        <div className="mt-1.5 text-[11px] text-rose-600 dark:text-rose-300">{warn}</div>
      ) : caption ? (
        <div className="mt-1.5 truncate text-[11px] text-content-subtle" title={caption}>{caption}</div>
      ) : null}
    </div>
  )
}

function ConnectionsTile({
  current,
  max,
  points,
  loading,
}: {
  current?: number
  max?: number
  points: ReturnType<typeof toPoints>
  loading: boolean
}) {
  const ratio = current !== undefined && max ? current / max : undefined
  const color = ratio === undefined ? '#64748b' : ratio >= 0.9 ? '#e11d48' : ratio >= 0.7 ? '#d97706' : '#059669'
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-content-subtle">Connections</div>
      <div className="mt-1.5 flex items-center gap-3">
        {loading ? (
          <Skeleton width={52} height={52} rounded="lg" />
        ) : (
          <DonutGauge
            value={current ?? 0}
            max={max && max > 0 ? max : Math.max(current ?? 0, 1)}
            size={52}
            thickness={6}
            color={color}
            label={<span className="font-mono text-[11px] font-semibold">{current ?? '—'}</span>}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[20px] font-semibold tabular-nums leading-none text-content">
            {loading ? <Skeleton width={70} height={22} /> : current !== undefined ? Math.round(current) : '—'}
          </div>
          <div className="mt-1 text-[11px] text-content-subtle">
            {max ? `of ${max} max_connections${ratio !== undefined ? ` · ${Math.round(ratio * 100)}%` : ''}` : 'backends'}
          </div>
          <div className="mt-1 h-5">
            {points.length > 1 ? <Sparkline points={points} color={color} height={20} width="100%" /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function EndpointRow({ label, host, namespace }: { label: string; host?: string; namespace?: string }) {
  if (!host) return null
  const fqdn = namespace ? `${host}.${namespace}.svc:5432` : `${host}:5432`
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="shrink-0 text-xs text-content-muted">{label}</span>
      <button
        type="button"
        className="group min-w-0 truncate font-mono text-xs text-content hover:text-brand-700 dark:hover:text-brand-300"
        title="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(fqdn)
        }}
      >
        {fqdn}
      </button>
    </div>
  )
}
