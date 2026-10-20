import { defineClient, type HttpClient } from '../base/index.ts'
import { nextCursor, unwrapList } from './normalize.ts'

/**
 * Planning calls for the Define module — sprints, epics, roadmap, workload —
 * kept apart from the main Plane client so they can be read, tested and
 * reasoned about on their own.
 *
 * Every route below was checked against the fork the platform runs
 * (`adhar-io/plane` tag `adhar-v1.4.2-1`, `apps/api/plane/api/urls/*` and the
 * matching `views/*`):
 *
 *   • `projects/<p>/issues/?expand=state` — one call yields each issue's
 *     state group, so cross-project views do not need a states call per
 *     project, nor the cycle/module membership crawl `listIssues` performs.
 *   • `cycles/<c>/cycle-issues/` GET/POST `{issues}` and
 *     `cycle-issues/<issue>/` DELETE; the same shape for `module-issues`.
 *   • `cycles/<c>/` PATCH — refused once a cycle's end date has passed
 *     ("completed cycles can only change sort order"), so a sprint is
 *     completed early by moving its end date to now *before* transferring.
 *   • `cycles/<c>/transfer-issues/` `{new_cycle_id}` — only from ended cycles.
 *   • `project-members/` POST answers `{id, member, role}`: `id` is the
 *     ProjectMember pk that `project-members/<pk>/` PATCH/DELETE need. The
 *     list endpoints never expose it, so the console can only change or
 *     remove memberships whose pk it recorded when it added them.
 *   • `estimates/` is defined in `urls/estimate.py` but NOT included in
 *     `urls/__init__.py` — it 404s, and callers get `null` ("not available").
 *   • `work-items/<i>/relations/` GET returns relation lists keyed by type.
 */

export type StateGroupName = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

/** A work item as cross-project planning views need it. */
export interface PlanIssue {
  id: string
  name: string
  project: string
  sequence_id?: number
  state: string
  /** From `expand=state`; undefined when Plane did not expand it. */
  state_group?: StateGroupName
  state_name?: string
  state_color?: string
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
  assignees: string[]
  labels: string[]
  parent?: string | null
  start_date?: string | null
  target_date?: string | null
  completed_at?: string | null
  created_at: string
  updated_at?: string
  /** Plane 1.x: the id of an estimate point (unresolvable — see header). */
  estimate_point?: string | number | null
}

export interface ProjectMembership {
  /** ProjectMember pk — needed to change the role or remove the member. */
  id: string
  member: string
  role: number
}

export interface PlanRelations {
  blocking: string[]
  blocked_by: string[]
  start_before: string[]
  start_after: string[]
  finish_before: string[]
  finish_after: string[]
  relates_to: string[]
  duplicate: string[]
}

export interface PlanningClient {
  /** Every work item of a project with its state group; no membership crawl. */
  listPlanIssues(slug: string, project: string): Promise<PlanIssue[]>
  /** Ids of the work items in a cycle / module. */
  listCycleIssueIds(slug: string, project: string, cycle: string): Promise<string[]>
  listModuleIssueIds(slug: string, project: string, module: string): Promise<string[]>
  addCycleIssues(slug: string, project: string, cycle: string, issues: string[]): Promise<void>
  removeCycleIssue(slug: string, project: string, cycle: string, issue: string): Promise<void>
  addModuleIssues(slug: string, project: string, module: string, issues: string[]): Promise<void>
  removeModuleIssue(slug: string, project: string, module: string, issue: string): Promise<void>
  /** Set a cycle's dates (start sprint / reschedule / end now). ISO strings. */
  setCycleDates(slug: string, project: string, cycle: string, dates: { start_date?: string; end_date?: string }): Promise<void>
  /** Move a cycle's unfinished work to another cycle (the source must have ended). */
  transferCycle(slug: string, project: string, cycle: string, toCycle: string): Promise<void>
  /** Reschedule a work item (`YYYY-MM-DD` or null to clear). */
  setIssueDates(slug: string, project: string, issue: string, dates: { start_date?: string | null; target_date?: string | null }): Promise<void>
  /** Update a work item's state (automation, workflow moves). */
  setIssueState(slug: string, project: string, issue: string, state: string): Promise<void>
  /** Generic work-item patch used by automation actions. */
  patchIssue(slug: string, project: string, issue: string, patch: Record<string, unknown>): Promise<void>
  /** Reschedule an epic (module). */
  setModuleDates(slug: string, project: string, module: string, dates: { start_date?: string | null; target_date?: string | null }): Promise<void>
  /** Add a member to a project; answers the membership pk. */
  addProjectMembership(slug: string, project: string, member: string, role: number): Promise<ProjectMembership>
  setProjectMemberRole(slug: string, project: string, membership: string, role: number): Promise<void>
  removeProjectMembership(slug: string, project: string, membership: string): Promise<void>
  /** Estimate point values, or null when this Plane exposes no estimates route. */
  estimatePoints(slug: string, project: string): Promise<Array<{ id: string; value: string }> | null>
  /** Relations of one work item, flattened to issue ids per type. */
  relationsOf(slug: string, project: string, issue: string): Promise<PlanRelations>
}

const MAX_PAGES = 40

/** Plane's issue row with `expand=state` folded back into flat fields. */
export function toPlanIssue(raw: Record<string, unknown>): PlanIssue {
  const st = raw.state
  const stateObj = st && typeof st === 'object' ? st as { id?: string; group?: string; name?: string; color?: string } : undefined
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? String((x as { id?: unknown }).id ?? '') : String(x))).filter(Boolean) : []
  const proj = raw.project
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    project: proj && typeof proj === 'object' ? String((proj as { id?: unknown }).id) : String(proj ?? ''),
    sequence_id: typeof raw.sequence_id === 'number' ? raw.sequence_id : undefined,
    state: stateObj ? String(stateObj.id ?? '') : String(st ?? ''),
    state_group: (stateObj?.group ?? (typeof raw.state_group === 'string' ? raw.state_group : undefined)) as StateGroupName | undefined,
    state_name: stateObj?.name,
    state_color: stateObj?.color,
    priority: (typeof raw.priority === 'string' ? raw.priority : 'none') as PlanIssue['priority'],
    assignees: ids(raw.assignees),
    labels: ids(raw.labels),
    parent: (raw.parent as string | null | undefined) ?? null,
    start_date: (raw.start_date as string | null | undefined) ?? null,
    target_date: (raw.target_date as string | null | undefined) ?? null,
    completed_at: (raw.completed_at as string | null | undefined) ?? null,
    created_at: String(raw.created_at ?? ''),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
    estimate_point: (raw.estimate_point as string | number | null | undefined) ?? null,
  }
}

export function toPlanRelations(raw: unknown): PlanRelations {
  const out: PlanRelations = {
    blocking: [],
    blocked_by: [],
    start_before: [],
    start_after: [],
    finish_before: [],
    finish_after: [],
    relates_to: [],
    duplicate: [],
  }
  if (!raw || typeof raw !== 'object') return out
  for (const k of Object.keys(out) as Array<keyof PlanRelations>) {
    const v = (raw as Record<string, unknown>)[k]
    if (Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === 'string' ? x : String((x as { issue_id?: unknown; id?: unknown })?.issue_id ?? (x as { id?: unknown })?.id ?? ''))).filter(Boolean)
    }
  }
  return out
}

function buildPlanning(http: HttpClient): PlanningClient {
  const ws = (slug: string) => `/api/v1/workspaces/${slug}`
  const proj = (slug: string, p: string) => `${ws(slug)}/projects/${p}`
  const list = async <T>(path: string, query = ''): Promise<T[]> => {
    const out: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const sep = query ? `?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}` : cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const raw = await http.get<unknown>(`${path}${sep}`)
      out.push(...unwrapList<T>(raw))
      cursor = nextCursor(raw)
      if (!cursor) break
    }
    return out
  }
  return {
    listPlanIssues: async (slug, p) =>
      (await list<Record<string, unknown>>(`${proj(slug, p)}/issues/`, 'expand=state')).map(toPlanIssue),
    listCycleIssueIds: async (slug, p, c) =>
      (await list<{ id: string }>(`${proj(slug, p)}/cycles/${c}/cycle-issues/`, 'fields=id')).map((r) => r.id),
    listModuleIssueIds: async (slug, p, m) =>
      (await list<{ id: string }>(`${proj(slug, p)}/modules/${m}/module-issues/`, 'fields=id')).map((r) => r.id),
    addCycleIssues: async (slug, p, c, issues) => {
      if (!issues.length) return
      await http.post<unknown>(`${proj(slug, p)}/cycles/${c}/cycle-issues/`, { issues })
    },
    removeCycleIssue: async (slug, p, c, issue) => {
      await http.delete<void>(`${proj(slug, p)}/cycles/${c}/cycle-issues/${issue}/`)
    },
    addModuleIssues: async (slug, p, m, issues) => {
      if (!issues.length) return
      await http.post<unknown>(`${proj(slug, p)}/modules/${m}/module-issues/`, { issues })
    },
    removeModuleIssue: async (slug, p, m, issue) => {
      await http.delete<void>(`${proj(slug, p)}/modules/${m}/module-issues/${issue}/`)
    },
    setCycleDates: async (slug, p, c, dates) => {
      await http.patch<unknown>(`${proj(slug, p)}/cycles/${c}/`, dates)
    },
    transferCycle: async (slug, p, c, to) => {
      await http.post<unknown>(`${proj(slug, p)}/cycles/${c}/transfer-issues/`, { new_cycle_id: to })
    },
    setIssueDates: async (slug, p, issue, dates) => {
      await http.patch<unknown>(`${proj(slug, p)}/issues/${issue}/`, dates)
    },
    setIssueState: async (slug, p, issue, state) => {
      await http.patch<unknown>(`${proj(slug, p)}/issues/${issue}/`, { state })
    },
    patchIssue: async (slug, p, issue, patch) => {
      await http.patch<unknown>(`${proj(slug, p)}/issues/${issue}/`, patch)
    },
    setModuleDates: async (slug, p, m, dates) => {
      await http.patch<unknown>(`${proj(slug, p)}/modules/${m}/`, dates)
    },
    addProjectMembership: (slug, p, member, role) =>
      http.post<ProjectMembership>(`${proj(slug, p)}/project-members/`, { member, role }),
    setProjectMemberRole: async (slug, p, pk, role) => {
      await http.patch<unknown>(`${proj(slug, p)}/project-members/${pk}/`, { role })
    },
    removeProjectMembership: async (slug, p, pk) => {
      await http.delete<void>(`${proj(slug, p)}/project-members/${pk}/`)
    },
    estimatePoints: async (slug, p) => {
      let estimate: { id?: string } | undefined
      try {
        estimate = await http.get<{ id?: string }>(`${proj(slug, p)}/estimates/`)
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null
        throw e
      }
      if (!estimate?.id) return []
      return list<{ id: string; value: string }>(`${proj(slug, p)}/estimates/${estimate.id}/estimate-points/`)
    },
    relationsOf: async (slug, p, issue) =>
      toPlanRelations(await http.get<unknown>(`${proj(slug, p)}/work-items/${issue}/relations/`)),
  }
}

/* ───── offline stub (tests / `mode: 'stub'` only) ───── */

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const STUB_ISSUES: PlanIssue[] = [
  { id: 'iss-1', name: 'Redesign project cards', project: 'proj-con', sequence_id: 1, state: 'st-progress', state_group: 'started', priority: 'high', assignees: ['u-1'], labels: [], start_date: day(-3), target_date: day(4), created_at: day(-10) },
  { id: 'iss-2', name: 'Plane client pagination', project: 'proj-con', sequence_id: 2, state: 'st-done', state_group: 'completed', priority: 'medium', assignees: ['u-2'], labels: [], start_date: day(-9), target_date: day(-2), completed_at: day(-2), created_at: day(-12) },
]
const stubMemberships = new Map<string, ProjectMembership>()

export const PlanningClient = defineClient<PlanningClient>(buildPlanning, () => ({
  listPlanIssues: (_s, p) => Promise.resolve(STUB_ISSUES.filter((i) => i.project === p)),
  listCycleIssueIds: () => Promise.resolve(STUB_ISSUES.map((i) => i.id)),
  listModuleIssueIds: () => Promise.resolve([]),
  addCycleIssues: () => Promise.resolve(),
  removeCycleIssue: () => Promise.resolve(),
  addModuleIssues: () => Promise.resolve(),
  removeModuleIssue: () => Promise.resolve(),
  setCycleDates: () => Promise.resolve(),
  transferCycle: () => Promise.resolve(),
  setIssueDates: () => Promise.resolve(),
  setIssueState: () => Promise.resolve(),
  patchIssue: () => Promise.resolve(),
  setModuleDates: () => Promise.resolve(),
  addProjectMembership: (_s, p, member, role) => {
    const m = { id: `pm-${p}-${member}`, member, role }
    stubMemberships.set(m.id, m)
    return Promise.resolve(m)
  },
  setProjectMemberRole: () => Promise.resolve(),
  removeProjectMembership: (_s, _p, pk) => {
    stubMemberships.delete(pk)
    return Promise.resolve()
  },
  estimatePoints: () => Promise.resolve(null),
  relationsOf: () => Promise.resolve(toPlanRelations({})),
}))
