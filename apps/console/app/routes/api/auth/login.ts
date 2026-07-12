import { createFileRoute } from '@tanstack/react-router'
import { handleLogin } from '@adhar-console/auth/server'

/**
 * GET /api/auth/login?returnTo=/path&intent=login|register
 *
 * Starts the OIDC Authorization-Code + PKCE flow: mints a signed transaction
 * cookie (state / nonce / code_verifier / returnTo) and 302-redirects the
 * browser to Keycloak.
 */
export const Route = createFileRoute('/api/auth/login')({
  server: {
    handlers: {
      GET: async ({ request }) => handleLogin(request),
    },
  },
})
