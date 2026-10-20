/**
 * Pure agile-report math for Define's dashboard, My Work and Reports.
 *
 * Everything here works on a normalized `WorkItem` (a Plane issue joined with
 * its state's group) plus, where history matters, either Plane's per-issue
 * activity log or the console's daily snapshots (`define.snapshot`). No React,
 * no fetching — tested in `insights-math_test.ts`.
 *
 * Time is UTC milliseconds; a "day" is a UTC calendar day and a value "at day
 * d" means at the END of that day (so work finished on d counts on d).
 */

export type Group = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
export const GROUPS: Group[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled']
export const GROUP_LABEL: Record<Group, string> = {
  backlog: 'Backlog',
  unstarted: 'To do',
  started: 'In progress',
  completed: 'Done',
  cancelled: 'Cancelled',
}

export const DAY = 86_400_000

export interface WorkItem {
  id: string
  project: string
  /** Project identifier + sequence, e.g. `CON-42` (empty when unknown). */
  key: string
  seq?: number
  name: string
  state: string
  group: Group
  priority: string
  assignees: string[]
  labels: string[]
  points: number | null
  createdAt: number
  updatedAt: number
  /** When it reached a completed state (Plane's `completed_at`). */
  completedAt?: number
  targetDate?: string
  startDate?: string
  createdBy?: string
  parent?: string | null
}

interface IssueLike {
  id: string
  name: string
  state: string
  project: string
  priority?: string
  assignees?: string[]
  labels?: string[]
  estimate_point?: number | null
  created_at: string
  updated_at?: string
  completed_at?: string | null
  target_date?: string | null
  start_date?: string | null
  sequence_id?: number
  created_by?: string
  parent?: string | null
}

export function toMs(v: string | null | undefined): number | undefined {
  if (!v) return undefined
  const ms = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)
  return Number.isFinite(ms) ? ms : undefined
}

/** Join issues with their state groups. Unknown states count as backlog. */
export function toWorkItems(
  issues: IssueLike[],
  states: Array<{ id: string; group: string }>,
  identifier = '',
): WorkItem[] {
  const groupOf = new Map(states.map((s) => [s.id, s.group as Group]))
  return issues.map((i) => {
    const created = toMs(i.created_at) ?? 0
    const group = groupOf.get(i.state) ?? 'backlog'
    return {
      id: i.id,
      project: i.project,
      key: identifier && i.sequence_id != null ? `${identifier}-${i.sequence_id}` : '',
      seq: i.sequence_id,
      name: i.name,
      state: i.state,
      group,
      priority: i.priority ?? 'none',
      assignees: i.assignees ?? [],
      labels: i.labels ?? [],
      points: typeof i.estimate_point === 'number' ? i.estimate_point : null,
      createdAt: created,
      updatedAt: toMs(i.updated_at) ?? created,
      completedAt: group === 'completed' ? toMs(i.completed_at) ?? toMs(i.updated_at) : undefined,
      targetDate: i.target_date ?? undefined,
      startDate: i.start_date ?? undefined,
      createdBy: i.created_by,
      parent: i.parent ?? null,
    }
  })
}

/* ───── days ───── */

export const startOfDay = (ms: number) => Math.floor(ms / DAY) * DAY
export const endOfDay = (ms: number) => startOfDay(ms) + DAY - 1
export const dayKey = (ms: number) => new Date(startOfDay(ms)).toISOString().slice(0, 10)

/** Every UTC day start from `from` to `to` inclusive (capped at 400 days). */
export function daysBetween(from: number, to: number): number[] {
  const out: number[] = []
  for (let t = startOfDay(from); t <= to && out.length < 400; t += DAY) out.push(t)
  return out
}

export const isOpen = (i: WorkItem) => i.group !== 'completed' && i.group !== 'cancelled'

/** When the item left the open set (done, or cancelled ≈ its last update). */
export function resolvedAt(i: WorkItem): number | undefined {
  if (i.group === 'completed') return i.completedAt ?? i.updatedAt
  if (i.group === 'cancelled') return i.updatedAt
  return undefined
}

const weight = (i: WorkItem, metric: Metric) => (metric === 'points' ? i.points ?? 0 : 1)
export type Metric = 'count' | 'points'

/* ───── burndown / burnup ───── */

export interface BurnPoint {
  t: number
  remaining?: number
  ideal: number
  completed?: number
  scope?: number
}

/**
 * Sprint burndown + burnup from the items CURRENTLY in the sprint. Cancelled
 * work is out of scope. Days after `now` carry only the ideal line.
 * Scope over time follows each item's creation date — Plane's public API does
 * not say when an issue joined the cycle, so work moved in later counts from
 * the sprint's start (callers say so).
 */
export function burn(
  items: WorkItem[],
  start: number,
  end: number,
  now: number,
  metric: Metric = 'count',
): { points: BurnPoint[]; total: number } {
  const scope = items.filter((i) => i.group !== 'cancelled')
  const total = scope.reduce((a, i) => a + weight(i, metric), 0)
  const days = daysBetween(start, end)
  const span = Math.max(1, days.length - 1)
  const rows = days.map((d) => {
    if (d > now) return { t: d, ideal: 0 }
    const eod = endOfDay(d)
    let completed = 0
    let scopeAtDay = 0
    for (const i of scope) {
      const w = weight(i, metric)
      // Work created after the sprint started joins scope the day it was created.
      if (i.createdAt <= eod) scopeAtDay += w
      const r = i.group === 'completed' ? resolvedAt(i) : undefined
      if (r !== undefined && r <= eod) completed += w
    }
    return { t: d, ideal: 0, remaining: Math.max(0, scopeAtDay - completed), completed, scope: scopeAtDay }
  })
  // The ideal line runs from what was left on day one (work finished before
  // the sprint began is not part of its burn) down to zero at the end.
  const from = rows[0]?.remaining ?? total
  const points: BurnPoint[] = rows.map((r, idx) => ({ ...r, ideal: Math.max(0, from - (from * idx) / span) }))
  return { points, total }
}

/* ───── velocity ───── */

export interface CycleLike {
  id: string
  name: string
  start_date?: string | null
  end_date?: string | null
  total_issues?: number
  completed_issues?: number
  cancelled_issues?: number
}

export interface VelocityRow {
  id: string
  name: string
  end: number
  committed: number
  completed: number
  committedPts?: number
  completedPts?: number
}

/**
 * Velocity over finished cycles (end before `now`), oldest first, last `n`.
 * Counts come from Plane's cycle totals; points from `itemsByCycle` when the
 * caller has membership (Plane's issues carry no cycle).
 */
export function velocity(
  cycles: CycleLike[],
  now: number,
  itemsByCycle?: Map<string, WorkItem[]>,
  n = 8,
): { rows: VelocityRow[]; average: number; averagePts?: number } {
  const done = cycles
    .map((c) => ({ c, end: toMs(c.end_date) }))
    .filter((x): x is { c: CycleLike; end: number } => x.end !== undefined && endOfDay(x.end) < now)
    .sort((a, b) => a.end - b.end)
    .slice(-n)
  const rows = done.map(({ c, end }) => {
    const items = itemsByCycle?.get(c.id)
    const row: VelocityRow = {
      id: c.id,
      name: c.name,
      end,
      committed: (c.total_issues ?? 0) - (c.cancelled_issues ?? 0),
      completed: c.completed_issues ?? 0,
    }
    if (items) {
      const scope = items.filter((i) => i.group !== 'cancelled')
      row.committedPts = scope.reduce((a, i) => a + (i.points ?? 0), 0)
      row.completedPts = scope.filter((i) => i.group === 'completed').reduce((a, i) => a + (i.points ?? 0), 0)
    }
    return row
  })
  const last = rows.slice(-3)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  return {
    rows,
    average: avg(last.map((r) => r.completed)),
    averagePts: itemsByCycle ? avg(last.map((r) => r.completedPts ?? 0)) : undefined,
  }
}

/* ───── created vs resolved / throughput ───── */

export interface FlowBucket {
  t: number
  created: number
  resolved: number
  cumCreated: number
  cumResolved: number
}

export function createdVsResolved(
  items: WorkItem[],
  from: number,
  to: number,
  bucket: 'day' | 'week' = 'day',
): FlowBucket[] {
  const size = bucket === 'week' ? 7 * DAY : DAY
  const start = startOfDay(from)
  const n = Math.max(1, Math.ceil((endOfDay(to) - start + 1) / size))
  const out: FlowBucket[] = Array.from({ length: n }, (_, k) => ({ t: start + k * size, created: 0, resolved: 0, cumCreated: 0, cumResolved: 0 }))
  for (const i of items) {
    const c = Math.floor((i.createdAt - start) / size)
    if (c >= 0 && c < n) out[c].created++
    const r0 = i.group === 'completed' ? resolvedAt(i) : undefined
    if (r0 !== undefined) {
      const r = Math.floor((r0 - start) / size)
      if (r >= 0 && r < n) out[r].resolved++
    }
  }
  let cc = 0
  let cr = 0
  for (const b of out) {
    cc += b.created
    cr += b.resolved
    b.cumCreated = cc
    b.cumResolved = cr
  }
  return out
}

/* ───── average age ───── */

/** Mean age (days) of the items open at the end of each day. */
export function averageAge(items: WorkItem[], from: number, to: number): Array<{ t: number; age: number; open: number }> {
  return daysBetween(from, to).map((d) => {
    const eod = endOfDay(d)
    let sum = 0
    let open = 0
    for (const i of items) {
      if (i.createdAt > eod) continue
      const r = resolvedAt(i)
      if (r !== undefined && r <= eod) continue
      open++
      sum += (eod - i.createdAt) / DAY
    }
    return { t: d, age: open ? sum / open : 0, open }
  })
}

/* ───── state timelines (history) ───── */

export interface Segment {
  state: string
  group: Group
  from: number
  to: number
}

export interface HistoryRow {
  field?: string | null
  old_value?: string | null
  new_value?: string | null
  old_identifier?: string | null
  new_identifier?: string | null
  created_at: string
}

/**
 * An issue's state segments from Plane's activity log. State changes carry
 * the state ids in `old_identifier` / `new_identifier`; older rows only have
 * names, matched against `states`.
 */
export function timelineFromHistory(
  item: WorkItem,
  history: HistoryRow[],
  states: Array<{ id: string; name: string; group: string }>,
  now: number,
): Segment[] {
  const byId = new Map(states.map((s) => [s.id, s]))
  const byName = new Map(states.map((s) => [s.name.toLowerCase(), s]))
  const resolve = (id?: string | null, name?: string | null) =>
    (id && byId.get(id)) || (name ? byName.get(name.toLowerCase()) : undefined)
  const changes = history
    .filter((h) => h.field === 'state')
    .map((h) => ({ at: toMs(h.created_at) ?? 0, from: resolve(h.old_identifier, h.old_value), to: resolve(h.new_identifier, h.new_value) }))
    .sort((a, b) => a.at - b.at)
  const segs: Segment[] = []
  const end = item.group === 'completed' || item.group === 'cancelled' ? Math.max(item.updatedAt, item.completedAt ?? 0) : now
  let cur = changes[0]?.from ?? byId.get(item.state)
  let t = item.createdAt
  for (const c of changes) {
    if (cur && c.at > t) segs.push({ state: cur.id, group: cur.group as Group, from: t, to: c.at })
    cur = c.to ?? cur
    t = c.at
  }
  const last = cur ?? byId.get(item.state)
  if (last) segs.push({ state: last.id, group: last.group as Group, from: t, to: Math.max(t, last.group === 'completed' || last.group === 'cancelled' ? t : end) })
  return segs
}

/** Total time (ms) per state over a set of timelines; terminal states are not timed. */
export function timeInStatus(timelines: Segment[][]): Map<string, { ms: number; items: number; group: Group }> {
  const out = new Map<string, { ms: number; items: number; group: Group }>()
  for (const tl of timelines) {
    const seen = new Set<string>()
    for (const s of tl) {
      if (s.group === 'completed' || s.group === 'cancelled') continue
      const row = out.get(s.state) ?? { ms: 0, items: 0, group: s.group }
      row.ms += Math.max(0, s.to - s.from)
      if (!seen.has(s.state)) {
        row.items++
        seen.add(s.state)
      }
      out.set(s.state, row)
    }
  }
  return out
}

/** First moment the timeline enters a started-group state. */
export function firstStarted(tl: Segment[]): number | undefined {
  return tl.find((s) => s.group === 'started')?.from
}

/* ───── control chart ───── */

export interface ControlPoint {
  id: string
  key: string
  name: string
  t: number
  days: number
}

export function rollingAverage(values: number[], window: number): number[] {
  const out: number[] = []
  let sum = 0
  for (let k = 0; k < values.length; k++) {
    sum += values[k]
    if (k >= window) sum -= values[k - window]
    out.push(sum / Math.min(window, k + 1))
  }
  return out
}

/**
 * Cycle (or lead) time per completed item in [from, to]. `startOf` returns
 * when work started; without it — or when it returns undefined — the item's
 * creation is used (lead time).
 */
export function controlChart(
  items: WorkItem[],
  from: number,
  to: number,
  startOf?: (i: WorkItem) => number | undefined,
  window = 5,
): { points: ControlPoint[]; rolling: Array<[number, number]>; mean: number; stdev: number } {
  const points = items
    .filter((i) => i.group === 'completed' && i.completedAt !== undefined && i.completedAt >= from && i.completedAt <= to)
    .map((i) => {
      const s = startOf?.(i) ?? i.createdAt
      return { id: i.id, key: i.key, name: i.name, t: i.completedAt!, days: Math.max(0, (i.completedAt! - s) / DAY) }
    })
    .sort((a, b) => a.t - b.t)
  const vals = points.map((p) => p.days)
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  const stdev = vals.length > 1 ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (vals.length - 1)) : 0
  const ra = rollingAverage(vals, window)
  return { points, rolling: points.map((p, k) => [p.t, ra[k]]), mean, stdev }
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

/* ───── workload ───── */

export interface WorkloadRow {
  assignee: string
  open: number
  points: number
  overdue: number
  inProgress: number
}

export function workload(items: WorkItem[], now: number): WorkloadRow[] {
  const map = new Map<string, WorkloadRow>()
  for (const i of items) {
    if (!isOpen(i)) continue
    const who = i.assignees.length ? i.assignees : ['']
    for (const a of who) {
      const row = map.get(a) ?? { assignee: a, open: 0, points: 0, overdue: 0, inProgress: 0 }
      row.open++
      row.points += i.points ?? 0
      if (isOverdue(i, now)) row.overdue++
      if (i.group === 'started') row.inProgress++
      map.set(a, row)
    }
  }
  return [...map.values()].sort((a, b) => b.open - a.open)
}

export function isOverdue(i: WorkItem, now: number): boolean {
  const due = toMs(i.targetDate)
  return isOpen(i) && due !== undefined && endOfDay(due) < now
}

export function isDueWithin(i: WorkItem, now: number, days: number): boolean {
  const due = toMs(i.targetDate)
  return isOpen(i) && due !== undefined && endOfDay(due) >= now && due <= now + days * DAY
}

/* ───── sprint + epic reports ───── */

export interface SprintReport {
  completed: WorkItem[]
  notCompleted: WorkItem[]
  cancelled: WorkItem[]
  /** Created after the sprint began — the only "added" signal Plane's API gives. */
  createdAfterStart: WorkItem[]
  completedPts: number
  notCompletedPts: number
  completion: number
}

export function sprintReport(items: WorkItem[], start: number): SprintReport {
  const completed = items.filter((i) => i.group === 'completed')
  const cancelled = items.filter((i) => i.group === 'cancelled')
  const notCompleted = items.filter(isOpen)
  const pts = (xs: WorkItem[]) => xs.reduce((a, i) => a + (i.points ?? 0), 0)
  const inScope = completed.length + notCompleted.length
  return {
    completed,
    notCompleted,
    cancelled,
    createdAfterStart: items.filter((i) => i.createdAt > endOfDay(start)),
    completedPts: pts(completed),
    notCompletedPts: pts(notCompleted),
    completion: inScope ? Math.round((completed.length / inScope) * 100) : 0,
  }
}

export interface EpicForecast {
  total: number
  done: number
  remaining: number
  /** Items completed per week, averaged over the last `weeks` weeks. */
  ratePerWeek: number
  /** Projected completion at that rate; undefined when nothing is moving. */
  eta?: number
}

export function epicForecast(items: WorkItem[], now: number, weeks = 4): EpicForecast {
  const scope = items.filter((i) => i.group !== 'cancelled')
  const done = scope.filter((i) => i.group === 'completed')
  const since = now - weeks * 7 * DAY
  const recent = done.filter((i) => (i.completedAt ?? 0) >= since).length
  const ratePerWeek = recent / weeks
  const remaining = scope.length - done.length
  return {
    total: scope.length,
    done: done.length,
    remaining,
    ratePerWeek,
    eta: remaining === 0 ? now : ratePerWeek > 0 ? now + (remaining / ratePerWeek) * 7 * DAY : undefined,
  }
}

/* ───── distributions ───── */

export function countBy<T>(xs: T[], key: (x: T) => string | string[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const x of xs) {
    const k = key(x)
    for (const one of Array.isArray(k) ? (k.length ? k : ['']) : [k]) out.set(one, (out.get(one) ?? 0) + 1)
  }
  return out
}

/* ───── CSV ───── */

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return ''
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const cell = (v: unknown) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v)
    // Neutralise spreadsheet formulas; quote anything with separators.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')
}
