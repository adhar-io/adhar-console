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

/** Hosts that only resolve inside the cluster and mean nothing to a browser. */
const INTERNAL_HOST = /(\.svc\.cluster\.local|\.svc|\.cluster\.local)$|^localhost$|^127\./

/**
 * Whether a URL's host is only reachable from inside the cluster.
 *
 * `toolUrl()` deliberately prefers an explicit in-cluster Service address,
 * because that is the right answer for a server-side call. It is the wrong
 * answer for anything a person is going to click, clone or paste.
 */
export function isInternalUrl(raw: string | undefined): boolean {
  if (!raw) return false
  try {
    return INTERNAL_HOST.test(new URL(raw).hostname)
  } catch {
    return false
  }
}

/**
 * The **publicly reachable** base URL for a tool, for anything that leaves the
 * cluster: a clone URL, a catalog annotation, a link in the UI, a GitOps
 * `repoURL`.
 *
 * Gitea is the case that matters. It builds `html_url` and `clone_url` from the
 * host of the request it received, and the console reaches it over in-cluster
 * Service DNS — so a freshly scaffolded repository reported itself as living at
 * `http://gitea-http.adhar-system.svc.cluster.local:3000/...`, an address no
 * developer can clone and no browser can open.
 *
 * An explicit `<TOOL>_PUBLIC_URL` wins, then the tool's configured URL when it
 * is already public, then the derived `https://<sub>.<domain>`. If nothing
 * public can be determined the internal URL is returned unchanged — a working
 * in-cluster address beats a fabricated public one.
 */
export function toolPublicUrl(sub: string, ...envKeys: string[]): string {
  const explicit = env(`${sub.toUpperCase().replace(/-/g, '_')}_PUBLIC_URL`)
  if (explicit) return explicit.replace(/\/$/, '')
  const configured = derivedUrl(sub, ...envKeys)
  if (configured && !isInternalUrl(configured)) return configured
  const derived = subdomainUrl(sub)
  return derived ? derived.replace(/\/$/, '') : configured
}

/**
 * Rewrite a URL a tool reported about itself onto its public origin, keeping
 * the path. Already-public URLs pass through untouched.
 */
export function toPublicToolUrl(
  raw: string | undefined,
  sub: string,
  ...envKeys: string[]
): string | undefined {
  if (!raw) return raw
  if (!isInternalUrl(raw)) return raw
  const base = toolPublicUrl(sub, ...envKeys)
  if (!base || isInternalUrl(base)) return raw
  try {
    const from = new URL(raw)
    const to = new URL(base)
    // Keep the tool's own path, adopt the public origin (including any port).
    return `${to.origin}${to.pathname.replace(/\/$/, '')}${from.pathname}${from.search}${from.hash}`
  } catch {
    return raw
  }
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
