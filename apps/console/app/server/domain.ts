import { env } from '@adhar-console/utils'

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

export interface PlatformDomain {
  /** Bare host (may include a port), e.g. `platform.adhar.io` or `adhar.localtest.me:8443`. */
  host: string
  /** `https:` unless the configured entry URL says otherwise. */
  protocol: string
}

function fromUrl(raw: string | undefined): PlatformDomain | null {
  if (!raw) return null
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const labels = u.hostname.split('.')
    // Drop the leading label (console/keycloak/…) when there is a domain left.
    const rest = labels.length > 2 ? labels.slice(1).join('.') : u.hostname
    const port = u.port ? `:${u.port}` : ''
    return { host: `${rest}${port}`, protocol: u.protocol }
  } catch {
    return null
  }
}

function fromBare(raw: string | undefined): PlatformDomain | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!cleaned) return null
  return { host: cleaned, protocol: (env('ADHAR_DOMAIN_PROTOCOL') ?? 'https:').replace(/:?$/, ':') }
}

let cached: PlatformDomain | null | undefined

/** The platform's base domain, or null when nothing identifies it. */
export function platformDomain(): PlatformDomain | null {
  if (cached !== undefined) return cached
  cached =
    fromBare(env('ADHAR_DOMAIN') ?? env('ADHAR_BASE_DOMAIN') ?? env('BASE_DOMAIN')) ??
    fromUrl(env('ADHAR_CONTROL_PLANE_URL')) ??
    fromUrl(env('AUTH_PUBLIC_URL')) ??
    fromUrl(env('KEYCLOAK_URL')) ??
    null
  return cached
}

/** Test seam — re-read the environment. */
export function resetPlatformDomain(): void {
  cached = undefined
}

/** `https://<sub>.<domain>` for the platform's domain, or '' when unknown. */
export function subdomainUrl(sub: string): string {
  const d = platformDomain()
  return d ? `${d.protocol}//${sub}.${d.host}` : ''
}

/**
 * Resolve a tool's base URL: the first explicit env var that is set, else the
 * derived `https://<sub>.<domain>`. This is what makes a one-variable install
 * work — every tile, proxy and deep link resolves without per-tool config.
 */
export function toolUrl(sub: string, ...envKeys: string[]): string {
  for (const k of envKeys) {
    const v = env(k)
    if (v && v.trim()) return v.trim().replace(/\/$/, '')
  }
  return subdomainUrl(sub)
}

/** The console's own public URL (`AUTH_PUBLIC_URL`, else `console.<domain>`). */
export function consolePublicUrl(): string {
  return (env('AUTH_PUBLIC_URL') ?? env('ADHAR_CONSOLE_URL') ?? subdomainUrl('console')).replace(/\/$/, '')
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
