import { assertEquals } from 'jsr:@std/assert@1'
import { normaliseScorerConfigMap, PLATFORM_CATEGORIES } from './scorecards.ts'

// The scorer grades delivered applications on performance and resilience too,
// from the resilience runner's automated k6 + Litmus evidence. The console used
// to keep only the four original categories, dropping both — and read a missing
// category as 0, which would show every platform package as "0% resilient".
const summary = {
  generatedAt: '2026-10-18T03:00:00Z',
  weights: { reliability: 35, security: 25, observability: 15, operations: 25, performance: 20, resilience: 25 },
  services: [
    {
      kind: 'application', name: 'shop', namespace: 'prod', environment: 'prod', score: 93, grade: 'A',
      health: 'Healthy', sync: 'Synced', stateful: false,
      categories: { reliability: 100, security: 100, observability: 100, operations: 100, performance: 66, resilience: 87 },
      environments: [{ name: 'dev', namespace: 'dev', health: 'Healthy', sync: 'Synced', argocdApp: 'adhar-shop-dev' }],
      evidence: { environment: 'test', performance: { status: 'passed', p95Ms: 120 }, chaos: { status: 'passed', probeSuccessPercentage: 100 } },
      signals: [{ name: 'chaos_pod_delete', category: 'resilience', applicable: true, score: 1, detail: 'passed: kept answering' }],
    },
    {
      kind: 'package', name: 'keycloak', namespace: 'adhar-system', score: 75, grade: 'C', health: 'Healthy', sync: 'Synced',
      categories: { reliability: 100, security: 100, observability: 100, operations: 0, performance: null, resilience: null },
      signals: [],
    },
  ],
}

Deno.test('the scorer\'s performance and resilience categories reach the console', () => {
  assertEquals(PLATFORM_CATEGORIES.includes('performance'), true)
  assertEquals(PLATFORM_CATEGORIES.includes('resilience'), true)
  const out = normaliseScorerConfigMap({ 'summary.json': JSON.stringify(summary) }, 'adhar-system', 'adhar-scorecards')
  const shop = out.services.find((s) => s.name === 'shop')!
  assertEquals(shop.kind, 'application')
  assertEquals(shop.categories.performance, 66)
  assertEquals(shop.categories.resilience, 87)
  assertEquals(shop.signals[0].detail, 'passed: kept answering')
  assertEquals(shop.environments?.[0].argocdApp, 'adhar-shop-dev')
  assertEquals(shop.evidence?.chaos?.probeSuccessPercentage, 100)
})

Deno.test('a category nothing applies to is n/a, never a zero', () => {
  const out = normaliseScorerConfigMap({ 'summary.json': JSON.stringify(summary) }, 'adhar-system', 'adhar-scorecards')
  const kc = out.services.find((s) => s.name === 'keycloak')!
  assertEquals(kc.kind, 'package')
  assertEquals(kc.categories.resilience, null)
  assertEquals(kc.categories.performance, null)
  // A real zero stays a zero.
  assertEquals(kc.categories.operations, 0)
})
