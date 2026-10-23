/**
 * Time series maths for the native Grafana timeseries panel: per-series
 * draw styles from field config, gap handling (insertNulls / spanNulls),
 * stacking (normal / percent, per group, negatives stacked apart), the
 * `negative-Y` transform, y-axis ranges + ticks (linear and log) and path
 * building (linear, smooth, step). All pure — the view only paints.
 */

import type { FieldDefaults } from './grafana-board.ts'

export type Pt = [number, number | null]

export interface SeriesStyle {
  drawStyle: 'line' | 'bars' | 'points'
  lineWidth: number
  fillOpacity: number
  gradientMode: string
  lineInterpolation: 'linear' | 'smooth' | 'stepBefore' | 'stepAfter'
  dash?: number[]
  showPoints: 'auto' | 'never' | 'always'
  pointSize: number
  stackGroup?: string
  stackMode: 'none' | 'normal' | 'percent'
  negativeY: boolean
  axisPlacement: 'auto' | 'left' | 'right' | 'hidden'
  spanNulls: boolean | number
  insertNulls: false | number | undefined
  hideLegend: boolean
  hideTooltip: boolean
  hideViz: boolean
  scaleLog?: number
  axisSoftMin?: number
  axisSoftMax?: number
  barAlignment: number
}

/** Field config → draw style (Grafana defaults where unset). */
export function seriesStyle(cfg: FieldDefaults): SeriesStyle {
  const c = (cfg.custom ?? {}) as Record<string, unknown>
  const stacking = (c.stacking ?? {}) as { mode?: string; group?: string }
  const lineStyle = (c.lineStyle ?? {}) as { fill?: string; dash?: number[] }
  const hide = (c.hideFrom ?? {}) as { legend?: boolean; tooltip?: boolean; viz?: boolean }
  const scale = (c.scaleDistribution ?? {}) as { type?: string; log?: number }
  const dash = lineStyle.fill === 'dash' ? (lineStyle.dash?.length ? lineStyle.dash : [10, 10]) : lineStyle.fill === 'dot' ? [0, 10] : undefined
  return {
    drawStyle: c.drawStyle === 'bars' ? 'bars' : c.drawStyle === 'points' ? 'points' : 'line',
    lineWidth: typeof c.lineWidth === 'number' ? c.lineWidth : 1,
    fillOpacity: typeof c.fillOpacity === 'number' ? c.fillOpacity : 0,
    gradientMode: typeof c.gradientMode === 'string' ? c.gradientMode : 'none',
    lineInterpolation: (['smooth', 'stepBefore', 'stepAfter'].includes(String(c.lineInterpolation)) ? c.lineInterpolation : 'linear') as SeriesStyle['lineInterpolation'],
    dash,
    showPoints: c.showPoints === 'always' ? 'always' : c.showPoints === 'never' ? 'never' : 'auto',
    pointSize: typeof c.pointSize === 'number' ? c.pointSize : 5,
    stackGroup: stacking.group ?? 'A',
    stackMode: stacking.mode === 'normal' ? 'normal' : stacking.mode === 'percent' ? 'percent' : 'none',
    negativeY: c.transform === 'negative-Y',
    axisPlacement: (['left', 'right', 'hidden'].includes(String(c.axisPlacement)) ? c.axisPlacement : 'auto') as SeriesStyle['axisPlacement'],
    spanNulls: typeof c.spanNulls === 'number' || typeof c.spanNulls === 'boolean' ? c.spanNulls : false,
    insertNulls: c.insertNulls === false ? false : typeof c.insertNulls === 'number' ? c.insertNulls : undefined,
    hideLegend: !!hide.legend,
    hideTooltip: !!hide.tooltip,
    hideViz: !!hide.viz,
    scaleLog: scale.type === 'log' ? (scale.log ?? 2) : undefined,
    axisSoftMin: typeof c.axisSoftMin === 'number' ? c.axisSoftMin : undefined,
    axisSoftMax: typeof c.axisSoftMax === 'number' ? c.axisSoftMax : undefined,
    barAlignment: typeof c.barAlignment === 'number' ? c.barAlignment : 0,
  }
}

/**
 * Split samples into drawable runs. Nulls are inserted where samples are more
 * than `threshold` apart (Grafana's null-insert, threshold = step unless
 * `insertNulls` says otherwise); a null breaks the line unless `spanNulls`
 * is true, or a number ≥ the gap it spans.
 */
export function splitRuns(points: Pt[], spanNulls: boolean | number, threshold: number | false | undefined): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = []
  let cur: Array<[number, number]> = []
  let prevT: number | null = null
  for (const [t, v] of points) {
    const gap = prevT == null ? 0 : t - prevT
    const missing = v == null || !Number.isFinite(v)
    const nullGap = prevT != null && threshold && gap > threshold
    if (missing) continue
    if (nullGap && cur.length) {
      const connect = spanNulls === true || (typeof spanNulls === 'number' && spanNulls > 0 && gap <= spanNulls)
      if (!connect) {
        runs.push(cur)
        cur = []
      }
    }
    cur.push([t, v as number])
    prevT = t
  }
  // Explicit nulls (from transforms / joins) also break unless spanned.
  if (cur.length) runs.push(cur)
  if (spanNulls === true) return runs
  return runs.flatMap((r) => breakOnExplicitNulls(r, points, spanNulls))
}

function breakOnExplicitNulls(run: Array<[number, number]>, all: Pt[], spanNulls: boolean | number): Array<Array<[number, number]>> {
  if (!all.some(([, v]) => v == null)) return [run]
  const nullTimes = all.filter(([, v]) => v == null).map(([t]) => t)
  const out: Array<Array<[number, number]>> = []
  let cur: Array<[number, number]> = []
  for (let i = 0; i < run.length; i++) {
    if (i > 0) {
      const a = run[i - 1][0]
      const b = run[i][0]
      const hasNull = nullTimes.some((t) => t > a && t < b)
      const spanned = typeof spanNulls === 'number' && spanNulls > 0 && b - a <= spanNulls
      if (hasNull && !spanned) {
        out.push(cur)
        cur = []
      }
    }
    cur.push(run[i])
  }
  if (cur.length) out.push(cur)
  return out
}

/* ─────────── stacking ─────────── */

export interface StackInput {
  points: Pt[]
  style: SeriesStyle
}

/**
 * Stack series per (group, direction): every timestamp's values accumulate
 * in series order. Percent mode normalises each timestamp to 0..1. Returns
 * per-series [t, bottom, top] triples; unstacked series get bottom 0.
 */
export function stackSeries(list: StackInput[]): Array<Array<[number, number, number]>> {
  const out: Array<Array<[number, number, number]>> = list.map(() => [])
  const groups = new Map<string, number[]>()
  list.forEach((s, i) => {
    const sign = (v: number | null) => (v ?? 0) * (s.style.negativeY ? -1 : 1)
    if (s.style.stackMode === 'none') {
      out[i] = s.points.filter(([, v]) => v != null && Number.isFinite(v)).map(([t, v]) => [t, 0, sign(v)])
      return
    }
    const neg = s.style.negativeY || s.points.every(([, v]) => v == null || v <= 0) ? '-' : '+'
    const key = `${s.style.stackMode}:${s.style.stackGroup}:${neg}`
    groups.set(key, [...(groups.get(key) ?? []), i])
  })
  for (const [key, idx] of groups) {
    const percent = key.startsWith('percent')
    const totals = new Map<number, number>()
    if (percent) {
      for (const i of idx) for (const [t, v] of list[i].points) if (v != null && Number.isFinite(v)) totals.set(t, (totals.get(t) ?? 0) + Math.abs(v))
    }
    const acc = new Map<number, number>()
    for (const i of idx) {
      const s = list[i]
      const dir = s.style.negativeY ? -1 : 1
      out[i] = s.points
        .filter(([, v]) => v != null && Number.isFinite(v))
        .map(([t, v]) => {
          let val = (v as number) * dir
          if (percent) val = (totals.get(t) ? Math.abs(v as number) / totals.get(t)! : 0) * Math.sign(dir)
          const bottom = acc.get(t) ?? 0
          const top = bottom + val
          acc.set(t, top)
          return [t, bottom, top]
        })
    }
  }
  return out
}

/* ─────────── axes ─────────── */

/** Grafana-ish axis range: data extent widened by soft limits, hard min/max win. */
export function axisRange(
  values: number[],
  o: { min?: number; max?: number; softMin?: number; softMax?: number; log?: number; bars?: boolean },
): { min: number; max: number } {
  const v = values.filter((x) => Number.isFinite(x) && (!o.log || x > 0))
  let lo = v.length ? Math.min(...v) : 0
  let hi = v.length ? Math.max(...v) : 1
  if (o.softMin != null) lo = Math.min(lo, o.softMin)
  if (o.softMax != null) hi = Math.max(hi, o.softMax)
  if (o.bars && !o.log) {
    lo = Math.min(lo, 0)
    hi = Math.max(hi, 0)
  }
  if (o.log) {
    const b = o.log
    lo = o.min && o.min > 0 ? o.min : b ** Math.floor(Math.log(lo || 1) / Math.log(b))
    hi = o.max ?? b ** Math.ceil(Math.log(hi || b) / Math.log(b))
    if (hi <= lo) hi = lo * b
    return { min: lo, max: hi }
  }
  if (lo === hi) {
    const d = lo === 0 ? 1 : Math.abs(lo) * 0.1
    lo -= d
    hi += d
  }
  // uPlot's padded range (10%), clamped at zero when the data does not cross it.
  const pad = (hi - lo) * 0.1
  let pLo = lo - pad
  let pHi = hi + pad
  if (lo >= 0 && pLo < 0) pLo = 0
  if (hi <= 0 && pHi > 0) pHi = 0
  const step = niceTickStep(pHi - pLo, 5)
  const min = o.min ?? Math.floor(pLo / step) * step
  let max = o.max ?? Math.ceil(pHi / step) * step
  if (max <= min) max = min + step
  return { min, max }
}

/** 1/2/5 × 10ⁿ tick step for `span` over ~`count` ticks. */
export function niceTickStep(span: number, count: number): number {
  const raw = Math.abs(span) / Math.max(1, count)
  if (!(raw > 0)) return 1
  const e = Math.floor(Math.log10(raw))
  const b = 10 ** e
  const m = raw / b
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * b
}

/**
 * Tick values inside [min, max]. `decimals` (the field's) keeps the step at
 * or above 10^-decimals, so a 0-decimal axis never repeats `1, 1, 1`.
 */
export function axisTicks(min: number, max: number, count: number, log?: number, decimals?: number): number[] {
  if (log) {
    const out: number[] = []
    for (let e = Math.ceil(Math.log(min) / Math.log(log) - 1e-9); log ** e <= max * (1 + 1e-9) && out.length < 30; e++) out.push(log ** e)
    return out
  }
  const step = Math.max(niceTickStep(max - min, count), decimals != null ? 10 ** -decimals : 0)
  const out: number[] = []
  const start = Math.ceil(min / step - 1e-9) * step
  for (let v = start; v <= max + step * 1e-9 && out.length < 50; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

/* ─────────── paths ─────────── */

/** SVG path for a run of pixel points, by interpolation mode. */
export function linePath(px: Array<[number, number]>, mode: SeriesStyle['lineInterpolation']): string {
  if (!px.length) return ''
  const f = (n: number) => n.toFixed(1)
  if (px.length === 1) return `M${f(px[0][0])},${f(px[0][1])}`
  if (mode === 'stepAfter' || mode === 'stepBefore') {
    let d = `M${f(px[0][0])},${f(px[0][1])}`
    for (let i = 1; i < px.length; i++) {
      d += mode === 'stepAfter' ? `H${f(px[i][0])}V${f(px[i][1])}` : `V${f(px[i][1])}H${f(px[i][0])}`
    }
    return d
  }
  if (mode === 'smooth' && px.length > 2) return monotonePath(px)
  return px.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)},${f(y)}`).join('')
}

/** Monotone cubic (Fritsch–Carlson), as uPlot's spline: no overshoot. */
export function monotonePath(p: Array<[number, number]>): string {
  const n = p.length
  const dx: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(p[i + 1][0] - p[i][0])
    m.push(dx[i] === 0 ? 0 : (p[i + 1][1] - p[i][1]) / dx[i])
  }
  const t: number[] = [m[0]]
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t.push(0)
    else {
      const w1 = 2 * dx[i] + dx[i - 1]
      const w2 = dx[i] + 2 * dx[i - 1]
      t.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]))
    }
  }
  t.push(m[n - 2])
  const f = (v: number) => v.toFixed(1)
  let d = `M${f(p[0][0])},${f(p[0][1])}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += `C${f(p[i][0] + h)},${f(p[i][1] + t[i] * h)} ${f(p[i + 1][0] - h)},${f(p[i + 1][1] - t[i + 1] * h)} ${f(p[i + 1][0])},${f(p[i + 1][1])}`
  }
  return d
}

/** Nearest sample index to `t` in a sorted list (binary search). */
export function nearestIndex(ts: number[], t: number): number {
  let lo = 0
  let hi = ts.length - 1
  if (hi < 0) return -1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts[mid] < t) lo = mid
    else hi = mid
  }
  return Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi
}
