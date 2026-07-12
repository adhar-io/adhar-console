import { createFileRoute } from '@tanstack/react-router'
import { handleSession } from '@adhar-console/auth/server'

/**
 * GET /api/auth/session
 *
 * Returns `{ authenticated, configured, session? }`. The session is the
 * client-safe projection (no access/refresh tokens). Transparently refreshes
 * the access token (and re-sets the cookie) when it is near expiry. The
 * browser `AuthProvider` calls this on bootstrap.
 */
export const Route = createFileRoute('/api/auth/session')({
  server: {
    handlers: {
      GET: async ({ request }) => handleSession(request),
    },
  },
})
