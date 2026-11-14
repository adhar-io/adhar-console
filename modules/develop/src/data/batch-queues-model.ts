import type { Condition, Meta } from './functions-model.ts'
import type { BatchJobXR } from './batch-model.ts'
import { LABEL } from './batch-model.ts'

/**
 * Develop → Batch → Queues, the pure half (design 0025 §4.3, §7.2 Phase 2):
 * what Volcano's `Queue` and `PodGroup` objects MEAN for a team, with no
 * fetching and no React (`batch-queues-model_test.ts`).
 *
 *   • The platform's batch capacity is one hierarchy. `Queue adhar-batch` is the
 *     parent (its capability is the cluster's batch ceiling, rendered at seed
 *     time), and under it one LEAF per team × tier, named `<org>-<team>-<env>`
 *     with `<env>` one of `dev | test | prod`. Only leaves schedule.
 *   • A team may `get` its three leaves by name and nothing else (§10.2), so the
 *     names are worked out here from what the user can already read: the
 *     queue a BatchJob reports, and the organisation and team its namespace
 *     carries.
 *   • A PodGroup is one gang: Volcano creates no pod of it until `minMember` of
 *     them fit at once (§4.5). Pending/Inqueue with an `Unschedulable` condition
 *     is a gang waiting for room.
 *
 * Every field is optional: Volcano is optional (disabled in every profile until
 * the production gate, §15), and a page that throws on a missing status shows
 * nothing at all.
 */

/* ─────────────────────────── API surface ─────────────────────────── */

/** The parent of every team leaf, unless the scheduler descriptor names another. */
export const ROOT_QUEUE = 'adhar-batch'
/** The three tiers a team has a leaf for, in promotion order. */
export const TIERS = ['dev', 'test', 'prod'] as const
export type Tier = (typeof TIERS)[number]
/** `ConfigMap adhar-batch-scheduler` (D7): which scheduler batch resolves to. Absent means the native path. */
export const SCHEDULER_DESCRIPTOR = { namespace: 'adhar-system', name: 'adhar-batch-scheduler' } as const
/** `BatchGangPending` fires after this long (§11.3); the page warns at the same point. */
export const GANG_PENDING_ALERT_MS = 30 * 60_000

const ORG_LABEL = 'adhar.io/organisation'

export type ResourceList = Record<string, string | number | undefined>

export interface VolcanoQueue {
  apiVersion?: string
  kind?: string
  metadata: Meta
  spec?: {
    capability?: ResourceList
    deserved?: ResourceList
    guarantee?: { resource?: ResourceList }
    reclaimable?: boolean
    priority?: number
    weight?: number
    parent?: string
  }
  status?: {
    state?: string
    pending?: number
    inqueue?: number
    running?: number
    completed?: number
    unknown?: number
    allocated?: ResourceList
  }
}

export interface PodGroup {
  apiVersion?: string
  kind?: string
  metadata: Meta & { ownerReferences?: Array<{ apiVersion?: string; kind?: string; name?: string; uid?: string; controller?: boolean }> }
  spec?: {
    minMember?: number
    minTaskMember?: Record<string, number>
    queue?: string
    priorityClassName?: string
    minResources?: ResourceList
  }
  status?: {
    phase?: string
    conditions?: Array<Condition & { transitionID?: string }>
    running?: number
    succeeded?: number
    failed?: number
  }
}

/* ─────────────────────────── quantities ─────────────────────────── */

const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 }
const DECIMAL: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 }

/** A Kubernetes quantity in base units (cores, bytes, counts); `undefined` when it is not one. */
export function parseQuantity(q: string | number | undefined | null): number | undefined {
  if (typeof q === 'number') return Number.isFinite(q) ? q : undefined
  if (typeof q !== 'string') return undefined
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))(?:[eE]([+-]?\d+))?\s*([a-zA-Z]{0,2})\s*$/.exec(q)
  if (!m) return undefined
  const n = Number(m[1]) * (m[2] ? 10 ** Number(m[2]) : 1)
  const unit = m[3]
  const factor = BINARY[unit] ?? DECIMAL[unit]
  return factor === undefined || !Number.isFinite(n) ? undefined : n * factor
}

/** `2`, `1.5`, `250m`: cores the way a manifest would say them. */
export function formatCores(cores: number | undefined): string {
  if (cores === undefined) return '—'
  if (cores !== 0 && Math.abs(cores) < 1) return `${Math.round(cores * 1000)}m`
  return String(Number(cores.toFixed(2)))
}

/** `4 GiB`, `512 MiB`. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  const units: Array<[string, number]> = [['TiB', 2 ** 40], ['GiB', 2 ** 30], ['MiB', 2 ** 20], ['KiB', 2 ** 10]]
  for (const [u, f] of units) if (Math.abs(bytes) >= f) return `${Number((bytes / f).toFixed(1))} ${u}`
  return `${bytes} B`
}

/** The part of a ResourceList a person reads: cores, bytes, and everything else as written. */
export interface Res {
  cpu?: number
  memory?: number
  /** Extended resources (`nvidia.com/gpu`, `pods`), as `[name, value]`. */
  other: Array<[string, string]>
}

export function resOf(rl: ResourceList | undefined): Res {
  const out: Res = { other: [] }
  for (const [k, v] of Object.entries(rl ?? {})) {
    if (v === undefined || v === null || v === '') continue
    if (k === 'cpu') out.cpu = parseQuantity(v)
    else if (k === 'memory') out.memory = parseQuantity(v)
    else out.other.push([k, String(v)])
  }
  out.other.sort((a, b) => a[0].localeCompare(b[0]))
  return out
}

export const hasRes = (r: Res): boolean => r.cpu !== undefined || r.memory !== undefined || r.other.length > 0

export function formatRes(r: Res): string {
  if (!hasRes(r)) return '—'
  return [
    r.cpu !== undefined ? `${formatCores(r.cpu)} CPU` : null,
    r.memory !== undefined ? formatBytes(r.memory) : null,
    ...r.other.map(([k, v]) => `${v} ${k}`),
  ].filter(Boolean).join(' · ')
}

function addRes(a: Res, b: Res): Res {
  return {
    cpu: a.cpu === undefined && b.cpu === undefined ? undefined : (a.cpu ?? 0) + (b.cpu ?? 0),
    memory: a.memory === undefined && b.memory === undefined ? undefined : (a.memory ?? 0) + (b.memory ?? 0),
    other: [...a.other, ...b.other],
  }
}

const maxOf = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b)

/** The larger of the CPU and memory fractions of `of` that `used` takes; `undefined` with no ceiling to measure against. */
export function shareOf(used: Res, of: Res): number | undefined {
  const parts = [
    of.cpu ? (used.cpu ?? 0) / of.cpu : undefined,
    of.memory ? (used.memory ?? 0) / of.memory : undefined,
  ].filter((x): x is number => x !== undefined)
  return parts.length ? Math.max(...parts) : undefined
}

/* ─────────────────────────── which queues are the team's ─────────────────────────── */

/** `<org>-<team>-<env>` (§4.3): `<org>-<team>` is the Team XR's name, and every project of the team shares its leaves. */
export function leafQueueName(org: string, team: string, tier: Tier): string {
  return `${org}-${team}-${tier}`
}

export function isTier(v: string | undefined): v is Tier {
  return v === 'dev' || v === 'test' || v === 'prod'
}

/** The Team composition stamps each leaf with its tier under this label (compositions/team/local.yaml). */
const TIER_LABEL = 'adhar.io/tier'

/** The tier of a leaf: its tier (or environment) label, else the suffix of its name. */
export function tierOf(q: VolcanoQueue): Tier | undefined {
  const tier = q.metadata.labels?.[TIER_LABEL]
  if (isTier(tier)) return tier
  const label = q.metadata.labels?.[LABEL.environment]
  if (isTier(label)) return label
  const m = /-(dev|test|prod)$/.exec(q.metadata.name)
  return m ? (m[1] as Tier) : undefined
}

/**
 * A project, as far as queue naming needs it: the organisation and team it
 * belongs to. `status` is what the Project composition RESOLVED — it defaults
 * an omitted organisation/team — so it is read before the parameters.
 */
export interface ProjectRef {
  metadata: { name: string; labels?: Record<string, string> }
  spec?: { parameters?: { organisation?: unknown; team?: unknown } } | Record<string, unknown>
  status?: { organisation?: unknown; team?: unknown } | Record<string, unknown>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * Every leaf name the caller could have: what each BatchJob says its queue is
 * (the composition writes it, so it wins), and all three tiers of every
 * organisation × team the caller's BatchJobs and projects belong to — a team's
 * dev leaf exists before its first dev job does.
 */
export function candidateQueueNames(jobs: readonly BatchJobXR[], projects: readonly ProjectRef[] = []): string[] {
  const names = new Set<string>()
  const teams = new Set<string>()
  const addTeam = (org: string | undefined, team: string | undefined) => {
    if (org && team) teams.add(`${org}\u0000${team}`)
  }
  for (const j of jobs) {
    const q = str(j.status?.queue)
    if (q) names.add(q)
    const l = j.metadata.labels ?? {}
    addTeam(l[ORG_LABEL] ?? str(j.spec?.parameters?.organisation), l[LABEL.team] ?? str(j.spec?.parameters?.team))
  }
  for (const p of projects) {
    const params = ((p.spec as { parameters?: Record<string, unknown> } | undefined)?.parameters) ?? {}
    const st = (p.status ?? {}) as Record<string, unknown>
    addTeam(
      str(st.organisation) ?? p.metadata.labels?.[ORG_LABEL] ?? str(params.organisation),
      str(st.team) ?? p.metadata.labels?.[LABEL.team] ?? str(params.team),
    )
  }
  for (const t of teams) {
    const [org, team] = t.split('\u0000')
    for (const tier of TIERS) names.add(leafQueueName(org, team, tier))
  }
  return [...names].sort()
}

/** The team a leaf belongs to, when the Team composition stamped its label. */
export function queueTeamOf(q: VolcanoQueue): string | undefined {
  return q.metadata.labels?.[LABEL.team]
}

/**
 * Whether a leaf is the active team's. A lens, not a boundary (the apiserver
 * already decided what the caller may read): by the team label when the Team
 * composition stamped one, else by the `-<team>-<tier>` the name ends in.
 */
export function belongsToTeam(q: VolcanoQueue, team: string): boolean {
  if (!team) return true
  const label = queueTeamOf(q)
  if (label) return label === team
  const tier = tierOf(q)
  return Boolean(tier && q.metadata.name.endsWith(`-${team}-${tier}`))
}

/* ─────────────────────────── gangs ─────────────────────────── */

export type GangPhase = 'Pending' | 'Inqueue' | 'Running' | 'Completed' | 'Unknown'

export const isWaitingGang = (phase: GangPhase): boolean => phase === 'Pending' || phase === 'Inqueue'

export interface GangRow {
  key: string
  namespace: string
  name: string
  queue?: string
  phase: GangPhase
  /** All-or-nothing size: no pod starts until this many fit (§4.5). */
  minMember: number
  /** Members running or finished. */
  ready: number
  running: number
  succeeded: number
  failed: number
  /** The run this gang belongs to, from the PodGroup's owner. */
  run?: { name: string; kind: 'Job' | 'VolcanoJob' }
  batchJob?: string
  minResources: Res
  createdAt?: string
  /** How long it has been waiting for room; undefined once it runs. */
  waitingMs?: number
  /** Volcano's own words for why it does not fit. */
  reason?: string
  /** Waiting past the `BatchGangPending` threshold. */
  overdue: boolean
}

function gangPhaseOf(pg: PodGroup): GangPhase {
  const p = pg.status?.phase
  return p === 'Pending' || p === 'Inqueue' || p === 'Running' || p === 'Completed' ? p : 'Unknown'
}

/** The newest condition saying the gang does not fit, while it is true. */
function unschedulableOf(pg: PodGroup): string | undefined {
  const conds = (pg.status?.conditions ?? []).filter((c) => c.type === 'Unschedulable' && c.status === 'True')
  conds.sort((a, b) => (b.lastTransitionTime ?? '').localeCompare(a.lastTransitionTime ?? ''))
  const c = conds[0]
  return c ? (c.message || c.reason) : undefined
}

export function gangRow(pg: PodGroup, now = Date.now()): GangRow {
  const phase = gangPhaseOf(pg)
  const owner = (pg.metadata.ownerReferences ?? []).find((o) => o.kind === 'Job' && o.name)
  const running = pg.status?.running ?? 0
  const succeeded = pg.status?.succeeded ?? 0
  const created = pg.metadata.creationTimestamp
  const createdMs = created ? Date.parse(created) : NaN
  const waiting = isWaitingGang(phase) && Number.isFinite(createdMs) ? Math.max(0, now - createdMs) : undefined
  const namespace = pg.metadata.namespace ?? ''
  return {
    key: `${namespace}/${pg.metadata.name}`,
    namespace,
    name: pg.metadata.name,
    queue: str(pg.spec?.queue),
    phase,
    minMember: Math.max(0, pg.spec?.minMember ?? 0),
    ready: running + succeeded,
    running,
    succeeded,
    failed: pg.status?.failed ?? 0,
    run: owner?.name ? { name: owner.name, kind: owner.apiVersion?.startsWith('batch.volcano.sh') ? 'VolcanoJob' : 'Job' } : undefined,
    batchJob: pg.metadata.labels?.[LABEL.batchJob],
    minResources: resOf(pg.spec?.minResources),
    createdAt: created,
    waitingMs: waiting,
    reason: isWaitingGang(phase) ? unschedulableOf(pg) : undefined,
    overdue: waiting !== undefined && waiting >= GANG_PENDING_ALERT_MS,
  }
}

const GANG_ORDER: Record<GangPhase, number> = { Pending: 0, Inqueue: 1, Running: 2, Unknown: 3, Completed: 4 }

/** Gangs still holding or waiting for capacity — waiting ones first, the longest wait on top. */
export function gangRows(pgs: readonly PodGroup[], now = Date.now()): GangRow[] {
  return pgs
    .map((pg) => gangRow(pg, now))
    .filter((g) => g.phase !== 'Completed')
    .sort((a, b) => GANG_ORDER[a.phase] - GANG_ORDER[b.phase] || (b.waitingMs ?? 0) - (a.waitingMs ?? 0) || a.key.localeCompare(b.key))
}

/** "3 of 5": members up of the gang's all-or-nothing size. */
export function gangProgress(g: Pick<GangRow, 'ready' | 'minMember'>): { label: string; fraction: number } {
  if (!g.minMember) return { label: `${g.ready}`, fraction: g.ready ? 1 : 0 }
  return { label: `${Math.min(g.ready, g.minMember)} of ${g.minMember}`, fraction: Math.min(1, g.ready / g.minMember) }
}

/**
 * The PodGroup a run's gang is, as the CLI finds it (`podGroupOf`,
 * cmd/batch/gang.go): the one the run OWNS, by uid — Volcano names a Volcano
 * Job's `<run>-<uid>` and a plain Job's `podgroup-<uid>`, and both carry the
 * run as owner — else, for a run read without its uid, the owner's name, else
 * one of those two names. The uid comes first because a Job and a Volcano Job
 * may share a name in one namespace.
 */
export function podGroupOfRun(run: { name: string; uid?: string }, pgs: readonly PodGroup[]): PodGroup | null {
  const owned = (pg: PodGroup, match: (o: NonNullable<PodGroup['metadata']['ownerReferences']>[number]) => boolean) =>
    (pg.metadata.ownerReferences ?? []).some((o) => o.kind === 'Job' && match(o))
  if (run.uid) {
    const byUid = pgs.find((pg) => owned(pg, (o) => o.uid === run.uid))
    if (byUid) return byUid
  }
  const byName = pgs.find((pg) => owned(pg, (o) => o.name === run.name && (!run.uid || !o.uid)))
  if (byName) return byName
  if (!run.uid) return null
  const names = new Set([`${run.name}-${run.uid}`, `podgroup-${run.uid}`])
  return pgs.find((pg) => names.has(pg.metadata.name)) ?? null
}

/** The gangs of one BatchJob: PodGroups carrying its label (Volcano copies a Volcano Job's labels onto them), or owned by one of its runs. */
export function gangsOfJob(job: string, runs: readonly string[], pgs: readonly PodGroup[], now = Date.now()): GangRow[] {
  const mine = new Set(runs)
  return gangRows(
    pgs.filter((pg) =>
      pg.metadata.labels?.[LABEL.batchJob] === job ||
      (pg.metadata.ownerReferences ?? []).some((o) => o.kind === 'Job' && o.name !== undefined && mine.has(o.name))
    ),
    now,
  )
}

/* ─────────────────────────── a job's gang and its queue (DEC-3) ─────────────────────────── */

/** The composition's defaults for a run pod (xrd/batchjob.xrd.yaml) and for the gang (§6.2). */
const DEFAULT_CPU = '1'
const DEFAULT_MEMORY = '1536Mi'
const DEFAULT_WORKERS = 4

/** What one run of a job asks Volcano for: one pod, or a manager and its workers that start together (§4.5). */
export interface GangPlan {
  shape: 'single' | 'gang'
  /** All-or-nothing size: 1, or 1 manager + `workers`. */
  members: number
  workers: number
  manager: Res
  worker?: Res
  /** The gang's summed requests — what its PodGroup's `minResources` will be. */
  request: Res
}

export function gangPlanOf(job: BatchJobXR): GangPlan {
  const p = job.spec?.parameters ?? {}
  const r = p.resources ?? {}
  const manager: Res = { cpu: parseQuantity(r.cpu ?? DEFAULT_CPU), memory: parseQuantity(r.memory ?? DEFAULT_MEMORY), other: [] }
  if (p.mode !== 'partitioned' && p.mode !== 'chunked') return { shape: 'single', members: 1, workers: 0, manager, request: manager }
  const workers = Math.max(1, Math.floor(p.workers ?? DEFAULT_WORKERS))
  const worker: Res = { cpu: parseQuantity(r.workerCpu ?? r.cpu ?? DEFAULT_CPU), memory: parseQuantity(r.workerMemory ?? r.memory ?? DEFAULT_MEMORY), other: [] }
  const times = (x: number | undefined, n: number) => (x === undefined ? undefined : x * n)
  const request = addRes(manager, { cpu: times(worker.cpu, workers), memory: times(worker.memory, workers), other: [] })
  return { shape: 'gang', members: workers + 1, workers, manager, worker, request }
}

/**
 * The queue a job's Volcano runs go to: what the composition reports
 * (`status.queue`, authoritative), else `<org>-<team>-<tier>` from the labels
 * of the job's NAMESPACE, when the caller has them — the composition (and
 * adhar-batch-queue-binding) name the leaf from the namespace's
 * `adhar.io/tier`, never from the job's environment: an environment named
 * `dev` may be of tier `test`, and a name guessed from it is another team
 * leaf's. `undefined` when neither says.
 */
export function queueOfJob(job: BatchJobXR, namespaceLabels?: Readonly<Record<string, string>>): { name: string; reported: boolean } | undefined {
  const reported = str(job.status?.queue)
  if (reported) return { name: reported, reported: true }
  const l = namespaceLabels ?? {}
  const org = l[ORG_LABEL]
  const team = l[LABEL.team]
  const tier = l[TIER_LABEL]
  return org && team && isTier(tier) ? { name: leafQueueName(org, team, tier), reported: false } : undefined
}

/**
 * The condition the BatchJob composition raises when the job's gang does not fit
 * its queue (DEC-3, 2026-11-14): `False` with the reason in its message. The
 * page shows it as written, and otherwise works the same answer out itself.
 */
export const QUEUE_FIT_CONDITION = 'QueueFits'

export function queueConditionOf(job: BatchJobXR): Condition | undefined {
  const c = job.status?.conditions?.find((x) => x.type === QUEUE_FIT_CONDITION)
  return c?.status === 'False' ? c : undefined
}

/**
 * The Scheduling section's warning: the composition's QueueFits=False as it is
 * written; else the page's own fit. A fit worked out from the DESCRIPTOR's prod
 * share (the leaf could not be read) never overrides a QueueFits condition the
 * composition did write — it read the team's real leaf, whose deserved share may
 * differ from the platform default. A fit against the leaf itself, or a leaf the
 * page found missing, is still said: it is a newer read of the same object.
 */
export function jobQueueWarning(job: BatchJobXR, fit: QueueFit): string | undefined {
  const failed = queueConditionOf(job)
  if (failed) return failed.message || `${failed.type}: ${failed.reason ?? 'False'}`
  if (fit.level !== 'never' && fit.level !== 'no-reclaim' && fit.level !== 'missing') return undefined
  const reported = job.status?.conditions?.some((x) => x.type === QUEUE_FIT_CONDITION)
  return fit.source === 'descriptor' && reported ? undefined : fit.message
}

/**
 * `fits`: Volcano can admit the gang, and a prod gang can reclaim. `no-reclaim`:
 * it fits the queue's capability but asks for more than the leaf's deserved
 * share in EVERY dimension, so it never takes capacity back from dev and test
 * (v1.16 capacity.go: a queue reclaims while `allocated + request ≤ deserved`
 * holds in at least one dimension) and starts only on room left over. `never`:
 * it is bigger than the queue's capability, so it waits Pending for ever.
 * `missing`: the leaf does not exist. `unknown`: nothing to compare against.
 */
export type QueueFitLevel = 'fits' | 'no-reclaim' | 'never' | 'missing' | 'unknown'

export interface QueueFit {
  level: QueueFitLevel
  message?: string
  /** What the comparison was made against, as a person reads it. */
  capability?: Res
  deserved?: Res
  /** `queue`: the leaf itself; `descriptor`: the platform's prod share, because the leaf could not be read. */
  source?: 'queue' | 'descriptor'
}

/** Some requested dimension is over its bound. A bound that is not declared does not limit (Volcano's capability is unlimited there). */
function overAny(req: Res, bound: Res): boolean {
  return (req.cpu !== undefined && bound.cpu !== undefined && req.cpu > bound.cpu) ||
    (req.memory !== undefined && bound.memory !== undefined && req.memory > bound.memory)
}

/** Every requested dimension is over its share. An undeclared share is zero (the capacity plugin's `deserved`). */
function overEvery(req: Res, share: Res): boolean {
  const dims = (['cpu', 'memory'] as const).filter((d) => (req[d] ?? 0) > 0)
  return dims.length > 0 && dims.every((d) => (req[d] ?? 0) > (share[d] ?? 0))
}

const gangWords = (plan: GangPlan) =>
  plan.shape === 'gang' ? `Its gang of ${plan.members} (1 manager + ${plan.workers} workers) asks for ${formatRes(plan.request)}` : `Its run asks for ${formatRes(plan.request)}`

export function queueFitOf(
  plan: GangPlan,
  queue: { name: string; leaf?: VolcanoQueue; state: 'present' | 'missing' | 'denied' | 'unknown' },
  descriptor?: SchedulerDescriptor,
): QueueFit {
  if (queue.state === 'missing') {
    return {
      level: 'missing',
      message: `Queue ${queue.name} does not exist. The Team composition creates a team’s leaves, and refuses a prod leaf when the batch root has no deserved share left for it (BatchQueuesReady is QueueRejected on the Team). Until the leaf exists, this job’s Volcano runs are refused.`,
    }
  }
  const tier = queue.leaf ? tierOf(queue.leaf) : (/-(dev|test|prod)$/.exec(queue.name)?.[1] as Tier | undefined)
  if (queue.leaf) {
    const capability = resOf(queue.leaf.spec?.capability)
    const deserved = resOf(queue.leaf.spec?.deserved)
    if (overAny(plan.request, capability)) {
      return {
        level: 'never',
        capability,
        deserved,
        source: 'queue',
        message: `${gangWords(plan)}, more than queue ${queue.name} can ever hold (${formatRes(capability)}). Volcano will not admit it: its runs wait Pending, holding nothing, until the job is made smaller or the team’s allowance grows.`,
      }
    }
    if (hasRes(deserved) && overEvery(plan.request, deserved)) {
      return {
        level: 'no-reclaim',
        capability,
        deserved,
        source: 'queue',
        message: `${gangWords(plan)}, more than the ${formatRes(deserved)} queue ${queue.name} is guaranteed in every dimension, so it cannot reclaim capacity from dev and test runs. It starts only when the cluster has that much room left over.`,
      }
    }
    return { level: 'fits', capability, deserved, source: 'queue' }
  }
  // The leaf could not be read: for prod, the platform's own share says as much.
  const share: Res = { cpu: parseQuantity(descriptor?.prodDeservedCPU), memory: parseQuantity(descriptor?.prodDeservedMemory), other: [] }
  if (tier === 'prod' && hasRes(share)) {
    if (overEvery(plan.request, share)) {
      return {
        level: 'no-reclaim',
        deserved: share,
        source: 'descriptor',
        message: `${gangWords(plan)}, more than the platform’s ${formatRes(share)} prod share in every dimension, so it cannot reclaim capacity from dev and test runs. It starts only when the cluster has that much room left over.`,
      }
    }
    return { level: 'fits', deserved: share, source: 'descriptor' }
  }
  return { level: 'unknown' }
}

/* ─────────────────────────── queue rows ─────────────────────────── */

/**
 * `saturated`: allocated has reached capability and work is still waiting — the
 * `BatchQueueSaturated` condition (§11.3). `over-share`: past its `deserved`
 * share on a reclaimable leaf, so prod may take that capacity back (§4.3).
 * `closed`: Volcano admits nothing new.
 */
export type QueueLevel = 'ok' | 'over-share' | 'saturated' | 'closed'

export const QUEUE_LEVEL_LABEL: Record<QueueLevel, string> = {
  ok: 'Has room',
  'over-share': 'Over its share',
  saturated: 'Saturated',
  closed: 'Closed',
}

export const QUEUE_LEVEL_BADGE: Record<QueueLevel, 'healthy' | 'paused' | 'degraded' | 'unknown'> = {
  ok: 'healthy',
  'over-share': 'paused',
  saturated: 'degraded',
  closed: 'unknown',
}

export interface QueueRow {
  name: string
  tier?: Tier
  team?: string
  parent?: string
  state?: string
  capability: Res
  deserved: Res
  guarantee: Res
  allocated: Res
  /** Summed `minResources` of the gangs waiting in this queue. */
  demand: Res
  counts: { pending: number; inqueue: number; running: number; completed: number }
  /** Gangs of this queue the caller could read (waiting or running). */
  gangs: GangRow[]
  waiting: number
  reclaimable?: boolean
  priority?: number
  weight?: number
  /** allocated ÷ capability, the larger of CPU and memory. */
  used?: number
  level: QueueLevel
  message: string
}

function levelOf(q: VolcanoQueue, r: Omit<QueueRow, 'level' | 'message'>): { level: QueueLevel; message: string } {
  const state = q.status?.state
  if (state === 'Closed' || state === 'Closing') return { level: 'closed', message: `Volcano reports the queue ${state.toLowerCase()}: it admits no new work.` }
  const full = (r.capability.cpu !== undefined && (r.allocated.cpu ?? 0) >= r.capability.cpu) ||
    (r.capability.memory !== undefined && (r.allocated.memory ?? 0) >= r.capability.memory)
  const demand = (r.demand.cpu ?? 0) > 0 || (r.demand.memory ?? 0) > 0 || r.counts.inqueue > 0 || r.counts.pending > 0 || r.waiting > 0
  if (full && demand) return { level: 'saturated', message: 'Allocated has reached the queue’s capability and work is waiting: it starts as runs in this queue finish.' }
  // Volcano's capacity plugin takes max(deserved, guarantee), and a queue with
  // NEITHER is best-effort: every task in it is an immediate reclaim victim
  // (v1.16 `capacity.go` isImmediateVictim). That is exactly what the Team
  // composition emits for dev and test, so anything they hold is over share.
  const share = { cpu: maxOf(r.deserved.cpu, r.guarantee.cpu), memory: maxOf(r.deserved.memory, r.guarantee.memory) }
  const over = share.cpu === undefined && share.memory === undefined
    ? (r.allocated.cpu ?? 0) > 0 || (r.allocated.memory ?? 0) > 0
    : (share.cpu !== undefined && (r.allocated.cpu ?? 0) > share.cpu) ||
      (share.memory !== undefined && (r.allocated.memory ?? 0) > share.memory)
  if (over && r.reclaimable) return { level: 'over-share', message: 'Using more than its deserved share. That is allowed while there is room; prod can reclaim it, stopping these runs gracefully to restart later.' }
  return { level: 'ok', message: full ? 'At capability, with nothing waiting.' : 'Below capability: new work is admitted.' }
}

export function queueRow(q: VolcanoQueue, gangs: readonly GangRow[]): QueueRow {
  const mine = gangs.filter((g) => g.queue === q.metadata.name)
  const waiting = mine.filter((g) => isWaitingGang(g.phase))
  const demand = waiting.reduce((acc, g) => addRes(acc, g.minResources), { other: [] } as Res)
  const capability = resOf(q.spec?.capability)
  const allocated = resOf(q.status?.allocated)
  const base: Omit<QueueRow, 'level' | 'message'> = {
    name: q.metadata.name,
    tier: tierOf(q),
    team: queueTeamOf(q),
    parent: str(q.spec?.parent),
    state: str(q.status?.state),
    capability,
    deserved: resOf(q.spec?.deserved),
    guarantee: resOf(q.spec?.guarantee?.resource),
    allocated,
    demand: { ...demand, other: [] },
    counts: { pending: q.status?.pending ?? 0, inqueue: q.status?.inqueue ?? 0, running: q.status?.running ?? 0, completed: q.status?.completed ?? 0 },
    gangs: mine,
    waiting: waiting.length,
    reclaimable: q.spec?.reclaimable,
    priority: q.spec?.priority,
    weight: q.spec?.weight,
    used: shareOf(allocated, capability),
  }
  return { ...base, ...levelOf(q, base) }
}

const tierRank = (t: Tier | undefined) => (t ? TIERS.indexOf(t) : TIERS.length)

/**
 * The team leaves, as rows: the queues under `root` (only leaves schedule). The
 * root itself, Volcano's own `default`, and any queue with no parent are never
 * rows — Volcano reads an empty `parent` as its own `root` (v1.16
 * `validate_queue.go`), so a tier-named queue someone created there is not a
 * team's leaf however it is named. Sorted by the name without its tier, then
 * dev → test → prod.
 */
export function queueRows(queues: readonly VolcanoQueue[], gangs: readonly GangRow[], root = ROOT_QUEUE): QueueRow[] {
  return queues
    .filter((q) => q.spec?.parent === root)
    .map((q) => queueRow(q, gangs))
    .sort((a, b) => {
      const stem = (r: QueueRow) => (r.tier ? r.name.slice(0, -(r.tier.length + 1)) : r.name)
      return stem(a).localeCompare(stem(b)) || tierRank(a.tier) - tierRank(b.tier)
    })
}

/** The root, when the caller may read it: the batch ceiling everything shares. */
export function rootOf(queues: readonly VolcanoQueue[], root = ROOT_QUEUE): { capability: Res; allocated: Res; used?: number } | undefined {
  const q = queues.find((x) => x.metadata.name === root)
  if (!q) return undefined
  const capability = resOf(q.spec?.capability)
  const allocated = resOf(q.status?.allocated)
  return { capability, allocated, used: shareOf(allocated, capability) }
}

/* ─────────────────────────── the scheduler descriptor (D7) ─────────────────────────── */

export interface SchedulerDescriptor {
  /** `present`: read it; `absent`: it does not exist, so batch runs on the native path; `unknown`: the caller may not read it. */
  state: 'present' | 'absent' | 'unknown'
  scheduler?: string
  version?: string
  gang?: boolean
  rootQueue?: string
  /** Each team's prod leaf `deserved` (D7), rendered at seed time from the cluster's size (DEC-3). */
  prodDeservedCPU?: string
  prodDeservedMemory?: string
}

export function descriptorOf(cm: { data?: Record<string, string> } | null | undefined, refused = false): SchedulerDescriptor {
  if (refused) return { state: 'unknown' }
  if (!cm) return { state: 'absent' }
  const d = cm.data ?? {}
  return {
    state: 'present',
    scheduler: str(d.scheduler),
    version: str(d.version),
    gang: d.gang === undefined ? undefined : d.gang === 'true',
    rootQueue: str(d.rootQueue),
    prodDeservedCPU: str(d.prodDeservedCPU),
    prodDeservedMemory: str(d.prodDeservedMemory),
  }
}

/** Volcano is served but batch does not use it: the descriptor is gone, or names another scheduler. */
export function nativePathNote(d: SchedulerDescriptor): string | undefined {
  if (d.state === 'absent') return 'The platform’s batch scheduler descriptor is not present, so BatchJobs run on the native Kubernetes path and no run waits in these queues.'
  if (d.state === 'present' && d.scheduler && d.scheduler !== 'volcano') return `The platform resolves batch to the ${d.scheduler} scheduler, so no run waits in these queues.`
  return undefined
}

/* ─────────────────────────── page state ─────────────────────────── */

export type QueuesState = 'loading' | 'forbidden' | 'empty' | 'error' | 'ready'

export function queuesStateOf(q: { isLoading: boolean; isError: boolean; data?: { items: readonly unknown[]; denied: readonly string[] } }, rows: number): QueuesState {
  if (q.isLoading && !q.data) return 'loading'
  if (q.isError && !q.data) return 'error'
  if (!q.data) return 'loading'
  if (rows > 0) return 'ready'
  if (q.data.denied.length && !q.data.items.length) return 'forbidden'
  return 'empty'
}
