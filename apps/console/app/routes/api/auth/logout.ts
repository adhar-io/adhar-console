import { createFileRoute } from '@tanstack/react-router'
import { handleLogout } from '@adhar-console/auth/server'

/**
 * GET /api/auth/logout
 *
 * Clears the session cookie and redirects to Keycloak's `end_session_endpoint`
 * (passing the id_token hint) so the IdP SSO session is terminated too, then
 * Keycloak returns the browser to /login.
 */
export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      GET: async ({ request }) => handleLogout(request),
    },
  },
})
