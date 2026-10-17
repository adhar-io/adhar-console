/**
 * PromQL editor helpers — autocomplete-lite, query history, presets.
 * Pure and JSX-free (unit-tested), except the localStorage wrappers which
 * tolerate a missing / throwing storage.
 */

import { httpQueries, type HttpSource, saturationQueries, USE_QUERIES } from './golden-signals.ts'

export const PROMQL_FUNCTIONS = [
  'abs', 'absent', 'absent_over_time', 'avg_over_time', 'ceil', 'changes', 'clamp', 'clamp_max', 'clamp_min',
  'count_over_time', 'day_of_week', 'delta', 'deriv', 'exp', 'floor', 'histogram_quantile', 'holt_winters',
  'idelta', 'increase', 'irate', 'label_join', 'label_replace', 'last_over_time', 'ln', 'log2', 'log10',
  'max_over_time', 'min_over_time', 'predict_linear', 'quantile_over_time', 'rate', 'resets', 'round',
  'scalar', 'sort', 'sort_desc', 'sqrt', 'stddev_over_time', 'sum_over_time', 'time', 'timestamp', 'vector',
]
export const PROMQL_AGGREGATIONS = [
  'sum', 'avg', 'min', 'max', 'count', 'count_values', 'group', 'stddev', 'stdvar', 'topk', 'bottomk', 'quantile',
]
export const PROMQL_KEYWORDS = ['by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'offset', 'bool', 'and', 'or', 'unless']

export type SuggestionKind = 'metric' | 'function' | 'aggregation' | 'keyword' | 'label' | 'value' | 'range'

export interface Suggestion {
  text: string
  kind: SuggestionKind
  /** What to insert (defaults to text); functions get a trailing `(`. */
  insert?: string
  detail?: string
}

export interface Context {
  /** Token being typed (prefix to complete). */
  prefix: string
  /** Start offset of `prefix` in the text. */
  start: number
  /** Where the cursor sits syntactically. */
  where: 'expr' | 'labelName' | 'labelValue' | 'range' | 'grouping'
  /** Metric whose `{…}` the cursor is inside (labelName / labelValue). */
  metric?: string
  /** Label whose value is being typed (labelValue). */
  label?: string
}

/** Work out what the cursor is completing. */
export function cursorContext(text: string, cursor: number): Context {
  const before = text.slice(0, cursor)
  // Inside a label value string?  …label="pre|   or  …label=~"pre|
  const val = /([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]*)$/.exec(before)
  if (val && insideBraces(before)) {
    return { prefix: val[3], start: cursor - val[3].length, where: 'labelValue', label: val[1], metric: braceMetric(before) }
  }
  const tok = /[A-Za-z_:][A-Za-z0-9_:]*$/.exec(before)
  const prefix = tok ? tok[0] : ''
  const start = cursor - prefix.length
  if (/\[[^\]]*$/.test(before)) return { prefix: before.slice(before.lastIndexOf('[') + 1), start: before.lastIndexOf('[') + 1, where: 'range' }
  if (insideBraces(before)) return { prefix, start, where: 'labelName', metric: braceMetric(before) }
  // `by (` / `without (` grouping list.
  if (/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*$/.test(before)) return { prefix, start, where: 'grouping' }
  return { prefix, start, where: 'expr' }
}

function insideBraces(before: string): boolean {
  let depth = 0
  let inStr = false
  for (let i = 0; i < before.length; i++) {
    const c = before[i]
    if (c === '"' && before[i - 1] !== '\\') inStr = !inStr
    if (inStr) continue
    if (c === '{') depth++
    if (c === '}') depth = Math.max(0, depth - 1)
  }
  return depth > 0
}

function braceMetric(before: string): string | undefined {
  const i = before.lastIndexOf('{')
  const m = /([A-Za-z_:][A-Za-z0-9_:]*)\s*$/.exec(before.slice(0, i))
  return m?.[1]
}

/** Rank: exact-prefix first, then substring, then shorter names. */
function rank(list: string[], prefix: string, limit: number): string[] {
  const p = prefix.toLowerCase()
  const pre: string[] = []
  const sub: string[] = []
  for (const s of list) {
    const l = s.toLowerCase()
    if (l.startsWith(p)) pre.push(s)
    else if (p.length >= 2 && l.includes(p)) sub.push(s)
  }
  const byLen = (a: string, b: string) => a.length - b.length || a.localeCompare(b)
  return [...pre.sort(byLen), ...sub.sort(byLen)].slice(0, limit)
}

export interface Vocab {
  metrics: string[]
  labels?: string[]
  values?: string[]
  meta?: Record<string, { type: string; help: string }>
}

export function suggest(ctx: Context, vocab: Vocab, limit = 12): Suggestion[] {
  switch (ctx.where) {
    case 'range':
      return ['1m', '5m', '15m', '1h', '6h', '1d']
        .filter((r) => r.startsWith(ctx.prefix))
        .map((r) => ({ text: r, kind: 'range' as const, insert: `${r}]` }))
    case 'labelValue':
      return rank(vocab.values ?? [], ctx.prefix, limit).map((v) => ({ text: v, kind: 'value' as const, insert: `${v}"` }))
    case 'labelName':
    case 'grouping':
      return rank(vocab.labels ?? [], ctx.prefix, limit).map((l) => ({
        text: l,
        kind: 'label' as const,
        insert: ctx.where === 'labelName' ? `${l}="` : l,
      }))
    case 'expr': {
      if (!ctx.prefix) return []
      const fns = rank(PROMQL_FUNCTIONS, ctx.prefix, 4).map((f) => ({ text: f, kind: 'function' as const, insert: `${f}(` }))
      const aggs = rank(PROMQL_AGGREGATIONS, ctx.prefix, 3).map((f) => ({ text: f, kind: 'aggregation' as const, insert: `${f}(` }))
      const kws = rank(PROMQL_KEYWORDS, ctx.prefix, 2).map((k) => ({ text: k, kind: 'keyword' as const, insert: `${k} ` }))
      const mets = rank(vocab.metrics, ctx.prefix, limit).map((m) => ({
        text: m,
        kind: 'metric' as const,
        detail: vocab.meta?.[m]?.type,
      }))
      return [...aggs, ...fns, ...kws, ...mets].slice(0, limit)
    }
  }
}

/** Replace the completed token with the suggestion; returns new text + cursor. */
export function applySuggestion(text: string, ctx: Context, s: Suggestion, cursor: number): { text: string; cursor: number } {
  const ins = s.insert ?? s.text
  // Swallow the rest of a half-typed identifier after the cursor.
  const tail = text.slice(cursor)
  const rest = ctx.where === 'labelValue' ? /^[^"]*"?/.exec(tail)?.[0] ?? '' : /^[A-Za-z0-9_:]*/.exec(tail)?.[0] ?? ''
  const next = text.slice(0, ctx.start) + ins + text.slice(cursor + rest.length)
  return { text: next, cursor: ctx.start + ins.length }
}

/** The metric names referenced in an expression (for "explain" / labels). */
export function referencedMetrics(expr: string, known: Set<string>): string[] {
  const out = new Set<string>()
  const stripped = expr.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  for (const m of stripped.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*/g)) if (known.has(m[0])) out.add(m[0])
  return [...out]
}

/** Starter expression for a metric by its type. */
export function starterFor(name: string, type?: string): string {
  if (type === 'histogram' || name.endsWith('_bucket')) {
    const base = name.replace(/_bucket$/, '')
    return `histogram_quantile(0.95, sum by (le) (rate(${base}_bucket[5m])))`
  }
  if (type === 'counter' || name.endsWith('_total')) return `sum(rate(${name}[5m]))`
  if (type === 'summary') return `${name}{quantile="0.95"}`
  return name
}

/* ─────────── history ─────────── */

const HISTORY_KEY = 'adhar.discover.promql-history'
export const HISTORY_MAX = 30

/** Push a query to the front (deduped, capped). */
export function pushHistory(list: string[], q: string, max = HISTORY_MAX): string[] {
  const t = q.trim()
  if (!t) return list
  return [t, ...list.filter((x) => x !== t)].slice(0, max)
}

export function loadHistory(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(HISTORY_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function saveHistory(list: string[]): void {
  try {
    globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable */
  }
}

/* ─────────── presets ─────────── */

export type Unit = 'auto' | 'short' | 'percent' | 'ms' | 'seconds' | 'bytes' | 'bytes/s' | 'cores' | 'rps'

export interface Preset {
  group: string
  label: string
  queries: string[]
  unit: Unit
}

export function goldenPresets(src: HttpSource | null): Preset[] {
  const out: Preset[] = []
  if (src) {
    const q = httpQueries(src, {}, '5m')
    const by = httpQueries(src, {}, '5m', src.serviceLabel)
    out.push(
      { group: 'Golden signals', label: 'Latency p50 / p90 / p99', queries: [q.p50, q.p90, q.p99].filter(Boolean) as string[], unit: 'ms' },
      { group: 'Golden signals', label: 'Traffic (requests/s)', queries: [q.rps], unit: 'rps' },
      { group: 'Golden signals', label: 'Errors — 5xx share', queries: [q.errorPct], unit: 'percent' },
      { group: 'Golden signals', label: 'Errors — 5xx per second', queries: [q.errorRps], unit: 'rps' },
      { group: 'RED by service', label: 'Rate by service', queries: [`topk(10, ${by.rps})`], unit: 'rps' },
      { group: 'RED by service', label: 'Error % by service', queries: [`topk(10, ${by.errorPct})`], unit: 'percent' },
    )
    if (by.p95) out.push({ group: 'RED by service', label: 'p95 by service', queries: [`topk(10, ${by.p95})`], unit: 'ms' })
  }
  const sat = saturationQueries({}, '5m')
  out.push(
    { group: 'Saturation', label: 'Node CPU / memory / disk %', queries: [sat.cpuPct, sat.memPct, sat.diskPct!], unit: 'percent' },
    { group: 'Saturation', label: 'Node network rx / tx', queries: [sat.netRx, sat.netTx], unit: 'bytes/s' },
    {
      group: 'Saturation',
      label: 'CPU by namespace',
      queries: ['topk(8, sum by (namespace) (rate(container_cpu_usage_seconds_total{container!="", container!="POD"}[5m])))'],
      unit: 'cores',
    },
    {
      group: 'Saturation',
      label: 'Memory by namespace',
      queries: ['topk(8, sum by (namespace) (container_memory_working_set_bytes{container!="", container!="POD"}))'],
      unit: 'bytes',
    },
    { group: 'USE (nodes)', label: 'CPU utilisation by node', queries: [USE_QUERIES.cpuUtil], unit: 'percent' },
    { group: 'USE (nodes)', label: 'Load per core by node', queries: [USE_QUERIES.cpuSat], unit: 'short' },
    { group: 'USE (nodes)', label: 'Memory utilisation by node', queries: [USE_QUERIES.memUtil], unit: 'percent' },
    { group: 'Kubernetes', label: 'Container restarts (1h)', queries: ['topk(10, sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h])) > 0)'], unit: 'short' },
    { group: 'Kubernetes', label: 'Pods by phase', queries: ['sum by (phase) (kube_pod_status_phase)'], unit: 'short' },
    { group: 'Kubernetes', label: 'Scrape targets up', queries: ['sum by (job) (up)'], unit: 'short' },
  )
  return out
}

/** Format a value for a unit (shared by chart axes, tooltips and tables). */
export function formatValue(v: number | null | undefined, unit: Unit): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  const short = (x: number) => {
    const ax = Math.abs(x)
    if (ax >= 1e9) return `${(x / 1e9).toFixed(1)}G`
    if (ax >= 1e6) return `${(x / 1e6).toFixed(1)}M`
    if (ax >= 1e3) return `${(x / 1e3).toFixed(1)}k`
    if (ax >= 100 || ax === 0) return x.toFixed(0)
    if (ax >= 10) return x.toFixed(1)
    if (ax >= 1) return x.toFixed(2)
    return x.toPrecision(2)
  }
  switch (unit) {
    case 'percent':
      return `${a >= 10 ? v.toFixed(1) : v.toFixed(2)}%`
    case 'ms':
      return a >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${a >= 10 ? v.toFixed(0) : v.toFixed(1)} ms`
    case 'seconds':
      return a >= 1 ? `${v.toFixed(2)} s` : `${(v * 1000).toFixed(0)} ms`
    case 'bytes':
    case 'bytes/s': {
      const sfx = unit === 'bytes/s' ? '/s' : ''
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let x = v
      let i = 0
      while (Math.abs(x) >= 1024 && i < units.length - 1) {
        x /= 1024
        i++
      }
      return `${Math.abs(x) >= 100 || i === 0 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}${sfx}`
    }
    case 'cores':
      return a < 1 ? `${(v * 1000).toFixed(0)}m` : `${v.toFixed(2)}`
    case 'rps':
      return `${short(v)}/s`
    default:
      return short(v)
  }
}

/** Guess a unit from the expression when the user leaves it on auto. */
export function guessUnit(expr: string): Unit {
  const e = expr.replace(/\s+/g, ' ')
  if (/^\s*100 \*/.test(e) || /_ratio\b|_percent\b/.test(e)) return 'percent'
  if (/^\s*1000 \* histogram_quantile|_milliseconds/.test(e)) return 'ms'
  if (/histogram_quantile/.test(e) && /_seconds/.test(e)) return 'seconds'
  if (/_bytes_total/.test(e) && /rate\(/.test(e)) return 'bytes/s'
  if (/_bytes\b/.test(e)) return 'bytes'
  if (/cpu_usage_seconds_total/.test(e) && /rate\(/.test(e)) return 'cores'
  if (/(rate|irate)\(/.test(e)) return 'rps'
  return 'short'
}
