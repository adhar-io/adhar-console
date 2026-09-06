import { env } from '@adhar-console/utils'
import { isServerAuthConfigured } from '@adhar-console/auth/server'
import { publicToolInfo } from './tool-registry.ts'

/**
 * The single source of truth for `GET /api/config` — non-secret runtime
 * configuration for the browser.
 *
 * Two entry points serve this route: the production Deno server
 * (`apps/console/server.ts`) and the TanStack file route
 * (`app/routes/api/config.ts`, dev/SSR). They used to carry two hand-copied
 * bodies that drifted — the server one never gained `giteaOrg` /
 * `argocdProject` / `docsBaseUrl` / `publicBaseDomain`, so on a real install
 * those came back `null` and the client fell back to defaults. Both now call
 * this builder. Secrets are never included.
 */

/**
 * Public base domain tools are exposed under (`<tool>.<base>`), used by the app
 * launcher to build URLs for tools whose external URL the BFF can't report
 * (in-cluster `.svc` URLs). An explicit `ADHAR_BASE_DOMAIN` wins; otherwise it
 * is derived from `AUTH_PUBLIC_URL` by dropping the console's own first label
 * (`console.platform.adhar.io` → `platform.adhar.io`) so one immutable image
 * resolves the right hosts on any cluster/domain. Empty when unknowable — the
 * client then falls back to its own origin.
 */
export function publicBaseDomain(): string {
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

export function buildPublicConfig(): Record<string, unknown> {
  return {
    authConfigured: isServerAuthConfigured(),
    builderUrl: env('ADHAR_BUILDER_URL') ?? env('VITE_ADHAR_BUILDER_URL') ?? '',
    tools: publicToolInfo(),
    // Baked into the image at build time from the release tag (Dockerfile
    // ARG → ENV); an explicit env override still wins. 'dev' = local run.
    version: env('ADHAR_CONSOLE_VERSION') ?? 'dev',
    // Real single-tenant-per-install backend identifiers so the UI never
    // hardcodes them. Gitea org owns the repos; Argo CD project scopes apps.
    giteaOrg: env('GITEA_TEMPLATES_ORG') ?? env('GITEA_ORG') ?? 'adhar',
    argocdProject: env('ARGOCD_PROJECT') ?? 'default',
    docsBaseUrl: env('DOCS_BASE_URL') ?? env('DOCS_URL') ?? 'https://docs.adhar.io',
    publicBaseDomain: publicBaseDomain(),
  }
}

/** `/api/config` response — same headers from either entry point. */
export function publicConfigResponse(): Response {
  return Response.json(buildPublicConfig(), { headers: { 'cache-control': 'no-store' } })
}
