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

export function getDiscovery(cfg: ServerAuthConfig): Promise<OidcEndpoints> {
  const cached = discoveryCache.get(cfg.issuer)
  if (cached) return cached
  const p = (async () => {
    const url = `${cfg.issuer}/.well-known/openid-configuration`
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) {
      throw new Error(`OIDC discovery failed (${res.status}) at ${url}`)
    }
    return (await res.json()) as OidcEndpoints
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
