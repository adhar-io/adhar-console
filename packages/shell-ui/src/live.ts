import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { applyEvent, nextDelay, sameSnapshot, type Snapshot, snapshotOf } from './live-signal.ts'

/**
 * Live client — the browser side of `/api/live`, one multiplexed WebSocket
 * per tab shared by every module (shell-ui is a Module-Federation singleton).
 *
 *   liveClient.subscribe(topic, params, handler)   → unsubscribe()
 *   useLiveStatus()                                 → 'connecting' | 'live' | 'reconnecting' | 'offline'
 *   useLiveK8sList(gvr, opts)                       → list kept current by watch deltas
 *   useLiveInvalidate(topic, params, queryKeys)     → invalidate React-Query keys on push
 *   useWatchSignal(watch, queryKeys, opts)          → invalidate only on real object changes
 *   useLivePoll(tool, path, ms, queryKey, map?)     → server-side change detection feeding a query
 *   usePollingInterval(ms)                          → `ms` while offline, `false` while live
 *   pollEvery(ms)                                   → `ms` raised to the poll floor
 *
 * Reconnects with backoff, re-subscribes everything, and answers the server
 * heartbeat. When the socket is down, hooks fall back to polling — never
 * faster than `POLL_FLOOR_MS`, so a dropped socket cannot turn every open tab
 * into a tight loop against the control plane.
 *
 * A tab that stays hidden for `HIDDEN_SUSPEND_MS` closes its socket, which
 * tears down every watch and BFF poll it held; coming back reopens it and the
 * server's `resync` brings each subscriber current with one fetch.
 */

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'
export type LiveTopic = 'k8s' | 'poll' | 'notifications' | 'audit'

type Handler = (msg: Record<string, unknown>) => void

interface Sub {
  id: string
  topic: LiveTopic
  params: Record<string, unknown>
  handler: Handler
}

/**
 * The fastest any timer-driven fetch may run — the last resort behind watches
 * (k8s) and BFF change detection (tools). Everything that wants to be faster
 * must be pushed over the live socket instead.
 */
export const POLL_FLOOR_MS = 60_000

/** `ms` raised to the poll floor; `false`/`undefined` pass through. */
export function pollEvery(ms: number): number
export function pollEvery(ms: number | false | undefined): number | false | undefined
export function pollEvery(ms: number | false | undefined): number | false | undefined {
  return typeof ms === 'number' && ms > 0 ? Math.max(ms, POLL_FLOOR_MS) : ms
}

/** How long a hidden tab keeps its socket (and every upstream watch/poll) open. */
const HIDDEN_SUSPEND_MS = 2 * 60_000

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
  /** Socket deliberately closed because the tab has been hidden a while. */
  private suspended = false
  private hiddenTimer: number | undefined

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
    if (this.suspended) return
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
      if (this.ws === ws) this.ws = null
      if (this.suspended) return
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
    if (this.suspended) return
    if (!this.subs.size) return
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.timer) clearTimeout(this.timer)
    this.backoff = BACKOFF_MIN
    this.open()
  }

  /**
   * Tab visibility. Hidden for longer than `HIDDEN_SUSPEND_MS` closes the
   * socket, so nobody is holding apiserver watches or BFF polls open for a tab
   * no one is looking at. Visible again reopens it; subscriptions are kept,
   * re-sent on open, and answered with a `resync`.
   */
  setHidden(hidden: boolean) {
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer)
    this.hiddenTimer = undefined
    if (hidden) {
      this.hiddenTimer = setTimeout(() => {
        this.suspended = true
        if (this.timer) clearTimeout(this.timer)
        if (this.pingTimer) clearInterval(this.pingTimer)
        try {
          this.ws?.close()
        } catch {
          // already gone
        }
        this.ws = null
        this.setStatus('reconnecting')
      }, HIDDEN_SUSPEND_MS) as unknown as number
      return
    }
    if (!this.suspended) return this.reconnectNow()
    this.suspended = false
    if (this.wantOpen && this.subs.size) {
      this.backoff = BACKOFF_MIN
      this.open()
    }
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
    liveClient.setHidden(document.visibilityState === 'hidden')
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

/**
 * `false` (no polling) while the live socket is up; while it is down, `ms`
 * raised to `POLL_FLOOR_MS`.
 */
export function usePollingInterval(ms: number): number | false {
  const status = useLiveStatus()
  return status === 'live' ? false : pollEvery(ms)
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

/** True when any query under `keys` holds data fetched before `since`. */
function cachedBefore(qc: ReturnType<typeof useQueryClient>, keys: QueryKey[], since: number): boolean {
  return keys.some((k) => qc.getQueryCache().findAll({ queryKey: k }).some((q) => q.state.dataUpdatedAt < since))
}

/**
 * Invalidate React-Query keys when the topic pushes a real change.
 *
 *   • k8s — objects are fingerprinted (`live-signal.ts`); no-op MODIFIED
 *     events and relist `resync`s that change nothing are ignored.
 *   • poll — the hub's first `changed` after subscribing only refetches if
 *     the cache predates the subscription (the query just loaded otherwise).
 *
 * Debounced so a burst becomes one refetch; an in-flight fetch is never
 * cancelled to start the same one again.
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
    let snap: Snapshot | null = null
    let first = true
    const subscribedAt = Date.now()
    const bump = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        for (const k of keysRef.current) void qc.invalidateQueries({ queryKey: k }, { cancelRefetch: false })
      }, 250) as unknown as number
    }
    const unsub = liveClient.subscribe(topic, JSON.parse(paramsKey), (msg) => {
      if (msg.op === 'resync') {
        const next = snapshotOf((msg.items as unknown[]) ?? [])
        const prev = snap
        snap = next
        if (prev === null ? cachedBefore(qc, keysRef.current, subscribedAt) : !sameSnapshot(prev, next)) bump()
      } else if (msg.op === 'event') {
        if (snap === null) snap = new Map()
        if (applyEvent(snap, String(msg.type ?? ''), msg.object)) bump()
      } else if (msg.op === 'changed') {
        const wasFirst = first
        first = false
        if (!wasFirst || cachedBefore(qc, keysRef.current, subscribedAt)) bump()
      } else if (msg.op === 'invalidate') {
        bump()
      }
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
  return useWatchSignal(watch, queryKeys, { enabled, fallbackMs, throttleMs: 2_000 })
}

/* ─────────── change-filtered watch signal ─────────── */

export interface WatchSignalOpts {
  enabled?: boolean
  /** Timer used only while the socket is down or the watch was refused. Floored at 60s. */
  fallbackMs?: number
  /** At most one refetch per this window while changes keep arriving. */
  throttleMs?: number
  /** Extra noise keys for this resource (e.g. Kyverno's per-result `timestamp`). */
  ignore?: readonly string[]
}

/**
 * Invalidate `queryKeys` when the objects behind `watch` really change.
 * Returns the `refetchInterval` for the query: `false` while the watch is
 * live, the (≥60s) fallback when the socket is down or the watch was refused.
 */
export function useWatchSignal(
  watch: LiveWatchRef | null,
  queryKeys: QueryKey[],
  opts: WatchSignalOpts = {},
): number | false {
  const { enabled = true, fallbackMs = POLL_FLOOR_MS, throttleMs = 5_000, ignore = [] } = opts
  const qc = useQueryClient()
  const status = useLiveStatus()
  const [refused, setRefused] = useState(false)
  const keysRef = useRef(queryKeys)
  keysRef.current = queryKeys
  const watchKey = watch ? JSON.stringify(watch) : ''
  const ignoreKey = ignore.join(',')

  useEffect(() => {
    setRefused(false)
    if (!enabled || !watchKey) return
    const extra = ignoreKey ? ignoreKey.split(',') : []
    let snap: Snapshot | null = null
    let timer: number | undefined
    let last = 0
    const subscribedAt = Date.now()

    const invalidate = () => {
      for (const k of keysRef.current) {
        // `cancelRefetch: false` — never abort a fetch already in flight just
        // to start the same one again.
        void qc.invalidateQueries({ queryKey: k }, { cancelRefetch: false })
      }
    }
    const bump = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        last = Date.now()
        invalidate()
      }, nextDelay(Date.now(), last, throttleMs)) as unknown as number
    }

    const unsub = liveClient.subscribe('k8s', JSON.parse(watchKey), (msg) => {
      if (msg.op === 'resync') {
        const next = snapshotOf((msg.items as unknown[]) ?? [], extra)
        setRefused(false)
        if (snap === null) {
          snap = next
          // First snapshot: only refetch what was fetched before the watch
          // started (a cached list from an earlier visit); a list that is
          // loading right now already reflects this state.
          const older = keysRef.current.some((k) =>
            qc.getQueryCache().findAll({ queryKey: k }).some((q) => q.state.dataUpdatedAt < subscribedAt)
          )
          if (older) bump()
          return
        }
        const changed = !sameSnapshot(snap, next)
        snap = next
        if (changed) bump()
      } else if (msg.op === 'event') {
        if (snap === null) snap = new Map()
        if (applyEvent(snap, String(msg.type ?? ''), msg.object, extra)) bump()
      } else if (msg.op === 'error') {
        setRefused(true)
      }
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unsub()
    }
  }, [watchKey, ignoreKey, enabled, throttleMs, qc])

  if (!enabled) return false
  if (!watchKey || refused || status !== 'live') return pollEvery(fallbackMs)
  return false
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
  intervalMs = pollEvery(intervalMs)
  const keysRef = useRef(queryKeys)
  keysRef.current = queryKeys

  useEffect(() => {
    if (!enabled || !path) return
    let timer: number | undefined
    let first = true
    const subscribedAt = Date.now()
    // `hashOnly`: this hook only needs the change signal, so the hub does not
    // ship the tool's body over the socket.
    const unsub = liveClient.subscribe('poll', { tool, path, intervalMs, windowMs, hashOnly: true }, (msg) => {
      if (msg.op !== 'changed') return
      // The hub's first tick always reports `changed` (it has no previous
      // hash). The query that just mounted already holds that state.
      const wasFirst = first
      first = false
      if (wasFirst && !cachedBefore(qc, keysRef.current, subscribedAt)) return
      // Coalesce a burst of changes into one refetch.
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        for (const k of keysRef.current) void qc.invalidateQueries({ queryKey: k }, { cancelRefetch: false })
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
  intervalMs = pollEvery(intervalMs)
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
