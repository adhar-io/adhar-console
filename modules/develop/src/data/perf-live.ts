/**
 * Live signals for one k6 run, from the best source that exists — and an
 * honest record of which one that was.
 *
 *   1. **k6 remote-write metrics** (`k6_*` series, `--out experimental-prometheus-rw`).
 *      The full picture: RPS, latency percentiles, error rate, VUs, data. The
 *      k6 operator tags every sample with `testrun_name=<run>`, so a run's
 *      series are selectable without any extra configuration in the script.
 *      Not enabled on this platform by default (no remote-write receiver).
 *   2. **k6 progress lines** — VUs and iterations, printed about once a second
 *      unless the runner is `--quiet` (console-launched runs are quiet).
 *   3. **cAdvisor** — the runner pods' own CPU and network, which Prometheus
 *      scrapes everywhere. Network out of a load generator is the load it is
 *      sending, measured at the pod rather than by k6.
 *   4. **Runner logs** — k6 logs every failed request (`level=warning
 *      msg="Request Failed"`) with a timestamp, so failures per second and the
 *      most common errors come from stdout even for a quiet run.
 *   5. **The end-of-test summary** — the authoritative totals, once it ends.
 *
 * Nothing here interpolates or invents: a series is only drawn where samples
 * exist, and every chart is labelled with the source it came from.
 */

/* ─────────────────────────── logfmt ─────────────────────────── */

/** `time="…" level=warning msg="Request Failed" error="Get \"…\": …"` → fields. */
export function parseLogfmt(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z_][\w.-]*)=("((?:[^"\\]|\\.)*)"|\S*)/g
  for (const m of line.matchAll(re)) {
    out[m[1]] = m[3] !== undefined ? m[3].replace(/\\(["\\])/g, '$1') : m[2]
  }
  return out
}

export type LogLevel = 'error' | 'warning' | 'info' | 'debug'

/** A k6 log line's level, or undefined for summary / plain output. */
export function k6LogLevel(text: string): LogLevel | undefined {
  if (!/\blevel=/.test(text)) return undefined
  const m = /\blevel=(\w+)/.exec(text)
  const l = m?.[1]?.toLowerCase()
  if (l === 'error' || l === 'fatal' || l === 'panic') return 'error'
  if (l === 'warning' || l === 'warn') return 'warning'
  if (l === 'debug' || l === 'trace') return 'debug'
  return 'info'
}

/**
 * Fold the variable parts out of a message so identical failures group:
 * numbers, IPs and ports, hex ids and quoted URLs' query strings.
 */
export function normaliseMessage(s: string): string {
  return s
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\?[^\s"']*/g, '?…')
    .replace(/\b\d+(?:\.\d+)?(ms|s|µs)?\b/g, (_m, u) => `<n>${u ?? ''}`)
    .trim()
}

export interface LogGroup {
  key: string
  level: LogLevel
  /** The k6 `msg`, e.g. "Request Failed". */
  msg: string
  /** The normalised `error` (or the message itself when there is no error field). */
  detail: string
  count: number
  firstTs?: string
  lastTs?: string
  /** One original line, verbatim, for the tooltip. */
  sample: string
}

export interface LogActivity {
  /** Per-bucket counts of warnings and errors, `t` = bucket start (epoch ms). */
  buckets: Array<{ t: number; warning: number; error: number }>
  groups: LogGroup[]
  totals: { error: number; warning: number; info: number }
  bucketSecs: number
}

/**
 * Warnings and errors per time bucket, and the most frequent ones grouped.
 *
 * Only k6's own logfmt lines count (they carry `level=`): the end-of-test
 * summary and `console.log` output have no level and are not "errors" just
 * because they contain the word. Lines without a timestamp still group, but
 * cannot be placed in time.
 */
export function logActivity(
  lines: ReadonlyArray<{ ts?: string; text: string }>,
  opts: { bucketSecs?: number; maxGroups?: number; targetPoints?: number } = {},
): LogActivity {
  const totals = { error: 0, warning: 0, info: 0 }
  const groups = new Map<string, LogGroup>()
  const counts = new Map<number, { warning: number; error: number }>()
  const times: number[] = []
  const parsed: Array<{ t?: number; level: LogLevel }> = []

  for (const l of lines) {
    const level = k6LogLevel(l.text)
    if (!level) continue
    if (level === 'debug') continue
    totals[level === 'info' ? 'info' : level]++
    // Prefer kube's own timestamp, else k6's `time=`.
    const f = level === 'info' ? undefined : parseLogfmt(l.text)
    const tsRaw = l.ts ?? f?.time
    const t = tsRaw ? Date.parse(tsRaw) : NaN
    if (level === 'info') continue
    if (Number.isFinite(t)) times.push(t)
    parsed.push({ t: Number.isFinite(t) ? t : undefined, level })

    const msg = f?.msg ?? l.text
    const detail = normaliseMessage(f?.error ?? f?.msg ?? l.text)
    const key = `${level}|${msg}|${detail}`
    const g = groups.get(key)
    const ts = Number.isFinite(t) ? new Date(t).toISOString() : undefined
    if (g) {
      g.count++
      if (ts) g.lastTs = ts
    } else {
      groups.set(key, { key, level, msg, detail, count: 1, firstTs: ts, lastTs: ts, sample: l.text })
    }
  }

  // Bucket size from the span: ~1s for a short test, coarser for a soak, so a
  // chart gets a readable number of points (≤ ~180).
  const span = times.length ? (Math.max(...times) - Math.min(...times)) / 1000 : 0
  const bucketSecs = opts.bucketSecs ?? Math.max(1, Math.ceil(span / (opts.targetPoints ?? 180)))
  for (const p of parsed) {
    if (p.t === undefined) continue
    const b = Math.floor(p.t / 1000 / bucketSecs) * bucketSecs * 1000
    const c = counts.get(b) ?? { warning: 0, error: 0 }
    c[p.level === 'error' ? 'error' : 'warning']++
    counts.set(b, c)
  }
  // Fill empty buckets inside the span with zeros: a quiet second is a real
  // zero here (the stream covered it), not a missing sample.
  const keys = [...counts.keys()].sort((a, b) => a - b)
  const buckets: LogActivity['buckets'] = []
  if (keys.length) {
    for (let t = keys[0]; t <= keys[keys.length - 1]; t += bucketSecs * 1000) {
      const c = counts.get(t)
      buckets.push({ t, warning: c?.warning ?? 0, error: c?.error ?? 0 })
    }
  }

  return {
    buckets,
    groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, opts.maxGroups ?? 8),
    totals,
    bucketSecs,
  }
}

/* ─────────────────────────── Prometheus queries ─────────────────────────── */

/** Escape a value for a PromQL double-quoted string. */
export function promStr(v: string): string {
  return v.replace(/["\\]/g, '\\$&')
}

/** Regex-escape (then PromQL-escape) a literal for `=~`. */
export function promRegexLiteral(v: string): string {
  return promStr(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

/** Matches this run's runner pods only: `<run>-<n>-<suffix>`. */
export function runnerPodRegex(run: string): string {
  return `${promRegexLiteral(run)}-[0-9]+-.*`
}

export type LiveMetricId =
  | 'vus'
  | 'rps'
  | 'latency'
  | 'errors'
  | 'checks'
  | 'iterations'
  | 'data'
  | 'cpu'

export interface LiveQuery {
  /** Which chart this feeds. */
  chart: LiveMetricId
  /** Legend name for the series. */
  series: string
  query: string
  /** Multiply each sample by this (seconds → ms, ratio → %). */
  scale?: number
}

/**
 * The k6 remote-write series for one run. Durations arrive in SECONDS (the
 * output converts them) and rates as 0–1 ratios. Trend stats exist only for
 * the stats `K6_PROMETHEUS_RW_TREND_STATS` asked for, so a missing p99 is an
 * empty series, not a zero.
 */
export function k6RemoteQueries(run: string): LiveQuery[] {
  const sel = `testrun_name="${promStr(run)}"`
  const rate = (m: string) => `sum(rate(${m}{${sel}}[30s]))`
  return [
    { chart: 'vus', series: 'VUs', query: `sum(k6_vus{${sel}})` },
    { chart: 'vus', series: 'VUs max', query: `sum(k6_vus_max{${sel}})` },
    { chart: 'rps', series: 'requests/s', query: rate('k6_http_reqs_total') },
    { chart: 'latency', series: 'p50', query: `max(k6_http_req_duration_med{${sel}})`, scale: 1000 },
    { chart: 'latency', series: 'p90', query: `max(k6_http_req_duration_p90{${sel}})`, scale: 1000 },
    { chart: 'latency', series: 'p95', query: `max(k6_http_req_duration_p95{${sel}})`, scale: 1000 },
    { chart: 'latency', series: 'p99', query: `max(k6_http_req_duration_p99{${sel}})`, scale: 1000 },
    { chart: 'latency', series: 'avg', query: `max(k6_http_req_duration_avg{${sel}})`, scale: 1000 },
    { chart: 'errors', series: 'failed requests', query: `avg(k6_http_req_failed_rate{${sel}})`, scale: 100 },
    { chart: 'checks', series: 'checks passed', query: `avg(k6_checks_rate{${sel}})`, scale: 100 },
    { chart: 'iterations', series: 'iterations/s', query: rate('k6_iterations_total') },
    { chart: 'data', series: 'sent', query: rate('k6_data_sent_total') },
    { chart: 'data', series: 'received', query: rate('k6_data_received_total') },
  ]
}

/** cAdvisor's view of the runner pods: CPU and the bytes they push and pull. */
export function runnerResourceQueries(run: string, namespace: string): LiveQuery[] {
  const sel = `namespace="${promStr(namespace)}",pod=~"${runnerPodRegex(run)}"`
  return [
    { chart: 'data', series: 'sent', query: `sum(rate(container_network_transmit_bytes_total{${sel}}[1m]))` },
    { chart: 'data', series: 'received', query: `sum(rate(container_network_receive_bytes_total{${sel}}[1m]))` },
    { chart: 'cpu', series: 'runner CPU', query: `sum(rate(container_cpu_usage_seconds_total{${sel},container!="",container!="POD"}[1m]))` },
  ]
}

/** The `query_range` step for a window: ≥ 5s, ~150 points. */
export function stepFor(startMs: number, endMs: number, points = 150): number {
  return Math.max(5, Math.ceil((endMs - startMs) / 1000 / points))
}

/**
 * How often a running run's Prometheus window advances — the console-wide
 * poll floor. Range queries return the whole window at full resolution, so a
 * read a minute apart loses no samples; the second-by-second feel of a live
 * run comes from the pushed pod/TestRun watches and the runner log stream.
 */
export const LIVE_WINDOW_QUANTUM_MS = 60_000

/**
 * A live window: from the run's start to now, with the end rounded UP to the
 * step so the query key changes once per step rather than on every render —
 * the bug that refetched every panel on every 5-second TestRun poll.
 */
export function liveWindow(startMs: number | undefined, endMs: number | undefined, nowMs: number, quantumMs = 15_000) {
  if (startMs === undefined) return null
  const end = endMs ?? Math.ceil(nowMs / quantumMs) * quantumMs
  return { startMs, endMs: Math.max(end, startMs + 60_000) }
}

/* ─────────────────────────── thresholds, live ─────────────────────────── */

/**
 * Evaluate a k6 threshold expression (`p(95)<500`, `rate<0.01`, `avg<200`,
 * `count>100`) against a value. Undefined when the aggregation is not one this
 * value represents — the caller then shows "pending", never a guessed pass.
 */
export function evalThreshold(expression: string, values: Partial<Record<string, number>>): boolean | undefined {
  const m = /^\s*([a-z]+(?:\(\d+(?:\.\d+)?\))?)\s*(<=|>=|==|!=|<|>|===)\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(expression.replace(/['"]/g, ''))
  if (!m) return undefined
  const v = values[m[1].toLowerCase()]
  if (v === undefined || !Number.isFinite(v)) return undefined
  const rhs = Number(m[3])
  switch (m[2]) {
    case '<':
      return v < rhs
    case '<=':
      return v <= rhs
    case '>':
      return v > rhs
    case '>=':
      return v >= rhs
    case '==':
    case '===':
      return v === rhs
    case '!=':
      return v !== rhs
  }
  return undefined
}

/* ─────────────────────────── series shaping ─────────────────────────── */

export interface Sample {
  t: number
  v: number
}

/** The latest sample of a series, or undefined. */
export function lastValue(points: ReadonlyArray<Sample> | undefined): number | undefined {
  return points?.length ? points[points.length - 1].v : undefined
}

/** Peak of a series. */
export function peakValue(points: ReadonlyArray<Sample> | undefined): number | undefined {
  if (!points?.length) return undefined
  return points.reduce((m, p) => (p.v > m ? p.v : m), -Infinity)
}

/** `1234567` → `1.2 MB`. */
export function fmtBytes(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let i = 0
  let n = Math.abs(v)
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  return `${v < 0 ? '-' : ''}${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/** A compact number: `950`, `1.2k`, `3.4M`. */
export function fmtCount(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(0)}k`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 2 : 1)
}
