import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { workspace } from '@adhar-console/api-clients'
import { docStore, DocStoreError, type StoredDoc } from '@adhar-console/shell-ui'
import type { Permission } from './access.ts'

/**
 * Workspace data layer — REAL, tenant-scoped persistence through the console's
 * BFF (`/api/workspace/*`, Postgres document store) with Keycloak group
 * reflection for teams and org roles.
 *
 * Org / members / invitations / teams / projects / api-tokens / audit /
 * approvals all round-trip through the server; there is no in-memory fallback.
 * A missing database surfaces as a `WorkspaceApiError` with status 503 that
 * views render as a "connect a database" state — never fake data.
 *
 * Custom RBAC roles and webhooks keep their existing docStore persistence.
 * A handful of read-only surfaces outside this vertical (plan, usage,
 * integrations, environments) still read from the api-clients stub via
 * `wsClient` until their own verticals land.
 */

export const CURRENT_ORG_SLUG = 'current'

/* ─────────────────── BFF fetch wrapper ─────────────────── */

export class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'WorkspaceApiError'
  }
}

/** True when the error means "no database configured" (surface a connect-DB state). */
export function isDbUnavailable(e: unknown): boolean {
  return (
    (e instanceof WorkspaceApiError && e.status === 503) ||
    (e instanceof DocStoreError && e.status === 503)
  )
}

const ERROR_MESSAGE: Record<string, string> = {
  store_unavailable: 'The console database is not configured.',
  requires_admin_or_owner: 'This action requires the Admin or Owner role.',
  requires_owner: 'This action requires the Owner role.',
  cannot_demote_last_owner: 'The organization must keep at least one owner.',
  cannot_remove_last_owner: 'The organization must keep at least one owner.',
  cannot_remove_self: 'You cannot remove your own membership.',
  cannot_decide_own_request: 'You cannot approve or reject your own request.',
  confirmation_mismatch: 'The confirmation text does not match the organization name.',
  slug_taken: 'That slug is already in use.',
  invalid_email: 'Enter a valid email address.',
  already_decided: 'This request has already been decided.',
}

async function wsFetch<T>(
  path: string,
  init?: Omit<RequestInit, 'body'> & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await fetch(`/api/workspace/${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      accept: 'application/json',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  })
  if (!res.ok) {
    let code: string | undefined
    try {
      code = ((await res.json()) as { error?: string }).error
    } catch {
      /* non-JSON error body */
    }
    throw new WorkspaceApiError(
      (code && ERROR_MESSAGE[code]) ??
        (res.status === 503
          ? 'The console database is not configured.'
          : `Workspace request failed (${res.status}${code ? `: ${code}` : ''})`),
      res.status,
      code,
    )
  }
  return (await res.json()) as T
}

/* ─────────────────── API types ─────────────────── */

export type WsOrganization = workspace.Organization
export type WsMember = workspace.Member
export type WsInvitation = workspace.Invitation & { teams?: string[] }
export type WsProject = workspace.Project
export type WsAuditEvent = workspace.AuditEvent & { metadata?: Record<string, unknown> }
export type OrgRole = workspace.OrgRole

export interface WsTeam extends workspace.Team {
  keycloakGroup?: string
  keycloakSynced: boolean
}

export interface WsApiToken extends workspace.ApiToken {
  last4?: string
  createdBy?: string
}

export interface WorkspaceMe {
  userId: string
  email: string
  name: string
  role: OrgRole
  teams: string[]
  org: WsOrganization
  /** Whether the server can reflect changes into Keycloak groups (real RBAC). */
  keycloakConfigured: boolean
}

export interface ApprovalRequest {
  id: string
  scope: string
  summary: string
  status: 'pending' | 'approved' | 'rejected'
  requestedBy: { id: string; label: string }
  requestedAt: string
  decidedBy?: { id: string; label: string }
  decidedAt?: string
  note?: string
}

export interface AuditPage {
  items: WsAuditEvent[]
  total: number
  limit: number
  offset: number
}

/* ─────────────────── query keys ─────────────────── */

const K = {
  me: ['ws', 'me'] as const,
  org: ['ws', 'org'] as const,
  members: ['ws', 'members'] as const,
  invitations: ['ws', 'invitations'] as const,
  teams: ['ws', 'teams'] as const,
  projects: ['ws', 'projects'] as const,
  tokens: ['ws', 'tokens'] as const,
  approvals: ['ws', 'approvals'] as const,
  audit: (p: AuditParams) => ['ws', 'audit', p] as const,
}

/* ─────────────────── me / access ─────────────────── */

export function fetchWorkspaceMe(): Promise<WorkspaceMe> {
  return wsFetch<WorkspaceMe>('me')
}

export function useWorkspaceMe() {
  return useQuery({
    queryKey: K.me,
    queryFn: fetchWorkspaceMe,
    staleTime: 30_000,
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
  })
}

/* ─────────────────── organization ─────────────────── */

export function useOrg() {
  return useQuery({
    queryKey: K.org,
    queryFn: async () => (await wsFetch<{ item: WsOrganization }>('org')).item,
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
  })
}

export interface OrgPatch {
  name?: string
  description?: string
  domain?: string
  logoUrl?: string
  ssoEnforced?: boolean
  defaultProjectId?: string
}

export function useUpdateOrg() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: OrgPatch) =>
      wsFetch<{ item: WsOrganization }>('org', { method: 'PUT', json: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.org })
      qc.invalidateQueries({ queryKey: K.me })
    },
  })
}

export function useTransferOwnership() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      wsFetch<{ ok: boolean; keycloakSynced: boolean }>('org/transfer', {
        method: 'POST',
        json: { userId },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.members })
      qc.invalidateQueries({ queryKey: K.me })
    },
  })
}

export function useDeleteOrg() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (confirm: string) =>
      wsFetch<{ ok: boolean }>('org', { method: 'DELETE', json: { confirm } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws'] }),
  })
}

/* ─────────────────── members ─────────────────── */

export function useMembers() {
  return useQuery({
    queryKey: K.members,
    queryFn: async () => (await wsFetch<{ items: WsMember[] }>('members')).items,
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
  })
}

export function useUpdateMemberRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { userId: string; role: OrgRole }) =>
      wsFetch<{ item: WsMember; keycloakSynced: boolean }>(`members/${v.userId}`, {
        method: 'PATCH',
        json: { role: v.role },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.members })
      qc.invalidateQueries({ queryKey: K.me })
    },
  })
}

export function useRemoveMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      wsFetch<{ ok: boolean; keycloakSynced: boolean }>(`members/${userId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.members })
      qc.invalidateQueries({ queryKey: K.teams })
    },
  })
}

/* ─────────────────── invitations ─────────────────── */

export function useInvitations() {
  return useQuery({
    queryKey: K.invitations,
    queryFn: async () => (await wsFetch<{ items: WsInvitation[] }>('invitations')).items,
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
  })
}

export interface CreatedInvitation {
  item: WsInvitation
  /** Plaintext invite token — shown once; only a hash is stored server-side. */
  token: string
  acceptPath: string
}

export function useCreateInvitation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { email: string; role: OrgRole; teams?: string[] }) =>
      wsFetch<CreatedInvitation>('invitations', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.invitations }),
  })
}

export function useRevokeInvitation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      wsFetch<{ item: WsInvitation }>(`invitations/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.invitations }),
  })
}

/* ─────────────────── teams ─────────────────── */

export function useTeams() {
  return useQuery({
    queryKey: K.teams,
    queryFn: async () => (await wsFetch<{ items: WsTeam[] }>('teams')).items,
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
  })
}

export function useCreateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; slug?: string; description?: string }) =>
      wsFetch<{ item: WsTeam; keycloakSynced: boolean }>('teams', {
        method: 'POST',
        json: input,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.teams }),
  })
}

export function useUpdateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; name?: string; description?: string }) =>
      wsFetch<{ item: WsTeam }>(`teams/${v.id}`, {
        method: 'PATCH',
        json: { name: v.name, description: v.description },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.teams }),
  })
}

export function useDeleteTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      wsFetch<{ ok: boolean; keycloakSynced: boolean }>(`teams/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.teams })
      qc.invalidateQueries({ queryKey: K.members })
    },
  })
}

export function useAddTeamMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { teamId: string; userId: string }) =>
      wsFetch<{ item: WsTeam; keycloakSynced: boolean }>(`teams/${v.teamId}/members`, {
        method: 'POST',
        json: { userId: v.userId },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.teams })
      qc.invalidateQueries({ queryKey: K.members })
    },
  })
}

export function useRemoveTeamMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { teamId: string; userId: string }) =>
      wsFetch<{ item: WsTeam; keycloakSynced: boolean }>(
        `teams/${v.teamId}/members/${v.userId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.teams })
      qc.invalidateQueries({ queryKey: K.members })
    },
  })
}

/* ─────────────────── projects ─────────────────── */

export function useProjects() {
  return useQuery({
    queryKey: K.projects,
    queryFn: async () => (await wsFetch<{ items: WsProject[] }>('projects')).items,
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
  })
}

export interface ProjectInput {
  name: string
  slug?: string
  description?: string
  teams?: string[]
  environments?: string[]
  primaryRepo?: string
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ProjectInput) =>
      wsFetch<{ item: WsProject }>('projects', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.projects }),
  })
}

export function useUpdateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string } & Partial<ProjectInput>) => {
      const { id, ...patch } = v
      return wsFetch<{ item: WsProject }>(`projects/${id}`, { method: 'PATCH', json: patch })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: K.projects }),
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => wsFetch<{ ok: boolean }>(`projects/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.projects }),
  })
}

/* ─────────────────── API tokens ─────────────────── */

export function useApiTokens() {
  return useQuery({
    queryKey: K.tokens,
    queryFn: async () => (await wsFetch<{ items: WsApiToken[] }>('tokens')).items,
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
  })
}

export function useCreateApiToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; scopes: string[]; expiresAt?: string }) =>
      wsFetch<{ token: string; item: WsApiToken }>('tokens', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.tokens }),
  })
}

export function useRevokeApiToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => wsFetch<{ ok: boolean }>(`tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.tokens }),
  })
}

/* ─────────────────── audit log ─────────────────── */

export interface AuditParams {
  limit?: number
  offset?: number
  q?: string
  outcome?: 'success' | 'failure'
  action?: string
}

export function useAuditEvents(params: AuditParams) {
  return useQuery({
    queryKey: K.audit(params),
    queryFn: () => {
      const search = new URLSearchParams()
      if (params.limit) search.set('limit', String(params.limit))
      if (params.offset) search.set('offset', String(params.offset))
      if (params.q) search.set('q', params.q)
      if (params.outcome) search.set('outcome', params.outcome)
      if (params.action) search.set('action', params.action)
      const qs = search.toString()
      return wsFetch<AuditPage>(`audit${qs ? `?${qs}` : ''}`)
    },
    placeholderData: (prev) => prev,
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
  })
}

/* ─────────────────── approvals queue ─────────────────── */

export const APPROVAL_SCOPES = [
  'production-deploy',
  'budget-increase',
  'role-grant-owner',
  'data-export',
  'destructive-rbac',
  'cluster-delete',
] as const
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number]

export function useApprovalRequests() {
  return useQuery({
    queryKey: K.approvals,
    queryFn: async () => (await wsFetch<{ items: ApprovalRequest[] }>('approvals')).items,
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
  })
}

export function useCreateApprovalRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { scope: ApprovalScope; summary: string }) =>
      wsFetch<{ item: ApprovalRequest }>('approvals', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.approvals }),
  })
}

export function useDecideApproval() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject'; note?: string }) =>
      wsFetch<{ item: ApprovalRequest }>(`approvals/${v.id}/${v.decision}`, {
        method: 'POST',
        json: { note: v.note },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.approvals }),
  })
}

/* ─────────────────── approval policies (docStore-backed config) ─────────────────── */

/**
 * Which high-blast-radius actions require a second approver. The catalog of
 * scopes is fixed (each maps to a real guarded action); the per-policy config
 * (`approversRequired` / `approverRoles` / `enabled`) is persisted per tenant in
 * the document store and merged over these defaults.
 */
export interface ApprovalPolicy {
  id: string
  scope: ApprovalScope
  description: string
  approversRequired: number
  approverRoles: string[]
  enabled: boolean
}

const APPROVAL_POLICY_KIND = 'workspace.approval-policy'

const DEFAULT_APPROVAL_POLICIES: ApprovalPolicy[] = [
  { id: 'production-deploy', scope: 'production-deploy', description: 'Promotion to a Kargo stage tagged "production".', approversRequired: 2, approverRoles: ['admin', 'owner'], enabled: true },
  { id: 'budget-increase', scope: 'budget-increase', description: 'Lifting a budget cap by more than 10%.', approversRequired: 1, approverRoles: ['billing', 'owner'], enabled: true },
  { id: 'role-grant-owner', scope: 'role-grant-owner', description: 'Granting the Owner role to any member.', approversRequired: 2, approverRoles: ['owner'], enabled: true },
  { id: 'data-export', scope: 'data-export', description: 'Bulk exporting tenant data outside the home region.', approversRequired: 2, approverRoles: ['admin', 'owner'], enabled: true },
  { id: 'destructive-rbac', scope: 'destructive-rbac', description: 'Removing the only Owner / disabling SSO enforcement.', approversRequired: 2, approverRoles: ['owner'], enabled: true },
  { id: 'cluster-delete', scope: 'cluster-delete', description: 'Deleting a Kubernetes cluster registered in the platform.', approversRequired: 2, approverRoles: ['admin', 'owner'], enabled: false },
]

type ApprovalPolicyOverride = Pick<ApprovalPolicy, 'approversRequired' | 'approverRoles' | 'enabled'>

const APPROVAL_POLICIES_KEY = ['ws', 'approval-policies'] as const

/** Read the policy catalog with tenant-persisted overrides merged over the defaults. */
export function useApprovalPolicies() {
  return useQuery({
    queryKey: APPROVAL_POLICIES_KEY,
    queryFn: async (): Promise<ApprovalPolicy[]> => {
      const stored = await docStore.list<ApprovalPolicyOverride>(APPROVAL_POLICY_KIND)
      const byId = new Map(stored.map((d) => [d.id, d.data]))
      return DEFAULT_APPROVAL_POLICIES.map((p) => {
        const o = byId.get(p.id)
        return o ? { ...p, ...o, approverRoles: [...(o.approverRoles ?? p.approverRoles)] } : p
      })
    },
    retry: (count, err) => !isDbUnavailable(err) && count < 2,
    staleTime: 60_000,
  })
}

/** Persist a policy's config (enable/disable, approver count/roles) for the tenant. */
export function useSaveApprovalPolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: ApprovalPolicy) =>
      docStore.put<ApprovalPolicyOverride>(APPROVAL_POLICY_KIND, p.id, {
        approversRequired: p.approversRequired,
        approverRoles: [...p.approverRoles],
        enabled: p.enabled,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: APPROVAL_POLICIES_KEY }),
  })
}

/* ─────────────────── base client (out-of-vertical reads) ─────────────────── */

/**
 * Read-only surfaces outside the team/org vertical (plan, usage, integrations,
 * environments) still read the api-clients stub until their verticals land.
 * Nothing in the org / members / teams / projects / tokens / audit / approvals
 * flows uses this.
 */
export const wsClient = workspace.WorkspaceClient.stub()

/* ─────────────────── document-store kinds ─────────────────── */

const ROLE_KIND = 'workspace.role'
const WEBHOOK_KIND = 'workspace.webhook'
const DELIVERY_KIND = 'workspace.webhook-delivery'

/* ─────────────────── Custom RBAC roles ─────────────────── */

export interface CustomRole {
  id: string
  name: string
  description?: string
  permissions: Permission[]
  createdAt: string
  updatedAt: string
}

export interface RoleInput {
  name: string
  description?: string
  permissions: Permission[]
}

interface RoleData {
  name: string
  description?: string
  permissions: Permission[]
}

function toRole(doc: StoredDoc<RoleData>): CustomRole {
  return {
    id: doc.id,
    name: doc.data.name,
    description: doc.data.description,
    permissions: [...(doc.data.permissions ?? [])],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/* ─────────────────── Webhooks ─────────────────── */

type Webhook = workspace.Webhook

export interface WebhookInput {
  url: string
  events: string[]
  active: boolean
  /** Optional new signing secret; omitted on edit keeps the existing one. */
  secret?: string
}

interface WebhookData {
  url: string
  events: string[]
  active: boolean
  /** Stored server-side only; the client surfaces it as the `secretSet` flag. */
  secret?: string
  lastDeliveryAt?: string
  lastDeliveryStatus?: 'success' | 'failure'
}

export interface WebhookDelivery {
  id: string
  webhookId: string
  event: string
  status: 'success' | 'failure'
  statusCode: number
  durationMs: number
  at: string
}

type DeliveryData = Omit<WebhookDelivery, 'id'>

function toWebhook(doc: StoredDoc<WebhookData>): Webhook {
  return {
    id: doc.id,
    url: doc.data.url,
    events: [...(doc.data.events ?? [])],
    active: doc.data.active,
    secretSet: Boolean(doc.data.secret),
    lastDeliveryAt: doc.data.lastDeliveryAt,
    lastDeliveryStatus: doc.data.lastDeliveryStatus,
  }
}

function toDelivery(doc: StoredDoc<DeliveryData>): WebhookDelivery {
  return { id: doc.id, ...doc.data }
}

/* ─────────────────── Custom roles (docStore-backed) ─────────────────── */

export async function listCustomRoles(): Promise<CustomRole[]> {
  const docs = await docStore.list<RoleData>(ROLE_KIND)
  return docs.map(toRole)
}

export async function createRole(input: RoleInput): Promise<CustomRole> {
  const doc = await docStore.create<RoleData>(ROLE_KIND, {
    name: input.name,
    description: input.description,
    permissions: [...input.permissions],
  })
  return toRole(doc)
}

export async function updateRole(id: string, patch: Partial<RoleInput>): Promise<CustomRole> {
  const existing = await docStore.get<RoleData>(ROLE_KIND, id)
  if (!existing) throw new Error(`Role ${id} not found`)
  const next: RoleData = {
    name: patch.name ?? existing.data.name,
    description: patch.description ?? existing.data.description,
    permissions: patch.permissions ? [...patch.permissions] : existing.data.permissions,
  }
  const doc = await docStore.put<RoleData>(ROLE_KIND, id, next)
  return toRole(doc)
}

export async function deleteRole(id: string): Promise<void> {
  await docStore.remove(ROLE_KIND, id)
}

/* ─────────────────── Webhooks (docStore-backed) ─────────────────── */

export async function listWebhooks(): Promise<Webhook[]> {
  const docs = await docStore.list<WebhookData>(WEBHOOK_KIND)
  return docs.map(toWebhook)
}

export async function createWebhook(input: WebhookInput): Promise<Webhook> {
  const doc = await docStore.create<WebhookData>(WEBHOOK_KIND, {
    url: input.url,
    events: [...input.events],
    active: input.active,
    secret: input.secret,
  })
  return toWebhook(doc)
}

export async function updateWebhook(id: string, input: WebhookInput): Promise<Webhook> {
  const existing = await docStore.get<WebhookData>(WEBHOOK_KIND, id)
  if (!existing) throw new Error(`Webhook ${id} not found`)
  const next: WebhookData = {
    ...existing.data,
    url: input.url,
    events: [...input.events],
    active: input.active,
    // Blank secret on edit keeps the existing one.
    secret: input.secret ?? existing.data.secret,
  }
  const doc = await docStore.put<WebhookData>(WEBHOOK_KIND, id, next)
  return toWebhook(doc)
}

export async function deleteWebhook(id: string): Promise<void> {
  await docStore.remove(WEBHOOK_KIND, id)
}

/**
 * Simulate a signed test delivery, record it as a real `workspace.webhook-delivery`
 * document, and stamp the webhook's last-delivery fields via `docStore.put`.
 */
export async function testWebhook(id: string): Promise<WebhookDelivery> {
  const existing = await docStore.get<WebhookData>(WEBHOOK_KIND, id)
  if (!existing) throw new Error(`Webhook ${id} not found`)

  const ok = Math.random() > 0.15
  const at = new Date().toISOString()
  const deliveryData: DeliveryData = {
    webhookId: id,
    event: 'ping.test',
    status: ok ? 'success' : 'failure',
    statusCode: ok ? 200 : 502,
    durationMs: Math.round(70 + Math.random() * 430),
    at,
  }

  const doc = await docStore.create<DeliveryData>(DELIVERY_KIND, deliveryData)

  await docStore.put<WebhookData>(WEBHOOK_KIND, id, {
    ...existing.data,
    lastDeliveryAt: at,
    lastDeliveryStatus: deliveryData.status,
  })

  return toDelivery(doc)
}

export async function listWebhookDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
  const docs = await docStore.list<DeliveryData>(DELIVERY_KIND)
  return docs
    .filter((d) => d.data.webhookId === webhookId)
    .map(toDelivery)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 8)
}
