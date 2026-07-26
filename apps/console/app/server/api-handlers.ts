import { getRequestUser, unauthorized } from './request-user.ts'

/**
 * Framework-agnostic handlers for the Postgres-backed preferences and
 * notification-state APIs. Shared by the standalone server (server.ts).
 *
 * `@adhar-console/db` is dynamically imported so postgres.js is only pulled in
 * when these endpoints are actually hit, and the endpoints degrade gracefully
 * (persisted:false / empty) when no DB is configured.
 */
const db = () => import('@adhar-console/db')

const SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

export async function handlePreferences(req: Request, scope: string): Promise<Response> {
  if (!SCOPE_RE.test(scope)) return Response.json({ error: 'invalid_scope' }, { status: 400 })
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const method = req.method.toUpperCase()

  if (method === 'GET') {
    const { getMigratedDb, getPreferences } = await db()
    const conn = await getMigratedDb()
    if (!conn) return withCookie(Response.json({ data: null }), auth.refreshedCookie)
    const data = await getPreferences(conn, auth.user.id, scope)
    return withCookie(Response.json({ data }), auth.refreshedCookie)
  }

  if (method === 'PUT') {
    let body: { data?: unknown }
    try {
      body = (await req.json()) as { data?: unknown }
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    if (typeof body.data !== 'object' || body.data === null) {
      return Response.json({ error: 'data_must_be_object' }, { status: 400 })
    }
    const { getMigratedDb, setPreferences, touchUser } = await db()
    const conn = await getMigratedDb()
    if (!conn) return withCookie(Response.json({ ok: true, persisted: false }), auth.refreshedCookie)
    await touchUser(conn, auth.user)
    await setPreferences(conn, auth.user.id, scope, body.data as Record<string, unknown>)
    return withCookie(Response.json({ ok: true, persisted: true }), auth.refreshedCookie)
  }

  return new Response('Method Not Allowed', { status: 405 })
}

export async function handleNotifications(req: Request): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const method = req.method.toUpperCase()

  if (method === 'GET') {
    const { getMigratedDb, getNotificationState } = await db()
    const conn = await getMigratedDb()
    if (!conn) return withCookie(Response.json({ state: [] }), auth.refreshedCookie)
    const state = await getNotificationState(conn, auth.user.id)
    return withCookie(Response.json({ state }), auth.refreshedCookie)
  }

  if (method === 'POST') {
    let body: { id?: string; ids?: string[]; read?: boolean; dismissed?: boolean }
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    const patch = {
      ...(typeof body.read === 'boolean' ? { read: body.read } : {}),
      ...(typeof body.dismissed === 'boolean' ? { dismissed: body.dismissed } : {}),
    }
    if (patch.read === undefined && patch.dismissed === undefined) {
      return Response.json({ error: 'nothing_to_update' }, { status: 400 })
    }
    const ids = body.ids ?? (body.id ? [body.id] : [])
    if (ids.length === 0) return Response.json({ error: 'missing_id' }, { status: 400 })

    const { getMigratedDb, setNotificationState, setNotificationStateBulk, touchUser } = await db()
    const conn = await getMigratedDb()
    if (!conn) return withCookie(Response.json({ ok: true, persisted: false }), auth.refreshedCookie)
    await touchUser(conn, auth.user)
    if (ids.length === 1) await setNotificationState(conn, auth.user.id, ids[0], patch)
    else await setNotificationStateBulk(conn, auth.user.id, ids, patch)
    return withCookie(Response.json({ ok: true, persisted: true }), auth.refreshedCookie)
  }

  return new Response('Method Not Allowed', { status: 405 })
}
