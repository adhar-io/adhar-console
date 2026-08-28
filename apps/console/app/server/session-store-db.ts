import { setSessionStore, type ServerSession, type ServerSessionStore } from '@adhar-console/auth/server'

/**
 * Postgres-backed server-side session store.
 *
 * Registered at server boot so the auth layer keeps the (large) Keycloak
 * access/refresh/id tokens server-side and the session cookie carries only a
 * small opaque id — which is what makes login reliable (an inlined-tokens
 * cookie exceeds the browser's ~4 KB limit and gets silently dropped, bouncing
 * the user back to /login).
 *
 * Sessions live in the generic `documents` table under a reserved system
 * tenant (`auth`) + kind (`auth.session`), so no schema migration is needed.
 * When no database is configured (local dev) `put` throws → the auth layer
 * transparently falls back to the legacy inline cookie.
 */
const db = () => import('@adhar-console/db')

const SESSION_TENANT = 'auth'
const SESSION_KIND = 'auth.session'

const dbSessionStore: ServerSessionStore = {
  async put(id: string, session: ServerSession): Promise<void> {
    const { getMigratedDb, putDocument } = await db()
    const conn = await getMigratedDb()
    if (!conn) throw new Error('database not configured')
    await putDocument(
      conn,
      SESSION_TENANT,
      SESSION_KIND,
      id,
      session as unknown as Record<string, unknown>,
      session.user.id,
    )
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
}
