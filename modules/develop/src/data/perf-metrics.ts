import { useQueries, useQuery } from '@tanstack/react-query'
import type { PerfTestConfig } from './perf-format.ts'

/**
 * What the system was doing WHILE the test ran.
 *
 * ---------------------------------------------------------------------------
 * WHY THE k6 SUMMARY IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * k6 tells you what the client saw: throughput, latency percentiles, whether
 * the thresholds held. It cannot tell you WHY. A p95 that doubled is a fact;
 * whether it doubled because the pods hit their CPU limit, because the
 * database started queueing, or because a node ran out of memory is the
 * question you actually need answered, and every one of those answers lives
 * in Prometheus rather than in the runner's stdout.
 *
 * So a report pairs the k6 numbers with the cluster's own view of the same
 * window: the workload under test, the runners generating the load, the nodes
 * underneath, and the database behind it. Same time range, same chart width —
 * which is what makes "the latency knee lines up with the CPU ceiling"
 * visible instead of inferred.
 *
 * ---------------------------------------------------------------------------
 * HONESTY
 * ---------------------------------------------------------------------------
 * Every query here can legitimately return nothing: Prometheus may not be
 * reachable, kube-state-metrics may not be installed, there may be no
 * database exporter. A panel with no data says so. Nothing on this page is
 * ever synthesised — a performance report that invents a number is worse than
 * one that admits a gap, because someone will make a decision on it.
 */

const PROM_BASE = '/api/svc/prometheus'

export interface Sample {
  t: number
  v: number
}

export interface Series {
  label: string
  points: Sample[]
}

export interface PanelData {
  series: Series[]
  /** Set when the query could not be answered at all. */
  error?: string
  /** True when Prometheus answered but had nothing for this window. */
  empty: boolean
}

/* ─────────────────────────── transport ─────────────────────────── */

interface PromMatrix {
  status?: string
  data?: { resultType?: string; result?: Array<{ metric?: Record<string, string>; values?: Array<[number, string]> }> }
  error?: string
}

/**
 * Range query. Step is derived from the window so a 30-second test and a
 * six-hour soak both come back with a readable number of points rather than
 * two or twenty thousand.
 */
async function queryRange(query: string, startMs: number, endMs: number, points = 120): Promise<PanelData> {
  const start = Math.floor(startMs / 1000)
  const end = Math.ceil(endMs / 1000)
  const step = Math.max(1, Math.floor((end - start) / points))
  const qs = new URLSearchParams({ query, start: String(start), end: String(end), step: String(step) })

  const res = await fetch(`${PROM_BASE}/api/v1/query_range?${qs}`, { credentials: 'include' })
  if (!res.ok) {
    // 503 is the console's own "this tool is not configured"; anything else
    // came from Prometheus. Both are worth saying out loud rather than
    // rendering an empty chart that looks like a quiet system.
    throw new Error(
      res.status === 503
        ? 'Prometheus is not configured for this install.'
        : `Prometheus returned HTTP ${res.status}.`,
    )
  }
  const body = (await res.json()) as PromMatrix
  if (body.status === 'error') throw new Error(body.error ?? 'Prometheus rejected the query.')

  const series: Series[] = (body.data?.result ?? []).map((r) => ({
    label: labelFor(r.metric ?? {}),
    points: (r.values ?? []).map(([t, v]) => ({ t: t * 1000, v: Number(v) })).filter((p) => Number.isFinite(p.v)),
  })).filter((s) => s.points.length > 0)

  return { series, empty: series.length === 0 }
}

/** The most identifying label Prometheus gave us, for a legend. */
function labelFor(metric: Record<string, string>): string {
  return metric.pod ?? metric.node ?? metric.instance ?? metric.container ?? metric.datname ??
    metric.__name__ ?? 'value'
}

/* ─────────────────────────── the panels ─────────────────────────── */

export interface Window {
  startMs: number
  endMs: number
}

export interface PanelSpec {
  id: string
  group: 'workload' | 'runners' | 'infrastructure' | 'database'
  title: string
  /** What the number means, in a sentence — charts without units mislead. */
  unit: string
  hint: string
  query: string
}

/**
 * Build the query set for one run.
 *
 * `selector` is the label selector for the system under test (from the test's
 * config). Without it the workload panels are skipped rather than guessed —
 * charting the wrong pods is worse than charting none, because it looks
 * authoritative.
 */
export function panelsFor(opts: {
  runnerNamespace: string
  runnerSelector: string
  target?: PerfTestConfig['target']
}): PanelSpec[] {
  const { runnerNamespace, runnerSelector, target } = opts
  const panels: PanelSpec[] = []

  const targetNs = target?.namespace
  const targetSel = target?.selector

  if (targetNs && targetSel) {
    const ns = `namespace="${esc(targetNs)}"`
    const running = `${ns},container!="",container!="POD"`
    const pick = (inner: string) => restrictToSelector(inner, targetNs, targetSel)
    const labelMatchers = selectorToLabelMatchers(targetSel).join(',')

    panels.push(
      {
        id: 'target-cpu',
        group: 'workload',
        title: 'CPU used by the system under test',
        unit: 'cores',
        hint: 'A flat line at a round number is a limit, not a coincidence.',
        query: `sum by (pod) (${pick(`rate(container_cpu_usage_seconds_total{${running}}[1m])`)})`,
      },
      {
        id: 'target-cpu-limit',
        group: 'workload',
        title: 'CPU limit',
        unit: 'cores',
        hint: 'What the pods are allowed. Compare with usage — throttling starts where they meet.',
        query: `sum by (pod) (${
          pick(`kube_pod_container_resource_limits{${ns},resource="cpu"}`)
        })`,
      },
      {
        id: 'target-throttle',
        group: 'workload',
        title: 'CPU throttling',
        unit: 'ratio',
        hint:
          'Fraction of scheduling periods the kernel held the container back. Anything sustained above zero is latency you are paying for.',
        query: `sum by (pod) (${pick(`rate(container_cpu_cfs_throttled_periods_total{${ns}}[1m])`)}) / clamp_min(sum by (pod) (${
          pick(`rate(container_cpu_cfs_periods_total{${ns}}[1m])`)
        }), 1)`,
      },
      {
        id: 'target-memory',
        group: 'workload',
        title: 'Memory used by the system under test',
        unit: 'bytes',
        hint: 'Working set. A sawtooth is garbage collection; a climb that never returns is a leak.',
        query: `sum by (pod) (${pick(`container_memory_working_set_bytes{${running}}`)})`,
      },
      {
        id: 'target-restarts',
        group: 'workload',
        title: 'Restarts',
        unit: 'count',
        hint: 'A restart mid-test invalidates the numbers either side of it.',
        query: `sum by (pod) (${pick(`kube_pod_container_status_restarts_total{${ns}}`)})`,
      },
      {
        id: 'target-replicas',
        group: 'workload',
        title: 'Pods matching the target',
        unit: 'pods',
        hint: 'If this moved, the test measured a moving target — an autoscaler joined in.',
        query: `count(kube_pod_labels{${ns}${labelMatchers ? `,${labelMatchers}` : ''}})`,
      },
    )
  }

  panels.push(
    {
      id: 'runner-cpu',
      group: 'runners',
      title: 'Load generator CPU',
      unit: 'cores',
      hint: 'The runners themselves. If these are saturated you measured k6, not your service.',
      query:
        `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="${esc(runnerNamespace)}",pod=~"${esc(runnerSelector)}",container!="",container!="POD"}[1m]))`,
    },
    {
      id: 'runner-memory',
      group: 'runners',
      title: 'Load generator memory',
      unit: 'bytes',
      hint: 'A runner that runs out of memory stops generating load, which reads as the target getting faster.',
      query:
        `sum by (pod) (container_memory_working_set_bytes{namespace="${esc(runnerNamespace)}",pod=~"${esc(runnerSelector)}",container!="",container!="POD"})`,
    },
    {
      id: 'node-cpu',
      group: 'infrastructure',
      title: 'Node CPU utilisation',
      unit: 'ratio',
      hint: 'Across the cluster. A node at its ceiling affects every pod on it, including yours.',
      query: `1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[1m]))`,
    },
    {
      id: 'node-memory',
      group: 'infrastructure',
      title: 'Node memory available',
      unit: 'bytes',
      hint: 'When this approaches zero the kubelet starts evicting — usually the biggest pod, often yours.',
      query: `node_memory_MemAvailable_bytes`,
    },
    {
      id: 'node-network',
      group: 'infrastructure',
      title: 'Node network received',
      unit: 'bytes/s',
      hint: 'Useful sanity check that the load actually arrived where you think it did.',
      query: `sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|cali.*|cilium.*"}[1m]))`,
    },
    {
      id: 'node-disk',
      group: 'infrastructure',
      title: 'Disk read/write time',
      unit: 'ratio',
      hint: 'Fraction of wall time the disk was busy. Saturation here shows up as latency everywhere.',
      query: `sum by (instance) (rate(node_disk_io_time_seconds_total[1m]))`,
    },
    {
      id: 'db-connections',
      group: 'database',
      title: 'Database connections',
      unit: 'count',
      hint: 'Against the pool ceiling. Queueing for a connection is indistinguishable from a slow query, from the client.',
      query: `sum by (datname) (pg_stat_database_numbackends)`,
    },
    {
      id: 'db-commits',
      group: 'database',
      title: 'Transactions per second',
      unit: '/s',
      hint: 'Commits and rollbacks. A rollback rate that climbs under load usually means contention.',
      query: `sum by (datname) (rate(pg_stat_database_xact_commit[1m]))`,
    },
    {
      id: 'db-rollbacks',
      group: 'database',
      title: 'Rollbacks per second',
      unit: '/s',
      hint: 'Should be near zero. Under load it is the first sign of lock contention or deadlocks.',
      query: `sum by (datname) (rate(pg_stat_database_xact_rollback[1m]))`,
    },
    {
      id: 'db-blocked',
      group: 'database',
      title: 'Rows fetched per second',
      unit: '/s',
      hint: 'How hard the database is actually working, independent of how many queries were sent.',
      query: `sum by (datname) (rate(pg_stat_database_tup_fetched[1m]))`,
    },
  )

  return panels
}

/** Regex-escape a value being interpolated into a PromQL matcher. */
function esc(v: string): string {
  return v.replace(/["\\]/g, '\\$&')
}

/**
 * `app=checkout,tier=web` → `label_app="checkout",label_tier="web"`.
 *
 * kube-state-metrics exports a pod's labels on `kube_pod_labels`, rewritten
 * with a `label_` prefix and non-alphanumerics folded to underscores.
 */
function selectorToLabelMatchers(selector: string): string[] {
  return selector.split(',').map((p) => p.trim()).filter(Boolean).flatMap((p) => {
    const [k, v] = p.split('=').map((s) => s.trim())
    if (!k || v === undefined) return []
    return [`label_${k.replace(/[^a-zA-Z0-9_]/g, '_')}="${esc(v)}"`]
  })
}

/**
 * Restrict a per-pod cAdvisor expression to the pods a selector matches.
 *
 * cAdvisor series carry `namespace` and `pod` but NOT arbitrary workload
 * labels, so `app=checkout` cannot be applied to them directly. The standard
 * answer is to multiply by `kube_pod_labels` — which does carry them — joined
 * on `(namespace, pod)`. `group_left` keeps the metric's own labels, and
 * multiplying by a series whose value is always 1 filters without changing
 * the number.
 *
 * Needs kube-state-metrics. Without it these panels come back empty, and the
 * UI says the exporter is missing rather than implying the system was idle.
 */
function restrictToSelector(inner: string, namespace: string, selector: string): string {
  const matchers = selectorToLabelMatchers(selector)
  if (!matchers.length) return inner
  return `${inner} * on (namespace, pod) group_left kube_pod_labels{namespace="${esc(namespace)}",${matchers.join(',')}}`
}

/* ─────────────────────────── hooks ─────────────────────────── */

/**
 * Run every panel query over the run's window.
 *
 * One React Query per panel so a missing exporter fails ONE chart rather than
 * the page: a cluster without postgres_exporter should still show CPU.
 */
export function usePerfPanels(panels: PanelSpec[], window: Window | null) {
  const enabled = Boolean(window && window.endMs > window.startMs)
  const results = useQueries({
    queries: panels.map((p) => ({
      queryKey: ['perf', 'panel', p.id, window?.startMs, window?.endMs],
      queryFn: () => queryRange(p.query, window!.startMs, window!.endMs),
      enabled,
      retry: false,
      staleTime: 60_000,
    })),
  })

  return panels.map((panel, i) => {
    const r = results[i]
    return {
      panel,
      data: r.data,
      loading: r.isLoading,
      error: r.error ? (r.error as Error).message : undefined,
    }
  })
}

/** Whether Prometheus can be reached at all, so the page can say so once. */
export function usePrometheusReachable() {
  return useQuery({
    queryKey: ['perf', 'prometheus-reachable'],
    queryFn: async () => {
      const res = await fetch(`${PROM_BASE}/api/v1/query?query=up`, { credentials: 'include' })
      if (!res.ok) {
        return {
          ok: false,
          reason: res.status === 503
            ? 'Prometheus is not configured for this install.'
            : `Prometheus returned HTTP ${res.status}.`,
        }
      }
      return { ok: true as const, reason: undefined }
    },
    staleTime: 60_000,
    retry: false,
  })
}
