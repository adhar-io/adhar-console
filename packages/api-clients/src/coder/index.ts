import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Coder API client for cloud development environments (CDEs).
 *
 * Each developer gets one or more Coder workspaces, provisioned from a
 * template (Terraform-defined). The Develop module shows them in a grid
 * with start/stop/SSH/IDE actions.
 */

export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  active_user_count: z.number().optional(),
  build_time_stats: z
    .object({ start: z.object({ p50: z.number().optional() }).optional() })
    .optional(),
  default_ttl_ms: z.number().optional(),
  organization_id: z.string().optional(),
})
export type Template = z.infer<typeof TemplateSchema>

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  template_id: z.string(),
  template_name: z.string(),
  template_icon: z.string().optional(),
  owner_name: z.string(),
  /**
   * Coder reports a coarse status on the latest build:
   *  starting / running / stopping / stopped / pending / failed / canceling /
   *  canceled / deleting / deleted.
   */
  latest_build: z.object({
    id: z.string(),
    transition: z.enum(['start', 'stop', 'delete']),
    status: z.enum([
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
    ]),
    started_at: z.string().optional(),
    deadline: z.string().optional(),
    resources: z
      .array(
        z.object({
          name: z.string(),
          type: z.string(),
          agents: z
            .array(
              z.object({
                name: z.string(),
                status: z.enum(['connecting', 'connected', 'disconnected', 'timeout']),
                operating_system: z.string().optional(),
                architecture: z.string().optional(),
                apps: z
                  .array(
                    z.object({
                      slug: z.string(),
                      display_name: z.string(),
                      icon: z.string().optional(),
                      url: z.string().optional(),
                      external: z.boolean().optional(),
                    }),
                  )
                  .optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
  }),
  outdated: z.boolean().optional(),
  autostart_schedule: z.string().optional(),
  ttl_ms: z.number().optional(),
  last_used_at: z.string().optional(),
  created_at: z.string(),
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export type WorkspaceStatus = Workspace['latest_build']['status']

export interface CoderClient {
  listTemplates(): Promise<Template[]>
  listWorkspaces(): Promise<Workspace[]>
  getWorkspace(id: string): Promise<Workspace>
  startWorkspace(id: string): Promise<void>
  stopWorkspace(id: string): Promise<void>
  deleteWorkspace(id: string): Promise<void>
  createWorkspace(body: { name: string; template_id: string }): Promise<Workspace>
}

function build(http: HttpClient): CoderClient {
  return {
    listTemplates: () => http.get<Template[]>(`/api/v2/templates`),
    listWorkspaces: () => http.get<Workspace[]>(`/api/v2/workspaces`),
    getWorkspace: (id) => http.get<Workspace>(`/api/v2/workspaces/${id}`),
    startWorkspace: async (id) => {
      await http.post<void>(`/api/v2/workspaces/${id}/builds`, { transition: 'start' })
    },
    stopWorkspace: async (id) => {
      await http.post<void>(`/api/v2/workspaces/${id}/builds`, { transition: 'stop' })
    },
    deleteWorkspace: async (id) => {
      await http.post<void>(`/api/v2/workspaces/${id}/builds`, { transition: 'delete' })
    },
    createWorkspace: (body) => http.post<Workspace>(`/api/v2/workspaces`, body),
  }
}

const STUB_TEMPLATES: Template[] = [
  {
    id: 'tpl-node-ts',
    name: 'node-ts',
    display_name: 'Node.js + TypeScript',
    description: 'Node 20, pnpm, Deno, oh-my-zsh. Pre-cached node_modules.',
    icon: '/icon/node.svg',
    active_user_count: 14,
    build_time_stats: { start: { p50: 38_000 } },
    default_ttl_ms: 8 * 3600 * 1000,
  },
  {
    id: 'tpl-go',
    name: 'go-dev',
    display_name: 'Go 1.23',
    description: 'Go 1.23 with delve, golangci-lint, air for live reload.',
    icon: '/icon/go.svg',
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
    active_user_count: 11,
    build_time_stats: { start: { p50: 30_000 } },
    default_ttl_ms: 8 * 3600 * 1000,
  },
  {
    id: 'tpl-fullstack',
    name: 'fullstack-tilt',
    display_name: 'Full-stack (Tilt + k3d)',
    description: 'k3d cluster + Tilt for live multi-service dev. 8 GB RAM.',
    icon: '/icon/k8s.svg',
    active_user_count: 3,
    build_time_stats: { start: { p50: 95_000 } },
    default_ttl_ms: 12 * 3600 * 1000,
  },
]

const STUB_WORKSPACES: Workspace[] = [
  {
    id: 'ws-tapas-adhar',
    name: 'tapas-adhar',
    template_id: 'tpl-node-ts',
    template_name: 'node-ts',
    template_icon: '/icon/node.svg',
    owner_name: 'tapas',
    latest_build: {
      id: 'build-001',
      transition: 'start',
      status: 'running',
      started_at: '2026-04-24T08:00:00Z',
      deadline: '2026-04-24T16:00:00Z',
      resources: [
        {
          name: 'main',
          type: 'kubernetes_pod',
          agents: [
            {
              name: 'main',
              status: 'connected',
              operating_system: 'linux',
              architecture: 'amd64',
              apps: [
                { slug: 'code-server', display_name: 'VS Code', icon: '/icon/code.svg', url: 'https://ws-tapas-adhar.coder.adhar.local/code' },
                { slug: 'terminal', display_name: 'Terminal', icon: '/icon/term.svg' },
                { slug: 'preview', display_name: 'Preview :5100', icon: '/icon/preview.svg', url: 'https://ws-tapas-adhar.coder.adhar.local/preview' },
              ],
            },
          ],
        },
      ],
    },
    outdated: false,
    autostart_schedule: 'CRON_TZ=Asia/Kolkata 0 9 * * mon-fri',
    ttl_ms: 8 * 3600 * 1000,
    last_used_at: '2026-04-24T11:42:00Z',
    created_at: '2026-04-04T14:00:00Z',
  },
  {
    id: 'ws-maya-portal',
    name: 'maya-portal',
    template_id: 'tpl-fullstack',
    template_name: 'fullstack-tilt',
    template_icon: '/icon/k8s.svg',
    owner_name: 'maya',
    latest_build: {
      id: 'build-002',
      transition: 'start',
      status: 'starting',
      started_at: '2026-04-24T11:35:00Z',
      resources: [
        {
          name: 'main',
          type: 'kubernetes_pod',
          agents: [{ name: 'main', status: 'connecting', operating_system: 'linux', architecture: 'amd64' }],
        },
      ],
    },
    outdated: false,
    ttl_ms: 12 * 3600 * 1000,
    last_used_at: '2026-04-24T11:30:00Z',
    created_at: '2026-04-12T10:00:00Z',
  },
  {
    id: 'ws-priya-billing',
    name: 'priya-billing',
    template_id: 'tpl-go',
    template_name: 'go-dev',
    template_icon: '/icon/go.svg',
    owner_name: 'priya',
    latest_build: {
      id: 'build-003',
      transition: 'stop',
      status: 'stopped',
      started_at: '2026-04-23T17:14:00Z',
      resources: [
        { name: 'main', type: 'kubernetes_pod', agents: [{ name: 'main', status: 'disconnected', operating_system: 'linux', architecture: 'amd64' }] },
      ],
    },
    outdated: true,
    ttl_ms: 8 * 3600 * 1000,
    last_used_at: '2026-04-23T17:00:00Z',
    created_at: '2026-04-02T08:00:00Z',
  },
  {
    id: 'ws-anika-ds',
    name: 'anika-design-tokens',
    template_id: 'tpl-python',
    template_name: 'python',
    template_icon: '/icon/python.svg',
    owner_name: 'anika',
    latest_build: {
      id: 'build-004',
      transition: 'start',
      status: 'failed',
      started_at: '2026-04-24T06:00:00Z',
      resources: [],
    },
    outdated: false,
    ttl_ms: 8 * 3600 * 1000,
    last_used_at: '2026-04-24T05:55:00Z',
    created_at: '2026-04-22T10:00:00Z',
  },
]

export const CoderClient = defineClient<CoderClient>(build, () => {
  const ws = STUB_WORKSPACES.slice()
  return {
    listTemplates: async () => STUB_TEMPLATES,
    listWorkspaces: async () => ws,
    getWorkspace: async (id) => {
      const w = ws.find((x) => x.id === id)
      if (!w) throw new Error(`Stub: workspace ${id} not found`)
      return w
    },
    startWorkspace: async (id) => {
      const w = ws.find((x) => x.id === id)
      if (w) w.latest_build.status = 'starting'
    },
    stopWorkspace: async (id) => {
      const w = ws.find((x) => x.id === id)
      if (w) w.latest_build.status = 'stopping'
    },
    deleteWorkspace: async (id) => {
      const i = ws.findIndex((x) => x.id === id)
      if (i >= 0) ws.splice(i, 1)
    },
    createWorkspace: async (body) => {
      const tpl = STUB_TEMPLATES.find((t) => t.id === body.template_id) ?? STUB_TEMPLATES[0]
      const fresh: Workspace = {
        id: `ws-new-${Date.now().toString(36)}`,
        name: body.name,
        template_id: tpl.id,
        template_name: tpl.name,
        template_icon: tpl.icon,
        owner_name: 'me',
        latest_build: {
          id: `build-new-${Date.now().toString(36)}`,
          transition: 'start',
          status: 'pending',
          started_at: new Date().toISOString(),
        },
        outdated: false,
        ttl_ms: tpl.default_ttl_ms,
        last_used_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }
      ws.unshift(fresh)
      return fresh
    },
  }
})
