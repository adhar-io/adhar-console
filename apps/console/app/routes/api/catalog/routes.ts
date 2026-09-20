import { createFileRoute } from '@tanstack/react-router'
import { handleEntityRoutes } from '~/server/entity-routes.ts'

/**
 * GET /api/catalog/routes?name=&namespace= — where a catalog entity is reachable.
 *
 * Lists HTTPRoutes and Ingresses whose backend is the entity's Service (name
 * matching is only a fallback) and returns absolute URLs. Logic lives in
 * `~/server/entity-routes.ts` and is shared verbatim with the production Deno
 * server (`apps/console/server.ts`) — never duplicate it here.
 */
export const Route = createFileRoute('/api/catalog/routes')({
  server: {
    handlers: {
      GET: ({ request }) => handleEntityRoutes(request),
    },
  },
})
