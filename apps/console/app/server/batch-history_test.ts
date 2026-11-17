import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  type BatchEvent,
  BRIDGE_PROXY_PATH,
  BRIDGE_PROXY_RESOURCE,
  type BridgeFetch,
  consumerPath,
  handleBatchHistory,
  historyCheck,
  type HistoryDeps,
  matching,
  parseSince,
  readTopic,
  resetBatchHistoryCache,
  sharedRead,
  type StreamRead,
} from './batch-history.ts'
import type { K8sIdentity } from './k8s/gateway.ts'

/**
 * /api/batch/history against a fake bridge: the consumer protocol the Strimzi
 * bridge speaks, that the consumer never outlives the read, and that a caller
 * is shown only the namespaces they may list BatchJobs in.
 */

const ev = (subject: string, type: string, time: string, data: Record<string, unknown> = {}): BatchEvent => ({
  specversion: '1.0',
  id: `${subject}-${type}-${time}`,
  type: `io.adhar.batch.${type}`,
  source: 'adhar/batch-observer',
  subject,
  time,
  data,
})

interface Call {
  method: string
  path: string
  body?: unknown
}

/** A bridge that serves `polls` in order, then empty polls. */
function fakeBridge(polls: unknown[][], over: Partial<Record<string, () => Response>> = {}): { bridge: BridgeFetch; calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const bridge: BridgeFetch = (path, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined })
    const key = `${method} ${path.replace(/adhar-console-[^/]+/, 'G').replace(/history-[^/?]+/, 'N')}`
    if (over[key]) return Promise.resolve(over[key]!())
    if (method === 'POST' && path.endsWith('/subscription')) return Promise.resolve(new Response(null, { status: 204 }))
    if (method === 'POST') {
      const name = (JSON.parse(init.body ?? '{}') as { name: string }).name
      return Promise.resolve(
        Response.json({ instance_id: name, base_uri: `http://adhar-events-bridge-service.adhar-system.svc:8080${path}/instances/${name}` }),
      )
    }
    if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
    return Promise.resolve(Response.json(polls[i++] ?? []))
  }
  return { bridge, calls }
}

const rec = (value: unknown) => ({ topic: 'adhar.batch', partition: 0, offset: 0, key: 'k', value })

Deno.test('the proxy path names the bridge Service with its port, which is the name RBAC is asked about', () => {
  assertEquals(BRIDGE_PROXY_RESOURCE, 'adhar-events-bridge-service:8080')
  assertEquals(BRIDGE_PROXY_PATH, '/api/v1/namespaces/adhar-system/services/adhar-events-bridge-service:8080/proxy')
})

Deno.test('readTopic: creates a consumer from the beginning that commits nothing, subscribes, polls until quiet, and deletes it', async () => {
  const a = ev('prod/importer', 'run.started', '2026-11-03T01:30:00Z')
  const b = ev('prod/importer', 'run.succeeded', '2026-11-03T01:40:00Z')
  const { bridge, calls } = fakeBridge([[rec(a)], [], [rec(b)]])
  const read = await readTopic(bridge, { pollMs: 1, id: 'x1' })
  assertEquals(read, { state: 'read', events: [a, b], foreign: 0, truncated: false })

  assertEquals(calls[0].method, 'POST')
  assertEquals(calls[0].path, '/consumers/adhar-console-x1')
  assertEquals(calls[0].body, {
    name: 'history-x1',
    format: 'json',
    'auto.offset.reset': 'earliest',
    'enable.auto.commit': false,
    'consumer.request.timeout.ms': 60_000,
  })
  assertEquals(calls[1], { method: 'POST', path: '/consumers/adhar-console-x1/instances/history-x1/subscription', body: { topics: ['adhar.batch'] } })
  // One empty poll between two records does not end the read; two in a row do.
  assertEquals(calls.filter((c) => c.method === 'GET').length, 5)
  assert(calls.filter((c) => c.method === 'GET').every((c) => c.path === '/consumers/adhar-console-x1/instances/history-x1/records?timeout=1'))
  assertEquals(calls.at(-1), { method: 'DELETE', path: '/consumers/adhar-console-x1/instances/history-x1', body: undefined })
})

Deno.test('readTopic: every read is its own group, so two readers never split the partitions', async () => {
  const one = fakeBridge([])
  const two = fakeBridge([])
  await readTopic(one.bridge, { pollMs: 1 })
  await readTopic(two.bridge, { pollMs: 1 })
  assert(one.calls[0].path !== two.calls[0].path, `${one.calls[0].path} was reused`)
})

Deno.test('readTopic: a record that is not an adhar.batch CloudEvent is counted, never shown', async () => {
  const good = ev('prod/importer', 'run.failed', '2026-11-03T01:40:00Z')
  const { bridge } = fakeBridge([[
    rec(good),
    rec('not json'),
    rec({ type: 'io.adhar.batch.run.failed', subject: 'prod/importer' }), // no specversion
    rec({ ...good, type: 'io.adhar.cluster.scale.refused' }), // another domain
    rec({ ...good, subject: 'importer' }), // no namespace to check access against
    { value: null },
  ]])
  const read = await readTopic(bridge, { pollMs: 1 })
  assertEquals(read, { state: 'read', events: [good], foreign: 5, truncated: false })
})

Deno.test('readTopic: keeps the newest events when the topic is larger than the cap, and says it was cut', async () => {
  const all = [1, 2, 3, 4, 5].map((n) => ev('prod/importer', 'run.started', `2026-11-0${n}T00:00:00Z`))
  const { bridge } = fakeBridge([all.slice(0, 3).map(rec), all.slice(3).map(rec)])
  const read = await readTopic(bridge, { pollMs: 1, maxEvents: 2 })
  assertEquals(read, { state: 'read', events: all.slice(3), foreign: 0, truncated: true })
})

Deno.test('readTopic: a spent budget ends the read with what it has, cut, and still deletes the consumer', async () => {
  const a = ev('prod/importer', 'run.started', '2026-11-03T01:30:00Z')
  const { bridge, calls } = fakeBridge([[rec(a)], [rec(a)], [rec(a)]])
  let t = 0
  const read = await readTopic(bridge, { pollMs: 1, budgetMs: 25, now: () => (t += 10) })
  assert(read.state === 'read' && read.truncated)
  assertEquals(calls.at(-1)?.method, 'DELETE')
})

Deno.test('readTopic: no bridge Service is "no bus", said as a state and not an error', async () => {
  const { bridge, calls } = fakeBridge([], { 'POST /consumers/G': () => new Response('services "adhar-events-bridge-service" not found', { status: 404 }) })
  const read = await readTopic(bridge, { pollMs: 1 })
  assert(read.state === 'unavailable')
  assertEquals(read.reason, 'no-bus')
  // Nothing was created, so there is nothing to delete.
  assertEquals(calls.length, 1)
})

Deno.test('readTopic: a refused proxy call names the grant; a broken bridge is unreachable', async () => {
  const denied = await readTopic(fakeBridge([], { 'POST /consumers/G': () => new Response('forbidden', { status: 403 }) }).bridge, { pollMs: 1 })
  assert(denied.state === 'unavailable')
  assertEquals(denied.reason, 'forbidden')
  assert(denied.detail.includes('console-batch-history'))

  const broken = fakeBridge([], { 'GET /consumers/G/instances/N/records?timeout=1': () => new Response('no brokers', { status: 500 }) })
  const read = await readTopic(broken.bridge, { pollMs: 1 })
  assert(read.state === 'unavailable')
  assertEquals(read.reason, 'unreachable')
  // The consumer existed by then: it is deleted even though the read failed.
  assertEquals(broken.calls.at(-1)?.method, 'DELETE')
})

Deno.test('consumerPath: only the path of the consumer that was asked for is taken from base_uri', () => {
  const own = '/consumers/g/instances/n'
  assertEquals(consumerPath('g', 'n', { instance_id: 'n', base_uri: 'http://bridge:8080/consumers/g/instances/n' }), own)
  assertEquals(
    consumerPath('g', 'n', {
      instance_id: 'n',
      base_uri: 'https://kubernetes.default.svc/api/v1/namespaces/adhar-system/services/x:8080/proxy/consumers/g/instances/n/',
    }),
    own,
  )
  assertEquals(consumerPath('g', 'n', {}), own)
  // A base_uri naming another consumer, or another host's idea of a path, is not followed.
  assertEquals(consumerPath('g', 'n', { instance_id: 'n', base_uri: 'http://evil.example/consumers/other/instances/victim' }), own)
  assertEquals(consumerPath('g', 'n', { instance_id: 'm' }), '/consumers/g/instances/m')
})

Deno.test('parseSince: an age, an instant, nothing, or refused', () => {
  const now = Date.parse('2026-11-10T00:00:00Z')
  assertEquals(parseSince(null, now), undefined)
  assertEquals(parseSince('7d', now), Date.parse('2026-11-03T00:00:00Z'))
  assertEquals(parseSince('12h', now), Date.parse('2026-11-09T12:00:00Z'))
  assertEquals(parseSince('2w', now), Date.parse('2026-10-27T00:00:00Z'))
  assertEquals(parseSince('2026-11-01T00:00:00Z', now), Date.parse('2026-11-01T00:00:00Z'))
  assertEquals(parseSince('last tuesday', now), null)
})

Deno.test('matching: exactly the job and the namespace, and an unreadable time is kept', () => {
  const events = [
    ev('prod/importer', 'run.started', '2026-11-01T00:00:00Z'),
    ev('prod/importer-eu', 'run.started', '2026-11-02T00:00:00Z'),
    ev('preprod/importer', 'run.started', '2026-11-02T00:00:00Z'),
    ev('prod/importer', 'run.failed', 'not a time'),
    ev('prod/importer', 'run.succeeded', '2026-11-05T00:00:00Z'),
  ]
  assertEquals(matching(events, { namespace: 'prod', job: 'importer', limit: 10 }).map((e) => e.type), [
    'io.adhar.batch.run.started',
    'io.adhar.batch.run.failed',
    'io.adhar.batch.run.succeeded',
  ])
  assertEquals(matching(events, { job: 'importer', limit: 10 }).length, 4)
  assertEquals(matching(events, { namespace: 'prod', job: 'importer', sinceMs: Date.parse('2026-11-03T00:00:00Z'), limit: 10 }).map((e) => e.type), [
    'io.adhar.batch.run.failed',
    'io.adhar.batch.run.succeeded',
  ])
})

Deno.test('sharedRead: concurrent callers share one read, and the next one within the window reuses it', async () => {
  resetBatchHistoryCache()
  let reads = 0
  let release!: (r: StreamRead) => void
  const read = () => {
    reads++
    return new Promise<StreamRead>((r) => (release = r))
  }
  let now = 1_000
  const a = sharedRead(read, () => now)
  const b = sharedRead(read, () => now)
  release({ state: 'read', events: [], foreign: 0, truncated: false })
  assertEquals(await a, await b)
  assertEquals(reads, 1)
  now += 29_000
  await sharedRead(read, () => now)
  assertEquals(reads, 1)
  now += 2_000
  const c = sharedRead(read, () => now)
  release({ state: 'read', events: [], foreign: 0, truncated: false })
  await c
  assertEquals(reads, 2)
  resetBatchHistoryCache()
})

/* ─────────────────────────── the handler ─────────────────────────── */

const alice: K8sIdentity = { token: 't', user: { id: 'alice', name: 'Alice', email: 'alice@example.com' } }

const STREAM = [
  ev('prod/importer', 'run.started', '2026-11-03T01:30:00Z'),
  ev('payments-prod/ledger', 'run.failed', '2026-11-03T02:00:00Z'),
  ev('prod/importer', 'run.succeeded', '2026-11-03T01:40:00Z'),
  ev('dev/importer', 'run.succeeded', '2026-11-04T01:40:00Z'),
]

function deps(over: Partial<HistoryDeps> = {}, may: readonly string[] = ['prod', 'dev']): HistoryDeps & { asked: string[][] } {
  const asked: string[][] = []
  return {
    asked,
    identity: () => Promise.resolve(alice),
    read: () => Promise.resolve({ state: 'read', events: STREAM, foreign: 0, truncated: false }),
    allowed: (_id, namespaces) => {
      asked.push(namespaces)
      return Promise.resolve({ results: namespaces.map((n) => may.includes(n)), degraded: false })
    },
    now: () => Date.parse('2026-11-10T00:00:00Z'),
    ...over,
  }
}

const get = (query = '', d = deps(), method = 'GET') => handleBatchHistory(new Request(`https://console.example/api/batch/history${query}`, { method }), d)

Deno.test('handler: a caller is shown only the namespaces they may list BatchJobs in', async () => {
  const d = deps()
  const res = await get('', d)
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('cache-control'), 'no-store')
  const body = await res.json()
  assertEquals(body.state, 'read')
  assertEquals(body.events.map((e: BatchEvent) => e.subject), ['prod/importer', 'prod/importer', 'dev/importer'])
  assertEquals(body.total, 3)
  // Each namespace in the stream was asked about once, as the caller.
  assertEquals(d.asked, [['dev', 'payments-prod', 'prod']])
  assert(!JSON.stringify(body).includes('ledger'), 'another tenant’s job leaked')
})

Deno.test('handler: the access asked is list batchjobs.platform.adhar.io in the namespace', () => {
  assertEquals(historyCheck('prod'), { verb: 'list', group: 'platform.adhar.io', resource: 'batchjobs', namespace: 'prod' })
})

Deno.test('handler: someone who may list nowhere gets nothing, not an error', async () => {
  const body = await (await get('', deps({}, []))).json()
  assertEquals(body, { state: 'read', events: [], total: 0, truncated: false, degraded: false })
})

Deno.test('handler: asking for a namespace by name does not get around the access check', async () => {
  const d = deps()
  const body = await (await get('?namespace=payments-prod&job=ledger', d)).json()
  assertEquals(body.events, [])
  assertEquals(d.asked, [['payments-prod']])
})

Deno.test('handler: namespace, job, since and limit narrow it; limit keeps the newest', async () => {
  const one = await (await get('?namespace=prod&job=importer')).json()
  assertEquals(one.events.map((e: BatchEvent) => e.type), ['io.adhar.batch.run.started', 'io.adhar.batch.run.succeeded'])
  const recent = await (await get('?since=6d')).json()
  assertEquals(recent.events.map((e: BatchEvent) => e.subject), ['dev/importer'])
  const last = await (await get('?limit=1')).json()
  assertEquals(last.events.map((e: BatchEvent) => e.subject), ['dev/importer'])
  assertEquals(last.total, 3)
})

Deno.test('handler: signed out is 401 and reads nothing', async () => {
  let read = false
  const res = await get(
    '',
    deps({
      identity: () => Promise.resolve(null),
      read: () => ((read = true), Promise.resolve({ state: 'read', events: STREAM, foreign: 0, truncated: false })),
    }),
  )
  assertEquals(res.status, 401)
  assert(!read)
})

Deno.test('handler: bad input is refused; only GET is served', async () => {
  assertEquals((await get('?since=whenever')).status, 400)
  assertEquals((await get('?limit=0')).status, 400)
  assertEquals((await get('?limit=many')).status, 400)
  assertEquals((await get('', deps(), 'POST')).status, 405)
})

Deno.test('handler: a cluster with no bus answers 200 with the reason, so the page can say so', async () => {
  const d = deps({ read: () => Promise.resolve({ state: 'unavailable', reason: 'no-bus', detail: 'opt-in' }) })
  const res = await get('', d)
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { state: 'unavailable', reason: 'no-bus', detail: 'opt-in', events: [] })
  assertEquals(d.asked, [])
})

Deno.test('handler: a cut stream and an unanswered access review are both passed on', async () => {
  const d = deps({
    read: () => Promise.resolve({ state: 'read', events: STREAM, foreign: 0, truncated: true }),
    allowed: (_id, namespaces) => Promise.resolve({ results: namespaces.map(() => false), degraded: true }),
  })
  const body = await (await get('', d)).json()
  assertEquals([body.truncated, body.degraded, body.events.length], [true, true, 0])
})

Deno.test('handler: a namespace with no answer is not shown — only a definite yes is', async () => {
  // A review that answers for fewer namespaces than it was asked about (sorted: dev, payments-prod, prod).
  const d = deps({ allowed: () => Promise.resolve({ results: [true], degraded: true }) })
  const body = await (await get('', d)).json()
  assertEquals(body.events.map((e: BatchEvent) => e.subject), ['dev/importer'])
  assertEquals(body.degraded, true)
})

Deno.test('handler: a refreshed session cookie rides on the answer', async () => {
  const res = await get('', deps({ identity: () => Promise.resolve({ ...alice, refreshedCookie: 'adhar_session=new; Path=/' }) }))
  assertEquals(res.headers.get('set-cookie'), 'adhar_session=new; Path=/')
})
