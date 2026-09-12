import { env } from '@adhar-console/utils'
import { getDiscovery, getServerAuthConfig, isServerAuthConfigured } from '@adhar-console/auth/server'
import { publicToolInfo } from './tool-registry.ts'
import { discoverRoutedApps } from './app-discovery.ts'
import { consolePublicUrl, platformDomain } from './domain.ts'

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
  // Single source of truth: the platform domain the install was configured
  // with (ADHAR_DOMAIN, else derived from the control-plane / console URL).
  return platformDomain()?.host ?? ''
}

/** Public scheme the platform is served on (from AUTH_PUBLIC_URL; https by default). */
function publicProtocol(): string {
  return platformDomain()?.protocol ?? 'https:'
}

/**
 * Does this realm let a visitor register themselves?
 *
 * Keycloak does not advertise it in OIDC discovery, so we ask the hosted
 * sign-up endpoint: it answers 400 when `registrationAllowed` is false and
 * serves the form (200, or a redirect) when it is true. Cached for the process
 * lifetime — it is a realm setting, not per-request state, and the sign-in page
 * asks on every load.
 */
let selfRegistrationCache: boolean | undefined
async function selfRegistrationAllowed(): Promise<boolean> {
  if (selfRegistrationCache !== undefined) return selfRegistrationCache
  const cfg = getServerAuthConfig()
  if (!cfg) return false
  try {
    const { authorization_endpoint } = await getDiscovery(cfg)
    const url = new URL(authorization_endpoint.replace(/\/auth$/, '/registrations'))
    url.searchParams.set('client_id', cfg.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'openid')
    url.searchParams.set('redirect_uri', `${consolePublicUrl()}/api/auth/callback`)
    const res = await fetch(url, { redirect: 'manual' })
    // 400 is Keycloak's "registration not allowed". Anything else means the
    // form is reachable; a network failure is not evidence either way, so it is
    // treated as unavailable rather than advertising a door that may not open.
    selfRegistrationCache = res.status !== 400
    await res.body?.cancel()
  } catch {
    selfRegistrationCache = false
  }
  return selfRegistrationCache
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
    // Whether a visitor can create their own account. The console offers
    // "Create a new account", but self-registration is a realm setting that many
    // installs deliberately leave off — and onboarding cannot create an
    // organization for someone who has no account to own it. Knowing this up
    // front lets the sign-in page explain that an administrator must create the
    // account, instead of redirecting into a Keycloak error page.
    selfRegistration: await selfRegistrationAllowed(),
    builderUrl: env('ADHAR_BUILDER_URL') ?? env('VITE_ADHAR_BUILDER_URL') ?? '',
    tools,
    // Baked into the image at build time from the release tag (Dockerfile
    // ARG → ENV); an explicit env override still wins. 'dev' = local run.
    version: env('ADHAR_CONSOLE_VERSION') ?? 'dev',
    // Real single-tenant-per-install backend identifiers so the UI never
    // hardcodes them. Gitea org owns the repos; Argo CD project scopes apps.
    giteaOrg: env('GITEA_TEMPLATES_ORG') ?? env('GITEA_ORG') ?? 'adhar',
    argocdProject: env('ARGOCD_PROJECT') ?? 'default',
    // Harbor project the platform pushes images to (Harbor's default is `library`).
    harborProject: env('HARBOR_PROJECT') ?? 'library',
    // Plane workspace the Define phase works in — never a hardcoded company.
    planeWorkspace:
      env('PLANE_WORKSPACE') ?? env('PLANE_WORKSPACE_SLUG') ?? env('GITEA_TEMPLATES_ORG') ?? env('GITEA_ORG') ?? 'adhar',
    docsBaseUrl: env('DOCS_BASE_URL') ?? env('DOCS_URL') ?? 'https://docs.adhar.io',
    publicBaseDomain: base,
    // The one URL an install configures; the client derives tool hosts from it
    // exactly the way the server does.
    consoleUrl: consolePublicUrl(),
    // What the gateway exposes under the base domain, for the launcher and
    // for diagnosing "why isn't app X showing up" (`namespace/route`).
    discoveredApps: discovered.map(({ id, url, route }) => ({ id, url, route })),
  }
}

/** `/api/config` response — same headers from either entry point. */
export async function publicConfigResponse(): Promise<Response> {
  return Response.json(await buildPublicConfig(), { headers: { 'cache-control': 'no-store' } })
}
