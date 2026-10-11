import { assertAlmostEquals, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1'
import {
  compareRuns,
  compareToBaseline,
  DEFAULT_TOLERANCE,
  evaluateGate,
  gateEnv,
  isImprovement,
  overview,
  parseBaseline,
  parseGate,
  type PerfBaseline,
  type PerfGate,
  serialiseGate,
  trendPoints,
} from './perf-gate.ts'
import { parseConfig, serialiseConfig, DEFAULT_CONFIG } from './perf-format.ts'
import type { RunMetrics, RunRecord } from './perf-results.ts'

/**
 * The regression and gate rules decide whether a pipeline goes green. They
 * are mirrored by awk in the runner script, so every rule is pinned here.
 */

const base: PerfBaseline = {
  run: 'checkout-load-r1',
  pinnedAt: '2026-10-01T00:00:00Z',
  metrics: { p95Ms: 200, p99Ms: 400, avgMs: 100, errorRatePct: 0.5, rps: 100 },
}

const m = (o: Partial<RunMetrics>): RunMetrics => ({ thresholdsPassed: 0, thresholdsFailed: 0, ...o })

Deno.test('latency regresses only beyond the tolerance', () => {
  const at = compareToBaseline(m({ p95Ms: 220 }), base.metrics)
  assertEquals(at.find((d) => d.key === 'p95Ms')?.regressed, false) // +10% exactly is allowed
  const over = compareToBaseline(m({ p95Ms: 221 }), base.metrics)
  const d = over.find((d) => d.key === 'p95Ms')!
  assertEquals(d.regressed, true)
  assertAlmostEquals(d.deltaPct!, 10.5)
  assertAlmostEquals(d.limit!, 220)
})

Deno.test('error rate is compared in absolute points, not percent', () => {
  // 0.5% → 0.9% is +80% relative but only +0.4 points: inside 0.5 pts.
  const ok = compareToBaseline(m({ errorRatePct: 0.9 }), base.metrics)
  assertEquals(ok.find((d) => d.key === 'errorRatePct')?.regressed, false)
  const bad = compareToBaseline(m({ errorRatePct: 1.1 }), base.metrics)
  assertEquals(bad.find((d) => d.key === 'errorRatePct')?.regressed, true)
})

Deno.test('throughput regresses when it DROPS', () => {
  const up = compareToBaseline(m({ rps: 150 }), base.metrics)
  const t = up.find((d) => d.key === 'rps')!
  assertEquals(t.regressed, false)
  assertEquals(t.improved, true)
  const down = compareToBaseline(m({ rps: 89 }), base.metrics)
  assertEquals(down.find((d) => d.key === 'rps')?.regressed, true)
})

Deno.test('missing numbers are neither regressions nor improvements', () => {
  const d = compareToBaseline(m({}), base.metrics)
  assertEquals(d.every((x) => !x.regressed && !x.improved), true)
})

Deno.test('custom tolerance is honoured', () => {
  const tol = { ...DEFAULT_TOLERANCE, latencyPct: 50 }
  assertEquals(compareToBaseline(m({ p95Ms: 290 }), base.metrics, tol).find((d) => d.key === 'p95Ms')?.regressed, false)
})

const gate: PerfGate = {
  p95Ms: 250,
  errorRatePct: 1,
  minRps: 50,
  requireThresholds: true,
  failOnRegression: true,
  tolerance: DEFAULT_TOLERANCE,
}

Deno.test('a run inside every budget passes', () => {
  const v = evaluateGate({
    metrics: m({ p95Ms: 210, avgMs: 100, errorRatePct: 0.2, rps: 95, thresholdsPassed: 2 }),
    stage: 'finished',
    exitCode: 0,
    gate,
    baseline: base,
  })
  assertEquals(v.status, 'pass')
  assertEquals(v.checks.map((c) => c.id), ['thresholds', 'p95', 'errors', 'rps', 'regression'])
})

Deno.test('each breached budget is its own failure', () => {
  const v = evaluateGate({
    metrics: m({ p95Ms: 300, errorRatePct: 2, rps: 40 }),
    stage: 'finished',
    gate: { ...gate, failOnRegression: false },
  })
  assertEquals(v.status, 'fail')
  assertEquals(v.failures.map((c) => c.id), ['p95', 'errors', 'rps'])
})

Deno.test('exit code 99 means the script thresholds were crossed', () => {
  const v = evaluateGate({ metrics: m({ thresholdsPassed: 2 }), exitCode: 99, stage: 'finished' })
  assertEquals(v.status, 'fail')
  assertEquals(v.failures[0].id, 'thresholds')
})

Deno.test('a limit on a metric the run did not report fails, with the reason', () => {
  const v = evaluateGate({ metrics: m({ p95Ms: 100 }), stage: 'finished', gate: { ...gate, p99Ms: 500 } })
  const p99 = v.checks.find((c) => c.id === 'p99')!
  assertEquals(p99.passed, false)
  assertStringIncludes(p99.detail, 'summaryTrendStats')
})

Deno.test('regressions are reported even when they do not gate', () => {
  const v = evaluateGate({
    metrics: m({ p95Ms: 240, errorRatePct: 0, rps: 100 }),
    stage: 'finished',
    gate: { ...gate, failOnRegression: false },
    baseline: base,
  })
  assertEquals(v.status, 'pass')
  assertEquals(v.regressions.map((d) => d.key), ['p95Ms'])
})

Deno.test('a run that did not finish fails; one with no summary has no data', () => {
  assertEquals(evaluateGate({ stage: 'error' }).status, 'fail')
  assertEquals(evaluateGate({ stage: 'finished' }).status, 'no-data')
})

Deno.test('without a gate, the verdict is the script thresholds', () => {
  assertEquals(evaluateGate({ metrics: m({ thresholdsFailed: 1 }), stage: 'finished' }).status, 'fail')
  assertEquals(evaluateGate({ metrics: m({ thresholdsPassed: 1 }), stage: 'finished' }).status, 'pass')
})

Deno.test('gate and baseline survive a test.json round trip', () => {
  const c = { ...DEFAULT_CONFIG, title: 'T', gate, baseline: base }
  const back = parseConfig(serialiseConfig(c), 't')
  assertEquals(back.gate, gate)
  assertEquals(back.baseline, base)
})

Deno.test('a config without a gate gets none — not an empty one', () => {
  const back = parseConfig(serialiseConfig({ ...DEFAULT_CONFIG, title: 'T' }), 't')
  assertEquals('gate' in back, false)
  assertEquals('baseline' in back, false)
})

Deno.test('a hand-mangled gate degrades instead of throwing', () => {
  const g = parseGate({ p95Ms: 'abc', errorRatePct: -1, minRps: '25', tolerance: 'x' })!
  assertEquals(g.p95Ms, undefined)
  assertEquals(g.errorRatePct, undefined)
  assertEquals(g.minRps, 25)
  assertEquals(g.requireThresholds, true)
  assertEquals(g.tolerance, DEFAULT_TOLERANCE)
  assertEquals(parseGate('nope'), undefined)
  assertEquals(parseBaseline({ metrics: {} }), undefined)
  assertEquals(Object.keys(serialiseGate(g)).includes('p95Ms'), false)
})

Deno.test('gate.env carries only numbers and safe words to the shell', () => {
  const env = gateEnv({
    test: 'checkout;rm -rf /',
    namespace: 'perf',
    commit: 'abc$(id)',
    gate: { ...gate, p95Ms: 250.12345 },
    baseline: base,
  })
  assertStringIncludes(env, "PERF_TEST='checkoutrm-rf'")
  assertStringIncludes(env, "PERF_COMMIT='abcid'")
  assertStringIncludes(env, "GATE_P95_MS='250.123'")
  assertStringIncludes(env, "GATE_P99_MS=''")
  assertStringIncludes(env, "GATE_FAIL_ON_REGRESSION='true'")
  assertStringIncludes(env, "BASE_RPS='100'")
  assertEquals(/\$\(|;|`/.test(env.split('\n').slice(1).join('\n')), false)
})

Deno.test('regression gating is off in gate.env when there is no baseline to regress from', () => {
  assertStringIncludes(gateEnv({ test: 't', namespace: 'n', gate }), "GATE_FAIL_ON_REGRESSION='false'")
})

Deno.test('comparison measures from the first run and marks best and worst', () => {
  const rows = compareRuns(
    [m({ p95Ms: 200, rps: 100 }), m({ p95Ms: 300, rps: 120 }), m({ p95Ms: 150 })],
    ['p95Ms', 'rps'],
  )
  const p95 = rows[0]
  assertEquals(p95.deltasPct, [undefined, 50, -25])
  assertEquals(p95.best, 2)
  assertEquals(p95.worst, 1)
  const rps = rows[1]
  assertEquals(rps.best, 1) // higher throughput is better
  assertEquals(rps.values[2], undefined)
  assertEquals(isImprovement('p95Ms', -5), true)
  assertEquals(isImprovement('rps', -5), false)
})

Deno.test('identical values have no best or worst', () => {
  const [row] = compareRuns([m({ p95Ms: 200 }), m({ p95Ms: 200 })], ['p95Ms'])
  assertEquals(row.best, undefined)
})

const rec = (test: string, startedAt: string, o: Partial<RunMetrics>, stage = 'finished'): RunRecord => ({
  run: `${test}-${startedAt}`,
  test,
  namespace: 'perf',
  resultName: `k6-result-${test}`,
  startedAt,
  stage,
  trigger: 'schedule',
  runners: 1,
  metrics: m(o),
})

Deno.test('trend points are chronological and skip runs without the metric', () => {
  const pts = trendPoints([
    rec('a', '2026-10-03T00:00:00Z', { p95Ms: 3 }),
    rec('a', '2026-10-01T00:00:00Z', { p95Ms: 1 }),
    rec('a', '2026-10-02T00:00:00Z', {}),
  ], 'p95Ms')
  assertEquals(pts.map((p) => p[1]), [1, 3])
})

Deno.test('overview counts the last seven days and flags tests whose LATEST run regressed', () => {
  const now = Date.parse('2026-10-11T00:00:00Z')
  const records = [
    rec('a', '2026-10-10T00:00:00Z', { p95Ms: 300, thresholdsPassed: 1 }), // regressed, latest
    rec('a', '2026-10-09T00:00:00Z', { p95Ms: 200, thresholdsPassed: 1 }),
    rec('b', '2026-10-08T00:00:00Z', { p95Ms: 400, thresholdsFailed: 1 }), // regressed but…
    rec('b', '2026-10-09T00:00:00Z', { p95Ms: 200, thresholdsPassed: 1 }), // …recovered
    rec('c', '2026-09-01T00:00:00Z', { thresholdsPassed: 1 }), // outside the window
  ]
  const o = overview(records, (r) => evaluateGate({ metrics: r.metrics, stage: r.stage, baseline: base }), now)
  assertEquals(o.runs7d, 4)
  assertEquals(o.passed7d, 3)
  assertEquals(o.failed7d, 1)
  assertEquals(o.passRatePct, 75)
  assertEquals(o.regressedTests, ['a'])
})
