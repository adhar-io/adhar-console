import { getServerAuthConfig, getValidSession } from '@adhar-console/auth/server'
import type { User } from '@adhar-console/auth'

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
  if (!cfg) return null
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
