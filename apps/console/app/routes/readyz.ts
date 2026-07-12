import { createFileRoute } from '@tanstack/react-router'
import { getDiscovery, getServerAuthConfig } from '@adhar-console/auth/server'

/**
 * Readiness probe. Reports whether the console can actually serve authenticated
 * traffic: when Keycloak is configured we verify OIDC discovery resolves, so a
 * pod that can't reach the IdP is pulled from the Service until it can.
 *
 * In stub/demo mode (no Keycloak configured) we report ready — there is nothing
 * external to depend on.
 */
export const Route = createFileRoute('/readyz')({
  server: {
    handlers: {
      GET: async () => {
        // The database is optional persistence — report its status but don't
        // gate readiness on it (K8s-sourced views work without it). Loaded
        // dynamically so postgres.js stays out of the browser bundle.
        const { isDbConfigured, pingDb } = await import('@adhar-console/db')
        const db = isDbConfigured() ? ((await pingDb()) ? 'ok' : 'down') : 'unconfigured'

        const cfg = getServerAuthConfig()
        if (!cfg) {
          return Response.json(
            { status: 'ready', auth: 'stub', db },
            { headers: { 'cache-control': 'no-store' } },
          )
        }
        try {
          await getDiscovery(cfg)
          return Response.json(
            { status: 'ready', auth: 'keycloak', db },
            { headers: { 'cache-control': 'no-store' } },
          )
        } catch (e) {
          return Response.json(
            {
              status: 'not-ready',
              reason: e instanceof Error ? e.message : 'oidc discovery failed',
              db,
            },
            { status: 503, headers: { 'cache-control': 'no-store' } },
          )
        }
      },
    },
  },
})
