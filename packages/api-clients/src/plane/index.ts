import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'
import {
  cycleProgress,
  cycleStatus,
  filterIssues,
  membershipIndex,
  nextCursor,
  normalizeMember,
  type RawWorkspaceMember,
  stripHtml,
  unwrapList,
} from './normalize.ts'

export { cycleProgress, cycleStatus, PLANE_ROLE, stripHtml } from './normalize.ts'

/**
 * Plane.so v1 API client — every shape mirrors the upstream JSON the apiserver
 * returns at https://api.plane.so/api/v1 (or self-hosted equivalent). Field
 * names use the snake_case the backend serializes; `assignees` / `labels` are
 * UUID arrays you cross-reference against `listMembers` / `listLabels`.
 *
 * Auth: pass `token` in HttpClientOptions — Plane uses bearer tokens minted
 * from the personal-access-token settings page.
 */

/* ───────────────────────────── Schemas ───────────────────────────── */

export const PrioritySchema = z.enum(['urgent', 'high', 'medium', 'low', 'none'])
export type Priority = z.infer<typeof PrioritySchema>

export const StateGroupSchema = z.enum([
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
])
export type StateGroup = z.infer<typeof StateGroupSchema>

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  organization_size: z.number().optional(),
  total_members: z.number().optional(),
  total_projects: z.number().optional(),
  logo_url: z.string().nullable().optional(),
  created_at: z.string().optional(),
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  identifier: z.string(),
  description: z.string().optional(),
  description_text: z.string().optional(),
  workspace: z.string(),
  workspace_slug: z.string().optional(),
  network: z.number().optional(), // 0=private, 2=public
  emoji: z.string().nullable().optional(),
  cover_image: z.string().nullable().optional(),
  module_view: z.boolean().optional(),
  cycle_view: z.boolean().optional(),
  issue_views_view: z.boolean().optional(),
  page_view: z.boolean().optional(),
  inbox_view: z.boolean().optional(),
  /** Plane ≥ 0.23 name for the triage queue toggle (was `inbox_view`). */
  intake_view: z.boolean().optional(),
  archived_at: z.string().nullable().optional(),
  archive_in: z.number().optional(),
  close_in: z.number().optional(),
  default_assignee: z.string().nullable().optional(),
  project_lead: z.string().nullable().optional(),
  total_members: z.number().optional(),
  total_cycles: z.number().optional(),
  total_modules: z.number().optional(),
  is_member: z.boolean().optional(),
  member_role: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})
export type Project = z.infer<typeof ProjectSchema>

export const StateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  color: z.string(),
  workspace: z.string(),
  project: z.string(),
  sequence: z.number().optional(),
  group: StateGroupSchema,
  default: z.boolean().optional(),
})
export type State = z.infer<typeof StateSchema>

export const LabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  parent: z.string().nullable().optional(),
  project: z.string(),
})
export type Label = z.infer<typeof LabelSchema>

export const IssueSchema = z.object({
  id: z.string(),
  name: z.string(),
  description_html: z.string().optional(),
  description_stripped: z.string().optional(),
  priority: PrioritySchema,
  /** UUID of the matching State on this project. */
  state: z.string(),
  /** UUIDs of assigned members. */
  assignees: z.array(z.string()).default([]),
  /** UUIDs of labels. */
  labels: z.array(z.string()).default([]),
  /**
   * The estimate's numeric value. Plane 1.x sends the id of an estimate point
   * instead; the client resolves it (see `estimate_point_id`).
   */
  estimate_point: z.number().nullable().optional(),
  /** The Plane estimate point id behind `estimate_point` (set by the client). */
  estimate_point_id: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  archived_at: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  cycle: z.string().nullable().optional(),
  module: z.string().nullable().optional(),
  project: z.string(),
  workspace: z.string(),
  /** Sequential numeric identifier within a project — `CON-42`. */
  sequence_id: z.number().optional(),
  created_by: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  sub_issues_count: z.number().optional(),
  attachment_count: z.number().optional(),
  link_count: z.number().optional(),
})
export type Issue = z.infer<typeof IssueSchema>

export const CycleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  owned_by: z.string().optional(),
  archived_at: z.string().nullable().optional(),
  status: z.enum(['current', 'upcoming', 'completed', 'draft']),
  project: z.string(),
  workspace: z.string(),
  total_issues: z.number().optional(),
  cancelled_issues: z.number().optional(),
  completed_issues: z.number().optional(),
  started_issues: z.number().optional(),
  unstarted_issues: z.number().optional(),
  backlog_issues: z.number().optional(),
  /** 0–100, derived by the client from the issue counts (Plane sends none). */
  progress: z.number().optional(),
})
export type Cycle = z.infer<typeof CycleSchema>

export const ModuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  start_date: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  status: z.enum(['backlog', 'planned', 'in-progress', 'paused', 'completed', 'cancelled']),
  lead: z.string().nullable().optional(),
  members: z.array(z.string()).default([]),
  total_issues: z.number().optional(),
  completed_issues: z.number().optional(),
  cancelled_issues: z.number().optional(),
  started_issues: z.number().optional(),
  unstarted_issues: z.number().optional(),
  backlog_issues: z.number().optional(),
  project: z.string(),
  workspace: z.string(),
  archived_at: z.string().nullable().optional(),
})
export type Module = z.infer<typeof ModuleSchema>

export const PageSchema = z.object({
  id: z.string(),
  name: z.string(),
  description_html: z.string().optional(),
  description_stripped: z.string().optional(),
  owned_by: z.string(),
  access: z.enum(['public', 'private']),
  parent: z.string().nullable().optional(),
  archived_at: z.string().nullable().optional(),
  blocks: z.array(z.unknown()).default([]),
  labels: z.array(z.string()).default([]),
  project: z.string(),
  workspace: z.string(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  is_locked: z.boolean().optional(),
  is_favorite: z.boolean().optional(),
})
export type Page = z.infer<typeof PageSchema>

export const CommentSchema = z.object({
  id: z.string(),
  comment_html: z.string().optional(),
  comment_stripped: z.string().optional(),
  actor: z.string(),
  actor_detail: z
    .object({
      id: z.string(),
      display_name: z.string().optional(),
      avatar: z.string().nullable().optional(),
      email: z.string().optional(),
    })
    .optional(),
  issue: z.string(),
  project: z.string(),
  workspace: z.string(),
  created_at: z.string(),
  updated_at: z.string().optional(),
})
export type Comment = z.infer<typeof CommentSchema>

export const ActivitySchema = z.object({
  id: z.string(),
  verb: z.string(),
  field: z.string().nullable().optional(),
  old_value: z.string().nullable().optional(),
  new_value: z.string().nullable().optional(),
  comment: z.string().optional(),
  actor: z.string(),
  actor_detail: z
    .object({
      display_name: z.string().optional(),
      email: z.string().optional(),
      avatar: z.string().nullable().optional(),
    })
    .optional(),
  issue: z.string().optional(),
  created_at: z.string(),
})
export type Activity = z.infer<typeof ActivitySchema>

export const ViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  query_data: z.record(z.unknown()).default({}),
  project: z.string(),
  workspace: z.string(),
  access: z.enum(['public', 'private']).optional(),
  created_at: z.string().optional(),
})
export type View = z.infer<typeof ViewSchema>

export const MemberSchema = z.object({
  id: z.string(),
  /** Plane sometimes returns `member` as a nested object, sometimes flat. */
  member: z
    .object({
      id: z.string(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string(),
      display_name: z.string().optional(),
      avatar: z.string().nullable().optional(),
    })
    .optional(),
  /** Flat fallback when `member` isn't expanded. */
  email: z.string().optional(),
  display_name: z.string().optional(),
  avatar: z.string().nullable().optional(),
  /** Plane RBAC: 20 Admin, 15 Member, 5 Guest. */
  role: z.number(),
  workspace: z.string(),
})
export type Member = z.infer<typeof MemberSchema>

/* Plane API responses sometimes paginate via `{count, next, previous, results}` */
const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    count: z.number().optional(),
    next: z.string().nullable().optional(),
    previous: z.string().nullable().optional(),
    results: z.array(item),
  })

/* ───────────────────────────── Client ───────────────────────────── */

export const EstimatePointSchema = z.object({
  id: z.string(),
  key: z.number().optional(),
  value: z.string(),
  description: z.string().optional(),
})
export type EstimatePoint = z.infer<typeof EstimatePointSchema>


/* ───── triage, links, relations, search, stickies (Plane public API v1) ───── */

/** Intake (triage) status: -2 pending, -1 declined, 0 snoozed, 1 accepted, 2 duplicate. */
export type IntakeStatus = -2 | -1 | 0 | 1 | 2
export interface IntakeItem {
  id: string
  /** The underlying work item's id — the key every intake call uses. */
  issue: string
  status: IntakeStatus
  snoozed_till?: string | null
  duplicate_to?: string | null
  source?: string | null
  created_at: string
  created_by?: string | null
  issue_detail?: Partial<Issue> & { id: string; name: string; sequence_id?: number; priority?: Priority; description_html?: string; created_by?: string }
}

export interface IssueLink {
  id: string
  url: string
  title?: string | null
  metadata?: Record<string, unknown>
  created_at: string
  created_by?: string | null
}

export type RelationType = 'blocking' | 'blocked_by' | 'duplicate' | 'relates_to' | 'start_before' | 'start_after' | 'finish_before' | 'finish_after'
/** Relations of one issue, grouped by type; each entry names the other issue. */
export type IssueRelations = Record<RelationType, Array<{ project_id: string; issue_id: string }>>

export interface SearchHit {
  id: string
  name: string
  sequence_id: number
  project_id: string
  project__identifier: string
}

export interface ProjectMemberLite {
  /** The USER id (Plane's lite serializer flattens the member). */
  id: string
  display_name?: string
  first_name?: string
  last_name?: string
  email?: string
  avatar_url?: string | null
  role: number
  is_active?: boolean
  is_bot?: boolean
}

export interface ProjectSummary {
  id: string
  name: string
  identifier: string
  counts: Partial<Record<'members' | 'states' | 'labels' | 'cycles' | 'modules' | 'issues' | 'intakes' | 'pages', number>>
}

export interface Sticky {
  id: string
  name?: string | null
  description_html?: string
  description_stripped?: string | null
  color?: string | null
  background_color?: string | null
  sort_order?: number
  created_at?: string
  updated_at?: string
}

export interface PlaneClient {
  /* Workspace members */
  listMembers(slug: string): Promise<Member[]>

  /* Projects */
  listProjects(slug: string): Promise<Project[]>
  getProject(slug: string, project: string): Promise<Project>
  createProject(slug: string, body: Partial<Project>): Promise<Project>
  updateProject(slug: string, project: string, patch: Partial<Project>): Promise<Project>
  deleteProject(slug: string, project: string): Promise<void>

  /* States + Labels (per-project metadata) */
  listStates(slug: string, project: string): Promise<State[]>
  listLabels(slug: string, project: string): Promise<Label[]>

  /* Issues (Plane calls them work items) */
  listIssues(slug: string, project: string, params?: IssueListParams): Promise<Issue[]>
  getIssue(slug: string, project: string, issue: string): Promise<Issue>
  /** `cycle` / `module` in the body are applied through Plane's membership endpoints. */
  createIssue(slug: string, project: string, body: Partial<Issue>): Promise<Issue>
  /**
   * `cycle` / `module` in the patch move the issue between containers; pass
   * `current` (the issue as last read) so the old membership can be removed.
   */
  updateIssue(
    slug: string,
    project: string,
    issue: string,
    patch: Partial<Issue>,
    current?: Pick<Issue, 'cycle' | 'module'>,
  ): Promise<Issue>
  deleteIssue(slug: string, project: string, issue: string): Promise<void>
  /** Sub-issues — issues whose `parent` is the given issue. */
  listSubIssues(slug: string, project: string, issue: string): Promise<Issue[]>

  /* Comments + activity for an issue */
  listComments(slug: string, project: string, issue: string): Promise<Comment[]>
  createComment(slug: string, project: string, issue: string, body: { comment_html: string }): Promise<Comment>
  deleteComment(slug: string, project: string, issue: string, comment: string): Promise<void>
  listActivities(slug: string, project: string, issue: string): Promise<Activity[]>

  /* Cycles + Modules */
  listCycles(slug: string, project: string): Promise<Cycle[]>
  createCycle(slug: string, project: string, body: Partial<Cycle>): Promise<Cycle>
  updateCycle(slug: string, project: string, cycle: string, patch: Partial<Cycle>): Promise<Cycle>
  deleteCycle(slug: string, project: string, cycle: string): Promise<void>

  listModules(slug: string, project: string): Promise<Module[]>
  createModule(slug: string, project: string, body: Partial<Module>): Promise<Module>
  updateModule(slug: string, project: string, module: string, patch: Partial<Module>): Promise<Module>
  deleteModule(slug: string, project: string, module: string): Promise<void>

  /* triage */
  listIntake(slug: string, project: string, status?: IntakeStatus): Promise<IntakeItem[]>
  createIntake(slug: string, project: string, issue: { name: string; description_html?: string; priority?: Priority }): Promise<IntakeItem>
  /** Accept (1), decline (-1), snooze (0 + snoozed_till), duplicate (2 + duplicate_to), or edit the item. */
  updateIntake(
    slug: string,
    project: string,
    issue: string,
    patch: { status?: IntakeStatus; snoozed_till?: string | null; duplicate_to?: string | null; issue?: { name?: string; description_html?: string; priority?: Priority } },
  ): Promise<IntakeItem>
  deleteIntake(slug: string, project: string, issue: string): Promise<void>

  /* links + relations */
  listLinks(slug: string, project: string, issue: string): Promise<IssueLink[]>
  createLink(slug: string, project: string, issue: string, body: { url: string; title?: string }): Promise<IssueLink>
  deleteLink(slug: string, project: string, issue: string, link: string): Promise<void>
  listRelations(slug: string, project: string, issue: string): Promise<IssueRelations>
  /** Plane's public API can add relations but not remove them. */
  createRelation(slug: string, project: string, issue: string, type: RelationType, issues: string[]): Promise<void>

  /** Name / number / `KEY-123` search across the workspace (or one project). */
  searchIssues(slug: string, query: string, opts?: { project?: string; limit?: number }): Promise<SearchHit[]>

  /* projects */
  archiveProject(slug: string, project: string): Promise<void>
  unarchiveProject(slug: string, project: string): Promise<void>
  getProjectSummary(slug: string, project: string): Promise<ProjectSummary>
  listProjectMembers(slug: string, project: string): Promise<ProjectMemberLite[]>
  addProjectMember(slug: string, project: string, member: string, role: number): Promise<void>

  /* workflow */
  createState(slug: string, project: string, body: { name: string; color: string; group: StateGroup; description?: string }): Promise<State>
  updateState(slug: string, project: string, state: string, patch: Partial<Pick<State, 'name' | 'color' | 'group' | 'description' | 'default'>>): Promise<State>
  deleteState(slug: string, project: string, state: string): Promise<void>
  createLabel(slug: string, project: string, body: { name: string; color: string; parent?: string | null }): Promise<Label>
  updateLabel(slug: string, project: string, label: string, patch: Partial<Pick<Label, 'name' | 'color' | 'parent'>>): Promise<Label>
  deleteLabel(slug: string, project: string, label: string): Promise<void>

  /* cycles + modules lifecycle */
  /** Move a completed cycle's unfinished issues into another cycle. */
  transferCycleIssues(slug: string, project: string, cycle: string, toCycle: string): Promise<void>
  archiveCycle(slug: string, project: string, cycle: string): Promise<void>
  unarchiveCycle(slug: string, project: string, cycle: string): Promise<void>
  listArchivedCycles(slug: string, project: string): Promise<Cycle[]>
  archiveModule(slug: string, project: string, module: string): Promise<void>
  unarchiveModule(slug: string, project: string, module: string): Promise<void>
  listArchivedModules(slug: string, project: string): Promise<Module[]>

  /* workspace stickies (the API key owner's notes) */
  listStickies(slug: string): Promise<Sticky[]>
  createSticky(slug: string, body: Partial<Sticky>): Promise<Sticky>
  updateSticky(slug: string, sticky: string, patch: Partial<Sticky>): Promise<Sticky>
  deleteSticky(slug: string, sticky: string): Promise<void>
}

export interface IssueListParams {
  state?: string
  priority?: Priority
  assignees?: string[]
  cycle?: string
  module?: string
  /** Only issues with target_date set — used by the Roadmap view. */
  has_target_date?: boolean
}

/** Pages a list may follow before giving up — a guard against a cursor loop. */
const MAX_PAGES = 50
/** Above this many cycles + modules, issue lists skip membership enrichment. */
const MAX_MEMBERSHIP_LOOKUPS = 40

function build(http: HttpClient): PlaneClient {
  const qs = (params?: Record<string, string | undefined>) => {
    const parts = Object.entries(params ?? {})
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    return parts.length ? `?${parts.join('&')}` : ''
  }

  /** Every row of a list, following Plane's cursor (bare arrays end at once). */
  const list = async <T>(path: string, params?: Record<string, string | undefined>): Promise<T[]> => {
    const out: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await http.get<unknown>(`${path}${qs({ ...params, cursor })}`)
      out.push(...unwrapList<T>(raw))
      cursor = nextCursor(raw)
      if (!cursor) break
    }
    return out
  }

  const ws = (slug: string) => `/api/v1/workspaces/${slug}`
  const proj = (slug: string, p: string) => `${ws(slug)}/projects/${p}`

  const shapeCycle = (c: Cycle): Cycle => ({
    ...c,
    status: cycleStatus(c),
    progress: cycleProgress(c),
  })
  const shapeModule = (m: Module): Module => ({ ...m, members: m.members ?? [] })
  const shapeIssue = (i: Issue): Issue => ({
    ...i,
    assignees: i.assignees ?? [],
    labels: i.labels ?? [],
    description_stripped: i.description_stripped ?? stripHtml(i.description_html),
  })

  const issueIdsIn = async (path: string) =>
    (await list<{ id: string }>(path, { fields: 'id' })).map((r) => r.id)

  /**
   * issue id → cycle id and → module id for a project. Plane only exposes
   * membership per container, so this is one call per cycle and per module;
   * the BFF's shared cache keeps repeated reads off Plane's rate limit.
   */
  const membership = async (slug: string, p: string) => {
    const [cycles, modules] = await Promise.all([
      list<Cycle>(`${proj(slug, p)}/cycles/`),
      list<Module>(`${proj(slug, p)}/modules/`),
    ])
    if (cycles.length + modules.length > MAX_MEMBERSHIP_LOOKUPS) {
      return { cycle: new Map<string, string>(), module: new Map<string, string>(), complete: false }
    }
    const [c, m] = await Promise.all([
      Promise.all(cycles.map(async (x) => ({ id: x.id, issueIds: await issueIdsIn(`${proj(slug, p)}/cycles/${x.id}/cycle-issues/`) }))),
      Promise.all(modules.map(async (x) => ({ id: x.id, issueIds: await issueIdsIn(`${proj(slug, p)}/modules/${x.id}/module-issues/`) }))),
    ])
    return { cycle: membershipIndex(c), module: membershipIndex(m), complete: true }
  }

  const withMembership = (issues: Issue[], idx: { cycle: Map<string, string>; module: Map<string, string> }) =>
    issues.map((i) => ({ ...i, cycle: idx.cycle.get(i.id) ?? null, module: idx.module.get(i.id) ?? null }))

  const addToCycle = (slug: string, p: string, cycle: string, issue: string) =>
    http.post<unknown>(`${proj(slug, p)}/cycles/${cycle}/cycle-issues/`, { issues: [issue] })
  const removeFromCycle = (slug: string, p: string, cycle: string, issue: string) =>
    http.delete<void>(`${proj(slug, p)}/cycles/${cycle}/cycle-issues/${issue}/`)
  const addToModule = (slug: string, p: string, module: string, issue: string) =>
    http.post<unknown>(`${proj(slug, p)}/modules/${module}/module-issues/`, { issues: [issue] })
  const removeFromModule = (slug: string, p: string, module: string, issue: string) =>
    http.delete<void>(`${proj(slug, p)}/modules/${module}/module-issues/${issue}/`)

  /**
   * The project's estimate points (`[]` when it has no estimate). Plane 1.x
   * stores an issue's estimate as the id of one of these; the console works
   * in their values.
   */
  // The fork's public API doesn't register `estimates/` (it 404s for every
  // project). Remember the first 404 so each issue list doesn't spend one of
  // the shared 60-a-minute key's requests rediscovering it — the BFF only
  // caches 2xx answers.
  let estimatesMissing = false
  const estimatePoints = async (slug: string, p: string): Promise<EstimatePoint[]> => {
    if (estimatesMissing) return []
    let estimate: { id?: string } | undefined
    try {
      estimate = await http.get<{ id?: string }>(`${proj(slug, p)}/estimates/`)
    } catch (e) {
      if ((e as { status?: number }).status === 404) estimatesMissing = true
      return []
    }
    if (!estimate?.id) return []
    return list<EstimatePoint>(`${proj(slug, p)}/estimates/${estimate.id}/estimate-points/`)
  }

  /** Swap estimate point ids for their numeric values, keeping the id alongside. */
  const withEstimates = async (slug: string, p: string, issues: Issue[]): Promise<Issue[]> => {
    const raw = (i: Issue) => i.estimate_point as unknown
    if (!issues.some((i) => typeof raw(i) === 'string')) return issues
    const points = await estimatePoints(slug, p).catch(() => [] as EstimatePoint[])
    const byId = new Map(points.map((pt) => [pt.id, pt]))
    return issues.map((i) => {
      const id = raw(i)
      if (typeof id !== 'string') return i
      const pt = byId.get(id)
      const value = pt ? Number(pt.value) : NaN
      return { ...i, estimate_point_id: id, estimate_point: Number.isFinite(value) ? value : null }
    })
  }

  /** Strip the fields Plane's issue serializer does not own; map an estimate value to its point id. */
  const issueBody = async (slug: string, p: string, body: Partial<Issue>) => {
    const { cycle: _c, module: _m, estimate_point_id: _e, ...rest } = body
    if (typeof rest.estimate_point === 'number') {
      const points = await estimatePoints(slug, p)
      if (!points.length) {
        throw new Error(estimatesMissing
          ? 'Plane\'s API doesn\'t expose estimates on this server, so story points can\'t be set from the console. Set them in Plane.'
          : 'This project has no estimate in Plane. Set one up under the project\'s Estimates settings first.')
      }
      const match = points.find((pt) => Number(pt.value) === rest.estimate_point)
      if (!match) {
        throw new Error(`No estimate point ${rest.estimate_point}. This project's points are ${points.map((pt) => pt.value).join(', ')}.`)
      }
      return { ...rest, estimate_point: match.id as unknown as number }
    }
    return rest
  }

  return {
    listMembers: async (slug) =>
      (await list<RawWorkspaceMember>(`${ws(slug)}/members/`)).map((m) => normalizeMember(m, slug) as Member),

    listProjects: (slug) => list<Project>(`${ws(slug)}/projects/`),
    getProject: (slug, p) => http.get<Project>(`${proj(slug, p)}/`),
    createProject: (slug, body) => http.post<Project>(`${ws(slug)}/projects/`, body),
    updateProject: (slug, p, patch) => http.patch<Project>(`${proj(slug, p)}/`, patch),
    deleteProject: async (slug, p) => {
      await http.delete<void>(`${proj(slug, p)}/`)
    },

    listStates: (slug, p) => list<State>(`${proj(slug, p)}/states/`),
    listLabels: (slug, p) => list<Label>(`${proj(slug, p)}/labels/`),

    listIssues: async (slug, p, params) => {
      // A container filter reads that container's own list — cheaper than
      // indexing every cycle and module, and exact.
      if (params?.cycle) {
        const rows = (await list<Issue>(`${proj(slug, p)}/cycles/${params.cycle}/cycle-issues/`)).map(shapeIssue)
        const shaped = await withEstimates(slug, p, rows.map((i) => ({ ...i, cycle: params.cycle })))
        return filterIssues(shaped, { ...params, cycle: undefined })
      }
      if (params?.module) {
        const rows = (await list<Issue>(`${proj(slug, p)}/modules/${params.module}/module-issues/`)).map(shapeIssue)
        const shaped = await withEstimates(slug, p, rows.map((i) => ({ ...i, module: params.module })))
        return filterIssues(shaped, { ...params, module: undefined })
      }
      const [rows, idx] = await Promise.all([
        list<Issue>(`${proj(slug, p)}/issues/`),
        membership(slug, p).catch(() => ({ cycle: new Map<string, string>(), module: new Map<string, string>() })),
      ])
      return filterIssues(await withEstimates(slug, p, withMembership(rows.map(shapeIssue), idx)), params)
    },
    getIssue: async (slug, p, id) => {
      const [issue, idx] = await Promise.all([
        http.get<Issue>(`${proj(slug, p)}/issues/${id}/`),
        membership(slug, p).catch(() => ({ cycle: new Map<string, string>(), module: new Map<string, string>() })),
      ])
      return (await withEstimates(slug, p, withMembership([shapeIssue(issue)], idx)))[0]
    },
    createIssue: async (slug, p, body) => {
      const created = shapeIssue(await http.post<Issue>(`${proj(slug, p)}/issues/`, await issueBody(slug, p, body)))
      if (body.cycle) await addToCycle(slug, p, body.cycle, created.id)
      if (body.module) await addToModule(slug, p, body.module, created.id)
      const [withPoints] = await withEstimates(slug, p, [created])
      return { ...withPoints, cycle: body.cycle ?? null, module: body.module ?? null }
    },
    updateIssue: async (slug, p, id, patch, current) => {
      const rest = await issueBody(slug, p, patch)
      const updated = Object.keys(rest).length
        ? shapeIssue(await http.patch<Issue>(`${proj(slug, p)}/issues/${id}/`, rest))
        : shapeIssue(await http.get<Issue>(`${proj(slug, p)}/issues/${id}/`))
      let cycle = current?.cycle ?? null
      let module = current?.module ?? null
      if ('cycle' in patch && (patch.cycle ?? null) !== cycle) {
        // Adding to a cycle moves the issue out of any other one server-side.
        if (patch.cycle) await addToCycle(slug, p, patch.cycle, id)
        else if (cycle) await removeFromCycle(slug, p, cycle, id)
        cycle = patch.cycle ?? null
      }
      if ('module' in patch && (patch.module ?? null) !== module) {
        if (module) await removeFromModule(slug, p, module, id)
        if (patch.module) await addToModule(slug, p, patch.module, id)
        module = patch.module ?? null
      }
      const [withPoints] = await withEstimates(slug, p, [updated])
      return { ...withPoints, cycle, module }
    },
    deleteIssue: async (slug, p, id) => {
      await http.delete<void>(`${proj(slug, p)}/issues/${id}/`)
    },
    listSubIssues: async (slug, p, id) =>
      withEstimates(slug, p, (await list<Issue>(`${proj(slug, p)}/issues/`)).map(shapeIssue).filter((i) => i.parent === id)),

    listComments: (slug, p, id) => list<Comment>(`${proj(slug, p)}/issues/${id}/comments/`),
    createComment: (slug, p, id, body) => http.post<Comment>(`${proj(slug, p)}/issues/${id}/comments/`, body),
    deleteComment: async (slug, p, id, c) => {
      await http.delete<void>(`${proj(slug, p)}/issues/${id}/comments/${c}/`)
    },
    listActivities: (slug, p, id) => list<Activity>(`${proj(slug, p)}/issues/${id}/activities/`),

    listCycles: async (slug, p) => (await list<Cycle>(`${proj(slug, p)}/cycles/`)).map(shapeCycle),
    createCycle: async (slug, p, body) => {
      const { status: _s, progress: _p, ...rest } = body
      return shapeCycle(await http.post<Cycle>(`${proj(slug, p)}/cycles/`, rest))
    },
    updateCycle: async (slug, p, id, patch) => {
      const { status: _s, progress: _p, ...rest } = patch
      return shapeCycle(await http.patch<Cycle>(`${proj(slug, p)}/cycles/${id}/`, rest))
    },
    deleteCycle: async (slug, p, id) => {
      await http.delete<void>(`${proj(slug, p)}/cycles/${id}/`)
    },

    listModules: async (slug, p) => (await list<Module>(`${proj(slug, p)}/modules/`)).map(shapeModule),
    createModule: async (slug, p, body) => shapeModule(await http.post<Module>(`${proj(slug, p)}/modules/`, body)),
    updateModule: async (slug, p, id, patch) =>
      shapeModule(await http.patch<Module>(`${proj(slug, p)}/modules/${id}/`, patch)),
    deleteModule: async (slug, p, id) => {
      await http.delete<void>(`${proj(slug, p)}/modules/${id}/`)
    },

    listIntake: (slug, p, status) =>
      list<IntakeItem>(`${proj(slug, p)}/intake-issues/`, { status: status === undefined ? undefined : String(status) }),
    createIntake: (slug, p, issue) =>
      http.post<IntakeItem>(`${proj(slug, p)}/intake-issues/`, { issue: { priority: 'none', ...issue } }),
    updateIntake: (slug, p, issue, patch) => http.patch<IntakeItem>(`${proj(slug, p)}/intake-issues/${issue}/`, patch),
    deleteIntake: async (slug, p, issue) => {
      await http.delete<void>(`${proj(slug, p)}/intake-issues/${issue}/`)
    },

    listLinks: (slug, p, issue) => list<IssueLink>(`${proj(slug, p)}/issues/${issue}/links/`),
    createLink: (slug, p, issue, body) => http.post<IssueLink>(`${proj(slug, p)}/issues/${issue}/links/`, body),
    deleteLink: async (slug, p, issue, link) => {
      await http.delete<void>(`${proj(slug, p)}/issues/${issue}/links/${link}/`)
    },
    listRelations: async (slug, p, issue) => {
      const raw = await http.get<Partial<IssueRelations>>(`${proj(slug, p)}/work-items/${issue}/relations/`)
      return { ...EMPTY_RELATIONS(), ...raw }
    },
    createRelation: async (slug, p, issue, type, issues) => {
      await http.post<unknown>(`${proj(slug, p)}/work-items/${issue}/relations/`, { relation_type: type, issues })
    },

    searchIssues: async (slug, query, opts = {}) => {
      const r = await http.get<{ issues?: SearchHit[] }>(
        `${ws(slug)}/issues/search/${qs({
          search: query,
          limit: String(opts.limit ?? 10),
          workspace_search: opts.project ? 'false' : 'true',
          project_id: opts.project,
        })}`,
      )
      return r.issues ?? []
    },

    archiveProject: async (slug, p) => {
      await http.post<unknown>(`${proj(slug, p)}/archive/`, {})
    },
    unarchiveProject: async (slug, p) => {
      await http.delete<void>(`${proj(slug, p)}/archive/`)
    },
    getProjectSummary: (slug, p) =>
      http.get<ProjectSummary>(`${proj(slug, p)}/summary/${qs({ fields: 'members,states,labels,cycles,modules,issues,intakes' })}`),
    listProjectMembers: async (slug, p) =>
      (await list<ProjectMemberLite>(`${proj(slug, p)}/project-members-lite/`)).filter((m) => m.is_active !== false),
    addProjectMember: async (slug, p, member, role) => {
      await http.post<unknown>(`${proj(slug, p)}/project-members/`, { member, role })
    },

    createState: (slug, p, body) => http.post<State>(`${proj(slug, p)}/states/`, body),
    updateState: (slug, p, id, patch) => http.patch<State>(`${proj(slug, p)}/states/${id}/`, patch),
    deleteState: async (slug, p, id) => {
      await http.delete<void>(`${proj(slug, p)}/states/${id}/`)
    },
    createLabel: (slug, p, body) => http.post<Label>(`${proj(slug, p)}/labels/`, body),
    updateLabel: (slug, p, id, patch) => http.patch<Label>(`${proj(slug, p)}/labels/${id}/`, patch),
    deleteLabel: async (slug, p, id) => {
      await http.delete<void>(`${proj(slug, p)}/labels/${id}/`)
    },

    transferCycleIssues: async (slug, p, cycle, toCycle) => {
      await http.post<unknown>(`${proj(slug, p)}/cycles/${cycle}/transfer-issues/`, { new_cycle_id: toCycle })
    },
    archiveCycle: async (slug, p, cycle) => {
      await http.post<unknown>(`${proj(slug, p)}/cycles/${cycle}/archive/`, {})
    },
    unarchiveCycle: async (slug, p, cycle) => {
      await http.delete<void>(`${proj(slug, p)}/archived-cycles/${cycle}/unarchive/`)
    },
    listArchivedCycles: async (slug, p) => (await list<Cycle>(`${proj(slug, p)}/archived-cycles/`)).map(shapeCycle),
    archiveModule: async (slug, p, m) => {
      await http.post<unknown>(`${proj(slug, p)}/modules/${m}/archive/`, {})
    },
    unarchiveModule: async (slug, p, m) => {
      await http.delete<void>(`${proj(slug, p)}/archived-modules/${m}/unarchive/`)
    },
    listArchivedModules: async (slug, p) => (await list<Module>(`${proj(slug, p)}/archived-modules/`)).map(shapeModule),

    listStickies: (slug) => list<Sticky>(`${ws(slug)}/stickies/`),
    createSticky: (slug, body) => http.post<Sticky>(`${ws(slug)}/stickies/`, body),
    updateSticky: (slug, id, patch) => http.patch<Sticky>(`${ws(slug)}/stickies/${id}/`, patch),
    deleteSticky: async (slug, id) => {
      await http.delete<void>(`${ws(slug)}/stickies/${id}/`)
    },
  }
}

const EMPTY_RELATIONS = (): IssueRelations => ({
  blocking: [],
  blocked_by: [],
  duplicate: [],
  relates_to: [],
  start_before: [],
  start_after: [],
  finish_before: [],
  finish_after: [],
})

/* ───────────────────────────── Stubs ───────────────────────────── */

const NOW = '2026-04-25T00:00:00Z'
const days = (offset: number) =>
  new Date(new Date(NOW).getTime() + offset * 86_400_000).toISOString()

const STUB_WS: Workspace = {
  id: 'ws-default',
  name: 'Default Organization',
  slug: 'default',
  organization_size: 42,
  total_members: 18,
  total_projects: 4,
  logo_url: null,
  created_at: '2025-09-01T00:00:00Z',
}

const STUB_PROJECTS: Project[] = [
  {
    id: 'proj-con',
    name: 'Adhar Console',
    identifier: 'CON',
    description: 'Operator console for the Adhar platform.',
    workspace: 'ws-default',
    workspace_slug: 'default',
    emoji: '🛰️',
    network: 0,
    module_view: true,
    cycle_view: true,
    issue_views_view: true,
    intake_view: true,
    page_view: true,
    total_members: 8,
    total_cycles: 6,
    total_modules: 4,
    project_lead: 'usr-tapas',
    created_at: '2026-01-12T00:00:00Z',
  },
  {
    id: 'proj-bil',
    name: 'Billing Service',
    identifier: 'BIL',
    description: 'Subscription, invoicing, and dunning microservice.',
    workspace: 'ws-default',
    workspace_slug: 'default',
    emoji: '💸',
    network: 0,
    module_view: true,
    cycle_view: true,
    page_view: true,
    total_members: 5,
    total_cycles: 4,
    total_modules: 3,
    project_lead: 'usr-maya',
    created_at: '2026-02-01T00:00:00Z',
  },
  {
    id: 'proj-pay',
    name: 'Payments API',
    identifier: 'PAY',
    description: 'Card + ACH gateway behind Stripe and Adyen.',
    workspace: 'ws-default',
    workspace_slug: 'default',
    emoji: '💳',
    network: 0,
    module_view: true,
    cycle_view: true,
    page_view: true,
    total_members: 4,
    total_cycles: 3,
    total_modules: 2,
    project_lead: 'usr-arun',
    created_at: '2026-02-20T00:00:00Z',
  },
  {
    id: 'proj-ml',
    name: 'ML Platform',
    identifier: 'ML',
    description: 'KServe training pipelines.',
    workspace: 'ws-default',
    workspace_slug: 'default',
    emoji: '🧠',
    network: 0,
    module_view: true,
    cycle_view: false,
    page_view: true,
    total_members: 6,
    total_cycles: 0,
    total_modules: 5,
    project_lead: 'usr-priya',
    created_at: '2026-03-05T00:00:00Z',
  },
]

const STUB_STATES_CON: State[] = [
  { id: 'st-bk', name: 'Backlog', color: '#94a3b8', group: 'backlog', workspace: 'ws-default', project: 'proj-con', sequence: 1, default: true },
  { id: 'st-td', name: 'Todo', color: '#0ea5e9', group: 'unstarted', workspace: 'ws-default', project: 'proj-con', sequence: 2 },
  { id: 'st-ip', name: 'In Progress', color: '#6366f1', group: 'started', workspace: 'ws-default', project: 'proj-con', sequence: 3 },
  { id: 'st-rv', name: 'In Review', color: '#a855f7', group: 'started', workspace: 'ws-default', project: 'proj-con', sequence: 4 },
  { id: 'st-dn', name: 'Done', color: '#10b981', group: 'completed', workspace: 'ws-default', project: 'proj-con', sequence: 5 },
  { id: 'st-cn', name: 'Cancelled', color: '#f43f5e', group: 'cancelled', workspace: 'ws-default', project: 'proj-con', sequence: 6 },
]

const STUB_LABELS_CON: Label[] = [
  { id: 'lbl-platform', name: 'platform', color: '#6366f1', project: 'proj-con' },
  { id: 'lbl-frontend', name: 'frontend', color: '#10b981', project: 'proj-con' },
  { id: 'lbl-bug', name: 'bug', color: '#f43f5e', project: 'proj-con' },
  { id: 'lbl-perf', name: 'performance', color: '#f59e0b', project: 'proj-con' },
  { id: 'lbl-docs', name: 'docs', color: '#0ea5e9', project: 'proj-con' },
  { id: 'lbl-security', name: 'security', color: '#a855f7', project: 'proj-con' },
]

const STUB_MEMBERS: Member[] = [
  {
    id: 'mem-1',
    member: { id: 'usr-tapas', display_name: 'Tapas Mishra', email: 'tapas@example.com', avatar: null },
    role: 20,
    workspace: 'ws-default',
  },
  {
    id: 'mem-2',
    member: { id: 'usr-maya', display_name: 'Maya Reyes', email: 'maya@example.com', avatar: null },
    role: 15,
    workspace: 'ws-default',
  },
  {
    id: 'mem-3',
    member: { id: 'usr-arun', display_name: 'Arun Pillai', email: 'arun@example.com', avatar: null },
    role: 15,
    workspace: 'ws-default',
  },
  {
    id: 'mem-4',
    member: { id: 'usr-priya', display_name: 'Priya Shah', email: 'priya@example.com', avatar: null },
    role: 20,
    workspace: 'ws-default',
  },
  {
    id: 'mem-5',
    member: { id: 'usr-leo', display_name: 'Leo Wei', email: 'leo@example.com', avatar: null },
    role: 15,
    workspace: 'ws-default',
  },
  {
    id: 'mem-6',
    member: { id: 'usr-sam', display_name: 'Sam Carter', email: 'sam@example.com', avatar: null },
    role: 5,
    workspace: 'ws-default',
  },
]

const STUB_ISSUES_CON: Issue[] = [
  {
    id: 'iss-1',
    name: 'Define OIDC session schema',
    description_stripped: 'Schema covering the access token, refresh, and tenant claims.',
    state: 'st-ip',
    priority: 'high',
    assignees: ['usr-tapas'],
    labels: ['lbl-platform', 'lbl-security'],
    estimate_point: 5,
    start_date: days(-12),
    target_date: days(3),
    sequence_id: 12,
    project: 'proj-con',
    workspace: 'ws-default',
    sub_issues_count: 3,
    attachment_count: 1,
    link_count: 2,
    created_at: days(-15),
    updated_at: days(-1),
    cycle: 'cyc-current',
    module: 'mod-auth',
  },
  {
    id: 'iss-2',
    name: 'Wire up Keycloak realm',
    state: 'st-td',
    priority: 'urgent',
    assignees: ['usr-maya'],
    labels: ['lbl-platform', 'lbl-security'],
    estimate_point: 3,
    target_date: days(2),
    sequence_id: 14,
    project: 'proj-con',
    workspace: 'ws-default',
    cycle: 'cyc-current',
    module: 'mod-auth',
    created_at: days(-7),
  },
  {
    id: 'iss-3',
    name: 'Switch nav-tree to design tokens',
    state: 'st-rv',
    priority: 'medium',
    assignees: ['usr-arun'],
    labels: ['lbl-frontend'],
    estimate_point: 2,
    target_date: days(-1),
    sequence_id: 17,
    project: 'proj-con',
    workspace: 'ws-default',
    cycle: 'cyc-current',
    module: 'mod-uipolish',
    created_at: days(-10),
  },
  {
    id: 'iss-4',
    name: 'Pod shell exec WebSocket',
    state: 'st-dn',
    priority: 'high',
    assignees: ['usr-tapas', 'usr-leo'],
    labels: ['lbl-platform'],
    estimate_point: 8,
    target_date: days(-3),
    completed_at: days(-2),
    sequence_id: 22,
    project: 'proj-con',
    workspace: 'ws-default',
    cycle: 'cyc-prev',
    module: 'mod-platform',
    created_at: days(-21),
  },
  {
    id: 'iss-5',
    name: 'Crossplane XR list crashes on missing status',
    state: 'st-bk',
    priority: 'high',
    assignees: ['usr-priya'],
    labels: ['lbl-bug', 'lbl-platform'],
    estimate_point: 1,
    sequence_id: 26,
    project: 'proj-con',
    workspace: 'ws-default',
    created_at: days(-2),
  },
  {
    id: 'iss-6',
    name: 'Onboarding wizard polish',
    state: 'st-dn',
    priority: 'medium',
    assignees: ['usr-arun'],
    labels: ['lbl-frontend'],
    estimate_point: 3,
    target_date: days(-5),
    completed_at: days(-4),
    sequence_id: 28,
    project: 'proj-con',
    workspace: 'ws-default',
    cycle: 'cyc-prev',
    module: 'mod-uipolish',
    created_at: days(-14),
  },
  {
    id: 'iss-7',
    name: 'Add HeatMap chart for cluster activity',
    state: 'st-td',
    priority: 'low',
    assignees: ['usr-leo'],
    labels: ['lbl-frontend'],
    estimate_point: 2,
    target_date: days(8),
    sequence_id: 30,
    project: 'proj-con',
    workspace: 'ws-default',
    cycle: 'cyc-current',
    created_at: days(-3),
  },
  {
    id: 'iss-8',
    name: 'Audit log retention reaches 365d',
    state: 'st-ip',
    priority: 'medium',
    assignees: ['usr-maya'],
    labels: ['lbl-platform', 'lbl-security'],
    estimate_point: 5,
    target_date: days(7),
    sequence_id: 33,
    project: 'proj-con',
    workspace: 'ws-default',
    cycle: 'cyc-current',
    module: 'mod-auth',
    created_at: days(-9),
  },
  {
    id: 'iss-9',
    name: 'Fix mobile sidebar drawer scroll-lock leak',
    state: 'st-rv',
    priority: 'medium',
    assignees: ['usr-arun'],
    labels: ['lbl-frontend', 'lbl-bug'],
    estimate_point: 1,
    target_date: days(1),
    sequence_id: 35,
    project: 'proj-con',
    workspace: 'ws-default',
    cycle: 'cyc-current',
    module: 'mod-uipolish',
    created_at: days(-4),
  },
  {
    id: 'iss-10',
    name: 'Document Crossplane XRD versioning',
    state: 'st-td',
    priority: 'low',
    assignees: ['usr-priya'],
    labels: ['lbl-docs'],
    estimate_point: 2,
    target_date: days(14),
    sequence_id: 37,
    project: 'proj-con',
    workspace: 'ws-default',
    module: 'mod-docs',
    created_at: days(-6),
  },
]

const STUB_CYCLES_CON: Cycle[] = [
  {
    id: 'cyc-current',
    name: 'Sprint 12 — Auth & Platform polish',
    description: 'OIDC schema, mobile drawer, XR robustness.',
    start_date: days(-7),
    end_date: days(7),
    status: 'current',
    workspace: 'ws-default',
    project: 'proj-con',
    total_issues: 18,
    completed_issues: 8,
    started_issues: 4,
    unstarted_issues: 4,
    backlog_issues: 1,
    cancelled_issues: 1,
    progress: 44,
  },
  {
    id: 'cyc-next',
    name: 'Sprint 13 — Data & Decide',
    description: 'Metabase embeds, decide aggregates.',
    start_date: days(7),
    end_date: days(21),
    status: 'upcoming',
    workspace: 'ws-default',
    project: 'proj-con',
    total_issues: 9,
    completed_issues: 0,
    progress: 0,
  },
  {
    id: 'cyc-prev',
    name: 'Sprint 11 — Platform fundamentals',
    description: 'Pod shell, XR list, K8s wiring.',
    start_date: days(-21),
    end_date: days(-7),
    status: 'completed',
    workspace: 'ws-default',
    project: 'proj-con',
    total_issues: 22,
    completed_issues: 19,
    cancelled_issues: 2,
    started_issues: 0,
    unstarted_issues: 1,
    progress: 86,
  },
  {
    id: 'cyc-future',
    name: 'Sprint 14 — Theming v2',
    start_date: days(21),
    end_date: days(35),
    status: 'draft',
    workspace: 'ws-default',
    project: 'proj-con',
    total_issues: 0,
    completed_issues: 0,
    progress: 0,
  },
]

const STUB_MODULES_CON: Module[] = [
  {
    id: 'mod-auth',
    name: 'Identity & Auth',
    description: 'Keycloak realm, OIDC session, audit log.',
    start_date: days(-30),
    target_date: days(20),
    status: 'in-progress',
    lead: 'usr-tapas',
    members: ['usr-tapas', 'usr-maya'],
    total_issues: 14,
    completed_issues: 6,
    started_issues: 4,
    unstarted_issues: 3,
    backlog_issues: 1,
    workspace: 'ws-default',
    project: 'proj-con',
  },
  {
    id: 'mod-platform',
    name: 'Platform integration',
    description: 'Live K8s reads, Pod drawer, XR composites.',
    start_date: days(-45),
    target_date: days(10),
    status: 'in-progress',
    lead: 'usr-leo',
    members: ['usr-tapas', 'usr-leo', 'usr-priya'],
    total_issues: 22,
    completed_issues: 18,
    started_issues: 2,
    unstarted_issues: 1,
    backlog_issues: 1,
    workspace: 'ws-default',
    project: 'proj-con',
  },
  {
    id: 'mod-uipolish',
    name: 'UI polish & responsive',
    description: 'Token migration, charts, mobile.',
    start_date: days(-21),
    target_date: days(14),
    status: 'in-progress',
    lead: 'usr-arun',
    members: ['usr-arun', 'usr-leo'],
    total_issues: 16,
    completed_issues: 9,
    started_issues: 3,
    unstarted_issues: 4,
    workspace: 'ws-default',
    project: 'proj-con',
  },
  {
    id: 'mod-docs',
    name: 'Documentation',
    description: 'Architecture, getting started, runbooks.',
    start_date: days(0),
    target_date: days(45),
    status: 'planned',
    lead: 'usr-priya',
    members: ['usr-priya', 'usr-sam'],
    total_issues: 9,
    completed_issues: 1,
    workspace: 'ws-default',
    project: 'proj-con',
  },
]



const STUB_COMMENTS: Comment[] = [
  {
    id: 'cmt-1',
    comment_html: '<p>OIDC discovery doc landed — refresh / introspection live next.</p>',
    comment_stripped: 'OIDC discovery doc landed — refresh / introspection live next.',
    actor: 'usr-tapas',
    actor_detail: { id: 'usr-tapas', display_name: 'Tapas Mishra', email: 'tapas@example.com', avatar: null },
    issue: 'iss-1',
    project: 'proj-con',
    workspace: 'ws-default',
    created_at: days(-3),
  },
  {
    id: 'cmt-2',
    comment_html: '<p>Will pair with platform team on the realm config tomorrow morning.</p>',
    comment_stripped: 'Will pair with platform team on the realm config tomorrow morning.',
    actor: 'usr-maya',
    actor_detail: { id: 'usr-maya', display_name: 'Maya Reyes', email: 'maya@example.com', avatar: null },
    issue: 'iss-1',
    project: 'proj-con',
    workspace: 'ws-default',
    created_at: days(-1),
  },
]

const STUB_ACTIVITY: Activity[] = [
  {
    id: 'act-1',
    verb: 'created',
    field: null,
    actor: 'usr-tapas',
    actor_detail: { display_name: 'Tapas Mishra', email: 'tapas@example.com', avatar: null },
    issue: 'iss-1',
    created_at: days(-15),
  },
  {
    id: 'act-2',
    verb: 'updated',
    field: 'priority',
    old_value: 'medium',
    new_value: 'high',
    actor: 'usr-tapas',
    actor_detail: { display_name: 'Tapas Mishra', email: 'tapas@example.com', avatar: null },
    issue: 'iss-1',
    created_at: days(-12),
  },
  {
    id: 'act-3',
    verb: 'updated',
    field: 'state',
    old_value: 'Todo',
    new_value: 'In Progress',
    actor: 'usr-maya',
    actor_detail: { display_name: 'Maya Reyes', email: 'maya@example.com', avatar: null },
    issue: 'iss-1',
    created_at: days(-10),
  },
  {
    id: 'act-4',
    verb: 'updated',
    field: 'target_date',
    old_value: null,
    new_value: days(3).slice(0, 10),
    actor: 'usr-tapas',
    actor_detail: { display_name: 'Tapas Mishra', email: 'tapas@example.com', avatar: null },
    issue: 'iss-1',
    created_at: days(-7),
  },
]

/** Per-project map so the stub stays useful across multiple projects. */
function statesFor(p: string): State[] {
  if (p === 'proj-con') return STUB_STATES_CON
  return STUB_STATES_CON.map((s) => ({ ...s, project: p, id: `${s.id}-${p}` }))
}
function labelsFor(p: string): Label[] {
  if (p === 'proj-con') return STUB_LABELS_CON
  return STUB_LABELS_CON.map((l) => ({ ...l, project: p, id: `${l.id}-${p}` })).slice(0, 4)
}
function issuesFor(p: string): Issue[] {
  if (p === 'proj-con') return STUB_ISSUES_CON
  // Project-specific synthesised slices keep the views non-empty.
  return STUB_ISSUES_CON.slice(0, 5).map((i, idx) => ({
    ...i,
    id: `${i.id}-${p}`,
    project: p,
    sequence_id: idx + 1,
  }))
}

export const PlaneClient = defineClient<PlaneClient>(build, () => ({
  listMembers: async () => STUB_MEMBERS,
  listProjects: async () => STUB_PROJECTS,
  getProject: async (_slug, p) =>
    STUB_PROJECTS.find((x) => x.id === p) ?? STUB_PROJECTS[0],
  createProject: async (_slug, body) => {
    const next: Project = {
      id: `proj-new-${Date.now().toString(36)}`,
      name: body.name ?? 'Untitled project',
      identifier: body.identifier ?? (body.name ?? 'NEW').slice(0, 3).toUpperCase(),
      description: body.description,
      workspace: STUB_WS.id,
      workspace_slug: STUB_WS.slug,
      emoji: body.emoji ?? null,
      network: body.network ?? 0,
      module_view: body.module_view ?? true,
      cycle_view: body.cycle_view ?? true,
      issue_views_view: body.issue_views_view ?? true,
      page_view: body.page_view ?? true,
      total_members: 1,
      total_cycles: 0,
      total_modules: 0,
      project_lead: body.project_lead ?? null,
      created_at: new Date().toISOString(),
    }
    STUB_PROJECTS.push(next)
    return next
  },
  updateProject: async (_slug, p, patch) => {
    const cur = STUB_PROJECTS.find((x) => x.id === p)
    return { ...(cur as Project), ...patch, id: p }
  },
  deleteProject: async () => undefined,
  listStates: async (_slug, p) => statesFor(p),
  listLabels: async (_slug, p) => labelsFor(p),
  listIssues: async (_slug, p, params) => {
    let rows = issuesFor(p)
    if (params?.state) rows = rows.filter((i) => i.state === params.state)
    if (params?.priority) rows = rows.filter((i) => i.priority === params.priority)
    if (params?.cycle) rows = rows.filter((i) => i.cycle === params.cycle)
    if (params?.module) rows = rows.filter((i) => i.module === params.module)
    if (params?.has_target_date) rows = rows.filter((i) => !!i.target_date)
    if (params?.assignees?.length) {
      const set = new Set(params.assignees)
      rows = rows.filter((i) => i.assignees.some((a) => set.has(a)))
    }
    return rows
  },
  getIssue: async (_slug, p, id) => {
    const found = issuesFor(p).find((i) => i.id === id)
    if (!found) throw new Error(`stub: issue ${id} not found`)
    return found
  },
  createIssue: async (_slug, p, body) =>
    ({
      ...(body as Issue),
      id: `iss-new-${Date.now().toString(36)}`,
      project: p,
      workspace: STUB_WS.id,
      created_at: new Date().toISOString(),
      assignees: body.assignees ?? [],
      labels: body.labels ?? [],
      sequence_id: 999,
      priority: body.priority ?? 'none',
      state: body.state ?? 'st-bk',
      name: body.name ?? '(untitled)',
    }) as Issue,
  updateIssue: async (_slug, p, id, patch) => {
    const found = issuesFor(p).find((i) => i.id === id)
    return { ...(found ?? ({} as Issue)), ...patch, id, project: p }
  },
  deleteIssue: async () => undefined,
  listSubIssues: async (_slug, p, id) =>
    issuesFor(p).filter((i) => i.parent === id),
  listComments: async () => STUB_COMMENTS,
  createComment: async (_slug, p, id, body) => ({
    id: `cmt-new-${Date.now().toString(36)}`,
    comment_html: body.comment_html,
    comment_stripped: body.comment_html.replace(/<[^>]+>/g, ''),
    actor: 'usr-tapas',
    actor_detail: { display_name: 'You', email: 'you@example.com', avatar: null, id: 'usr-tapas' },
    issue: id,
    project: p,
    workspace: STUB_WS.id,
    created_at: new Date().toISOString(),
  }),
  deleteComment: async () => undefined,
  listActivities: async () => STUB_ACTIVITY,
  listCycles: async (_slug, p) =>
    p === 'proj-con' ? STUB_CYCLES_CON : STUB_CYCLES_CON.slice(0, 2).map((c) => ({ ...c, project: p })),
  createCycle: async (_slug, p, body) =>
    ({
      id: `cyc-new-${Date.now().toString(36)}`,
      name: body.name ?? 'New cycle',
      description: body.description,
      start_date: body.start_date ?? null,
      end_date: body.end_date ?? null,
      status: body.status ?? 'draft',
      project: p,
      workspace: STUB_WS.id,
      total_issues: 0,
      completed_issues: 0,
      progress: 0,
    }) as Cycle,
  updateCycle: async (_slug, p, id, patch) => {
    const cur = STUB_CYCLES_CON.find((c) => c.id === id)
    return { ...(cur as Cycle), ...patch, id, project: p }
  },
  deleteCycle: async () => undefined,
  listModules: async (_slug, p) =>
    p === 'proj-con' ? STUB_MODULES_CON : STUB_MODULES_CON.slice(0, 2).map((m) => ({ ...m, project: p })),
  createModule: async (_slug, p, body) =>
    ({
      id: `mod-new-${Date.now().toString(36)}`,
      name: body.name ?? 'New module',
      description: body.description,
      status: body.status ?? 'planned',
      lead: body.lead ?? null,
      members: body.members ?? [],
      start_date: body.start_date ?? null,
      target_date: body.target_date ?? null,
      total_issues: 0,
      completed_issues: 0,
      project: p,
      workspace: STUB_WS.id,
    }) as Module,
  updateModule: async (_slug, p, id, patch) => {
    const cur = STUB_MODULES_CON.find((m) => m.id === id)
    return { ...(cur as Module), ...patch, id, project: p }
  },
  deleteModule: async () => undefined,

  listIntake: async (_slug, p, status) => STUB_INTAKE.filter((x) => x.issue_detail?.project === p || p === 'proj-con').filter((x) => status === undefined || x.status === status),
  createIntake: async (_slug, p, issue) => {
    const id = `iss-intake-${Date.now().toString(36)}`
    const item: IntakeItem = {
      id: `int-${Date.now().toString(36)}`,
      issue: id,
      status: -2,
      created_at: new Date().toISOString(),
      source: 'in_app',
      issue_detail: { id, name: issue.name, description_html: issue.description_html, priority: issue.priority ?? 'none', project: p, sequence_id: 900 + STUB_INTAKE.length },
    }
    STUB_INTAKE.unshift(item)
    return item
  },
  updateIntake: async (_slug, _p, issue, patch) => {
    const item = STUB_INTAKE.find((x) => x.issue === issue)
    if (!item) throw new Error('stub: intake item not found')
    if (patch.status !== undefined) item.status = patch.status
    if (patch.snoozed_till !== undefined) item.snoozed_till = patch.snoozed_till
    if (patch.duplicate_to !== undefined) item.duplicate_to = patch.duplicate_to
    if (patch.issue && item.issue_detail) Object.assign(item.issue_detail, patch.issue)
    return item
  },
  deleteIntake: async (_slug, _p, issue) => {
    const i = STUB_INTAKE.findIndex((x) => x.issue === issue)
    if (i >= 0) STUB_INTAKE.splice(i, 1)
  },

  listLinks: async (_slug, _p, issue) => STUB_LINKS[issue] ?? [],
  createLink: async (_slug, _p, issue, body) => {
    const l: IssueLink = { id: `lnk-${Date.now().toString(36)}`, url: body.url, title: body.title ?? null, created_at: new Date().toISOString() }
    STUB_LINKS[issue] = [...(STUB_LINKS[issue] ?? []), l]
    return l
  },
  deleteLink: async (_slug, _p, issue, link) => {
    STUB_LINKS[issue] = (STUB_LINKS[issue] ?? []).filter((l) => l.id !== link)
  },
  listRelations: async (_slug, _p, issue) => ({ ...EMPTY_RELATIONS(), ...(STUB_RELATIONS[issue] ?? {}) }),
  createRelation: async (_slug, p, issue, type, issues) => {
    const cur = { ...EMPTY_RELATIONS(), ...(STUB_RELATIONS[issue] ?? {}) }
    cur[type] = [...cur[type], ...issues.map((issue_id) => ({ project_id: p, issue_id }))]
    STUB_RELATIONS[issue] = cur
  },
  searchIssues: async (_slug, query, opts = {}) => {
    const q = query.toLowerCase()
    const all = STUB_PROJECTS.flatMap((pr) => issuesFor(pr.id).map((i) => ({ i, pr })))
    return all
      .filter(({ i, pr }) => (!opts.project || pr.id === opts.project) && (i.name.toLowerCase().includes(q) || `${pr.identifier}-${i.sequence_id}`.toLowerCase() === q || String(i.sequence_id) === q.replace(/^\w+-/, '')))
      .slice(0, opts.limit ?? 10)
      .map(({ i, pr }) => ({ id: i.id, name: i.name, sequence_id: i.sequence_id ?? 0, project_id: pr.id, project__identifier: pr.identifier }))
  },
  archiveProject: async (_slug, p) => {
    const cur = STUB_PROJECTS.find((x) => x.id === p)
    if (cur) cur.archived_at = new Date().toISOString()
  },
  unarchiveProject: async (_slug, p) => {
    const cur = STUB_PROJECTS.find((x) => x.id === p)
    if (cur) cur.archived_at = null
  },
  getProjectSummary: async (_slug, p) => {
    const pr = STUB_PROJECTS.find((x) => x.id === p) ?? STUB_PROJECTS[0]
    return {
      id: pr.id,
      name: pr.name,
      identifier: pr.identifier,
      counts: { members: STUB_MEMBERS.length, states: statesFor(p).length, labels: labelsFor(p).length, cycles: STUB_CYCLES_CON.length, modules: STUB_MODULES_CON.length, issues: issuesFor(p).length, intakes: STUB_INTAKE.filter((x) => x.status === -2).length },
    }
  },
  listProjectMembers: async () =>
    STUB_MEMBERS.map((m) => ({ id: m.member?.id ?? m.id, display_name: m.member?.display_name, email: m.member?.email, first_name: m.member?.first_name, last_name: m.member?.last_name, role: m.role, is_active: true })),
  addProjectMember: async () => undefined,
  createState: async (_slug, p, body) => ({ id: `st-new-${Date.now().toString(36)}`, workspace: STUB_WS.id, project: p, ...body }),
  updateState: async (_slug, p, id, patch) => ({ ...(statesFor(p).find((s) => s.id === id) as State), ...patch }),
  deleteState: async () => undefined,
  createLabel: async (_slug, p, body) => ({ id: `lbl-new-${Date.now().toString(36)}`, project: p, ...body }),
  updateLabel: async (_slug, p, id, patch) => ({ ...(labelsFor(p).find((l) => l.id === id) as Label), ...patch }),
  deleteLabel: async () => undefined,
  transferCycleIssues: async () => undefined,
  archiveCycle: async () => undefined,
  unarchiveCycle: async () => undefined,
  listArchivedCycles: async () => [],
  archiveModule: async () => undefined,
  unarchiveModule: async () => undefined,
  listArchivedModules: async () => [],
  listStickies: async () => STUB_STICKIES,
  createSticky: async (_slug, body) => {
    const st: Sticky = { id: `stk-${Date.now().toString(36)}`, name: body.name ?? '', description_html: body.description_html ?? '<p></p>', background_color: body.background_color ?? 'yellow', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    STUB_STICKIES.unshift(st)
    return st
  },
  updateSticky: async (_slug, id, patch) => {
    const st = STUB_STICKIES.find((x) => x.id === id)
    if (!st) throw new Error('stub: sticky not found')
    Object.assign(st, patch, { updated_at: new Date().toISOString() })
    return st
  },
  deleteSticky: async (_slug, id) => {
    const i = STUB_STICKIES.findIndex((x) => x.id === id)
    if (i >= 0) STUB_STICKIES.splice(i, 1)
  },
}))

const STUB_INTAKE: IntakeItem[] = [
  {
    id: 'int-1',
    issue: 'iss-int-1',
    status: -2,
    source: 'in_app',
    created_at: days(-1),
    issue_detail: { id: 'iss-int-1', name: 'Export audit log as CSV', description_html: '<p>Compliance asks for a monthly CSV export of the audit log.</p>', priority: 'medium', project: 'proj-con', sequence_id: 141 },
  },
  {
    id: 'int-2',
    issue: 'iss-int-2',
    status: -2,
    source: 'in_app',
    created_at: days(-2),
    issue_detail: { id: 'iss-int-2', name: 'Login page flashes unstyled on slow networks', description_html: '<p>Seen on 3G throttling in Chrome.</p>', priority: 'high', project: 'proj-con', sequence_id: 142 },
  },
  {
    id: 'int-3',
    issue: 'iss-int-3',
    status: 0,
    snoozed_till: days(5),
    source: 'in_app',
    created_at: days(-6),
    issue_detail: { id: 'iss-int-3', name: 'Dark mode for email notifications', priority: 'low', project: 'proj-con', sequence_id: 137 },
  },
  {
    id: 'int-4',
    issue: 'iss-int-4',
    status: -1,
    source: 'in_app',
    created_at: days(-9),
    issue_detail: { id: 'iss-int-4', name: 'Support IE11', priority: 'none', project: 'proj-con', sequence_id: 131 },
  },
]
const STUB_LINKS: Record<string, IssueLink[]> = {
  'iss-1': [{ id: 'lnk-1', url: 'https://www.figma.com/file/console-cards', title: 'Card redesign (Figma)', created_at: days(-2) }],
}
const STUB_RELATIONS: Record<string, Partial<IssueRelations>> = {
  'iss-1': { blocked_by: [{ project_id: 'proj-con', issue_id: 'iss-2' }], relates_to: [{ project_id: 'proj-con', issue_id: 'iss-3' }] },
}
const STUB_STICKIES: Sticky[] = [
  { id: 'stk-1', name: 'Release checklist', description_html: '<p>Tag, changelog, smoke test on DO, announce in #releases.</p>', background_color: 'yellow', created_at: days(-3), updated_at: days(-1) },
  { id: 'stk-2', name: 'Q3 focus', description_html: '<p>Tenancy, Assist, Develop stage polish.</p>', background_color: 'blue', created_at: days(-10), updated_at: days(-4) },
]

/* Helpful re-exports for views that don't want to import from /base. */
export { Paginated as PaginatedSchema }
export { type Attachment, parseIssueKey, planeToday, type PlaneUser, PlaneWorkClient, type WorkItem } from './work.ts'
export { type HistoryActivity, type PlaneInsights, PlaneInsightsClient } from './insights.ts'
export { type PlanIssue, type PlanRelations, PlanningClient, type ProjectMembership, type StateGroupName, toPlanIssue, toPlanRelations } from './planning.ts'
