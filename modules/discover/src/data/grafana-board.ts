/**
 * Pure helpers for rendering a Grafana dashboard natively in the console.
 *
 * The platform's Grafana answers `X-Frame-Options: deny` (no
 * `security.allow_embedding`), so a kiosk iframe can never show a board. The
 * console instead fetches the dashboard JSON through the BFF (`/api/svc/grafana
 * /api/dashboards/uid/<uid>`), lays its panels out on Grafana's 24-column grid,
 * resolves template variables and runs each panel's PromQL / LogQL through the
 * panel's own datasource (Grafana datasource proxy).
 *
 * Everything in here is side-effect free so it can be unit tested: time-range
 * parsing, variable interpolation, `label_values()` parsing, layout, legend
 * formatting, reducers, units and threshold colours.
 */

/* ─────────── dashboard JSON (the subset we read) ─────────── */

export interface DsRef {
  uid?: string
  type?: string
}

export interface GrafanaTarget {
  refId?: string
  expr?: string
  /** Loki/Tempo variants carry the query here on some versions. */
  query?: string
  legendFormat?: string
  instant?: boolean
  range?: boolean
  format?: string
  hide?: boolean
  interval?: string
  datasource?: DsRef | string | null
}

export interface ThresholdStep {
  color: string
  value: number | null
}

export interface MappingResult {
  text?: string
  color?: string
  index?: number
}

/**
 * A Grafana value mapping. Modern boards use `{type, options}` with
 * `value` / `range` / `regex` / `special` kinds; pre-v8 boards carry legacy
 * `{type: 1|2, value|from|to, text}` objects.
 */
export interface ValueMapping {
  type?: string | number
  options?:
    | Record<string, MappingResult>
    | { from?: number | null; to?: number | null; result?: MappingResult }
    | { pattern?: string; result?: MappingResult }
    | { match?: string; result?: MappingResult }
  /** Legacy (type 1 = value, type 2 = range). */
  value?: string
  from?: string | number
  to?: string | number
  text?: string
}

export interface DataLink {
  title?: string
  url?: string
  targetBlank?: boolean
}

export interface FieldDefaults {
  unit?: string
  decimals?: number
  min?: number
  max?: number
  thresholds?: { mode?: 'absolute' | 'percentage'; steps?: ThresholdStep[] }
  mappings?: ValueMapping[]
  displayName?: string
  /** Legend name the datasource gave the series (Prometheus `legendFormat`). */
  displayNameFromDS?: string
  color?: { mode?: string; fixedColor?: string; seriesBy?: string }
  noValue?: string
  links?: DataLink[]
  /** Datasource-reported sample spacing (the query step) in ms. */
  interval?: number
  custom?: Record<string, unknown>
}

export interface FieldOverride {
  matcher?: { id?: string; options?: unknown }
  properties?: Array<{ id: string; value?: unknown }>
}

export interface GridPos {
  x: number
  y: number
  w: number
  h: number
}

export interface GrafanaPanel {
  id: number
  type: string
  title?: string
  description?: string
  gridPos?: GridPos
  datasource?: DsRef | string | null
  targets?: GrafanaTarget[]
  fieldConfig?: { defaults?: FieldDefaults; overrides?: FieldOverride[] }
  transformations?: Array<{ id: string; options?: Record<string, unknown>; disabled?: boolean }>
  links?: DataLink[]
  timeFrom?: string
  timeShift?: string
  hideTimeOverride?: boolean
  options?: Record<string, unknown> & {
    reduceOptions?: { calcs?: string[]; values?: boolean; fields?: string; limit?: number }
    content?: string
    mode?: string
    legend?: {
      showLegend?: boolean
      displayMode?: string
      placement?: string
      calcs?: string[]
      sortBy?: string
      sortDesc?: boolean
      width?: number
    }
    tooltip?: { mode?: string; sort?: string }
  }
  /** Legacy (Grafana 6/7) graph & singlestat fields. */
  yaxes?: Array<{ format?: string; min?: number | string | null; max?: number | string | null }>
  format?: string
  valueName?: string
  content?: string
  mode?: string
  interval?: string
  maxDataPoints?: number
  repeat?: string
  repeatDirection?: 'h' | 'v'
  maxPerRow?: number
  collapsed?: boolean
  /** Nested panels of a collapsed row. */
  panels?: GrafanaPanel[]
  /** Set on repeat clones so the renderer can scope variables. */
  scopedVars?: Record<string, string>
  /** Id of the panel a repeat clone was made from (for Grafana deep links). */
  sourceId?: number
}

export interface GrafanaVariable {
  name: string
  type: 'query' | 'custom' | 'constant' | 'interval' | 'datasource' | 'textbox' | 'adhoc' | string
  label?: string
  hide?: number
  query?: string | { query?: string; qryType?: number; refId?: string }
  definition?: string
  regex?: string
  sort?: number
  multi?: boolean
  includeAll?: boolean
  allValue?: string | null
  datasource?: DsRef | string | null
  current?: { text?: string | string[]; value?: string | string[] }
  options?: Array<{ text: string; value: string; selected?: boolean }>
  auto?: boolean
  auto_count?: number
  auto_min?: string
}

export interface GrafanaDashboard {
  uid: string
  title: string
  tags?: string[]
  panels?: GrafanaPanel[]
  /** Pre-schema-16 dashboards nest panels under rows. */
  rows?: Array<{ title?: string; collapse?: boolean; panels?: GrafanaPanel[]; height?: string | number }>
  templating?: { list?: GrafanaVariable[] }
  time?: { from: string; to: string }
  refresh?: string | false
  timezone?: string
  description?: string
}

export interface GrafanaDatasource {
  id?: number
  uid: string
  name: string
  type: string
  isDefault?: boolean
  url?: string
}

/* ─────────── time ranges ─────────── */

export const QUICK_RANGES: Array<{ from: string; label: string }> = [
  { from: 'now-5m', label: 'Last 5 minutes' },
  { from: 'now-15m', label: 'Last 15 minutes' },
  { from: 'now-30m', label: 'Last 30 minutes' },
  { from: 'now-1h', label: 'Last 1 hour' },
  { from: 'now-3h', label: 'Last 3 hours' },
  { from: 'now-6h', label: 'Last 6 hours' },
  { from: 'now-12h', label: 'Last 12 hours' },
  { from: 'now-24h', label: 'Last 24 hours' },
  { from: 'now-2d', label: 'Last 2 days' },
  { from: 'now-7d', label: 'Last 7 days' },
  { from: 'now-30d', label: 'Last 30 days' },
]

export const REFRESH_INTERVALS = ['', '1m', '5m', '15m', '1h'] as const

/** The fastest a board may auto-refresh — the console-wide poll floor (`POLL_FLOOR_MS`). */
export const MIN_BOARD_REFRESH_MS = 60_000

/**
 * A board's refresh setting raised to the poll floor: a board saved with
 * `5s`/`10s`/`30s` refreshes every minute here; unparseable means off.
 * Every tick re-queries every panel, so a sub-minute refresh on a twenty-panel
 * board was twenty-plus datasource queries every few seconds per open tab.
 */
export function clampRefresh(s: string | undefined | null): string {
  const ms = parseDuration(s)
  if (!ms) return ''
  return ms < MIN_BOARD_REFRESH_MS ? '1m' : s!.trim()
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  M: 30 * 86_400_000,
  y: 365 * 86_400_000,
}

/** `30s` / `5m` / `1h` / `2d` → milliseconds; null when unparseable. */
export function parseDuration(s: string | undefined | null): number | null {
  if (!s) return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|M|y)\s*$/.exec(s)
  if (!m) return null
  return Number(m[1]) * UNIT_MS[m[2]]
}

/** Milliseconds → Prometheus duration (`15s`, `5m`, `1h`). */
export function formatPromDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s % 86400 === 0) return `${s / 86400}d`
  if (s % 3600 === 0) return `${s / 3600}h`
  if (s % 60 === 0) return `${s / 60}m`
  return `${s}s`
}

function startOf(d: Date, unit: string): Date {
  const out = new Date(d)
  switch (unit) {
    case 'y':
      out.setMonth(0, 1)
      out.setHours(0, 0, 0, 0)
      break
    case 'M':
      out.setDate(1)
      out.setHours(0, 0, 0, 0)
      break
    case 'w':
      out.setDate(out.getDate() - out.getDay())
      out.setHours(0, 0, 0, 0)
      break
    case 'd':
      out.setHours(0, 0, 0, 0)
      break
    case 'h':
      out.setMinutes(0, 0, 0)
      break
    case 'm':
      out.setSeconds(0, 0)
      break
  }
  return out
}

/**
 * Grafana time expression → epoch ms. Supports `now`, `now-6h`, `now-1d/d`,
 * `now/d`, epoch milliseconds and ISO strings. `roundUp` makes `now/d` mean
 * the END of the day (Grafana's semantics for the `to` side).
 */
export function parseGrafanaTime(expr: string, now = Date.now(), roundUp = false): number {
  const s = String(expr ?? '').trim()
  if (/^\d{10,}$/.test(s)) return Number(s)
  if (!s.startsWith('now')) {
    const t = Date.parse(s)
    return Number.isNaN(t) ? now : t
  }
  let d = new Date(now)
  let rest = s.slice(3)
  const re = /^([+-])(\d+)(ms|s|m|h|d|w|M|y)|^\/(s|m|h|d|w|M|y)/
  while (rest.length) {
    const m = re.exec(rest)
    if (!m) break
    if (m[1]) {
      const sign = m[1] === '-' ? -1 : 1
      d = new Date(d.getTime() + sign * Number(m[2]) * UNIT_MS[m[3]])
    } else if (m[4]) {
      const start = startOf(d, m[4])
      if (roundUp) {
        const next = new Date(start)
        if (m[4] === 'y') next.setFullYear(next.getFullYear() + 1)
        else if (m[4] === 'M') next.setMonth(next.getMonth() + 1)
        else next.setTime(next.getTime() + UNIT_MS[m[4]])
        d = new Date(next.getTime() - 1)
      } else d = start
    }
    rest = rest.slice(m[0].length)
  }
  return d.getTime()
}

export function resolveRange(from: string, to: string, now = Date.now()): { start: number; end: number } {
  const start = parseGrafanaTime(from, now, false)
  const end = parseGrafanaTime(to, now, true)
  return start < end ? { start, end } : { start: end - 3_600_000, end }
}

export function rangeLabel(from: string, to: string): string {
  if (to === 'now') {
    const q = QUICK_RANGES.find((r) => r.from === from)
    if (q) return q.label
    if (from.startsWith('now-')) return `Last ${from.slice(4)}`
  }
  const fmt = (v: string) => {
    if (v.startsWith('now')) return v
    const d = new Date(parseGrafanaTime(v))
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  return `${fmt(from)} → ${fmt(to)}`
}

/** Grafana's `rangeutil.roundInterval` table: [upper bound, rounded] in ms. */
const ROUND_INTERVALS: Array<[number, number]> = [
  [15, 10], [35, 20], [75, 50], [150, 100], [350, 200], [750, 500], [1_500, 1_000], [3_500, 2_000],
  [7_500, 5_000], [12_500, 10_000], [17_500, 15_000], [25_000, 20_000], [45_000, 30_000], [90_000, 60_000],
  [210_000, 120_000], [450_000, 300_000], [750_000, 600_000], [1_050_000, 900_000], [1_500_000, 1_200_000],
  [2_700_000, 1_800_000], [5_400_000, 3_600_000], [9_000_000, 7_200_000], [16_200_000, 10_800_000],
  [32_400_000, 21_600_000], [86_400_000, 43_200_000], [604_800_000, 86_400_000], [1_814_400_000, 604_800_000],
  [3_628_800_000, 2_592_000_000],
]

/** Round a raw interval to the nearest tidy value, exactly like Grafana. */
export function roundInterval(ms: number): number {
  for (const [bound, v] of ROUND_INTERVALS) if (ms < bound) return v
  return 31_536_000_000
}

/**
 * Query step like Grafana's `$__interval`: range / maxDataPoints rounded with
 * Grafana's table, never below `minMs` (the panel's min interval, else 15s —
 * the kube-prometheus scrape interval). Grafana's default `maxDataPoints` is
 * the panel's pixel width.
 */
export function computeStepMs(rangeMs: number, maxDataPoints = 300, minMs = 15_000): number {
  return Math.max(minMs, roundInterval(rangeMs / Math.max(1, maxDataPoints)))
}

/**
 * Grafana panel time overrides: `timeFrom` (`2h` → last 2h ending at the
 * board's `to`) and `timeShift` (`1d` → whole window moved back a day).
 * Returns the effective window and the info text Grafana shows in the header.
 */
export function applyPanelTime(
  time: { start: number; end: number },
  timeFrom?: string,
  timeShift?: string,
  vars: VarMap = {},
): { start: number; end: number; info?: string } {
  let { start, end } = time
  const info: string[] = []
  const from = parseDuration(interpolate(timeFrom ?? '', vars, {}, {}, 'raw').replace(/^now-/, ''))
  if (from) {
    start = end - from
    info.push(`Last ${interpolate(timeFrom ?? '', vars, {}, {}, 'raw').replace(/^now-/, '')}`)
  }
  const shift = parseDuration(interpolate(timeShift ?? '', vars, {}, {}, 'raw').replace(/^-/, ''))
  if (shift) {
    start -= shift
    end -= shift
    info.push(`timeshift -${interpolate(timeShift ?? '', vars, {}, {}, 'raw').replace(/^-/, '')}`)
  }
  return info.length ? { start, end, info: info.join(' ') } : { start, end }
}

/* ─────────── variables ─────────── */

export const ALL_VALUE = '$__all'

/** What one variable currently resolves to. */
export interface VarState {
  /** Selected values (`$__all` when "All" is selected). */
  values: string[]
  /** Every option the variable offers (needed to expand "All"). */
  options: string[]
  /** Display text per value (datasource vars show names). */
  includeAll?: boolean
  allValue?: string | null
  multi?: boolean
}

export type VarMap = Record<string, VarState>

/** Escape a literal for a PromQL/LogQL regex matcher (Grafana's default). */
export function escapeRegex(v: string): string {
  return v.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')
}

/** The concrete values a variable stands for (expands "All"). */
export function expandValues(v: VarState): string[] {
  if (v.values.includes(ALL_VALUE)) return v.options
  return v.values
}

/**
 * Format a variable for substitution. `regex` (Grafana's PromQL default)
 * escapes each value and joins multi-values as `(a|b)`; "All" with a custom
 * `allValue` (often `.*` or `.+`) passes it through unescaped.
 */
export function formatVariable(v: VarState, format?: string): string {
  const all = v.values.includes(ALL_VALUE)
  if (all && v.allValue != null && v.allValue !== '' && (!format || format === 'regex')) return v.allValue
  const vals = expandValues(v)
  switch (format) {
    case 'raw':
      return vals.join(',')
    case 'csv':
      return vals.join(',')
    case 'pipe':
      return vals.join('|')
    case 'json':
      return JSON.stringify(vals)
    case 'text':
      return vals.join(' + ')
    case 'singlequote':
      return vals.map((x) => `'${x}'`).join(',')
    case 'doublequote':
      return vals.map((x) => `"${x}"`).join(',')
    case 'queryparam':
      return vals.map((x) => `var-${encodeURIComponent(x)}`).join('&')
    case 'glob':
      return vals.length > 1 ? `{${vals.join(',')}}` : (vals[0] ?? '')
    default: {
      // regex (default)
      if (vals.length === 0) return ''
      if (vals.length === 1 && !all && !v.multi) return escapeRegex(vals[0])
      if (vals.length === 1) return escapeRegex(vals[0])
      return `(${vals.map(escapeRegex).join('|')})`
    }
  }
}

/** Built-in interval variables for a given range + step. */
export function builtinVars(rangeMs: number, stepMs: number, scrapeMs = 15_000): Record<string, string> {
  const rate = Math.max(stepMs + scrapeMs, 4 * scrapeMs)
  const rangeS = Math.max(1, Math.round(rangeMs / 1000))
  return {
    __interval: formatPromDuration(stepMs),
    __interval_ms: String(stepMs),
    __rate_interval: formatPromDuration(rate),
    __rate_interval_ms: String(rate),
    __range: `${rangeS}s`,
    __range_s: String(rangeS),
    __range_ms: String(rangeMs),
    interval: formatPromDuration(stepMs),
    __auto_interval: formatPromDuration(stepMs),
  }
}

const VAR_RE = /\$(\w+)|\[\[(\w+)(?::(\w+))?\]\]|\$\{(\w+)(?:\.([\w.]+))?(?::(\w+))?\}/g

/**
 * Substitute `$var`, `${var}`, `${var:format}` and `[[var]]` in a query.
 * Built-ins (strings) are substituted verbatim; unknown names are left as-is
 * so a mistake stays visible in the query rather than silently vanishing.
 */
export function interpolate(
  text: string,
  vars: VarMap,
  builtins: Record<string, string> = {},
  scoped: Record<string, string> = {},
  defaultFormat?: string,
): string {
  if (!text) return text
  return text.replace(VAR_RE, (whole, a, b, bFmt, c, _field, cFmt) => {
    const name: string = a ?? b ?? c
    const fmt: string | undefined = bFmt ?? cFmt ?? defaultFormat
    if (name in scoped) return fmt === 'raw' || !fmt ? escapeRegexIf(scoped[name], fmt) : scoped[name]
    // A dashboard variable named like a legacy built-in (`$interval`) wins,
    // as in Grafana; the `__` built-ins can never be shadowed.
    const v = name.startsWith('__') ? undefined : vars[name]
    if (v) return formatVariable(v, fmt)
    if (name in builtins) return builtins[name]
    return whole
  })
}

function escapeRegexIf(v: string, fmt?: string): string {
  return fmt === 'raw' ? v : escapeRegex(v)
}

/** Which variables a string references (for dependency ordering). */
export function referencedVars(text: string): string[] {
  const out = new Set<string>()
  for (const m of (text ?? '').matchAll(VAR_RE)) out.add(m[1] ?? m[2] ?? m[4])
  return [...out]
}

/** The query string of a query variable, whichever schema version wrote it. */
export function variableQuery(v: GrafanaVariable): string {
  if (typeof v.query === 'string') return v.query
  if (v.query && typeof v.query === 'object' && typeof v.query.query === 'string') return v.query.query
  return v.definition ?? ''
}

export type PromVarQuery =
  | { kind: 'label_values'; label: string; match?: string }
  | { kind: 'label_names'; match?: string }
  | { kind: 'metrics'; regex: string }
  | { kind: 'query_result'; expr: string }
  | { kind: 'unknown'; raw: string }

/** Parse a Prometheus template-variable query (`label_values(...)` etc.). */
export function parsePromVarQuery(q: string): PromVarQuery {
  const s = (q ?? '').trim()
  let m = /^label_values\(\s*([a-zA-Z_][\w]*)\s*\)$/.exec(s)
  if (m) return { kind: 'label_values', label: m[1] }
  m = /^label_values\(\s*([\s\S]+?)\s*,\s*([a-zA-Z_][\w]*)\s*\)$/.exec(s)
  if (m) return { kind: 'label_values', label: m[2], match: m[1] }
  m = /^label_names\(\s*([\s\S]*?)\s*\)$/.exec(s)
  if (m) return { kind: 'label_names', match: m[1] || undefined }
  m = /^metrics\(\s*([\s\S]*?)\s*\)$/.exec(s)
  if (m) return { kind: 'metrics', regex: m[1] }
  m = /^query_result\(\s*([\s\S]+)\s*\)$/.exec(s)
  if (m) return { kind: 'query_result', expr: m[1] }
  return { kind: 'unknown', raw: s }
}

/**
 * Apply a variable's `regex` (`/pattern/flags`) to raw option strings. A
 * capture group (or `(?<value>…)`) narrows the value; non-matches drop out.
 */
export function applyVarRegex(values: string[], regex?: string): string[] {
  if (!regex) return values
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(regex.trim())
  let re: RegExp
  try {
    re = m ? new RegExp(m[1], m[2].replace('g', '')) : new RegExp(regex)
  } catch {
    return values
  }
  const out: string[] = []
  for (const v of values) {
    const hit = re.exec(v)
    if (!hit) continue
    const val = hit.groups?.value ?? hit.groups?.text ?? hit[1] ?? hit[0]
    if (val != null && !out.includes(val)) out.push(val)
  }
  return out
}

/** Grafana variable `sort` codes → sorted copy. */
export function sortOptions(values: string[], sort = 0): string[] {
  const out = [...new Set(values)]
  const num = (s: string) => {
    const n = Number(/-?\d+(\.\d+)?/.exec(s)?.[0])
    return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n
  }
  switch (sort) {
    case 1:
      return out.sort((a, b) => a.localeCompare(b))
    case 2:
      return out.sort((a, b) => b.localeCompare(a))
    case 3:
      return out.sort((a, b) => num(a) - num(b))
    case 4:
      return out.sort((a, b) => num(b) - num(a))
    case 5:
      return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    case 6:
      return out.sort((a, b) => b.toLowerCase().localeCompare(a.toLowerCase()))
    default:
      return out
  }
}

/** Options of a `custom` variable: `a,b,c` or `label : value` pairs. */
export function parseCustomOptions(q: string): Array<{ text: string; value: string }> {
  const parts = (q ?? '').match(/(?:\\,|[^,])+/g) ?? []
  return parts
    .map((p) => p.replace(/\\,/g, ',').trim())
    .filter(Boolean)
    .map((p) => {
      const kv = /^(.+?)\s:\s(.+)$/.exec(p)
      return kv ? { text: kv[1].trim(), value: kv[2].trim() } : { text: p, value: p }
    })
}

/** The variable's saved selection (`current.value`) as a list. */
export function currentValues(v: GrafanaVariable): string[] {
  const c = v.current?.value
  if (c == null) return []
  const list = Array.isArray(c) ? c : [c]
  return list.map((x) => (x === '$__all' || x === 'All' ? ALL_VALUE : String(x)))
}

/** Reconcile a selection with newly loaded options (Grafana picks the first). */
export function reconcileSelection(selected: string[], options: string[], includeAll = false): string[] {
  if (selected.includes(ALL_VALUE)) return includeAll ? [ALL_VALUE] : options.slice(0, 1)
  const kept = selected.filter((s) => options.includes(s))
  if (kept.length) return kept
  if (options.length === 0) return selected.length ? selected : []
  return includeAll && selected.length === 0 ? [ALL_VALUE] : [options[0]]
}

/** Variables in dependency order (a variable after every var it references). */
export function orderVariables(list: GrafanaVariable[]): GrafanaVariable[] {
  const byName = new Map(list.map((v) => [v.name, v]))
  const out: GrafanaVariable[] = []
  const seen = new Set<string>()
  const visit = (v: GrafanaVariable, stack: Set<string>) => {
    if (seen.has(v.name) || stack.has(v.name)) return
    stack.add(v.name)
    const ds = typeof v.datasource === 'string' ? v.datasource : (v.datasource?.uid ?? '')
    for (const dep of [...referencedVars(variableQuery(v)), ...referencedVars(ds)]) {
      const d = byName.get(dep)
      if (d && d !== v) visit(d, stack)
    }
    stack.delete(v.name)
    seen.add(v.name)
    out.push(v)
  }
  for (const v of list) visit(v, new Set())
  return out
}

/* ─────────── datasources ─────────── */

const MIXED = '-- Mixed --'

/**
 * Resolve a panel/target datasource reference to a concrete datasource.
 * References are `{uid,type}` objects, legacy name strings, `${var}` /
 * `$var` datasource variables, `null` (the default) or `-- Mixed --`.
 */
export function resolveDatasource(
  ref: DsRef | string | null | undefined,
  datasources: GrafanaDatasource[],
  vars: VarMap,
): GrafanaDatasource | null {
  const def = datasources.find((d) => d.isDefault) ?? null
  if (ref == null || ref === '' || ref === 'default') return def
  let key = typeof ref === 'string' ? ref : (ref.uid ?? '')
  const type = typeof ref === 'string' ? undefined : ref.type
  if (!key) {
    if (type) return datasources.find((d) => d.type === type && d.isDefault) ?? datasources.find((d) => d.type === type) ?? def
    return def
  }
  if (key === MIXED || key === '-- Grafana --' || key === 'grafana') return null
  if (key.includes('$')) {
    key = interpolate(key, vars, {}, {}, 'raw')
    if (key === ALL_VALUE || key.includes('$')) {
      return (type && datasources.find((d) => d.type === type && d.isDefault)) || (type && datasources.find((d) => d.type === type)) || def
    }
  }
  if (key === 'default') return def
  return datasources.find((d) => d.uid === key) ?? datasources.find((d) => d.name === key) ?? null
}

export type DsKind = 'prometheus' | 'loki' | 'other'

export function dsKind(ds: GrafanaDatasource | null | undefined): DsKind {
  const t = ds?.type ?? ''
  if (t === 'prometheus' || t.includes('prometheus') || t === 'mimir') return 'prometheus'
  if (t === 'loki') return 'loki'
  return 'other'
}

/* ─────────── layout ─────────── */

export const GRID_COLUMNS = 24
export const GRID_CELL_HEIGHT = 30
export const GRID_CELL_MARGIN = 8

export interface BoardSection {
  /** Row panel heading the section; null for panels above the first row. */
  row: GrafanaPanel | null
  /** Panels with their gridPos made relative to the section top. */
  panels: Array<GrafanaPanel & { gridPos: GridPos }>
  /** Height of the section in grid units. */
  height: number
}

function gp(p: GrafanaPanel): GridPos {
  const g = p.gridPos ?? { x: 0, y: 0, w: 12, h: 8 }
  const w = Math.max(1, Math.min(GRID_COLUMNS, g.w || 12))
  return { x: Math.max(0, Math.min(GRID_COLUMNS - w, g.x || 0)), y: Math.max(0, g.y || 0), w, h: Math.max(1, g.h || 8) }
}

/**
 * Convert schema-<16 `rows: [{panels}]` dashboards to the flat `panels` +
 * row-panel form, assigning gridPos with spans (legacy `span` is out of 12).
 */
export function normalizePanels(d: GrafanaDashboard): GrafanaPanel[] {
  if (d.panels?.length) return d.panels
  if (!d.rows?.length) return []
  const out: GrafanaPanel[] = []
  let y = 0
  let id = 10_000
  for (const r of d.rows) {
    const h = Math.max(4, Math.round((Number(String(r.height ?? '250').replace('px', '')) || 250) / 38))
    if (r.title) out.push({ id: id++, type: 'row', title: r.title, gridPos: { x: 0, y, w: 24, h: 1 }, collapsed: false })
    y += r.title ? 1 : 0
    let x = 0
    for (const p of r.panels ?? []) {
      const w = Math.round(((p as { span?: number }).span ?? 12) * 2)
      if (x + w > GRID_COLUMNS) {
        x = 0
        y += h
      }
      out.push({ ...p, gridPos: { x, y, w, h } })
      x += w
    }
    y += h
  }
  return out
}

/**
 * Expand `repeat` panels: one clone per selected value of the repeat variable,
 * laid out horizontally (wrapping at 24 columns / `maxPerRow`) or vertically.
 * Panels below the repeat are pushed down by the extra height.
 */
export function expandRepeats(panels: GrafanaPanel[], vars: VarMap): GrafanaPanel[] {
  const sorted = [...panels].sort((a, b) => gp(a).y - gp(b).y || gp(a).x - gp(b).x)
  const out: GrafanaPanel[] = []
  let shift = 0
  for (const p of sorted) {
    const g = gp(p)
    const base = { ...g, y: g.y + shift }
    const v = p.repeat ? vars[p.repeat] : undefined
    const values = v ? expandValues(v) : []
    if (!p.repeat || values.length <= 1 || p.type === 'row') {
      out.push({ ...p, gridPos: base, ...(p.repeat && values.length === 1 ? { scopedVars: { [p.repeat]: values[0] } } : {}) })
      continue
    }
    if (p.repeatDirection === 'v') {
      values.forEach((val, i) => {
        out.push({ ...p, id: p.id * 1000 + i, sourceId: p.id, gridPos: { ...base, y: base.y + i * g.h }, scopedVars: { [p.repeat!]: val } })
      })
      shift += (values.length - 1) * g.h
      continue
    }
    // Grafana: w = max(24 / n, 24 / maxPerRow), maxPerRow defaulting to 4.
    const perRow = Math.max(1, Math.min(p.maxPerRow || 4, 24))
    const width = Math.max(1, Math.floor(Math.max(GRID_COLUMNS / values.length, GRID_COLUMNS / perRow)))
    const cols = Math.max(1, Math.floor(GRID_COLUMNS / width))
    values.forEach((val, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      out.push({
        ...p,
        id: p.id * 1000 + i,
        sourceId: p.id,
        gridPos: { x: col * width, y: base.y + row * g.h, w: width, h: g.h },
        scopedVars: { [p.repeat!]: val },
      })
    })
    shift += (Math.ceil(values.length / cols) - 1) * g.h
  }
  return out
}

/**
 * Split a flat panel list into row sections. A collapsed row carries its
 * panels in `row.panels`; an expanded row owns every panel below it until the
 * next row. Each section's gridPos is rebased so it starts at y = 0.
 */
export function layoutSections(panels: GrafanaPanel[]): BoardSection[] {
  const sorted = [...panels].sort((a, b) => gp(a).y - gp(b).y || gp(a).x - gp(b).x)
  const sections: Array<{ row: GrafanaPanel | null; panels: GrafanaPanel[] }> = [{ row: null, panels: [] }]
  for (const p of sorted) {
    if (p.type === 'row') {
      sections.push({ row: p, panels: p.collapsed ? [...(p.panels ?? [])] : [] })
    } else {
      sections[sections.length - 1].panels.push(p)
    }
  }
  return sections
    .filter((s) => s.row || s.panels.length)
    .map((s) => {
      const withPos = s.panels.map((p) => ({ ...p, gridPos: gp(p) }))
      const y0 = withPos.length ? Math.min(...withPos.map((p) => p.gridPos.y)) : 0
      const rebased = withPos
        .map((p) => ({ ...p, gridPos: { ...p.gridPos, y: p.gridPos.y - y0 } }))
        .sort((a, b) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x)
      const height = rebased.reduce((m, p) => Math.max(m, p.gridPos.y + p.gridPos.h), 0)
      return { row: s.row, panels: rebased, height }
    })
}

/** Pixel height of a panel spanning `h` grid units (Grafana's formula). */
export function panelPixelHeight(h: number): number {
  return h * GRID_CELL_HEIGHT + (h - 1) * GRID_CELL_MARGIN
}

/* ─────────── series ─────────── */

export interface PromSeries {
  metric: Record<string, string>
  values?: Array<[number, string]>
  value?: [number, string]
}

/** Prometheus-style `name{a="b"}` string for a label set. */
export function seriesString(metric: Record<string, string>): string {
  const { __name__, ...rest } = metric
  const labels = Object.entries(rest)
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ')
  return `${__name__ ?? ''}${labels ? `{${labels}}` : __name__ ? '' : '{}'}`
}

/** Apply a Grafana `legendFormat` (`{{pod}} – {{container}}`). */
export function formatLegend(fmt: string | undefined, metric: Record<string, string>, fallback?: string): string {
  if (!fmt || fmt === '__auto') {
    const s = seriesString(metric)
    return s === '{}' ? (fallback ?? 'value') : s
  }
  return fmt.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => metric[k] ?? '')
}

export type Calc = 'last' | 'lastNotNull' | 'first' | 'firstNotNull' | 'mean' | 'max' | 'min' | 'sum' | 'count' | 'range' | 'delta' | 'diff'

/** Legend / table header names Grafana gives its reducers. */
export const CALC_LABEL: Record<string, string> = {
  lastNotNull: 'Last *',
  last: 'Last',
  firstNotNull: 'First *',
  first: 'First',
  min: 'Min',
  max: 'Max',
  mean: 'Mean',
  median: 'Median',
  sum: 'Total',
  count: 'Count',
  range: 'Range',
  delta: 'Delta',
  diff: 'Difference',
  diffperc: 'Difference percent',
  stdDev: 'StdDev',
  variance: 'Variance',
  logmin: 'Min (above zero)',
  changeCount: 'Change count',
  distinctCount: 'Distinct count',
  step: 'Step',
  allIsNull: 'All null',
  allIsZero: 'All zero',
}

/**
 * Grafana reducer over a numeric series (`reduceOptions.calcs[0]`, legend
 * calcs). `last`/`first` look at the raw ends (null when that sample is
 * missing); the `*NotNull` variants skip gaps.
 */
export function reduce(values: Array<number | null>, calc: string = 'lastNotNull'): number | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x))
  if (calc === 'last') {
    const x = values[values.length - 1]
    return x != null && Number.isFinite(x) ? x : null
  }
  if (calc === 'first') {
    const x = values[0]
    return x != null && Number.isFinite(x) ? x : null
  }
  if (calc === 'count') return values.length
  if (!v.length) return null
  switch (calc) {
    case 'firstNotNull':
      return v[0]
    case 'mean':
    case 'avg':
      return v.reduce((a, b) => a + b, 0) / v.length
    case 'current':
      return v[v.length - 1]
    case 'median': {
      const s = [...v].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    }
    case 'max':
      return v.reduce((a, b) => (b > a ? b : a), -Infinity)
    case 'min':
      return v.reduce((a, b) => (b < a ? b : a), Infinity)
    case 'logmin': {
      const p = v.filter((x) => x > 0)
      return p.length ? p.reduce((a, b) => (b < a ? b : a), Infinity) : null
    }
    case 'sum':
    case 'total':
      return v.reduce((a, b) => a + b, 0)
    case 'range':
      return v.reduce((a, b) => (b > a ? b : a), -Infinity) - v.reduce((a, b) => (b < a ? b : a), Infinity)
    case 'delta': {
      // Counter-aware: sum of increases, a drop counts as a reset.
      let d = 0
      for (let i = 1; i < v.length; i++) d += v[i] >= v[i - 1] ? v[i] - v[i - 1] : v[i]
      return d
    }
    case 'diff':
      return v[v.length - 1] - v[0]
    case 'diffperc':
      return v[0] === 0 ? null : (v[v.length - 1] - v[0]) / v[0]
    case 'stdDev':
    case 'variance': {
      const mean = v.reduce((a, b) => a + b, 0) / v.length
      const vr = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length
      return calc === 'variance' ? vr : Math.sqrt(vr)
    }
    case 'changeCount': {
      let c = 0
      for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1]) c++
      return c
    }
    case 'distinctCount':
      return new Set(v).size
    case 'step': {
      let m = Infinity
      for (let i = 1; i < v.length; i++) m = Math.min(m, Math.abs(v[i] - v[i - 1]))
      return Number.isFinite(m) ? m : null
    }
    default: {
      const p = /^p(\d{1,2})$/.exec(calc)
      if (p) {
        const s = [...v].sort((a, b) => a - b)
        return s[Math.min(s.length - 1, Math.max(0, Math.ceil((Number(p[1]) / 100) * s.length) - 1))]
      }
      return v[v.length - 1]
    }
  }
}

/** Legacy singlestat `valueName` → modern calc id. */
export function legacyCalc(valueName?: string): string {
  switch (valueName) {
    case 'avg':
      return 'mean'
    case 'current':
      return 'lastNotNull'
    case 'total':
      return 'sum'
    case 'name':
      return 'lastNotNull'
    default:
      return valueName || 'lastNotNull'
  }
}

/* ─────────── units ─────────── */

const SI = ['', 'K', 'M', 'B', 'T']
const BIN = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
const DEC = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']

function fixed(n: number, decimals?: number): string {
  if (decimals != null) return n.toFixed(decimals)
  const a = Math.abs(n)
  if (a === 0) return '0'
  if (a >= 100) return n.toFixed(0)
  if (a >= 10) return n.toFixed(1).replace(/\.0$/, '')
  if (a >= 1) return n.toFixed(2).replace(/\.?0+$/, '')
  if (a >= 0.01) return n.toFixed(3).replace(/\.?0+$/, '')
  return n.toPrecision(2)
}

function scaled(n: number, base: number, units: string[], decimals?: number, sep = ' '): string {
  let i = 0
  let v = n
  while (Math.abs(v) >= base && i < units.length - 1) {
    v /= base
    i++
  }
  return `${fixed(v, decimals)}${sep}${units[i]}`.trim()
}

function duration(ms: number, decimals?: number): string {
  const a = Math.abs(ms)
  if (a < 1) return `${fixed(ms * 1000, decimals)} µs`
  if (a < 1000) return `${fixed(ms, decimals)} ms`
  if (a < 60_000) return `${fixed(ms / 1000, decimals)} s`
  if (a < 3_600_000) return `${fixed(ms / 60_000, decimals)} min`
  if (a < 86_400_000) return `${fixed(ms / 3_600_000, decimals)} hour`
  return `${fixed(ms / 86_400_000, decimals)} day`
}

const CURRENCY: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', CHF: 'CHF ', AUD: 'A$', CAD: 'C$' }

function isoLocal(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fromNow(ms: number, now = Date.now()): string {
  const d = (ms - now) / 1000
  const a = Math.abs(d)
  const [n, u] = a < 60 ? [a, 'second'] : a < 3600 ? [a / 60, 'minute'] : a < 86400 ? [a / 3600, 'hour'] : [a / 86400, 'day']
  const r = Math.round(n)
  const txt = `${r} ${u}${r === 1 ? '' : 's'}`
  return d < 0 ? `${txt} ago` : `in ${txt}`
}

/** Format a value with a Grafana unit id (`bytes`, `percent`, `s`, `reqps` …). */
export function formatUnit(value: number | null | undefined, unit?: string, decimals?: number): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const u = unit ?? 'short'
  switch (u) {
    case 'none':
    case 'string':
      return fixed(value, decimals)
    case 'percent':
      return `${fixed(value, decimals)}%`
    case 'percentunit':
      return `${fixed(value * 100, decimals)}%`
    case 'bytes':
    case 'binbytes':
      return scaled(value, 1024, BIN, decimals)
    case 'decbytes':
      return scaled(value, 1000, DEC, decimals)
    case 'bits':
      return scaled(value, 1024, ['b', 'Kib', 'Mib', 'Gib', 'Tib'], decimals)
    case 'kbytes':
      return scaled(value * 1024, 1024, BIN, decimals)
    case 'mbytes':
      return scaled(value * 1024 * 1024, 1024, BIN, decimals)
    case 'Bps':
    case 'binBps':
      return `${scaled(value, 1024, BIN, decimals)}/s`
    case 'decBps':
      return `${scaled(value, 1000, DEC, decimals)}/s`
    case 'bps':
    case 'binbps':
      return scaled(value, 1000, ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'], decimals)
    case 'pps':
      return `${scaled(value, 1000, SI, decimals, '')} p/s`
    case 's':
      return duration(value * 1000, decimals)
    case 'ms':
      return duration(value, decimals)
    case 'µs':
    case 'us':
      return duration(value / 1000, decimals)
    case 'ns':
      return duration(value / 1e6, decimals)
    case 'm':
      return duration(value * 60_000, decimals)
    case 'h':
      return duration(value * 3_600_000, decimals)
    case 'd':
      return duration(value * 86_400_000, decimals)
    case 'dtdurations':
    case 'dtdurationms':
      return duration(u === 'dtdurations' ? value * 1000 : value, decimals)
    case 'reqps':
      return `${scaled(value, 1000, SI, decimals, '')} req/s`
    case 'rps':
      return `${scaled(value, 1000, SI, decimals, '')} rd/s`
    case 'wps':
      return `${scaled(value, 1000, SI, decimals, '')} wr/s`
    case 'iops':
      return `${scaled(value, 1000, SI, decimals, '')} io/s`
    case 'ops':
    case 'opm':
      return `${scaled(value, 1000, SI, decimals, '')} ${u === 'ops' ? 'ops' : 'op/m'}`
    case 'cps':
      return `${scaled(value, 1000, SI, decimals, '')} c/s`
    case 'hertz':
      return scaled(value, 1000, ['Hz', 'kHz', 'MHz', 'GHz'], decimals)
    case 'celsius':
      return `${fixed(value, decimals)}°C`
    case 'dateTimeAsIso':
      return isoLocal(value)
    case 'dateTimeAsSystem':
      return new Date(value).toLocaleString()
    case 'dateTimeFromNow':
      return fromNow(value)
    case 'decmbytes':
      return scaled(value * 1e6, 1000, DEC, decimals)
    case 'decgbytes':
      return scaled(value * 1e9, 1000, DEC, decimals)
    case 'deckbytes':
      return scaled(value * 1e3, 1000, DEC, decimals)
    case 'gbytes':
      return scaled(value * 1024 ** 3, 1024, BIN, decimals)
    case 'sishort':
    case 'short':
      return scaled(value, 1000, SI, decimals, '')
    case 'locale':
      return value.toLocaleString()
    case 'bool':
      return value ? 'true' : 'false'
    default:
      if (u.startsWith('suffix:')) return `${fixed(value, decimals)}${u.slice(7)}`
      if (u.startsWith('prefix:')) return `${u.slice(7)}${fixed(value, decimals)}`
      if (u.startsWith('currency')) {
        const sym = CURRENCY[u.slice(8)] ?? (u.startsWith('currency:') ? u.slice(9) : '')
        const neg = value < 0 ? '-' : ''
        return `${neg}${sym}${scaled(Math.abs(value), 1000, SI, decimals, '')}`
      }
      if (u.startsWith('si:')) return `${scaled(value, 1000, ['', 'k', 'M', 'G', 'T'], decimals, ' ')}${u.slice(3)}`.replace(/\s+$/, '')
      if (u.startsWith('count:')) return `${scaled(value, 1000, SI, decimals, '')} ${u.slice(6)}`
      // Grafana shows an unknown unit id as a custom suffix (`cores`).
      return `${scaled(value, 1000, SI, decimals, '')} ${u}`
  }
}

/** Unit + min/max of a panel, reading modern fieldConfig or legacy yaxes. */
export function panelUnit(p: GrafanaPanel): { unit?: string; decimals?: number; min?: number; max?: number } {
  const d = p.fieldConfig?.defaults ?? {}
  const y = p.yaxes?.[0]
  const num = (v: unknown) => (v == null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined)
  return {
    unit: d.unit ?? y?.format ?? p.format,
    decimals: d.decimals,
    min: d.min ?? num(y?.min),
    max: d.max ?? num(y?.max),
  }
}

/* ─────────── thresholds & colours ─────────── */

const NAMED: Record<string, string> = {
  green: 'var(--color-emerald-500)',
  'dark-green': 'var(--color-emerald-700)',
  'semi-dark-green': 'var(--color-emerald-600)',
  'light-green': 'var(--color-emerald-400)',
  red: 'var(--color-rose-500)',
  'dark-red': 'var(--color-rose-700)',
  'semi-dark-red': 'var(--color-rose-600)',
  'light-red': 'var(--color-rose-400)',
  orange: 'var(--color-orange-500)',
  'dark-orange': 'var(--color-orange-700)',
  'semi-dark-orange': 'var(--color-orange-600)',
  'light-orange': 'var(--color-orange-400)',
  yellow: 'var(--color-amber-400)',
  'dark-yellow': 'var(--color-amber-600)',
  'semi-dark-yellow': 'var(--color-amber-500)',
  'light-yellow': 'var(--color-amber-300)',
  blue: 'var(--color-sky-500)',
  'dark-blue': 'var(--color-sky-700)',
  'semi-dark-blue': 'var(--color-sky-600)',
  'light-blue': 'var(--color-sky-400)',
  purple: 'var(--color-violet-500)',
  'dark-purple': 'var(--color-violet-700)',
  'semi-dark-purple': 'var(--color-violet-600)',
  'light-purple': 'var(--color-violet-400)',
  'super-light-green': 'var(--color-emerald-300)',
  'super-light-red': 'var(--color-rose-300)',
  'super-light-orange': 'var(--color-orange-300)',
  'super-light-yellow': 'var(--color-amber-200)',
  'super-light-blue': 'var(--color-sky-300)',
  'super-light-purple': 'var(--color-violet-300)',
  text: 'var(--color-content)',
  transparent: 'transparent',
}

/** Grafana colour (named or CSS) → a CSS colour usable in both themes. */
export function grafanaColor(c?: string): string | undefined {
  if (!c) return undefined
  return NAMED[c] ?? c
}

export type ThresholdTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral'

/** Status semantics of a threshold colour (for icon + label). */
export function colorTone(c?: string): ThresholdTone {
  const s = (c ?? '').toLowerCase()
  if (!s || s === 'text' || s === 'transparent') return 'neutral'
  if (s.includes('green') || s === '#73bf69' || s === '#299c46') return 'ok'
  if (s.includes('red') || s === '#f2495c' || s === '#d44a3a' || s === '#e02f44') return 'bad'
  if (s.includes('orange') || s.includes('yellow') || s === '#ff9830' || s === '#fade2a' || s === '#ff780a') return 'warn'
  return 'info'
}

/** The threshold step a value falls in (`steps` sorted, base step has value null). */
export function thresholdFor(
  value: number | null,
  t?: FieldDefaults['thresholds'],
  min = 0,
  max = 100,
): ThresholdStep | null {
  const steps = t?.steps ?? []
  if (!steps.length || value == null) return null
  const v = t?.mode === 'percentage' ? ((value - min) / Math.max(1e-9, max - min)) * 100 : value
  let hit = steps[0]
  for (const s of steps) if (s.value == null || v >= s.value) hit = s
  return hit
}

/** Grafana's `stringToJsRegex`: `/re/flags`, else an anchored pattern. */
export function toJsRegex(s: string): RegExp | null {
  try {
    if (s.startsWith('/')) {
      const m = /^\/(.*)\/([gimsuy]*)$/.exec(s)
      return m ? new RegExp(m[1], m[2].replace('g', '')) : new RegExp(s)
    }
    return new RegExp(`^${s}$`)
  } catch {
    return null
  }
}

/**
 * Apply value mappings the way Grafana does: the first matching mapping wins.
 * Kinds: `value` (exact string match), `range` (inclusive, open-ended when
 * null), `regex` (text may use capture groups), `special` (null, nan,
 * null+nan, true, false, empty), plus legacy type 1 (value) / 2 (range).
 */
export function mapValue(value: number | string | null | undefined, mappings?: ValueMapping[]): MappingResult | null {
  if (!mappings?.length) return null
  const isNull = value == null
  const num = typeof value === 'number' ? value : value != null && value !== '' ? Number(value) : NaN
  const str = isNull ? '' : String(value)
  for (const m of mappings) {
    const t = m.type
    if (t === 1 || t === '1') {
      if (!isNull && m.value != null && String(m.value) === str) return { text: m.text }
      if (isNull && m.value === 'null') return { text: m.text }
      continue
    }
    if (t === 2 || t === '2') {
      const from = m.from === '' || m.from == null ? -Infinity : Number(m.from)
      const to = m.to === '' || m.to == null ? Infinity : Number(m.to)
      if (Number.isFinite(num) && num >= from && num <= to) return { text: m.text }
      continue
    }
    const o = m.options as Record<string, unknown> | undefined
    if (!o) continue
    if (t === 'value') {
      if (isNull) continue
      const hit = (o as Record<string, MappingResult>)[str]
      if (hit && typeof hit === 'object') return hit
      continue
    }
    if (t === 'range') {
      if (!Number.isFinite(num)) continue
      const r = o as { from?: number | null; to?: number | null; result?: MappingResult }
      const from = r.from ?? -Infinity
      const to = r.to ?? Infinity
      if (num >= from && num <= to) return r.result ?? null
      continue
    }
    if (t === 'regex') {
      const r = o as { pattern?: string; result?: MappingResult }
      if (isNull || !r.pattern) continue
      const re = toJsRegex(r.pattern)
      if (re && re.test(str)) {
        const res = { ...(r.result ?? {}) }
        if (res.text) res.text = str.replace(re, res.text)
        return res
      }
      continue
    }
    if (t === 'special') {
      const r = o as { match?: string; result?: MappingResult }
      const nan = typeof value === 'number' && Number.isNaN(value)
      const hit = (r.match === 'null' && isNull) ||
        (r.match === 'nan' && nan) ||
        (r.match === 'null+nan' && (isNull || nan)) ||
        (r.match === 'true' && (value === 1 || str === 'true')) ||
        (r.match === 'false' && (value === 0 || str === 'false')) ||
        (r.match === 'empty' && str === '')
      if (hit) return r.result ?? null
    }
  }
  return null
}

/** Categorical palette for series (status colours deliberately excluded). */
export const SERIES_COLORS = [
  'var(--color-brand-500)',
  'var(--color-violet-500)',
  'var(--color-sky-500)',
  'var(--color-teal-500)',
  'var(--color-fuchsia-500)',
  'var(--color-indigo-400)',
  'var(--color-cyan-600)',
  'var(--color-pink-400)',
  'var(--color-lime-600)',
  'var(--color-slate-400)',
]

/* ─────────── panel support ─────────── */

export const SUPPORTED_PANELS = new Set([
  'timeseries',
  'graph',
  'stat',
  'singlestat',
  'gauge',
  'bargauge',
  'table',
  'table-old',
  'text',
  'piechart',
  'barchart',
  'logs',
  'state-timeline',
  'status-history',
  'heatmap',
  'histogram',
  'dashlist',
  'alertlist',
  'annolist',
])

/** Panels that render without running the panel's own queries. */
export const NO_QUERY_PANELS = new Set(['text', 'dashlist', 'alertlist', 'annolist'])

/** Deep link to one panel in Grafana. */
export function panelLink(base: string, uid: string, panelId: number, from: string, to: string, vars: VarMap): string {
  if (!base) return ''
  const qs = new URLSearchParams({ viewPanel: String(panelId), from, to })
  for (const [k, v] of Object.entries(vars)) for (const val of v.values) qs.append(`var-${k}`, val === ALL_VALUE ? 'All' : val)
  return `${base.replace(/\/$/, '')}/d/${encodeURIComponent(uid)}?${qs}`
}

export function boardLink(base: string, uid: string, from: string, to: string, vars: VarMap): string {
  if (!base) return ''
  const qs = new URLSearchParams({ from, to })
  for (const [k, v] of Object.entries(vars)) for (const val of v.values) qs.append(`var-${k}`, val === ALL_VALUE ? 'All' : val)
  return `${base.replace(/\/$/, '')}/d/${encodeURIComponent(uid)}?${qs}`
}

/* ─────────── library ─────────── */

export interface SearchHit {
  uid: string
  title: string
  tags: string[]
  folderTitle?: string
  folderUid?: string
  isStarred?: boolean
  url?: string
  type?: string
}

/** Tokens that mark the Adhar golden-signals boards. */
const GOLDEN_RE = /golden|adhar|red method|use method|slo|http|service overview/i

export function isGoldenBoard(h: SearchHit): boolean {
  return GOLDEN_RE.test(h.title) || h.tags.some((t) => /golden|adhar|slo|red|use/i.test(t))
}

/** Filter + group the dashboard library: starred first, then folders A→Z. */
export function groupLibrary(
  hits: SearchHit[],
  opts: { query?: string; tags?: string[]; starredOnly?: boolean; folder?: string } = {},
): Array<{ folder: string; items: SearchHit[] }> {
  const q = (opts.query ?? '').trim().toLowerCase()
  const tags = opts.tags ?? []
  const filtered = hits.filter((h) => {
    if (opts.starredOnly && !h.isStarred) return false
    if (opts.folder && (h.folderTitle ?? 'General') !== opts.folder) return false
    if (tags.length && !tags.every((t) => h.tags.includes(t))) return false
    if (!q) return true
    return (
      h.title.toLowerCase().includes(q) ||
      (h.folderTitle ?? '').toLowerCase().includes(q) ||
      h.tags.some((t) => t.toLowerCase().includes(q))
    )
  })
  const groups = new Map<string, SearchHit[]>()
  const starred = filtered.filter((h) => h.isStarred)
  if (starred.length && !opts.starredOnly) groups.set('★ Starred', starred)
  for (const h of filtered) {
    const f = h.folderTitle || 'General'
    if (!groups.has(f)) groups.set(f, [])
    groups.get(f)!.push(h)
  }
  return [...groups.entries()]
    .map(([folder, items]) => ({ folder, items: items.sort((a, b) => a.title.localeCompare(b.title)) }))
    .sort((a, b) => (a.folder.startsWith('★') ? -1 : b.folder.startsWith('★') ? 1 : a.folder.localeCompare(b.folder)))
}

/** Tag → count across the library, most used first. */
export function tagCounts(hits: SearchHit[]): Array<[string, number]> {
  const m = new Map<string, number>()
  for (const h of hits) for (const t of h.tags) m.set(t, (m.get(t) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** Validate an import payload: accepts a bare dashboard or `{dashboard: …}`. */
export function parseImport(text: string): { ok: true; dashboard: Record<string, unknown> } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Expected a JSON object.' }
  const obj = raw as Record<string, unknown>
  const dash = (obj.dashboard && typeof obj.dashboard === 'object' ? obj.dashboard : obj) as Record<string, unknown>
  if (typeof dash.title !== 'string' || !dash.title.trim()) return { ok: false, error: 'Dashboard JSON needs a "title".' }
  if (!Array.isArray(dash.panels) && !Array.isArray(dash.rows)) {
    return { ok: false, error: 'Dashboard JSON has no "panels" (or legacy "rows").' }
  }
  // Grafana assigns a fresh numeric id; a stale one makes the save fail.
  const { id: _id, ...rest } = dash
  return { ok: true, dashboard: rest }
}

/* ─────────── URL state ─────────── */

export interface BoardUrlState {
  board?: string
  from?: string
  to?: string
  refresh?: string
  vars: Record<string, string[]>
}

/** Read `board`, `from`, `to`, `refresh`, `var-*` from a query string. */
export function readBoardUrl(search: string): BoardUrlState {
  const p = new URLSearchParams(search)
  const dec = (v: string | null) => {
    if (v == null) return undefined
    if (v.startsWith('"')) {
      try {
        const j = JSON.parse(v)
        if (typeof j === 'string') return j
      } catch { /* keep raw */ }
    }
    return v
  }
  const vars: Record<string, string[]> = {}
  for (const [k, v] of p) {
    if (!k.startsWith('var-')) continue
    const val = dec(v) ?? ''
    ;(vars[k.slice(4)] ??= []).push(val === 'All' ? ALL_VALUE : val)
  }
  return { board: dec(p.get('board')), from: dec(p.get('from')), to: dec(p.get('to')), refresh: dec(p.get('refresh')), vars }
}

/** Write board state into a query string, keeping every unrelated param. */
export function writeBoardUrl(search: string, s: BoardUrlState): string {
  const p = new URLSearchParams(search)
  for (const k of [...p.keys()]) if (k.startsWith('var-') || ['board', 'from', 'to', 'refresh'].includes(k)) p.delete(k)
  // TanStack Router reads JSON-looking values as JSON — quote those.
  const enc = (v: string) => {
    try {
      JSON.parse(v)
      return JSON.stringify(v)
    } catch {
      return v
    }
  }
  if (s.board) p.set('board', enc(s.board))
  if (s.board) {
    if (s.from) p.set('from', enc(s.from))
    if (s.to) p.set('to', enc(s.to))
    if (s.refresh) p.set('refresh', enc(s.refresh))
    for (const [k, vals] of Object.entries(s.vars)) for (const v of vals) p.append(`var-${k}`, v === ALL_VALUE ? 'All' : enc(v))
  }
  const out = p.toString()
  return out ? `?${out}` : ''
}
