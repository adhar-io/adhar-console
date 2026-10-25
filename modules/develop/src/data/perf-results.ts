import { type K6Summary, parseK6Summary } from './k6-summary.ts'
import { LABEL_APPLICATION, LABEL_COMMIT, LABEL_MANAGED, LABEL_TEST } from './perf-format.ts'

/**
 * Durable run results — the history every trend, baseline and gate is built on.
 *
 * ---------------------------------------------------------------------------
 * WHY RESULTS NEED THEIR OWN HOME
 * ---------------------------------------------------------------------------
 * A k6 result only ever exists in a runner pod's stdout. The TestRun and its
 * pods are short-lived by design: they are cleaned up, garbage collected, or
 * deleted by whoever tidies the namespace. A number that disappears with the
 * pod cannot be trended, cannot be a baseline and cannot be compared next
 * month.
 *
 * So when a run finishes its end-of-test summary is HARVESTED into a small
 * ConfigMap — `k6-result-<run>` — labelled with the test, the commit and what
 * triggered it. The summary is stored as the text k6 printed, not as numbers
 * someone derived, so the same tested parser (`parseK6Summary`) reads it back
 * and nothing is lost in translation. The harvest is done by the adhar-controlplane
 * runner script for scheduled and CI runs, and by the console for runs it
 * launched itself.
 *
 * This module is pure: parsing, unit conversion and aggregation only.
 */

/* ─────────────────────────── labels ─────────────────────────── */

export const LABEL_RESULT = 'adhar.io/perf-result'
export const LABEL_TRIGGER = 'adhar.io/perf-trigger'
/** Name of the schedule (CronJob) that produced a run; also marks schedules. */
export const LABEL_SCHEDULE = 'adhar.io/perf-schedule'
/** `job` when the adhar-controlplane runner script owns the run and its harvest. */
export const LABEL_RUNNER = 'adhar.io/perf-runner'

export const ANN_RUN = 'adhar.io/perf-run'
export const ANN_STARTED = 'adhar.io/perf-started'
export const ANN_FINISHED = 'adhar.io/perf-finished'
export const ANN_STAGE = 'adhar.io/perf-stage'
export const ANN_EXIT = 'adhar.io/perf-exit-code'
export const ANN_VERDICT = 'adhar.io/perf-verdict'
export const ANN_REASONS = 'adhar.io/perf-verdict-reasons'
export const ANN_PARALLELISM = 'adhar.io/perf-parallelism'
/** Stamped on a TestRun once its summary has been copied out. */
export const ANN_HARVESTED = 'adhar.io/perf-harvested'

export const SUMMARY_KEY = 'summary.txt'
/** Separates one runner's summary from the next inside `summary.txt`. */
export const RUNNER_MARK = '=== adhar-perf runner'

export type Trigger = 'console' | 'schedule' | 'ci' | 'manual'

export const resultConfigMapName = (run: string) => `k6-result-${run}`.slice(0, 253)

/* ─────────────────────────── unit parsing ─────────────────────────── */

/**
 * k6 duration → milliseconds. k6 prints `148.21ms`, `1.02s`, `999µs`,
 * `1m2.3s` and `1h2m3s` depending on magnitude, so a single unit regex is
 * not enough: the components are summed.
 */
export function parseDurationMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const s = raw.trim()
  const re = /(\d+(?:\.\d+)?)(ms|µs|μs|us|ns|h|m|s)/gy
  let total = 0
  let matched = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const n = Number(m[1])
    switch (m[2]) {
      case 'h':
        total += n * 3_600_000
        break
      case 'm':
        total += n * 60_000
        break
      case 's':
        total += n * 1000
        break
      case 'ms':
        total += n
        break
      case 'ns':
        total += n / 1e6
        break
      default:
        total += n / 1000
    }
    matched = re.lastIndex
  }
  if (!matched || matched !== s.length) {
    // A bare number is k6's way of printing zero (`0s` aside) for some outputs.
    const bare = Number(s)
    return Number.isFinite(bare) && s !== '' ? bare : undefined
  }
  return total
}

/** `1.00%` → 1. */
export function parsePercent(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)%$/)
  return m ? Number(m[1]) : undefined
}

/** First bare number on a counter line: `1482   49.06/s` → 1482. */
function leadingNumber(raw: string): number | undefined {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)(?:\s|$)/)
  return m ? Number(m[1]) : undefined
}

/** The `/s` token on a counter line: `1482   49.06/s` → 49.06. */
function perSecond(raw: string): number | undefined {
  const m = raw.match(/(\d+(?:\.\d+)?)\/s\b/)
  return m ? Number(m[1]) : undefined
}

/* ─────────────────────────── headline metrics ─────────────────────────── */

/**
 * The numbers a performance verdict is made of. Every field is optional: a
 * test that makes no HTTP calls has no latency, and k6 only prints `p(99)`
 * when the script asks for it in `summaryTrendStats`. Absent means "not
 * measured", never zero.
 */
export interface RunMetrics {
  avgMs?: number
  medMs?: number
  p90Ms?: number
  p95Ms?: number
  p99Ms?: number
  maxMs?: number
  /** Failed HTTP requests as a percentage, 0–100. */
  errorRatePct?: number
  /** Requests per second. */
  rps?: number
  requests?: number
  iterations?: number
  vusMax?: number
  /** Checks passed as a percentage, 0–100. */
  checksPct?: number
  thresholdsPassed: number
  thresholdsFailed: number
}

export type MetricKey = 'p95Ms' | 'p99Ms' | 'avgMs' | 'medMs' | 'errorRatePct' | 'rps' | 'checksPct'

export interface MetricDef {
  key: MetricKey
  label: string
  unit: 'ms' | '%' | '/s'
  /** Whether a smaller number is the better one. */
  lowerIsBetter: boolean
}

export const METRIC_DEFS: MetricDef[] = [
  { key: 'p95Ms', label: 'p95 latency', unit: 'ms', lowerIsBetter: true },
  { key: 'p99Ms', label: 'p99 latency', unit: 'ms', lowerIsBetter: true },
  { key: 'avgMs', label: 'Average latency', unit: 'ms', lowerIsBetter: true },
  { key: 'medMs', label: 'Median latency', unit: 'ms', lowerIsBetter: true },
  { key: 'errorRatePct', label: 'Error rate', unit: '%', lowerIsBetter: true },
  { key: 'rps', label: 'Throughput', unit: '/s', lowerIsBetter: false },
  { key: 'checksPct', label: 'Checks passed', unit: '%', lowerIsBetter: false },
]

export function metricDef(key: MetricKey): MetricDef {
  return METRIC_DEFS.find((d) => d.key === key)!
}

export function metricsFromSummary(summary: K6Summary): RunMetrics {
  const find = (name: string) => summary.metrics.find((m) => m.name === name)
  const dur = find('http_req_duration')
  const failed = find('http_req_failed')
  const reqs = find('http_reqs')
  const iters = find('iterations')
  const vusMax = find('vus_max')

  const out: RunMetrics = {
    thresholdsPassed: summary.thresholds.filter((t) => t.passed).length,
    thresholdsFailed: summary.thresholds.filter((t) => !t.passed).length,
  }
  if (dur) {
    const pct = (target: number): string | undefined => {
      const exact = dur.values[`p(${target})`]
      if (exact) return exact
      for (const [k, v] of Object.entries(dur.values)) {
        const m = /^p\((\d+(?:\.\d+)?)\)$/i.exec(k)
        if (!m) continue
        const n = Number(m[1])
        if (Number.isFinite(n) && Math.abs(n - target) < 0.0001) return v
      }
      return undefined
    }
    out.avgMs = parseDurationMs(dur.values['avg'])
    out.medMs = parseDurationMs(dur.values['med'])
    out.p90Ms = parseDurationMs(pct(90))
    out.p95Ms = parseDurationMs(pct(95))
    out.p99Ms = parseDurationMs(pct(99))
    out.maxMs = parseDurationMs(dur.values['max'])
  }
  if (failed) out.errorRatePct = parsePercent(failed.raw.split(/\s+/)[0])
  if (reqs) {
    out.requests = leadingNumber(reqs.raw)
    out.rps = perSecond(reqs.raw)
  }
  if (iters) out.iterations = leadingNumber(iters.raw)
  if (vusMax) out.vusMax = leadingNumber(vusMax.raw)
  if (summary.checks) {
    const total = summary.checks.passed + summary.checks.failed
    if (total > 0) out.checksPct = (summary.checks.passed / total) * 100
  }
  return stripUndefined(out)
}

function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k]
  return o
}

/**
 * Combine the summaries of several runners into one result.
 *
 * With `parallelism > 1` every runner prints its own summary for its slice
 * of the load. Throughput and counts add up; the error rate is weighted by
 * each slice's request count; latency percentiles cannot be merged exactly
 * without the raw samples, so the WORST runner's percentile is taken — the
 * conservative choice for a gate, and the one the runner script makes too.
 */
export function aggregateMetrics(parts: RunMetrics[]): RunMetrics {
  if (parts.length === 0) return { thresholdsPassed: 0, thresholdsFailed: 0 }
  if (parts.length === 1) return parts[0]

  const max = (k: keyof RunMetrics) => {
    const vs = parts.map((p) => p[k]).filter((v): v is number => typeof v === 'number')
    return vs.length ? Math.max(...vs) : undefined
  }
  const sum = (k: keyof RunMetrics) => {
    const vs = parts.map((p) => p[k]).filter((v): v is number => typeof v === 'number')
    return vs.length ? vs.reduce((a, b) => a + b, 0) : undefined
  }
  const weighted = (k: keyof RunMetrics) => {
    let num = 0
    let den = 0
    let unweighted = 0
    let n = 0
    for (const p of parts) {
      const v = p[k]
      if (typeof v !== 'number') continue
      const w = p.requests ?? 0
      num += v * w
      den += w
      unweighted += v
      n++
    }
    if (!n) return undefined
    return den > 0 ? num / den : unweighted / n
  }

  return stripUndefined({
    avgMs: weighted('avgMs'),
    medMs: max('medMs'),
    p90Ms: max('p90Ms'),
    p95Ms: max('p95Ms'),
    p99Ms: max('p99Ms'),
    maxMs: max('maxMs'),
    errorRatePct: weighted('errorRatePct'),
    rps: sum('rps'),
    requests: sum('requests'),
    iterations: sum('iterations'),
    vusMax: sum('vusMax'),
    checksPct: weighted('checksPct'),
    thresholdsPassed: Math.min(...parts.map((p) => p.thresholdsPassed)),
    thresholdsFailed: Math.max(...parts.map((p) => p.thresholdsFailed)),
  })
}

/* ─────────────────────────── summary text ─────────────────────────── */

/** A k6 progress line — `running (…)`, `default [ 33% ]`, `default ✓ [=====]`. */
const PROGRESS = /running \(|\[ *\d+%|\[=/

/**
 * Keep only what follows k6's last progress line: the end-of-test summary.
 *
 * The runner script does exactly this with awk, so a summary harvested by
 * the console and one harvested adhar-controlplane are byte-for-byte comparable.
 */
export function extractSummary(log: string): string {
  const lines = log.split('\n')
  let last = -1
  for (let i = 0; i < lines.length; i++) if (PROGRESS.test(lines[i])) last = i
  let from = last + 1
  if (last < 0) {
    // A `--quiet` runner (every console-launched run) prints no progress
    // lines, so "after the last one" was the WHOLE log — every logged
    // request failure went into the result ConfigMap (355 kB for a two-minute
    // run; a long one would pass the 1 MiB object limit and the harvest would
    // fail). Start at the summary instead: k6 v1's first `█` section, or the
    // first summary metric line for older versions.
    const v1 = lines.findIndex((l) => SUMMARY_SECTION.test(l))
    const legacy = lines.findIndex((l) => LEGACY_METRIC.test(l))
    const start = v1 >= 0 ? v1 : legacy
    if (start >= 0) {
      // Older k6 prints the check results (`✓ status is 200`) just above the
      // metrics; keep that block with them.
      from = start
      while (v1 < 0 && from > 0 && (/^\s*[✓✗×√]\s/.test(lines[from - 1]) || !lines[from - 1].trim())) from--
    }
  }
  // Request-failure log lines can still interleave with the summary as
  // stdout and stderr are merged; they are not part of it.
  const kept = lines.slice(from).filter((l) => !LOG_LINE.test(l) || /level=error/.test(l))
  return kept.join('\n').replace(/\s+$/, '') + '\n'
}

/** k6 v1's summary sections: `  █ THRESHOLDS`, `  █ TOTAL RESULTS`. */
const SUMMARY_SECTION = /^\s*█\s+[A-Z]/
/** A pre-v1 summary metric line: `     checks.....: 99.00% ✓ 2934 ✗ 30`. */
const LEGACY_METRIC = /^\s*[a-z_]+\.{3,}:\s/
/** A k6 logfmt line — `time="…" level=warning msg="Request Failed" …`. */
const LOG_LINE = /^time="[^"]*"\s+level=/

/** Join several runners' summaries into one `summary.txt`. */
export function joinRunnerSummaries(parts: Array<{ pod: string; summary: string }>): string {
  return parts.map((p) => `${RUNNER_MARK} ${p.pod} ===\n${p.summary}`).join('')
}

/** Split `summary.txt` back into one block per runner. */
export function splitRunnerSummaries(text: string): string[] {
  if (!text.includes(RUNNER_MARK)) return text.trim() ? [text] : []
  return text.split(new RegExp(`^${RUNNER_MARK}.*$`, 'm')).map((s) => s.trim()).filter(Boolean)
}

/** Parse a stored `summary.txt` into combined metrics plus the first runner's full summary. */
export function readStoredSummary(text: string): { metrics?: RunMetrics; summary?: K6Summary; runners: number } {
  const blocks = splitRunnerSummaries(text)
  const parsed = blocks.map(parseK6Summary).filter((s) => s.complete)
  if (!parsed.length) return { runners: blocks.length }
  return {
    metrics: aggregateMetrics(parsed.map(metricsFromSummary)),
    summary: parsed[0],
    runners: parsed.length,
  }
}

/* ─────────────────────────── records ─────────────────────────── */

export interface RunRecord {
  /** The TestRun name — unique per run. */
  run: string
  test: string
  namespace: string
  /** Name of the result ConfigMap. */
  resultName: string
  startedAt?: string
  finishedAt?: string
  /** Final operator stage: finished, error, stopped or timeout. */
  stage?: string
  trigger: Trigger
  schedule?: string
  commit?: string
  /** Highest non-zero runner exit code; 99 is k6's "thresholds crossed". */
  exitCode?: number
  /** The application the test drives (`adhar.io/application`), when known. */
  application?: string
  /** Verdict the runner script recorded when the run finished, if any. */
  recordedVerdict?: 'pass' | 'fail'
  recordedReasons?: string
  parallelism?: number
  metrics?: RunMetrics
  summary?: K6Summary
  runners: number
}

interface ConfigMapLike {
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  data?: Record<string, string>
}

const TRIGGERS: Trigger[] = ['console', 'schedule', 'ci', 'manual']

export function recordFromConfigMap(cm: ConfigMapLike): RunRecord | null {
  const labels = cm.metadata.labels ?? {}
  const ann = cm.metadata.annotations ?? {}
  const test = labels[LABEL_TEST]
  if (!test || labels[LABEL_RESULT] !== 'true') return null
  const trigger = TRIGGERS.includes(labels[LABEL_TRIGGER] as Trigger) ? labels[LABEL_TRIGGER] as Trigger : 'console'
  const stored = readStoredSummary(cm.data?.[SUMMARY_KEY] ?? '')
  const exit = Number(ann[ANN_EXIT])
  const par = Number(ann[ANN_PARALLELISM])
  const verdict = ann[ANN_VERDICT]
  const run = ann[ANN_RUN] || cm.metadata.name.replace(/^k6-result-/, '')
  return {
    run,
    test,
    namespace: cm.metadata.namespace ?? 'default',
    resultName: cm.metadata.name,
    startedAt: ann[ANN_STARTED] || cm.metadata.creationTimestamp,
    finishedAt: ann[ANN_FINISHED] || cm.metadata.creationTimestamp,
    stage: ann[ANN_STAGE] || undefined,
    trigger,
    schedule: labels[LABEL_SCHEDULE] || undefined,
    commit: labels[LABEL_COMMIT] || undefined,
    application: labels[LABEL_APPLICATION] || undefined,
    exitCode: ann[ANN_EXIT] !== undefined && ann[ANN_EXIT] !== '' && Number.isFinite(exit) ? exit : undefined,
    recordedVerdict: verdict === 'pass' || verdict === 'fail' ? verdict : undefined,
    recordedReasons: ann[ANN_REASONS] || undefined,
    parallelism: Number.isFinite(par) && par > 0 ? par : undefined,
    metrics: stored.metrics,
    summary: stored.summary,
    runners: stored.runners,
  }
}

/** Newest first, by when the run started. */
export function sortRecords(records: RunRecord[]): RunRecord[] {
  return [...records].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
}

/**
 * The result ConfigMap the console writes for a run it launched itself —
 * the same shape the runner script creates with kubectl.
 */
export function resultConfigMap(input: {
  run: string
  test: string
  namespace: string
  summaryText: string
  trigger: Trigger
  commit?: string
  startedAt?: string
  finishedAt?: string
  stage?: string
  exitCode?: number
  parallelism?: number
  application?: string
  /** The gate's verdict, as the adhar-controlplane runner records it. */
  verdict?: 'pass' | 'fail'
  reasons?: string
}) {
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: 'adhar-console',
    [LABEL_RESULT]: 'true',
    [LABEL_TEST]: input.test,
    [LABEL_TRIGGER]: input.trigger,
  }
  if (input.commit) labels[LABEL_COMMIT] = input.commit.slice(0, 63)
  if (input.application) labels[LABEL_APPLICATION] = input.application
  const annotations: Record<string, string> = { [ANN_RUN]: input.run }
  if (input.startedAt) annotations[ANN_STARTED] = input.startedAt
  if (input.finishedAt) annotations[ANN_FINISHED] = input.finishedAt
  if (input.stage) annotations[ANN_STAGE] = input.stage
  if (input.exitCode !== undefined) annotations[ANN_EXIT] = String(input.exitCode)
  if (input.parallelism) annotations[ANN_PARALLELISM] = String(input.parallelism)
  if (input.verdict) annotations[ANN_VERDICT] = input.verdict
  if (input.reasons) annotations[ANN_REASONS] = input.reasons
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: resultConfigMapName(input.run), namespace: input.namespace, labels, annotations },
    data: { [SUMMARY_KEY]: input.summaryText },
  }
}

/* ─────────────────────────── formatting ─────────────────────────── */

export function fmtMetric(key: MetricKey, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  const unit = metricDef(key).unit
  if (unit === 'ms') return fmtMs(v)
  if (unit === '%') return `${v < 10 ? v.toFixed(2) : v.toFixed(1)}%`
  return `${v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString()}/s`
}

export function fmtMs(v: number): string {
  if (v === 0) return '0ms'
  if (v >= 60_000) return `${(v / 60_000).toFixed(1)}m`
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`
  if (v >= 10) return `${Math.round(v)}ms`
  if (v >= 1) return `${v.toFixed(1)}ms`
  return `${(v * 1000).toFixed(0)}µs`
}
