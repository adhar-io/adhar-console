import {
  getServerAuthConfig,
  getValidSession,
  serializeCookie,
  signSessionToken,
} from '@adhar-console/auth/server'
import { getRequestUser, unauthorized } from './request-user.ts'
import { originOk } from './k8s/gateway.ts'

/**
 * Organization (workspace) management — `/api/organizations/*`.
 *
 * An "organization" is the tenant that scopes the console's own Postgres data
 * (workspace, billing, OKRs, saved views, …) via the session's `activeTenant`.
 * The list of orgs a user can access is kept per-user in the preferences table
 * (server-authoritative for that user), so switching / creating persists across
 * devices. Org ids are server-generated random slugs — unguessable, so a user
 * can only ever activate an org that is in their own registry.
 *
 * Switching an org re-signs the session cookie with the new `activeTenant`; the
 * client then reloads for a clean slate. Kubernetes RBAC is unaffected (that is
 * driven by the Keycloak token's groups, not `activeTenant`).
 *
 *   GET    /api/organizations               → { organizations, activeId }
 *   POST   /api/organizations               → create { name } → activate
 *   POST   /api/organizations/<id>/activate → switch active org
 *   PATCH  /api/organizations/<id>          → rename { name }
 *   DELETE /api/organizations/<id>          → delete (can't delete the last one)
 */

const db = () => import('@adhar-console/db')
const PREFS_SCOPE = 'organizations'

export interface Organization {
  id: string
  name: string
  slug: string
  createdAt: string
  createdBy?: string
}

interface Registry {
  orgs: Organization[]
  activeId: string
}

const NAME_MAX = 60
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org'
}

function randomSuffix(): string {
  const arr = new Uint8Array(5)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
}

/* ─────────── per-user registry (preferences table) ─────────── */

async function readRegistry(userId: string, fallbackActive: string): Promise<Registry | null> {
  const { getMigratedDb, getPreferences } = await db()
  const conn = await getMigratedDb()
  if (!conn) return null
  const raw = (await getPreferences(conn, userId, PREFS_SCOPE)) as Registry | null
  if (raw && Array.isArray(raw.orgs) && raw.orgs.length > 0) {
    return { orgs: raw.orgs, activeId: raw.activeId || raw.orgs[0].id }
  }
  // Seed a default org keyed to the session's current tenant so existing
  // console data stays associated with the user's first organization.
  const seedId = ID_RE.test(fallbackActive) ? fallbackActive : 'default'
  const seed: Registry = {
    orgs: [{ id: seedId, name: 'My Organization', slug: seedId, createdAt: new Date().toISOString() }],
    activeId: seedId,
  }
  return seed
}

async function writeRegistry(
  userId: string,
  user: { id: string; name: string; email: string },
  reg: Registry,
): Promise<boolean> {
  const { getMigratedDb, setPreferences, touchUser } = await db()
  const conn = await getMigratedDb()
  if (!conn) return false
  await touchUser(conn, user)
  await setPreferences(conn, userId, PREFS_SCOPE, reg as unknown as Record<string, unknown>)
  return true
}

/** Re-sign the session cookie with a new activeTenant. */
async function activeTenantCookie(req: Request, tenantId: string): Promise<string | null> {
  const cfg = getServerAuthConfig()
  if (!cfg) return null
  const result = await getValidSession(req, cfg)
  if (!result) return null
  const next = { ...result.session, activeTenant: tenantId }
  return serializeCookie(cfg.cookieName, await signSessionToken(next, cfg), {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'Lax',
    maxAge: cfg.sessionTtlSeconds,
  })
}

/* ─────────── handler ─────────── */

export async function handleOrganizations(req: Request, subpath: string): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const attach = (res: Response) => withCookie(res, auth.refreshedCookie)

  const method = req.method.toUpperCase()
  if (method !== 'GET' && !originOk(req)) return attach(json({ error: 'origin_not_allowed' }, 403))

  const reg = await readRegistry(auth.user.id, auth.activeTenant)
  if (!reg) return attach(json({ error: 'store_unavailable', detail: 'database not configured' }, 503))

  const seg = subpath.replace(/\/+$/, '').split('/').filter(Boolean)

  try {
    // GET /api/organizations
    if (seg.length === 0 && method === 'GET') {
      return attach(json({ organizations: reg.orgs, activeId: reg.activeId }))
    }
    // POST /api/organizations  → create + activate
    if (seg.length === 0 && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { name?: string }
      const name = (body.name ?? '').trim()
      if (!name) return attach(json({ error: 'name_required' }, 400))
      if (name.length > NAME_MAX) return attach(json({ error: 'name_too_long' }, 400))
      const id = `${slugify(name)}-${randomSuffix()}`.slice(0, 63)
      const org: Organization = {
        id,
        name,
        slug: slugify(name),
        createdAt: new Date().toISOString(),
        createdBy: auth.user.id,
      }
      const nextReg: Registry = { orgs: [...reg.orgs, org], activeId: id }
      await writeRegistry(auth.user.id, auth.user, nextReg)
      const cookie = await activeTenantCookie(req, id)
      return withCookie(json({ organization: org, activeId: id }, 201), cookie ?? auth.refreshedCookie)
    }
    // POST /api/organizations/<id>/activate
    if (seg.length === 2 && seg[1] === 'activate' && method === 'POST') {
      const id = seg[0]
      const target = reg.orgs.find((o) => o.id === id)
      if (!target) return attach(json({ error: 'not_a_member' }, 404))
      await writeRegistry(auth.user.id, auth.user, { ...reg, activeId: id })
      const cookie = await activeTenantCookie(req, id)
      if (!cookie) return attach(json({ error: 'session_reissue_failed' }, 500))
      return withCookie(json({ activeId: id }), cookie)
    }
    // PATCH /api/organizations/<id>  → rename
    if (seg.length === 1 && method === 'PATCH') {
      const id = seg[0]
      const idx = reg.orgs.findIndex((o) => o.id === id)
      if (idx === -1) return attach(json({ error: 'not_found' }, 404))
      const body = (await req.json().catch(() => ({}))) as { name?: string }
      const name = (body.name ?? '').trim()
      if (!name || name.length > NAME_MAX) return attach(json({ error: 'invalid_name' }, 400))
      const orgs = [...reg.orgs]
      orgs[idx] = { ...orgs[idx], name }
      await writeRegistry(auth.user.id, auth.user, { ...reg, orgs })
      return attach(json({ organization: orgs[idx] }))
    }
    // DELETE /api/organizations/<id>
    if (seg.length === 1 && method === 'DELETE') {
      const id = seg[0]
      if (reg.orgs.length <= 1) return attach(json({ error: 'cannot_delete_last' }, 400))
      if (!reg.orgs.some((o) => o.id === id)) return attach(json({ error: 'not_found' }, 404))
      const orgs = reg.orgs.filter((o) => o.id !== id)
      const activeId = reg.activeId === id ? orgs[0].id : reg.activeId
      await writeRegistry(auth.user.id, auth.user, { orgs, activeId })
      // If we deleted the active org, re-scope the session to the new active one.
      const cookie = reg.activeId === id ? await activeTenantCookie(req, activeId) : undefined
      return withCookie(json({ activeId, switched: reg.activeId === id }), cookie ?? auth.refreshedCookie)
    }
    return attach(json({ error: 'not_found' }, 404))
  } catch (e) {
    console.error('[organizations] handler error:', e instanceof Error ? e.message : e)
    return attach(json({ error: 'internal_error' }, 500))
  }
}
