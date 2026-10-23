/**
 * Heatmap + histogram maths, Grafana semantics.
 *
 * Prometheus `format: heatmap` (classic histogram buckets): series are sorted
 * by their `le` label and de-accumulated per timestamp, so each row holds the
 * count that fell into (previous le, le]. With `calculate: true` (or plain
 * series), samples are bucketed per time column into y buckets (linear or
 * log). Colours come from a quantised d3-style scheme with Grafana's
 * linear / exponential scale; `filterValues.le` hides near-zero cells.
 */

import type { PromSeries } from './grafana-board.ts'
import { blendStops } from './grafana-fields.ts'

export interface HeatmapBucket {
  /** Lower bound (previous `le`, or -∞ / 0 for the first). */
  lo: number
  /** Upper bound (`le`), Infinity for `+Inf`. */
  hi: number
}

export interface HeatmapData {
  /** Column start times (ms). */
  xs: number[]
  /** Column width in ms. */
  xStep: number
  buckets: HeatmapBucket[]
  /** counts[bucket][column] (null = no sample). */
  counts: Array<Array<number | null>>
  min: number
  max: number
  /** The y axis is ordinal bucket rows (Prometheus `le`) vs a numeric scale. */
  ordinal: boolean
}

const MAX_COLUMNS = 400

function parseLe(le: string | undefined): number {
  if (le == null) return NaN
  if (/^\+?inf$/i.test(le)) return Infinity
  return Number(le)
}

/** Prometheus classic-histogram buckets → heatmap rows (de-accumulated). */
export function heatmapFromBuckets(series: PromSeries[]): HeatmapData | null {
  const withLe = series.filter((s) => s.metric.le != null && !Number.isNaN(parseLe(s.metric.le)))
  if (!withLe.length) return null
  // Several label sets per le (no `sum by (le)`)? Sum them, as Grafana's merge does.
  const byLe = new Map<number, Map<number, number>>()
  const times = new Set<number>()
  for (const s of withLe) {
    const le = parseLe(s.metric.le)
    const m = byLe.get(le) ?? new Map<number, number>()
    for (const [t, v] of s.values ?? (s.value ? [s.value] : [])) {
      const n = Number(v)
      if (!Number.isFinite(n)) continue
      const ms = t * 1000
      times.add(ms)
      m.set(ms, (m.get(ms) ?? 0) + n)
    }
    byLe.set(le, m)
  }
  const les = [...byLe.keys()].sort((a, b) => a - b)
  let xs = [...times].sort((a, b) => a - b)
  const step = xs.length > 1 ? medianStep(xs) : 60_000
  let cols = xs.map((t) => les.map((le) => byLe.get(le)!.get(t) ?? null))
  // Downsample wide ranges by summing neighbouring columns.
  if (xs.length > MAX_COLUMNS) {
    const k = Math.ceil(xs.length / MAX_COLUMNS)
    const nx: number[] = []
    const nc: Array<Array<number | null>> = []
    for (let i = 0; i < xs.length; i += k) {
      nx.push(xs[i])
      nc.push(les.map((_, b) => {
        let sum: number | null = null
        for (let j = i; j < Math.min(xs.length, i + k); j++) {
          const v = cols[j][b]
          if (v != null) sum = (sum ?? 0) + v
        }
        return sum
      }))
    }
    xs = nx
    cols = nc
    return finish(xs, step * k, les, cols)
  }
  return finish(xs, step, les, cols)
}

function finish(xs: number[], xStep: number, les: number[], cols: Array<Array<number | null>>): HeatmapData {
  const counts: Array<Array<number | null>> = les.map(() => new Array(xs.length).fill(null))
  let min = Infinity
  let max = -Infinity
  cols.forEach((col, x) => {
    for (let b = 0; b < les.length; b++) {
      const cur = col[b]
      if (cur == null) continue
      const prev = b > 0 ? col[b - 1] ?? 0 : 0
      const v = Math.max(0, cur - prev)
      counts[b][x] = v
      if (v < min) min = v
      if (v > max) max = v
    }
  })
  const buckets = les.map((le, i) => ({ lo: i === 0 ? (le > 0 ? 0 : -Infinity) : les[i - 1], hi: le }))
  return { xs, xStep, buckets, counts, min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0, ordinal: true }
}

function medianStep(xs: number[]): number {
  const d: number[] = []
  for (let i = 1; i < xs.length; i++) d.push(xs[i] - xs[i - 1])
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)] || 60_000
}

/**
 * Grafana's `calculate` heatmap: bucket every series' samples per time
 * column into y buckets. `yScale` log uses powers of `logBase`.
 */
export function calculateHeatmap(
  series: Array<Array<[number, number]>>,
  opts: { yBuckets?: number; yScale?: 'linear' | 'log'; logBase?: number; xBuckets?: number } = {},
): HeatmapData | null {
  const pts = series.flat().filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v))
  if (!pts.length) return null
  const ts = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b)
  const step = ts.length > 1 ? medianStep(ts) : 60_000
  const colCount = Math.min(MAX_COLUMNS, opts.xBuckets ?? ts.length)
  const t0 = ts[0]
  const t1 = ts[ts.length - 1] + step
  const xStep = (t1 - t0) / colCount
  const log = opts.yScale === 'log'
  const base = opts.logBase ?? 2
  const vals = pts.map((p) => p[1]).filter((v) => !log || v > 0)
  if (!vals.length) return null
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  let edges: number[]
  if (log) {
    const a = Math.floor(Math.log(lo) / Math.log(base))
    const b = Math.ceil(Math.log(hi) / Math.log(base))
    edges = []
    for (let e = a; e <= Math.max(b, a + 1); e++) edges.push(base ** e)
  } else {
    if (lo === hi) {
      lo -= 0.5
      hi += 0.5
    }
    const n = Math.max(1, opts.yBuckets ?? 10)
    const size = niceStep((hi - lo) / n)
    const start = Math.floor(lo / size) * size
    edges = []
    for (let e = start; e <= hi + size * 0.5 && edges.length < 200; e += size) edges.push(Number(e.toPrecision(12)))
    if (edges[edges.length - 1] <= hi) edges.push(Number((edges[edges.length - 1] + size).toPrecision(12)))
  }
  const buckets: HeatmapBucket[] = []
  for (let i = 0; i < edges.length - 1; i++) buckets.push({ lo: edges[i], hi: edges[i + 1] })
  const counts: Array<Array<number | null>> = buckets.map(() => new Array(colCount).fill(null))
  for (const [t, v] of pts) {
    if (log && v <= 0) continue
    const x = Math.min(colCount - 1, Math.max(0, Math.floor((t - t0) / xStep)))
    let b = buckets.findIndex((bk) => v >= bk.lo && v < bk.hi)
    if (b < 0) b = buckets.length - 1
    counts[b][x] = (counts[b][x] ?? 0) + 1
  }
  let min = Infinity
  let max = -Infinity
  for (const row of counts) for (const c of row) if (c != null) {
    if (c < min) min = c
    if (c > max) max = c
  }
  return {
    xs: Array.from({ length: colCount }, (_, i) => t0 + i * xStep),
    xStep,
    buckets,
    counts,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 0,
    ordinal: false,
  }
}

/** 1, 2, 2.5, 5 × 10ⁿ at or above `v`. */
export function niceStep(v: number): number {
  if (!(v > 0)) return 1
  const e = Math.floor(Math.log10(v))
  const b = 10 ** e
  const m = v / b
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * b
}

/* ─────────── colour ─────────── */

/** d3-scale-chromatic anchor colours (low → high), plus Grafana's invert rule. */
const SCHEMES: Record<string, { stops: string[]; invert?: 'always' | 'dark' }> = {
  Spectral: { stops: ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'], invert: 'always' },
  RdYlGn: { stops: ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b', '#ffffbf', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837'], invert: 'always' },
  RdYlBu: { stops: ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee090', '#ffffbf', '#e0f3f8', '#abd9e9', '#74add1', '#4575b4', '#313695'], invert: 'always' },
  RdBu: { stops: ['#67001f', '#b2182b', '#d6604d', '#f4a582', '#fddbc7', '#f7f7f7', '#d1e5f0', '#92c5de', '#4393c3', '#2166ac', '#053061'], invert: 'always' },
  Oranges: { stops: ['#fff5eb', '#fee6ce', '#fdd0a2', '#fdae6b', '#fd8d3c', '#f16913', '#d94801', '#a63603', '#7f2704'], invert: 'dark' },
  Reds: { stops: ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'], invert: 'dark' },
  Greens: { stops: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'], invert: 'dark' },
  Blues: { stops: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'], invert: 'dark' },
  Purples: { stops: ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#54278f', '#3f007d'], invert: 'dark' },
  Greys: { stops: ['#ffffff', '#f0f0f0', '#d9d9d9', '#bdbdbd', '#969696', '#737373', '#525252', '#252525', '#000000'], invert: 'dark' },
  YlOrRd: { stops: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'], invert: 'dark' },
  YlGnBu: { stops: ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4', '#1d91c0', '#225ea8', '#253494', '#081d58'], invert: 'dark' },
  Viridis: { stops: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'] },
  Magma: { stops: ['#000004', '#1c1044', '#4f127b', '#812581', '#b5367a', '#e55964', '#fb8761', '#fec287', '#fcfdbf'] },
  Inferno: { stops: ['#000004', '#210c4a', '#56106e', '#89226a', '#bb3754', '#e35933', '#f98e09', '#f9cb35', '#fcffa4'] },
  Plasma: { stops: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'] },
  Turbo: { stops: ['#23171b', '#4a58dd', '#2f9df5', '#27d7c4', '#4df884', '#95fb51', '#dedd32', '#ffa423', '#f65f18', '#ba2208', '#900c00'] },
  Cividis: { stops: ['#002051', '#0d346b', '#33486e', '#575c6d', '#76706f', '#968671', '#b89c6c', '#dbb45e', '#fdcd4b', '#fdea45'] },
  Warm: { stops: ['#6e40aa', '#a83cb3', '#df40a1', '#ff507a', '#ff704e', '#f89b31', '#d2c934', '#aff05b'] },
  Cool: { stops: ['#6e40aa', '#5e57d0', '#4a77e5', '#3694e0', '#25b1cc', '#1ac7b0', '#1ddea0', '#28ea8d', '#aff05b'] },
}

export interface HeatmapColorOptions {
  mode?: 'scheme' | 'opacity'
  scheme?: string
  fill?: string
  scale?: 'linear' | 'exponential'
  exponent?: number
  steps?: number
  reverse?: boolean
  min?: number
  max?: number
}

/** Quantised palette, low → high, as Grafana builds it. */
export function heatmapPalette(o: HeatmapColorOptions, dark = false): string[] {
  const s = SCHEMES[o.scheme ?? 'Oranges'] ?? SCHEMES.Oranges
  const n = Math.max(2, Math.min(128, o.steps ?? 64))
  let colors = Array.from({ length: n }, (_, i) => blendStops(s.stops, i / (n - 1)))
  if (s.invert === 'always' || (s.invert === 'dark' && dark)) colors = colors.reverse()
  if (o.reverse) colors = colors.reverse()
  return colors
}

/** Position 0..1 of a count on the colour scale. */
export function heatmapScale(v: number, min: number, max: number, o: HeatmapColorOptions): number {
  const lo = o.min ?? min
  const hi = o.max ?? max
  if (hi <= lo) return 1
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
  return o.scale === 'exponential' ? t ** (o.exponent ?? 0.5) : t
}

/* ─────────── histogram ─────────── */

export interface HistogramBar {
  lo: number
  hi: number
  count: number
}

/** Grafana histogram panel: bucket all values (auto size → ~ 30 buckets). */
export function histogram(values: number[], opts: { bucketSize?: number; bucketOffset?: number; bucketCount?: number } = {}): HistogramBar[] {
  const v = values.filter((x) => Number.isFinite(x))
  if (!v.length) return []
  const lo = Math.min(...v)
  const hi = Math.max(...v)
  const size = opts.bucketSize && opts.bucketSize > 0 ? opts.bucketSize : niceStep((hi - lo || Math.abs(hi) || 1) / (opts.bucketCount ?? 30))
  const off = opts.bucketOffset ?? 0
  const start = Math.floor((lo - off) / size) * size + off
  const n = Math.min(500, Math.floor((hi - start) / size) + 1)
  const bars: HistogramBar[] = Array.from({ length: n }, (_, i) => ({ lo: start + i * size, hi: start + (i + 1) * size, count: 0 }))
  for (const x of v) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((x - start) / size)))
    bars[i].count++
  }
  return bars
}
