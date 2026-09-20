import { createFileRoute } from '@tanstack/react-router'
import { handleScorecardHistory } from '~/server/scorecards.ts'

/**
 * GET /api/scorecards/history — the scorer's rolling series of past runs.
 *
 * Reads `adhar-system/adhar-scorecards-history`, which the scorer CronJob
 * appends to on every run (the live results ConfigMap is overwritten, so this is
 * the only place a trend exists). Logic lives in `~/server/scorecards.ts` and is
 * shared verbatim with the production Deno server — never duplicate it here.
 */
export const Route = createFileRoute('/api/scorecards/history')({
  server: {
    handlers: {
      GET: ({ request }) => handleScorecardHistory(request),
    },
  },
})
