import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { lgtm } from '@adhar/api-clients'
import {
  Card,
  CardBody,
  CardHeader,
  type Column,
  DataTable,
  Spinner,
  StatusBadge,
  type Threshold,
  type TimeSeries,
  TimeSeriesChart,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { usePersistentVolumeClaims, usePersistentVolumes, usePodMetrics, usePods, useStorageClasses } from '../data/hooks.ts'
import { formatBytes, formatCpu, parseQuantity } from '../data/format.ts'

/**
 * The detail under the cluster totals on the Metrics page.
 *
 *   - Capacity: CPU and memory as used / requested / limited / allocatable —
 *     the four numbers that decide whether the next pod schedules and whether
 *     the node is overcommitted.
 *   - Trends: the same over time from Prometheus (cAdvisor, kube-state-metrics,
 *     node-exporter), with node filesystem usage.
 *   - Namespaces: who uses and reserves what.
 *   - Storage: every PVC with its real fill level (kubelet volume stats),
 *     persistent volumes and storage classes.
 *
 * Every number is read live; a source that is not installed says so instead
 * of showing zero.
 */

const lgtmClient = lgtm.LgtmClient.auto({ tool: 'lgtm' })

const RANGES = [
  { id: '1h', ms: 3_600_000, step: '1m' },
  { id: '6h', ms: 21_600_000, step: '5m' },
  { id: '24h', ms: 86_400_000, step: '15m' },
] as const
type RangeId = (typeof RANGES)[number]['id']

function fold(series: lgtm.MetricSeries[] | undefined): Array<[number, number]> {
  const by = new Map<number, number>()
  for (const s of series ?? []) {
    for (const [t, v] of s.values) {
      const n = Number(v)
      if (Number.isFinite(n)) by.set(Number(t) * 1000, (by.get(Number(t) * 1000) ?? 0) + n)
    }
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0])
}

function useRange(query: string, range: RangeId, enabled = true) {
  const r = RANGES.find((x) => x.id === range) ?? RANGES[0]
  return useQuery({
    queryKey: ['platform', 'metrics-detail', query, range],
    queryFn: () => {
      const end = new Date()
      return lgtmClient.queryMetrics(query, new Date(end.getTime() - r.ms), end, r.step)
    },
    select: fold,
    refetchInterval: 30_000,
    retry: 1,
    enabled,
  })
}

/** Latest value per label set, from a short range (the client exposes range queries only). */
function useLatestBy(query: string, labels: string[]) {
  return useQuery({
    queryKey: ['platform', 'metrics-latest', query],
    queryFn: async () => {
      const end = new Date()
      const series = await lgtmClient.queryMetrics(query, new Date(end.getTime() - 5 * 60_000), end, '1m')
      const out = new Map<string, number>()
      for (const s of series) {
        const last = s.values[s.values.length - 1]
        if (!last) continue
        out.set(labels.map((l) => s.metric?.[l] ?? '').join('/'), Number(last[1]))
      }
      return out
    },
    refetchInterval: 60_000,
    retry: 1,
  })
}

/* ─────────── shared bits ─────────── */

type Resources = { requests?: Record<string, string>; limits?: Record<string, string> }
type PodLike = {
  metadata?: { name?: string; namespace?: string }
  spec?: { containers?: Array<{ resources?: Resources }>; initContainers?: Array<{ resources?: Resources }>; nodeName?: string }
  status?: { phase?: string }
}

function sumResources(pods: PodLike[]) {
  const out = { cpuReq: 0, cpuLim: 0, memReq: 0, memLim: 0 }
  for (const p of pods) {
    if (p.status?.phase !== 'Running' && p.status?.phase !== 'Pending') continue
    for (const c of p.spec?.containers ?? []) {
      out.cpuReq += parseQuantity(c.resources?.requests?.cpu)
      out.cpuLim += parseQuantity(c.resources?.limits?.cpu)
      out.memReq += parseQuantity(c.resources?.requests?.memory)
      out.memLim += parseQuantity(c.resources?.limits?.memory)
    }
  }
  return out
}

function Section({ title, hint, actions, children }: { title: string; hint?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-content">{title}</div>
            {hint ? <div className="text-[11px] text-content-subtle">{hint}</div> : null}
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  )
}

const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

/* ─────────── capacity ─────────── */

export function CapacityDetail({
  cpuAlloc,
  memAlloc,
  cpuUsed,
  memUsed,
  hasUsage,
}: {
  cpuAlloc: number
  memAlloc: number
  cpuUsed: number
  memUsed: number
  hasUsage: boolean
}) {
  const pods = usePods()
  const r = useMemo(() => sumResources((pods.data ?? []) as PodLike[]), [pods.data])
  return (
    <Section title="Capacity" hint="Used by containers, reserved by requests, capped by limits, against what the nodes can allocate">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <CapacityBar label="CPU" fmt={(v) => `${formatCpu(v)} cores`} used={hasUsage ? cpuUsed : undefined} req={r.cpuReq} lim={r.cpuLim} alloc={cpuAlloc} />
        <CapacityBar label="Memory" fmt={(v) => formatBytes(v)} used={hasUsage ? memUsed : undefined} req={r.memReq} lim={r.memLim} alloc={memAlloc} />
      </div>
    </Section>
  )
}

function CapacityBar({ label, fmt, used, req, lim, alloc }: { label: string; fmt(v: number): string; used?: number; req: number; lim: number; alloc: number }) {
  const w = (v: number) => `${Math.min(100, alloc > 0 ? (v / alloc) * 100 : 0)}%`
  const overcommit = lim > alloc && alloc > 0
  const rows: Array<[string, number | undefined, string]> = [
    ['Used', used, 'bg-brand-500'],
    ['Requested', req, 'bg-violet-500'],
    ['Limits', lim, overcommit ? 'bg-amber-500' : 'bg-slate-400'],
  ]
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-content">{label}</span>
        <span className="font-mono text-[11px] text-content-subtle">allocatable {fmt(alloc)}</span>
      </div>
      <div className="space-y-2">
        {rows.map(([name, v, color]) => (
          <div key={name} className="grid grid-cols-[5.5rem_minmax(0,1fr)_7.5rem] items-center gap-3 text-[12px]">
            <span className="text-content-muted">{name}</span>
            <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-sunken">
              {v !== undefined ? <div className={cn('h-full rounded-full', color)} style={{ width: w(v) }} /> : null}
            </div>
            <span className="text-right font-mono tabular-nums text-content">
              {v === undefined ? 'no metrics' : `${fmt(v)} · ${pctOf(v, alloc)}%`}
            </span>
          </div>
        ))}
      </div>
      <p className={cn('mt-2 text-[11px]', overcommit ? 'text-amber-700 dark:text-amber-300' : 'text-content-subtle')}>
        {overcommit
          ? `Limits are ${pctOf(lim, alloc)}% of allocatable — overcommitted; under pressure the kernel will throttle or OOM-kill.`
          : `${fmt(Math.max(0, alloc - req))} still unreserved for new pods.`}
      </p>
    </div>
  )
}

/* ─────────── trends ─────────── */

const C = `container!="",container!="POD"`
const FS = `fstype!~"tmpfs|overlay|squashfs|nsfs|ramfs"`

export function TrendsDetail() {
  const [range, setRange] = useState<RangeId>('1h')
  const cpuUsed = useRange(`sum(rate(container_cpu_usage_seconds_total{${C}}[5m]))`, range)
  const cpuReq = useRange(`sum(kube_pod_container_resource_requests{resource="cpu"})`, range)
  const cpuAlloc = useRange(`sum(kube_node_status_allocatable{resource="cpu"})`, range)
  const memUsed = useRange(`sum(container_memory_working_set_bytes{${C}})`, range)
  const memReq = useRange(`sum(kube_pod_container_resource_requests{resource="memory"})`, range)
  const memAlloc = useRange(`sum(kube_node_status_allocatable{resource="memory"})`, range)
  const fsUsed = useRange(`sum(node_filesystem_size_bytes{${FS}} - node_filesystem_avail_bytes{${FS}})`, range)
  const fsSize = useRange(`sum(node_filesystem_size_bytes{${FS}})`, range)
  const pvcUsed = useRange(`sum(kubelet_volume_stats_used_bytes)`, range)
  const pvcCap = useRange(`sum(kubelet_volume_stats_capacity_bytes)`, range)

  const loading = cpuUsed.isLoading
  const unavailable = cpuUsed.isError
  const chart = (series: TimeSeries[], fmt: (v: number) => string, thresholds?: Threshold[]) =>
    series.every((s) => s.points.length < 2) ? (
      <div className="flex h-44 items-center justify-center rounded-lg border border-dashed border-edge-default text-[12px] text-content-subtle">No samples — this metric is not collected here.</div>
    ) : (
      <TimeSeriesChart series={series} height={176} formatY={fmt} thresholds={thresholds} />
    )
  const lastOf = (q: { data?: Array<[number, number]> }) => q.data?.[q.data.length - 1]?.[1]
  const memAllocNow = lastOf(memAlloc)

  return (
    <Section
      title="Trends"
      hint="Prometheus · cAdvisor, kube-state-metrics and node-exporter · refreshes every 30s"
      actions={
        <div className="inline-flex rounded-lg border border-edge-default bg-surface-sunken p-0.5">
          {RANGES.map((r) => (
            <button key={r.id} type="button" onClick={() => setRange(r.id)} className={cn('h-7 rounded-md px-2.5 text-[11px] font-medium', range === r.id ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content')}>
              {r.id}
            </button>
          ))}
        </div>
      }
    >
      {loading ? (
        <div className="flex h-40 items-center justify-center gap-2 text-[12px] text-content-subtle"><Spinner size={12} /> Querying Prometheus…</div>
      ) : unavailable ? (
        <div className="rounded-lg border border-dashed border-edge-default p-6 text-center text-[12px] text-content-subtle">
          Prometheus is not reachable from the console ({(cpuUsed.error as Error)?.message?.slice(0, 80)}). Live totals above still come from metrics-server.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] font-semibold text-content">CPU (cores)</div>
            {chart(
              [
                { name: 'used', points: cpuUsed.data ?? [] },
                { name: 'requested', points: cpuReq.data ?? [], color: 'var(--color-violet-500, #8b5cf6)' },
                { name: 'allocatable', points: cpuAlloc.data ?? [], dashed: true, color: 'var(--color-content-subtle)' },
              ],
              (v) => formatCpu(v),
            )}
          </div>
          <div>
            <div className="mb-1 text-[12px] font-semibold text-content">Memory</div>
            {chart(
              [
                { name: 'working set', points: memUsed.data ?? [] },
                { name: 'requested', points: memReq.data ?? [], color: 'var(--color-violet-500, #8b5cf6)' },
                { name: 'allocatable', points: memAlloc.data ?? [], dashed: true, color: 'var(--color-content-subtle)' },
              ],
              (v) => formatBytes(v),
              memAllocNow ? [{ value: memAllocNow * 0.9, label: '90% of allocatable' }] : undefined,
            )}
          </div>
          <div>
            <div className="mb-1 text-[12px] font-semibold text-content">Node disk</div>
            {chart(
              [
                { name: 'used', points: fsUsed.data ?? [] },
                { name: 'size', points: fsSize.data ?? [], dashed: true, color: 'var(--color-content-subtle)' },
              ],
              (v) => formatBytes(v),
            )}
          </div>
          <div>
            <div className="mb-1 text-[12px] font-semibold text-content">Persistent volumes</div>
            {chart(
              [
                { name: 'used', points: pvcUsed.data ?? [] },
                { name: 'capacity', points: pvcCap.data ?? [], dashed: true, color: 'var(--color-content-subtle)' },
              ],
              (v) => formatBytes(v),
            )}
          </div>
        </div>
      )}
    </Section>
  )
}

/* ─────────── namespaces ─────────── */

interface NsRow {
  namespace: string
  pods: number
  cpuUsed: number
  memUsed: number
  cpuReq: number
  cpuLim: number
  memReq: number
  memLim: number
}

export function NamespaceDetail() {
  const pods = usePods()
  const metrics = usePodMetrics()
  const rows = useMemo(() => {
    const by = new Map<string, NsRow>()
    const row = (ns: string) => {
      let r = by.get(ns)
      if (!r) by.set(ns, (r = { namespace: ns, pods: 0, cpuUsed: 0, memUsed: 0, cpuReq: 0, cpuLim: 0, memReq: 0, memLim: 0 }))
      return r
    }
    for (const p of (pods.data ?? []) as PodLike[]) {
      const ns = p.metadata?.namespace ?? '—'
      const r = row(ns)
      r.pods++
      const s = sumResources([p])
      r.cpuReq += s.cpuReq
      r.cpuLim += s.cpuLim
      r.memReq += s.memReq
      r.memLim += s.memLim
    }
    for (const m of (metrics.data ?? []) as Array<{ metadata: { namespace?: string }; containers?: Array<{ usage?: { cpu?: string; memory?: string } }> }>) {
      const r = row(m.metadata.namespace ?? '—')
      for (const c of m.containers ?? []) {
        r.cpuUsed += parseQuantity(c.usage?.cpu)
        r.memUsed += parseQuantity(c.usage?.memory)
      }
    }
    return [...by.values()].sort((a, b) => b.cpuUsed - a.cpuUsed || b.memUsed - a.memUsed)
  }, [pods.data, metrics.data])
  const hasUsage = Array.isArray(metrics.data) && metrics.data.length > 0

  const ratio = (used: number, req: number) =>
    req > 0 ? <span className={cn('font-mono tabular-nums', used > req ? 'text-amber-700 dark:text-amber-300' : 'text-content-muted')}>{pctOf(used, req)}%</span> : <span className="text-content-subtle">—</span>
  const columns: Column<NsRow>[] = [
    { key: 'namespace', header: 'Namespace', cell: (r) => <span className="font-mono text-[12px] text-content">{r.namespace}</span>, value: (r) => r.namespace },
    { key: 'pods', header: 'Pods', align: 'right', cell: (r) => <span className="font-mono tabular-nums">{r.pods}</span>, value: (r) => r.pods },
    { key: 'cpu', header: 'CPU used', align: 'right', cell: (r) => <span className="font-mono tabular-nums">{hasUsage ? formatCpu(r.cpuUsed) : '—'}</span>, value: (r) => r.cpuUsed },
    { key: 'cpuReq', header: 'CPU req / lim', align: 'right', cell: (r) => <span className="font-mono tabular-nums text-content-muted">{formatCpu(r.cpuReq)} / {r.cpuLim ? formatCpu(r.cpuLim) : '∞'}</span>, value: (r) => r.cpuReq },
    { key: 'cpuEff', header: 'of request', align: 'right', cell: (r) => (hasUsage ? ratio(r.cpuUsed, r.cpuReq) : '—'), value: (r) => (r.cpuReq ? r.cpuUsed / r.cpuReq : 0) },
    { key: 'mem', header: 'Memory used', align: 'right', cell: (r) => <span className="font-mono tabular-nums">{hasUsage ? formatBytes(r.memUsed) : '—'}</span>, value: (r) => r.memUsed },
    { key: 'memReq', header: 'Mem req / lim', align: 'right', cell: (r) => <span className="font-mono tabular-nums text-content-muted">{formatBytes(r.memReq)} / {r.memLim ? formatBytes(r.memLim) : '∞'}</span>, value: (r) => r.memReq },
    { key: 'memEff', header: 'of request', align: 'right', cell: (r) => (hasUsage ? ratio(r.memUsed, r.memReq) : '—'), value: (r) => (r.memReq ? r.memUsed / r.memReq : 0) },
  ]
  return (
    <Section title="By namespace" hint="Usage from metrics-server; requests and limits from running and pending pods. Usage above request is highlighted.">
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.namespace} loading={pods.isLoading} />
    </Section>
  )
}

/* ─────────── storage ─────────── */

interface PvcRow {
  key: string
  name: string
  namespace: string
  phase: string
  storageClass: string
  capacity: number
  used?: number
  modes: string
  volume: string
}

export function StorageDetail() {
  const pvcs = usePersistentVolumeClaims()
  const pvs = usePersistentVolumes()
  const scs = useStorageClasses()
  const used = useLatestBy('kubelet_volume_stats_used_bytes', ['namespace', 'persistentvolumeclaim'])

  const rows: PvcRow[] = useMemo(
    () =>
      ((pvcs.data ?? []) as Array<{
        metadata: { name: string; namespace?: string; uid?: string }
        spec?: { storageClassName?: string; accessModes?: string[]; volumeName?: string; resources?: { requests?: { storage?: string } } }
        status?: { phase?: string; capacity?: { storage?: string } }
      }>).map((p) => ({
        key: p.metadata.uid ?? `${p.metadata.namespace}/${p.metadata.name}`,
        name: p.metadata.name,
        namespace: p.metadata.namespace ?? '—',
        phase: p.status?.phase ?? 'Unknown',
        storageClass: p.spec?.storageClassName ?? '—',
        capacity: parseQuantity(p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage),
        used: used.data?.get(`${p.metadata.namespace}/${p.metadata.name}`),
        modes: (p.spec?.accessModes ?? []).map((m) => m.replace('ReadWriteOnce', 'RWO').replace('ReadOnlyMany', 'ROX').replace('ReadWriteMany', 'RWX').replace('ReadWriteOncePod', 'RWOP')).join(', '),
        volume: p.spec?.volumeName ?? '—',
      })),
    [pvcs.data, used.data],
  )
  const totalCap = rows.reduce((s, r) => s + r.capacity, 0)
  const totalUsed = rows.reduce((s, r) => s + (r.used ?? 0), 0)
  const measured = rows.filter((r) => r.used !== undefined).length
  const nearlyFull = rows.filter((r) => r.used !== undefined && r.capacity > 0 && r.used / r.capacity > 0.85).length

  const columns: Column<PvcRow>[] = [
    {
      key: 'name',
      header: 'Claim',
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-[12px] text-content">{r.name}</div>
          <div className="truncate font-mono text-[10px] text-content-subtle">{r.namespace}</div>
        </div>
      ),
      value: (r) => `${r.namespace}/${r.name}`,
    },
    { key: 'phase', header: 'Status', cell: (r) => <StatusBadge kind={r.phase === 'Bound' ? 'healthy' : r.phase === 'Pending' ? 'progressing' : 'degraded'}>{r.phase}</StatusBadge>, value: (r) => r.phase },
    {
      key: 'usage',
      header: 'Usage',
      cell: (r) => {
        const p = r.used !== undefined && r.capacity > 0 ? Math.round((r.used / r.capacity) * 100) : null
        return (
          <div className="min-w-44">
            <div className="flex justify-between font-mono text-[11px] tabular-nums">
              <span className="text-content">{r.used !== undefined ? formatBytes(r.used) : '—'}</span>
              <span className="text-content-subtle">{formatBytes(r.capacity)}{p !== null ? ` · ${p}%` : ''}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              {p !== null ? <div className={cn('h-full rounded-full', p > 85 ? 'bg-rose-500' : p > 70 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, p)}%` }} /> : null}
            </div>
          </div>
        )
      },
      value: (r) => (r.used !== undefined && r.capacity ? r.used / r.capacity : -1),
    },
    { key: 'sc', header: 'Storage class', cell: (r) => <span className="font-mono text-[12px] text-content-muted">{r.storageClass}</span>, value: (r) => r.storageClass },
    { key: 'modes', header: 'Access', cell: (r) => <span className="font-mono text-[11px] text-content-muted">{r.modes || '—'}</span>, value: (r) => r.modes },
    { key: 'volume', header: 'Volume', cell: (r) => <span className="block max-w-48 truncate font-mono text-[11px] text-content-subtle" title={r.volume}>{r.volume}</span>, value: (r) => r.volume },
  ]

  const classes = (scs.data ?? []) as Array<{
    metadata: { name: string; annotations?: Record<string, string> }
    provisioner?: string
    reclaimPolicy?: string
    volumeBindingMode?: string
    allowVolumeExpansion?: boolean
  }>
  const pvList = (pvs.data ?? []) as Array<{ status?: { phase?: string } }>
  const pvBy = (phase: string) => pvList.filter((p) => p.status?.phase === phase).length

  return (
    <Section title="Storage" hint="Claims with their fill level from kubelet volume stats, persistent volumes and storage classes">
      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Mini label="Claims" value={String(rows.length)} sub={`${rows.filter((r) => r.phase === 'Bound').length} bound · ${rows.filter((r) => r.phase !== 'Bound').length} not bound`} />
        <Mini label="Provisioned" value={formatBytes(totalCap)} sub={measured ? `${formatBytes(totalUsed)} used across ${measured} measured` : 'no kubelet volume stats'} />
        <Mini label="Nearly full" value={String(nearlyFull)} sub="claims above 85%" tone={nearlyFull ? 'rose' : undefined} />
        <Mini label="Volumes" value={String(pvList.length)} sub={`${pvBy('Bound')} bound · ${pvBy('Available')} available · ${pvBy('Released')} released`} />
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.key} loading={pvcs.isLoading} />
      <div className="mt-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Storage classes</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {classes.map((c) => {
            const isDefault = c.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
            const claims = rows.filter((r) => r.storageClass === c.metadata.name)
            return (
              <div key={c.metadata.name} className="rounded-lg border border-edge-default bg-surface-raised px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[12px] font-semibold text-content">{c.metadata.name}</span>
                  {isDefault ? <StatusBadge kind="info" className="px-1.5 py-0 text-[10px]" dot={false}>default</StatusBadge> : null}
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-content-subtle">{c.provisioner}</div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-content-muted">
                  <span>reclaim {c.reclaimPolicy ?? 'Delete'}</span>
                  <span>{c.volumeBindingMode === 'WaitForFirstConsumer' ? 'binds on first use' : 'binds immediately'}</span>
                  <span>{c.allowVolumeExpansion ? 'expandable' : 'fixed size'}</span>
                  <span>{claims.length} claim{claims.length === 1 ? '' : 's'} · {formatBytes(claims.reduce((s, r) => s + r.capacity, 0))}</span>
                </div>
              </div>
            )
          })}
          {classes.length === 0 && !scs.isLoading ? <p className="text-[12px] text-content-subtle">No storage classes.</p> : null}
        </div>
      </div>
    </Section>
  )
}

function Mini({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'rose' }) {
  return (
    <div className="rounded-lg border border-edge-default bg-surface-raised px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-content-subtle">{label}</div>
      <div className={cn('mt-0.5 font-mono text-[17px] font-semibold tabular-nums', tone === 'rose' ? 'text-rose-700 dark:text-rose-300' : 'text-content')}>{value}</div>
      <div className="truncate text-[11px] text-content-muted">{sub}</div>
    </div>
  )
}
