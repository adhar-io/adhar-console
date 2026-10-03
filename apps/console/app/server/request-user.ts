import { getServerAuthConfig, getValidSession } from '@adhar-console/auth/server'
import type { User } from '@adhar-console/auth'
import { env } from '@adhar-console/utils'

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
 * configured AND that the process is not running in a cluster.
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
    } as unknown as User,
    activeTenant: org,
  }
}

/**
 * Resolve the authenticated user for a server-route request from the session
 * cookie, transparently refreshing the access token near expiry. Returns null
 * when there's no valid session or auth isn't configured.
 *
 * `refreshedCookie` (when present) must be attached to the response so a
 * rotated session token is written back to the browser.
 */
export async function getRequestUser(
  request: Request,
): Promise<{ user: User; activeTenant: string; refreshedCookie?: string } | null> {
  const cfg = getServerAuthConfig()
  if (!cfg) return devStubUser()
  const result = await getValidSession(request, cfg)
  if (!result) return null
  return {
    user: result.session.user,
    // Tenant that scopes the user's console-owned data (documents store).
    // Falls back to the user's first tenant, then a shared 'default' space.
    activeTenant: result.session.activeTenant || result.session.user.tenants[0] || 'default',
    refreshedCookie: result.refreshedCookie,
  }
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
