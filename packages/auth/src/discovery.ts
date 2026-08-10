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

/** Replace an endpoint's origin (protocol+host) with `originUrl`'s, keep its path. */
function withOrigin(endpoint: string, originUrl: string): string {
  try {
    const u = new URL(endpoint)
    const o = new URL(originUrl)
    u.protocol = o.protocol
    u.host = o.host
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
    if (cfg.internalUrl) {
      // When we fetch discovery over the internal HTTP backchannel, Keycloak
      // reflects that request's scheme/host into the URLs it computes — so the
      // doc comes back with the WRONG scheme (e.g. `http://…:8443`). Pin each
      // endpoint to the correct origin ourselves:
      //   - browser-facing (issuer, authorization, end-session) → PUBLIC issuer
      //     origin (the user's browser must reach these over the gateway/HTTPS),
      //   - server-to-server (token, JWKS, userinfo) → INTERNAL Service origin
      //     (the console reaches these from inside the cluster).
      doc.issuer = cfg.issuer
      doc.authorization_endpoint = withOrigin(doc.authorization_endpoint, cfg.issuer)
      if (doc.end_session_endpoint) {
        doc.end_session_endpoint = withOrigin(doc.end_session_endpoint, cfg.issuer)
      }
      doc.token_endpoint = withOrigin(doc.token_endpoint, cfg.internalUrl)
      doc.jwks_uri = withOrigin(doc.jwks_uri, cfg.internalUrl)
      if (doc.userinfo_endpoint) {
        doc.userinfo_endpoint = withOrigin(doc.userinfo_endpoint, cfg.internalUrl)
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
