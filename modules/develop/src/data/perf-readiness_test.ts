import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { fmtGauge, readinessApplications, readinessReport, type ScorerApplication } from './perf-readiness.ts'

const shop: ScorerApplication = {
  kind: 'application', name: 'shop', environment: 'prod', score: 81, grade: 'B',
  categories: { performance: 66, resilience: 75 },
  evidence: {
    environment: 'test', testedAt: '2026-10-20T10:00:00Z', image: 'h/shop@sha256:1',
    performance: { status: 'failed', p95Ms: 812, p99Ms: 1200, avgMs: 300, errorRate: 0.002, rps: 140, vus: 10, thresholdP95Ms: 500, thresholdErrorRate: 0.01 },
    chaos: { status: 'passed', probeSuccessPercentage: '100', recoverySeconds: 12 },
    chaosSuite: {
      'pod-delete': { status: 'passed', probeSuccessPercentage: '100', recoverySeconds: 12, detail: 'kept answering while pods were deleted' },
      'pod-cpu-hog': { status: 'failed', probeSuccessPercentage: '0', detail: 'stopped answering with its CPU saturated' },
    },
    slo: { environment: 'prod', requests: 5000, p95Ms: 210, errorRatio: 0.002, targetAvailability: 99.9 },
  },
  perfCenter: { count: 3, tests: ['shop-load'], latest: { test: 'shop-load', trigger: 'schedule', verdict: 'fail', reasons: 'p95_ms 812 > 500' } },
  gameDays: null,
  signals: [
    { name: 'load_test', category: 'performance', applicable: true, score: 0, detail: 'failed' },
    { name: 'error_budget', category: 'performance', applicable: true, score: 0 },
    { name: 'chaos_pod_delete', category: 'resilience', applicable: true, score: 1 },
    { name: 'chaos_gameday', category: 'resilience', applicable: false, score: 0 },
    { name: 'probes', category: 'reliability', applicable: true, score: 1 },
  ],
}

Deno.test('the report judges every number against the target it was tested to', () => {
  const r = readinessReport(shop)
  const p95 = r.load.find((g) => g.label === 'p95 latency')!
  assertEquals([p95.value, p95.target, p95.tone], [812, 500, 'bad'])
  const err = r.load.find((g) => g.label === 'Error rate')!
  assertEquals([err.value, err.target, err.tone], [0.2, 1, 'good'])
  // 0.2% 5xx against a 99.9% SLO (0.1% budget) is OVER budget.
  const live = r.slo.find((g) => g.label.startsWith('5xx'))!
  assertEquals(live.tone, 'bad')
  assertEquals(r.loadTone, 'bad')
})

Deno.test('chaos rows cover the whole suite and say what each fault means', () => {
  const r = readinessReport(shop)
  assertEquals(r.chaos.map((c) => [c.experiment, c.tone]), [['pod-delete', 'good'], ['pod-cpu-hog', 'bad']])
  assertEquals(r.chaos[1].title, 'The CPU saturates')
  assertEquals(r.chaos[0].recoverySeconds, 12)
})

Deno.test('the verdict names what holds the grade back and ignores other categories', () => {
  const r = readinessReport(shop)
  assertEquals(r.signals.length, 4)
  assertStringIncludes(r.verdict, '2 checks hold the grade back')
  assertStringIncludes(r.verdict, 'automated load test meets its targets')
  assertEquals(r.perfCenter?.tone, 'bad')
  assertEquals(r.gameDay, undefined)
  assertEquals(r.testResults[0]?.name, 'Automated load test')
  assertEquals(r.testResults.some((t) => t.name.startsWith('Performance Center ·')), true)
})

Deno.test('a missing measurement is reported as missing, never as zero', () => {
  const bare = readinessReport({ kind: 'application', name: 'cart', score: 40, grade: 'F', evidence: { pending: 'no healthy environment among test,dev' } })
  assertEquals(bare.load.every((g) => g.value === undefined && g.tone === 'none'), true)
  assertEquals(fmtGauge(bare.load[0]), '—')
  assertEquals(bare.slo, [])
  assertEquals(bare.loadStatus, 'pending')
  assertEquals(bare.verdict, 'No performance or resilience evidence has been produced yet.')
})

Deno.test('only delivered applications get a readiness report', () => {
  const list = readinessApplications([
    shop, { kind: 'package', name: 'keycloak', score: 90, grade: 'A' }, { kind: 'application', name: 'cart', score: 1, grade: 'F' },
  ])
  assertEquals(list.map((a) => a.name), ['cart', 'shop'])
})

// The scorer publishes `latest: null` when no Performance Center result was
// judged; reading `latest.verdict` unguarded crashed the page (2026-10-22).
Deno.test('a Performance Center history with no judged run renders as not judged', () => {
  const unjudged: ScorerApplication = {
    ...shop,
    perfCenter: { count: 2, tests: ['shop-load'], latest: null, unjudged: 2 },
    gameDays: { count: 1, experiments: ['pod-delete'], latest: null },
  }
  const r = readinessReport(unjudged)
  assertEquals([r.perfCenter?.verdict, r.perfCenter?.tone, r.perfCenter?.test], ['no verdict', 'none', 'shop-load'])
  assertStringIncludes(r.perfCenter?.reasons ?? '', 'without a verdict')
  assertEquals([r.gameDay?.verdict, r.gameDay?.experiment], ['no verdict', 'pod-delete'])
  assertEquals(r.testResults.some((t) => t.name.startsWith('Game day ·')), true)
})
