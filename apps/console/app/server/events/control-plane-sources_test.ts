import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert'
import { CONTROL_PLANE_SOURCES, XR_KINDS } from './control-plane-sources.ts'
import type { KubeObject } from './signal-kit.ts'

/**
 * Control-plane XRs, nodes, the autoscaler and the resilience gate, against
 * objects copied (and trimmed) from a live cluster on 2026-10-22.
 */

const by = (id: string) => {
  const s = CONTROL_PLANE_SOURCES.find((x) => x.id === id)
  if (!s) throw new Error(`no source ${id}`)
  return s
}
const START = Date.parse('2026-10-22T14:00:00Z')

/* ─────────────────────────── XRs ─────────────────────────── */

const cond = (type: string, status: string, reason: string, message = '') => ({ type, status, reason, message, lastTransitionTime: '2026-10-22T13:15:09Z' })
const appXR = (created: string, conditions: unknown[] = []) => ({
  apiVersion: 'platform.adhar.io/v1alpha1',
  kind: 'Application',
  metadata: {
    name: 'bot-service',
    namespace: 'adhar-system',
    uid: 'x1',
    creationTimestamp: created,
    labels: { 'adhar.io/application': 'bot-service', 'adhar.io/project': 'adhar', 'crossplane.io/composite': 'bot-service' },
  },
  spec: { parameters: { project: 'adhar' } },
  ...(conditions.length ? { status: { conditions } } : {}),
})

Deno.test('XR: created → ready → failed, each once, titled by kind and app', () => {
  const s = by('xr-applications')
  const created = s.signal(appXR('2026-10-22T14:15:09Z'), { since: START })
  assertEquals(created?.doc.title, 'Application bot-service created')
  assertEquals(created?.doc.kind, 'info')
  assertEquals(created?.doc.href, '/catalog?entity=component%3Abot-service&tab=deploy')

  const ready = s.signal(appXR('2026-10-22T14:15:09Z', [cond('Synced', 'True', 'ReconcileSuccess'), cond('Ready', 'True', 'Available')]), { since: START, previous: 'created' })
  assertEquals(ready?.doc.title, 'Application bot-service is ready')
  assertEquals(ready?.doc.kind, 'success')

  const failed = s.signal(appXR('2026-10-22T14:15:09Z', [
    cond('Synced', 'False', 'ReconcileError', 'cannot compose resources: cannot render composed resource "argocd-dev"'),
    cond('Ready', 'True', 'Available'),
  ]), { since: START, previous: 'ready' })
  assertEquals(failed?.doc.title, 'Application bot-service failed')
  assertEquals(failed?.doc.kind, 'error')
  assertStringIncludes(String(failed?.doc.description ?? ''), 'cannot compose')
  assertStringIncludes(String(failed?.doc.prompt ?? ''), 'adhar-system/bot-service')
  assert(created?.signature !== ready?.signature && ready?.signature !== failed?.signature)
})

Deno.test('XR: an object older than the watcher is never announced as created', () => {
  const s = by('xr-applications')
  assertEquals(s.signal(appXR('2026-10-22T13:15:09Z'), { since: START }), null)
  // Still creating, Ready=False/Creating — not a failure, and not new.
  assertEquals(s.signal(appXR('2026-10-22T13:15:09Z', [cond('Synced', 'True', 'ReconcileSuccess'), cond('Ready', 'False', 'Creating', 'Unready resources: gitea-team')]), { since: START }), null)
})

Deno.test('XR: once tracked, an in-progress flap is not "created" again', () => {
  const flapped = appXR('2026-10-22T14:15:09Z', [cond('Synced', 'True', 'ReconcileSuccess'), cond('Ready', 'False', 'Creating')])
  assertEquals(by('xr-applications').signal(flapped, { since: START, previous: 'ready' }), null)
})

Deno.test('XR: a Release is titled by what it releases, and deletion is reported', () => {
  const release = {
    apiVersion: 'platform.adhar.io/v1alpha1',
    kind: 'Release',
    metadata: { name: 'qua-service-prod-7', namespace: 'adhar-system', uid: 'rel1', creationTimestamp: '2026-10-22T14:30:00Z' },
    spec: { parameters: { project: 'adhar', application: 'qua-service', environment: 'prod', freight: '0fd5b96b4c2287d27d5a21eb31a4f3003655c41e' } },
  }
  const s = by('xr-releases')
  assertEquals(s.signal(release, { since: START })?.doc.title, 'Release of qua-service to prod created')
  assertEquals(s.signal(release, { since: START })?.doc.href, '/deliver?section=releases')
  const gone = s.removed?.(release)
  assertEquals(gone?.doc.title, 'Release of qua-service to prod deleted')
  assertEquals(gone?.doc.kind, 'warning')
})

Deno.test('XR: every control-plane kind has a source with created/ready/deleted', () => {
  for (const { kind, plural } of XR_KINDS) {
    const s = by(`xr-${plural}`)
    assertEquals(s.group, 'platform.adhar.io')
    const obj = { metadata: { name: 'n', namespace: 'ns', uid: 'u', creationTimestamp: '2026-10-22T14:30:00Z' } }
    assertStringIncludes(s.signal(obj, { since: START })?.doc.title ?? '', 'created', kind)
    assertStringIncludes(s.removed?.(obj)?.doc.title ?? '', 'deleted', kind)
  }
})

/* ─────────────────────────── nodes ─────────────────────────── */

const node = (created: string) => ({
  apiVersion: 'v1',
  kind: 'Node',
  metadata: {
    name: 'adhar-worker-workers-5',
    uid: 'n1',
    creationTimestamp: created,
    labels: { 'kubernetes.io/hostname': 'adhar-worker-workers-5', 'node.kubernetes.io/instance-type': 'Standard_E4bds_v5' },
  },
})

Deno.test('Nodes: a node that joined after the watcher started is announced once; boot-time nodes are not', () => {
  const s = by('nodes')
  const joined = s.signal(node('2026-10-22T14:30:00Z'), { since: START })
  assertEquals(joined?.doc.title, 'Node adhar-worker-workers-5 joined the cluster')
  assertStringIncludes(String(joined?.doc.description ?? ''), 'Standard_E4bds_v5')
  assertEquals(s.signal(node('2026-10-22T14:30:00Z'), { since: START, previous: 'joined' })?.signature, 'joined')
  assertEquals(s.signal(node('2026-10-22T11:00:00Z'), { since: START }), null)
  assertEquals(s.removed?.(node('2026-10-22T11:00:00Z'))?.doc.title, 'Node adhar-worker-workers-5 left the cluster')
})

/* ─────────────────────────── autoscaler ─────────────────────────── */

const scaleEvent = (reason: string, message: string, count = 1) => ({
  apiVersion: 'v1',
  kind: 'Event',
  metadata: { name: 'prod.18a0', namespace: 'adhar-system', uid: `e-${reason}-${message.length}` },
  involvedObject: { apiVersion: 'platform.adhar.io/v1alpha1', kind: 'AdharPlatform', name: 'prod', namespace: 'adhar-system' },
  reason,
  message,
  count,
  type: reason.endsWith('Failed') || reason === 'ScaleUpMadeNoProgress' ? 'Warning' : 'Normal',
})

Deno.test('Autoscaler: scaling decisions inform, failures alarm with a prompt', () => {
  const s = by('autoscaler-events')
  assertEquals(s.search?.fieldSelector, 'involvedObject.kind=AdharPlatform')
  const up = s.signal(scaleEvent('ScalingUp', '3 pod(s) unschedulable for capacity (e.g. adhar-system/chi-posthog-posthog-0-0-0); adding a worker (8/8)'))
  assertEquals(up?.doc.title, 'Cluster prod is adding a worker')
  assertEquals(up?.doc.kind, 'info')
  assertEquals(up?.doc.prompt, undefined)
  const failed = s.signal(scaleEvent('ScaleUpFailed', 'ScaleUp failed: tracker lacks network resources; cannot add workers'))
  assertEquals(failed?.doc.kind, 'error')
  assertEquals(typeof failed?.doc.prompt, 'string')
  assertEquals(s.signal(scaleEvent('ScaleUpMadeNoProgress', 'worker adhar-worker-workers-3 never joined'))?.doc.kind, 'warning')
  assertEquals(s.signal(scaleEvent('ScalingDown', 'node idle; removing adhar-worker-workers-4 (4/3)'))?.doc.title, 'Cluster prod is removing a worker')
  assertEquals(s.signal(scaleEvent('SomethingElse', 'x')), null)
})

Deno.test('Autoscaler: a tick-by-tick scale-up storm shares one dedupe key per target', () => {
  const s = by('autoscaler-events')
  const a = s.signal(scaleEvent('ScalingUp', '4 pod(s) unschedulable for capacity (e.g. adhar-system/airbyte-server-68c98fc9c8-kvlbm); adding a worker (8/8)'))
  const b = s.signal(scaleEvent('ScalingUp', '2 pod(s) unschedulable for capacity (e.g. adhar-system/posthog-bootstrap-lscqv); adding a worker (8/8)'))
  assertEquals(a?.doc.key, b?.doc.key)
  const c = s.signal(scaleEvent('ScalingUp', '2 pod(s) unschedulable; adding a worker (9/10)'))
  assert(c?.doc.key !== a?.doc.key, 'a new target is a new step')
})

/* ─────────────────────────── resilience gate ─────────────────────────── */

const gateJob = (ns: string, conditions: unknown[]) => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: {
    name: 'adhar-gate-qua-service-dev-48213',
    namespace: ns,
    uid: 'j1',
    labels: { 'adhar.io/component': 'scorecards', 'adhar.io/resilience-gate': 'qua-service' },
  },
  spec: {
    template: {
      spec: {
        containers: [{
          name: 'runner',
          env: [{ name: 'VERIFY_APP', value: 'qua-service' }, { name: 'VERIFY_NAMESPACE', value: 'dev' }, { name: 'VERIFY_ENVIRONMENT', value: 'dev' }],
        }],
      },
    },
  },
  status: { conditions },
})

Deno.test('Resilience gate: passed and failed are reported once, only for the adhar-system runner', () => {
  const s = by('resilience-gate')
  assertEquals(s.search?.labelSelector, 'adhar.io/resilience-gate')
  const passed = s.signal(gateJob('adhar-system', [{ type: 'Complete', status: 'True' }]))
  assertEquals(passed?.doc.title, 'qua-service passed the resilience gate for dev')
  assertEquals(passed?.doc.href, '/deliver?section=performance&view=readiness&app=qua-service')
  const failed = s.signal(gateJob('adhar-system', [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' }]))
  assertEquals(failed?.doc.title, 'qua-service failed the resilience gate for dev')
  assertEquals(failed?.doc.kind, 'error')
  assertEquals(typeof failed?.doc.prompt, 'string')
  // Running: nothing yet. The Kargo wrapper Job in the project namespace: never.
  assertEquals(s.signal(gateJob('adhar-system', [])), null)
  assertEquals(s.signal(gateJob('adhar', [{ type: 'Complete', status: 'True' }])), null)
})

Deno.test('every control-plane signal is idempotent and fully addressed', () => {
  const probes: Array<[string, KubeObject]> = [
    ['xr-applications', appXR('2026-10-22T14:15:09Z', [cond('Synced', 'False', 'ReconcileError', 'boom')])],
    ['nodes', node('2026-10-22T14:30:00Z')],
    ['autoscaler-events', scaleEvent('ScaleUpFailed', 'quota')],
    ['resilience-gate', gateJob('adhar-system', [{ type: 'Failed', status: 'True' }])],
  ]
  for (const [id, obj] of probes) {
    const a = by(id).signal(obj, { since: START })
    const b = by(id).signal(structuredClone(obj), { since: START })
    assert(a, `${id} produced no signal for its probe`)
    assertEquals(a.signature, b?.signature, id)
    assertEquals(typeof a.doc.key, 'string', `${id} must set a dedupe key`)
    assertEquals(typeof a.doc.href, 'string', `${id} must link somewhere`)
    assert(a.doc.target?.label, `${id} must name its target`)
  }
})
