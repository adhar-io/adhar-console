import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { readinessReport, type ScorerApplication } from './perf-readiness.ts'
import { recommendations, reportFindings, reportHtml } from './perf-report.ts'

const app: ScorerApplication = {
  kind: 'application',
  name: 'cart',
  score: 64,
  grade: 'D',
  environment: 'prod',
  categories: { performance: 55, resilience: 70 },
  signals: [
    { name: 'load_test', category: 'performance', applicable: true, score: 0, detail: 'p95 640 ms over 500 ms' },
    { name: 'replicas_ha', category: 'resilience', applicable: true, score: 0, detail: '1 replica' },
    { name: 'pod_disruption_budget', category: 'resilience', applicable: true, score: 1 },
    { name: 'progressive_delivery', category: 'resilience', applicable: false, score: 0 },
  ],
  evidence: {
    environment: 'test',
    testedAt: '2026-10-22T09:00:00Z',
    image: 'harbor/shop/cart:abc',
    performance: { status: 'failed', p95Ms: 640, p99Ms: 1900, avgMs: 210, errorRate: 0.002, thresholdP95Ms: 500, thresholdErrorRate: 0.01, rps: 120, vus: 20 },
    chaosSuite: { 'pod-delete': { status: 'failed', probeSuccessPercentage: 62, recoverySeconds: 48 } },
  },
}

Deno.test('findings explain every failure and rank high-priority actions first', () => {
  const r = readinessReport(app)
  const f = reportFindings(r)
  assert(f.some((x) => x.title === 'p95 latency is over target under load' && x.priority === 'high'))
  assert(f.some((x) => x.title === 'Long latency tail'))
  assert(f.some((x) => x.title === 'Not met: At least two replicas' && x.snippet?.includes('replicas: 2')))
  assert(f.some((x) => x.title === 'No live request metrics'))
  assert(f.some((x) => x.title === 'No Performance Center test targets this service' && x.recommendation?.includes('app=cart')))
  // Passing and not-applicable checks are not raised as issues.
  assert(!f.some((x) => x.title.includes('PodDisruptionBudget')))
  assert(!f.some((x) => x.title.includes('Progressive delivery')))
  const recs = recommendations(f)
  assertEquals(recs[0].priority, 'high')
  assertEquals(recs.at(-1)?.priority, 'low')
})

Deno.test('the HTML is standalone and escapes data', () => {
  const r = readinessReport({ ...app, name: 'cart<script>' })
  const html = reportHtml(r, { generatedAt: '2026-10-22T10:00:00Z', generatedBy: 'Ana' })
  assert(html.startsWith('<!doctype html>'))
  assertStringIncludes(html, 'cart&lt;script&gt;')
  assert(!html.includes('cart<script>'))
  assert(!/<link|<script/i.test(html))
  assertStringIncludes(html, 'Executive summary')
  assertStringIncludes(html, 'Test results')
  assertStringIncludes(html, 'Recommendations')
})

Deno.test('a passing app gets a clean bill and no actions', () => {
  const r = readinessReport({
    kind: 'application', name: 'web', score: 95, grade: 'A',
    signals: [{ name: 'load_test', category: 'performance', applicable: true, score: 1 }],
    evidence: { environment: 'test', performance: { status: 'passed', p95Ms: 120, p99Ms: 180, thresholdP95Ms: 500, errorRate: 0, thresholdErrorRate: 0.01 }, slo: { environment: 'prod', p95Ms: 150, errorRatio: 0.0001, targetAvailability: 99.9 } },
    perfCenter: { count: 3, tests: ['checkout'], latest: { test: 'checkout', verdict: 'passed' } },
  })
  const recs = recommendations(reportFindings(r))
  assertEquals(recs.filter((x) => x.priority === 'high').length, 0)
  const html = reportHtml(r, { generatedAt: '2026-10-22T10:00:00Z' })
  assertStringIncludes(html, 'is production-ready')
  assertStringIncludes(html, 'Performance Center · checkout')
})
