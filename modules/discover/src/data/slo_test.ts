import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  alertRulesYaml,
  budgetRemaining,
  burnDown,
  burnRate,
  errorBudget,
  errorRatioExpr,
  evaluate,
  eventsExpr,
  policyFactor,
  type SloDefinition,
  validateSlo,
  windowsQuery,
} from './slo.ts'

const avail: SloDefinition = {
  id: 'api-availability',
  name: 'API availability',
  service: 'api',
  objective: 99.9,
  windowDays: 30,
  sli: { kind: 'availability', metric: 'http_requests_total', selector: 'namespace="shop"', errorSelector: 'code=~"5.."' },
}
const latency: SloDefinition = {
  ...avail,
  id: 'api-latency',
  sli: { kind: 'latency', metric: 'http_request_duration_seconds', selector: '{job="api"}', threshold: '0.3' },
}

Deno.test('PromQL generation', () => {
  assertEquals(
    errorRatioExpr(avail, '1h'),
    'sum(rate(http_requests_total{namespace="shop", code=~"5.."}[1h])) / sum(rate(http_requests_total{namespace="shop"}[1h]))',
  )
  assertEquals(
    eventsExpr(latency, 'error', '5m'),
    '(sum(rate(http_request_duration_seconds_count{job="api"}[5m])) - sum(rate(http_request_duration_seconds_bucket{job="api", le="0.3"}[5m])))',
  )
  const custom: SloDefinition = { ...avail, sli: { kind: 'custom', errorQuery: 'sum(rate(bad[$window]))', totalQuery: 'sum(rate(all[$window]))' } }
  assertEquals(errorRatioExpr(custom, '6h'), '(sum(rate(bad[6h]))) / (sum(rate(all[6h])))')
  const wq = windowsQuery(avail)
  assert(wq.includes('"w", "5m"'))
  assert(wq.includes('"w", "30d"'))
  assertEquals(wq.split(' or label_replace').length, 8)
  // empty selector
  const bare: SloDefinition = { ...avail, sli: { kind: 'availability', metric: 'x_total', selector: '', errorSelector: 'code="500"' } }
  assertEquals(eventsExpr(bare, 'total', '5m'), 'sum(rate(x_total{}[5m]))')
})

Deno.test('budget + burn math', () => {
  assertAlmostEquals(errorBudget(99.9), 0.001, 1e-12)
  assertAlmostEquals(burnRate(0.0144, 99.9)!, 14.4, 1e-9)
  assertEquals(burnRate(null, 99.9), null)
  assertEquals(burnRate(NaN, 99.9), null)
  assertAlmostEquals(budgetRemaining(0.0005, 99.9)!, 0.5, 1e-9)
  assertAlmostEquals(budgetRemaining(0.002, 99.9)!, -1, 1e-9)
  assertEquals(policyFactor(14.4, 30), 14.4)
  assertEquals(policyFactor(14.4, 7), 3.36)
})

Deno.test('evaluate statuses', () => {
  assertEquals(evaluate(avail, {}).status, 'no-data')
  assertEquals(evaluate(avail, { '30d': 0.0001, '1h': 0, '5m': 0 }).status, 'healthy')
  assertEquals(evaluate(avail, { '30d': 0.0011 }).status, 'breached')
  const fast = evaluate(avail, { '30d': 0.0005, '1h': 0.02, '5m': 0.03 })
  assertEquals(fast.status, 'burning')
  assertEquals(fast.firing[0].severity, 'critical')
  // long window burning but short recovered → not firing
  assertEquals(evaluate(avail, { '30d': 0.0001, '1h': 0.02, '5m': 0.0 }).status, 'healthy')
  const slow = evaluate(avail, { '30d': 0.0003, '1d': 0.004, '2h': 0.005 })
  assertEquals(slow.status, 'at-risk')
  assertEquals(evaluate(avail, { '30d': 0.0008 }).status, 'at-risk') // 20% left
  assertAlmostEquals(evaluate(avail, { '30d': 0.0001 }).sli!, 99.99, 1e-9)
})

Deno.test('burnDown', () => {
  // 1000 events, budget 0.1% = 1 bad event
  const total: Array<[number, number]> = [[1, 500], [2, 500]]
  const bad: Array<[number, number]> = [[1, 0.5], [2, 0.25]]
  const bd = burnDown(bad, total, 99.9)
  assertAlmostEquals(bd[0][1], 50, 1e-9)
  assertAlmostEquals(bd[1][1], 25, 1e-9)
  assertEquals(burnDown([], [[1, 0]], 99.9), [])
  const over = burnDown([[1, 3]], [[1, 1000]], 99.9)
  assertAlmostEquals(over[0][1], -200, 1e-9)
})

Deno.test('validateSlo', () => {
  assertEquals(validateSlo(avail), [])
  assertEquals(validateSlo(latency), [])
  assert(validateSlo({ ...avail, objective: 100 }).length === 1)
  assert(validateSlo({ ...latency, sli: { kind: 'latency', metric: 'x_bucket', selector: '', threshold: 'fast' } }).length === 2)
  assert(validateSlo({ ...avail, sli: { kind: 'custom', errorQuery: 'a', totalQuery: 'b' } }).length === 1)
})

Deno.test('alertRulesYaml', () => {
  const y = alertRulesYaml(avail)
  assert(y.startsWith('apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule'))
  assert(y.includes('record: slo:sli_error:ratio_rate5m'))
  assert(y.includes('alert: SLOErrorBudgetBurnFast'))
  assert(y.includes('> (14.4 * 0.001) and slo:sli_error:ratio_rate5m'))
  assertEquals((y.match(/- alert:/g) ?? []).length, 4)
  assertEquals((y.match(/- record:/g) ?? []).length, 7)
})
