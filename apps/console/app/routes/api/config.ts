import { createFileRoute } from '@tanstack/react-router'
import { publicConfigResponse } from '~/server/public-config.ts'

/**
 * GET /api/config — non-secret runtime configuration for the browser.
 *
 * This is how a single immutable container image is configured per environment:
 * the front-end reads feature flags and external tool URLs (for "open in tool"
 * deep links) from here at runtime instead of baking them in at build time.
 * Secrets (client secret, service tokens, cookie key) are never included.
 *
 * The body lives in `~/server/public-config.ts` and is shared with the
 * production Deno server (`apps/console/server.ts`), which serves this same
 * path outside of TanStack — keep them in sync by never duplicating it here.
 */
export const Route = createFileRoute('/api/config')({
  server: {
    handlers: {
      GET: async () => publicConfigResponse(),
    },
  },
})
