import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart,
  BarChart,
  DonutGauge,
  EmptyState,
  Skeleton,
  Sparkline,
  StatusBadge,
  type SeriesPoint,
} from '@adhar-console/shell-ui'
import { client, LOCAL_CLUSTER } from '../data/client.ts'
import { formatBytes, formatCpu, parseQuantity } from '../data/format.ts'

/**
 * Depth metrics for a single pod, in two independent layers that degrade
 * gracefully on their own:
 *
 *  1. **Live snapshot** — instantaneous CPU / memory per container from
 *     `metrics.k8s.io/v1beta1` (metrics-server), polled every 10s. Always shown
 *     when metrics-server is present.
 *  2. **Time-series** — real historical graphs from **Prometheus**, proxied by
 *     the BFF at `/api/svc/prometheus/api/v1/query_range`. CPU vs requests/limits
 *     with CFS throttling, memory working-set vs requests/limits, network RX/TX,
 *     filesystem I/O, and a per-container breakdown, over a selectable window
 *     (15m / 1h / 6h / 24h).
 *
 * When Prometheus isn't wired the time-series layer shows an honest setup note
 * and the panel falls back to the live snapshot only. Restart / OOM indicators
 * come straight off the pod's own status.
 */

const POLL_MS = 10_000
const PROM_BASE = '/api/svc/prometheus'

type RangeKey = '15m' | '1h' | '6h' | '24h'
interface RangeCfg {
  label: RangeKey
  seconds: number
  step: number
  rate: string
}
const RANGES: RangeCfg[] = [
  { label: '15m', seconds: 900, step: 15, rate: '1m' },
  { label: '1h', seconds: 3600, step: 30, rate: '2m' },
  { label: '6h', seconds: 21_600, step: 120, rate: '5m' },
  { label: '24h', seconds: 86_400, step: 600, rate: '10m' },
]

interface ContainerResources {
  name: string
  resources?: {
    requests?: { cpu?: string; memory?: string }
    limits?: { cpu?: string; memory?: string }
  }
}

/* ───── Prometheus client (BFF proxy) ───── */

interface PromMatrix {
  metric: Record<string, string>
  values: Array<[number, string]>
}
interface PromResponse {
  status: string
  error?: string
  data?: { resultType: string; result: PromMatrix[] }
}

async function promRange(query: string, cfg: RangeCfg): Promise<PromMatrix[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - cfg.seconds
  const params = new URLSearchParams({
    query,
    start: String(start),
    end: String(end),
    step: String(cfg.step),
  })
  const res = await fetch(`${PROM_BASE}/api/v1/query_range?${params.toString()}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Prometheus request failed (${res.status} ${res.statusText})`)
  const json = (await res.json()) as PromResponse
  if (json.status !== 'success' || !json.data) throw new Error(json.error ?? 'Prometheus query failed')
  return json.data.result
}

/** A single matrix series → chart points (v in native units, t in ms). */
function toPoints(series: PromMatrix | undefined): SeriesPoint[] {
  if (!series) return []
  return series.values.map(([t, v]) => ({ v: Number(v), t: t * 1000 }))
}

/** Last numeric value of a series (the "current" reading). */
function lastValue(series: PromMatrix | undefined): number | undefined {
  if (!series || series.values.length === 0) return undefined
  const raw = series.values[series.values.length - 1][1]
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function sel(namespace: string, podName: string): string {
  // container!="" excludes the pod-level cgroup roll-up; container!="POD"
  // drops the pause/sandbox container.
  return `namespace="${namespace}",pod="${podName}"`
}
function cadvisorSel(namespace: string, podName: string): string {
  return `${sel(namespace, podName)},container!="",container!="POD"`
}

/**
 * One batched fetch of every time-series we chart. All queries share the range
 * so a single `query_range` fan-out (via Promise.all) covers the whole panel;
 * `retry:false` + a slow `refetchInterval` keep it cheap.
 */
function usePromMetrics(namespace: string, podName: string, cfg: RangeCfg) {
  return useQuery({
    queryKey: ['prom', 'pod', namespace, podName, cfg.label],
    retry: false,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      const s = sel(namespace, podName)
      const cs = cadvisorSel(namespace, podName)
      const [
        cpuTotal,
        cpuByContainer,
        cpuReq,
        cpuLim,
        cpuThrottle,
        memTotal,
        memByContainer,
        memReq,
        memLim,
        netRx,
        netTx,
        fsRead,
        fsWrite,
        restarts,
      ] = await Promise.all([
        promRange(`sum(rate(container_cpu_usage_seconds_total{${cs}}[${cfg.rate}]))`, cfg),
        promRange(`sum by (container) (rate(container_cpu_usage_seconds_total{${cs}}[${cfg.rate}]))`, cfg),
        promRange(`sum(kube_pod_container_resource_requests{${s},resource="cpu"})`, cfg),
        promRange(`sum(kube_pod_container_resource_limits{${s},resource="cpu"})`, cfg),
        promRange(
          `100 * sum(rate(container_cpu_cfs_throttled_periods_total{${s}}[${cfg.rate}])) / clamp_min(sum(rate(container_cpu_cfs_periods_total{${s}}[${cfg.rate}])), 1)`,
          cfg,
        ),
        promRange(`sum(container_memory_working_set_bytes{${cs}})`, cfg),
        promRange(`sum by (container) (container_memory_working_set_bytes{${cs}})`, cfg),
        promRange(`sum(kube_pod_container_resource_requests{${s},resource="memory"})`, cfg),
        promRange(`sum(kube_pod_container_resource_limits{${s},resource="memory"})`, cfg),
        promRange(`sum(rate(container_network_receive_bytes_total{${s}}[${cfg.rate}]))`, cfg),
        promRange(`sum(rate(container_network_transmit_bytes_total{${s}}[${cfg.rate}]))`, cfg),
        promRange(`sum(rate(container_fs_reads_bytes_total{${cs}}[${cfg.rate}]))`, cfg),
        promRange(`sum(rate(container_fs_writes_bytes_total{${cs}}[${cfg.rate}]))`, cfg),
        promRange(`max(kube_pod_container_status_restarts_total{${s}})`, cfg),
      ])
      return {
        cpuTotal: cpuTotal[0],
        cpuByContainer,
        cpuReq: lastValue(cpuReq[0]),
        cpuLim: lastValue(cpuLim[0]),
        cpuThrottle: cpuThrottle[0],
        memTotal: memTotal[0],
        memByContainer,
        memReq: lastValue(memReq[0]),
        memLim: lastValue(memLim[0]),
        netRx: netRx[0],
        netTx: netTx[0],
        fsRead: fsRead[0],
        fsWrite: fsWrite[0],
        restarts: lastValue(restarts[0]),
      }
    },
  })
}

/* ───── panel ───── */

export function PodMetricsPanel({
  namespace,
  podName,
  containers,
}: {
  namespace: string
  podName: string
  containers: ContainerResources[]
}) {
  const [range, setRange] = useState<RangeKey>('1h')
  const cfg = RANGES.find((r) => r.label === range) ?? RANGES[1]

  // Live instantaneous snapshot (metrics-server).
  const live = useQuery({
    queryKey: ['k8s', 'pod-metrics', namespace, podName],
    queryFn: () => client.podMetrics(LOCAL_CLUSTER, namespace, podName),
    refetchInterval: POLL_MS,
    retry: false,
  })

  // Pod status for restart / OOM indicators (dedupes with the drawer's pod query).
  const podQ = useQuery({
    queryKey: ['k8s', 'pod', namespace, podName],
    queryFn: () => client.getPod(LOCAL_CLUSTER, namespace, podName),
    refetchInterval: 15_000,
    retry: false,
  })

  const prom = usePromMetrics(namespace, podName, cfg)

  const liveAvailable = live.data !== undefined
  const promAvailable = prom.data !== undefined && !prom.isError

  // Both layers absent → the original full-page setup empty state.
  if (!liveAvailable && !live.isLoading && !promAvailable && !prom.isLoading) {
    return <MetricsMissing />
  }

  return (
    <div className="space-y-4">
      {/* range selector */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-content-subtle">
          Time range
        </span>
        <div className="inline-flex overflow-hidden rounded-lg border border-edge-default">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setRange(r.label)}
              className={
                'px-2.5 py-1 text-xs font-medium transition ' +
                (r.label === range
                  ? 'bg-brand-500 text-white'
                  : 'bg-surface-raised text-content-muted hover:text-content')
              }
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-content-subtle">
          {promAvailable ? `Prometheus · step ${cfg.step}s` : 'live snapshot'}
        </span>
      </div>

      <LiveSnapshot live={live} containers={containers} />

      <RestartStrip pod={podQ.data} promRestarts={prom.data?.restarts} />

      {promAvailable ? (
        <PromCharts prom={prom.data!} containers={containers} />
      ) : prom.isLoading ? (
        <PromLoading />
      ) : (
        <PromMissing />
      )}
    </div>
  )
}

/* ───── live snapshot (metrics.k8s.io) ───── */

function LiveSnapshot({
  live,
  containers,
}: {
  live: ReturnType<typeof useQuery<Awaited<ReturnType<typeof client.podMetrics>>>>
  containers: ContainerResources[]
}) {
  const limits = useMemo(() => sumResources(containers), [containers])
  const data = live.data
  if (live.isLoading && !data) {
    return (
      <Panel title="Live snapshot" subtitle="metrics.k8s.io">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={56} />)}
        </div>
      </Panel>
    )
  }
  if (!data) {
    return (
      <Panel title="Live snapshot" subtitle="metrics.k8s.io">
        <p className="text-xs text-content-muted">
          metrics-server is not installed — instantaneous CPU / memory is unavailable. Historical
          graphs below come from Prometheus if it is wired.
        </p>
      </Panel>
    )
  }

  let cpuTotal = 0
  let memTotal = 0
  for (const c of data.containers) {
    cpuTotal += parseQuantity(c.usage.cpu)
    memTotal += parseQuantity(c.usage.memory)
  }
  const cpuPctLimit = limits.cpuLim ? Math.round((cpuTotal / limits.cpuLim) * 100) : undefined
  const memPctLimit = limits.memLim ? Math.round((memTotal / limits.memLim) * 100) : undefined

  return (
    <Panel title="Live snapshot" subtitle="metrics.k8s.io · every 10s">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <InstantTile label="CPU (pod)" value={`${formatCpu(cpuTotal)}`} sub={cpuPctLimit != null ? `${cpuPctLimit}% of limit` : 'cores'} tone={pctTone(cpuPctLimit)} />
        <InstantTile label="Memory (pod)" value={formatBytes(memTotal)} sub={memPctLimit != null ? `${memPctLimit}% of limit` : 'working set'} tone={pctTone(memPctLimit)} />
        <InstantTile label="CPU limit" value={limits.cpuLim ? formatCpu(limits.cpuLim) : '—'} sub={limits.cpuReq ? `req ${formatCpu(limits.cpuReq)}` : 'no request'} />
        <InstantTile label="Mem limit" value={limits.memLim ? formatBytes(limits.memLim) : '—'} sub={limits.memReq ? `req ${formatBytes(limits.memReq)}` : 'no request'} />
      </div>
      {data.containers.length > 1 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-content-subtle">
                <th className="py-1 pr-3 font-medium">Container</th>
                <th className="py-1 pr-3 font-medium">CPU</th>
                <th className="py-1 font-medium">Memory</th>
              </tr>
            </thead>
            <tbody>
              {data.containers.map((c) => (
                <tr key={c.name} className="border-t border-edge-subtle">
                  <td className="py-1 pr-3 font-mono text-content">{c.name}</td>
                  <td className="py-1 pr-3 tabular-nums text-content-muted">{formatCpu(parseQuantity(c.usage.cpu))}</td>
                  <td className="py-1 tabular-nums text-content-muted">{formatBytes(parseQuantity(c.usage.memory))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  )
}

/* ───── restart / OOM strip ───── */

interface PodStatusLite {
  status?: {
    containerStatuses?: Array<{
      name: string
      restartCount?: number
      ready?: boolean
      lastState?: { terminated?: { reason?: string; exitCode?: number; finishedAt?: string } }
      state?: { waiting?: { reason?: string; message?: string } }
    }>
  }
}

function RestartStrip({ pod, promRestarts }: { pod?: PodStatusLite; promRestarts?: number }) {
  const statuses = pod?.status?.containerStatuses ?? []
  const totalRestarts = statuses.reduce((a, c) => a + (c.restartCount ?? 0), 0)
  const oom = statuses.filter((c) => c.lastState?.terminated?.reason === 'OOMKilled')
  const waiting = statuses.filter((c) => c.state?.waiting?.reason)

  if (statuses.length === 0 && promRestarts == null) return null

  const healthy = totalRestarts === 0 && oom.length === 0 && waiting.length === 0

  return (
    <Panel title="Reliability" subtitle="pod status">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge kind={totalRestarts > 0 ? 'degraded' : 'healthy'}>
          {totalRestarts} restart{totalRestarts === 1 ? '' : 's'}
        </StatusBadge>
        {oom.length > 0 ? (
          <StatusBadge kind="failed">
            OOMKilled ×{oom.length}
          </StatusBadge>
        ) : null}
        {waiting.map((c) => (
          <StatusBadge key={c.name} kind="progressing">
            {c.name}: {c.state?.waiting?.reason}
          </StatusBadge>
        ))}
        {healthy ? (
          <span className="text-xs text-content-muted">No restarts or OOM events on record.</span>
        ) : null}
      </div>
      {statuses.some((c) => c.lastState?.terminated) ? (
        <div className="mt-2 space-y-1">
          {statuses
            .filter((c) => c.lastState?.terminated)
            .map((c) => {
              const t = c.lastState!.terminated!
              return (
                <div key={c.name} className="text-[11px] text-content-muted">
                  <span className="font-mono text-content">{c.name}</span> last terminated
                  {t.reason ? <> · <span className="font-medium">{t.reason}</span></> : null}
                  {typeof t.exitCode === 'number' ? ` (exit ${t.exitCode})` : ''}
                  {c.restartCount ? ` · ${c.restartCount} restarts` : ''}
                </div>
              )
            })}
        </div>
      ) : null}
    </Panel>
  )
}

/* ───── Prometheus charts ───── */

function PromCharts({ prom, containers }: { prom: PromData; containers: ContainerResources[] }) {
  const cpuCur = lastValue(prom.cpuTotal)
  const memCur = lastValue(prom.memTotal)
  const throttleCur = lastValue(prom.cpuThrottle)
  const rxCur = lastValue(prom.netRx)
  const txCur = lastValue(prom.netTx)
  const fsRCur = lastValue(prom.fsRead)
  const fsWCur = lastValue(prom.fsWrite)

  const cpuPoints = toPoints(prom.cpuTotal)
  const memPoints = toPoints(prom.memTotal)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard
          title="CPU usage"
          current={cpuCur != null ? `${formatCpu(cpuCur)} cores` : '—'}
          points={cpuPoints}
          color="var(--color-brand-500)"
          formatY={(v) => formatCpu(v)}
          usage={cpuCur}
          request={prom.cpuReq}
          limit={prom.cpuLim}
          formatRef={(v) => formatCpu(v)}
          emptyLabel="No CPU samples in range"
        />
        <ChartCard
          title="Memory (working set)"
          current={memCur != null ? formatBytes(memCur) : '—'}
          points={memPoints}
          color="var(--color-accent-500)"
          formatY={(v) => formatBytes(v)}
          usage={memCur}
          request={prom.memReq}
          limit={prom.memLim}
          formatRef={(v) => formatBytes(v)}
          emptyLabel="No memory samples in range"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard
          title="CPU throttling"
          current={throttleCur != null ? `${throttleCur.toFixed(1)}%` : '—'}
          points={toPoints(prom.cpuThrottle)}
          color="#f59e0b"
          formatY={(v) => `${v.toFixed(0)}%`}
          usage={throttleCur}
          badgeKind={throttleCur != null && throttleCur >= 25 ? 'degraded' : 'healthy'}
          hint="% of CFS periods throttled — sustained values mean the CPU limit is too tight."
          emptyLabel="No throttling metrics in range"
        />
        <div className="grid grid-cols-1 gap-3">
          <ChartCard
            title="Network"
            current={rxCur != null || txCur != null ? `↓ ${formatBytes(rxCur ?? 0)}/s · ↑ ${formatBytes(txCur ?? 0)}/s` : '—'}
            points={toPoints(prom.netRx)}
            secondaryPoints={toPoints(prom.netTx)}
            color="var(--color-accent-600, #0891b2)"
            secondaryColor="#a855f7"
            formatY={(v) => `${formatBytes(v)}/s`}
            legend={['receive', 'transmit']}
            emptyLabel="No network metrics in range"
          />
          <ChartCard
            title="Filesystem I/O"
            current={fsRCur != null || fsWCur != null ? `r ${formatBytes(fsRCur ?? 0)}/s · w ${formatBytes(fsWCur ?? 0)}/s` : '—'}
            points={toPoints(prom.fsRead)}
            secondaryPoints={toPoints(prom.fsWrite)}
            color="#14b8a6"
            secondaryColor="#f43f5e"
            formatY={(v) => `${formatBytes(v)}/s`}
            legend={['read', 'write']}
            emptyLabel="No filesystem I/O metrics in range"
          />
        </div>
      </div>

      <PerContainer cpu={prom.cpuByContainer} mem={prom.memByContainer} />
    </div>
  )
}

interface PromData {
  cpuTotal?: PromMatrix
  cpuByContainer: PromMatrix[]
  cpuReq?: number
  cpuLim?: number
  cpuThrottle?: PromMatrix
  memTotal?: PromMatrix
  memByContainer: PromMatrix[]
  memReq?: number
  memLim?: number
  netRx?: PromMatrix
  netTx?: PromMatrix
  fsRead?: PromMatrix
  fsWrite?: PromMatrix
  restarts?: number
}

function ChartCard({
  title,
  current,
  points,
  secondaryPoints,
  color,
  secondaryColor,
  formatY,
  usage,
  request,
  limit,
  formatRef,
  badgeKind,
  legend,
  hint,
  emptyLabel,
}: {
  title: string
  current: string
  points: SeriesPoint[]
  secondaryPoints?: SeriesPoint[]
  color: string
  secondaryColor?: string
  formatY(v: number): string
  usage?: number
  request?: number
  limit?: number
  formatRef?(v: number): string
  badgeKind?: 'healthy' | 'degraded' | 'failed'
  legend?: [string, string]
  hint?: string
  emptyLabel?: string
}) {
  const pctLimit = limit && usage != null ? Math.round((usage / limit) * 100) : undefined
  const kind = badgeKind ?? (pctLimit == null ? 'healthy' : pctLimit >= 90 ? 'failed' : pctLimit >= 75 ? 'degraded' : 'healthy')
  const hasData = points.length > 1 || (secondaryPoints?.length ?? 0) > 1

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-content-subtle">{title}</div>
          <div className="mt-0.5 text-lg font-semibold tabular-nums text-content">{current}</div>
        </div>
        {pctLimit != null ? (
          <StatusBadge kind={kind}>{pctLimit}% of limit</StatusBadge>
        ) : badgeKind ? (
          <StatusBadge kind={kind}>{title.includes('throttl') ? 'throttle' : 'ok'}</StatusBadge>
        ) : null}
      </div>

      {hasData ? (
        <div className="relative">
          <AreaChart points={points} color={color} height={88} formatY={formatY} showAxis />
          {secondaryPoints && secondaryPoints.length > 1 ? (
            <div className="pointer-events-none absolute inset-x-0 top-0">
              <Sparkline points={secondaryPoints} color={secondaryColor ?? color} height={88} strokeWidth={1.25} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-edge-default text-xs text-content-subtle">
          {emptyLabel ?? 'No data in range'}
        </div>
      )}

      {legend ? (
        <div className="mt-2 flex items-center gap-4 border-t border-edge-subtle pt-2 text-[10px]">
          <span className="inline-flex items-center gap-1 text-content-muted">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} /> {legend[0]}
          </span>
          <span className="inline-flex items-center gap-1 text-content-muted">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: secondaryColor ?? color }} /> {legend[1]}
          </span>
        </div>
      ) : (request != null || limit != null) && formatRef ? (
        <div className="mt-2 flex items-center gap-4 border-t border-edge-subtle pt-2 text-[10px]">
          <span className="text-content-muted">request {request != null ? formatRef(request) : '—'}</span>
          <span className="text-content-muted">limit {limit != null ? formatRef(limit) : '—'}</span>
          {pctLimit != null ? (
            <span className="ml-auto">
              <DonutGauge value={usage ?? 0} max={limit ?? 1} size={34} thickness={5} label="" caption="" />
            </span>
          ) : null}
        </div>
      ) : hint ? (
        <p className="mt-2 border-t border-edge-subtle pt-2 text-[10px] text-content-subtle">{hint}</p>
      ) : null}
    </div>
  )
}

function PerContainer({ cpu, mem }: { cpu: PromMatrix[]; mem: PromMatrix[] }) {
  const names = useMemo(() => {
    const set = new Set<string>()
    for (const s of cpu) if (s.metric.container) set.add(s.metric.container)
    for (const s of mem) if (s.metric.container) set.add(s.metric.container)
    return [...set]
  }, [cpu, mem])

  if (names.length === 0) return null

  const cpuBars = cpu
    .filter((s) => s.metric.container)
    .map((s) => ({ label: s.metric.container, value: lastValue(s) ?? 0 }))
  const memBars = mem
    .filter((s) => s.metric.container)
    .map((s) => ({ label: s.metric.container, value: lastValue(s) ?? 0 }))

  return (
    <Panel title="Per-container" subtitle={`${names.length} container${names.length === 1 ? '' : 's'}`}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-medium text-content-subtle">CPU (cores, current)</div>
          <BarChart bars={cpuBars} color="var(--color-brand-500)" height={72} formatY={(v) => formatCpu(v)} />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium text-content-subtle">Memory (working set, current)</div>
          <BarChart bars={memBars} color="var(--color-accent-500)" height={72} formatY={(v) => formatBytes(v)} />
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {names.map((name) => {
          const cpuS = cpu.find((s) => s.metric.container === name)
          const memS = mem.find((s) => s.metric.container === name)
          return (
            <div key={name} className="grid grid-cols-[10rem_1fr_1fr] items-center gap-3 rounded-lg border border-edge-subtle bg-surface-sunken px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-content">{name}</div>
                <div className="mt-0.5 text-[11px] text-content-subtle">
                  {formatCpu(lastValue(cpuS) ?? 0)} · {formatBytes(lastValue(memS) ?? 0)}
                </div>
              </div>
              <Sparkline points={toPoints(cpuS)} color="var(--color-brand-500)" />
              <Sparkline points={toPoints(memS)} color="var(--color-accent-500)" />
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

/* ───── empty / loading states ───── */

function MetricsMissing() {
  return (
    <EmptyState
      title="No metrics backends reachable"
      description={
        <>
          Live CPU and memory graphs need either the Kubernetes{' '}
          <code className="font-mono">metrics.k8s.io</code> API (
          <a
            href="https://github.com/kubernetes-sigs/metrics-server"
            target="_blank"
            rel="noreferrer"
            className="text-brand-700 dark:text-brand-300 underline hover:text-brand-800"
          >
            metrics-server
          </a>
          ) for the live snapshot, or <strong>Prometheus</strong> for history. Neither is
          responding for this pod.
        </>
      }
    />
  )
}

function PromMissing() {
  return (
    <Panel title="Time-series (Prometheus)" subtitle="unavailable">
      <p className="text-xs text-content-muted">
        Prometheus is not reachable through the console proxy (
        <code className="font-mono">/api/svc/prometheus</code>) — set{' '}
        <code className="font-mono">PROMETHEUS_URL</code> (or install the{' '}
        <code className="font-mono">kube-prometheus-stack</code>) to unlock CPU/memory history,
        throttling, network and filesystem graphs. The live snapshot above still works.
      </p>
    </Panel>
  )
}

function PromLoading() {
  return (
    <Panel title="Time-series (Prometheus)" subtitle="loading">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Skeleton height={140} />
        <Skeleton height={140} />
      </div>
    </Panel>
  )
}

/* ───── small atoms ───── */

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-content">{title}</div>
        {subtitle ? <span className="text-[11px] text-content-subtle">{subtitle}</span> : null}
      </div>
      {children}
    </div>
  )
}

function InstantTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'good' | 'warn' | 'bad'
}) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken px-2 py-2 text-center">
      <div
        className={
          'text-lg font-semibold tabular-nums ' +
          (tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : 'text-content')
        }
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-content-subtle">{label}</div>
      {sub ? <div className="mt-0.5 text-[10px] text-content-muted">{sub}</div> : null}
    </div>
  )
}

function pctTone(pct?: number): 'good' | 'warn' | 'bad' | undefined {
  if (pct == null) return undefined
  if (pct >= 90) return 'bad'
  if (pct >= 75) return 'warn'
  return 'good'
}

/** Sum requests/limits across a pod's containers into total cores / bytes. */
function sumResources(containers: ContainerResources[]) {
  let cpuReq = 0, cpuLim = 0, memReq = 0, memLim = 0
  for (const c of containers) {
    const r = c.resources
    if (r?.requests?.cpu) cpuReq += parseQuantity(r.requests.cpu)
    if (r?.limits?.cpu) cpuLim += parseQuantity(r.limits.cpu)
    if (r?.requests?.memory) memReq += parseQuantity(r.requests.memory)
    if (r?.limits?.memory) memLim += parseQuantity(r.limits.memory)
  }
  return { cpuReq, cpuLim, memReq, memLim }
}
