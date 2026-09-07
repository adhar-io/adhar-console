import { derivedUrl, env, subdomainUrl } from '@adhar-console/utils'

/**
 * ONE control-plane URL, everything else derived.
 *
 * A platform install only ever chooses one thing: the domain it is served on
 * (`adhar.io`, `platform.acme.dev`, `adhar.localtest.me:8443`, …). Every other
 * address the console needs — Keycloak, Gitea, Argo CD, Grafana, Harbor, the
 * console's own public URL — is that domain with a different first label.
 * Requiring ~25 `<TOOL>_URL` variables to be set correctly is what made a
 * fresh DigitalOcean install come up unable to reach its own control plane.
 *
 * Resolution order for the base domain:
 *   1. `ADHAR_DOMAIN` / `ADHAR_BASE_DOMAIN` / `BASE_DOMAIN` — set at install.
 *   2. `ADHAR_CONTROL_PLANE_URL` — the console/platform entry URL, minus its
 *      first label (`https://console.platform.adhar.io` → `platform.adhar.io`).
 *   3. `AUTH_PUBLIC_URL`, then `KEYCLOAK_URL`, the same way.
 * The scheme (and any port) is inherited from whichever URL was used, so
 * `https://…:8443` installs derive `https://gitea.<domain>:8443`.
 *
 * An explicit `<TOOL>_URL` ALWAYS wins — in-cluster Service addresses stay the
 * right answer for server-side calls when the platform sets them.
 */

export type { PlatformDomain } from '@adhar-console/utils'
export { platformDomain, resetPlatformDomain, subdomainUrl } from '@adhar-console/utils'

/**
 * Resolve a tool's base URL: the first explicit env var that is set, else the
 * derived `https://<sub>.<domain>`. This is what makes a one-variable install
 * work — every tile, proxy and deep link resolves without per-tool config.
 */
export function toolUrl(sub: string, ...envKeys: string[]): string {
  return derivedUrl(sub, ...envKeys)
}

/** The console's own public URL (`AUTH_PUBLIC_URL`, else `console.<domain>`). */
export function consolePublicUrl(): string {
  return derivedUrl('console', 'AUTH_PUBLIC_URL', 'ADHAR_CONSOLE_URL')
}

/**
 * Kubernetes API server. In-cluster this is the well-known Service; an
 * out-of-cluster console (or a second cluster) sets `K8S_API_URL`. Derived
 * `api.<domain>` is used only when neither is available, so a console running
 * outside the cluster still finds the control plane it was installed against.
 */
export function controlPlaneUrl(): string {
  const explicit = env('K8S_API_URL')
  if (explicit) return explicit.replace(/\/$/, '')
  const inCluster = Boolean(env('KUBERNETES_SERVICE_HOST'))
  if (inCluster) return 'https://kubernetes.default.svc'
  return subdomainUrl('api') || 'https://kubernetes.default.svc'
}
