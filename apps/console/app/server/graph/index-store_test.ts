import { assertEquals } from 'jsr:@std/assert'
import { GraphIndex } from './index-store.ts'
import type { Contribution } from './model.ts'

/**
 * The index's job is to stay TRUE as objects churn. Every test here is a way
 * it could quietly stop being true: a shared node deleted too early, a stale
 * node kept too long, a field erased by whichever watch fired last.
 */

const c = (nodes: Contribution['nodes'], edges: Contribution['edges'] = []): Contribution => ({ nodes, edges })

Deno.test('a node shared by two sources survives losing one of them', () => {
  // Ten namespaces contribute the same org node. If deleting any one of them
  // deleted the org, the graph would develop holes during ordinary churn.
  const g = new GraphIndex()
  g.apply('ns/pay', c([{ id: 'org:acme', kind: 'org', name: 'acme' }]))
  g.apply('ns/search', c([{ id: 'org:acme', kind: 'org', name: 'acme' }]))

  g.remove('ns/pay')
  assertEquals(g.has('org:acme'), true, 'still contributed by ns/search')

  g.remove('ns/search')
  assertEquals(g.has('org:acme'), false, 'last contributor gone')
})

Deno.test('a source that stops contributing a node releases it', () => {
  // A workload that changed image must not keep the old one forever.
  const g = new GraphIndex()
  g.apply('wl/api', c([
    { id: 'workload:n/api', kind: 'workload', name: 'api' },
    { id: 'image:a:1', kind: 'image', name: 'a' },
  ], [{ from: 'workload:n/api', to: 'image:a:1', kind: 'uses-image' }]))

  g.apply('wl/api', c([
    { id: 'workload:n/api', kind: 'workload', name: 'api' },
    { id: 'image:a:2', kind: 'image', name: 'a' },
  ], [{ from: 'workload:n/api', to: 'image:a:2', kind: 'uses-image' }]))

  assertEquals(g.has('image:a:1'), false, 'old image released')
  assertEquals(g.has('image:a:2'), true)
  assertEquals(g.allEdges().length, 1)
})

Deno.test('applying the same object twice changes nothing', () => {
  // Resyncs re-apply everything; that has to be free.
  const g = new GraphIndex()
  const contribution = c(
    [{ id: 'pod:n/p', kind: 'pod', name: 'p' }, { id: 'node:n1', kind: 'node', name: 'n1' }],
    [{ from: 'pod:n/p', to: 'node:n1', kind: 'runs-on' }],
  )
  g.apply('pod/n/p', contribution)
  const before = g.stats()
  g.apply('pod/n/p', contribution)
  assertEquals(g.stats().nodes, before.nodes)
  assertEquals(g.stats().edges, before.edges)
})

Deno.test('a richer description does not erase what another source knew', () => {
  // The pod knows the image digest; the Deployment does not. Whichever watch
  // fires last must not delete the other's knowledge.
  const g = new GraphIndex()
  g.apply('pod/p', c([{ id: 'image:a:1', kind: 'image', name: 'a', props: { digest: 'sha256:abc', ref: 'a:1' } }]))
  g.apply('wl/d', c([{ id: 'image:a:1', kind: 'image', name: 'a', props: { ref: 'a:1' } }]))

  assertEquals(g.get('image:a:1')?.props?.digest, 'sha256:abc')
})

Deno.test('an "unknown" status never overwrites a real one', () => {
  const g = new GraphIndex()
  g.apply('a', c([{ id: 'workload:n/api', kind: 'workload', name: 'api', status: 'failed' }]))
  g.apply('b', c([{ id: 'workload:n/api', kind: 'workload', name: 'api', status: 'unknown' }]))
  assertEquals(g.get('workload:n/api')?.status, 'failed')
})

Deno.test('reconcile drops objects deleted while the watch was disconnected', () => {
  // No DELETED frame was ever seen for these. Without reconcile they would
  // linger forever, which is exactly how a live graph becomes a lying graph.
  const g = new GraphIndex()
  g.apply('pod|n/a', c([{ id: 'pod:n/a', kind: 'pod', name: 'a' }]))
  g.apply('pod|n/b', c([{ id: 'pod:n/b', kind: 'pod', name: 'b' }]))
  g.apply('svc|n/s', c([{ id: 'service:n/s', kind: 'service', name: 's' }]))

  const dropped = g.reconcile('pod|', new Set(['pod|n/a']))

  assertEquals(dropped, 1)
  assertEquals(g.has('pod:n/a'), true)
  assertEquals(g.has('pod:n/b'), false)
  // A different source's prefix must be untouched by the pod resync.
  assertEquals(g.has('service:n/s'), true)
})

/* ─────────── traversal ─────────── */

function cluster(): GraphIndex {
  const g = new GraphIndex()
  g.apply('ns', c(
    [{ id: 'namespace:pay', kind: 'namespace', name: 'pay' }, { id: 'org:acme', kind: 'org', name: 'acme' }],
    [{ from: 'namespace:pay', to: 'org:acme', kind: 'belongs-to' }],
  ))
  g.apply('app', c(
    [{ id: 'application:payments', kind: 'application', name: 'payments', status: 'failed' }],
    [{ from: 'application:payments', to: 'workload:pay/api', kind: 'manages' }],
  ))
  g.apply('wl', c(
    [{ id: 'workload:pay/api', kind: 'workload', name: 'api', namespace: 'pay' }],
    [{ from: 'namespace:pay', to: 'workload:pay/api', kind: 'contains' }],
  ))
  g.apply('pod', c(
    [{ id: 'pod:pay/api-x', kind: 'pod', name: 'api-x', namespace: 'pay' }, { id: 'node:n1', kind: 'node', name: 'n1' }],
    [
      { from: 'workload:pay/api', to: 'pod:pay/api-x', kind: 'owns' },
      { from: 'pod:pay/api-x', to: 'node:n1', kind: 'runs-on' },
    ],
  ))
  return g
}

Deno.test('neighbours are returned in both directions', () => {
  // Edge direction encodes meaning, not navigability: "what runs on this node"
  // and "what node does this run on" are one edge asked from two ends.
  const g = cluster()
  const fromPod = g.neighbours('pod:pay/api-x')
  assertEquals(fromPod.length, 2)
  assertEquals(fromPod.find((n) => n.node.id === 'node:n1')?.direction, 'out')
  assertEquals(fromPod.find((n) => n.node.id === 'workload:pay/api')?.direction, 'in')
})

Deno.test('neighbours can be filtered by kind', () => {
  const g = cluster()
  assertEquals(g.neighbours('pod:pay/api-x', { kinds: ['node'] }).length, 1)
})

Deno.test('an edge to a node that does not exist is not returned', () => {
  // Contributions reference nodes other sources own; before that source has
  // listed, the edge points at nothing and must not produce a phantom.
  const g = new GraphIndex()
  g.apply('a', c([{ id: 'pod:n/p', kind: 'pod', name: 'p' }], [{ from: 'pod:n/p', to: 'node:missing', kind: 'runs-on' }]))
  assertEquals(g.neighbours('pod:n/p').length, 0)
})

Deno.test('a path crosses subsystems — the reason the graph exists', () => {
  // "How is this pod related to that Argo CD application" has no answer in any
  // list API. Here it is three hops across three different controllers.
  const g = cluster()
  const p = g.path('pod:pay/api-x', 'application:payments')
  assertEquals(p?.nodes.map((n) => n.id), ['pod:pay/api-x', 'workload:pay/api', 'application:payments'])
  assertEquals(p?.edges.map((e) => e.kind), ['owns', 'manages'])
})

Deno.test('a path to an unreachable or unknown node is null, not empty', () => {
  const g = cluster()
  assertEquals(g.path('pod:pay/api-x', 'node:nope'), null)
  const isolated = new GraphIndex()
  isolated.apply('a', c([{ id: 'a:1', kind: 'pod', name: 'a' }, { id: 'b:1', kind: 'pod', name: 'b' }]))
  assertEquals(isolated.path('a:1', 'b:1'), null)
})

Deno.test('a path to itself is the node alone', () => {
  const g = cluster()
  assertEquals(g.path('node:n1', 'node:n1')?.nodes.length, 1)
  assertEquals(g.path('node:n1', 'node:n1')?.edges.length, 0)
})

Deno.test('subgraph respects depth and is capped by node count', () => {
  const g = cluster()
  assertEquals(g.subgraph('pod:pay/api-x', 1).nodes.length, 3)

  // Depth alone bounds nothing useful — two hops from a namespace is most of
  // a cluster — so the cap is what makes this safe to hand to a model.
  const wide = new GraphIndex()
  wide.apply('hub', c([{ id: 'hub', kind: 'namespace', name: 'h' }]))
  for (let i = 0; i < 50; i++) {
    wide.apply(`p${i}`, c([{ id: `pod:${i}`, kind: 'pod', name: `p${i}` }], [{ from: 'hub', to: `pod:${i}`, kind: 'contains' }]))
  }
  const capped = wide.subgraph('hub', 3, 10)
  assertEquals(capped.truncated, true)
  assertEquals(capped.nodes.length <= 10, true)
})

Deno.test('subgraph edges never dangle outside the returned nodes', () => {
  // A renderer that trusts the edge list would draw an arrow to nothing.
  const g = cluster()
  const sub = g.subgraph('pod:pay/api-x', 1)
  const ids = new Set(sub.nodes.map((n) => n.id))
  assertEquals(sub.edges.every((e) => ids.has(e.from) && ids.has(e.to)), true)
})

Deno.test('subgraph of an unknown node is empty rather than throwing', () => {
  assertEquals(cluster().subgraph('pod:nope', 2).nodes.length, 0)
})

/* ─────────── search ─────────── */

Deno.test('search ranks an exact name above a substring above a prop match', () => {
  const g = new GraphIndex()
  g.apply('a', c([{ id: 'workload:n/checkout', kind: 'workload', name: 'checkout' }]))
  g.apply('b', c([{ id: 'pod:n/checkout-abc', kind: 'pod', name: 'checkout-abc' }]))
  g.apply('c', c([{ id: 'service:n/pay', kind: 'service', name: 'pay', props: { selector: 'app=checkout' } }]))

  const hits = g.search('checkout')
  assertEquals(hits.map((h) => h.id), ['workload:n/checkout', 'pod:n/checkout-abc', 'service:n/pay'])
})

Deno.test('search filters by kind and namespace', () => {
  const g = cluster()
  assertEquals(g.search('api', { kinds: ['pod'] }).map((n) => n.id), ['pod:pay/api-x'])
  assertEquals(g.search('', { namespace: 'pay' }).every((n) => n.namespace === 'pay'), true)
})

Deno.test('stats count what is actually in the graph', () => {
  const g = cluster()
  const s = g.stats()
  assertEquals(s.nodes, 6)
  assertEquals(s.byKind.pod, 1)
  assertEquals(s.byKind.namespace, 1)
})
