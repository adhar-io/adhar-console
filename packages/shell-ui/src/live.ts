import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'

/**
 * Live client — the browser side of `/api/live`, one multiplexed WebSocket
 * per tab shared by every module (shell-ui is a Module-Federation singleton).
 *
 *   liveClient.subscribe(topic, params, handler)   → unsubscribe()
 *   useLiveStatus()                                 → 'connecting' | 'live' | 'reconnecting' | 'offline'
 *   useLiveK8sList(gvr, opts)                       → list kept current by watch deltas
 *   useLiveInvalidate(topic, params, queryKeys)     → invalidate React-Query keys on push
 *   useLivePoll(tool, path, ms, queryKey, map?)     → server-side change detection feeding a query
 *   usePollingInterval(ms)                          → `ms` while offline, `false` while live
 *
 * Reconnects with backoff, re-subscribes everything, and answers the server
 * heartbeat. When the socket is down, hooks fall back to their old polling
 * interval so nothing goes stale.
 */

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'
export type LiveTopic = 'k8s' | 'poll' | 'notifications'

type Handler = (msg: Record<string, unknown>) => void

interface Sub {
  id: string
  topic: LiveTopic
  params: Record<string, unknown>
  handler: Handler
}

const BACKOFF_MIN = 1000
const BACKOFF_MAX = 30_000
/**
 * Treat the socket as dead after this long with no traffic. The server
 * heartbeats every 25s, so 70s is comfortably past two missed beats — long
 * enough not to fire on a slow network, short enough that a user does not sit
 * in front of a frozen page.
 */
const DEAD_AFTER_MS = 70_000

class LiveClient {
  private ws: WebSocket | null = null
  private subs = new Map<string, Sub>()
  private seq = 0
  private backoff = BACKOFF_MIN
  private timer: number | undefined
  private listeners = new Set<() => void>()
  private _status: LiveStatus = 'offline'
  private wantOpen = false
  private pingTimer: number | undefined
  /** Timestamp of the last frame received, for the half-open watchdog. */
  private lastMsgAt = 0

  get status(): LiveStatus {
    return this._status
  }
  get connected(): boolean {
    return this._status === 'live'
  }

  subscribeStatus(l: () => void) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private setStatus(s: LiveStatus) {
    if (this._status === s) return
    this._status = s
    this.listeners.forEach((l) => l())
  }

  subscribe(topic: LiveTopic, params: Record<string, unknown>, handler: Handler): () => void {
    const id = `s${++this.seq}`
    const sub: Sub = { id, topic, params, handler }
    this.subs.set(id, sub)
    this.ensureOpen()
    this.sendSub(sub)
    return () => {
      this.subs.delete(id)
      this.send({ op: 'unsub', id })
      if (this.subs.size === 0) this.scheduleIdleClose()
    }
  }

  private idleTimer: number | undefined
  private scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.subs.size === 0) this.close()
    }, 60_000) as unknown as number
  }

  private ensureOpen() {
    if (typeof WebSocket === 'undefined') return
    this.wantOpen = true
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.open()
  }

  private open() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.setStatus(this._status === 'offline' ? 'connecting' : 'reconnecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/live`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.backoff = BACKOFF_MIN
      this.lastMsgAt = Date.now()
      this.setStatus('live')
      for (const s of this.subs.values()) this.sendSub(s)
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => {
        // Watchdog. The server heartbeats every 25s, so silence well past that
        // means the connection is gone even though the browser still reports it
        // as OPEN — the half-open case a TCP-level failure leaves behind, where
        // no `close` event ever fires and nothing would otherwise reconnect.
        if (Date.now() - this.lastMsgAt > DEAD_AFTER_MS) {
          try {
            ws.close()
          } catch {
            // already gone — onclose will schedule the reconnect
          }
          return
        }
        this.send({ op: 'ping', t: Date.now() })
      }, 20_000) as unknown as number
    }
    ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now()
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.op === 'ping') return this.send({ op: 'pong', t: msg.t })
      if (msg.op === 'pong' || msg.op === 'hello') return
      const sub = typeof msg.id === 'string' ? this.subs.get(msg.id) : undefined
      if (sub) sub.handler(msg)
    }
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.ws = null
      if (this.wantOpen && this.subs.size) this.scheduleReconnect()
      else this.setStatus('offline')
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  }

  private scheduleReconnect() {
    this.setStatus('reconnecting')
    if (this.timer) clearTimeout(this.timer)
    // Full jitter. Without it every tab that was connected when the server
    // restarted wakes on the same schedule and reconnects in lockstep, which
    // is precisely the load the restarting server cannot absorb. Spreading the
    // retries across the window turns a thundering herd into a trickle.
    const delay = BACKOFF_MIN + Math.random() * (this.backoff - BACKOFF_MIN)
    this.timer = setTimeout(() => this.open(), delay) as unknown as number
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX)
  }

  /**
   * Reconnect now, abandoning any backoff wait.
   *
   * Backoff is right for a server that is down, and wrong for a laptop that
   * just woke up: the socket died while suspended, the backoff has grown to
   * half a minute, and the user is looking at a stale page for no reason. The
   * triggers below all mean "the environment just changed, try again".
   */
  reconnectNow() {
    if (!this.subs.size) return
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.timer) clearTimeout(this.timer)
    this.backoff = BACKOFF_MIN
    this.open()
  }

  private close() {
    this.wantOpen = false
    this.ws?.close()
    this.ws = null
    this.setStatus('offline')
  }

  private sendSub(sub: Sub) {
    this.send({ op: 'sub', id: sub.id, topic: sub.topic, params: sub.params })
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
}

export const liveClient = new LiveClient()

// Recover immediately when the environment says something changed: the tab
// coming back to the foreground (laptop woken, tab re-selected) or the network
// coming back. Each of these leaves a socket that is already dead but whose
// backoff timer may be tens of seconds away, which the user experiences as a
// page that has simply stopped updating.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') liveClient.reconnectNow()
  })
}
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('online', () => liveClient.reconnectNow())
  // A socket can stay half-open after a network change: the browser never sees
  // a close, so nothing triggers a reconnect. `focus` is a cheap extra nudge.
  globalThis.addEventListener('focus', () => liveClient.reconnectNow())
}

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (l) => liveClient.subscribeStatus(l),
    () => liveClient.status,
    () => 'offline' as LiveStatus,
  )
}

/** `ms` while the live socket is down, `false` (no polling) while it is live. */
export function usePollingInterval(ms: number): number | false {
  const status = useLiveStatus()
  return status === 'live' ? false : ms
}

/* ─────────── k8s live list ─────────── */

export interface LiveK8sOpts {
  namespace?: string
  labelSelector?: string
  fieldSelector?: string
  cluster?: string
  enabled?: boolean
}

export interface LiveListState<T> {
  data: T[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  status: 'connecting' | 'live' | 'reconnecting' | 'error'
  refetch(): void
}

interface KubeLike {
  metadata?: { uid?: string; namespace?: string; name?: string }
}

function keyOf(o: KubeLike): string {
  return o.metadata?.uid ?? `${o.metadata?.namespace ?? ''}/${o.metadata?.name ?? ''}`
}

/**
 * A Kubernetes list kept current by apiserver watch deltas over the live
 * socket. Same shape as a TanStack query so views need no changes.
 */
export function useLiveK8sList<T extends KubeLike>(
  gvr: { group: string; version: string; resource: string },
  opts: LiveK8sOpts = {},
): LiveListState<T> {
  const { namespace, labelSelector, fieldSelector, cluster, enabled = true } = opts
  const [map, setMap] = useState<Map<string, T>>(() => new Map())
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [status, setStatus] = useState<LiveListState<T>['status']>('connecting')
  const [nonce, setNonce] = useState(0)
  const depKey = `${gvr.group}/${gvr.version}/${gvr.resource}|${namespace ?? ''}|${labelSelector ?? ''}|${fieldSelector ?? ''}|${cluster ?? ''}|${enabled}|${nonce}`

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    setStatus('connecting')
    setMap(new Map())
    const unsub = liveClient.subscribe(
      'k8s',
      { group: gvr.group, version: gvr.version, resource: gvr.resource, namespace, labelSelector, fieldSelector, cluster },
      (msg) => {
        if (msg.op === 'resync') {
          const next = new Map<string, T>()
          for (const it of (msg.items as T[]) ?? []) next.set(keyOf(it), it)
          setMap(next)
          setLoading(false)
          setError(null)
          setStatus('live')
        } else if (msg.op === 'event') {
          const obj = msg.object as T
          setMap((prev) => {
            const n = new Map(prev)
            const k = keyOf(obj)
            if (msg.type === 'DELETED') n.delete(k)
            else n.set(k, obj)
            return n
          })
        } else if (msg.op === 'status') {
          setStatus('reconnecting')
        } else if (msg.op === 'error') {
          const err = Object.assign(new Error(String(msg.message ?? 'live error')), { status: msg.status })
          setError(err)
          setStatus('error')
          setLoading(false)
        }
      },
    )
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey])

  const data = useMemo(() => Array.from(map.values()), [map])
  return { data, isLoading, isError: error !== null, error, status, refetch: () => setNonce((n) => n + 1) }
}

/* ─────────── invalidate-on-push ─────────── */

/**
 * Invalidate React-Query keys whenever the topic pushes. Debounced so a burst
 * of watch events becomes one refetch.
 */
export function useLiveInvalidate(
  topic: LiveTopic,
  params: Record<string, unknown>,
  queryKeys: QueryKey[],
  enabled = true,
) {
  const qc = useQueryClient()
  const keysRef = useRef(queryKeys)
  keysRef.current = queryKeys
  const paramsKey = JSON.stringify(params)
  useEffect(() => {
    if (!enabled) return
    let timer: number | undefined
    const bump = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        for (const k of keysRef.current) void qc.invalidateQueries({ queryKey: k })
      }, 250) as unknown as number
    }
    const unsub = liveClient.subscribe(topic, JSON.parse(paramsKey), (msg) => {
      if (msg.op === 'event' || msg.op === 'resync' || msg.op === 'changed' || msg.op === 'invalidate') bump()
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [topic, paramsKey, enabled, qc])
}

/** The apiserver resource a query is derived from. */
export interface LiveWatchRef {
  group: string
  version: string
  resource: string
  namespace?: string
  labelSelector?: string
  fieldSelector?: string
  cluster?: string
}

/**
 * Make an existing `useQuery` live.
 *
 * This is the one-line conversion from "poll on a timer" to "push, and poll
 * only as a safety net". It subscribes to the apiserver watch for `watch`,
 * invalidates `queryKeys` when anything changes, and returns the
 * `refetchInterval` to hand back to TanStack Query — `false` while the socket
 * is live, `fallbackMs` when it is not.
 *
 * ```ts
 * const key = ['platform', 'pods', ns]
 * return useQuery({
 *   queryKey: key,
 *   queryFn: () => client.listPods(undefined, ns),
 *   refetchInterval: useLiveRefetch(PODS_GVR, [key], 10_000),
 * })
 * ```
 *
 * The timer fallback is deliberate rather than vestigial: a socket can be
 * blocked by a corporate proxy, drop on a flaky network, or be mid-reconnect,
 * and a page that silently stopped updating is worse than one that polls. Pass
 * `watch: null` for data with no Kubernetes resource behind it — the query then
 * keeps polling, which is the honest behaviour.
 */
export function useLiveRefetch(
  watch: LiveWatchRef | null,
  queryKeys: QueryKey[],
  fallbackMs: number,
  enabled = true,
): number | false {
  useLiveInvalidate(
    'k8s',
    (watch ?? {}) as unknown as Record<string, unknown>,
    queryKeys,
    enabled && watch !== null,
  )
  const interval = usePollingInterval(fallbackMs)
  // With no watch behind it there is nothing to push, so the timer stands.
  return watch === null ? fallbackMs : interval
}

/**
 * Make a **tool-backed** query live.
 *
 * Not everything the console shows lives in Kubernetes: Coder, Airbyte, Harbor,
 * Gitea and Plane are ordinary REST APIs with no watch endpoint, so there is
 * nothing to subscribe to. What can still be removed is the *browser* polling:
 * the BFF fetches the path on an interval, hashes the response, and notifies
 * only when it actually changed — and that upstream poll is shared across every
 * tab and every user on the same session, instead of each tab hitting the tool
 * on its own timer.
 *
 * Unlike `useLivePoll`, this does not write the pushed body into the cache. The
 * body the BFF sees is the tool's raw response, while the query holds whatever
 * the typed client parsed it into; writing one into the other would quietly
 * corrupt the shape. So this uses the push purely as a change signal and lets
 * the query refetch through its normal `queryFn`, which keeps types honest at
 * the cost of one extra round trip on an actual change.
 *
 * Returns the `refetchInterval` to hand back to TanStack Query: `false` while
 * the socket is live, `intervalMs` as the fallback when it is not.
 */
export function useLiveToolPoll(
  tool: string,
  path: string,
  intervalMs: number,
  queryKeys: QueryKey[],
  opts: { windowMs?: number; enabled?: boolean } = {},
): number | false {
  const qc = useQueryClient()
  const { windowMs = 0, enabled = true } = opts
  const keysRef = useRef(queryKeys)
  keysRef.current = queryKeys

  useEffect(() => {
    if (!enabled || !path) return
    let timer: number | undefined
    const unsub = liveClient.subscribe('poll', { tool, path, intervalMs, windowMs }, (msg) => {
      if (msg.op !== 'changed') return
      // Coalesce a burst of changes into one refetch.
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        for (const k of keysRef.current) void qc.invalidateQueries({ queryKey: k })
      }, 200) as unknown as number
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [tool, path, intervalMs, windowMs, enabled, qc])

  const fallback = usePollingInterval(intervalMs)
  return enabled ? fallback : false
}

/**
 * Server-side change detection for a proxied tool path: the BFF polls and
 * pushes the body only when it changes; the pushed body is written straight
 * into the query cache (no client refetch). `{start}`/`{end}` in `path`
 * slide by `windowMs`.
 */
export function useLivePoll<T = unknown>(
  tool: string,
  path: string,
  intervalMs: number,
  queryKey: QueryKey,
  opts: { windowMs?: number; enabled?: boolean; map?(body: unknown): T } = {},
) {
  const qc = useQueryClient()
  const { windowMs = 0, enabled = true } = opts
  const mapRef = useRef(opts.map)
  mapRef.current = opts.map
  const keyStr = JSON.stringify(queryKey)
  useEffect(() => {
    if (!enabled || !path) return
    const unsub = liveClient.subscribe('poll', { tool, path, intervalMs, windowMs }, (msg) => {
      if (msg.op === 'changed') {
        const body = msg.body
        qc.setQueryData(JSON.parse(keyStr), mapRef.current ? mapRef.current(body) : (body as T))
      }
    })
    return unsub
  }, [tool, path, intervalMs, windowMs, enabled, keyStr, qc])
}
