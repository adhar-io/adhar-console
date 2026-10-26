import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { k8s } from '@adhar/api-clients'
import { kube } from '@adhar/api-clients/k8s'
import { useWatchSignal } from '@adhar/shell-ui'
import { isRunning, type TestRun } from './k6.ts'
import { queryRange } from './perf-metrics.ts'
import { type LiveQuery, stepFor } from './perf-live.ts'
import { type PodDetail, podDetail, type PodLike, sortPods } from './perf-run-model.ts'
import { chartsFromAnswers, type ReportChartInput, reportChartQueries, reportWindow } from './perf-report-charts.ts'
import type { ReportCharts } from './perf-run-report.ts'

/**
 * The run drawer's reads — pods, the script behind the run, and the live
 * series — with the polling discipline the drawer needs to stay stable:
 *
 *   • every query is keyed by the run, so switching runs never shows the
 *     previous run's data under the new name;
 *   • nothing polls the apiserver: pod and TestRun changes are pushed by
 *     watches over the live socket (`/api/live`), the runner output is a
 *     log stream, and only the Prometheus series are re-read — once a
 *     minute, when the live window advances (range queries return the
 *     whole window at full resolution, so nothing is lost between reads);
 *   • once the run ends, one final read keyed by the terminal stage
 *     captures the end state and the series window freezes;
 *   • a failed read keeps the last good data instead of blanking the view.
 */

const client = k8s.K8sClient.auto()
const CONFIG_MAPS: k8s.GVR = { group: '', version: 'v1', resource: 'configmaps', namespaced: true }
const PODS = { group: '', version: 'v1', resource: 'pods' } as const

/** The watch behind a run's pods — `k6_cr` is the label the operator stamps on every pod of a run. */
export function runPodsWatch(namespace: string | undefined, name: string | undefined) {
  return namespace && name ? { ...PODS, namespace, labelSelector: `k6_cr=${name}` } : null
}

/** Every pod the operator created for the run, including retried attempts. */
export function useRunPods(run: TestRun | undefined) {
  const namespace = run?.metadata.namespace
  const name = run?.metadata.name
  const live = run ? isRunning(run) : false
  // Pod phase / container state changes are pushed by an apiserver watch on
  // the run's pods (prefix key, so the stage-suffixed query refetches too).
  // The watch is held only while the run is in flight; afterwards the pods
  // are read once and held. A short throttle keeps runner state changes
  // feeling immediate; the signal ignores status-heartbeat noise.
  const refetchInterval = useWatchSignal(live ? runPodsWatch(namespace, name) : null, [['k6', 'run-pods', namespace, name]], {
    enabled: live,
    fallbackMs: 60_000,
    throttleMs: 1_500,
  })
  return useQuery({
    // The stage is in the key: the read after the run ends is a new query, so
    // the final pod states are fetched exactly once and then held.
    queryKey: ['k6', 'run-pods', namespace, name, live ? 'live' : run?.status?.stage ?? ''],
    queryFn: async (): Promise<PodDetail[]> => {
      const labelled = await client.listPods(undefined, namespace, `k6_cr=${name}`)
      // `k6_cr` is the operator's own label; the prefix match is the fallback
      // for an operator that renamed it. Anchored on `-<n>-`, `-initializer-`,
      // `-starter-` so a run named `load` never adopts `load-r2`'s pods.
      const pods = labelled.length ? labelled : (await client.listPods(undefined, namespace)).filter((p) => {
        const rest = p.metadata.name.slice((name ?? '').length)
        return p.metadata.name.startsWith(`${name}-`) && /^-(?:\d+|initializer|starter)-[a-z0-9]+$/.test(rest)
      })
      return sortPods(pods.map((p) => podDetail(name!, p as unknown as PodLike)))
    },
    enabled: Boolean(namespace && name),
    refetchInterval: live ? refetchInterval : false,
    placeholderData: (prev) => prev,
    retry: false,
  })
}

/** The k6 script the run executes, read from its ConfigMap. Null when unreadable. */
export function useRunScript(run: TestRun | undefined) {
  const cm = run?.spec?.script?.configMap
  const namespace = run?.metadata.namespace
  return useQuery({
    queryKey: ['k6', 'run-script', namespace, cm?.name, cm?.file],
    queryFn: async (): Promise<string | null> => {
      const obj = await kube.get<{ data?: Record<string, string> }>(CONFIG_MAPS, namespace!, cm!.name).catch(() => null)
      if (!obj?.data) return null
      if (cm?.file && obj.data[cm.file] !== undefined) return obj.data[cm.file]
      const key = Object.keys(obj.data).find((k) => k.endsWith('.js') || k.endsWith('.ts'))
      return key ? obj.data[key] : null
    },
    enabled: Boolean(namespace && cm?.name),
    staleTime: Infinity,
    retry: false,
  })
}

export interface LiveSeries {
  name: string
  points: Array<[number, number]>
}

/**
 * Range-query a set of live series over a window. Re-reads when the window
 * advances (`liveWindow` steps it once a minute while live), holds
 * the last result while a new window loads (no flashing back to empty), and
 * reports per-chart emptiness so the view can say which source had nothing.
 */
export function useLiveSeries(queries: LiveQuery[], window: { startMs: number; endMs: number } | null, live: boolean, enabled = true) {
  const on = enabled && Boolean(window)
  const results = useQueries({
    queries: queries.map((q) => ({
      queryKey: ['perf', 'live-series', q.query, window?.startMs, window?.endMs],
      queryFn: () => {
        const step = stepFor(window!.startMs, window!.endMs)
        return queryRange(q.query, window!.startMs, window!.endMs, Math.ceil((window!.endMs - window!.startMs) / 1000 / step))
      },
      enabled: on,
      // No timer: while live the key changes as the window's end advances,
      // which is the once-a-minute read; a finished run's window is frozen.
      refetchInterval: false as const,
      placeholderData: <T,>(prev: T) => prev,
      staleTime: live ? 30_000 : Infinity,
      retry: false,
    })),
  })
  const data = results.map((r) => r.data)
  // Changes only when a query resolves — a stable dependency for the memo.
  const stamp = results.map((r) => r.dataUpdatedAt).join(',')
  const loading = results.some((r) => r.isLoading)
  const error = results.find((r) => r.error)?.error as Error | undefined
  const byChart = useMemo(() => {
    const out = new Map<string, LiveSeries[]>()
    queries.forEach((q, i) => {
      const d = data[i]
      const pts = (d?.series ?? []).flatMap((s) => s.points).map((p): [number, number] => [p.t, p.v * (q.scale ?? 1)])
      if (!pts.length) return
      const list = out.get(q.chart) ?? []
      list.push({ name: q.series, points: pts })
      out.set(q.chart, list)
    })
    return out
  }, [queries, stamp]) // eslint-disable-line react-hooks/exhaustive-deps
  return { byChart, loading, error, any: byChart.size > 0 }
}

/**
 * Every pod's full log, one after another with a header — the "download all
 * logs" bundle. Sequential so a twenty-runner test does not open twenty
 * streams at once.
 */
export async function fetchAllLogs(namespace: string, pods: PodDetail[]): Promise<string> {
  const parts: string[] = []
  for (const p of pods) {
    const text = await kube.logStream(namespace, p.name, { timestamps: true, tailLines: 100_000 }).catch((e) => `(could not read: ${e instanceof Error ? e.message : String(e)})`)
    parts.push(`===== ${p.name} (${p.role}${p.index ? ` ${p.index}` : ''}, ${p.state}${p.exitCode !== undefined ? `, exit ${p.exitCode}` : ''}) =====\n${text.replace(/\s+$/, '')}\n`)
  }
  return parts.join('\n')
}

/* ─────────────────────────── report charts ─────────────────────────── */

/** The query key of a run report's charts — shared by the Report tab and the downloads. */
export function reportChartsKey(i: ReportChartInput | null) {
  return ['perf', 'report-charts', i?.namespace, i?.run, i?.application, i?.targetNamespace, i?.startMs, i?.endMs] as const
}

/**
 * Read every chart of a run report from Prometheus. One failed query is one
 * missing chart (with its reason), never a failed report; Prometheus not being
 * configured at all is one honest error.
 */
export async function fetchReportCharts(i: ReportChartInput): Promise<ReportCharts> {
  const queries = reportChartQueries(i)
  const { start, end, step } = reportWindow(i.startMs, i.endMs)
  const points = Math.max(2, Math.ceil((end - start) / 1000 / step))
  const answers = await Promise.allSettled(queries.map((q) => queryRange(q.query, start, end, points)))
  const notConfigured = answers.find((a) => a.status === 'rejected' && /not configured/.test(String((a.reason as Error)?.message)))
  if (notConfigured) throw (notConfigured as PromiseRejectedResult).reason
  return chartsFromAnswers(
    i,
    queries,
    answers.map((a) => (a.status === 'fulfilled' ? (a.value.series[0]?.points ?? []).map((p): [number, number] => [p.t, p.v]) : undefined)),
  )
}

/** A finished run's report charts, read once and held (its window never moves). */
export function useReportCharts(i: ReportChartInput | null, enabled = true) {
  return useQuery({
    queryKey: reportChartsKey(i),
    queryFn: () => fetchReportCharts(i!),
    enabled: enabled && Boolean(i && i.endMs > i.startMs),
    staleTime: Infinity,
    retry: false,
  })
}
