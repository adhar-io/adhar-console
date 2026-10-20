/**
 * Board / backlog maths — columns from workflow states, WIP limits,
 * swimlanes, rank (Plane `sort_order`) and Trello-style card facts.
 * Pure so it is unit-tested in work-board_test.ts.
 */

export const STATE_GROUPS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const
export type StateGroup = (typeof STATE_GROUPS)[number]

export const GROUP_LABEL: Record<StateGroup, string> = {
  backlog: 'Backlog',
  unstarted: 'To do',
  started: 'In progress',
  completed: 'Done',
  cancelled: 'Cancelled',
}

export interface BoardState {
  id: string
  name: string
  color: string
  group: string
  sequence?: number
  project?: string
}

export interface BoardColumn {
  /** State id — or `group:<name>` for a cross-project board. */
  id: string
  label: string
  color?: string
  group: StateGroup
  /** State ids this column holds (several on a cross-project board). */
  stateIds: string[]
}

const groupIndex = (g: string) => {
  const i = STATE_GROUPS.indexOf(g as StateGroup)
  return i < 0 ? STATE_GROUPS.length : i
}

/**
 * One column per workflow state, ordered by state group then Plane's
 * sequence. With `byGroup` (states from several projects) there is one
 * column per group instead, since project workflows differ.
 */
export function boardColumns(states: BoardState[], byGroup = false): BoardColumn[] {
  const sorted = [...states].sort((a, b) => groupIndex(a.group) - groupIndex(b.group) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.name.localeCompare(b.name))
  if (!byGroup) {
    return sorted.map((s) => ({ id: s.id, label: s.name, color: s.color, group: (STATE_GROUPS.includes(s.group as StateGroup) ? s.group : 'backlog') as StateGroup, stateIds: [s.id] }))
  }
  const out: BoardColumn[] = []
  for (const g of STATE_GROUPS) {
    const ids = sorted.filter((s) => s.group === g).map((s) => s.id)
    if (ids.length) out.push({ id: `group:${g}`, label: GROUP_LABEL[g], group: g, stateIds: ids })
  }
  return out
}

/** Contiguous runs of columns sharing a state group — the header band above them. */
export function groupBands(columns: BoardColumn[]): Array<{ group: StateGroup; span: number; start: number }> {
  const out: Array<{ group: StateGroup; span: number; start: number }> = []
  columns.forEach((c, i) => {
    const last = out[out.length - 1]
    if (last && last.group === c.group) last.span++
    else out.push({ group: c.group, span: 1, start: i })
  })
  return out
}

/** The state a card dropped on a column lands in (for a group column, the project's first state of that group). */
export function targetState(column: BoardColumn, states: BoardState[], project: string): string | undefined {
  if (!column.id.startsWith('group:')) return column.id
  const own = states
    .filter((s) => column.stateIds.includes(s.id) && (!s.project || s.project === project))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  return own[0]?.id
}

export type WipStatus = 'none' | 'under' | 'at' | 'over'

/** WIP limit state for a column: no limit, under, exactly at, or breached. */
export function wipStatus(count: number, limit?: number | null): WipStatus {
  if (!limit || limit <= 0) return 'none'
  if (count > limit) return 'over'
  if (count === limit) return 'at'
  return 'under'
}

export type SwimlaneBy = 'none' | 'assignee' | 'epic' | 'priority'

export interface LaneIssue {
  id: string
  assignees: string[]
  module?: string | null
  priority: string
}

export interface Lane {
  id: string
  label: string
}

const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none']

/** The lane an issue sits in (first assignee, like Jira's single-assignee swimlanes). */
export function laneOf(issue: LaneIssue, by: SwimlaneBy): string {
  switch (by) {
    case 'assignee':
      return issue.assignees[0] ?? '_none'
    case 'epic':
      return issue.module ?? '_none'
    case 'priority':
      return issue.priority
    default:
      return '_all'
  }
}

/** Lanes that have cards, in a stable order: priority order / name, "none" last. */
export function swimlanes(
  issues: LaneIssue[],
  by: SwimlaneBy,
  names: { member?(id: string): string; epic?(id: string): string } = {},
): Lane[] {
  if (by === 'none') return [{ id: '_all', label: '' }]
  if (by === 'priority') {
    const present = new Set(issues.map((i) => i.priority))
    return PRIORITIES.filter((p) => present.has(p)).map((p) => ({ id: p, label: p === 'none' ? 'No priority' : p[0].toUpperCase() + p.slice(1) }))
  }
  const ids = [...new Set(issues.map((i) => laneOf(i, by)))]
  const label = (id: string) =>
    id === '_none' ? (by === 'assignee' ? 'Unassigned' : 'No epic') : (by === 'assignee' ? names.member?.(id) : names.epic?.(id)) ?? id.slice(0, 8)
  return ids
    .map((id) => ({ id, label: label(id) }))
    .sort((a, b) => (a.id === '_none' ? 1 : b.id === '_none' ? -1 : a.label.localeCompare(b.label)))
}

/* ───── rank (Plane sort_order) ───── */

/** Plane's own spacing between new items. */
export const RANK_STEP = 10_000
const MIN_GAP = 1e-6

/** A rank strictly between two neighbours; undefined when the gap is exhausted. */
export function rankBetween(prev?: number, next?: number): number | undefined {
  if (prev === undefined && next === undefined) return 65_535
  if (prev === undefined) return next! - RANK_STEP
  if (next === undefined) return prev + RANK_STEP
  if (next - prev <= MIN_GAP) return undefined
  return (prev + next) / 2
}

export interface Ranked {
  id: string
  sort_order?: number
}

/**
 * Move `movedId` to `toIndex` in `list` (an index into the list WITHOUT the
 * moved item). Returns the sort_order patches to send — normally just the
 * moved item at the midpoint of its new neighbours. When the neighbours have
 * no room left, or carry no rank at all, the whole list is renumbered at
 * RANK_STEP spacing and only the items whose rank changes are returned.
 */
export function planRank(list: Ranked[], movedId: string, toIndex: number): Array<{ id: string; sort_order: number }> {
  const rest = list.filter((x) => x.id !== movedId)
  const at = Math.max(0, Math.min(toIndex, rest.length))
  const prev = rest[at - 1]?.sort_order
  const next = rest[at]?.sort_order
  const missing = (at > 0 && prev === undefined) || (at < rest.length && next === undefined)
  const r = missing ? undefined : rankBetween(prev, next)
  if (r !== undefined) return [{ id: movedId, sort_order: r }]
  const ordered: Ranked[] = [...rest.slice(0, at), { id: movedId }, ...rest.slice(at)]
  const out: Array<{ id: string; sort_order: number }> = []
  ordered.forEach((x, i) => {
    const want = (i + 1) * RANK_STEP
    if (x.id === movedId || x.sort_order !== want) out.push({ id: x.id, sort_order: want })
  })
  return out
}

/** Rank order for a list (sort_order asc; unranked last, then newest first like Plane). */
export function byRank<T extends Ranked & { created_at?: string }>(a: T, b: T): number {
  const x = a.sort_order
  const y = b.sort_order
  if (x !== undefined && y !== undefined && x !== y) return x - y
  if (x === undefined && y !== undefined) return 1
  if (y === undefined && x !== undefined) return -1
  return (b.created_at ?? '').localeCompare(a.created_at ?? '')
}

/* ───── card facts ───── */

/** Children done / total per parent id, from the loaded items. */
export function subtaskProgress(
  issues: Array<{ id: string; parent?: string | null; state: string }>,
  groupOf: (stateId: string) => string | undefined,
): Map<string, { done: number; total: number }> {
  const out = new Map<string, { done: number; total: number }>()
  for (const i of issues) {
    if (!i.parent) continue
    const cur = out.get(i.parent) ?? { done: 0, total: 0 }
    const g = groupOf(i.state)
    if (g === 'cancelled') continue
    cur.total++
    if (g === 'completed') cur.done++
    out.set(i.parent, cur)
  }
  return out
}

/** Trello-style cover: the first image in the description (http(s) or data:image only). */
export function coverFromHtml(html?: string | null): string | undefined {
  if (!html) return undefined
  const m = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(html)
  const src = (m?.[2] ?? m?.[3] ?? '').trim()
  if (/^https?:\/\//i.test(src) || /^data:image\/(png|jpe?g|gif|webp);/i.test(src)) return src
  return undefined
}

/** Overdue = due before today and not done/cancelled. */
export function isOverdue(target: string | null | undefined, group: string | undefined, now = Date.now()): boolean {
  if (!target || group === 'completed' || group === 'cancelled') return false
  const end = Date.parse(target.length === 10 ? `${target}T23:59:59Z` : target)
  return Number.isFinite(end) && end < now
}

/** Sum of estimates, and how many items had one. */
export function estimateTotal(issues: Array<{ estimate_point?: number | null }>): { points: number; estimated: number; total: number } {
  let points = 0
  let estimated = 0
  for (const i of issues) {
    if (typeof i.estimate_point === 'number') {
      points += i.estimate_point
      estimated++
    }
  }
  return { points, estimated, total: issues.length }
}
