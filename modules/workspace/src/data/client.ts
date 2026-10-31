import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { workspace } from '@adhar/api-clients'
import { docStore, DocStoreError, type StoredDoc, useLiveInvalidate, usePollingInterval } from '@adhar/shell-ui'
import type { Permission } from './access.ts'
import { type MemberStatus, type OrgRole, type OrgVia, workspaceErrorMessage } from './members-model.ts'

/**
 * Workspace data layer — REAL, tenant-scoped data through the console's BFF
 * (`/api/workspace/*`).
 *
 * People are Keycloak's: an organisation's members are the Keycloak groups
 * `org-<slug>` and `org-<slug>-admin`, and a team is the group
 * `ws-team-<org>.<team>`. The console stores no member, role or invitation
 * records — listing members reads those groups, and adding, removing or
 * promoting someone writes them. A Keycloak failure on a write is an error
 * (503 / 502), never a quiet "saved, console-only".
 *
 * Org settings / teams / projects / api-tokens / audit / approvals round-trip
 * through the server's Postgres document store; there is no in-memory
 * fallback. A missing database surfaces as a `WorkspaceApiError` with code
 * `store_unavailable` that views render as a "connect a database" state —
 * never fake data.
 *
 * Custom RBAC roles and webhooks keep their existing docStore persistence.
 */

export const CURRENT_ORG_SLUG = 'current'

/* ─────────────────── BFF fetch wrapper ─────────────────── */

export class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The server's own explanation, when it sent one. */
    readonly detail?: string,
    /** The whole error body — some codes carry more (`user_exists` → `userId`, `already_member` → `item`). */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'WorkspaceApiError'
  }
}

/**
 * True when the error means "no database configured" (surface a connect-DB
 * state). A 503 from Keycloak or from the access check is NOT that — those are
 * outages, retried and shown with their own message.
 */
export function isDbUnavailable(e: unknown): boolean {
  if (e instanceof WorkspaceApiError) return e.status === 503 && (!e.code || e.code === 'store_unavailable')
  return e instanceof DocStoreError && e.status === 503
}

/** Retry outages, never answers: a 4xx or a missing database will not change on the next try. */
function shouldRetry(count: number, err: unknown): boolean {
  if (count >= 2 || isDbUnavailable(err)) return false
  return !(err instanceof WorkspaceApiError && err.status < 500)
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
    let body: Record<string, unknown> = {}
    try {
      const parsed = await res.json()
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
    } catch {
      /* non-JSON error body */
    }
    const code = typeof body.error === 'string' ? body.error : undefined
    const detail = typeof body.detail === 'string' ? body.detail : undefined
    throw new WorkspaceApiError(
      workspaceErrorMessage({ status: res.status, code, detail, partial: body.partial === true }),
      res.status,
      code,
      detail,
      body,
    )
  }
  return (await res.json()) as T
}

/* ─────────────────── API types ─────────────────── */

export type { OrgRole, OrgVia }
export type WsOrganization = workspace.Organization
export type WsProject = workspace.Project
export type WsAuditEvent = workspace.AuditEvent & { metadata?: Record<string, unknown> }

/** A person in the active organisation, read from its Keycloak groups. */
export interface WsMember {
  /** Keycloak user id. */
  userId: string
  email: string
  /** "first last", else the username, else the email. */
  name: string
  username: string
  /** `admin` = in `org-<slug>-admin`. */
  role: OrgRole
  /** Slugs of this organisation's teams the person is in. */
  teams: string[]
  status: MemberStatus
  /** When the Keycloak account was created. */
  createdAt?: string
}

export interface MembersResponse {
  /** Everyone in `org-<slug>` or `org-<slug>-admin`. */
  items: WsMember[]
  /**
   * Groups whose members hold a role here without being listed: the platform
   * admin groups (admin of every organisation) and, in the platform
   * organisation only, the platform team (members).
   */
  implicit: Array<{ group: string; role: OrgRole }>
  /** The list stopped at the server's cap. */
  truncated: boolean
  /**
   * Whether Keycloak can email a set-password link (the realm has an SMTP
   * server). False: "New account" cannot work, so Add people leads with "ask
   * them to sign up". Null: Keycloak would not say.
   */
  canEmail?: boolean | null
}

export interface WsTeam {
  id: string
  slug: string
  name: string
  description?: string
  createdAt: string
  /** The Keycloak group that IS the team's membership: `ws-team-<org>.<team>`. */
  group: string
  /** Same as `group`; kept for older readers. */
  keycloakGroup: string
  /** Null when Keycloak could not be read. */
  memberCount: number | null
  projectCount: number
  /**
   * Whether cluster RBAC already binds `group`. `pending-platform-upgrade`: the
   * Team resource still publishes the old organisation-less group, so access
   * granted through this team reaches Kubernetes after the next platform
   * upgrade.
   */
  accessBinding: 'current' | 'pending-platform-upgrade' | 'unknown'
}

export interface TeamsResponse {
  items: WsTeam[]
  /** Member counts could not be read from Keycloak. */
  degraded?: boolean
}

/** A team member, as `GET /teams/:id/members` lists them. */
export type WsTeamMember = Pick<WsMember, 'userId' | 'email' | 'name' | 'status'>

/** A Keycloak account found by `GET /users`, with its membership here. */
export interface DirectoryUser {
  userId: string
  email: string
  name: string
  username: string
  enabled: boolean
  /**
   * Whether Keycloak verified the account's email. The realm lets anyone sign
   * up with any address, so an unverified account found by email may be
   * someone else's; only a platform admin may add one, explicitly.
   */
  emailVerified: boolean
  /** Role in the active organisation, or null when not a member. */
  membership: OrgRole | null
}

export interface UserSearch {
  items: DirectoryUser[]
  /** `exact`: email/username match only (org admins); `search`: directory search (platform admins). */
  mode: 'exact' | 'search'
}

export type SetupEmailResult =
  | { sent: true }
  | { sent: false; reason: 'send_failed'; detail?: string }

export interface CreatedUser {
  item: WsMember
  setupEmail: SetupEmailResult
}

export interface WsApiToken extends workspace.ApiToken {
  last4?: string
  createdBy?: string
}

export interface WorkspaceMe {
  userId: string
  email: string
  name: string
  /** Null in a personal tenant — the user is in no organisation. */
  role: OrgRole | null
  via: OrgVia | null
  /** This organisation's teams the user is in. */
  teams: string[]
  /** The organisation's Keycloak / control-plane slug (not the tenant id). */
  orgSlug: string | null
  /** The platform's own organisation — it cannot be deleted. */
  isPlatformOrganisation: boolean
  org: WsOrganization | null
  /** Whether the console holds a Keycloak admin credential (membership is read and written there). */
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
  // Under `teams`, so invalidating the team list refreshes every team's members too.
  teams: ['ws', 'teams'] as const,
  teamMembers: (id: string) => ['ws', 'teams', id, 'members'] as const,
  users: (q: string) => ['ws', 'users', q] as const,
  projects: ['ws', 'projects'] as const,
  tokens: ['ws', 'tokens'] as const,
  approvals: ['ws', 'approvals'] as const,
  audit: (p: AuditParams) => ['ws', 'audit', p] as const,
}

/** Billing's seat count is the size of the member list. */
const BILLING_KEY = ['billing'] as const

/* ─────────────────── me / access ─────────────────── */

export function fetchWorkspaceMe(): Promise<WorkspaceMe> {
  return wsFetch<WorkspaceMe>('me')
}

export function useWorkspaceMe() {
  return useQuery({
    queryKey: K.me,
    queryFn: fetchWorkspaceMe,
    staleTime: 30_000,
    retry: shouldRetry,
  })
}

/* ─────────────────── organization ─────────────────── */

export function useOrg() {
  return useQuery({
    queryKey: K.org,
    queryFn: async () => (await wsFetch<{ item: WsOrganization }>('org')).item,
    retry: shouldRetry,
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

export function useDeleteOrg() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (confirm: string) =>
      // `retained`: what deleting the organisation deliberately leaves in place.
      wsFetch<{ ok: boolean; retained?: string[] }>('org', { method: 'DELETE', json: { confirm } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws'] }),
  })
}

/* ─────────────────── members (Keycloak groups) ─────────────────── */

function fetchMembers(): Promise<MembersResponse> {
  return wsFetch<MembersResponse>('members')
}

/** The member list with what it leaves out — implicit admins, and whether it was capped. */
export function useMembersPage() {
  return useQuery({ queryKey: K.members, queryFn: fetchMembers, retry: shouldRetry })
}

/** Just the people (same request and cache as `useMembersPage`). */
export function useMembers() {
  return useQuery({
    queryKey: K.members,
    queryFn: fetchMembers,
    select: (page: MembersResponse) => page.items,
    retry: shouldRetry,
  })
}

/** Everything a membership change can move: the list, team counts, your own role, seats. */
function invalidateMembership(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: K.members })
  qc.invalidateQueries({ queryKey: K.teams })
  qc.invalidateQueries({ queryKey: K.me })
  qc.invalidateQueries({ queryKey: ['ws', 'users'] })
  qc.invalidateQueries({ queryKey: BILLING_KEY })
}

/** Add an existing Keycloak account to the organisation (and optionally to teams). */
export function useAddMember() {
  const qc = useQueryClient()
  return useMutation({
    // `allowUnverifiedEmail`: a platform admin vouching for an account whose
    // email Keycloak never verified (refused for anyone else).
    mutationFn: (input: { userId: string; role?: OrgRole; teams?: string[]; allowUnverifiedEmail?: boolean }) =>
      wsFetch<{ item: WsMember }>('members', { method: 'POST', json: input }),
    onSuccess: () => invalidateMembership(qc),
  })
}

/**
 * Create a Keycloak account and add it here. Keycloak emails the person a
 * set-password link; `setupEmail.sent` says whether that email went out.
 */
export function useCreateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { email: string; firstName?: string; lastName?: string; role: OrgRole; teams?: string[] }) =>
      wsFetch<CreatedUser>('users', { method: 'POST', json: input }),
    onSuccess: () => invalidateMembership(qc),
  })
}

/** Send the set-password email again, for a member who has not set one yet. */
export function useResendSetupEmail() {
  return useMutation({
    mutationFn: (userId: string) =>
      wsFetch<{ setupEmail: SetupEmailResult }>(`users/${encodeURIComponent(userId)}/setup-email`, { method: 'POST' }),
  })
}

/**
 * Find Keycloak accounts to add. Org admins get exact email / username
 * matches; platform admins get a directory search (`mode` says which).
 */
export function useSearchUsers(q: string) {
  const query = q.trim()
  return useQuery({
    queryKey: K.users(query),
    queryFn: () => wsFetch<UserSearch>(`users?${new URLSearchParams({ q: query, max: '20' })}`),
    enabled: query.length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    retry: shouldRetry,
  })
}

export function useUpdateMemberRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { userId: string; role: OrgRole }) =>
      wsFetch<{ item: WsMember }>(`members/${encodeURIComponent(v.userId)}`, {
        method: 'PATCH',
        json: { role: v.role },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.members })
      qc.invalidateQueries({ queryKey: K.me })
    },
  })
}

/** Remove someone from the organisation's groups — and its team groups. Their Keycloak account stays. */
export function useRemoveMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      wsFetch<{ ok: boolean }>(`members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    onSuccess: () => invalidateMembership(qc),
  })
}

/* ─────────────────── teams ─────────────────── */

function fetchTeams(): Promise<TeamsResponse> {
  return wsFetch<TeamsResponse>('teams')
}

/** Teams with whether their member counts could be read. */
export function useTeamsPage() {
  return useQuery({ queryKey: K.teams, queryFn: fetchTeams, retry: shouldRetry })
}

export function useTeams() {
  return useQuery({
    queryKey: K.teams,
    queryFn: fetchTeams,
    select: (page: TeamsResponse) => page.items,
    retry: shouldRetry,
  })
}

export function useTeamMembers(teamId: string | undefined) {
  return useQuery({
    queryKey: K.teamMembers(teamId ?? ''),
    queryFn: async () =>
      (await wsFetch<{ items: WsTeamMember[] }>(`teams/${encodeURIComponent(teamId!)}/members`)).items,
    enabled: !!teamId,
    retry: shouldRetry,
  })
}

export function useCreateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; slug?: string; description?: string }) =>
      wsFetch<{ item: WsTeam }>('teams', {
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
      wsFetch<{ item: WsTeam }>(`teams/${encodeURIComponent(v.id)}`, {
        method: 'PATCH',
        json: { name: v.name, description: v.description },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: K.teams }),
  })
}

export function useDeleteTeam() {
  const qc = useQueryClient()
  return useMutation({
    // `controlPlaneSynced: false` — the Team resource (and its Gitea team) was
    // left in place; the page says so rather than implying it is gone.
    mutationFn: (id: string) =>
      wsFetch<{ ok: boolean; controlPlaneSynced?: boolean; controlPlaneDetail?: string }>(`teams/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.teams })
      qc.invalidateQueries({ queryKey: K.members })
      qc.invalidateQueries({ queryKey: K.me })
    },
  })
}

export function useAddTeamMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { teamId: string; userId: string }) =>
      wsFetch<{ item: WsTeam }>(`teams/${encodeURIComponent(v.teamId)}/members`, {
        method: 'POST',
        json: { userId: v.userId },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.teams })
      qc.invalidateQueries({ queryKey: K.members })
      qc.invalidateQueries({ queryKey: K.me })
    },
  })
}

export function useRemoveTeamMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { teamId: string; userId: string }) =>
      wsFetch<{ item: WsTeam }>(
        `teams/${encodeURIComponent(v.teamId)}/members/${encodeURIComponent(v.userId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: K.teams })
      qc.invalidateQueries({ queryKey: K.members })
      qc.invalidateQueries({ queryKey: K.me })
    },
  })
}

/* ─────────────────── projects ─────────────────── */

export function useProjects() {
  return useQuery({
    queryKey: K.projects,
    queryFn: async () => (await wsFetch<{ items: WsProject[] }>('projects')).items,
    retry: shouldRetry,
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
    retry: shouldRetry,
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
  /** Action prefix, e.g. `team.` or `team.create`. */
  action?: string
  /** Actor id (exact). */
  actor?: string
  actorType?: 'user' | 'token' | 'system'
  targetType?: string
  /** ISO bounds on the event time. */
  from?: string
  to?: string
  sort?: 'asc' | 'desc'
}

export interface AuditFacets {
  sampled: number
  total: number
  actions: Array<{ value: string; n: number }>
  actorTypes: Array<{ value: string; n: number }>
  targetTypes: Array<{ value: string; n: number }>
  actors: Array<{ id: string; label: string; n: number }>
}

export function auditQueryString(params: AuditParams): string {
  const search = new URLSearchParams()
  const set = (k: string, v: string | number | undefined) => {
    if (v !== undefined && v !== '') search.set(k, String(v))
  }
  set('limit', params.limit)
  set('offset', params.offset)
  set('q', params.q)
  set('outcome', params.outcome)
  set('action', params.action)
  set('actor', params.actor)
  set('actorType', params.actorType)
  set('targetType', params.targetType)
  set('from', params.from)
  set('to', params.to)
  set('sort', params.sort)
  return search.toString()
}

/**
 * `liveMs` turns on the live tail. It rides TanStack's own `refetchInterval`
 * (rather than a hand-rolled timer) so polling pauses while the tab is hidden
 * and never overlaps an in-flight request. The shared QueryClient floors it at
 * one minute (`POLL_FLOOR_MS`).
 */
/**
 * Audit events. With `live`, the hub's `audit` topic pushes on every audit
 * write and the page refetches then; the 60s timer only runs while the
 * socket is down.
 */
export function useAuditEvents(params: AuditParams, live = false) {
  const key = K.audit(params)
  useLiveInvalidate('audit', {}, [key], live)
  const fallback = usePollingInterval(60_000)
  return useQuery({
    queryKey: key,
    refetchInterval: live ? fallback : false,
    queryFn: () => {
      const qs = auditQueryString(params)
      return wsFetch<AuditPage>(`audit${qs ? `?${qs}` : ''}`)
    },
    placeholderData: (prev) => prev,
    retry: shouldRetry,
  })
}

/** Distinct values for the audit filter menus (sampled from the newest 2k events). */
export function useAuditFacets() {
  return useQuery({
    queryKey: ['ws', 'audit', 'facets'] as const,
    queryFn: () => wsFetch<AuditFacets>('audit/facets'),
    staleTime: 60_000,
    retry: shouldRetry,
  })
}

/** Fetch every matching event page-by-page for a full export (bounded). */
export async function fetchAllAuditEvents(params: AuditParams, max = 50_000): Promise<WsAuditEvent[]> {
  const out: WsAuditEvent[] = []
  const limit = 500
  for (let offset = 0; offset < max; offset += limit) {
    const qs = auditQueryString({ ...params, limit, offset })
    const page = await wsFetch<AuditPage>(`audit?${qs}`)
    out.push(...page.items)
    if (page.items.length < limit || out.length >= page.total) break
  }
  return out
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
    retry: shouldRetry,
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

// An organisation has two roles, admin and member, and deciding a request
// takes organisation admin (`approvalsDecide`) — so admins are the approvers.
// `role-grant-owner` keeps its id for the overrides tenants already saved; it
// now guards granting organisation admin, since there is no owner any more.
const DEFAULT_APPROVAL_POLICIES: ApprovalPolicy[] = [
  { id: 'production-deploy', scope: 'production-deploy', description: 'Promotion to a Kargo stage tagged "production".', approversRequired: 2, approverRoles: ['admin'], enabled: true },
  { id: 'budget-increase', scope: 'budget-increase', description: 'Lifting a budget cap by more than 10%.', approversRequired: 1, approverRoles: ['admin'], enabled: true },
  { id: 'role-grant-owner', scope: 'role-grant-owner', description: 'Granting organisation admin to any member.', approversRequired: 2, approverRoles: ['admin'], enabled: true },
  { id: 'data-export', scope: 'data-export', description: 'Bulk exporting tenant data outside the home region.', approversRequired: 2, approverRoles: ['admin'], enabled: true },
  { id: 'destructive-rbac', scope: 'destructive-rbac', description: 'Removing the last admin / disabling SSO enforcement.', approversRequired: 2, approverRoles: ['admin'], enabled: true },
  { id: 'cluster-delete', scope: 'cluster-delete', description: 'Deleting a Kubernetes cluster registered in the platform.', approversRequired: 2, approverRoles: ['admin'], enabled: false },
]

type ApprovalPolicyOverride = Pick<ApprovalPolicy, 'approversRequired' | 'approverRoles' | 'enabled'>

/**
 * Approver roles as they are now. Overrides saved before roles came from
 * Keycloak can name `owner`, `security`, `billing`, … — roles that no longer
 * exist. Deciding a request takes organisation admin whatever the policy
 * says, so every approver is an admin.
 */
export function approverRolesNow(roles: readonly string[]): string[] {
  return roles.length ? ['admin'] : []
}

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
        return o ? { ...p, ...o, approverRoles: approverRolesNow(o.approverRoles ?? p.approverRoles) } : p
      })
    },
    retry: shouldRetry,
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
  /** Transport error when no HTTP response could be read (network / CORS). */
  error?: string
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

/** HMAC-SHA256 hex digest of `body` keyed by `secret` (WebCrypto). */
async function signPayload(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Send a REAL signed `ping.test` event to the webhook URL from the browser and
 * record the actual outcome as a `workspace.webhook-delivery` document. The
 * status code and duration are measured, never invented. When the browser
 * cannot reach the endpoint or read its response (network error, CORS) the
 * delivery is recorded as a failure with `statusCode: 0` and the error text.
 */
export async function testWebhook(id: string): Promise<WebhookDelivery> {
  const existing = await docStore.get<WebhookData>(WEBHOOK_KIND, id)
  if (!existing) throw new Error(`Webhook ${id} not found`)

  const at = new Date().toISOString()
  const body = JSON.stringify({ event: 'ping.test', webhookId: id, sentAt: at })
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-adhar-event': 'ping.test' }
  if (existing.data.secret) {
    headers['x-adhar-signature'] = `sha256=${await signPayload(existing.data.secret, body)}`
  }

  const started = performance.now()
  let statusCode = 0
  let error: string | undefined
  try {
    const res = await fetch(existing.data.url, { method: 'POST', headers, body })
    statusCode = res.status
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const ok = statusCode >= 200 && statusCode < 300
  const deliveryData: DeliveryData = {
    webhookId: id,
    event: 'ping.test',
    status: ok ? 'success' : 'failure',
    statusCode,
    durationMs: Math.round(performance.now() - started),
    at,
    ...(error ? { error } : {}),
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
