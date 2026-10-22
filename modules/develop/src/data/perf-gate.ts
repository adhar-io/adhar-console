import { fmtMetric, metricDef, type MetricKey, type RunMetrics, type RunRecord } from './perf-results.ts'

/**
 * Performance gates, baselines and regression detection.
 *
 * ---------------------------------------------------------------------------
 * THREE QUESTIONS, ONE VERDICT
 * ---------------------------------------------------------------------------
 *   1. Did the script's own thresholds hold?  (k6 decides; exit code 99)
 *   2. Is it inside the budget?                (absolute SLOs: p95 < X ms…)
 *   3. Is it worse than the run we trust?      (relative: vs the baseline)
 *
 * The script answers the first and nothing else. Budgets and baselines live
 * in the test's `test.json` in git — beside the script, reviewed like it, and
 * versioned with it — so "who loosened the p95 budget, and when" has an
 * answer. The console, the in-cluster runner script and the CI step all read
 * the same numbers.
 *
 * Every function here is pure and mirrored by the awk in the runner script;
 * the tests pin the rules so the two cannot quietly drift apart.
 */

export interface Tolerance {
  /** Latency may grow by this percentage before it is a regression. */
  latencyPct: number
  /** Error rate may grow by this many percentage POINTS. */
  errorRatePts: number
  /** Throughput may drop by this percentage before it is a regression. */
  throughputPct: number
}

export const DEFAULT_TOLERANCE: Tolerance = { latencyPct: 10, errorRatePts: 0.5, throughputPct: 10 }

export interface PerfGate {
  p95Ms?: number
  p99Ms?: number
  avgMs?: number
  /** Maximum error rate, percent. */
  errorRatePct?: number
  /** Minimum throughput, requests per second. */
  minRps?: number
  /** The script's own thresholds must pass. */
  requireThresholds: boolean
  /** A regression against the baseline fails the gate. */
  failOnRegression: boolean
  tolerance: Tolerance
}

export const DEFAULT_GATE: PerfGate = {
  requireThresholds: true,
  failOnRegression: false,
  tolerance: DEFAULT_TOLERANCE,
}

/** The headline numbers of the pinned run, copied so the baseline outlives its result. */
export interface BaselineMetrics {
  p95Ms?: number
  p99Ms?: number
  avgMs?: number
  errorRatePct?: number
  rps?: number
}

export interface PerfBaseline {
  run: string
  namespace?: string
  pinnedAt: string
  pinnedBy?: string
  commit?: string
  metrics: BaselineMetrics
}

/* ─────────────────────────── parsing ─────────────────────────── */

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k]
  return o
}

/** Read `gate` from test.json. Anything unusable is dropped, never thrown. */
export function parseGate(v: unknown): PerfGate | undefined {
  const o = obj(v)
  if (!o) return undefined
  const tol = obj(o.tolerance) ?? {}
  return clean({
    p95Ms: num(o.p95Ms),
    p99Ms: num(o.p99Ms),
    avgMs: num(o.avgMs),
    errorRatePct: num(o.errorRatePct),
    minRps: num(o.minRps),
    requireThresholds: o.requireThresholds !== false,
    failOnRegression: o.failOnRegression === true,
    tolerance: {
      latencyPct: num(tol.latencyPct) ?? DEFAULT_TOLERANCE.latencyPct,
      errorRatePts: num(tol.errorRatePts) ?? DEFAULT_TOLERANCE.errorRatePts,
      throughputPct: num(tol.throughputPct) ?? DEFAULT_TOLERANCE.throughputPct,
    },
  })
}

export function parseBaseline(v: unknown): PerfBaseline | undefined {
  const o = obj(v)
  const run = str(o?.run)
  if (!o || !run) return undefined
  const m = obj(o.metrics) ?? {}
  return clean({
    run,
    namespace: str(o.namespace),
    pinnedAt: str(o.pinnedAt) ?? '',
    pinnedBy: str(o.pinnedBy),
    commit: str(o.commit),
    metrics: clean({
      p95Ms: num(m.p95Ms),
      p99Ms: num(m.p99Ms),
      avgMs: num(m.avgMs),
      errorRatePct: num(m.errorRatePct),
      rps: num(m.rps),
    }),
  })
}

/** Stable key order, for readable diffs in git. */
export function serialiseGate(g: PerfGate): Record<string, unknown> {
  return clean({
    p95Ms: g.p95Ms,
    p99Ms: g.p99Ms,
    avgMs: g.avgMs,
    errorRatePct: g.errorRatePct,
    minRps: g.minRps,
    requireThresholds: g.requireThresholds,
    failOnRegression: g.failOnRegression,
    tolerance: {
      latencyPct: g.tolerance.latencyPct,
      errorRatePts: g.tolerance.errorRatePts,
      throughputPct: g.tolerance.throughputPct,
    },
  })
}

export function serialiseBaseline(b: PerfBaseline): Record<string, unknown> {
  return clean({
    run: b.run,
    namespace: b.namespace,
    pinnedAt: b.pinnedAt,
    pinnedBy: b.pinnedBy,
    commit: b.commit,
    metrics: clean({ ...b.metrics }),
  })
}

/** Snapshot a run's numbers as the baseline. */
export function baselineFromRecord(r: RunRecord, pinnedAt: string, pinnedBy?: string): PerfBaseline {
  const m = r.metrics ?? { thresholdsPassed: 0, thresholdsFailed: 0 }
  return clean({
    run: r.run,
    namespace: r.namespace,
    pinnedAt,
    pinnedBy,
    commit: r.commit,
    metrics: clean({
      p95Ms: m.p95Ms,
      p99Ms: m.p99Ms,
      avgMs: m.avgMs,
      errorRatePct: m.errorRatePct,
      rps: m.rps,
    }),
  })
}

/* ─────────────────────────── regression ─────────────────────────── */

export interface MetricDelta {
  key: MetricKey
  label: string
  current?: number
  baseline?: number
  /** current − baseline, in the metric's unit. */
  delta?: number
  /** Relative change in percent; undefined when the baseline is zero. */
  deltaPct?: number
  regressed: boolean
  improved: boolean
  /** The limit the current value was held to, for the explanation. */
  limit?: number
}

const COMPARED: MetricKey[] = ['p95Ms', 'p99Ms', 'avgMs', 'errorRatePct', 'rps']

/**
 * Compare a run against the baseline.
 *
 *   latency      regressed when current > baseline × (1 + latencyPct/100)
 *   error rate   regressed when current > baseline + errorRatePts
 *   throughput   regressed when current < baseline × (1 − throughputPct/100)
 *
 * The error rate is compared in absolute points because a relative rule is
 * useless near zero: 0.01% → 0.02% is "+100%" and means nothing.
 */
export function compareToBaseline(
  current: RunMetrics | undefined,
  baseline: BaselineMetrics | undefined,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
): MetricDelta[] {
  return COMPARED.map((key) => {
    const cur = current?.[key] as number | undefined
    const base = baseline?.[key as keyof BaselineMetrics]
    const def = metricDef(key)
    const out: MetricDelta = { key, label: def.label, current: cur, baseline: base, regressed: false, improved: false }
    if (cur === undefined || base === undefined) return out
    out.delta = cur - base
    out.deltaPct = base !== 0 ? ((cur - base) / base) * 100 : undefined
    if (key === 'errorRatePct') {
      out.limit = base + tolerance.errorRatePts
      out.regressed = cur > out.limit
      out.improved = cur < base - tolerance.errorRatePts
    } else if (key === 'rps') {
      out.limit = base * (1 - tolerance.throughputPct / 100)
      out.regressed = cur < out.limit
      out.improved = cur > base * (1 + tolerance.throughputPct / 100)
    } else {
      out.limit = base * (1 + tolerance.latencyPct / 100)
      out.regressed = cur > out.limit
      out.improved = cur < base * (1 - tolerance.latencyPct / 100)
    }
    return out
  })
}

export function regressions(deltas: MetricDelta[]): MetricDelta[] {
  return deltas.filter((d) => d.regressed)
}

/* ─────────────────────────── the gate ─────────────────────────── */

export interface GateCheck {
  id: string
  label: string
  passed: boolean
  /** One-line explanation, e.g. `p95 241ms ≤ 500ms`. */
  detail: string
}

export type VerdictStatus = 'pass' | 'fail' | 'no-data'

export interface GateVerdict {
  status: VerdictStatus
  checks: GateCheck[]
  /** Regressions against the baseline, whether or not they fail the gate. */
  regressions: MetricDelta[]
  /** Failed checks, for the one-line summary. */
  failures: GateCheck[]
}

/**
 * The verdict on one run.
 *
 * A limit on a metric the run did not report FAILS: a gate that passes
 * because the number it guards was never measured is not a gate. The UI
 * says why (e.g. p99 needs `summaryTrendStats`), the runner script does
 * the same.
 */
export function evaluateGate(input: {
  metrics?: RunMetrics
  stage?: string
  exitCode?: number
  gate?: PerfGate
  baseline?: PerfBaseline
}): GateVerdict {
  const gate = input.gate ?? DEFAULT_GATE
  const checks: GateCheck[] = []
  const m = input.metrics

  if (input.stage && input.stage !== 'finished') {
    checks.push({
      id: 'completed',
      label: `Run ${input.stage}`,
      passed: false,
      detail: `the run ended in stage “${input.stage}”`,
    })
  }

  if (!m) {
    return {
      status: checks.length ? 'fail' : 'no-data',
      checks,
      regressions: [],
      failures: checks.filter((c) => !c.passed),
    }
  }

  if (gate.requireThresholds) {
    const crossed = m.thresholdsFailed > 0 || input.exitCode === 99
    const total = m.thresholdsPassed + m.thresholdsFailed
    checks.push({
      id: 'thresholds',
      label: 'Script thresholds',
      passed: !crossed,
      detail: crossed
        ? `${m.thresholdsFailed || 'some'} threshold${m.thresholdsFailed === 1 ? '' : 's'} crossed`
        : total
        ? `${total} threshold${total === 1 ? '' : 's'} held`
        : 'no thresholds declared',
    })
  }

  const ceiling = (id: string, key: MetricKey, limit: number | undefined, hint?: string) => {
    if (limit === undefined) return
    const v = m[key] as number | undefined
    const label = `${metricDef(key).label} ≤ ${fmtMetric(key, limit)}`
    if (v === undefined) {
      checks.push({ id, label, passed: false, detail: `not reported by this run${hint ? ` — ${hint}` : ''}` })
      return
    }
    checks.push({ id, label, passed: v <= limit, detail: `${fmtMetric(key, v)} vs ${fmtMetric(key, limit)}` })
  }
  ceiling('p95', 'p95Ms', gate.p95Ms)
  ceiling('p99', 'p99Ms', gate.p99Ms, 'add "p(99)" to summaryTrendStats in the script options')
  ceiling('avg', 'avgMs', gate.avgMs)
  ceiling('errors', 'errorRatePct', gate.errorRatePct)

  if (gate.minRps !== undefined) {
    const label = `Throughput ≥ ${fmtMetric('rps', gate.minRps)}`
    checks.push(
      m.rps === undefined
        ? { id: 'rps', label, passed: false, detail: 'not reported by this run' }
        : { id: 'rps', label, passed: m.rps >= gate.minRps, detail: `${fmtMetric('rps', m.rps)} vs ${fmtMetric('rps', gate.minRps)}` },
    )
  }

  const deltas = input.baseline ? compareToBaseline(m, input.baseline.metrics, gate.tolerance) : []
  const regressed = regressions(deltas)
  if (gate.failOnRegression && input.baseline) {
    checks.push({
      id: 'regression',
      label: 'No regression vs baseline',
      passed: regressed.length === 0,
      detail: regressed.length
        ? regressed.map((d) => `${d.label} ${fmtMetric(d.key, d.current)} vs ${fmtMetric(d.key, d.baseline)}`).join('; ')
        : `within tolerance of ${input.baseline.run}`,
    })
  }

  const failures = checks.filter((c) => !c.passed)
  return { status: failures.length ? 'fail' : 'pass', checks, regressions: regressed, failures }
}

/** True when the gate has any criterion beyond the script's thresholds. */
export function hasBudget(g: PerfGate | undefined): boolean {
  return Boolean(
    g && (g.p95Ms !== undefined || g.p99Ms !== undefined || g.avgMs !== undefined ||
      g.errorRatePct !== undefined || g.minRps !== undefined || g.failOnRegression),
  )
}

/* ─────────────────────────── gate.env ─────────────────────────── */

/** Only digits and a dot reach the shell — the file is sourced. */
function shNum(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return ''
  return String(Math.round(v * 1000) / 1000)
}

function shWord(v: string | undefined): string {
  return (v ?? '').replace(/[^A-Za-z0-9._-]/g, '')
}

/**
 * The gate as a sourceable env file, read by the in-cluster runner script.
 *
 * Generated rather than hand-written so the console, the CronJob and the CI
 * step evaluate the same numbers. Values are reduced to numbers and safe
 * words before they are written, because the runner `.`-sources this file.
 */
export function gateEnv(input: {
  test: string
  namespace: string
  commit?: string
  gate?: PerfGate
  baseline?: PerfBaseline
  /** The application the test drives, for the result's label. */
  application?: string
}): string {
  const g = input.gate ?? DEFAULT_GATE
  const b = input.baseline
  const lines: Array<[string, string]> = [
    ['PERF_TEST', shWord(input.test)],
    ['PERF_NAMESPACE', shWord(input.namespace)],
    ['PERF_COMMIT', shWord(input.commit).slice(0, 40)],
    ['TARGET_APP', shWord(input.application)],
    ['GATE_P95_MS', shNum(g.p95Ms)],
    ['GATE_P99_MS', shNum(g.p99Ms)],
    ['GATE_AVG_MS', shNum(g.avgMs)],
    ['GATE_ERROR_PCT', shNum(g.errorRatePct)],
    ['GATE_MIN_RPS', shNum(g.minRps)],
    ['GATE_REQUIRE_THRESHOLDS', g.requireThresholds ? 'true' : 'false'],
    ['GATE_FAIL_ON_REGRESSION', g.failOnRegression && b ? 'true' : 'false'],
    ['TOL_LATENCY_PCT', shNum(g.tolerance.latencyPct)],
    ['TOL_ERROR_PTS', shNum(g.tolerance.errorRatePts)],
    ['TOL_RPS_PCT', shNum(g.tolerance.throughputPct)],
    ['BASE_RUN', shWord(b?.run)],
    ['BASE_P95_MS', shNum(b?.metrics.p95Ms)],
    ['BASE_P99_MS', shNum(b?.metrics.p99Ms)],
    ['BASE_AVG_MS', shNum(b?.metrics.avgMs)],
    ['BASE_ERROR_PCT', shNum(b?.metrics.errorRatePct)],
    ['BASE_RPS', shNum(b?.metrics.rps)],
  ]
  return `# Generated by the Adhar console from the test.json of ${shWord(input.test)} in its application repo — edit the test, not this file.\n` +
    lines.map(([k, v]) => `${k}='${v}'`).join('\n') + '\n'
}

/**
 * The gate (and baseline) back out of a `gate.env` — the inverse of gateEnv.
 *
 * The console records the result of a run it launched itself, and that record
 * must carry the same verdict the in-cluster runner would have written: the
 * platform scorer reads only the recorded verdict and never re-judges a run.
 * The env file in the test's artefact is the one copy of the gate the console,
 * the CronJob and CI all evaluate, so the verdict is computed from it.
 */
export function gateFromEnv(text: string): { gate: PerfGate; baseline?: PerfBaseline } {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)='([^']*)'$/)
    if (m) env[m[1]] = m[2]
  }
  const n = (k: string) => num(env[k])
  // Unset limits are left out, as a parsed test.json leaves them.
  const limits = Object.fromEntries(
    ([['p95Ms', 'GATE_P95_MS'], ['p99Ms', 'GATE_P99_MS'], ['avgMs', 'GATE_AVG_MS'], ['errorRatePct', 'GATE_ERROR_PCT'], [
      'minRps',
      'GATE_MIN_RPS',
    ]] as const)
      .map(([key, envKey]) => [key, n(envKey)] as const)
      .filter(([, v]) => v !== undefined),
  ) as Pick<PerfGate, 'p95Ms' | 'p99Ms' | 'avgMs' | 'errorRatePct' | 'minRps'>
  const gate: PerfGate = {
    ...limits,
    requireThresholds: (env.GATE_REQUIRE_THRESHOLDS ?? 'true') === 'true',
    failOnRegression: env.GATE_FAIL_ON_REGRESSION === 'true',
    tolerance: {
      latencyPct: n('TOL_LATENCY_PCT') ?? DEFAULT_TOLERANCE.latencyPct,
      errorRatePts: n('TOL_ERROR_PTS') ?? DEFAULT_TOLERANCE.errorRatePts,
      throughputPct: n('TOL_RPS_PCT') ?? DEFAULT_TOLERANCE.throughputPct,
    },
  }
  const baseline: PerfBaseline | undefined = env.BASE_RUN
    ? {
      run: env.BASE_RUN,
      pinnedAt: '',
      metrics: {
        p95Ms: n('BASE_P95_MS'),
        p99Ms: n('BASE_P99_MS'),
        avgMs: n('BASE_AVG_MS'),
        errorRatePct: n('BASE_ERROR_PCT'),
        rps: n('BASE_RPS'),
      },
    }
    : undefined
  return { gate, ...(baseline ? { baseline } : {}) }
}

/**
 * The verdict to RECORD for a finished run, judged exactly as the in-cluster
 * runner judges one (perf-runner.ts, step 6): a run that did not finish, or
 * left no end-of-test summary, fails; otherwise the gate decides.
 *
 * Console-launched runs used to be recorded with no verdict at all, and the
 * platform scorer — which reads only what was recorded — counted "no verdict
 * recorded" against the application (my-service, 2026-10-22: a passing run,
 * exit code 0, still held its grade back).
 */
export function recordedVerdict(
  r: Pick<RunRecord, 'metrics' | 'stage' | 'exitCode'>,
  gateEnvText: string | undefined,
): { verdict: 'pass' | 'fail'; reasons: string } {
  const { gate, baseline } = gateFromEnv(gateEnvText ?? '')
  if (r.stage && r.stage !== 'finished') return { verdict: 'fail', reasons: `run ended in stage ${r.stage}` }
  const v = evaluateGate({ metrics: r.metrics, stage: r.stage, exitCode: r.exitCode, gate, baseline })
  if (v.status === 'no-data') return { verdict: 'fail', reasons: 'no end-of-test summary was found' }
  return { verdict: v.status, reasons: v.failures.map((c) => c.detail).join('; ') }
}

/* ─────────────────────────── comparison ─────────────────────────── */

export interface ComparisonRow {
  key: MetricKey
  label: string
  values: Array<number | undefined>
  /** Change vs the first (reference) run, percent; undefined for the reference. */
  deltasPct: Array<number | undefined>
  /** Index of the best value, when there is more than one to compare. */
  best?: number
  worst?: number
}

/**
 * Side-by-side comparison of two or more runs. The first run is the
 * reference every delta is measured from — the UI lets the user choose it.
 */
export function compareRuns(metrics: Array<RunMetrics | undefined>, keys: MetricKey[]): ComparisonRow[] {
  return keys.map((key) => {
    const def = metricDef(key)
    const values = metrics.map((m) => m?.[key] as number | undefined)
    const ref = values[0]
    const deltasPct = values.map((v, i) =>
      i === 0 || v === undefined || ref === undefined || ref === 0 ? undefined : ((v - ref) / ref) * 100
    )
    const present = values.map((v, i) => [v, i] as const).filter((p): p is readonly [number, number] => p[0] !== undefined)
    let best: number | undefined
    let worst: number | undefined
    if (present.length > 1) {
      const sorted = [...present].sort((a, b) => def.lowerIsBetter ? a[0] - b[0] : b[0] - a[0])
      if (sorted[0][0] !== sorted[sorted.length - 1][0]) {
        best = sorted[0][1]
        worst = sorted[sorted.length - 1][1]
      }
    }
    return { key, label: def.label, values, deltasPct, best, worst }
  })
}

/** Whether a change of `deltaPct` on this metric is good news. */
export function isImprovement(key: MetricKey, deltaPct: number): boolean {
  return metricDef(key).lowerIsBetter ? deltaPct < 0 : deltaPct > 0
}

/* ─────────────────────────── trends & overview ─────────────────────────── */

/** `[epoch ms, value]` points for one metric, oldest first, skipping gaps. */
export function trendPoints(records: RunRecord[], key: MetricKey): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const r of records) {
    const v = r.metrics?.[key] as number | undefined
    const t = Date.parse(r.startedAt ?? '')
    if (v === undefined || !Number.isFinite(t)) continue
    out.push([t, v])
  }
  return out.sort((a, b) => a[0] - b[0])
}

export interface Overview {
  runs7d: number
  passed7d: number
  failed7d: number
  /** Passed / (passed + failed) over the last 7 days; undefined with no verdicts. */
  passRatePct?: number
  /** Tests whose most recent run regressed against their baseline. */
  regressedTests: string[]
}

export function overview(
  records: RunRecord[],
  verdictOf: (r: RunRecord) => GateVerdict,
  nowMs: number,
): Overview {
  const since = nowMs - 7 * 24 * 3600 * 1000
  let runs7d = 0
  let passed7d = 0
  let failed7d = 0
  const latest = new Map<string, RunRecord>()
  for (const r of records) {
    const t = Date.parse(r.startedAt ?? '')
    const prev = latest.get(r.test)
    if (!prev || (r.startedAt ?? '') > (prev.startedAt ?? '')) latest.set(r.test, r)
    if (!Number.isFinite(t) || t < since) continue
    runs7d++
    const v = verdictOf(r).status
    if (v === 'pass') passed7d++
    else if (v === 'fail') failed7d++
  }
  const regressedTests = [...latest.values()]
    .filter((r) => verdictOf(r).regressions.length > 0)
    .map((r) => r.test)
    .sort()
  const decided = passed7d + failed7d
  return {
    runs7d,
    passed7d,
    failed7d,
    passRatePct: decided ? (passed7d / decided) * 100 : undefined,
    regressedTests,
  }
}
