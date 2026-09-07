import { env } from '@adhar-console/utils'
import { isServerAuthConfigured } from '@adhar-console/auth/server'
import { publicToolInfo } from './tool-registry.ts'
import { discoverRoutedApps } from './app-discovery.ts'

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

/** Public scheme the platform is served on (from AUTH_PUBLIC_URL; https by default). */
function publicProtocol(): string {
  try {
    return new URL(env('AUTH_PUBLIC_URL') ?? '').protocol || 'https:'
  } catch {
    return 'https:'
  }
}

export async function buildPublicConfig(): Promise<Record<string, unknown>> {
  const base = publicBaseDomain()
  // Start from the env-driven registry, then overlay what the cluster's
  // gateway actually routes: a discovered app gets its REAL public URL (the
  // registry only knows in-cluster `.svc` URLs, reported as ''), and apps the
  // registry never heard of are added as configured. Discovery is best-effort
  // and can only add — it never marks a configured tool unavailable.
  const tools = publicToolInfo()
  const discovered = await discoverRoutedApps(base, publicProtocol())
  for (const app of discovered) {
    tools[app.id] = { configured: true, url: app.url }
  }
  return {
    authConfigured: isServerAuthConfigured(),
    builderUrl: env('ADHAR_BUILDER_URL') ?? env('VITE_ADHAR_BUILDER_URL') ?? '',
    tools,
    // Baked into the image at build time from the release tag (Dockerfile
    // ARG → ENV); an explicit env override still wins. 'dev' = local run.
    version: env('ADHAR_CONSOLE_VERSION') ?? 'dev',
    // Real single-tenant-per-install backend identifiers so the UI never
    // hardcodes them. Gitea org owns the repos; Argo CD project scopes apps.
    giteaOrg: env('GITEA_TEMPLATES_ORG') ?? env('GITEA_ORG') ?? 'adhar',
    argocdProject: env('ARGOCD_PROJECT') ?? 'default',
    // Plane workspace the Define phase works in — never a hardcoded company.
    planeWorkspace:
      env('PLANE_WORKSPACE') ?? env('PLANE_WORKSPACE_SLUG') ?? env('GITEA_TEMPLATES_ORG') ?? env('GITEA_ORG') ?? 'adhar',
    docsBaseUrl: env('DOCS_BASE_URL') ?? env('DOCS_URL') ?? 'https://docs.adhar.io',
    publicBaseDomain: base,
    // What the gateway exposes under the base domain, for the launcher and
    // for diagnosing "why isn't app X showing up" (`namespace/route`).
    discoveredApps: discovered.map(({ id, url, route }) => ({ id, url, route })),
  }
}

/** `/api/config` response — same headers from either entry point. */
export async function publicConfigResponse(): Promise<Response> {
  return Response.json(await buildPublicConfig(), { headers: { 'cache-control': 'no-store' } })
}
