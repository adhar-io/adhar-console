import { CONSOLE_PERMISSIONS, type ConsolePermission, getServerAuthConfig } from '@adhar/auth/server'
import { env } from '@adhar/utils'
import { getRequestContext, type RequestContext, unauthorized } from '../request-user.ts'
import { orgPermissionDenied } from '../k8s/access.ts'
import {
  getKeycloakAdmin,
  type IdentityDirectory,
  KC_CLIENT_DETAIL,
  KcError,
  kcErrorResponse,
  keycloakNotConfigured,
  type KcUser,
  SETUP_EMAIL_LIFESPAN_S,
} from './keycloak-admin.ts'
import {
  type ApplyOutcome,
  applyXr,
  backfillXrs,
  deleteConsoleXr,
  listTeamXrs,
  teamManifest,
  type TeamXrSummary,
  type XrManifest,
} from '../control-plane.ts'
import { type DirectoryEntry, DirectoryUnavailable, getOrgDirectory, type OrgDirectory } from '../tenancy/directory.ts'
import { type LiveGroups, sharedLiveGroups } from '../tenancy/entitlement.ts'
import {
  confirmOrgAdminLive,
  decideOrgScoped,
  implicitGrants,
  isNewTeamSlug,
  isPlatformAdmin,
  isStoredSlug,
  type OrgAccess,
  OrgAccessError,
  orgAccess,
  orgAdminGroup,
  orgMemberGroup,
  type OrgRole,
  PLATFORM_ORG_SLUG,
  teamGroup,
  teamSlugFromName,
  teamsOf,
  UUID_RE,
} from '../tenancy/org-access.ts'
import {
  KIND,
  mintTokenSecret,
  ORG_DOC_ID,
  openStore,
  sha256Hex,
  slugify,
  writeAudit,
  type ApprovalDoc,
  type OrgDoc,
  type ProjectDoc,
  type Store,
  type StoredDoc,
  type TeamDoc,
  type TokenDoc,
  type AuditDoc,
} from './store.ts'

/**
 * Workspace / Organization management BFF — `/api/workspace/*`.
 *
 * WHO is in an organisation is Keycloak's to say, and only Keycloak's. Members
 * are the realm groups `org-<slug>` (member) and `org-<slug>-admin` (admin,
 * always also a member); a team's members are `ws-team-<slug>.<team>`. This
 * handler lists people from those groups and changes them there, creating the
 * Keycloak account (and having Keycloak email a set-password link) for someone
 * who has none. It stores no members, roles or invitations: what it still
 * keeps in Postgres is what no identity provider owns — the organisation's
 * settings, team names, projects, API tokens, approvals and the audit trail.
 *
 * Authorization is the org-scoped decision of tenancy/org-access.ts — the same
 * function `<Can>`/`useCan` reach through k8s/access.ts — and every write that
 * changes access re-reads the caller's groups from Keycloak first, so a
 * demotion takes effect at once rather than when the caller's token expires.
 *
 * Keycloak is not best-effort here. There is no copy to fall back on, so a
 * Keycloak call that fails fails the request (503 `keycloak_unavailable`,
 * 502 `keycloak_denied`) and nothing is reported as done that was not.
 *
 * A caller with no organisation (their personal tenant) gets their own `me`
 * and an empty team list; everything else answers 409 `no_organisation`.
 * Every mutation appends a `workspace.audit` document.
 */

export interface WorkspaceDeps {
  context(req: Request): Promise<RequestContext | null>
  openStore(tenant: string): Promise<Store | null>
  /** Null only on a laptop without an identity provider. */
  kc(): IdentityDirectory | null
  directory: OrgDirectory
  liveGroups: LiveGroups
  applyXr(m: XrManifest): Promise<ApplyOutcome>
  backfillXrs(manifests: XrManifest[]): void
  deleteConsoleXr(m: XrManifest): Promise<ApplyOutcome>
  /** Every Team XR (organisation, name, published group); null when the cluster cannot say. */
  teamXrs(): Promise<TeamXrSummary[] | null>
  /** Where the set-password email sends people back to (the console), when known. */
  consoleUrl(): string | undefined
  /** The console's OIDC client id, for that redirect. */
  clientId(): string | undefined
}

const DEFAULT_DEPS: WorkspaceDeps = {
  context: getRequestContext,
  openStore,
  kc: getKeycloakAdmin,
  get directory() {
    return getOrgDirectory()
  },
  liveGroups: sharedLiveGroups,
  applyXr: (m) => applyXr(m),
  backfillXrs,
  deleteConsoleXr: (m) => deleteConsoleXr(m),
  teamXrs: () => listTeamXrs(),
  consoleUrl: () => (env('AUTH_PUBLIC_URL') ?? env('ADHAR_CONSOLE_URL'))?.replace(/\/$/, '') || undefined,
  clientId: () => getServerAuthConfig()?.clientId,
}

interface Ctx {
  req: Request
  deps: WorkspaceDeps
  store: Store
  tenant: string
  user: { id: string; email: string; name: string; groups: string[] }
  org: DirectoryEntry
  access: OrgAccess
  kc: IdentityDirectory | null
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const badRequest = (error: string, detail?: string) => json({ error, ...(detail ? { detail } : {}) }, 400)
const notFound = (error = 'not_found', detail?: string) => json({ error, ...(detail ? { detail } : {}) }, 404)
const conflict = (error: string, detail: string, extra: Record<string, unknown> = {}) =>
  json({ error, detail, ...extra }, 409)

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
    return body as Record<string, unknown>
  } catch {
    return null
  }
}

const REMOVED = {
  invitations: () =>
    json({
      error: 'invitations_removed',
      detail: 'Invitations were removed: people are added straight from Keycloak. Use Settings → Members → Add people.',
    }, 410),
  ownership: () =>
    json({
      error: 'ownership_removed',
      detail: 'Organisations have admins, not an owner. Make someone an admin in Settings → Members instead.',
    }, 410),
}

export async function handleWorkspace(
  req: Request,
  subpath: string,
  overrides: Partial<WorkspaceDeps> = {},
): Promise<Response> {
  const deps: WorkspaceDeps = { ...DEFAULT_DEPS, ...overrides }
  const auth = await deps.context(req)
  if (!auth) return unauthorized()
  const attach = (res: Response) => withCookie(res, auth.refreshedCookie)
  const seg = subpath.replace(/\/+$/, '').split('/').filter(Boolean)
  const method = req.method.toUpperCase()
  const [head, id] = seg

  // Gone for everyone, whatever organisation they are in.
  if (head === 'invitations') return attach(REMOVED.invitations())
  if (head === 'org' && id === 'transfer') return attach(REMOVED.ownership())

  const user = { id: auth.user.id, email: auth.user.email, name: auth.user.name, groups: auth.user.groups ?? [] }
  if (!auth.org) {
    if (auth.degraded) {
      return attach(json({
        error: 'authorization_unavailable',
        detail: 'Your organisation could not be looked up right now, so nothing was read or changed. Try again shortly.',
      }, 503))
    }
    if (head === 'me' && method === 'GET') return attach(json(personalMe(user, deps)))
    if (head === 'teams' && !id && method === 'GET') return attach(json({ items: [] }))
    return attach(json({
      error: 'no_organisation',
      detail: 'You are not in an organisation yet. Ask an organisation admin to add you, or create one.',
    }, 409))
  }

  const store = await deps.openStore(auth.activeTenant)
  if (!store) {
    return attach(json({ error: 'store_unavailable', detail: 'database not configured' }, 503))
  }

  try {
    // Nothing about the caller is recorded here: Keycloak is the only user
    // store, and the audit trail names whoever acted.
    const ctx: Ctx = {
      req,
      deps,
      store,
      tenant: auth.activeTenant,
      user,
      org: auth.org,
      access: auth.access,
      kc: deps.kc(),
    }
    return attach(await route(ctx, method, seg))
  } catch (e) {
    const kc = kcErrorResponse(e)
    if (kc) return attach(kc)
    if (e instanceof OrgAccessError) return attach(requiresOrgAdmin(auth.org.slug))
    if (e instanceof DirectoryUnavailable) {
      // The cause (a database error, with its host) stays in the log.
      console.warn('[workspace]', e.message)
      return attach(json({ error: 'store_unavailable', detail: 'The organisation directory could not be read. Try again shortly.' }, 503))
    }
    console.error('[workspace] handler error:', e)
    return attach(json({ error: 'internal_error' }, 500))
  }
}

function route(ctx: Ctx, method: string, seg: string[]): Promise<Response> | Response {
  const [head, id, sub, subId] = seg
  switch (head) {
    case 'me':
      if (method === 'GET') return handleMe(ctx)
      break
    case 'org':
      if (seg.length === 1 && method === 'GET') return getOrg(ctx)
      if (seg.length === 1 && method === 'PUT') return updateOrg(ctx)
      if (seg.length === 1 && method === 'DELETE') return deleteOrg(ctx)
      break
    case 'members':
      if (!id && method === 'GET') return listMembers(ctx)
      if (!id && method === 'POST') return addMember(ctx)
      if (id && !sub && method === 'PATCH') return patchMember(ctx, id)
      if (id && !sub && method === 'DELETE') return removeMember(ctx, id)
      break
    case 'users':
      if (!id && method === 'GET') return searchUsers(ctx)
      if (!id && method === 'POST') return createUser(ctx)
      if (id && sub === 'setup-email' && !subId && method === 'POST') return resendSetupEmail(ctx, id)
      break
    case 'teams':
      if (!id && method === 'GET') return listTeams(ctx)
      if (!id && method === 'POST') return createTeam(ctx)
      if (id && !sub && method === 'PATCH') return patchTeam(ctx, id)
      if (id && !sub && method === 'DELETE') return deleteTeam(ctx, id)
      if (id && sub === 'members' && !subId && method === 'GET') return listTeamMembers(ctx, id)
      if (id && sub === 'members' && !subId && method === 'POST') return addTeamMember(ctx, id)
      if (id && sub === 'members' && subId && method === 'DELETE') {
        return removeTeamMember(ctx, id, subId)
      }
      break
    case 'projects':
      if (!id && method === 'GET') return listProjects(ctx)
      if (!id && method === 'POST') return createProject(ctx)
      if (id && method === 'PATCH') return patchProject(ctx, id)
      if (id && method === 'DELETE') return deleteProject(ctx, id)
      break
    case 'tokens':
      if (!id && method === 'GET') return listTokens(ctx)
      if (!id && method === 'POST') return createToken(ctx)
      if (id && method === 'DELETE') return revokeToken(ctx, id)
      break
    case 'audit':
      if (!id && method === 'GET') return gated(ctx, CONSOLE_PERMISSIONS.auditView, () => listAudit(ctx))
      if (id === 'facets' && method === 'GET') return gated(ctx, CONSOLE_PERMISSIONS.auditView, () => auditFacets(ctx))
      break
    case 'approvals':
      if (!id && method === 'GET') return listApprovals(ctx)
      if (!id && method === 'POST') return createApproval(ctx)
      if (id && sub === 'approve' && method === 'POST') return decideApproval(ctx, id, 'approved')
      if (id && sub === 'reject' && method === 'POST') return decideApproval(ctx, id, 'rejected')
      break
  }
  return notFound()
}

/* ─────────────────── authorization ─────────────────── */

/**
 * The org-scoped permission check, from the caller's token groups — the very
 * function `<Can>`/`useCan` reach through k8s/access.ts, so a button that is
 * shown is a request that passes. Every permission this handler gates on is
 * org-scoped; RBAC is not consulted for them.
 */
function gate(ctx: Ctx, perm: ConsolePermission): Response | null {
  if (decideOrgScoped(perm, ctx.access) === true) return null
  return orgPermissionDenied(perm, { access: ctx.access, degraded: false, slug: ctx.org.slug })
}

function gated(ctx: Ctx, perm: ConsolePermission, run: () => Promise<Response>): Promise<Response> {
  const denied = gate(ctx, perm)
  return denied ? Promise.resolve(denied) : run()
}

function requiresOrgAdmin(slug: string): Response {
  return json({
    error: 'requires_org_admin',
    detail: `Only organisation admins can do this, and Keycloak no longer lists you in ${orgAdminGroup(slug)}. Sign in again if that is new.`,
  }, 403)
}

/**
 * `gate`, then the live check every access-changing write needs (see
 * `confirmOrgAdminLive`). Without Keycloak — a laptop with no identity
 * provider — there is nothing live to ask and the token decision stands.
 */
async function gateWrite(ctx: Ctx, perm: ConsolePermission): Promise<Response | null> {
  const denied = gate(ctx, perm)
  if (denied) return denied
  if (!ctx.kc) return null
  try {
    await confirmOrgAdminLive(ctx.kc, ctx.user.id, ctx.org.slug)
    return null
  } catch (e) {
    if (e instanceof OrgAccessError) return requiresOrgAdmin(ctx.org.slug)
    throw e
  }
}

/** The Keycloak client, or the refusal when there is none (membership needs it). */
function needKc(ctx: Ctx): IdentityDirectory | Response {
  return ctx.kc ?? keycloakNotConfigured()
}

/** Keycloak forgets nothing the console does, but the per-user caches must. */
function touched(ctx: Ctx, userId: string): void {
  ctx.deps.liveGroups.invalidate(userId)
}

/* ─────────────────── me ─────────────────── */

function personalMe(user: Ctx['user'], deps: WorkspaceDeps) {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: null,
    via: null,
    teams: [],
    orgSlug: null,
    isPlatformOrganisation: false,
    org: null,
    keycloakConfigured: deps.kc() !== null,
  }
}

async function handleMe(ctx: Ctx): Promise<Response> {
  const org = await loadOrg(ctx)
  // Teams from Keycloak when it answers (a membership added a minute ago
  // shows), from the token otherwise.
  const groups = (await ctx.deps.liveGroups.get(ctx.user.id, 30_000)) ?? ctx.user.groups
  return json({
    userId: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    role: ctx.access.role,
    via: ctx.access.via,
    teams: teamsOf(groups, ctx.org.slug),
    orgSlug: ctx.org.slug,
    isPlatformOrganisation: ctx.org.slug === PLATFORM_ORG_SLUG,
    org: toOrg(org, ctx.org),
    keycloakConfigured: ctx.kc !== null,
  })
}

/* ─────────────────── organization ─────────────────── */

async function loadOrg(ctx: Ctx): Promise<StoredDoc<OrgDoc>> {
  const existing = await ctx.store.get<OrgDoc>(KIND.org, ORG_DOC_ID)
  if (existing) {
    // Documents written before membership moved to Keycloak carry the TENANT
    // id as their slug (`default`, `acme-x1y2z`). The slug is the directory's —
    // the one the groups, namespace and Gitea org are named by — so an old one
    // is corrected once, here, and `toOrg` never shows anything else.
    if (existing.data.slug === ctx.org.slug) return existing
    return await ctx.store.put(KIND.org, ORG_DOC_ID, { ...existing.data, slug: ctx.org.slug }, existing.updatedBy ?? 'system')
      .catch(() => existing)
  }
  // Bootstrap the org document from the directory on first read.
  const doc: OrgDoc = {
    slug: ctx.org.slug,
    name: ctx.org.name,
    ...(ctx.org.description ? { description: ctx.org.description } : {}),
    region: 'adhar-controlplane',
    plan: 'team',
    createdAt: new Date().toISOString(),
    ssoEnforced: false,
  }
  return await ctx.store.put(KIND.org, ORG_DOC_ID, doc, ctx.user.id)
}

/** The organisation as the pages show it — its id and slug always the directory's. */
function toOrg(doc: StoredDoc<OrgDoc>, org: DirectoryEntry) {
  return { ...doc.data, id: `org-${org.slug}`, slug: org.slug }
}

async function getOrg(ctx: Ctx): Promise<Response> {
  return json({ item: toOrg(await loadOrg(ctx), ctx.org) })
}

async function updateOrg(ctx: Ctx): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.orgUpdate)
  if (denied) return denied
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const current = await loadOrg(ctx)
  const patch: Partial<OrgDoc> = {}
  if (typeof body.name === 'string' && body.name.trim()) patch.name = cleanText(body.name, 60)
  if (typeof body.description === 'string') patch.description = body.description
  if (typeof body.domain === 'string') patch.domain = body.domain.trim() || undefined
  if (typeof body.logoUrl === 'string') patch.logoUrl = body.logoUrl.trim() || undefined
  if (typeof body.ssoEnforced === 'boolean') patch.ssoEnforced = body.ssoEnforced
  if (typeof body.defaultProjectId === 'string') patch.defaultProjectId = body.defaultProjectId
  if (Object.keys(patch).length === 0) return badRequest('nothing_to_update')
  const next = { ...current.data, ...patch }
  const saved = await ctx.store.put(KIND.org, ORG_DOC_ID, next, ctx.user.id)
  // The switcher lists organisations from the shared directory; keep its name
  // the one people just typed.
  if (patch.name && patch.name !== ctx.org.name) {
    await ctx.deps.directory.put({ ...ctx.org, name: patch.name }, ctx.user.id)
  }
  await writeAudit(
    ctx.store,
    ctx.user,
    'org.update',
    { type: 'organization', id: ctx.org.slug, label: next.name },
    ctx.req,
    { fields: Object.keys(patch) },
  )
  return json({ item: toOrg(saved, ctx.org) })
}

/**
 * Delete the organisation: its Keycloak groups first — every team group, then
 * `org-<slug>-admin`, then `org-<slug>` — and only then the console's
 * documents, so a Keycloak failure leaves the organisation intact rather than
 * half-deleted with its people still holding its groups. The Organisation
 * resource, its namespace and its Gitea organisation are kept: they hold
 * workloads and repositories, and deleting those is not a settings-page click.
 */
async function deleteOrg(ctx: Ctx): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.orgDelete)
  if (denied) return denied
  if (ctx.org.slug === PLATFORM_ORG_SLUG) {
    return conflict('platform_organisation', 'The platform\'s own organisation cannot be deleted.')
  }
  const body = await readBody(ctx.req)
  const confirm = typeof body?.confirm === 'string' ? body.confirm.trim() : ''
  const org = await loadOrg(ctx)
  if (confirm !== org.data.name) return badRequest('confirmation_mismatch')

  const teams = await ctx.store.list<TeamDoc>(KIND.team)
  const kc = ctx.kc
  if (kc) {
    for (const t of teams) {
      if (isStoredSlug(t.data.slug)) await kc.deleteGroup(teamGroup(ctx.org.slug, t.data.slug))
    }
    await kc.deleteGroup(orgAdminGroup(ctx.org.slug))
    await kc.deleteGroup(orgMemberGroup(ctx.org.slug))
  }

  for (const kind of [
    KIND.member,
    KIND.invitation,
    KIND.team,
    KIND.project,
    KIND.token,
    KIND.approval,
  ]) {
    const docs = await ctx.store.list<Record<string, unknown>>(kind)
    for (const d of docs) await ctx.store.remove(kind, d.id)
  }
  await ctx.store.remove(KIND.org, ORG_DOC_ID)
  await ctx.deps.directory.remove(ctx.org, ctx.user.id)

  await writeAudit(
    ctx.store,
    ctx.user,
    'org.delete',
    { type: 'organization', id: ctx.org.slug, label: org.data.name },
    ctx.req,
  )
  return json({ ok: true, retained: ['Organisation resource', 'namespace', 'Gitea organisation'] })
}

/* ─────────────────── members ─────────────────── */

type MemberStatus = 'active' | 'invited' | 'disabled'

interface MemberView {
  userId: string
  email: string
  name: string
  username: string
  role: OrgRole
  teams: string[]
  status: MemberStatus
  createdAt?: string
}

/** The most rows one listing returns. */
const MEMBERS_LIST_CAP = 2_000

function displayName(u: KcUser): string {
  const full = [u.firstName, u.lastName].filter((s) => s && s.trim()).join(' ').trim()
  return full || u.username || u.email || u.id
}

function statusOf(u: KcUser): MemberStatus {
  if (u.enabled === false) return 'disabled'
  if ((u.requiredActions ?? []).includes('UPDATE_PASSWORD')) return 'invited'
  return 'active'
}

function memberView(u: KcUser, role: OrgRole, teams: string[]): MemberView {
  return {
    userId: u.id,
    email: u.email ?? '',
    name: displayName(u),
    username: u.username,
    role,
    teams,
    status: statusOf(u),
    ...(u.createdTimestamp ? { createdAt: new Date(u.createdTimestamp).toISOString() } : {}),
  }
}

/** Bounded-concurrency map — one call per team must not be one burst per page. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

async function teamDocs(ctx: Ctx): Promise<StoredDoc<TeamDoc>[]> {
  return (await ctx.store.list<TeamDoc>(KIND.team)).filter((t) => isStoredSlug(t.data?.slug))
}

/** user id → the org's team slugs they are in, from the team groups. */
async function teamMembership(ctx: Ctx, kc: IdentityDirectory): Promise<Map<string, string[]>> {
  const teams = await teamDocs(ctx)
  const lists = await mapLimit(teams, 8, (t) => kc.listGroupMembers(teamGroup(ctx.org.slug, t.data.slug)))
  const by = new Map<string, string[]>()
  teams.forEach((t, i) => {
    for (const m of lists[i].members) by.set(m.id, [...(by.get(m.id) ?? []), t.data.slug])
  })
  for (const v of by.values()) v.sort()
  return by
}

async function listMembers(ctx: Ctx): Promise<Response> {
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  const [members, admins, teams] = await Promise.all([
    kc.listGroupMembers(orgMemberGroup(ctx.org.slug), { brief: false }),
    kc.listGroupMembers(orgAdminGroup(ctx.org.slug), { brief: false }),
    teamMembership(ctx, kc),
  ])
  const items: MemberView[] = []
  const seen = new Set<string>()
  for (const [list, role] of [[admins.members, 'admin'], [members.members, 'member']] as const) {
    for (const u of list) {
      if (seen.has(u.id)) continue
      seen.add(u.id)
      items.push(memberView(u, role, teams.get(u.id) ?? []))
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email))
  return json({
    items: items.slice(0, MEMBERS_LIST_CAP),
    implicit: implicitGrants(ctx.org.slug),
    truncated: members.truncated || admins.truncated || items.length > MEMBERS_LIST_CAP,
    // Whether Keycloak can email a set-password link — without an SMTP server
    // on the realm "New account" cannot work, and the page says so up front.
    // Null when Keycloak would not say.
    canEmail: await kc.emailConfigured().catch(() => null),
  })
}

const isRole = (v: unknown): v is OrgRole => v === 'admin' || v === 'member'

/** The team slugs a body names, all of which must be this organisation's teams. */
async function requestedTeams(ctx: Ctx, raw: unknown): Promise<string[] | Response> {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) return badRequest('unknown_team', 'teams must be a list of team slugs.')
  const known = new Set((await teamDocs(ctx)).map((t) => t.data.slug))
  const wanted = [...new Set(raw as string[])]
  const unknown = wanted.filter((t) => !known.has(t))
  if (unknown.length) return badRequest('unknown_team', `Not a team of this organisation: ${unknown.slice(0, 5).join(', ')}.`)
  return wanted
}

/** Membership of a user in this organisation, from their live groups. */
function explicitRole(groups: readonly string[], slug: string): OrgRole | null {
  if (groups.includes(orgAdminGroup(slug))) return 'admin'
  if (groups.includes(orgMemberGroup(slug))) return 'member'
  return null
}

/**
 * Add `userId` to each group in order; if one fails, take back the ones
 * already added and rethrow — a half-added member is a member nobody chose.
 */
async function addToGroups(kc: IdentityDirectory, userId: string, groups: string[]): Promise<void> {
  const done: string[] = []
  try {
    for (const g of groups) {
      await kc.addUserToGroup(userId, g)
      done.push(g)
    }
  } catch (e) {
    for (const g of done.reverse()) await kc.removeUserFromGroup(userId, g).catch(() => {})
    throw e
  }
}

function groupsFor(slug: string, role: OrgRole, teams: string[]): string[] {
  return [orgMemberGroup(slug), ...(role === 'admin' ? [orgAdminGroup(slug)] : []), ...teams.map((t) => teamGroup(slug, t))]
}

async function addMember(ctx: Ctx): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.membersInvite)
  if (denied) return denied
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const userId = typeof body.userId === 'string' ? body.userId : ''
  if (!UUID_RE.test(userId)) return badRequest('invalid_user_id')
  const role = body.role ?? 'member'
  if (!isRole(role)) return badRequest('invalid_role')
  const teams = await requestedTeams(ctx, body.teams)
  if (teams instanceof Response) return teams

  const target = await kc.getUser(userId)
  if (!target || (target.username ?? '').startsWith('service-account-')) {
    return notFound('user_not_found', 'No Keycloak account has that id.')
  }
  const groups = await kc.getUserGroups(userId)
  const already = explicitRole(groups, ctx.org.slug)
  if (already) {
    return conflict('already_member', `${displayName(target)} is already in this organisation.`, {
      item: memberView(target, already, teamsOf(groups, ctx.org.slug)),
    })
  }
  // An account is found by its email, and the realm lets anyone sign up with
  // any address without proving it. Adding an unverified account trusts an
  // address nobody checked — it may be someone else's sign-up with your
  // colleague's email. Only a platform admin may vouch for one, explicitly.
  if (target.emailVerified !== true) {
    const vouched = body.allowUnverifiedEmail === true && isPlatformAdmin((await ctx.deps.liveGroups.get(ctx.user.id, 0)) ?? [])
    if (!vouched) {
      return conflict(
        'email_unverified',
        `Keycloak has not verified that ${target.email ?? target.username} belongs to whoever created this account, so it cannot be added on the email alone. Ask them to verify their email, or ask a platform admin to add them.`,
      )
    }
  }
  await addToGroups(kc, userId, groupsFor(ctx.org.slug, role, teams))
  touched(ctx, userId)
  await writeAudit(
    ctx.store,
    ctx.user,
    'member.add',
    { type: 'member', id: userId, label: target.email ?? target.username },
    ctx.req,
    { role, teams, ...(target.emailVerified !== true ? { emailUnverified: true } : {}) },
  )
  return json({ item: memberView(target, role, teams) }, 201)
}

/**
 * Explicit admins of the organisation other than `exceptUserId`, read fresh.
 * Platform admins are not counted: they are everyone's admins and nobody's
 * owner, and an organisation whose only admin is "whoever runs the platform"
 * has lost its own.
 */
async function otherAdmins(kc: IdentityDirectory, slug: string, exceptUserId: string): Promise<number> {
  const admins = await kc.listGroupMembers(orgAdminGroup(slug), { fresh: true })
  return admins.members.filter((m) => m.id !== exceptUserId).length
}

/**
 * The platform's own organisation is never left without an admin — platform
 * admins administer it by definition — so the last-admin guard does not apply
 * there; it would otherwise forbid demoting the one person ever promoted.
 */
const guardsLastAdmin = (slug: string) => slug !== PLATFORM_ORG_SLUG

async function patchMember(ctx: Ctx, userId: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.membersUpdate)
  if (denied) return denied
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  if (!UUID_RE.test(userId)) return badRequest('invalid_user_id')
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  if (!isRole(body.role)) return badRequest('invalid_role')
  const role = body.role
  const slug = ctx.org.slug

  const target = await kc.getUser(userId)
  if (!target) return notFound('user_not_found', 'No Keycloak account has that id.')
  const groups = await kc.getUserGroups(userId)
  const previous = explicitRole(groups, slug)
  if (!previous) return notInOrganisation()

  if (role === 'admin') {
    // Admins are members too: both groups, always — which also mends an
    // admin someone put only in the admin group by hand.
    const missing = [orgMemberGroup(slug), orgAdminGroup(slug)].filter((g) => !groups.includes(g))
    if (missing.length) await addToGroups(kc, userId, missing)
  } else if (previous === 'admin') {
    if (guardsLastAdmin(slug) && (await otherAdmins(kc, slug, userId)) === 0) {
      return conflict('cannot_demote_last_admin', 'An organisation needs at least one admin. Make someone else an admin first.')
    }
    await kc.addUserToGroup(userId, orgMemberGroup(slug))
    await kc.removeUserFromGroup(userId, orgAdminGroup(slug))
    // Two admins demoting each other at once would both pass the check above.
    if (guardsLastAdmin(slug) && (await otherAdmins(kc, slug, '')) === 0) {
      await kc.addUserToGroup(userId, orgAdminGroup(slug))
      return conflict('cannot_demote_last_admin', 'Another change just left this organisation without an admin; this one was undone.')
    }
  }
  touched(ctx, userId)
  if (previous !== role) {
    await writeAudit(
      ctx.store,
      ctx.user,
      'member.update_role',
      { type: 'member', id: userId, label: target.email ?? target.username },
      ctx.req,
      { from: previous, to: role },
    )
  }
  return json({ item: memberView(target, role, teamsOf(groups, slug)) })
}

async function removeMember(ctx: Ctx, userId: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.membersRemove)
  if (denied) return denied
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  if (!UUID_RE.test(userId)) return badRequest('invalid_user_id')
  if (userId === ctx.user.id) {
    return badRequest('cannot_remove_self', 'To remove yourself, leave the organisation from the organisation switcher.')
  }
  const slug = ctx.org.slug
  const [target, groups] = await Promise.all([
    kc.getUser(userId),
    kc.getUserGroups(userId).catch((e) => {
      if (e instanceof KcError && e.code === 'not_found') return null
      throw e
    }),
  ])
  if (!target || !groups) return notFound('user_not_found', 'No Keycloak account has that id.')
  const role = explicitRole(groups, slug)
  if (!role) return notInOrganisation()
  if (role === 'admin' && guardsLastAdmin(slug) && (await otherAdmins(kc, slug, userId)) === 0) {
    return conflict('cannot_remove_last_admin', 'An organisation needs at least one admin. Make someone else an admin first.')
  }

  // Teams, then admin, then membership: the narrowest grant goes first, so an
  // interruption never leaves someone in a team of an organisation they left.
  const teams = teamsOf(groups, slug)
  const removed: string[] = []
  try {
    for (const t of teams) {
      await kc.removeUserFromGroup(userId, teamGroup(slug, t))
      removed.push(teamGroup(slug, t))
    }
    if (role === 'admin') {
      await kc.removeUserFromGroup(userId, orgAdminGroup(slug))
      removed.push(orgAdminGroup(slug))
      if (guardsLastAdmin(slug) && (await otherAdmins(kc, slug, '')) === 0) {
        for (const g of removed.reverse()) await kc.addUserToGroup(userId, g).catch(() => {})
        return conflict('cannot_remove_last_admin', 'Another change just left this organisation without an admin; this one was undone.')
      }
    }
    await kc.removeUserFromGroup(userId, orgMemberGroup(slug))
  } catch (e) {
    touched(ctx, userId)
    if (removed.length === 0) throw e
    // Some groups are gone, some are not. Removing is idempotent: the same
    // request again finishes the job.
    const partial = kcErrorResponse(e, { partial: true })
    if (partial) return partial
    throw e
  }
  touched(ctx, userId)
  await writeAudit(
    ctx.store,
    ctx.user,
    'member.remove',
    { type: 'member', id: userId, label: target.email ?? target.username },
    ctx.req,
    { role, teams },
  )
  return json({ ok: true })
}

/** The PERSON acted on is not in this organisation (as opposed to the caller: `not_a_member`). */
function notInOrganisation(): Response {
  return notFound('user_not_in_organisation', 'That person is not a member of this organisation.')
}

/* ─────────────────── rate limits ─────────────────── */

/**
 * Per-caller ceilings on the calls that reach into the whole realm: looking an
 * account up, creating one (Keycloak then emails whatever address it names),
 * and resending that email. Every signed-in user may create an organisation
 * and so become an admin of one; these keep that from becoming an account
 * oracle or a way to have Keycloak mail strangers. In memory, per replica — a
 * ceiling, not an accounting.
 */
const RATE_LIMITS = {
  lookup: { max: 60, windowMs: 60_000 },
  create: { max: 20, windowMs: 10 * 60_000 },
  email: { max: 10, windowMs: 10 * 60_000 },
} as const
const rateHits = new Map<string, number[]>()

function rateLimited(userId: string, bucket: keyof typeof RATE_LIMITS, now = Date.now()): Response | null {
  const { max, windowMs } = RATE_LIMITS[bucket]
  const key = `${bucket}\u0000${userId}`
  const recent = (rateHits.get(key) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= max) {
    rateHits.set(key, recent)
    const retryAfter = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000))
    const res = json({ error: 'rate_limited', detail: `Too many of these in a short time. Try again in ${retryAfter} seconds.` }, 429)
    res.headers.set('retry-after', String(retryAfter))
    return res
  }
  recent.push(now)
  rateHits.delete(key)
  if (rateHits.size >= 10_000) rateHits.delete(rateHits.keys().next().value!)
  rateHits.set(key, recent)
  return null
}

/* ─────────────────── people (Keycloak accounts) ─────────────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trimmed, control characters stripped, at most `max` characters. */
function cleanText(v: unknown, max: number): string {
  // deno-lint-ignore no-control-regex
  return typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max) : ''
}

/**
 * Find an account to add. Org admins look people up by EXACT email or
 * username only — the realm holds every organisation's people, and an admin
 * of one must not be able to page through the others. Platform admins, who
 * administer them all, may search.
 */
async function searchUsers(ctx: Ctx): Promise<Response> {
  const denied = gate(ctx, CONSOLE_PERMISSIONS.membersInvite)
  if (denied) return denied
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  const limited = rateLimited(ctx.user.id, 'lookup')
  if (limited) return limited
  const url = new URL(ctx.req.url)
  const q = (url.searchParams.get('q') ?? '').replace(/\*/g, '').trim()
  const max = Math.min(Math.max(Number(url.searchParams.get('max') ?? 20) || 20, 1), 50)
  const search = isPlatformAdmin(ctx.user.groups)
  if (q.length < 2 || q.length > (search ? 100 : 254)) {
    return badRequest('invalid_query', 'Search with 2–100 characters (an exact email or username).')
  }
  let users: KcUser[]
  if (search) {
    users = await kc.searchUsers(q, { max })
  } else {
    const hit = q.includes('@') ? await kc.findUserByEmail(q.toLowerCase()) : await kc.findUserByUsername(q)
    users = hit ? [hit] : []
  }
  const [members, admins] = await Promise.all([
    kc.listGroupMembers(orgMemberGroup(ctx.org.slug)),
    kc.listGroupMembers(orgAdminGroup(ctx.org.slug)),
  ])
  const adminIds = new Set(admins.members.map((m) => m.id))
  const memberIds = new Set(members.members.map((m) => m.id))
  return json({
    items: users.map((u) => ({
      userId: u.id,
      email: u.email ?? '',
      name: displayName(u),
      username: u.username,
      enabled: u.enabled !== false,
      // Whether Keycloak verified the address — an unverified one may be
      // anybody's sign-up, and is not added on the email alone (addMember).
      emailVerified: u.emailVerified === true,
      membership: adminIds.has(u.id) ? 'admin' : memberIds.has(u.id) ? 'member' : null,
    })),
    mode: search ? 'search' : 'exact',
  })
}

/** Has Keycloak created this account in the last minute, for this request? */
async function justCreated(kc: IdentityDirectory, id: string, email: string): Promise<boolean> {
  const u = await kc.getUser(id).catch(() => null)
  if (!u) return false
  return u.username === email && typeof u.createdTimestamp === 'number' && Date.now() - u.createdTimestamp < 60_000
}

function setupEmailOptions(ctx: Ctx) {
  const redirectUri = ctx.deps.consoleUrl()
  const clientId = ctx.deps.clientId()
  return { lifespan: SETUP_EMAIL_LIFESPAN_S, ...(redirectUri && clientId ? { redirectUri, clientId } : {}) }
}

/**
 * Someone new: create the Keycloak account, put it in the organisation's
 * groups, and have Keycloak email a link to set a password. Keycloak sends the
 * email, so with no SMTP server on the realm nothing would reach the person —
 * that is refused up front rather than creating an account nobody can enter.
 */
async function createUser(ctx: Ctx): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.membersInvite)
  if (denied) return denied
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  const limited = rateLimited(ctx.user.id, 'create')
  if (limited) return limited
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (email.length > 254 || !EMAIL_RE.test(email)) return badRequest('invalid_email')
  const firstName = cleanText(body.firstName, 100)
  const lastName = cleanText(body.lastName, 100)
  const role = body.role ?? 'member'
  if (!isRole(role)) return badRequest('invalid_role')
  const teams = await requestedTeams(ctx, body.teams)
  if (teams instanceof Response) return teams

  if (!(await kc.emailConfigured())) {
    return json({
      error: 'keycloak_email_not_configured',
      detail: 'Keycloak has no SMTP server, so it cannot email a set-password link. Configure Realm settings → Email, or add an existing account instead.',
    }, 422)
  }
  // The answer names no account: an organisation admin learns that the
  // address is taken (Keycloak would refuse it anyway), not whose it is.
  const exists = () => conflict('user_exists', 'An account with that email already exists — add it as an existing account.')
  if (await kc.findUserByEmail(email)) return exists()
  let id: string
  try {
    id = await kc.createUser({ email, firstName, lastName })
  } catch (e) {
    if (e instanceof KcError && e.code === 'conflict') return exists()
    throw e
  }
  try {
    await addToGroups(kc, id, groupsFor(ctx.org.slug, role, teams))
  } catch (e) {
    // Undo exactly what this request made: the account, and only when it is
    // unmistakably the one just created.
    if (await justCreated(kc, id, email)) await kc.deleteUser(id).catch(() => {})
    throw e
  }
  let setupEmail: { sent: true } | { sent: false; reason: 'send_failed'; detail: string }
  try {
    await kc.executeActionsEmail(id, setupEmailOptions(ctx))
    setupEmail = { sent: true }
  } catch (e) {
    // Keycloak's SMTP error goes to the log, not to the browser.
    console.warn(`[workspace] set-password email for a new account failed: ${e instanceof Error ? e.message : String(e)}`)
    setupEmail = { sent: false, reason: 'send_failed', detail: KC_CLIENT_DETAIL.email_failed }
  }
  const created = (await kc.getUser(id).catch(() => null)) ??
    { id, username: email, email, firstName, lastName, enabled: true, requiredActions: ['UPDATE_PASSWORD'] }
  await writeAudit(
    ctx.store,
    ctx.user,
    'member.create_account',
    { type: 'member', id, label: email },
    ctx.req,
    { role, teams, setupEmailSent: setupEmail.sent },
  )
  return json({ item: memberView(created, role, teams), setupEmail }, 201)
}

async function resendSetupEmail(ctx: Ctx, userId: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.membersInvite)
  if (denied) return denied
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  if (!UUID_RE.test(userId)) return badRequest('invalid_user_id')
  const limited = rateLimited(ctx.user.id, 'email')
  if (limited) return limited
  const target = await kc.getUser(userId)
  if (!target) return notFound('user_not_found', 'No Keycloak account has that id.')
  if (!explicitRole(await kc.getUserGroups(userId), ctx.org.slug)) return notInOrganisation()
  if (!(target.requiredActions ?? []).includes('UPDATE_PASSWORD')) {
    return conflict('setup_not_pending', 'That account has already been set up; there is no set-password email to send.')
  }
  if (!(await kc.emailConfigured())) {
    return json({
      error: 'keycloak_email_not_configured',
      detail: 'Keycloak has no SMTP server, so it cannot email a set-password link. Configure Realm settings → Email.',
    }, 422)
  }
  try {
    await kc.executeActionsEmail(userId, setupEmailOptions(ctx))
  } catch (e) {
    if (e instanceof KcError && e.code === 'email_failed') {
      console.warn(`[workspace] resending the set-password email failed: ${e.detail}`)
      const detail = KC_CLIENT_DETAIL.email_failed
      return json({ error: 'email_send_failed', detail, setupEmail: { sent: false, reason: 'send_failed', detail } }, 502)
    }
    throw e
  }
  await writeAudit(
    ctx.store,
    ctx.user,
    'member.setup_email',
    { type: 'member', id: userId, label: target.email ?? target.username },
    ctx.req,
  )
  return json({ setupEmail: { sent: true } }, 202)
}

/* ─────────────────── teams ─────────────────── */

type AccessBinding = 'current' | 'pending-platform-upgrade' | 'unknown'

interface TeamView {
  id: string
  slug: string
  name: string
  description?: string
  createdAt: string
  group: string
  keycloakGroup: string
  memberCount: number | null
  projectCount: number
  accessBinding: AccessBinding
}

/**
 * Whether the platform binds this team's group yet. The console fills
 * `ws-team-<org>.<team>`; a Team XR still publishing the old `ws-team-<team>`
 * on its status belongs to a control plane not yet upgraded, whose project
 * bindings still name the old group — so access granted here reaches
 * Kubernetes only after that upgrade.
 */
function bindingOf(xrs: TeamXrSummary[] | null, org: string, slug: string, group: string): AccessBinding {
  const xr = xrs?.find((x) => x.organisation === org && x.name === slug)
  if (!xr?.group) return 'unknown'
  return xr.group === group ? 'current' : 'pending-platform-upgrade'
}

async function teamViews(ctx: Ctx, docs: StoredDoc<TeamDoc>[]): Promise<{ items: TeamView[]; degraded: boolean }> {
  const slug = ctx.org.slug
  const [projects, xrs] = await Promise.all([
    ctx.store.list<ProjectDoc>(KIND.project),
    ctx.deps.teamXrs().catch(() => null),
  ])
  let degraded = false
  const items = await mapLimit(docs, 8, async (d): Promise<TeamView> => {
    const group = teamGroup(slug, d.data.slug)
    let memberCount: number | null = null
    if (ctx.kc) {
      try {
        memberCount = (await ctx.kc.listGroupMembers(group)).members.length
      } catch {
        degraded = true
      }
    }
    return {
      id: d.id,
      slug: d.data.slug,
      name: d.data.name,
      description: d.data.description,
      createdAt: d.data.createdAt,
      group,
      keycloakGroup: group,
      memberCount,
      projectCount: projects.filter((p) => (p.data.teams ?? []).includes(d.data.slug)).length,
      accessBinding: bindingOf(xrs, slug, d.data.slug, group),
    }
  })
  return { items, degraded }
}

async function teamView(ctx: Ctx, doc: StoredDoc<TeamDoc>): Promise<TeamView> {
  return (await teamViews(ctx, [doc])).items[0]
}

/**
 * Bootstrap one team on first read, the way `loadOrg` bootstraps the org.
 *
 * An organization with zero teams is not a meaningful state: the tenancy chain
 * is Organization → Team → Project → App, so a missing middle level leaves
 * projects with nothing to belong to and the switcher with nothing to show —
 * which reads as a broken feature rather than an empty one. Every install was
 * starting there, because nothing ever created the first team.
 *
 * Only the team is seeded — nobody is put in it. It used to add whoever read
 * the list first to the realm-wide `ws-team-platform` group, which the
 * platform's own project binds as namespace admin: any signed-in user could
 * create an organisation and walk into the platform team's namespaces.
 */
async function ensureDefaultTeam(ctx: Ctx): Promise<void> {
  const existing = await ctx.store.list<TeamDoc>(KIND.team)
  if (existing.length > 0) return
  const doc: TeamDoc = {
    slug: 'platform',
    name: 'Platform Team',
    description: 'The organization’s first team. Rename it, or add more in Workspace → Teams.',
    createdAt: new Date().toISOString(),
  }
  await ctx.store.put(KIND.team, crypto.randomUUID(), doc, ctx.user.id)
}

/** The XRD's own pattern, so a back-filled Team is one the control plane accepts. */
const teamXrManifests = (org: string, docs: StoredDoc<TeamDoc>[]) =>
  docs
    .filter((d) => isNewTeamSlug(d.data.slug))
    .map((d) => teamManifest({ slug: d.data.slug, name: d.data.name, description: d.data.description }, org))

async function listTeams(ctx: Ctx): Promise<Response> {
  await ensureDefaultTeam(ctx)
  const docs = await teamDocs(ctx)
  // Teams created before the control plane owned tenancy become Team XRs the
  // first time they are listed (background, throttled; see control-plane.ts).
  ctx.deps.backfillXrs(teamXrManifests(ctx.org.slug, docs))
  const { items, degraded } = await teamViews(ctx, docs)
  return json(degraded ? { items, degraded: true } : { items })
}

/**
 * Group first, then the document, then the Team XR: a team must never exist
 * in the console without the Keycloak group its members will be put in, and
 * the XR (which publishes that group to the platform) is reported, not fatal —
 * the next listing back-fills a missed one.
 */
async function createTeam(ctx: Ctx): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.teamsCreate)
  if (denied) return denied
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const name = cleanText(body.name, 100)
  if (!name) return badRequest('missing_name')
  // A slug someone typed is taken as typed (and refused if the Team XRD
  // would refuse it); one derived from the name is MADE to fit, so a team is
  // never refused over a slug nobody saw ("2026 Platform", a long name).
  const typed = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : ''
  const slug = typed || teamSlugFromName(name)
  if (!isNewTeamSlug(slug)) {
    return badRequest(
      'invalid_slug',
      typed
        ? 'A team slug starts with a letter and has at most 40 lowercase letters, digits and hyphens.'
        : 'No slug can be made from that name — type one: a letter first, then lowercase letters, digits and hyphens.',
    )
  }
  const description = typeof body.description === 'string' ? body.description.trim() || undefined : undefined

  const existing = await ctx.store.list<TeamDoc>(KIND.team)
  if (existing.some((t) => t.data.slug === slug)) return conflict('slug_taken', `This organisation already has a team "${slug}".`)

  if (ctx.kc) await ctx.kc.ensureGroup(teamGroup(ctx.org.slug, slug))

  const doc: TeamDoc = { slug, name, description, createdAt: new Date().toISOString() }
  const id = crypto.randomUUID()
  const saved = await ctx.store.put(KIND.team, id, doc, ctx.user.id)

  const controlPlane = await ctx.deps.applyXr(teamManifest({ slug, name, description }, ctx.org.slug))
  if (!controlPlane.ok) console.warn(`[control-plane] Team ${ctx.org.slug}/${slug}: ${controlPlane.detail}`)

  await writeAudit(
    ctx.store,
    ctx.user,
    'team.create',
    { type: 'team', id, label: name },
    ctx.req,
    { slug, group: teamGroup(ctx.org.slug, slug), controlPlaneSynced: controlPlane.ok },
  )
  return json({ item: await teamView(ctx, saved), controlPlaneSynced: controlPlane.ok }, 201)
}

async function patchTeam(ctx: Ctx, id: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.teamsUpdate)
  if (denied) return denied
  const doc = await ctx.store.get<TeamDoc>(KIND.team, id)
  if (!doc || !isStoredSlug(doc.data.slug)) return notFound()
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const next: TeamDoc = {
    ...doc.data,
    name: typeof body.name === 'string' && body.name.trim() ? cleanText(body.name, 100) : doc.data.name,
    description: typeof body.description === 'string'
      ? body.description.trim() || undefined
      : doc.data.description,
  }
  const saved = await ctx.store.put(KIND.team, id, next, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'team.update',
    { type: 'team', id, label: next.name },
    ctx.req,
  )
  return json({ item: await teamView(ctx, saved) })
}

async function deleteTeam(ctx: Ctx, id: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.teamsDelete)
  if (denied) return denied
  const doc = await ctx.store.get<TeamDoc>(KIND.team, id)
  if (!doc) return notFound()
  const slug = doc.data.slug

  // The group goes first and must go: a deleted team whose group lives on
  // keeps granting whatever the platform binds to it.
  if (ctx.kc && isStoredSlug(slug)) await ctx.kc.deleteGroup(teamGroup(ctx.org.slug, slug))
  await ctx.store.remove(KIND.team, id)
  const controlPlane = isNewTeamSlug(slug)
    ? await ctx.deps.deleteConsoleXr(teamManifest({ slug, name: doc.data.name }, ctx.org.slug))
    : { ok: true, status: 0, detail: 'no Team XR for this slug' }
  if (!controlPlane.ok) console.warn(`[control-plane] deleting Team ${ctx.org.slug}/${slug}: ${controlPlane.detail}`)

  await writeAudit(
    ctx.store,
    ctx.user,
    'team.delete',
    { type: 'team', id, label: doc.data.name },
    ctx.req,
    { slug, controlPlaneSynced: controlPlane.ok },
  )
  // Whether the Team resource (and the Gitea team it composes) went too. It
  // can be left in place — not the console's to delete, or the delete was
  // refused — and the page says so rather than implying it is gone.
  return json({ ok: true, controlPlaneSynced: controlPlane.ok, ...(controlPlane.ok ? {} : { controlPlaneDetail: 'The Team resource was left in place; a platform admin can remove it.' }) })
}

async function loadTeam(ctx: Ctx, teamId: string): Promise<StoredDoc<TeamDoc> | null> {
  const team = await ctx.store.get<TeamDoc>(KIND.team, teamId)
  return team && isStoredSlug(team.data.slug) ? team : null
}

async function listTeamMembers(ctx: Ctx, teamId: string): Promise<Response> {
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  const team = await loadTeam(ctx, teamId)
  if (!team) return notFound()
  const { members } = await kc.listGroupMembers(teamGroup(ctx.org.slug, team.data.slug), { brief: false })
  return json({
    items: members
      .map((u) => ({ userId: u.id, email: u.email ?? '', name: displayName(u), status: statusOf(u) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
}

async function addTeamMember(ctx: Ctx, teamId: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.teamsUpdate)
  if (denied) return denied
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const userId = typeof body.userId === 'string' ? body.userId : ''
  if (!UUID_RE.test(userId)) return badRequest('invalid_user_id')
  const team = await loadTeam(ctx, teamId)
  if (!team) return notFound()

  const groups = await kc.getUserGroups(userId).catch((e) => {
    if (e instanceof KcError && e.code === 'not_found') return null
    throw e
  })
  if (!groups) return notFound('user_not_found', 'No Keycloak account has that id.')
  // Implicit members count (a platform admin, the platform team in `adhar`):
  // they are in the organisation without being listed. The code is about the
  // PERSON added, not the caller — `not_a_member` means "you are not".
  if (!orgAccess(groups, ctx.org.slug).role) {
    return conflict('user_not_in_organisation', 'That person is not a member of this organisation — add them under Members first.')
  }
  await kc.addUserToGroup(userId, teamGroup(ctx.org.slug, team.data.slug))
  touched(ctx, userId)
  await writeAudit(
    ctx.store,
    ctx.user,
    'team.member_add',
    { type: 'team', id: teamId, label: team.data.name },
    ctx.req,
    { userId },
  )
  return json({ item: await teamView(ctx, team) })
}

async function removeTeamMember(ctx: Ctx, teamId: string, userId: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.teamsUpdate)
  if (denied) return denied
  const kc = needKc(ctx)
  if (kc instanceof Response) return kc
  if (!UUID_RE.test(userId)) return badRequest('invalid_user_id')
  const team = await loadTeam(ctx, teamId)
  if (!team) return notFound()
  await kc.removeUserFromGroup(userId, teamGroup(ctx.org.slug, team.data.slug))
  touched(ctx, userId)
  await writeAudit(
    ctx.store,
    ctx.user,
    'team.member_remove',
    { type: 'team', id: teamId, label: team.data.name },
    ctx.req,
    { userId },
  )
  return json({ item: await teamView(ctx, team) })
}

/* ─────────────────── projects ─────────────────── */

function toProject(doc: StoredDoc<ProjectDoc>) {
  return { id: doc.id, ...doc.data }
}

async function listProjects(ctx: Ctx): Promise<Response> {
  const docs = await ctx.store.list<ProjectDoc>(KIND.project)
  return json({ items: docs.map(toProject) })
}

async function createProject(ctx: Ctx): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.projectsCreate)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('missing_name')
  const slug = slugify(typeof body?.slug === 'string' && body.slug.trim() ? body.slug : name)
  const existing = await ctx.store.list<ProjectDoc>(KIND.project)
  if (existing.some((p) => p.data.slug === slug)) return badRequest('slug_taken')

  const doc: ProjectDoc = {
    slug,
    name,
    description: typeof body?.description === 'string' ? body.description.trim() || undefined : undefined,
    tenantId: ctx.tenant,
    teams: Array.isArray(body?.teams) ? (body.teams as string[]).filter((t) => typeof t === 'string') : [],
    primaryRepo: typeof body?.primaryRepo === 'string' ? body.primaryRepo.trim() || undefined : undefined,
    giteaOrg: ctx.tenant,
    argoProject: `${ctx.tenant}-${slug}`,
    harborProject: ctx.tenant,
    environments: Array.isArray(body?.environments) && (body.environments as string[]).length
      ? (body.environments as string[]).filter((e) => typeof e === 'string')
      : ['dev', 'staging', 'prod'],
    createdAt: new Date().toISOString(),
  }
  const id = crypto.randomUUID()
  const saved = await ctx.store.put(KIND.project, id, doc, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'project.create',
    { type: 'project', id, label: name },
    ctx.req,
    { slug },
  )
  return json({ item: toProject(saved) }, 201)
}

async function patchProject(ctx: Ctx, id: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.projectsUpdate)
  if (denied) return denied
  const doc = await ctx.store.get<ProjectDoc>(KIND.project, id)
  if (!doc) return notFound()
  const body = await readBody(ctx.req)
  if (!body) return badRequest('invalid_json')
  const next: ProjectDoc = {
    ...doc.data,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : doc.data.name,
    description: typeof body.description === 'string'
      ? body.description.trim() || undefined
      : doc.data.description,
    primaryRepo: typeof body.primaryRepo === 'string'
      ? body.primaryRepo.trim() || undefined
      : doc.data.primaryRepo,
    teams: Array.isArray(body.teams)
      ? (body.teams as string[]).filter((t) => typeof t === 'string')
      : doc.data.teams,
    environments: Array.isArray(body.environments) && (body.environments as string[]).length
      ? (body.environments as string[]).filter((e) => typeof e === 'string')
      : doc.data.environments,
  }
  const saved = await ctx.store.put(KIND.project, id, next, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'project.update',
    { type: 'project', id, label: next.name },
    ctx.req,
  )
  return json({ item: toProject(saved) })
}

async function deleteProject(ctx: Ctx, id: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.projectsDelete)
  if (denied) return denied
  const doc = await ctx.store.get<ProjectDoc>(KIND.project, id)
  if (!doc) return notFound()
  await ctx.store.remove(KIND.project, id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'project.delete',
    { type: 'project', id, label: doc.data.name },
    ctx.req,
    { slug: doc.data.slug },
  )
  return json({ ok: true })
}

/* ─────────────────── API tokens ─────────────────── */

function toToken(doc: StoredDoc<TokenDoc>) {
  return {
    id: doc.id,
    name: doc.data.name,
    prefix: doc.data.prefix,
    last4: doc.data.last4,
    scopes: doc.data.scopes ?? [],
    ownerType: doc.data.ownerType,
    ownerId: doc.data.ownerId,
    createdAt: doc.data.createdAt,
    createdBy: doc.data.createdBy,
    lastUsedAt: doc.data.lastUsedAt,
    expiresAt: doc.data.expiresAt,
  }
}

async function listTokens(ctx: Ctx): Promise<Response> {
  const docs = await ctx.store.list<TokenDoc>(KIND.token)
  return json({ items: docs.map(toToken) })
}

async function createToken(ctx: Ctx): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.tokensCreate)
  if (denied) return denied
  const body = await readBody(ctx.req)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('missing_name')
  const scopes = Array.isArray(body?.scopes)
    ? (body.scopes as string[]).filter((s) => typeof s === 'string' && s.length > 0)
    : []
  if (scopes.length === 0) return badRequest('missing_scopes')
  let expiresAt: string | undefined
  if (typeof body?.expiresAt === 'string' && body.expiresAt) {
    const parsed = new Date(body.expiresAt)
    if (Number.isNaN(parsed.getTime())) return badRequest('invalid_expiry')
    expiresAt = parsed.toISOString()
  }

  // Mint the secret; store only its hash + display hints. Shown exactly once.
  const secret = mintTokenSecret()
  const doc: TokenDoc = {
    name,
    prefix: secret.slice(0, 12),
    last4: secret.slice(-4),
    hash: await sha256Hex(secret),
    scopes,
    ownerType: 'org',
    ownerId: ctx.tenant,
    createdAt: new Date().toISOString(),
    createdBy: ctx.user.email,
    expiresAt,
  }
  const id = crypto.randomUUID()
  const saved = await ctx.store.put(KIND.token, id, doc, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'token.create',
    { type: 'api-token', id, label: name },
    ctx.req,
    { scopes, expiresAt },
  )
  return json({ token: secret, item: toToken(saved) }, 201)
}

async function revokeToken(ctx: Ctx, id: string): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.tokensRevoke)
  if (denied) return denied
  const doc = await ctx.store.get<TokenDoc>(KIND.token, id)
  if (!doc) return notFound()
  await ctx.store.remove(KIND.token, id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'token.revoke',
    { type: 'api-token', id, label: doc.data.name },
    ctx.req,
  )
  return json({ ok: true })
}

/* ─────────────────── audit log ─────────────────── */

async function listAudit(ctx: Ctx): Promise<Response> {
  const url = new URL(ctx.req.url)
  const p = url.searchParams
  const limit = Math.min(Math.max(Number(p.get('limit') ?? 50) || 50, 1), 500)
  const offset = Math.max(Number(p.get('offset') ?? 0) || 0, 0)
  const q = (p.get('q') ?? '').trim()
  const outcome = p.get('outcome')
  const action = (p.get('action') ?? '').trim()
  const actor = (p.get('actor') ?? '').trim()
  const actorType = (p.get('actorType') ?? '').trim()
  const targetType = (p.get('targetType') ?? '').trim()
  const from = (p.get('from') ?? '').trim()
  const to = (p.get('to') ?? '').trim()
  const sort = p.get('sort') === 'asc' ? 'asc' : 'desc'

  // Everything runs in Postgres — filters, search, ordering and the total —
  // so the audit trail scales to millions of rows without loading them.
  const equals: Array<{ path: string; value: string }> = []
  if (outcome === 'success' || outcome === 'failure') equals.push({ path: 'outcome', value: outcome })
  if (actorType) equals.push({ path: 'actor.type', value: actorType })
  if (targetType) equals.push({ path: 'target.type', value: targetType })
  if (actor) equals.push({ path: 'actor.id', value: actor })
  const page = await ctx.store.query<AuditDoc>(KIND.audit, {
    search: q ? { text: q, paths: ['action', 'actor.label', 'actor.id', 'target.label', 'target.id', 'ip'] } : undefined,
    equals,
    startsWith: action ? [{ path: 'action', value: action }] : undefined,
    range: from || to ? { path: 'at', from: from || undefined, to: to || undefined } : undefined,
    sort: { path: 'at', direction: sort },
    limit,
    offset,
  })
  const items = page.items.map((d) => ({ id: d.id, ...d.data }))
  return json({ items, total: page.total, limit, offset })
}

/** Distinct action / actor-type / target-type values for the filter menus (bounded sample). */
async function auditFacets(ctx: Ctx): Promise<Response> {
  const sample = await ctx.store.query<AuditDoc>(KIND.audit, { limit: 2000, offset: 0, sort: { path: 'at', direction: 'desc' } })
  const actions = new Map<string, number>()
  const actorTypes = new Map<string, number>()
  const targetTypes = new Map<string, number>()
  const actors = new Map<string, { id: string; label: string; n: number }>()
  for (const d of sample.items) {
    const e = d.data
    actions.set(e.action, (actions.get(e.action) ?? 0) + 1)
    actorTypes.set(e.actor.type, (actorTypes.get(e.actor.type) ?? 0) + 1)
    targetTypes.set(e.target.type, (targetTypes.get(e.target.type) ?? 0) + 1)
    const a = actors.get(e.actor.id) ?? { id: e.actor.id, label: e.actor.label, n: 0 }
    a.n += 1
    actors.set(e.actor.id, a)
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }))
  return json({
    sampled: sample.items.length,
    total: sample.total,
    actions: top(actions),
    actorTypes: top(actorTypes),
    targetTypes: top(targetTypes),
    actors: [...actors.values()].sort((a, b) => b.n - a.n).slice(0, 50),
  })
}

/* ─────────────────── approvals queue ─────────────────── */

const APPROVAL_SCOPES = [
  'production-deploy',
  'budget-increase',
  // Kept as the stored id; it now means "grant organisation admin".
  'role-grant-owner',
  'data-export',
  'destructive-rbac',
  'cluster-delete',
]

function toApproval(doc: StoredDoc<ApprovalDoc>) {
  return { id: doc.id, ...doc.data }
}

async function listApprovals(ctx: Ctx): Promise<Response> {
  const docs = await ctx.store.list<ApprovalDoc>(KIND.approval)
  const items = docs.map(toApproval).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
  return json({ items })
}

async function createApproval(ctx: Ctx): Promise<Response> {
  const body = await readBody(ctx.req)
  const scope = typeof body?.scope === 'string' ? body.scope : ''
  const summary = typeof body?.summary === 'string' ? body.summary.trim() : ''
  if (!APPROVAL_SCOPES.includes(scope)) return badRequest('invalid_scope')
  if (!summary) return badRequest('missing_summary')

  const doc: ApprovalDoc = {
    scope,
    summary,
    status: 'pending',
    requestedBy: { id: ctx.user.id, label: ctx.user.email },
    requestedAt: new Date().toISOString(),
  }
  const id = crypto.randomUUID()
  const saved = await ctx.store.put(KIND.approval, id, doc, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    'approval.request',
    { type: 'approval', id, label: `${scope}: ${summary.slice(0, 60)}` },
    ctx.req,
    { scope },
  )
  return json({ item: toApproval(saved) }, 201)
}

async function decideApproval(
  ctx: Ctx,
  id: string,
  status: 'approved' | 'rejected',
): Promise<Response> {
  const denied = await gateWrite(ctx, CONSOLE_PERMISSIONS.approvalsDecide)
  if (denied) return denied
  const doc = await ctx.store.get<ApprovalDoc>(KIND.approval, id)
  if (!doc) return notFound()
  if (doc.data.status !== 'pending') return badRequest('already_decided')
  // Segregation of duty: the requester can never approve their own request.
  if (doc.data.requestedBy.id === ctx.user.id) return json({ error: 'cannot_decide_own_request' }, 403)

  const body = await readBody(ctx.req)
  const note = typeof body?.note === 'string' ? body.note.trim() || undefined : undefined
  const next: ApprovalDoc = {
    ...doc.data,
    status,
    decidedBy: { id: ctx.user.id, label: ctx.user.email },
    decidedAt: new Date().toISOString(),
    note,
  }
  const saved = await ctx.store.put(KIND.approval, id, next, ctx.user.id)
  await writeAudit(
    ctx.store,
    ctx.user,
    `approval.${status === 'approved' ? 'approve' : 'reject'}`,
    { type: 'approval', id, label: `${doc.data.scope}: ${doc.data.summary.slice(0, 60)}` },
    ctx.req,
    { requestedBy: doc.data.requestedBy.label },
  )
  return json({ item: toApproval(saved) })
}
