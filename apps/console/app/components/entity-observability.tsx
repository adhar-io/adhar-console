import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { lgtm } from '@adhar-console/api-clients'
import {
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  GrafanaIcon,
  Spinner,
  usePollingInterval,
  useToolPublicUrl, Sparkline } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'

/**
 * Live metrics + the Grafana entry point for one catalog entity.
 *
 * The catalog knows a workload's name and namespace, which is all Prometheus
 * needs: every panel below is a real range query scoped to that workload
 * (cAdvisor for CPU/memory/network — present on every kubelet — and
 * kube-state-metrics for replicas/restarts). Nothing is synthesised: a panel
 * with no series says the metric isn't being collected for this workload.
 *
 * "Monitor" opens the same workload in Grafana (a dashboard when the install
 * pins one via `adhar.io/grafana-dashboard`, else Explore pre-filled with the
 * panel's query), so the deep dive continues where the operator expects it.
 */

const lgtmClient = lgtm.LgtmClient.auto({ tool: 'lgtm' })
const REFRESH_MS = 15_000

export interface EntityTarget {
  /** Workload name (Deployment/StatefulSet/Pod prefix). */
  name: string
  namespace?: string
  /** `app.kubernetes.io/name` style label when the entity carries one. */
  appLabel?: string
}

interface PanelDef {
  id: string
  label: string
  unit: 'cores' | 'bytes' | 'rps' | 'count' | 'percent'
  query(t: EntityTarget): string
  hint: string
}

/**
 * PromQL label values are double-quoted strings: a name containing `"` or `\`
 * ends the string early and the query fails to parse, which shows up as the
 * whole tab erroring rather than as one malformed panel. Regex metacharacters
 * are escaped too — a workload with a `.` in its name would otherwise match any
 * character there.
 */
function quoted(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
function regexQuoted(v: string): string {
  return quoted(v).replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)
}

/** `pod=~"<name>(-hash)*"` — Deployments own ReplicaSet-suffixed pods. */
function podSelector(t: EntityTarget): string {
  const ns = t.namespace ? `namespace="${quoted(t.namespace)}",` : ''
  return `${ns}pod=~"${regexQuoted(t.name)}(-[a-z0-9]+)*"`
}

/**
 * Ready replicas, for any workload kind.
 *
 * This used to ask only `kube_deployment_status_replicas_ready`, so a
 * StatefulSet or DaemonSet — a database, a queue consumer, a node agent — always
 * rendered "No series", which reads as "metrics are broken" rather than "this
 * panel asked the wrong question". kube-state-metrics publishes a different
 * metric per kind, so all three are asked and whichever answers wins.
 */
function readyReplicasQuery(t: EntityTarget): string {
  const ns = t.namespace ? `namespace="${quoted(t.namespace)}",` : ''
  const n = quoted(t.name)
  return [
    `max(kube_deployment_status_replicas_ready{${ns}deployment="${n}"})`,
    `max(kube_statefulset_status_replicas_ready{${ns}statefulset="${n}"})`,
    `max(kube_daemonset_status_number_ready{${ns}daemonset="${n}"})`,
  ].join(' or ')
}

const PANELS: PanelDef[] = [
  {
    id: 'cpu',
    label: 'CPU',
    unit: 'cores',
    hint: 'container_cpu_usage_seconds_total, 5m rate',
    query: (t) => `sum(rate(container_cpu_usage_seconds_total{${podSelector(t)},container!="",container!="POD"}[5m]))`,
  },
  {
    id: 'memory',
    label: 'Memory',
    unit: 'bytes',
    hint: 'container_memory_working_set_bytes',
    query: (t) => `sum(container_memory_working_set_bytes{${podSelector(t)},container!="",container!="POD"})`,
  },
  {
    id: 'network',
    label: 'Network in',
    unit: 'bytes',
    hint: 'container_network_receive_bytes_total, 5m rate',
    query: (t) => `sum(rate(container_network_receive_bytes_total{${podSelector(t)}}[5m]))`,
  },
  {
    id: 'replicas',
    label: 'Ready replicas',
    unit: 'count',
    hint: 'kube_{deployment,statefulset,daemonset} ready replicas',
    query: readyReplicasQuery,
  },
  {
    id: 'restarts',
    label: 'Restarts (1h)',
    unit: 'count',
    hint: 'kube_pod_container_status_restarts_total, 1h increase',
    query: (t) => `sum(increase(kube_pod_container_status_restarts_total{${podSelector(t)}}[1h]))`,
  },
]

const RANGES = [
  { id: '1h', label: '1h', ms: 60 * 60_000, step: '1m' },
  { id: '6h', label: '6h', ms: 6 * 60 * 60_000, step: '5m' },
  { id: '24h', label: '24h', ms: 24 * 60 * 60_000, step: '15m' },
] as const
export type RangeId = (typeof RANGES)[number]['id']

function usePanel(query: string, range: RangeId, enabled: boolean) {
  const r = RANGES.find((x) => x.id === range) ?? RANGES[0]
  return useQuery({
    queryKey: ['entity-metrics', query, range],
    queryFn: () => {
      const end = new Date()
      const start = new Date(end.getTime() - r.ms)
      return lgtmClient.queryMetrics(query, start, end, r.step)
    },
    refetchInterval: usePollingInterval(REFRESH_MS),
    enabled,
    // `retry: false` meant one transient failure — a proxy connection reset, a
    // Prometheus pod rolling — painted all five panels "unavailable" until the
    // next 15s poll. Opening the tab during that window is indistinguishable
    // from metrics being broken, so allow one fast retry.
    retry: 1,
    retryDelay: 700,
  })
}

export function EntityMetrics({
  target,
  range,
  onRange,
  grafanaUrl,
}: {
  target: EntityTarget
  range: RangeId
  onRange(r: RangeId): void
  grafanaUrl: string
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-content">Live metrics</h3>
            <p className="text-[11px] text-content-subtle">
              Prometheus, scoped to {target.namespace ? `${target.namespace}/` : ''}
              {target.name} · refreshes every {REFRESH_MS / 1000}s
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center rounded-lg border border-edge-default bg-surface-sunken p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onRange(r.id)}
                  className={cn(
                    'h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors',
                    range === r.id ? 'bg-surface-raised text-content shadow-sm ring-1 ring-edge-default' : 'text-content-muted hover:text-content',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {grafanaUrl ? <MonitorButton url={grafanaUrl} /> : null}
          </div>
        </div>
      </CardHeader>
      <CardBody>
        <div className="grid gap-3 sm:grid-cols-2">
          {PANELS.map((p) => (
            <MetricPanel key={p.id} panel={p} target={target} range={range} grafanaBase={grafanaUrl} />
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

function MetricPanel({
  panel,
  target,
  range,
  grafanaBase,
}: {
  panel: PanelDef
  target: EntityTarget
  range: RangeId
  grafanaBase: string
}) {
  const query = useMemo(() => panel.query(target), [panel, target])
  const q = usePanel(query, range, Boolean(target.name))
  const series = q.data ?? []
  const points = useMemo(() => series.flatMap((s) => s.values.map(([, v]) => Number(v))).filter((n) => Number.isFinite(n)), [series])
  const last = points.length ? points[points.length - 1] : null
  const peak = points.length ? Math.max(...points) : null
  const explore = grafanaBase ? `${grafanaBase.replace(/\/$/, '')}/explore?left=${encodeURIComponent(JSON.stringify({ queries: [{ expr: query }], range: { from: `now-${range}`, to: 'now' } }))}` : ''

  return (
    <div className="rounded-xl border border-edge-subtle bg-surface-sunken/30 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-semibold text-content">{panel.label}</span>
        <span className="font-mono text-[11px] tabular-nums text-content-muted">
          {q.isLoading ? '…' : last === null ? '—' : fmt(last, panel.unit)}
        </span>
      </div>
      <div className="mt-1.5">
        {q.isLoading ? (
          <div className="flex h-14 items-center justify-center text-[11px] text-content-subtle">
            <Spinner size={12} />
          </div>
        ) : q.isError ? (
          <div className="flex h-14 items-center text-[11px] text-content-subtle">
            Prometheus unavailable — {(q.error as Error)?.message?.slice(0, 60) ?? 'query failed'}
          </div>
        ) : points.length === 0 ? (
          <div className="flex h-14 items-center text-[11px] text-content-subtle">
            No series — this metric isn't collected for this workload.
          </div>
        ) : (
          <AreaChart points={points} color="var(--color-brand-500)" height={56} showAxis={false} />
        )}
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-content-subtle">
        <span title={panel.hint}>{peak !== null ? `peak ${fmt(peak, panel.unit)}` : panel.hint}</span>
        {explore ? (
          <a href={explore} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-300">
            open in Grafana ↗
          </a>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Three sparklines for the drawer's Overview: CPU, memory, ready replicas
 * over the last hour. Same queries as the Metrics tab, so the tab is the
 * same picture at full size — this is the glance, that is the look.
 */
export function EntitySparklines({ target, onOpen }: { target: EntityTarget; onOpen(): void }) {
  const panels = PANELS.filter((p) => p.id === 'cpu' || p.id === 'memory' || p.id === 'replicas')
  // Rows, not three tiles across: in a 300px column three tiles left the
  // labels as "C…" / "M…" / "R…".
  return (
    <div className="divide-y divide-edge-subtle">
      {panels.map((p) => (
        <SparkTile key={p.id} panel={p} target={target} onOpen={onOpen} />
      ))}
    </div>
  )
}

function SparkTile({ panel, target, onOpen }: { panel: PanelDef; target: EntityTarget; onOpen(): void }) {
  const query = useMemo(() => panel.query(target), [panel, target])
  const q = usePanel(query, '1h', Boolean(target.name))
  const series = q.data ?? []
  const points = useMemo(
    () => series.flatMap((s) => s.values.map(([t, v]) => ({ t: Number(t) * 1000, v: Number(v) }))).filter((pt) => Number.isFinite(pt.v)),
    [series],
  )
  const last = points.length ? points[points.length - 1].v : null
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${panel.label} — ${panel.hint}. Open the Metrics tab`}
      className="flex w-full items-center gap-3 py-2 text-left transition-colors first:pt-0 last:pb-0 hover:text-brand-700 dark:hover:text-brand-300"
    >
      <span className="w-24 shrink-0 truncate text-[11px] font-medium text-content-muted">{panel.label}</span>
      <span className="min-w-0 flex-1">
        {q.isLoading || q.isError || points.length === 0 ? (
          <span className="block text-[10px] text-content-subtle">{q.isLoading ? '…' : q.isError ? 'unavailable' : 'no series'}</span>
        ) : (
          <Sparkline points={points} height={24} color="var(--color-brand-500)" />
        )}
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-content">
        {q.isLoading ? '…' : last === null ? '—' : fmt(last, panel.unit)}
      </span>
    </button>
  )
}

export function MonitorButton({ url, compact = false }: { url: string; compact?: boolean }) {
  if (!url) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Open this workload's Grafana dashboard"
      className={cn(
        'inline-flex items-center gap-1.5 font-medium transition-colors',
        // A link out, so it looks like the other links beside it (Source,
        // Docs) rather than like the page's one primary action. The filled
        // brand button made "open Grafana" the loudest thing in every drawer.
        compact
          ? 'rounded-md bg-surface-raised px-1.5 py-1 text-[10px] text-content-muted ring-1 ring-edge-default hover:text-brand-700 dark:hover:text-brand-300'
          : 'rounded-lg border border-edge-default bg-surface-raised px-3 py-2 text-xs text-content-muted shadow-sm hover:border-brand-200 hover:text-brand-700 dark:hover:border-brand-500/25 dark:hover:text-brand-300',
      )}
    >
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">
        <GrafanaIcon />
      </span>
      Monitor
    </a>
  )
}

/**
 * Where "Monitor" points: an explicitly pinned dashboard
 * (`adhar.io/grafana-dashboard` — uid or full URL) when the entity has one,
 * otherwise Grafana's Kubernetes workload view for this namespace/workload,
 * which the kube-prometheus stack ships by default.
 */
export function useGrafanaMonitorUrl(target: EntityTarget, pinned?: string): { url: string; grafanaBase: string } {
  const grafanaBase = useToolPublicUrl('grafana')
  const url = useMemo(() => {
    if (!grafanaBase) return ''
    const base = grafanaBase.replace(/\/$/, '')
    if (pinned) {
      if (/^https?:/.test(pinned)) return pinned
      const [uid, slug] = pinned.split('/')
      return `${base}/d/${uid}${slug ? `/${slug}` : ''}?${varParams(target)}`
    }
    // kube-prometheus-stack's "Kubernetes / Compute Resources / Workload".
    return `${base}/d/a164a7f0339f99e89cea5cb47e9be617/kubernetes-compute-resources-workload?${varParams(target)}`
  }, [grafanaBase, pinned, target])
  return { url, grafanaBase }
}

function varParams(t: EntityTarget): string {
  const p = new URLSearchParams({ 'var-workload': t.name, 'var-type': 'deployment', refresh: '30s' })
  if (t.namespace) p.set('var-namespace', t.namespace)
  return p.toString()
}

function fmt(v: number, unit: PanelDef['unit']): string {
  switch (unit) {
    case 'bytes': {
      const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let n = v
      let i = 0
      while (n >= 1024 && i < u.length - 1) {
        n /= 1024
        i++
      }
      return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
    }
    case 'cores':
      return v < 1 ? `${(v * 1000).toFixed(0)}m` : v.toFixed(2)
    case 'percent':
      return `${v.toFixed(1)}%`
    case 'rps':
      return `${v.toFixed(2)}/s`
    default:
      return Number.isInteger(v) ? String(v) : v.toFixed(1)
  }
}
