import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { openStore } from './workspace/store.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'
import { emitNotification, NOTIFICATION_KIND, type NotificationDoc } from './notify.ts'

/**
 * Notification Center API (`/api/notifications*`).
 *
 *   GET  /api/notifications?limit&offset&kind&source&unread=1&q
 *        → { items, total, unread }  (tenant feed ⋈ the caller's read/dismissed state)
 *   POST /api/notifications   { id | ids, read?, dismissed? }   → state patch
 *   POST /api/notifications   { title, ... }                    → create (audience = caller)
 *   POST /api/notifications/scan                                → run the insights scan
 *
 * The insights scan reads the cluster WITH THE CALLER'S TOKEN (RBAC-scoped)
 * and turns what it finds into `insight` notifications addressed to that
 * user: Warning-event bursts, Argo CD apps out of sync / degraded, Kyverno
 * policy failures and certificates about to expire. Keys de-dupe re-scans.
 */

const db = () => import('@adhar-console/db')

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

export async function handleNotificationsApi(req: Request, subpath: string): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const method = req.method.toUpperCase()
  const sub = subpath.replace(/^\/+|\/+$/g, '')

  if (sub === 'scan' && method === 'POST') return withCookie(await scan(req, auth), auth.refreshedCookie)
  if (sub) return Response.json({ error: 'not_found' }, { status: 404 })

  if (method === 'GET') return withCookie(await list(req, auth), auth.refreshedCookie)

  if (method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }
    if (typeof body.title === 'string') return withCookie(await create(auth, body), auth.refreshedCookie)
    return withCookie(await patchState(auth, body), auth.refreshedCookie)
  }
  return new Response('Method Not Allowed', { status: 405 })
}

type Auth = NonNullable<Awaited<ReturnType<typeof getRequestUser>>>

async function list(req: Request, auth: Auth): Promise<Response> {
  const url = new URL(req.url)
  const p = url.searchParams
  const limit = Math.min(Math.max(Number(p.get('limit') ?? 50) || 50, 1), 200)
  const offset = Math.max(Number(p.get('offset') ?? 0) || 0, 0)
  const kind = (p.get('kind') ?? '').trim()
  const source = (p.get('source') ?? '').trim()
  const q = (p.get('q') ?? '').trim()
  const unreadOnly = p.get('unread') === '1'

  const store = await openStore(auth.activeTenant)
  if (!store) return Response.json({ items: [], total: 0, unread: 0, persisted: false })
  const { getNotificationState } = await db()
  const stateRows = await getNotificationState(store.conn, auth.user.id)
  const state = new Map(stateRows.map((r) => [r.notificationId, r]))

  // Pull a generous window newest-first, then apply per-user state (dismissed
  // filtering can't happen in SQL since state is per user).
  const window = await store.query<NotificationDoc>(NOTIFICATION_KIND, {
    equals: [...(kind ? [{ path: 'kind', value: kind }] : []), ...(source ? [{ path: 'source', value: source }] : [])],
    search: q ? { text: q, paths: ['title', 'description', 'target.label', 'actor.label'] } : undefined,
    sort: { path: 'at', direction: 'desc' },
    limit: Math.min(1000, offset + limit * 4 + 200),
    offset: 0,
  })
  const mine = window.items.filter((d) => !d.data.audience?.length || d.data.audience.includes(auth.user.id))
  const visible = mine
    .map((d) => ({ id: d.id, ...d.data, read: state.get(d.id)?.read ?? false, dismissed: state.get(d.id)?.dismissed ?? false }))
    .filter((n) => !n.dismissed)
  const filtered = unreadOnly ? visible.filter((n) => !n.read) : visible
  const unread = visible.filter((n) => !n.read).length
  return Response.json({
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    unread,
    persisted: true,
  })
}

async function create(auth: Auth, body: Record<string, unknown>): Promise<Response> {
  const store = await openStore(auth.activeTenant)
  if (!store) return Response.json({ ok: false, persisted: false }, { status: 503 })
  const kind = String(body.kind ?? 'info')
  const source = String(body.source ?? 'user')
  const doc: NotificationDoc = {
    kind: (['info', 'success', 'warning', 'error', 'insight'].includes(kind) ? kind : 'info') as NotificationDoc['kind'],
    source: (['workspace', 'platform', 'gitops', 'policy', 'security', 'ai', 'system', 'user'].includes(source) ? source : 'user') as NotificationDoc['source'],
    title: String(body.title).slice(0, 200),
    description: typeof body.description === 'string' ? body.description.slice(0, 2000) : undefined,
    href: typeof body.href === 'string' ? body.href.slice(0, 500) : undefined,
    key: typeof body.key === 'string' ? body.key.slice(0, 200) : undefined,
    severity: typeof body.severity === 'string' ? (body.severity as NotificationDoc['severity']) : undefined,
    prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 2000) : undefined,
    target: body.target && typeof body.target === 'object' ? (body.target as NotificationDoc['target']) : undefined,
    actor: { id: auth.user.id, label: auth.user.name },
    // Client-created notifications are private to their creator unless the
    // caller explicitly broadcasts (only meaningful for admins; kept simple).
    audience: body.broadcast === true ? undefined : [auth.user.id],
    at: new Date().toISOString(),
  }
  const id = await emitNotification(store, doc, auth.user.id)
  return Response.json({ ok: !!id, id, persisted: true })
}

async function patchState(auth: Auth, body: Record<string, unknown>): Promise<Response> {
  const patch = {
    ...(typeof body.read === 'boolean' ? { read: body.read } : {}),
    ...(typeof body.dismissed === 'boolean' ? { dismissed: body.dismissed } : {}),
  }
  if (patch.read === undefined && patch.dismissed === undefined) return Response.json({ error: 'nothing_to_update' }, { status: 400 })
  const ids = (Array.isArray(body.ids) ? (body.ids as string[]) : typeof body.id === 'string' ? [body.id] : []).filter((x) => typeof x === 'string')
  if (ids.length === 0) return Response.json({ error: 'missing_id' }, { status: 400 })
  const { getMigratedDb, setNotificationState, setNotificationStateBulk, touchUser } = await db()
  const conn = await getMigratedDb()
  if (!conn) return Response.json({ ok: true, persisted: false })
  await touchUser(conn, auth.user)
  if (ids.length === 1) await setNotificationState(conn, auth.user.id, ids[0], patch)
  else await setNotificationStateBulk(conn, auth.user.id, ids, patch)
  return Response.json({ ok: true, persisted: true })
}

/* ─────────── insights scan ─────────── */

const SCAN_COOLDOWN_MS = 60_000
const lastScan = new Map<string, number>()

interface KEvent {
  type?: string
  reason?: string
  message?: string
  count?: number
  lastTimestamp?: string
  involvedObject?: { kind?: string; name?: string; namespace?: string }
}

async function scan(req: Request, auth: Auth): Promise<Response> {
  const now = Date.now()
  const last = lastScan.get(auth.user.id) ?? 0
  const url = new URL(req.url)
  if (now - last < SCAN_COOLDOWN_MS && url.searchParams.get('force') !== '1') {
    return Response.json({ ok: true, skipped: true, nextInMs: SCAN_COOLDOWN_MS - (now - last) })
  }
  lastScan.set(auth.user.id, now)
  const id = await resolveIdentity(req)
  const store = await openStore(auth.activeTenant)
  if (!id || !store) return Response.json({ ok: false, persisted: false }, { status: 503 })

  const token = id
  const created: string[] = []
  interface Insight {
    kind: NotificationDoc['kind']
    title: string
    description?: string
    href?: string
    key?: string
    severity?: NotificationDoc['severity']
    target?: NotificationDoc['target']
    prompt?: string
    source?: NotificationDoc['source']
  }
  const emit = async (doc: Insight) => {
    const full: NotificationDoc = { ...doc, source: doc.source ?? 'platform', audience: [auth.user.id], at: new Date().toISOString() }
    const nid = await emitNotification(store, full, auth.user.id)
    if (nid) created.push(nid)
  }
  const results: Record<string, unknown> = {}

  // 1. Warning-event bursts (last hour), grouped by namespace + reason.
  try {
    const res = await apiServerFetch(token, '/api/v1/events', { search: '?fieldSelector=type%3DWarning&limit=500' })
    if (res.ok) {
      const items = ((await res.json()).items ?? []) as KEvent[]
      const cutoff = now - 60 * 60_000
      const groups = new Map<string, { ns: string; reason: string; n: number; sample: KEvent }>()
      for (const e of items) {
        const t = e.lastTimestamp ? new Date(e.lastTimestamp).getTime() : 0
        if (t < cutoff) continue
        const ns = e.involvedObject?.namespace ?? 'cluster'
        const reason = e.reason ?? 'Warning'
        const k = `${ns}/${reason}`
        const g = groups.get(k) ?? { ns, reason, n: 0, sample: e }
        g.n += e.count ?? 1
        groups.set(k, g)
      }
      const top = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 5)
      results.warningGroups = top.length
      for (const g of top) {
        if (g.n < 3) continue
        const sev = /OOM|Failed|BackOff|Unhealthy|Evict/i.test(g.reason) ? 'high' : 'medium'
        await emit({
          kind: 'insight',
          key: `insight:events:${g.ns}:${g.reason}`,
          severity: sev,
          title: `${g.n}× ${g.reason} in ${g.ns} (last hour)`,
          description: `${g.sample.involvedObject?.kind ?? 'object'}/${g.sample.involvedObject?.name ?? ''}: ${(g.sample.message ?? '').slice(0, 180)}`,
          href: `/platform?section=events`,
          target: { type: 'namespace', id: g.ns, label: g.ns },
          prompt: `Namespace "${g.ns}" has ${g.n} Warning events with reason ${g.reason} in the last hour. Scan its events, diagnose the affected workloads and explain the root cause.`,
        })
      }
    }
  } catch (e) {
    results.events = `error: ${e instanceof Error ? e.message : e}`
  }

  // 2. Argo CD apps out of sync / degraded.
  try {
    const ns = env('ARGOCD_NAMESPACE') || 'argocd'
    const res = await apiServerFetch(token, `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(ns)}/applications`, { search: '?limit=500' })
    if (res.ok) {
      const apps = ((await res.json()).items ?? []) as Array<{ metadata?: { name?: string }; status?: { sync?: { status?: string }; health?: { status?: string } } }>
      const bad = apps.filter((a) => (a.status?.sync?.status && a.status.sync.status !== 'Synced') || (a.status?.health?.status && !['Healthy', 'Progressing'].includes(a.status.health.status)))
      results.argoApps = bad.length
      for (const a of bad.slice(0, 8)) {
        const name = a.metadata?.name ?? 'app'
        const sync = a.status?.sync?.status ?? 'Unknown'
        const health = a.status?.health?.status ?? 'Unknown'
        await emit({
          kind: health === 'Degraded' ? 'error' : 'insight',
          source: 'gitops',
          key: `insight:argocd:${name}:${sync}:${health}`,
          severity: health === 'Degraded' ? 'high' : 'medium',
          title: `Argo CD app ${name} is ${health !== 'Healthy' ? health : sync}`,
          description: `sync ${sync} · health ${health}`,
          href: `/deliver?section=apps`,
          target: { type: 'application', id: name, label: name },
          prompt: `Argo CD application "${name}" reports sync=${sync} health=${health}. Check its status and explain what is blocking it.`,
        })
      }
    }
  } catch (e) {
    results.argo = `error: ${e instanceof Error ? e.message : e}`
  }

  // 3. Kyverno policy failures (cluster reports).
  try {
    const res = await apiServerFetch(token, '/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports', { search: '?limit=200' })
    if (res.ok) {
      const reports = ((await res.json()).items ?? []) as Array<{ summary?: { fail?: number }; results?: Array<{ policy: string; result: string; severity?: string }> }>
      const byPolicy = new Map<string, { n: number; sev: string }>()
      for (const r of reports) for (const x of r.results ?? []) {
        if (x.result !== 'fail') continue
        const g = byPolicy.get(x.policy) ?? { n: 0, sev: x.severity ?? 'medium' }
        g.n++
        byPolicy.set(x.policy, g)
      }
      const top = [...byPolicy.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5)
      results.policyFailures = top.length
      for (const [policy, g] of top) {
        await emit({
          kind: 'insight',
          source: 'policy',
          key: `insight:policy:${policy}`,
          severity: (['critical', 'high'].includes(g.sev) ? 'high' : 'medium') as NotificationDoc['severity'],
          title: `${g.n} resource${g.n === 1 ? '' : 's'} violate policy ${policy}`,
          description: `severity ${g.sev} · from cluster PolicyReports`,
          href: `/platform?section=policy`,
          target: { type: 'policy', id: policy, label: policy },
          prompt: `Kyverno policy "${policy}" has ${g.n} failing resources. Summarise which resources fail, why, and how to fix them.`,
        })
      }
    }
  } catch (e) {
    results.policy = `error: ${e instanceof Error ? e.message : e}`
  }

  // 4. Certificates expiring within 14 days (cert-manager).
  try {
    const res = await apiServerFetch(token, '/apis/cert-manager.io/v1/certificates', { search: '?limit=500' })
    if (res.ok) {
      const certs = ((await res.json()).items ?? []) as Array<{ metadata?: { name?: string; namespace?: string }; status?: { notAfter?: string; conditions?: Array<{ type: string; status: string; message?: string }> } }>
      const soon = certs.filter((c) => c.status?.notAfter && new Date(c.status.notAfter).getTime() - now < 14 * 24 * 60 * 60_000)
      const notReady = certs.filter((c) => c.status?.conditions?.some((x) => x.type === 'Ready' && x.status === 'False'))
      results.certs = { expiring: soon.length, notReady: notReady.length }
      for (const c of [...soon, ...notReady].slice(0, 6)) {
        const name = `${c.metadata?.namespace}/${c.metadata?.name}`
        const days = c.status?.notAfter ? Math.max(0, Math.round((new Date(c.status.notAfter).getTime() - now) / 86_400_000)) : null
        const failing = notReady.includes(c)
        await emit({
          kind: failing ? 'error' : 'warning',
          source: 'security',
          key: `insight:cert:${name}:${failing ? 'notready' : 'expiring'}`,
          severity: failing || (days !== null && days < 3) ? 'high' : 'medium',
          title: failing ? `Certificate ${name} is not Ready` : `Certificate ${name} expires in ${days} day${days === 1 ? '' : 's'}`,
          description: failing ? c.status?.conditions?.find((x) => x.type === 'Ready')?.message?.slice(0, 200) : `notAfter ${c.status?.notAfter}`,
          href: `/platform?section=config`,
          target: { type: 'certificate', id: name, label: name },
          prompt: `cert-manager Certificate "${name}" ${failing ? 'is not Ready' : `expires on ${c.status?.notAfter}`}. Explain why and how to renew it.`,
        })
      }
    }
  } catch (e) {
    results.certs = `error: ${e instanceof Error ? e.message : e}`
  }

  return Response.json({ ok: true, created: created.length, results })
}
