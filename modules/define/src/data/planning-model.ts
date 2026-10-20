/**
 * Planning math for Define — sprints, burndown/burnup, velocity, capacity,
 * project health, workload and intake SLAs. Pure functions only (no React,
 * no fetch) so every number on the planning screens is testable.
 *
 * Inputs come from two places, and the functions say which:
 *   • Plane — work items with `state_group`, `completed_at`, dates, assignees;
 *     cycles with start/end dates. Plane's public API has no issue history
 *     per cycle and no estimate values (estimate points are unresolvable
 *     UUIDs), so
 *   • the console's own store — daily sprint snapshots (which work items were
 *     in the sprint each day) and story points the console recorded.
 * When a value can only be approximated, the result carries a `source` so the
 * view can say so instead of presenting a guess as fact.
 */

export const DAY_MS = 86_400_000

/** `YYYY-MM-DD` in UTC. */
export type DayKey = string

export type StateGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

/** The slice of a Plane work item the planning math needs. */
export interface WorkItem {
  id: string
  name?: string
  state_group?: StateGroup
  completed_at?: string | null
  created_at: string
  assignees: string[]
  start_date?: string | null
  target_date?: string | null
  priority?: string
  labels?: string[]
  project?: string
  /** Numeric estimate when Plane resolved one; UUIDs are ignored. */
  estimate_point?: string | number | null
}

/* ───── days ───── */

/** Parse a Plane date or datetime to ms; date-only values are UTC midnight. */
export function toMs(v: string | null | undefined): number | undefined {
  if (!v) return undefined
  const ms = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)
  return Number.isFinite(ms) ? ms : undefined
}

export function dayKey(v: number | string): DayKey {
  const ms = typeof v === 'number' ? v : toMs(v) ?? NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : ''
}

/** UTC midnight of the day containing `ms`. */
export function startOfDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

/** Every day from `start` to `end` inclusive, as UTC-midnight ms. */
export function eachDay(start: number, end: number): number[] {
  const out: number[] = []
  const last = startOfDay(end)
  for (let d = startOfDay(start); d <= last && out.length < 1000; d += DAY_MS) out.push(d)
  return out
}

/** Mon–Fri days between two instants, inclusive. */
export function workdays(start: number, end: number): number {
  return eachDay(start, end).filter((d) => {
    const w = new Date(d).getUTCDay()
    return w !== 0 && w !== 6
  }).length
}

/* ───── work item state ───── */

export const isDone = (i: Pick<WorkItem, 'state_group' | 'completed_at'>) =>
  i.state_group ? i.state_group === 'completed' : !!i.completed_at
export const isCancelled = (i: Pick<WorkItem, 'state_group'>) => i.state_group === 'cancelled'
export const isClosed = (i: Pick<WorkItem, 'state_group' | 'completed_at'>) => isDone(i) || isCancelled(i)
export const isOpen = (i: Pick<WorkItem, 'state_group' | 'completed_at'>) => !isClosed(i)

/** True when the item was completed at or before `ms` (end of that instant). */
export function doneBy(i: WorkItem, ms: number): boolean {
  if (!isDone(i)) return false
  const at = toMs(i.completed_at)
  // Completed in Plane without a timestamp — counts from the moment we saw it.
  return at === undefined ? true : at <= ms
}

export function isOverdue(i: WorkItem, now = Date.now()): boolean {
  const due = toMs(i.target_date)
  return due !== undefined && isOpen(i) && due + DAY_MS <= now
}

/**
 * Story points of an item: a numeric estimate Plane resolved, else the value
 * the console recorded, else null (unestimated).
 */
export function pointsOf(i: Pick<WorkItem, 'id' | 'estimate_point'>, recorded: Record<string, number> = {}): number | null {
  if (typeof i.estimate_point === 'number' && Number.isFinite(i.estimate_point)) return i.estimate_point
  const v = recorded[i.id]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export type Metric = 'issues' | 'points'

export function weigh(i: Pick<WorkItem, 'id' | 'estimate_point'>, metric: Metric, recorded: Record<string, number>): number {
  return metric === 'issues' ? 1 : pointsOf(i, recorded) ?? 0
}

/* ───── sprints ───── */

export type SprintStatus = 'draft' | 'upcoming' | 'active' | 'completed'

/**
 * Derived from dates, as Plane's own cycle filter does: no dates is a draft,
 * a start in the future upcoming, an end in the past completed, else active.
 * A date-only end counts through that whole day.
 */
export function sprintStatus(c: { start_date?: string | null; end_date?: string | null }, now = Date.now()): SprintStatus {
  const start = toMs(c.start_date)
  let end = toMs(c.end_date)
  if (start === undefined && end === undefined) return 'draft'
  if (end !== undefined && c.end_date && c.end_date.length === 10) end += DAY_MS - 1
  if (start !== undefined && start > now) return 'upcoming'
  if (end !== undefined && end < now) return 'completed'
  if (start === undefined) return 'draft'
  return 'active'
}

/** Elapsed share 0–1 of a sprint's time box. */
export function sprintElapsed(c: { start_date?: string | null; end_date?: string | null }, now = Date.now()): number {
  const s = toMs(c.start_date)
  const e = toMs(c.end_date)
  if (s === undefined || e === undefined || e <= s) return 0
  return Math.max(0, Math.min(1, (now - s) / (e + (c.end_date?.length === 10 ? DAY_MS : 0) - s)))
}

export function daysLeft(end: string | null | undefined, now = Date.now()): number | undefined {
  const e = toMs(end)
  if (e === undefined) return undefined
  const endMs = end && end.length === 10 ? e + DAY_MS : e
  return Math.max(0, Math.ceil((endMs - now) / DAY_MS))
}

/** One day's record of a sprint's contents, written by the console. */
export interface SprintSnapshot {
  /** Work item ids in the sprint that day. */
  ids: string[]
  /** Of those, the ones completed. */
  done: string[]
  /** Points per id when any were known. */
  points?: Record<string, number>
}

export function takeSnapshot(items: WorkItem[], recorded: Record<string, number> = {}): SprintSnapshot {
  const points: Record<string, number> = {}
  for (const i of items) {
    const p = pointsOf(i, recorded)
    if (p !== null) points[i.id] = p
  }
  const snap: SprintSnapshot = {
    ids: items.map((i) => i.id).sort(),
    done: items.filter(isDone).map((i) => i.id).sort(),
  }
  if (Object.keys(points).length) snap.points = points
  return snap
}

/**
 * The snapshot map with today's entry set, or null when today's entry is
 * already identical (so the caller skips a write).
 */
export function withSnapshot(
  existing: Record<DayKey, SprintSnapshot> | undefined,
  day: DayKey,
  snap: SprintSnapshot,
): Record<DayKey, SprintSnapshot> | null {
  const cur = existing?.[day]
  if (cur && JSON.stringify(cur) === JSON.stringify(snap)) return null
  return { ...(existing ?? {}), [day]: snap }
}

/** The latest snapshot at or before `day`, if any. */
export function snapshotAt(snaps: Record<DayKey, SprintSnapshot> | undefined, day: DayKey): SprintSnapshot | undefined {
  if (!snaps) return undefined
  let best: DayKey | undefined
  for (const k of Object.keys(snaps)) if (k <= day && (!best || k > best)) best = k
  return best ? snaps[best] : undefined
}

export interface BurnSeries {
  /** UTC-midnight ms for each day of the sprint. */
  days: number[]
  ideal: number[]
  /** Remaining work at the end of each day; null for days still ahead. */
  remaining: Array<number | null>
  /** Total scope each day (burnup's upper line); null for days ahead. */
  scope: Array<number | null>
  /** Completed work each day (burnup); null for days ahead. */
  completed: Array<number | null>
  /** Work committed at sprint start. */
  committed: number
  /**
   * Where daily scope came from: recorded snapshots, the sprint's current
   * contents (no snapshots at all), or both (snapshots started mid-sprint).
   */
  scopeSource: 'snapshots' | 'current' | 'mixed'
}

/**
 * Burndown + burnup for a sprint. Completion dates come from Plane
 * (`completed_at`); daily scope comes from the console's snapshots where
 * recorded, else the sprint's current contents.
 */
export function burnSeries(input: {
  start: string | null | undefined
  end: string | null | undefined
  items: WorkItem[]
  snapshots?: Record<DayKey, SprintSnapshot>
  metric: Metric
  points?: Record<string, number>
  now?: number
}): BurnSeries | null {
  const s = toMs(input.start)
  const e = toMs(input.end)
  if (s === undefined || e === undefined || e < s) return null
  const now = input.now ?? Date.now()
  const recorded = input.points ?? {}
  const byId = new Map(input.items.map((i) => [i.id, i]))
  const days = eachDay(s, e)
  const remaining: Array<number | null> = []
  const scope: Array<number | null> = []
  const completed: Array<number | null> = []
  let usedSnap = false
  let usedCurrent = false
  for (const d of days) {
    if (d > now) {
      remaining.push(null)
      scope.push(null)
      completed.push(null)
      continue
    }
    const endOfDay = d + DAY_MS - 1
    const snap = snapshotAt(input.snapshots, dayKey(d))
    let total = 0
    let done = 0
    if (snap) {
      usedSnap = true
      const doneSet = new Set(snap.done)
      for (const id of snap.ids) {
        const item = byId.get(id)
        const w = input.metric === 'issues' ? 1 : snap.points?.[id] ?? (item ? pointsOf(item, recorded) : null) ?? 0
        if (item?.state_group === 'cancelled') continue
        total += w
        const isDoneThatDay = item ? doneBy(item, endOfDay) : doneSet.has(id)
        if (isDoneThatDay) done += w
      }
    } else {
      usedCurrent = true
      for (const item of input.items) {
        if (isCancelled(item)) continue
        const w = weigh(item, input.metric, recorded)
        total += w
        if (doneBy(item, endOfDay)) done += w
      }
    }
    scope.push(round(total))
    completed.push(round(done))
    remaining.push(round(total - done))
  }
  const committed = scope.find((v) => v !== null) ?? input.items.filter((i) => !isCancelled(i)).reduce((a, i) => a + weigh(i, input.metric, recorded), 0)
  const n = Math.max(1, days.length - 1)
  const ideal = days.map((_, k) => round(committed - (committed * k) / n))
  return {
    days,
    ideal,
    remaining,
    scope,
    completed,
    committed,
    scopeSource: usedSnap && usedCurrent ? 'mixed' : usedSnap ? 'snapshots' : 'current',
  }
}

const round = (v: number) => Math.round(v * 10) / 10

export interface ScopeChange {
  day: DayKey
  added: string[]
  removed: string[]
}

/** Day-over-day scope changes between consecutive snapshots. */
export function scopeChanges(snaps: Record<DayKey, SprintSnapshot> | undefined): ScopeChange[] {
  if (!snaps) return []
  const keys = Object.keys(snaps).sort()
  const out: ScopeChange[] = []
  for (let k = 1; k < keys.length; k++) {
    const prev = new Set(snaps[keys[k - 1]].ids)
    const cur = new Set(snaps[keys[k]].ids)
    const added = [...cur].filter((id) => !prev.has(id))
    const removed = [...prev].filter((id) => !cur.has(id))
    if (added.length || removed.length) out.push({ day: keys[k], added, removed })
  }
  return out
}

export interface SprintOutcome {
  id: string
  name: string
  committed: number
  completed: number
  /** Unfinished at the end — the carry-over. */
  carried: number
  added: number
  removed: number
  /** Whether committed came from a start-of-sprint snapshot. */
  measured: boolean
}

/**
 * Committed vs completed for one sprint. Committed is the start-of-sprint
 * snapshot when the console recorded one (or the console's own commitment
 * recorded at "Start sprint"), else the current scope.
 */
export function sprintOutcome(input: {
  id: string
  name: string
  start: string | null | undefined
  end: string | null | undefined
  items: WorkItem[]
  snapshots?: Record<DayKey, SprintSnapshot>
  commitment?: { ids: string[]; points?: Record<string, number> }
  metric: Metric
  points?: Record<string, number>
  now?: number
}): SprintOutcome {
  const recorded = input.points ?? {}
  const e = toMs(input.end)
  const endMs = e === undefined ? input.now ?? Date.now() : e + (input.end?.length === 10 ? DAY_MS - 1 : 0)
  const byId = new Map(input.items.map((i) => [i.id, i]))
  const startKey = input.start ? dayKey(input.start) : ''
  const startSnap = input.commitment ?? (startKey ? snapshotAt(input.snapshots, startKey) ?? firstSnapshot(input.snapshots) : undefined)
  const w = (id: string, snapPts?: Record<string, number>) => {
    if (input.metric === 'issues') return 1
    const item = byId.get(id)
    return snapPts?.[id] ?? (item ? pointsOf(item, recorded) : null) ?? 0
  }
  const live = input.items.filter((i) => !isCancelled(i))
  const committedIds = startSnap ? startSnap.ids.filter((id) => byId.get(id)?.state_group !== 'cancelled') : live.map((i) => i.id)
  const committed = committedIds.reduce((a, id) => a + w(id, startSnap?.points), 0)
  const completed = live.filter((i) => doneBy(i, endMs)).reduce((a, i) => a + w(i.id), 0)
  const carried = live.filter((i) => !doneBy(i, endMs)).reduce((a, i) => a + w(i.id), 0)
  const startSet = new Set(committedIds)
  const liveSet = new Set(live.map((i) => i.id))
  const added = live.filter((i) => !startSet.has(i.id)).reduce((a, i) => a + w(i.id), 0)
  const removed = committedIds.filter((id) => !liveSet.has(id)).reduce((a, id) => a + w(id, startSnap?.points), 0)
  return { id: input.id, name: input.name, committed: round(committed), completed: round(completed), carried: round(carried), added: round(added), removed: round(removed), measured: !!startSnap }
}

function firstSnapshot(snaps?: Record<DayKey, SprintSnapshot>): SprintSnapshot | undefined {
  if (!snaps) return undefined
  const k = Object.keys(snaps).sort()[0]
  return k ? snaps[k] : undefined
}

export interface Velocity {
  /** Mean completed over the last `window` finished sprints (null when none). */
  average: number | null
  /** Completed ÷ committed across the window, 0–1 (null when nothing committed). */
  sayDo: number | null
  /** +1 rising, -1 falling, 0 flat/unknown — last sprint vs the window average before it. */
  trend: -1 | 0 | 1
  window: number
}

export function velocity(outcomes: SprintOutcome[], window = 3): Velocity {
  const last = outcomes.slice(-window)
  if (!last.length) return { average: null, sayDo: null, trend: 0, window }
  const average = round(last.reduce((a, o) => a + o.completed, 0) / last.length)
  const committed = last.reduce((a, o) => a + o.committed, 0)
  const sayDo = committed > 0 ? Math.round((last.reduce((a, o) => a + o.completed, 0) / committed) * 100) / 100 : null
  let trend: -1 | 0 | 1 = 0
  if (outcomes.length >= 2) {
    const prev = outcomes.slice(-window - 1, -1)
    const prevAvg = prev.reduce((a, o) => a + o.completed, 0) / prev.length
    const lastDone = outcomes[outcomes.length - 1].completed
    if (lastDone > prevAvg * 1.1) trend = 1
    else if (lastDone < prevAvg * 0.9) trend = -1
  }
  return { average, sayDo, trend, window }
}

/* ───── capacity ───── */

export interface CapacityInput {
  member: string
  /** Planned capacity for the sprint, in the sprint's metric. */
  capacity: number
  /** Working days the member is away during the sprint. */
  daysOff?: number
}

export interface CapacityRow {
  member: string
  capacity: number
  /** Capacity after days off. */
  effective: number
  assigned: number
  /** assigned ÷ effective, 0–∞ (null without capacity). */
  load: number | null
  over: boolean
}

export function capacityPlan(input: {
  entries: CapacityInput[]
  items: WorkItem[]
  metric: Metric
  points?: Record<string, number>
  workdays: number
}): { rows: CapacityRow[]; unassigned: number; totalCapacity: number; totalAssigned: number } {
  const recorded = input.points ?? {}
  const assigned = new Map<string, number>()
  let unassigned = 0
  for (const i of input.items) {
    if (isClosed(i)) continue
    const w = weigh(i, input.metric, recorded)
    if (!i.assignees.length) {
      unassigned += w
      continue
    }
    // Shared work splits evenly — no one person carries it all.
    for (const a of i.assignees) assigned.set(a, (assigned.get(a) ?? 0) + w / i.assignees.length)
  }
  const members = new Set([...input.entries.map((e) => e.member), ...assigned.keys()])
  const byMember = new Map(input.entries.map((e) => [e.member, e]))
  const rows: CapacityRow[] = [...members].map((m) => {
    const e = byMember.get(m)
    const capacity = e?.capacity ?? 0
    const days = Math.max(0, input.workdays)
    const effective = days > 0 ? round((capacity * Math.max(0, days - (e?.daysOff ?? 0))) / days) : capacity
    const a = round(assigned.get(m) ?? 0)
    const load = effective > 0 ? Math.round((a / effective) * 100) / 100 : null
    return { member: m, capacity, effective, assigned: a, load, over: effective > 0 ? a > effective : a > 0 && !!e }
  })
  rows.sort((x, y) => (y.load ?? -1) - (x.load ?? -1) || y.assigned - x.assigned)
  return {
    rows,
    unassigned: round(unassigned),
    totalCapacity: round(rows.reduce((s, r) => s + r.effective, 0)),
    totalAssigned: round(rows.reduce((s, r) => s + r.assigned, 0) + unassigned),
  }
}

/* ───── project health ───── */

export type Health = 'on-track' | 'at-risk' | 'off-track'

export interface HealthSignal {
  health: Health
  reasons: string[]
}

/**
 * Health from real signals: overdue open work, and the active sprint's
 * completion against its elapsed time. No signals → on track, said plainly.
 */
export function deriveHealth(input: {
  items: WorkItem[]
  /** The running sprint with its in-scope (non-cancelled) and completed counts. */
  activeSprint?: { start_date?: string | null; end_date?: string | null; total: number; done: number }
  now?: number
}): HealthSignal {
  const now = input.now ?? Date.now()
  const reasons: string[] = []
  let level = 0
  const open = input.items.filter(isOpen)
  const overdue = open.filter((i) => isOverdue(i, now))
  if (open.length && overdue.length) {
    const share = overdue.length / open.length
    if (share > 0.2 && overdue.length >= 3) level = Math.max(level, 2)
    else if (share > 0.05 || overdue.length >= 3) level = Math.max(level, 1)
    reasons.push(`${overdue.length} overdue of ${open.length} open`)
  }
  if (input.activeSprint) {
    const elapsed = sprintElapsed(input.activeSprint, now)
    const { total, done } = input.activeSprint
    if (total > 0 && elapsed > 0.2) {
      const progress = done / total
      const gap = elapsed - progress
      if (gap > 0.35) level = Math.max(level, 2)
      else if (gap > 0.15) level = Math.max(level, 1)
      reasons.push(`sprint ${Math.round(progress * 100)}% done at ${Math.round(elapsed * 100)}% of its time`)
    }
  }
  if (!reasons.length) reasons.push(input.items.length ? 'nothing overdue' : 'no work items yet')
  return { health: (['on-track', 'at-risk', 'off-track'] as const)[level], reasons }
}

export interface HealthOverride {
  health: Health
  note?: string
  by?: string
  at: string
  /** Optional expiry — after it, the derived value shows again. */
  until?: string | null
}

export function effectiveHealth(derived: HealthSignal, override?: HealthOverride | null, now = Date.now()): HealthSignal & { overridden: boolean } {
  if (override && (!override.until || (toMs(override.until) ?? 0) + DAY_MS > now)) {
    return { health: override.health, reasons: [override.note ? `set manually: ${override.note}` : 'set manually'], overridden: true }
  }
  return { ...derived, overridden: false }
}

/* ───── workload ───── */

export interface WorkloadRow {
  member: string
  open: number
  inProgress: number
  points: number
  overdue: number
  projects: string[]
  /** Weekly capacity in points, when recorded. */
  capacity: number | null
  over: boolean
}

export function workload(input: {
  items: WorkItem[]
  points?: Record<string, number>
  capacity?: Record<string, number>
  now?: number
}): WorkloadRow[] {
  const now = input.now ?? Date.now()
  const rows = new Map<string, WorkloadRow & { _p: Set<string> }>()
  for (const i of input.items) {
    if (isClosed(i)) continue
    for (const a of i.assignees) {
      let r = rows.get(a)
      if (!r) {
        r = { member: a, open: 0, inProgress: 0, points: 0, overdue: 0, projects: [], capacity: input.capacity?.[a] ?? null, over: false, _p: new Set() }
        rows.set(a, r)
      }
      r.open += 1
      if (i.state_group === 'started') r.inProgress += 1
      r.points += (pointsOf(i, input.points) ?? 0) / i.assignees.length
      if (isOverdue(i, now)) r.overdue += 1
      if (i.project) r._p.add(i.project)
    }
  }
  return [...rows.values()]
    .map(({ _p, ...r }) => ({
      ...r,
      points: round(r.points),
      projects: [..._p],
      over: r.capacity !== null && r.capacity > 0 ? r.points > r.capacity : r.inProgress > 5,
    }))
    .sort((a, b) => Number(b.over) - Number(a.over) || b.open - a.open)
}

/* ───── availability ───── */

export interface Absence {
  from: DayKey
  to: DayKey
  note?: string
}

/** Workdays inside [start, end] that fall in any absence. */
export function daysOffIn(absences: Absence[] | undefined, start: number, end: number): number {
  if (!absences?.length) return 0
  const days = eachDay(start, end).filter((d) => {
    const w = new Date(d).getUTCDay()
    return w !== 0 && w !== 6
  })
  return days.filter((d) => {
    const k = dayKey(d)
    return absences.some((a) => a.from <= k && k <= a.to)
  }).length
}

/* ───── intake SLA ───── */

export interface SlaPolicy {
  /** Hours to triage, per priority; `default` covers the rest. */
  hours: Partial<Record<'urgent' | 'high' | 'medium' | 'low' | 'none' | 'default', number>>
}

export const DEFAULT_SLA: SlaPolicy = { hours: { urgent: 4, high: 24, medium: 72, low: 120, default: 120 } }

export interface SlaState {
  dueAt: number
  remainingMs: number
  breached: boolean
  /** Share of the window used, 0–1+. */
  used: number
}

export function slaState(createdAt: string, priority: string | undefined, policy: SlaPolicy = DEFAULT_SLA, now = Date.now()): SlaState | null {
  const c = toMs(createdAt)
  if (c === undefined) return null
  const p = (priority ?? 'none') as keyof SlaPolicy['hours']
  const hours = policy.hours[p] ?? policy.hours.default
  if (!hours || hours <= 0) return null
  const dueAt = c + hours * 3_600_000
  return { dueAt, remainingMs: dueAt - now, breached: now > dueAt, used: (now - c) / (dueAt - c) }
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  const h = Math.floor(abs / 3_600_000)
  if (h >= 48) return `${Math.floor(h / 24)}d`
  if (h >= 1) return `${h}h`
  return `${Math.max(1, Math.floor(abs / 60_000))}m`
}

/* ───── labels ───── */

/** Bug-ish labels: "bug", "defect", "incident", "regression". */
export function isBugLabel(name: string): boolean {
  return /\b(bug|defect|incident|regression)s?\b/i.test(name)
}

/**
 * Burnup for a long-running container (epic, release) that has no snapshots:
 * scope grows with each item's creation date, completed with its completion
 * date. Items added to the container long after creation therefore count
 * from creation — the view says so.
 */
export function burnupByCreation(input: { items: WorkItem[]; start?: string | null; end?: string | null; now?: number }): { days: number[]; scope: Array<number | null>; completed: Array<number | null> } | null {
  const now = input.now ?? Date.now()
  const live = input.items.filter((i) => !isCancelled(i))
  if (!live.length) return null
  const firstCreated = Math.min(...live.map((i) => toMs(i.created_at) ?? now))
  const s = toMs(input.start) ?? firstCreated
  const e = Math.max(toMs(input.end) ?? now, s)
  const days = eachDay(s, e)
  // Keep the chart readable on long epics: at most ~120 points.
  const step = Math.max(1, Math.ceil(days.length / 120))
  const picked = days.filter((_, k) => k % step === 0 || k === days.length - 1)
  const scope = picked.map((d) => (d > now ? null : live.filter((i) => (toMs(i.created_at) ?? 0) <= d + DAY_MS - 1).length))
  const completed = picked.map((d) => (d > now ? null : live.filter((i) => doneBy(i, d + DAY_MS - 1)).length))
  return { days: picked, scope, completed }
}

/* ───── wall clock ─────
 * The planning math buckets by calendar day in UTC. To bucket by the
 * viewer's own calendar, shift instants by their timezone offset first
 * ("wall-clock time written as UTC"); date-only values need no shift.
 */

/** `Date.now()` as wall-clock-as-UTC for a timezone offset (minutes, as `getTimezoneOffset`). */
export function wallNow(offsetMin = new Date().getTimezoneOffset(), now = Date.now()): number {
  return now - offsetMin * 60_000
}

/** A datetime as wall-clock-as-UTC ISO; date-only values and nulls pass through. */
export function wallIso(v: string | null | undefined, offsetMin?: number): string | null | undefined {
  if (!v || v.length === 10) return v
  const ms = Date.parse(v)
  if (!Number.isFinite(ms)) return v
  const off = offsetMin ?? new Date(ms).getTimezoneOffset()
  return new Date(ms - off * 60_000).toISOString()
}

/** A sprint/epic date as the viewer's calendar day (`YYYY-MM-DD`). */
export function wallDay(v: string | null | undefined, offsetMin?: number): string | null | undefined {
  const w = wallIso(v, offsetMin)
  return w && w.length > 10 ? w.slice(0, 10) : w
}

/** Work items with their instants moved to wall-clock-as-UTC. */
export function wallItems<T extends WorkItem>(items: T[], offsetMin?: number): T[] {
  return items.map((i) => ({ ...i, created_at: wallIso(i.created_at, offsetMin) ?? i.created_at, completed_at: wallIso(i.completed_at, offsetMin) ?? null }))
}
