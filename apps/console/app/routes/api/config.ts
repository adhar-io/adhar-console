import { createFileRoute } from '@tanstack/react-router'
import { isServerAuthConfigured } from '@adhar-console/auth/server'
import { env } from '@adhar-console/utils'
import { publicToolInfo } from '~/server/tool-registry.ts'

/**
 * Public base domain the app launcher derives tool URLs from (`<tool>.<base>`).
 * An explicit `ADHAR_BASE_DOMAIN` wins; otherwise it is derived from
 * `AUTH_PUBLIC_URL` by dropping the console's own first label
 * (`console.platform.adhar.io` → `platform.adhar.io`), so one immutable image
 * resolves the right hosts on any cluster/domain without hardcoding. Empty when
 * neither is set — the client then falls back to its own origin.
 */
function publicBaseDomain(): string {
  const explicit = (env('ADHAR_BASE_DOMAIN') ?? env('BASE_DOMAIN') ?? '').trim()
  if (explicit) return explicit.replace(/^https?:\/\//, '').replace(/\/$/, '')
  try {
    const host = new URL(env('AUTH_PUBLIC_URL') ?? '').host
    const rest = host.split('.').slice(1).join('.')
    return rest.includes('.') ? rest : ''
  } catch {
    return ''
  }
}

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
            docsBaseUrl: env('DOCS_BASE_URL') ?? env('DOCS_URL') ?? 'https://docs.adhar.io',
            publicBaseDomain: publicBaseDomain(),
          },
          { headers: { 'cache-control': 'no-store' } },
        ),
    },
  },
})
