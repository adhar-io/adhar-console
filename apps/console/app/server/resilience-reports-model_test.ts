import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  buildReport,
  designChecks,
  overflowIds,
  parseImage,
  placementOf,
  reportId,
  resolveCommit,
  resolveTrigger,
  shaQuery,
  type FreightLike,
  type JobLike,
} from './resilience-reports-model.ts'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const DIGEST = `sha256:${'c'.repeat(64)}`

Deno.test('parseImage splits repo, tag and digest; a port is not a tag', () => {
  assertEquals(parseImage(`harbor.x:5000/shop/cart:${SHA}`), { repo: 'harbor.x:5000/shop/cart', tag: SHA })
  assertEquals(parseImage(`harbor.x:5000/shop/cart@${DIGEST}`), { repo: 'harbor.x:5000/shop/cart', digest: DIGEST })
  assertEquals(parseImage(`harbor.x/shop/cart:v1@${DIGEST}`), { repo: 'harbor.x/shop/cart', tag: 'v1', digest: DIGEST })
  assertEquals(parseImage('  '), undefined)
})

Deno.test('a 40-hex tag is the commit; a digest resolves through Kargo freight; nothing is guessed', () => {
  assertEquals(resolveCommit(`h/shop/cart:${SHA.toUpperCase()}`, 'cart', []).commit, SHA)
  assertEquals(resolveCommit(`h/shop/cart:${SHA}`, 'cart', []).source, 'image-tag')

  const freights: FreightLike[] = [
    { metadata: { name: 'f-other', namespace: 'p2' }, origin: { name: 'other' }, images: [{ repoURL: 'h/shop/cart', tag: SHA2, digest: DIGEST }] },
    {
      metadata: { name: 'f1', namespace: 'shop', labels: { 'kargo.akuity.io/alias': 'brave-otter' } },
      origin: { name: 'cart' },
      images: [{ repoURL: 'https://h/shop/cart', tag: SHA, digest: DIGEST }],
      commits: [{ repoURL: 'http://gitea/shop/cart.git', id: SHA }],
    },
  ]
  const r = resolveCommit(`h/shop/cart@${DIGEST}`, 'cart', freights)
  assertEquals(r.commit, SHA) // the app's own warehouse wins over another project's
  assertEquals(r.source, 'kargo-freight')
  assertEquals(r.freight, { name: 'f1', alias: 'brave-otter', project: 'shop' })
  assertEquals(r.repoUrl, 'http://gitea/shop/cart.git')

  const none = resolveCommit(`h/shop/cart@${DIGEST}`, 'cart', [])
  assertEquals(none.commit, undefined)
  assertEquals(none.source, 'unknown')
  assert(none.note?.includes('no Kargo freight'))
  assert(resolveCommit('h/shop/cart:latest', 'cart', []).note?.includes('"latest" is not a commit SHA'))
  assertEquals(resolveCommit(undefined, 'cart', []).source, 'unknown')
})

Deno.test('the trigger comes from the runner Job whose lifetime covers the test', () => {
  const jobs: JobLike[] = [
    {
      metadata: { name: 'adhar-resilience-runner-29000', ownerReferences: [{ kind: 'CronJob', name: 'adhar-resilience-runner' }] },
      status: { startTime: '2026-10-22T09:23:00Z', completionTime: '2026-10-22T09:40:00Z' },
    },
    {
      metadata: { name: 'adhar-gate-cart-test-abc12', labels: { 'adhar.io/resilience-gate': 'cart', 'adhar.io/resilience-namespace': 'shop-test', 'adhar.io/triggered-by': 'console' }, annotations: { 'adhar.io/triggered-by-user': 'ana@example.com' } },
      status: { startTime: '2026-10-22T10:00:00Z', completionTime: '2026-10-22T10:12:00Z' },
    },
    {
      metadata: { name: 'cart-test-verify-1', labels: { 'adhar.io/resilience-gate': 'cart' } },
      spec: { template: { spec: { containers: [{ env: [{ name: 'VERIFY_NAMESPACE', value: 'shop-test' }] }] } } },
      status: { startTime: '2026-10-22T11:00:00Z' },
    },
  ]
  assertEquals(resolveTrigger('cart', 'shop-test', '2026-10-22T09:35:00Z', jobs).trigger, 'schedule')
  const click = resolveTrigger('cart', 'shop-test', '2026-10-22T10:11:00Z', jobs)
  assertEquals(click, { trigger: 'console', runId: 'adhar-gate-cart-test-abc12', triggeredByUser: 'ana@example.com', startedAt: '2026-10-22T10:00:00Z' })
  // Still running (no completion): covered up to now.
  assertEquals(resolveTrigger('cart', 'shop-test', '2026-10-22T11:05:00Z', jobs, Date.parse('2026-10-22T11:06:00Z')).trigger, 'promotion')
  // Another namespace's gate never claims the run.
  assertEquals(resolveTrigger('cart', 'shop-dev', '2026-10-22T10:11:00Z', jobs).trigger, 'unknown')
})

Deno.test('placement reads environment, project and source repo from the Argo CD Application', () => {
  const apps = [{
    metadata: { name: 'shop-cart-test', labels: { 'adhar.io/application': 'cart', 'adhar.io/environment': 'test' } },
    spec: { source: { repoURL: 'http://gitea/shop/cart.git' }, destination: { namespace: 'shop-test' } },
  }]
  assertEquals(placementOf('cart', 'shop-test', apps), { environment: 'test', project: 'shop', repoUrl: 'http://gitea/shop/cart.git' })
  assertEquals(placementOf('cart', 'shop-prod', apps), {})
})

Deno.test('a record becomes a report with commit, trigger, gate and design checks', () => {
  const record = {
    environment: 'test',
    namespace: 'shop-test',
    image: `h/shop/cart:${SHA}`,
    testedAt: '2026-10-22T10:11:00Z',
    target: 'http://cart.shop-test.svc.cluster.local:80/',
    performance: { status: 'passed', p95Ms: 120, errorRate: 0, thresholdP95Ms: 500 },
    chaosSuite: {
      'pod-delete': { status: 'passed', verdict: 'Pass', probeSuccessPercentage: 100, recoverySeconds: 12, replicas: 2 },
      'pod-cpu-hog': { status: 'failed', verdict: 'Fail', probeSuccessPercentage: '64', detail: 'stopped answering' },
    },
    gates: { 'shop-test': { verdict: 'fail', reasons: ['pod-cpu-hog failed: stopped answering'], image: `h/shop/cart:${SHA}`, at: '2026-10-22T10:11:05Z' } },
  }
  const r = buildReport({
    app: 'cart',
    record,
    jobs: [],
    freights: [],
    argoApps: [],
    scorerServices: [{ name: 'cart', kind: 'application', environment: 'prod', signals: [
      { name: 'replicas_ha', applicable: true, score: 1 },
      { name: 'pod_disruption_budget', applicable: true, score: 0, detail: 'none' },
      { name: 'load_test', applicable: true, score: 1 },
    ] }],
    now: Date.parse('2026-10-22T10:12:00Z'),
  })!
  assertEquals(r.id, reportId('cart', 'shop-test', '2026-10-22T10:11:00Z'))
  assertEquals(r.commit, SHA)
  assertEquals(r.experiments.map((e) => [e.name, e.status, e.probeSuccessPercentage]), [['pod-delete', 'passed', 100], ['pod-cpu-hog', 'failed', 64]])
  assertEquals(r.gate?.verdict, 'fail')
  assertEquals(r.checks?.map((c) => c.name), ['replicas_ha', 'pod_disruption_budget'])
  assertEquals(r.checksEnvironment, 'prod')
  assertEquals(r.trigger, 'unknown')
  assert(!('freight' in r)) // unknown fields are left out, not stored as undefined
})

Deno.test('queued or untested records produce no report; an old gate verdict is not attached', () => {
  assertEquals(buildReport({ app: 'cart', record: { pending: 'no healthy environment' }, jobs: [], freights: [], argoApps: [] }), undefined)
  const r = buildReport({
    app: 'cart',
    record: { namespace: 'n', testedAt: '2026-10-22T10:00:00Z', chaos: { experiment: 'pod-delete', status: 'error' }, gates: { n: { verdict: 'pass', at: '2026-10-01T00:00:00Z' } } },
    jobs: [], freights: [], argoApps: [],
  })!
  assertEquals(r.experiments[0].name, 'pod-delete')
  assertEquals(r.gate, undefined)
  assertEquals(r.environment, 'n')
})

Deno.test('sha queries, design checks without a scorer entry, and pruning', () => {
  assertEquals(shaQuery('  ABC1234 '), 'abc1234')
  assertEquals(shaQuery('abc'), undefined)
  assertEquals(shaQuery('not-a-sha'), undefined)
  assertEquals(designChecks('cart', []).checks, [])
  assertEquals(overflowIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2), ['c'])
})

/* ─────────────────────────── phases + metrics ─────────────────────────── */

import { assembleMetrics, metricsDue, metricsEmpty, metricsPlan, phasesForRun } from './resilience-reports-model.ts'
import { MAX_POINTS, parseRunnerTimeline } from '@adhar/utils'

const RUN_LOG = [
  '2026-10-22T09:00:00Z adhar-resilience: cart: load test against http://cart (old run)',
  '2026-10-22T09:01:00Z adhar-resilience: cart: performance {"status":"passed"}',
  '2026-10-22T09:50:05Z adhar-resilience: cart: load test against http://cart.shop-test.svc.cluster.local:8080/',
  '2026-10-22T09:51:25Z adhar-resilience: cart: performance {"status":"passed","p95Ms":210}',
  '2026-10-22T09:51:26Z adhar-resilience: cart: pod-delete chaos for 30s with a continuous probe on http://cart',
  '2026-10-22T09:52:20Z adhar-resilience: cart: pod-delete {"status":"passed","probeSuccessPercentage":100,"recoverySeconds":12}',
  '2026-10-22T09:52:21Z adhar-resilience: cart: pod-cpu-hog chaos for 30s with a continuous probe on http://cart',
].join('\n')

Deno.test('a run keeps only its own phases, closed at the record time', () => {
  const tl = parseRunnerTimeline(RUN_LOG, 'cart')
  const phases = phasesForRun(tl, '2026-10-22T09:53:30Z')
  // The earlier run in the same log is not this record's.
  assertEquals(phases.map((p) => `${p.kind}:${p.name}`), ['load:load-test', 'fault:pod-delete', 'recovery:pod-delete', 'fault:pod-cpu-hog'])
  const open = phases[3]
  assertEquals(open.end, Date.parse('2026-10-22T09:53:30Z'))
  assertEquals(open.status, 'unknown')
  assertEquals(phasesForRun(undefined, '2026-10-22T09:53:30Z'), [])
})

Deno.test('buildReport carries the phases and takes its start from them when no Job matched', () => {
  const r = buildReport({
    app: 'cart',
    record: { namespace: 'shop-test', testedAt: '2026-10-22T09:53:30Z', chaosSuite: { 'pod-delete': { status: 'passed' } } },
    jobs: [],
    freights: [],
    argoApps: [],
    timeline: parseRunnerTimeline(RUN_LOG, 'cart'),
    now: Date.parse('2026-10-22T09:54:00Z'),
  })!
  assertEquals(r.phases?.length, 4)
  assertEquals(r.startedAt, '2026-10-22T09:50:05.000Z')
  // Without a timeline nothing is invented.
  const bare = buildReport({ app: 'cart', record: { namespace: 'shop-test', testedAt: '2026-10-22T09:53:30Z' }, jobs: [], freights: [], argoApps: [] })!
  assertEquals(bare.phases, undefined)
  assertEquals(bare.startedAt, undefined)
})

Deno.test('metrics are due once the padded window closed, once, and only while Prometheus still has them', () => {
  const fin = '2026-10-22T10:00:00Z'
  const t = Date.parse(fin)
  assertEquals(metricsDue({ finishedAt: fin }, t + 60_000), false)
  assertEquals(metricsDue({ finishedAt: fin }, t + 3 * 60_000), true)
  assertEquals(metricsDue({ finishedAt: fin, metricsNote: 'no' }, t + 3 * 60_000), false)
  assertEquals(metricsDue({ finishedAt: fin }, t + 7 * 3600_000), false)
})

Deno.test('the plan pads the run, bounds the step and selects the app pods in its namespace', () => {
  const plan = metricsPlan({ app: 'cart', namespace: 'shop-test', startedAt: '2026-10-22T09:50:00Z', finishedAt: '2026-10-22T10:00:00Z' })!
  assertEquals(plan.window.start, Date.parse('2026-10-22T09:48:00Z'))
  assertEquals(plan.window.end, Date.parse('2026-10-22T10:02:00Z'))
  assertEquals(plan.window.stepSeconds, 15)
  assertEquals(plan.queries.length, 7)
  assert(plan.selector.includes('pod=~"cart-[a-z0-9]+-[a-z0-9]+"'))
  // A Job that ran for days is capped to the last three hours.
  const long = metricsPlan({ app: 'cart', namespace: 'n', startedAt: '2026-10-19T10:00:00Z', finishedAt: '2026-10-22T10:00:00Z' })!
  assertEquals(long.window.end - long.window.start, 3 * 3600_000)
})

Deno.test('assembled metrics are compact, bounded, restarts are deltas and gaps are named', () => {
  const plan = metricsPlan({ app: 'cart', namespace: 'shop-test', startedAt: '2026-10-22T09:50:00Z', finishedAt: '2026-10-22T10:00:00Z' })!
  const t0 = plan.window.start / 1000
  const matrix = (n: number, f: (i: number) => number) => [{ values: Array.from({ length: n }, (_, i) => [t0 + i * 5, String(f(i))] as [number, string]) }]
  const phases = phasesForRun(parseRunnerTimeline(RUN_LOG, 'cart'), '2026-10-22T09:53:30Z')
  const m = assembleMetrics(plan, {
    rps: matrix(500, (i) => 10 + Math.sin(i)),
    errors: [],
    p95: { error: 'HTTP 503' },
    ready: matrix(60, (i) => (i > 20 && i < 30 ? 1 : 2)),
    restarts: matrix(60, (i) => (i < 25 ? 7 : 8)),
    cpu: matrix(3, () => 0.25),
    memory: [{ values: [[t0, '1e8']] }],
  }, phases, Date.parse('2026-10-22T10:05:00Z'))
  assertEquals(m.series.map((s) => s.id), ['rps', 'probe', 'ready', 'restarts', 'cpu'])
  for (const s of m.series) assert(s.points.length <= MAX_POINTS)
  assertEquals(m.series.find((s) => s.id === 'restarts')!.points.at(-1)![1], 1)
  assertEquals(m.missing?.map((x) => x.id), ['errors', 'p95', 'memory'])
  assert(m.missing![1].reason.includes('HTTP 503'))
  assert(JSON.stringify(m).length < 20_000)
  assertEquals(metricsEmpty(m), false)
  assertEquals(metricsEmpty(assembleMetrics(plan, { rps: [] }, phases)), true)
})
