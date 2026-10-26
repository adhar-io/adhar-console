/**
 * Live run models — what a chaos run is doing RIGHT NOW, as one shape the run
 * canvas draws, whichever kind of run it is:
 *
 *   • an experiment   — one ChaosEngine and its ChaosResult;
 *   • a game day      — an Argo Workflow whose steps each run an engine;
 *   • a suite run     — a resilience-runner gate Job, read through its
 *                       timestamped log (`parseRunnerTimeline`).
 *
 * The canvas shows a lifecycle (scheduled → preparing → injecting →
 * recovering → verdict), the steps with their status and timing, and a
 * recovery timer. Everything is derived from what the cluster reports; a
 * time the cluster does not record (when recovery began, say) is the moment
 * this page first OBSERVED it, and the view says so.
 *
 * Pure: no React, no fetch — the rules are pinned by `chaos-live_test.ts`.
 */

import type { PhaseWindow, RunnerTimeline } from '@adhar/utils'
import { durationOf, errorReason, faultById, faultOf, isLive, isOver, measuredProbe, phaseOf, type ChaosEngine, type ChaosResult } from './chaos-kinds.ts'
import type { ChaosWorkflow, ChaosWorkflowNode } from './chaos.ts'
import { type GameDayInput, LABEL_SCENARIO, scenarioById, type Scenario } from './chaos-scenarios.ts'
import { LABEL_GAMEDAY } from './chaos.ts'

/* ─────────────────────────── shared shape ─────────────────────────── */

export type Stage = 'scheduled' | 'preparing' | 'injecting' | 'recovering' | 'verdict'

export const STAGES: Stage[] = ['scheduled', 'preparing', 'injecting', 'recovering', 'verdict']

export const STAGE_LABEL: Record<Stage, string> = {
  scheduled: 'Scheduled',
  preparing: 'Preparing',
  injecting: 'Injecting fault',
  recovering: 'Recovering',
  verdict: 'Verdict',
}

export type Verdict = 'passed' | 'failed' | 'stopped' | 'error'

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error' | 'skipped' | 'stopped'

export interface RunStep {
  id: string
  kind: 'prepare' | 'load' | 'fault' | 'pause' | 'revert' | 'verdict'
  label: string
  /** The fault id, for a fault step. */
  fault?: string
  hypothesis?: string
  status: StepStatus
  start?: number
  end?: number
  /** Planned length, for a progress bar while it runs. */
  seconds?: number
  probeSuccessPercentage?: number
  recoverySeconds?: number
  detail?: string
}

export interface LiveRun {
  stage: Stage
  verdict?: Verdict
  steps: RunStep[]
  /** Windows to shade on the metric charts. */
  windows: PhaseWindow[]
  startedAt?: number
  finishedAt?: number
  /** Still changing — poll and keep the timers ticking. */
  active: boolean
}

/* ─────────────────────────── experiment (one engine) ─────────────────────────── */

const ts = (iso?: string) => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? t : undefined
}

/**
 * When the fault started being applied: the ChaosResult is created as the
 * experiment pod starts. Litmus REUSES a result across runs of the same
 * engine and fault (it only bumps `history`), so a result older than the
 * engine belongs to an earlier run of that name and says nothing about this
 * one's start — reading it gave a finished run a negative duration.
 */
export function injectionStart(engine: ChaosEngine, result?: ChaosResult): number | undefined {
  const created = ts(engine.metadata.creationTimestamp)
  const fromResult = ts(result?.metadata.creationTimestamp)
  const own = fromResult !== undefined && (created === undefined || fromResult >= created) ? fromResult : undefined
  return own ?? (isLive(engine) ? ts(engine.status?.experiments?.[0]?.lastUpdateTime) : undefined)
}

export interface Observed {
  /** First poll at which the page saw the fault no longer applied. */
  faultEndedAt?: number
  /** First poll at which every target pod was ready again after that. */
  recoveredAt?: number
}

/**
 * The lifecycle of one experiment.
 *
 * `targetReady` is the live readiness of the target's pods (undefined when
 * not known — a node fault, or no pods matched). A run Litmus has finished
 * whose target is not back yet is still RECOVERING — the verdict alone does
 * not say the service is whole again.
 */
export function engineRun(engine: ChaosEngine, result: ChaosResult | undefined, opts: { now: number; targetReady?: boolean; observed?: Observed }): LiveRun {
  const phase = phaseOf(engine)
  const fault = faultOf(engine)
  const seconds = durationOf(engine)
  const created = ts(engine.metadata.creationTimestamp)
  const start = injectionStart(engine, result)
  const exp = result?.status?.experimentStatus
  const verdictRaw = (exp?.verdict ?? engine.status?.experiments?.[0]?.verdict ?? '').toLowerCase()
  const over = isOver(engine)
  const faultEnd = opts.observed?.faultEndedAt ?? (over && start && seconds ? Math.min(opts.now, start + seconds * 1000) : undefined)
  const recovering = phase === 'recovering' || (over && opts.targetReady === false)

  let stage: Stage
  if (recovering) stage = 'recovering'
  else if (over) stage = 'verdict'
  else if (phase === 'injected') stage = 'injecting'
  else if (engine.status?.engineStatus || engine.status?.experiments?.length) stage = 'preparing'
  else stage = 'scheduled'

  const verdict: Verdict | undefined = !over && !recovering
    ? undefined
    : phase === 'stopped' || verdictRaw === 'stopped'
    ? 'stopped'
    : verdictRaw === 'pass'
    ? 'passed'
    : verdictRaw === 'fail'
    ? 'failed'
    : over
    ? 'error'
    : undefined

  const pct = measuredProbe(result)
  const recoveredIn = opts.observed?.recoveredAt && faultEnd ? Math.max(0, Math.round((opts.observed.recoveredAt - faultEnd) / 1000)) : undefined
  const def = faultById(fault)
  const status: StepStatus = stage === 'injecting' || stage === 'recovering' ? 'running' : verdict === 'passed' ? 'passed' : verdict === 'failed' ? 'failed' : verdict === 'stopped' ? 'stopped' : verdict === 'error' ? 'error' : 'pending'
  const steps: RunStep[] = [
    { id: 'prepare', kind: 'prepare', label: 'Select targets and start the runner', status: stage === 'scheduled' || stage === 'preparing' ? 'running' : 'passed', start: created, end: start },
    {
      id: fault,
      kind: 'fault',
      fault,
      label: def?.label ?? fault,
      status,
      start,
      end: faultEnd,
      seconds,
      ...(pct !== undefined ? { probeSuccessPercentage: pct } : {}),
      ...(recoveredIn !== undefined ? { recoverySeconds: recoveredIn } : {}),
      ...(verdict === 'error' && errorReason(result) ? { detail: errorReason(result) } : exp?.failStep ? { detail: exp.failStep } : {}),
    },
  ]
  const windows: PhaseWindow[] = []
  if (start) windows.push({ kind: 'fault', name: fault, start, ...(faultEnd ? { end: faultEnd } : {}) })
  if (faultEnd && (recovering || opts.observed?.recoveredAt)) windows.push({ kind: 'recovery', name: fault, start: faultEnd, ...(opts.observed?.recoveredAt ? { end: opts.observed.recoveredAt } : {}) })
  // A finished run's end: what this page saw, else the fault's end, else the
  // moment Litmus last updated the experiment (it does so as it completes).
  // Never before the engine existed — that would be another run's time.
  const lastUpdate = ts(engine.status?.experiments?.[0]?.lastUpdateTime)
  const end = opts.observed?.recoveredAt ?? faultEnd ?? (over && lastUpdate !== undefined && (created === undefined || lastUpdate >= created) ? lastUpdate : undefined)
  return {
    stage,
    ...(verdict && stage === 'verdict' ? { verdict } : {}),
    steps,
    windows,
    ...(created ? { startedAt: created } : {}),
    ...(stage === 'verdict' && end ? { finishedAt: end } : {}),
    active: stage !== 'verdict',
  }
}

/** Update what the page has observed, poll by poll. Returns the same object when nothing changed. */
export function observe(prev: Observed, input: { live: boolean; over: boolean; targetReady?: boolean; now: number }): Observed {
  let next = prev
  if (!input.live && input.over && prev.faultEndedAt === undefined) next = { ...next, faultEndedAt: input.now }
  if (next.faultEndedAt !== undefined && next.recoveredAt === undefined && input.targetReady) next = { ...next, recoveredAt: input.now }
  return next
}

/* ─────────────────────────── probe timeline ─────────────────────────── */

export type ProbeVerdict = 'passed' | 'failed' | 'awaited' | 'na'

export interface ProbeSample {
  t: number
  /** probe name → verdict at this poll */
  probes: Record<string, ProbeVerdict>
  /** probeSuccessPercentage when Litmus has written one. */
  pct?: number
}

function probeVerdict(v: string | undefined): ProbeVerdict {
  const s = (v ?? '').toLowerCase()
  if (s.startsWith('pass')) return 'passed'
  if (s.startsWith('fail')) return 'failed'
  if (s === 'n/a' || s === 'na') return 'na'
  return 'awaited'
}

/**
 * Append this poll's probe state to the observed timeline. A sample equal to
 * the last one only moves the last one's time forward, so a quiet run stays
 * a handful of samples however long it is watched; the timeline is capped.
 */
export function addProbeSample(prev: ProbeSample[], result: ChaosResult | undefined, t: number, max = 400): ProbeSample[] {
  const statuses = result?.status?.probeStatuses ?? []
  if (!statuses.length) return prev
  const probes: Record<string, ProbeVerdict> = {}
  for (const p of statuses) probes[p.name] = probeVerdict(p.status?.verdict)
  const pctN = Number(result?.status?.experimentStatus?.probeSuccessPercentage)
  const sample: ProbeSample = { t, probes, ...(Number.isFinite(pctN) && result?.status?.experimentStatus?.probeSuccessPercentage !== '' ? { pct: pctN } : {}) }
  const last = prev[prev.length - 1]
  if (last && JSON.stringify(last.probes) === JSON.stringify(probes) && last.pct === sample.pct) {
    // Keep the first sample of a run of equal states and a moving tail.
    return prev.length >= 2 && JSON.stringify(prev[prev.length - 2].probes) === JSON.stringify(probes) && prev[prev.length - 2].pct === sample.pct
      ? [...prev.slice(0, -1), sample]
      : [...prev, sample]
  }
  const next = [...prev, sample]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Segments of one probe's state over the observed timeline, for a status strip. */
export function probeSegments(samples: ProbeSample[], probe: string, until: number): Array<{ start: number; end: number; verdict: ProbeVerdict }> {
  const out: Array<{ start: number; end: number; verdict: ProbeVerdict }> = []
  samples.forEach((s, i) => {
    const v = s.probes[probe]
    if (!v) return
    const end = samples[i + 1]?.t ?? until
    const last = out[out.length - 1]
    if (last && last.verdict === v) last.end = end
    else out.push({ start: s.t, end, verdict: v })
  })
  return out
}

/* ─────────────────────────── game day (Argo Workflow) ─────────────────────────── */

export type GameDayPhase = 'pending' | 'running' | 'stopping' | 'accomplished' | 'aborted' | 'stopped'

/**
 * A workflow's state, read from Argo's phase.
 *
 * `Failed` here is NOT a failure of the tool — a scenario step exits non-zero
 * when its hypothesis did not hold, which is the experiment producing its
 * most important answer. A workflow somebody shut down (`spec.shutdown`) is
 * `stopping` until Argo has run the revert exit handler, then `stopped`.
 */
export function workflowPhase(wf: ChaosWorkflow): GameDayPhase {
  const shutdown = typeof wf.spec?.shutdown === 'string' && wf.spec.shutdown !== ''
  switch (wf.status?.phase) {
    case 'Succeeded':
      return 'accomplished'
    case 'Failed':
    case 'Error':
      return shutdown ? 'stopped' : 'aborted'
    case 'Running':
      return shutdown ? 'stopping' : 'running'
    default:
      return wf.status?.startedAt ? (shutdown ? 'stopping' : 'running') : 'pending'
  }
}

export interface GameDayStep {
  /** Template name, e.g. `2-net-latency`. */
  template: string
  kind: 'scenario' | 'pause' | 'revert'
  seconds?: number
  scenario?: Scenario
  phase: 'done' | 'running' | 'pending' | 'failed' | 'skipped'
  startedAt?: string
  finishedAt?: string
  message?: string
}

/**
 * The declared steps, in declaration order, joined to whatever nodes exist.
 *
 * Driving the timeline off the SPEC rather than off the nodes matters: Argo
 * creates a node as the workflow reaches it, so a node-driven list would show
 * a game day as having only the steps it has already run, and the operator
 * could not see what is still coming. Steps a stopped or failed run never
 * reached read as skipped, not pending forever.
 */
export function orderSteps(wf: ChaosWorkflow | undefined): GameDayStep[] {
  if (!wf?.spec?.templates) return []
  const nodes = Object.values(wf.status?.nodes ?? {}) as ChaosWorkflowNode[]
  const declared = wf.spec.templates.filter((t) => t.name !== wf.spec?.entrypoint)
  const finished = !!wf.status?.finishedAt || wf.status?.phase === 'Failed' || wf.status?.phase === 'Error' || wf.status?.phase === 'Succeeded'
  const nodeFor = (template: string) => nodes.find((n) => n.templateName === template && n.type !== 'StepGroup')

  return declared.map((t) => {
    const template = String(t.name ?? '')
    const node = nodeFor(template)
    const phase: GameDayStep['phase'] = !node
      ? (finished ? 'skipped' : 'pending')
      : node.phase === 'Succeeded'
      ? 'done'
      : node.phase === 'Failed' || node.phase === 'Error'
      ? 'failed'
      : node.phase === 'Skipped' || node.phase === 'Omitted'
      ? 'skipped'
      : 'running'
    const kind: GameDayStep['kind'] = template === 'revert' ? 'revert' : 'suspend' in t ? 'pause' : 'scenario'
    // Template names are `<index>-<scenario id>`; recover the scenario for
    // its hypothesis, which is what makes the timeline readable.
    const scenario = kind === 'scenario' ? scenarioById(template.replace(/^\d+-/, '')) : undefined
    const suspend = (t as { suspend?: { duration?: string } }).suspend
    return {
      template,
      kind,
      seconds: scenario?.seconds ?? (suspend?.duration ? Number(String(suspend.duration).replace(/s$/, '')) || undefined : undefined),
      scenario,
      phase,
      startedAt: node?.startedAt,
      finishedAt: node?.finishedAt,
      message: node?.message,
    }
  })
}

const STEP_STATUS: Record<GameDayStep['phase'], StepStatus> = { done: 'passed', running: 'running', pending: 'pending', failed: 'failed', skipped: 'skipped' }

/** A game day as a live run. */
export function gameDayRun(wf: ChaosWorkflow): LiveRun {
  const phase = workflowPhase(wf)
  const steps = orderSteps(wf)
  const running = steps.find((s) => s.phase === 'running')
  const stage: Stage = phase === 'pending'
    ? 'scheduled'
    : phase === 'running' || phase === 'stopping'
    ? running?.kind === 'pause' || running?.kind === 'revert' || phase === 'stopping' ? 'recovering' : running ? 'injecting' : 'preparing'
    : 'verdict'
  const verdict: Verdict | undefined = phase === 'accomplished' ? 'passed' : phase === 'aborted' ? 'failed' : phase === 'stopped' ? 'stopped' : undefined
  const windows: PhaseWindow[] = []
  for (const s of steps) {
    const start = ts(s.startedAt)
    if (!start) continue
    const end = ts(s.finishedAt)
    windows.push({ kind: s.kind === 'scenario' ? 'fault' : s.kind === 'pause' ? 'recovery' : 'revert', name: s.scenario?.fault ?? s.template, start, ...(end ? { end } : {}) })
  }
  return {
    stage,
    ...(verdict ? { verdict } : {}),
    steps: steps.map((s) => ({
      id: s.template,
      kind: s.kind === 'scenario' ? 'fault' : s.kind,
      label: s.scenario?.title ?? (s.kind === 'pause' ? 'Recovery pause' : s.kind === 'revert' ? 'Revert — stop and remove every engine' : s.template),
      ...(s.scenario ? { fault: s.scenario.fault, hypothesis: s.scenario.hypothesis } : {}),
      status: STEP_STATUS[s.phase],
      ...(ts(s.startedAt) ? { start: ts(s.startedAt) } : {}),
      ...(ts(s.finishedAt) ? { end: ts(s.finishedAt) } : {}),
      ...(s.seconds ? { seconds: s.seconds } : {}),
      ...(s.message && s.phase === 'failed' ? { detail: s.message } : {}),
    })),
    windows,
    ...(ts(wf.status?.startedAt) ? { startedAt: ts(wf.status?.startedAt) } : {}),
    ...(ts(wf.status?.finishedAt) ? { finishedAt: ts(wf.status?.finishedAt) } : {}),
    active: phase === 'pending' || phase === 'running' || phase === 'stopping',
  }
}

/* ─────────────────────────── suite run (gate Job + its log) ─────────────────────────── */

export interface SuiteRunInput {
  /** The faults the suite declares, in run order. */
  faults: Array<{ name: string; hypothesis?: string; seconds?: number }>
  timeline?: RunnerTimeline
  /** The Job: started, finished, still running? */
  job: { startTime?: string; completionTime?: string; phase: 'pending' | 'running' | 'succeeded' | 'failed' }
  /** Seconds the runner injects each fault (its `chaos_seconds`), when known. */
  faultSeconds?: number
}

/**
 * A resilience suite run as a live run: preparing (waiting for the app), the
 * load test, each declared fault in order, then the gate verdict. A fault the
 * log has not reached yet is pending; once the Job ended, skipped.
 */
export function suiteRun(input: SuiteRunInput): LiveRun {
  const phases = input.timeline?.phases ?? []
  const jobStart = ts(input.job.startTime)
  const jobEnd = ts(input.job.completionTime)
  const done = input.job.phase === 'succeeded' || input.job.phase === 'failed'
  const load = phases.find((p) => p.kind === 'load')
  const firstAt = phases[0]?.start
  const status = (p: PhaseWindow | undefined): StepStatus =>
    !p ? (done ? 'skipped' : 'pending') : p.end === undefined ? (done ? 'error' : 'running') : p.status === 'passed' ? 'passed' : p.status === 'failed' ? 'failed' : p.status === 'opted-out' || p.status === 'unavailable' ? 'skipped' : 'error'

  const names = [...input.faults.map((f) => f.name)]
  for (const p of phases) if (p.kind === 'fault' && !names.includes(p.name)) names.push(p.name)

  const steps: RunStep[] = [
    {
      id: 'prepare',
      kind: 'prepare',
      label: 'Wait for the application to be ready',
      status: firstAt ? 'passed' : done ? (input.timeline?.alreadyPassed ? 'passed' : 'error') : 'running',
      ...(jobStart ? { start: jobStart } : {}),
      ...(firstAt ? { end: firstAt } : {}),
    },
    { id: 'load-test', kind: 'load', label: 'Load test', status: status(load), ...(load ? { start: load.start, ...(load.end ? { end: load.end } : {}) } : {}) },
    ...names.map((name): RunStep => {
      const p = phases.find((x) => x.kind === 'fault' && x.name === name)
      const rec = phases.find((x) => x.kind === 'recovery' && x.name === name)
      const decl = input.faults.find((f) => f.name === name)
      const seconds = decl?.seconds ?? p?.plannedSeconds ?? input.faultSeconds
      return {
        id: name,
        kind: 'fault',
        fault: name,
        label: faultById(name)?.label ?? name,
        ...(decl?.hypothesis ? { hypothesis: decl.hypothesis } : {}),
        status: status(p),
        ...(p ? { start: p.start } : {}),
        ...(rec?.end ?? p?.end ? { end: rec?.end ?? p?.end } : {}),
        ...(seconds ? { seconds } : {}),
        ...(p?.probeSuccessPercentage !== undefined ? { probeSuccessPercentage: p.probeSuccessPercentage } : {}),
        ...(p?.recoverySeconds !== undefined ? { recoverySeconds: p.recoverySeconds } : {}),
      }
    }),
  ]
  const gate = input.timeline?.gate
  steps.push({
    id: 'verdict',
    kind: 'verdict',
    label: 'Promotion gate verdict',
    status: gate ? (gate.verdict === 'pass' ? 'passed' : gate.verdict === 'fail' ? 'failed' : 'skipped') : done ? (input.job.phase === 'failed' ? 'failed' : 'passed') : 'pending',
    ...(gate?.reasons.length ? { detail: gate.reasons.join('; ') } : input.timeline?.alreadyPassed ? { detail: 'This image had already passed the gate here; nothing was retested.' } : {}),
  })

  const runningStep = steps.find((s) => s.status === 'running')
  const inRecovery = phases.some((p) => p.kind === 'recovery' && p.end === undefined)
  const stage: Stage = done
    ? 'verdict'
    : !jobStart
    ? 'scheduled'
    : runningStep?.kind === 'fault'
    ? inRecovery ? 'recovering' : 'injecting'
    : runningStep?.kind === 'load' || runningStep?.kind === 'prepare'
    ? 'preparing'
    : 'recovering'
  const failed = steps.some((s) => s.status === 'failed')
  return {
    stage,
    ...(done ? { verdict: failed || input.job.phase === 'failed' ? 'failed' as const : 'passed' as const } : {}),
    steps,
    windows: phases,
    ...(jobStart ? { startedAt: jobStart } : {}),
    ...(jobEnd ? { finishedAt: jobEnd } : {}),
    active: !done,
  }
}

/* ─────────────────────────── shared readings ─────────────────────────── */

/** 0–1 progress of a running step against its planned length. */
export function stepProgress(step: RunStep, now: number): number | undefined {
  if (step.status !== 'running' || !step.start || !step.seconds) return undefined
  return Math.max(0, Math.min(1, (now - step.start) / (step.seconds * 1000)))
}

/** `1m 05s`; `2h 05m` past an hour (a run opened long after it started). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  if (h) return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  const m = Math.floor(s / 60)
  const r = s % 60
  return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`
}

/* ─────────────────────────── re-run ─────────────────────────── */

/** `checkout-pod-delete` → `checkout-pod-delete-r2`, `…-r2` → `…-r3`; ≤ 63 chars. */
export function rerunName(name: string, taken: Iterable<string> = []): string {
  const used = new Set([name, ...taken])
  const base = name.replace(/-r\d+$/, '')
  for (let i = 2; i < 1000; i++) {
    const n = `${base.slice(0, 63 - `-r${i}`.length).replace(/-+$/, '')}-r${i}`
    if (!used.has(n)) return n
  }
  return `${base.slice(0, 56)}-${Date.now().toString(36).slice(-6)}`
}

/**
 * A fresh engine with the same fault, target, knobs and probes as `engine` —
 * the run's own spec with its state reset, so a re-run tests exactly what
 * the original did. Labels are kept (they say what the run targets); status,
 * uid and every server-set field are dropped.
 */
export function rerunManifest(engine: ChaosEngine, name: string): ChaosEngine {
  const spec = structuredClone(engine.spec ?? {})
  spec.engineState = 'active'
  // A re-run is a run of its own: it is not part of the game day the original
  // belonged to (whose revert step would not know to remove it).
  const labels = { ...(engine.metadata.labels ?? {}) }
  delete labels[LABEL_GAMEDAY]
  delete labels[LABEL_SCENARIO]
  return {
    apiVersion: engine.apiVersion ?? 'litmuschaos.io/v1alpha1',
    kind: 'ChaosEngine',
    metadata: {
      name,
      namespace: engine.metadata.namespace,
      labels: { ...labels, 'app.kubernetes.io/managed-by': 'adhar-console', 'adhar.io/rerun-of': engine.metadata.name.slice(0, 63) },
    },
    spec,
  }
}

/**
 * The builder input that made a game day, read back from the workflow: the
 * scenarios (annotation), the order, the recovery pause, and the target and
 * probe from its first engine. Undefined when the workflow was not made by
 * the console's builder — a re-run must reproduce, not guess.
 */
export function gameDayInputFrom(wf: ChaosWorkflow, name: string): GameDayInput | undefined {
  const scenarios = (wf.metadata.annotations?.['adhar.io/chaos-scenarios'] ?? '').split(',').filter((s) => !!scenarioById(s))
  if (!scenarios.length) return undefined
  const templates = wf.spec?.templates ?? []
  const first = templates.find((t) => /^\d+-/.test(String(t.name ?? '')) && 'inputs' in t) as
    | { inputs?: { artifacts?: Array<{ raw?: { data?: string } }> } }
    | undefined
  let engine: ChaosEngine | undefined
  try {
    engine = JSON.parse(first?.inputs?.artifacts?.[0]?.raw?.data ?? '') as ChaosEngine
  } catch {
    return undefined
  }
  const app = engine?.spec?.appinfo
  if (!engine || !app?.appns) return undefined
  const env = Object.fromEntries((engine.spec?.experiments?.[0]?.spec?.components?.env ?? []).map((e) => [e.name, e.value]))
  const pct = env.PODS_AFFECTED_PERC
  const probe = engine.spec?.experiments?.[0]?.spec?.probe?.[0] as
    | { runProperties?: { interval?: string }; 'httpProbe/inputs'?: { url?: string; method?: { get?: { responseCode?: string } } } }
    | undefined
  const url = probe?.['httpProbe/inputs']?.url
  const pause = templates.find((t) => 'suspend' in t) as { suspend?: { duration?: string } } | undefined
  const strategy = wf.metadata.annotations?.['adhar.io/chaos-strategy'] === 'parallel' ? 'parallel' : 'serial'
  return {
    name,
    target: {
      namespace: app.appns,
      label: app.applabel ?? '',
      ...(app.appkind ? { appKind: app.appkind as 'deployment' } : {}),
      mode: !pct ? 'one' : pct === '100' ? 'all' : 'percent',
      ...(pct && pct !== '100' ? { percent: pct } : {}),
    },
    scenarios,
    strategy,
    recoverySeconds: Number(String(pause?.suspend?.duration ?? '0').replace(/s$/, '')) || 0,
    ...(url
      ? {
        steadyState: {
          url,
          statusCode: Number(probe?.['httpProbe/inputs']?.method?.get?.responseCode ?? 200) || 200,
          intervalSeconds: Number(String(probe?.runProperties?.interval ?? '5').replace(/s$/, '')) || 5,
        },
      }
      : {}),
  }
}

/* ─────────────────────────── target pods ─────────────────────────── */

/** The slice of a Pod the canvas reads. */
export interface PodLike {
  metadata: { name: string; creationTimestamp?: string; deletionTimestamp?: string; labels?: Record<string, string>; ownerReferences?: Array<{ kind: string; name?: string }> }
  spec?: { nodeName?: string }
  status?: {
    phase?: string
    conditions?: Array<{ type: string; status: string }>
    containerStatuses?: Array<{ name: string; ready?: boolean; restartCount?: number; state?: { waiting?: { reason?: string }; terminated?: { reason?: string } }; lastState?: { terminated?: { reason?: string } } }>
  }
}

export interface TargetPodRow {
  name: string
  ready: boolean
  /** Running, Pending, Terminating, CrashLoopBackOff… — the most specific state. */
  state: string
  restarts: number
  node?: string
  createdAt?: number
  /** Why the last container restart happened (OOMKilled, Error…). */
  lastReason?: string
}

export interface TargetPods {
  rows: TargetPodRow[]
  total: number
  ready: number
  restarts: number
  /** Every pod ready and none terminating — the target is whole. */
  whole: boolean
}

/** Pods → the live readiness the canvas shows (and recovery is judged on). */
export function targetPods(pods: PodLike[]): TargetPods {
  const rows = pods.map((p): TargetPodRow => {
    const cs = p.status?.containerStatuses ?? []
    const terminating = !!p.metadata.deletionTimestamp
    const ready = !terminating && p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') === true
    const waiting = cs.map((c) => c.state?.waiting?.reason ?? c.state?.terminated?.reason).find(Boolean)
    const t = Date.parse(p.metadata.creationTimestamp ?? '')
    return {
      name: p.metadata.name,
      ready,
      state: terminating ? 'Terminating' : waiting ?? p.status?.phase ?? 'Unknown',
      restarts: cs.reduce((a, c) => a + (c.restartCount ?? 0), 0),
      ...(p.spec?.nodeName ? { node: p.spec.nodeName } : {}),
      ...(Number.isFinite(t) ? { createdAt: t } : {}),
      ...(cs.map((c) => c.lastState?.terminated?.reason).find(Boolean) ? { lastReason: cs.map((c) => c.lastState?.terminated?.reason).find(Boolean) } : {}),
    }
  }).sort((a, b) => Number(a.ready) - Number(b.ready) || a.name.localeCompare(b.name))
  const ready = rows.filter((r) => r.ready).length
  return {
    rows,
    total: rows.length,
    ready,
    restarts: rows.reduce((a, r) => a + r.restarts, 0),
    whole: rows.length > 0 && ready === rows.length && !rows.some((r) => r.state === 'Terminating'),
  }
}
