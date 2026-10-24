import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { k8s } from '@adhar/api-clients'
import { kube } from '@adhar/api-clients/k8s'
import { isRunning, type TestRun } from './k6.ts'
import { queryRange } from './perf-metrics.ts'
import { type LiveQuery, stepFor } from './perf-live.ts'
import { type PodDetail, podDetail, type PodLike, sortPods } from './perf-run-model.ts'

/**
 * The run drawer's reads — pods, the script behind the run, and the live
 * series — with the polling discipline the drawer needs to stay stable:
 *
 *   • every query is keyed by the run, so switching runs never shows the
 *     previous run's data under the new name;
 *   • polling runs only while the run is in flight (and React Query pauses it
 *     while the tab is hidden), and stops by itself once the run ends — one
 *     final read, keyed by the terminal stage, captures the end state;
 *   • a failed read keeps the last good data instead of blanking the view.
 */

const client = k8s.K8sClient.auto()
const CONFIG_MAPS: k8s.GVR = { group: '', version: 'v1', resource: 'configmaps', namespaced: true }

/** Every pod the operator created for the run, including retried attempts. */
export function useRunPods(run: TestRun | undefined) {
  const namespace = run?.metadata.namespace
  const name = run?.metadata.name
  const live = run ? isRunning(run) : false
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
    refetchInterval: live ? 4_000 : false,
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
 * Range-query a set of live series over a window. Polls while `live`, holds
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
      refetchInterval: on && live ? 10_000 : (false as const),
      placeholderData: <T,>(prev: T) => prev,
      staleTime: live ? 5_000 : Infinity,
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
