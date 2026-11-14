import { assert, assertEquals } from 'jsr:@std/assert@1'
import type { KObj } from './catalog-composition-model.ts'
import {
  changeWarnings,
  confirmReason,
  currentIntent,
  declaredDrift,
  describeScaleEvent,
  lineDiff,
  deriveOp,
  describeChange,
  hpaView,
  isProductionEnv,
  OP_TIMEOUT_MS,
  scaledObjectFor,
  scalerFor,
  scalerLimit,
  scalerProblem,
  type ScalingOp,
  validateIntent,
} from './catalog-scaling-model.ts'

const HPA: KObj = {
  metadata: { name: 'reactapp', namespace: 'dev' },
  spec: {
    scaleTargetRef: { apiVersion: 'argoproj.io/v1alpha1', kind: 'Rollout', name: 'reactapp' },
    minReplicas: 1,
    maxReplicas: 3,
    metrics: [
      { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } },
      { type: 'Pods', pods: { metric: { name: 'http_requests' }, target: { type: 'AverageValue', averageValue: '10' } } },
    ],
  },
  status: {
    currentReplicas: 1,
    desiredReplicas: 1,
    lastScaleTime: '2026-11-13T02:00:00Z',
    currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 10, averageValue: '1m' } } }],
    conditions: [
      { type: 'AbleToScale', status: 'True', reason: 'ReadyForNewScale' },
      { type: 'ScalingActive', status: 'True', reason: 'ValidMetricFound' },
      { type: 'ScalingLimited', status: 'True', reason: 'TooManyReplicas', message: 'the desired replica count is more than the maximum replica count' },
    ],
  },
}

Deno.test('validateIntent: the bounds the dialog and the server share', () => {
  assertEquals(validateIntent({ mode: 'fixed', replicas: 0 }), { ok: true, value: { mode: 'fixed', replicas: 0 } })
  assertEquals(validateIntent({ mode: 'fixed', replicas: 2.5 }).ok, false)
  assertEquals(validateIntent({ mode: 'fixed', replicas: -1 }).ok, false)
  assertEquals(validateIntent({ mode: 'fixed', replicas: 51 }).ok, false)
  assertEquals(validateIntent({ mode: 'auto', min: 2, max: 6, cpu: 70, extra: 1 }), { ok: true, value: { mode: 'auto', min: 2, max: 6, cpu: 70 } })
  const bad = [
    [{ mode: 'auto', min: 0, max: 3, cpu: 70 }, 'min'],
    [{ mode: 'auto', min: 4, max: 3, cpu: 70 }, 'max'],
    [{ mode: 'auto', min: 1, max: 99, cpu: 70 }, 'max'],
    [{ mode: 'auto', min: 1, max: 3, cpu: 5 }, 'cpu'],
    [{ mode: 'auto', min: 1, max: 3, memory: 120 }, 'memory'],
    [{ mode: 'auto', min: 1, max: 3 }, 'cpu'],
    [{ mode: 'other' }, 'mode'],
    [null, 'mode'],
  ] as const
  for (const [raw, field] of bad) {
    const v = validateIntent(raw)
    assert(!v.ok, JSON.stringify(raw))
    if (!v.ok) assertEquals(v.field, field, JSON.stringify(raw))
  }
  assertEquals(validateIntent({ mode: 'auto', min: 1, max: 3, memory: 80 }), { ok: true, value: { mode: 'auto', min: 1, max: 3, memory: 80 } })
})

Deno.test('describeChange: the one-line diff preview', () => {
  assertEquals(describeChange({ mode: 'fixed', replicas: 3 }, { mode: 'fixed', replicas: 5 }), '3 → 5 instances')
  assertEquals(describeChange({ mode: 'fixed', replicas: 2 }, { mode: 'fixed', replicas: 1 }), '2 → 1 instance')
  assertEquals(describeChange({ mode: 'auto', min: 1, max: 3, cpu: 70 }, { mode: 'fixed', replicas: 3 }), 'Autoscaling off · hold 3 instances')
  assertEquals(describeChange({ mode: 'fixed', replicas: 2 }, { mode: 'auto', min: 2, max: 6, cpu: 70 }), 'Autoscaling on · 2–6 at 70% CPU')
  assertEquals(describeChange({ mode: 'auto', min: 1, max: 3, cpu: 70 }, { mode: 'auto', min: 2, max: 6, cpu: 60, memory: 80 }), 'Autoscale 1–3 at 70% CPU → 2–6 at 60% CPU, 80% memory')
  assertEquals(describeChange({ mode: 'fixed', replicas: 2 }, { mode: 'fixed', replicas: 2 }), 'No change · 2 instances')
  assertEquals(describeChange({ mode: 'auto', min: 1, max: 3, cpu: 70 }, { mode: 'auto', min: 2, max: 6, cpu: 70 }), 'Autoscale 1–3 → 2–6 at 70% CPU')
})

Deno.test('production and offline changes need the typed name; warnings advise, never block', () => {
  assert(isProductionEnv('prod') && isProductionEnv('Production') && isProductionEnv('eu-prod') && !isProductionEnv('product-dev') && !isProductionEnv('test'))
  assertEquals(confirmReason('dev', { mode: 'fixed', replicas: 0 }), 'offline')
  assertEquals(confirmReason('prod', { mode: 'fixed', replicas: 3 }), 'production')
  assertEquals(confirmReason('test', { mode: 'auto', min: 1, max: 2, cpu: 70 }), null)
  assertEquals(changeWarnings('dev', { mode: 'fixed', replicas: 1 }, { mode: 'fixed', replicas: 0 }).length, 1)
  assert(changeWarnings('prod', undefined, { mode: 'fixed', replicas: 1 })[0].includes('outage'))
  assert(changeWarnings('dev', undefined, { mode: 'auto', min: 3, max: 3, cpu: 70 })[0].includes('never change'))
  assertEquals(changeWarnings('dev', { mode: 'fixed', replicas: 1 }, { mode: 'fixed', replicas: 2 }), [])
})

Deno.test('hpaView reads bounds, targets, utilisation, other metrics and limits', () => {
  const v = hpaView(HPA)
  assertEquals([v.min, v.max, v.cpuTarget, v.cpuNow, v.memoryTarget, v.current, v.desired], [1, 3, 70, 10, undefined, 1, 1])
  assertEquals(v.otherMetrics, ['Pods: http_requests'])
  assertEquals(v.keda, undefined)
  assertEquals(scalerLimit(v), { text: 'held at its maximum (3) — load wants more', atMax: true })
  assertEquals(scalerProblem(v), undefined)
  const broken = hpaView({ ...HPA, status: { conditions: [{ type: 'ScalingActive', status: 'False', reason: 'FailedGetResourceMetric', message: 'missing request for cpu' }] } })
  assertEquals(scalerProblem(broken)?.reason, 'FailedGetResourceMetric')
  assertEquals(hpaView({ metadata: { name: 'keda-hpa-shop', namespace: 'x' }, spec: {} }).keda, 'shop')
})

Deno.test('scalerFor / scaledObjectFor match the workload by scaleTargetRef in its namespace', () => {
  assertEquals(scalerFor([HPA], { kind: 'Rollout', name: 'reactapp', namespace: 'dev' })?.metadata.name, 'reactapp')
  assertEquals(scalerFor([HPA], { kind: 'Rollout', name: 'reactapp', namespace: 'test' }), undefined)
  assertEquals(scalerFor([HPA], { kind: 'Deployment', name: 'reactapp', namespace: 'dev' }), undefined)
  const so: KObj = { metadata: { name: 'so', namespace: 'dev' }, spec: { scaleTargetRef: { name: 'api' } } }
  assertEquals(scaledObjectFor([so], { kind: 'Deployment', name: 'api', namespace: 'dev' })?.metadata.name, 'so')
  assertEquals(scaledObjectFor([so], { kind: 'Rollout', name: 'api', namespace: 'dev' }), undefined)
})

Deno.test('currentIntent: the autoscaler wins over the workload count', () => {
  assertEquals(currentIntent(2, hpaView(HPA)), { mode: 'auto', min: 1, max: 3, cpu: 70 })
  assertEquals(currentIntent(2, undefined), { mode: 'fixed', replicas: 2 })
  assertEquals(currentIntent(undefined, undefined), undefined)
})

/* ─────────── following a change ─────────── */

const T0 = 1_000_000
const op = (over: Partial<ScalingOp> = {}): ScalingOp => ({
  app: 'reactapp',
  env: 'test',
  from: { mode: 'auto', min: 2, max: 3, cpu: 70 },
  target: { mode: 'fixed', replicas: 4 },
  startedAt: T0,
  commit: 'abc',
  promotion: 'test-x',
  rollout: 'promotion',
  ...over,
})

Deno.test('deriveOp walks promoting → syncing → settling → scaling → done', () => {
  const hpa = hpaView(HPA)
  assertEquals(deriveOp(op(), { promotion: { phase: 'Running' }, hpa, workload: { desired: 2, ready: 2, available: 2 } }, T0 + 1).phase, 'promoting')
  assertEquals(deriveOp(op(), { promotion: { phase: 'Succeeded' }, hpa, workload: { desired: 2, ready: 2, available: 2 } }, T0 + 1).phase, 'syncing')
  const settle = deriveOp(op(), { promotion: { phase: 'Succeeded' }, argo: { sync: 'Synced' }, workload: { desired: 2, ready: 2, available: 2 } }, T0 + 1)
  assertEquals([settle.phase, settle.needsSettle], ['settling', true])
  assertEquals(deriveOp(op(), { promotion: { phase: 'Succeeded' }, argo: { sync: 'OutOfSync' }, workload: { desired: 2, ready: 2, available: 2 } }, T0 + 1).phase, 'syncing')
  const scaling = deriveOp(op(), { promotion: { phase: 'Succeeded' }, workload: { desired: 4, ready: 3, available: 3 } }, T0 + 1)
  assertEquals([scaling.phase, scaling.detail], ['scaling', '3/4 ready'])
  assertEquals(deriveOp(op(), { workload: { desired: 4, ready: 4, available: 4 } }, T0 + 1).phase, 'done')
})

Deno.test('deriveOp: scale down is done when the extra pods are gone; zero means none', () => {
  const down = op({ from: { mode: 'fixed', replicas: 4 }, target: { mode: 'fixed', replicas: 2 } })
  assertEquals(deriveOp(down, { workload: { desired: 2, ready: 4, available: 4 } }, T0 + 1).phase, 'scaling')
  assertEquals(deriveOp(down, { workload: { desired: 2, ready: 2, available: 2 } }, T0 + 1).phase, 'done')
  const off = op({ target: { mode: 'fixed', replicas: 0 } })
  assertEquals(deriveOp(off, { workload: { desired: 0, ready: 1, available: 1 } }, T0 + 1).phase, 'scaling')
  assertEquals(deriveOp(off, { workload: { desired: 0, ready: 0, available: 0 } }, T0 + 1).phase, 'done')
})

Deno.test('deriveOp: autoscaling target is reached when the live autoscaler carries the bounds', () => {
  const on = op({ from: { mode: 'fixed', replicas: 1 }, target: { mode: 'auto', min: 1, max: 3, cpu: 70 } })
  assertEquals(deriveOp(on, { promotion: { phase: 'Succeeded' }, workload: { desired: 1, ready: 1, available: 1 } }, T0 + 1).phase, 'syncing')
  assertEquals(deriveOp(on, { hpa: hpaView(HPA), workload: { desired: 1, ready: 1, available: 1 } }, T0 + 1).phase, 'done')
})

Deno.test('deriveOp: failed promotion, timeout and deferred', () => {
  const failed = deriveOp(op(), { promotion: { phase: 'Errored', message: 'git push rejected' } }, T0 + 1)
  assertEquals([failed.phase, failed.detail], ['failed', 'Promotion errored: git push rejected'])
  assertEquals(deriveOp(op(), { promotion: { phase: 'Running' } }, T0 + OP_TIMEOUT_MS + 1).phase, 'failed')
  assertEquals(deriveOp(op({ rollout: 'deferred', promotion: undefined, deferredReason: 'later' }), {}, T0).detail, 'later')
  assertEquals(deriveOp(op({ rollout: 'argo', promotion: undefined }), { argo: { operation: 'Running' }, hpa: hpaView(HPA) }, T0 + 1).phase, 'syncing')
})

Deno.test('declaredDrift: Git says N, nothing scales it, Argo CD at rest, workload runs another count', () => {
  assertEquals(declaredDrift({ mode: 'fixed', replicas: 2 }, { argo: { sync: 'Synced' }, workload: { desired: 3, ready: 3, available: 3 } }), 2)
  assertEquals(declaredDrift({ mode: 'fixed', replicas: 3 }, { argo: { sync: 'Synced' }, workload: { desired: 3, ready: 3, available: 3 } }), undefined)
  assertEquals(declaredDrift({ mode: 'fixed', replicas: 2 }, { argo: { sync: 'OutOfSync' }, workload: { desired: 3, ready: 3, available: 3 } }), undefined)
  assertEquals(declaredDrift({ mode: 'fixed', replicas: 2 }, { argo: { sync: 'Synced' }, hpa: hpaView(HPA), workload: { desired: 3, ready: 3, available: 3 } }), undefined)
  assertEquals(declaredDrift({ mode: 'auto', min: 1, max: 2 }, { argo: { sync: 'Synced' }, workload: { desired: 3, ready: 3, available: 3 } }), undefined)
})

Deno.test('lineDiff folds unchanged runs and marks additions and removals', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\n'
  const after = 'a\nb\nc\nd\nE\nf\ng\nh\n'
  const d = lineDiff(before, after, 1)
  assertEquals(d.map((l) => `${l.op}${l.text}`), ['…3 unchanged lines', ' d', '-e', '+E', ' f', ' g', '+h'])
  assertEquals(lineDiff(null, 'x\n').map((l) => `${l.op}${l.text}`), ['+x'])
  assertEquals(lineDiff('x\n', null).map((l) => `${l.op}${l.text}`), ['-x'])
})

Deno.test('describeScaleEvent reads the HPA controller message', () => {
  assertEquals(describeScaleEvent('SuccessfulRescale', 'New size: 3; reason: cpu resource utilization (percentage of request) above target'), 'Scaled to 3 — cpu resource utilization (percentage of request) above target')
  assertEquals(describeScaleEvent('FailedGetResourceMetric', 'missing request for cpu'), 'FailedGetResourceMetric: missing request for cpu')
})
