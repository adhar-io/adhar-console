import { createFileRoute } from '@tanstack/react-router'

/**
 * Liveness probe. Always 200 while the process is up — it must NOT depend on
 * Keycloak or any backing tool, or a transient upstream outage would cause
 * Kubernetes to kill otherwise-healthy pods.
 */
export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: async () =>
        Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } }),
    },
  },
})
