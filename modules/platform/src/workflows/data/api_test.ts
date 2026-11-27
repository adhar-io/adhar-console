import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import {
  archiveQuery,
  decideApproval,
  getCapabilities,
  getRunLogs,
  listArchive,
  listRuns,
  readCapabilities,
  readEngine,
  suspendAllSchedules,
  retryRun,
  setSuspended,
  shutdownRun,
  submitRun,
  WorkflowsApiError,
} from './api.ts'
import { buildRun, entryOf } from './catalog.ts'

/**
 * The requests against a fake gateway and BFF: `fetch` is what both clients
 * call, so these assert the method, path, content type and body each action
 * sends — Kubernetes objects through `/api/k8s` as the user, argo-server only
 * through `/api/workflows` (INV-9).
 */

interface Seen {
  method: string
  url: string
  contentType?: string
  body?: unknown
}
type Reply = { status: number; body?: unknown } | ((req: Seen) => { status: number; body?: unknown })

function fake(routes: Record<string, Reply>) {
  const seen: Seen[] = []
  const saved = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const req: Seen = {
      method: init?.method ?? 'GET',
      url,
      contentType: (init?.headers as Record<string, string> | undefined)?.['content-type'],
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    seen.push(req)
    const key = Object.keys(routes).filter((k) => `${req.method} ${url}`.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    const route = key ? routes[key] : { status: 500, body: { message: `no route for ${req.method} ${url}` } }
    const r = typeof route === 'function' ? route(req) : route
    return Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, statusText: String(r.status) }))
  }) as typeof fetch
  return { seen, restore: () => (globalThis.fetch = saved) }
}

const WF = '/api/k8s/apis/argoproj.io/v1alpha1'
const forbidden = { status: 403, body: { kind: 'Status', code: 403, reason: 'Forbidden', message: 'forbidden' } }
const wf = (ns: string, name: string, created: string) => ({ metadata: { name, namespace: ns, creationTimestamp: created } })

Deno.test('a team member: the cluster-wide list is refused, so each namespace is listed and a refusal is reported, not fatal', async () => {
  const g = fake({
    [`GET ${WF}/workflows?`]: forbidden,
    [`GET ${WF}/namespaces/shop-dev/workflows`]: { status: 200, body: { items: [wf('shop-dev', 'a', '2026-11-25T01:00:00Z')] } },
    [`GET ${WF}/namespaces/shop/workflows`]: { status: 200, body: { items: [wf('shop', 'b', '2026-11-25T02:00:00Z')] } },
    [`GET ${WF}/namespaces/billing/workflows`]: forbidden,
  })
  try {
    const r = await listRuns({ namespaces: ['shop-dev', 'shop', 'billing'], labelSelector: 'workflows.argoproj.io/completed!=true' })
    assertEquals(r.mode, 'namespaces')
    assertEquals(r.items.map((w) => w.metadata.name), ['b', 'a']) // newest first
    assertEquals(r.denied, ['billing'])
    assert(g.seen.every((s) => s.url.includes('labelSelector=workflows.argoproj.io%2Fcompleted%21%3Dtrue')))
    assert(g.seen.every((s) => s.url.includes('limit=200')))
  } finally {
    g.restore()
  }
})

Deno.test('Argo not installed reads as missing, not as an error', async () => {
  const g = fake({ [`GET ${WF}/workflows`]: { status: 404, body: { kind: 'Status', code: 404, message: 'not found' } } })
  try {
    assertEquals((await listRuns({ namespaces: [] })).missing, true)
  } finally {
    g.restore()
  }
})

Deno.test('submit POSTs a Workflow with generateName to its namespace, and never a service account', async () => {
  const g = fake({ [`POST ${WF}/namespaces/shop-dev/workflows`]: (req) => ({ status: 201, body: { ...(req.body as object), metadata: { name: 'db-check-x1y2z', namespace: 'shop-dev' } } }) })
  try {
    const entry = entryOf({ kind: 'WorkflowTemplate', metadata: { name: 'db-check', namespace: 'shop-dev' }, spec: { arguments: { parameters: [{ name: 't', value: 'a' }] } } }, 'WorkflowTemplate')
    const created = await submitRun(buildRun({ entry, namespace: 'shop-dev', values: { t: 'b' } }, 'v1'))
    assertEquals(created.metadata.name, 'db-check-x1y2z')
    const sent = g.seen[0].body as { metadata: Record<string, unknown>; spec: Record<string, unknown> }
    assertEquals(sent.metadata.generateName, 'db-check-')
    assert(!('name' in sent.metadata), 'a submit lets the apiserver name the run')
    assert(!JSON.stringify(sent).includes('serviceAccount'))
    assertEquals(sent.spec.workflowTemplateRef, { name: 'db-check' })
  } finally {
    g.restore()
  }
})

Deno.test('a dry run goes through server-side apply with dryRun and a concrete name', async () => {
  const g = fake({ ['POST /api/k8s/-/apply']: (req) => ({ status: 200, body: (req.body as { manifest: unknown }).manifest }) })
  try {
    const entry = entryOf({ kind: 'WorkflowTemplate', metadata: { name: 'db-check', namespace: 'shop-dev' }, spec: {} }, 'WorkflowTemplate')
    await submitRun(buildRun({ entry, namespace: 'shop-dev', values: {} }, undefined), { dryRun: true })
    const body = g.seen[0].body as { dryRun: boolean; manifest: { metadata: Record<string, unknown> } }
    assertEquals(body.dryRun, true)
    assert(String(body.manifest.metadata.name).startsWith('db-check-dryrun'))
    assert(!('generateName' in body.manifest.metadata))
  } finally {
    g.restore()
  }
})

Deno.test('stop, terminate, suspend and resume are merge patches of spec, as the user', async () => {
  const g = fake({ [`PATCH ${WF}/namespaces/shop-dev/workflows/r`]: { status: 200, body: {} } })
  try {
    await shutdownRun('shop-dev', 'r', 'Stop')
    await shutdownRun('shop-dev', 'r', 'Terminate')
    await setSuspended('shop-dev', 'r', true)
    await setSuspended('shop-dev', 'r', false)
    assertEquals(g.seen.map((s) => s.body), [{ spec: { shutdown: 'Stop' } }, { spec: { shutdown: 'Terminate' } }, { spec: { suspend: true } }, { spec: { suspend: null } }])
    assert(g.seen.every((s) => s.contentType === 'application/merge-patch+json'))
  } finally {
    g.restore()
  }
})

Deno.test('retry and approve go to the BFF; the approver is never sent by the browser', async () => {
  const g = fake({
    ['POST /api/workflows/runs/shop-dev/r/retry']: { status: 200, body: {} },
    ['POST /api/workflows/runs/shop-dev/r/approve']: { status: 200, body: {} },
  })
  try {
    await retryRun('shop-dev', 'r', { nodeId: 'r-123', restartSuccessful: true }, 'edge')
    await decideApproval('shop-dev', 'r', { nodeId: 'r-9', decision: 'reject', comment: 'not today' })
    assertEquals(g.seen[0].url, '/api/workflows/runs/shop-dev/r/retry?cluster=edge')
    assertEquals(g.seen[0].body, { nodeId: 'r-123', restartSuccessful: true })
    assertEquals(g.seen[1].body, { nodeId: 'r-9', decision: 'reject', comment: 'not today' })
    assert(!JSON.stringify(g.seen[1].body).includes('approver'))
  } finally {
    g.restore()
  }
})

Deno.test('a BFF refusal surfaces as a typed error with its detail', async () => {
  const g = fake({ ['POST /api/workflows/runs/shop-dev/r/approve']: { status: 403, body: { error: 'self_approval_forbidden', detail: 'You submitted this run.' } } })
  try {
    const e = await assertRejects(() => decideApproval('shop-dev', 'r', { nodeId: 'x', decision: 'approve' }), WorkflowsApiError)
    assertEquals([e.status, e.code, e.message], [403, 'self_approval_forbidden', 'You submitted this run.'])
  } finally {
    g.restore()
  }
})

Deno.test('the archive query is an allow-list: no fieldSelector and no namespace parameter ever leave the browser (GHSA-q65w)', async () => {
  const hostile = { phase: 'Failed', template: 't', fieldSelector: 'metadata.namespace=other', namespace: 'other', 'listOptions.fieldSelector': 'x' } as unknown as Parameters<typeof archiveQuery>[0]
  const q = archiveQuery(hostile)
  assertEquals([...q.keys()].sort(), ['phase', 'template'])
  const g = fake({ ['GET /api/workflows/archive/shop-dev']: { status: 200, body: { items: [{ uid: 'u1', name: 'a', namespace: 'shop-dev', phase: 'Succeeded' }, { metadata: { uid: 'u2', name: 'b', namespace: 'shop-dev', labels: { 'workflows.argoproj.io/phase': 'Failed' } } }], continue: 'tok' } } })
  try {
    const r = await listArchive('shop-dev', hostile)
    assert(!g.seen[0].url.includes('fieldSelector'))
    assert(!/[?&]namespace=/.test(g.seen[0].url))
    assertEquals(r.items.map((i) => [i.uid, i.phase]), [['u1', 'Succeeded'], ['u2', 'Failed']])
    assertEquals(r.continue, 'tok')
  } finally {
    g.restore()
  }
})

Deno.test('logs say where they came from (live pod or Loki)', async () => {
  const g = fake({ ['GET /api/workflows/runs/shop-dev/r/logs']: { status: 200, body: { source: 'loki', pod: 'r-build-1', lines: ['a', 'b'], note: 'from Loki' } } })
  try {
    const l = await getRunLogs('shop-dev', 'r', { node: 'r-1', container: 'main', tail: 100 })
    assertEquals(l.source, 'loki')
    assertEquals(l.lines, ['a', 'b'])
    assertEquals(g.seen[0].url, '/api/workflows/runs/shop-dev/r/logs?node=r-1&container=main&tail=100')
  } finally {
    g.restore()
  }
})

Deno.test('capabilities: whatever the BFF omits reads as "no"', async () => {
  assertEquals(readCapabilities({ installed: true }).argoServer, { reachable: false, identity: 'none' })
  assertEquals(readCapabilities({ installed: true, argoServer: { reachable: true, identity: 'root' } }).argoServer.identity, 'none')
  const g = fake({ ['GET /api/workflows/capabilities']: { status: 200, body: { installed: true, archive: true, artifactNamespaces: ['adhar-system', 7], argoServer: { reachable: true, identity: 'user' } } } })
  try {
    const c = await getCapabilities()
    assertEquals([c.installed, c.archive, c.argoServer.identity, c.artifactNamespaces], [true, true, 'user', ['adhar-system']])
  } finally {
    g.restore()
  }
})

Deno.test('engine: a series Prometheus lacks stays null (shown as "—"), never zero', () => {
  const e = readEngine({ controller: { leader: 1, queueDepth: null, errors15m: 0 }, limits: { parallelism: 50, namespaceParallelism: '5' }, namespaces: [{ name: 'shop', parallelismLimit: 2 }, { nope: 1 }], problems: ['Prometheus: down', 7] })
  assertEquals(e.controller.leader, 1)
  assertEquals(e.controller.queueDepth, null)
  assertEquals(e.controller.errors15m, 0)
  assertEquals(e.controller.archiveDatabaseBytes, null)
  assertEquals(e.limits, { parallelism: 50, namespaceParallelism: undefined })
  assertEquals(e.namespaces, [{ name: 'shop', parallelismLimit: 2 }])
  assertEquals(e.problems, ['Prometheus: down'])
})

Deno.test('suspend-all sends the reason and reads what was suspended and what failed', async () => {
  const g = fake({ ['POST /api/workflows/engine/schedules/suspend-all']: { status: 200, body: { suspended: ['shop/nightly'], failed: [{ schedule: 'b/x', status: 403 }], alreadySuspended: 2 } } })
  try {
    const r = await suspendAllSchedules({ reason: 'incident 42' })
    assertEquals(g.seen[0].body, { reason: 'incident 42' })
    assertEquals(r, { suspended: ['shop/nightly'], failed: [{ schedule: 'b/x', status: 403 }], alreadySuspended: 2 })
  } finally {
    g.restore()
  }
})
