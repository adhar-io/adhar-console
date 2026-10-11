import { assertEquals, assertAlmostEquals } from 'jsr:@std/assert@^1'
import { parseK6Summary } from './k6-summary.ts'
import {
  aggregateMetrics,
  extractSummary,
  fmtMetric,
  joinRunnerSummaries,
  metricsFromSummary,
  parseDurationMs,
  parsePercent,
  readStoredSummary,
  recordFromConfigMap,
  resultConfigMap,
  splitRunnerSummaries,
} from './perf-results.ts'
import { RUNNER_LOG } from './testdata/k6-runner-log.ts'

/**
 * Results are what every trend, baseline and gate is computed from, so the
 * conversion from k6's text to numbers is pinned here against real output.
 */

Deno.test('k6 durations convert to milliseconds in every unit k6 prints', () => {
  assertEquals(parseDurationMs('241ms'), 241)
  assertEquals(parseDurationMs('1.02s'), 1020)
  assertAlmostEquals(parseDurationMs('999µs')!, 0.999)
  assertAlmostEquals(parseDurationMs('12us')!, 0.012)
  assertEquals(parseDurationMs('1m2.5s'), 62_500)
  assertEquals(parseDurationMs('1h2m3s'), 3_723_000)
  assertEquals(parseDurationMs('0s'), 0)
  assertEquals(parseDurationMs(undefined), undefined)
  assertEquals(parseDurationMs('fast'), undefined)
})

Deno.test('percentages parse, anything else does not', () => {
  assertEquals(parsePercent('1.00%'), 1)
  assertEquals(parsePercent('0.00%'), 0)
  assertEquals(parsePercent('rate'), undefined)
})

Deno.test('headline metrics come out of the summary as numbers', () => {
  const m = metricsFromSummary(parseK6Summary(extractSummary(RUNNER_LOG)))
  assertEquals(m.p95Ms, 241)
  assertEquals(m.avgMs, 99.42)
  assertEquals(m.medMs, 88.3)
  assertEquals(m.maxMs, 1020)
  assertEquals(m.errorRatePct, 1)
  assertEquals(m.rps, 49.06)
  assertEquals(m.requests, 1482)
  assertEquals(m.vusMax, 50)
  assertEquals(m.thresholdsPassed, 1)
  assertEquals(m.thresholdsFailed, 1)
  assertAlmostEquals(m.checksPct!, (2934 / 2964) * 100)
  // k6 prints p(99) only when summaryTrendStats asks for it — absent, not zero.
  assertEquals('p99Ms' in m, false)
})

Deno.test('the summary is what follows the last progress line', () => {
  const s = extractSummary(RUNNER_LOG)
  assertEquals(s.includes('running ('), false)
  assertEquals(s.includes('execution: local'), false)
  assertEquals(s.trimStart().startsWith('✓ status is 200'), true)
})

Deno.test('a log with no progress lines is kept whole', () => {
  assertEquals(extractSummary('a\nb\n'), 'a\nb\n')
})

Deno.test('several runners: throughput adds up, percentiles take the worst, errors are weighted', () => {
  const m = aggregateMetrics([
    { p95Ms: 200, avgMs: 100, errorRatePct: 0, rps: 50, requests: 100, thresholdsPassed: 2, thresholdsFailed: 0 },
    { p95Ms: 300, avgMs: 200, errorRatePct: 3, rps: 30, requests: 300, thresholdsPassed: 1, thresholdsFailed: 1 },
  ])
  assertEquals(m.p95Ms, 300)
  assertEquals(m.rps, 80)
  assertEquals(m.requests, 400)
  assertEquals(m.avgMs, (100 * 100 + 200 * 300) / 400)
  assertEquals(m.errorRatePct, (0 * 100 + 3 * 300) / 400)
  assertEquals(m.thresholdsFailed, 1)
})

Deno.test('runner summaries round-trip through summary.txt', () => {
  const one = extractSummary(RUNNER_LOG)
  const text = joinRunnerSummaries([{ pod: 'run-1-abc', summary: one }, { pod: 'run-2-def', summary: one }])
  assertEquals(splitRunnerSummaries(text).length, 2)
  const stored = readStoredSummary(text)
  assertEquals(stored.runners, 2)
  assertEquals(stored.metrics?.rps, 98.12)
  assertEquals(stored.metrics?.p95Ms, 241)
})

Deno.test('a result ConfigMap reads back as the record it was written from', () => {
  const cm = resultConfigMap({
    run: 'checkout-load-20261011-020000',
    test: 'checkout-load',
    namespace: 'perf',
    summaryText: joinRunnerSummaries([{ pod: 'p-1', summary: extractSummary(RUNNER_LOG) }]),
    trigger: 'console',
    commit: 'abc1234',
    startedAt: '2026-10-11T02:00:00Z',
    finishedAt: '2026-10-11T02:01:00Z',
    stage: 'finished',
    exitCode: 99,
    parallelism: 1,
  })
  const r = recordFromConfigMap(cm)!
  assertEquals(r.run, 'checkout-load-20261011-020000')
  assertEquals(r.resultName, 'k6-result-checkout-load-20261011-020000')
  assertEquals(r.test, 'checkout-load')
  assertEquals(r.trigger, 'console')
  assertEquals(r.commit, 'abc1234')
  assertEquals(r.exitCode, 99)
  assertEquals(r.stage, 'finished')
  assertEquals(r.metrics?.p95Ms, 241)
})

Deno.test('ConfigMaps that are not results are ignored', () => {
  assertEquals(recordFromConfigMap({ metadata: { name: 'x', labels: { 'adhar.io/perf-test': 't' } } }), null)
  assertEquals(recordFromConfigMap({ metadata: { name: 'x' } }), null)
})

Deno.test('a result whose runner printed no summary has no metrics, not zeros', () => {
  const r = recordFromConfigMap({
    metadata: {
      name: 'k6-result-r',
      labels: { 'adhar.io/perf-test': 't', 'adhar.io/perf-result': 'true', 'adhar.io/perf-trigger': 'schedule' },
      annotations: { 'adhar.io/perf-verdict': 'fail', 'adhar.io/perf-stage': 'error' },
    },
    data: { 'summary.txt': '=== adhar-perf runner r-1 ===\nlevel=error msg="boom"\n' },
  })!
  assertEquals(r.metrics, undefined)
  assertEquals(r.trigger, 'schedule')
  assertEquals(r.recordedVerdict, 'fail')
})

Deno.test('metrics format in their own units', () => {
  assertEquals(fmtMetric('p95Ms', 241), '241ms')
  assertEquals(fmtMetric('p95Ms', 1020), '1.02s')
  assertEquals(fmtMetric('errorRatePct', 1), '1.00%')
  assertEquals(fmtMetric('rps', 49.06), '49.1/s')
  assertEquals(fmtMetric('rps', undefined), '—')
})
