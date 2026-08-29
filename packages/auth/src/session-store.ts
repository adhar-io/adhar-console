import { SignJWT, jwtVerify } from 'jose'
import type { Session, User } from './types.ts'
import type { ServerAuthConfig } from './config.ts'

/**
 * Server-side session.
 *
 * The session — including the upstream access/refresh/id tokens — is kept in a
 * **server-side store** (Postgres, registered via `setSessionStore`) and the
 * HttpOnly cookie carries only a short, opaque **session id**. This is what
 * makes login reliable: the raw Keycloak tokens (three JWTs) easily exceed the
 * browser's ~4 KB per-cookie limit, so inlining them made the browser silently
 * DROP the cookie → every request looked anonymous → the app bounced back to
 * `/login`. With the tokens server-side the cookie stays tiny.
 *
 * When no store is registered (e.g. local dev with no database) we fall back to
 * the legacy **stateless** cookie that inlines the whole session — fine for the
 * small/stub sessions used there. Either cookie shape is accepted on read, so
 * upgrades and mixed fleets just work.
 *
 * Trade-off (stateless fallback only): logout can't revoke an already-issued
 * cookie before expiry — mitigated by short TTLs + Keycloak end-session. The
 * server-side store deletes the row on logout, giving real revocation.
 */
export interface ServerSession {
  user: User
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
  /**
   * Epoch ms of the original interactive login. Immutable across refreshes —
   * used to enforce an absolute session lifetime so a stolen/rolling cookie
   * can't be extended forever within the sliding TTL window.
   */
  authTime?: number
  activeTenant: string
  /**
   * Server-side store id (present only when a store is active). Never sent to
   * the browser and never included in the client `Session`. Preserved across
   * refreshes so a rotating session keeps a single store row.
   */
  sid?: string
}

/**
 * Pluggable server-side session store. The console registers a Postgres-backed
 * implementation at boot (`setSessionStore`). Kept as an interface so the auth
 * package stays storage-agnostic.
 */
export interface ServerSessionStore {
  put(id: string, session: ServerSession, ttlSeconds: number): Promise<void>
  get(id: string): Promise<ServerSession | null>
  del(id: string): Promise<void>
}

let externalStore: ServerSessionStore | null = null

/** Register (or clear) the server-side session store. Call once at server boot. */
export function setSessionStore(store: ServerSessionStore | null): void {
  externalStore = store
}

const ALG = 'HS256'

function secretKey(cfg: ServerAuthConfig): Uint8Array {
  return new TextEncoder().encode(cfg.cookieSecret)
}

function newSid(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Sign a session into the cookie JWT. With a store active the cookie holds only
 * `{ sid }` (tiny) and the session lives server-side; otherwise it inlines the
 * whole `{ session }` (stateless fallback). A store failure degrades to inline
 * rather than blocking sign-in.
 */
export async function signSessionToken(
  session: ServerSession,
  cfg: ServerAuthConfig,
): Promise<string> {
  if (externalStore) {
    try {
      const sid = session.sid ?? newSid()
      session.sid = sid
      // Persist the full session (with tokens) minus the id we key it by.
      const { sid: _omit, ...stored } = session
      await externalStore.put(sid, { ...stored, sid }, cfg.sessionTtlSeconds)
      return await new SignJWT({ sid } as Record<string, unknown>)
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setExpirationTime(`${cfg.sessionTtlSeconds}s`)
        .setSubject(session.user.id)
        .sign(secretKey(cfg))
    } catch (e) {
      console.warn(
        '[auth] session store unavailable — falling back to a trimmed inline cookie:',
        e instanceof Error ? e.message : e,
      )
      // fall through to the stateless inline cookie
    }
  }
  // Stateless fallback. CRITICAL: drop the large `refreshToken` + `idToken`
  // (each ~1.5–2 KB) — inlining all three Keycloak JWTs pushes the cookie past
  // the browser's ~4 KB limit, so it gets silently dropped and the user bounces
  // back to /login. Keeping only the access token stays under the limit. The
  // trade-off (no server-side refresh; session ends at access-token expiry) is
  // acceptable for the store-less path (local dev / a momentary DB outage) —
  // the Postgres store keeps the full session when it's available.
  const inline: ServerSession = {
    user: session.user,
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
    authTime: session.authTime,
    activeTenant: session.activeTenant,
  }
  const token = await new SignJWT({ session: inline } as Record<string, unknown>)
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${cfg.sessionTtlSeconds}s`)
    .setSubject(session.user.id)
    .sign(secretKey(cfg))
  const bytes = token.length
  if (bytes > 3900) {
    console.warn(
      `[auth] inline session cookie is ${bytes} bytes — over the ~4 KB browser ` +
        'limit even after trimming (very large access token). Configure DATABASE_URL ' +
        'so sessions are stored server-side, or login may fail.',
    )
  }
  return token
}

/** Verify + decode a session cookie JWT. Returns null when invalid/expired. */
export async function verifySessionToken(
  token: string,
  cfg: ServerAuthConfig,
): Promise<ServerSession | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(cfg), { algorithms: [ALG] })
    const p = payload as { sid?: string; session?: ServerSession }
    // Server-side session id → look up the store.
    if (typeof p.sid === 'string' && externalStore) {
      try {
        const s = await externalStore.get(p.sid)
        if (!s) return null
        s.sid = p.sid
        return s
      } catch {
        return null
      }
    }
    // Legacy / stateless inline session.
    if (p.session) return { ...p.session, sid: undefined }
    return null
  } catch {
    return null
  }
}

/** Delete the server-side session backing a cookie (logout). No-op if inline. */
export async function destroySession(token: string, cfg: ServerAuthConfig): Promise<void> {
  if (!externalStore) return
  try {
    const { payload } = await jwtVerify(token, secretKey(cfg), { algorithms: [ALG] })
    const sid = (payload as { sid?: string }).sid
    if (typeof sid === 'string') await externalStore.del(sid)
  } catch {
    // already invalid / inline — nothing to delete
  }
}

/**
 * Project a server session down to the client-visible `Session` shape — i.e.
 * with the upstream tokens (and the internal sid) stripped. This is what
 * `/api/auth/session` returns and what the browser `AuthProvider` consumes; the
 * browser never sees the real access/refresh tokens.
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
