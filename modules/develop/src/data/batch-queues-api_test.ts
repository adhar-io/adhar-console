import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { readNamespaceGangs, readPodGroups, readQueue, readQueues, readRunGang, readSchedulerDescriptor, volcanoServed } from './batch-queues-api.ts'

/**
 * The Queues requests against a fake Kubernetes gateway: which paths are asked
 * for, as whom they would be refused, and how each answer is read. The caller
 * is always the signed-in user; nothing here may fall back to a wider identity.
 */

interface Seen {
  method: string
  url: string
}

type Reply = { status: number; body?: unknown }

function fakeGateway(routes: Record<string, Reply>) {
  const seen: Seen[] = []
  const saved = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const req: Seen = { method: init?.method ?? 'GET', url }
    seen.push(req)
    // Exact match first, then the longest prefix, so a collection route does not answer for one object.
    const line = `${req.method} ${url}`
    const key = routes[line] ? line : Object.keys(routes).filter((k) => line.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    const r = key ? routes[key] : { status: 500, body: { message: `no route for ${line}` } }
    return Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, statusText: String(r.status) }))
  }) as typeof fetch
  return { seen, restore: () => (globalThis.fetch = saved) }
}

const Q = 'GET /api/k8s/apis/scheduling.volcano.sh/v1beta1/queues'
const PG = 'GET /api/k8s/apis/scheduling.volcano.sh/v1beta1'
const DISCOVERY = 'GET /api/k8s/-/discovery'
const forbidden = { status: 403, body: { kind: 'Status', reason: 'Forbidden', code: 403, message: 'forbidden' } }
const notFound = { status: 404, body: { kind: 'Status', reason: 'NotFound', code: 404, message: 'not found' } }
const queue = (name: string) => ({ metadata: { name }, spec: { parent: 'adhar-batch' } })
const res = (group: string, name: string, subresource = false) => ({ group, version: 'v1beta1', groupVersion: `${group}/v1beta1`, kind: 'X', name, namespaced: false, verbs: ['get'], subresource })

Deno.test('discovery: Volcano is installed when its scheduling resources are served', async () => {
  const g = fakeGateway({ [DISCOVERY]: { status: 200, body: { cached: true, resources: [res('scheduling.volcano.sh', 'queues'), res('scheduling.volcano.sh', 'podgroups'), res('scheduling.volcano.sh', 'queues/status', true)] } } })
  try {
    assertEquals(await volcanoServed(), { queues: true, podgroups: true })
  } finally {
    g.restore()
  }
})

Deno.test('discovery: absent resources, or a look-alike group, mean not installed', async () => {
  const g = fakeGateway({ [DISCOVERY]: { status: 200, body: { cached: true, resources: [res('scheduling.k8s.io', 'priorityclasses'), res('kueue.x-k8s.io', 'queues')] } } })
  try {
    assertEquals(await volcanoServed(), { queues: false, podgroups: false })
  } finally {
    g.restore()
  }
})

Deno.test('discovery: when it fails, one list decides — 404 not served, 403 served', async () => {
  for (const [reply, want] of [[notFound, false], [forbidden, true], [{ status: 200, body: { items: [] } }, true]] as const) {
    const g = fakeGateway({ [DISCOVERY]: { status: 400, body: { message: 'discovery broke' } }, [Q]: reply })
    try {
      assertEquals((await volcanoServed()).queues, want)
      assert(g.seen.some((s) => s.url.endsWith('/queues?limit=1')))
    } finally {
      g.restore()
    }
  }
})

Deno.test('queues: one cluster-wide list when the caller may list them', async () => {
  const g = fakeGateway({ [Q]: { status: 200, body: { items: [queue('adhar-batch'), queue('acme-payments-prod')] } } })
  try {
    const l = await readQueues(['acme-payments-prod'], 'adhar-batch')
    assertEquals(l.scope, 'cluster')
    assertEquals(l.items.length, 2)
    assertEquals(g.seen.length, 1)
  } finally {
    g.restore()
  }
})

Deno.test('queues: a team member gets its own leaves by name; refused and missing are told apart', async () => {
  const g = fakeGateway({
    [Q]: forbidden,
    [`${Q}/adhar-batch`]: forbidden,
    [`${Q}/acme-payments-dev`]: { status: 200, body: queue('acme-payments-dev') },
    [`${Q}/acme-payments-prod`]: { status: 200, body: queue('acme-payments-prod') },
    [`${Q}/acme-payments-test`]: notFound,
    [`${Q}/acme-web-prod`]: forbidden,
  })
  try {
    const l = await readQueues(['acme-payments-dev', 'acme-payments-prod', 'acme-payments-test', 'acme-web-prod'], 'adhar-batch')
    assertEquals(l.scope, 'names')
    assertEquals(l.items.map((q) => q.metadata.name).sort(), ['acme-payments-dev', 'acme-payments-prod'])
    assertEquals(l.denied, ['acme-web-prod'])
    assertEquals(l.missing, ['acme-payments-test'])
    // The root was asked for, and its refusal is not reported as a denied leaf.
    assert(g.seen.some((s) => s.url.endsWith('/queues/adhar-batch')))
    // Every request is a GET: reading queues never writes.
    assert(g.seen.every((s) => s.method === 'GET'))
  } finally {
    g.restore()
  }
})

Deno.test('queues: a hard failure with nothing read is an error, not an empty page', async () => {
  const g = fakeGateway({ [Q]: forbidden, [`${Q}/acme-web-dev`]: { status: 500, body: { message: 'apiserver unreachable' } } })
  try {
    await assertRejects(() => readQueues(['acme-web-dev'], 'adhar-batch'))
  } finally {
    g.restore()
  }
  const h = fakeGateway({ [Q]: { status: 500, body: { message: 'boom' } } })
  try {
    await assertRejects(() => readQueues([], 'adhar-batch'))
  } finally {
    h.restore()
  }
})

Deno.test('podgroups: cluster-wide, else per namespace; a refused namespace makes the list partial', async () => {
  const g = fakeGateway({
    [`${PG}/podgroups`]: forbidden,
    [`${PG}/namespaces/shop-prod/podgroups`]: { status: 200, body: { items: [{ metadata: { name: 'a', namespace: 'shop-prod' } }] } },
    [`${PG}/namespaces/shop-dev/podgroups`]: forbidden,
  })
  try {
    const l = await readPodGroups('cluster', ['shop-prod', 'shop-dev'])
    assertEquals(l.items.map((p) => p.metadata.name), ['a'])
    assert(l.partial)
  } finally {
    g.restore()
  }
  const h = fakeGateway({ [`${PG}/namespaces/shop-prod/podgroups`]: { status: 200, body: { items: [] } } })
  try {
    const l = await readPodGroups('namespaces', ['shop-prod'])
    assertEquals(l, { items: [], partial: false })
    assert(!h.seen.some((s) => s.url.endsWith('/v1beta1/podgroups')), 'a namespaced caller is not asked cluster-wide')
  } finally {
    h.restore()
  }
})

Deno.test('run gang: the PodGroup owned by the run, whatever Volcano named it', async () => {
  const g = fakeGateway({
    [`${PG}/namespaces/shop-prod/podgroups`]: {
      status: 200,
      body: {
        items: [
          { metadata: { name: 'other-1', namespace: 'shop-prod', ownerReferences: [{ kind: 'Job', name: 'other' }] } },
          { metadata: { name: 'settlement-aa-0f1e', namespace: 'shop-prod', ownerReferences: [{ apiVersion: 'batch.volcano.sh/v1alpha1', kind: 'Job', name: 'settlement-aa' }] } },
        ],
      },
    },
  })
  try {
    assertEquals((await readRunGang('shop-prod', 'settlement-aa'))?.metadata.name, 'settlement-aa-0f1e')
    assertEquals(await readRunGang('shop-prod', 'nope'), null)
  } finally {
    g.restore()
  }
})

Deno.test('descriptor: read, never written; absent and refused are different answers', async () => {
  const CM = 'GET /api/k8s/api/v1/namespaces/adhar-system/configmaps/adhar-batch-scheduler'
  for (const [reply, state] of [[{ status: 200, body: { data: { scheduler: 'volcano' } } }, 'present'], [notFound, 'absent'], [forbidden, 'unknown']] as const) {
    const g = fakeGateway({ [CM]: reply })
    try {
      assertEquals((await readSchedulerDescriptor()).state, state)
      assertEquals(g.seen.map((s) => s.method), ['GET'])
    } finally {
      g.restore()
    }
  }
})

Deno.test('run gang: with the run’s uid, the PodGroup it owns wins over a namesake', async () => {
  const g = fakeGateway({
    [`${PG}/namespaces/shop-prod/podgroups`]: {
      status: 200,
      body: {
        items: [
          { metadata: { name: 'podgroup-u1', namespace: 'shop-prod', ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'settlement-aa', uid: 'u1' }] } },
          { metadata: { name: 'settlement-aa-u2', namespace: 'shop-prod', ownerReferences: [{ apiVersion: 'batch.volcano.sh/v1alpha1', kind: 'Job', name: 'settlement-aa', uid: 'u2' }] } },
        ],
      },
    },
  })
  try {
    assertEquals((await readRunGang('shop-prod', 'settlement-aa', 'u2'))?.metadata.name, 'settlement-aa-u2')
    assertEquals((await readRunGang('shop-prod', 'settlement-aa', 'u1'))?.metadata.name, 'podgroup-u1')
    assertEquals(g.seen.map((s) => s.method), ['GET', 'GET'])
  } finally {
    g.restore()
  }
})

Deno.test('job drawer reads: a namespace’s gangs, and one queue by name — a refusal is said, not read as none', async () => {
  const one = `${Q}/acme-payments-prod`
  for (const [reply, state] of [[{ status: 200, body: { metadata: { name: 'acme-payments-prod' } } }, 'present'], [notFound, 'missing'], [forbidden, 'denied']] as const) {
    const g = fakeGateway({ [one]: reply })
    try {
      const r = await readQueue('acme-payments-prod')
      assertEquals(r.state, state)
      assertEquals(r.leaf?.metadata.name, state === 'present' ? 'acme-payments-prod' : undefined)
      assertEquals(g.seen.map((s) => `${s.method} ${s.url}`), [`GET ${one.slice(4)}`])
    } finally {
      g.restore()
    }
  }
  const list = `${PG}/namespaces/shop-prod/podgroups`
  for (const [reply, want] of [[{ status: 200, body: { items: [{ metadata: { name: 'x' } }] } }, { n: 1, forbidden: false }], [forbidden, { n: 0, forbidden: true }], [notFound, { n: 0, forbidden: false }]] as const) {
    const g = fakeGateway({ [list]: reply })
    try {
      const r = await readNamespaceGangs('shop-prod')
      assertEquals({ n: r.items.length, forbidden: r.forbidden }, want)
    } finally {
      g.restore()
    }
  }
  const boom = fakeGateway({ [list]: { status: 500, body: { message: 'apiserver down' } } })
  try {
    await assertRejects(() => readNamespaceGangs('shop-prod'))
  } finally {
    boom.restore()
  }
})
