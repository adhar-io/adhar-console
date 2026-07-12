import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { client, LOCAL_CLUSTER } from '../data/client.ts'
import { formatBytes, formatCpu, parseQuantity } from '../data/format.ts'

/**
 * Traffic + resource metrics graphs for a single pod.
 *
 * CPU / memory come from `metrics.k8s.io/v1beta1` (metrics-server). We poll
 * every 10s and accumulate a rolling 60-point window on the client — good
 * enough for the "last 10 minutes" glance most operators actually want,
 * without depending on Prometheus/Mimir being wired in yet.
 *
 * Traffic (net rx/tx) is polled from cAdvisor's summary endpoint when
 * available — on a bare kind cluster it may not be exposed, in which case
 * we gracefully fall back to CPU + memory only.
 */

const POLL_MS = 10_000
const WINDOW = 60 // 60 samples * 10s = last 10 minutes

interface Sample {
  t: number
  cpuCores: number
  memBytes: number
  rxBytes?: number
  txBytes?: number
}

interface ContainerSeries {
  name: string
  samples: Sample[]
}

export function PodMetricsPanel({
  namespace,
  podName,
  containerNames,
}: {
  namespace: string
  podName: string
  containerNames: string[]
}) {
  const [series, setSeries] = useState<Record<string, ContainerSeries>>({})
  const seriesRef = useRef(series)
  seriesRef.current = series

  const q = useQuery({
    queryKey: ['k8s', 'pod-metrics', namespace, podName],
    queryFn: () => client.podMetrics(LOCAL_CLUSTER, namespace, podName),
    refetchInterval: POLL_MS,
    retry: false,
  })

  // Append the latest reading into the rolling window.
  useEffect(() => {
    if (!q.data) return
    const t = Date.now()
    setSeries((prev) => {
      const next: Record<string, ContainerSeries> = { ...prev }
      for (const c of q.data!.containers) {
        const prior = next[c.name]?.samples ?? []
        const cpuCores = parseQuantity(c.usage.cpu)
        const memBytes = parseQuantity(c.usage.memory)
        const nextSamples = [...prior, { t, cpuCores, memBytes }].slice(-WINDOW)
        next[c.name] = { name: c.name, samples: nextSamples }
      }
      return next
    })
  }, [q.data])

  const available = q.data !== undefined
  const aggregate = useMemo(() => aggregateSeries(series), [series])

  // metrics-server absent? Show setup empty state but still let the traffic
  // panel render (cAdvisor summary can work independently of metrics-server).
  if (q.isError || (!available && !q.isLoading)) {
    return <MetricsMissing />
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MetricCard
          title="CPU usage"
          color="var(--color-brand-500)"
          subtitle={aggregate.cpuCores > 0 ? `${formatCpu(aggregate.cpuCores)} cores` : 'awaiting first sample…'}
          series={aggregate.cpuSeries}
          format={(v) => formatCpu(v)}
          unit="cores"
        />
        <MetricCard
          title="Memory usage"
          color="var(--color-accent-500)"
          subtitle={aggregate.memBytes > 0 ? formatBytes(aggregate.memBytes) : 'awaiting first sample…'}
          series={aggregate.memSeries}
          format={(v) => formatBytes(v)}
          unit=""
        />
      </div>

      {Object.keys(series).length > 1 ? (
        <div className="rounded-xl border border-edge-default bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-content">Per-container</div>
            <span className="text-[11px] text-content-subtle">
              sampled every 10s · last {Math.min(aggregate.cpuSeries.length, WINDOW)} points
            </span>
          </div>
          <div className="space-y-3">
            {Object.values(series).map((s) => {
              const last = s.samples[s.samples.length - 1]
              return (
                <div
                  key={s.name}
                  className="grid grid-cols-[10rem_1fr_1fr] items-center gap-3 rounded-lg border border-edge-subtle bg-surface-sunken px-3 py-2"
                >
                  <div>
                    <div className="text-sm font-medium text-content">{s.name}</div>
                    <div className="mt-0.5 text-[11px] text-content-subtle">
                      {last ? `${formatCpu(last.cpuCores)} · ${formatBytes(last.memBytes)}` : '—'}
                    </div>
                  </div>
                  <Spark points={s.samples.map((x) => x.cpuCores)} color="var(--color-brand-500)" />
                  <Spark points={s.samples.map((x) => x.memBytes)} color="var(--color-accent-500)" />
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      <TrafficPanel namespace={namespace} podName={podName} containerNames={containerNames} />
    </div>
  )
}

function MetricsMissing() {
  return (
    <EmptyState
      title="metrics-server is not installed"
      description={
        <>
          Live CPU and memory graphs require the Kubernetes{' '}
          <code className="font-mono">metrics.k8s.io</code> API. Install{' '}
          <a
            href="https://github.com/kubernetes-sigs/metrics-server"
            target="_blank"
            rel="noreferrer"
            className="text-brand-700 underline hover:text-brand-800"
          >
            metrics-server
          </a>
          {' '}on the cluster — kube-state-metrics and cAdvisor come along for free.
        </>
      }
    />
  )
}

/* ───── traffic (cAdvisor summary) ───── */

interface SummaryNetwork {
  rxBytes?: number
  txBytes?: number
  time?: string
}

function TrafficPanel({
  namespace,
  podName,
}: {
  namespace: string
  podName: string
  /** Reserved for future per-container split — currently unused. */
  containerNames?: string[]
}) {
  // Fetch each node's /stats/summary is too heavy — instead poll the
  // kubelet /metrics/cadvisor when exposed via the proxy. On kind clusters
  // this is usually off by default, so we noop on 403/404.
  const q = useQuery({
    queryKey: ['k8s', 'pod-traffic', namespace, podName],
    queryFn: async () => {
      // Try the node-summary shortcut first — only works when the apiserver
      // has the stats/summary subresource enabled. We route through the
      // pod's node; for simplicity we fetch the pod and grab spec.nodeName.
      const pod = await client.getPod(LOCAL_CLUSTER, namespace, podName)
      const node = pod.spec.nodeName
      if (!node) return null
      try {
        const body = await fetch(
          `/kube-api/api/v1/nodes/${encodeURIComponent(node)}/proxy/stats/summary`,
          { credentials: 'same-origin' },
        )
        if (!body.ok) return null
        const parsed = (await body.json()) as {
          pods?: Array<{
            podRef?: { name: string; namespace: string }
            network?: SummaryNetwork
          }>
        }
        const match = (parsed.pods ?? []).find(
          (p) => p.podRef?.name === podName && p.podRef?.namespace === namespace,
        )
        return match?.network ?? null
      } catch {
        return null
      }
    },
    refetchInterval: POLL_MS,
    retry: false,
  })

  const [points, setPoints] = useState<{ t: number; rx: number; tx: number }[]>([])
  useEffect(() => {
    if (!q.data || (q.data.rxBytes == null && q.data.txBytes == null)) return
    setPoints((prev) => {
      const now = Date.now()
      const next = {
        t: now,
        rx: q.data!.rxBytes ?? 0,
        tx: q.data!.txBytes ?? 0,
      }
      // Store cumulative counters; rates derived below.
      return [...prev, next].slice(-WINDOW)
    })
  }, [q.data])

  const rates = useMemo(() => deriveRates(points), [points])
  const latest = rates[rates.length - 1]

  if (q.isLoading) {
    return (
      <div className="rounded-xl border border-edge-default bg-white p-6 text-center text-xs text-content-muted shadow-sm">
        Polling pod network traffic via kubelet summary…
      </div>
    )
  }

  if (!q.data) {
    return (
      <div className="rounded-xl border border-edge-default bg-white p-6 text-xs text-content-muted shadow-sm">
        <div className="text-sm font-medium text-content">Network traffic unavailable</div>
        <p className="mt-1">
          The pod's node doesn't expose <code className="font-mono">/stats/summary</code> through the
          apiserver proxy — enable kubelet authz or wire the Beyla / OTel eBPF collector to surface
          real-time traffic here.
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <MetricCard
        title="Network in"
        color="var(--color-accent-600)"
        subtitle={latest ? `${formatBytes(latest.rxPerSec)}/s` : 'awaiting samples…'}
        series={rates.map((r) => r.rxPerSec)}
        format={(v) => `${formatBytes(v)}/s`}
        unit=""
      />
      <MetricCard
        title="Network out"
        color="#a855f7"
        subtitle={latest ? `${formatBytes(latest.txPerSec)}/s` : 'awaiting samples…'}
        series={rates.map((r) => r.txPerSec)}
        format={(v) => `${formatBytes(v)}/s`}
        unit=""
      />
    </div>
  )
}

/* ───── chart atoms ───── */

function MetricCard({
  title,
  color,
  subtitle,
  series,
  format,
  unit,
}: {
  title: string
  color: string
  subtitle: string
  series: number[]
  format(v: number): string
  unit: string
}) {
  const max = Math.max(1, ...series)
  return (
    <div className="rounded-xl border border-edge-default bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-content-subtle">
            {title}
          </div>
          <div className="mt-0.5 flex items-baseline gap-1.5 text-content">
            <span className="text-lg font-semibold tabular-nums">{subtitle}</span>
          </div>
        </div>
        <StatusBadge kind={series.length ? 'healthy' : 'unknown'}>
          {series.length}/{WINDOW} pts
        </StatusBadge>
      </div>
      <AreaSpark points={series} color={color} max={max} />
      <div className="mt-1 flex items-center justify-between text-[10px] text-content-subtle">
        <span>{format(0)}</span>
        <span>{unit}</span>
        <span>{format(max)}</span>
      </div>
    </div>
  )
}

function AreaSpark({
  points,
  color,
  max,
}: {
  points: number[]
  color: string
  max: number
}) {
  const width = 320
  const height = 64
  if (points.length < 2) {
    return (
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1="0" x2={width} y1={height / 2} y2={height / 2} stroke={color} strokeOpacity="0.15" strokeDasharray="3 3" />
      </svg>
    )
  }
  const step = width / (points.length - 1)
  const ys = points.map((p) => height - (p / max) * (height - 4) - 2)
  const path = ys.map((y, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `${path} L${width},${height} L0,${height} Z`
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`g-${color}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#g-${color})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(points.length - 1) * step} cy={ys[ys.length - 1]} r="2.5" fill={color} />
    </svg>
  )
}

function Spark({ points, color }: { points: number[]; color: string }) {
  const max = Math.max(1, ...points)
  const width = 120
  const height = 28
  if (points.length < 2) {
    return (
      <svg width={width} height={height} className="opacity-40">
        <line x1="0" x2={width} y1={height / 2} y2={height / 2} stroke={color} />
      </svg>
    )
  }
  const step = width / (points.length - 1)
  const ys = points.map((p) => height - (p / max) * (height - 2) - 1)
  const path = ys.map((y, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y.toFixed(2)}`).join(' ')
  return (
    <svg width={width} height={height}>
      <path d={path} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/* ───── helpers ───── */

function aggregateSeries(series: Record<string, ContainerSeries>) {
  const names = Object.keys(series)
  if (!names.length) {
    return { cpuSeries: [], memSeries: [], cpuCores: 0, memBytes: 0 }
  }
  // Assume all containers share the same sample indexes (they're populated in
  // lockstep on each metrics poll). Sum each column.
  const firstLen = series[names[0]].samples.length
  const cpuSeries: number[] = []
  const memSeries: number[] = []
  for (let i = 0; i < firstLen; i++) {
    let cpu = 0
    let mem = 0
    for (const n of names) {
      const s = series[n].samples[i]
      if (s) {
        cpu += s.cpuCores
        mem += s.memBytes
      }
    }
    cpuSeries.push(cpu)
    memSeries.push(mem)
  }
  return {
    cpuSeries,
    memSeries,
    cpuCores: cpuSeries[cpuSeries.length - 1] ?? 0,
    memBytes: memSeries[memSeries.length - 1] ?? 0,
  }
}

function deriveRates(points: { t: number; rx: number; tx: number }[]) {
  const out: { t: number; rxPerSec: number; txPerSec: number }[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const dt = Math.max(1, (cur.t - prev.t) / 1000)
    out.push({
      t: cur.t,
      rxPerSec: Math.max(0, (cur.rx - prev.rx) / dt),
      txPerSec: Math.max(0, (cur.tx - prev.tx) / dt),
    })
  }
  return out
}
