/**
 * Service graph — built from real edge metrics, laid out in layers.
 *
 * Pure and JSX-free (unit-tested). The graph is derived from Prometheus
 * vectors keyed by a client/server label pair:
 *
 *   - Tempo metrics-generator service graphs: `traces_service_graph_request_total{client,server}`
 *     (+ `_failed_total`, `_server_seconds_bucket`)
 *   - Istio: `istio_requests_total{source_workload,destination_workload}`
 *   - Cilium Hubble httpV2 with source + destination context labels
 *
 * Whichever source answers is used; nothing is invented. A node's RED numbers
 * are what it SERVED (sum of incoming edges); a pure client (a load generator,
 * the ingress "user" node) has no incoming edges and shows its outgoing rate.
 */

import { esc, type Health } from './golden-signals.ts'

export interface GraphSource {
  id: string
  label: string
  probe: string
  client: string
  server: string
  clientNs?: string
  serverNs?: string
  /** Builds the instant queries for a rate window. `ns` filters both ends. */
  queries(win: string, ns?: string | null): { rps: string; err: string; p95: string | null }
  hint: string
}

function nsSel(a: string | undefined, b: string | undefined, ns?: string | null, extra: string[] = []): string {
  const m = [...extra]
  // Keep an edge if EITHER end is in the namespace — its neighbours stay visible.
  if (ns && a && b) return `{${[...m, `${a}="${esc(ns)}"`].join(', ')}}`
  return m.length ? `{${m.join(', ')}}` : ''
}

export const GRAPH_SOURCES: GraphSource[] = [
  {
    id: 'tempo',
    label: 'Tempo service graphs',
    probe: 'traces_service_graph_request_total',
    client: 'client',
    server: 'server',
    queries: (w) => ({
      rps: `sum by (client, server) (rate(traces_service_graph_request_total[${w}]))`,
      err: `sum by (client, server) (rate(traces_service_graph_request_failed_total[${w}]))`,
      p95: `1000 * histogram_quantile(0.95, sum by (le, client, server) (rate(traces_service_graph_request_server_seconds_bucket[${w}])))`,
    }),
    hint: 'Tempo metrics-generator with the service-graphs processor (remote-writes traces_service_graph_* to Prometheus)',
  },
  {
    id: 'istio',
    label: 'Istio',
    probe: 'istio_requests_total',
    client: 'source_workload',
    server: 'destination_workload',
    clientNs: 'source_workload_namespace',
    serverNs: 'destination_workload_namespace',
    queries: (w, ns) => {
      const by = 'source_workload, source_workload_namespace, destination_workload, destination_workload_namespace'
      const s = nsSel('destination_workload_namespace', 'source_workload_namespace', ns, ['reporter="destination"'])
      const e = nsSel('destination_workload_namespace', 'source_workload_namespace', ns, ['reporter="destination"', 'response_code=~"5.."'])
      return {
        rps: `sum by (${by}) (rate(istio_requests_total${s}[${w}]))`,
        err: `sum by (${by}) (rate(istio_requests_total${e}[${w}]))`,
        p95: `histogram_quantile(0.95, sum by (le, ${by}) (rate(istio_request_duration_milliseconds_bucket${s}[${w}])))`,
      }
    },
    hint: 'Istio standard metrics',
  },
  {
    id: 'hubble',
    label: 'Cilium Hubble L7',
    probe: 'hubble_http_requests_total',
    client: 'source_workload',
    server: 'destination_workload',
    clientNs: 'source_namespace',
    serverNs: 'destination_namespace',
    queries: (w, ns) => {
      const by = 'source_workload, source_namespace, destination_workload, destination_namespace'
      const s = nsSel('destination_namespace', 'source_namespace', ns)
      const e = nsSel('destination_namespace', 'source_namespace', ns, ['status=~"5.."'])
      return {
        rps: `max by (${by}) (sum by (${by}, reporter) (rate(hubble_http_requests_total${s}[${w}])))`,
        err: `max by (${by}) (sum by (${by}, reporter) (rate(hubble_http_requests_total${e}[${w}])))`,
        p95: `1000 * histogram_quantile(0.95, sum by (le, ${by}) (rate(hubble_http_request_duration_seconds_bucket${s}[${w}])))`,
      }
    },
    hint: 'Hubble httpV2 with labelsContext=source_namespace,source_workload,destination_namespace,destination_workload',
  },
]

export interface Sample {
  metric: Record<string, string>
  value: number
}

export interface GraphNode {
  id: string
  name: string
  namespace?: string
  /** Requests per second served (incoming), or sent when it only calls out. */
  rps: number
  errorPct: number | null
  p95Ms: number | null
  /** True when the node only appears as a client. */
  clientOnly: boolean
  inDegree: number
  outDegree: number
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  rps: number
  errorPct: number | null
  p95Ms: number | null
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

function nodeId(name: string, ns?: string): string {
  return ns ? `${ns}/${name}` : name
}

/** Hubble/Istio use these for traffic from outside the cluster or unresolved endpoints. */
const UNKNOWN = new Set(['', 'unknown'])

export function buildGraph(src: GraphSource, rps: Sample[], err: Sample[], p95: Sample[]): Graph {
  const edges = new Map<string, GraphEdge>()
  const nodes = new Map<string, GraphNode>()
  const ends = (m: Record<string, string>) => {
    const c = m[src.client] ?? ''
    const s = m[src.server] ?? ''
    return {
      from: nodeId(UNKNOWN.has(c) ? 'external' : c, src.clientNs && !UNKNOWN.has(c) ? m[src.clientNs] : undefined),
      fromName: UNKNOWN.has(c) ? 'external' : c,
      fromNs: src.clientNs && !UNKNOWN.has(c) ? m[src.clientNs] : undefined,
      to: nodeId(s, src.serverNs ? m[src.serverNs] : undefined),
      toName: s,
      toNs: src.serverNs ? m[src.serverNs] : undefined,
    }
  }
  const touch = (id: string, name: string, ns?: string) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, name, namespace: ns, rps: 0, errorPct: null, p95Ms: null, clientOnly: true, inDegree: 0, outDegree: 0 })
    }
    return nodes.get(id)!
  }
  for (const s of rps) {
    const e = ends(s.metric)
    if (UNKNOWN.has(e.toName) || !(s.value > 0)) continue
    const id = `${e.from}->${e.to}`
    const cur = edges.get(id)
    if (cur) cur.rps += s.value
    else edges.set(id, { id, from: e.from, to: e.to, rps: s.value, errorPct: null, p95Ms: null })
    touch(e.from, e.fromName, e.fromNs)
    touch(e.to, e.toName, e.toNs)
  }
  const errByEdge = new Map<string, number>()
  for (const s of err) {
    const e = ends(s.metric)
    const id = `${e.from}->${e.to}`
    errByEdge.set(id, (errByEdge.get(id) ?? 0) + s.value)
  }
  for (const s of p95) {
    const e = ends(s.metric)
    const edge = edges.get(`${e.from}->${e.to}`)
    if (edge && Number.isFinite(s.value)) edge.p95Ms = s.value
  }
  // Node aggregates.
  const served = new Map<string, { rps: number; err: number; p95: number | null; any: boolean }>()
  for (const edge of edges.values()) {
    const errRps = errByEdge.get(edge.id) ?? 0
    edge.errorPct = edge.rps > 0 ? (100 * errRps) / edge.rps : null
    nodes.get(edge.from)!.outDegree++
    const to = nodes.get(edge.to)!
    to.inDegree++
    to.clientOnly = false
    const agg = served.get(edge.to) ?? { rps: 0, err: 0, p95: null, any: false }
    agg.rps += edge.rps
    agg.err += errRps
    // p95 of a node across callers: the worst caller's p95 (upper bound, honest without raw buckets).
    if (edge.p95Ms != null) agg.p95 = Math.max(agg.p95 ?? 0, edge.p95Ms)
    agg.any = true
    served.set(edge.to, agg)
  }
  for (const n of nodes.values()) {
    const agg = served.get(n.id)
    if (agg) {
      n.rps = agg.rps
      n.errorPct = agg.rps > 0 ? (100 * agg.err) / agg.rps : null
      n.p95Ms = agg.p95
    } else {
      n.rps = [...edges.values()].filter((e) => e.from === n.id).reduce((a, e) => a + e.rps, 0)
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

export function nodeHealth(n: { errorPct: number | null; clientOnly?: boolean }): Health {
  if (n.errorPct == null) return n.clientOnly ? 'none' : 'ok'
  if (n.errorPct >= 5) return 'crit'
  if (n.errorPct >= 1) return 'warn'
  return 'ok'
}

/* ─────────── filtering ─────────── */

export interface GraphFilter {
  search?: string
  namespace?: string | null
  /** Only nodes with errors (and their neighbours). */
  errorsOnly?: boolean
  /** Hide nodes below this served RPS. */
  minRps?: number
}

/** Filter, keeping 1-hop neighbours of matches so edges stay meaningful. */
export function filterGraph(g: Graph, f: GraphFilter): Graph {
  const q = f.search?.trim().toLowerCase()
  const match = (n: GraphNode) =>
    (!q || n.name.toLowerCase().includes(q) || (n.namespace ?? '').toLowerCase().includes(q)) &&
    (!f.namespace || n.namespace === f.namespace) &&
    (!f.errorsOnly || (n.errorPct ?? 0) >= 1) &&
    (!f.minRps || n.rps >= f.minRps)
  const hits = new Set(g.nodes.filter(match).map((n) => n.id))
  if (!q && !f.namespace && !f.errorsOnly && !f.minRps) return g
  const keep = new Set(hits)
  for (const e of g.edges) {
    if (hits.has(e.from)) keep.add(e.to)
    if (hits.has(e.to)) keep.add(e.from)
  }
  return {
    nodes: g.nodes.filter((n) => keep.has(n.id)),
    edges: g.edges.filter((e) => keep.has(e.from) && keep.has(e.to) && (hits.has(e.from) || hits.has(e.to))),
  }
}

/* ─────────── layout ─────────── */

export interface Positioned {
  x: number
  y: number
  layer: number
}

export interface Layout {
  pos: Map<string, Positioned>
  width: number
  height: number
  layers: number
}

export const NODE_W = 168
export const NODE_H = 52
const GAP_X = 150
const GAP_Y = 28
const PAD = 24

/**
 * Layered (Sugiyama-lite) layout:
 *   1. break cycles by DFS (back edges ignored for ranking),
 *   2. rank = longest path from a source,
 *   3. order within a layer by barycentre of neighbours, a few sweeps down and up,
 *   4. place on a grid, centring short layers.
 * Deterministic: ties break on name, so the map does not reshuffle on refetch.
 */
export function layoutGraph(g: Graph): Layout {
  const ids = g.nodes.map((n) => n.id).sort()
  const out = new Map<string, string[]>()
  const inc = new Map<string, string[]>()
  for (const id of ids) {
    out.set(id, [])
    inc.set(id, [])
  }
  // Cycle breaking.
  const state = new Map<string, 0 | 1 | 2>()
  const dag: Array<[string, string]> = []
  const adj = new Map<string, string[]>()
  for (const id of ids) adj.set(id, [])
  for (const e of g.edges) if (adj.has(e.from) && adj.has(e.to) && e.from !== e.to) adj.get(e.from)!.push(e.to)
  for (const v of adj.values()) v.sort()
  const visit = (v: string) => {
    state.set(v, 1)
    for (const w of adj.get(v)!) {
      const s = state.get(w) ?? 0
      if (s === 1) continue // back edge — ignore for ranking
      dag.push([v, w])
      if (s === 0) visit(w)
    }
    state.set(v, 2)
  }
  // Start DFS from true sources first so back edges point upstream.
  const indeg = new Map(ids.map((id) => [id, 0]))
  for (const [, tos] of adj) for (const t of tos) indeg.set(t, (indeg.get(t) ?? 0) + 1)
  for (const id of [...ids].sort((a, b) => (indeg.get(a)! - indeg.get(b)!) || a.localeCompare(b))) {
    if (!state.get(id)) visit(id)
  }
  for (const [a, b] of dag) {
    out.get(a)!.push(b)
    inc.get(b)!.push(a)
  }
  // Longest-path ranking over the DAG (Kahn order).
  const rank = new Map<string, number>()
  const deg = new Map(ids.map((id) => [id, inc.get(id)!.length]))
  const queue = ids.filter((id) => deg.get(id) === 0)
  for (const id of queue) rank.set(id, 0)
  while (queue.length) {
    const v = queue.shift()!
    for (const w of out.get(v)!) {
      rank.set(w, Math.max(rank.get(w) ?? 0, (rank.get(v) ?? 0) + 1))
      deg.set(w, deg.get(w)! - 1)
      if (deg.get(w) === 0) queue.push(w)
    }
  }
  const layers: string[][] = []
  for (const id of ids) {
    const r = rank.get(id) ?? 0
    ;(layers[r] ??= []).push(id)
  }
  for (let i = 0; i < layers.length; i++) layers[i] ??= []
  // Barycentre ordering sweeps.
  const order = new Map<string, number>()
  const reindex = () => layers.forEach((l) => l.forEach((id, i) => order.set(id, i)))
  reindex()
  const bary = (id: string, nbrs: string[]) =>
    nbrs.length ? nbrs.reduce((a, n) => a + (order.get(n) ?? 0), 0) / nbrs.length : (order.get(id) ?? 0)
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let i = 1; i < layers.length; i++) {
      layers[i].sort((a, b) => bary(a, inc.get(a)!) - bary(b, inc.get(b)!) || a.localeCompare(b))
      reindex()
    }
    for (let i = layers.length - 2; i >= 0; i--) {
      layers[i].sort((a, b) => bary(a, out.get(a)!) - bary(b, out.get(b)!) || a.localeCompare(b))
      reindex()
    }
  }
  const tallest = Math.max(1, ...layers.map((l) => l.length))
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * GAP_Y
  const width = PAD * 2 + layers.length * NODE_W + Math.max(0, layers.length - 1) * GAP_X
  const pos = new Map<string, Positioned>()
  layers.forEach((l, li) => {
    const colH = l.length * NODE_H + (l.length - 1) * GAP_Y
    const top = (height - colH) / 2
    l.forEach((id, i) => {
      pos.set(id, { x: PAD + li * (NODE_W + GAP_X), y: top + i * (NODE_H + GAP_Y), layer: li })
    })
  })
  return { pos, width: Math.max(width, NODE_W + PAD * 2), height, layers: layers.length }
}

/** Edge thickness ∝ log(rps), clamped — linear widths let one hot edge swamp the rest. */
export function edgeWidth(rps: number): number {
  if (!(rps > 0)) return 1
  return Math.max(1, Math.min(5, 1 + Math.log10(1 + rps)))
}

/* ─────────── per-node RED (range queries for the side panel) ─────────── */

/**
 * Served-traffic RED for one node, from the same source the graph came from,
 * so the panel's numbers agree with the node on the map.
 */
export function nodeQueries(src: GraphSource, node: { name: string; namespace?: string }, win: string): { rps: string; errPct: string; p95: string } {
  const m = [`${src.server}="${esc(node.name)}"`]
  if (src.serverNs && node.namespace) m.push(`${src.serverNs}="${esc(node.namespace)}"`)
  const s = `{${m.join(', ')}}`
  const e = (extra: string) => `{${[...m, extra].join(', ')}}`
  switch (src.id) {
    case 'tempo':
      return {
        rps: `sum(rate(traces_service_graph_request_total${s}[${win}]))`,
        errPct: `100 * sum(rate(traces_service_graph_request_failed_total${s}[${win}])) / sum(rate(traces_service_graph_request_total${s}[${win}]))`,
        p95: `1000 * histogram_quantile(0.95, sum by (le) (rate(traces_service_graph_request_server_seconds_bucket${s}[${win}])))`,
      }
    case 'istio': {
      const r = [...m, 'reporter="destination"']
      const sr = `{${r.join(', ')}}`
      return {
        rps: `sum(rate(istio_requests_total${sr}[${win}]))`,
        errPct: `100 * sum(rate(istio_requests_total{${[...r, 'response_code=~"5.."'].join(', ')}}[${win}])) / sum(rate(istio_requests_total${sr}[${win}]))`,
        p95: `histogram_quantile(0.95, sum by (le) (rate(istio_request_duration_milliseconds_bucket${sr}[${win}])))`,
      }
    }
    default:
      return {
        rps: `max (sum by (reporter) (rate(hubble_http_requests_total${s}[${win}])))`,
        errPct: `100 * max (sum by (reporter) (rate(hubble_http_requests_total${e('status=~"5.."')}[${win}]))) / max (sum by (reporter) (rate(hubble_http_requests_total${s}[${win}])))`,
        p95: `1000 * histogram_quantile(0.95, sum by (le) (rate(hubble_http_request_duration_seconds_bucket${s}[${win}])))`,
      }
  }
}
