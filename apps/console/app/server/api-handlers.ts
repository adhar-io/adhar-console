import { CONSOLE_PERMISSIONS, type ConsolePermission } from '@adhar/auth/server'
import { getRequestUser, unauthorized } from './request-user.ts'
import { requirePermission } from './k8s/access.ts'

/**
 * Framework-agnostic handlers for the Postgres-backed preferences and
 * notification-state APIs. Shared by the standalone server (server.ts).
 *
 * `@adhar/db` is dynamically imported so postgres.js is only pulled in
 * when these endpoints are actually hit, and the endpoints degrade gracefully
 * (persisted:false / empty) when no DB is configured.
 */
const db = () => import('@adhar/db')

const SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** Collection namespace, e.g. `okr.objective`, `design.adr`, `workspace.webhook`. */
const KIND_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/
/**
 * Kinds only server handlers may touch. Every one of these is something an
 * authorization decision or a credential lives in, so letting a tenant member
 * write it through this generic store bypasses the handler that guards it:
 *   - `auth.*`        server-side sessions, tokens included (session-store-db.ts);
 *   - `billing.*`     subscription / invoices / payment methods (billing/);
 *   - `console.*`     notifications and provisioning jobs;
 *   - `security.*`    scan waivers the CI enforces (scan-waivers.ts);
 *   - `resilience.*`  chaos run evidence for promotions (resilience-reports.ts);
 *   - the workspace API's own records — `workspace.member` carried the caller's
 *     ROLE (a member PUTting `{role:'owner'}` became owner) and is what the
 *     Keycloak membership migration replays, `workspace.invitation` the
 *     accept-token hash, `workspace.audit` the audit trail,
 *     `workspace.migration` the migration's done-markers (writing one would
 *     skip a tenant's migration), `workspace.org-directory` which tenant holds
 *     which organisation (writing one would point a slug at your tenant).
 * Other `workspace.*` kinds (settings pages: theme, webhooks, roles, …) are
 * client-owned documents and stay available.
 */
const RESERVED_KIND = /^(auth|billing|console|security|resilience)\./
const RESERVED_WORKSPACE_KINDS = new Set([
  'workspace.org',
  'workspace.member',
  'workspace.invitation',
  'workspace.team',
  'workspace.project',
  'workspace.api-token',
  'workspace.approval',
  'workspace.audit',
  'workspace.migration',
  'workspace.org-directory',
])

/**
 * Client-owned kinds whose WRITES are still permissions. `workspace.role` is a
 * custom role from before an organisation's roles came from Keycloak: it grants
 * nothing any more (there are two roles, `org-<slug>` member and
 * `org-<slug>-admin` admin) and no page offers it, but writing one stays an
 * organisation-admin action so nobody else can plant one.
 */
const GUARDED_KIND_WRITES: Record<string, Partial<Record<'POST' | 'PUT' | 'DELETE', ConsolePermission>>> = {
  'workspace.role': {
    POST: CONSOLE_PERMISSIONS.rolesCreate,
    PUT: CONSOLE_PERMISSIONS.rolesUpdate,
    DELETE: CONSOLE_PERMISSIONS.rolesDelete,
  },
  // Support-ticket settings decide what evidence the console ships to Plane
  // and where — an organisation setting, like the routing table beside it.
  'workspace.support-tickets': {
    POST: CONSOLE_PERMISSIONS.orgUpdate,
    PUT: CONSOLE_PERMISSIONS.orgUpdate,
    DELETE: CONSOLE_PERMISSIONS.orgUpdate,
  },
}

/** True for a document kind `/api/store` must refuse. */
export function isReservedKind(kind: string): boolean {
  return RESERVED_KIND.test(kind) || RESERVED_WORKSPACE_KINDS.has(kind)
}

/**
 * Preference scopes that are server-owned. `organizations` is the registry of
 * tenants a user may activate (organizations.ts) — writable here, a user could
 * list any tenant id (including the `auth` session tenant) and switch into it.
 */
const RESERVED_SCOPES = new Set(['organizations'])
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
    if (RESERVED_SCOPES.has(scope)) {
      return withCookie(
        Response.json({ error: 'reserved_scope', detail: `${scope} is managed by the console server.` }, { status: 403 }),
        auth.refreshedCookie,
      )
    }
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
  // Server-owned collections: scan waivers carry approvals the CI enforces, so
  // they are only ever written by /api/security/* behind its RBAC checks; chaos
  // run reports are evidence for promotions, written only by their recorder.
  if (isReservedKind(kind)) {
    return Response.json({ error: 'reserved_kind', detail: `${kind} is managed by the console server and cannot be read or written through /api/store.` }, { status: 403 })
  }
  if (id !== undefined && !ID_RE.test(id)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 })
  }
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const method = req.method.toUpperCase()
  const tenant = auth.activeTenant
  const guard = GUARDED_KIND_WRITES[kind]?.[method as 'POST' | 'PUT' | 'DELETE']
  if (guard) {
    const denied = await requirePermission(req, guard)
    if (denied) return withCookie(denied, auth.refreshedCookie)
  }

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
