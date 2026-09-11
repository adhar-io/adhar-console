import { createFileRoute } from '@tanstack/react-router'
import { handleScorecards } from '~/server/scorecards.ts'

/**
 * GET /api/scorecards — the platform scorer's production-readiness results.
 *
 * Reads the `adhar-system/adhar-scorecards` ConfigMap published by the
 * `application/scorecards` package's CronJob through the per-user Kubernetes
 * gateway, and returns a typed, normalised payload (`configured: false` when
 * the package isn't installed). The logic lives in `~/server/scorecards.ts` and
 * is shared verbatim with the production Deno server (`apps/console/server.ts`),
 * which serves this same path outside of TanStack — never duplicate it here.
 */
export const Route = createFileRoute('/api/scorecards')({
  server: {
    handlers: {
      GET: ({ request }) => handleScorecards(request),
    },
  },
})
