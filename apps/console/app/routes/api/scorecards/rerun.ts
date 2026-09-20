import { createFileRoute } from '@tanstack/react-router'
import { handleScorecardRerun } from '~/server/scorecards.ts'

/**
 * POST /api/scorecards/rerun — score the platform now.
 *
 * Creates a Job from the scorer CronJob's own `jobTemplate` as the caller, so a
 * manual run is the same code path as a scheduled one and the apiserver enforces
 * the user's RBAC. Logic lives in `~/server/scorecards.ts` and is shared
 * verbatim with the production Deno server — never duplicate it here.
 */
export const Route = createFileRoute('/api/scorecards/rerun')({
  server: {
    handlers: {
      POST: ({ request }) => handleScorecardRerun(request),
    },
  },
})
