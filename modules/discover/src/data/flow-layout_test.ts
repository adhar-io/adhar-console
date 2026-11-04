import { assert, assertEquals } from 'jsr:@std/assert@1'
import { computeLayers, edgeCurve, incrementalLayout, layoutKey, layoutMap, NODE_H, NODE_W, nodeSetKey } from './flow-layout.ts'
import type { MapEdge, MapGraph, MapNode } from './live-flows.ts'

const node = (id: string, extra: Partial<MapNode> = {}): MapNode => {
  const i = id.indexOf('/')
  return {
    id,
    name: i > 0 ? id.slice(i + 1) : id,
    ns: i > 0 ? id.slice(0, i) : undefined,
    kind: id === '~world' ? 'world' : id === '~ingress' ? 'ingress' : 'workload',
    rps: 1,
    cps: 0,
    fps: 0,
    orps: 0,
    ofps: 0,
    err: 0,
    p95: null,
    drops: 0,
    ...extra,
  }
}
const edge = (s: string, d: string): MapEdge => ({ id: `${s}>${d}`, s, d, rps: 1, cps: 0, fps: 0, err: 0, e4: 0, p50: null, p95: null, drops: 0, protos: ['http'], ports: [] })

const G: MapGraph = {
  nodes: ['~world', '~ingress', 'shop/web', 'shop/cart', 'shop/redis', 'pay/api', 'pay/db'].map((id) => node(id)),
  edges: [edge('~world', '~ingress'), edge('~ingress', 'shop/web'), edge('shop/web', 'shop/cart'), edge('shop/cart', 'shop/redis'), edge('shop/cart', 'pay/api'), edge('pay/api', 'pay/db')],
}

Deno.test('layers follow the call chain; entries lead', () => {
  const l = computeLayers(G)
  assertEquals(l.get('~world'), 0)
  assertEquals(l.get('~ingress'), 0)
  assertEquals(l.get('shop/web'), 1)
  assertEquals(l.get('shop/cart'), 2)
  assertEquals(l.get('pay/api'), 3)
  assertEquals(l.get('pay/db'), 4)
})

Deno.test('cycles do not inflate layers', () => {
  const g: MapGraph = { nodes: ['a/x', 'a/y', 'a/z'].map((id) => node(id)), edges: [edge('a/x', 'a/y'), edge('a/y', 'a/z'), edge('a/z', 'a/x')] }
  const l = computeLayers(g)
  assertEquals(Math.max(...l.values()), 2)
})

Deno.test('namespace groups contain their nodes and never overlap', () => {
  const lay = layoutMap(G)
  assertEquals(lay.groups.map((g) => g.ns).sort(), ['pay', 'shop'])
  for (const grp of lay.groups) {
    for (const n of G.nodes.filter((x) => x.ns === grp.ns)) {
      const p = lay.pos.get(n.id)!
      assert(p.x >= grp.x && p.x + NODE_W <= grp.x + grp.w, `${n.id} inside ${grp.ns} horizontally`)
      assert(p.y >= grp.y && p.y + NODE_H <= grp.y + grp.h, `${n.id} inside ${grp.ns} vertically`)
    }
  }
  const [a, b] = lay.groups
  const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  assert(!overlap)
  // Callers sit left of callees inside a namespace; entry points lead.
  assert(lay.pos.get('shop/web')!.x < lay.pos.get('shop/cart')!.x)
  assert(lay.pos.get('~world')!.x < Math.min(...lay.groups.map((g) => g.x)))
  assert(lay.width > 0 && lay.height > 0)
})

Deno.test('a namespace with many workloads becomes wide and short, not a tower', () => {
  const big: MapGraph = {
    nodes: [node('~ingress'), ...Array.from({ length: 100 }, (_, i) => node(`sys/w${i}`))],
    edges: Array.from({ length: 100 }, (_, i) => edge('~ingress', `sys/w${i}`)),
  }
  const lay = layoutMap(big)
  const g = lay.groups[0]
  assert(g.w > g.h, `frame ${g.w}x${g.h} should be wider than tall`)
  assert(g.w / g.h < 3, 'but not a ribbon either')
})

Deno.test('many namespaces pack into rows rather than one long strip', () => {
  const nss = Array.from({ length: 12 }, (_, i) => `ns${i}`)
  const g: MapGraph = {
    nodes: [node('~ingress'), ...nss.flatMap((n) => [node(`${n}/a`), node(`${n}/b`)])],
    edges: nss.flatMap((n) => [edge('~ingress', `${n}/a`), edge(`${n}/a`, `${n}/b`)]),
  }
  const lay = layoutMap(g)
  const ratio = lay.width / lay.height
  assert(ratio < 4 && ratio > 0.5, `aspect ${ratio.toFixed(2)}`)
  for (let i = 0; i < lay.groups.length; i++) {
    for (let j = i + 1; j < lay.groups.length; j++) {
      const a = lay.groups[i]
      const b = lay.groups[j]
      assert(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), 'frames overlap')
    }
  }
})

Deno.test('no two nodes share a slot', () => {
  const big: MapGraph = {
    nodes: [node('~ingress'), ...Array.from({ length: 12 }, (_, i) => node(`ns${i % 3}/svc${i}`))],
    edges: Array.from({ length: 12 }, (_, i) => edge('~ingress', `ns${i % 3}/svc${i}`)),
  }
  const lay = layoutMap(big)
  const pts = [...lay.pos.values()]
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i]
      const b = pts[j]
      assert(!(Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H), 'overlap')
    }
  }
})

Deno.test('stable: previous vertical order is kept when a node is added', () => {
  const g: MapGraph = { nodes: [node('~ingress'), node('a/zeta'), node('a/alpha')], edges: [edge('~ingress', 'a/zeta'), edge('~ingress', 'a/alpha')] }
  const first = layoutMap(g)
  // Pretend the user saw zeta above alpha.
  const prev = new Map(first.pos)
  prev.set('a/zeta', { x: 0, y: 0 })
  prev.set('a/alpha', { x: 0, y: 100 })
  const g2: MapGraph = { nodes: [...g.nodes, node('a/beta')], edges: [...g.edges, edge('~ingress', 'a/beta')] }
  const second = layoutMap(g2, { prev })
  const y = (id: string) => second.pos.get(id)!.y
  assert(y('a/zeta') < y('a/alpha'))
  assert(y('a/alpha') < y('a/beta'), 'new node goes after existing ones')
})

Deno.test('pinned nodes keep their position and stretch their group', () => {
  const pinned = new Map([['shop/cart', { x: 2000, y: 900 }]])
  const lay = layoutMap(G, { pinned })
  assertEquals(lay.pos.get('shop/cart'), { x: 2000, y: 900 })
  const shop = lay.groups.find((g) => g.ns === 'shop')!
  assert(shop.x + shop.w >= 2000 + NODE_W)
  assert(lay.width >= 2000 + NODE_W)
})

Deno.test('layoutKey changes with structure, not with rates', () => {
  const k = layoutKey(G)
  assertEquals(layoutKey({ ...G, nodes: G.nodes.map((n) => ({ ...n, rps: 99 })) }), k)
  assert(layoutKey({ ...G, edges: G.edges.slice(1) }) !== k)
})

Deno.test('edge curves: forward edges run right to left side, back edges loop under', () => {
  const f = edgeCurve({ x: 0, y: 0 }, { x: 400, y: 100 })
  assertEquals([f.x0, f.y0], [NODE_W, NODE_H / 2])
  assertEquals(f.x3, 397)
  const b = edgeCurve({ x: 400, y: 0 }, { x: 0, y: 0 })
  assert(b.y1 > NODE_H && b.y2 > NODE_H)
})

Deno.test('a long call chain folds into bands instead of a ribbon', () => {
  const chain = Array.from({ length: 9 }, (_, i) => `obs/s${i}`)
  const g: MapGraph = {
    nodes: chain.map((id) => node(id)),
    edges: chain.slice(1).map((id, i) => edge(chain[i], id)),
  }
  const lay = layoutMap(g)
  const grp = lay.groups[0]
  assert(grp.w / grp.h < 4, `chain frame ${grp.w}x${grp.h}`)
  const ys = new Set(chain.map((id) => lay.pos.get(id)!.y))
  assert(ys.size > 1, 'spans more than one band')
  // Still left → right within a band: s0 before s1.
  assert(lay.pos.get('obs/s0')!.x < lay.pos.get('obs/s1')!.x)
})

Deno.test('incremental: existing nodes never move; removals leave their slot', () => {
  const first = layoutMap(G)
  const fewer: MapGraph = { nodes: G.nodes.filter((n) => n.id !== 'shop/redis'), edges: G.edges.filter((e) => e.d !== 'shop/redis') }
  const r = incrementalLayout(fewer, first)!
  assertEquals(r.provisional, 0)
  for (const n of fewer.nodes) assertEquals(r.layout.pos.get(n.id), first.pos.get(n.id))
})

Deno.test('incremental: new nodes join their namespace frame without moving anyone', () => {
  const first = layoutMap(G)
  const more: MapGraph = { nodes: [...G.nodes, node('shop/search'), node('pay/fraud')], edges: [...G.edges, edge('shop/web', 'shop/search'), edge('pay/api', 'pay/fraud')] }
  const r = incrementalLayout(more, first)!
  assertEquals(r.provisional, 2)
  for (const n of G.nodes) assertEquals(r.layout.pos.get(n.id), first.pos.get(n.id))
  const shop = r.layout.groups.find((g) => g.ns === 'shop')!
  const p = r.layout.pos.get('shop/search')!
  assert(p.x >= shop.x && p.x + NODE_W <= shop.x + shop.w && p.y >= shop.y && p.y + NODE_H <= shop.y + shop.h)
  const pts = [...r.layout.pos.values()]
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) assert(!(Math.abs(pts[i].x - pts[j].x) < NODE_W && Math.abs(pts[i].y - pts[j].y) < NODE_H), 'overlap')
  }
})

Deno.test('incremental: a new namespace or lane asks for a full layout', () => {
  const first = layoutMap(G)
  assertEquals(incrementalLayout({ nodes: [...G.nodes, node('newns/x')], edges: G.edges }, first), null)
  assertEquals(incrementalLayout({ nodes: [...G.nodes, node('~kube-apiserver', { kind: 'apiserver', ns: undefined })], edges: G.edges }, first), null)
})

Deno.test('nodeSetKey ignores edges', () => {
  assertEquals(nodeSetKey(G), nodeSetKey({ ...G, edges: [] }))
  assert(nodeSetKey(G) !== nodeSetKey({ ...G, nodes: G.nodes.slice(1) }))
})

Deno.test('incremental: a batch of newcomers stays inside the frame width', () => {
  const first = layoutMap(G)
  const extra = Array.from({ length: 10 }, (_, i) => node(`shop/new${i}`))
  const more: MapGraph = { nodes: [...G.nodes, ...extra], edges: G.edges }
  const r = incrementalLayout(more, first)!
  const shopBefore = first.groups.find((g) => g.ns === 'shop')!
  for (const n of extra) assert(r.layout.pos.get(n.id)!.x <= shopBefore.x + shopBefore.w, `${n.id} ran off to the right`)
})

Deno.test('full layout puts infrastructure in a lane right of the frames', () => {
  const g: MapGraph = {
    nodes: [node('dev/a'), node('dev/b'), node('~restricted', { kind: 'restricted', ns: undefined }), node('~kube-apiserver', { kind: 'apiserver', ns: undefined })],
    edges: [edge('dev/a', 'dev/b'), edge('dev/a', '~restricted'), edge('dev/b', '~kube-apiserver')],
  }
  const lay = layoutMap(g)
  const frame = lay.groups.find((x) => x.ns === 'dev')!
  for (const id of ['~restricted', '~kube-apiserver']) assert(lay.pos.get(id)!.x > frame.x + frame.w, `${id} sits right of the frame`)
})
