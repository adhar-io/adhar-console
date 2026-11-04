import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  classifyKind,
  cleanPath,
  endpointNode,
  FlowAggregator,
  type FlowEvent,
  normalizeFlow,
  quantile,
  RESTRICTED,
  workloadName,
} from './aggregate.ts'
import { decodeGetFlowsResponse, type HubbleFlow } from './proto-wire.ts'
import { encodeResponse, type FlowSpec, pod } from './testing.ts'

const T0 = 1_793_721_000_000

function flow(spec: FlowSpec): HubbleFlow {
  const r = decodeGetFlowsResponse(encodeResponse(spec))
  if (r.kind !== 'flow') throw new Error('not a flow')
  return r.flow
}

const web = pod('shop', 'web-7d9f8c6b5-k2m4n', 'web')
const cart = pod('shop', 'cart-6b7c9d8f4-x2x9k', 'cart')
const ledger = pod('finance', 'ledger-5c6d7f8b9-abcde', 'ledger')

/** An HTTP response (server → client on the wire) for client → server. */
function httpResp(t: number, client = web, server = cart, code = 200, latencyMs = 10, sport = 50_000): FlowSpec {
  return {
    timeMs: t,
    ipSrc: '10.0.0.2',
    ipDst: '10.0.0.1',
    tcp: { sport: 8080, dport: sport },
    src: server,
    dst: client,
    l7: { type: 2, latencyNs: latencyMs * 1e6, http: { code, method: 'GET', url: `/api/items/123?x=${t}` } },
  }
}

function syn(t: number, client = web, server = cart, sport = 40_000): FlowSpec {
  return { timeMs: t, ipSrc: '10.0.0.1', ipDst: '10.0.0.2', tcp: { sport, dport: 8080, syn: true }, src: client, dst: server, isReply: false }
}

function agg(now: () => number) {
  return new FlowAggregator({ now, feedSampleL4: 1 })
}

/* ─────────── identity ─────────── */

Deno.test('workloadName: owner, pod-name heuristics, labels', () => {
  assertEquals(workloadName({ workloads: [{ name: 'api-6b7c9d8f4', kind: 'ReplicaSet' }], podName: '', labels: [] }), 'api')
  assertEquals(workloadName({ workloads: [{ name: 'pg', kind: 'StatefulSet' }], podName: 'pg-0', labels: [] }), 'pg')
  assertEquals(workloadName({ workloads: [], podName: 'gitea-774d585dcf-9n8lh', labels: [] }), 'gitea')
  assertEquals(workloadName({ workloads: [], podName: 'alloy-gkqz5', labels: [] }), 'alloy')
  assertEquals(workloadName({ workloads: [], podName: 'console-db-1', labels: [] }), 'console-db')
  assertEquals(
    workloadName({ workloads: [], podName: 'py-service-685bc9dbb9-4v2xm', labels: ['k8s:rollouts-pod-template-hash=685bc9dbb9'] }),
    'py-service',
  )
  assertEquals(workloadName({ workloads: [], podName: '', labels: ['k8s:app.kubernetes.io/name=alloy'] }), 'alloy')
})

Deno.test('classifyKind recognises data stores by name, component and port', () => {
  assertEquals(classifyKind('orders-postgresql'), 'database')
  assertEquals(classifyKind('console-db'), 'database')
  assertEquals(classifyKind('session-redis'), 'cache')
  assertEquals(classifyKind('adhar-kafka-kafka'), 'queue')
  assertEquals(classifyKind('coredns'), 'dns')
  assertEquals(classifyKind('store', [], 5432), 'database')
  assertEquals(classifyKind('store', [], 6379), 'cache')
  assertEquals(classifyKind('x', ['k8s:app.kubernetes.io/component=database']), 'database')
  assertEquals(classifyKind('web'), 'workload')
  assertEquals(classifyKind('opensearch-operator'), 'workload', 'an operator is not the store')
  assertEquals(classifyKind('redis-exporter'), 'workload')
  assertEquals(classifyKind('opensearch-nodes'), 'database')
})

Deno.test('endpointNode maps reserved identities to entry nodes', () => {
  const r = (labels: string[], identity = 0) => endpointNode({ identity, namespace: '', labels, podName: '', workloads: [] }, '')
  assertEquals(r(['reserved:world']).id, '~world')
  assertEquals(r(['reserved:world-ipv4']).id, '~world')
  assertEquals(r(['reserved:ingress']).id, '~ingress')
  assertEquals(r(['reserved:host']).id, '~nodes')
  assertEquals(r(['reserved:remote-node']).id, '~nodes')
  assertEquals(r(['reserved:kube-apiserver']).id, '~kube-apiserver')
  assertEquals(r(['reserved:unmanaged']).id, '~unmanaged')
  assertEquals(endpointNode(null, '8.8.8.8').id, '~world')
  assertEquals(endpointNode(null, '10.1.2.3').id, '~unmanaged')
  const w = endpointNode({ identity: 5, namespace: 'shop', labels: [], podName: 'cart-6b7c9d8f4-x2x9k', workloads: [] }, '')
  assertEquals(w, { id: 'shop/cart', name: 'cart', ns: 'shop', kind: 'workload' })
})

Deno.test('cleanPath strips query strings and collapses ids', () => {
  assertEquals(cleanPath('https://h/api/v1/repos/adhar/x/raw/project.toml?ref=main'), '/api/v1/repos/adhar/x/raw/project.toml')
  assertEquals(cleanPath('/users/12345/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6'), '/users/:id/orders/:id')
  assertEquals(cleanPath('/a?token=secret'), '/a')
})

/* ─────────── normalisation ─────────── */

Deno.test('L7 responses are re-oriented client → server; requests are skipped', () => {
  const ev = normalizeFlow(flow(httpResp(T0, web, cart, 503, 25)))!
  assertEquals(ev.src.id, 'shop/web')
  assertEquals(ev.dst.id, 'shop/cart')
  assertEquals(ev.port, 8080)
  assertEquals(ev.proto, 'http')
  assertEquals(ev.req, { method: 'GET', path: '/api/items/:id', status: 503, latencyMs: 25, error: true })
  const req = normalizeFlow(flow({ timeMs: T0, src: web, dst: cart, l7: { type: 1, http: { method: 'GET', url: '/' } } }))
  assertEquals(req, null)
})

Deno.test('gRPC is told apart from HTTP by HTTP/2 + /pkg.Service/Method', () => {
  const ev = normalizeFlow(flow({ ...httpResp(T0), l7: { type: 2, http: { code: 200, method: 'POST', url: '/shop.Cart/AddItem', protocol: 'HTTP/2' } } }))!
  assertEquals(ev.proto, 'grpc')
})

Deno.test('SYN marks a new connection; reply packets are flipped and not new', () => {
  const s = normalizeFlow(flow(syn(T0)))!
  assert(s.newConn)
  assertEquals(s.src.id, 'shop/web')
  const reply = normalizeFlow(flow({ timeMs: T0, tcp: { sport: 8080, dport: 40_000, syn: true, ack: true }, src: cart, dst: web, isReply: true }))!
  assert(!reply.newConn)
  assert(reply.reply)
  assertEquals(reply.src.id, 'shop/web')
  assertEquals(reply.dst.id, 'shop/cart')
})

Deno.test('DNS on port 53 and its errors; NXDOMAIN is not an error', () => {
  const coredns = pod('kube-system', 'coredns-5d78c9869d-abcde', 'coredns')
  const mk = (rcode: number) =>
    normalizeFlow(flow({ timeMs: T0, udp: { sport: 53, dport: 33_000 }, src: coredns, dst: web, l7: { type: 2, dns: { query: 'cart.shop.svc.cluster.local.', rcode } } }))!
  assertEquals(mk(0).proto, 'dns')
  assertEquals(mk(0).dst.kind, 'dns')
  assertEquals(mk(0).req?.query, 'cart.shop.svc.cluster.local')
  assertEquals(mk(3).req?.error, false)
  assertEquals(mk(2).req?.error, true)
})

Deno.test('drops carry a readable reason', () => {
  const ev = normalizeFlow(flow({ ...syn(T0), verdict: 2, dropReason: 133 }))!
  assertEquals(ev.verdict, 'drop')
  assertEquals(ev.dropReason, 'Policy denied')
})

/* ─────────── aggregation ─────────── */

Deno.test('rates, errors and latency quantiles over the window', () => {
  // The window is the last N seconds including the current one.
  let now = T0 + 59_000
  const a = agg(() => now)
  for (let i = 0; i < 60; i++) {
    const code = i < 3 ? 500 : i < 6 ? 404 : 200
    a.add(normalizeFlow(flow(httpResp(T0 + i * 1000, web, cart, code, i + 1, 50_000 + i)))!)
  }
  const f = a.snapshot({ windowS: 60, allow: '*' })
  assertEquals(f.edges.length, 1)
  const e = f.edges[0]
  assertEquals(e.id, 'shop/web>shop/cart')
  assertEquals(e.rps, 1)
  assertEquals(e.err, 5)
  assertEquals(e.e4, 5)
  assertEquals(e.p50, 30)
  assertEquals(e.p95, 57)
  assertEquals(f.totals.rps, 1)
  assertEquals(f.totals.err, 5)
  assertEquals(f.totals.services, 2)
  const cartNode = f.nodes.find((n) => n.id === 'shop/cart')!
  assertEquals(cartNode.rps, 1)
  assertEquals(cartNode.err, 5)
  const webNode = f.nodes.find((n) => n.id === 'shop/web')!
  assertEquals(webNode.orps, 1)
  assertEquals(webNode.rps, 0)
  // A 15s window only sees the last 15 requests.
  const short = a.snapshot({ windowS: 15, allow: '*' })
  assertEquals(short.edges[0].rps, 1)
  assertEquals(short.edges[0].err, 0)
  now += 400_000
  a.prune()
  assertEquals(a.snapshot({ windowS: 300, allow: '*' }).edges.length, 0)
  assertEquals(a.edges.size, 0)
})

Deno.test('the same request seen at both observation points counts once', () => {
  const now = T0 + 1000
  const a = agg(() => now)
  const resp = flow(httpResp(T0))
  a.add(normalizeFlow(resp)!)
  a.add(normalizeFlow(resp)!)
  const s = flow(syn(T0))
  a.add(normalizeFlow(s)!)
  a.add(normalizeFlow(s)!)
  const f = a.snapshot({ windowS: 15, allow: '*' })
  assertEquals(f.edges[0].rps, round(1 / 15))
  assertEquals(f.edges[0].cps, round(1 / 15))
  // Flow events are what Hubble emitted: both sightings of the response and of the SYN.
  assertEquals(f.edges[0].fps, round(4 / 15))
})

function round(v: number) {
  return Math.round(v * 1000) / 1000
}

Deno.test('flows from the future are clamped; ones older than 5 minutes ignored', () => {
  const now = T0
  const a = agg(() => now)
  a.add(normalizeFlow(flow(httpResp(T0 + 30_000)))!)
  a.add(normalizeFlow(flow(httpResp(T0 - 400_000, web, cart, 200, 1, 1)))!)
  const f = a.snapshot({ windowS: 15, allow: '*' })
  assertEquals(f.edges[0].rps, round(1 / 15))
})

Deno.test('protocol and namespace filters; seen lists stay complete', () => {
  const now = T0 + 1000
  const a = agg(() => now)
  a.add(normalizeFlow(flow(httpResp(T0)))!)
  a.add(normalizeFlow(flow(syn(T0, web, ledger)))!)
  const all = a.snapshot({ windowS: 15, allow: '*' })
  assertEquals(all.edges.length, 2)
  assertEquals(all.protos, ['http', 'tcp'])
  assertEquals(all.namespaces, ['finance', 'shop'])
  const http = a.snapshot({ windowS: 15, allow: '*', protos: ['http'] })
  assertEquals(http.edges.map((e) => e.id), ['shop/web>shop/cart'])
  assertEquals(http.protos, ['http', 'tcp'], 'protocols offered do not shrink with the filter')
  const fin = a.snapshot({ windowS: 15, allow: '*', namespaces: ['finance'] })
  assertEquals(fin.edges.map((e) => e.id), ['shop/web>finance/ledger'])
})

Deno.test('RBAC: invisible namespaces are masked, never named', () => {
  const now = T0 + 1000
  const a = agg(() => now)
  a.add(normalizeFlow(flow({ ...syn(T0, web, ledger), dstService: { name: 'ledger', namespace: 'finance' } }))!)
  a.add(normalizeFlow(flow(httpResp(T0, ledger, ledger)))!)
  a.add(normalizeFlow(flow(syn(T0, { identity: 2, labels: ['reserved:world'] }, { identity: 8, labels: ['reserved:ingress'] })))!)
  const f = a.snapshot({ windowS: 15, allow: new Set(['shop']) })
  const json = JSON.stringify(f)
  assert(!json.includes('finance'), 'no namespace name')
  assert(!json.includes('ledger'), 'no workload, pod or service name')
  assertEquals(f.edges.map((e) => e.id), [`shop/web>${RESTRICTED.id}`])
  assertEquals(f.namespaces, ['shop'])
  // finance → finance is invisible entirely; so is world → ingress (no visible namespaced end).
  assertEquals(f.totals.edges, 1)
  assert(f.feed.every((r) => r.d === RESTRICTED.id && !r.dp && r.port === 0))
  // Cluster-wide viewers see everything.
  assertEquals(a.snapshot({ windowS: 15, allow: '*' }).totals.edges, 3)
  // A viewer with no namespaces sees nothing.
  assertEquals(a.snapshot({ windowS: 15, allow: new Set() }).edges.length, 0)
})

Deno.test('caps keep the busiest edges and report what was hidden; focus survives', () => {
  const now = T0 + 1000
  const a = agg(() => now)
  for (let i = 0; i < 30; i++) {
    const server = pod('shop', `svc${i}-6b7c9d8f4-x2x9k`, `svc${i}`)
    for (let k = 0; k <= i; k++) a.add(normalizeFlow(flow(syn(T0, web, server, 30_000 + i * 100 + k)))!)
  }
  const f = a.snapshot({ windowS: 15, allow: '*', maxEdges: 10, focus: 'shop/svc0' })
  assertEquals(f.edges.length, 11)
  assertEquals(f.hidden.edges, 19)
  assert(f.edges.some((e) => e.d === 'shop/svc0'))
  assertEquals(f.edges[0].d, 'shop/svc29')
  assertEquals(f.totals.edges, 30)
})

Deno.test('feed: newest first, after a cursor, drops and requests always kept', () => {
  const now = T0 + 5000
  const a = new FlowAggregator({ now: () => now, feedSampleL4: 1000 })
  a.add(normalizeFlow(flow(httpResp(T0)))!)
  a.add(normalizeFlow(flow({ timeMs: T0 + 1000, tcp: { sport: 1, dport: 8080, ack: true }, src: web, dst: cart }))!) // plain L4: sampled out
  a.add(normalizeFlow(flow({ ...syn(T0 + 2000), verdict: 2, dropReason: 181 }))!)
  const f = a.snapshot({ windowS: 15, allow: '*' })
  assertEquals(f.feed.length, 2)
  assertEquals(f.feed[0].v, 'drop')
  assertEquals(f.feed[0].dr, 'Policy deny rule')
  assertEquals(f.feed[1].code, 200)
  assertEquals(f.feed[1].path, '/api/items/:id')
  const next = a.snapshot({ windowS: 15, allow: '*', afterSeq: f.feed[0].seq })
  assertEquals(next.feed.length, 0)
})

Deno.test('focus series and pods, and edge detail', () => {
  const now = T0 + 59_000
  const a = agg(() => now)
  for (let i = 0; i < 60; i++) a.add(normalizeFlow(flow(httpResp(T0 + i * 1000, web, cart, i % 10 === 0 ? 502 : 200, 5, 40_000 + i)))!)
  a.add(normalizeFlow(flow({ ...syn(T0 + 59_000), verdict: 2, dropReason: 133 }))!)
  const f = a.snapshot({ windowS: 60, allow: '*', focus: 'shop/cart', edge: 'shop/web>shop/cart' })
  assertEquals(f.focus?.id, 'shop/cart')
  assertEquals(f.focus?.series.length, 59, 'up to the last complete second')
  assertEquals(f.focus?.pods, ['cart-6b7c9d8f4-x2x9k'])
  assertEquals(f.edge?.status, { c2: 54, c3: 0, c4: 0, c5: 6 })
  assertEquals(f.edge?.dropReasons, [{ reason: 'Policy denied', count: 1 }])
  assertEquals(f.edge?.ports, [8080])
  assertEquals(f.edge?.p95, 5)
})

Deno.test('a later port hint upgrades a workload node to a database', () => {
  const now = T0 + 1000
  const a = agg(() => now)
  const store = pod('shop', 'store-6b7c9d8f4-x2x9k', 'store')
  a.add(normalizeFlow(flow({ ...syn(T0, web, store), tcp: { sport: 40_000, dport: 8080, syn: true } }))!)
  a.add(normalizeFlow(flow({ ...syn(T0, web, store, 40_001), tcp: { sport: 40_001, dport: 5432, syn: true } }))!)
  const f = a.snapshot({ windowS: 15, allow: '*' })
  assertEquals(f.nodes.find((n) => n.id === 'shop/store')?.k, 'database')
})

Deno.test('lost events are summed over the window', () => {
  let now = T0
  const a = agg(() => now)
  a.noteLost(10)
  now += 20_000
  a.noteLost(5)
  assertEquals(a.snapshot({ windowS: 15, allow: '*' }).lost, 5)
  assertEquals(a.snapshot({ windowS: 60, allow: '*' }).lost, 15)
})

Deno.test('quantile', () => {
  assertEquals(quantile([], 0.5), null)
  assertEquals(quantile([1, 2, 3, 4], 0.5), 2)
  assertEquals(quantile([1, 2, 3, 4], 0.95), 4)
})

Deno.test('normalizeFlow output is plain data (structured-clone safe)', () => {
  const ev = normalizeFlow(flow(httpResp(T0))) as FlowEvent
  assertEquals(structuredClone(ev), ev)
})

Deno.test('hideHosts drops node traffic before the caps, from totals and feed too', () => {
  const now = T0 + 1000
  const a = agg(() => now)
  const host = { identity: 1, labels: ['reserved:host'] }
  for (let i = 0; i < 5; i++) a.add(normalizeFlow(flow(syn(T0, host, pod('shop', `p${i}-6b7c9d8f4-x2x9k`, `p${i}`), 20_000 + i)))!)
  a.add(normalizeFlow(flow(httpResp(T0)))!)
  const all = a.snapshot({ windowS: 15, allow: '*' })
  assertEquals(all.totals.edges, 6)
  const f = a.snapshot({ windowS: 15, allow: '*', hideHosts: true, maxEdges: 1 })
  assertEquals(f.edges.map((e) => e.id), ['shop/web>shop/cart'], 'host edges do not use up the budget')
  assertEquals(f.totals.edges, 1)
  assert(f.feed.every((r) => r.s !== '~nodes' && r.d !== '~nodes'))
})

Deno.test('apps scope: platform-only traffic is left out before the caps; an explicit namespace wins', () => {
  const now = T0 + 1000
  const a = agg(() => now)
  const argo = pod('argocd', 'argocd-server-6b7c9d8f4-x2x9k', 'argocd-server')
  const operator = pod('adhar-system', 'adhar-operator-5c6d7f8b9-abcde', 'adhar-operator')
  a.add(normalizeFlow(flow(syn(T0, argo, operator)))!) // platform ↔ platform
  a.add(normalizeFlow(flow(syn(T0, web, ledger)))!) // app ↔ app
  a.add(normalizeFlow(flow(syn(T0, web, operator)))!) // app ↔ platform: kept (one end is an app)
  const apps = a.snapshot({ windowS: 15, allow: '*', appsOnly: true })
  assertEquals(apps.edges.map((e) => e.id).sort(), ['shop/web>adhar-system/adhar-operator', 'shop/web>finance/ledger'])
  assert(apps.namespaces.includes('argocd'), 'the namespace picker still offers platform namespaces')
  const explicit = a.snapshot({ windowS: 15, allow: '*', appsOnly: true, namespaces: ['argocd'] })
  assertEquals(explicit.edges.map((e) => e.id), ['argocd/argocd-server>adhar-system/adhar-operator'])
})
