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
/** Collection namespace, e.g. `okr.objective`, `design.adr`, `workspace.webhook`. */
const KIND_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/
/** Document id — client-chosen slug/uuid. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

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

/**
 * Generic tenant-scoped document store: `/api/store/<kind>[/<id>]`.
 *   GET    /api/store/<kind>        → list all documents of a kind
 *   POST   /api/store/<kind>        → create (server-assigned id unless body.id)
 *   GET    /api/store/<kind>/<id>   → one document
 *   PUT    /api/store/<kind>/<id>   → upsert
 *   DELETE /api/store/<kind>/<id>   → delete
 *
 * Backs the console's own domain entities (OKRs, saved views, custom roles,
 * webhooks, design docs, API specs). Scoped to the caller's active tenant so
 * data is shared across the tenant's members and persists in Postgres. Returns
 * 503 when no DB is configured — callers must surface that, not silently stub.
 */
export async function handleDocuments(
  req: Request,
  kind: string,
  id?: string,
): Promise<Response> {
  if (!KIND_RE.test(kind)) return Response.json({ error: 'invalid_kind' }, { status: 400 })
  if (id !== undefined && !ID_RE.test(id)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 })
  }
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const method = req.method.toUpperCase()
  const tenant = auth.activeTenant

  const {
    getMigratedDb,
    listDocuments,
    getDocument,
    putDocument,
    deleteDocument,
    touchUser,
  } = await db()
  const conn = await getMigratedDb()
  if (!conn) {
    return withCookie(
      Response.json({ error: 'store_unavailable', detail: 'database not configured' }, { status: 503 }),
      auth.refreshedCookie,
    )
  }

  // Collection endpoints (no id)
  if (id === undefined) {
    if (method === 'GET') {
      const items = await listDocuments(conn, tenant, kind)
      return withCookie(Response.json({ items }), auth.refreshedCookie)
    }
    if (method === 'POST') {
      const data = await readData(req)
      if (data === null) return Response.json({ error: 'data_must_be_object' }, { status: 400 })
      const newId = typeof (data as { id?: unknown }).id === 'string' && ID_RE.test((data as { id: string }).id)
        ? (data as { id: string }).id
        : crypto.randomUUID()
      await touchUser(conn, auth.user)
      const doc = await putDocument(conn, tenant, kind, newId, data, auth.user.id)
      return withCookie(Response.json({ item: doc }, { status: 201 }), auth.refreshedCookie)
    }
    return new Response('Method Not Allowed', { status: 405 })
  }

  // Item endpoints (with id)
  if (method === 'GET') {
    const doc = await getDocument(conn, tenant, kind, id)
    if (!doc) return withCookie(Response.json({ error: 'not_found' }, { status: 404 }), auth.refreshedCookie)
    return withCookie(Response.json({ item: doc }), auth.refreshedCookie)
  }
  if (method === 'PUT') {
    const data = await readData(req)
    if (data === null) return Response.json({ error: 'data_must_be_object' }, { status: 400 })
    await touchUser(conn, auth.user)
    const doc = await putDocument(conn, tenant, kind, id, data, auth.user.id)
    return withCookie(Response.json({ item: doc }), auth.refreshedCookie)
  }
  if (method === 'DELETE') {
    const removed = await deleteDocument(conn, tenant, kind, id)
    return withCookie(Response.json({ ok: removed }, { status: removed ? 200 : 404 }), auth.refreshedCookie)
  }
  return new Response('Method Not Allowed', { status: 405 })
}

/** Parse a JSON body's document payload — accepts `{data:{…}}` or a bare object. */
async function readData(req: Request): Promise<Record<string, unknown> | null> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const maybe = body as { data?: unknown }
  const data = maybe.data !== undefined ? maybe.data : body
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  return data as Record<string, unknown>
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
