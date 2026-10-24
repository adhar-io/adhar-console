/**
 * A k6 TestRun's lifecycle, derived from what the cluster actually recorded.
 *
 * The operator's `status.stage` is coarse (`initialization → initialized →
 * created → started → finished`) and its conditions are named after its own
 * bookkeeping (`TestRunRunning`, `CloudTestRun`, `TeardownExecuted`) — none of
 * them is named after a stage, so timing stages from condition names finds
 * nothing. The pods are where the real timestamps are:
 *
 *   initializer  `k6 archive` + `k6 inspect` — the script is parsed and split
 *   runners      one per `parallelism`, each executing its slice of the load
 *   starter      releases paused runners together (a no-op when not paused)
 *
 * Each container's `state.terminated.{startedAt,finishedAt,exitCode}` gives
 * real start/end times and a real outcome. k6's own exit codes then separate
 * "the test ran and its thresholds failed" (99) from "the test could not run"
 * (107 script error, 104 bad config, …) — the two verdicts the Performance
 * Center never conflates.
 *
 * Pure: takes plain objects, returns plain objects; React-free so it is tested
 * directly (perf-run-model_test.ts).
 */

import { type LoadPlan, plannedVusAt, type PlanSegmentKind, segmentAt } from './perf-plan.ts'

/* ─────────────────────────── inputs ─────────────────────────── */

/** The slice of a TestRun the model reads. Structural, so `k6.ts`'s type fits. */
export interface RunLike {
  metadata: { name: string; namespace?: string; creationTimestamp?: string; annotations?: Record<string, string> }
  spec?: { parallelism?: number; paused?: string | boolean }
  status?: {
    stage?: string
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }>
  }
}

/** The slice of a Pod the model reads. */
export interface PodLike {
  metadata: { name: string; creationTimestamp?: string; labels?: Record<string, string>; deletionTimestamp?: string }
  spec?: { nodeName?: string; containers?: Array<{ name?: string; command?: string[]; args?: string[] }> }
  status?: {
    phase?: string
    reason?: string
    message?: string
    startTime?: string
    containerStatuses?: Array<{
      name?: string
      restartCount?: number
      ready?: boolean
      state?: Record<string, unknown>
    }>
  }
}

export type PodRole = 'initializer' | 'runner' | 'starter'

export interface PodDetail {
  name: string
  role: PodRole
  /** Runner instance number (`<run>-<n>-…`), 1-based. */
  index?: number
  phase?: string
  state: 'pending' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'unknown'
  /** `ContainerCreating`, `ImagePullBackOff`, `Error`, `Completed`, … */
  reason?: string
  message?: string
  exitCode?: number
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  restarts: number
  node?: string
  /** Runner started with `--paused` — it waits for the starter. */
  paused?: boolean
  terminating?: boolean
}

/* ─────────────────────────── pods ─────────────────────────── */

const ROLE_ORDER: Record<PodRole, number> = { initializer: 0, runner: 1, starter: 2 }

export function podRole(name: string, labels?: Record<string, string>): PodRole {
  const job = labels?.['job-name'] ?? labels?.['batch.kubernetes.io/job-name'] ?? ''
  if (labels?.runner === 'true') return 'runner'
  if (job.endsWith('-initializer') || /-initializer(-|$)/.test(name)) return 'initializer'
  if (job.endsWith('-starter') || /-starter(-|$)/.test(name)) return 'starter'
  return 'runner'
}

function runnerIndex(run: string, name: string, labels?: Record<string, string>): number | undefined {
  const job = labels?.['job-name'] ?? labels?.['batch.kubernetes.io/job-name']
  const src = job ?? name
  const m = src.slice(run.length).match(/^-(\d+)(?:-|$)/)
  return m ? Number(m[1]) : undefined
}

export function podDetail(run: string, p: PodLike): PodDetail {
  const role = podRole(p.metadata.name, p.metadata.labels)
  const cs = p.status?.containerStatuses?.[0]
  const st = (cs?.state ?? {}) as {
    waiting?: { reason?: string; message?: string }
    running?: { startedAt?: string }
    terminated?: { exitCode?: number; reason?: string; message?: string; startedAt?: string; finishedAt?: string }
  }
  const phase = p.status?.phase
  let state: PodDetail['state'] = 'unknown'
  if (st.terminated) state = st.terminated.exitCode === 0 ? 'succeeded' : 'failed'
  else if (st.running) state = 'running'
  else if (st.waiting) state = 'waiting'
  else if (phase === 'Pending') state = 'pending'
  else if (phase === 'Running') state = 'running'
  else if (phase === 'Succeeded') state = 'succeeded'
  else if (phase === 'Failed') state = 'failed'
  const c = p.spec?.containers?.[0]
  const argv = [...(c?.command ?? []), ...(c?.args ?? [])]
  return {
    name: p.metadata.name,
    role,
    index: role === 'runner' ? runnerIndex(run, p.metadata.name, p.metadata.labels) : undefined,
    phase,
    state,
    reason: st.terminated?.reason ?? st.waiting?.reason ?? p.status?.reason,
    message: st.terminated?.message ?? st.waiting?.message ?? p.status?.message,
    exitCode: typeof st.terminated?.exitCode === 'number' ? st.terminated.exitCode : undefined,
    createdAt: p.metadata.creationTimestamp,
    startedAt: st.terminated?.startedAt ?? st.running?.startedAt,
    finishedAt: st.terminated?.finishedAt,
    restarts: cs?.restartCount ?? 0,
    node: p.spec?.nodeName,
    paused: role === 'runner' ? argv.includes('--paused') || undefined : undefined,
    terminating: p.metadata.deletionTimestamp ? true : undefined,
  }
}

/** Initializer, runners in instance order, then the starter. */
export function sortPods(pods: PodDetail[]): PodDetail[] {
  return [...pods].sort((a, b) =>
    ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.index ?? 0) - (b.index ?? 0) ||
    a.name.localeCompare(b.name, undefined, { numeric: true })
  )
}

/**
 * Job retries leave several pods for one role. Keep the newest per job slot
 * (initializer / runner N / starter) so a retried runner is not counted twice;
 * the older attempts are still listed by the caller for their logs.
 */
export function latestPerSlot(pods: PodDetail[]): PodDetail[] {
  const by = new Map<string, PodDetail>()
  for (const p of pods) {
    const slot = p.role === 'runner' ? `runner-${p.index ?? p.name}` : p.role
    const prev = by.get(slot)
    if (!prev || (p.createdAt ?? '') > (prev.createdAt ?? '')) by.set(slot, p)
  }
  return sortPods([...by.values()])
}

/** The runner whose output the drawer reads first: the lowest healthy instance. */
export function primaryRunner(pods: PodDetail[]): PodDetail | undefined {
  const runners = latestPerSlot(pods).filter((p) => p.role === 'runner')
  return runners.find((p) => p.state !== 'pending' && p.state !== 'waiting') ?? runners[0]
}

/* ─────────────────────────── k6 exit codes ─────────────────────────── */

/** k6's documented exit codes (errext/exitcodes). */
export const K6_EXIT: Record<number, string> = {
  0: 'completed',
  97: 'cloud test run failed',
  98: 'could not get cloud progress',
  99: 'thresholds crossed',
  100: 'setup() timed out',
  101: 'teardown() timed out',
  102: 'timed out',
  103: 'k6 engine error',
  104: 'invalid configuration',
  105: 'aborted externally',
  106: 'could not start the REST API',
  107: 'script error',
  108: 'aborted by the script (test.abort())',
  110: 'aborted by a threshold (abortOnFail)',
  137: 'killed (out of memory or evicted)',
  143: 'terminated (SIGTERM)',
}

export function exitMeaning(code: number | undefined): string | undefined {
  if (code === undefined) return undefined
  return K6_EXIT[code] ?? `exited with code ${code}`
}

/* ─────────────────────────── lifecycle ─────────────────────────── */

export type PhaseId = 'created' | 'initializing' | 'starting' | 'running' | 'finishing' | 'complete'
export type PhaseState = 'done' | 'active' | 'pending' | 'failed' | 'skipped'

export interface Phase {
  id: PhaseId
  label: string
  state: PhaseState
  startMs?: number
  endMs?: number
  /** One line: what is happening or what went wrong. */
  detail?: string
}

export type Outcome = 'in-progress' | 'passed' | 'thresholds-failed' | 'failed' | 'aborted' | 'unknown'

export interface Lifecycle {
  phases: Phase[]
  current: PhaseId
  outcome: Outcome
  /** The reason behind a failed / aborted outcome, in words. */
  outcomeDetail?: string
  /** Run creation. */
  createdMs?: number
  /** When load generation began (first runner executing, or starter release). */
  loadStartMs?: number
  /** When the last runner stopped. */
  loadEndMs?: number
  /** When the operator marked the run terminal. */
  endMs?: number
  /** Created paused and not yet released. */
  heldPaused: boolean
  /** Runners, newest attempt per instance. */
  runners: PodDetail[]
  running: boolean
}

const ms = (s: string | undefined): number | undefined => {
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : undefined
}
const minOf = (xs: Array<number | undefined>) => {
  const v = xs.filter((x): x is number => x !== undefined)
  return v.length ? Math.min(...v) : undefined
}
const maxOf = (xs: Array<number | undefined>) => {
  const v = xs.filter((x): x is number => x !== undefined)
  return v.length ? Math.max(...v) : undefined
}

const RUNNING_STAGES = new Set(['initialization', 'initialized', 'created', 'started'])

export function isRunStageRunning(stage: string | undefined): boolean {
  return RUNNING_STAGES.has(stage ?? 'initialization')
}

export const PHASE_LABEL: Record<PhaseId, string> = {
  created: 'Created',
  initializing: 'Initializing',
  starting: 'Starting',
  running: 'Generating load',
  finishing: 'Finishing',
  complete: 'Complete',
}

/**
 * Derive the lifecycle. `exitCodeHint` is the exit code a harvested result
 * recorded, used when the pods are gone (cleanup) so a finished run still
 * reads as passed / thresholds-failed rather than "unknown".
 */
export function runLifecycle(run: RunLike, rawPods: PodDetail[], _nowMs: number, exitCodeHint?: number): Lifecycle {
  const stage = run.status?.stage ?? 'initialization'
  const running = isRunStageRunning(stage)
  const pods = latestPerSlot(rawPods)
  const init = pods.find((p) => p.role === 'initializer')
  const starter = pods.find((p) => p.role === 'starter')
  const runners = pods.filter((p) => p.role === 'runner')
  const parallelism = Math.max(1, run.spec?.parallelism ?? 1)
  const conds = run.status?.conditions ?? []
  const runningCond = conds.find((c) => c.type === 'TestRunRunning')
  const heldPaused = String(run.spec?.paused ?? '') === 'true' && running && stage !== 'started'

  const createdMs = ms(run.metadata.creationTimestamp)
  const condTimes = conds.map((c) => ms(c.lastTransitionTime))
  const endMs = running ? undefined : maxOf(condTimes)

  // Initializing: the initializer container's own run.
  const initStart = ms(init?.createdAt) ?? (init ? undefined : createdMs)
  const initEnd = ms(init?.finishedAt)
  const initFailed = init?.state === 'failed'

  // Load starts when a runner is actually executing k6 — immediately for
  // unpaused runners, at the starter's release for paused ones.
  const runnersPaused = runners.some((r) => r.paused)
  const runnerStarts = runners.map((r) => ms(r.startedAt))
  const starterEnd = ms(starter?.finishedAt)
  let loadStartMs: number | undefined = runnersPaused ? starterEnd : minOf(runnerStarts)
  if (loadStartMs === undefined && runningCond?.status === 'True') loadStartMs = ms(runningCond.lastTransitionTime)
  const allRunnersDone = runners.length >= parallelism && runners.every((r) => r.state === 'succeeded' || r.state === 'failed')
  const loadEndMs = allRunnersDone ? maxOf(runners.map((r) => ms(r.finishedAt))) : !running && runningCond?.status === 'False' ? ms(runningCond.lastTransitionTime) : undefined

  const runnersFailed = runners.filter((r) => r.state === 'failed' && r.exitCode !== 99)
  const thresholdFails = runners.filter((r) => r.exitCode === 99)
  const runnerStuck = runners.find((r) => r.state === 'waiting' && r.reason && /BackOff|Err|Invalid/.test(r.reason))

  // Outcome.
  let outcome: Outcome = 'in-progress'
  let outcomeDetail: string | undefined
  if (stage === 'error') {
    outcome = 'failed'
    outcomeDetail = initFailed
      ? `The initializer failed (${exitMeaning(init?.exitCode) ?? init?.reason ?? 'error'}) — usually a script that does not parse.`
      : conds.find((c) => c.status === 'True' && /error|fail/i.test(c.reason ?? ''))?.message || 'The operator could not run the test.'
  } else if (stage === 'stopped') {
    outcome = 'aborted'
    outcomeDetail = 'The run was stopped before it finished.'
  } else if (stage === 'finished') {
    const codes = runners.map((r) => r.exitCode).filter((c): c is number => c !== undefined)
    const code = codes.length ? (codes.includes(99) && codes.every((c) => c === 0 || c === 99) ? 99 : codes.find((c) => c !== 0) ?? 0) : exitCodeHint
    if (code === undefined) outcome = 'unknown'
    else if (code === 0) outcome = 'passed'
    else if (code === 99) {
      outcome = 'thresholds-failed'
      outcomeDetail = 'The test ran to the end, and at least one threshold was crossed.'
    } else if (code === 105 || code === 108 || code === 110 || code === 143) {
      outcome = 'aborted'
      outcomeDetail = `k6 ${exitMeaning(code)}.`
    } else {
      outcome = 'failed'
      outcomeDetail = `k6 ${exitMeaning(code)}.`
    }
  } else if (initFailed) {
    outcome = 'failed'
    outcomeDetail = `The initializer failed (${exitMeaning(init?.exitCode) ?? init?.reason ?? 'error'}) — usually a script that does not parse.`
  } else if (runners.length && runnersFailed.length === runners.length && runners.length >= parallelism) {
    outcome = 'failed'
    outcomeDetail = `Every runner failed: ${exitMeaning(runnersFailed[0].exitCode) ?? runnersFailed[0].reason}.`
  }

  const failedAt: PhaseId | undefined = outcome === 'failed' || outcome === 'aborted'
    ? initFailed || (stage === 'error' && !runners.length)
      ? 'initializing'
      : runnersFailed.length || loadStartMs
      ? 'running'
      : 'starting'
    : undefined

  const phases: Phase[] = []
  const add = (p: Phase) => phases.push(p)
  add({ id: 'created', label: PHASE_LABEL.created, state: 'done', startMs: createdMs, endMs: initStart ?? createdMs })

  // Which phase is current, by evidence.
  let current: PhaseId
  if (!running) current = 'complete'
  else if (loadStartMs !== undefined) current = allRunnersDone ? 'finishing' : 'running'
  else if (init?.state === 'succeeded' || (!init && runners.length)) current = 'starting'
  else current = 'initializing'

  const order: PhaseId[] = ['created', 'initializing', 'starting', 'running', 'finishing', 'complete']
  const ci = order.indexOf(current)
  const stateFor = (id: PhaseId): PhaseState => {
    const i = order.indexOf(id)
    if (failedAt) {
      const fi = order.indexOf(failedAt)
      if (i < fi) return 'done'
      if (i === fi) return 'failed'
      return id === 'complete' ? 'failed' : 'skipped'
    }
    if (!running) return 'done'
    if (i < ci) return 'done'
    if (i === ci) return 'active'
    return 'pending'
  }

  add({
    id: 'initializing',
    label: PHASE_LABEL.initializing,
    state: stateFor('initializing'),
    startMs: initStart,
    endMs: initEnd ?? (initFailed ? ms(init?.finishedAt) : undefined),
    detail: initFailed
      ? `Initializer ${exitMeaning(init?.exitCode) ?? init?.reason ?? 'failed'}`
      : init?.state === 'waiting' || init?.state === 'pending'
      ? `Initializer pod ${init.reason ?? 'pending'}`
      : init?.state === 'running'
      ? 'Archiving the script and working out the execution plan'
      : init?.state === 'succeeded'
      ? 'Script archived and inspected'
      : running
      ? 'Waiting for the operator'
      : undefined,
  })

  const runnersCreated = minOf(runners.map((r) => ms(r.createdAt)))
  const readyRunners = runners.filter((r) => r.state === 'running' || r.state === 'succeeded' || r.state === 'failed').length
  add({
    id: 'starting',
    label: PHASE_LABEL.starting,
    state: stateFor('starting'),
    startMs: runnersCreated ?? initEnd,
    endMs: loadStartMs,
    detail: heldPaused
      ? 'Paused — the runners wait until the run is resumed'
      : runnerStuck
      ? `Runner ${runnerStuck.index ?? ''} ${runnerStuck.reason}`.replace('  ', ' ')
      : runners.length
      ? `${readyRunners}/${parallelism} runner${parallelism === 1 ? '' : 's'} up${runnersPaused ? ', waiting for the starter' : ''}`
      : running && current === 'starting'
      ? `Creating ${parallelism} runner pod${parallelism === 1 ? '' : 's'}`
      : undefined,
  })

  const activeRunners = runners.filter((r) => r.state === 'running').length
  add({
    id: 'running',
    label: PHASE_LABEL.running,
    state: stateFor('running'),
    startMs: loadStartMs,
    endMs: loadEndMs,
    detail: runnersFailed.length
      ? `${runnersFailed.length} runner${runnersFailed.length === 1 ? '' : 's'} failed: ${exitMeaning(runnersFailed[0].exitCode) ?? runnersFailed[0].reason}`
      : current === 'running'
      ? `${activeRunners}/${parallelism} runner${parallelism === 1 ? '' : 's'} generating load`
      : thresholdFails.length
      ? 'Ran to the end — thresholds crossed'
      : loadEndMs
      ? 'All runners finished'
      : undefined,
  })

  add({
    id: 'finishing',
    label: PHASE_LABEL.finishing,
    state: stateFor('finishing'),
    startMs: loadEndMs,
    endMs: endMs,
    detail: current === 'finishing' ? 'Runners stopped — the operator is wrapping up' : undefined,
  })

  add({
    id: 'complete',
    label: outcome === 'passed'
      ? 'Passed'
      : outcome === 'thresholds-failed'
      ? 'Thresholds failed'
      : outcome === 'failed'
      ? 'Failed'
      : outcome === 'aborted'
      ? 'Aborted'
      : PHASE_LABEL.complete,
    state: running ? (failedAt ? 'failed' : 'pending') : outcome === 'passed' || outcome === 'unknown' ? 'done' : 'failed',
    startMs: endMs,
    detail: outcomeDetail,
  })

  return {
    phases,
    current: failedAt && running ? failedAt : current,
    outcome,
    outcomeDetail,
    createdMs,
    loadStartMs,
    loadEndMs,
    endMs,
    heldPaused,
    runners,
    running,
  }
}

/* ─────────────────────────── progress ─────────────────────────── */

export interface RunProgress {
  /** Seconds of load generation so far (or in total, once over). */
  elapsedSecs?: number
  plannedSecs?: number
  /** True when `plannedSecs` is an upper bound (iteration-based plans). */
  plannedIsUpperBound?: boolean
  /** 0–100. Absent when there is no plan to measure against. */
  pct?: number
  remainingSecs?: number
  /** Planned VUs right now. */
  targetVus?: number
  segment?: PlanSegmentKind
  /** Elapsed past the plan (graceful stop, slow iterations). */
  overrun: boolean
}

/**
 * How far through its plan the run is. `k6Line` is k6's own progress line
 * (`[ 33% ] … 0m10.0s/0m30.0s`) when the runner printed one — it is the
 * authority when present, since it is k6's own clock.
 */
export function runProgress(
  lc: Pick<Lifecycle, 'loadStartMs' | 'loadEndMs' | 'running'>,
  plan: LoadPlan | undefined,
  nowMs: number,
  k6Line?: { elapsedSecs: number; plannedSecs?: number; percent?: number },
): RunProgress {
  const end = lc.loadEndMs ?? (lc.running ? nowMs : undefined)
  const elapsedSecs = k6Line?.elapsedSecs ?? (lc.loadStartMs !== undefined && end !== undefined ? Math.max(0, (end - lc.loadStartMs) / 1000) : undefined)
  const plannedSecs = k6Line?.plannedSecs ?? plan?.totalSecs
  const out: RunProgress = { elapsedSecs, plannedSecs, plannedIsUpperBound: plan?.totalIsUpperBound, overrun: false }
  if (elapsedSecs === undefined) return out
  if (plannedSecs && plannedSecs > 0) {
    const finished = !lc.running && lc.loadEndMs !== undefined
    const raw = k6Line?.percent ?? (elapsedSecs / plannedSecs) * 100
    // An upper bound is not a plan: an iteration test that finishes early is
    // 100% done, not 12%.
    out.pct = finished ? 100 : Math.max(0, Math.min(100, raw))
    out.overrun = elapsedSecs > plannedSecs + 1
    out.remainingSecs = finished ? 0 : Math.max(0, plannedSecs - elapsedSecs)
  }
  if (plan) {
    out.targetVus = lc.running ? plannedVusAt(plan, elapsedSecs) : undefined
    out.segment = lc.running ? segmentAt(plan, elapsedSecs)?.kind : undefined
    if (out.targetVus !== undefined) out.targetVus = Math.round(out.targetVus)
  }
  return out
}

/** `95s` / `2m 05s` / `1h 04m` — a duration a person reads at a glance. */
export function fmtSecs(secs: number | undefined): string {
  if (secs === undefined || !Number.isFinite(secs) || secs < 0) return '—'
  if (secs < 60) return `${secs < 10 ? secs.toFixed(1).replace(/\.0$/, '') : Math.round(secs)}s`
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  if (m < 60) return `${m}m ${String(s === 60 ? 59 : s).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
