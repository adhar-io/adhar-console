import { assert, assertEquals } from 'jsr:@std/assert'
import {
  byAttention,
  describeStep,
  pauseReason,
  readRollout,
  summariseRollouts,
  type RolloutView,
} from './rollout-state.ts'
import type { argoRollouts } from '@adhar-console/api-clients'

/** The canary this cluster actually runs. */
function rollout(over: {
  name?: string
  namespace?: string
  replicas?: number
  steps?: Array<Record<string, unknown>>
  blueGreen?: boolean
  status?: Record<string, unknown>
} = {}): argoRollouts.Rollout {
  return {
    metadata: {
      name: over.name ?? 'test-service',
      namespace: over.namespace ?? 'adhar-system',
      creationTimestamp: '2026-10-04T04:00:00Z',
    },
    spec: {
      replicas: over.replicas ?? 4,
      strategy: over.blueGreen
        ? { blueGreen: {} }
        : {
          canary: {
            steps: over.steps ?? [
              { setWeight: 25 },
              { pause: { duration: '30s' } },
              { setWeight: 50 },
              { pause: { duration: '30s' } },
              { setWeight: 100 },
            ],
          },
        },
    },
    status: { phase: 'Progressing', currentStepIndex: 2, ...over.status },
  } as unknown as argoRollouts.Rollout
}

Deno.test('a canary is read into its strategy, steps and position', () => {
  const v = readRollout(rollout())
  assertEquals(v.key, 'adhar-system/test-service')
  assertEquals(v.strategy, 'canary')
  assertEquals(v.totalSteps, 5)
  assertEquals(v.currentStep, 2)
  assertEquals(v.steps.map((s) => s.state), ['done', 'done', 'current', 'pending', 'pending'])
  assertEquals(v.steps[0].label, 'setWeight 25%')
  assertEquals(v.steps[1].label, 'pause 30s')
})

Deno.test('every canary step kind is described rather than dumped', () => {
  assertEquals(describeStep({ setWeight: 10 }), 'setWeight 10%')
  assertEquals(describeStep({ analysis: {} }), 'analysis')
  assertEquals(describeStep({ experiment: {} }), 'experiment')
  assertEquals(describeStep({ setCanaryScale: {} }), 'scale canary')
  assertEquals(describeStep({ setHeaderRoute: {} }), 'header route')
  // A step kind this console has never seen still names itself.
  assertEquals(describeStep({ somethingNew: {} }), 'somethingNew')
  assertEquals(describeStep({}), 'step')
})

/** A pause with no duration waits for a person. "pause 0" would be a lie. */
Deno.test('an indefinite pause says it is waiting to be promoted', () => {
  assertEquals(describeStep({ pause: {} }), 'pause until promoted')
  assertEquals(describeStep({ pause: null }), 'pause until promoted')
  assertEquals(describeStep({ pause: { duration: 0 } }), 'pause 0')
})

Deno.test('replica counts are read, including the ones the card ignored', () => {
  const v = readRollout(rollout({
    status: { replicas: 4, updatedReplicas: 2, readyReplicas: 3, availableReplicas: 3 },
  }))
  assertEquals(v.replicas, { desired: 4, current: 4, updated: 2, ready: 3, available: 3 })
  assertEquals(v.fullyRolledOut, false)
})

Deno.test('a rollout is fully rolled out only when every replica is updated and available', () => {
  const v = readRollout(rollout({
    status: { phase: 'Healthy', replicas: 4, updatedReplicas: 4, readyReplicas: 4, availableReplicas: 4 },
  }))
  assert(v.fullyRolledOut)
})

/** Argo always reports the canary side; the stable side is the remainder. */
Deno.test('the traffic split is completed from the canary weight', () => {
  const v = readRollout(rollout({ status: { canary: { weights: { canary: { weight: 25 } } } } }))
  assertEquals(v.weights, { canary: 25, stable: 75 })
})

Deno.test('a rollout reporting no weights claims none', () => {
  assertEquals(readRollout(rollout()).weights, undefined)
})

Deno.test('the pause reason is read when Argo gives one', () => {
  assertEquals(pauseReason([{ reason: 'CanaryPauseStep' }]), 'CanaryPauseStep')
  assertEquals(pauseReason([]), undefined)
  assertEquals(pauseReason(undefined), undefined)
  assertEquals(pauseReason([{ startTime: 'x' }]), undefined)
})

/* ── which actions make sense ── */

Deno.test('a paused canary can be advanced, skipped or aborted', () => {
  const v = readRollout(rollout({ status: { phase: 'Paused', currentStepIndex: 1 } }))
  assertEquals(
    [v.canPromote, v.canPromoteFull, v.canAbort, v.canRetry],
    [true, true, true, false],
  )
})

/**
 * The rule this replaces was `phase === 'Healthy' && cur >= steps.length`,
 * which left Abort enabled on a finished healthy rollout with nothing to
 * abort.
 */
Deno.test('a finished healthy rollout offers no actions', () => {
  const v = readRollout(rollout({
    status: {
      phase: 'Healthy',
      currentStepIndex: 5,
      replicas: 4,
      updatedReplicas: 4,
      readyReplicas: 4,
      availableReplicas: 4,
    },
  }))
  assertEquals(
    [v.canPromote, v.canPromoteFull, v.canAbort, v.canRetry],
    [false, false, false, false],
  )
})

Deno.test('an aborted rollout can only be retried', () => {
  const v = readRollout(rollout({ status: { phase: 'Degraded', abort: true } }))
  assert(v.aborted)
  assertEquals([v.canPromote, v.canAbort, v.canRetry], [false, false, true])
})

Deno.test('a degraded rollout can be retried or forced through', () => {
  const v = readRollout(rollout({ status: { phase: 'Degraded', currentStepIndex: 2 } }))
  assertEquals([v.canRetry, v.canPromoteFull, v.canAbort], [true, true, false])
})

/** A canary at its last step has nothing further to advance to. */
Deno.test('a canary past its final step cannot be advanced', () => {
  const v = readRollout(rollout({ status: { phase: 'Progressing', currentStepIndex: 5 } }))
  assertEquals(v.canPromote, false)
})

/** Blue/green has no step ladder, but it is exactly what promotion is for. */
Deno.test('a blue/green rollout can be promoted despite having no steps', () => {
  const v = readRollout(rollout({ blueGreen: true, status: { phase: 'Paused' } }))
  assertEquals(v.strategy, 'blueGreen')
  assertEquals(v.totalSteps, 0)
  assertEquals(v.canPromote, true)
})

Deno.test('a rollout with no strategy offers no promotion', () => {
  const r = rollout()
  ;(r.spec as { strategy?: unknown }).strategy = undefined
  const v = readRollout(r)
  assertEquals(v.strategy, 'none')
  assertEquals([v.canPromote, v.canPromoteFull], [false, false])
})

/* ── the list ── */

Deno.test('the summary counts each phase and aborts separately', () => {
  const s = summariseRollouts([
    readRollout(rollout({ name: 'a', status: { phase: 'Healthy' } })),
    readRollout(rollout({ name: 'b', status: { phase: 'Paused' } })),
    readRollout(rollout({ name: 'c', status: { phase: 'Degraded', abort: true } })),
  ].map((v) => v))
  assertEquals(s, { total: 3, healthy: 1, progressing: 0, paused: 1, degraded: 1, aborted: 1 })
})

Deno.test('rollouts needing a human sort first, aborted above everything', () => {
  const list = [
    readRollout(rollout({ name: 'healthy', status: { phase: 'Healthy' } })),
    readRollout(rollout({ name: 'paused', status: { phase: 'Paused' } })),
    readRollout(rollout({ name: 'degraded', status: { phase: 'Degraded' } })),
    readRollout(rollout({ name: 'aborted', status: { phase: 'Progressing', abort: true } })),
  ]
  assertEquals(
    [...list].sort(byAttention).map((r) => r.name),
    ['aborted', 'degraded', 'paused', 'healthy'],
  )
})

Deno.test('an unknown phase is not treated as healthy', () => {
  const v = readRollout(rollout({ status: { phase: undefined } }))
  assertEquals(v.phase, 'Unknown')
  const sorted = [
    readRollout(rollout({ name: 'h', status: { phase: 'Healthy' } })),
    v,
  ].sort(byAttention)
  assertEquals(sorted[0].phase, 'Unknown')
})

Deno.test('no rollouts summarises to zeros', () => {
  assertEquals(summariseRollouts([] as RolloutView[]), {
    total: 0, healthy: 0, progressing: 0, paused: 0, degraded: 0, aborted: 0,
  })
})
