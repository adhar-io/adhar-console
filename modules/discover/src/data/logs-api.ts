import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { lokiMatrix, type PromMatrixSeries, sampleNum } from './backends.ts'
import { stepFor, volumeQueries } from './logql.ts'
import { type HistogramBucket, selectionToWindow, TIME_RANGES, type TimeSelection } from './observability.ts'
import { MIN_REFRESH_MS, windowRefreshMs } from './refresh.ts'

/**
 * Loki metric-side hooks for the Logs workbench:
 *
 *   • `useLogVolume`  — the *full* volume of a log query across the window
 *                       (Loki `count_over_time`), split by keyword-detected
 *                       level. Unlike the histogram derived from fetched lines
 *                       it isn't capped by the line limit.
 *   • `useLogMetric`  — runs a LogQL metric query (`rate(...)`, `sum by`)
 *                       and returns its series for charting.
 */

/** A preset's span in ms (0 for absolute windows, which never refresh). */
function presetWindowMs(sel: TimeSelection): number {
  return sel.kind === 'preset' ? (TIME_RANGES.find((r) => r.id === sel.id)?.ms ?? 0) : 0
}

function windowKey(sel: TimeSelection): string {
  return sel.kind === 'absolute' ? `${sel.from}|${sel.to}` : sel.id
}

function toMap(series: PromMatrixSeries[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const [t, v] of series[0]?.values ?? []) m.set(Number(t), sampleNum(v) ?? 0)
  return m
}

export function useLogVolume(query: string, sel: TimeSelection, enabled: boolean, live = false) {
  return useQuery({
    queryKey: ['loki', 'volume', query, windowKey(sel)],
    queryFn: async (): Promise<{ buckets: HistogramBucket[]; stepSec: number; total: number }> => {
      const { start, end } = selectionToWindow(sel)
      const stepSec = stepFor(end.getTime() - start.getTime(), 60)
      const qs = volumeQueries(query, stepSec)!
      const [total, error, warn] = await Promise.all([
        lokiMatrix(qs.total, start, end, stepSec),
        lokiMatrix(qs.error, start, end, stepSec).catch(() => [] as PromMatrixSeries[]),
        lokiMatrix(qs.warn, start, end, stepSec).catch(() => [] as PromMatrixSeries[]),
      ])
      const tm = toMap(total)
      const em = toMap(error)
      const wm = toMap(warn)
      // Loki stamps a sample at the END of its [step] range; draw it over the bucket it covers.
      const t0 = Math.floor(start.getTime() / 1000 / stepSec) * stepSec
      const buckets: HistogramBucket[] = []
      let sum = 0
      for (let t = t0 + stepSec; t <= end.getTime() / 1000 + stepSec; t += stepSec) {
        const all = tm.get(t) ?? 0
        const e = Math.min(all, em.get(t) ?? 0)
        const w = Math.min(all - e, wm.get(t) ?? 0)
        sum += all
        buckets.push({ start: (t - stepSec) * 1000, end: t * 1000, error: e, warn: w, info: Math.max(0, all - e - w) })
      }
      return { buckets, stepSec, total: sum }
    },
    enabled: enabled && !!volumeQueries(query, 60),
    placeholderData: keepPreviousData,
    refetchInterval: sel.kind === 'preset' ? (live ? MIN_REFRESH_MS : windowRefreshMs(presetWindowMs(sel))) : false,
    retry: false,
  })
}

export function useLogMetric(query: string, sel: TimeSelection, enabled: boolean) {
  return useQuery({
    queryKey: ['loki', 'metric', query, windowKey(sel)],
    queryFn: async () => {
      const { start, end } = selectionToWindow(sel)
      const stepSec = stepFor(end.getTime() - start.getTime(), 120)
      const series = await lokiMatrix(query, start, end, stepSec)
      return series.map((s) => ({
        metric: s.metric,
        points: s.values.map(([t, v]) => [Number(t) * 1000, sampleNum(v) ?? NaN] as [number, number]).filter(([, v]) => Number.isFinite(v)),
      }))
    },
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: sel.kind === 'preset' ? windowRefreshMs(presetWindowMs(sel)) : false,
    retry: false,
  })
}
