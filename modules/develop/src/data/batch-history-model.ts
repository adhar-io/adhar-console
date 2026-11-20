import { tryParseYaml } from '@adhar/utils'
import { nextRuns } from './perf-cron.ts'
import { MAX_RESTARTS } from './batch-naming.ts'
import {
  ANNOTATION,
  type BatchJobXR,
  batchRef,
  type ConfigMapLike,
  dateInZone,
  ENV,
  heldOf,
  knownTimeZone,
  LABEL,
  nextRestartName,
  type ParamField,
  QUEUED_BY_BACKFILL,
  resolveParams,
  runEnv,
  runKindOf,
  runName,
  type RunObject,
  type RunPhase,
  type RunRow,
  type RunTemplate,
  scheduleOf,
} from './batch-model.ts'

/**
 * Develop → Batch, Phase 3, the pure half (design 0025 §7.2 History and
 * Tonight, §8.1, D5, D12): what the `adhar.batch` events, the calendars and the
 * schedules MEAN. No fetching and no React, so every rule is unit-tested
 * (`batch-history-model_test.ts`).
 *
 * Three things here are the CLI's rules, restated so the two clients agree
 * (cmd/batch in the platform repo): how an ops Job is named, which executions
 * count as holding dead letters, and how a backfill plans, queues and releases
 * its runs. The forecast's percentile and deadline are the batch observer's
 * (platform/controllers/batch/schedule.go), so the page and the
 * `deadline.endangered` event predict the same end.
 */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const toMs = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

const TOO_MANY_RESTARTS = `has reached ${MAX_RESTARTS} restarts. Investigate the failure before going further.`

/** Where a run sits in the restart chain of `base`: 0 for base itself, n for `-r<n>`, nothing for another run. */
function restartIndex(base: string, name: string): number | undefined {
  if (name === base) return 0
  const tail = name.startsWith(`${base}-r`) ? name.slice(base.length + 2) : ''
  return /^[1-9][0-9]?$/.test(tail) ? Number(tail) : undefined
}

/** The restart chain of `base` among `rows`, and its LATEST member: a base that failed and was restarted is described by its restart. */
function chainOf<T extends { name: string }>(base: string, rows: readonly T[]): { names: string[]; latest?: T } {
  let latest: T | undefined
  let at = -1
  const names: string[] = []
  for (const r of rows) {
    const n = restartIndex(base, r.name)
    if (n === undefined) continue
    names.push(r.name)
    if (n > at) [at, latest] = [n, r]
  }
  return { names, latest }
}

/* ─────────────────────────── adhar.batch events (platform/events/CONTRACT.md) ─────────────────────────── */

export const BATCH_TYPE_PREFIX = 'io.adhar.batch.'

/** One CloudEvent from `/api/batch/history`. Every `data` field is optional for a consumer. */
export interface BatchEvent {
  id?: string
  type: string
  /** `<namespace>/<batchjob>`. */
  subject: string
  time?: string
  data?: Record<string, unknown>
  /** Read from the run-summary archive (design 0025 Phase 4), not the stream: a finished run past the stream's retention. */
  archived?: boolean
}

/**
 * The run-summary archive's part in a read. `read`: consulted (`events` of them were returned). `skipped`: not
 * consulted — it is read for one job at a time. `absent`: this cluster archives nothing. `unreachable`: it could
 * not be read.
 */
export interface ArchiveState {
  state: 'read' | 'skipped' | 'absent' | 'unreachable'
  detail?: string
  events?: number
}

export type HistoryRead =
  /**
   * `truncated`: the oldest events were dropped (the stream is over the cap). `behind`: the read ended early, so the NEWEST are missing.
   * `stream`: set when the stream could not be read and the events are the archive's alone (finished runs only).
   */
  | {
    state: 'read'
    events: BatchEvent[]
    total: number
    truncated: boolean
    behind: boolean
    degraded: boolean
    archive?: ArchiveState
    stream?: { reason: string; detail: string }
  }
  /** The stream could not be read: no bus on this cluster, or a bridge that did not answer. */
  | { state: 'unavailable'; reason: string; detail: string }

/** The BFF's answer, checked: a body this page cannot read is unavailable, never an empty history. */
export function parseHistory(body: unknown): HistoryRead {
  const o = obj(body)
  if (o?.state === 'unavailable') {
    return { state: 'unavailable', reason: str(o.reason) ?? 'unreachable', detail: str(o.detail) ?? 'The event stream could not be read.' }
  }
  if (o?.state !== 'read' || !Array.isArray(o.events)) {
    return { state: 'unavailable', reason: 'unreadable', detail: 'The console answered with something that is not a batch history.' }
  }
  const events = o.events.filter((e): e is BatchEvent => typeof obj(e)?.type === 'string' && typeof obj(e)?.subject === 'string')
  const archive = obj(o.archive)
  const archiveState = str(archive?.state)
  const stream = obj(o.stream)
  return {
    state: 'read',
    events,
    total: num(o.total) ?? events.length,
    truncated: o.truncated === true,
    behind: o.behind === true,
    degraded: o.degraded === true,
    ...(archiveState === 'read' || archiveState === 'skipped' || archiveState === 'absent' || archiveState === 'unreachable'
      ? { archive: { state: archiveState, ...(str(archive?.detail) ? { detail: str(archive?.detail) } : {}), ...(num(archive?.events) !== undefined ? { events: num(archive?.events) } : {}) } }
      : {}),
    ...(stream ? { stream: { reason: str(stream.reason) ?? 'unreachable', detail: str(stream.detail) ?? 'The event stream could not be read.' } } : {}),
  }
}

export type Tone = 'healthy' | 'paused' | 'progressing' | 'failed' | 'unknown' | 'info'

/** Each event type, as a person reads it. A type this page does not know keeps its own name. */
export const EVENT_LABEL: Record<string, { label: string; tone: Tone }> = {
  'run.requested': { label: 'Requested', tone: 'info' },
  'run.started': { label: 'Started', tone: 'progressing' },
  'run.succeeded': { label: 'Succeeded', tone: 'healthy' },
  'run.failed': { label: 'Failed', tone: 'failed' },
  'run.stopped': { label: 'Stopped', tone: 'paused' },
  'run.resumed': { label: 'Resumed', tone: 'progressing' },
  'run.skipped': { label: 'Skipped', tone: 'unknown' },
  'run.lost': { label: 'Attempt lost', tone: 'failed' },
  'schedule.held': { label: 'Held', tone: 'paused' },
  'schedule.released': { label: 'Released', tone: 'info' },
  'schedule.missed': { label: 'Slot missed', tone: 'failed' },
  'deadline.endangered': { label: 'Deadline at risk', tone: 'paused' },
  'deadline.missed': { label: 'Deadline missed', tone: 'failed' },
}

export interface HistoryRow {
  key: string
  namespace: string
  job: string
  /** The type without its prefix: `run.failed`. */
  event: string
  label: string
  tone: Tone
  time?: string
  at?: number
  run?: string
  businessDate?: string
  trigger?: string
  actor?: string
  executionId?: number
  durationMs?: number
  exitCode?: number
  deadLettered?: number
  detail: string
  /** Read from the run-summary archive, not the stream. */
  archived: boolean
}

const seconds = (s: number) => {
  const t = Math.round(s)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${t % 60}s` : `${t}s`
}

/** The phrase worth a column: the outcome first, then what the event type is about (as `adhar batch history`). */
export function eventDetail(data: Record<string, unknown> | undefined): string {
  const d = data ?? {}
  const outcome = obj(d.outcome)
  const run = obj(d.run)
  const counts = obj(d.counts)
  const schedule = obj(d.schedule)
  const deadline = obj(d.deadline)
  const dependency = obj(d.dependency)
  const parts: string[] = []
  if (str(outcome?.reason)) parts.push(outcome!.reason as string)
  if (num(outcome?.exitCode) !== undefined) parts.push(`exit ${outcome!.exitCode}`)
  if (num(counts?.read) !== undefined) parts.push(`read ${counts!.read} written ${num(counts?.written) ?? 0}`)
  if ((num(counts?.deadLettered) ?? 0) > 0) parts.push(`${counts!.deadLettered} dead-lettered`)
  if (str(d.pod)) parts.push(`pod ${d.pod}`)
  if (str(schedule?.holdReason)) parts.push(`held: ${schedule!.holdReason}`)
  if (str(schedule?.slot)) parts.push(`slot ${schedule!.slot}`)
  if (str(deadline?.deadline)) {
    parts.push(`deadline ${deadline!.deadline}`)
    if (str(deadline?.expectedEnd)) parts.push(`expected ${deadline!.expectedEnd}`)
  }
  const after = Array.isArray(dependency?.after) ? dependency!.after.filter((a): a is string => typeof a === 'string') : []
  if (after.length) parts.push(`after ${after.join(', ')}`)
  if (str(run?.queue)) parts.push(`queue ${run!.queue}`)
  if (str(outcome?.message)) parts.push(outcome!.message as string)
  return parts.join(' · ')
}

function historyRow(e: BatchEvent, i: number): HistoryRow | undefined {
  const slash = e.subject.indexOf('/')
  if (slash <= 0 || slash === e.subject.length - 1) return undefined
  const event = e.type.startsWith(BATCH_TYPE_PREFIX) ? e.type.slice(BATCH_TYPE_PREFIX.length) : e.type
  const known = EVENT_LABEL[event]
  const d = e.data ?? {}
  const run = obj(d.run)
  const spring = obj(d.springBatch)
  const duration = num(d.durationSeconds)
  return {
    key: e.id ?? `${e.subject}|${e.type}|${e.time ?? ''}|${i}`,
    namespace: e.subject.slice(0, slash),
    job: e.subject.slice(slash + 1),
    event,
    label: known?.label ?? event,
    tone: known?.tone ?? 'unknown',
    time: e.time,
    at: toMs(e.time),
    run: str(run?.name),
    businessDate: str(spring?.businessDate) ?? str(obj(d.dependency)?.businessDate),
    trigger: str(run?.trigger),
    actor: str(run?.actor),
    executionId: num(spring?.executionId),
    durationMs: duration !== undefined ? duration * 1_000 : undefined,
    exitCode: num(obj(d.outcome)?.exitCode),
    deadLettered: num(obj(d.counts)?.deadLettered),
    detail: eventDetail(d),
    archived: e.archived === true,
  }
}

/** Newest first. An event whose time cannot be read sorts last and is still shown. */
export function historyRows(events: readonly BatchEvent[]): HistoryRow[] {
  return events
    .map(historyRow)
    .filter((r): r is HistoryRow => r !== undefined)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.at ?? -Infinity) - (a.r.at ?? -Infinity) || b.i - a.i)
    .map((x) => x.r)
}

export function historySearchText(r: HistoryRow): string[] {
  return [r.job, r.namespace, r.label, r.event, r.run ?? '', r.businessDate ?? '', r.actor ?? '', r.trigger ?? '', r.detail]
}

/** How long the duration text of a history row is, in the page's own words. */
export const durationWords = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : seconds(ms / 1_000))

/* ─────────────────────────── ops Jobs (§8.1, §8.3; cmd/batch/ops.go) ─────────────────────────── */

export const OPS_TRIGGER = 'ops'
export const OPS_DLQ_REPLAY = 'dlq-replay'
/** A Job name that still fits the label value the Job controller copies it into. */
const MAX_RUN_NAME = 63

/**
 * `<job>-ops-<verb>-<executionId>`. The verb and the id make the name, so when
 * it is too long the JOB prefix is cut, leaving room for the `-r99` of the last
 * retry: a cut id would name another execution.
 */
export function opsRunName(batchJob: string, verb: string, executionId: number): string {
  const suffix = `-ops-${verb}-${executionId}`
  const room = MAX_RUN_NAME - '-r99'.length - suffix.length
  const prefix = batchJob.length > room ? batchJob.slice(0, Math.max(0, room)).replace(/[-.]+$/, '') : batchJob
  return prefix + suffix
}

/** A run that carries a command rather than the business job. */
export function isOpsRun(run: Pick<RunObject, 'metadata' | 'spec'>): boolean {
  return run.metadata.labels?.[LABEL.trigger] === OPS_TRIGGER || Boolean(runEnv(run, ENV.command))
}

/* ─────────────────────────── the dead-letter queue (§8.1, A3.6; cmd/batch/dlq.go) ─────────────────────────── */

export interface DlqEntry {
  namespace: string
  job: string
  run: string
  businessDate?: string
  executionId?: number
  deadLettered: number
  ended?: string
  /** `run`: its summary, from a run the cluster holds. `event`: the observer's end event. */
  source: 'run' | 'event'
  /** The latest dlq-replay ops Job for this execution, when the cluster still holds one. */
  replay?: { run: string; phase: RunPhase }
}

const END_EVENTS = new Set(['run.succeeded', 'run.failed', 'run.skipped'].map((t) => BATCH_TYPE_PREFIX + t))

/**
 * Which executions dead-lettered items. The rejected items live in the job's
 * OWN database, which nothing on the platform reads, so the counts are what the
 * runs said about themselves: the termination summary for a run the cluster
 * holds, the observer's end event for one it no longer does. A run that is both
 * in the cluster and on the bus is counted once, and an ops Job is never
 * counted: it is not a business run.
 */
export function dlqEntries(runs: readonly RunRow[], events: readonly BatchEvent[]): DlqEntry[] {
  const out: DlqEntry[] = []
  const seenExec = new Set<string>()
  const seenRun = new Set<string>()
  const execKey = (ns: string, job: string, id: number) => `${ns}/${job}#${id}`
  for (const r of runs) {
    if (!r.batchJob || isOpsRun(r.raw)) continue
    const dead = r.summary?.deadLettered
    if (dead === undefined || dead <= 0) continue
    const id = r.summary?.executionId
    if (id !== undefined) seenExec.add(execKey(r.namespace, r.batchJob, id))
    seenRun.add(r.key)
    out.push({
      namespace: r.namespace,
      job: r.batchJob,
      run: r.name,
      businessDate: r.businessDate,
      executionId: id,
      deadLettered: dead,
      ended: r.finishedAt,
      source: 'run',
    })
  }
  for (const e of events) {
    if (!END_EVENTS.has(e.type)) continue
    const slash = e.subject.indexOf('/')
    if (slash <= 0) continue
    const namespace = e.subject.slice(0, slash)
    const job = e.subject.slice(slash + 1)
    const d = e.data ?? {}
    const dead = num(obj(d.counts)?.deadLettered)
    if (dead === undefined || dead <= 0) continue
    const run = obj(d.run)
    if (str(run?.trigger) === OPS_TRIGGER) continue
    const spring = obj(d.springBatch)
    const id = num(spring?.executionId)
    const name = str(run?.name) ?? ''
    if ((id !== undefined && seenExec.has(execKey(namespace, job, id))) || (name && seenRun.has(batchRef(namespace, name)))) continue
    if (id !== undefined) seenExec.add(execKey(namespace, job, id))
    if (name) seenRun.add(batchRef(namespace, name))
    out.push({
      namespace,
      job,
      run: name,
      businessDate: str(spring?.businessDate),
      executionId: id,
      deadLettered: dead,
      ended: str(d.end) ?? e.time,
      source: 'event',
    })
  }
  // Each execution's latest replay, from the ops Jobs the cluster holds.
  const latest = new Map<string, RunRow>()
  for (const r of runs) {
    if (!r.batchJob || runEnv(r.raw, ENV.command) !== OPS_DLQ_REPLAY) continue
    const key = `${r.namespace}/${r.batchJob}#${runEnv(r.raw, ENV.executionId) ?? ''}`
    const prev = latest.get(key)
    if (!prev || (r.created ?? '') > (prev.created ?? '')) latest.set(key, r)
  }
  for (const e of out) {
    if (e.executionId === undefined) continue
    const r = latest.get(execKey(e.namespace, e.job, e.executionId))
    if (r) e.replay = { run: r.name, phase: r.phase }
  }
  return out.sort((a, b) => (b.ended ?? '').localeCompare(a.ended ?? ''))
}

export interface DlqJob {
  key: string
  namespace: string
  job: string
  total: number
  entries: DlqEntry[]
}

/** Counts per job, the largest first. */
export function dlqByJob(entries: readonly DlqEntry[]): DlqJob[] {
  const by = new Map<string, DlqJob>()
  for (const e of entries) {
    const key = batchRef(e.namespace, e.job)
    const j = by.get(key) ?? { key, namespace: e.namespace, job: e.job, total: 0, entries: [] }
    j.total += e.deadLettered
    j.entries.push(e)
    by.set(key, j)
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
}

export type ReplayPlan =
  /** Start `<job>-ops-dlq-replay-<id>`, or after a failed one its next `-r<n>`. */
  | { action: 'create'; name: string; restartOf?: string }
  /** A replay of this execution exists and has not failed: show it, start nothing. */
  | { action: 'exists'; name: string; phase: RunPhase }
  | { action: 'refused'; reason: string }

/**
 * What replaying one execution does, given the runs that exist. Asking twice
 * shows the replay that is there; only a FAILED one is retried, as its next
 * `-r<n>` (the CLI's `--wait` rule). An entry with no execution id cannot be
 * replayed from here: the kit's command acts on an execution.
 */
export function replayPlan(
  entry: Pick<DlqEntry, 'job' | 'namespace' | 'executionId'>,
  runs: readonly Pick<RunRow, 'namespace' | 'name' | 'phase'>[],
): ReplayPlan {
  if (entry.executionId === undefined) {
    return {
      action: 'refused',
      reason: 'This run reported no execution id, so there is nothing to name the replay after. `adhar batch dlq --replay --execution <id>` takes one.',
    }
  }
  const base = opsRunName(entry.job, OPS_DLQ_REPLAY, entry.executionId)
  const { names, latest } = chainOf(base, runs.filter((r) => r.namespace === entry.namespace))
  if (!latest) return { action: 'create', name: base }
  if (latest.phase !== 'failed') return { action: 'exists', name: latest.name, phase: latest.phase }
  const next = nextRestartName(base, names)
  return next ? { action: 'create', name: next, restartOf: latest.name } : { action: 'refused', reason: `${base} ${TOO_MANY_RESTARTS}` }
}

/* ─────────────────────────── calendars (D5) ─────────────────────────── */

export const CALENDAR_LABEL = 'adhar.io/batch-calendar'
export const CALENDAR_SELECTOR = `${CALENDAR_LABEL}=true`
export const CALENDAR_KEY = 'calendar.yaml'
/** Where the platform's own calendars live; a job's namespace is looked in first. */
export const PLATFORM_CALENDAR_NAMESPACE = 'adhar-system'

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** A date that exists. `Date.parse` alone rolls 2026-02-30 over into March, and the runner reading the same file does not. */
const realDate = (d: string) => ISO_DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d

export interface Calendar {
  namespace: string
  /** The ConfigMap's name, which is what `schedule.calendar` names. */
  name: string
  timeZone?: string
  weekendDays: string[]
  holidays: string[]
  businessDays: string[]
  /** Why `calendar.yaml` cannot be read. A run mounting it exits 2. */
  error?: string
}

const dateList = (v: unknown, key: string): { dates: string[]; error?: string } => {
  if (v === undefined || v === null) return { dates: [] }
  if (!Array.isArray(v)) return { dates: [], error: `${key} is not a list.` }
  const dates = v.map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d)))
  const bad = dates.find((d) => !realDate(d))
  return bad ? { dates: [], error: `${key} has ${bad}, which is not a date (yyyy-mm-dd).` } : { dates: [...dates].sort() }
}

/** A calendar ConfigMap, read. One that cannot be read keeps its name and says why. */
export function parseCalendar(cm: ConfigMapLike): Calendar {
  const base = {
    namespace: cm.metadata?.namespace ?? '',
    name: cm.metadata?.name ?? '',
    weekendDays: ['SATURDAY', 'SUNDAY'],
    holidays: [] as string[],
    businessDays: [] as string[],
  }
  const text = cm.data?.[CALENDAR_KEY]
  if (!text || !text.trim()) return { ...base, error: `It has no ${CALENDAR_KEY}.` }
  const parsed = tryParseYaml(text)
  const doc = parsed.ok ? obj(parsed.value) : undefined
  if (!doc) return { ...base, error: `${CALENDAR_KEY} cannot be read${parsed.ok ? '' : `: ${parsed.error}`}.` }
  let weekendDays = base.weekendDays
  if (doc.weekendDays !== undefined && doc.weekendDays !== null) {
    if (!Array.isArray(doc.weekendDays)) return { ...base, error: 'weekendDays is not a list.' }
    weekendDays = doc.weekendDays.map((d) => String(d).toUpperCase())
    const bad = weekendDays.find((d) => !(WEEKDAYS as readonly string[]).includes(d))
    if (bad) return { ...base, error: `weekendDays has ${bad}, which is not a day of the week.` }
  }
  const holidays = dateList(doc.holidays, 'holidays')
  const businessDays = dateList(doc.businessDays, 'businessDays')
  const error = holidays.error ?? businessDays.error
  return {
    ...base,
    ...(str(doc.timeZone) ? { timeZone: str(doc.timeZone) } : {}),
    weekendDays,
    holidays: holidays.dates,
    businessDays: businessDays.dates,
    ...(error ? { error } : {}),
  }
}

/**
 * D5's rule: a date is a business day when it is listed in `businessDays`, or
 * is neither a `weekendDays` day nor listed in `holidays`.
 */
export function isBusinessDay(cal: Pick<Calendar, 'weekendDays' | 'holidays' | 'businessDays'>, date: string): boolean {
  if (cal.businessDays.includes(date)) return true
  if (cal.holidays.includes(date)) return false
  return !cal.weekendDays.includes(WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()])
}

/** The calendar a job's `schedule.calendar` resolves to: its own namespace first, then the platform's. */
export function calendarOf(job: BatchJobXR, calendars: readonly Calendar[]): { name: string; calendar?: Calendar } | undefined {
  const name = job.spec?.parameters?.schedule?.calendar
  if (!name) return undefined
  const ns = job.metadata.namespace ?? ''
  return {
    name,
    calendar: calendars.find((c) => c.name === name && c.namespace === ns) ??
      calendars.find((c) => c.name === name && c.namespace === PLATFORM_CALENDAR_NAMESPACE),
  }
}

export interface CalendarRow {
  key: string
  calendar: Calendar
  /** `platform` for one in adhar-system, `team` for one a team authored beside its jobs. */
  scope: 'platform' | 'team'
  /** The jobs that follow it (`<namespace>/<name>`). */
  usedBy: string[]
  /** The next dates it changes: holidays and working weekend days, from today on. */
  upcoming: Array<{ date: string; kind: 'holiday' | 'business day' }>
  /** A team calendar of the same name hides a platform one for that namespace's jobs. */
  shadows?: boolean
}

export function calendarRows(calendars: readonly Calendar[], jobs: readonly BatchJobXR[], today: string): CalendarRow[] {
  return calendars
    .map((calendar): CalendarRow => {
      const scope = calendar.namespace === PLATFORM_CALENDAR_NAMESPACE ? 'platform' : 'team'
      const upcoming = [
        ...calendar.holidays.map((date) => ({ date, kind: 'holiday' as const })),
        ...calendar.businessDays.map((date) => ({ date, kind: 'business day' as const })),
      ].filter((d) => d.date >= today).sort((a, b) => a.date.localeCompare(b.date))
      return {
        key: batchRef(calendar.namespace, calendar.name),
        calendar,
        scope,
        usedBy: jobs.filter((j) => calendarOf(j, calendars)?.calendar === calendar).map((j) => batchRef(j.metadata.namespace ?? '', j.metadata.name)).sort(),
        upcoming,
        ...(scope === 'team' && calendars.some((c) => c.name === calendar.name && c.namespace === PLATFORM_CALENDAR_NAMESPACE) ? { shadows: true } : {}),
      }
    })
    .sort((a, b) => (a.scope === b.scope ? a.key.localeCompare(b.key) : a.scope === 'platform' ? -1 : 1))
}

/* ─────────────────────────── the forecast (§7.2 Tonight, §11.4) ─────────────────────────── */

/** How many of the newest durations the percentile reads: the observer's window. */
export const P90_WINDOW = 20

/** The nearest-rank 90th percentile, as the batch observer computes it. `undefined` with no history. */
export function p90Of(durations: readonly number[]): number | undefined {
  if (!durations.length) return undefined
  const sorted = [...durations].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)]
}

/**
 * The durations of a job's last successes, newest first: the runs the cluster
 * holds, then the `run.succeeded` events for the ones it no longer does. A run
 * that is in both is counted once.
 */
export function successDurations(namespace: string, job: string, runs: readonly RunRow[], events: readonly BatchEvent[]): number[] {
  const seen = new Set<string>()
  const all: Array<{ at: number; ms: number }> = []
  for (const r of runs) {
    if (r.namespace !== namespace || r.batchJob !== job || r.phase !== 'succeeded' || r.durationMs === undefined || isOpsRun(r.raw)) continue
    seen.add(r.name)
    all.push({ at: toMs(r.finishedAt) ?? 0, ms: r.durationMs })
  }
  for (const e of events) {
    if (e.type !== `${BATCH_TYPE_PREFIX}run.succeeded` || e.subject !== batchRef(namespace, job)) continue
    const run = obj(e.data?.run)
    const s = num(e.data?.durationSeconds)
    const name = str(run?.name)
    if (s === undefined || (name && seen.has(name)) || str(run?.trigger) === OPS_TRIGGER) continue
    if (name) seen.add(name)
    all.push({ at: toMs(e.time) ?? 0, ms: s * 1_000 })
  }
  return all.sort((a, b) => b.at - a.at).slice(0, P90_WINDOW).map((d) => d.ms)
}

/**
 * The first instant at or after `anchor` whose wall clock in `timeZone` reads
 * `finishBy` (HH:MM): the observer's `deadlineAfter`. Stepped through the zone's
 * own clock, so a daylight-saving change moves the deadline with it.
 */
export function deadlineAfter(anchorMs: number, finishBy: string | undefined, timeZone?: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(finishBy ?? '')
  if (!m || !knownTimeZone(timeZone)) return undefined
  return nextRuns(`${Number(m[2])} ${Number(m[1])} * * *`, anchorMs - 1, 1, timeZone)[0]
}

export const TONIGHT_WINDOW_MS = 24 * 3_600_000
/** The fires of one job that get a row each; a job firing more often says how many more. */
const MAX_FIRES = 4

export type CalendarVerdict =
  /** No calendar: every date runs. */
  | { state: 'none' }
  | { state: 'business-day'; calendar: string }
  /** The run will start and exit 0 as skipped, reason `calendar`. */
  | { state: 'skipped'; calendar: string; why: 'holiday' | 'weekend' }
  /** The job names a calendar this page cannot read: it does not guess. */
  | { state: 'unknown'; calendar: string; why: string }

export interface TonightRow {
  key: string
  namespace: string
  job: string
  displayName: string
  application?: string
  environment?: string
  startMs: number
  timeZone: string
  businessDate?: string
  calendar: CalendarVerdict
  /** p90 of the last successes; absent with no history. */
  p90Ms?: number
  expectedEndMs?: number
  finishBy?: string
  deadlineMs?: number
  /** The deadline less the expected end; negative is a forecast miss. */
  slackMs?: number
  sla: 'none' | 'ok' | 'at-risk' | 'unknown'
  /** Further fires of this job inside the window, not listed. */
  more: number
  /** The jobs the observer starts once this one succeeds. */
  then: string[]
}

function verdictOf(job: BatchJobXR, calendars: readonly Calendar[], businessDate: string | undefined, unread: readonly string[] = []): CalendarVerdict {
  const named = calendarOf(job, calendars)
  if (!named) return { state: 'none' }
  if (!named.calendar) {
    // Not found is a claim about every place it could be: one this person may not list is not "absent".
    const hidden = [job.metadata.namespace ?? '', PLATFORM_CALENDAR_NAMESPACE].filter((ns) => unread.includes(ns))
    return {
      state: 'unknown',
      calendar: named.name,
      why: hidden.length ? `you may not read the calendars of ${hidden.join(' or ')}` : 'not found in this namespace or among the platform’s calendars',
    }
  }
  if (named.calendar.error) return { state: 'unknown', calendar: named.name, why: named.calendar.error }
  if (!businessDate) return { state: 'unknown', calendar: named.name, why: 'the business date could not be worked out' }
  if (isBusinessDay(named.calendar, businessDate)) return { state: 'business-day', calendar: named.name }
  return { state: 'skipped', calendar: named.name, why: named.calendar.holidays.includes(businessDate) ? 'holiday' : 'weekend' }
}

/**
 * Every fire of `cron` after `from` and up to `until`. Asked for one at a time:
 * asking for a day's worth at once would walk a nightly schedule four years out
 * to find 1,440 fires, on every job, each time the page's clock ticks.
 */
function firesUntil(cron: string, from: number, until: number, timeZone?: string): number[] {
  const out: number[] = []
  // One fire a minute for the whole window is the most a cron can ask for.
  for (let t = from; out.length < 24 * 60;) {
    const [next] = nextRuns(cron, t, 1, timeZone)
    if (next === undefined || next > until) break
    out.push(next)
    t = next
  }
  return out
}

/**
 * What runs in the next 24 hours, with the calendar applied: every fire of
 * every schedule that is not held or suspended, its expected end (start + p90)
 * and whether that end is inside `sla.finishBy`.
 */
export function tonightRows(
  jobs: readonly BatchJobXR[],
  ctx: {
    now: number
    runs?: readonly RunRow[]
    events?: readonly BatchEvent[]
    calendars?: readonly Calendar[]
    /** Namespaces whose calendars this person may not list. */
    unreadCalendars?: readonly string[]
    envByNamespace?: ReadonlyMap<string, string>
    windowMs?: number
  },
): TonightRow[] {
  const until = ctx.now + (ctx.windowMs ?? TONIGHT_WINDOW_MS)
  const dependents = dependentsOf(jobs)
  const out: TonightRow[] = []
  for (const job of jobs) {
    const sch = scheduleOf(job)
    // A zone this runtime cannot read is no row here; `unforecastJobs` names the job instead.
    if (!sch.cron || sch.suspended || heldOf(job) || !knownTimeZone(sch.timeZone)) continue
    const namespace = job.metadata.namespace ?? ''
    const name = job.metadata.name
    const p = job.spec?.parameters
    const fires = firesUntil(sch.cron, ctx.now, until, sch.timeZone)
    const p90Ms = p90Of(successDurations(namespace, name, ctx.runs ?? [], ctx.events ?? []))
    const slaZone = p?.sla?.timeZone || sch.timeZone
    fires.slice(0, MAX_FIRES).forEach((startMs, i, shown) => {
      const businessDate = dateInZone(startMs, sch.timeZone)
      const calendar = verdictOf(job, ctx.calendars ?? [], businessDate, ctx.unreadCalendars)
      const expectedEndMs = p90Ms !== undefined ? startMs + p90Ms : undefined
      const deadlineMs = deadlineAfter(startMs, p?.sla?.finishBy, slaZone)
      const slackMs = deadlineMs !== undefined && expectedEndMs !== undefined ? deadlineMs - expectedEndMs : undefined
      out.push({
        key: `${batchRef(namespace, name)}@${startMs}`,
        namespace,
        job: name,
        displayName: p?.displayName || name,
        application: job.metadata.labels?.[LABEL.application] ?? p?.application,
        environment: job.metadata.labels?.[LABEL.environment] ?? ctx.envByNamespace?.get(namespace) ?? p?.environment,
        startMs,
        timeZone: sch.timeZone,
        businessDate,
        calendar,
        p90Ms,
        expectedEndMs,
        finishBy: p?.sla?.finishBy,
        deadlineMs,
        slackMs,
        // A skipped date has no work due, so no deadline to miss.
        sla: deadlineMs === undefined || calendar.state === 'skipped' ? 'none' : slackMs === undefined ? 'unknown' : slackMs < 0 ? 'at-risk' : 'ok',
        more: i === shown.length - 1 ? fires.length - shown.length : 0,
        then: dependents.get(batchRef(namespace, name)) ?? [],
      })
    })
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.key.localeCompare(b.key))
}

export interface Unforecast {
  key: string
  /** `schedule`: its fires cannot be placed, so it has no row. `sla`: its rows carry no deadline. */
  what: 'schedule' | 'sla'
  timeZone: string
}

/**
 * The scheduled jobs the forecast cannot place or bound, because a time zone
 * they name is not one this runtime knows. The XRD takes any string, and the
 * forecast must say which jobs it left out: a job missing from "what runs
 * tonight" otherwise reads as one that does not run.
 */
export function unforecastJobs(jobs: readonly BatchJobXR[]): Unforecast[] {
  const out: Unforecast[] = []
  for (const job of jobs) {
    const sch = scheduleOf(job)
    if (!sch.cron || sch.suspended || heldOf(job)) continue
    const key = batchRef(job.metadata.namespace ?? '', job.metadata.name)
    const sla = job.spec?.parameters?.sla
    if (!knownTimeZone(sch.timeZone)) out.push({ key, what: 'schedule', timeZone: sch.timeZone })
    else if (sla?.finishBy && sla.timeZone && !knownTimeZone(sla.timeZone)) out.push({ key, what: 'sla', timeZone: sla.timeZone })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/* ─────────────────────────── dependency chains (`dependsOn`, §12) ─────────────────────────── */

/** For each job (`<namespace>/<name>`), the jobs that name it in `dependsOn`. */
export function dependentsOf(jobs: readonly BatchJobXR[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const j of jobs) {
    const ns = j.metadata.namespace ?? ''
    for (const d of j.spec?.parameters?.dependsOn ?? []) {
      if (!d.batchJob) continue
      const up = batchRef(d.namespace || ns, d.batchJob)
      out.set(up, [...(out.get(up) ?? []), batchRef(ns, j.metadata.name)].sort())
    }
  }
  return out
}

export interface ChainLink {
  key: string
  /** The same business date must have succeeded (the default); else only its latest run. */
  sameBusinessDate: boolean
  /** A BatchJob this page can see. One it cannot is not judged. */
  known: boolean
  lastPhase?: RunPhase
  lastSuccessDate?: string
}

export interface Chain {
  key: string
  namespace: string
  job: string
  after: ChainLink[]
  /** The newest run the observer started for a dependency. */
  lastDependencyRun?: { name: string; phase: RunPhase; businessDate?: string }
  /** `waiting`: an upstream has not succeeded. `unknown`: an upstream is out of sight. */
  state: 'ready' | 'waiting' | 'unknown'
}

/** Each job that waits for others, with what is known about the ones it waits for. */
export function dependencyChains(jobs: readonly BatchJobXR[], runs: readonly RunRow[]): Chain[] {
  const known = new Set(jobs.map((j) => batchRef(j.metadata.namespace ?? '', j.metadata.name)))
  const business = (ns: string, job: string) => runs.filter((r) => r.namespace === ns && r.batchJob === job && !isOpsRun(r.raw))
  const out: Chain[] = []
  for (const j of jobs) {
    const deps = (j.spec?.parameters?.dependsOn ?? []).filter((d) => d.batchJob)
    if (!deps.length) continue
    const namespace = j.metadata.namespace ?? ''
    const after = deps.map((d): ChainLink => {
      const ns = d.namespace || namespace
      const mine = business(ns, d.batchJob as string)
      return {
        key: batchRef(ns, d.batchJob as string),
        sameBusinessDate: d.sameBusinessDate !== false,
        known: known.has(batchRef(ns, d.batchJob as string)),
        lastPhase: mine[0]?.phase,
        lastSuccessDate: mine.find((r) => r.phase === 'succeeded')?.businessDate,
      }
    })
    const started = business(namespace, j.metadata.name).find((r) => r.trigger === 'dependency')
    out.push({
      key: batchRef(namespace, j.metadata.name),
      namespace,
      job: j.metadata.name,
      after,
      ...(started ? { lastDependencyRun: { name: started.name, phase: started.phase, businessDate: started.businessDate } } : {}),
      state: after.some((l) => !l.known)
        ? 'unknown'
        : after.every((l) => (l.sameBusinessDate ? l.lastSuccessDate !== undefined : l.lastPhase === 'succeeded'))
        ? 'ready'
        : 'waiting',
    })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/* ─────────────────────────── backfill (§8.1, A3.3; cmd/batch/backfill.go) ─────────────────────────── */

/** One backfill is bounded: a mistyped year would otherwise create thousands of Jobs. */
export const MAX_BACKFILL_DATES = 366

/** Every date from `from` to `to`, inclusive, in order. */
export function backfillDates(from: string, to: string): { dates: string[]; error?: undefined } | { error: string } {
  if (!realDate(from)) return { error: 'The first date is not a date, yyyy-mm-dd.' }
  if (!realDate(to)) return { error: 'The last date is not a date, yyyy-mm-dd.' }
  if (to < from) return { error: `${to} is before ${from}.` }
  const dates: string[] = []
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    if (dates.length === MAX_BACKFILL_DATES) return { error: `${from} to ${to} is more than ${MAX_BACKFILL_DATES} dates. Backfill it in parts.` }
    dates.push(new Date(t).toISOString().slice(0, 10))
  }
  return { dates }
}

/**
 * The parameter a business date goes into: the one named `businessDate`, else
 * the first date parameter the schedule supplies. The batch observer's rule for
 * a dependency run, so a backfill and a dependency run of one date are one identity.
 */
export function businessDateField(fields: readonly ParamField[]): ParamField | undefined {
  return fields.find((f) => f.name === 'businessDate') ?? fields.find((f) => f.type === 'date' && f.source === 'schedule')
}

export type BackfillState =
  /** Ended: succeeded or failed (or going). */
  | 'done'
  /** Created suspended and never started: the backfill's to release. */
  | 'queued'
  /** Released and not ended, or still stopping. */
  | 'in-flight'
  /** A person suspended it after it started: left alone. */
  | 'stopped'

/**
 * Phase alone cannot classify a backfill's run: a Job created suspended reads
 * as stopped exactly as one a person stopped does. Anything not provably queued,
 * stopped or ended counts as in flight, so `parallel` is never exceeded.
 *
 * Queued is the one state a backfill acts on (it resumes the run), so it needs
 * the backfill's own mark AND no sign the run ever started. The status alone
 * does not say: since Kubernetes 1.36 the Job controller clears
 * `status.startTime` on every suspend, so a run a person stopped before a pod
 * failed has the status of one that never started. A suspended run without the
 * mark is a person's, and is left alone (cmd/batch/backfill.go, the same rule).
 */
export function backfillState(r: Pick<RunRow, 'phase' | 'kind' | 'raw'>): BackfillState {
  if (r.phase === 'succeeded' || r.phase === 'failed' || r.phase === 'deleting') return 'done'
  const s = r.raw.status
  if (r.raw.spec?.suspend !== true) return r.phase === 'stopped' && r.kind === 'VolcanoJob' ? 'stopped' : 'in-flight'
  if ((s?.active ?? 0) > 0 || (s?.terminating ?? 0) > 0) return 'in-flight'
  if (r.raw.metadata.annotations?.[ANNOTATION.queued] !== QUEUED_BY_BACKFILL) return 'stopped'
  return !s?.startTime && (s?.failed ?? 0) === 0 && (s?.succeeded ?? 0) === 0 ? 'queued' : 'stopped'
}

export interface BackfillItem {
  businessDate: string
  /** The run this date is: the one to create, or the one that exists. */
  run: string
  /** `create` and `restart` are what this backfill will do; the rest is what it found. */
  action: 'create' | 'restart' | 'exists' | 'completed' | 'stopped'
  params: Record<string, string>
  restartOf?: string
}

export type BackfillPlan = { items: BackfillItem[]; volcano: boolean; field: string; error?: undefined } | { error: string }

/**
 * Every date resolved and named BEFORE anything is created, against the runs
 * that exist: a date that completed is left alone, one in flight or queued is
 * found, and one that failed is restarted as the next `-r<n>`. One refused date
 * refuses the backfill, so nothing is half created.
 */
export function backfillPlan(
  target: { namespace: string; job: string },
  template: RunTemplate,
  dates: readonly string[],
  extra: Readonly<Record<string, string>>,
  runs: readonly RunRow[],
): BackfillPlan {
  const { namespace, job } = target
  if (template.paramsError) return { error: `The run template’s parameters cannot be read: ${template.paramsError}` }
  const field = businessDateField(template.fields)
  if (!field) {
    return { error: `${job} declares no business-date parameter (businessDate, or a date its schedule supplies), so there is nothing to backfill by.` }
  }
  if (field.name in extra) return { error: `${field.name} is the business date: the first and last date give it.` }
  const mine = runs.filter((r) => r.namespace === namespace && r.batchJob === job)
  const items: BackfillItem[] = []
  const refused: string[] = []
  for (const date of dates) {
    const resolved = resolveParams(template.fields, { ...extra, [field.name]: date })
    const problems = Object.entries(resolved.errors)
    if (problems.length) {
      refused.push(`${date}: ${problems.map(([k, v]) => `${k}: ${v}`).join(' ')}`)
      continue
    }
    const base = runName(job, resolved.identifying)
    const { names, latest } = chainOf(base, mine)
    if (!latest) {
      items.push({ businessDate: date, run: base, action: 'create', params: resolved.params })
    } else if (latest.phase === 'succeeded') {
      items.push({ businessDate: date, run: latest.name, action: 'completed', params: resolved.params })
    } else if (latest.phase === 'failed') {
      const next = nextRestartName(base, names)
      if (!next) return { error: `${base} ${TOO_MANY_RESTARTS}` }
      items.push({ businessDate: date, run: next, action: 'restart', params: resolved.params, restartOf: latest.name })
    } else {
      items.push({ businessDate: date, run: latest.name, action: backfillState(latest) === 'stopped' ? 'stopped' : 'exists', params: resolved.params })
    }
  }
  if (refused.length) {
    return { error: `Parameters refused. ${refused.slice(0, 3).join(' | ')}${refused.length > 3 ? ` (and ${refused.length - 3} more dates)` : ''}` }
  }
  return { items, volcano: runKindOf(template.manifest) === 'VolcanoJob', field: field.name }
}

export interface BackfillProgress {
  /** The queued runs to release now, in date order. */
  release: RunRow[]
  inFlight: number
  queued: number
  done: number
  stopped: number
  /** No longer in the cluster: deleted, or cleaned up by its TTL after it ended. */
  gone: number
  /** Nothing left for this page to release. */
  settled: boolean
}

/**
 * The release step: queued runs in date order while fewer than `parallel` are
 * in flight. On Volcano nothing is released from here: every run was created at
 * once and the job's queue decides how many start. `released` names the runs
 * this page already released, so a list that has not caught up yet cannot make
 * it release a second batch.
 */
export function backfillProgress(
  runNames: readonly string[],
  runs: readonly RunRow[],
  parallel: number,
  volcano: boolean,
  released: ReadonlySet<string> = new Set(),
): BackfillProgress {
  const by = new Map(runs.map((r) => [r.name, r]))
  const out: BackfillProgress = { release: [], inFlight: 0, queued: 0, done: 0, stopped: 0, gone: 0, settled: false }
  const waiting: RunRow[] = []
  for (const name of runNames) {
    const r = by.get(name)
    if (!r) {
      out.gone++
      continue
    }
    // A run this page just released may still read as queued until the next list: it is in flight.
    const state = backfillState(r) === 'queued' && released.has(name) ? 'in-flight' : backfillState(r)
    if (state === 'in-flight') out.inFlight++
    else if (state === 'queued') waiting.push(r)
    else if (state === 'done') out.done++
    else out.stopped++
  }
  if (!volcano) out.release = waiting.slice(0, Math.max(0, Math.max(1, parallel) - out.inFlight))
  out.queued = waiting.length
  out.settled = waiting.length === 0
  return out
}

/**
 * The release loop's own state, kept between renders of the dialog. A run is in
 * `released` from the moment its release is sent until the release fails: one
 * that failed is not in flight, and counting it there would hold its slot for
 * the rest of the session (with "at once" 1, nothing would ever be released
 * again). `pending` is the release on its way; `halted` is why the last one
 * failed, and nothing is released after a failure until a person retries —
 * a refusal that does not go away (no `patch jobs`, a quota) would otherwise be
 * sent again on every change of the run list.
 */
export interface ReleaseLoop {
  released: ReadonlySet<string>
  pending: readonly string[]
  halted?: string
}

export const RELEASE_LOOP_START: ReleaseLoop = { released: new Set(), pending: [] }

/**
 * What the loop sends now: `backfillProgress`'s release, and nothing while a
 * release is on its way or after one failed. The dialog's effect is keyed on
 * the names this returns, so a run list that changed while a release was
 * pending is acted on once it settles: the key reads empty while pending and
 * is computed afresh after.
 */
export function releaseStep(
  runNames: readonly string[],
  runs: readonly RunRow[],
  parallel: number,
  volcano: boolean,
  loop: ReleaseLoop,
): RunRow[] {
  if (loop.pending.length || loop.halted !== undefined) return []
  return backfillProgress(runNames, runs, parallel, volcano, loop.released).release
}

/** A release was sent: its runs count as in flight from now. */
export function releaseSent(loop: ReleaseLoop, names: readonly string[]): ReleaseLoop {
  return { released: new Set([...loop.released, ...names]), pending: [...names] }
}

/**
 * The release settled. Runs are released one at a time, so a failure part way
 * names the runs patched before it (`releasedBefore`): those stay in flight,
 * the rest leave `released` and read as queued again, and the loop halts.
 */
export function releaseSettled(loop: ReleaseLoop, outcome: { error?: undefined } | { error: string; releasedBefore: readonly string[] }): ReleaseLoop {
  if (outcome.error === undefined) return { released: loop.released, pending: [] }
  const kept = new Set(outcome.releasedBefore)
  const lost = new Set(loop.pending.filter((n) => !kept.has(n)))
  return { released: new Set([...loop.released].filter((n) => !lost.has(n))), pending: [], halted: outcome.error }
}

/** A person asked to try again: the next step releases what is queued, failed runs first by date. */
export function releaseRetried(loop: ReleaseLoop): ReleaseLoop {
  return { released: loop.released, pending: loop.pending }
}
