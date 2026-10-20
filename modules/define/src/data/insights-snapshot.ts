import { DAY, dayKey, type Group, GROUPS, type Segment, toMs, type WorkItem } from './insights-math.ts'

/**
 * Console-side daily snapshots of each project's issue states
 * (docStore kind `define.snapshot`).
 *
 * Plane's public API only exposes state history one issue at a time
 * (`…/issues/<id>/activities/`), which a cumulative-flow diagram over a whole
 * project cannot afford under the shared 60 req/min key. So whenever someone
 * loads a project's issues in Define, the console records that day's state of
 * every issue — at most once per project per day, piggy-backing on data it
 * already fetched (no extra Plane calls). History therefore starts on the
 * first day anyone looked, and the reports say so.
 *
 * Storage: ONE document per project per month (`<projectId>.<YYYY-MM>`), read
 * by id, so a report fetches only the months it draws. Per day:
 *   `c`  issue count per state group
 *   `p`  estimate points per state group
 *   `s`  compact per-issue states: `seq:stateIndex` pairs, comma-separated,
 *        indexing into the month's `states` list (≈6 bytes an issue).
 */

export const SNAPSHOT_KIND = 'define.snapshot'

export interface SnapshotDay {
  /** ISO timestamp the snapshot was taken. */
  at: string
  c: Partial<Record<Group, number>>
  p: Partial<Record<Group, number>>
  s: string
}

export interface SnapshotMonth {
  project: string
  /** `YYYY-MM` */
  month: string
  /** State ids referenced by `s` indexes. */
  states: string[]
  /** State id → group, so old months still read after a workflow change. */
  groups: Record<string, Group>
  days: Record<string, SnapshotDay>
}

export const monthKey = (ms: number) => dayKey(ms).slice(0, 7)
export const snapshotId = (project: string, month: string) => `${project}.${month}`

/** Months (`YYYY-MM`) touched by [from, to], oldest first. */
export function monthsBetween(from: number, to: number): string[] {
  const out: string[] = []
  const d = new Date(from)
  let y = d.getUTCFullYear()
  let m = d.getUTCMonth()
  const end = monthKey(to)
  for (let k = 0; k < 36; k++) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}`
    out.push(key)
    if (key >= end) break
    m++
    if (m === 12) {
      m = 0
      y++
    }
  }
  return out
}

/**
 * Record today's state of `items` into `doc` (creating it when absent).
 * Returns null when today is already recorded — nothing to write.
 */
export function recordDay(
  doc: SnapshotMonth | null,
  project: string,
  items: WorkItem[],
  now: number,
): SnapshotMonth | null {
  const day = dayKey(now)
  const month = monthKey(now)
  const base: SnapshotMonth = doc && doc.month === month
    ? { ...doc, states: [...doc.states], groups: { ...doc.groups }, days: { ...doc.days } }
    : { project, month, states: [], groups: {}, days: {} }
  if (base.days[day]) return null
  const c: Partial<Record<Group, number>> = {}
  const p: Partial<Record<Group, number>> = {}
  const pairs: string[] = []
  for (const i of items) {
    c[i.group] = (c[i.group] ?? 0) + 1
    if (i.points) p[i.group] = (p[i.group] ?? 0) + i.points
    if (i.seq == null) continue
    let idx = base.states.indexOf(i.state)
    if (idx < 0) {
      idx = base.states.length
      base.states.push(i.state)
    }
    base.groups[i.state] = i.group
    pairs.push(`${i.seq}:${idx}`)
  }
  base.days[day] = { at: new Date(now).toISOString(), c, p, s: pairs.join(',') }
  return base
}

export interface DayState {
  t: number
  counts: Partial<Record<Group, number>>
  points: Partial<Record<Group, number>>
  /** sequence id → state id */
  issues: Map<number, string>
  groups: Record<string, Group>
}

/** Flatten month docs into ordered days. */
export function readDays(months: Array<SnapshotMonth | null | undefined>): DayState[] {
  const out: DayState[] = []
  for (const m of months) {
    if (!m) continue
    for (const [d, v] of Object.entries(m.days)) {
      const issues = new Map<number, string>()
      for (const pair of v.s ? v.s.split(',') : []) {
        const [seq, idx] = pair.split(':').map(Number)
        const st = m.states[idx]
        if (Number.isFinite(seq) && st) issues.set(seq, st)
      }
      out.push({ t: toMs(d)!, counts: v.c ?? {}, points: v.p ?? {}, issues, groups: m.groups })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Cumulative-flow series (one per group) from snapshot days. */
export function cfd(days: DayState[], metric: 'count' | 'points' = 'count', groups: Group[] = GROUPS.filter((g) => g !== 'cancelled')) {
  return groups.map((g) => ({
    group: g,
    points: days.map((d) => [d.t, (metric === 'points' ? d.points[g] : d.counts[g]) ?? 0] as [number, number]),
  }))
}

/**
 * One issue's state segments from daily snapshots (day granularity): a state
 * seen on consecutive days is one segment, ending where the next begins.
 */
export function timelineFromDays(seq: number, days: DayState[], now: number): Segment[] {
  const segs: Segment[] = []
  for (const d of days) {
    const st = d.issues.get(seq)
    if (!st) continue
    const last = segs[segs.length - 1]
    if (last && last.state === st) {
      last.to = d.t + DAY
      continue
    }
    if (last) last.to = d.t
    segs.push({ state: st, group: d.groups[st] ?? 'backlog', from: d.t, to: d.t + DAY })
  }
  const last = segs[segs.length - 1]
  if (last && last.group !== 'completed' && last.group !== 'cancelled') last.to = Math.max(last.to, now)
  return segs
}
