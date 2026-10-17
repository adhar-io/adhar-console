/**
 * LogQL builder, parser and volume helpers — pure, React-free, unit tested.
 *
 * The builder models the subset of LogQL an operator composes by hand every
 * day: a stream selector, line filters, one parser, label filters after it,
 * an optional `line_format`, and an optional metric wrapper. `parseLogQL`
 * reads a query back into that model when (and only when) it fits; anything
 * the model can't represent returns `null` so the UI falls back to the raw
 * editor instead of silently rewriting the operator's query.
 */

export type MatcherOp = '=' | '!=' | '=~' | '!~'
export type LineFilterOp = '|=' | '!=' | '|~' | '!~'
export type LabelFilterOp = '=' | '!=' | '=~' | '!~' | '>' | '>=' | '<' | '<='
export type ParserKind = 'none' | 'json' | 'logfmt' | 'pattern' | 'regexp'
export type MetricFn = 'none' | 'count_over_time' | 'rate' | 'bytes_over_time' | 'bytes_rate'
export type MetricAgg = 'none' | 'sum' | 'avg' | 'max' | 'min' | 'topk'

export interface LogQLSpec {
  matchers: Array<{ key: string; op: MatcherOp; value: string }>
  lineFilters: Array<{ op: LineFilterOp; value: string }>
  parser: ParserKind
  /** Expression for `pattern` / `regexp` parsers. */
  parserArg?: string
  labelFilters: Array<{ key: string; op: LabelFilterOp; value: string }>
  lineFormat?: string
  metric: { fn: MetricFn; range: string; agg: MetricAgg; by: string[]; k?: number }
}

export const EMPTY_SPEC: LogQLSpec = {
  matchers: [],
  lineFilters: [],
  parser: 'none',
  labelFilters: [],
  metric: { fn: 'none', range: '5m', agg: 'sum', by: [], k: 10 },
}

/* ─────────── building ─────────── */

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Regex values read best as raw backtick strings (no double escaping). */
function quoteRegex(s: string): string {
  return s.includes('`') ? quote(s) : `\`${s}\``
}

const NUMERIC_LITERAL = /^-?\d+(\.\d+)?(ns|us|µs|ms|s|m|h|d|w|y|b|kb|mb|gb|kib|mib|gib|B|KB|MB|GB|KiB|MiB|GiB)?$/

export function buildSelector(matchers: LogQLSpec['matchers']): string {
  const parts = matchers
    .filter((m) => m.key.trim())
    .map((m) => `${m.key.trim()}${m.op}${m.op.includes('~') ? quoteRegex(m.value) : quote(m.value)}`)
  return `{${parts.join(', ')}}`
}

/** The log (stream) part of the query — no metric wrapper. */
export function buildLogPipeline(spec: LogQLSpec): string {
  let q = buildSelector(spec.matchers)
  for (const f of spec.lineFilters) {
    if (!f.value) continue
    q += ` ${f.op} ${f.op.includes('~') ? quoteRegex(f.value) : quote(f.value)}`
  }
  if (spec.parser === 'json' || spec.parser === 'logfmt') q += ` | ${spec.parser}`
  else if ((spec.parser === 'pattern' || spec.parser === 'regexp') && spec.parserArg) {
    q += ` | ${spec.parser} ${quoteRegex(spec.parserArg)}`
  }
  for (const f of spec.labelFilters) {
    if (!f.key.trim()) continue
    const cmp = f.op === '>' || f.op === '>=' || f.op === '<' || f.op === '<='
    const v = cmp && NUMERIC_LITERAL.test(f.value)
      ? f.value
      : f.op.includes('~')
        ? quoteRegex(f.value)
        : quote(f.value)
    q += ` | ${f.key.trim()}${f.op}${v}`
  }
  if (spec.lineFormat) q += ` | line_format ${quote(spec.lineFormat)}`
  return q
}

export function buildLogQL(spec: LogQLSpec): string {
  const pipeline = buildLogPipeline(spec)
  const m = spec.metric
  if (m.fn === 'none') return pipeline
  const inner = `${m.fn}(${pipeline} [${m.range || '5m'}])`
  if (m.agg === 'none') return inner
  const by = m.by.filter(Boolean)
  const byClause = by.length ? ` by (${by.join(', ')})` : ''
  if (m.agg === 'topk') return `topk(${m.k ?? 10}, sum${byClause} (${inner}))`
  return `${m.agg}${byClause} (${inner})`
}

/** Problems that would make Loki reject the built query. */
export function validateSpec(spec: LogQLSpec): string[] {
  const out: string[] = []
  const real = spec.matchers.filter((m) => m.key.trim())
  if (!real.length) out.push('Add at least one label matcher — Loki needs a stream selector.')
  else if (real.every((m) => (m.op === '=' && m.value === '') || ((m.op === '=~') && /^(\.\*)?$/.test(m.value)) || m.op === '!=' || m.op === '!~')) {
    out.push('At least one matcher must select something (e.g. namespace="adhar-system" or app=~".+").')
  }
  if ((spec.parser === 'pattern' || spec.parser === 'regexp') && !spec.parserArg) {
    out.push(`The ${spec.parser} parser needs an expression.`)
  }
  if (spec.metric.fn !== 'none' && !/^\d+(ms|s|m|h|d)$/.test(spec.metric.range)) {
    out.push('Metric range must be a duration like 1m, 5m or 1h.')
  }
  return out
}

/* ─────────── parsing ─────────── */

const STR = String.raw`"((?:[^"\\]|\\.)*)"|\x60([^\x60]*)\x60`

function unq(dq: string | undefined, bt: string | undefined): string {
  if (bt !== undefined) return bt
  return (dq ?? '').replace(/\\(.)/g, '$1')
}

/** True for a LogQL *metric* query (returns series, not lines). */
export function isMetricQuery(q: string): boolean {
  return /^\s*\(?\s*(sum|avg|min|max|count|topk|bottomk|stddev|stdvar|sort|sort_desc|quantile_over_time|rate|rate_counter|count_over_time|bytes_rate|bytes_over_time|absent_over_time|sum_over_time|avg_over_time|max_over_time|min_over_time|first_over_time|last_over_time|stddev_over_time|stdvar_over_time|label_replace|vector)\s*(\(|by\b|without\b)/
    .test(q)
}

function parsePipeline(src: string): Omit<LogQLSpec, 'metric'> | null {
  const sel = /^\s*\{([^}]*)\}/.exec(src)
  if (!sel) return null
  const matchers: LogQLSpec['matchers'] = []
  const body = sel[1].trim()
  if (body) {
    const re = new RegExp(String.raw`\s*([A-Za-z_][\w]*)\s*(=~|!~|!=|=)\s*(?:${STR})\s*(,|$)`, 'y')
    let pos = 0
    while (pos < body.length) {
      re.lastIndex = pos
      const m = re.exec(body)
      if (!m) return null
      matchers.push({ key: m[1], op: m[2] as MatcherOp, value: unq(m[3], m[4]) })
      pos = re.lastIndex
    }
  }
  const out: Omit<LogQLSpec, 'metric'> = { matchers, lineFilters: [], parser: 'none', labelFilters: [] }
  let rest = src.slice(sel[0].length)
  const stages: Array<[RegExp, (m: RegExpExecArray) => boolean]> = [
    [new RegExp(String.raw`^\s*(\|=|!=|\|~|!~)\s*(?:${STR})`), (m) => {
      out.lineFilters.push({ op: m[1] as LineFilterOp, value: unq(m[2], m[3]) })
      return true
    }],
    [/^\s*\|\s*(json|logfmt)\b(?!\s*[A-Za-z_]\w*\s*=)/, (m) => {
      if (out.parser !== 'none') return false
      out.parser = m[1] as ParserKind
      return true
    }],
    [new RegExp(String.raw`^\s*\|\s*(pattern|regexp)\s+(?:${STR})`), (m) => {
      if (out.parser !== 'none') return false
      out.parser = m[1] as ParserKind
      out.parserArg = unq(m[2], m[3])
      return true
    }],
    [new RegExp(String.raw`^\s*\|\s*line_format\s+(?:${STR})`), (m) => {
      out.lineFormat = unq(m[1], m[2])
      return true
    }],
    [new RegExp(String.raw`^\s*\|\s*([A-Za-z_][\w.]*)\s*(=~|!~|!=|>=|<=|==|=|>|<)\s*(?:${STR}|([^\s|()]+))`), (m) => {
      const op = (m[2] === '==' ? '=' : m[2]) as LabelFilterOp
      out.labelFilters.push({ key: m[1], op, value: m[5] ?? unq(m[3], m[4]) })
      return true
    }],
  ]
  while (rest.trim()) {
    let matched = false
    for (const [re, apply] of stages) {
      const m = re.exec(rest)
      if (m) {
        if (!apply(m)) return null
        rest = rest.slice(m[0].length)
        matched = true
        break
      }
    }
    if (!matched) return null
  }
  return out
}

/**
 * Read a query back into the builder model, or `null` when it uses LogQL the
 * builder can't express (so the caller keeps the raw editor).
 */
export function parseLogQL(query: string): LogQLSpec | null {
  const q = query.trim()
  if (!q) return { ...EMPTY_SPEC, matchers: [], lineFilters: [], labelFilters: [], metric: { ...EMPTY_SPEC.metric } }
  if (!isMetricQuery(q)) {
    const p = parsePipeline(q)
    return p ? { ...p, metric: { ...EMPTY_SPEC.metric } } : null
  }
  // topk(K, sum [by (..)] (FN(PIPE [R])))
  let m = /^topk\(\s*(\d+)\s*,\s*sum(?:\s+by\s*\(([^)]*)\))?\s*\(\s*(count_over_time|rate|bytes_over_time|bytes_rate)\((.*)\[(\w+)\]\s*\)\s*\)\s*\)$/s.exec(q)
  if (m) {
    const p = parsePipeline(m[4])
    if (!p) return null
    return { ...p, metric: { fn: m[3] as MetricFn, range: m[5], agg: 'topk', by: splitBy(m[2]), k: Number(m[1]) } }
  }
  // AGG [by (..)] (FN(PIPE [R]))
  m = /^(sum|avg|max|min)(?:\s+by\s*\(([^)]*)\))?\s*\(\s*(count_over_time|rate|bytes_over_time|bytes_rate)\((.*)\[(\w+)\]\s*\)\s*\)$/s.exec(q)
  if (m) {
    const p = parsePipeline(m[4])
    if (!p) return null
    return { ...p, metric: { fn: m[3] as MetricFn, range: m[5], agg: m[1] as MetricAgg, by: splitBy(m[2]), k: 10 } }
  }
  // FN(PIPE [R])
  m = /^(count_over_time|rate|bytes_over_time|bytes_rate)\((.*)\[(\w+)\]\s*\)$/s.exec(q)
  if (m) {
    const p = parsePipeline(m[2])
    if (!p) return null
    return { ...p, metric: { fn: m[1] as MetricFn, range: m[3], agg: 'none', by: [], k: 10 } }
  }
  return null
}

function splitBy(s: string | undefined): string[] {
  return (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
}

/* ─────────── volume ─────────── */

/**
 * Keyword level detection that mirrors `detectLogLevel` closely enough for a
 * volume chart: a `level=`/`severity:` token, or an upper-case `[ERROR]`-style
 * token. Raw (backtick) LogQL strings, RE2 syntax.
 */
export const ERROR_LINE_RE =
  String.raw`(?i)(?:level|lvl|severity|loglevel)"?\s*[=:]\s*"?(?:error|err|fatal|crit|critical|panic|emerg|alert)\b|(?-i:\b(?:ERROR|FATAL|CRITICAL|PANIC)\b)`
export const WARN_LINE_RE = String.raw`(?i)(?:level|lvl|severity|loglevel)"?\s*[=:]\s*"?(?:warn|warning)\b|(?-i:\b(?:WARN|WARNING)\b)`

/**
 * Metric queries that count the *full* volume of a log query (not just the
 * lines fetched under the limit), split by keyword-detected level. Returns
 * null for metric queries, which have no line volume.
 */
export function volumeQueries(query: string, stepSec: number): { total: string; error: string; warn: string } | null {
  const q = query.trim()
  if (!q || isMetricQuery(q) || !/^\{/.test(q)) return null
  const r = `${Math.max(1, Math.round(stepSec))}s`
  return {
    total: `sum(count_over_time(${q} [${r}]))`,
    error: `sum(count_over_time(${q} |~ \`${ERROR_LINE_RE}\` [${r}]))`,
    warn: `sum(count_over_time(${q} |~ \`${WARN_LINE_RE}\` [${r}]))`,
  }
}

/** A step (seconds) that yields ~`buckets` points across the window, rounded to a friendly unit. */
export function stepFor(windowMs: number, buckets = 60): number {
  const raw = windowMs / 1000 / buckets
  const nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]
  return nice.find((n) => n >= raw) ?? Math.ceil(raw)
}

/* ─────────── spike detection ─────────── */

export interface Spike {
  index: number
  count: number
  /** count / baseline (baseline floored at 1). */
  ratio: number
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Buckets whose count stands out from the series: above a robust threshold
 * (median + k·MAD) **and** at least `factor`× the baseline **and** at least
 * `minCount`. Median/MAD rather than mean/σ so one burst can't hide itself by
 * inflating the spread.
 */
export function detectSpikes(counts: number[], opts: { minCount?: number; factor?: number; k?: number } = {}): Spike[] {
  const minCount = opts.minCount ?? 5
  const factor = opts.factor ?? 3
  const k = opts.k ?? 4
  if (counts.length < 4) return []
  const med = median(counts)
  const mad = median(counts.map((c) => Math.abs(c - med))) * 1.4826
  const base = Math.max(1, med)
  const threshold = Math.max(minCount, med + k * mad, base * factor)
  const out: Spike[] = []
  counts.forEach((c, index) => {
    if (c >= threshold) out.push({ index, count: c, ratio: c / base })
  })
  return out
}

/* ─────────── trace ids ─────────── */

const TRACE_KEYS = ['traceid', 'trace_id', 'traceId', 'traceID', 'trace.id', 'otel.trace_id', 'otelTraceID', 'dd.trace_id', 'x-b3-traceid']
const TRACE_IN_LINE = /(?:trace[_.\-]?id|traceparent)["']?\s*[=:]\s*["']?(?:00-)?([0-9a-f]{32}|[0-9a-f]{16})\b/i

/** A W3C/OTel trace id carried by a log line's labels, parsed fields, or text. */
export function findTraceId(
  message: string,
  labels: Record<string, string> = {},
  fields: Record<string, string> = {},
): string | null {
  const lower = new Map<string, string>()
  for (const [k, v] of [...Object.entries(labels), ...Object.entries(fields)]) lower.set(k.toLowerCase(), v)
  for (const k of TRACE_KEYS) {
    const v = lower.get(k.toLowerCase())
    if (v && /^[0-9a-f]{16,32}$/i.test(v.trim()) && !/^0+$/.test(v.trim())) return v.trim().toLowerCase()
  }
  const m = TRACE_IN_LINE.exec(message)
  if (m && !/^0+$/.test(m[1])) return m[1].toLowerCase()
  return null
}
