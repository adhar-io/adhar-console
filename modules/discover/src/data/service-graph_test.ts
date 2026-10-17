import { assert, assertEquals } from 'jsr:@std/assert@1'
import { buildGraph, edgeWidth, filterGraph, GRAPH_SOURCES, layoutGraph, NODE_H, nodeHealth } from './service-graph.ts'

const tempo = GRAPH_SOURCES.find((s) => s.id === 'tempo')!
const hubble = GRAPH_SOURCES.find((s) => s.id === 'hubble')!
const e = (client: string, server: string, value: number) => ({ metric: { client, server }, value })

Deno.test('buildGraph aggregates served traffic, errors and p95 per node', () => {
  const g = buildGraph(
    tempo,
    [e('user', 'frontend', 10), e('frontend', 'cart', 6), e('frontend', 'catalog', 4), e('cart', 'redis', 6)],
    [e('frontend', 'cart', 0.6)],
    [e('frontend', 'cart', 120), e('user', 'frontend', 80)],
  )
  assertEquals(g.nodes.length, 5)
  assertEquals(g.edges.length, 4)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  assertEquals(byId.get('cart')!.rps, 6)
  assertEquals(byId.get('cart')!.errorPct, 10)
  assertEquals(byId.get('cart')!.p95Ms, 120)
  // A pure client reports what it sends and has no error rate of its own.
  assertEquals(byId.get('user')!.clientOnly, true)
  assertEquals(byId.get('user')!.rps, 10)
  assertEquals(byId.get('user')!.errorPct, null)
  assertEquals(nodeHealth(byId.get('cart')!), 'crit')
  assertEquals(nodeHealth(byId.get('user')!), 'none')
  assertEquals(nodeHealth(byId.get('catalog')!), 'ok')
})

Deno.test('buildGraph drops zero-rate edges and unknown servers; maps unknown clients to external', () => {
  const g = buildGraph(tempo, [e('', 'api', 3), e('api', '', 2), e('api', 'db', 0)], [], [])
  assertEquals(g.edges.map((x) => x.id), ['external->api'])
})

Deno.test('namespaced sources key nodes by namespace/name', () => {
  const s = (sw: string, sn: string, dw: string, dn: string, value: number) => ({
    metric: { source_workload: sw, source_namespace: sn, destination_workload: dw, destination_namespace: dn },
    value,
  })
  const g = buildGraph(hubble, [s('web', 'a', 'api', 'b', 1), s('web', 'c', 'api', 'b', 1)], [], [])
  assertEquals(g.nodes.map((n) => n.id).sort(), ['a/web', 'b/api', 'c/web'])
  assertEquals(g.nodes.find((n) => n.id === 'b/api')!.rps, 2)
})

Deno.test('hubble queries filter on the namespace and de-duplicate reporters', () => {
  const q = hubble.queries('5m', 'shop')
  assert(q.rps.includes('destination_namespace="shop"'), q.rps)
  assert(q.rps.startsWith('max by ('), q.rps)
})

Deno.test('filterGraph keeps matches plus one-hop neighbours', () => {
  const g = buildGraph(tempo, [e('a', 'b', 1), e('b', 'c', 1), e('c', 'd', 1)], [], [])
  const f = filterGraph(g, { search: 'c' })
  assertEquals(f.nodes.map((n) => n.id).sort(), ['b', 'c', 'd'])
  assertEquals(f.edges.map((x) => x.id).sort(), ['b->c', 'c->d'])
  assertEquals(filterGraph(g, {}), g)
})

Deno.test('layoutGraph ranks by longest path, survives cycles and does not overlap', () => {
  const g = buildGraph(tempo, [e('a', 'b', 1), e('b', 'c', 1), e('a', 'c', 1), e('c', 'b', 1), e('c', 'd', 1)], [], [])
  const l = layoutGraph(g)
  const a = l.pos.get('a')!
  const d = l.pos.get('d')!
  assertEquals(a.layer, 0)
  assert(d.layer > a.layer)
  // No two nodes share a slot.
  const pts = [...l.pos.values()]
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const overlap = pts[i].x === pts[j].x && Math.abs(pts[i].y - pts[j].y) < NODE_H
      assert(!overlap, 'overlapping nodes')
    }
  }
  // Deterministic.
  assertEquals([...layoutGraph(g).pos.entries()], [...l.pos.entries()])
})

Deno.test('edgeWidth is log-scaled and clamped', () => {
  assertEquals(edgeWidth(0), 1)
  assert(edgeWidth(10) > edgeWidth(1))
  assertEquals(edgeWidth(1e9), 5)
})
