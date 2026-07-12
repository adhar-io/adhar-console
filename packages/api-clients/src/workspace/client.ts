import { HttpClient, type HttpClientOptions } from '../base/index.ts'
import type {
  ApiToken,
  AuditEvent,
  CreateOrgInput,
  CreateProjectInput,
  Environment,
  Integration,
  InviteMemberInput,
  Invitation,
  Member,
  Organization,
  Plan,
  Project,
  Team,
  Usage,
  Webhook,
} from './types.ts'
import {
  STUB_AUDIT,
  STUB_ENVIRONMENTS,
  STUB_INTEGRATIONS,
  STUB_INVITATIONS,
  STUB_MEMBERS,
  STUB_ORGS,
  STUB_PLAN,
  STUB_PROJECTS,
  STUB_TEAMS,
  STUB_TOKENS,
  STUB_USAGE,
  STUB_WEBHOOKS,
} from './stub.ts'

export interface WorkspaceClient {
  listOrganizations(): Promise<Organization[]>
  getOrganization(slug: string): Promise<Organization>
  createOrganization(input: CreateOrgInput): Promise<Organization>
  updateOrganization(slug: string, patch: Partial<Organization>): Promise<Organization>
  deleteOrganization(slug: string): Promise<void>

  listMembers(orgSlug: string): Promise<Member[]>
  inviteMember(orgSlug: string, input: InviteMemberInput): Promise<Invitation>
  listInvitations(orgSlug: string): Promise<Invitation[]>
  revokeInvitation(orgSlug: string, invitationId: string): Promise<void>
  updateMemberRole(orgSlug: string, userId: string, role: Member['role']): Promise<void>
  removeMember(orgSlug: string, userId: string): Promise<void>

  listTeams(orgSlug: string): Promise<Team[]>
  createTeam(orgSlug: string, team: { slug: string; name: string; description?: string }): Promise<Team>

  listProjects(orgSlug: string): Promise<Project[]>
  getProject(orgSlug: string, projectSlug: string): Promise<Project>
  createProject(orgSlug: string, input: CreateProjectInput): Promise<Project>

  listEnvironments(orgSlug: string, projectSlug: string): Promise<Environment[]>

  listIntegrations(orgSlug: string): Promise<Integration[]>

  listApiTokens(orgSlug: string): Promise<ApiToken[]>
  createApiToken(
    orgSlug: string,
    input: { name: string; scopes: string[]; expiresAt?: string },
  ): Promise<{ token: string; metadata: ApiToken }>
  revokeApiToken(orgSlug: string, tokenId: string): Promise<void>

  listAuditEvents(orgSlug: string, params?: { limit?: number }): Promise<AuditEvent[]>

  getPlan(orgSlug: string): Promise<Plan>
  getUsage(orgSlug: string): Promise<Usage>

  listWebhooks(orgSlug: string): Promise<Webhook[]>
}

function build(http: HttpClient): WorkspaceClient {
  const base = (slug: string) => `/api/v1/orgs/${slug}`
  return {
    listOrganizations: () => http.get<Organization[]>('/api/v1/orgs'),
    getOrganization: (s) => http.get<Organization>(base(s)),
    createOrganization: (i) => http.post<Organization>('/api/v1/orgs', i),
    updateOrganization: (s, p) => http.patch<Organization>(base(s), p),
    deleteOrganization: async (s) => {
      await http.delete<void>(base(s))
    },
    listMembers: (s) => http.get<Member[]>(`${base(s)}/members`),
    inviteMember: (s, i) => http.post<Invitation>(`${base(s)}/invitations`, i),
    listInvitations: (s) => http.get<Invitation[]>(`${base(s)}/invitations`),
    revokeInvitation: async (s, id) => {
      await http.delete<void>(`${base(s)}/invitations/${id}`)
    },
    updateMemberRole: async (s, u, r) => {
      await http.patch<void>(`${base(s)}/members/${u}`, { role: r })
    },
    removeMember: async (s, u) => {
      await http.delete<void>(`${base(s)}/members/${u}`)
    },
    listTeams: (s) => http.get<Team[]>(`${base(s)}/teams`),
    createTeam: (s, t) => http.post<Team>(`${base(s)}/teams`, t),
    listProjects: (s) => http.get<Project[]>(`${base(s)}/projects`),
    getProject: (s, p) => http.get<Project>(`${base(s)}/projects/${p}`),
    createProject: (s, i) => http.post<Project>(`${base(s)}/projects`, i),
    listEnvironments: (s, p) => http.get<Environment[]>(`${base(s)}/projects/${p}/environments`),
    listIntegrations: (s) => http.get<Integration[]>(`${base(s)}/integrations`),
    listApiTokens: (s) => http.get<ApiToken[]>(`${base(s)}/tokens`),
    createApiToken: (s, i) => http.post<{ token: string; metadata: ApiToken }>(`${base(s)}/tokens`, i),
    revokeApiToken: async (s, id) => {
      await http.delete<void>(`${base(s)}/tokens/${id}`)
    },
    listAuditEvents: (s, p) =>
      http.get<AuditEvent[]>(`${base(s)}/audit${p?.limit ? `?limit=${p.limit}` : ''}`),
    getPlan: (s) => http.get<Plan>(`${base(s)}/plan`),
    getUsage: (s) => http.get<Usage>(`${base(s)}/usage`),
    listWebhooks: (s) => http.get<Webhook[]>(`${base(s)}/webhooks`),
  }
}

function stub(): WorkspaceClient {
  return {
    listOrganizations: async () => STUB_ORGS,
    getOrganization: async (s) => {
      const o = STUB_ORGS.find((x) => x.slug === s)
      if (!o) throw new Error(`Stub: org ${s} not found`)
      return o
    },
    createOrganization: async (i) => ({
      id: `org-${i.slug}`,
      slug: i.slug,
      name: i.name,
      region: i.region,
      plan: i.plan,
      createdAt: new Date().toISOString(),
      ssoEnforced: false,
    }),
    updateOrganization: async (s, p) => {
      const o = STUB_ORGS.find((x) => x.slug === s)!
      return { ...o, ...p }
    },
    deleteOrganization: async () => {},
    listMembers: async () => STUB_MEMBERS,
    inviteMember: async (_s, i) => ({
      id: `inv-${Date.now()}`,
      email: i.email,
      role: i.role,
      invitedBy: 'stub-user-1',
      invitedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      status: 'pending',
    }),
    listInvitations: async () => STUB_INVITATIONS,
    revokeInvitation: async () => {},
    updateMemberRole: async () => {},
    removeMember: async () => {},
    listTeams: async () => STUB_TEAMS,
    createTeam: async (_s, t) => ({
      id: `team-${t.slug}`,
      slug: t.slug,
      name: t.name,
      description: t.description,
      memberCount: 1,
      projectCount: 0,
      createdAt: new Date().toISOString(),
    }),
    listProjects: async () => STUB_PROJECTS,
    getProject: async (_s, p) => {
      const project = STUB_PROJECTS.find((x) => x.slug === p)
      if (!project) throw new Error(`Stub: project ${p} not found`)
      return project
    },
    createProject: async (_s, i) => ({
      id: `proj-${i.slug}`,
      slug: i.slug,
      name: i.name,
      tenantId: 'acme',
      teams: i.teams,
      giteaOrg: 'acme',
      argoProject: 'acme',
      harborProject: 'acme',
      environments: i.environments,
      createdAt: new Date().toISOString(),
    }),
    listEnvironments: async () => STUB_ENVIRONMENTS,
    listIntegrations: async () => STUB_INTEGRATIONS,
    listApiTokens: async () => STUB_TOKENS,
    createApiToken: async (_s, i) => ({
      token: `adhar_pat_stub_${Math.random().toString(36).slice(2, 12)}`,
      metadata: {
        id: `tok-${Date.now()}`,
        name: i.name,
        prefix: 'adhar_pat_stub_',
        scopes: i.scopes,
        ownerType: 'org',
        ownerId: 'acme',
        createdAt: new Date().toISOString(),
        expiresAt: i.expiresAt,
      },
    }),
    revokeApiToken: async () => {},
    listAuditEvents: async (_s, p) =>
      p?.limit ? STUB_AUDIT.slice(0, p.limit) : STUB_AUDIT,
    getPlan: async () => STUB_PLAN,
    getUsage: async () => STUB_USAGE,
    listWebhooks: async () => STUB_WEBHOOKS,
  }
}

export const WorkspaceClient = {
  create: (opts: HttpClientOptions) => build(new HttpClient(opts)),
  stub,
}
