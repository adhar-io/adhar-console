/**
 * The Chaos Mesh catalogue, and the rules for reading an experiment's state.
 *
 * Kept free of React so the status logic can be tested directly. That logic is
 * worth testing because it is the difference between a page that tells you a
 * fault is currently applied to production and one that quietly says
 * "Running" while nothing is injected.
 */

export const CHAOS_GROUP = 'chaos-mesh.org'
export const CHAOS_VERSION = 'v1alpha1'

export type ChaosKindId =
  | 'pod'
  | 'network'
  | 'stress'
  | 'io'
  | 'time'
  | 'dns'
  | 'http'
  | 'kernel'
  | 'jvm'
  | 'block'

export interface ChaosKind {
  id: ChaosKindId
  /** Kubernetes kind. */
  kind: string
  /** Plural resource name. */
  resource: string
  label: string
  /** What it actually does to a running system, in one line. */
  blurb: string
  /** `spec.action` values this kind accepts. First is the safe default. */
  actions: string[]
  /**
   * How much of a production outage this fault resembles. Used to order the
   * catalogue and to decide which experiments need a second confirmation —
   * killing one pod is a Tuesday; corrupting kernel syscalls is not.
   */
  blast: 'low' | 'medium' | 'high'
}

/**
 * Ordered least to most destructive.
 *
 * `podChaos: pod-failure` is first deliberately: it is the experiment people
 * should start with, because it is the one real clusters survive.
 */
export const CHAOS_KINDS: ChaosKind[] = [
  {
    id: 'pod',
    kind: 'PodChaos',
    resource: 'podchaos',
    label: 'Pod',
    blurb: 'Kill pods, stop containers, or make a pod unavailable without deleting it.',
    actions: ['pod-failure', 'pod-kill', 'container-kill'],
    blast: 'medium',
  },
  {
    id: 'network',
    kind: 'NetworkChaos',
    resource: 'networkchaos',
    label: 'Network',
    blurb: 'Latency, packet loss, duplication, corruption, bandwidth caps and partitions.',
    actions: ['delay', 'loss', 'duplicate', 'corrupt', 'partition', 'bandwidth'],
    blast: 'medium',
  },
  {
    id: 'stress',
    kind: 'StressChaos',
    resource: 'stresschaos',
    label: 'Stress',
    blurb: 'Burn CPU or fill memory inside the target pods.',
    actions: ['stress'],
    blast: 'low',
  },
  {
    id: 'io',
    kind: 'IOChaos',
    resource: 'iochaos',
    label: 'I/O',
    blurb: 'Delay, fail or silently corrupt filesystem operations.',
    actions: ['latency', 'fault', 'attrOverride', 'mistake'],
    blast: 'high',
  },
  {
    id: 'time',
    kind: 'TimeChaos',
    resource: 'timechaos',
    label: 'Clock',
    blurb: 'Shift the clock inside a pod — the classic way to find expiry bugs.',
    actions: ['delay'],
    blast: 'medium',
  },
  {
    id: 'dns',
    kind: 'DNSChaos',
    resource: 'dnschaos',
    label: 'DNS',
    blurb: 'Return errors or wrong answers for name lookups.',
    actions: ['error', 'random'],
    blast: 'medium',
  },
  {
    id: 'http',
    kind: 'HTTPChaos',
    resource: 'httpchaos',
    label: 'HTTP',
    blurb: 'Abort, delay, or rewrite HTTP requests and responses in flight.',
    actions: ['abort', 'delay', 'replace', 'patch'],
    blast: 'medium',
  },
  {
    id: 'jvm',
    kind: 'JVMChaos',
    resource: 'jvmchaos',
    label: 'JVM',
    blurb: 'Throw exceptions, add latency or trigger GC inside a running JVM.',
    actions: ['latency', 'exception', 'gc', 'return', 'stress'],
    blast: 'medium',
  },
  {
    id: 'block',
    kind: 'BlockChaos',
    resource: 'blockchaos',
    label: 'Block device',
    blurb: 'Delay or limit block-device I/O beneath the filesystem.',
    actions: ['delay', 'freeze'],
    blast: 'high',
  },
  {
    id: 'kernel',
    kind: 'KernelChaos',
    resource: 'kernelchaos',
    label: 'Kernel',
    blurb: 'Inject failures into kernel syscalls. The sharpest tool here.',
    actions: ['fault'],
    blast: 'high',
  },
]

export function gvrFor(id: ChaosKindId) {
  const kind = CHAOS_KINDS.find((k) => k.id === id)
  if (!kind) throw new Error(`unknown chaos kind: ${id}`)
  return { group: CHAOS_GROUP, version: CHAOS_VERSION, resource: kind.resource, namespaced: true }
}

export function kindById(id: ChaosKindId): ChaosKind | undefined {
  return CHAOS_KINDS.find((k) => k.id === id)
}

/** Map a Kubernetes kind (`PodChaos`) back to our id. */
export function kindIdOf(kubeKind: string | undefined): ChaosKindId | undefined {
  return CHAOS_KINDS.find((k) => k.kind === kubeKind)?.id
}

/* ─────────── object shapes ─────────── */

export interface ChaosCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason?: string
}

export interface ChaosRecord {
  id?: string
  selectorKey?: string
  phase?: string
}

export interface ChaosExperiment {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  spec?: {
    action?: string
    mode?: string
    value?: string
    duration?: string
    selector?: {
      namespaces?: string[]
      labelSelectors?: Record<string, string>
    }
    [k: string]: unknown
  }
  status?: {
    conditions?: ChaosCondition[]
    experiment?: {
      desiredPhase?: string
      containerRecords?: ChaosRecord[]
      /** Older Chaos Mesh spelling of the same list. */
      Records?: ChaosRecord[]
    }
  }
}

/* ─────────── status ─────────── */

/**
 * What an experiment is actually doing, right now.
 *
 * `injecting` is deliberately distinct from `running`: an experiment can be
 * desired-Run and selected but not yet applied, and during that window nothing
 * is broken yet. Collapsing the two would make the page claim a fault is live
 * before it is — the single most misleading thing a chaos console can do.
 */
export type ChaosPhase = 'injected' | 'injecting' | 'recovering' | 'paused' | 'finished' | 'unknown'

const conditionIs = (exp: ChaosExperiment, type: string): boolean =>
  exp.status?.conditions?.find((c) => c.type === type)?.status === 'True'

/**
 * Someone asked for this experiment to stop.
 *
 * Only the annotation means that. `desiredPhase: Stop` does NOT: the
 * controller also sets it when a bounded experiment reaches the end of its
 * `duration`, so treating it as "paused" labels every naturally completed
 * experiment as though a human had halted it.
 */
export function isPaused(exp: ChaosExperiment): boolean {
  return exp.metadata.annotations?.['experiment.chaos-mesh.org/pause'] === 'true'
}

/** The controller is no longer trying to keep the fault applied. */
export function isWindingDown(exp: ChaosExperiment): boolean {
  return isPaused(exp) || exp.status?.experiment?.desiredPhase === 'Stop'
}

export function records(exp: ChaosExperiment): ChaosRecord[] {
  const e = exp.status?.experiment
  return e?.containerRecords ?? e?.Records ?? []
}

/** How many targets currently have the fault applied. */
export function injectedCount(exp: ChaosExperiment): { injected: number; total: number } {
  const all = records(exp)
  return { injected: all.filter((r) => r.phase === 'Injected').length, total: all.length }
}

export function phaseOf(exp: ChaosExperiment): ChaosPhase {
  const allInjected = conditionIs(exp, 'AllInjected')
  const allRecovered = conditionIs(exp, 'AllRecovered')
  const { injected } = injectedCount(exp)

  // Winding down but still applied to something is `recovering`, never
  // `paused` or `finished` — the fault is live and the page must not imply
  // otherwise. This is the reading that matters during an incident.
  if (injected > 0 && isWindingDown(exp)) return 'recovering'
  if (allInjected || injected > 0) return 'injected'
  // Past here nothing is applied, and the only question is why it stopped.
  // The annotation is what separates "a person halted this" from "it ran its
  // duration and recovered on its own" — both leave desiredPhase at Stop.
  if (isPaused(exp)) return 'paused'
  if (allRecovered) return 'finished'
  if (exp.status?.experiment?.desiredPhase === 'Run') return 'injecting'
  if (exp.status?.conditions?.length) return 'unknown'
  return 'injecting'
}

/** True when a fault is currently applied to at least one target. */
export function isLive(exp: ChaosExperiment): boolean {
  const phase = phaseOf(exp)
  return phase === 'injected' || phase === 'recovering'
}

/** Human summary of what the experiment is pointed at. */
export function targetSummary(exp: ChaosExperiment): string {
  const sel = exp.spec?.selector
  const namespaces = sel?.namespaces ?? []
  const labels = Object.entries(sel?.labelSelectors ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  const scope = namespaces.length ? namespaces.join(', ') : 'every namespace'
  const mode = exp.spec?.mode ? modeLabel(exp.spec.mode, exp.spec.value) : ''
  return [scope, labels, mode].filter(Boolean).join(' · ')
}

export function modeLabel(mode: string, value?: string): string {
  switch (mode) {
    case 'one':
      return 'one pod'
    case 'all':
      return 'all pods'
    case 'fixed':
      return `${value ?? '?'} pods`
    case 'fixed-percent':
      return `${value ?? '?'}% of pods`
    case 'random-max-percent':
      return `up to ${value ?? '?'}% of pods`
    default:
      return mode
  }
}

/** Modes where `spec.value` is required rather than ignored. */
export function modeNeedsValue(mode: string): boolean {
  return mode === 'fixed' || mode === 'fixed-percent' || mode === 'random-max-percent'
}
