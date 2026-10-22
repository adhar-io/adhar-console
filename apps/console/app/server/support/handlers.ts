import type { AccessCheck } from '@adhar/auth/server'
import { getRequestUser, unauthorized } from '../request-user.ts'
import { requirePermission } from '../k8s/access.ts'
import { NOTIFICATION_KIND, type NotificationDoc } from '../notify.ts'
import { openStore } from '../workspace/store.ts'
import { XR_GROUP, XR_KINDS } from '../events/control-plane-sources.ts'
import { type IncidentRef, parseRef } from './classify.ts'
import { createTicketFor, supportStatus } from './service.ts'

/**
 * `/api/support/*`
 *
 *   POST /api/support/tickets  {notificationId}  → open (or return) the ticket for a notification
 *   GET  /api/support/status                      → is Plane wired, queue health, last error
 *
 * The manual path collects evidence with the console's ServiceAccount, so it
 * is gated on the CALLER being able to read the thing the ticket is about —
 * otherwise "Create support ticket" would be a way to read logs of a namespace
 * you were never granted, by way of a project tracker.
 */

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

/** The RBAC check that stands for "may see what this ticket would contain". Exported for tests. */
export function accessCheckFor(ref: IncidentRef | null): AccessCheck {
  const ns = ref?.namespace ?? 'adhar-system'
  switch (ref?.source) {
    case 'argocd':
    case 'argocd-sync':
      return { verb: 'get', group: 'argoproj.io', resource: 'applications', namespace: ns, name: ref.name }
    case 'rollout':
      return { verb: 'get', group: 'argoproj.io', resource: 'rollouts', namespace: ns }
    case 'tekton':
      return { verb: 'get', group: 'tekton.dev', resource: 'pipelineruns', namespace: ns }
    case 'kargo-promotion':
      return { verb: 'get', group: 'kargo.akuity.io', resource: 'promotions', namespace: ns }
    case 'kargo-verification':
      return { verb: 'get', group: 'kargo.akuity.io', resource: 'stages', namespace: ns }
    case 'xr': {
      const plural = XR_KINDS.find((k) => k.kind === ref.objectKind)?.plural ?? 'applications'
      return { verb: 'get', group: XR_GROUP, resource: plural, namespace: ns }
    }
    default:
      // Pod logs are the most sensitive thing a ticket carries.
      return { verb: 'get', group: '', resource: 'pods', subresource: 'log', namespace: ns }
  }
}

export async function handleSupportApi(req: Request, sub: string): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const method = req.method.toUpperCase()
  const path = sub.replace(/^\/+|\/+$/g, '')

  if (path === 'status' && method === 'GET') {
    return withCookie(Response.json(supportStatus()), auth.refreshedCookie)
  }
  if (path !== 'tickets') return Response.json({ error: 'not_found' }, { status: 404 })
  if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let body: { notificationId?: unknown }
  try {
    body = (await req.json()) as { notificationId?: unknown }
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const notificationId = typeof body.notificationId === 'string' ? body.notificationId : ''
  if (!notificationId) return Response.json({ error: 'missing_notification_id' }, { status: 400 })

  const store = await openStore(auth.activeTenant)
  if (!store) return Response.json({ error: 'store_unavailable' }, { status: 503 })
  const n = await store.get<NotificationDoc>(NOTIFICATION_KIND, notificationId)
  // A notification addressed to someone else does not exist for this caller.
  if (!n || (n.data.audience?.length && !n.data.audience.includes(auth.user.id))) {
    return withCookie(Response.json({ error: 'not_found' }, { status: 404 }), auth.refreshedCookie)
  }
  if (n.data.source === 'workspace' || n.data.source === 'user') {
    return withCookie(Response.json({ error: 'not_a_platform_signal', detail: 'Support tickets carry platform evidence; this notification has none.' }, { status: 400 }), auth.refreshedCookie)
  }
  const denied = await requirePermission(req, accessCheckFor(parseRef(n.data)))
  if (denied) return withCookie(denied, auth.refreshedCookie)

  try {
    const result = await createTicketFor(auth.activeTenant, notificationId, n.data)
    if (result.outcome === 'noop') {
      return withCookie(Response.json({ ok: false, error: 'not_created', detail: result.reason }, { status: 409 }), auth.refreshedCookie)
    }
    const ticket = 'ticket' in result ? result.ticket : result.tickets[0]
    return withCookie(Response.json({ ok: true, outcome: result.outcome, ticket }), auth.refreshedCookie)
  } catch (e) {
    return withCookie(Response.json({ ok: false, error: 'plane_error', detail: e instanceof Error ? e.message : String(e) }, { status: 502 }), auth.refreshedCookie)
  }
}
