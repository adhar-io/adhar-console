import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { lgtm } from '@adhar/api-clients'
import {
  Card,
  CardBody,
  CardHeader,
  GrafanaIcon,
  Sparkline,
  Spinner,
  TimeSeriesChart,
  type Threshold,
  type TimeSeries,
  usePollingInterval,
  usePublicUrl,
  useToolPublicUrl,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'

/**
 * Live metrics + the Grafana entry point for one catalog entity.
 *
 * The catalog knows a workload's name and (when annotated or deployed by
 * Argo CD) its Kubernetes namespace, which is all Prometheus needs: every
 * panel below is a real range query scoped to that workload (cAdvisor for
 * CPU/memory/network — present on every kubelet — and kube-state-metrics for
 * replicas/restarts). Nothing is synthesised: a panel with no series says the
 * metric isn't being collected for this workload.
 *
 * Scoping rule: the namespace is only pinned when it is KNOWN to be the
 * workload's Kubernetes namespace. A catalog entity's own namespace is a
 * catalog grouping, not a cluster namespace — scoping to it was why every
 * panel read "No series" for workloads that live in `adhar-system`.
 *
 * "Monitor" opens the same workload in Grafana (a dashboard when the install
 * pins one via `adhar.io/grafana-dashboard`, else Explore pre-filled with the
 * panel's query), so the deep dive continues where the operator expects it.
 */

const lgtmClient = lgtm.LgtmClient.auto({ tool: 'lgtm' })
const REFRESH_MS = 15_000

export interface EntityTarget {
  /** Workload name (Deployment/StatefulSet/DaemonSet). */
  name: string
  /** Kubernetes namespace, when known. Omitted → the pod name alone scopes the query. */
  namespace?: string
  /** `app.kubernetes.io/name` style label when the entity carries one. */
  appLabel?: string
}

type PanelGroup = 'resources' | 'workload' | 'network' | 'http'
type Unit = 'cores' | 'bytes' | 'bytes/s' | 'rps' | 'count' | 'percent' | 'ms'

interface SeriesDef {
  name: string
  query(t: EntityTarget): string
  dashed?: boolean
  color?: string
}

interface PanelDef {
  id: string
  label: string
  unit: Unit
  group: PanelGroup
  /** First series is the headline (filled area, KPI value); the rest are overlays. */
  series: SeriesDef[]
  hint: string
  /** For panels that only exist when the app exposes the metric — shown instead of "no series". */
  absent?: string
  thresholds?: Threshold[]
  /** Pin the top of the axis (percent panels). */
  yMax?: number
  /** Going up is bad (restarts, errors, throttling, latency): colour the delta accordingly. */
  upIsBad?: boolean
}

const GROUP_LABEL: Record<PanelGroup, { title: string; blurb: string }> = {
  resources: { title: 'Resources', blurb: 'What the pods use, and how close to their limits they run' },
  workload: { title: 'Workload', blurb: 'Replicas, restarts and kills — the rollout as Kubernetes sees it' },
  network: { title: 'Network', blurb: 'Bytes in and out of the pods' },
  http: { title: 'HTTP golden signals', blurb: 'Rate, errors and latency from the app’s own http_* metrics, when it exposes them' },
}
const GROUP_ORDER: PanelGroup[] = ['resources', 'workload', 'network', 'http']

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

/**
 * Pods that belong to this workload, by name shape:
 *   Deployment  → `<name>-<replicaset hash>-<pod hash>`
 *   DaemonSet   → `<name>-<pod hash>`
 *   StatefulSet → `<name>-<ordinal>`
 *
 * Hash segments are 5–10 lowercase alphanumerics. Anchoring on that shape is
 * what keeps `gitea` from also matching `gitea-postgresql-0` and
 * `gitea-valkey-primary-0` — which the old `(-[a-z0-9]+)*` did, so Gitea's
 * CPU quietly included its database.
 */
function podSelector(t: EntityTarget): string {
  const ns = t.namespace ? `namespace="${quoted(t.namespace)}",` : ''
  const n = regexQuoted(t.name)
  return `${ns}pod=~"${n}(-[a-z0-9]{5,10}){1,2}|${n}-[0-9]+"`
}

/** Ready replicas, for any workload kind — whichever kube-state metric answers wins. */
function readyReplicasQuery(t: EntityTarget): string {
  const ns = t.namespace ? `namespace="${quoted(t.namespace)}",` : ''
  const n = quoted(t.name)
  return [
    `max(kube_deployment_status_replicas_ready{${ns}deployment="${n}"})`,
    `max(kube_statefulset_status_replicas_ready{${ns}statefulset="${n}"})`,
    `max(kube_daemonset_status_number_ready{${ns}daemonset="${n}"})`,
  ].join(' or ')
}

/** Desired replicas, any workload kind — the line "ready" is measured against. */
function desiredReplicasQuery(t: EntityTarget): string {
  const ns = t.namespace ? `namespace="${quoted(t.namespace)}",` : ''
  const n = quoted(t.name)
  return [
    `max(kube_deployment_spec_replicas{${ns}deployment="${n}"})`,
    `max(kube_statefulset_replicas{${ns}statefulset="${n}"})`,
    `max(kube_daemonset_status_desired_number_scheduled{${ns}daemonset="${n}"})`,
  ].join(' or ')
}

const CONTAINERS = `container!="",container!="POD"`

const PANELS: PanelDef[] = [
  // ── resources ──
  {
    id: 'cpu',
    label: 'CPU',
    unit: 'cores',
    group: 'resources',
    hint: 'container_cpu_usage_seconds_total, 5m rate, against the CPU limit when one is set',
    series: [
      { name: 'used', query: (t) => `sum(rate(container_cpu_usage_seconds_total{${podSelector(t)},${CONTAINERS}}[5m]))` },
      { name: 'limit', dashed: true, query: (t) => `sum(kube_pod_container_resource_limits{${podSelector(t)},resource="cpu"})` },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    unit: 'bytes',
    group: 'resources',
    hint: 'container_memory_working_set_bytes, against the memory limit when one is set',
    series: [
      { name: 'working set', query: (t) => `sum(container_memory_working_set_bytes{${podSelector(t)},${CONTAINERS}})` },
      { name: 'limit', dashed: true, query: (t) => `sum(kube_pod_container_resource_limits{${podSelector(t)},resource="memory"})` },
    ],
  },
  {
    id: 'cpu-throttle',
    label: 'CPU throttling',
    unit: 'percent',
    group: 'resources',
    hint: 'share of CFS periods throttled, 5m — sustained throttling means the CPU limit is too low',
    yMax: 100,
    upIsBad: true,
    thresholds: [{ value: 25, label: '25% — raise the limit', color: 'var(--color-amber-500, #f59e0b)' }],
    series: [
      {
        name: 'throttled',
        query: (t) =>
          `100 * sum(rate(container_cpu_cfs_throttled_periods_total{${podSelector(t)},${CONTAINERS}}[5m])) / clamp_min(sum(rate(container_cpu_cfs_periods_total{${podSelector(t)},${CONTAINERS}}[5m])), 1)`,
      },
    ],
    absent: 'No CFS throttling series — the containers may have no CPU limit.',
  },
  {
    id: 'memory-limit',
    label: 'Memory vs limit',
    unit: 'percent',
    group: 'resources',
    hint: 'working set as a share of the memory limit — above 90% is OOM territory',
    yMax: 100,
    upIsBad: true,
    thresholds: [{ value: 90, label: '90% — OOM risk' }],
    series: [
      {
        name: 'of limit',
        query: (t) =>
          `100 * sum(container_memory_working_set_bytes{${podSelector(t)},${CONTAINERS}}) / clamp_min(sum(kube_pod_container_resource_limits{${podSelector(t)},resource="memory"}), 1)`,
      },
    ],
    absent: 'No memory limit set on these containers.',
  },
  // ── workload ──
  {
    id: 'replicas',
    label: 'Replicas',
    unit: 'count',
    group: 'workload',
    hint: 'ready replicas against the desired count — ready should sit on the dashed line',
    series: [
      { name: 'ready', query: readyReplicasQuery },
      { name: 'desired', dashed: true, query: desiredReplicasQuery },
    ],
  },
  {
    id: 'restarts',
    label: 'Restarts',
    unit: 'count',
    group: 'workload',
    hint: 'kube_pod_container_status_restarts_total, 1h increase',
    upIsBad: true,
    series: [{ name: 'restarts / 1h', query: (t) => `sum(increase(kube_pod_container_status_restarts_total{${podSelector(t)}}[1h]))` }],
  },
  {
    id: 'oom',
    label: 'OOM kills',
    unit: 'count',
    group: 'workload',
    hint: 'containers whose last termination was OOMKilled',
    upIsBad: true,
    series: [{ name: 'OOM killed', query: (t) => `sum(kube_pod_container_status_last_terminated_reason{${podSelector(t)},reason="OOMKilled"}) or vector(0)` }],
  },
  // ── network ──
  {
    id: 'network',
    label: 'Network',
    unit: 'bytes/s',
    group: 'network',
    hint: 'container_network_{receive,transmit}_bytes_total, 5m rate',
    series: [
      { name: 'in', query: (t) => `sum(rate(container_network_receive_bytes_total{${podSelector(t)}}[5m]))` },
      { name: 'out', color: 'var(--color-accent-500)', query: (t) => `sum(rate(container_network_transmit_bytes_total{${podSelector(t)}}[5m]))` },
    ],
  },
  // ── http ──
  {
    id: 'rps',
    label: 'Requests',
    unit: 'rps',
    group: 'http',
    hint: 'http_requests_total, 5m rate',
    series: [{ name: 'req/s', query: (t) => `sum(rate(http_requests_total{${podSelector(t)}}[5m]))` }],
    absent: 'Not instrumented — expose http_requests_total to see request rate.',
  },
  {
    id: 'errors',
    label: '5xx rate',
    unit: 'percent',
    group: 'http',
    hint: 'share of responses with a 5xx status, 5m',
    yMax: 100,
    upIsBad: true,
    thresholds: [{ value: 5, label: '5% error budget' }],
    series: [
      {
        name: '5xx',
        query: (t) =>
          `100 * sum(rate(http_requests_total{${podSelector(t)},status=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total{${podSelector(t)}}[5m])), 0.001)`,
      },
    ],
    absent: 'Not instrumented — needs http_requests_total with a status label.',
  },
  {
    id: 'p95',
    label: 'Latency',
    unit: 'ms',
    group: 'http',
    hint: 'histogram_quantile over http_request_duration_seconds, 5m',
    upIsBad: true,
    series: [
      { name: 'p95', query: (t) => `1000 * histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{${podSelector(t)}}[5m])))` },
      { name: 'p50', dashed: true, query: (t) => `1000 * histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket{${podSelector(t)}}[5m])))` },
    ],
    absent: 'Not instrumented — expose an http_request_duration_seconds histogram.',
  },
]

/** The four numbers at the top of the tab. Same queries as their panels, so React Query answers from cache. */
const KPI_IDS = ['cpu', 'memory', 'replicas', 'restarts'] as const

const RANGES = [
  { id: '1h', label: '1h', ms: 60 * 60_000, step: '1m' },
  { id: '6h', label: '6h', ms: 6 * 60 * 60_000, step: '5m' },
  { id: '24h', label: '24h', ms: 24 * 60 * 60_000, step: '15m' },
] as const
export type RangeId = (typeof RANGES)[number]['id']

/** [epoch ms, value] samples, several Prometheus series folded into one by summing per timestamp. */
type Samples = Array<[number, number]>

function fold(series: lgtm.MetricSeries[] | undefined): Samples {
  if (!series?.length) return []
  if (series.length === 1) {
    return series[0].values.map(([t, v]) => [Number(t) * 1000, Number(v)] as [number, number]).filter(([, v]) => Number.isFinite(v))
  }
  const byT = new Map<number, number>()
  for (const s of series) {
    for (const [t, v] of s.values) {
      const n = Number(v)
      if (!Number.isFinite(n)) continue
      const ms = Number(t) * 1000
      byT.set(ms, (byT.get(ms) ?? 0) + n)
    }
  }
  return [...byT.entries()].sort((a, b) => a[0] - b[0])
}

function useSeries(query: string, range: RangeId, enabled: boolean) {
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
    // One fast retry: a proxy reset or a Prometheus pod rolling painted every
    // panel "unavailable" until the next poll otherwise.
    retry: 1,
    retryDelay: 700,
    select: fold,
  })
}

/** Every series of a panel, as one hook call per series (stable order → stable hooks). */
function usePanelSeries(panel: PanelDef, target: EntityTarget, range: RangeId) {
  const enabled = Boolean(target.name)
  // Panels have at most two series; call the hook for both slots so the hook
  // order never changes between panels.
  const q0 = useSeries(panel.series[0].query(target), range, enabled)
  const q1 = useSeries(panel.series[1]?.query(target) ?? 'vector(0)', range, enabled && panel.series.length > 1)
  const queries = panel.series.length > 1 ? [q0, q1] : [q0]
  return {
    primary: q0,
    queries,
    isLoading: q0.isLoading,
    isError: q0.isError,
    error: q0.error,
    chart: panel.series.map((s, i) => ({
      name: s.name,
      color: s.color,
      dashed: s.dashed,
      points: queries[i]?.data ?? [],
    })) as TimeSeries[],
  }
}

function stats(samples: Samples) {
  const vals = samples.map(([, v]) => v)
  if (!vals.length) return null
  const last = vals[vals.length - 1]
  const first = vals[0]
  return {
    last,
    peak: Math.max(...vals),
    low: Math.min(...vals),
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
    delta: first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null,
  }
}

function Delta({ delta, upIsBad }: { delta: number | null; upIsBad?: boolean }) {
  if (delta === null || Math.abs(delta) < 1) return null
  const up = delta > 0
  const cls = upIsBad
    ? up ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-600 dark:text-emerald-400'
    : 'text-content-subtle'
  return (
    <span className={cn('font-mono text-[10px] tabular-nums', cls)} title="Change from the first to the last sample in this range">
      {up ? '▲' : '▼'} {Math.abs(delta).toFixed(0)}%
    </span>
  )
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
  const scope = target.namespace ? `${target.namespace}/${target.name}` : `${target.name} (any namespace)`
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-content">Live metrics</h3>
            <p className="text-[11px] text-content-subtle">
              {PANELS.length} panels from Prometheus, scoped to <span className="font-mono">{scope}</span> · last {range} · refreshes every {REFRESH_MS / 1000}s
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
      <CardBody className="space-y-6">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {KPI_IDS.map((id) => {
            const p = PANELS.find((x) => x.id === id)!
            return <KpiTile key={id} panel={p} target={target} range={range} />
          })}
        </div>
        {GROUP_ORDER.map((g) => {
          const panels = PANELS.filter((p) => p.group === g)
          return (
            <section key={g}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-content-subtle">{GROUP_LABEL[g].title}</h4>
                <span className="text-[11px] text-content-subtle">{GROUP_LABEL[g].blurb}</span>
              </div>
              <div className={cn('grid gap-3', panels.length > 1 && 'lg:grid-cols-2')}>
                {panels.map((p) => (
                  <MetricPanel key={p.id} panel={p} target={target} range={range} grafanaBase={grafanaUrl} />
                ))}
              </div>
            </section>
          )
        })}
      </CardBody>
    </Card>
  )
}

/** One headline number: the latest sample, its change over the window, and a sparkline. */
function KpiTile({ panel, target, range }: { panel: PanelDef; target: EntityTarget; range: RangeId }) {
  const { primary } = usePanelSeries(panel, target, range)
  const samples = primary.data ?? []
  const st = stats(samples)
  return (
    <div className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-3.5 py-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-content-subtle">{panel.label}</span>
        <Delta delta={st?.delta ?? null} upIsBad={panel.upIsBad} />
      </div>
      <div className="mt-1 font-mono text-[20px] font-semibold tabular-nums leading-none text-content">
        {primary.isLoading ? '…' : st ? fmt(st.last, panel.unit) : '—'}
      </div>
      <div className="mt-2 h-6">
        {samples.length > 1 ? <Sparkline points={samples.map(([, v]) => v)} height={24} color="var(--color-brand-500)" /> : null}
      </div>
    </div>
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
  const { primary, isLoading, isError, error, chart } = usePanelSeries(panel, target, range)
  const samples = primary.data ?? []
  const st = stats(samples)
  const query = panel.series[0].query(target)
  const explore = grafanaBase
    ? `${grafanaBase.replace(/\/$/, '')}/explore?left=${encodeURIComponent(JSON.stringify({ queries: [{ expr: query }], range: { from: `now-${range}`, to: 'now' } }))}`
    : ''
  const formatY = (v: number) => fmt(v, panel.unit)

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold text-content">{panel.label}</span>
          <span className="ml-2 hidden text-[10px] text-content-subtle sm:inline" title={panel.hint}>
            {panel.hint}
          </span>
        </div>
        <span className="flex shrink-0 items-baseline gap-2">
          <Delta delta={st?.delta ?? null} upIsBad={panel.upIsBad} />
          <span className="font-mono text-[13px] font-semibold tabular-nums text-content">
            {isLoading ? '…' : st ? fmt(st.last, panel.unit) : '—'}
          </span>
        </span>
      </div>
      <div className="mt-2">
        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-[11px] text-content-subtle">
            <Spinner size={12} />
          </div>
        ) : isError ? (
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-rose-300/60 px-3 text-center text-[11px] text-rose-700 dark:border-rose-500/30 dark:text-rose-300">
            Prometheus unavailable — {(error as Error)?.message?.slice(0, 80) ?? 'query failed'}
          </div>
        ) : samples.length === 0 ? (
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-edge-default px-3 text-center text-[11px] text-content-subtle">
            {panel.absent ?? "No series — this metric isn't collected for this workload."}
          </div>
        ) : (
          <TimeSeriesChart series={chart} height={160} formatY={formatY} thresholds={panel.thresholds} yMax={panel.yMax} />
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-content-subtle">
        <span>
          {st ? `min ${fmt(st.low, panel.unit)} · avg ${fmt(st.avg, panel.unit)} · peak ${fmt(st.peak, panel.unit)} · ${samples.length} samples` : ''}
        </span>
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
  return (
    <div className="divide-y divide-edge-subtle">
      {panels.map((p) => (
        <SparkTile key={p.id} panel={p} target={target} onOpen={onOpen} />
      ))}
    </div>
  )
}

function SparkTile({ panel, target, onOpen }: { panel: PanelDef; target: EntityTarget; onOpen(): void }) {
  const q = useSeries(panel.series[0].query(target), '1h', Boolean(target.name))
  const samples = q.data ?? []
  const last = samples.length ? samples[samples.length - 1][1] : null
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${panel.label} — ${panel.hint}. Open the Metrics tab`}
      className="flex w-full items-center gap-3 py-2 text-left transition-colors first:pt-0 last:pb-0 hover:text-brand-700 dark:hover:text-brand-300"
    >
      <span className="w-24 shrink-0 truncate text-[11px] font-medium text-content-muted">{panel.label}</span>
      <span className="min-w-0 flex-1">
        {q.isLoading || q.isError || samples.length === 0 ? (
          <span className="block text-[10px] text-content-subtle">{q.isLoading ? '…' : q.isError ? 'unavailable' : 'no series'}</span>
        ) : (
          <Sparkline points={samples.map(([t, v]) => ({ t, v }))} height={24} color="var(--color-brand-500)" />
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
        compact
          ? 'min-h-8 rounded-md bg-surface-raised px-2 py-1 text-[10px] text-content-muted ring-1 ring-edge-default hover:text-brand-700 dark:hover:text-brand-300 sm:min-h-0 sm:px-1.5'
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
  const pub = usePublicUrl()
  const url = useMemo(() => {
    if (!grafanaBase) return ''
    const base = grafanaBase.replace(/\/$/, '')
    if (pinned) {
      if (/^https?:/.test(pinned)) return pub(pinned, 'grafana')
      const [uid, slug] = pinned.split('/')
      return `${base}/d/${uid}${slug ? `/${slug}` : ''}?${varParams(target)}`
    }
    return `${base}/d/a164a7f0339f99e89cea5cb47e9be617/kubernetes-compute-resources-workload?${varParams(target)}`
  }, [grafanaBase, pinned, target, pub])
  return { url, grafanaBase }
}

function varParams(t: EntityTarget): string {
  const p = new URLSearchParams({ 'var-workload': t.name, 'var-type': 'deployment', refresh: '30s' })
  if (t.namespace) p.set('var-namespace', t.namespace)
  return p.toString()
}

function fmt(v: number, unit: Unit): string {
  switch (unit) {
    case 'bytes':
    case 'bytes/s': {
      const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let n = v
      let i = 0
      while (n >= 1024 && i < u.length - 1) {
        n /= 1024
        i++
      }
      return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}${unit === 'bytes/s' ? '/s' : ''}`
    }
    case 'cores':
      return v < 1 ? `${(v * 1000).toFixed(0)}m` : v.toFixed(2)
    case 'percent':
      return `${v.toFixed(1)}%`
    case 'rps':
      return `${v.toFixed(2)}/s`
    case 'ms':
      return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(0)} ms`
    default:
      return Number.isInteger(v) ? String(v) : v.toFixed(1)
  }
}
