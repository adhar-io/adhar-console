import { createFileRoute } from '@tanstack/react-router'
import { handleCallback } from '@adhar-console/auth/server'

/**
 * GET /api/auth/callback?code=…&state=…
 *
 * Keycloak's redirect target. Validates state against the transaction cookie,
 * exchanges the code for tokens (confidential client), verifies the ID token,
 * sets the signed HttpOnly session cookie, and 302s back to the original
 * `returnTo` (or /onboarding for brand-new users).
 */
export const Route = createFileRoute('/api/auth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => handleCallback(request),
    },
  },
})
