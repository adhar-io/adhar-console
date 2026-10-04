import type { argoRollouts } from '@adhar-console/api-clients'

/**
 * Reading an Argo Rollout into what the page needs to show and offer.
 *
 * The card showed a step ladder and three buttons and ignored most of what a
 * Rollout reports: how many replicas are actually updated and ready, how much
 * traffic the canary is taking, whether the rollout was aborted — and offered
 * no retry at all, though the client has always had one.
 *
 * Which actions are available is the part most worth pinning down. The old
 * rule for Abort was `phase === 'Healthy' && cur >= steps.length`, a double
 * negative that left Abort enabled on a finished healthy rollout with nothing
 * to abort.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export type RolloutPhase = 'Healthy' | 'Progressing' | 'Degraded' | 'Paused' | 'Unknown'
export type Strategy = 'canary' | 'blueGreen' | 'none'

export interface RolloutStep {
  label: string
  /** Cleared, running now, or still ahead. */
  state: 'done' | 'current' | 'pending'
}

export interface RolloutReplicas {
  desired: number
  current: number
  updated: number
  ready: number
  available: number
}

export interface RolloutView {
  key: string
  name: string
  namespace: string
  strategy: Strategy
  phase: RolloutPhase
  steps: RolloutStep[]
  currentStep: number
  totalSteps: number
  replicas: RolloutReplicas
  /** Canary traffic split, when the rollout reports one. */
  weights?: { canary: number; stable: number }
  aborted: boolean
  pausedReason?: string
  message?: string
  createdAt?: string
  /** Every replica updated, ready and available — the rollout has landed. */
  fullyRolledOut: boolean
  canPromote: boolean
  canPromoteFull: boolean
  canAbort: boolean
  canRetry: boolean
}

/** One canary step, in the words the spec used. */
export function describeStep(s: Record<string, unknown>): string {
  if ('setWeight' in s) return `setWeight ${s.setWeight}%`
  if ('pause' in s) {
    const p = s.pause as { duration?: string | number } | null
    // A pause with no duration waits for a human; that is not "pause 0".
    return p?.duration !== undefined && p?.duration !== null ? `pause ${p.duration}` : 'pause until promoted'
  }
  if ('analysis' in s) return 'analysis'
  if ('experiment' in s) return 'experiment'
  if ('setCanaryScale' in s) return 'scale canary'
  if ('setHeaderRoute' in s) return 'header route'
  if ('setMirrorRoute' in s) return 'mirror route'
  if ('plugin' in s) return 'plugin'
  return Object.keys(s)[0] ?? 'step'
}

/** Why a rollout is paused, when Argo says. */
export function pauseReason(conditions: Array<Record<string, unknown>> | undefined): string | undefined {
  const first = (conditions ?? [])[0]
  if (!first) return undefined
  const reason = first.reason
  return typeof reason === 'string' && reason ? reason : undefined
}

export function readRollout(r: argoRollouts.Rollout): RolloutView {
  const strategy: Strategy = r.spec.strategy?.canary
    ? 'canary'
    : r.spec.strategy?.blueGreen
    ? 'blueGreen'
    : 'none'

  const specSteps = (r.spec.strategy?.canary?.steps ?? []) as Array<Record<string, unknown>>
  const currentStep = r.status.currentStepIndex ?? 0
  const steps: RolloutStep[] = specSteps.map((s, i) => ({
    label: describeStep(s),
    state: i < currentStep ? 'done' : i === currentStep ? 'current' : 'pending',
  }))

  const desired = r.spec.replicas ?? r.status.replicas ?? 0
  const replicas: RolloutReplicas = {
    desired,
    current: r.status.replicas ?? 0,
    updated: r.status.updatedReplicas ?? 0,
    ready: r.status.readyReplicas ?? 0,
    available: r.status.availableReplicas ?? 0,
  }

  const w = r.status.canary?.weights
  const canaryWeight = w?.canary?.weight
  const weights = canaryWeight === undefined ? undefined : {
    canary: canaryWeight,
    // Argo only always reports the canary side; the stable side is the rest.
    stable: w?.stable?.weight ?? Math.max(0, 100 - canaryWeight),
  }

  const phase = (r.status.phase ?? 'Unknown') as RolloutPhase
  const aborted = Boolean(r.status.abort)
  const stepsRemaining = steps.length > 0 && currentStep < steps.length
  const fullyRolledOut = desired > 0 &&
    replicas.updated >= desired &&
    replicas.available >= desired

  return {
    key: `${r.metadata.namespace}/${r.metadata.name}`,
    name: r.metadata.name,
    namespace: r.metadata.namespace,
    strategy,
    phase,
    steps,
    currentStep,
    totalSteps: steps.length,
    replicas,
    weights,
    aborted,
    pausedReason: pauseReason(r.status.pauseConditions),
    message: r.status.message,
    createdAt: r.metadata.creationTimestamp,
    fullyRolledOut,

    // Advance one step: there has to be a step to advance to, and the rollout
    // has to be mid-flight rather than finished or aborted.
    canPromote: strategy !== 'none' && !aborted &&
      (phase === 'Paused' || phase === 'Progressing') &&
      (strategy === 'blueGreen' || stepsRemaining),
    // Skip the remaining steps. Pointless once there are none left.
    canPromoteFull: strategy !== 'none' && !aborted && !fullyRolledOut &&
      (phase === 'Paused' || phase === 'Progressing' || phase === 'Degraded'),
    // Only something in flight can be aborted. A healthy finished rollout has
    // nothing to abort, and an already-aborted one cannot be aborted again.
    canAbort: !aborted && (phase === 'Progressing' || phase === 'Paused'),
    // Retry is what undoes an abort, and what re-runs a rollout that failed.
    canRetry: aborted || phase === 'Degraded',
  }
}

export interface RolloutSummary {
  total: number
  healthy: number
  progressing: number
  paused: number
  degraded: number
  aborted: number
}

export function summariseRollouts(list: RolloutView[]): RolloutSummary {
  return {
    total: list.length,
    healthy: list.filter((r) => r.phase === 'Healthy').length,
    progressing: list.filter((r) => r.phase === 'Progressing').length,
    paused: list.filter((r) => r.phase === 'Paused').length,
    degraded: list.filter((r) => r.phase === 'Degraded').length,
    aborted: list.filter((r) => r.aborted).length,
  }
}

/** Needs-a-human first, then by name, so the list does not shuffle. */
const PHASE_ORDER: Record<RolloutPhase, number> = {
  Degraded: 0,
  Paused: 1,
  Progressing: 2,
  Unknown: 3,
  Healthy: 4,
}

export function byAttention(a: RolloutView, b: RolloutView): number {
  // An aborted rollout is waiting on someone whatever its phase says.
  const rank = (r: RolloutView) => (r.aborted ? -1 : PHASE_ORDER[r.phase] ?? 5)
  return rank(a) - rank(b) || a.key.localeCompare(b.key)
}
