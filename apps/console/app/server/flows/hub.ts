/**
 * The `flows` live topic — Hubble Relay → one shared aggregator → per-viewer frames.
 *
 *   - ONE upstream `Observer.GetFlows(follow)` stream per BFF process, opened
 *     when the first viewer subscribes and closed `IDLE_GRACE_MS` after the
 *     last one leaves (so a filter change re-subscribing does not reconnect).
 *     The stream backfills the last minute on (re)connect, so a fresh page
 *     paints a populated map immediately. Reconnects with jittered backoff.
 *   - Every viewer gets its own frame every `FRAME_MS`, computed from the
 *     shared aggregator with THAT viewer's namespace access applied; frames
 *     identical to the last one sent are not re-sent. Snapshots are memoised
 *     per (access, view) within a tick, so ten viewers of the same view cost
 *     one computation.
 *   - Access: a viewer sees flows for namespaces where they may `list pods`
 *     (SelfSubjectAccessReview as the viewer, cached 30 s by access.ts);
 *     cluster-wide `list pods` means everything. Re-checked every minute
 *     against the namespaces present in traffic. Fail closed: if the check
 *     cannot be made, the viewer sees nothing until it can.
 *
 * Wire (server → client, all tagged with the subscription id):
 *   {op:'status', state:'connecting'|'live'|'reconnecting'|'unavailable', reason?, message?}
 *   {op:'frame', frame}   — see aggregate.ts `Frame`
 */

import { env } from '@adhar/utils'
import { type Allow, FlowAggregator, type Frame, PROTOS, type Proto, type SnapshotView, WINDOWS_S } from './aggregate.ts'
import { grpcServerStream } from './h2c-grpc.ts'
import { decodeGetFlowsResponse, encodeGetFlowsRequest } from './proto-wire.ts'
import { normalizeFlow } from './aggregate.ts'

type Json = Record<string, unknown>

export const FRAME_MS = 1_500
const IDLE_GRACE_MS = 20_000
const ACCESS_REFRESH_MS = 60_000
const BACKFILL_MS = 60_000
const BACKOFF_MIN = 1_000
const BACKOFF_MAX = 30_000

export type HubState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'unavailable'

/* ─────────────────────────── relay address ─────────────────────────── */

export interface RelayTarget {
  hostname: string
  port: number
  tls: boolean
}

/**
 * `HUBBLE_RELAY_ADDR` (`host:port`, optional `grpc://` / `grpcs://` /
 * `http(s)://` scheme). In-cluster without it, Cilium's default Service
 * (`hubble-relay.<HUBBLE_RELAY_NAMESPACE|adhar-system>:80`). Off-cluster
 * without it: none — the map falls back to metrics and says why.
 */
export function relayTarget(get: (k: string) => string | undefined = env): RelayTarget | null {
  let raw = (get('HUBBLE_RELAY_ADDR') ?? '').trim()
  if (raw === 'off' || raw === 'disabled') return null
  if (!raw) {
    if (!get('KUBERNETES_SERVICE_HOST')) return null
    raw = `hubble-relay.${get('HUBBLE_RELAY_NAMESPACE') ?? 'adhar-system'}.svc.cluster.local:80`
  }
  let tls = get('HUBBLE_RELAY_TLS') === '1' || get('HUBBLE_RELAY_TLS') === 'true'
  const m = raw.match(/^(grpcs?|https?):\/\/(.*)$/)
  if (m) {
    tls = tls || m[1] === 'grpcs' || m[1] === 'https'
    raw = m[2]
  }
  raw = raw.replace(/\/.*$/, '')
  const idx = raw.lastIndexOf(':')
  const hostname = (idx > 0 ? raw.slice(0, idx) : raw).replace(/^\[|\]$/g, '')
  const port = idx > 0 ? Number(raw.slice(idx + 1)) : tls ? 443 : 80
  if (!hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { hostname, port, tls }
}

/* ─────────────────────────── upstream source ─────────────────────────── */

/** Something that streams flows into the aggregator. Injectable for tests. */
export interface FlowSource {
  /** Runs until the stream ends; rejects if it could not connect. */
  run(opts: { signal: AbortSignal; sinceMs: number; onOpen(): void; onMessage(m: Uint8Array): void }): Promise<{ reason: string; detail?: string }>
}

export function relaySource(t: RelayTarget): FlowSource {
  return {
    run: ({ signal, sinceMs, onOpen, onMessage }) =>
      grpcServerStream({
        hostname: t.hostname,
        port: t.port,
        tls: t.tls,
        path: '/observer.Observer/GetFlows',
        message: encodeGetFlowsRequest({ follow: true, sinceMs, excludeLabels: ['reserved:health'] }),
        signal,
        onOpen,
        onMessage,
      }),
  }
}

/* ─────────────────────────── hub ─────────────────────────── */

export interface Viewer {
  /** Stable key for whose access applies (identity key). */
  accessKey: string
  allow: Allow | null
  view: SnapshotView
  push(m: Json): void
  /** Last frame body sent (minus time and feed), to skip identical frames. */
  lastJson?: string
}

export class FlowsHub {
  readonly agg: FlowAggregator
  state: HubState = 'idle'
  message = ''
  readonly viewers = new Set<Viewer>()
  #ac: AbortController | null = null
  #idleTimer: number | undefined
  #tick: number | undefined
  #memo = new Map<string, { t: number; frame: Frame; json: string }>()
  readonly #source: FlowSource | null
  readonly #now: () => number
  readonly #unavailableReason: string

  constructor(opts: { source: FlowSource | null; now?: () => number; unavailableReason?: string; aggregator?: FlowAggregator }) {
    this.#source = opts.source
    this.#now = opts.now ?? Date.now
    this.agg = opts.aggregator ?? new FlowAggregator({ now: this.#now })
    this.#unavailableReason = opts.unavailableReason ?? 'not-configured'
    if (!this.#source) {
      this.state = 'unavailable'
      this.message = 'Hubble Relay is not configured for this console.'
    }
  }

  #setState(s: HubState, message = '') {
    if (this.state === s && this.message === message) return
    this.state = s
    this.message = message
    for (const v of this.viewers) v.push(this.statusMsg())
  }

  statusMsg(): Json {
    const m: Json = { op: 'status', state: this.state }
    if (this.message) m.message = this.message
    if (this.state === 'unavailable') m.reason = this.#unavailableReason
    return m
  }

  join(v: Viewer): () => void {
    this.viewers.add(v)
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = undefined
    }
    // Starting announces `connecting` to every viewer, this one included.
    if (this.#source && !this.#ac) this.#start()
    else v.push(this.statusMsg())
    if (this.#tick === undefined) this.#tick = setInterval(() => this.tick(), FRAME_MS) as unknown as number
    return () => {
      this.viewers.delete(v)
      if (this.viewers.size) return
      if (this.#tick !== undefined) clearInterval(this.#tick)
      this.#tick = undefined
      this.#idleTimer = setTimeout(() => this.stop(), IDLE_GRACE_MS) as unknown as number
    }
  }

  /** Close the upstream stream (last viewer gone, or shutdown). */
  stop(): void {
    this.#ac?.abort()
    this.#ac = null
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
    if (this.#tick !== undefined) clearInterval(this.#tick)
    this.#tick = undefined
    if (this.#source) this.state = 'idle'
  }

  get upstreamOpen(): boolean {
    return this.#ac !== null
  }

  #start() {
    const ac = new AbortController()
    this.#ac = ac
    this.#setState('connecting')
    const source = this.#source!
    ;(async () => {
      let backoff = BACKOFF_MIN
      let first = true
      while (!ac.signal.aborted) {
        try {
          const res = await source.run({
            signal: ac.signal,
            // Backfill on the first connect; after a drop, only what we missed.
            sinceMs: this.#now() - (first ? BACKFILL_MS : Math.min(BACKFILL_MS, backoff * 2)),
            onOpen: () => {
              backoff = BACKOFF_MIN
              this.#setState('live')
            },
            onMessage: (m) => this.ingest(m),
          })
          first = false
          if (ac.signal.aborted) return
          this.#setState('reconnecting', `Relay stream ended (${res.reason}${res.detail ? `: ${res.detail}` : ''})`)
        } catch (e) {
          if (ac.signal.aborted) return
          this.#setState('reconnecting', `Cannot reach Hubble Relay: ${e instanceof Error ? e.message : String(e)}`)
        }
        const delay = backoff / 2 + Math.random() * (backoff / 2)
        backoff = Math.min(backoff * 2, BACKOFF_MAX)
        await new Promise((r) => setTimeout(r, delay))
      }
    })()
  }

  ingest(m: Uint8Array): void {
    let r
    try {
      r = decodeGetFlowsResponse(m)
    } catch {
      return // one malformed message must not end the stream
    }
    if (r.kind === 'lost') this.agg.noteLost(r.lost)
    if (r.kind !== 'flow') return
    const ev = normalizeFlow(r.flow)
    if (ev) this.agg.add(ev)
  }

  /** Compute and push one frame per viewer. Public for tests. */
  tick(): void {
    this.agg.prune()
    this.#memo.clear()
    if (this.state !== 'live' && this.state !== 'reconnecting') return
    for (const v of this.viewers) {
      if (!v.allow) continue
      const allowKey = v.allow === '*' ? '*' : [...v.allow].sort().join(',')
      const { afterSeq: _cursor, ...shape } = v.view
      const memoKey = `${allowKey}|${JSON.stringify(shape)}`
      let hit = this.#memo.get(memoKey)
      if (!hit) {
        const frame = compactFrame(this.agg.snapshot({ ...shape, allow: v.allow }))
        hit = { t: this.#now(), frame, json: JSON.stringify({ ...frame, t: 0, feed: [] }) }
        this.#memo.set(memoKey, hit)
      }
      // Each viewer only gets feed rows it has not seen yet.
      const after = v.view.afterSeq ?? 0
      const feed = hit.frame.feed.filter((f) => f.seq > after)
      if (!feed.length && hit.json === v.lastJson) continue
      v.lastJson = hit.json
      if (feed.length) v.view.afterSeq = feed[0].seq
      v.push({ op: 'frame', frame: { ...hit.frame, feed } })
    }
  }
}

/* ─────────────────────────── payload ─────────────────────────── */

/** Drop zero / null / empty-array fields from nodes, edges and feed rows (the client defaults them). */
function strip<T extends object>(o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === 0 || v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0)) continue
    out[k] = v
  }
  return out as T
}

/** A frame with the per-item zero fields removed — roughly halves a busy frame. */
export function compactFrame(f: Frame): Frame {
  return { ...f, nodes: f.nodes.map(strip), edges: f.edges.map(strip), feed: f.feed.map(strip) }
}

/* ─────────────────────────── params ─────────────────────────── */

const NS_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/** Validates subscription params into a snapshot view (allow is filled in later). */
export function parseView(params: Json): Omit<SnapshotView, 'allow'> {
  const w = Number(params.windowS)
  const windowS = (WINDOWS_S as readonly number[]).includes(w) ? w : 60
  const namespaces = Array.isArray(params.namespaces)
    ? (params.namespaces as unknown[]).filter((n): n is string => typeof n === 'string' && NS_RE.test(n)).slice(0, 50)
    : []
  const protos = Array.isArray(params.protos)
    ? (params.protos as unknown[]).filter((p): p is Proto => typeof p === 'string' && (PROTOS as readonly string[]).includes(p))
    : []
  const id = (v: unknown) => (typeof v === 'string' && v.length <= 300 ? v : undefined)
  return {
    windowS,
    namespaces,
    // `scope: 'apps'` (the Service map's default) hides platform-only traffic.
    appsOnly: params.scope === 'apps',
    protos,
    hideHosts: params.hosts === false,
    focus: id(params.focus),
    edge: id(params.edge),
    maxEdges: Math.min(400, Math.max(20, Number(params.maxEdges) || 200)),
    maxNodes: Math.min(250, Math.max(10, Number(params.maxNodes) || 120)),
    feedMax: 40,
  }
}

/* ─────────────────────────── process-wide hub ─────────────────────────── */

let shared: FlowsHub | null = null

export function sharedHub(): FlowsHub {
  if (!shared) {
    const t = relayTarget()
    shared = new FlowsHub({ source: t ? relaySource(t) : null })
  }
  return shared
}

/** Diagnostics for /readyz-style status. */
export function flowsStats(): { state: HubState; viewers: number; upstream: boolean; edges: number } {
  if (!shared) return { state: 'idle', viewers: 0, upstream: false, edges: 0 }
  return { state: shared.state, viewers: shared.viewers.size, upstream: shared.upstreamOpen, edges: shared.agg.edges.size }
}

/** Test seam: replace the process hub. */
export function setSharedHub(h: FlowsHub | null): void {
  shared?.stop()
  shared = h
}

export { ACCESS_REFRESH_MS }
