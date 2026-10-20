import type * as metabase from './mb-types.ts'

/**
 * Query result → something drawable.
 *
 * Metabase hands back rows and typed columns; the visualisation choice (`display`)
 * and the optional `graph.dimensions` / `graph.metrics` settings say how a card
 * wants to be drawn. This module turns that into a small chart model the SVG
 * renderer consumes, and does the formatting every view shares. It never
 * invents a value: an unusable shape comes back as `{ error }` and the card
 * says so, with a "view as table" fallback.
 */

type Cell = metabase.MbCell
type Col = metabase.MbColumn

export type ColKind = 'time' | 'number' | 'category' | 'boolean'

const TEMPORAL = /type\/(Date|DateTime|Time|Instant|DateTimeWithTZ|DateTimeWithLocalTZ|DateTimeWithZoneID|DateTimeWithZoneOffset|Temporal)/
const NUMERIC = /type\/(Integer|BigInteger|Float|Decimal|Number|Currency|Percentage|Share|Score)/

/** The kind of a column, from its declared type, else from its values. */
export function colKind(col: Col, rows?: Cell[][], index?: number): ColKind {
  const t = `${col.effective_type ?? ''} ${col.base_type ?? ''}`
  const sem = col.semantic_type ?? ''
  if (TEMPORAL.test(t) || (col.unit && !/-of-/.test(col.unit))) return 'time'
  if (/type\/Boolean/.test(t)) return 'boolean'
  // Keys are numbers you don't add up.
  if (/type\/(PK|FK)/.test(sem)) return 'category'
  if (NUMERIC.test(t)) return 'number'
  if (/type\/(Text|Category|UUID|Name|Title|Email|URL)/.test(t)) return 'category'
  if (rows && index != null) {
    const sample = rows.slice(0, 50).map((r) => r[index]).filter((v) => v != null)
    if (sample.length) {
      if (sample.every((v) => typeof v === 'number')) return 'number'
      if (sample.every((v) => typeof v === 'boolean')) return 'boolean'
      if (sample.every((v) => typeof v === 'string' && ISO_RE.test(v))) return 'time'
    }
  }
  return 'category'
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/

/**
 * A timestamp as WALL-CLOCK time, encoded as a UTC epoch.
 *
 * Metabase returns temporal values already shifted into the report timezone
 * (`2026-01-05T00:00:00-05:00`). Converting that to the browser's zone would
 * move a "January" bucket into December for anyone east of it. Reading the
 * wall-clock fields and formatting them back in UTC keeps the bucket the
 * label Metabase meant.
 */
export function wallTime(v: Cell): number | null {
  if (v == null || typeof v === 'boolean') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const m = ISO_RE.exec(v)
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0)
  }
  // Year-only buckets come back as plain "2024" from some drivers.
  if (/^\d{4}$/.test(v)) return Date.UTC(+v, 0, 1)
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

export function toNumber(v: Cell): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v)
  return v.trim() !== '' && Number.isFinite(n) ? n : null
}

/* ─────────── chart model ─────────── */

export interface ChartSeries {
  key: string
  name: string
  values: (number | null)[]
}

export interface ChartModel {
  xKind: 'time' | 'category'
  /** Epoch ms (time) or labels (category), in draw order. */
  x: Array<number | string>
  series: ChartSeries[]
  xName: string
  yName: string
  /** Temporal bucket, when known (`day`, `month`…). */
  unit?: string
  /** Series folded into "Other" to stay within the palette. */
  folded: number
}

export const MAX_SERIES = 8

/**
 * Columns a chart uses: Metabase's explicit `graph.dimensions` / `graph.metrics`
 * when they name real columns, else the first non-numeric column(s) as
 * dimensions and every numeric column as a metric.
 */
export function pickColumns(cols: Col[], rows: Cell[][], settings?: Record<string, unknown>): { dims: number[]; metrics: number[] } {
  const byName = (n: unknown) => cols.findIndex((c) => c.name === n)
  const sd = Array.isArray(settings?.['graph.dimensions']) ? (settings!['graph.dimensions'] as unknown[]).map(byName) : []
  const sm = Array.isArray(settings?.['graph.metrics']) ? (settings!['graph.metrics'] as unknown[]).map(byName) : []
  if (sd.length && sm.length && sd.every((i) => i >= 0) && sm.every((i) => i >= 0)) {
    return { dims: sd.slice(0, 2), metrics: sm }
  }
  const kinds = cols.map((c, i) => colKind(c, rows, i))
  let dims = kinds.map((k, i) => (k !== 'number' ? i : -1)).filter((i) => i >= 0)
  let metrics = kinds.map((k, i) => (k === 'number' ? i : -1)).filter((i) => i >= 0)
  // All numeric (e.g. `SELECT year, revenue` where year is an int): first column is the axis.
  if (dims.length === 0 && metrics.length >= 2) {
    dims = [metrics[0]]
    metrics = metrics.slice(1)
  }
  // A time dimension leads, whatever its position.
  const timeDim = dims.find((i) => kinds[i] === 'time')
  if (timeDim != null) dims = [timeDim, ...dims.filter((i) => i !== timeDim)]
  return { dims: dims.slice(0, 2), metrics }
}

/** Build the chart model, or explain why the result can't be charted. */
export function toChartModel(cols: Col[], rows: Cell[][], settings?: Record<string, unknown>): ChartModel | { error: string } {
  if (!cols.length || !rows.length) return { error: 'No rows to chart.' }
  const { dims, metrics } = pickColumns(cols, rows, settings)
  if (!dims.length) return { error: 'This result has no column to put on the x-axis.' }
  if (!metrics.length) return { error: 'This result has no numeric column to plot.' }
  const xi = dims[0]
  const xKind: 'time' | 'category' = colKind(cols[xi], rows, xi) === 'time' ? 'time' : 'category'
  const keyOf = (v: Cell): number | string | null => (xKind === 'time' ? wallTime(v) : v == null ? '(empty)' : String(v))

  // Order of x values: chronological for time, first-seen for categories.
  const xs: Array<number | string> = []
  const xIndex = new Map<number | string, number>()
  for (const r of rows) {
    const k = keyOf(r[xi])
    if (k == null || xIndex.has(k)) continue
    xIndex.set(k, xs.length)
    xs.push(k)
  }
  if (xKind === 'time') {
    xs.sort((a, b) => (a as number) - (b as number))
    xs.forEach((k, i) => xIndex.set(k, i))
  }

  let series: ChartSeries[]
  let yName = cols[metrics[0]].display_name ?? cols[metrics[0]].name
  if (dims.length >= 2) {
    // Breakout: one series per value of the second dimension, first metric.
    const bi = dims[1]
    const mi = metrics[0]
    const map = new Map<string, (number | null)[]>()
    for (const r of rows) {
      const k = keyOf(r[xi])
      if (k == null) continue
      const s = r[bi] == null ? '(empty)' : String(r[bi])
      if (!map.has(s)) map.set(s, new Array(xs.length).fill(null))
      const arr = map.get(s)!
      const n = toNumber(r[mi])
      if (n != null) arr[xIndex.get(k)!] = (arr[xIndex.get(k)!] ?? 0) + n
    }
    series = [...map.entries()].map(([name, values]) => ({ key: name, name, values }))
  } else {
    series = metrics.map((mi) => {
      const values: (number | null)[] = new Array(xs.length).fill(null)
      for (const r of rows) {
        const k = keyOf(r[xi])
        if (k == null) continue
        const n = toNumber(r[mi])
        if (n != null) values[xIndex.get(k)!] = (values[xIndex.get(k)!] ?? 0) + n
      }
      const c = cols[mi]
      return { key: c.name, name: c.display_name ?? c.name, values }
    })
    if (metrics.length > 1) yName = ''
  }

  const { kept, folded } = foldSeries(series)
  return {
    xKind,
    x: xs,
    series: kept,
    xName: cols[xi].display_name ?? cols[xi].name,
    yName,
    unit: cols[xi].unit,
    folded,
  }
}

/**
 * Keep at most `MAX_SERIES`: the largest by total, in their original order,
 * with the rest summed into "Other". A ninth hue is never generated.
 */
export function foldSeries(series: ChartSeries[]): { kept: ChartSeries[]; folded: number } {
  if (series.length <= MAX_SERIES) return { kept: series, folded: 0 }
  const total = (s: ChartSeries) => s.values.reduce<number>((a, v) => a + Math.abs(v ?? 0), 0)
  const ranked = [...series].sort((a, b) => total(b) - total(a))
  const keepSet = new Set(ranked.slice(0, MAX_SERIES - 1).map((s) => s.key))
  const kept = series.filter((s) => keepSet.has(s.key))
  const rest = series.filter((s) => !keepSet.has(s.key))
  const other: ChartSeries = {
    key: '__other__',
    name: `Other (${rest.length})`,
    values: series[0].values.map((_, i) => {
      let sum: number | null = null
      for (const s of rest) if (s.values[i] != null) sum = (sum ?? 0) + (s.values[i] as number)
      return sum
    }),
  }
  return { kept: [...kept, other], folded: rest.length }
}

/* ─────────── pie / funnel ─────────── */

export interface Slice {
  label: string
  value: number
  share: number
}

/** Slices largest first; beyond `max - 1` they fold into "Other". Negative values are dropped (they have no share). */
export function toSlices(cols: Col[], rows: Cell[][], settings?: Record<string, unknown>, max = 7): Slice[] | { error: string } {
  const { dims, metrics } = pickColumns(cols, rows, {
    'graph.dimensions': settings?.['pie.dimension'] ? [settings['pie.dimension']].flat() : undefined,
    'graph.metrics': settings?.['pie.metric'] ? [settings['pie.metric']] : undefined,
  })
  if (!dims.length || !metrics.length) return { error: 'A share chart needs one label column and one number column.' }
  const acc = new Map<string, number>()
  for (const r of rows) {
    const n = toNumber(r[metrics[0]])
    if (n == null || n < 0) continue
    const label = r[dims[0]] == null ? '(empty)' : String(r[dims[0]])
    acc.set(label, (acc.get(label) ?? 0) + n)
  }
  const all = [...acc.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)
  const total = all.reduce((a, s) => a + s.value, 0)
  if (!all.length || total <= 0) return { error: 'Nothing to share out — every value is zero or empty.' }
  let kept = all
  if (all.length > max) {
    const rest = all.slice(max - 1)
    kept = [...all.slice(0, max - 1), { label: `Other (${rest.length})`, value: rest.reduce((a, s) => a + s.value, 0) }]
  }
  return kept.map((s) => ({ ...s, share: s.value / total }))
}

/* ─────────── scalars ─────────── */

export interface ScalarModel {
  value: number | string | null
  col?: Col
  /** Previous period, for "smart" scalars. */
  previous?: number | null
  /** Fractional change vs previous (0.1 = +10%). */
  change?: number | null
  /** Label of the period the value is for. */
  period?: string
  previousPeriod?: string
}

/** A number card's value: the `scalar.field` column when set, else the first numeric column of the first row. */
export function toScalar(ds: metabase.MbDataset, settings?: Record<string, unknown>): ScalarModel {
  const cols = ds.data?.cols ?? []
  const rows = ds.data?.rows ?? []
  if (!rows.length || !cols.length) return { value: null }
  let ci = cols.findIndex((c) => c.name === settings?.['scalar.field'])
  if (ci < 0) ci = cols.findIndex((c, i) => colKind(c, rows, i) === 'number')
  if (ci < 0) ci = 0
  const v = rows[0][ci]
  return { value: typeof v === 'boolean' ? String(v) : v, col: cols[ci] }
}

/**
 * Trend ("smart") number: the latest bucket vs the one before it. Uses
 * Metabase's own `insights` when the query returned them; otherwise the last
 * two rows by time. With one row there is nothing to compare — no delta shown.
 */
export function toSmartScalar(ds: metabase.MbDataset): ScalarModel {
  const cols = ds.data?.cols ?? []
  const rows = ds.data?.rows ?? []
  if (!rows.length) return { value: null }
  const ti = cols.findIndex((c, i) => colKind(c, rows, i) === 'time')
  const mi = cols.findIndex((c, i) => i !== ti && colKind(c, rows, i) === 'number')
  if (mi < 0) return toScalar(ds)
  const ins = ds.data?.insights?.find((x) => x.col === cols[mi].name)
  const sorted = ti >= 0 ? [...rows].sort((a, b) => (wallTime(a[ti]) ?? 0) - (wallTime(b[ti]) ?? 0)) : rows
  const last = sorted[sorted.length - 1]
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : undefined
  const value = ins?.['last-value'] ?? toNumber(last[mi])
  const previous = ins ? ins['previous-value'] ?? null : prev ? toNumber(prev[mi]) : null
  const change = ins?.['last-change'] ?? (previous != null && value != null && previous !== 0 ? (value - previous) / Math.abs(previous) : null)
  const unit = cols[ti]?.unit
  return {
    value,
    col: cols[mi],
    previous,
    change,
    period: ti >= 0 ? formatTime(wallTime(last[ti]) ?? 0, unit) : undefined,
    previousPeriod: ti >= 0 && prev ? formatTime(wallTime(prev[ti]) ?? 0, unit) : undefined,
  }
}

/* ─────────── auto display ─────────── */

/** What to draw when the card says "table" by default or the user picks "auto". */
export function autoDisplay(cols: Col[], rows: Cell[][]): string {
  if (rows.length === 1 && cols.length === 1) return 'scalar'
  if (!rows.length) return 'table'
  const kinds = cols.map((c, i) => colKind(c, rows, i))
  const hasNum = kinds.includes('number')
  if (kinds[0] === 'time' && hasNum && cols.length <= 4) return 'line'
  if (kinds.includes('time') && hasNum && cols.length <= 3) return 'line'
  if (kinds[0] === 'category' && hasNum && cols.length <= 3 && rows.length <= 30) return rows.length > 8 ? 'row' : 'bar'
  return 'table'
}

/** Visualisations the switcher offers for a result, with their availability. */
export const VIZ_OPTIONS: { id: string; label: string }[] = [
  { id: 'table', label: 'Table' },
  { id: 'scalar', label: 'Number' },
  { id: 'smartscalar', label: 'Trend' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'bar', label: 'Bar' },
  { id: 'row', label: 'Row' },
  { id: 'combo', label: 'Combo' },
  { id: 'pie', label: 'Share' },
  { id: 'pivot', label: 'Pivot' },
]

/** Whether a visualisation can draw this result at all. */
export function vizSupported(display: string, cols: Col[], rows: Cell[][]): boolean {
  if (display === 'table') return true
  if (display === 'pivot') return !('error' in toPivot(cols, rows))
  // A single number only means something for a single-row result.
  if (display === 'scalar') return rows.length === 1
  if (display === 'smartscalar') return cols.some((c, i) => colKind(c, rows, i) === 'time') && cols.some((c, i) => colKind(c, rows, i) === 'number')
  if (display === 'pie') return !('error' in (toSlices(cols, rows) as object))
  const m = toChartModel(cols, rows)
  return !('error' in m)
}

/* ─────────── pivot-lite ─────────── */

export interface PivotModel {
  rowHeader: string
  colHeader: string
  rowKeys: string[]
  colKeys: string[]
  cells: (number | null)[][]
  rowTotals: number[]
  colTotals: number[]
  grand: number
}

/** First two dimensions as rows × columns, first metric summed into cells. */
export function toPivot(cols: Col[], rows: Cell[][]): PivotModel | { error: string } {
  const kinds = cols.map((c, i) => colKind(c, rows, i))
  const dims = kinds.map((k, i) => (k !== 'number' ? i : -1)).filter((i) => i >= 0)
  const mi = kinds.findIndex((k) => k === 'number')
  if (dims.length < 2 || mi < 0) return { error: 'A pivot needs two grouping columns and one number column.' }
  const [ri, ci] = dims
  const label = (v: Cell, i: number) => (v == null ? '(empty)' : kinds[i] === 'time' ? formatTime(wallTime(v) ?? 0, cols[i].unit) : String(v))
  const rowKeys: string[] = []
  const colKeys: string[] = []
  const cell = new Map<string, number>()
  for (const r of rows) {
    const rk = label(r[ri], ri)
    const ck = label(r[ci], ci)
    if (!rowKeys.includes(rk)) rowKeys.push(rk)
    if (!colKeys.includes(ck)) colKeys.push(ck)
    const n = toNumber(r[mi])
    if (n != null) cell.set(`${rk}\u0000${ck}`, (cell.get(`${rk}\u0000${ck}`) ?? 0) + n)
  }
  const cells = rowKeys.map((rk) => colKeys.map((ck) => cell.get(`${rk}\u0000${ck}`) ?? null))
  const rowTotals = cells.map((r) => r.reduce<number>((a, v) => a + (v ?? 0), 0))
  const colTotals = colKeys.map((_, j) => cells.reduce<number>((a, r) => a + (r[j] ?? 0), 0))
  return {
    rowHeader: cols[ri].display_name ?? cols[ri].name,
    colHeader: cols[ci].display_name ?? cols[ci].name,
    rowKeys,
    colKeys,
    cells,
    rowTotals,
    colTotals,
    grand: rowTotals.reduce((a, v) => a + v, 0),
  }
}

/* ─────────── column stats ─────────── */

export interface ColumnStats {
  name: string
  kind: ColKind
  nulls: number
  distinct: number
  min?: number | string
  max?: number | string
  sum?: number
  avg?: number
}

/** Per-column summary of the rows we actually have (not the whole table). */
export function columnStats(cols: Col[], rows: Cell[][]): ColumnStats[] {
  return cols.map((c, i) => {
    const kind = colKind(c, rows, i)
    const vals = rows.map((r) => r[i])
    const present = vals.filter((v) => v != null)
    const s: ColumnStats = {
      name: c.display_name ?? c.name,
      kind,
      nulls: vals.length - present.length,
      distinct: new Set(present.map(String)).size,
    }
    if (kind === 'number') {
      const nums = present.map(toNumber).filter((n): n is number => n != null)
      if (nums.length) {
        s.min = Math.min(...nums)
        s.max = Math.max(...nums)
        s.sum = nums.reduce((a, n) => a + n, 0)
        s.avg = s.sum / nums.length
      }
    } else if (kind === 'time') {
      const ts = present.map(wallTime).filter((n): n is number => n != null)
      if (ts.length) {
        s.min = formatTime(Math.min(...ts), c.unit ?? 'day')
        s.max = formatTime(Math.max(...ts), c.unit ?? 'day')
      }
    }
    return s
  })
}

/* ─────────── sorting ─────────── */

export function compareCells(a: Cell, b: Cell): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const na = toNumber(a)
  const nb = toNumber(b)
  if (na != null && nb != null) return na - nb
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Row indexes sorted by one column; nulls last in both directions. */
export function sortRowIndexes(rows: Cell[][], col: number, dir: 'asc' | 'desc'): number[] {
  const idx = rows.map((_, i) => i)
  idx.sort((i, j) => {
    const a = rows[i][col]
    const b = rows[j][col]
    if (a == null || b == null) return compareCells(a, b)
    const c = compareCells(a, b)
    return dir === 'asc' ? c : -c
  })
  return idx
}

/* ─────────── formatting ─────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A wall-clock epoch (see `wallTime`) as a label for its bucket. */
export function formatTime(ms: number, unit?: string): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const mo = MONTHS[d.getUTCMonth()]
  const day = d.getUTCDate()
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  switch (unit) {
    case 'year':
      return String(y)
    case 'quarter':
      return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}`
    case 'month':
      return `${mo} ${y}`
    case 'week':
      return `Week of ${mo} ${day}, ${y}`
    case 'hour':
    case 'minute':
      return `${mo} ${day}, ${hh}:${mm}`
    case 'day':
    case undefined:
    default:
      return hh === '00' && mm === '00' ? `${mo} ${day}, ${y}` : `${mo} ${day}, ${y} ${hh}:${mm}`
  }
}

/** A short axis tick for a wall-clock epoch, picked from the axis span. */
export function formatTimeTick(ms: number, spanMs: number, unit?: string): string {
  const d = new Date(ms)
  const mo = MONTHS[d.getUTCMonth()]
  if (unit === 'year' || spanMs > 3 * 365 * 86_400_000) return String(d.getUTCFullYear())
  if (unit === 'quarter') return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ’${String(d.getUTCFullYear()).slice(2)}`
  if (unit === 'month' || spanMs > 120 * 86_400_000) return `${mo} ’${String(d.getUTCFullYear()).slice(2)}`
  if (spanMs > 2 * 86_400_000) return `${mo} ${d.getUTCDate()}`
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** Compact number for axes and tiles: 1.2K, 3.4M, 0.42. */
export function formatCompact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e12) return `${trim(n / 1e12)}T`
  if (a >= 1e9) return `${trim(n / 1e9)}B`
  if (a >= 1e6) return `${trim(n / 1e6)}M`
  if (a >= 1e4) return `${trim(n / 1e3)}K`
  if (a >= 100) return String(Math.round(n))
  if (a >= 1 || a === 0) return trim(n)
  return n.toPrecision(2).replace(/\.?0+$/, '')
}
function trim(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '')
}

/** Is this column a percentage / ratio (Metabase semantic types)? */
export function isPercent(col?: Col): boolean {
  return !!col && /type\/(Percentage|Share)/.test(`${col.semantic_type ?? ''} ${col.effective_type ?? ''}`)
}

/** Full value for tables, tooltips and scalars. */
export function formatValue(v: Cell, col?: Col, opts: { compact?: boolean } = {}): string {
  if (v == null) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (col) {
    const kind = colKind(col)
    if (kind === 'time') {
      const t = wallTime(v)
      return t == null ? String(v) : formatTime(t, col.unit)
    }
    if (kind === 'category' && typeof v === 'number') return String(v)
  }
  if (typeof v === 'number') {
    if (isPercent(col)) return `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    if (opts.compact) return formatCompact(v)
    return v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2 })
  }
  return v
}

/** Nice round axis maximum ≥ v, and its tick step. */
export function niceScale(min: number, max: number, ticks = 4): { lo: number; hi: number; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, step: 0.25 }
  const lo0 = Math.min(0, min)
  const hi0 = Math.max(0, max)
  const span = hi0 - lo0 || Math.abs(hi0) || 1
  const raw = span / ticks
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  return { lo: Math.floor(lo0 / step) * step, hi: Math.ceil(hi0 / step) * step || step, step }
}
