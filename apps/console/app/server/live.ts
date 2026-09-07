import { env } from '@adhar-console/utils'
import { apiServerFetch, originOk, resolveClusterBase, resolveIdentity, type K8sIdentity } from './k8s/gateway.ts'
import { getRequestUser } from './request-user.ts'
import { proxyToolRequest } from './proxy.ts'
import { openStore } from './workspace/store.ts'
import { NOTIFICATION_KIND, type NotificationDoc } from './notify.ts'

/**
 * `/api/live` — ONE multiplexed WebSocket per browser tab that replaces
 * client-side polling with server push.
 *
 * Topics (client `{op:'sub', id, topic, params}` → server events tagged `id`):
 *
 *   k8s            list + **watch** a resource with the caller's own token
 *                  (RBAC intact). Emits `resync` (full list) then `ADDED` /
 *                  `MODIFIED` / `DELETED` deltas; relists on 410 Gone; retries
 *                  with backoff. One apiserver watch per subscription instead
 *                  of one HTTP stream per list per tab.
 *   poll           server-side change detection for pull-only backends
 *                  (Prometheus, Tempo, Harbor, Gitea …): the BFF fetches the
 *                  proxied tool path on an interval, hashes the body and only
 *                  pushes `changed` (with the body) when it differs. `{start}`
 *                  / `{end}` placeholders in the path slide with `windowMs`,
 *                  so range queries stay "now"-relative. De-duplicated per
 *                  user+path across subscriptions.
 *   notifications  pushes `invalidate` when the tenant's newest notification
 *                  changes (DB checked every few seconds, server side).
 *
 * Auth: session cookie (same as every API), origin-checked; a subscription
 * never sees more than the user could fetch themselves. Heartbeat every 25 s;
 * everything is torn down when the socket closes.
 */

type Json = Record<string, unknown>

interface SubHandle {
  stop(): void
}

const HEARTBEAT_MS = 25_000
const POLL_MIN_MS = 3_000
const POLL_MAX_MS = 300_000
const NOTIF_CHECK_MS = 4_000
const MAX_SUBS = 200

export async function handleLive(req: Request): Promise<Response> {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 })
  }
  if (!originOk(req)) return new Response('Origin not allowed', { status: 403 })
  const id = await resolveIdentity(req)
  const auth = await getRequestUser(req)
  if (!id || !auth) return new Response('Unauthorized', { status: 401 })

  const { socket, response } = Deno.upgradeWebSocket(req)
  const cookie = req.headers.get('cookie') ?? ''
  const origin = new URL(req.url).origin
  const subs = new Map<string, SubHandle>()
  let closed = false

  const send = (msg: Json) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(msg))
    } catch {
      // socket went away between checks
    }
  }

  const heartbeat = setInterval(() => send({ op: 'ping', t: Date.now() }), HEARTBEAT_MS)

  socket.onmessage = (ev) => {
    let msg: Json
    try {
      msg = JSON.parse(String(ev.data)) as Json
    } catch {
      return
    }
    const op = msg.op
    if (op === 'ping') return send({ op: 'pong', t: msg.t })
    if (op === 'pong') return
    const sid = typeof msg.id === 'string' ? msg.id : ''
    if (op === 'unsub') {
      subs.get(sid)?.stop()
      subs.delete(sid)
      return
    }
    if (op !== 'sub' || !sid) return
    if (subs.size >= MAX_SUBS) return send({ op: 'error', id: sid, message: 'too many subscriptions' })
    subs.get(sid)?.stop()
    const params = (msg.params ?? {}) as Json
    try {
      switch (msg.topic) {
        case 'k8s':
          subs.set(sid, watchK8s(sid, id, params, send))
          break
        case 'poll':
          subs.set(sid, pollTool(sid, { cookie, origin }, params, send))
          break
        case 'notifications':
          subs.set(sid, watchNotifications(sid, auth.activeTenant, auth.user.id, send))
          break
        default:
          send({ op: 'error', id: sid, message: `unknown topic ${String(msg.topic)}` })
      }
    } catch (e) {
      send({ op: 'error', id: sid, message: e instanceof Error ? e.message : String(e) })
    }
  }

  const teardown = () => {
    closed = true
    clearInterval(heartbeat)
    for (const s of subs.values()) s.stop()
    subs.clear()
  }
  socket.onclose = teardown
  socket.onerror = teardown
  socket.onopen = () => send({ op: 'hello', user: id.user.id, t: Date.now() })

  if (id.refreshedCookie) response.headers.append('set-cookie', id.refreshedCookie)
  return response
}

/* ─────────── k8s: list + watch with the user's token ─────────── */

function watchK8s(sid: string, id: K8sIdentity, params: Json, send: (m: Json) => void): SubHandle {
  const group = String(params.group ?? '')
  const version = String(params.version ?? 'v1')
  const resource = String(params.resource ?? '')
  const namespace = params.namespace ? String(params.namespace) : ''
  const labelSelector = params.labelSelector ? String(params.labelSelector) : ''
  const fieldSelector = params.fieldSelector ? String(params.fieldSelector) : ''
  const cluster = params.cluster ? String(params.cluster) : undefined
  if (!resource) throw new Error('resource required')
  if (resolveClusterBase(cluster) === null) throw new Error(`unknown cluster ${cluster}`)

  const root = group ? `/apis/${group}/${version}` : `/api/${version}`
  const path = `${root}${namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''}/${resource}`
  const base = new URLSearchParams()
  if (labelSelector) base.set('labelSelector', labelSelector)
  if (fieldSelector) base.set('fieldSelector', fieldSelector)

  const ac = new AbortController()
  let stopped = false
  ;(async () => {
    let backoff = 1000
    while (!stopped) {
      try {
        // 1. list → resync snapshot
        const lq = new URLSearchParams(base)
        lq.set('limit', '2000')
        const list = await apiServerFetch(id, path, { search: `?${lq}`, signal: ac.signal, cluster })
        if (!list.ok) {
          const body = await list.text().catch(() => '')
          send({ op: 'error', id: sid, status: list.status, message: body.slice(0, 300) || `list failed (${list.status})` })
          if (list.status === 401 || list.status === 403 || list.status === 404) return
          throw new Error(`list ${list.status}`)
        }
        const body = (await list.json()) as { items?: unknown[]; metadata?: { resourceVersion?: string } }
        let rv = body.metadata?.resourceVersion ?? ''
        send({ op: 'resync', id: sid, items: body.items ?? [], resourceVersion: rv })
        backoff = 1000

        // 2. watch from that resourceVersion
        const wq = new URLSearchParams(base)
        wq.set('watch', '1')
        wq.set('allowWatchBookmarks', 'true')
        if (rv) wq.set('resourceVersion', rv)
        const res = await apiServerFetch(id, path, { search: `?${wq}`, signal: ac.signal, cluster })
        if (!res.ok || !res.body) {
          if (res.status === 410) continue // relist
          throw new Error(`watch ${res.status}`)
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done || stopped) break
          buf += value
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line) continue
            let ev: { type?: string; object?: { metadata?: { resourceVersion?: string }; code?: number } }
            try {
              ev = JSON.parse(line)
            } catch {
              continue
            }
            if (ev.type === 'ERROR') {
              if (ev.object?.code === 410) rv = ''
              throw new Error('watch stream error')
            }
            if (ev.object?.metadata?.resourceVersion) rv = ev.object.metadata.resourceVersion
            if (ev.type === 'BOOKMARK') continue
            send({ op: 'event', id: sid, type: ev.type, object: ev.object })
          }
        }
        // clean close (server timeout) → loop relists immediately
      } catch (e) {
        if (stopped || ac.signal.aborted) return
        send({ op: 'status', id: sid, state: 'reconnecting', message: e instanceof Error ? e.message : String(e) })
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 15_000)
      }
    }
  })()

  return {
    stop() {
      stopped = true
      ac.abort()
    },
  }
}

/* ─────────── poll: server-side change detection for pull-only tools ─────────── */

interface PollCtx {
  cookie: string
  origin: string
}

/** Shared upstream pollers, keyed per user cookie + tool + path + interval. */
const pollers = new Map<string, { subscribers: Set<(m: Json) => void>; stop(): void; last?: { hash: string; body: unknown } }>()

function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

function pollTool(sid: string, ctx: PollCtx, params: Json, send: (m: Json) => void): SubHandle {
  const tool = String(params.tool ?? '')
  const rawPath = String(params.path ?? '')
  const intervalMs = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Number(params.intervalMs ?? 15_000) || 15_000))
  const windowMs = Number(params.windowMs ?? 0) || 0
  if (!tool || !rawPath) throw new Error('tool and path required')
  if (!/^[a-z0-9-]+$/.test(tool)) throw new Error('bad tool')

  const key = `${fnv(ctx.cookie)}|${tool}|${rawPath}|${intervalMs}|${windowMs}`
  const deliver = (m: Json) => send({ ...m, id: sid })
  let entry = pollers.get(key)
  if (!entry) {
    const subscribers = new Set<(m: Json) => void>()
    let inflight = false
    const e = { subscribers, last: undefined as { hash: string; body: unknown } | undefined, stop() {} }
    const tick = async () => {
      if (inflight) return
      inflight = true
      try {
        const now = Date.now()
        const path = rawPath
          .replace(/\{start\}/g, encodeURIComponent(new Date(now - windowMs).toISOString()))
          .replace(/\{end\}/g, encodeURIComponent(new Date(now).toISOString()))
        const splat = path.replace(/^\//, '')
        const req = new Request(`${ctx.origin}/api/svc/${tool}/${splat}`, {
          headers: { cookie: ctx.cookie, accept: 'application/json', origin: ctx.origin },
        })
        const res = await proxyToolRequest(req, tool, splat.split('?')[0])
        const text = await res.text()
        if (!res.ok) {
          for (const s of subscribers) s({ op: 'error', status: res.status, message: text.slice(0, 300) })
          return
        }
        const hash = fnv(text)
        if (e.last?.hash === hash) return
        let body: unknown = text
        try {
          body = JSON.parse(text)
        } catch {
          // non-JSON tool response — ship as text
        }
        e.last = { hash, body }
        for (const s of subscribers) s({ op: 'changed', body, hash, at: now })
      } catch (err) {
        for (const s of subscribers) s({ op: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        inflight = false
      }
    }
    const timer = setInterval(() => void tick(), intervalMs)
    e.stop = () => {
      clearInterval(timer)
      pollers.delete(key)
    }
    void tick()
    entry = e
    pollers.set(key, e)
  } else if (entry.last) {
    // Late joiner gets the current snapshot immediately.
    deliver({ op: 'changed', body: entry.last.body, hash: entry.last.hash, at: Date.now() })
  }
  entry.subscribers.add(deliver)
  const e = entry
  return {
    stop() {
      e.subscribers.delete(deliver)
      if (e.subscribers.size === 0) e.stop()
    },
  }
}

/* ─────────── notifications: DB change detection ─────────── */

function watchNotifications(sid: string, tenant: string, userId: string, send: (m: Json) => void): SubHandle {
  let stopped = false
  let lastAt = ''
  let lastCount = -1
  const tick = async () => {
    if (stopped) return
    try {
      const store = await openStore(tenant)
      if (!store) return
      const page = await store.query<NotificationDoc>(NOTIFICATION_KIND, { sort: { path: 'at', direction: 'desc' }, limit: 1, offset: 0 })
      const at = page.items[0]?.data.at ?? ''
      if (lastCount === -1) {
        lastAt = at
        lastCount = page.total
        return
      }
      if (at !== lastAt || page.total !== lastCount) {
        lastAt = at
        lastCount = page.total
        send({ op: 'invalidate', id: sid, reason: 'notifications-changed', at })
      }
    } catch {
      // DB hiccup — try next tick
    }
  }
  const timer = setInterval(() => void tick(), NOTIF_CHECK_MS)
  void tick()
  void userId
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** Exposed for diagnostics (`/api/live` is WS-only; this reports hub load). */
export function liveStats(): { pollers: number } {
  return { pollers: pollers.size }
}

// Keep `env` referenced for future tunables without unused-import churn.
void env
