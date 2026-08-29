import { setSessionStore, type ServerSession, type ServerSessionStore } from '@adhar-console/auth/server'

/**
 * Postgres-backed server-side session store.
 *
 * Registered at server boot so the auth layer keeps the (large) Keycloak
 * access/refresh/id tokens server-side and the session cookie carries only a
 * small opaque id — which is what makes login reliable. An inlined-tokens
 * cookie exceeds the browser's ~4 KB limit and gets silently dropped, bouncing
 * the user straight back to /login (verified: inline ≈ 5.7 KB, store ≈ 0.2 KB).
 *
 * Sessions live in the generic `documents` table under a reserved system
 * tenant (`auth`) + kind (`auth.session`), so no schema migration is needed.
 * When no database is configured (local dev) `put` throws → the auth layer
 * transparently falls back to the legacy inline cookie.
 */
const db = () => import('@adhar-console/db')

const SESSION_TENANT = 'auth'
const SESSION_KIND = 'auth.session'

export type SessionStoreMode = 'postgres' | 'inline-fallback' | 'unknown'
let storeMode: SessionStoreMode = 'unknown'
let lastError: string | null = null

/** Current session-store mode — surfaced in `/api/diagnostics`. */
export function sessionStoreStatus(): { mode: SessionStoreMode; error: string | null } {
  return { mode: storeMode, error: lastError }
}

const dbSessionStore: ServerSessionStore = {
  async put(id: string, session: ServerSession): Promise<void> {
    const { getMigratedDb, putDocument } = await db()
    const conn = await getMigratedDb()
    if (!conn) {
      storeMode = 'inline-fallback'
      throw new Error('database not configured (getMigratedDb returned null)')
    }
    await putDocument(
      conn,
      SESSION_TENANT,
      SESSION_KIND,
      id,
      session as unknown as Record<string, unknown>,
      session.user.id,
    )
    storeMode = 'postgres'
    lastError = null
  },
  async get(id: string): Promise<ServerSession | null> {
    const { getMigratedDb, getDocument } = await db()
    const conn = await getMigratedDb()
    if (!conn) return null
    const doc = await getDocument(conn, SESSION_TENANT, SESSION_KIND, id)
    return doc ? (doc.data as unknown as ServerSession) : null
  },
  async del(id: string): Promise<void> {
    const { getMigratedDb, deleteDocument } = await db()
    const conn = await getMigratedDb()
    if (!conn) return
    await deleteDocument(conn, SESSION_TENANT, SESSION_KIND, id)
  },
}

let registered = false

/** Register the Postgres session store with the auth layer. Idempotent. */
export function registerDbSessionStore(): void {
  if (registered) return
  registered = true
  setSessionStore(dbSessionStore)

  // Boot probe — connect once so the log/diagnostics show the real mode BEFORE
  // the first login, instead of only discovering it on first token storage.
  void (async () => {
    try {
      const { isDbConfigured, getMigratedDb } = await db()
      if (!isDbConfigured()) {
        storeMode = 'inline-fallback'
        lastError = 'DATABASE_URL not set'
        console.warn(
          '[auth] session store: INLINE FALLBACK — DATABASE_URL is not set. ' +
            'Login with real Keycloak tokens will FAIL (cookie exceeds the 4 KB ' +
            'browser limit and is dropped). Set DATABASE_URL to enable the ' +
            'Postgres session store.',
        )
        return
      }
      const conn = await getMigratedDb()
      if (conn) {
        storeMode = 'postgres'
        lastError = null
        console.log('[auth] session store: Postgres (server-side) — cookie carries only a session id')
      } else {
        storeMode = 'inline-fallback'
        lastError = 'database unreachable at boot'
        console.warn('[auth] session store: database unreachable at boot — will retry per-request')
      }
    } catch (e) {
      storeMode = 'inline-fallback'
      lastError = e instanceof Error ? e.message : String(e)
      console.warn('[auth] session store boot probe failed:', lastError)
    }
  })()
}
