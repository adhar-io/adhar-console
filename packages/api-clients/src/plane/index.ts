import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

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
  estimate_point: z.number().nullable().optional(),
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
  status: z.enum(['current', 'upcoming', 'completed', 'draft']),
  project: z.string(),
  workspace: z.string(),
  total_issues: z.number().optional(),
  cancelled_issues: z.number().optional(),
  completed_issues: z.number().optional(),
  started_issues: z.number().optional(),
  unstarted_issues: z.number().optional(),
  backlog_issues: z.number().optional(),
  /** 0–100 progress percentage derived server-side. */
  progress: z.number().optional(),
})
export type Cycle = z.infer<typeof CycleSchema>

export const ModuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  start_date: z.string().nullable().optional(),
  target_date: z.string().nullable().optional(),
  status: z.enum(['planned', 'in-progress', 'paused', 'completed', 'cancelled']),
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
  /** 5=Admin, 15=Member, 20=Guest, 25=Viewer (Plane RBAC enum). */
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

export interface PlaneClient {
  /* Workspaces */
  getWorkspace(slug: string): Promise<Workspace>
  listMembers(slug: string): Promise<Member[]>
  inviteMember(slug: string, body: { email: string; role: number }): Promise<Member>
  updateMemberRole(slug: string, memberId: string, role: number): Promise<Member>
  removeMember(slug: string, memberId: string): Promise<void>

  /* Projects */
  listProjects(slug: string): Promise<Project[]>
  getProject(slug: string, project: string): Promise<Project>
  createProject(slug: string, body: Partial<Project>): Promise<Project>
  updateProject(slug: string, project: string, patch: Partial<Project>): Promise<Project>
  deleteProject(slug: string, project: string): Promise<void>

  /* States + Labels (per-project metadata) */
  listStates(slug: string, project: string): Promise<State[]>
  listLabels(slug: string, project: string): Promise<Label[]>

  /* Issues */
  listIssues(slug: string, project: string, params?: IssueListParams): Promise<Issue[]>
  getIssue(slug: string, project: string, issue: string): Promise<Issue>
  createIssue(slug: string, project: string, body: Partial<Issue>): Promise<Issue>
  updateIssue(slug: string, project: string, issue: string, patch: Partial<Issue>): Promise<Issue>
  deleteIssue(slug: string, project: string, issue: string): Promise<void>
  /** Sub-issues — `parent` set to the given issue id. */
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

  /* Pages + Views */
  listPages(slug: string, project: string): Promise<Page[]>
  getPage(slug: string, project: string, page: string): Promise<Page>
  createPage(slug: string, project: string, body: Partial<Page>): Promise<Page>
  updatePage(slug: string, project: string, page: string, patch: Partial<Page>): Promise<Page>
  deletePage(slug: string, project: string, page: string): Promise<void>

  listViews(slug: string, project: string): Promise<View[]>
  createView(slug: string, project: string, body: Partial<View>): Promise<View>
  updateView(slug: string, project: string, view: string, patch: Partial<View>): Promise<View>
  deleteView(slug: string, project: string, view: string): Promise<void>
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

function build(http: HttpClient): PlaneClient {
  // Plane wraps lists in either a bare array (older) or {results} (newer).
  // unwrap() handles both so we don't have to know which version is talking.
  const unwrap = <T>(raw: unknown): T[] => {
    if (Array.isArray(raw)) return raw as T[]
    if (raw && typeof raw === 'object' && 'results' in raw) {
      return ((raw as { results: T[] }).results) ?? []
    }
    return []
  }

  const list = async <T>(path: string, params?: Record<string, string | undefined>) => {
    const q = params
      ? '?' +
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : ''
    return unwrap<T>(await http.get<unknown>(`${path}${q}`))
  }

  return {
    getWorkspace: (slug) => http.get<Workspace>(`/api/v1/workspaces/${slug}/`),
    listMembers: (slug) => list<Member>(`/api/v1/workspaces/${slug}/members/`),
    inviteMember: (slug, body) =>
      http.post<Member>(`/api/v1/workspaces/${slug}/invitations/`, body),
    updateMemberRole: (slug, id, role) =>
      http.patch<Member>(`/api/v1/workspaces/${slug}/members/${id}/`, { role }),
    removeMember: async (slug, id) => {
      await http.delete<void>(`/api/v1/workspaces/${slug}/members/${id}/`)
    },

    listProjects: (slug) => list<Project>(`/api/v1/workspaces/${slug}/projects/`),
    getProject: (slug, p) => http.get<Project>(`/api/v1/workspaces/${slug}/projects/${p}/`),
    createProject: (slug, body) =>
      http.post<Project>(`/api/v1/workspaces/${slug}/projects/`, body),
    updateProject: (slug, p, patch) =>
      http.patch<Project>(`/api/v1/workspaces/${slug}/projects/${p}/`, patch),
    deleteProject: async (slug, p) => {
      await http.delete<void>(`/api/v1/workspaces/${slug}/projects/${p}/`)
    },

    listStates: (slug, p) =>
      list<State>(`/api/v1/workspaces/${slug}/projects/${p}/states/`),
    listLabels: (slug, p) =>
      list<Label>(`/api/v1/workspaces/${slug}/projects/${p}/labels/`),

    listIssues: (slug, p, params) => {
      const qs: Record<string, string | undefined> = {}
      if (params?.state) qs.state = params.state
      if (params?.priority) qs.priority = params.priority
      if (params?.cycle) qs.cycle = params.cycle
      if (params?.module) qs.module = params.module
      if (params?.assignees?.length) qs.assignees = params.assignees.join(',')
      if (params?.has_target_date) qs.target_date__isnull = 'false'
      return list<Issue>(`/api/v1/workspaces/${slug}/projects/${p}/issues/`, qs)
    },
    getIssue: (slug, p, id) =>
      http.get<Issue>(`/api/v1/workspaces/${slug}/projects/${p}/issues/${id}/`),
    createIssue: (slug, p, body) =>
      http.post<Issue>(`/api/v1/workspaces/${slug}/projects/${p}/issues/`, body),
    updateIssue: (slug, p, id, patch) =>
      http.patch<Issue>(`/api/v1/workspaces/${slug}/projects/${p}/issues/${id}/`, patch),
    deleteIssue: async (slug, p, id) => {
      await http.delete<void>(`/api/v1/workspaces/${slug}/projects/${p}/issues/${id}/`)
    },
    listSubIssues: (slug, p, id) =>
      list<Issue>(`/api/v1/workspaces/${slug}/projects/${p}/issues/${id}/sub-issues/`),

    listComments: (slug, p, id) =>
      list<Comment>(`/api/v1/workspaces/${slug}/projects/${p}/issues/${id}/comments/`),
    createComment: (slug, p, id, body) =>
      http.post<Comment>(`/api/v1/workspaces/${slug}/projects/${p}/issues/${id}/comments/`, body),
    deleteComment: async (slug, p, id, c) => {
      await http.delete<void>(`/api/v1/workspaces/${slug}/projects/${p}/issues/${id}/comments/${c}/`)
    },
    listActivities: (slug, p, id) =>
      list<Activity>(`/api/v1/workspaces/${slug}/projects/${p}/issues/${id}/activities/`),

    listCycles: (slug, p) => list<Cycle>(`/api/v1/workspaces/${slug}/projects/${p}/cycles/`),
    createCycle: (slug, p, body) =>
      http.post<Cycle>(`/api/v1/workspaces/${slug}/projects/${p}/cycles/`, body),
    updateCycle: (slug, p, id, patch) =>
      http.patch<Cycle>(`/api/v1/workspaces/${slug}/projects/${p}/cycles/${id}/`, patch),
    deleteCycle: async (slug, p, id) => {
      await http.delete<void>(`/api/v1/workspaces/${slug}/projects/${p}/cycles/${id}/`)
    },

    listModules: (slug, p) =>
      list<Module>(`/api/v1/workspaces/${slug}/projects/${p}/modules/`),
    createModule: (slug, p, body) =>
      http.post<Module>(`/api/v1/workspaces/${slug}/projects/${p}/modules/`, body),
    updateModule: (slug, p, id, patch) =>
      http.patch<Module>(`/api/v1/workspaces/${slug}/projects/${p}/modules/${id}/`, patch),
    deleteModule: async (slug, p, id) => {
      await http.delete<void>(`/api/v1/workspaces/${slug}/projects/${p}/modules/${id}/`)
    },

    listPages: (slug, p) => list<Page>(`/api/v1/workspaces/${slug}/projects/${p}/pages/`),
    getPage: (slug, p, id) =>
      http.get<Page>(`/api/v1/workspaces/${slug}/projects/${p}/pages/${id}/`),
    createPage: (slug, p, body) =>
      http.post<Page>(`/api/v1/workspaces/${slug}/projects/${p}/pages/`, body),
    updatePage: (slug, p, id, patch) =>
      http.patch<Page>(`/api/v1/workspaces/${slug}/projects/${p}/pages/${id}/`, patch),
    deletePage: async (slug, p, id) => {
      await http.delete<void>(`/api/v1/workspaces/${slug}/projects/${p}/pages/${id}/`)
    },
    listViews: (slug, p) => list<View>(`/api/v1/workspaces/${slug}/projects/${p}/views/`),
    createView: (slug, p, body) =>
      http.post<View>(`/api/v1/workspaces/${slug}/projects/${p}/views/`, body),
    updateView: (slug, p, id, patch) =>
      http.patch<View>(`/api/v1/workspaces/${slug}/projects/${p}/views/${id}/`, patch),
    deleteView: async (slug, p, id) => {
      await http.delete<void>(`/api/v1/workspaces/${slug}/projects/${p}/views/${id}/`)
    },
  }
}

/* ───────────────────────────── Stubs ───────────────────────────── */

const NOW = '2026-04-25T00:00:00Z'
const days = (offset: number) =>
  new Date(new Date(NOW).getTime() + offset * 86_400_000).toISOString()

const STUB_WS: Workspace = {
  id: 'ws-acme',
  name: 'Acme Corp',
  slug: 'acme',
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
    workspace: 'ws-acme',
    workspace_slug: 'acme',
    emoji: '🛰️',
    network: 0,
    module_view: true,
    cycle_view: true,
    issue_views_view: true,
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
    workspace: 'ws-acme',
    workspace_slug: 'acme',
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
    workspace: 'ws-acme',
    workspace_slug: 'acme',
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
    description: 'KServe + Argo Workflows training pipelines.',
    workspace: 'ws-acme',
    workspace_slug: 'acme',
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
  { id: 'st-bk', name: 'Backlog', color: '#94a3b8', group: 'backlog', workspace: 'ws-acme', project: 'proj-con', sequence: 1, default: true },
  { id: 'st-td', name: 'Todo', color: '#0ea5e9', group: 'unstarted', workspace: 'ws-acme', project: 'proj-con', sequence: 2 },
  { id: 'st-ip', name: 'In Progress', color: '#6366f1', group: 'started', workspace: 'ws-acme', project: 'proj-con', sequence: 3 },
  { id: 'st-rv', name: 'In Review', color: '#a855f7', group: 'started', workspace: 'ws-acme', project: 'proj-con', sequence: 4 },
  { id: 'st-dn', name: 'Done', color: '#10b981', group: 'completed', workspace: 'ws-acme', project: 'proj-con', sequence: 5 },
  { id: 'st-cn', name: 'Cancelled', color: '#f43f5e', group: 'cancelled', workspace: 'ws-acme', project: 'proj-con', sequence: 6 },
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
    member: { id: 'usr-tapas', display_name: 'Tapas Mishra', email: 'tapas@acme.com', avatar: null },
    role: 5,
    workspace: 'ws-acme',
  },
  {
    id: 'mem-2',
    member: { id: 'usr-maya', display_name: 'Maya Reyes', email: 'maya@acme.com', avatar: null },
    role: 15,
    workspace: 'ws-acme',
  },
  {
    id: 'mem-3',
    member: { id: 'usr-arun', display_name: 'Arun Pillai', email: 'arun@acme.com', avatar: null },
    role: 15,
    workspace: 'ws-acme',
  },
  {
    id: 'mem-4',
    member: { id: 'usr-priya', display_name: 'Priya Shah', email: 'priya@acme.com', avatar: null },
    role: 5,
    workspace: 'ws-acme',
  },
  {
    id: 'mem-5',
    member: { id: 'usr-leo', display_name: 'Leo Wei', email: 'leo@acme.com', avatar: null },
    role: 15,
    workspace: 'ws-acme',
  },
  {
    id: 'mem-6',
    member: { id: 'usr-sam', display_name: 'Sam Carter', email: 'sam@acme.com', avatar: null },
    role: 20,
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
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
    workspace: 'ws-acme',
    project: 'proj-con',
  },
]

const STUB_PAGES_CON: Page[] = [
  {
    id: 'pg-arch',
    name: 'Architecture · Module Federation + TanStack Start',
    description_stripped:
      'How the host loads phase remotes, BFF boundaries, and where session state lives.',
    owned_by: 'usr-tapas',
    access: 'public',
    blocks: [],
    labels: [],
    project: 'proj-con',
    workspace: 'ws-acme',
    created_at: days(-30),
    updated_at: days(-2),
    is_favorite: true,
  },
  {
    id: 'pg-runbook',
    name: 'Runbook · Cluster unreachable',
    description_stripped:
      'Steps to triage when ConnectionGate fires — kubectl proxy, Vite proxy, RBAC.',
    owned_by: 'usr-leo',
    access: 'public',
    blocks: [],
    labels: [],
    project: 'proj-con',
    workspace: 'ws-acme',
    created_at: days(-12),
    updated_at: days(-1),
  },
  {
    id: 'pg-design',
    name: 'Design tokens & theming presets',
    description_stripped:
      'OKLCH ramps for brand/accent/surface, theme picker behaviour, customisation.',
    owned_by: 'usr-arun',
    access: 'public',
    blocks: [],
    labels: [],
    project: 'proj-con',
    workspace: 'ws-acme',
    created_at: days(-22),
    updated_at: days(-5),
  },
  {
    id: 'pg-onboarding',
    name: 'Onboarding wizard copy',
    description_stripped: 'Source of truth for the 5 onboarding steps + tone of voice.',
    owned_by: 'usr-arun',
    access: 'private',
    blocks: [],
    labels: [],
    project: 'proj-con',
    workspace: 'ws-acme',
    created_at: days(-10),
    updated_at: days(-3),
  },
]

const STUB_VIEWS_CON: View[] = [
  {
    id: 'vw-mine',
    name: 'My open issues',
    description: 'All issues assigned to me, not done.',
    query_data: { assignees: ['me'], state__group: ['backlog', 'unstarted', 'started'] },
    project: 'proj-con',
    workspace: 'ws-acme',
    access: 'private',
    created_at: days(-30),
  },
  {
    id: 'vw-bugs',
    name: 'Open bugs',
    description: 'Anything labelled bug that isn\'t closed.',
    query_data: { labels: ['lbl-bug'], state__group: ['backlog', 'unstarted', 'started'] },
    project: 'proj-con',
    workspace: 'ws-acme',
    access: 'public',
    created_at: days(-20),
  },
  {
    id: 'vw-blocked',
    name: 'Blocked / urgent',
    description: 'Priority urgent or paused waiting for review.',
    query_data: { priority: ['urgent'] },
    project: 'proj-con',
    workspace: 'ws-acme',
    access: 'public',
    created_at: days(-14),
  },
]

const STUB_COMMENTS: Comment[] = [
  {
    id: 'cmt-1',
    comment_html: '<p>OIDC discovery doc landed — refresh / introspection live next.</p>',
    comment_stripped: 'OIDC discovery doc landed — refresh / introspection live next.',
    actor: 'usr-tapas',
    actor_detail: { id: 'usr-tapas', display_name: 'Tapas Mishra', email: 'tapas@acme.com', avatar: null },
    issue: 'iss-1',
    project: 'proj-con',
    workspace: 'ws-acme',
    created_at: days(-3),
  },
  {
    id: 'cmt-2',
    comment_html: '<p>Will pair with platform team on the realm config tomorrow morning.</p>',
    comment_stripped: 'Will pair with platform team on the realm config tomorrow morning.',
    actor: 'usr-maya',
    actor_detail: { id: 'usr-maya', display_name: 'Maya Reyes', email: 'maya@acme.com', avatar: null },
    issue: 'iss-1',
    project: 'proj-con',
    workspace: 'ws-acme',
    created_at: days(-1),
  },
]

const STUB_ACTIVITY: Activity[] = [
  {
    id: 'act-1',
    verb: 'created',
    field: null,
    actor: 'usr-tapas',
    actor_detail: { display_name: 'Tapas Mishra', email: 'tapas@acme.com', avatar: null },
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
    actor_detail: { display_name: 'Tapas Mishra', email: 'tapas@acme.com', avatar: null },
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
    actor_detail: { display_name: 'Maya Reyes', email: 'maya@acme.com', avatar: null },
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
    actor_detail: { display_name: 'Tapas Mishra', email: 'tapas@acme.com', avatar: null },
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
  getWorkspace: async () => STUB_WS,
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
  inviteMember: async (_slug, body) => ({
    id: `mem-new-${Date.now().toString(36)}`,
    member: {
      id: `usr-new-${Date.now().toString(36)}`,
      display_name: body.email.split('@')[0],
      email: body.email,
      avatar: null,
    },
    role: body.role,
    workspace: STUB_WS.id,
  }),
  updateMemberRole: async (_slug, id, role) => {
    const cur = STUB_MEMBERS.find((m) => m.id === id) ?? STUB_MEMBERS[0]
    return { ...cur, role }
  },
  removeMember: async () => undefined,
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
    actor_detail: { display_name: 'You', email: 'you@acme.com', avatar: null, id: 'usr-tapas' },
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
  listPages: async (_slug, p) =>
    p === 'proj-con' ? STUB_PAGES_CON : STUB_PAGES_CON.slice(0, 1).map((g) => ({ ...g, project: p })),
  getPage: async (_slug, p, id) => {
    const found = STUB_PAGES_CON.find((g) => g.id === id)
    if (!found) throw new Error(`stub: page ${id} not found`)
    return { ...found, project: p }
  },
  createPage: async (_slug, p, body) =>
    ({
      ...(body as Page),
      id: `pg-new-${Date.now().toString(36)}`,
      owned_by: 'usr-tapas',
      access: body.access ?? 'public',
      blocks: [],
      labels: [],
      project: p,
      workspace: STUB_WS.id,
      created_at: new Date().toISOString(),
      name: body.name ?? '(untitled page)',
    }) as Page,
  updatePage: async (_slug, p, id, patch) => {
    const found = STUB_PAGES_CON.find((g) => g.id === id)
    return {
      ...(found ?? ({} as Page)),
      ...patch,
      id,
      project: p,
      updated_at: new Date().toISOString(),
    } as Page
  },
  deletePage: async () => undefined,
  listViews: async (_slug, p) =>
    p === 'proj-con' ? STUB_VIEWS_CON : [],
  createView: async (_slug, p, body) =>
    ({
      id: `vw-new-${Date.now().toString(36)}`,
      name: body.name ?? 'Untitled view',
      description: body.description,
      query_data: body.query_data ?? {},
      access: body.access ?? 'private',
      project: p,
      workspace: STUB_WS.id,
      created_at: new Date().toISOString(),
    }) as View,
  updateView: async (_slug, p, id, patch) =>
    ({
      ...(STUB_VIEWS_CON.find((v) => v.id === id) as View),
      ...patch,
      id,
      project: p,
    }),
  deleteView: async () => undefined,
}))

/* Helpful re-exports for views that don't want to import from /base. */
export { Paginated as PaginatedSchema }
