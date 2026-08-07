import type { plane } from '@adhar-console/api-clients'
import { memberDisplayName } from './plane.ts'

/**
 * Shared shape for a Saved View's `query_data`. Both the Issues board and the
 * Saved Views page read/write this so a view can capture a real filter set and
 * re-apply it — the Issues board initializes its filters from a view, and the
 * "Save view" flow serializes the board's live filters back into `query_data`.
 */

export type IssueGroupBy = 'state' | 'priority' | 'assignee' | 'label' | 'cycle' | 'module'
export type IssueSortBy = 'updated' | 'created' | 'priority' | 'target' | 'estimate'

export interface SavedIssueQuery {
  priority?: plane.Priority
  /** State id. */
  state?: string
  /** Label id. */
  label?: string
  /** Member id. */
  assignee?: string
  group_by?: IssueGroupBy
  sort_by?: IssueSortBy
}

/** Serialize a filter set into a Plane `query_data` record, dropping empties. */
export function buildIssueQuery(q: SavedIssueQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (q.priority) out.priority = q.priority
  if (q.state) out.state = q.state
  if (q.label) out.label = q.label
  if (q.assignee) out.assignee = q.assignee
  if (q.group_by && q.group_by !== 'state') out.group_by = q.group_by
  if (q.sort_by && q.sort_by !== 'updated') out.sort_by = q.sort_by
  return out
}

/** Parse a stored `query_data` record back into a typed filter set. */
export function readIssueQuery(query: Record<string, unknown> | undefined): SavedIssueQuery {
  const q = query ?? {}
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return {
    priority: str(q.priority) as plane.Priority | undefined,
    state: str(q.state),
    label: str(q.label),
    assignee: str(q.assignee),
    group_by: str(q.group_by) as IssueGroupBy | undefined,
    sort_by: str(q.sort_by) as IssueSortBy | undefined,
  }
}

export function isEmptyQuery(query: Record<string, unknown> | undefined): boolean {
  return Object.keys(readIssueQueryDefined(query)).length === 0
}

function readIssueQueryDefined(query: Record<string, unknown> | undefined): Record<string, string> {
  const q = readIssueQuery(query)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(q)) if (v) out[k] = v as string
  return out
}

export interface ChipContext {
  states?: plane.State[]
  labels?: plane.Label[]
  members?: plane.Member[]
}

const GROUP_LABEL: Record<IssueGroupBy, string> = {
  state: 'State',
  priority: 'Priority',
  assignee: 'Assignee',
  label: 'Label',
  cycle: 'Cycle',
  module: 'Module',
}
const SORT_LABEL: Record<IssueSortBy, string> = {
  updated: 'Recently updated',
  created: 'Recently created',
  priority: 'Priority',
  target: 'Target date',
  estimate: 'Estimate',
}

/** Human-readable chips for a stored query, resolving ids to names. */
export function issueQueryChips(
  query: Record<string, unknown> | undefined,
  ctx: ChipContext = {},
): Array<{ key: string; value: string }> {
  const q = readIssueQuery(query)
  const chips: Array<{ key: string; value: string }> = []
  if (q.priority) chips.push({ key: 'Priority', value: q.priority })
  if (q.state) {
    const name = ctx.states?.find((s) => s.id === q.state)?.name
    chips.push({ key: 'State', value: name ?? q.state })
  }
  if (q.label) {
    const name = ctx.labels?.find((l) => l.id === q.label)?.name
    chips.push({ key: 'Label', value: name ?? q.label })
  }
  if (q.assignee) {
    const m = ctx.members?.find((x) => (x.member?.id ?? x.id) === q.assignee)
    chips.push({ key: 'Assignee', value: m ? memberDisplayName(m) : q.assignee })
  }
  if (q.group_by) chips.push({ key: 'Group', value: GROUP_LABEL[q.group_by] })
  if (q.sort_by) chips.push({ key: 'Sort', value: SORT_LABEL[q.sort_by] })
  return chips
}
