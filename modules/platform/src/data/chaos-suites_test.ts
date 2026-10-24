import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  environmentNames,
  formatRate,
  gateVerdicts,
  joinSuites,
  parseResults,
  parseSelected,
  parseSuite,
  runOutcome,
  runPhase,
  type ConfigMapLike,
} from './chaos-suites.ts'

/**
 * The suites panel tells someone what their application is promised to
 * survive and whether it last did. Each rule below is one way that reading
 * could silently be wrong.
 */

const CATALOGUE = [
  { name: 'pod-delete', hypothesis: 'keeps answering while a replica is killed', env: { CHAOS_INTERVAL: '10' } },
  { name: 'pod-memory-hog', hypothesis: 'is not OOM-killed under memory pressure' },
  { name: 'pod-network-latency', hypothesis: 'stays inside its p95 with 200 ms added', env: { NETWORK_LATENCY: 200 } },
]

const cm = (suite: unknown, over: Partial<ConfigMapLike['metadata']> = {}): ConfigMapLike => ({
  metadata: { name: 'shop-resilience', namespace: 'test', labels: { 'adhar.io/application': 'shop' }, ...over },
  data: { 'suite.json': typeof suite === 'string' ? suite : JSON.stringify(suite) },
})

Deno.test('selected picks AND orders the faults that run', () => {
  const s = parseSuite(cm({ selected: 'pod-network-latency, pod-delete', experiments: CATALOGUE }))
  assertEquals(s.steps.map((x) => x.name), ['pod-network-latency', 'pod-delete'])
  assertEquals(s.steps[1].hypothesis, 'keeps answering while a replica is killed')
  assertEquals(s.steps[0].env, { NETWORK_LATENCY: '200' })
  assertEquals(s.catalogue.length, 3)
})

Deno.test('an empty selected runs the whole catalogue in its own order', () => {
  for (const selected of ['', ' , ', undefined]) {
    const s = parseSuite(cm({ selected, experiments: CATALOGUE }))
    assertEquals(s.steps.map((x) => x.name), ['pod-delete', 'pod-memory-hog', 'pod-network-latency'])
  }
})

Deno.test('a selected fault with no catalogue entry is kept and marked', () => {
  const s = parseSuite(cm({ selected: 'pod-delete,disk-fill', experiments: CATALOGUE }))
  assertEquals(s.steps.map((x) => [x.name, x.catalogued]), [['pod-delete', true], ['disk-fill', false]])
  assertEquals(s.steps[1].hypothesis, undefined)
})

Deno.test('duplicates in selected run once, at their first position', () => {
  assertEquals(parseSelected('a,b,a,c'), ['a', 'b', 'c'])
  assertEquals(parseSelected(['b', 'a']), ['b', 'a'])
})

Deno.test('probe path, load-test thresholds and the gate switch are read', () => {
  const s = parseSuite(cm({
    probePath: '/actuator/health/readiness',
    perf: { path: '', p95Ms: 500, errorRate: 0.01 },
    gate: { enabled: false },
    experiments: [],
  }))
  assertEquals(s.probePath, '/actuator/health/readiness')
  assertEquals(s.perf, { path: '', p95Ms: 500, errorRate: 0.01 })
  assertEquals(s.gateEnabled, false)
  assertEquals(parseSuite(cm({ experiments: [] })).gateEnabled, true)
})

Deno.test('a suite that is not JSON is a readable error, not a crash', () => {
  const s = parseSuite(cm('{ "selected": "pod-delete", '))
  assert(s.error?.startsWith('suite.json is not valid JSON'))
  assertEquals(s.app, 'shop')
  assertEquals(s.namespace, 'test')
  assertEquals(s.steps, [])
  assert(parseSuite({ metadata: { name: 'x-resilience' } }).error)
  assertEquals(parseSuite({ metadata: { name: 'x-resilience' } }).app, 'x')
  assert(parseSuite(cm('[1,2]')).error)
})

const RESULTS = {
  shop: {
    environment: 'test',
    namespace: 'test',
    image: 'harbor/shop:1.2',
    testedAt: '2026-10-20T10:00:00Z',
    performance: { status: 'passed', p95Ms: 9.2, errorRate: 0, rps: 120, thresholdP95Ms: 500 },
    chaosSuite: {
      'pod-delete': { status: 'passed', verdict: 'Pass', probeSuccessPercentage: 100, recoverySeconds: 12 },
      'pod-cpu-hog': { status: 'unavailable', detail: 'not installed' },
    },
    gates: {
      test: { verdict: 'pass', reasons: [], environment: 'test', image: 'harbor/shop:1.2', at: '2026-10-20T10:00:00Z' },
      dev: { verdict: 'fail', reasons: ['pod-delete failed: probe 40%'], at: '2026-10-19T10:00:00Z' },
      gone: { verdict: 'skipped', reason: 'disabled by the suite', at: '2026-10-18T10:00:00Z' },
    },
  },
}

Deno.test('results parse, and an unreadable results.json reports instead of throwing', () => {
  const { results, error } = parseResults(JSON.stringify(RESULTS))
  assertEquals(error, undefined)
  const shop = results.get('shop')!
  assertEquals(shop.performance?.p95Ms, 9.2)
  assertEquals(shop.chaosSuite['pod-cpu-hog'].status, 'unavailable')
  assertEquals(parseResults(undefined).results.size, 0)
  assert(parseResults('nope').error)
})

Deno.test('gate verdicts: newest first, and a skip carries its singular reason', () => {
  const shop = parseResults(JSON.stringify(RESULTS)).results.get('shop')
  const gates = gateVerdicts(shop)
  assertEquals(gates.map((g) => [g.namespace, g.verdict]), [['test', 'pass'], ['dev', 'fail'], ['gone', 'skipped']])
  assertEquals(gates[1].reasons, ['pod-delete failed: probe 40%'])
  assertEquals(gates[2].reasons, ['disabled by the suite'])
})

Deno.test('fault results join only to the namespace the last run tested; gates join everywhere', () => {
  const { results } = parseResults(JSON.stringify(RESULTS))
  const suites = [
    parseSuite(cm({ selected: 'pod-delete,pod-memory-hog', experiments: CATALOGUE })),
    parseSuite(cm({ selected: 'pod-delete', experiments: CATALOGUE }, { namespace: 'dev' })),
  ]
  const [shop] = joinSuites(suites, results, environmentNames([
    { metadata: { labels: { 'adhar.io/environment': 'development' } }, spec: { destination: { namespace: 'dev' } } },
  ]))
  assertEquals(shop.environments.map((r) => [r.namespace, r.environment]), [['dev', 'development'], ['test', 'test']])

  const [dev, test] = shop.environments
  // dev was not the last test: no fault results, but its own gate verdict.
  assertEquals(dev.result, undefined)
  assertEquals(dev.faults[0].result, undefined)
  assertEquals(dev.gate?.verdict, 'fail')

  assertEquals(test.result?.image, 'harbor/shop:1.2')
  assertEquals(test.faults.map((f) => [f.name, f.inSuite, f.result?.status]), [
    ['pod-delete', true, 'passed'],
    ['pod-memory-hog', true, undefined],
    // Recorded by the last run but no longer selected — still shown, marked.
    ['pod-cpu-hog', false, 'unavailable'],
  ])
  assertEquals(shop.orphanGates.map((g) => g.namespace), ['gone'])
})

Deno.test('an application with a suite but no results has rows and nothing else', () => {
  const [a] = joinSuites([parseSuite(cm({ experiments: CATALOGUE }))], new Map())
  assertEquals(a.last, undefined)
  assertEquals(a.environments[0].gate, undefined)
  assertEquals(a.environments[0].faults.length, 3)
})

Deno.test('job phase: conditions win over counters', () => {
  assertEquals(runPhase(undefined), 'pending')
  assertEquals(runPhase({ active: 1 }), 'running')
  assertEquals(runPhase({ active: 1, failed: 1 }), 'running')
  assertEquals(runPhase({ failed: 1, conditions: [{ type: 'Failed', status: 'True' }] }), 'failed')
  assertEquals(runPhase({ succeeded: 1 }), 'succeeded')
})

Deno.test('a finished run that did not move testedAt reads as "already passed"', () => {
  const after = parseResults(JSON.stringify(RESULTS)).results.get('shop')
  const before = '2026-10-20T10:00:00Z'
  assertEquals(runOutcome({ phase: 'succeeded', namespace: 'test', testedAtBefore: before, after }), 'already-passed')
  assertEquals(runOutcome({ phase: 'succeeded', namespace: 'test', testedAtBefore: '2026-10-01T00:00:00Z', after }), 'tested')
  assertEquals(runOutcome({ phase: 'running', namespace: 'test', after }), 'running')
  assertEquals(runOutcome({ phase: 'failed', namespace: 'test', after }), 'failed')
  assertEquals(runOutcome({ phase: 'succeeded', namespace: 'gone', after }), 'skipped')
  assertEquals(runOutcome({ phase: 'succeeded', namespace: 'prod', after }), 'no-change')
  // Started elsewhere (no before-value): the Job's start time decides.
  assertEquals(runOutcome({ phase: 'succeeded', namespace: 'test', startedAt: '2026-10-20T09:55:00Z', after }), 'tested')
  assertEquals(runOutcome({ phase: 'succeeded', namespace: 'test', startedAt: '2026-10-20T11:00:00Z', after }), 'already-passed')
  assertEquals(
    runOutcome({ phase: 'succeeded', namespace: 'prod', after, log: 'shop: harbor/shop:1.2 already passed the gate in prod' }),
    'already-passed',
  )
})

Deno.test('error rates read as percentages', () => {
  assertEquals(formatRate(0.01), '1%')
  assertEquals(formatRate(0), '0%')
  assertEquals(formatRate(0.0025), '0.25%')
})
