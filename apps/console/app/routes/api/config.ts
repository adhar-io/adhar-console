import { createFileRoute } from '@tanstack/react-router'
import { isServerAuthConfigured } from '@adhar-console/auth/server'
import { env } from '@adhar-console/utils'
import { publicToolInfo } from '~/server/tool-registry.ts'

/**
 * GET /api/config — non-secret runtime configuration for the browser.
 *
 * This is how a single immutable container image is configured per environment:
 * the front-end reads feature flags and external tool URLs (for "open in tool"
 * deep links) from here at runtime instead of baking them in at build time.
 * Secrets (client secret, service tokens, cookie key) are never included.
 */
export const Route = createFileRoute('/api/config')({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          {
            authConfigured: isServerAuthConfigured(),
            builderUrl: env('ADHAR_BUILDER_URL') ?? env('VITE_ADHAR_BUILDER_URL') ?? '',
            tools: publicToolInfo(),
            version: env('ADHAR_CONSOLE_VERSION') ?? '0.1.0',
            // Real single-tenant-per-install backend identifiers so the UI never
            // hardcodes them (Develop/Deliver used a bogus "acme" org/project →
            // 404/empty). Gitea org owns the repos; Argo CD project scopes apps.
            giteaOrg: env('GITEA_TEMPLATES_ORG') ?? env('GITEA_ORG') ?? 'adhar',
            argocdProject: env('ARGOCD_PROJECT') ?? 'default',
          },
          { headers: { 'cache-control': 'no-store' } },
        ),
    },
  },
})
