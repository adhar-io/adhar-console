import { formatDuration } from '@adhar/utils'
import { describeCron } from './perf-cron.ts'
import { LABEL, observabilityLinks } from './batch-model.ts'

/**
 * Develop → Batch → Jobs, the in-service group (design 0025 §5.20.8, CON-Q.1):
 * what a service's schedule report MEANS, with no fetching and no React.
 *
 * A service on the kit's `quartz` engine writes `ConfigMap
 * <scheduler-name>-batch-schedules` in its own namespace, labelled
 * `adhar.io/batch-schedules: "true"`, with one key, `schedules.json`, version 1.
 * It is built from the Quartz store and the JobRepository, so every replica
 * writes the same document; it is rewritten after a fire ends and after trigger
 * changes, and it is ADVISORY: a write that fails is counted by the service and
 * never affects scheduling. So what the page shows is the last report, and the
 * one judgement it adds is whether that report has fallen behind its own next
 * fire.
 *
 * Every field is optional to a reader. A report of a version this console does
 * not know is kept as written and shown raw, never parsed by guesswork: a field
 * that changed meaning would otherwise be displayed with the old one.
 */

/* ─────────────────────────── the contract ─────────────────────────── */

export const SCHEDULES_LABEL = 'adhar.io/batch-schedules'
export const SCHEDULES_SELECTOR = `${SCHEDULES_LABEL}=true`
export const SCHEDULES_DATA_KEY = 'schedules.json'
export const SCHEDULES_SUFFIX = '-batch-schedules'
export const REPORT_VERSION = 1

/**
 * How late a fire may be before the row says so: the kit's default misfire
 * threshold (`adhar.batch.scheduler.misfire-threshold`, 10 min) and the 600 s of
 * the template's `BatchInServiceScheduleStalled` alert. Below it, a late fire is
 * not even a misfire to the scheduler.
 */
export const OVERDUE_AFTER_MS = 10 * 60_000

/** The most of an unreadable report the page will echo. */
export const RAW_LIMIT = 4_000

export interface ReportInstance {
  id?: string
  checkin?: string
}

export interface ReportTrigger {
  key?: string
  kind?: string
  /** `cron`: Quartz syntax, seconds first, optional year. */
  expression?: string
  /** `interval` / `daily`: a duration (`5m`, `PT5M`, or milliseconds). */
  every?: string
  /** `interval`: the grid anchor. */
  start?: string
  /** `daily`: times of day. */
  from?: string
  to?: string
  /** `daily`: days of the week, as names or Quartz numbers (1 = Sunday). */
  days?: string[]
  timeZone?: string
  calendar?: string
  misfire?: string
  /** Quartz's trigger state: NORMAL, PAUSED, BLOCKED, ERROR, COMPLETE, NONE. */
  state?: string
  previous?: string
  next?: string
}

export interface ReportLastRun {
  run?: string
  executionId?: number
  /** Spring Batch's BatchStatus. */
  status?: string
  /** The kit's outcome (D13): completed, skipped, … */
  outcome?: string
  trigger?: string
  start?: string
  end?: string
}

export interface ReportJob {
  job?: string
  name?: string
  triggers: ReportTrigger[]
  lastRun?: ReportLastRun
}

export interface ScheduleReport {
  v?: number
  engine?: string
  scheduler?: string
  updated?: string
  truncated: boolean
  instances?: ReportInstance[]
  jobs: ReportJob[]
}

export type ParsedReport =
  | { kind: 'v1'; report: ScheduleReport }
  /** A version this console does not read: kept as written. */
  | { kind: 'unknown'; version: string; raw: string }
  | { kind: 'invalid'; raw: string; error: string }
  | { kind: 'missing' }

const str = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined)
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : undefined)
const obj = (x: unknown): Record<string, unknown> | undefined => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined)
const objs = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.map(obj).filter((o): o is Record<string, unknown> => Boolean(o)) : [])
/** A duration as the kit may write it: a string as is, a number of milliseconds as one. */
const durationText = (x: unknown): string | undefined => str(x) ?? (typeof x === 'number' && Number.isFinite(x) && x > 0 ? String(x) : undefined)

const clip = (raw: string) => (raw.length > RAW_LIMIT ? `${raw.slice(0, RAW_LIMIT)}…` : raw)

function triggerOf(t: Record<string, unknown>): ReportTrigger {
  const days = Array.isArray(t.days) ? t.days.map((d) => (typeof d === 'number' ? String(d) : str(d))).filter((d): d is string => Boolean(d)) : str(t.days)?.split(/[\s,]+/).filter(Boolean)
  return {
    key: str(t.key),
    kind: str(t.kind),
    expression: str(t.expression),
    every: durationText(t.every),
    start: str(t.start),
    from: str(t.from),
    to: str(t.to),
    days: days?.length ? days : undefined,
    timeZone: str(t.timeZone),
    calendar: str(t.calendar),
    misfire: str(t.misfire),
    state: str(t.state),
    previous: str(t.previous),
    next: str(t.next),
  }
}

function lastRunOf(r: Record<string, unknown> | undefined): ReportLastRun | undefined {
  if (!r) return undefined
  return { run: str(r.run), executionId: num(r.executionId), status: str(r.status), outcome: str(r.outcome), trigger: str(r.trigger), start: str(r.start), end: str(r.end) }
}

/**
 * `schedules.json` → a report, read field by field: a value of the wrong type is
 * absent, never a thrown page. Version 1, or no `v` at all (every field is
 * optional, `v` too), is parsed; any other `v` is kept raw.
 */
export function parseReport(text: string | undefined): ParsedReport {
  if (text === undefined || text.trim() === '') return { kind: 'missing' }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    return { kind: 'invalid', raw: clip(text), error: e instanceof Error ? e.message : String(e) }
  }
  const d = obj(doc)
  if (!d) return { kind: 'invalid', raw: clip(text), error: 'not a JSON object' }
  if (d.v !== undefined && d.v !== REPORT_VERSION) return { kind: 'unknown', version: String(typeof d.v === 'string' || typeof d.v === 'number' ? d.v : JSON.stringify(d.v)), raw: clip(text) }
  return {
    kind: 'v1',
    report: {
      v: REPORT_VERSION,
      engine: str(d.engine),
      scheduler: str(d.scheduler),
      updated: str(d.updated),
      truncated: d.truncated === true,
      instances: Array.isArray(d.instances) ? objs(d.instances).map((i) => ({ id: str(i.id), checkin: str(i.checkin) })) : undefined,
      jobs: objs(d.jobs).map((j) => ({ job: str(j.job), name: str(j.name), triggers: objs(j.triggers).map(triggerOf), lastRun: lastRunOf(obj(j.lastRun)) })),
    },
  }
}

/* ─────────────────────────── cron in words ─────────────────────────── */

const WILD = (f: string | undefined) => f === undefined || f === '*' || f === '?'
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/** Quartz numbers the days of the week 1 = Sunday … 7 = Saturday; cron 0 = Sunday. */
function renumberWeekdays(field: string): string | null {
  const out: string[] = []
  for (const part of field.split(',')) {
    const [range, step] = part.split('/')
    const ends = range.split('-').map((v) => {
      if (/^\d+$/.test(v)) {
        const n = Number(v)
        return n >= 1 && n <= 7 ? String(n - 1) : null
      }
      return DAY_NAMES.includes(v.toUpperCase()) || v === '*' ? v : null
    })
    if (ends.some((e) => e === null)) return null
    out.push(ends.join('-') + (step === undefined ? '' : `/${step}`))
  }
  return out.join(',')
}

/** `0/5` and `*\/5` are one thing to a reader. */
const stepFromZero = (f: string) => f.replace(/^0\/(\d+)$/, '*/$1')

/**
 * A Quartz cron expression (seconds first, `?` in one day field, days of the
 * week numbered from Sunday = 1, optional year) in words. Read by converting it
 * to the five fields `describeCron` reads, so a Quartz trigger and a BatchJob
 * schedule of the same shape read the same. Whatever it cannot say in words
 * (`L`, `W`, `#`, a year, a fixed second other than :00) is shown as written.
 */
export function quartzCronWords(expr: string | undefined): string | undefined {
  const e = expr?.trim()
  if (!e) return undefined
  const parts = e.split(/\s+/)
  if (parts.length < 6 || parts.length > 7) return e
  const [sec, min, hour, dom, month, dow, year] = parts
  // `L`, `W` and `#` need no check of their own: `renumberWeekdays` and the
  // five-field reader both refuse them, and a refusal is shown as written.
  if (!(year === undefined || year === '*')) return e
  const restWild = WILD(min) && WILD(hour) && WILD(dom) && WILD(month) && WILD(dow)
  if (sec === '*' && restWild) return 'Every second'
  const secStep = /^(?:\*|0)\/(\d+)$/.exec(sec)
  if (secStep && restWild) return Number(secStep[1]) === 1 ? 'Every second' : `Every ${secStep[1]} seconds`
  if (sec !== '0') return e
  const weekdays = WILD(dow) ? '*' : renumberWeekdays(dow)
  if (weekdays === null) return e
  const five = [stepFromZero(min), stepFromZero(hour), WILD(dom) ? '*' : dom, month, weekdays].join(' ')
  const words = describeCron(five)
  return words === five ? e : words
}

/** `5m`, `PT5M`, `300000` (ms) → milliseconds. */
export function parseEveryMs(text: string | undefined): number | undefined {
  const s = text?.trim()
  if (!s) return undefined
  if (/^\d+$/.test(s)) return Number(s) || undefined
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s)
  if (iso && s.toUpperCase() !== 'P' && !/T$/i.test(s)) {
    const [, d, h, m, sec] = iso
    return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m ?? 0)) * 60_000 + Number(sec ?? 0) * 1_000 || undefined
  }
  if (!/^(\d+(\.\d+)?(ms|s|m|h|d))+$/.test(s)) return undefined
  let total = 0
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
    const n = Number(m[1])
    total += m[2] === 'ms' ? n : m[2] === 's' ? n * 1_000 : m[2] === 'm' ? n * 60_000 : m[2] === 'h' ? n * 3_600_000 : n * 86_400_000
  }
  return total || undefined
}

function everyWords(ms: number): string {
  const unit = (n: number, one: string) => (n === 1 ? `Every ${one}` : `Every ${n} ${one}s`)
  if (ms % 86_400_000 === 0) return unit(ms / 86_400_000, 'day')
  if (ms % 3_600_000 === 0) return unit(ms / 3_600_000, 'hour')
  if (ms % 60_000 === 0) return unit(ms / 60_000, 'minute')
  if (ms % 1_000 === 0) return unit(ms / 1_000, 'second')
  return `Every ${formatDuration(ms)}`
}

const titleDay = (d: string) => d[0] + d.slice(1).toLowerCase()

/** `MONDAY`, `mon`, `2` (Quartz: Monday) → `MON`; anything else is kept. */
function dayName(d: string): string {
  if (/^\d$/.test(d)) return DAY_NAMES[Number(d) - 1] ?? d
  const up = d.toUpperCase().slice(0, 3)
  return DAY_NAMES.includes(up) ? up : d
}

function daysWords(days: readonly string[] | undefined): string | undefined {
  if (!days?.length) return undefined
  const names = [...new Set(days.map(dayName))]
  const set = new Set(names)
  if (names.length === 7 && DAY_NAMES.every((d) => set.has(d))) return undefined
  if (names.length === 5 && ['MON', 'TUE', 'WED', 'THU', 'FRI'].every((d) => set.has(d))) return 'on weekdays'
  if (names.length === 2 && set.has('SAT') && set.has('SUN')) return 'at weekends'
  const ordered = names.sort((a, b) => DAY_NAMES.indexOf(a) - DAY_NAMES.indexOf(b))
  return `on ${ordered.map((d) => (DAY_NAMES.includes(d) ? titleDay(d) : d)).join(', ')}`
}

const hhmm = (t: string | undefined) => (t && /^\d{1,2}:\d{2}/.test(t) ? t.slice(0, t.indexOf(':') + 3).padStart(5, '0') : t)

/** A trigger in words, by kind; the raw definition when there are none. */
export function triggerWords(t: ReportTrigger): string {
  const kind = t.kind?.toLowerCase()
  if (kind === 'cron' || (!kind && t.expression)) return quartzCronWords(t.expression) ?? 'Cron'
  const every = parseEveryMs(t.every)
  if (kind === 'interval') return every ? everyWords(every) : t.every ? `Every ${t.every}` : 'Repeating'
  if (kind === 'daily') {
    const base = every ? everyWords(every) : t.every ? `Every ${t.every}` : 'Repeating'
    const window = t.from || t.to ? `${hhmm(t.from) ?? '00:00'}–${hhmm(t.to) ?? '24:00'}` : undefined
    return [base, window, daysWords(t.days)].filter(Boolean).join(', ')
  }
  if (kind === 'runtime' || kind === 'once' || kind === 'resume') return 'Once'
  return t.expression ?? t.kind ?? 'Trigger'
}

/** The definition behind the words: what a hover shows. */
export function triggerDefinition(t: ReportTrigger): string | undefined {
  const kind = t.kind?.toLowerCase()
  if (t.expression) return t.expression
  if (kind === 'interval') return [t.every ? `every ${t.every}` : null, t.start ? `from ${t.start}` : null].filter(Boolean).join(' ') || undefined
  if (kind === 'daily') return [t.every ? `every ${t.every}` : null, t.from ? `from ${t.from}` : null, t.to ? `to ${t.to}` : null, t.days?.length ? `on ${t.days.join(',')}` : null].filter(Boolean).join(' ') || undefined
  return undefined
}

export const MISFIRE_LABEL: Record<string, string> = {
  skip: 'a missed slot is skipped',
  latest: 'the latest missed slot runs once',
  all: 'every missed slot runs, oldest first',
}

/* ─────────────────────────── rows ─────────────────────────── */

const toMs = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

/** Quartz states in which a trigger will still fire. BLOCKED: its job is running right now. */
const FIRING_STATES = new Set(['NORMAL', 'BLOCKED', 'WAITING', 'ACQUIRED', 'EXECUTING'])

export const TRIGGER_STATE_LABEL: Record<string, string> = {
  PAUSED: 'Paused',
  BLOCKED: 'Running',
  ERROR: 'Error',
  COMPLETE: 'No more fires',
  NONE: 'Gone',
}

export type Tone = 'healthy' | 'paused' | 'progressing' | 'failed' | 'unknown' | 'info'

export interface TriggerView {
  key: string
  /** The trigger's own name: the last segment of its key. */
  name: string
  kind?: string
  words: string
  definition?: string
  timeZone?: string
  calendar?: string
  misfire?: string
  state?: string
  /** A badge for any state but NORMAL. */
  stateLabel?: string
  /** Whether Quartz will fire it again. */
  fires: boolean
  nextMs?: number
  previousMs?: number
  /** It should have fired more than OVERDUE_AFTER_MS ago and the report still says it will. */
  overdue: boolean
}

export interface LastRunView {
  run?: string
  executionId?: number
  status?: string
  outcome?: string
  trigger?: string
  startMs?: number
  endMs?: number
  durationMs?: number
  running: boolean
  label: string
  tone: Tone
}

export interface ScheduleJobRow {
  key: string
  /** The Spring Batch job (`importJob`). */
  job: string
  /** Its schedule name as a DNS label (`import-job`), when the report has one. */
  name?: string
  triggers: TriggerView[]
  /** The soonest next fire of a trigger that still fires. */
  nextFireMs?: number
  nextTimeZone?: string
  overdue: boolean
  /** When it was due, for the row's words. */
  overdueSinceMs?: number
  lastRun?: LastRunView
}

export interface ScheduleServiceRow {
  key: string
  namespace: string
  configMap: string
  application: string
  environment?: string
  scheduler?: string
  engine?: string
  report: ParsedReport['kind']
  /** `unknown`: the version as written. */
  version?: string
  raw?: string
  error?: string
  updatedMs?: number
  truncated: boolean
  /** Replicas checked in to the cluster when the report was written; undefined when it does not say. */
  replicas?: number
  instances: ReportInstance[]
  jobs: ScheduleJobRow[]
  /** Some job is overdue: the report has fallen behind its own next fire. */
  stale: boolean
}

/** The report ConfigMap's shape as this page reads it. */
export interface ReportConfigMap {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  data?: Record<string, string>
}

function lastRunView(r: ReportLastRun | undefined, now: number): LastRunView | undefined {
  if (!r || !(r.run || r.status || r.start || r.executionId !== undefined)) return undefined
  const status = r.status?.toUpperCase()
  const startMs = toMs(r.start)
  const endMs = toMs(r.end)
  const running = status === 'STARTING' || status === 'STARTED' || status === 'STOPPING'
  const skipped = r.outcome?.toLowerCase().startsWith('skipped') ?? false
  const [label, tone]: [string, Tone] = status === 'COMPLETED'
    ? (skipped ? ['Skipped', 'info'] : ['Completed', 'healthy'])
    : status === 'FAILED'
    ? ['Failed', 'failed']
    : status === 'ABANDONED'
    ? ['Abandoned', 'failed']
    : status === 'STOPPED'
    ? ['Stopped', 'paused']
    : status === 'STOPPING'
    ? ['Stopping', 'progressing']
    : running
    ? ['Running', 'progressing']
    : [r.status ?? 'Unknown', 'unknown']
  return {
    run: r.run,
    executionId: r.executionId,
    status: r.status,
    outcome: r.outcome,
    trigger: r.trigger,
    startMs,
    endMs,
    durationMs: startMs !== undefined ? Math.max(0, (endMs ?? (running ? now : startMs)) - startMs) : undefined,
    running,
    label,
    tone,
  }
}

function triggerView(t: ReportTrigger, i: number, now: number): TriggerView {
  const state = t.state?.toUpperCase()
  const fires = state === undefined || FIRING_STATES.has(state)
  const nextMs = toMs(t.next)
  const key = t.key ?? `trigger-${i}`
  return {
    key,
    name: key.split('.').pop() || key,
    kind: t.kind,
    words: triggerWords(t),
    definition: triggerDefinition(t),
    timeZone: t.timeZone,
    calendar: t.calendar,
    misfire: t.misfire,
    state: t.state,
    stateLabel: state && state !== 'NORMAL' ? TRIGGER_STATE_LABEL[state] ?? t.state : undefined,
    fires,
    nextMs,
    previousMs: toMs(t.previous),
    overdue: fires && nextMs !== undefined && now - nextMs > OVERDUE_AFTER_MS,
  }
}

function jobRow(j: ReportJob, i: number, serviceKey: string, now: number): ScheduleJobRow {
  const triggers = j.triggers.map((t, n) => triggerView(t, n, now))
  const firing = triggers.filter((t) => t.fires && t.nextMs !== undefined).sort((a, b) => (a.nextMs as number) - (b.nextMs as number))
  const overdue = triggers.filter((t) => t.overdue)
  const job = j.job ?? j.name ?? `job ${i + 1}`
  return {
    key: `${serviceKey}/${j.name ?? j.job ?? i}`,
    job,
    name: j.name && j.name !== j.job ? j.name : undefined,
    triggers,
    nextFireMs: firing[0]?.nextMs,
    nextTimeZone: firing[0]?.timeZone,
    overdue: overdue.length > 0,
    overdueSinceMs: overdue.length ? Math.min(...overdue.map((t) => t.nextMs as number)) : undefined,
    lastRun: lastRunView(j.lastRun, now),
  }
}

/** The application a report belongs to: its label, else the scheduler, else the ConfigMap's name. */
export function reportApplication(cm: ReportConfigMap, scheduler?: string): string {
  return cm.metadata.labels?.[LABEL.application] || scheduler ||
    (cm.metadata.name.endsWith(SCHEDULES_SUFFIX) ? cm.metadata.name.slice(0, -SCHEDULES_SUFFIX.length) : cm.metadata.name)
}

/** One service's report ConfigMap → a row. Never throws. */
export function scheduleService(cm: ReportConfigMap, opts: { envByNamespace?: ReadonlyMap<string, string>; now?: number } = {}): ScheduleServiceRow {
  const now = opts.now ?? Date.now()
  const namespace = cm.metadata.namespace ?? ''
  const key = `${namespace}/${cm.metadata.name}`
  const parsed = parseReport(cm.data?.[SCHEDULES_DATA_KEY])
  const report = parsed.kind === 'v1' ? parsed.report : undefined
  const jobs = (report?.jobs ?? []).map((j, i) => jobRow(j, i, key, now))
  return {
    key,
    namespace,
    configMap: cm.metadata.name,
    application: reportApplication(cm, report?.scheduler),
    environment: cm.metadata.labels?.[LABEL.environment] ?? (namespace ? opts.envByNamespace?.get(namespace) : undefined),
    scheduler: report?.scheduler,
    engine: report?.engine,
    report: parsed.kind,
    version: parsed.kind === 'unknown' ? parsed.version : undefined,
    raw: parsed.kind === 'unknown' || parsed.kind === 'invalid' ? parsed.raw : undefined,
    error: parsed.kind === 'invalid' ? parsed.error : undefined,
    updatedMs: toMs(report?.updated),
    truncated: report?.truncated ?? false,
    replicas: report?.instances ? report.instances.length : undefined,
    instances: report?.instances ?? [],
    jobs,
    stale: jobs.some((j) => j.overdue),
  }
}

/** Every readable report, sorted by application, then environment, then service. */
export function scheduleServices(cms: readonly ReportConfigMap[], opts: { envByNamespace?: ReadonlyMap<string, string>; now?: number } = {}): ScheduleServiceRow[] {
  const seen = new Set<string>()
  const out: ScheduleServiceRow[] = []
  for (const cm of cms) {
    const row = scheduleService(cm, opts)
    if (seen.has(row.key)) continue
    seen.add(row.key)
    out.push(row)
  }
  return out.sort((a, b) =>
    a.application.localeCompare(b.application) || (a.environment ?? a.namespace).localeCompare(b.environment ?? b.namespace) || a.configMap.localeCompare(b.configMap)
  )
}

export interface ScheduleGroup {
  application: string
  services: ScheduleServiceRow[]
}

export function groupServicesByApplication(rows: readonly ScheduleServiceRow[]): ScheduleGroup[] {
  const out: ScheduleGroup[] = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (last?.application === row.application) last.services.push(row)
    else out.push({ application: row.application, services: [row] })
  }
  return out
}

export function serviceSearchText(r: ScheduleServiceRow): string[] {
  return [
    r.application,
    r.namespace,
    r.environment,
    r.scheduler,
    r.configMap,
    ...r.jobs.flatMap((j) => [j.job, j.name, j.lastRun?.run, ...j.triggers.flatMap((t) => [t.name, t.definition, t.calendar])]),
  ].filter((s): s is string => Boolean(s))
}

/* ─────────────────────────── links ─────────────────────────── */

const lokiEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * The service's Grafana dashboard, and its logs in Loki filtered to one run.
 * The filter is a line filter on the run name rather than a parsed field: the
 * kit's MDC carries it as `batch.run`, and the same name is in the INFO line the
 * scheduler writes per fire, so it matches whatever the encoder's layout. With
 * no run reported yet the logs are filtered on the job's name instead.
 */
export function inServiceLinks(grafana: string, o: { application: string; namespace: string; run?: string; job?: string }): { dashboard: string; logs: string } | undefined {
  const base = observabilityLinks(grafana, { application: o.application, namespace: o.namespace, name: o.application })
  if (!base) return undefined
  const filter = o.run ?? o.job
  const expr = `{namespace="${lokiEsc(o.namespace)}"}${filter ? ` |= "${lokiEsc(filter)}"` : ''}`
  const ds = { type: 'loki', uid: 'loki' }
  const panes = { a: { datasource: ds.uid, queries: [{ refId: 'A', datasource: ds, expr }], range: { from: 'now-24h', to: 'now' } } }
  return { dashboard: base.dashboard, logs: `${grafana.replace(/\/$/, '')}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}` }
}
