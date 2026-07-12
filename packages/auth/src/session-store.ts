import { SignJWT, jwtVerify } from 'jose'
import type { Session, User } from './types.ts'
import type { ServerAuthConfig } from './config.ts'

/**
 * Server-side session, stateless by design.
 *
 * The full session — including the upstream access/refresh tokens — is encoded
 * into a JWT signed (HS256) with `AUTH_COOKIE_SECRET` and stored in the
 * HttpOnly session cookie. This keeps the console **horizontally scalable with
 * no shared store**: any replica can validate any request's cookie. The tokens
 * never reach the browser (the cookie is HttpOnly and the value is opaque to
 * JS), and `verifySessionToken` rejects tampered or expired cookies.
 *
 * Trade-off: logout cannot revoke an already-issued cookie server-side before
 * its expiry. We mitigate by (a) short session TTLs, (b) clearing the cookie +
 * driving Keycloak's `end_session_endpoint` on logout. A shared revocation
 * store (Redis) can be layered in later behind `ServerSessionStore` without
 * touching call sites.
 */
export interface ServerSession {
  user: User
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
  activeTenant: string
}

const ALG = 'HS256'

function secretKey(cfg: ServerAuthConfig): Uint8Array {
  return new TextEncoder().encode(cfg.cookieSecret)
}

/** Sign a server session into a compact JWT for the session cookie. */
export async function signSessionToken(
  session: ServerSession,
  cfg: ServerAuthConfig,
): Promise<string> {
  return await new SignJWT({ session } as Record<string, unknown>)
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${cfg.sessionTtlSeconds}s`)
    .setSubject(session.user.id)
    .sign(secretKey(cfg))
}

/** Verify + decode a session cookie JWT. Returns null when invalid/expired. */
export async function verifySessionToken(
  token: string,
  cfg: ServerAuthConfig,
): Promise<ServerSession | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(cfg), { algorithms: [ALG] })
    const session = (payload as { session?: ServerSession }).session
    return session ?? null
  } catch {
    return null
  }
}

/**
 * Project a server session down to the client-visible `Session` shape — i.e.
 * with the upstream tokens stripped. This is what `/api/auth/session` returns
 * and what the browser `AuthProvider` consumes; the browser never sees the
 * real access/refresh tokens.
 */
export function toClientSession(s: ServerSession): Session {
  return {
    user: s.user,
    // The browser only needs to know it's authenticated; it calls same-origin
    // proxy routes (cookie-authenticated) rather than holding a bearer token.
    accessToken: 'cookie',
    expiresAt: s.expiresAt,
    activeTenant: s.activeTenant,
  }
}
