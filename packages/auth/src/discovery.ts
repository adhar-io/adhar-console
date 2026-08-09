import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'
import type { ServerAuthConfig } from './config.ts'

/**
 * OIDC discovery + JWKS, cached per-issuer for the lifetime of the process.
 *
 * Keycloak publishes its endpoints at
 * `${issuer}/.well-known/openid-configuration`. We resolve them once and reuse
 * the document; the JWKS is fetched lazily by `jose` and cached with its own
 * cooldown so key rotation is picked up without a redeploy.
 */
export interface OidcEndpoints {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
  jwks_uri: string
}

const discoveryCache = new Map<string, Promise<OidcEndpoints>>()
const jwksCache = new Map<string, JWTVerifyGetKey>()

/** Swap an endpoint's origin (protocol+host) for the internal one, keep its path. */
function toInternalOrigin(endpoint: string, internalUrl: string): string {
  try {
    const u = new URL(endpoint)
    const i = new URL(internalUrl)
    u.protocol = i.protocol
    u.host = i.host
    return u.toString()
  } catch {
    return endpoint
  }
}

export function getDiscovery(cfg: ServerAuthConfig): Promise<OidcEndpoints> {
  const cached = discoveryCache.get(cfg.issuer)
  if (cached) return cached
  const p = (async () => {
    // Fetch discovery over the in-cluster backchannel when configured, else the
    // public issuer. `internalUrl` is Keycloak's base (…/svc:8080), so the
    // well-known lives under /realms/<realm>/.
    const base = cfg.internalUrl ? `${cfg.internalUrl}/realms/${cfg.realm}` : cfg.issuer
    const url = `${base}/.well-known/openid-configuration`
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      throw new Error(`OIDC discovery failed (${res.status}) at ${url}`)
    }
    const doc = (await res.json()) as OidcEndpoints
    // Keycloak returns PUBLIC endpoints (based on its frontend hostname). Keep
    // `issuer` + the browser-facing authorization/end-session endpoints public,
    // but point the SERVER-TO-SERVER endpoints (token, JWKS, userinfo) at the
    // internal origin so they're reachable from inside the cluster.
    if (cfg.internalUrl) {
      doc.token_endpoint = toInternalOrigin(doc.token_endpoint, cfg.internalUrl)
      doc.jwks_uri = toInternalOrigin(doc.jwks_uri, cfg.internalUrl)
      if (doc.userinfo_endpoint) {
        doc.userinfo_endpoint = toInternalOrigin(doc.userinfo_endpoint, cfg.internalUrl)
      }
    }
    return doc
  })()
  // Cache the promise so concurrent callers share one fetch; drop it on failure
  // so a transient outage doesn't poison the cache forever.
  p.catch(() => discoveryCache.delete(cfg.issuer))
  discoveryCache.set(cfg.issuer, p)
  return p
}

export async function getJwks(cfg: ServerAuthConfig): Promise<JWTVerifyGetKey> {
  const existing = jwksCache.get(cfg.issuer)
  if (existing) return existing
  const { jwks_uri } = await getDiscovery(cfg)
  const set = createRemoteJWKSet(new URL(jwks_uri))
  jwksCache.set(cfg.issuer, set)
  return set
}
