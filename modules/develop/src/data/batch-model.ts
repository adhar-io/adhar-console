import { tryParseYaml } from '@adhar/utils'
import { describeCron, nextRuns } from './perf-cron.ts'
import { type ApplicationXR, type Condition, type EventLike, type EventRow, gitopsOwner, type Meta, PLATFORM_ENVIRONMENTS } from './functions-model.ts'
import { hasLoneSurrogate, MAX_RESTARTS, NAMING_VERSION, nextRestartName, runName } from './batch-naming.ts'

export { canonicalParams, nextRestartName, NAMING_VERSION, paramsHash, restartName, runName } from './batch-naming.ts'

/**
 * Develop → Batch, the pure half: what a BatchJob XR and the runs it produces
 * MEAN, with no fetching and no React, so every rule is unit-tested
 * (`batch-model_test.ts`). The contract it reads is design 0025:
 *
 *   • A `BatchJob` (`platform.adhar.io/v1alpha1`, namespaced, §6.2) lives in an
 *     environment namespace, created by GitOps from `deploy/envs/<env>`.
 *   • It composes a CronJob (when scheduled), a run template `ConfigMap
 *     <name>-run` (§6.5) and a PrometheusRule `<name>-batch` (§6.4).
 *   • A run is a Job, or a Volcano Job, labelled `adhar.io/batch-job`. A person
 *     creates one from the run template and may change only its name, the
 *     `adhar.io/batch-trigger` label and the `ADHAR_BATCH_*` client variables
 *     (§6.5); Kyverno refuses anything else (§10.3).
 *   • The kit writes a summary into the batch container's termination message
 *     (§5.13, D13); the exit code means what §5.7 says.
 *
 * Every field is optional. A page that throws on a missing status shows nothing
 * at all, and the kit's runner and the composition are not on every cluster yet.
 */

/* ─────────────────────────── API surface ─────────────────────────── */

export const BATCHJOBS_GVR = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'batchjobs', namespaced: true } as const
export const JOBS_GVR = { group: 'batch', version: 'v1', resource: 'jobs', namespaced: true } as const
export const CRONJOBS_GVR = { group: 'batch', version: 'v1', resource: 'cronjobs', namespaced: true } as const
export const VOLCANO_JOBS_GVR = { group: 'batch.volcano.sh', version: 'v1alpha1', resource: 'jobs', namespaced: true } as const
export const VOLCANO_CRONJOBS_GVR = { group: 'batch.volcano.sh', version: 'v1alpha1', resource: 'cronjobs', namespaced: true } as const
export const PODGROUPS_GVR = { group: 'scheduling.volcano.sh', version: 'v1beta1', resource: 'podgroups', namespaced: true } as const
export const QUEUES_GVR = { group: 'scheduling.volcano.sh', version: 'v1beta1', resource: 'queues', namespaced: false } as const
export const COMMANDS_GVR = { group: 'bus.volcano.sh', version: 'v1alpha1', resource: 'commands', namespaced: true } as const
export const PODS_GVR = { group: '', version: 'v1', resource: 'pods', namespaced: true } as const
export const EVENTS_GVR = { group: '', version: 'v1', resource: 'events', namespaced: true } as const
export const CONFIGMAPS_GVR = { group: '', version: 'v1', resource: 'configmaps', namespaced: true } as const

export const LABEL = {
  batchJob: 'adhar.io/batch-job',
  trigger: 'adhar.io/batch-trigger',
  role: 'adhar.io/batch-role',
  workload: 'adhar.io/workload',
  application: 'adhar.io/application',
  environment: 'adhar.io/environment',
  project: 'adhar.io/project',
  team: 'adhar.io/team',
  nativeJob: 'batch.kubernetes.io/job-name',
  nativeJobLegacy: 'job-name',
  nativeIndex: 'batch.kubernetes.io/job-completion-index',
  volcanoJob: 'volcano.sh/job-name',
  volcanoIndex: 'volcano.sh/task-index',
} as const

export const ANNOTATION = {
  hold: 'adhar.io/batch-hold',
  actor: 'adhar.io/batch-actor',
  scheduled: 'batch.kubernetes.io/cronjob-scheduled-timestamp',
} as const

export const ENV = {
  params: 'ADHAR_BATCH_PARAMS',
  trigger: 'ADHAR_BATCH_TRIGGER',
  restartOf: 'ADHAR_BATCH_RESTART_OF',
  timeZone: 'ADHAR_BATCH_TIME_ZONE',
} as const

/** The container the batch runner lives in (§6.4). */
export const BATCH_CONTAINER = 'batch'

/** The label selector that finds every run, and every run's pods, of any job. */
export const RUN_SELECTOR = LABEL.batchJob

/* ─────────────────────────── shapes ─────────────────────────── */

export type ParamType = 'string' | 'long' | 'double' | 'boolean' | 'date' | 'datetime'

export interface ParameterSpec {
  name?: string
  type?: ParamType
  identifying?: boolean
  required?: boolean
  default?: string
  pattern?: string
  allowed?: string[]
  source?: 'input' | 'schedule'
  sensitive?: boolean
  description?: string
}

export interface BatchJobParameters {
  displayName?: string
  application?: string
  job?: string
  image?: string
  imagePullSecrets?: string[]
  mode?: 'single' | 'partitioned' | 'chunked'
  workers?: number
  gridSize?: number
  scheduler?: 'auto' | 'volcano' | 'kubernetes'
  schedule?: {
    cron?: string
    timeZone?: string
    startingDeadlineSeconds?: number
    concurrencyPolicy?: string
    suspend?: boolean
    calendar?: string
  }
  parameters?: ParameterSpec[]
  resources?: { cpu?: string; memory?: string; cpuLimit?: string; workerCpu?: string; workerMemory?: string; tmpSize?: string }
  jvm?: { threads?: number; codeCache?: string; options?: string }
  retry?: { backoffLimit?: number; maxRetry?: number }
  timeouts?: { activeDeadlineSeconds?: number; terminationGracePeriodSeconds?: number }
  history?: { successfulJobsHistoryLimit?: number; failedJobsHistoryLimit?: number; ttlSecondsAfterFinished?: number }
  priority?: string
  disruption?: string
  scaleUp?: boolean
  database?: { secretRef?: string; schema?: string }
  env?: Record<string, string>
  envFrom?: unknown[]
  serviceAccountName?: string
  sla?: { maxDuration?: string; finishBy?: string; timeZone?: string }
  alerts?: { enabled?: boolean; staleAfter?: string; severity?: string }
  organisation?: string
  team?: string
  project?: string
  environment?: string
}

export interface BatchJobXR {
  apiVersion?: string
  kind?: string
  metadata: Meta
  spec?: { parameters?: BatchJobParameters; crossplane?: Record<string, unknown> }
  status?: {
    scheduler?: string
    queue?: string
    runTemplate?: string
    cronJob?: string
    lastScheduleTime?: string
    lastSuccessfulTime?: string
    activeRuns?: string[]
    held?: { reason?: string; since?: string }
    message?: string
    conditions?: Condition[]
  }
}

export interface ContainerSpec {
  name?: string
  image?: string
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>
}

export interface PodTemplate {
  metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }
  spec?: { containers?: ContainerSpec[] }
}

/** A run: a `batch/v1` Job or a `batch.volcano.sh/v1alpha1` Job. */
export interface RunObject {
  apiVersion?: string
  kind?: string
  metadata: Meta & { ownerReferences?: Array<{ kind?: string; name?: string }> }
  spec?: {
    suspend?: boolean
    backoffLimit?: number
    activeDeadlineSeconds?: number
    completions?: number
    parallelism?: number
    completionMode?: string
    template?: PodTemplate
    tasks?: Array<{ name?: string; replicas?: number; template?: PodTemplate }>
    queue?: string
    maxRetry?: number
  }
  status?: {
    conditions?: Condition[]
    active?: number
    ready?: number
    succeeded?: number
    failed?: number
    terminating?: number
    startTime?: string
    completionTime?: string
    /** Volcano. */
    state?: { phase?: string; reason?: string; message?: string; lastTransitionTime?: string }
    retryCount?: number
    running?: number
    pending?: number
    version?: number
  }
}

export interface Terminated {
  exitCode?: number
  reason?: string
  message?: string
  startedAt?: string
  finishedAt?: string
}

export interface RunPod {
  metadata: Meta
  spec?: { containers?: Array<{ name: string; image?: string }>; nodeName?: string }
  status?: {
    phase?: string
    reason?: string
    message?: string
    conditions?: Condition[]
    containerStatuses?: Array<{
      name: string
      ready?: boolean
      restartCount?: number
      image?: string
      imageID?: string
      state?: { waiting?: { reason?: string; message?: string }; running?: { startedAt?: string }; terminated?: Terminated }
      lastState?: { terminated?: Terminated }
    }>
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/* ─────────────────────────── references ─────────────────────────── */

/** `<namespace>/<name>`, the deep-link form of a job or a run. */
export function batchRef(namespace: string, name: string): string {
  return `${namespace}/${name}`
}

export function parseBatchRef(ref: string | undefined): { namespace: string; name: string } | null {
  if (!ref) return null
  const i = ref.indexOf('/')
  if (i <= 0 || i === ref.length - 1) return null
  return { namespace: ref.slice(0, i), name: ref.slice(i + 1) }
}

/* ─────────────────────────── durations ─────────────────────────── */

/**
 * `3h`, `26h`, `90m`, `1h30m`, `45s`, `1d` → milliseconds. `undefined` for
 * anything else: a duration this page cannot read means "no SLA to judge", never
 * a breached one.
 */
export function parseDurationMs(text: string | undefined): number | undefined {
  const s = text?.trim()
  if (!s || !/^(\d+(\.\d+)?(ms|s|m|h|d))+$/.test(s)) return undefined
  let total = 0
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
    const n = Number(m[1])
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1_000 : m[2] === 'm' ? n * 60_000 : m[2] === 'h' ? n * 3_600_000 : n * 86_400_000
  }
  return total
}

const toMs = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

/* ─────────────────────────── the termination summary (§5.13, D13) ─────────────────────────── */

export interface StepSummary {
  name?: string
  status?: string
  read?: number
  written?: number
  skipped?: number
}

export interface RunSummary {
  v?: number
  job?: string
  batchJob?: string
  instanceId?: number
  executionId?: number
  status?: string
  exitCode?: number
  exitDescription?: string
  outcome?: string
  reason?: string
  trigger?: string
  businessDate?: string
  read?: number
  written?: number
  skipped?: number
  deadLettered?: number
  filtered?: number
  start?: string
  end?: string
  image?: string
  steps?: StepSummary[]
  /** The kit dropped step detail to stay under its 3.5 KB cap. */
  stepsTruncated?: boolean
  /** The text was cut mid-document; these are the fields that could be recovered. */
  truncated: boolean
}

const SUMMARY_STRINGS = ['job', 'batchJob', 'status', 'exitDescription', 'outcome', 'reason', 'trigger', 'businessDate', 'start', 'end', 'image'] as const
const SUMMARY_NUMBERS = ['v', 'instanceId', 'executionId', 'exitCode', 'read', 'written', 'skipped', 'deadLettered', 'filtered'] as const

function normaliseSummary(o: Record<string, unknown>, truncated: boolean): RunSummary {
  const out: RunSummary = { truncated }
  // exitDescription may legitimately be '' — keep what the kit wrote.
  for (const k of SUMMARY_STRINGS) if (typeof o[k] === 'string') (out as unknown as Record<string, unknown>)[k] = o[k]
  for (const k of SUMMARY_NUMBERS) if (num(o[k]) !== undefined) (out as unknown as Record<string, unknown>)[k] = o[k]
  if (o.stepsTruncated === true) out.stepsTruncated = true
  if (Array.isArray(o.steps)) out.steps = o.steps.map((s) => obj(s)).filter((s) => s !== undefined).map(stepOf)
  return out
}

function stepOf(s: Record<string, unknown>): StepSummary {
  return { name: str(s.name), status: str(s.status), read: num(s.read), written: num(s.written), skipped: num(s.skipped) }
}

/**
 * Parse a termination message. A whole document is read as JSON; one cut part
 * way through (the kubelet keeps 4 KiB, and any earlier cap can cut it) still
 * yields every field written before the cut, and says it was truncated. Text
 * that is not a summary at all — a JVM that died before the runner started
 * writes something else, or nothing — is `null`, never a guess.
 */
export function parseSummary(text: string | undefined): RunSummary | null {
  const t = text?.trim()
  if (!t || t[0] !== '{') return null
  let whole: unknown
  try {
    whole = JSON.parse(t)
  } catch {
    whole = undefined
  }
  if (whole !== undefined) {
    const o = obj(whole)
    if (!o || !('v' in o || 'outcome' in o || 'batchJob' in o)) return null
    return normaliseSummary(o, false)
  }
  // Cut mid-document. Top-level scalars come before `steps`, and each step has
  // its own `read` and `written`, so scalars are read from the head only.
  const stepsAt = t.indexOf('"steps":')
  const head = stepsAt >= 0 ? t.slice(0, stepsAt) : t
  const o: Record<string, unknown> = {}
  for (const m of head.matchAll(/"([A-Za-z]+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)\s*(?=[,}])/g)) {
    try {
      o[m[1]] = JSON.parse(m[2])
    } catch { /* a value cut mid-escape */ }
  }
  if (!('v' in o || 'outcome' in o || 'batchJob' in o)) return null
  const out = normaliseSummary(o, true)
  if (stepsAt >= 0) {
    const steps: StepSummary[] = []
    for (const m of t.slice(stepsAt).matchAll(/\{[^{}]*\}/g)) {
      try {
        steps.push(stepOf(JSON.parse(m[0]) as Record<string, unknown>))
      } catch { /* a step cut in half */ }
    }
    if (steps.length) out.steps = steps
  }
  return out
}

/** The batch container's termination: the current one, or the last before a restart in place. */
export function terminationOf(pod: RunPod): Terminated | undefined {
  const cs = pod.status?.containerStatuses ?? []
  const c = cs.find((x) => x.name === BATCH_CONTAINER) ?? (cs.length === 1 ? cs[0] : undefined)
  return c?.state?.terminated ?? c?.lastState?.terminated
}

/** The summary a pod wrote (`null` when it wrote none, as any pod still running). */
export function summaryOf(pod: RunPod): RunSummary | null {
  return parseSummary(terminationOf(pod)?.message)
}

/* ─────────────────────────── exit codes (§5.7) ─────────────────────────── */

const EXIT_MEANING: Record<number, string> = {
  0: 'Completed, or nothing to do',
  1: 'The JVM failed before the run started',
  2: 'Invalid request (parameters, unknown job, migration)',
  3: 'Failed, not retryable',
  4: 'Stopped on request',
  5: 'Failed, retryable',
  6: 'Abandoned — a new identity is needed',
  7: 'Repository state unknown',
  137: 'Killed (out of memory, or SIGKILL)',
  143: 'Terminated (SIGTERM)',
}

/** What an exit code means, in a sentence. */
export function exitMeaning(code: number | undefined): string | undefined {
  if (code === undefined) return undefined
  return EXIT_MEANING[code] ?? `Exit ${code}`
}

const REASON_MEANING: Record<string, string> = {
  'already-complete': 'this identity already completed',
  duplicate: 'another run of this identity is in progress',
  calendar: 'not a business day',
  parameters: 'the parameters were refused',
  'unknown-job': 'the job bean does not exist',
  incrementer: 'the job uses an incrementer',
  'resourceless-repository': 'no JDBC job repository',
  migration: 'the schema migration failed',
  'business-date': 'the business date could not be resolved',
}

/** The kit's outcome + reason, for humans: exit 0 covers four different results (D13). */
export function outcomeLabel(s: Pick<RunSummary, 'outcome' | 'reason'> | null | undefined): string | undefined {
  if (!s?.outcome) return undefined
  const label = s.outcome[0].toUpperCase() + s.outcome.slice(1)
  if (!s.reason) return label
  return `${label}: ${REASON_MEANING[s.reason] ?? s.reason}`
}

/* ─────────────────────────── runs ─────────────────────────── */

export type RunKind = 'Job' | 'VolcanoJob'

export function runKindOf(run: Pick<RunObject, 'apiVersion'>): RunKind {
  return run.apiVersion?.startsWith('batch.volcano.sh') ? 'VolcanoJob' : 'Job'
}

export type RunPhase = 'pending' | 'running' | 'stopping' | 'stopped' | 'succeeded' | 'failed' | 'deleting' | 'unknown'

const condTrue = (conds: readonly Condition[] | undefined, type: string) => conds?.find((c) => c.type === type)?.status === 'True'

/** The phase a person reads. `FailureTarget` / `SuccessCriteriaMet` count: the Job has decided, its pods are only leaving. */
export function runPhaseOf(run: RunObject): RunPhase {
  if (run.metadata.deletionTimestamp) return 'deleting'
  if (runKindOf(run) === 'VolcanoJob') {
    switch (run.status?.state?.phase) {
      case 'Pending':
        return 'pending'
      case 'Running':
      case 'Restarting':
      case 'Completing':
        return 'running'
      case 'Aborting':
        return 'stopping'
      case 'Aborted':
        return 'stopped'
      case 'Completed':
        return 'succeeded'
      case 'Failed':
      case 'Terminating':
      case 'Terminated':
        return 'failed'
      default:
        return run.status?.state?.phase ? 'unknown' : 'pending'
    }
  }
  const conds = run.status?.conditions
  if (condTrue(conds, 'Complete') || condTrue(conds, 'SuccessCriteriaMet')) return 'succeeded'
  if (condTrue(conds, 'Failed') || condTrue(conds, 'FailureTarget')) return 'failed'
  const active = run.status?.active ?? 0
  if (run.spec?.suspend === true || condTrue(conds, 'Suspended')) {
    return active > 0 || (run.status?.terminating ?? 0) > 0 ? 'stopping' : 'stopped'
  }
  if (active > 0) return (run.status?.ready ?? 1) > 0 ? 'running' : 'pending'
  return 'pending'
}

export const PHASE_LABEL: Record<RunPhase, string> = {
  pending: 'Pending',
  running: 'Running',
  stopping: 'Stopping',
  stopped: 'Stopped',
  succeeded: 'Succeeded',
  failed: 'Failed',
  deleting: 'Deleting',
  unknown: 'Unknown',
}

export const PHASE_BADGE: Record<RunPhase, 'healthy' | 'paused' | 'progressing' | 'failed' | 'unknown'> = {
  pending: 'progressing',
  running: 'progressing',
  stopping: 'progressing',
  stopped: 'paused',
  succeeded: 'healthy',
  failed: 'failed',
  deleting: 'progressing',
  unknown: 'unknown',
}

export const isActivePhase = (p: RunPhase) => p === 'pending' || p === 'running' || p === 'stopping'

/** Every container of the run object: a Job has one pod template, a Volcano Job one per task. */
function templatesOf(run: { spec?: RunObject['spec'] }): PodTemplate[] {
  const out: PodTemplate[] = []
  if (run.spec?.template) out.push(run.spec.template)
  for (const t of run.spec?.tasks ?? []) if (t.template) out.push(t.template)
  return out
}

function batchContainerOf(run: { spec?: RunObject['spec'] }): ContainerSpec | undefined {
  const all = templatesOf(run).flatMap((t) => t.spec?.containers ?? [])
  return all.find((c) => c.name === BATCH_CONTAINER) ?? all[0]
}

function envOf(run: { spec?: RunObject['spec'] }, name: string): string | undefined {
  return batchContainerOf(run)?.env?.find((e) => e.name === name)?.value
}

/** The image of the run's batch container. */
export function runImage(run: { spec?: RunObject['spec'] }): string | undefined {
  return batchContainerOf(run)?.image
}

/** The parameters a run was given (`ADHAR_BATCH_PARAMS`). `{}` for what the variable does not say. */
export function runParams(run: { spec?: RunObject['spec'] }): Record<string, string> {
  const raw = envOf(run, ENV.params)
  if (!raw) return {}
  try {
    const o = obj(JSON.parse(raw))
    if (!o) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = String(v)
    return out
  } catch {
    return {}
  }
}

/** The pods of one run, newest first. */
export function podsOfRun(run: RunObject, pods: readonly RunPod[]): RunPod[] {
  const name = run.metadata.name
  const ns = run.metadata.namespace
  const volcano = runKindOf(run) === 'VolcanoJob'
  return pods
    .filter((p) => {
      if (ns && p.metadata.namespace && p.metadata.namespace !== ns) return false
      const l = p.metadata.labels ?? {}
      return volcano ? l[LABEL.volcanoJob] === name : l[LABEL.nativeJob] === name || l[LABEL.nativeJobLegacy] === name
    })
    .sort((a, b) => (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? ''))
}

export const podRole = (p: RunPod) => p.metadata.labels?.[LABEL.role]
export const podIndex = (p: RunPod) => p.metadata.labels?.[LABEL.nativeIndex] ?? p.metadata.labels?.[LABEL.volcanoIndex]

/**
 * The pod whose summary speaks for the run: the manager when there is one (in
 * an indexed job, index 0 is the manager, §5.5), otherwise the newest attempt.
 * Pods are newest first, and a pod still running has no summary yet, so the
 * first pod that has written one wins within the eligible set.
 */
export function speakerPod(pods: readonly RunPod[]): RunPod | undefined {
  const notWorkers = pods.filter((p) => podRole(p) !== 'worker')
  const managers = notWorkers.filter((p) => podRole(p) === 'manager' || podIndex(p) === '0')
  const set = managers.length ? managers : notWorkers.length ? notWorkers : pods
  return set.find((p) => parseSummary(terminationOf(p)?.message) !== null) ?? set.find((p) => terminationOf(p)) ?? set[0]
}

export interface RunRow {
  key: string
  namespace: string
  name: string
  kind: RunKind
  batchJob?: string
  application?: string
  environment?: string
  project?: string
  team?: string
  phase: RunPhase
  /** Why it is in that phase, when the object says. */
  message?: string
  trigger?: string
  actor?: string
  businessDate?: string
  restartOf?: string
  scheduledAt?: string
  attempts: number
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  exitCode?: number
  summary: RunSummary | null
  image?: string
  created?: string
  raw: RunObject
}

/** The calendar date of an instant in a time zone (`en-CA` formats as yyyy-mm-dd). */
export function dateInZone(ms: number, timeZone?: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
  } catch {
    return undefined
  }
}

/** When a finished run finished. A failed or suspended Job has no `completionTime`; its condition says when. */
function finishedAtOf(run: RunObject, phase: RunPhase, summary: RunSummary | null): string | undefined {
  if (phase !== 'succeeded' && phase !== 'failed' && phase !== 'stopped') return undefined
  if (run.status?.completionTime) return run.status.completionTime
  const type = phase === 'failed' ? ['Failed', 'FailureTarget'] : phase === 'succeeded' ? ['Complete', 'SuccessCriteriaMet'] : ['Suspended']
  const at = run.status?.conditions?.find((c) => c.status === 'True' && type.includes(c.type ?? ''))?.lastTransitionTime
  return at ?? run.status?.state?.lastTransitionTime ?? summary?.end
}

function attemptsOf(run: RunObject, pods: readonly RunPod[]): number {
  if (runKindOf(run) === 'VolcanoJob') return run.status?.state?.phase === 'Pending' && !run.status?.retryCount ? 0 : (run.status?.retryCount ?? 0) + 1
  const counted = (run.status?.failed ?? 0) + (run.status?.succeeded ?? 0) + (run.status?.active ?? 0)
  // An indexed job counts one pod per index, not one per attempt: never below what the status says.
  return Math.max(counted, pods.filter((p) => podRole(p) !== 'worker').length)
}

/** Everything a list row or a detail page shows about one run. */
export function runRow(run: RunObject, allPods: readonly RunPod[], now = Date.now()): RunRow {
  const m = run.metadata
  const labels = m.labels ?? {}
  const pods = podsOfRun(run, allPods)
  const speaker = speakerPod(pods)
  const term = speaker ? terminationOf(speaker) : undefined
  const summary = term ? parseSummary(term.message) : null
  const phase = runPhaseOf(run)
  const scheduledAt = m.annotations?.[ANNOTATION.scheduled]
  const startedAt = run.status?.startTime ?? summary?.start ?? pods.at(-1)?.metadata.creationTimestamp
  const finishedAt = finishedAtOf(run, phase, summary)
  const startMs = toMs(startedAt)
  const endMs = toMs(finishedAt) ?? (isActivePhase(phase) ? now : undefined)
  const params = runParams(run)
  const scheduledMs = toMs(scheduledAt)
  const zone = envOf(run, ENV.timeZone)
  return {
    key: batchRef(m.namespace ?? '', m.name),
    namespace: m.namespace ?? '',
    name: m.name,
    kind: runKindOf(run),
    batchJob: labels[LABEL.batchJob],
    application: labels[LABEL.application],
    environment: labels[LABEL.environment],
    project: labels[LABEL.project],
    team: labels[LABEL.team],
    phase,
    message: run.status?.conditions?.find((c) => c.status === 'True' && (c.type === 'Failed' || c.type === 'FailureTarget' || c.type === 'Suspended'))?.message ?? run.status?.state?.message,
    trigger: labels[LABEL.trigger] ?? envOf(run, ENV.trigger) ?? (scheduledAt || m.ownerReferences?.some((o) => o.kind === 'CronJob') ? 'schedule' : undefined),
    actor: m.annotations?.[ANNOTATION.actor] || undefined,
    businessDate: summary?.businessDate ?? params.businessDate ?? (scheduledMs !== undefined ? dateInZone(scheduledMs, zone) : undefined),
    restartOf: envOf(run, ENV.restartOf) || undefined,
    scheduledAt,
    attempts: attemptsOf(run, pods),
    startedAt,
    finishedAt,
    durationMs: startMs !== undefined && endMs !== undefined && endMs >= startMs ? endMs - startMs : undefined,
    exitCode: summary?.exitCode ?? term?.exitCode,
    summary,
    image: runImage(run),
    created: m.creationTimestamp,
    raw: run,
  }
}

const byNewest = (a: RunRow, b: RunRow) => (b.created ?? b.startedAt ?? '').localeCompare(a.created ?? a.startedAt ?? '')

export function runRows(runs: readonly RunObject[], pods: readonly RunPod[], now = Date.now()): RunRow[] {
  return runs.map((r) => runRow(r, pods, now)).sort(byNewest)
}

/** Facet values and search text of a run row. */
export function runSearchText(r: RunRow): string[] {
  return [r.name, r.batchJob, r.namespace, r.trigger, r.actor, r.businessDate, r.application].filter((s): s is string => Boolean(s))
}

/* ─────────────────────────── what can be done to a run (§3.4, §7.4) ─────────────────────────── */

export interface RunActions {
  stop: boolean
  resume: boolean
  restart: boolean
}

/** Stop while it can still stop, resume what was stopped, restart what failed. */
export function runActionsOf(phase: RunPhase): RunActions {
  return {
    stop: phase === 'pending' || phase === 'running',
    resume: phase === 'stopped',
    restart: phase === 'failed',
  }
}

/** A warning a restart has to carry, because the same identity will fail the same way (§5.7). */
export function restartWarning(exitCode: number | undefined): string | undefined {
  if (exitCode === 2) return 'This run was refused as an invalid request (exit 2). A restart sends the same parameters, so unless the job was corrected since, it will be refused again.'
  if (exitCode === 6) return 'This run’s execution was abandoned (exit 6). The same identity will exit 6 again: it needs new parameters, which is a new run rather than a restart.'
  return undefined
}

export type Gvr = { group: string; version: string; resource: string; namespaced?: boolean }

/** One Kubernetes write, as data. The hook performs it; the tests read it. */
export type RunRequest =
  | { verb: 'patch'; gvr: Gvr; namespace: string; name: string; body: unknown }
  | { verb: 'create'; gvr: Gvr; namespace: string; body: Record<string, unknown> }

/** The `bus.volcano.sh` Command `vcctl job suspend` / `resume` would create [S13, S30]. */
export function volcanoCommand(run: RunObject, action: 'AbortJob' | 'ResumeJob'): Record<string, unknown> {
  const owner = {
    apiVersion: 'batch.volcano.sh/v1alpha1',
    kind: 'Job',
    name: run.metadata.name,
    uid: run.metadata.uid ?? '',
    controller: true,
    blockOwnerDeletion: true,
  }
  return {
    apiVersion: 'bus.volcano.sh/v1alpha1',
    kind: 'Command',
    metadata: {
      generateName: `${run.metadata.name}-${action.toLowerCase()}-`,
      namespace: run.metadata.namespace,
      ownerReferences: [owner],
    },
    action,
    target: owner,
  }
}

/** Stop: suspend a native Job (pods get SIGTERM and grace, §3.4), abort a Volcano one. */
export function stopRequest(run: RunObject): RunRequest {
  const namespace = run.metadata.namespace ?? ''
  return runKindOf(run) === 'VolcanoJob'
    ? { verb: 'create', gvr: COMMANDS_GVR, namespace, body: volcanoCommand(run, 'AbortJob') }
    : { verb: 'patch', gvr: JOBS_GVR, namespace, name: run.metadata.name, body: { spec: { suspend: true } } }
}

/** Resume: the new pod finds the execution STOPPED and restarts it. */
export function resumeRequest(run: RunObject): RunRequest {
  const namespace = run.metadata.namespace ?? ''
  return runKindOf(run) === 'VolcanoJob'
    ? { verb: 'create', gvr: COMMANDS_GVR, namespace, body: volcanoCommand(run, 'ResumeJob') }
    : { verb: 'patch', gvr: JOBS_GVR, namespace, name: run.metadata.name, body: { spec: { suspend: false } } }
}

/** Hold or release: the ONE thing an operator may change on a BatchJob (§3.5, §10.3). */
export function holdPatch(reason: string | null): { metadata: { annotations: Record<string, string | null> } } {
  return { metadata: { annotations: { [ANNOTATION.hold]: reason === null ? null : reason.trim() } } }
}

export interface AccessGate {
  gvr: Gvr
  verb: string
  namespace: string
  name?: string
  subresource?: string
}

export type BatchAction = 'run' | 'stop' | 'resume' | 'restart' | 'hold' | 'logs'

/**
 * The checks an action must pass — exactly the requests it will make, as §7.4
 * lists them. A blocked action is hidden, so a gate that asks for less than its
 * request needs shows a button that fails, and one that asks for more hides a
 * button that would have worked. `read the run template` is part of Run now and
 * Restart: it is the first request they make.
 */
export function actionGates(action: BatchAction, target: { namespace: string; name: string; kind: RunKind }): AccessGate[] {
  const { namespace, name, kind } = target
  const runs = kind === 'VolcanoJob' ? VOLCANO_JOBS_GVR : JOBS_GVR
  switch (action) {
    case 'run':
    case 'restart':
      return [{ gvr: runs, verb: 'create', namespace }, { gvr: CONFIGMAPS_GVR, verb: 'get', namespace }]
    case 'stop':
    case 'resume':
      return kind === 'VolcanoJob' ? [{ gvr: COMMANDS_GVR, verb: 'create', namespace }] : [{ gvr: JOBS_GVR, verb: 'patch', namespace, name }]
    case 'hold':
      return [{ gvr: BATCHJOBS_GVR, verb: 'patch', namespace, name }]
    case 'logs':
      return [{ gvr: PODS_GVR, verb: 'get', namespace, subresource: 'log' }]
  }
}

/** Which kind of run a job creates, before its template has been read: the template's `kind` decides afterwards. */
export function runKindOfJob(job: BatchJobXR): RunKind {
  const mode = job.spec?.parameters?.mode
  return (mode === 'partitioned' || mode === 'chunked') && job.status?.scheduler === 'volcano' ? 'VolcanoJob' : 'Job'
}

/* ─────────────────────────── the parameter form (§6.5) ─────────────────────────── */

export interface ParamField {
  name: string
  type: ParamType
  identifying: boolean
  required: boolean
  default?: string
  pattern?: string
  allowed?: string[]
  source: 'input' | 'schedule'
  sensitive: boolean
  description?: string
}

const PARAM_TYPES: readonly ParamType[] = ['string', 'long', 'double', 'boolean', 'date', 'datetime']

/** The kit's SecretParameterGuard (§5.6). The runner exits 2 on these, so the form says it first. */
const SECRET_NAME = /pass(word)?|secret|token|credential|api[-_]?key|private[-_]?key/i

function fieldOf(p: unknown): ParamField | undefined {
  const o = obj(p)
  const name = str(o?.name)
  if (!o || !name) return undefined
  return {
    name,
    type: PARAM_TYPES.includes(o.type as ParamType) ? (o.type as ParamType) : 'string',
    identifying: o.identifying !== false,
    required: o.required === true,
    ...(typeof o.default === 'string' ? { default: o.default } : o.default !== undefined && o.default !== null ? { default: String(o.default) } : {}),
    ...(str(o.pattern) ? { pattern: str(o.pattern) } : {}),
    ...(Array.isArray(o.allowed) ? { allowed: o.allowed.map(String) } : {}),
    source: o.source === 'schedule' ? 'schedule' : 'input',
    sensitive: o.sensitive === true,
    ...(str(o.description) ? { description: str(o.description) } : {}),
  }
}

/** `parameters.json` → the fields of the form. An absent document is a job with no parameters, not an error. */
export function paramFormOf(json: string | undefined): { fields: ParamField[]; error?: string } {
  if (!json || !json.trim()) return { fields: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    return { fields: [], error: `parameters.json cannot be read: ${(e as Error).message}` }
  }
  const list = Array.isArray(parsed) ? parsed : obj(parsed)?.parameters
  if (!Array.isArray(list)) return { fields: [], error: 'parameters.json is not a list of parameters.' }
  return { fields: list.map(fieldOf).filter((f): f is ParamField => f !== undefined) }
}

/** The declared parameters of an XR, as the same fields (for the drawer, which needs no template). */
export function fieldsOfJob(job: BatchJobXR): ParamField[] {
  return (job.spec?.parameters?.parameters ?? []).map(fieldOf).filter((f): f is ParamField => f !== undefined)
}

/**
 * The form's starting values: each default, and for a parameter the schedule
 * normally supplies (a manual run has no schedule), today in the job's zone, so
 * the identity a person is about to create is on the screen and editable.
 */
export function initialParamValues(fields: readonly ParamField[], opts: { timeZone?: string; now?: number } = {}): Record<string, string> {
  const now = opts.now ?? Date.now()
  const out: Record<string, string> = {}
  for (const f of fields) {
    if (f.default !== undefined) out[f.name] = f.default
    else if (f.source === 'schedule' && f.type === 'date') out[f.name] = dateInZone(now, opts.timeZone) ?? ''
    else out[f.name] = ''
  }
  return out
}

function typeError(f: ParamField, v: string): string | undefined {
  switch (f.type) {
    case 'long':
      return /^-?\d{1,19}$/.test(v) ? undefined : 'Must be a whole number.'
    case 'double':
      return /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(v) ? undefined : 'Must be a number.'
    case 'boolean':
      return v === 'true' || v === 'false' ? undefined : 'Must be true or false.'
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Must be a date, yyyy-mm-dd.'
      const d = new Date(`${v}T00:00:00Z`)
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? undefined : 'That date does not exist.'
    }
    case 'datetime':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))
        ? undefined
        : 'Must be a date and time with an offset, 2026-11-03T17:30:00Z.'
    default:
      return undefined
  }
}

/** `pattern` is a whole-value match, as the runner reads it. A pattern JavaScript cannot compile is left to the runner. */
function patternError(f: ParamField, v: string): string | undefined {
  if (!f.pattern) return undefined
  let re: RegExp
  try {
    re = new RegExp(`^(?:${f.pattern})$`)
  } catch {
    return undefined
  }
  return re.test(v) ? undefined : `Must match ${f.pattern}.`
}

export interface ResolvedParams {
  /** Field name → why its value is refused. */
  errors: Record<string, string>
  /** Everything the run is given (`ADHAR_BATCH_PARAMS`). */
  params: Record<string, string>
  /** The identifying subset the run is named after (§8.3). */
  identifying: Record<string, string>
}

/**
 * Validate and resolve. Defaults apply BEFORE hashing: a parameter left at its
 * default and the same value typed produce one name. An optional parameter with
 * no default and no value is ABSENT, not `""` (D1) — so a default of `""` is
 * present, and hashes differently from no default at all.
 */
export function resolveParams(fields: readonly ParamField[], values: Readonly<Record<string, string>>): ResolvedParams {
  const out: ResolvedParams = { errors: {}, params: {}, identifying: {} }
  for (const f of fields) {
    let v = values[f.name] ?? ''
    if (SECRET_NAME.test(f.name)) {
      out.errors[f.name] = 'The runner refuses a parameter with this name: parameters are stored in clear text. Pass it through a Secret.'
      continue
    }
    if (v === '') {
      if (f.default !== undefined) {
        v = f.default
      } else {
        if (f.required) out.errors[f.name] = 'Required.'
        else if (f.source === 'schedule') out.errors[f.name] = 'A manual run has no schedule to take this from, so it needs a value.'
        continue
      }
    }
    const refused = hasLoneSurrogate(v)
      ? 'Not valid text.'
      : v === '' && f.default === ''
      ? undefined
      : f.allowed?.length && !f.allowed.includes(v)
      ? `Must be one of ${f.allowed.join(', ')}.`
      : typeError(f, v) ?? patternError(f, v)
    if (refused) {
      out.errors[f.name] = refused
      continue
    }
    out.params[f.name] = v
    if (f.identifying) out.identifying[f.name] = v
  }
  return out
}

/** What may be shown of a parameter's value. */
export function displayParam(field: Pick<ParamField, 'sensitive'> | undefined, value: string): string {
  return field?.sensitive ? '••••••' : value
}

/* ─────────────────────────── the run template (§6.5) ─────────────────────────── */

export interface RunTemplate {
  kind: 'Job' | 'IndexedJob' | 'VolcanoJob'
  naming: string
  fields: ParamField[]
  /** `parameters.json` was present and could not be read. */
  paramsError?: string
  /** `template.yaml`, parsed: the run object, unnamed. */
  manifest: RunObject & Record<string, unknown>
}

export interface ConfigMapLike {
  metadata?: Partial<Meta>
  data?: Record<string, string>
}

/**
 * Read `ConfigMap <name>-run`. JSON is tried first because it is exact and JSON
 * is YAML; `yaml-lite` covers the block style a composition writes. A template
 * this client cannot read, or written for a naming version it does not
 * implement, is an error the person sees: starting a run from a guess would
 * create the wrong identity, and Kyverno would only catch a changed image or env.
 */
export function parseRunTemplate(cm: ConfigMapLike | null | undefined): { template?: RunTemplate; error?: string } {
  const data = cm?.data
  if (!data?.['template.yaml']) return { error: 'The run template has no template.yaml.' }
  const naming = data.naming ?? NAMING_VERSION
  if (naming !== NAMING_VERSION) return { error: `This console implements run naming ${NAMING_VERSION}; the template asks for ${naming}. Update the console.` }
  const raw = data['template.yaml']
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    const r = tryParseYaml(raw)
    if (!r.ok) return { error: `template.yaml cannot be read: ${r.error}` }
    doc = r.value
  }
  const manifest = obj(doc) as (RunObject & Record<string, unknown>) | undefined
  if (!manifest || manifest.kind !== 'Job' || !manifest.apiVersion) return { error: 'template.yaml is not a Job.' }
  if (!templatesOf(manifest).some((t) => (t.spec?.containers?.length ?? 0) > 0)) return { error: 'template.yaml has no containers.' }
  const volcano = runKindOf(manifest) === 'VolcanoJob'
  const declared = data.kind
  const kind: RunTemplate['kind'] = declared === 'IndexedJob' || declared === 'VolcanoJob' || declared === 'Job'
    ? declared
    : volcano
    ? 'VolcanoJob'
    : 'Job'
  const form = paramFormOf(data['parameters.json'])
  return { template: { kind, naming, manifest, fields: form.fields, ...(form.error ? { paramsError: form.error } : {}) } }
}

function setEnv(c: ContainerSpec, name: string, value: string | undefined) {
  const env = c.env ?? []
  const i = env.findIndex((e) => e.name === name)
  if (value === undefined) {
    if (i >= 0) env.splice(i, 1)
  } else if (i >= 0) {
    env[i] = { name, value }
  } else {
    env.push({ name, value })
  }
  c.env = env
}

/**
 * The run object to POST: the template, with ONLY what §6.5 lets a client change
 * (the name, the trigger label, the `ADHAR_BATCH_*` client variables). The
 * namespace is the BatchJob's: the template is unnamed and normally unplaced.
 * Kyverno compares the result with the template and refuses any other difference,
 * so an edit here that "helps" is a run nobody can start.
 */
export function buildRun(
  template: RunTemplate,
  opts: { name: string; namespace: string; trigger: 'manual' | 'restart'; params: Readonly<Record<string, string>>; restartOf?: string },
): RunObject & Record<string, unknown> {
  const run = structuredClone(template.manifest) as RunObject & Record<string, unknown>
  const meta = (run.metadata ?? {}) as Meta
  meta.name = opts.name
  meta.namespace = opts.namespace
  meta.labels = { ...(meta.labels ?? {}), [LABEL.trigger]: opts.trigger }
  run.metadata = meta
  for (const t of templatesOf(run)) {
    if (t.metadata?.labels?.[LABEL.trigger] !== undefined) t.metadata.labels[LABEL.trigger] = opts.trigger
    for (const c of t.spec?.containers ?? []) {
      // Only the containers the composition gave the batch contract to: a
      // sidecar has none of these and must not gain them.
      if (!c.env?.some((e) => e.name === ENV.params)) continue
      setEnv(c, ENV.params, JSON.stringify(opts.params))
      setEnv(c, ENV.trigger, opts.trigger)
      setEnv(c, ENV.restartOf, opts.restartOf)
    }
  }
  return run
}

export function gvrOfRun(run: Pick<RunObject, 'apiVersion'>): Gvr {
  return runKindOf(run) === 'VolcanoJob' ? VOLCANO_JOBS_GVR : JOBS_GVR
}

export interface RestartPlan {
  /** Why it cannot be restarted; nothing else is set then. */
  error?: string
  name?: string
  base?: string
  params?: Record<string, string>
  identifying?: Record<string, string>
  /** The image the run used and the image a restart will use, when they differ. */
  imageChange?: { from: string; to: string }
}

/**
 * Restart a failed run: the same IDENTIFYING parameters, so Spring Batch finds
 * the same JobInstance and re-executes only the failed steps (§3.4). A scheduled
 * run has `ADHAR_BATCH_PARAMS: {}` and got its date from the schedule, so the
 * restart must state it explicitly: from the run's summary, else its scheduled
 * timestamp. Without that it would start a new JobInstance, re-processing a
 * business date from the top.
 */
export function restartPlan(job: string, run: RunRow, template: RunTemplate, existingNames: readonly string[]): RestartPlan {
  const given = runParams(run.raw)
  const values: Record<string, string> = {}
  const scheduledMs = toMs(run.scheduledAt)
  for (const f of template.fields) {
    const v = given[f.name]
    if (v !== undefined) values[f.name] = v
    else if (f.source === 'schedule' && f.type === 'date' && run.businessDate) values[f.name] = run.businessDate
    else if (f.source === 'schedule' && f.type === 'datetime' && scheduledMs !== undefined) values[f.name] = new Date(scheduledMs).toISOString()
  }
  const resolved = resolveParams(template.fields, values)
  const problems = Object.entries(resolved.errors)
  if (problems.length) {
    return { error: `This run’s parameters cannot be reused: ${problems.map(([k, v]) => `${k}: ${v}`).join(' ')}` }
  }
  let base: string
  try {
    base = runName(job, resolved.identifying)
  } catch (e) {
    return { error: (e as Error).message }
  }
  const name = nextRestartName(base, existingNames)
  if (!name) return { error: `${base} has reached ${MAX_RESTARTS} restarts. Investigate the failure before going further.` }
  const from = run.image
  const to = runImage(template.manifest)
  return { name, base, params: resolved.params, identifying: resolved.identifying, ...(from && to && from !== to ? { imageChange: { from, to } } : {}) }
}

/* ─────────────────────────── jobs ─────────────────────────── */

export function jobApplication(job: BatchJobXR): string {
  return job.metadata.labels?.[LABEL.application] ?? job.spec?.parameters?.application ?? job.metadata.name
}

export function jobEnvironment(job: BatchJobXR, envByNamespace?: ReadonlyMap<string, string>): string | undefined {
  return job.metadata.labels?.[LABEL.environment] ?? job.spec?.parameters?.environment ??
    (job.metadata.namespace ? envByNamespace?.get(job.metadata.namespace) : undefined)
}

export function heldOf(job: BatchJobXR): { reason: string; since?: string } | undefined {
  const reason = job.metadata.annotations?.[ANNOTATION.hold] ?? job.status?.held?.reason
  return reason === undefined ? undefined : { reason, since: job.status?.held?.since }
}

export interface ScheduleView {
  /** `On demand` for a job with no schedule. */
  label: string
  cron?: string
  timeZone: string
  suspended: boolean
}

export function scheduleOf(job: BatchJobXR): ScheduleView {
  const s = job.spec?.parameters?.schedule
  const timeZone = s?.timeZone || 'UTC'
  if (!s?.cron) return { label: 'On demand', timeZone, suspended: false }
  return { label: describeCron(s.cron), cron: s.cron, timeZone, suspended: s.suspend === true }
}

/**
 * When it next fires: kube-state-metrics' answer when it has one in the future
 * (`kube_cronjob_next_schedule_time`, what the controller computed), else the
 * same cron stepped here with the job's time zone. Nothing for a held, suspended
 * or on-demand job: a time on the screen would say it is going to run.
 */
export function nextRunOf(job: BatchJobXR, opts: { now?: number; reportedMs?: number } = {}): number | undefined {
  const now = opts.now ?? Date.now()
  const sch = scheduleOf(job)
  if (!sch.cron || sch.suspended || heldOf(job)) return undefined
  if (opts.reportedMs !== undefined && opts.reportedMs > now) return opts.reportedMs
  return nextRuns(sch.cron, now, 1, sch.timeZone)[0]
}

export type JobStatus = 'running' | 'failed' | 'not-ready' | 'stopped' | 'succeeded' | 'idle' | 'deleting'

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  running: 'Running',
  failed: 'Last run failed',
  'not-ready': 'Not ready',
  stopped: 'Stopped',
  succeeded: 'Last run succeeded',
  idle: 'No runs yet',
  deleting: 'Deleting',
}

export const JOB_STATUS_BADGE: Record<JobStatus, 'healthy' | 'paused' | 'progressing' | 'failed' | 'unknown' | 'info'> = {
  running: 'progressing',
  failed: 'failed',
  'not-ready': 'paused',
  stopped: 'paused',
  succeeded: 'healthy',
  idle: 'info',
  deleting: 'progressing',
}

/** The conditions the composition reports that a BatchJob needs (§6.2). */
export const JOB_CONDITIONS = ['Ready', 'Synced', 'ScheduleReady', 'TemplateReady', 'PrerequisitesReady'] as const

export function jobProblem(job: BatchJobXR): string | undefined {
  for (const type of JOB_CONDITIONS) {
    const c = job.status?.conditions?.find((x) => x.type === type)
    if (c?.status === 'False') return c.message || `${type}: ${c.reason ?? 'False'}`
  }
  return undefined
}

/** One word for the job's row. What its runs say comes first: a failed run outranks a definition still reconciling. */
export function jobStatusOf(job: BatchJobXR, runs: readonly RunRow[]): JobStatus {
  if (job.metadata.deletionTimestamp) return 'deleting'
  if (runs.some((r) => isActivePhase(r.phase))) return 'running'
  const last = runs[0]
  if (last?.phase === 'failed') return 'failed'
  if (jobProblem(job)) return 'not-ready'
  if (last?.phase === 'stopped') return 'stopped'
  if (last?.phase === 'succeeded') return 'succeeded'
  return 'idle'
}

/* SLA (§11.4; `finishBy` is Phase 3) */

export type SlaLevel = 'none' | 'ok' | 'at-risk' | 'breached'

export interface SlaState {
  level: SlaLevel
  message?: string
  /** The bound a run's duration is judged against, in milliseconds. */
  maxDurationMs?: number
}

export function maxDurationOf(job: BatchJobXR): number | undefined {
  const p = job.spec?.parameters
  const explicit = parseDurationMs(p?.sla?.maxDuration)
  if (explicit !== undefined) return explicit
  const deadline = p?.timeouts?.activeDeadlineSeconds
  return deadline ? deadline * 1_000 : undefined
}

const fmtMinutes = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`
}

/**
 * Is this job inside what it promised? A running run that passed `maxDuration`,
 * a last run that took longer, or a schedule with no success inside `staleAfter`
 * is a breach; a running run past 80% is at risk. A job with no bound and no
 * schedule has nothing to judge: `none`, not `ok`.
 */
export function slaStateOf(job: BatchJobXR, runs: readonly RunRow[], now = Date.now()): SlaState {
  const maxDurationMs = maxDurationOf(job)
  const sch = scheduleOf(job)
  const active = runs.find((r) => isActivePhase(r.phase))
  if (maxDurationMs !== undefined && active?.durationMs !== undefined) {
    if (active.durationMs > maxDurationMs) return { level: 'breached', maxDurationMs, message: `${active.name} has run longer than its ${fmtMinutes(maxDurationMs)} limit.` }
    if (active.durationMs > maxDurationMs * 0.8) return { level: 'at-risk', maxDurationMs, message: `${active.name} is past 80% of its ${fmtMinutes(maxDurationMs)} limit.` }
  }
  const stale = parseDurationMs(job.spec?.parameters?.alerts?.staleAfter ?? '26h')
  const lastOk = toMs(job.status?.lastSuccessfulTime)
  if (sch.cron && !heldOf(job) && !sch.suspended && stale !== undefined && lastOk !== undefined && now - lastOk > stale) {
    return { level: 'breached', maxDurationMs, message: `No success for more than ${fmtMinutes(stale)}.` }
  }
  const finished = runs.find((r) => !isActivePhase(r.phase) && r.durationMs !== undefined)
  if (maxDurationMs !== undefined && finished?.durationMs !== undefined && finished.durationMs > maxDurationMs) {
    return { level: 'breached', maxDurationMs, message: `${finished.name} took longer than its ${fmtMinutes(maxDurationMs)} limit.` }
  }
  if (maxDurationMs === undefined && !sch.cron) return { level: 'none' }
  return { level: 'ok', maxDurationMs }
}

export const SLA_LABEL: Record<SlaLevel, string> = { none: 'No SLA', ok: 'Within SLA', 'at-risk': 'At risk', breached: 'Breached' }
export const SLA_BADGE: Record<SlaLevel, 'healthy' | 'paused' | 'failed' | 'unknown'> = { none: 'unknown', ok: 'healthy', 'at-risk': 'paused', breached: 'failed' }

/* The Jobs page */

export interface JobRow {
  key: string
  job: BatchJobXR
  namespace: string
  name: string
  displayName: string
  application: string
  environment?: string
  project?: string
  team?: string
  schedule: ScheduleView
  nextRunMs?: number
  held?: { reason: string; since?: string }
  status: JobStatus
  problem?: string
  lastRun?: RunRow
  lastSuccess?: string
  sla: SlaState
  queue?: string
  runs: RunRow[]
}

export function jobRows(
  jobs: readonly BatchJobXR[],
  runs: readonly RunRow[],
  ctx: { envByNamespace?: ReadonlyMap<string, string>; nextByCronJob?: ReadonlyMap<string, number>; now?: number } = {},
): JobRow[] {
  const now = ctx.now ?? Date.now()
  const rows = jobs.map((job): JobRow => {
    const namespace = job.metadata.namespace ?? ''
    const name = job.metadata.name
    const mine = runs.filter((r) => r.namespace === namespace && r.batchJob === name)
    const succeeded = mine.find((r) => r.phase === 'succeeded')
    const p = job.spec?.parameters
    return {
      key: batchRef(namespace, name),
      job,
      namespace,
      name,
      displayName: p?.displayName || name,
      application: jobApplication(job),
      environment: jobEnvironment(job, ctx.envByNamespace),
      project: job.metadata.labels?.[LABEL.project] ?? p?.project,
      team: job.metadata.labels?.[LABEL.team] ?? p?.team,
      schedule: scheduleOf(job),
      nextRunMs: nextRunOf(job, { now, reportedMs: ctx.nextByCronJob?.get(batchRef(namespace, job.status?.cronJob ?? name)) }),
      held: heldOf(job),
      status: jobStatusOf(job, mine),
      problem: jobProblem(job),
      lastRun: mine[0],
      lastSuccess: job.status?.lastSuccessfulTime ?? succeeded?.finishedAt,
      sla: slaStateOf(job, mine, now),
      queue: job.status?.queue,
      runs: mine,
    }
  })
  return rows.sort(byApplicationThenEnvironment)
}

function envRank(env: string | undefined): number {
  const i = (PLATFORM_ENVIRONMENTS as readonly string[]).indexOf(env ?? '')
  return i < 0 ? PLATFORM_ENVIRONMENTS.length : i
}

/** Application, then environment in promotion order, then name: the grouping §7.2 asks for. */
function byApplicationThenEnvironment(a: JobRow, b: JobRow): number {
  return a.application.localeCompare(b.application) || envRank(a.environment) - envRank(b.environment) || a.name.localeCompare(b.name)
}

export interface JobGroup {
  application: string
  rows: JobRow[]
}

export function groupByApplication(rows: readonly JobRow[]): JobGroup[] {
  const out: JobGroup[] = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (last?.application === row.application) last.rows.push(row)
    else out.push({ application: row.application, rows: [row] })
  }
  return out
}

export function jobSearchText(r: JobRow): string[] {
  return [r.name, r.displayName, r.application, r.namespace, r.project, r.team, r.schedule.cron, r.job.spec?.parameters?.job, r.held?.reason].filter((s): s is string => Boolean(s))
}

/** A batch application with no BatchJob yet: scaffolded, not promoted to any environment. */
export function isBatchApplication(app: ApplicationXR): boolean {
  return app.spec?.parameters?.type === 'batch' || app.metadata.labels?.[LABEL.workload] === 'batch'
}

export function pendingApplications(apps: readonly ApplicationXR[] | undefined, rows: readonly JobRow[]): ApplicationXR[] {
  const deployed = new Set(rows.map((r) => r.application))
  return (apps ?? []).filter((a) => isBatchApplication(a) && !deployed.has(a.metadata.labels?.[LABEL.application] || a.metadata.name))
}

/** Who manages this job's definition, and through which Application it is deleted. */
export const jobOwner = (job: BatchJobXR) => gitopsOwner(job.metadata)

/* ─────────────────────────── page state ─────────────────────────── */

export interface BatchJobList {
  items: BatchJobXR[]
  /** `cluster`: one list across the cluster; `namespaces`: the caller could only list some. */
  scope: 'cluster' | 'namespaces'
  namespaces: string[]
  denied: string[]
  /** False when `batchjobs.platform.adhar.io` is not served on this cluster. */
  installed: boolean
}

export type PageState = 'loading' | 'error' | 'not-installed' | 'forbidden' | 'empty' | 'ready'

/**
 * Which of the page's states applies. "Forbidden" has to be told apart from
 * "empty": a person who may read nothing must not be told there are no jobs,
 * because they would go and create one, or conclude a production job is gone.
 */
export function pageStateOf(q: { list?: BatchJobList; isLoading: boolean; isError: boolean }, pendingApps = 0): PageState {
  const l = q.list
  if (!l) return q.isLoading ? 'loading' : q.isError ? 'error' : 'loading'
  if (!l.installed && !l.items.length) return 'not-installed'
  if (l.items.length || pendingApps) return 'ready'
  if (l.scope === 'namespaces' && (l.namespaces.length === 0 || l.denied.length === l.namespaces.length)) return 'forbidden'
  return 'empty'
}

/* ─────────────────────────── recent runs against maxDuration ─────────────────────────── */

export interface DurationBar {
  key: string
  name: string
  phase: RunPhase
  durationMs: number
  /** Bar height as a share of the taller of the slowest run and the limit, 0..1. */
  ratio: number
  over: boolean
}

/** Oldest first, so it reads left to right as time. The limit line sits at `limitRatio`. */
export function durationBars(runs: readonly RunRow[], maxDurationMs: number | undefined, count = 20): { bars: DurationBar[]; limitRatio?: number } {
  const recent = runs.filter((r) => r.durationMs !== undefined).slice(0, count).reverse()
  const top = Math.max(1, maxDurationMs ?? 0, ...recent.map((r) => r.durationMs as number))
  return {
    bars: recent.map((r) => ({
      key: r.key,
      name: r.name,
      phase: r.phase,
      durationMs: r.durationMs as number,
      ratio: (r.durationMs as number) / top,
      over: maxDurationMs !== undefined && (r.durationMs as number) > maxDurationMs,
    })),
    limitRatio: maxDurationMs !== undefined ? maxDurationMs / top : undefined,
  }
}

/* ─────────────────────────── events ─────────────────────────── */

/** Events about a run, its pods and its Volcano PodGroup, newest first. */
export function runEvents(events: readonly EventLike[] | undefined, run: Pick<RunRow, 'name'>, podNames: readonly string[]): EventRow[] {
  const pods = new Set(podNames)
  return (events ?? [])
    .filter((e) => {
      const n = e.involvedObject?.name ?? ''
      return n === run.name || pods.has(n) || n.startsWith(`${run.name}-`)
    })
    .map((e) => ({
      key: e.metadata.uid ?? e.metadata.name,
      type: e.type ?? 'Normal',
      reason: e.reason ?? '',
      message: e.message ?? '',
      object: `${e.involvedObject?.kind ?? ''}/${e.involvedObject?.name ?? ''}`,
      count: typeof e.count === 'number' ? e.count : 1,
      at: e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp,
    }))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

/* ─────────────────────────── metrics, alerts and links ─────────────────────────── */

const promEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

export interface RunMetricQuery {
  id: 'cpu' | 'memory'
  title: string
  unit: 'cores' | 'bytes'
  hint: string
  query: string
}

/**
 * CPU and memory of a run's pods. Only cAdvisor series: the kit's own meters
 * arrive through OTLP with translated names, and §11.1 forbids writing them from
 * the Micrometer names until a query at the sink has proved them. They belong on
 * the `batch-jvm` dashboard this page links to.
 */
export function runMetricQueries(namespace: string, run: string): RunMetricQuery[] {
  const sel = `namespace="${promEsc(namespace)}",pod=~"${promEsc(run)}-.*",container!="",container!="POD"`
  return [
    { id: 'cpu', title: 'CPU', unit: 'cores', hint: 'cores used, summed across the run’s pods', query: `sum(rate(container_cpu_usage_seconds_total{${sel}}[2m]))` },
    { id: 'memory', title: 'Memory', unit: 'bytes', hint: 'working set; a batch pod is killed at its limit', query: `sum(container_memory_working_set_bytes{${sel}})` },
  ]
}

export interface PromSample {
  labels: Record<string, string>
  value: number
}

/** `kube_cronjob_next_schedule_time` across namespaces, keyed `<namespace>/<cronjob>`, in milliseconds. */
export function nextScheduleQuery(namespaces: readonly string[]): string {
  const ns = namespaces.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return `kube_cronjob_next_schedule_time{namespace=~"${promEsc(ns)}"}`
}

export function nextScheduleIndex(samples: readonly PromSample[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of samples) {
    const ns = s.labels.namespace
    const cj = s.labels.cronjob
    if (ns && cj && Number.isFinite(s.value)) out.set(batchRef(ns, cj), s.value * 1_000)
  }
  return out
}

/**
 * This job's firing alerts. `ALERTS` is Prometheus's own series for rule state,
 * and the composed rules label every alert `adhar_batch_job` (§11.3).
 */
export function firingAlertsQuery(namespace: string, job: string): string {
  return `ALERTS{alertstate="firing",namespace="${promEsc(namespace)}",adhar_batch_job="${promEsc(job)}"}`
}

export interface FiringAlert {
  name: string
  severity?: string
  labels: Record<string, string>
}

export function firingAlerts(samples: readonly PromSample[]): FiringAlert[] {
  return samples
    .map((s) => ({ name: s.labels.alertname ?? 'Alert', severity: s.labels.severity, labels: s.labels }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface ObservabilityLinks {
  dashboard: string
  logs: string
  traces: string
}

/**
 * Where a job is watched outside this page. The dashboard is `app-<application>`,
 * the uid the Application composition stamps per application (type `batch-jvm`
 * for these), with the environment's namespace as its `env` variable.
 */
export function observabilityLinks(grafana: string, o: { application: string; namespace: string; name: string; run?: string }): ObservabilityLinks | undefined {
  if (!grafana) return undefined
  const base = grafana.replace(/\/$/, '')
  const pods = o.run ? `${o.run}-.*` : `${o.name}-.*`
  const explore = (ds: { type: string; uid: string }, q: Record<string, unknown>) => {
    const panes = { a: { datasource: ds.uid, queries: [{ refId: 'A', datasource: ds, ...q }], range: { from: 'now-24h', to: 'now' } } }
    return `${base}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`
  }
  return {
    dashboard: `${base}/d/app-${encodeURIComponent(o.application)}?var-env=${encodeURIComponent(o.namespace)}`,
    logs: explore({ type: 'loki', uid: 'loki' }, { expr: `{namespace="${promEsc(o.namespace)}",pod=~"${promEsc(pods)}"}` }),
    traces: explore({ type: 'tempo', uid: 'tempo' }, { queryType: 'traceql', limit: 20, query: `{ resource.service.name = "${promEsc(o.application)}" }` }),
  }
}
