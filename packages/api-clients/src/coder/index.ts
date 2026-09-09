import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Coder v2 API client for cloud development environments (CDEs).
 *
 * The console proxies Coder with the bootstrap owner's session (see
 * apps/console/app/server/tool-registry.ts), so every call here is
 * privileged: it sees every workspace and creates them on behalf of the
 * signed-in developer (`owner` = their Coder username, resolved by e-mail).
 *
 * Wire-shape notes (v2.37):
 *   • `GET /workspaces` returns `{ workspaces, count }`, not an array.
 *   • Workspaces are created under an org member:
 *     `POST /organizations/{org}/members/{user}/workspaces`.
 *   • Workspace apps carry no browser URL unless `external`; the dashboard
 *     route is `<dashboard>/@<owner>/<workspace>.<agent>/apps/<slug>/`.
 */

export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  organization_id: z.string().optional(),
  organization_name: z.string().optional(),
  active_version_id: z.string().optional(),
  active_user_count: z.number().optional(),
  build_time_stats: z
    .object({
      start: z.object({ p50: z.number().nullable().optional(), p95: z.number().nullable().optional() }).optional(),
      stop: z.object({ p50: z.number().nullable().optional() }).optional(),
      delete: z.object({ p50: z.number().nullable().optional() }).optional(),
    })
    .optional(),
  default_ttl_ms: z.number().optional(),
  deprecated: z.boolean().optional(),
  deprecation_message: z.string().optional(),
  created_by_name: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})
export type Template = z.infer<typeof TemplateSchema>

export const TemplateParameterSchema = z.object({
  name: z.string(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(['string', 'number', 'bool', 'list(string)']).or(z.string()),
  mutable: z.boolean().optional(),
  default_value: z.string().optional(),
  icon: z.string().optional(),
  options: z.array(z.object({ name: z.string(), description: z.string().optional(), value: z.string(), icon: z.string().optional() })).nullable().optional(),
  required: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  validation_min: z.number().nullable().optional(),
  validation_max: z.number().nullable().optional(),
  validation_regex: z.string().optional(),
  validation_error: z.string().optional(),
})
export type TemplateParameter = z.infer<typeof TemplateParameterSchema>

export const WORKSPACE_STATUSES = [
  'pending',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
  'canceling',
  'canceled',
  'deleting',
  'deleted',
] as const
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number]

export const WorkspaceAppSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  display_name: z.string().optional(),
  icon: z.string().optional(),
  url: z.string().optional(),
  external: z.boolean().optional(),
  subdomain: z.boolean().optional(),
  sharing_level: z.string().optional(),
  health: z.enum(['disabled', 'initializing', 'healthy', 'unhealthy']).or(z.string()).optional(),
})
export type WorkspaceApp = z.infer<typeof WorkspaceAppSchema>

export const WorkspaceAgentSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  status: z.enum(['connecting', 'connected', 'disconnected', 'timeout']).or(z.string()),
  lifecycle_state: z.string().optional(),
  operating_system: z.string().optional(),
  architecture: z.string().optional(),
  version: z.string().optional(),
  first_connected_at: z.string().nullable().optional(),
  last_connected_at: z.string().nullable().optional(),
  apps: z.array(WorkspaceAppSchema).optional(),
})
export type WorkspaceAgent = z.infer<typeof WorkspaceAgentSchema>

export const WorkspaceBuildSchema = z.object({
  id: z.string(),
  build_number: z.number().optional(),
  workspace_id: z.string().optional(),
  template_version_id: z.string().optional(),
  template_version_name: z.string().optional(),
  transition: z.enum(['start', 'stop', 'delete']),
  status: z.enum(WORKSPACE_STATUSES),
  reason: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  started_at: z.string().optional(),
  deadline: z.string().nullable().optional(),
  initiator_name: z.string().optional(),
  job: z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      error: z.string().optional(),
      created_at: z.string().optional(),
      started_at: z.string().nullable().optional(),
      completed_at: z.string().nullable().optional(),
    })
    .optional(),
  resources: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        type: z.string(),
        agents: z.array(WorkspaceAgentSchema).optional(),
      }),
    )
    .optional(),
})
export type WorkspaceBuild = z.infer<typeof WorkspaceBuildSchema>

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_id: z.string().optional(),
  owner_name: z.string(),
  organization_id: z.string().optional(),
  organization_name: z.string().optional(),
  template_id: z.string(),
  template_name: z.string(),
  template_display_name: z.string().optional(),
  template_icon: z.string().optional(),
  template_active_version_id: z.string().optional(),
  latest_build: WorkspaceBuildSchema,
  outdated: z.boolean().optional(),
  health: z.object({ healthy: z.boolean(), failing_agents: z.array(z.string()).nullable().optional() }).optional(),
  autostart_schedule: z.string().nullable().optional(),
  ttl_ms: z.number().nullable().optional(),
  last_used_at: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  dormant_at: z.string().nullable().optional(),
  deleting_at: z.string().nullable().optional(),
  automatic_updates: z.string().optional(),
  favorite: z.boolean().optional(),
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export interface BuildLog {
  id: number
  created_at: string
  log_source: string
  log_level: string
  stage: string
  output: string
}

export interface CoderUser {
  id: string
  username: string
  email: string
  name?: string
  status?: string
  roles?: Array<{ name: string }>
  organization_ids?: string[]
  avatar_url?: string
}

export interface Organization {
  id: string
  name: string
  display_name?: string
  is_default?: boolean
}

export interface BuildInfo {
  version: string
  dashboard_url: string
  external_url?: string
}

export interface CreateWorkspaceBody {
  name: string
  template_id?: string
  template_version_id?: string
  rich_parameter_values?: Array<{ name: string; value: string }>
  ttl_ms?: number
  automatic_updates?: 'always' | 'never'
}

export interface CoderClient {
  buildInfo(): Promise<BuildInfo>
  me(): Promise<CoderUser>
  /** Users matching a free-text query (username / e-mail / name). */
  searchUsers(q: string, limit?: number): Promise<CoderUser[]>
  listOrganizations(): Promise<Organization[]>
  listTemplates(): Promise<Template[]>
  listTemplateParameters(templateVersionId: string): Promise<TemplateParameter[]>
  /** Every workspace the proxy identity can see; `q` is Coder's filter syntax (`owner:me status:running`). */
  listWorkspaces(q?: string): Promise<Workspace[]>
  getWorkspace(id: string): Promise<Workspace>
  createWorkspace(orgId: string, owner: string, body: CreateWorkspaceBody): Promise<Workspace>
  /** Queue a build. `template_version_id` on a `start` updates the workspace to that version. */
  buildWorkspace(id: string, body: { transition: 'start' | 'stop' | 'delete'; template_version_id?: string; orphan?: boolean }): Promise<WorkspaceBuild>
  startWorkspace(id: string, templateVersionId?: string): Promise<void>
  stopWorkspace(id: string): Promise<void>
  deleteWorkspace(id: string, orphan?: boolean): Promise<void>
  cancelBuild(buildId: string): Promise<void>
  listBuildLogs(buildId: string): Promise<BuildLog[]>
  listBuilds(workspaceId: string, limit?: number): Promise<WorkspaceBuild[]>
  updateTtl(workspaceId: string, ttlMs: number | null): Promise<void>
  updateAutostart(workspaceId: string, schedule: string | null): Promise<void>
  setFavorite(workspaceId: string, on: boolean): Promise<void>
}

/** Browser URL for a workspace app via the Coder dashboard route. */
export function appUrl(dashboard: string, w: Pick<Workspace, 'owner_name' | 'name'>, agent: string, app: WorkspaceApp): string | undefined {
  if (app.external && app.url) return app.url
  if (!dashboard) return app.url
  return `${dashboard.replace(/\/$/, '')}/@${w.owner_name}/${w.name}.${agent}/apps/${app.slug}/`
}
export function terminalUrl(dashboard: string, w: Pick<Workspace, 'owner_name' | 'name'>, agent: string): string {
  return `${dashboard.replace(/\/$/, '')}/@${w.owner_name}/${w.name}.${agent}/terminal`
}
export function workspaceUrl(dashboard: string, w: Pick<Workspace, 'owner_name' | 'name'>): string {
  return `${dashboard.replace(/\/$/, '')}/@${w.owner_name}/${w.name}`
}

function build(http: HttpClient): CoderClient {
  const enc = encodeURIComponent
  return {
    buildInfo: () => http.get<BuildInfo>(`/api/v2/buildinfo`),
    me: () => http.get<CoderUser>(`/api/v2/users/me`),
    searchUsers: async (q, limit = 10) => {
      const r = await http.get<{ users: CoderUser[] }>(`/api/v2/users?q=${enc(q)}&limit=${limit}`)
      return r.users ?? []
    },
    listOrganizations: () => http.get<Organization[]>(`/api/v2/organizations`),
    listTemplates: () => http.get<Template[]>(`/api/v2/templates`),
    listTemplateParameters: (versionId) =>
      http.get<TemplateParameter[]>(`/api/v2/templateversions/${versionId}/rich-parameters`),
    listWorkspaces: async (q = '') => {
      const r = await http.get<{ workspaces: Workspace[] } | Workspace[]>(`/api/v2/workspaces?limit=200${q ? `&q=${enc(q)}` : ''}`)
      return Array.isArray(r) ? r : r.workspaces ?? []
    },
    getWorkspace: (id) => http.get<Workspace>(`/api/v2/workspaces/${id}`),
    createWorkspace: (orgId, owner, body) =>
      http.post<Workspace>(`/api/v2/organizations/${orgId}/members/${enc(owner)}/workspaces`, body),
    buildWorkspace: (id, body) => http.post<WorkspaceBuild>(`/api/v2/workspaces/${id}/builds`, body),
    startWorkspace: async (id, templateVersionId) => {
      await http.post<WorkspaceBuild>(`/api/v2/workspaces/${id}/builds`, {
        transition: 'start',
        ...(templateVersionId ? { template_version_id: templateVersionId } : {}),
      })
    },
    stopWorkspace: async (id) => {
      await http.post<WorkspaceBuild>(`/api/v2/workspaces/${id}/builds`, { transition: 'stop' })
    },
    deleteWorkspace: async (id, orphan = false) => {
      await http.post<WorkspaceBuild>(`/api/v2/workspaces/${id}/builds`, { transition: 'delete', ...(orphan ? { orphan } : {}) })
    },
    cancelBuild: async (buildId) => {
      await http.patch(`/api/v2/workspacebuilds/${buildId}/cancel`, undefined, { response: 'raw' })
    },
    listBuildLogs: (buildId) => http.get<BuildLog[]>(`/api/v2/workspacebuilds/${buildId}/logs`),
    listBuilds: (workspaceId, limit = 20) => http.get<WorkspaceBuild[]>(`/api/v2/workspaces/${workspaceId}/builds?limit=${limit}`),
    updateTtl: async (workspaceId, ttlMs) => {
      await http.put(`/api/v2/workspaces/${workspaceId}/ttl`, { ttl_ms: ttlMs }, { response: 'raw' })
    },
    updateAutostart: async (workspaceId, schedule) => {
      await http.put(`/api/v2/workspaces/${workspaceId}/autostart`, { schedule: schedule ?? '' }, { response: 'raw' })
    },
    setFavorite: async (workspaceId, on) => {
      if (on) await http.put(`/api/v2/workspaces/${workspaceId}/favorite`, undefined, { response: 'raw' })
      else await http.delete(`/api/v2/workspaces/${workspaceId}/favorite`, { response: 'raw' })
    },
  }
}

/* ─────────── stub data ─────────── */

const STUB_ORG = '7f157861-d1a3-47aa-9589-4134e34223d3'

const STUB_TEMPLATES: Template[] = [
  {
    id: 'tpl-kubernetes',
    name: 'kubernetes',
    display_name: 'Kubernetes (Ubuntu)',
    description: 'One Ubuntu pod per workspace with code-server, a terminal and a persistent home volume.',
    icon: '/icon/k8s.png',
    organization_id: STUB_ORG,
    active_version_id: 'ver-k8s-1',
    active_user_count: 14,
    build_time_stats: { start: { p50: 38_000 } },
    default_ttl_ms: 8 * 3600 * 1000,
    created_by_name: 'adhar-admin',
  },
  {
    id: 'tpl-go',
    name: 'go-dev',
    display_name: 'Go 1.23',
    description: 'Go 1.23 with delve, golangci-lint, air for live reload.',
    icon: '/icon/go.svg',
    organization_id: STUB_ORG,
    active_version_id: 'ver-go-1',
    active_user_count: 6,
    build_time_stats: { start: { p50: 22_000 } },
    default_ttl_ms: 8 * 3600 * 1000,
  },
  {
    id: 'tpl-python',
    name: 'python',
    display_name: 'Python 3.12 + uv',
    description: 'Python 3.12 with uv, ruff, mypy, jupyter kernel.',
    icon: '/icon/python.svg',
    organization_id: STUB_ORG,
    active_version_id: 'ver-py-1',
    active_user_count: 11,
    build_time_stats: { start: { p50: 30_000 } },
    default_ttl_ms: 8 * 3600 * 1000,
  },
]

const STUB_PARAMS: Record<string, TemplateParameter[]> = {
  'ver-k8s-1': [
    { name: 'cpu', display_name: 'CPU', description: 'Cores reserved for the workspace.', type: 'string', mutable: true, default_value: '2', options: [{ name: '2 cores', value: '2' }, { name: '4 cores', value: '4' }, { name: '8 cores', value: '8' }] },
    { name: 'memory', display_name: 'Memory', description: 'GiB of RAM.', type: 'string', mutable: true, default_value: '4', options: [{ name: '4 GiB', value: '4' }, { name: '8 GiB', value: '8' }, { name: '16 GiB', value: '16' }] },
    { name: 'home_disk_size', display_name: 'Home volume', description: 'Size of /home/coder in GiB.', type: 'number', mutable: false, default_value: '10', validation_min: 1, validation_max: 100 },
  ],
}

const STUB_WORKSPACES: Workspace[] = [
  {
    id: 'ws-tapas-adhar',
    name: 'tapas-adhar',
    owner_name: 'tapas',
    organization_id: STUB_ORG,
    template_id: 'tpl-kubernetes',
    template_name: 'kubernetes',
    template_display_name: 'Kubernetes (Ubuntu)',
    template_active_version_id: 'ver-k8s-1',
    latest_build: {
      id: 'build-001',
      build_number: 4,
      template_version_id: 'ver-k8s-1',
      transition: 'start',
      status: 'running',
      created_at: '2026-04-24T08:00:00Z',
      deadline: '2026-04-24T16:00:00Z',
      job: { status: 'succeeded' },
      resources: [
        {
          name: 'main',
          type: 'kubernetes_pod',
          agents: [
            {
              name: 'main',
              status: 'connected',
              lifecycle_state: 'ready',
              operating_system: 'linux',
              architecture: 'amd64',
              apps: [
                { slug: 'code-server', display_name: 'code-server', icon: '/icon/code.svg', health: 'healthy' },
                { slug: 'preview', display_name: 'Preview :5100', icon: '/icon/preview.svg', health: 'healthy' },
              ],
            },
          ],
        },
      ],
    },
    outdated: false,
    health: { healthy: true },
    autostart_schedule: 'CRON_TZ=Asia/Kolkata 0 9 * * mon-fri',
    ttl_ms: 8 * 3600 * 1000,
    last_used_at: '2026-04-24T11:42:00Z',
    created_at: '2026-04-04T14:00:00Z',
  },
  {
    id: 'ws-maya-portal',
    name: 'maya-portal',
    owner_name: 'maya',
    organization_id: STUB_ORG,
    template_id: 'tpl-kubernetes',
    template_name: 'kubernetes',
    template_active_version_id: 'ver-k8s-1',
    latest_build: {
      id: 'build-002',
      build_number: 1,
      transition: 'start',
      status: 'starting',
      created_at: '2026-04-24T11:35:00Z',
      job: { status: 'running' },
      resources: [{ name: 'main', type: 'kubernetes_pod', agents: [{ name: 'main', status: 'connecting', operating_system: 'linux', architecture: 'amd64' }] }],
    },
    outdated: false,
    ttl_ms: 12 * 3600 * 1000,
    last_used_at: '2026-04-24T11:30:00Z',
    created_at: '2026-04-12T10:00:00Z',
  },
  {
    id: 'ws-priya-billing',
    name: 'priya-billing',
    owner_name: 'priya',
    organization_id: STUB_ORG,
    template_id: 'tpl-go',
    template_name: 'go-dev',
    template_active_version_id: 'ver-go-2',
    latest_build: {
      id: 'build-003',
      build_number: 9,
      template_version_id: 'ver-go-1',
      transition: 'stop',
      status: 'stopped',
      created_at: '2026-04-23T17:14:00Z',
      job: { status: 'succeeded' },
      resources: [{ name: 'main', type: 'kubernetes_pod', agents: [{ name: 'main', status: 'disconnected', operating_system: 'linux', architecture: 'amd64' }] }],
    },
    outdated: true,
    ttl_ms: 8 * 3600 * 1000,
    last_used_at: '2026-04-23T17:00:00Z',
    created_at: '2026-04-02T08:00:00Z',
  },
  {
    id: 'ws-anika-ds',
    name: 'anika-design-tokens',
    owner_name: 'anika',
    organization_id: STUB_ORG,
    template_id: 'tpl-python',
    template_name: 'python',
    latest_build: {
      id: 'build-004',
      build_number: 1,
      transition: 'start',
      status: 'failed',
      created_at: '2026-04-24T06:00:00Z',
      job: { status: 'failed', error: 'pod failed to schedule: insufficient memory' },
      resources: [],
    },
    outdated: false,
    ttl_ms: 8 * 3600 * 1000,
    last_used_at: '2026-04-24T05:55:00Z',
    created_at: '2026-04-22T10:00:00Z',
  },
]

const STUB_LOGS: BuildLog[] = [
  { id: 1, created_at: '2026-04-24T11:35:01Z', log_source: 'provisioner_daemon', log_level: 'info', stage: 'Setting up', output: '' },
  { id: 2, created_at: '2026-04-24T11:35:03Z', log_source: 'provisioner', log_level: 'info', stage: 'Planning infrastructure', output: 'Terraform v1.9.5' },
  { id: 3, created_at: '2026-04-24T11:35:09Z', log_source: 'provisioner', log_level: 'info', stage: 'Starting workspace', output: 'kubernetes_pod.main[0]: Creating...' },
  { id: 4, created_at: '2026-04-24T11:35:31Z', log_source: 'provisioner', log_level: 'info', stage: 'Starting workspace', output: 'kubernetes_pod.main[0]: Creation complete after 22s' },
]

/* ─────────── factory ─────────── */

export const CoderClient = defineClient<CoderClient>(build, () => {
  const ws = STUB_WORKSPACES.slice()
  return {
    buildInfo: async () => ({ version: 'v2.37.0', dashboard_url: 'https://coder.adhar.local' }),
    me: async () => ({ id: 'u-admin', username: 'adhar-admin', email: 'coder-admin@adhar.local', roles: [{ name: 'owner' }] }),
    searchUsers: async (q) =>
      [
        { id: 'u-tapas', username: 'tapas', email: 'tapas@adhar.local' },
        { id: 'u-maya', username: 'maya', email: 'maya@adhar.local' },
      ].filter((u) => u.username.includes(q) || u.email.includes(q)),
    listOrganizations: async () => [{ id: STUB_ORG, name: 'coder', is_default: true }],
    listTemplates: async () => STUB_TEMPLATES,
    listTemplateParameters: async (versionId) => STUB_PARAMS[versionId] ?? [],
    listWorkspaces: async () => ws,
    getWorkspace: async (id) => {
      const w = ws.find((x) => x.id === id)
      if (!w) throw new Error(`Stub: workspace ${id} not found`)
      return w
    },
    createWorkspace: async (orgId, owner, body) => {
      const tpl = STUB_TEMPLATES.find((t) => t.id === body.template_id || t.active_version_id === body.template_version_id) ?? STUB_TEMPLATES[0]
      const fresh: Workspace = {
        id: `ws-new-${Date.now().toString(36)}`,
        name: body.name,
        owner_name: owner === 'me' ? 'adhar-admin' : owner,
        organization_id: orgId,
        template_id: tpl.id,
        template_name: tpl.name,
        template_display_name: tpl.display_name,
        template_icon: tpl.icon,
        template_active_version_id: tpl.active_version_id,
        latest_build: {
          id: `build-new-${Date.now().toString(36)}`,
          build_number: 1,
          transition: 'start',
          status: 'pending',
          created_at: new Date().toISOString(),
          job: { status: 'pending' },
        },
        outdated: false,
        ttl_ms: body.ttl_ms ?? tpl.default_ttl_ms,
        last_used_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }
      ws.unshift(fresh)
      return fresh
    },
    buildWorkspace: async (id, body) => {
      const w = ws.find((x) => x.id === id)
      if (!w) throw new Error(`Stub: workspace ${id} not found`)
      w.latest_build = {
        ...w.latest_build,
        id: `build-${Date.now().toString(36)}`,
        transition: body.transition,
        status: body.transition === 'start' ? 'starting' : body.transition === 'stop' ? 'stopping' : 'deleting',
        created_at: new Date().toISOString(),
      }
      if (body.template_version_id) w.outdated = false
      return w.latest_build
    },
    startWorkspace: async (id) => {
      const w = ws.find((x) => x.id === id)
      if (w) w.latest_build = { ...w.latest_build, transition: 'start', status: 'starting' }
    },
    stopWorkspace: async (id) => {
      const w = ws.find((x) => x.id === id)
      if (w) w.latest_build = { ...w.latest_build, transition: 'stop', status: 'stopping' }
    },
    deleteWorkspace: async (id) => {
      const i = ws.findIndex((x) => x.id === id)
      if (i >= 0) ws.splice(i, 1)
    },
    cancelBuild: async () => {},
    listBuildLogs: async () => STUB_LOGS,
    listBuilds: async (id) => {
      const w = ws.find((x) => x.id === id)
      return w ? [w.latest_build] : []
    },
    updateTtl: async (id, ttl) => {
      const w = ws.find((x) => x.id === id)
      if (w) w.ttl_ms = ttl
    },
    updateAutostart: async (id, schedule) => {
      const w = ws.find((x) => x.id === id)
      if (w) w.autostart_schedule = schedule
    },
    setFavorite: async (id, on) => {
      const w = ws.find((x) => x.id === id)
      if (w) w.favorite = on
    },
  }
})
