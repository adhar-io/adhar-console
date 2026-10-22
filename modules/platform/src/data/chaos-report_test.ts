import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  chaosFindings,
  chaosReportHtml,
  type ChaosRunReport,
  commitUrl,
  compareRuns,
  historyOf,
  matchesCommit,
  recommendations,
  reportFileName,
  resilienceScore,
  runGrade,
  runVerdict,
  shaQuery,
} from './chaos-report.ts'

const SHA = '3f9c2a1' + '0'.repeat(33)
const OLD = '1111111' + '0'.repeat(33)

function run(over: Partial<ChaosRunReport> = {}): ChaosRunReport {
  return {
    id: 'cart.shop-test.1',
    app: 'cart',
    namespace: 'shop-test',
    environment: 'test',
    commit: SHA,
    commitSource: 'image-tag',
    image: `h/shop/cart:${SHA}`,
    trigger: 'promotion',
    finishedAt: '2026-10-22T10:00:00Z',
    recordedAt: '2026-10-22T10:01:00Z',
    experiments: [
      { name: 'pod-delete', status: 'passed', probeSuccessPercentage: 100, recoverySeconds: 12 },
      { name: 'pod-cpu-hog', status: 'failed', probeSuccessPercentage: 64, recoverySeconds: 95, detail: 'stopped answering with its CPU saturated' },
    ],
    checks: [
      { name: 'replicas_ha', applicable: true, score: 1 },
      { name: 'pod_disruption_budget', applicable: true, score: 0, detail: 'no PodDisruptionBudget selects the pods' },
      { name: 'progressive_delivery', applicable: false, score: 0 },
    ],
    ...over,
  }
}

Deno.test('verdict, score and grade follow the documented rules', () => {
  const r = run()
  assertEquals(runVerdict(r), 'failed')
  assertEquals(resilienceScore(r), 82)
  assertEquals(runGrade(r), 'C') // a failed fault caps the grade at C
  const ok = run({ experiments: [{ name: 'pod-delete', status: 'passed' }] })
  assertEquals([runVerdict(ok), resilienceScore(ok), runGrade(ok)], ['survived', 100, 'A'])
  const none = run({ experiments: [{ name: 'pod-delete', status: 'error' }, { name: 'disk-fill', status: 'unavailable' }] })
  assertEquals([runVerdict(none), resilienceScore(none), runGrade(none)], ['inconclusive', null, '—'])
})

Deno.test('every experiment gets observation, meaning and a fault-specific recommendation', () => {
  const f = chaosFindings(run())
  const cpu = f.find((x) => x.title === 'CPU saturation: stopped serving')!
  assertEquals(cpu.tone, 'bad')
  assertStringIncludes(cpu.observation, '64%')
  assertStringIncludes(cpu.recommendation!, 'HorizontalPodAutoscaler')
  assert(f.some((x) => x.title === 'Pod delete: kept serving' && !x.recommendation))
  assert(f.some((x) => x.title.startsWith('Slow recovery') && x.observation.includes('95s')))
  const pdb = f.find((x) => x.title === 'Not met: PodDisruptionBudget')!
  assertStringIncludes(pdb.snippet!, 'name: cart')
  // Passing and not-applicable checks are not raised.
  assert(!f.some((x) => x.title.includes('two replicas') || x.title.includes('Progressive')))
  assertEquals(recommendations(f)[0].priority, 'medium')
})

Deno.test('history compares with the previous run and the previous commit', () => {
  const prev = run({ id: 'p1', commit: SHA, finishedAt: '2026-10-22T09:00:00Z', experiments: [
    { name: 'pod-delete', status: 'passed', probeSuccessPercentage: 100 },
    { name: 'pod-cpu-hog', status: 'passed', probeSuccessPercentage: 100 },
  ] })
  const older = run({ id: 'p0', commit: OLD, finishedAt: '2026-10-21T09:00:00Z' })
  const otherNs = run({ id: 'x', namespace: 'shop-dev', finishedAt: '2026-10-22T09:30:00Z' })
  const cur = run()
  const h = historyOf([older, prev, otherNs, cur], cur)
  assertEquals(h.previous?.id, 'p1')
  assertEquals(h.previousCommit?.id, 'p0')
  const { rows, overall } = compareRuns(cur, prev)
  assertEquals(overall, 'worse')
  assertEquals(rows.find((x) => x.name === 'pod-cpu-hog')?.change, 'worse')
  const f = chaosFindings(cur, h)
  const worse = f.find((x) => x.title === 'Worse than the previous run')!
  assertEquals(worse.priority, 'high')
  assert(f.some((x) => x.title === 'Unchanged since the previous commit'))
})

Deno.test('commit lookup accepts short and full SHAs and never matches an unknown commit', () => {
  assertEquals(shaQuery(' 3F9C2A1 '), '3f9c2a1')
  assert(matchesCommit(run(), '3f9c2a1'))
  assert(matchesCommit(run(), SHA))
  assert(!matchesCommit(run(), OLD.slice(0, 7)))
  assert(!matchesCommit(run({ commit: undefined, commitSource: 'unknown' }), '3f9c2a1'))
  assertEquals(commitUrl('http://gitea-http.gitea.svc:3000/shop/cart.git', SHA), `http://gitea-http.gitea.svc:3000/shop/cart/commit/${SHA}`)
  assertEquals(commitUrl(undefined, SHA), undefined)
})

Deno.test('the HTML is standalone, escapes data and states an unknown commit honestly', () => {
  const html = chaosReportHtml(run({ app: 'cart<script>' }), {}, { generatedAt: '2026-10-22T10:00:00Z' })
  assert(html.startsWith('<!doctype html>'))
  assertStringIncludes(html, 'cart&lt;script&gt;')
  assert(!html.includes('cart<script>'))
  assert(!/<link|<script/i.test(html))
  for (const s of ['Executive summary', 'What was tested', 'Experiments', 'Observations', 'Recommendations', 'Workload design checks', 'How this report was produced', SHA]) {
    assertStringIncludes(html, s)
  }
  const unknown = chaosReportHtml(run({ commit: undefined, commitSource: 'unknown', commitNote: 'The image is pinned by digest and no Kargo freight carries that digest.' }), {}, { generatedAt: '2026-10-22T10:00:00Z' })
  assertStringIncludes(unknown, 'no Kargo freight carries that digest')
  assertEquals(reportFileName(run(), 'pdf'), 'cart-test-chaos-3f9c2a1-2026-10-22.pdf')
})
