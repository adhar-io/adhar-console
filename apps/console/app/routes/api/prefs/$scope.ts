import { createFileRoute } from '@tanstack/react-router'
import { getRequestUser, unauthorized } from '~/server/request-user.ts'

// `@adhar-console/db` pulls in postgres.js (node:net/tls) — load it dynamically
// inside handlers so it never enters the browser bundle.
const db = () => import('@adhar-console/db')

/**
 * /api/prefs/<scope> — per-user preference documents (overview layout, catalog
 * filters, …). Session-authenticated; the user id comes from the cookie, never
 * the client. `scope` is a short slug namespacing one feature's prefs.
 *
 *   GET → { data: <json> | null }
 *   PUT { data: <json> } → { ok: true }
 *
 * When no DB is configured the GET returns `{ data: null }` (client falls back
 * to defaults) and the PUT reports `persisted: false` so the UI can degrade.
 */
const SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function badScope(): Response {
  return Response.json({ error: 'invalid_scope' }, { status: 400 })
}

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

export const Route = createFileRoute('/api/prefs/$scope')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!SCOPE_RE.test(params.scope)) return badScope()
        const auth = await getRequestUser(request)
        if (!auth) return unauthorized()
        const { getMigratedDb, getPreferences } = await db()
        const conn = await getMigratedDb()
        if (!conn) return withCookie(Response.json({ data: null }), auth.refreshedCookie)
        const data = await getPreferences(conn, auth.user.id, params.scope)
        return withCookie(Response.json({ data }), auth.refreshedCookie)
      },
      PUT: async ({ request, params }) => {
        if (!SCOPE_RE.test(params.scope)) return badScope()
        const auth = await getRequestUser(request)
        if (!auth) return unauthorized()
        let body: { data?: unknown }
        try {
          body = (await request.json()) as { data?: unknown }
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
        await setPreferences(conn, auth.user.id, params.scope, body.data as Record<string, unknown>)
        return withCookie(Response.json({ ok: true, persisted: true }), auth.refreshedCookie)
      },
    },
  },
})
