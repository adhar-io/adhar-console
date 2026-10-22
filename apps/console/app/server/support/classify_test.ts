import { assert, assertEquals } from 'jsr:@std/assert'
import { SOURCES } from '../events/platform-events.ts'
import type { KubeObject } from '../events/signal-kit.ts'
import { toNotification } from '../alertmanager.ts'
import type { NotificationDoc } from '../notify.ts'
import { classify, parseRef, workloadOfPod } from './classify.ts'
import { DEFAULT_SUPPORT_CONFIG, mergeSupportConfig } from './config.ts'

/**
 * Classification runs over what the REAL event sources emit for objects
 * copied (trimmed) from the live DigitalOcean cluster on 2026-10-22 — so a
 * source that changes its key grammar breaks these tests instead of quietly
 * opening one ticket per state transition.
 */

const src = (id: string) => {
  const s = SOURCES.find((x) => x.id === id)
  if (!s) throw new Error(`no source ${id}`)
  return s
}
const emit = (id: string, obj: unknown, ctx = {}): NotificationDoc => {
  const sig = src(id).signal(obj as KubeObject, ctx)
  if (!sig) throw new Error(`${id} emitted nothing`)
  return { ...sig.doc, at: '2026-10-22T16:00:00Z' } as NotificationDoc
}
const cfg = DEFAULT_SUPPORT_CONFIG

const argoApp = (health: string, sync = 'Synced') => ({
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Application',
  metadata: {
    name: 'adhar-gateway-service-dev',
    namespace: 'adhar-system',
    uid: 'u-argo',
    labels: { 'adhar.io/application': 'gateway-service', 'adhar.io/environment': 'dev', 'adhar.io/project': 'adhar' },
  },
  status: { health: { status: health }, sync: { status: sync, revision: '5063d91e7f9b0c43f6ce06eaf258e99e36f47c1a' } },
})

Deno.test('argocd: degraded opens, synced+healthy resolves the SAME incident', () => {
  const bad = emit('argocd', argoApp('Degraded'))
  const good = emit('argocd', argoApp('Healthy'))
  const open = classify(bad, 'platform-watcher', cfg)
  const res = classify(good, 'platform-watcher', cfg)
  assertEquals(open.action, 'open')
  assertEquals(res.action, 'resolve')
  if (open.action !== 'open' || res.action !== 'resolve') return
  assertEquals(open.ref.incidentId, 'argocd:adhar-system/adhar-gateway-service-dev')
  assertEquals(res.ref.incidentId, open.ref.incidentId)
  assertEquals(open.ref.app, 'gateway-service')
  assertEquals(open.ref.env, 'dev')
})

Deno.test('argocd: an OutOfSync drift notice (warning/medium) does not open a ticket', () => {
  const drift = emit('argocd', argoApp('Healthy', 'OutOfSync'))
  assertEquals(classify(drift, 'platform-watcher', cfg).action, 'ignore')
})

Deno.test('argocd-sync: a failed sync joins the app incident; a successful SYNC is not a recovery', () => {
  const app = {
    ...argoApp('Healthy'),
    status: {
      ...argoApp('Healthy').status,
      operationState: { phase: 'Failed', startedAt: '2026-10-22T14:23:17Z', message: 'one or more objects failed to apply' },
    },
  }
  const failed = emit('argocd-sync', app)
  const d = classify(failed, 'platform-watcher', cfg)
  assertEquals(d.action, 'open')
  if (d.action === 'open') assertEquals(d.ref.incidentId, 'argocd:adhar-system/adhar-gateway-service-dev')
  const ok = emit('argocd-sync', { ...app, status: { ...app.status, operationState: { ...app.status.operationState, phase: 'Succeeded' } } })
  assertEquals(classify(ok, 'platform-watcher', cfg).action, 'ignore')
})

const rollout = (phase: string, hash: string) => ({
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Rollout',
  metadata: { name: 'gateway-service', namespace: 'dev', uid: 'u-ro', labels: { app: 'gateway-service' }, annotations: { 'rollout.argoproj.io/revision': '4' } },
  spec: { strategy: { canary: { steps: [{ setWeight: 50 }] } } },
  status: { phase, currentPodHash: hash, stableRS: '689ffd8cf6', message: phase === 'Degraded' ? 'ProgressDeadlineExceeded: ReplicaSet "gateway-service-5cd88799d8" has timed out progressing.' : undefined },
})

Deno.test('rollout: degraded opens; a later healthy revision resolves it', () => {
  const ctx = { namespaceLabels: () => ({ 'adhar.io/environment': 'dev', 'adhar.io/project': 'adhar' }) }
  const bad = emit('argo-rollouts', rollout('Degraded', '5cd88799d8'), ctx)
  const good = emit('argo-rollouts', rollout('Healthy', '5cd88799d8'), ctx)
  const o = classify(bad, 'platform-watcher', cfg)
  const r = classify(good, 'platform-watcher', cfg)
  assert(o.action === 'open' && r.action === 'resolve')
  assertEquals(o.ref.incidentId, 'rollout:dev/gateway-service')
  assertEquals(r.ref.incidentId, o.ref.incidentId)
})

const run = (status: string, name: string) => ({
  apiVersion: 'tekton.dev/v1',
  kind: 'PipelineRun',
  metadata: { name, namespace: 'adhar-system', uid: name, labels: { 'adhar.io/app': 'qua-service', 'tekton.dev/pipeline': 'app-ci' } },
  status: { conditions: [{ type: 'Succeeded', status, reason: status === 'True' ? 'Succeeded' : 'Failed', message: 'Tasks Completed: 3 (Failed: 1, Cancelled 0), Skipped: 4' }] },
})

Deno.test('tekton: every failed run of one app is ONE incident; the next green run resolves it', () => {
  const a = classify(emit('tekton', run('False', 'app-ci-run-abcde')), 'platform-watcher', cfg)
  const b = classify(emit('tekton', run('False', 'app-ci-run-fghij')), 'platform-watcher', cfg)
  const ok = classify(emit('tekton', run('True', 'app-ci-run-klmno')), 'platform-watcher', cfg)
  assert(a.action === 'open' && b.action === 'open' && ok.action === 'resolve')
  assertEquals(a.ref.incidentId, 'tekton:adhar-system/qua-service')
  assertEquals(b.ref.incidentId, a.ref.incidentId)
  assertEquals(ok.ref.incidentId, a.ref.incidentId)
})

const event = (reason: string, count: number, pod = 'gateway-service-689ffd8cf6-7kj2j') => ({
  apiVersion: 'v1',
  kind: 'Event',
  metadata: { name: `${pod}.1`, namespace: 'dev', uid: `e-${reason}-${pod}` },
  type: 'Warning',
  reason,
  count,
  message: reason === 'OOMKilling' ? 'Memory cgroup out of memory: Killed process 4242 (java)' : 'Back-off restarting failed container app',
  involvedObject: { kind: 'Pod', name: pod, namespace: 'dev' },
})

Deno.test('events: OOMKilling (warning/high) opens per WORKLOAD; BackOff (medium) does not', () => {
  const a = classify(emit('k8s-events', event('OOMKilling', 1)), 'platform-watcher', cfg)
  const b = classify(emit('k8s-events', event('OOMKilling', 1, 'gateway-service-5cd88799d8-68cfn')), 'platform-watcher', cfg)
  assert(a.action === 'open' && b.action === 'open')
  assertEquals(a.ref.incidentId, 'event:dev/Pod/gateway-service')
  assertEquals(b.ref.incidentId, a.ref.incidentId)
  assertEquals(classify(emit('k8s-events', event('BackOff', 197)), 'platform-watcher', cfg).action, 'ignore')
  // Turning warnings off silences OOMKills too.
  assertEquals(classify(emit('k8s-events', event('OOMKilling', 1)), 'platform-watcher', mergeSupportConfig({ includeWarnings: false })).action, 'ignore')
})

Deno.test('workloadOfPod strips ReplicaSet / StatefulSet / Job suffixes', () => {
  assertEquals(workloadOfPod('gateway-service-689ffd8cf6-7kj2j'), 'gateway-service')
  assertEquals(workloadOfPod('qua-service-db-1'), 'qua-service-db')
  assertEquals(workloadOfPod('migrate-x7k2p'), 'migrate')
  assertEquals(workloadOfPod('standalone'), 'standalone')
})

Deno.test('kargo: a failed promotion and a failed verification open; their successes resolve', () => {
  const promo = (phase: string, name: string) => ({
    apiVersion: 'kargo.akuity.io/v1alpha1',
    kind: 'Promotion',
    metadata: { name, namespace: 'adhar', uid: name },
    spec: { stage: 'dev', freight: '58d96bbc80a03f2f8be0c73cb97fe8cfe54b5769' },
    status: { phase, message: phase === 'Errored' ? 'step "argocd-update" failed' : undefined, freight: { name: '58d96bb', origin: { kind: 'Warehouse', name: 'gateway-service' } } },
  })
  const f = classify(emit('kargo-promotion', promo('Errored', 'dev.01a.58d96bb')), 'platform-watcher', cfg)
  const s = classify(emit('kargo-promotion', promo('Succeeded', 'dev.01b.58d96bb')), 'platform-watcher', cfg)
  assert(f.action === 'open' && s.action === 'resolve')
  assertEquals(f.ref.incidentId, 'kargo-promotion:adhar/gateway-service->dev')
  assertEquals(s.ref.incidentId, f.ref.incidentId)

  const stage = (phase: string, id: string) => ({
    apiVersion: 'kargo.akuity.io/v1alpha1',
    kind: 'Stage',
    metadata: { name: 'dev', namespace: 'adhar', uid: 'st' },
    status: {
      freightHistory: [{
        id: 'c1',
        items: { a: { name: 'f1', origin: { name: 'gateway-service' } } },
        verificationHistory: [{ id, phase, message: phase === 'Failed' ? 'Metric "gateway-service-rollout-healthy" assessed Failed' : undefined }],
      }],
    },
  })
  const vf = classify(emit('kargo-verification', stage('Failed', 'v1')), 'platform-watcher', cfg)
  const vs = classify(emit('kargo-verification', stage('Successful', 'v2')), 'platform-watcher', cfg)
  assert(vf.action === 'open' && vs.action === 'resolve')
  assertEquals(vf.ref.incidentId, 'kargo-verification:adhar/dev')
  assertEquals(vs.ref.incidentId, vf.ref.incidentId)
  assertEquals(vf.ref.app, 'gateway-service')
})

Deno.test('control plane: XR failed opens (uid-independent id), Ready resolves; autoscaler scale-up failure resolved by a node joining', () => {
  const xr = (synced: string, ready: string, uid = 'x1') => ({
    apiVersion: 'platform.adhar.io/v1alpha1',
    kind: 'Database',
    metadata: { name: 'qua-service-db', namespace: 'dev', uid },
    status: { conditions: [{ type: 'Synced', status: synced, reason: 'ReconcileError', message: 'cannot compose resources' }, { type: 'Ready', status: ready }] },
  })
  const f = classify(emit('xr-databases', xr('False', 'False')), 'platform-watcher', cfg)
  const ok = classify(emit('xr-databases', xr('True', 'True', 'x2')), 'platform-watcher', cfg)
  assert(f.action === 'open' && ok.action === 'resolve')
  assertEquals(f.ref.incidentId, 'xr:Database:dev/qua-service-db')
  assertEquals(ok.ref.incidentId, f.ref.incidentId)

  const ev = {
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: 'prod.1', namespace: 'adhar-system', uid: 'ev1' },
    reason: 'ScaleUpFailed',
    count: 3,
    message: 'create worker: quota exceeded (4/5)',
    involvedObject: { kind: 'AdharPlatform', name: 'prod', namespace: 'adhar-system' },
  }
  const a = classify(emit('autoscaler-events', ev), 'platform-watcher', cfg)
  assert(a.action === 'open')
  assertEquals(a.ref.incidentId, 'autoscaler:prod:scale-up')
  const node = { apiVersion: 'v1', kind: 'Node', metadata: { name: 'adhar-adhar-workers-9', uid: 'n9', creationTimestamp: '2026-10-22T16:00:00Z', labels: {} } }
  const joined = classify(emit('nodes', node, { since: 0 }), 'platform-watcher', cfg)
  assert(joined.action === 'resolve')
  assertEquals(joined.prefix, 'autoscaler:')
})

Deno.test('resilience gate: failed opens per app; passed resolves', () => {
  const job = (ok: boolean, name: string) => ({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: 'adhar-system', uid: name, labels: { 'adhar.io/resilience-gate': 'gateway-service' } },
    spec: { template: { spec: { containers: [{ env: [{ name: 'VERIFY_ENVIRONMENT', value: 'test' }] }] } } },
    status: { conditions: [{ type: ok ? 'Complete' : 'Failed', status: 'True', message: ok ? undefined : 'BackoffLimitExceeded' }] },
  })
  const f = classify(emit('resilience-gate', job(false, 'gate-1')), 'platform-watcher', cfg)
  const p = classify(emit('resilience-gate', job(true, 'gate-2')), 'platform-watcher', cfg)
  assert(f.action === 'open' && p.action === 'resolve')
  assertEquals(f.ref.incidentId, 'resilience-gate:gateway-service')
  assertEquals(p.ref.incidentId, f.ref.incidentId)
})

Deno.test('alertmanager: only allowlisted severities open; the resolved alert resolves the same incident', () => {
  const alert = (severity: string, status: 'firing' | 'resolved') => ({
    status,
    labels: { alertname: 'KubePodCrashLooping', severity, namespace: 'dev', pod: 'gateway-service-689ffd8cf6-7kj2j', container: 'app' },
    annotations: { summary: 'Pod is crash looping.' },
    startsAt: '2026-10-22T15:00:00Z',
    endsAt: '2026-10-22T16:00:00Z',
    fingerprint: 'a1b2c3d4e5f60718',
  })
  const crit = classify(toNotification(alert('critical', 'firing')), 'alertmanager', cfg)
  assert(crit.action === 'open')
  assertEquals(crit.ref.incidentId, 'alertmanager:a1b2c3d4e5f60718')
  assertEquals(crit.ref.namespace, 'dev')
  assertEquals(crit.ref.objectKind, 'Pod')
  // warning → severity "high" in the feed, but alerts are filtered on their own label.
  assertEquals(classify(toNotification(alert('warning', 'firing')), 'alertmanager', cfg).action, 'ignore')
  assertEquals(classify(toNotification(alert('warning', 'firing')), 'alertmanager', mergeSupportConfig({ alertSeverities: ['critical', 'warning'] })).action, 'open')
  const res = classify(toNotification(alert('critical', 'resolved')), 'alertmanager', cfg)
  assert(res.action === 'resolve')
  assertEquals(res.ref.incidentId, crit.ref.incidentId)
})

Deno.test('never for successes, info, user/workspace notes; config gates apply to automatic but not manual', () => {
  const bad = emit('argocd', argoApp('Degraded'))
  assertEquals(classify({ ...bad, source: 'user' }, 'manual', cfg).action, 'ignore')
  assertEquals(classify({ ...bad, source: 'workspace' }, 'platform-watcher', cfg).action, 'ignore')
  assertEquals(classify({ ...bad, kind: 'info' }, 'platform-watcher', cfg).action, 'ignore')
  // Disabled / not in the allowlist / below the floor: no automatic ticket …
  assertEquals(classify(bad, 'platform-watcher', mergeSupportConfig({ enabled: false })).action, 'ignore')
  assertEquals(classify(bad, 'platform-watcher', mergeSupportConfig({ sources: ['tekton'] })).action, 'ignore')
  assertEquals(classify(bad, 'platform-watcher', mergeSupportConfig({ minSeverity: 'critical' })).action, 'ignore')
  // … but a person pressing the button still gets one.
  assertEquals(classify(bad, 'manual', mergeSupportConfig({ enabled: false, sources: [] })).action, 'open')
  // A manual ticket for an unrecognised key still gets a stable identity.
  const d = classify({ kind: 'error', source: 'system', title: 'Something odd', key: 'custom:thing', at: 'x' }, 'manual', cfg)
  assert(d.action === 'open')
  assertEquals(d.ref.incidentId, 'manual:custom:thing')
  assertEquals(parseRef({ key: 'kargo-freight:adhar/f1', title: 't' }), null)
})
