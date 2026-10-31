import { backfillXrs, organisationManifest, type XrManifest } from './control-plane.ts'
import {
  getServerAuthConfig,
  getValidSession,
  refreshSessionNow,
  serializeCookie,
  signSessionToken,
} from '@adhar/auth/server'
import { getRequestContext, type RequestContext, requireUser, unauthorized } from './request-user.ts'
import { originOk } from './k8s/gateway.ts'
import { requirePermission } from './k8s/access.ts'
import { CONSOLE_PERMISSIONS, type ConsolePermission } from '@adhar/auth/server'
import { getProvisioningJob, listProvisioningJobs, startProvisioning } from './provisioning-jobs.ts'
import { apiServerFetch } from './k8s/gateway.ts'
import { getK8sServiceToken } from './tool-registry.ts'
import { getKeycloakAdmin, type IdentityDirectory, KcError, kcErrorResponse, keycloakNotConfigured } from './workspace/keycloak-admin.ts'
import {
  type DirectoryEntry,
  DirectoryUnavailable,
  entryProblem,
  getOrgDirectory,
  isSystemTenantId,
  type OrgDirectory,
} from './tenancy/directory.ts'
import { entitledEntries, type LiveGroups, sharedLiveGroups } from './tenancy/entitlement.ts'
import {
  confirmOrgAdminLive,
  isNewOrgSlug,
  type OrgAccess,
  OrgAccessError,
  orgAccess,
  orgAdminGroup,
  orgMemberGroup,
  type OrgRole,
  type OrgVia,
  PLATFORM_ORG_SLUG,
  RESERVED_ORG_SLUGS,
  teamGroup,
  teamsOf,
} from './tenancy/org-access.ts'
import { isMigrated, migrateTenant } from './tenancy/migrate-membership.ts'
import { openStore } from './workspace/store.ts'

/**
 * Organization (workspace) management — `/api/organizations/*`.
 *
 * An "organization" is the tenant that scopes the console's own Postgres data
 * (workspace, billing, OKRs, saved views, …) via the session's `activeTenant`.
 * WHO may open one is Keycloak's to say: the organisations listed for someone
 * are those their groups make them a member or admin of (`org-<slug>`,
 * `org-<slug>-admin`, or a platform admin — tenancy/org-access.ts), turned into
 * tenant ids by the shared directory (tenancy/directory.ts). A person added to
 * an organisation in Keycloak therefore sees it at once; one removed does not.
 *
 * The per-user preferences registry the list used to come from still records
 * what each user created and last activated, which is all it is used for.
 *
 * Switching an org re-signs the session cookie with the new `activeTenant`; the
 * client then reloads for a clean slate. Every request re-checks that the
 * session's tenant is still one the caller's groups entitle (request-user.ts).
 *
 *   GET    /api/organizations               → { organizations, activeId }
 *   POST   /api/organizations               → create { name } → activate
 *   POST   /api/organizations/<id>/activate → switch active org
 *   PATCH  /api/organizations/<id>          → rename { name } (org admins)
 *   DELETE /api/organizations/<id>          → LEAVE the organisation
 */

const db = () => import('@adhar/db')
const PREFS_SCOPE = 'organizations'

export interface Organization {
  id: string
  name: string
  slug: string
  /** What this tenant is for, as typed during onboarding. Optional. */
  description?: string
  createdAt: string
  createdBy?: string
}

/** An organisation as the switcher lists it: with the caller's role there. */
export interface OrgEntry {
  id: string
  name: string
  slug: string
  description?: string
  createdAt?: string
  role: OrgRole
  via: OrgVia
}

export interface Registry {
  orgs: Organization[]
  activeId: string
  /**
   * True when these organisations are the SEED below rather than anything a
   * person created. A seeded registry is a placeholder for rendering and must
   * never be promoted into the control plane — see the backfill call site.
   */
  seeded?: boolean
}

/**
 * Namespaces the platform itself runs in. Refused on CREATE (RESERVED_ORG_SLUGS,
 * tenancy/org-access.ts, is only what the control plane refuses): the
 * composition binds the `admin` ClusterRole to `org-<slug>-admin` inside
 * namespace `<slug>` and the creator is put in that group, so an organisation
 * named `argocd` would hand its creator admin over Argo CD's namespace.
 * `slugConflict` below catches any existing namespace; this list also covers
 * installs where that check cannot run.
 *
 * `adhar` is the platform's own organisation, and `dev`/`test`/`prod` are the
 * namespaces of its environments: `org-adhar-admin` is Kubernetes admin of all
 * four (compositions/env/local.yaml). Refusing them here does not depend on
 * the namespace existing yet — it may not during bootstrap.
 */
const PLATFORM_NAMESPACE_RE = /^(kube-|adhar-|openshift-)|^(adhar|dev|test|prod|argocd|argo|argo-rollouts|argo-workflows|kargo|keycloak|gitea|harbor|crossplane-system|cert-manager|ingress-nginx|kyverno|tekton-pipelines|tekton-pipelines-resolvers|monitoring|observability|grafana|loki|mimir|tempo|vault|openbao|cilium|istio-system|velero|external-secrets|coder|plane|strapi|nexus|metabase|airbyte|opencost|trivy-system|falco|cnpg-system|postgres|minio|rustfs)$/

/**
 * Why a new organisation may not take `slug`, or null when it may.
 *
 * Tenant names are GLOBAL across the platform — namespace `<slug>`, Keycloak
 * groups `org-<slug>` / `org-<slug>-admin`, Gitea org `<slug>` — and the
 * creator is put in both groups. Without this check, creating an organisation
 * with the same name as someone else's made the creator a member of THEIR
 * group, with access to THEIR namespace.
 *
 * Checked with the console's own credentials. A check that cannot run at all
 * (no SA token / no Keycloak admin) is skipped, because then the provisioner
 * cannot act on that system either; a check that runs and FAILS counts as
 * taken — refusing a name is recoverable, adopting someone's group is not.
 */
export async function slugConflict(
  slug: string,
  deps: {
    namespaceExists: (slug: string) => Promise<boolean | null>
    groupExists: (name: string) => Promise<boolean | null>
  } = { namespaceExists: k8sNamespaceExists, groupExists: keycloakGroupExists },
): Promise<'reserved' | 'taken' | null> {
  if (RESERVED_ORG_SLUGS.has(slug) || PLATFORM_NAMESPACE_RE.test(slug)) return 'reserved'
  const [ns, member, admin] = await Promise.all([
    deps.namespaceExists(slug),
    deps.groupExists(orgMemberGroup(slug)),
    deps.groupExists(orgAdminGroup(slug)),
  ])
  return ns || member || admin ? 'taken' : null
}

/** true / false, or null when the console cannot ask. */
async function k8sNamespaceExists(slug: string): Promise<boolean | null> {
  const token = getK8sServiceToken()
  if (!token) return null
  try {
    const res = await apiServerFetch(token, `/api/v1/namespaces/${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    await res.body?.cancel()
    if (res.status === 404) return false
    // Anything but a definite "not found" — including a 403 — is treated as
    // taken: refusing a name is recoverable, adopting someone's namespace is not.
    return true
  } catch {
    return true
  }
}

/**
 * `groupExists` for `slugConflict` over a Keycloak client: null when there is
 * no Keycloak to ask, and a lookup that FAILS counts as taken.
 */
export function groupExistsIn(kc: IdentityDirectory | null): (name: string) => Promise<boolean | null> {
  return async (name) => {
    if (!kc) return null
    try {
      return Boolean(await kc.findGroup(name))
    } catch {
      // Keycloak down is not "the name is free": that is how a second tenant
      // would be created on top of an existing tenant's groups.
      return true
    }
  }
}

function keycloakGroupExists(name: string): Promise<boolean | null> {
  return groupExistsIn(getKeycloakAdmin())(name)
}

const NAME_MAX = 60
/** Truncated rather than rejected — a long description is not a failed create. */
const DESCRIPTION_MAX = 280
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function withCookie(res: Response, cookie?: string | null): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org'
}

function randomSuffix(): string {
  const arr = new Uint8Array(5)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
}

/* ─────────── per-user registry (preferences table) ─────────── */

/**
 * The organisation a tenant's Team XRs may name — never the seed placeholder,
 * never a reserved slug. The Organisation backfill already refused both; the
 * TEAM backfill (and team creation) took the slug from here unchecked, so a
 * console with no registry yet created Team `default-platform` for an
 * organisation `default` that exists nowhere: its Gitea-team Job failed every
 * twelve minutes on "organisation default not in Gitea yet" (2026-10-25).
 * (Teams now take their organisation from the directory, which skips both.)
 */
export function controlPlaneOrg(reg: Registry | null, tenantId: string): Organization | undefined {
  if (!reg || reg.seeded) return undefined
  const org = reg.orgs.find((o) => o.id === tenantId)
  return org && !RESERVED_ORG_SLUGS.has(org.slug) ? org : undefined
}

async function readRegistry(userId: string, fallbackActive: string): Promise<Registry | null> {
  const { getMigratedDb, getPreferences } = await db()
  const conn = await getMigratedDb()
  if (!conn) return null
  const raw = (await getPreferences(conn, userId, PREFS_SCOPE)) as Registry | null
  if (raw && Array.isArray(raw.orgs) && raw.orgs.length > 0) {
    return { orgs: raw.orgs, activeId: raw.activeId || raw.orgs[0].id }
  }
  // Seed a default org keyed to the session's current tenant so existing
  // console data stays associated with the user's first organization.
  const seedId = ID_RE.test(fallbackActive) ? fallbackActive : 'default'
  const seed: Registry = {
    orgs: [{ id: seedId, name: 'Default Organization', slug: seedId, createdAt: new Date().toISOString() }],
    activeId: seedId,
    seeded: true,
  }
  return seed
}

async function writeRegistry(
  userId: string,
  // Kept in the signature for callers; the registry is keyed by id and the
  // console keeps no record of the person (Keycloak is the only user store).
  _user: { id: string; name: string; email: string },
  reg: Registry,
): Promise<boolean> {
  const { getMigratedDb, setPreferences } = await db()
  const conn = await getMigratedDb()
  if (!conn) return false
  const { seeded: _seeded, ...stored } = reg
  await setPreferences(conn, userId, PREFS_SCOPE, stored as unknown as Record<string, unknown>)
  return true
}

/**
 * Re-sign the session with `tenantId` as its active tenant — after refreshing
 * its tokens first when `refresh` is set, so a membership the console just
 * changed is in the token the session carries. Returns the cookie and the
 * groups of the token it now holds (null when there is no session).
 */
async function issueSession(
  req: Request,
  tenantId: string,
  opts: { refresh: boolean },
): Promise<{ cookie: string; groups: string[] } | null> {
  // `auth` and `_directory` are the console's own records; `_u_…` is only ever
  // chosen by request-user.ts. No session may be pointed at either by hand.
  if (isSystemTenantId(tenantId)) return null
  const cfg = getServerAuthConfig()
  if (!cfg) return null
  const session = (opts.refresh ? (await refreshSessionNow(req, cfg))?.session : undefined) ??
    (await getValidSession(req, cfg))?.session
  if (!session) return null
  const next = { ...session, activeTenant: tenantId }
  const cookie = serializeCookie(cfg.cookieName, await signSessionToken(next, cfg), {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'Lax',
    maxAge: cfg.sessionTtlSeconds,
  })
  return { cookie, groups: next.user.groups ?? [] }
}

/** Rename the organisation's own settings document too, so both screens agree. */
async function renameWorkspaceDoc(tenantId: string, name: string, userId: string): Promise<void> {
  const store = await openStore(tenantId)
  if (!store) return
  const doc = await store.get<Record<string, unknown>>('workspace.org', 'current')
  if (doc) await store.put('workspace.org', 'current', { ...doc.data, name }, userId)
}

/* ─────────── dependencies (the seam tests replace) ─────────── */

export interface OrganizationsDeps {
  context(req: Request): Promise<RequestContext | null>
  /** Why there is no context: never signed in, or a session that aged out. */
  unauthenticated(req: Request): Promise<'unauthenticated' | 'session_expired'>
  /** RBAC for the one permission that stays RBAC here: creating an organisation. */
  requirePermission(req: Request, perm: ConsolePermission): Promise<Response | null>
  directory: OrgDirectory
  kc(): IdentityDirectory | null
  liveGroups: LiveGroups
  readRegistry(userId: string, fallbackActive: string): Promise<Registry | null>
  writeRegistry(userId: string, user: { id: string; name: string; email: string }, reg: Registry): Promise<boolean>
  issueSession(req: Request, tenantId: string, opts: { refresh: boolean }): Promise<{ cookie: string; groups: string[] } | null>
  renameWorkspaceDoc(tenantId: string, name: string, userId: string): Promise<void>
  startProvisioning: typeof startProvisioning
  backfillXrs(manifests: XrManifest[]): void
  slugChecks?: Parameters<typeof slugConflict>[1]
  isMigrated(tenantId: string): Promise<boolean>
  migrateTenant(tenantId: string): Promise<unknown>
  originOk(req: Request): boolean
}

const DEFAULT_DEPS: OrganizationsDeps = {
  context: getRequestContext,
  unauthenticated: async (req) => {
    const r = await requireUser(req)
    return r.ok ? 'unauthenticated' : r.error
  },
  requirePermission: (req, perm) => requirePermission(req, perm),
  get directory() {
    return getOrgDirectory()
  },
  kc: getKeycloakAdmin,
  liveGroups: sharedLiveGroups,
  readRegistry,
  writeRegistry,
  issueSession,
  renameWorkspaceDoc,
  startProvisioning,
  backfillXrs,
  isMigrated: (tenantId) => isMigrated(tenantId),
  migrateTenant: (tenantId) => migrateTenant(tenantId),
  originOk,
}

/** How long the organisation list waits for an inline migration before answering anyway. */
const INLINE_MIGRATION_BUDGET_MS = 5_000

function toEntry(e: DirectoryEntry, access: OrgAccess): OrgEntry {
  return {
    id: e.tenantId,
    name: e.name,
    slug: e.slug,
    ...(e.description ? { description: e.description } : {}),
    createdAt: e.createdAt,
    role: access.role!,
    via: access.via!,
  }
}

/* ─────────── handler ─────────── */

export async function handleOrganizations(
  req: Request,
  subpath: string,
  overrides: Partial<OrganizationsDeps> = {},
): Promise<Response> {
  const deps: OrganizationsDeps = { ...DEFAULT_DEPS, ...overrides }
  const auth = await deps.context(req)
  if (!auth) return unauthorized(await deps.unauthenticated(req))
  const attach = (res: Response) => withCookie(res, auth.refreshedCookie)

  const method = req.method.toUpperCase()
  if (method !== 'GET' && !deps.originOk(req)) return attach(json({ error: 'origin_not_allowed' }, 403))

  const reg = await deps.readRegistry(auth.user.id, auth.activeTenant)
  if (!reg) return attach(json({ error: 'store_unavailable', detail: 'database not configured' }, 503))

  const seg = subpath.replace(/\/+$/, '').split('/').filter(Boolean)
  const user = { id: auth.user.id, name: auth.user.name, email: auth.user.email }
  const tokenGroups = auth.user.groups ?? []

  try {
    // GET /api/organizations
    if (seg.length === 0 && method === 'GET') {
      // Organisations this user created before membership lived in Keycloak are
      // moved there now if the startup sweep has not reached them yet, so the
      // list below — built from groups — still shows them.
      const pending = reg.seeded ? [] : await unmigrated(deps, reg)
      if (pending.length > 0) {
        let budget: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          Promise.allSettled(pending.map((t) => deps.migrateTenant(t))),
          new Promise((r) => (budget = setTimeout(r, INLINE_MIGRATION_BUDGET_MS))),
        ])
        clearTimeout(budget)
        deps.liveGroups.invalidate(user.id)
      }
      const live = await deps.liveGroups.get(user.id, 30_000)
      const groups = live ?? tokenGroups
      const listed = entitledEntries(await deps.directory.entries(), groups)
      // Every organisation the console knows is an Organisation XR — the ones
      // created before the control plane owned tenancy included. Applied in
      // the background, at most once per object per ten minutes.
      //
      // NOT the seed, and never a reserved name. `readRegistry` invents a
      // "Default Organization" with the bare slug `default` whenever this
      // console has no registry yet, and on 2026-10-13 — with the console
      // database freshly restored and empty — the backfill promoted that
      // placeholder into a real Organisation XR. It adopted the Kubernetes
      // `default` namespace, stamped `adhar.io/organisation: default` on it,
      // and created a matching Gitea org and team. A tenant nobody asked for,
      // holding a namespace the platform must never delete.
      if (!reg.seeded) {
        // Only organisations that still exist (the directory lists them), by
        // the directory's name for them — a registry copy may be stale.
        const known = new Map(listed.map((x) => [x.entry.tenantId, x.entry]))
        deps.backfillXrs(
          reg.orgs
            .filter((o) => !RESERVED_ORG_SLUGS.has(o.slug) && o.slug !== PLATFORM_ORG_SLUG && known.has(o.id))
            .map((o) => known.get(o.id)!)
            .map((e) => organisationManifest({ slug: e.slug, name: e.name, description: e.description })),
        )
      }
      const body = {
        organizations: listed.map((x) => toEntry(x.entry, x.access)),
        activeId: auth.org ? auth.activeTenant : '',
        ...(live ? {} : { degraded: true }),
      }
      return attach(json(body))
    }
    // POST /api/organizations  → create + activate
    if (seg.length === 0 && method === 'POST') return await createOrganization(req, deps, auth, reg)
    // GET /api/organizations/provisioning[/<jobId>] → live provisioning status
    if (seg[0] === 'provisioning' && method === 'GET') {
      if (seg.length === 2) {
        const job = await getProvisioningJob(auth.activeTenant, seg[1])
        return attach(job ? json({ job }) : json({ error: 'not_found' }, 404))
      }
      if (seg.length === 1) return attach(json({ jobs: await listProvisioningJobs(auth.activeTenant) }))
    }
    // POST /api/organizations/<id>/activate
    if (seg.length === 2 && seg[1] === 'activate' && method === 'POST') {
      return await activateOrganization(req, deps, auth, reg, seg[0])
    }
    // PATCH /api/organizations/<id>  → rename
    if (seg.length === 1 && method === 'PATCH') return attach(await renameOrganization(req, deps, auth, reg, seg[0]))
    // DELETE /api/organizations/<id>  → leave
    if (seg.length === 1 && method === 'DELETE') return await leaveOrganization(req, deps, auth, reg, seg[0])
    return attach(json({ error: 'not_found' }, 404))
  } catch (e) {
    const kc = kcErrorResponse(e)
    if (kc) return attach(kc)
    if (e instanceof DirectoryUnavailable) {
      // The cause (a database error, with its host) stays in the log.
      console.warn('[organizations]', e.message)
      return attach(json({ error: 'store_unavailable', detail: 'The organisation directory could not be read. Try again shortly.' }, 503))
    }
    console.error('[organizations] handler error:', e instanceof Error ? e.message : e)
    return attach(json({ error: 'internal_error' }, 500))
  }
}

/** The caller's registry organisations the membership migration has not reached. */
async function unmigrated(deps: OrganizationsDeps, reg: Registry): Promise<string[]> {
  if (!deps.kc()) return []
  const ids = reg.orgs.map((o) => o.id).filter((id) => ID_RE.test(id) && id !== 'default')
  const done = await Promise.all(ids.map((id) => deps.isMigrated(id).catch(() => true)))
  return ids.filter((_, i) => !done[i])
}

/**
 * Create an organisation. The identity step runs FIRST and inline — both
 * groups, the creator in both — because without it the creator could not open
 * what they just made: 503 here means nothing was created. Everything else
 * (namespace, Argo CD project, Gitea, …) is provisioned in the background.
 */
async function createOrganization(
  req: Request,
  deps: OrganizationsDeps,
  auth: RequestContext,
  reg: Registry,
): Promise<Response> {
  const attach = (res: Response) => withCookie(res, auth.refreshedCookie)
  // RBAC `create organizations.console.adhar.io`. The platform grants it to
  // every signed-in user by default (self-service onboarding); an operator
  // who wants tenants created only by the platform team removes that grant.
  const denied = await deps.requirePermission(req, CONSOLE_PERMISSIONS.orgCreate)
  if (denied) return attach(denied)
  const body = (await req.json().catch(() => ({}))) as {
    name?: string
    description?: string
    contactEmail?: string
    contactName?: string
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return attach(json({ error: 'name_required' }, 400))
  if (name.length > NAME_MAX) return attach(json({ error: 'name_too_long' }, 400))
  const slug = slugify(name)
  if (!isNewOrgSlug(slug)) {
    return attach(json({
      error: 'invalid_name',
      detail: 'An organisation name must start with a letter, and may not end in "admin".',
    }, 400))
  }
  const taken = (reserved: boolean) =>
    attach(json({
      error: reserved ? 'name_reserved' : 'name_taken',
      detail: reserved
        ? 'That name is reserved by the platform. Choose another name for the organization.'
        : 'An organization with that name already exists on this platform. Choose another name.',
    }, 409))
  const conflict = await slugConflict(slug, deps.slugChecks)
  if (conflict) return taken(conflict === 'reserved')

  // Onboarding asks what the org is for and shows the answer back on the
  // review step, so it has to be stored — a field that is collected,
  // confirmed and then dropped is worse than never asking.
  const description = (typeof body.description === 'string' ? body.description : '').trim().slice(0, DESCRIPTION_MAX)
  const id = `${slugify(name)}-${randomSuffix()}`.slice(0, 63)
  const org: Organization = {
    id,
    name,
    slug,
    ...(description ? { description } : {}),
    createdAt: new Date().toISOString(),
    createdBy: auth.user.id,
  }
  const dirEntry: DirectoryEntry = {
    slug,
    tenantId: id,
    name,
    ...(description ? { description } : {}),
    createdAt: org.createdAt,
    createdBy: auth.user.id,
  }
  // Everything the directory would refuse is refused BEFORE anything is
  // written to Keycloak — afterwards would leave the creator in the groups.
  if (entryProblem(dirEntry)) return taken(true)

  // The identity step: both groups CREATED (not adopted) by this request, the
  // creator in both. `slugConflict` above is only a check; two requests for
  // one name can both pass it, so creation itself must be exclusive — the
  // loser gets 409 instead of joining the winner's admin group.
  const kc = deps.kc()
  const created: string[] = []
  const joined: string[] = []
  const undoIdentity = async () => {
    if (!kc) return
    // Only what this request did: the memberships it added, the groups it
    // made. A concurrent request's groups (and their members) are not ours.
    for (const g of [...joined].reverse()) await kc.removeUserFromGroup(auth.user.id, g).catch(() => {})
    for (const g of [...created].reverse()) await kc.deleteGroup(g).catch(() => {})
    deps.liveGroups.invalidate(auth.user.id)
  }
  if (kc) {
    try {
      for (const g of [orgMemberGroup(slug), orgAdminGroup(slug)]) {
        await kc.createGroup(g)
        created.push(g)
      }
      for (const g of [orgMemberGroup(slug), orgAdminGroup(slug)]) {
        await kc.addUserToGroup(auth.user.id, g)
        joined.push(g)
      }
    } catch (e) {
      await undoIdentity()
      if (e instanceof KcError && e.code === 'conflict') return taken(false)
      return attach(kcErrorResponse(e) ?? json({ error: 'keycloak_unavailable' }, 503))
    }
    deps.liveGroups.invalidate(auth.user.id)
  }

  // From here on a failure must not leave the creator holding the groups of an
  // organisation that was never recorded.
  let registryWritten = false
  try {
    await deps.writeRegistry(auth.user.id, auth.user, { orgs: [...(reg.seeded ? [] : reg.orgs), org], activeId: id })
    registryWritten = true
    await deps.directory.put(dirEntry, auth.user.id)
  } catch (e) {
    await undoIdentity()
    // The directory is also built from registries: an entry left there would
    // bring back the organisation this request just took apart.
    if (registryWritten) {
      await deps.writeRegistry(auth.user.id, auth.user, reg.seeded ? { orgs: [], activeId: '' } : reg).catch(() => {})
    }
    throw e
  }
  // A fresh token carries the two new groups, so the organisation opens with
  // its admin actions on the next click, not half an hour later.
  const session = await deps.issueSession(req, id, { refresh: true })
  // Provisioning (namespace + RBAC, Argo CD project, Gitea org, …) runs
  // ASYNCHRONOUSLY: the org record above is the source of truth and the
  // response returns at once with a job the caller can watch — or ignore,
  // since a notification (and an email, when mail is configured) lands when it
  // finishes. Closing the tab never loses the provisioning.
  const contactEmail = typeof body.contactEmail === 'string' ? body.contactEmail.trim() : ''
  const contactName = typeof body.contactName === 'string' ? body.contactName.trim() : ''
  let job: Awaited<ReturnType<typeof startProvisioning>> | null = null
  try {
    job = await deps.startProvisioning({
      tenant: id,
      orgId: org.id,
      orgName: org.name,
      orgSlug: org.slug,
      orgDescription: description || undefined,
      user: auth.user,
      contactEmail: contactEmail || undefined,
      contactName: contactName || undefined,
    })
  } catch (e) {
    console.warn('[organizations] could not start provisioning:', e instanceof Error ? e.message : e)
  }
  const entry: OrgEntry = {
    id,
    name,
    slug,
    ...(description ? { description } : {}),
    createdAt: org.createdAt,
    role: 'admin',
    via: 'membership',
  }
  return withCookie(
    json(
      {
        organization: entry,
        activeId: id,
        // Legacy field kept for older clients: the live status now comes
        // from `job` / `GET /api/organizations/provisioning/<jobId>`.
        provisioning: job?.steps ?? [],
        job: job ? { id: job.id, status: job.status, startedAt: job.startedAt } : null,
      },
      201,
    ),
    session?.cookie ?? auth.refreshedCookie,
  )
}

/** The caller's groups straight from Keycloak, or null when it cannot be asked. */
async function liveGroupsNow(deps: OrganizationsDeps, userId: string): Promise<string[] | null> {
  const kc = deps.kc()
  if (!kc) return null
  try {
    return await kc.getUserGroups(userId)
  } catch {
    return null
  }
}

/**
 * Switch the session to organisation `id`. Entitlement is confirmed with
 * Keycloak; when the token does not show the membership yet, the session is
 * refreshed — and if even a fresh token does not, the caller must sign in again
 * (409 `reauth_required`) rather than be let in on a membership the rest of the
 * console cannot see.
 */
async function activateOrganization(
  req: Request,
  deps: OrganizationsDeps,
  auth: RequestContext,
  reg: Registry,
  id: string,
): Promise<Response> {
  const attach = (res: Response) => withCookie(res, auth.refreshedCookie)
  const entry = ID_RE.test(id) ? await deps.directory.byTenant(id, { refreshOnMiss: true }) : null
  if (!entry) return attach(json({ error: 'not_a_member' }, 404))
  const live = await liveGroupsNow(deps, auth.user.id)
  if (!orgAccess(live ?? auth.user.groups ?? [], entry.slug).role) return attach(json({ error: 'not_a_member' }, 404))

  const tokenKnows = orgAccess(auth.user.groups ?? [], entry.slug).role !== null
  const session = await deps.issueSession(req, id, { refresh: !tokenKnows })
  if (!session) return attach(json({ error: 'session_reissue_failed' }, 500))
  if (!orgAccess(session.groups, entry.slug).role) {
    return withCookie(json({
      error: 'reauth_required',
      detail: 'You were added to this organisation after you signed in. Sign in again to open it.',
    }, 409), auth.refreshedCookie)
  }
  const known = reg.seeded ? [] : reg.orgs
  const orgs = known.some((o) => o.id === id)
    ? known
    : [...known, { id, name: entry.name, slug: entry.slug, createdAt: entry.createdAt }]
  await deps.writeRegistry(auth.user.id, auth.user, { orgs, activeId: id })
  return withCookie(json({ activeId: id }), session.cookie)
}

async function renameOrganization(
  req: Request,
  deps: OrganizationsDeps,
  auth: RequestContext,
  reg: Registry,
  id: string,
): Promise<Response> {
  const entry = ID_RE.test(id) ? await deps.directory.byTenant(id, { refreshOnMiss: true }) : null
  if (!entry) return json({ error: 'not_found' }, 404)
  // Explicit organisation, so the check is made for THAT organisation, not
  // the one the session happens to be in.
  if (orgAccess(auth.user.groups ?? [], entry.slug).role !== 'admin') {
    return json({
      error: 'requires_org_admin',
      detail: `Only admins of this organisation can rename it (Keycloak group ${orgAdminGroup(entry.slug)}).`,
    }, 403)
  }
  const kc = deps.kc()
  if (kc) {
    try {
      await confirmOrgAdminLive(kc, auth.user.id, entry.slug)
    } catch (e) {
      if (e instanceof OrgAccessError) return json({ error: 'requires_org_admin' }, 403)
      throw e
    }
  }
  const body = (await req.json().catch(() => ({}))) as { name?: unknown }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > NAME_MAX) return json({ error: 'invalid_name' }, 400)
  await deps.directory.put({ ...entry, name }, auth.user.id)
  await deps.renameWorkspaceDoc(entry.tenantId, name, auth.user.id).catch((e) =>
    console.warn('[organizations] renaming the workspace settings document failed:', e instanceof Error ? e.message : e)
  )
  if (!reg.seeded && reg.orgs.some((o) => o.id === id)) {
    await deps.writeRegistry(auth.user.id, auth.user, { ...reg, orgs: reg.orgs.map((o) => (o.id === id ? { ...o, name } : o)) })
  }
  return json({ organization: toEntry({ ...entry, name }, orgAccess(auth.user.groups ?? [], entry.slug)) })
}

/**
 * Leave organisation `id`: out of its team groups, its admin group and its
 * member group, in that order. The last explicit admin cannot leave (someone
 * must be able to administer it), and someone who only sees the organisation
 * as a platform admin has nothing to leave.
 */
async function leaveOrganization(
  req: Request,
  deps: OrganizationsDeps,
  auth: RequestContext,
  reg: Registry,
  id: string,
): Promise<Response> {
  const attach = (res: Response) => withCookie(res, auth.refreshedCookie)
  const entry = ID_RE.test(id) ? await deps.directory.byTenant(id, { refreshOnMiss: true }) : null
  if (!entry) return attach(json({ error: 'not_found' }, 404))
  const kc = deps.kc()
  if (!kc) return attach(keycloakNotConfigured())
  const slug = entry.slug
  const groups = await kc.getUserGroups(auth.user.id)
  const explicit = groups.includes(orgAdminGroup(slug)) ? 'admin' : groups.includes(orgMemberGroup(slug)) ? 'member' : null
  if (!explicit) {
    if (orgAccess(groups, slug).role) {
      return attach(json({
        error: 'platform_admin_access',
        detail: 'You see this organisation because of your platform role, not a membership — there is nothing to leave.',
      }, 409))
    }
    return attach(json({ error: 'not_found' }, 404))
  }
  const guarded = slug !== PLATFORM_ORG_SLUG
  const otherAdmins = async () =>
    (await kc.listGroupMembers(orgAdminGroup(slug), { fresh: true })).members.filter((m) => m.id !== auth.user.id).length
  if (explicit === 'admin' && guarded && (await otherAdmins()) === 0) {
    return attach(json({
      error: 'cannot_leave_last_admin',
      detail: 'You are the only admin of this organisation. Make someone else an admin before you leave.',
    }, 409))
  }
  for (const t of teamsOf(groups, slug)) await kc.removeUserFromGroup(auth.user.id, teamGroup(slug, t))
  if (explicit === 'admin') {
    await kc.removeUserFromGroup(auth.user.id, orgAdminGroup(slug))
    if (guarded && (await otherAdmins()) === 0) {
      await kc.addUserToGroup(auth.user.id, orgAdminGroup(slug)).catch(() => {})
      return attach(json({
        error: 'cannot_leave_last_admin',
        detail: 'Another change just left this organisation without an admin, so you were kept as one.',
      }, 409))
    }
  }
  await kc.removeUserFromGroup(auth.user.id, orgMemberGroup(slug))
  deps.liveGroups.invalidate(auth.user.id)

  const remaining = reg.seeded ? [] : reg.orgs.filter((o) => o.id !== id)
  const switched = auth.activeTenant === id
  // The next organisation: the same choice request-user.ts makes, from the
  // groups as they are now — among those the user opened before, or the
  // platform's own (being added somewhere never moves anyone in). None at all
  // → '' and the personal tenant.
  const left = groups.filter((g) => g !== orgMemberGroup(slug) && g !== orgAdminGroup(slug) && !g.startsWith(`ws-team-${slug}.`))
  const opened = new Set(remaining.map((o) => o.id))
  const next = switched
    ? entitledEntries(await deps.directory.entries(), left)
      .find((x) => x.entry.tenantId !== id && (x.entry.slug === PLATFORM_ORG_SLUG || opened.has(x.entry.tenantId)))?.entry.tenantId ?? ''
    : auth.activeTenant
  await deps.writeRegistry(auth.user.id, auth.user, { orgs: remaining, activeId: next || remaining[0]?.id || '' })
  // Refresh either way: the token still lists the groups just left, and until
  // it stops, the organisation would keep opening.
  const session = await deps.issueSession(req, next, { refresh: true })
  return withCookie(json({ activeId: next, switched }), session?.cookie ?? auth.refreshedCookie)
}
