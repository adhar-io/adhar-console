import { env } from '@adhar-console/utils'

/**
 * Server-side auth configuration, read from the runtime environment.
 *
 * Unlike the (now-removed) browser OIDC config, none of this is exposed to the
 * client bundle — it lives only in the BFF / server routes. The console is a
 * **confidential** OIDC client: it holds `AUTH_CLIENT_SECRET` and performs the
 * authorization-code exchange server-side.
 *
 * Required in production:
 *   - KEYCLOAK_URL        e.g. https://keycloak.adhar.local
 *   - KEYCLOAK_CLIENT_ID  e.g. adhar-console
 *   - AUTH_CLIENT_SECRET  the confidential client secret from Keycloak
 *   - AUTH_COOKIE_SECRET  >= 32 chars; signs the session + transaction cookies
 *
 * Optional:
 *   - KEYCLOAK_REALM            (default "adhar")
 *   - AUTH_PUBLIC_URL           external origin of the console, used to build
 *                               the OIDC redirect_uri. Falls back to the
 *                               request origin when unset.
 *   - AUTH_SCOPES               (default "openid profile email offline_access")
 *   - AUTH_SESSION_TTL_SECONDS  (default 28800 = 8h) — session cookie lifetime.
 *   - AUTH_COOKIE_NAME          (default "adhar_session")
 *   - AUTH_COOKIE_SECURE        "true"/"false" (default: true unless DEV)
 */
export interface ServerAuthConfig {
  issuer: string
  realm: string
  clientId: string
  clientSecret: string
  cookieSecret: string
  cookieName: string
  cookieSecure: boolean
  publicUrl?: string
  scopes: string
  sessionTtlSeconds: number
}

const DEFAULT_REALM = 'adhar'
const DEFAULT_CLIENT = 'adhar-console'
const DEFAULT_SCOPES = 'openid profile email offline_access'
const DEFAULT_SESSION_TTL = 8 * 60 * 60
const DEFAULT_COOKIE_NAME = 'adhar_session'

function isDev(): boolean {
  return (env('NODE_ENV') ?? env('DENO_ENV')) !== 'production'
}

/**
 * Returns the resolved server auth config, or `null` when the minimum required
 * variables are absent. A `null` here means "run in stub/demo mode" — the
 * server routes degrade gracefully instead of crashing the container.
 */
export function getServerAuthConfig(): ServerAuthConfig | null {
  const url = env('KEYCLOAK_URL')?.replace(/\/$/, '')
  const clientSecret = env('AUTH_CLIENT_SECRET') ?? env('KEYCLOAK_CLIENT_SECRET')
  const cookieSecret = env('AUTH_COOKIE_SECRET')
  if (!url || !clientSecret || !cookieSecret) return null

  if (cookieSecret.length < 32) {
    throw new Error(
      'AUTH_COOKIE_SECRET must be at least 32 characters — generate one with `openssl rand -base64 48`.',
    )
  }

  const realm = env('KEYCLOAK_REALM') ?? DEFAULT_REALM
  const secureRaw = env('AUTH_COOKIE_SECURE')
  return {
    issuer: `${url}/realms/${realm}`,
    realm,
    clientId: env('KEYCLOAK_CLIENT_ID') ?? DEFAULT_CLIENT,
    clientSecret,
    cookieSecret,
    cookieName: env('AUTH_COOKIE_NAME') ?? DEFAULT_COOKIE_NAME,
    cookieSecure: secureRaw ? secureRaw === 'true' : !isDev(),
    publicUrl: env('AUTH_PUBLIC_URL')?.replace(/\/$/, ''),
    scopes: env('AUTH_SCOPES') ?? DEFAULT_SCOPES,
    sessionTtlSeconds: Number(env('AUTH_SESSION_TTL_SECONDS') ?? DEFAULT_SESSION_TTL),
  }
}

/** True when Keycloak + a confidential client secret are configured. */
export function isServerAuthConfigured(): boolean {
  return getServerAuthConfig() !== null
}

/**
 * Resolve the external base URL of the console for building redirect URIs.
 * Prefers `AUTH_PUBLIC_URL`; otherwise derives it from the incoming request
 * (honouring `X-Forwarded-Proto`/`Host` set by the ingress).
 */
export function resolvePublicOrigin(cfg: ServerAuthConfig, req: Request): string {
  if (cfg.publicUrl) return cfg.publicUrl
  const h = req.headers
  const proto = h.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '')
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? new URL(req.url).host
  return `${proto}://${host}`
}
