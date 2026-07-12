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
): Promise<{ user: User; refreshedCookie?: string } | null> {
  const cfg = getServerAuthConfig()
  if (!cfg) return null
  const result = await getValidSession(request, cfg)
  if (!result) return null
  return { user: result.session.user, refreshedCookie: result.refreshedCookie }
}

/** Standard 401 for unauthenticated API calls. */
export function unauthorized(): Response {
  return Response.json({ error: 'unauthenticated' }, { status: 401 })
}
