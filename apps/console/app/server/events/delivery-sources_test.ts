import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert'
import { DELIVERY_SOURCES } from './delivery-sources.ts'
import { groupByWatch, SOURCES } from './platform-events.ts'
import type { KubeObject, SignalContext } from './signal-kit.ts'

/**
 * The delivery lifecycle's signal functions, against objects copied (and
 * trimmed) from a live cluster on 2026-10-22. The rule every test here holds a
 * source to: one occurrence produces one notification per state, a resync of
 * the same state produces nothing, and the title names the APP.
 */

const by = (id: string) => {
  const s = DELIVERY_SOURCES.find((x) => x.id === id)
  if (!s) throw new Error(`no source ${id}`)
  return s
}
const clone = <T>(o: T): T => structuredClone(o)

/* ─────────────────────────── Argo CD sync ─────────────────────────── */

const argoApp = (phase: string, startedAt = '2026-10-22T14:23:17Z') => ({
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Application',
  metadata: {
    name: 'adhar-qua-service-dev',
    namespace: 'adhar-system',
    uid: 'a1',
    labels: { 'adhar.io/application': 'qua-service', 'adhar.io/environment': 'dev', 'adhar.io/project': 'adhar' },
  },
  status: {
    health: { status: 'Healthy' },
    sync: { status: 'Synced', revision: 'dd7e446802332ab8d61d8b9d2cb86349e1f561dc' },
    operationState: {
      phase,
      startedAt,
      message: phase === 'Failed' ? 'one or more objects failed to apply, reason: Deployment.apps "x" is invalid' : 'successfully synced (all tasks run)',
      operation: {
        initiatedBy: { automated: true, username: 'kargo-controller' },
        info: [{ name: 'kargo.akuity.io/promotion', value: 'dev.01m5hzx62szeka29v7jss58dns.0fd5b96' }],
      },
      syncResult: { revision: 'dd7e446802332ab8d61d8b9d2cb86349e1f561dc' },
    },
  },
})

Deno.test('Argo CD sync: one operation is one start and one outcome, keyed by startedAt', () => {
  const s = by('argocd-sync')
  const running = s.signal(argoApp('Running'))
  const done = s.signal(argoApp('Succeeded'))
  assertEquals(running?.doc.kind, 'info')
  assertEquals(running?.doc.title, 'qua-service sync to dev started')
  assertStringIncludes(String(running?.doc.description ?? ''), 'promotion dev.01m5hzx62szeka29v7jss58dns.0fd5b96')
  assertEquals(done?.doc.kind, 'success')
  assertEquals(done?.doc.title, 'qua-service synced to dev at dd7e446')
  assert(running?.signature !== done?.signature, 'start → result is a transition')
  // A resync of the same finished operation is the same signature: no news.
  assertEquals(s.signal(argoApp('Succeeded'))?.signature, done?.signature)
  // A NEW operation is new news even if it ends the same way.
  assert(s.signal(argoApp('Succeeded', '2026-10-22T15:00:00Z'))?.signature !== done?.signature)
  assertEquals(done?.doc.href, '/deliver?section=apps&app=adhar-qua-service-dev')
})

Deno.test('Argo CD sync: a failure carries the reason and an Ask-AI prompt', () => {
  const failed = by('argocd-sync').signal(argoApp('Failed'))
  assertEquals(failed?.doc.kind, 'error')
  assertEquals(failed?.doc.title, 'Sync of qua-service (dev) failed')
  assertStringIncludes(String(failed?.doc.description ?? ''), 'failed to apply')
  assertEquals(typeof failed?.doc.prompt, 'string')
})

Deno.test('Argo CD sync: platform packages only report failed syncs (a packages push syncs ~80 of them)', () => {
  const pkg = (phase: string) => {
    const a = argoApp(phase)
    a.metadata = { name: 'keycloak', namespace: 'adhar-system', uid: 'k1', labels: {} as never }
    return a
  }
  assertEquals(by('argocd-sync').signal(pkg('Running')), null)
  assertEquals(by('argocd-sync').signal(pkg('Succeeded')), null)
  assertEquals(by('argocd-sync').signal(pkg('Failed'))?.doc.title, 'Sync of keycloak failed')
})

Deno.test('Argo CD health and sync share one watch on applications', () => {
  const group = groupByWatch(SOURCES).find((g) => g.some((s) => s.id === 'argocd'))
  assertEquals(group?.map((s) => s.id).sort(), ['argocd', 'argocd-sync'])
  // …and nothing else is merged with a different selector: the Warning events
  // watch and the autoscaler's events watch must stay separate.
  const events = groupByWatch(SOURCES).filter((g) => g[0].resource === 'events')
  assertEquals(events.length, 2)
})

/* ─────────────────────────── Kargo Freight ─────────────────────────── */

const freight = (created: string) => ({
  apiVersion: 'kargo.akuity.io/v1alpha1',
  kind: 'Freight',
  alias: 'veering-beetle',
  images: [{
    digest: 'sha256:70a353a0238581ae0f2fabee31543b7fc9041b6119961461adde9a7ed2ea476b',
    repoURL: 'harbor-core.adhar-system.svc.cluster.local/library/qua-service',
    tag: '72ad021fd35d288e3790513ccd703b452fc372c9',
  }],
  metadata: {
    creationTimestamp: created,
    labels: { 'kargo.akuity.io/alias': 'veering-beetle' },
    name: '0fd5b96b4c2287d27d5a21eb31a4f3003655c41e',
    namespace: 'adhar',
    uid: 'f1',
  },
  origin: { kind: 'Warehouse', name: 'qua-service' },
  status: { currentlyIn: { dev: { since: '2026-10-22T14:23:19Z' } } },
})
const START = Date.parse('2026-10-22T14:00:00Z')

Deno.test('Freight: a build discovered after the watcher started is announced by app and image', () => {
  const sig = by('kargo-freight').signal(freight('2026-10-22T14:23:11Z'), { since: START })
  assertEquals(sig?.doc.title, 'New build qua-service:72ad021 of qua-service is available')
  assertStringIncludes(String(sig?.doc.description ?? ''), 'veering-beetle')
  assertEquals(sig?.doc.href, '/deliver?section=releases')
  // Its status moving between stages later is not a new build.
  const moved = freight('2026-10-22T14:23:11Z') as Record<string, unknown>
  moved.status = { currentlyIn: { dev: {}, test: {} } }
  assertEquals(by('kargo-freight').signal(moved as KubeObject, { since: START })?.signature, sig?.signature)
})

Deno.test('Freight: older than the watcher is history, not news', () => {
  assertEquals(by('kargo-freight').signal(freight('2026-10-22T12:01:00Z'), { since: START }), null)
})

/* ─────────────────────────── Kargo Promotion ─────────────────────────── */

const promotion = (phase: string, message?: string) => ({
  apiVersion: 'kargo.akuity.io/v1alpha1',
  kind: 'Promotion',
  metadata: {
    name: 'dev.01m5hzx62szeka29v7jss58dns.0fd5b96',
    namespace: 'adhar',
    uid: 'p1',
    labels: { 'kargo.akuity.io/stage': 'dev' },
  },
  spec: { freight: '0fd5b96b4c2287d27d5a21eb31a4f3003655c41e', stage: 'dev' },
  status: {
    phase,
    ...(message ? { message } : {}),
    startedAt: '2026-10-22T14:23:12Z',
    freight: {
      name: '0fd5b96b4c2287d27d5a21eb31a4f3003655c41e',
      origin: { kind: 'Warehouse', name: 'qua-service' },
      images: [{ repoURL: 'harbor-core.adhar-system.svc.cluster.local/library/qua-service', tag: '72ad021fd35d288e3790513ccd703b452fc372c9' }],
    },
  },
})
const aliases: SignalContext = { freightAlias: (n) => (n.startsWith('0fd5b96') ? 'veering-beetle' : undefined) }

Deno.test('Promotion: started then succeeded, titled by app and stage with alias and image', () => {
  const s = by('kargo-promotion')
  assertEquals(s.signal(promotion('Pending'), aliases), null, 'queued is not started')
  const started = s.signal(promotion('Running'), aliases)
  const ok = s.signal(promotion('Succeeded'), aliases)
  assertEquals(started?.doc.title, 'Promoting qua-service to dev')
  assertEquals(ok?.doc.title, 'qua-service promoted to dev')
  assertEquals(ok?.doc.kind, 'success')
  assertEquals(ok?.doc.description, 'freight veering-beetle · qua-service:72ad021')
  assert(started?.signature !== ok?.signature)
  assertEquals(s.signal(promotion('Succeeded'), aliases)?.signature, ok?.signature, 'a resync is not news')
  assertEquals(ok?.doc.prompt, undefined)
})

Deno.test('Promotion: failed and errored are errors with the message and a prompt', () => {
  for (const phase of ['Failed', 'Errored']) {
    const sig = by('kargo-promotion').signal(promotion(phase, 'step "push-qua-service" failed: rejected'), aliases)
    assertEquals(sig?.doc.kind, 'error', phase)
    assertStringIncludes(String(sig?.doc.title ?? ''), 'Promotion of qua-service to dev')
    assertEquals(sig?.doc.description, 'step "push-qua-service" failed: rejected')
    assertEquals(typeof sig?.doc.prompt, 'string')
  }
})

/* ─────────────────────────── Kargo Stage verification ─────────────────────────── */

const items = {
  'Warehouse/bot-service': { name: 'e3f49d0', origin: { kind: 'Warehouse', name: 'bot-service' } },
  'Warehouse/qua-service': { name: '0fd5b96', origin: { kind: 'Warehouse', name: 'qua-service' } },
  'Warehouse/transaction-service': { name: '46ac7a5', origin: { kind: 'Warehouse', name: 'transaction-service' } },
}
const stage = (verification?: Record<string, unknown>) => ({
  apiVersion: 'kargo.akuity.io/v1alpha1',
  kind: 'Stage',
  metadata: { name: 'dev', namespace: 'adhar', uid: 's1', labels: { 'adhar.io/environment': 'dev' } },
  status: {
    freightHistory: [{ id: '2d012afffa418a5034c4094814299f53472d2372', items, ...(verification ? { verificationHistory: [verification] } : {}) }],
    lastPromotion: { freight: { origin: { kind: 'Warehouse', name: 'qua-service' } } },
  },
})
const failedVerification = {
  analysisRun: { name: 'dev.01m5hy75chzgfsm6d2ya9vv9ms.2d012af', namespace: 'adhar', phase: 'Failed' },
  finishTime: '2026-10-22T13:56:41Z',
  id: '8f7faa47-0fe3-49cc-b4a8-0d4861707806',
  message: 'Metric "bot-service-rollout-healthy" assessed Failed due to failed (2) > failureLimit (1)',
  phase: 'Failed',
  startTime: '2026-10-22T13:53:41Z',
}

Deno.test('Verification: a failure names the app from the failing metric, not the last promotion', () => {
  const sig = by('kargo-verification').signal(stage(failedVerification))
  assertEquals(sig?.doc.kind, 'error')
  assertEquals(sig?.doc.title, 'Verification failed for bot-service in dev')
  assertStringIncludes(String(sig?.doc.description ?? ''), 'failureLimit')
  assertStringIncludes(String(sig?.doc.prompt ?? ''), 'dev.01m5hy75chzgfsm6d2ya9vv9ms.2d012af')
  assertEquals(sig?.doc.href, '/deliver?section=stages')
})

Deno.test('Verification: passes once per verification id; running and absent are silent', () => {
  const s = by('kargo-verification')
  assertEquals(s.signal(stage()), null)
  assertEquals(s.signal(stage({ id: 'v2', phase: 'Running' })), null)
  const passed = s.signal(stage({ id: 'v2', phase: 'Successful' }))
  assertEquals(passed?.doc.kind, 'success')
  // No metric named → falls back to the last promotion's app.
  assertEquals(passed?.doc.title, 'Verification passed for qua-service in dev')
  assertEquals(s.signal(stage({ id: 'v2', phase: 'Successful' }))?.signature, passed?.signature)
  assert(s.signal(stage({ id: 'v3', phase: 'Successful' }))?.signature !== passed?.signature, 'a new verification is news')
})

/* ─────────────────────────── Argo Rollouts ─────────────────────────── */

const rollout = (status: Record<string, unknown>, revision = '2') => ({
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Rollout',
  metadata: {
    name: 'gateway-service',
    namespace: 'dev',
    uid: 'r1',
    labels: { app: 'gateway-service' },
    annotations: { 'rollout.argoproj.io/revision': revision },
  },
  spec: {
    strategy: {
      canary: { steps: [{ setWeight: 25 }, { pause: { duration: '30s' } }, { setWeight: 50 }, { pause: {} }, { setWeight: 100 }] },
    },
  },
  status,
})
const nsCtx: SignalContext = {
  namespaceLabels: (ns) => (ns === 'dev' ? { 'adhar.io/environment': 'dev', 'adhar.io/project': 'adhar' } : undefined),
}

Deno.test('Rollouts: a new revision starts, then completes — once each', () => {
  const s = by('argo-rollouts')
  const started = s.signal(rollout({ phase: 'Progressing', currentPodHash: '5cd88799d8', stableRS: '689ffd8cf6', currentStepIndex: 0 }), nsCtx)
  assertEquals(started?.doc.title, 'gateway-service canary rollout started in dev (revision 2)')
  assertEquals(started?.doc.href, '/deliver?section=rollouts&app=adhar%2Fgateway-service&env=dev')
  const done = s.signal(rollout({ phase: 'Healthy', currentPodHash: '5cd88799d8', stableRS: '5cd88799d8' }), nsCtx)
  assertEquals(done?.doc.title, 'gateway-service rolled out to dev (revision 2)')
  assertEquals(done?.doc.kind, 'success')
  assertEquals(s.signal(rollout({ phase: 'Healthy', currentPodHash: '5cd88799d8', stableRS: '5cd88799d8', readyReplicas: 3 }), nsCtx)?.signature, done?.signature)
})

Deno.test('Rollouts: a timed canary pause is silent, an indefinite one warns', () => {
  const s = by('argo-rollouts')
  const paused = (step: number) =>
    s.signal(rollout({ phase: 'Paused', currentPodHash: '5cd88799d8', stableRS: '689ffd8cf6', currentStepIndex: step, pauseConditions: [{ reason: 'CanaryPauseStep' }] }), nsCtx)
  assertEquals(paused(1), null)
  assertEquals(paused(3)?.doc.kind, 'warning')
  assertEquals(paused(3)?.doc.title, 'gateway-service rollout paused in dev (revision 2)')
})

Deno.test('Rollouts: degraded and aborted are errors with the controller message and a prompt', () => {
  const s = by('argo-rollouts')
  const degraded = s.signal(rollout({
    phase: 'Degraded',
    currentPodHash: '5cd88799d8',
    stableRS: '689ffd8cf6',
    message: 'ProgressDeadlineExceeded: ReplicaSet "gateway-service-5cd88799d8" has timed out progressing.',
  }), nsCtx)
  assertEquals(degraded?.doc.title, 'gateway-service rollout degraded in dev (revision 2)')
  assertStringIncludes(String(degraded?.doc.description ?? ''), 'ProgressDeadlineExceeded')
  assertEquals(typeof degraded?.doc.prompt, 'string')
  const aborted = s.signal(rollout({ phase: 'Degraded', abort: true, currentPodHash: '5cd88799d8', stableRS: '689ffd8cf6' }), nsCtx)
  assertEquals(aborted?.doc.title, 'gateway-service rollout aborted in dev (revision 2)')
  assert(aborted?.signature !== degraded?.signature)
})

Deno.test('Rollouts: scaling a settled revision is not a rollout', () => {
  assertEquals(by('argo-rollouts').signal(rollout({ phase: 'Progressing', currentPodHash: 'abc', stableRS: 'abc' }), nsCtx), null)
})

Deno.test('every delivery signal is idempotent: the same object twice yields the same signature', () => {
  const probes: Array<[string, KubeObject, SignalContext?]> = [
    ['argocd-sync', argoApp('Running')],
    ['kargo-freight', freight('2026-10-22T14:23:11Z'), { since: START }],
    ['kargo-promotion', promotion('Succeeded'), aliases],
    ['kargo-verification', stage(failedVerification)],
    ['argo-rollouts', rollout({ phase: 'Degraded', currentPodHash: 'h', stableRS: 's' }), nsCtx],
  ]
  for (const [id, obj, ctx] of probes) {
    const a = by(id).signal(obj, ctx)
    const b = by(id).signal(clone(obj), ctx)
    assert(a, `${id} produced no signal for its probe`)
    assertEquals(a.signature, b?.signature, id)
    assertEquals(typeof a.doc.key, 'string', `${id} must set a dedupe key`)
    assertEquals(typeof a.doc.href, 'string', `${id} must link somewhere`)
    assert(a.doc.target?.label, `${id} must name its target`)
  }
})
