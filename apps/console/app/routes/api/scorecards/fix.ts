import { createFileRoute } from '@tanstack/react-router'
import { handleScorecardFix } from '~/server/scorecard-fix.ts'

/**
 * POST /api/scorecards/fix — commit a scorecard fix (catalog-info.yaml or
 * deploy manifests) as a pull request or a direct commit, gated to the owning
 * team's developers and platform admins. Logic lives in
 * `~/server/scorecard-fix.ts` and is shared verbatim with the production Deno
 * server — never duplicate it here.
 */
export const Route = createFileRoute('/api/scorecards/fix')({
  server: {
    handlers: {
      POST: ({ request }) => handleScorecardFix(request),
    },
  },
})
