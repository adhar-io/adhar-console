/**
 * Service map — the client half of the live traffic view. Pure and tested.
 *
 *   wire types     what the BFF's `flows` topic pushes (apps/console/app/server/flows)
 *   MapGraph       the one graph shape the canvas draws, whichever source fed it:
 *                    live Hubble frames, 1-minute Prometheus edge metrics
 *                    (fallback), plus idle workloads from Kubernetes watches
 *   retention      nodes/edges that fall out of the window linger briefly as
 *                  idle, so the map does not jitter while traffic flickers
 *   filters        search (with 1-hop context), errors only, drops, collapse
 *   particles      emission rate / travel time from an edge's live rate
 */

import type { Health } from './golden-signals.ts'
import type { Graph } from './service-graph.ts'

/* ─────────────────────────── wire ─────────────────────────── */

export type Proto = 'http' | 'grpc' | 'dns' | 'kafka' | 'tcp' | 'udp' | 'icmp' | 'other'
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
  | 'namespace'

export interface WireNode {
  id: string
  n: string
  ns?: string
  k: NodeKind
  rps: number
  cps: number
  fps: number
  orps: number
  ofps: number
  err: number | null
  p95: number | null
  drops: number
}

export interface WireEdge {
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

export interface FeedRow {
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
  v: 'fwd' | 'drop' | 'err' | 'audit'
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

export interface SeriesPoint {
  t: number
  rps: number
  fps: number
  err: number | null
  p95: number | null
  drops: number
}

export interface FlowsFrame {
  t: number
  windowS: number
  nodes: WireNode[]
  edges: WireEdge[]
  totals: { rps: number; cps: number; fps: number; err: number | null; drops: number; services: number; edges: number }
  hidden: { edges: number; nodes: number }
  namespaces: string[]
  protos: Proto[]
  feed: FeedRow[]
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
  lost: number
}

/* ─────────────────────────── graph model ─────────────────────────── */

export interface MapNode {
  id: string
  name: string
  ns?: string
  kind: NodeKind
  /** Served (inbound) rates. */
  rps: number
  cps: number
  fps: number
  /** Outbound rates. */
  orps: number
  ofps: number
  err: number | null
  p95: number | null
  drops: number
  /** No traffic in the window (topology, or recently gone quiet). */
  idle?: boolean
  /** Collapsed namespace: how many nodes it stands for. */
  members?: number
}

export interface MapEdge {
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
  idle?: boolean
}

export interface MapGraph {
  nodes: MapNode[]
  edges: MapEdge[]
}

export const EMPTY_GRAPH: MapGraph = { nodes: [], edges: [] }

/**
 * The hub omits zero / null / empty fields to keep frames small; this fills
 * them back in.
 */
export function fromFrame(f: FlowsFrame): MapGraph {
  return {
    nodes: f.nodes.map((n) => ({
      id: n.id,
      name: n.n,
      ns: n.ns,
      kind: n.k ?? 'workload',
      rps: n.rps ?? 0,
      cps: n.cps ?? 0,
      fps: n.fps ?? 0,
      orps: n.orps ?? 0,
      ofps: n.ofps ?? 0,
      err: n.err ?? null,
      p95: n.p95 ?? null,
      drops: n.drops ?? 0,
    })),
    edges: f.edges.map((e) => ({
      id: e.id,
      s: e.s,
      d: e.d,
      rps: e.rps ?? 0,
      cps: e.cps ?? 0,
      fps: e.fps ?? 0,
      err: e.err ?? null,
      e4: e.e4 ?? null,
      p50: e.p50 ?? null,
      p95: e.p95 ?? null,
      drops: e.drops ?? 0,
      protos: e.protos ?? [],
      ports: e.ports ?? [],
      ...(e.svc ? { svc: e.svc } : {}),
    })),
  }
}

const NS_SPLIT = /^([^/]+)\/(.+)$/

/**
 * The Prometheus service graph (1-minute fallback) in the same shape. Ingress
 * "user" style client-only nodes keep their outgoing rate.
 */
export function fromPromGraph(g: Graph): MapGraph {
  return {
    nodes: g.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      ns: n.namespace,
      kind: guessKind(n.name),
      rps: n.clientOnly ? 0 : n.rps,
      cps: 0,
      fps: 0,
      orps: n.clientOnly ? n.rps : 0,
      ofps: 0,
      err: n.clientOnly ? null : n.errorPct,
      p95: n.p95Ms,
      drops: 0,
    })),
    edges: g.edges.map((e) => ({
      id: `${e.from}>${e.to}`,
      s: e.from,
      d: e.to,
      rps: e.rps,
      cps: 0,
      fps: 0,
      err: e.errorPct,
      e4: null,
      p50: null,
      p95: e.p95Ms,
      drops: 0,
      protos: ['http'],
      ports: [],
    })),
  }
}

export function guessKind(name: string): NodeKind {
  const n = name.toLowerCase()
  if (/(^|-)(core|kube)-?dns/.test(n)) return 'dns'
  if (/operator|controller|exporter|webhook|dashboards?$|-ui$|-console$|proxy|metrics|admin$/.test(n)) return 'workload'
  if (/redis|valkey|memcache|dragonfly|keydb/.test(n)) return 'cache'
  if (/kafka|rabbit|nats|pulsar|redpanda|zookeeper|strimzi/.test(n)) return 'queue'
  if (/postgres|pgbouncer|(^|-)pg(-|$)|mysql|mariadb|mongo|cockroach|clickhouse|cassandra|(^|-)db(-|$)|-db-\d+$/.test(n)) return 'database'
  return 'workload'
}

/** A workload known from the Kubernetes API (topology without traffic). */
export interface TopoWorkload {
  ns: string
  name: string
}

/**
 * Add idle nodes for workloads with no traffic in the window. Only for the
 * namespaces in `scope` (the user's filter, or those already on the map) so a
 * big platform namespace does not bury the live part.
 */
export function withTopology(g: MapGraph, workloads: TopoWorkload[], scope: ReadonlySet<string>): MapGraph {
  if (!workloads.length || !scope.size) return g
  const have = new Set(g.nodes.map((n) => n.id))
  const extra: MapNode[] = []
  for (const w of workloads) {
    if (!scope.has(w.ns)) continue
    const id = `${w.ns}/${w.name}`
    if (have.has(id)) continue
    have.add(id)
    extra.push({ id, name: w.name, ns: w.ns, kind: guessKind(w.name), rps: 0, cps: 0, fps: 0, orps: 0, ofps: 0, err: null, p95: null, drops: 0, idle: true })
  }
  return extra.length ? { nodes: [...g.nodes, ...extra.sort((a, b) => a.id.localeCompare(b.id))], edges: g.edges } : g
}

/* ─────────────────────────── retention ─────────────────────────── */

export interface Retained {
  nodes: Map<string, { node: MapNode; seen: number }>
  edges: Map<string, { edge: MapEdge; seen: number }>
}

export function newRetained(): Retained {
  return { nodes: new Map(), edges: new Map() }
}

const zeroNode = (n: MapNode): MapNode => ({ ...n, rps: 0, cps: 0, fps: 0, orps: 0, ofps: 0, err: null, p95: null, drops: 0, idle: true })
const zeroEdge = (e: MapEdge): MapEdge => ({ ...e, rps: 0, cps: 0, fps: 0, err: null, e4: null, p50: null, p95: null, drops: 0, idle: true })

/**
 * Keep what just went quiet on the map as idle for `graceMs`, so a service
 * whose traffic flickers does not pop in and out (and re-layout) every frame.
 * Mutates `r` (the caller's ref) and returns the graph to draw.
 */
export function retain(r: Retained, g: MapGraph, now: number, graceMs: number): MapGraph {
  for (const n of g.nodes) r.nodes.set(n.id, { node: n, seen: now })
  for (const e of g.edges) r.edges.set(e.id, { edge: e, seen: now })
  const live = new Set(g.nodes.map((n) => n.id))
  const liveE = new Set(g.edges.map((e) => e.id))
  const nodes = [...g.nodes]
  const edges = [...g.edges]
  for (const [id, v] of r.nodes) {
    if (now - v.seen > graceMs) r.nodes.delete(id)
    else if (!live.has(id)) nodes.push(zeroNode(v.node))
  }
  const ids = new Set(nodes.map((n) => n.id))
  for (const [id, v] of r.edges) {
    if (now - v.seen > graceMs || !ids.has(v.edge.s) || !ids.has(v.edge.d)) r.edges.delete(id)
    else if (!liveE.has(id)) edges.push(zeroEdge(v.edge))
  }
  return { nodes, edges }
}

/* ─────────────────────────── health & rates ─────────────────────────── */

export function errHealth(err: number | null | undefined): Health {
  if (err == null || !Number.isFinite(err)) return 'none'
  return err >= 5 ? 'crit' : err >= 1 ? 'warn' : 'ok'
}

/** Node health: error share when it serves L7; drops alone make it a warning. */
export function mapNodeHealth(n: Pick<MapNode, 'err' | 'drops' | 'idle'>): Health {
  if (n.idle) return 'none'
  const h = errHealth(n.err)
  if (h === 'none' && n.drops > 0) return 'warn'
  return h
}

export function mapEdgeHealth(e: Pick<MapEdge, 'err' | 'drops' | 'rps' | 'fps' | 'cps' | 'idle'>): Health {
  if (e.idle) return 'none'
  const h = errHealth(e.err)
  if (e.drops > 0 && e.rps + e.cps + e.fps - e.drops <= 0) return 'crit' // only drops
  if (h === 'none' && e.drops > 0) return 'warn'
  return h
}

export type RateUnit = 'req/s' | 'conn/s' | 'flows/s'

/** The headline rate of a node or edge: requests when L7 is visible, else connections, else flow events. */
export function primaryRate(x: { rps: number; cps: number; fps: number }): { value: number; unit: RateUnit } {
  if (x.rps > 0) return { value: x.rps, unit: 'req/s' }
  if (x.cps > 0) return { value: x.cps, unit: 'conn/s' }
  return { value: x.fps, unit: 'flows/s' }
}

/** A single number for "how busy", comparable across units (used for particles and widths). */
export function activity(x: { rps: number; cps: number; fps: number; drops: number }): number {
  return Math.max(x.rps, x.cps, x.fps * 0.5, x.drops)
}

export function formatRate(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`
  if (v >= 100) return v.toFixed(0)
  if (v >= 10) return v.toFixed(1)
  if (v >= 0.01) return v.toFixed(2)
  return '<0.01'
}

export function formatMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}s`
  if (v >= 10) return `${v.toFixed(0)}ms`
  if (v >= 1) return `${v.toFixed(1)}ms`
  return `${(v * 1000).toFixed(0)}µs`
}

export function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0%'
  if (v < 0.1) return '<0.1%'
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`
}

/** Edge thickness ∝ log(activity), clamped. */
export function strokeWidth(a: number): number {
  if (!(a > 0)) return 1.25
  return Math.max(1.25, Math.min(6, 1.25 + Math.log10(1 + a) * 1.6))
}

/* ─────────────────────────── filters ─────────────────────────── */

export interface MapFilters {
  search?: string
  errorsOnly?: boolean
  showDrops?: boolean
  showIdle?: boolean
  /** Traffic to/from the nodes themselves (kubelet probes, host networking). */
  showHosts?: boolean
}

function nodeMatches(n: MapNode, q: string): boolean {
  return n.name.toLowerCase().includes(q) || (n.ns ?? '').toLowerCase().includes(q) || n.id.toLowerCase().includes(q)
}

/**
 * Filters keep context: a search keeps matches plus their direct neighbours;
 * "errors only" keeps edges at ≥1% errors or with drops (when drops are
 * shown), and the nodes on them.
 */
export function applyFilters(g: MapGraph, f: MapFilters): MapGraph {
  let nodes = g.nodes
  let edges = g.edges
  if (f.showHosts === false) {
    const hosts = new Set(nodes.filter((n) => n.kind === 'host').map((n) => n.id))
    if (hosts.size) {
      edges = edges.filter((e) => !hosts.has(e.s) && !hosts.has(e.d))
      const used = new Set(edges.flatMap((e) => [e.s, e.d]))
      // A workload whose only traffic was node probes leaves with them (idle topology stays).
      nodes = nodes.filter((n) => !hosts.has(n.id) && (used.has(n.id) || n.idle))
    }
  }
  if (f.showDrops === false) {
    edges = edges.filter((e) => e.idle || e.rps + e.cps + e.fps - e.drops > 0).map((e) => (e.drops ? { ...e, drops: 0 } : e))
    nodes = nodes.map((n) => (n.drops ? { ...n, drops: 0 } : n))
  }
  if (f.showIdle === false) {
    edges = edges.filter((e) => !e.idle)
    const used = new Set(edges.flatMap((e) => [e.s, e.d]))
    nodes = nodes.filter((n) => !n.idle || used.has(n.id))
  }
  if (f.errorsOnly) {
    edges = edges.filter((e) => (e.err ?? 0) >= 1 || (f.showDrops !== false && e.drops > 0))
    const used = new Set(edges.flatMap((e) => [e.s, e.d]))
    nodes = nodes.filter((n) => used.has(n.id) || (n.err ?? 0) >= 1)
  }
  const q = (f.search ?? '').trim().toLowerCase()
  if (q) {
    const hit = new Set(nodes.filter((n) => nodeMatches(n, q)).map((n) => n.id))
    const keep = new Set(hit)
    for (const e of edges) {
      if (hit.has(e.s)) keep.add(e.d)
      if (hit.has(e.d)) keep.add(e.s)
    }
    nodes = nodes.filter((n) => keep.has(n.id))
    edges = edges.filter((e) => keep.has(e.s) && keep.has(e.d) && (hit.has(e.s) || hit.has(e.d)))
  }
  const ids = new Set(nodes.map((n) => n.id))
  edges = edges.filter((e) => ids.has(e.s) && ids.has(e.d))
  return { nodes, edges }
}

/** The 1-hop neighbourhood of `id` (focus mode dims everything else). */
export function neighbourhood(g: MapGraph, id: string | null): Set<string> | null {
  if (!id) return null
  const out = new Set([id])
  for (const e of g.edges) {
    if (e.s === id) out.add(e.d)
    if (e.d === id) out.add(e.s)
  }
  return out
}

/** Collapse namespaces into one node each, merging their edges. */
export function collapseNamespaces(g: MapGraph, collapsed: ReadonlySet<string>): MapGraph {
  if (!collapsed.size) return g
  const map = new Map<string, string>()
  const groups = new Map<string, MapNode>()
  const nodes: MapNode[] = []
  for (const n of g.nodes) {
    if (n.ns && collapsed.has(n.ns)) {
      const gid = `ns:${n.ns}`
      map.set(n.id, gid)
      let grp = groups.get(gid)
      if (!grp) {
        grp = { id: gid, name: n.ns, ns: n.ns, kind: 'namespace', rps: 0, cps: 0, fps: 0, orps: 0, ofps: 0, err: null, p95: null, drops: 0, members: 0, idle: true }
        groups.set(gid, grp)
        nodes.push(grp)
      }
      grp.members = (grp.members ?? 0) + 1
      if (!n.idle) grp.idle = false
    } else nodes.push(n)
  }
  const edges = new Map<string, MapEdge & { _e5: number; _req: number }>()
  for (const e of g.edges) {
    const s = map.get(e.s) ?? e.s
    const d = map.get(e.d) ?? e.d
    if (s === d && map.has(e.s)) continue // traffic inside a collapsed namespace
    const id = `${s}>${d}`
    let m = edges.get(id)
    if (!m) {
      m = { ...e, id, s, d, rps: 0, cps: 0, fps: 0, drops: 0, err: null, e4: null, p50: null, p95: null, protos: [], ports: [], idle: true, _e5: 0, _req: 0 }
      delete m.svc
      edges.set(id, m)
    }
    m.rps += e.rps
    m.cps += e.cps
    m.fps += e.fps
    m.drops += e.drops
    m._req += e.rps
    m._e5 += ((e.err ?? 0) / 100) * e.rps
    m.p95 = Math.max(m.p95 ?? 0, e.p95 ?? 0) || null
    m.protos = [...new Set([...m.protos, ...e.protos])].sort() as Proto[]
    m.ports = [...new Set([...m.ports, ...e.ports])].slice(0, 3)
    if (!e.idle) m.idle = false
  }
  // Rates of a collapsed group: what it serves from outside.
  const out = [...edges.values()].map(({ _e5, _req, ...e }) => ({ ...e, err: _req > 0 ? (100 * _e5) / _req : null }))
  for (const e of out) {
    const d = groups.get(e.d)
    if (d) {
      d.rps += e.rps
      d.cps += e.cps
      d.fps += e.fps
      d.drops += e.drops
    }
    const s = groups.get(e.s)
    if (s) {
      s.orps += e.rps
      s.ofps += e.fps
    }
  }
  return { nodes, edges: out }
}

/* ─────────────────────────── ids & links ─────────────────────────── */

export function edgeEnds(id: string): { s: string; d: string } | null {
  const i = id.indexOf('>')
  if (i <= 0 || i === id.length - 1) return null
  return { s: id.slice(0, i), d: id.slice(i + 1) }
}

/** `ns/name` → parts; entry nodes (`~world`) have no namespace. */
export function splitId(id: string): { ns?: string; name: string } {
  const m = id.match(NS_SPLIT)
  return m && !id.startsWith('~') && !id.startsWith('ns:') ? { ns: m[1], name: m[2] } : { name: id.replace(/^~|^ns:/, '') }
}

export const KIND_LABEL: Record<NodeKind, string> = {
  workload: 'Workload',
  database: 'Database',
  cache: 'Cache',
  queue: 'Queue / stream',
  dns: 'DNS',
  world: 'Outside the cluster',
  ingress: 'Ingress',
  host: 'Cluster nodes',
  apiserver: 'Kubernetes API',
  unmanaged: 'Unmanaged',
  restricted: 'Outside your access',
  namespace: 'Namespace',
}

/** Entry points (left edge of the map). */
export const ENTRY_KINDS: ReadonlySet<NodeKind> = new Set(['world', 'ingress'])

/* ─────────────────────────── particles ─────────────────────────── */

/** Particles per second an edge emits for a given activity (log-scaled, capped). */
export function emissionRate(a: number): number {
  if (!(a > 0)) return 0
  return Math.min(9, Math.max(0.35, 1.4 * Math.log2(1 + a)))
}

/** How long one particle takes to cross an edge: busier = faster. */
export function travelMs(a: number): number {
  if (!(a > 0)) return 2600
  return Math.round(Math.max(900, Math.min(2600, 2600 - 600 * Math.log10(1 + a))))
}

export interface Bezier {
  x0: number
  y0: number
  x1: number
  y1: number
  x2: number
  y2: number
  x3: number
  y3: number
}

export function bezierAt(b: Bezier, t: number): { x: number; y: number } {
  const u = 1 - t
  const a = u * u * u
  const c1 = 3 * u * u * t
  const c2 = 3 * u * t * t
  const d = t * t * t
  return { x: a * b.x0 + c1 * b.x1 + c2 * b.x2 + d * b.x3, y: a * b.y0 + c1 * b.y1 + c2 * b.y2 + d * b.y3 }
}

export function bezierPath(b: Bezier): string {
  const r = (v: number) => Math.round(v * 10) / 10
  return `M${r(b.x0)},${r(b.y0)} C${r(b.x1)},${r(b.y1)} ${r(b.x2)},${r(b.y2)} ${r(b.x3)},${r(b.y3)}`
}
