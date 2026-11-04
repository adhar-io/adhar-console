/**
 * Live traffic aggregation for the Service map — pure, clock-injected, tested.
 *
 *   Hubble flow ──normalizeFlow──▶ FlowEvent (client → server, node refs, protocol)
 *              ──FlowAggregator.add──▶ per edge+protocol rings of 1-second buckets
 *              ──FlowAggregator.snapshot(view)──▶ one compact frame for one viewer
 *
 * Units, honestly named:
 *   rps  L7 requests/s — counted from L7 RESPONSE flows (they carry the status
 *        and latency), so it is only non-zero where Cilium's L7 proxy sees the
 *        traffic (an L7-aware policy or visibility annotation);
 *   cps  new TCP connections/s (SYN without ACK, de-duplicated across the two
 *        observation points a pod-to-pod connection is seen at);
 *   fps  flow events/s — every forwarded/dropped event Hubble emits for the
 *        edge, which is what keeps long-lived connections visible.
 *
 * Errors are HTTP 5xx, DNS SERVFAIL/REFUSED-class rcodes, and Kafka error
 * codes; 4xx are counted separately. Drops are DROPPED verdicts.
 *
 * RBAC lives in `snapshot`: a viewer only gets edges with at least one end in
 * a namespace they may list pods in, and the other end — if it sits in a
 * namespace they may not see — is masked as one "Outside your access" node
 * with no name, namespace or pod.
 */

import { isPlatformNamespace } from '@adhar/utils'
import { dropReasonName, FLOW_TYPE_L7, type HubbleEndpoint, type HubbleFlow, L7_RESPONSE } from './proto-wire.ts'

/* ─────────────────────────── node identity ─────────────────────────── */

export type NodeKind =
  | 'workload'
  | 'database'
  | 'cache'
  | 'queue'
  | 'dns'
  | 'world'
  | 'ingress'
  | 'host'
  | 'apiserver'
  | 'unmanaged'
  | 'restricted'

export interface NodeRef {
  id: string
  name: string
  ns?: string
  kind: NodeKind
}

export const RESTRICTED: NodeRef = { id: '~restricted', name: 'Outside your access', kind: 'restricted' }
const WORLD: NodeRef = { id: '~world', name: 'External', kind: 'world' }
const INGRESS: NodeRef = { id: '~ingress', name: 'Ingress gateway', kind: 'ingress' }
const HOSTS: NodeRef = { id: '~nodes', name: 'Cluster nodes', kind: 'host' }
const APISERVER: NodeRef = { id: '~kube-apiserver', name: 'Kubernetes API', kind: 'apiserver' }
const UNMANAGED: NodeRef = { id: '~unmanaged', name: 'Unmanaged endpoints', kind: 'unmanaged' }

// Kubernetes' generated-name alphabet (no vowels, no 0/1/3).
const GEN = '[bcdfghjklmnpqrstvwxz2456789]'
const RS_POD = new RegExp(`-${GEN}{6,10}-${GEN}{5}$`)
const DS_POD = new RegExp(`-${GEN}{5}$`)
const RS_HASH = new RegExp(`-${GEN}{6,10}$`)

function label(labels: string[], key: string): string | undefined {
  const p = `k8s:${key}=`
  const hit = labels.find((l) => l.startsWith(p))
  return hit ? hit.slice(p.length) : undefined
}

/**
 * The workload a pod belongs to: Hubble's resolved owner when it has one
 * (a ReplicaSet is shortened to its Deployment), else the pod name with its
 * generated suffixes removed, else the common app labels.
 */
export function workloadName(ep: Pick<HubbleEndpoint, 'workloads' | 'podName' | 'labels'>): string {
  const w = ep.workloads[0]
  if (w?.name) {
    if (w.kind === 'ReplicaSet') return w.name.replace(RS_HASH, '')
    if (w.kind === 'Job') return w.name.replace(/-\d{6,}$/, '')
    return w.name
  }
  const pod = ep.podName
  if (pod) {
    const hash = label(ep.labels, 'pod-template-hash') ?? label(ep.labels, 'rollouts-pod-template-hash')
    if (hash && pod.includes(`-${hash}-`)) return pod.slice(0, pod.lastIndexOf(`-${hash}-`))
    if (RS_POD.test(pod)) return pod.replace(RS_POD, '')
    if (/-\d+$/.test(pod)) return pod.replace(/-\d+$/, '')
    if (DS_POD.test(pod)) return pod.replace(DS_POD, '')
    return pod
  }
  return (
    label(ep.labels, 'app.kubernetes.io/name') ??
      label(ep.labels, 'app') ??
      label(ep.labels, 'k8s-app') ??
      label(ep.labels, 'name') ??
      ''
  )
}

const DB_RE = /postgres|pgbouncer|(^|-)pg(-|$)|mysql|mariadb|mongo|cockroach|clickhouse|cassandra|scylla|timescale|cnpg|(^|-)db(-|$)|-db-\d+$|opensearch|elasticsearch|etcd/
const CACHE_RE = /redis|valkey|memcache|dragonfly|keydb/
const QUEUE_RE = /kafka|rabbit|nats|pulsar|redpanda|zookeeper|activemq|strimzi|temporal/
const DNS_RE = /(^|-)(core|kube)-?dns/
const DB_PORTS = new Set([5432, 3306, 27017, 26257, 9042, 8123, 9200])
const CACHE_PORTS = new Set([6379, 11211])
const QUEUE_PORTS = new Set([9092, 5672, 4222, 6650])

// Things that manage or front a data store are not the store itself.
const NOT_A_STORE = /operator|controller|exporter|webhook|dashboards?$|-ui$|-console$|proxy|metrics|admin$/

export function classifyKind(name: string, labels: string[] = [], port = 0): NodeKind {
  const n = name.toLowerCase()
  const comp = (label(labels, 'app.kubernetes.io/component') ?? '').toLowerCase()
  if (DNS_RE.test(n) || (port === 53 && /dns/.test(n))) return 'dns'
  if (NOT_A_STORE.test(n)) return 'workload'
  if (CACHE_RE.test(n)) return 'cache'
  if (QUEUE_RE.test(n)) return 'queue'
  if (DB_RE.test(n) || comp === 'database' || comp === 'primary') return 'database'
  if (DB_PORTS.has(port)) return 'database'
  if (CACHE_PORTS.has(port)) return 'cache'
  if (QUEUE_PORTS.has(port)) return 'queue'
  return 'workload'
}

const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|fd|fc|::1$)/

/**
 * Map one side of a flow to a graph node. `port` is the server port when this
 * side is the server (used to recognise databases, caches and queues).
 */
export function endpointNode(ep: HubbleEndpoint | null, ip: string, port = 0): NodeRef {
  const labels = ep?.labels ?? []
  const reserved = labels.find((l) => l.startsWith('reserved:'))
  if (ep?.namespace) {
    const name = workloadName(ep) || ep.podName || ip || 'unknown'
    return { id: `${ep.namespace}/${name}`, name, ns: ep.namespace, kind: classifyKind(name, labels, port) }
  }
  const id = ep?.identity ?? 0
  if (reserved?.startsWith('reserved:world') || id === 2 || id === 9 || id === 10) return WORLD
  if (reserved === 'reserved:ingress' || id === 8) return INGRESS
  if (reserved === 'reserved:host' || reserved === 'reserved:remote-node' || id === 1 || id === 6) return HOSTS
  if (reserved === 'reserved:kube-apiserver' || id === 7) return APISERVER
  if (reserved) return UNMANAGED
  if (ip && !PRIVATE_IP.test(ip)) return WORLD
  return UNMANAGED
}

/* ─────────────────────────── normalisation ─────────────────────────── */

export type Proto = 'http' | 'grpc' | 'dns' | 'kafka' | 'tcp' | 'udp' | 'icmp' | 'other'
export const PROTOS: readonly Proto[] = ['http', 'grpc', 'dns', 'kafka', 'tcp', 'udp', 'icmp', 'other']

export type Verdict = 'fwd' | 'drop' | 'err' | 'audit'

export interface FlowEvent {
  /** Flow time (ms). */
  t: number
  src: NodeRef
  dst: NodeRef
  proto: Proto
  /** Server port. */
  port: number
  verdict: Verdict
  dropReason?: string
  /** Pod names on each side (for the node panel). */
  srcPod?: string
  dstPod?: string
  /** `namespace/name` of the Kubernetes Service the client addressed. */
  svc?: string
  /** An L7 response: a completed request. */
  req?: { method?: string; path?: string; status?: number; latencyMs?: number; error: boolean; query?: string; topic?: string }
  /** A new TCP connection (SYN, not ACK). */
  newConn: boolean
  /** True when this event is a reply-direction packet (still the same edge). */
  reply: boolean
  /** Key that identifies the same event seen at a second observation point. */
  dedupe?: string
}

/** `/a/b?token=x` → `/a/b`; long ids collapsed so paths group. Query strings never leave the server. */
export function cleanPath(url: string): string {
  let p = url
  try {
    p = new URL(url, 'http://x').pathname
  } catch {
    p = url.split('?')[0]
  }
  return p
    .split('/')
    .map((seg) => (/^[0-9]+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || seg.length > 48 ? ':id' : seg))
    .join('/')
    .slice(0, 120)
}

const GRPC_PATH = /^\/[A-Za-z_][\w.]*\/[A-Za-z_]\w*$/

function isDnsError(rcode: number): boolean {
  // NXDOMAIN (3) is routine with search domains; FORMERR/SERVFAIL/NOTIMP/REFUSED are failures.
  return rcode === 1 || rcode === 2 || rcode === 4 || rcode === 5
}

/**
 * One Hubble flow → a client→server event, or null when it carries nothing
 * the map draws (L7 REQUEST flows — the matching RESPONSE is counted; flows
 * with no usable endpoints).
 */
export function normalizeFlow(f: HubbleFlow): FlowEvent | null {
  const isL7 = f.type === FLOW_TYPE_L7 && f.l7 !== null
  if (isL7 && f.l7!.type !== L7_RESPONSE) return null
  // Orient client → server: L7 responses and reply packets travel server → client.
  const swap = isL7 ? true : f.isReply === true
  const cEp = swap ? f.destination : f.source
  const sEp = swap ? f.source : f.destination
  const cIp = swap ? f.ipDst : f.ipSrc
  const sIp = swap ? f.ipSrc : f.ipDst
  const cPort = swap ? f.l4.dstPort : f.l4.srcPort
  const sPort = swap ? f.l4.srcPort : f.l4.dstPort
  const src = endpointNode(cEp, cIp)
  const dst = endpointNode(sEp, sIp, sPort)
  const verdict: Verdict = f.verdict === 2 ? 'drop' : f.verdict === 3 ? 'err' : f.verdict === 4 ? 'audit' : 'fwd'

  let proto: Proto
  if (f.l4.proto === 'TCP') proto = 'tcp'
  else if (f.l4.proto === 'UDP') proto = sPort === 53 ? 'dns' : 'udp'
  else if (f.l4.proto === 'ICMPv4' || f.l4.proto === 'ICMPv6') proto = 'icmp'
  else proto = 'other'

  const ev: FlowEvent = {
    t: f.timeMs,
    src,
    dst,
    proto,
    port: sPort,
    verdict,
    newConn: false,
    reply: !isL7 && f.isReply === true,
  }
  if (cEp?.podName) ev.srcPod = cEp.podName
  if (sEp?.podName) ev.dstPod = sEp.podName
  const svc = swap ? f.sourceService : f.destinationService
  if (svc?.name) ev.svc = `${svc.namespace}/${svc.name}`
  if (verdict === 'drop') ev.dropReason = dropReasonName(f.dropReason)
  const tuple = `${cIp}:${cPort}>${sIp}:${sPort}`

  if (isL7) {
    const l7 = f.l7!
    const latencyMs = l7.latencyNs ? l7.latencyNs / 1e6 : undefined
    if (l7.http) {
      const path = cleanPath(l7.http.url)
      proto = l7.http.protocol === 'HTTP/2' && GRPC_PATH.test(path) ? 'grpc' : 'http'
      const status = l7.http.code || undefined
      ev.req = { method: l7.http.method || undefined, path, status, latencyMs, error: (status ?? 0) >= 500 }
      ev.dedupe = `h|${tuple}|${l7.http.method}|${path}|${status ?? 0}`
    } else if (l7.dns) {
      proto = 'dns'
      ev.req = { query: l7.dns.query.replace(/\.$/, ''), status: l7.dns.rcode, latencyMs, error: isDnsError(l7.dns.rcode) }
      ev.dedupe = `d|${tuple}|${l7.dns.query}|${l7.dns.rcode}`
    } else if (l7.kafka) {
      proto = 'kafka'
      ev.req = { method: l7.kafka.apiKey || undefined, topic: l7.kafka.topic || undefined, status: l7.kafka.errorCode, latencyMs, error: l7.kafka.errorCode !== 0 }
      ev.dedupe = `k|${tuple}|${l7.kafka.apiKey}|${l7.kafka.topic}|${l7.kafka.errorCode}`
    } else {
      ev.req = { latencyMs, error: false }
    }
    ev.proto = proto
    return ev
  }
  if (f.l4.proto === 'TCP' && f.l4.syn && !f.l4.ack && !ev.reply) {
    ev.newConn = true
    ev.dedupe = `s|${tuple}`
  }
  return ev
}

/* ─────────────────────────── aggregation ─────────────────────────── */

/** Longest window a viewer may ask for, in seconds (one bucket per second). */
export const MAX_WINDOW_S = 300
export const WINDOWS_S = [15, 60, 300] as const
const LAT_SAMPLES = 256
const DEDUPE_TTL_MS = 3_000
const MAX_EDGE_KEYS = 4_000
const RECENT_MAX = 600
const MAX_PODS = 24

interface Bucket {
  sec: number
  flows: number
  conns: number
  reqs: number
  e5: number
  e4: number
  c2: number
  c3: number
  drops: number
  dropReasons?: Record<string, number>
}

export interface EdgeStats {
  key: string
  src: NodeRef
  dst: NodeRef
  proto: Proto
  ring: Array<Bucket | undefined>
  /** Ring of [time ms, latency ms]. */
  lat: Float64Array
  latN: number
  ports: Map<number, number>
  svcs: Set<string>
  lastSec: number
}

/** A feed row: one recent request, connection or drop. Pre-filtered and safe to ship. */
export interface FeedItem {
  seq: number
  t: number
  s: string
  d: string
  sn: string
  dn: string
  sns?: string
  dns?: string
  p: Proto
  port: number
  v: Verdict
  m?: string
  path?: string
  code?: number
  lat?: number
  dr?: string
  q?: string
  newConn?: boolean
  sp?: string
  dp?: string
}

export interface AggregatorOpts {
  now?: () => number
  /** Keep 1-in-N plain L4 events in the recent feed (L7, drops and new connections are always kept). */
  feedSampleL4?: number
}

/** Who may see what: `'*'` (cluster-wide) or the set of namespaces. */
export type Allow = '*' | ReadonlySet<string>

export interface SnapshotView {
  windowS: number
  allow: Allow
  /** Namespace filter chosen in the UI (empty = all the viewer may see). */
  namespaces?: readonly string[]
  /**
   * With no namespace filter: keep only connections with at least one end in
   * an APPLICATION namespace (not the platform's own — see
   * `isPlatformNamespace`). Applied before the caps, so platform chatter
   * cannot crowd application traffic out of the busiest-N.
   */
  appsOnly?: boolean
  protos?: readonly Proto[]
  /** Leave out traffic to/from the nodes themselves (kubelet probes, host networking) — before the caps. */
  hideHosts?: boolean
  focus?: string
  edge?: string
  maxEdges?: number
  maxNodes?: number
  /** Feed rows newer than this sequence number. */
  afterSeq?: number
  feedMax?: number
}

export interface FrameNode {
  id: string
  n: string
  ns?: string
  k: NodeKind
  /** served (inbound) rates */
  rps: number
  cps: number
  fps: number
  /** outbound */
  orps: number
  ofps: number
  err: number | null
  p95: number | null
  drops: number
}

export interface FrameEdge {
  id: string
  s: string
  d: string
  rps: number
  cps: number
  fps: number
  err: number | null
  e4: number | null
  p50: number | null
  p95: number | null
  drops: number
  protos: Proto[]
  ports: number[]
  svc?: string
}

export interface SeriesPoint {
  t: number
  rps: number
  fps: number
  err: number | null
  p95: number | null
  drops: number
}

export interface Frame {
  t: number
  windowS: number
  nodes: FrameNode[]
  edges: FrameEdge[]
  totals: { rps: number; cps: number; fps: number; err: number | null; drops: number; services: number; edges: number }
  /** Edges/nodes left out by the caps, so the UI can say so. */
  hidden: { edges: number; nodes: number }
  /** Namespaces with traffic the viewer may see (for the filter). */
  namespaces: string[]
  protos: Proto[]
  feed: FeedItem[]
  seq: number
  focus?: { id: string; series: SeriesPoint[]; pods: string[] }
  edge?: {
    id: string
    series: SeriesPoint[]
    status: { c2: number; c3: number; c4: number; c5: number }
    dropReasons: Array<{ reason: string; count: number }>
    ports: number[]
    svcs: string[]
    p50: number | null
    p95: number | null
    p99: number | null
  }
  /** Flow events Hubble reported lost in this window (ring overflow). */
  lost: number
}

function round(v: number, d = 2): number {
  const m = 10 ** d
  return Math.round(v * m) / m
}

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[i]
}

export class FlowAggregator {
  readonly #now: () => number
  readonly #sampleL4: number
  readonly edges = new Map<string, EdgeStats>()
  readonly #dedupe = new Map<string, number>()
  #dedupePrunedAt = 0
  readonly #recent: Array<{ ev: FlowEvent; seq: number } | undefined> = new Array(RECENT_MAX)
  #seq = 0
  #l4Counter = 0
  readonly #pods = new Map<string, Map<string, number>>()
  #lost: Array<[number, number]> = []

  constructor(opts: AggregatorOpts = {}) {
    this.#now = opts.now ?? Date.now
    this.#sampleL4 = Math.max(1, opts.feedSampleL4 ?? 20)
  }

  get seq(): number {
    return this.#seq
  }

  noteLost(n: number): void {
    this.#lost.push([this.#now(), n])
    if (this.#lost.length > 64) this.#lost.shift()
  }

  /** True when `ev` repeats one already counted (the second observation point). */
  #isDuplicate(ev: FlowEvent, now: number): boolean {
    if (!ev.dedupe) return false
    if (now - this.#dedupePrunedAt > 1_000) {
      for (const [k, at] of this.#dedupe) if (now - at > DEDUPE_TTL_MS) this.#dedupe.delete(k)
      this.#dedupePrunedAt = now
    }
    const seen = this.#dedupe.get(ev.dedupe)
    if (seen !== undefined && now - seen <= DEDUPE_TTL_MS) return true
    this.#dedupe.set(ev.dedupe, now)
    return false
  }

  add(ev: FlowEvent): void {
    const now = this.#now()
    // Clamp skewed clocks: a flow "from the future" lands now; older than the
    // longest window it is useless.
    const t = Math.min(ev.t || now, now)
    if (now - t > MAX_WINDOW_S * 1000) return
    const dup = this.#isDuplicate(ev, now)
    const sec = Math.floor(t / 1000)
    const key = `${ev.src.id}>${ev.dst.id}|${ev.proto}`
    let e = this.edges.get(key)
    if (!e) {
      if (this.edges.size >= MAX_EDGE_KEYS) this.#evict()
      e = {
        key,
        src: ev.src,
        dst: ev.dst,
        proto: ev.proto,
        ring: new Array(MAX_WINDOW_S),
        lat: new Float64Array(LAT_SAMPLES * 2),
        latN: 0,
        ports: new Map(),
        svcs: new Set(),
        lastSec: 0,
      }
      this.edges.set(key, e)
    } else if (e.dst.kind === 'workload' && ev.dst.kind !== 'workload') {
      // A later flow recognised the server (its port said database/cache/queue).
      e.dst = ev.dst
    }
    e.lastSec = Math.max(e.lastSec, sec)
    const slot = sec % MAX_WINDOW_S
    let b = e.ring[slot]
    if (!b || b.sec !== sec) {
      b = { sec, flows: 0, conns: 0, reqs: 0, e5: 0, e4: 0, c2: 0, c3: 0, drops: 0 }
      e.ring[slot] = b
    }
    if (!ev.reply) b.flows++
    if (ev.verdict === 'drop') {
      b.drops++
      const r = ev.dropReason ?? 'Unknown reason'
      b.dropReasons ??= {}
      b.dropReasons[r] = (b.dropReasons[r] ?? 0) + 1
    }
    if (!dup) {
      if (ev.newConn) b.conns++
      if (ev.req) {
        b.reqs++
        const s = ev.req.status ?? 0
        if (ev.req.error) b.e5++
        else if (ev.proto === 'http' || ev.proto === 'grpc') {
          if (s >= 400) b.e4++
          else if (s >= 300) b.c3++
          else if (s >= 200) b.c2++
        } else b.c2++
        if (ev.req.latencyMs !== undefined) {
          const i = (e.latN % LAT_SAMPLES) * 2
          e.lat[i] = t
          e.lat[i + 1] = ev.req.latencyMs
          e.latN++
        }
      }
    }
    if (ev.port && !ev.reply) e.ports.set(ev.port, (e.ports.get(ev.port) ?? 0) + 1)
    if (ev.svc && e.svcs.size < 8) e.svcs.add(ev.svc)
    if (ev.srcPod) this.#notePod(ev.src.id, ev.srcPod, t)
    if (ev.dstPod) this.#notePod(ev.dst.id, ev.dstPod, t)

    // Recent feed: every request and drop, and every new connection that
    // touches a workload; node ↔ internet chatter and other plain L4 events
    // are sampled so they cannot drown the workload traffic out.
    if (dup || ev.reply) return
    const workload = !!(ev.src.ns || ev.dst.ns)
    const keep = ev.req || ev.verdict !== 'fwd' || (ev.newConn && workload) || ++this.#l4Counter % this.#sampleL4 === 0
    if (!keep) return
    const seq = ++this.#seq
    this.#recent[seq % RECENT_MAX] = { ev, seq }
  }

  #notePod(node: string, pod: string, t: number): void {
    let m = this.#pods.get(node)
    if (!m) {
      m = new Map()
      this.#pods.set(node, m)
    }
    m.set(pod, t)
    if (m.size > MAX_PODS) {
      let oldest = ''
      let at = Infinity
      for (const [p, ts] of m) if (ts < at) [oldest, at] = [p, ts]
      m.delete(oldest)
    }
  }

  /** Drop the least recently active quarter of edges. */
  #evict(): void {
    const sorted = [...this.edges.values()].sort((a, b) => a.lastSec - b.lastSec)
    for (const e of sorted.slice(0, Math.ceil(sorted.length / 4))) this.edges.delete(e.key)
  }

  /** Forget edges idle for longer than the longest window. */
  prune(): void {
    const minSec = Math.floor(this.#now() / 1000) - MAX_WINDOW_S
    for (const [k, e] of this.edges) if (e.lastSec < minSec) this.edges.delete(k)
    for (const [node, pods] of this.#pods) {
      for (const [p, t] of pods) if (t < minSec * 1000) pods.delete(p)
      if (!pods.size) this.#pods.delete(node)
    }
  }

  /** Namespaces with any traffic in the longest window (candidates for the RBAC check). */
  namespaces(): string[] {
    const out = new Set<string>()
    for (const e of this.edges.values()) {
      if (e.src.ns) out.add(e.src.ns)
      if (e.dst.ns) out.add(e.dst.ns)
    }
    return [...out].sort()
  }

  snapshot(v: SnapshotView): Frame {
    const now = this.#now()
    const nowSec = Math.floor(now / 1000)
    const windowS = Math.min(MAX_WINDOW_S, Math.max(5, Math.round(v.windowS)))
    const fromSec = nowSec - windowS + 1
    const fromMs = fromSec * 1000
    const allowed = (ns: string | undefined) => !ns || v.allow === '*' || v.allow.has(ns)
    const nsFilter = v.namespaces?.length ? new Set(v.namespaces) : null
    const protoFilter = v.protos?.length ? new Set(v.protos) : null
    const maxEdges = v.maxEdges ?? 300
    const maxNodes = v.maxNodes ?? 160

    /** Mask a node the viewer may not see. */
    const view = (n: NodeRef): NodeRef => (n.ns && !allowed(n.ns) ? RESTRICTED : n)
    /** Visible when one end is a namespaced node the viewer may see (or they see everything). */
    const visible = (s: NodeRef, d: NodeRef) => v.allow === '*' || (s.ns && allowed(s.ns)) || (d.ns && allowed(d.ns))

    interface Acc {
      id: string
      s: NodeRef
      d: NodeRef
      flows: number
      conns: number
      reqs: number
      e5: number
      e4: number
      c2: number
      c3: number
      drops: number
      lat: number[]
      protos: Set<Proto>
      ports: Map<number, number>
      svcs: Set<string>
      dropReasons: Map<string, number>
      stats: EdgeStats[]
    }
    const acc = new Map<string, Acc>()
    const namespaces = new Set<string>()
    const protosSeen = new Set<Proto>()

    for (const e of this.edges.values()) {
      if (e.lastSec < fromSec) continue
      if (!visible(e.src, e.dst)) continue
      const s = view(e.src)
      const d = view(e.dst)
      if (s.ns && allowed(s.ns)) namespaces.add(s.ns)
      if (d.ns && allowed(d.ns)) namespaces.add(d.ns)
      protosSeen.add(e.proto)
      if (protoFilter && !protoFilter.has(e.proto)) continue
      if (nsFilter && !(s.ns && nsFilter.has(s.ns)) && !(d.ns && nsFilter.has(d.ns))) continue
      if (!nsFilter && v.appsOnly && !(s.ns && !isPlatformNamespace(s.ns)) && !(d.ns && !isPlatformNamespace(d.ns))) continue
      if (v.hideHosts && (s.kind === 'host' || d.kind === 'host')) continue
      const id = `${s.id}>${d.id}`
      let a = acc.get(id)
      if (!a) {
        a = {
          id,
          s,
          d,
          flows: 0,
          conns: 0,
          reqs: 0,
          e5: 0,
          e4: 0,
          c2: 0,
          c3: 0,
          drops: 0,
          lat: [],
          protos: new Set(),
          ports: new Map(),
          svcs: new Set(),
          dropReasons: new Map(),
          stats: [],
        }
        acc.set(id, a)
      }
      let any = false
      for (const b of e.ring) {
        if (!b || b.sec < fromSec || b.sec > nowSec) continue
        any = true
        a.flows += b.flows
        a.conns += b.conns
        a.reqs += b.reqs
        a.e5 += b.e5
        a.e4 += b.e4
        a.c2 += b.c2
        a.c3 += b.c3
        a.drops += b.drops
        if (b.dropReasons) for (const [r, c] of Object.entries(b.dropReasons)) a.dropReasons.set(r, (a.dropReasons.get(r) ?? 0) + c)
      }
      if (!any) continue
      const n = Math.min(e.latN, LAT_SAMPLES)
      for (let i = 0; i < n; i++) if (e.lat[i * 2] >= fromMs) a.lat.push(e.lat[i * 2 + 1])
      a.protos.add(e.proto)
      for (const [p, c] of e.ports) a.ports.set(p, (a.ports.get(p) ?? 0) + c)
      // Only name the Service when the server end is visible to this viewer.
      if (d !== RESTRICTED) for (const x of e.svcs) a.svcs.add(x)
      a.stats.push(e)
    }
    for (const [id, a] of acc) if (a.flows + a.reqs + a.drops + a.conns === 0) acc.delete(id)

    const activity = (a: Acc) => a.reqs * 4 + a.conns * 2 + a.flows + a.drops * 2
    const all = [...acc.values()].sort((x, y) => activity(y) - activity(x) || x.id.localeCompare(y.id))

    // Totals over everything visible (before caps).
    let tReq = 0
    let tE5 = 0
    let tConn = 0
    let tFlow = 0
    let tDrop = 0
    const services = new Set<string>()
    for (const a of all) {
      tReq += a.reqs
      tE5 += a.e5
      tConn += a.conns
      tFlow += a.flows
      tDrop += a.drops
      if (a.s.kind !== 'restricted') services.add(a.s.id)
      if (a.d.kind !== 'restricted') services.add(a.d.id)
    }

    // Caps: keep the busiest edges, then the busiest nodes among them. A focused
    // node's or selected edge's neighbourhood always survives the cut.
    const pinned = (a: Acc) => (v.focus && (a.s.id === v.focus || a.d.id === v.focus)) || a.id === v.edge
    const kept = all.filter((a, i) => i < maxEdges || pinned(a))
    const nodeActivity = new Map<string, number>()
    for (const a of kept) {
      nodeActivity.set(a.s.id, (nodeActivity.get(a.s.id) ?? 0) + activity(a))
      nodeActivity.set(a.d.id, (nodeActivity.get(a.d.id) ?? 0) + activity(a))
    }
    const nodeIds = [...nodeActivity.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
    const keepNodes = new Set(nodeIds.filter((id, i) => i < maxNodes || id === v.focus))
    const edgesOut = kept.filter((a) => keepNodes.has(a.s.id) && keepNodes.has(a.d.id))

    const w = windowS
    const nodes = new Map<string, FrameNode & { _lat: number[]; _e5: number; _reqs: number }>()
    const node = (r: NodeRef) => {
      let n = nodes.get(r.id)
      if (!n) {
        n = { id: r.id, n: r.name, ns: r.ns, k: r.kind, rps: 0, cps: 0, fps: 0, orps: 0, ofps: 0, err: null, p95: null, drops: 0, _lat: [], _e5: 0, _reqs: 0 }
        if (!r.ns) delete n.ns
        nodes.set(r.id, n)
      }
      return n
    }
    const edges: FrameEdge[] = edgesOut.map((a) => {
      a.lat.sort((x, y) => x - y)
      const s = node(a.s)
      const d = node(a.d)
      d.rps += a.reqs / w
      d.cps += a.conns / w
      d.fps += a.flows / w
      d.drops += a.drops / w
      d._lat.push(...a.lat)
      d._e5 += a.e5
      d._reqs += a.reqs
      s.orps += a.reqs / w
      s.ofps += a.flows / w
      const top = [...a.ports.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([p]) => p)
      const fe: FrameEdge = {
        id: a.id,
        s: a.s.id,
        d: a.d.id,
        rps: round(a.reqs / w, 3),
        cps: round(a.conns / w, 3),
        fps: round(a.flows / w, 3),
        err: a.reqs ? round((100 * a.e5) / a.reqs) : null,
        e4: a.reqs ? round((100 * a.e4) / a.reqs) : null,
        p50: quantile(a.lat, 0.5),
        p95: quantile(a.lat, 0.95),
        drops: round(a.drops / w, 3),
        protos: [...a.protos].sort(),
        ports: top,
      }
      if (fe.p50 !== null) fe.p50 = round(fe.p50)
      if (fe.p95 !== null) fe.p95 = round(fe.p95)
      const svc = [...a.svcs][0]
      if (svc) fe.svc = svc
      return fe
    })
    const nodesOut: FrameNode[] = [...nodes.values()].map(({ _lat, _e5, _reqs, ...n }) => {
      _lat.sort((x, y) => x - y)
      const p95 = quantile(_lat, 0.95)
      return {
        ...n,
        rps: round(n.rps, 3),
        cps: round(n.cps, 3),
        fps: round(n.fps, 3),
        orps: round(n.orps, 3),
        ofps: round(n.ofps, 3),
        drops: round(n.drops, 3),
        err: _reqs ? round((100 * _e5) / _reqs) : null,
        p95: p95 === null ? null : round(p95),
      }
    })

    // Feed: newest first, filtered like the graph.
    const feed: FeedItem[] = []
    const feedMax = v.feedMax ?? 40
    const after = v.afterSeq ?? 0
    for (let seq = this.#seq; seq > after && seq > this.#seq - RECENT_MAX && feed.length < feedMax; seq--) {
      const r = this.#recent[seq % RECENT_MAX]
      if (!r || r.seq !== seq) continue
      const ev = r.ev
      if (ev.t < fromMs) break
      if (!visible(ev.src, ev.dst)) continue
      if (protoFilter && !protoFilter.has(ev.proto)) continue
      if (v.hideHosts && (ev.src.kind === 'host' || ev.dst.kind === 'host')) continue
      const s = view(ev.src)
      const d = view(ev.dst)
      if (nsFilter && !(s.ns && nsFilter.has(s.ns)) && !(d.ns && nsFilter.has(d.ns))) continue
      if (!nsFilter && v.appsOnly && !(s.ns && !isPlatformNamespace(s.ns)) && !(d.ns && !isPlatformNamespace(d.ns))) continue
      const item: FeedItem = { seq, t: ev.t, s: s.id, d: d.id, sn: s.name, dn: d.name, p: ev.proto, port: d === RESTRICTED ? 0 : ev.port, v: ev.verdict }
      if (s.ns) item.sns = s.ns
      if (d.ns) item.dns = d.ns
      if (ev.req) {
        // Request details describe the server; hide them when the server is masked.
        if (d !== RESTRICTED) {
          if (ev.req.method) item.m = ev.req.method
          if (ev.req.path) item.path = ev.req.path
          if (ev.req.query) item.q = ev.req.query
          if (ev.req.topic) item.path = ev.req.topic
        }
        if (ev.req.status !== undefined) item.code = ev.req.status
        if (ev.req.latencyMs !== undefined) item.lat = round(ev.req.latencyMs)
      }
      if (ev.dropReason) item.dr = ev.dropReason
      if (ev.newConn) item.newConn = true
      if (ev.srcPod && s !== RESTRICTED) item.sp = ev.srcPod
      if (ev.dstPod && d !== RESTRICTED) item.dp = ev.dstPod
      feed.push(item)
    }

    const frame: Frame = {
      t: now,
      windowS,
      nodes: nodesOut,
      edges,
      totals: {
        rps: round(tReq / w, 3),
        cps: round(tConn / w, 3),
        fps: round(tFlow / w, 3),
        err: tReq ? round((100 * tE5) / tReq) : null,
        drops: round(tDrop / w, 3),
        services: services.size,
        edges: all.length,
      },
      hidden: { edges: all.length - edgesOut.length, nodes: Math.max(0, nodeIds.length - keepNodes.size) },
      namespaces: [...namespaces].sort(),
      protos: PROTOS.filter((p) => protosSeen.has(p)),
      feed,
      seq: this.#seq,
      lost: this.#lost.filter(([t]) => t >= fromMs).reduce((s, [, n]) => s + n, 0),
    }

    if (v.focus && nodes.has(v.focus)) {
      const inbound = edgesOut.filter((a) => a.d.id === v.focus).flatMap((a) => a.stats)
      const outbound = edgesOut.filter((a) => a.s.id === v.focus).flatMap((a) => a.stats)
      const pods = v.focus.startsWith('~') ? [] : [...(this.#pods.get(v.focus)?.keys() ?? [])].sort()
      // Series stop at the last COMPLETE second, so the trend never ends on a false dip.
      frame.focus = { id: v.focus, series: series(inbound.length ? inbound : outbound, fromSec, nowSec - 1), pods }
    }
    if (v.edge) {
      const a = acc.get(v.edge)
      if (a) {
        a.lat.sort((x, y) => x - y)
        frame.edge = {
          id: a.id,
          series: series(a.stats, fromSec, nowSec - 1),
          status: { c2: a.c2, c3: a.c3, c4: a.e4, c5: a.e5 },
          dropReasons: [...a.dropReasons.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([reason, count]) => ({ reason, count })),
          ports: [...a.ports.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([p]) => p),
          svcs: [...a.svcs].slice(0, 8),
          p50: quantile(a.lat, 0.5),
          p95: quantile(a.lat, 0.95),
          p99: quantile(a.lat, 0.99),
        }
      }
    }
    return frame
  }
}

/** Rate series over [fromSec, toSec] in ≤60 steps, summed across `stats`. */
export function series(stats: EdgeStats[], fromSec: number, toSec: number): SeriesPoint[] {
  const span = toSec - fromSec + 1
  const step = Math.max(1, Math.ceil(span / 60))
  const out: SeriesPoint[] = []
  for (let s0 = fromSec; s0 <= toSec; s0 += step) {
    const s1 = Math.min(toSec, s0 + step - 1)
    let reqs = 0
    let flows = 0
    let e5 = 0
    let drops = 0
    const lats: number[] = []
    for (const e of stats) {
      for (let sec = s0; sec <= s1; sec++) {
        const b = e.ring[sec % MAX_WINDOW_S]
        if (!b || b.sec !== sec) continue
        reqs += b.reqs
        flows += b.flows
        e5 += b.e5
        drops += b.drops
      }
      const n = Math.min(e.latN, LAT_SAMPLES)
      for (let i = 0; i < n; i++) {
        const t = e.lat[i * 2]
        if (t >= s0 * 1000 && t < (s1 + 1) * 1000) lats.push(e.lat[i * 2 + 1])
      }
    }
    lats.sort((x, y) => x - y)
    const secs = s1 - s0 + 1
    const p95 = quantile(lats, 0.95)
    out.push({
      t: s0 * 1000,
      rps: round(reqs / secs, 3),
      fps: round(flows / secs, 3),
      err: reqs ? round((100 * e5) / reqs) : null,
      p95: p95 === null ? null : round(p95),
      drops: round(drops / secs, 3),
    })
  }
  return out
}
