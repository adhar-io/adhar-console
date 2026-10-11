/**
 * Plane 1.x public-API response shaping.
 *
 * The public API (`/api/v1/…`, API-key auth) is narrower than the one Plane's
 * own web app uses, and several things the console needs are simply not in
 * its payloads. Everything that has to be derived lives here, as pure
 * functions, so the client stays a thin transport and this stays testable.
 *
 * Verified against makeplane/plane v1.4.2 (`apps/api/plane/api`):
 *   • cycles carry dates and per-group counts but no `status` or `progress`;
 *   • work items carry no cycle or module — membership is only readable from
 *     `cycles/<id>/cycle-issues/` and `modules/<id>/module-issues/`;
 *   • the issue list ignores `state`, `priority`, `cycle`… query filters;
 *   • workspace members come back as flat user records plus `role`, and the
 *     roles are 20 Admin, 15 Member, 5 Guest;
 *   • lists are cursor-paginated (`next_cursor` + `next_page_results`).
 */

export type CycleStatus = 'current' | 'upcoming' | 'completed' | 'draft'

/** Plane workspace roles (`plane.db.models.workspace.ROLE_CHOICES`). */
export const PLANE_ROLE = { ADMIN: 20, MEMBER: 15, GUEST: 5 } as const

/** Parse a Plane date or datetime; date-only values are treated as UTC days. */
function toMs(v: string | null | undefined): number | undefined {
  if (!v) return undefined
  const ms = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * The same buckets Plane's `cycle_view` filter uses: no dates is a draft,
 * a start in the future is upcoming, an end in the past is completed, and
 * anything spanning now is current. An end date counts through that whole day.
 */
export function cycleStatus(
  c: { start_date?: string | null; end_date?: string | null },
  now = Date.now(),
): CycleStatus {
  const start = toMs(c.start_date)
  let end = toMs(c.end_date)
  if (start === undefined && end === undefined) return 'draft'
  if (end !== undefined && c.end_date && c.end_date.length === 10) end += 86_400_000 - 1
  if (start !== undefined && start > now) return 'upcoming'
  if (end !== undefined && end < now) return 'completed'
  if (start === undefined) return 'draft'
  return 'current'
}

/** Completed share of the work that is still in scope (cancelled excluded), 0–100. */
export function cycleProgress(c: {
  total_issues?: number
  completed_issues?: number
  cancelled_issues?: number
}): number {
  const total = (c.total_issues ?? 0) - (c.cancelled_issues ?? 0)
  if (total <= 0) return 0
  return Math.round(((c.completed_issues ?? 0) / total) * 100)
}

/** Every key a Plane list response can hide its rows under, newest first. */
export function unwrapList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results)) {
    return (raw as { results: T[] }).results
  }
  return []
}

/** The cursor for the next page, or undefined when this was the last one. */
export function nextCursor(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as { next_cursor?: unknown; next_page_results?: unknown }
  if (r.next_page_results !== true) return undefined
  return typeof r.next_cursor === 'string' && r.next_cursor ? r.next_cursor : undefined
}

export interface RawWorkspaceMember {
  id: string
  first_name?: string
  last_name?: string
  email?: string
  display_name?: string
  avatar?: string | null
  avatar_url?: string | null
  role: number
  /** Older Plane builds nested the user. */
  member?: { id: string; email?: string; display_name?: string; first_name?: string; last_name?: string; avatar?: string | null }
}

/**
 * Shape a workspace member the way the console reads members: `id` and
 * `member.id` are both the USER id — the value Plane stores in `assignees`,
 * `lead` and `owned_by` — so lookups by either keep working.
 */
export function normalizeMember(raw: RawWorkspaceMember, workspace = '') {
  const user = raw.member ?? raw
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  const display = user.display_name || name || user.email?.split('@')[0] || 'Unknown'
  const avatar = (raw as { avatar_url?: string | null }).avatar_url ?? user.avatar ?? null
  return {
    id: user.id,
    member: {
      id: user.id,
      email: user.email ?? '',
      display_name: display,
      first_name: user.first_name,
      last_name: user.last_name,
      avatar,
    },
    email: user.email,
    display_name: display,
    avatar,
    role: raw.role,
    workspace,
  }
}

export interface IssueFilter {
  state?: string
  priority?: string
  assignees?: string[]
  cycle?: string
  module?: string
  has_target_date?: boolean
}

/** Filters Plane's issue list does not apply server-side. */
export function filterIssues<
  T extends {
    state: string
    priority: string
    assignees?: string[]
    target_date?: string | null
    cycle?: string | null
    module?: string | null
  },
>(rows: T[], f: IssueFilter | undefined): T[] {
  if (!f) return rows
  let out = rows
  if (f.state) out = out.filter((i) => i.state === f.state)
  if (f.priority) out = out.filter((i) => i.priority === f.priority)
  if (f.cycle) out = out.filter((i) => i.cycle === f.cycle)
  if (f.module) out = out.filter((i) => i.module === f.module)
  if (f.has_target_date) out = out.filter((i) => !!i.target_date)
  if (f.assignees?.length) {
    const want = new Set(f.assignees)
    out = out.filter((i) => (i.assignees ?? []).some((a) => want.has(a)))
  }
  return out
}

/**
 * Build issue → container maps from per-container membership lists. Plane
 * lets an issue sit in one cycle but several modules; the console shows one
 * module, so the first one listed wins (containers arrive in Plane's order).
 */
export function membershipIndex(groups: Array<{ id: string; issueIds: string[] }>): Map<string, string> {
  const out = new Map<string, string>()
  for (const g of groups) {
    for (const issue of g.issueIds) if (!out.has(issue)) out.set(issue, g.id)
  }
  return out
}

/** Plain text from Plane's HTML descriptions (the API omits `description_stripped`). */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
