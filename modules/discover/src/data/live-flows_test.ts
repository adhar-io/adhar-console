import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  activity,
  applyFilters,
  bezierAt,
  collapseNamespaces,
  edgeEnds,
  emissionRate,
  errHealth,
  type FlowsFrame,
  formatMs,
  formatPct,
  formatRate,
  fromFrame,
  fromPromGraph,
  guessKind,
  type MapEdge,
  mapEdgeHealth,
  type MapGraph,
  mapNodeHealth,
  type MapNode,
  neighbourhood,
  newRetained,
  primaryRate,
  retain,
  splitId,
  strokeWidth,
  travelMs,
  withTopology,
} from './live-flows.ts'
import { buildGraph, GRAPH_SOURCES } from './service-graph.ts'

const node = (id: string, extra: Partial<MapNode> = {}): MapNode => {
  const [ns, name] = id.includes('/') ? id.split('/') : [undefined, id]
  return { id, name, ns, kind: 'workload', rps: 1, cps: 0, fps: 1, orps: 0, ofps: 0, err: 0, p95: 10, drops: 0, ...extra }
}
const edge = (s: string, d: string, extra: Partial<MapEdge> = {}): MapEdge => ({
  id: `${s}>${d}`,
  s,
  d,
  rps: 1,
  cps: 0,
  fps: 1,
  err: 0,
  e4: 0,
  p50: 5,
  p95: 10,
  drops: 0,
  protos: ['http'],
  ports: [80],
  ...extra,
})

const G: MapGraph = {
  nodes: [node('~world', { kind: 'world', name: 'External', ns: undefined }), node('shop/web'), node('shop/cart'), node('shop/redis', { kind: 'cache' }), node('finance/ledger')],
  edges: [
    edge('~world', 'shop/web'),
    edge('shop/web', 'shop/cart', { err: 7 }),
    edge('shop/cart', 'shop/redis', { protos: ['tcp'], rps: 0, cps: 2 }),
    edge('shop/web', 'finance/ledger', { drops: 0.5, rps: 0, fps: 0.5 }),
  ],
}

Deno.test('fromFrame maps the compact wire shape', () => {
  const f = {
    nodes: [{ id: 'a/x', n: 'x', ns: 'a', k: 'database', rps: 1, cps: 0, fps: 2, orps: 0, ofps: 0, err: 1.5, p95: 3, drops: 0 }],
    edges: [],
  } as unknown as FlowsFrame
  assertEquals(fromFrame(f).nodes[0], { id: 'a/x', name: 'x', ns: 'a', kind: 'database', rps: 1, cps: 0, fps: 2, orps: 0, ofps: 0, err: 1.5, p95: 3, drops: 0 })
})

Deno.test('fromFrame restores fields the hub omitted', () => {
  const f = { nodes: [{ id: 'a/x', n: 'x', ns: 'a', k: 'workload', fps: 2 }], edges: [{ id: 'a>b', s: 'a', d: 'b', fps: 1 }] } as unknown as FlowsFrame
  const g = fromFrame(f)
  assertEquals(g.nodes[0].rps, 0)
  assertEquals(g.nodes[0].err, null)
  assertEquals(g.edges[0], { id: 'a>b', s: 'a', d: 'b', rps: 0, cps: 0, fps: 1, err: null, e4: null, p50: null, p95: null, drops: 0, protos: [], ports: [] })
})

Deno.test('fromPromGraph keeps client-only nodes as senders', () => {
  const tempo = GRAPH_SOURCES[0]
  const g = buildGraph(tempo, [{ metric: { client: 'user', server: 'web' }, value: 4 }], [], [])
  const m = fromPromGraph(g)
  assertEquals(m.edges[0].id, 'user>web')
  const user = m.nodes.find((n) => n.id === 'user')!
  assertEquals(user.rps, 0)
  assertEquals(user.orps, 4)
})

Deno.test('health: errors, drops, idle', () => {
  assertEquals(errHealth(null), 'none')
  assertEquals(errHealth(0.2), 'ok')
  assertEquals(errHealth(2), 'warn')
  assertEquals(errHealth(5), 'crit')
  assertEquals(mapNodeHealth({ err: null, drops: 1 }), 'warn')
  assertEquals(mapNodeHealth({ err: 9, drops: 0, idle: true }), 'none')
  assertEquals(mapEdgeHealth({ err: null, drops: 1, rps: 0, fps: 1, cps: 0 }), 'crit', 'only drops')
  assertEquals(mapEdgeHealth({ err: null, drops: 1, rps: 0, fps: 5, cps: 0 }), 'warn')
})

Deno.test('primaryRate picks the most meaningful unit', () => {
  assertEquals(primaryRate({ rps: 2, cps: 5, fps: 9 }), { value: 2, unit: 'req/s' })
  assertEquals(primaryRate({ rps: 0, cps: 5, fps: 9 }), { value: 5, unit: 'conn/s' })
  assertEquals(primaryRate({ rps: 0, cps: 0, fps: 9 }), { value: 9, unit: 'flows/s' })
  assertEquals(activity({ rps: 0, cps: 0, fps: 8, drops: 1 }), 4)
})

Deno.test('formatters', () => {
  assertEquals(formatRate(0), '0')
  assertEquals(formatRate(0.004), '<0.01')
  assertEquals(formatRate(0.25), '0.25')
  assertEquals(formatRate(12.34), '12.3')
  assertEquals(formatRate(1234), '1.2k')
  assertEquals(formatMs(null), '—')
  assertEquals(formatMs(0.5), '500µs')
  assertEquals(formatMs(42.4), '42ms')
  assertEquals(formatMs(1500), '1.5s')
  assertEquals(formatPct(0), '0%')
  assertEquals(formatPct(0.05), '<0.1%')
  assertEquals(formatPct(3.21), '3.2%')
  assert(strokeWidth(0) < strokeWidth(10) && strokeWidth(10) < strokeWidth(1e6) && strokeWidth(1e9) === 6)
})

Deno.test('search keeps matches and their direct neighbours', () => {
  const r = applyFilters(G, { search: 'cart' })
  assertEquals(r.nodes.map((n) => n.id).sort(), ['shop/cart', 'shop/redis', 'shop/web'])
  assertEquals(r.edges.map((e) => e.id).sort(), ['shop/cart>shop/redis', 'shop/web>shop/cart'])
})

Deno.test('errors only keeps failing and dropping edges', () => {
  const r = applyFilters(G, { errorsOnly: true })
  assertEquals(r.edges.map((e) => e.id).sort(), ['shop/web>finance/ledger', 'shop/web>shop/cart'])
  const noDrops = applyFilters(G, { errorsOnly: true, showDrops: false })
  assertEquals(noDrops.edges.map((e) => e.id), ['shop/web>shop/cart'])
})

Deno.test('hiding drops removes drop-only edges and clears drop marks', () => {
  const r = applyFilters(G, { showDrops: false })
  assert(!r.edges.some((e) => e.id === 'shop/web>finance/ledger'))
  assert(r.edges.every((e) => e.drops === 0))
})

Deno.test('hiding idle drops idle nodes not on a live edge', () => {
  const g = { nodes: [...G.nodes, node('shop/idle', { idle: true })], edges: G.edges }
  assert(!applyFilters(g, { showIdle: false }).nodes.some((n) => n.id === 'shop/idle'))
  assert(applyFilters(g, {}).nodes.some((n) => n.id === 'shop/idle'))
})

Deno.test('neighbourhood is the 1-hop set', () => {
  assertEquals([...neighbourhood(G, 'shop/web')!].sort(), ['finance/ledger', 'shop/cart', 'shop/web', '~world'])
  assertEquals(neighbourhood(G, null), null)
})

Deno.test('collapsing a namespace merges its nodes and edges', () => {
  const c = collapseNamespaces(G, new Set(['shop']))
  const grp = c.nodes.find((n) => n.id === 'ns:shop')!
  assertEquals(grp.members, 3)
  assertEquals(grp.kind, 'namespace')
  assertEquals(c.edges.map((e) => e.id).sort(), ['ns:shop>finance/ledger', '~world>ns:shop'])
  assertEquals(grp.rps, 1, 'serves what comes from outside')
  assertEquals(collapseNamespaces(G, new Set()), G)
})

Deno.test('topology adds idle workloads only in scope', () => {
  const g = withTopology(G, [{ ns: 'shop', name: 'web' }, { ns: 'shop', name: 'worker' }, { ns: 'other', name: 'x' }], new Set(['shop']))
  assertEquals(g.nodes.filter((n) => n.idle).map((n) => n.id), ['shop/worker'])
  assertEquals(withTopology(G, [{ ns: 'shop', name: 'worker' }], new Set()), G)
})

Deno.test('retention keeps quiet nodes and edges as idle for the grace period', () => {
  const r = newRetained()
  retain(r, G, 0, 10_000)
  const later = retain(r, { nodes: G.nodes.slice(0, 3), edges: G.edges.slice(0, 2) }, 5_000, 10_000)
  const redis = later.nodes.find((n) => n.id === 'shop/redis')!
  assert(redis.idle)
  assertEquals(redis.rps, 0)
  assert(later.edges.find((e) => e.id === 'shop/cart>shop/redis')!.idle)
  const gone = retain(r, { nodes: G.nodes.slice(0, 3), edges: G.edges.slice(0, 2) }, 20_000, 10_000)
  assert(!gone.nodes.some((n) => n.id === 'shop/redis'))
  assert(!gone.edges.some((e) => e.id === 'shop/cart>shop/redis'))
})

Deno.test('ids', () => {
  assertEquals(edgeEnds('a/b>c/d'), { s: 'a/b', d: 'c/d' })
  assertEquals(edgeEnds('nope'), null)
  assertEquals(splitId('shop/web'), { ns: 'shop', name: 'web' })
  assertEquals(splitId('~world'), { name: 'world' })
  assertEquals(splitId('ns:shop'), { name: 'shop' })
})

Deno.test('guessKind', () => {
  assertEquals(guessKind('orders-postgresql'), 'database')
  assertEquals(guessKind('session-redis'), 'cache')
  assertEquals(guessKind('kube-dns'), 'dns')
  assertEquals(guessKind('web'), 'workload')
  assertEquals(guessKind('postgres-operator'), 'workload')
})

Deno.test('particles: busier edges emit more, travel faster, both bounded', () => {
  assertEquals(emissionRate(0), 0)
  assert(emissionRate(1) < emissionRate(100))
  assertEquals(emissionRate(1e9), 9)
  assert(travelMs(1) > travelMs(1000))
  assertEquals(travelMs(1e12), 900)
  const b = { x0: 0, y0: 0, x1: 10, y1: 0, x2: 20, y2: 0, x3: 30, y3: 0 }
  assertEquals(bezierAt(b, 0), { x: 0, y: 0 })
  assertEquals(bezierAt(b, 1), { x: 30, y: 0 })
  assertEquals(bezierAt(b, 0.5).x, 15)
})

Deno.test('hiding node traffic removes the host node, its edges and probe-only workloads', () => {
  const g: MapGraph = {
    nodes: [node('~nodes', { kind: 'host', name: 'Cluster nodes', ns: undefined }), node('shop/web'), node('shop/cart'), node('shop/probed-only'), node('shop/quiet', { idle: true })],
    edges: [edge('~nodes', 'shop/web'), edge('~nodes', 'shop/probed-only'), edge('shop/web', 'shop/cart')],
  }
  const r = applyFilters(g, { showHosts: false })
  assertEquals(r.nodes.map((n) => n.id).sort(), ['shop/cart', 'shop/quiet', 'shop/web'])
  assertEquals(r.edges.map((e) => e.id), ['shop/web>shop/cart'])
  assertEquals(applyFilters(g, {}).nodes.length, 5)
})
