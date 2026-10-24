import { assertEquals } from 'jsr:@std/assert@^1'
import { parseK6Summary } from './k6-summary.ts'
import { extractSummary, metricsFromSummary } from './perf-results.ts'
import { V1_FAILING_LOG, V1_PASSING_LOG } from './testdata/k6-v1-runner-log.ts'

Deno.test('k6 v1: thresholds are read from the THRESHOLDS section, with the measured value', () => {
  const s = parseK6Summary(V1_FAILING_LOG)
  assertEquals(s.thresholds, [
    { metric: 'checks', expression: 'rate>0.99', passed: false, actual: 'rate=0.00%' },
    { metric: 'http_req_duration', expression: 'p(95)<500', passed: true, actual: 'p(95)=0s' },
    { metric: 'http_req_failed', expression: 'rate<0.01', passed: false, actual: 'rate=100.00%' },
  ])
})

Deno.test('k6 v1: checks come from checks_succeeded / checks_failed', () => {
  assertEquals(parseK6Summary(V1_FAILING_LOG).checks, { passed: 0, failed: 1665 })
  assertEquals(parseK6Summary(V1_PASSING_LOG).checks, { passed: 1658, failed: 0 })
})

Deno.test('k6 v1: headline metrics parse into numbers', () => {
  const m = metricsFromSummary(parseK6Summary(V1_PASSING_LOG))
  assertEquals(m.p95Ms, 10.69)
  assertEquals(m.errorRatePct, 0)
  assertEquals(m.requests, 1658)
  assertEquals(m.vusMax, 10)
  assertEquals(m.checksPct, 100)
  assertEquals(m.thresholdsPassed, 3)
  assertEquals(m.thresholdsFailed, 0)
  const f = metricsFromSummary(parseK6Summary(V1_FAILING_LOG))
  assertEquals(f.errorRatePct, 100)
  assertEquals(f.checksPct, 0)
  assertEquals(f.thresholdsFailed, 2)
})

Deno.test('a quiet runner log is cut to the summary, not kept whole', () => {
  const s = extractSummary(V1_FAILING_LOG)
  assertEquals(s.includes('Request Failed'), false)
  assertEquals(s.trimStart().startsWith('█ THRESHOLDS'), true)
  // The final threshold error is kept: it is k6 saying why it exited 99.
  assertEquals(s.includes('have been crossed'), true)
  // And it still parses to the same summary.
  assertEquals(parseK6Summary(s).thresholds.length, 3)
})
