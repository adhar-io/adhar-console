import { env } from './env.ts'

/**
 * ONE control-plane domain, everything else derived.
 *
 * A platform install chooses exactly one thing: the domain it is served on
 * (`platform.acme.dev`, `adhar.localtest.me:8443`, …). Every other address the
 * console needs — Keycloak, the console's own public URL, Gitea, Argo CD,
 * Grafana — is that domain with a different first label.
 *
 * This lives in `utils` (not the console app) because **auth** needs it too:
 * hardcoding `KEYCLOAK_URL` in the platform manifests is what sent a
 * DigitalOcean install to a `*.localtest.me` Keycloak. With the fallback here,
 * setting `ADHAR_DOMAIN` alone is genuinely sufficient.
 *
 * Resolution order:
 *   1. `ADHAR_DOMAIN` / `ADHAR_BASE_DOMAIN` / `BASE_DOMAIN` — set at install.
 *   2. `ADHAR_CONTROL_PLANE_URL` — the platform entry URL, minus its first
 *      label (`https://console.platform.acme.dev` → `platform.acme.dev`).
 *   3. `AUTH_PUBLIC_URL`, then `KEYCLOAK_URL`, the same way.
 *   4. `ADHAR_DOMAIN_FALLBACK` — a deployment default for installs that never
 *      chose a domain.
 * Scheme and port are inherited, so `https://…:8443` installs derive
 * `https://gitea.<domain>:8443`.
 *
 * An explicit `<TOOL>_URL` always wins over derivation.
 */

export interface PlatformDomain {
  /** Bare host, possibly with a port: `platform.acme.dev`, `adhar.localtest.me:8443`. */
  host: string
  /** `https:` unless the configured entry URL says otherwise. */
  protocol: string
}

function fromUrl(raw: string | undefined): PlatformDomain | null {
  if (!raw) return null
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const labels = u.hostname.split('.')
    // Drop the leading label (console/keycloak/…) when a domain remains.
    const rest = labels.length > 2 ? labels.slice(1).join('.') : u.hostname
    return { host: `${rest}${u.port ? `:${u.port}` : ''}`, protocol: u.protocol }
  } catch {
    return null
  }
}

function fromBare(raw: string | undefined): PlatformDomain | null {
  const cleaned = (raw ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!cleaned) return null
  const proto = (env('ADHAR_DOMAIN_PROTOCOL') ?? 'https').replace(/:?$/, ':')
  return { host: cleaned, protocol: proto }
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
    // Deployment-provided default, used when the installer's domain ConfigMap
    // is absent (e.g. a laptop install that never chose a domain).
    fromBare(env('ADHAR_DOMAIN_FALLBACK')) ??
    null
  return cached
}

/** Test seam — re-read the environment. */
export function resetPlatformDomain(): void {
  cached = undefined
}

/** `https://<sub>.<domain>`, or '' when the domain is unknown. */
export function subdomainUrl(sub: string): string {
  const d = platformDomain()
  return d ? `${d.protocol}//${sub}.${d.host}` : ''
}

/**
 * A component's base URL: the first explicit env var that is set, else the
 * derived `https://<sub>.<domain>`. One variable then configures an install.
 */
export function derivedUrl(sub: string, ...envKeys: string[]): string {
  for (const k of envKeys) {
    const v = env(k)
    if (v && v.trim()) return v.trim().replace(/\/$/, '')
  }
  return subdomainUrl(sub)
}
