import type { KObj } from './catalog-composition-model.ts'

/**
 * Scaling for one application in one environment — the pure model shared by
 * the catalog drawer's Scaling section and the BFF (`server/scaling.ts`).
 *
 * WHERE SCALING IS DECLARED. An application's environments are deployed by
 * GitOps: its repository's kustomize overlay `<path>/envs/<env>` (on the
 * source branch) is rendered by the project's Kargo stage into the
 * environment's branch `stage/<env>`, and Argo CD — automated, selfHeal,
 * prune — applies that branch. So the replica count and the autoscaler are
 * whatever the overlay says; a direct `kubectl scale` or HPA edit is put back
 * by Argo CD within minutes. The console therefore changes the OVERLAY (a
 * console-managed patch file, `scaling.yaml`, applied after every other patch)
 * and rolls it out the platform's own way: a Kargo promotion of the freight
 * already running there, which re-renders the overlay.
 *
 * One live write remains legitimate: Argo CD ignores Rollout fields the HPA
 * controller (`kube-controller-manager`) wrote (the Application's
 * `ignoreDifferences.managedFieldsManagers`), so after autoscaling is turned
 * off the last count the HPA set would stand forever. Once the overlay has
 * rolled out, the console sets the count Git now declares through the scale
 * subresource — the same value Git holds, so nothing reverts it.
 *
 * Dependency-free so the browser, the server and the tests share one copy.
 */

/** The console will not set more instances than this (edit the overlay by hand for more). */
export const MAX_INSTANCES = 50
/** Autoscaler utilisation targets the console accepts, in percent of the request. */
export const MIN_TARGET = 10
export const MAX_TARGET = 100
export const DEFAULT_CPU_TARGET = 70

export type ScalingIntent =
  | { mode: 'fixed'; replicas: number }
  | { mode: 'auto'; min: number; max: number; cpu?: number; memory?: number }

export const FIXED_PRESETS = [1, 2, 3, 5] as const

export interface AutoPreset {
  label: string
  hint: string
  min: number
  max: number
  cpu: number
}

export const AUTO_PRESETS: readonly AutoPreset[] = [
  { label: 'Light', hint: '1–3 at 70% CPU', min: 1, max: 3, cpu: 70 },
  { label: 'Standard', hint: '2–6 at 70% CPU', min: 2, max: 6, cpu: 70 },
  { label: 'Burst', hint: '3–12 at 60% CPU', min: 3, max: 12, cpu: 60 },
]

/* ─────────── validation ─────────── */

export type IntentCheck =
  | { ok: true; value: ScalingIntent }
  | { ok: false; field: 'replicas' | 'min' | 'max' | 'cpu' | 'memory' | 'mode'; message: string }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** Normalise and validate a requested change; the server runs the same check. */
export function validateIntent(raw: unknown): IntentCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, field: 'mode', message: 'Say what to change.' }
  const r = raw as Record<string, unknown>
  if (r.mode === 'fixed') {
    if (!isInt(r.replicas)) return { ok: false, field: 'replicas', message: 'Instances must be a whole number.' }
    if (r.replicas < 0) return { ok: false, field: 'replicas', message: 'Instances cannot be negative.' }
    if (r.replicas > MAX_INSTANCES) {
      return { ok: false, field: 'replicas', message: `At most ${MAX_INSTANCES} instances from the console — edit the overlay for more.` }
    }
    return { ok: true, value: { mode: 'fixed', replicas: r.replicas } }
  }
  if (r.mode === 'auto') {
    if (!isInt(r.min) || r.min < 1) return { ok: false, field: 'min', message: 'The minimum must be at least 1 — an autoscaler cannot scale from zero.' }
    if (!isInt(r.max)) return { ok: false, field: 'max', message: 'The maximum must be a whole number.' }
    if (r.max < r.min) return { ok: false, field: 'max', message: 'The maximum cannot be below the minimum.' }
    if (r.max > MAX_INSTANCES) return { ok: false, field: 'max', message: `At most ${MAX_INSTANCES} instances from the console — edit the overlay for more.` }
    const target = (v: unknown, field: 'cpu' | 'memory'): IntentCheck | number | undefined => {
      if (v === undefined || v === null || v === '') return undefined
      if (!isInt(v) || v < MIN_TARGET || v > MAX_TARGET) {
        return { ok: false, field, message: `The ${field === 'cpu' ? 'CPU' : 'memory'} target must be ${MIN_TARGET}–${MAX_TARGET}%.` }
      }
      return v
    }
    const cpu = target(r.cpu, 'cpu')
    if (typeof cpu === 'object') return cpu
    const memory = target(r.memory, 'memory')
    if (typeof memory === 'object') return memory
    if (cpu === undefined && memory === undefined) {
      return { ok: false, field: 'cpu', message: 'Pick at least one target — CPU or memory — for the autoscaler to follow.' }
    }
    return {
      ok: true,
      value: { mode: 'auto', min: r.min, max: r.max, ...(cpu !== undefined ? { cpu } : {}), ...(memory !== undefined ? { memory } : {}) },
    }
  }
  return { ok: false, field: 'mode', message: 'mode must be "fixed" or "auto".' }
}

export function sameIntent(a: ScalingIntent | undefined, b: ScalingIntent | undefined): boolean {
  if (!a || !b || a.mode !== b.mode) return false
  if (a.mode === 'fixed' && b.mode === 'fixed') return a.replicas === b.replicas
  if (a.mode === 'auto' && b.mode === 'auto') return a.min === b.min && a.max === b.max && a.cpu === b.cpu && a.memory === b.memory
  return false
}

/* ─────────── environments and safeguards ─────────── */

export function isProductionEnv(env: string): boolean {
  const k = env.trim().toLowerCase()
  return k === 'prod' || k === 'production' || k.startsWith('prod-') || k.endsWith('-prod') || k === 'live'
}

/** "3 instances" / "1 instance". */
export function instances(n: number): string {
  return `${n} instance${n === 1 ? '' : 's'}`
}

function autoText(i: { min: number; max: number; cpu?: number; memory?: number }): string {
  const targets = [i.cpu !== undefined ? `${i.cpu}% CPU` : '', i.memory !== undefined ? `${i.memory}% memory` : ''].filter(Boolean).join(', ')
  return `${i.min}–${i.max}${targets ? ` at ${targets}` : ''}`
}

/** One line for an intent: "3 instances" / "autoscale 2–6 at 70% CPU". */
export function describeIntent(i: ScalingIntent): string {
  return i.mode === 'fixed' ? instances(i.replicas) : `autoscale ${autoText(i)}`
}

/** The diff preview: "3 → 5 instances", "Autoscaling off · hold 3 instances", … */
export function describeChange(from: ScalingIntent | undefined, to: ScalingIntent): string {
  if (to.mode === 'fixed') {
    if (!from) return `Hold ${instances(to.replicas)}`
    if (from.mode === 'auto') return `Autoscaling off · hold ${instances(to.replicas)}`
    return from.replicas === to.replicas ? `No change · ${instances(to.replicas)}` : `${from.replicas} → ${instances(to.replicas)}`
  }
  if (!from || from.mode === 'fixed') return `Autoscaling on · ${autoText(to)}`
  if (sameIntent(from, to)) return `No change · ${autoText(to)}`
  // Same targets: say them once ("Autoscale 1–3 → 2–6 at 70% CPU").
  if (from.cpu === to.cpu && from.memory === to.memory) {
    const targets = autoText({ ...to, min: 0, max: 0 }).replace(/^0–0/, '')
    return `Autoscale ${from.min}–${from.max} → ${to.min}–${to.max}${targets}`
  }
  return `Autoscale ${autoText(from)} → ${autoText(to)}`
}

export type ConfirmReason = 'production' | 'offline'

/** When a change needs the application's name typed to confirm it. */
export function confirmReason(env: string, to: ScalingIntent): ConfirmReason | null {
  if (to.mode === 'fixed' && to.replicas === 0) return 'offline'
  return isProductionEnv(env) ? 'production' : null
}

/** Advice shown with the preview — never blocking. */
export function changeWarnings(env: string, from: ScalingIntent | undefined, to: ScalingIntent): string[] {
  const out: string[] = []
  if (to.mode === 'fixed' && to.replicas === 0) out.push('0 instances takes the application offline in this environment: every request fails until it is scaled up again.')
  else if (isProductionEnv(env) && (to.mode === 'fixed' ? to.replicas : to.min) === 1) {
    out.push('One instance in production means every restart, deploy or node drain is an outage.')
  }
  if (to.mode === 'auto' && to.min === to.max) out.push(`Minimum and maximum are both ${to.min}: the autoscaler can never change the count.`)
  if (from?.mode === 'auto' && to.mode === 'fixed') out.push('The autoscaler stops adding instances under load.')
  return out
}

/* ─────────── live scalers (HPA, KEDA) ─────────── */

export interface ScalerCondition {
  type: string
  status: string
  reason?: string
  message?: string
}

export interface HpaView {
  name: string
  namespace: string
  min: number
  max: number
  cpuTarget?: number
  memoryTarget?: number
  cpuNow?: number
  memoryNow?: number
  /** Metrics the console does not edit (pods, object, external, or non-utilisation targets) — kept as they are. */
  otherMetrics: string[]
  current?: number
  desired?: number
  lastScaleTime?: string
  conditions: ScalerCondition[]
  /** Owned by a KEDA ScaledObject. */
  keda?: string
}

const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

interface RawMetric {
  type?: string
  resource?: { name?: string; target?: { type?: string; averageUtilization?: number }; current?: { averageUtilization?: number } }
}

function describeMetric(m: Record<string, unknown>): string {
  const type = String(m.type ?? 'Metric')
  const inner = (m[type.charAt(0).toLowerCase() + type.slice(1)] ?? {}) as { name?: string; metric?: { name?: string } }
  const name = inner.metric?.name ?? inner.name
  return name ? `${type}: ${name}` : type
}

/** An `autoscaling/v2` HorizontalPodAutoscaler, as the drawer reads it. */
export function hpaView(obj: KObj): HpaView {
  const spec = (obj.spec ?? {}) as { minReplicas?: number; maxReplicas?: number; metrics?: Array<Record<string, unknown>> }
  const st = (obj.status ?? {}) as {
    currentReplicas?: number
    desiredReplicas?: number
    lastScaleTime?: string
    currentMetrics?: RawMetric[]
    conditions?: ScalerCondition[]
  }
  let cpuTarget: number | undefined
  let memoryTarget: number | undefined
  const otherMetrics: string[] = []
  for (const m of spec.metrics ?? []) {
    const r = (m as RawMetric).resource
    const util = r?.target?.type === 'Utilization' ? n(r.target.averageUtilization) : undefined
    if ((m as RawMetric).type === 'Resource' && r?.name === 'cpu' && util !== undefined) cpuTarget = util
    else if ((m as RawMetric).type === 'Resource' && r?.name === 'memory' && util !== undefined) memoryTarget = util
    else otherMetrics.push(describeMetric(m))
  }
  let cpuNow: number | undefined
  let memoryNow: number | undefined
  for (const m of st.currentMetrics ?? []) {
    if (m.type !== 'Resource') continue
    const v = n(m.resource?.current?.averageUtilization)
    if (m.resource?.name === 'cpu') cpuNow = v
    if (m.resource?.name === 'memory') memoryNow = v
  }
  const owner = (obj.metadata.ownerReferences as Array<{ kind?: string; name?: string }> | undefined)?.find((o) => o.kind === 'ScaledObject')
  return {
    name: obj.metadata.name,
    namespace: obj.metadata.namespace ?? '',
    min: n(spec.minReplicas) ?? 1,
    max: n(spec.maxReplicas) ?? 1,
    ...(cpuTarget !== undefined ? { cpuTarget } : {}),
    ...(memoryTarget !== undefined ? { memoryTarget } : {}),
    ...(cpuNow !== undefined ? { cpuNow } : {}),
    ...(memoryNow !== undefined ? { memoryNow } : {}),
    otherMetrics,
    ...(n(st.currentReplicas) !== undefined ? { current: st.currentReplicas } : {}),
    ...(n(st.desiredReplicas) !== undefined ? { desired: st.desiredReplicas } : {}),
    ...(st.lastScaleTime ? { lastScaleTime: st.lastScaleTime } : {}),
    conditions: (st.conditions ?? []).filter((c) => c && c.type),
    ...(owner?.name ? { keda: owner.name } : obj.metadata.name.startsWith('keda-hpa-') ? { keda: obj.metadata.name.slice('keda-hpa-'.length) } : {}),
  }
}

interface TargetRef {
  kind?: string
  name?: string
}

/** The autoscaler whose `scaleTargetRef` is this workload. */
export function scalerFor(hpas: readonly KObj[], workload: { kind: string; name: string; namespace: string }): KObj | undefined {
  return hpas.find((h) => {
    const ref = ((h.spec ?? {}) as { scaleTargetRef?: TargetRef }).scaleTargetRef
    return (h.metadata.namespace ?? '') === workload.namespace && ref?.name === workload.name && (!ref.kind || ref.kind === workload.kind)
  })
}

/** A KEDA ScaledObject that scales this workload (KEDA's default target kind is Deployment). */
export function scaledObjectFor(objs: readonly KObj[], workload: { kind: string; name: string; namespace: string }): KObj | undefined {
  return objs.find((o) => {
    const ref = ((o.spec ?? {}) as { scaleTargetRef?: TargetRef }).scaleTargetRef
    return (o.metadata.namespace ?? '') === workload.namespace && ref?.name === workload.name && (ref.kind ?? 'Deployment') === workload.kind
  })
}

/** What is in force right now: the autoscaler's bounds, else the workload's fixed count. */
export function currentIntent(desired: number | undefined, hpa: HpaView | undefined): ScalingIntent | undefined {
  if (hpa) {
    return {
      mode: 'auto',
      min: hpa.min,
      max: hpa.max,
      ...(hpa.cpuTarget !== undefined ? { cpu: hpa.cpuTarget } : {}),
      ...(hpa.memoryTarget !== undefined ? { memory: hpa.memoryTarget } : {}),
    }
  }
  return desired === undefined ? undefined : { mode: 'fixed', replicas: desired }
}

/** The condition worth a line: why the autoscaler cannot or will not scale. */
export function scalerProblem(h: HpaView): ScalerCondition | undefined {
  const active = h.conditions.find((c) => c.type === 'ScalingActive')
  if (active?.status === 'False') return active
  const able = h.conditions.find((c) => c.type === 'AbleToScale')
  if (able?.status === 'False') return able
  return undefined
}

/**
 * When the autoscaler is pinned by its bounds. At the maximum it wants more
 * than it may have — worth a warning; at the minimum it is simply idle.
 */
export function scalerLimit(h: HpaView): { text: string; atMax: boolean } | undefined {
  const lim = h.conditions.find((c) => c.type === 'ScalingLimited' && c.status === 'True')
  if (!lim) return undefined
  if (lim.reason === 'TooManyReplicas') return { text: `held at its maximum (${h.max}) — load wants more`, atMax: true }
  if (lim.reason === 'TooFewReplicas') return { text: `idle at its minimum (${h.min})`, atMax: false }
  const text = lim.message ?? lim.reason
  return text ? { text, atMax: false } : undefined
}

/* ─────────── after "Apply": following the change to the pods ─────────── */

/** How a committed change reaches the cluster. */
export type RolloutMode = 'promotion' | 'argo' | 'deferred'

export interface ScalingOp {
  app: string
  env: string
  from?: ScalingIntent
  target: ScalingIntent
  startedAt: number
  commit?: string
  /** The Kargo Promotion that rolls the change out, when one was created. */
  promotion?: string
  rollout: RolloutMode
  /** Why the change waits for the next promotion (deferred only). */
  deferredReason?: string
  /** The console already set the committed count on the workload (see the header). */
  settleRequested?: boolean
}

export interface LiveScaling {
  workload?: { desired: number; ready: number; available: number }
  hpa?: HpaView
  promotion?: { phase: string; message?: string }
  argo?: { sync?: string; operation?: string }
}

export type OpPhase = 'promoting' | 'syncing' | 'settling' | 'scaling' | 'done' | 'failed' | 'deferred'

export interface OpState {
  phase: OpPhase
  /** Short live line under the progress steps. */
  detail: string
  /** 0 committed · 1 promoted · 2 synced · 3 running. */
  step: 0 | 1 | 2 | 3
  /** The committed count is in Git, but the HPA's last count stands — set it (see header). */
  needsSettle?: boolean
}

/** How long a change may take before the drawer calls it stuck. */
export const OP_TIMEOUT_MS = 15 * 60_000

/** Does the cluster now carry the target? (Not yet: whether the pods are up.) */
export function liveMatches(target: ScalingIntent, live: LiveScaling): boolean {
  if (target.mode === 'fixed') return !live.hpa && live.workload?.desired === target.replicas
  const h = live.hpa
  return Boolean(h && h.min === target.min && h.max === target.max && h.cpuTarget === target.cpu && h.memoryTarget === target.memory)
}

/** Where a change is, from the live objects alone — so reopening the drawer shows the same answer. */
export function deriveOp(op: ScalingOp, live: LiveScaling, now = Date.now()): OpState {
  if (op.rollout === 'deferred') {
    return { phase: 'deferred', step: 0, detail: op.deferredReason ?? 'Committed — it rolls out with the next promotion of this environment.' }
  }
  const promo = live.promotion?.phase
  if (op.promotion && (promo === 'Failed' || promo === 'Errored' || promo === 'Aborted')) {
    return { phase: 'failed', step: 0, detail: `Promotion ${promo.toLowerCase()}${live.promotion?.message ? `: ${live.promotion.message}` : ''}` }
  }
  const w = live.workload
  if (liveMatches(op.target, live)) {
    const want = op.target.mode === 'fixed' ? op.target.replicas : w?.desired ?? 0
    const ready = Math.min(w?.ready ?? 0, w?.available ?? 0)
    if (ready >= want && (w?.ready ?? 0) <= Math.max(want, w?.desired ?? want)) return { phase: 'done', step: 3, detail: `${instances(want)} running` }
    if (now - op.startedAt > OP_TIMEOUT_MS) return { phase: 'failed', step: 3, detail: `Only ${ready}/${want} ready after 15 minutes — check the pods.` }
    const running = w?.ready ?? 0
    return { phase: 'scaling', step: 3, detail: running > want ? `${running} running · stopping ${running - want}` : `${ready}/${want} ready` }
  }
  if (now - op.startedAt > OP_TIMEOUT_MS) {
    return { phase: 'failed', step: 1, detail: 'Not rolled out after 15 minutes — check the promotion and the Argo CD application.' }
  }
  if (op.promotion && promo !== 'Succeeded') {
    return { phase: 'promoting', step: 0, detail: promo === 'Running' ? 'Kargo is rendering the overlay' : 'Waiting for Kargo to start the promotion' }
  }
  // Rolled out (promotion done, or Argo CD syncing the overlay directly) but
  // the cluster does not carry it yet.
  const argoBusy = live.argo?.operation === 'Running' || live.argo?.sync === 'OutOfSync'
  if (op.target.mode === 'fixed' && !live.hpa && !argoBusy && w && w.desired !== op.target.replicas) {
    return { phase: 'settling', step: 2, detail: `Argo CD keeps the autoscaler's last count (${w.desired}); setting ${op.target.replicas}`, needsSettle: true }
  }
  return { phase: 'syncing', step: 1, detail: argoBusy ? 'Argo CD is applying the change' : 'Waiting for Argo CD to apply the change' }
}

/**
 * Drift with no change in flight: Git holds a fixed count, no autoscaler
 * exists, Argo CD is synced — and the workload still runs another count. That
 * is the HPA's last write, which Argo CD ignores; the drawer offers to set it.
 */
export function declaredDrift(declared: ScalingIntent | undefined, live: LiveScaling): number | undefined {
  if (declared?.mode !== 'fixed' || live.hpa || !live.workload) return undefined
  if (live.argo?.sync !== 'Synced' || live.argo.operation === 'Running') return undefined
  return live.workload.desired === declared.replicas ? undefined : declared.replicas
}

/* ─────────── the commit preview ─────────── */

export type DiffLine = { op: ' ' | '+' | '-'; text: string } | { op: '…'; text: string }

/** A line diff of two small files (LCS), with unchanged runs folded to `context` lines. */
export function lineDiff(before: string | null, after: string | null, context = 2): DiffLine[] {
  const a = before === null ? [] : before.replace(/\n$/, '').split('\n')
  const b = after === null ? [] : after.replace(/\n$/, '').split('\n')
  const full: Array<{ op: ' ' | '+' | '-'; text: string }> = []
  if (a.length * b.length > 250_000) {
    full.push(...a.map((text) => ({ op: '-' as const, text })), ...b.map((text) => ({ op: '+' as const, text })))
  } else {
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        full.push({ op: ' ', text: a[i] })
        i++
        j++
      } else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1])) full.push({ op: '-', text: a[i++] })
      else full.push({ op: '+', text: b[j++] })
    }
  }
  const out: DiffLine[] = []
  const changed = full.map((l) => l.op !== ' ')
  const near = (k: number) => changed.slice(Math.max(0, k - context), k + context + 1).some(Boolean)
  let hidden = 0
  full.forEach((l, k) => {
    if (l.op !== ' ' || near(k)) {
      if (hidden) out.push({ op: '…', text: `${hidden} unchanged line${hidden === 1 ? '' : 's'}` })
      hidden = 0
      out.push(l)
    } else hidden++
  })
  if (hidden) out.push({ op: '…', text: `${hidden} unchanged line${hidden === 1 ? '' : 's'}` })
  return out
}

/** "New size: 3; reason: cpu … above target" → "Scaled to 3 — cpu … above target". */
export function describeScaleEvent(reason: string, message: string): string {
  const m = /^New size: (\d+); reason: (.+)$/.exec(message.trim())
  if (m) return `Scaled to ${m[1]} — ${m[2]}`
  return reason ? `${reason}: ${message}` : message
}
