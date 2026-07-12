import { createFileRoute } from '@tanstack/react-router'
import { getRequestUser, unauthorized } from '~/server/request-user.ts'

// Dynamic import keeps postgres.js (node:net/tls) out of the browser bundle.
const db = () => import('@adhar-console/db')

/**
 * /api/notifications — per-user read/dismissed state for notifications.
 *
 *   GET → { state: [{ notificationId, read, dismissed }] }
 *   POST { id | ids, read?, dismissed? } → { ok: true }
 *
 * Content of notifications is server-seeded elsewhere; this endpoint only
 * records the user's interactions so they persist across reloads/tabs.
 */
function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

export const Route = createFileRoute('/api/notifications')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await getRequestUser(request)
        if (!auth) return unauthorized()
        const { getMigratedDb, getNotificationState } = await db()
        const conn = await getMigratedDb()
        if (!conn) return withCookie(Response.json({ state: [] }), auth.refreshedCookie)
        const state = await getNotificationState(conn, auth.user.id)
        return withCookie(Response.json({ state }), auth.refreshedCookie)
      },
      POST: async ({ request }) => {
        const auth = await getRequestUser(request)
        if (!auth) return unauthorized()
        let body: { id?: string; ids?: string[]; read?: boolean; dismissed?: boolean }
        try {
          body = await request.json()
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
      },
    },
  },
})
