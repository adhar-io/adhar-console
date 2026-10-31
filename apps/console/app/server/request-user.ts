import {
  getServerAuthConfig,
  getValidSession,
  refreshSessionNow,
  serializeCookie,
  type ServerAuthConfig,
  type ServerSession,
  signSessionToken,
} from '@adhar/auth/server'
import type { User } from '@adhar/auth'
import { env } from '@adhar/utils'
import { type DirectoryEntry, getOrgDirectory } from './tenancy/directory.ts'
import { type EntitlementDeps, type ResolvedTenant, resolveActiveTenant, sharedLiveGroups } from './tenancy/entitlement.ts'
import { NO_ACCESS, type OrgAccess, orgAccess } from './tenancy/org-access.ts'

/**
 * The identity a laptop runs as when there is no identity provider.
 *
 * The local dev session is a stub that exists only in the browser: the login
 * page hands out a session the BFF has no way to validate, so every route
 * built on `getRequestUser` answered 401 to a console that looked signed in.
 * `.env` already turns on `ADHAR_DEV_CLUSTER_AUTH` so cluster reads work the
 * same way; this is the same bargain for the console's own routes.
 *
 * What it broke, concretely: `/api/templates` returned `unauthenticated`, so
 * Create New said "No templates available — the Gitea templates repository is
 * not reachable", which is not what had happened. `/api/teams` returned the
 * same, so the owner picker silently fell back to two hardcoded defaults.
 * Both looked like integration failures and were authentication failures.
 *
 * It cannot engage anywhere but a laptop: it requires BOTH that no auth is
 * configured AND that the process is not running in a cluster. It is a
 * platform admin (`groups`), so organisation-scoped actions work as they did
 * before membership came from Keycloak.
 */
function devStubUser(): { user: User; activeTenant: string } | null {
  if (getServerAuthConfig() || env('KUBERNETES_SERVICE_HOST')) return null
  if (env('ADHAR_DEV_CLUSTER_AUTH') !== 'true') return null
  // The tenant is the install's Gitea org, not a literal 'default'. Anything
  // org-scoped resolves through `activeTenant` — the owner picker asks it which
  // organisation's teams to list — and on a laptop the console is pointed at
  // exactly one org, so that is the honest answer. Saying 'default' sent those
  // lookups to an organisation that does not exist.
  const org = env('GITEA_TEMPLATES_ORG') ?? env('GITEA_ORG') ?? 'adhar'
  return {
    user: {
      id: 'local-dev',
      name: 'Demo User',
      email: 'demo@adhar.local',
      tenants: [org],
      roles: ['platform-admin'],
      groups: ['platform-admin'],
    } as unknown as User,
    activeTenant: org,
  }
}

/** Everything a handler needs to know about who is asking and where. */
export interface RequestContext {
  user: User
  /** The tenant this request's console data is scoped to — re-validated, never just remembered. */
  activeTenant: string
  /** Attach to the response when present: the session was refreshed or re-scoped. */
  refreshedCookie?: string
  /** The caller's Keycloak access token (server-side use only). */
  accessToken?: string
  /** The organisation `activeTenant` holds; null for a personal tenant. */
  org: DirectoryEntry | null
  /** The caller's role in `org`, from their token's groups. */
  access: OrgAccess
  /** True for the caller's private tenant: no organisation, nothing shared. */
  personal: boolean
  /** The organisation could not be resolved (directory unreadable). */
  degraded: boolean
}

/** Organisation lookups for the request path, wired to the shared directory and Keycloak. */
function entitlementDeps(devMode: boolean): EntitlementDeps {
  const registry = async (userId: string) => {
    const { getMigratedDb, getPreferences } = await import('@adhar/db')
    const conn = await getMigratedDb()
    if (!conn) return null
    return (await getPreferences(conn, userId, 'organizations')) as { activeId?: unknown; orgs?: unknown } | null
  }
  return {
    directory: getOrgDirectory(),
    liveGroups: sharedLiveGroups,
    registryActiveId: async (userId) => {
      const reg = await registry(userId)
      return typeof reg?.activeId === 'string' ? reg.activeId : null
    },
    registryOrgIds: async (userId) => {
      const reg = await registry(userId)
      return (Array.isArray(reg?.orgs) ? reg.orgs : [])
        .map((o) => (o && typeof o === 'object' ? (o as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string')
    },
    devMode,
  }
}

/**
 * Forced refreshes are rate-limited per user: if Keycloak says "member" and a
 * fresh token still does not (a mapper or a subgroup quirk), refreshing on
 * every request would only hammer the token endpoint.
 */
const FORCED_REFRESH_GAP_MS = 60_000
const forcedRefreshAt = new Map<string, number>()

function mayForceRefresh(userId: string): boolean {
  const last = forcedRefreshAt.get(userId) ?? 0
  if (Date.now() - last < FORCED_REFRESH_GAP_MS) return false
  if (forcedRefreshAt.size > 10_000) forcedRefreshAt.clear()
  forcedRefreshAt.set(userId, Date.now())
  return true
}

/**
 * The caller's role for this request. The token's groups decide — that is what
 * <Can>/useCan and Kubernetes RBAC see. When Keycloak has confirmed a
 * membership the token does not carry yet (the forced refresh failed or was
 * rate-limited), the organisation's data is already open to them, and so are
 * its member-level views (audit, billing): `member`, never more. Admin actions
 * wait for a token that says admin — and every access-changing write re-checks
 * Keycloak live regardless.
 */
export function requestAccess(tokenGroups: readonly string[], r: Pick<ResolvedTenant, 'org' | 'access'>): OrgAccess {
  if (!r.org) return NO_ACCESS
  const fromToken = orgAccess(tokenGroups, r.org.slug)
  if (fromToken.role) return fromToken
  return r.access.role ? { role: 'member', via: r.access.via } : NO_ACCESS
}

async function sessionCookie(session: ServerSession, cfg: ServerAuthConfig): Promise<string> {
  return serializeCookie(cfg.cookieName, await signSessionToken(session, cfg), {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'Lax',
    maxAge: cfg.sessionTtlSeconds,
  })
}

async function computeContext(request: Request): Promise<RequestContext | null> {
  const cfg = getServerAuthConfig()
  if (!cfg) {
    const dev = devStubUser()
    if (!dev) return null
    const r = await resolveActiveTenant(
      { userId: dev.user.id, groups: dev.user.groups, sessionTenant: dev.activeTenant },
      entitlementDeps(true),
    )
    return { user: dev.user, activeTenant: r.tenant, org: r.org, access: r.access, personal: r.personal, degraded: r.degraded }
  }

  const result = await getValidSession(request, cfg)
  if (!result) return null
  let session = result.session
  let cookie = result.refreshedCookie
  const deps = entitlementDeps(false)
  const resolve = (s: ServerSession) =>
    // Sessions minted before `groups` existed carry none: treat that as no groups.
    resolveActiveTenant({ userId: s.user.id, groups: s.user.groups ?? [], sessionTenant: s.activeTenant ?? '' }, deps)

  let r = await resolve(session)
  if (r.needsRefresh && mayForceRefresh(session.user.id)) {
    // Keycloak entitles an organisation the token does not show yet (a group
    // added since it was minted): a fresh token makes the rest of the console
    // — useCan, Kubernetes RBAC — agree with it now rather than in 30 minutes.
    const fresh = await refreshSessionNow(request, cfg)
    if (fresh) {
      session = fresh.session
      cookie = fresh.refreshedCookie
      // Decide again with the new token, starting from what was just picked;
      // `session.activeTenant` stays the stored value so the check below
      // re-signs the session when the tenant moved.
      r = await resolve({ ...session, activeTenant: r.tenant })
    }
  }
  if (r.degraded) {
    // Nothing could be checked: the request works in the caller's PERSONAL
    // tenant (entitlement.ts fails closed), and the session is not re-signed,
    // so it still remembers its organisation for when the directory is back.
    return {
      user: session.user,
      activeTenant: r.tenant,
      refreshedCookie: cookie,
      accessToken: session.accessToken,
      org: null,
      access: NO_ACCESS,
      personal: r.personal,
      degraded: true,
    }
  }
  if (r.tenant !== session.activeTenant) {
    // Remember the re-decided tenant, so the next request takes the fast path.
    session = { ...session, activeTenant: r.tenant }
    cookie = await sessionCookie(session, cfg)
  }
  // The token's own groups decide `access`; a membership only Keycloak knows
  // about so far opens the organisation's data and its member-level views,
  // not its admin actions (see requestAccess).
  return {
    user: session.user,
    activeTenant: r.tenant,
    refreshedCookie: cookie,
    accessToken: session.accessToken,
    org: r.org,
    access: requestAccess(session.user.groups ?? [], r),
    personal: r.personal,
    degraded: false,
  }
}

const contexts = new WeakMap<Request, Promise<RequestContext | null>>()

/**
 * Who is asking, and in which organisation — once per request. Handlers and
 * the authorization layer (k8s/access.ts) call this for the same request; the
 * answer is computed once, so they cannot disagree and a forced token refresh
 * happens at most once.
 */
export function getRequestContext(request: Request): Promise<RequestContext | null> {
  let p = contexts.get(request)
  if (!p) {
    p = computeContext(request)
    contexts.set(request, p)
  }
  return p
}

/**
 * Resolve the authenticated user for a server-route request from the session
 * cookie, transparently refreshing the access token near expiry. Returns null
 * when there's no valid session or auth isn't configured.
 *
 * `activeTenant` is the organisation's tenant when the caller's groups entitle
 * one, otherwise their personal tenant — never a shared default they were not
 * given.
 *
 * `refreshedCookie` (when present) must be attached to the response so a
 * rotated session token is written back to the browser.
 */
export async function getRequestUser(
  request: Request,
): Promise<{ user: User; activeTenant: string; refreshedCookie?: string } | null> {
  const ctx = await getRequestContext(request)
  if (!ctx) return null
  return { user: ctx.user, activeTenant: ctx.activeTenant, refreshedCookie: ctx.refreshedCookie }
}

/** Standard 401 for unauthenticated API calls. */
export function unauthorized(error: 'unauthenticated' | 'session_expired' = 'unauthenticated'): Response {
  return Response.json(
    {
      error,
      detail:
        error === 'session_expired'
          ? 'Your session expired or could not be refreshed. Sign in again to continue — nothing you entered is lost.'
          : 'Sign in to continue.',
    },
    { status: 401 },
  )
}

/**
 * Why authentication failed, so the client can tell "you were never signed in"
 * apart from "your session aged out mid-flow" — the latter is recoverable with
 * a silent re-login and must never read as "unauthenticated" to a user who has
 * been working in the console for the last ten minutes.
 */
export async function requireUser(
  request: Request,
): Promise<
  | { ok: true; user: User; activeTenant: string; refreshedCookie?: string }
  | { ok: false; error: 'unauthenticated' | 'session_expired' }
> {
  const auth = await getRequestUser(request)
  if (auth) return { ok: true, ...auth }
  const cfg = getServerAuthConfig()
  // A session cookie was presented but no longer resolves → it expired or its
  // refresh token was rejected; anything else means there was never a session.
  const hadCookie = Boolean(cfg && (request.headers.get('cookie') ?? '').includes(`${cfg.cookieName}=`))
  return { ok: false, error: hadCookie ? 'session_expired' : 'unauthenticated' }
}
