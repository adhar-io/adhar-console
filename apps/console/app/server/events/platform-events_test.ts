import { assertEquals } from 'jsr:@std/assert'
import { remember, SOURCES, watchHandlers } from './platform-events.ts'

/**
 * The signal functions are the whole judgement of this feature: which platform
 * states are worth a notification, and — just as important — which are not.
 * They are pure, so they are testable without a cluster, and worth testing
 * because the failure mode of getting them wrong is not a crash. It is a feed
 * that either cries wolf or stays silent through an outage.
 */

const by = (id: string) => {
  const s = SOURCES.find((x) => x.id === id)
  if (!s) throw new Error(`no source ${id}`)
  return s
}

const app = (health: string, sync: string) => ({
  metadata: { name: 'payments-api', namespace: 'argocd' },
  status: { health: { status: health }, sync: { status: sync, revision: 'abc1234def' } },
})
const run = (status: string, reason = 'Completed') => ({
  metadata: { name: 'build-42', namespace: 'ci' },
  status: { conditions: [{ type: 'Succeeded', status, reason, message: 'm' }] },
})
const wf = (phase: string) => ({ metadata: { name: 'etl-9', namespace: 'data' }, status: { phase } })
const ev = (reason: string, count: number) => ({
  metadata: { name: 'e1', namespace: 'payments' },
  reason,
  count,
  message: 'msg',
  involvedObject: { kind: 'Pod', name: 'payments-api-x', namespace: 'payments' },
})

Deno.test('Argo CD: degraded alarms, healthy+synced reassures, drift warns, in-flight is silent', () => {
  assertEquals(by('argocd').signal(app('Degraded', 'Synced'))?.doc.kind, 'error')
  assertEquals(by('argocd').signal(app('Healthy', 'Synced'))?.doc.kind, 'success')
  assertEquals(by('argocd').signal(app('Healthy', 'OutOfSync'))?.doc.kind, 'warning')
  // Progressing is what a deploy looks like while it works. Announcing it
  // would notify on every rollout twice — once going out, once arriving.
  assertEquals(by('argocd').signal(app('Progressing', 'Synced')), null)
})

Deno.test('Argo CD: control-plane apps are titled by app and environment, not the Argo CD name', () => {
  const a = app('Degraded', 'Synced') as Record<string, unknown>
  a.metadata = { name: 'adhar-qua-service-dev', namespace: 'adhar-system', labels: { 'adhar.io/application': 'qua-service', 'adhar.io/environment': 'dev' } }
  const sig = by('argocd').signal(a as never)
  assertEquals(sig?.doc.title, 'qua-service (dev) is degraded')
  assertEquals(sig?.doc.href, '/deliver?section=apps&app=adhar-qua-service-dev')
})

Deno.test('Argo CD: the signature tracks health AND sync, so either transition notifies', () => {
  assertEquals(by('argocd').signal(app('Degraded', 'OutOfSync'))?.signature, 'Degraded/OutOfSync')
  assertEquals(by('argocd').signal(app('Degraded', 'Synced'))?.signature, 'Degraded/Synced')
})

Deno.test('Tekton: a run starts once (however its in-flight reason churns), then ends', () => {
  const started = by('tekton').signal(run('Unknown', 'Started'))
  assertEquals(started?.doc.kind, 'info')
  assertEquals(started?.doc.severity, 'low')
  assertEquals(started?.doc.title, 'Pipeline build-42 started')
  assertEquals(by('tekton').signal(run('Unknown', 'Running'))?.signature, started?.signature)
  // Tekton has not picked it up yet: no status at all is still "started".
  assertEquals(by('tekton').signal({ metadata: { name: 'build-43', namespace: 'ci' } })?.signature, started?.signature)
  assertEquals(by('tekton').signal(run('True'))?.signature === started?.signature, false)
  assertEquals(started?.doc.href, '/develop?section=builds&run=ci%2Fbuild-42')
})

Deno.test('Tekton: titles name the app the run builds', () => {
  const r = run('False', 'Failed') as Record<string, unknown>
  r.metadata = { name: 'app-ci-qua-service-qdpvc', namespace: 'adhar-system', labels: { 'adhar.io/app': 'qua-service', 'tekton.dev/pipeline': 'app-ci' } }
  assertEquals(by('tekton').signal(r as never)?.doc.title, 'Build of qua-service failed')
})

Deno.test('Tekton: only failures ask Adhar AI', () => {
  assertEquals(by('tekton').signal(run('True'))?.doc.kind, 'success')
  assertEquals(by('tekton').signal(run('False', 'Failed'))?.doc.kind, 'error')
  assertEquals(typeof by('tekton').signal(run('False', 'Failed'))?.doc.prompt, 'string')
  // A pipeline that passed needs no investigation offered.
  assertEquals(by('tekton').signal(run('True'))?.doc.prompt, undefined)
})

Deno.test('Warning events: allowlisted reasons only, and repeat thresholds hold', () => {
  assertEquals(by('k8s-events').signal(ev('Scheduled', 9)), null)
  assertEquals(by('k8s-events').signal(ev('OOMKilling', 1))?.doc.severity, 'high')
  // A single BackOff is a container restarting once; three is a loop.
  assertEquals(by('k8s-events').signal(ev('BackOff', 2)), null)
  assertEquals(by('k8s-events').signal(ev('BackOff', 3))?.doc.kind, 'warning')
  assertEquals(by('k8s-events').signal(ev('Unhealthy', 4)), null)
  assertEquals(by('k8s-events').signal(ev('Unhealthy', 5))?.doc.kind, 'warning')
})

Deno.test('Warning events: counts bucket, so a recurring event escalates instead of repeating', () => {
  const sig = (n: number) => by('k8s-events').signal(ev('BackOff', n))?.signature
  // Same bucket → the watcher sees no transition → no second notification.
  assertEquals(sig(3), sig(9))
  assertEquals(sig(10), 'BackOff/10+')
  assertEquals(sig(150), 'BackOff/100+')
  // And crossing a bucket IS a transition, which is the point: it got worse.
  assertEquals(sig(9) === sig(10), false)
})

Deno.test('remember: an object seen for the first time is news', () => {
  // This is the bug that would silence almost the whole feature if inverted.
  // A PipelineRun is untracked while it runs — signal() returns null — so the
  // failure that ends it is the FIRST signature it ever has. If a first
  // sighting were suppressed, no pipeline failure would ever notify.
  assertEquals(remember('t1/run-a', 'False/Failed'), true)
  assertEquals(remember('t1/run-a', 'False/Failed'), false, 'repeat of the same state is not news')
  assertEquals(remember('t1/run-a', 'True/Completed'), true, 'a transition is news')
})

Deno.test('remember: distinct keys do not shadow each other', () => {
  assertEquals(remember('t2/app-a', 'Degraded/Synced'), true)
  assertEquals(remember('t2/app-b', 'Degraded/Synced'), true)
  assertEquals(remember('t2/app-a', 'Degraded/Synced'), false)
})

Deno.test('every source emits a dedupe key and a link to the thing it is about', () => {
  const probe: Record<string, unknown> = {
    argocd: app('Degraded', 'Synced'),
    tekton: run('False', 'Failed'),
    'k8s-events': ev('OOMKilling', 1),
  }
  // The delivery and control-plane sources have their own, richer probes in
  // delivery-sources_test.ts and control-plane-sources_test.ts.
  for (const source of SOURCES.filter((s) => s.id in probe)) {
    const signal = source.signal(probe[source.id] as never)
    if (!signal) throw new Error(`${source.id} produced no signal for its probe`)
    // `key` is what stops a 6-hour re-notify storm in `emitNotification`.
    assertEquals(typeof signal.doc.key, 'string', `${source.id} must set a dedupe key`)
    assertEquals(typeof signal.doc.href, 'string', `${source.id} must link somewhere`)
    assertEquals(typeof signal.doc.title, 'string', `${source.id} must have a title`)
  }
})

Deno.test('watcher: priming is silent, a transition emits once, a no-op resync emits nothing, DELETED reports', async () => {
  const xr = SOURCES.filter((s) => s.id === 'xr-databases')
  const emitted: string[] = []
  const h = watchHandlers(xr, { since: Date.parse('2026-10-22T14:00:00Z') }, (_o, s) => {
    emitted.push(String(s.doc.title))
    return Promise.resolve()
  })
  const db = (uid: string, created: string, ready?: string) => ({
    metadata: { name: `db-${uid}`, namespace: 'dev', uid, creationTimestamp: created },
    ...(ready ? { status: { conditions: [{ type: 'Synced', status: 'True' }, { type: 'Ready', status: ready }] } } : {}),
  })
  await h.upsert(db('w1', '2026-10-22T11:00:00Z', 'True'), { priming: true })
  assertEquals(emitted, [], 'the priming list announces nothing')
  await h.upsert(db('w1', '2026-10-22T11:00:00Z', 'True'), { priming: false })
  assertEquals(emitted, [], 'a resync of the same state is not news')
  await h.upsert(db('w2', '2026-10-22T14:30:00Z'), { priming: false })
  await h.upsert(db('w2', '2026-10-22T14:30:00Z', 'False'), { priming: false })
  await h.upsert(db('w2', '2026-10-22T14:30:00Z', 'True'), { priming: false })
  await h.upsert(db('w2', '2026-10-22T14:30:00Z', 'True'), { priming: false })
  // A composed resource flapping Ready → Creating → Ready is neither a new
  // object nor a new readiness.
  await h.upsert(db('w2', '2026-10-22T14:30:00Z', 'False'), { priming: false })
  await h.upsert(db('w2', '2026-10-22T14:30:00Z', 'True'), { priming: false })
  assertEquals(emitted, ['Database db-w2 created', 'Database db-w2 is ready'])
  h.remove(db('w2', '2026-10-22T14:30:00Z', 'True'))
  assertEquals(emitted.at(-1), 'Database db-w2 deleted')
})

Deno.test('watcher: two sources on one object keep separate signatures', async () => {
  const group = SOURCES.filter((s) => s.id === 'argocd' || s.id === 'argocd-sync')
  const emitted: string[] = []
  const h = watchHandlers(group, {}, (_o, s) => {
    emitted.push(String(s.doc.title))
    return Promise.resolve()
  })
  const a = (phase: string) => ({
    metadata: { name: 'adhar-cart-dev', namespace: 'adhar-system', uid: 'shared-1', labels: { 'adhar.io/application': 'cart', 'adhar.io/environment': 'dev' } },
    status: { health: { status: 'Healthy' }, sync: { status: 'Synced', revision: 'abc1234' }, operationState: { phase, startedAt: '2026-10-22T15:00:00Z' } },
  })
  await h.upsert(a('Running'), { priming: false })
  await h.upsert(a('Running'), { priming: false })
  await h.upsert(a('Succeeded'), { priming: false })
  // Keyed by uid alone, the health signature would overwrite the sync one and
  // each update would re-announce both.
  assertEquals(emitted, ['cart (dev) is synced and healthy', 'cart sync to dev started', 'cart synced to dev at abc1234'])
})
