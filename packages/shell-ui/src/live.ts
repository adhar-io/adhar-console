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
      this.setStatus('live')
      for (const s of this.subs.values()) this.sendSub(s)
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => this.send({ op: 'ping', t: Date.now() }), 20_000) as unknown as number
    }
    ws.onmessage = (ev) => {
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
    this.timer = setTimeout(() => this.open(), this.backoff) as unknown as number
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX)
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
