import { assert, assertEquals } from 'jsr:@std/assert@1'
import { type FlowSource, FlowsHub, parseView, relayTarget, type Viewer } from './hub.ts'
import { resolveAllow, subscribeFlows } from './subscribe.ts'
import { encodeResponse, pod } from './testing.ts'
import type { K8sIdentity } from '../k8s/gateway.ts'

type Json = Record<string, unknown>

Deno.test('relayTarget: explicit address, schemes, in-cluster default, off', () => {
  const env = (m: Record<string, string>) => (k: string) => m[k]
  assertEquals(relayTarget(env({})), null)
  assertEquals(relayTarget(env({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })), {
    hostname: 'hubble-relay.adhar-system.svc.cluster.local',
    port: 80,
    tls: false,
  })
  assertEquals(relayTarget(env({ KUBERNETES_SERVICE_HOST: 'x', HUBBLE_RELAY_NAMESPACE: 'kube-system' }))?.hostname, 'hubble-relay.kube-system.svc.cluster.local')
  assertEquals(relayTarget(env({ HUBBLE_RELAY_ADDR: '127.0.0.1:14245' })), { hostname: '127.0.0.1', port: 14245, tls: false })
  assertEquals(relayTarget(env({ HUBBLE_RELAY_ADDR: 'grpcs://relay.example:4245' })), { hostname: 'relay.example', port: 4245, tls: true })
  assertEquals(relayTarget(env({ HUBBLE_RELAY_ADDR: 'relay', HUBBLE_RELAY_TLS: '1' })), { hostname: 'relay', port: 443, tls: true })
  assertEquals(relayTarget(env({ HUBBLE_RELAY_ADDR: 'off', KUBERNETES_SERVICE_HOST: 'x' })), null)
  assertEquals(relayTarget(env({ HUBBLE_RELAY_ADDR: 'host:99999' })), null)
})

Deno.test('parseView validates and bounds params', () => {
  const v = parseView({ windowS: 999, namespaces: ['shop', 'BAD NS', 7], protos: ['http', 'smtp'], focus: 'x'.repeat(400), maxEdges: 10_000 })
  assertEquals(v.windowS, 60)
  assertEquals(v.namespaces, ['shop'])
  assertEquals(v.protos, ['http'])
  assertEquals(v.focus, undefined)
  assertEquals(v.maxEdges, 400)
  assertEquals(parseView({ windowS: 15 }).windowS, 15)
  assertEquals(parseView({ hosts: false }).hideHosts, true)
  assertEquals(parseView({}).hideHosts, false)
})

/** A controllable source: resolves `run` when aborted. */
function fakeSource() {
  const state = { runs: 0, active: false, push: (_m: Uint8Array) => {}, open: () => {}, since: 0 }
  const source: FlowSource = {
    run: ({ signal, onMessage, onOpen, sinceMs }) => {
      state.runs++
      state.active = true
      state.push = onMessage
      state.open = onOpen
      state.since = sinceMs
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => {
          state.active = false
          resolve({ reason: 'aborted' })
        })
      )
    },
  }
  return { source, state }
}

function viewer(allow: Viewer['allow'], view: Partial<Viewer['view']> = {}): Viewer & { got: Json[] } {
  const got: Json[] = []
  return { accessKey: 'u', allow, view: { windowS: 15, allow: allow ?? new Set(), ...view }, push: (m) => got.push(m), got }
}

const T = 1_793_721_000_000

Deno.test('hub: one upstream for many viewers, frames per viewer, unchanged frames skipped', async () => {
  const now = T + 2000
  const { source, state } = fakeSource()
  const hub = new FlowsHub({ source, now: () => now })
  const a = viewer('*')
  const b = viewer(new Set(['other']))
  const leaveA = hub.join(a)
  const leaveB = hub.join(b)
  await Promise.resolve()
  assertEquals(state.runs, 1)
  assertEquals(state.since, now - 60_000, 'first connect backfills a minute')
  assertEquals(a.got[0], { op: 'status', state: 'connecting' })
  state.open()
  assertEquals(hub.state, 'live')
  state.push(
    encodeResponse({
      timeMs: T + 1000,
      tcp: { sport: 8080, dport: 50_000 },
      src: pod('shop', 'cart-6b7c9d8f4-x2x9k', 'cart'),
      dst: pod('shop', 'web-7d9f8c6b5-k2m4n', 'web'),
      l7: { type: 2, latencyNs: 1e6, http: { code: 200 } },
    }),
  )
  hub.tick()
  const fa = a.got.filter((m) => m.op === 'frame')
  const fb = b.got.filter((m) => m.op === 'frame')
  assertEquals(fa.length, 1)
  assertEquals((fa[0].frame as { edges: unknown[] }).edges.length, 1)
  assertEquals((fb[0].frame as { edges: unknown[] }).edges.length, 0, 'viewer without shop sees nothing')
  // Same state next tick: no new frame (and the feed row is not repeated).
  hub.tick()
  assertEquals(a.got.filter((m) => m.op === 'frame').length, 1)
  // A malformed message is ignored, not fatal.
  state.push(Uint8Array.from([0xff, 0xff]))
  leaveA()
  leaveB()
  assert(hub.upstreamOpen, 'kept open through the grace period')
  hub.stop()
  assert(!state.active)
  assert(!hub.upstreamOpen)
})

Deno.test('hub without a relay reports unavailable and never streams', () => {
  const hub = new FlowsHub({ source: null })
  const v = viewer('*')
  const leave = hub.join(v)
  assertEquals(v.got[0], { op: 'status', state: 'unavailable', message: 'Hubble Relay is not configured for this console.', reason: 'not-configured' })
  hub.tick()
  assertEquals(v.got.length, 1)
  leave()
  hub.stop()
})

Deno.test('hub reconnects after the stream fails', async () => {
  let runs = 0
  const source: FlowSource = {
    run: () => {
      runs++
      return runs === 1 ? Promise.reject(new Error('connection refused')) : new Promise(() => {})
    },
  }
  const hub = new FlowsHub({ source })
  const v = viewer('*')
  const leave = hub.join(v)
  await new Promise((r) => setTimeout(r, 1200))
  assert(v.got.some((m) => m.state === 'reconnecting' && String(m.message).includes('connection refused')))
  assertEquals(runs, 2)
  leave()
  hub.stop()
})

Deno.test('resolveAllow: cluster-wide, per namespace, fail closed', async () => {
  const wide = await resolveAllow(() => Promise.resolve({ results: [true], degraded: false }), ['a'])
  assertEquals(wide.allow, '*')
  const some = await resolveAllow((checks) =>
    Promise.resolve(
      checks[0].namespace ? { results: checks.map((c) => c.namespace === 'shop'), degraded: false } : { results: [false], degraded: false },
    ), ['shop', 'finance', 'shop'])
  assertEquals(some.allow, new Set(['shop']))
  const failed = await resolveAllow((checks) => Promise.resolve({ results: checks.map(() => false), degraded: true }), ['shop'])
  assertEquals(failed.allow, new Set())
  assert(failed.degraded)
})

Deno.test('subscribeFlows: frames only after access resolves, tagged with the sid', async () => {
  const now = T + 2000
  const { source, state } = fakeSource()
  const hub = new FlowsHub({ source, now: () => now })
  const sent: Json[] = []
  const id = { user: { id: 'u1', username: 'u1', groups: [] } } as unknown as K8sIdentity
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const sub = subscribeFlows('s9', id, { windowS: 15 }, (m) => sent.push(m), {
    hub,
    check: async (checks) => {
      await gate
      return { results: checks.map((c) => c.namespace === 'shop'), degraded: false }
    },
  })
  await Promise.resolve()
  state.open()
  state.push(
    encodeResponse({
      timeMs: T + 1000,
      tcp: { sport: 8080, dport: 50_000 },
      src: pod('shop', 'cart-6b7c9d8f4-x2x9k', 'cart'),
      dst: pod('shop', 'web-7d9f8c6b5-k2m4n', 'web'),
      l7: { type: 2, http: { code: 200 } },
    }),
  )
  hub.tick()
  assert(!sent.some((m) => m.op === 'frame'), 'no frame before access is known')
  release()
  await new Promise((r) => setTimeout(r, 10))
  hub.tick()
  const frames = sent.filter((m) => m.op === 'frame')
  assertEquals(frames.length, 1)
  assertEquals(frames[0].id, 's9')
  assert(sent.every((m) => m.id === 's9'))
  sub.stop()
  hub.stop()
})

Deno.test('compactFrame drops zero, null and empty fields only', async () => {
  const { compactFrame } = await import('./hub.ts')
  const f = compactFrame({
    t: 1,
    windowS: 15,
    nodes: [{ id: 'a', n: 'a', k: 'workload', rps: 0, cps: 0, fps: 2, orps: 0, ofps: 0, err: null, p95: 3, drops: 0 }],
    edges: [{ id: 'a>b', s: 'a', d: 'b', rps: 0, cps: 0, fps: 1, err: null, e4: null, p50: null, p95: null, drops: 0, protos: ['tcp'], ports: [] }],
    totals: { rps: 0, cps: 0, fps: 0, err: null, drops: 0, services: 0, edges: 0 },
    hidden: { edges: 0, nodes: 0 },
    namespaces: [],
    protos: [],
    feed: [],
    seq: 0,
    lost: 0,
  })
  assertEquals(f.nodes[0] as unknown, { id: 'a', n: 'a', k: 'workload', fps: 2, p95: 3 })
  assertEquals(f.edges[0] as unknown, { id: 'a>b', s: 'a', d: 'b', fps: 1, protos: ['tcp'] })
  assertEquals(f.totals.err, null, 'totals are kept whole')
})
