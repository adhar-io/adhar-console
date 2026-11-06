import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { listBatchJobs, listRuns, promInstant, promRange, readRunTemplate, restartRun, resumeRun, runNamesOf, runNow, setHold, stopRun } from './batch-api.ts'
import { pageStateOf, type RunObject, type RunTemplate } from './batch-model.ts'

/**
 * The requests against a fake Kubernetes gateway: `fetch` is what `kube` calls,
 * so these assert the actual method, path, content type and body each action
 * sends, and how every answer the apiserver can give is read.
 */

interface Seen {
  method: string
  url: string
  contentType?: string
  body?: unknown
}

type Reply = { status: number; body?: unknown } | ((req: Seen) => { status: number; body?: unknown })

function fakeGateway(routes: Record<string, Reply>) {
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

const BATCHJOBS = 'GET /api/k8s/apis/platform.adhar.io/v1alpha1'
const J = (ns: string, name: string) => ({ metadata: { name, namespace: ns } })
const forbidden = { status: 403, body: { kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403, message: 'forbidden' } }
const notFound = { status: 404, body: { kind: 'Status', status: 'Failure', reason: 'NotFound', code: 404, message: 'not found' } }

Deno.test('list: one cluster-wide read when RBAC allows it', async () => {
  const g = fakeGateway({ [`${BATCHJOBS}/batchjobs`]: { status: 200, body: { items: [J('prod', 'a'), J('dev', 'a')] } } })
  try {
    const l = await listBatchJobs(['prod', 'dev'])
    assertEquals(l.scope, 'cluster')
    assertEquals(l.items.length, 2)
    assertEquals(l.namespaces.sort(), ['dev', 'prod'])
    assertEquals(g.seen.length, 1)
  } finally {
    g.restore()
  }
})

Deno.test('list: 404 means the API is not installed, which is not an error', async () => {
  const g = fakeGateway({ [`${BATCHJOBS}/batchjobs`]: notFound })
  try {
    const l = await listBatchJobs(['prod'])
    assertEquals(l.installed, false)
    assertEquals(pageStateOf({ list: l, isLoading: false, isError: false }), 'not-installed')
  } finally {
    g.restore()
  }
})

Deno.test('list: cluster-wide refused, each namespace is asked', async () => {
  const g = fakeGateway({
    [`${BATCHJOBS}/batchjobs`]: forbidden,
    [`${BATCHJOBS}/namespaces/prod/batchjobs`]: forbidden,
    [`${BATCHJOBS}/namespaces/dev/batchjobs`]: { status: 200, body: { items: [J('dev', 'a')] } },
  })
  try {
    const l = await listBatchJobs(['prod', 'dev', 'dev', ''])
    assertEquals(l.scope, 'namespaces')
    assertEquals(l.namespaces, ['dev', 'prod'])
    assertEquals(l.denied, ['prod'])
    assertEquals(l.items.map((j) => j.metadata.name), ['a'])
    assertEquals(pageStateOf({ list: l, isLoading: false, isError: false }), 'ready')
  } finally {
    g.restore()
  }
})

Deno.test('list: refused everywhere is forbidden, never an empty page', async () => {
  const g = fakeGateway({ [`${BATCHJOBS}/`]: forbidden })
  try {
    const l = await listBatchJobs(['prod', 'dev'])
    assertEquals(l.denied, ['dev', 'prod'])
    assertEquals(pageStateOf({ list: l, isLoading: false, isError: false }), 'forbidden')
  } finally {
    g.restore()
  }
  const h = fakeGateway({ [`${BATCHJOBS}/`]: forbidden })
  try {
    assertEquals(pageStateOf({ list: await listBatchJobs([]), isLoading: false, isError: false }), 'forbidden')
  } finally {
    h.restore()
  }
})

Deno.test('list: anything else is a real failure and is thrown', async () => {
  const g = fakeGateway({ [`${BATCHJOBS}/batchjobs`]: { status: 400, body: { message: 'bad' } } })
  try {
    await assertRejects(() => listBatchJobs(['prod']))
  } finally {
    g.restore()
  }
})

const JOBS = 'GET /api/k8s/apis/batch/v1'
const VOLCANO = 'GET /api/k8s/apis/batch.volcano.sh/v1alpha1'
const PODS = 'GET /api/k8s/api/v1'

Deno.test('runs: selected by label, both kinds tagged for what they are', async () => {
  const g = fakeGateway({
    [`${JOBS}/jobs`]: { status: 200, body: { items: [{ metadata: { name: 'r1', namespace: 'prod' } }] } },
    [`${VOLCANO}/jobs`]: { status: 200, body: { items: [{ metadata: { name: 'r2', namespace: 'prod' } }] } },
    [`${PODS}/pods`]: { status: 200, body: { items: [{ metadata: { name: 'p' } }] } },
  })
  try {
    const l = await listRuns('cluster', [])
    assertEquals(l.runs.map((r) => r.apiVersion), ['batch/v1', 'batch.volcano.sh/v1alpha1'])
    assertEquals(l.pods.length, 1)
    assert(l.volcano)
    assert(!l.podsUnknown)
    for (const req of g.seen) assert(decodeURIComponent(req.url).includes('labelSelector=adhar.io/batch-job'), req.url)
  } finally {
    g.restore()
  }
})

Deno.test('runs: no Volcano on the cluster is a fact, not a failure', async () => {
  const g = fakeGateway({
    [`${JOBS}/jobs`]: { status: 200, body: { items: [] } },
    [`${VOLCANO}/`]: notFound,
    [`${PODS}/pods`]: { status: 200, body: { items: [] } },
  })
  try {
    const l = await listRuns('cluster', [])
    assertEquals(l.volcano, false)
    assertEquals(l.forbidden, false)
  } finally {
    g.restore()
  }
})

Deno.test('runs: reading no pods makes exit codes unknown; reading no runs is forbidden', async () => {
  const g = fakeGateway({
    [`${JOBS}/jobs`]: { status: 200, body: { items: [{ metadata: { name: 'r1' } }] } },
    [`${VOLCANO}/`]: notFound,
    [`${PODS}/`]: forbidden,
  })
  try {
    assertEquals((await listRuns('cluster', ['prod'])).podsUnknown, true)
  } finally {
    g.restore()
  }
  const h = fakeGateway({ [`${JOBS}/`]: forbidden, [`${VOLCANO}/`]: notFound, [`${PODS}/`]: forbidden })
  try {
    const l = await listRuns('namespaces', ['prod'])
    assertEquals(l.forbidden, true)
    assertEquals(l.runs, [])
  } finally {
    h.restore()
  }
})

Deno.test('runs: a namespace that refuses makes the list partial, not empty', async () => {
  const g = fakeGateway({
    [`${JOBS}/namespaces/dev/jobs`]: { status: 200, body: { items: [{ metadata: { name: 'r1' } }] } },
    [`${JOBS}/namespaces/prod/jobs`]: forbidden,
    [`${VOLCANO}/`]: notFound,
    [`${PODS}/`]: { status: 200, body: { items: [] } },
  })
  try {
    const l = await listRuns('namespaces', ['dev', 'prod'])
    assertEquals(l.runs.length, 1)
    assertEquals(l.partial, true)
    assertEquals(l.forbidden, false)
  } finally {
    g.restore()
  }
})

const CM = 'GET /api/k8s/api/v1/namespaces/prod/configmaps'

Deno.test('template: each state the dialog has words for', async () => {
  const g = fakeGateway({ [`${CM}/importer-run`]: notFound })
  try {
    assertEquals((await readRunTemplate('prod', 'importer')).state, 'missing')
  } finally {
    g.restore()
  }
  const h = fakeGateway({ [`${CM}/importer-run`]: forbidden })
  try {
    const r = await readRunTemplate('prod', 'importer')
    assertEquals(r.state, 'forbidden')
    assert('message' in r && r.message.includes('get configmaps'))
  } finally {
    h.restore()
  }
  const i = fakeGateway({ [`${CM}/importer-run`]: { status: 200, body: { data: { 'template.yaml': 'kind: Pod\napiVersion: v1\n' } } } })
  try {
    assertEquals((await readRunTemplate('prod', 'importer')).state, 'invalid')
  } finally {
    i.restore()
  }
  const k = fakeGateway({ [`${CM}/custom-name`]: { status: 200, body: { data: { 'template.yaml': '{"kind":"Job","apiVersion":"batch/v1","metadata":{},"spec":{"template":{"spec":{"containers":[{"name":"batch"}]}}}}' } } } })
  try {
    // `status.runTemplate` names it when the composition says so.
    assertEquals((await readRunTemplate('prod', 'importer', 'custom-name')).state, 'ok')
  } finally {
    k.restore()
  }
})

const template: RunTemplate = {
  kind: 'Job',
  naming: 'v1',
  fields: [],
  manifest: {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: '', labels: { 'adhar.io/batch-trigger': 'manual' } },
    spec: { template: { metadata: { labels: { 'adhar.io/batch-trigger': 'manual' } }, spec: { containers: [{ name: 'batch', image: 'img', env: [{ name: 'ADHAR_BATCH_PARAMS', value: '{}' }, { name: 'ADHAR_BATCH_TRIGGER', value: 'manual' }] }] } } },
  },
}

Deno.test('run now: POSTs the template under its identity, as the user', async () => {
  const g = fakeGateway({ 'POST /api/k8s/apis/batch/v1/namespaces/prod/jobs': (req) => ({ status: 201, body: req.body }) })
  try {
    const out = await runNow({ namespace: 'prod', batchJob: 'importer', template, params: { businessDate: '2026-11-03', note: 'x' }, identifying: { businessDate: '2026-11-03' } })
    assert(out.created)
    assertEquals(g.seen.length, 1)
    const req = g.seen[0]
    assertEquals(req.method, 'POST')
    assertEquals(req.contentType, 'application/json')
    const body = req.body as RunObject
    assertEquals(body.metadata.name, 'importer-09932cb3')
    assertEquals(body.metadata.namespace, 'prod')
    assertEquals(body.metadata.labels?.['adhar.io/batch-trigger'], 'manual')
    assertEquals(JSON.parse(body.spec!.template!.spec!.containers![0].env![0].value!), { businessDate: '2026-11-03', note: 'x' })
  } finally {
    g.restore()
  }
})

Deno.test('run now: AlreadyExists shows that run and starts nothing', async () => {
  const g = fakeGateway({ 'POST /api/k8s/apis/batch/v1/namespaces/prod/jobs': { status: 409, body: { kind: 'Status', reason: 'AlreadyExists', code: 409, message: 'exists' } } })
  try {
    const out = await runNow({ namespace: 'prod', batchJob: 'importer', template, params: {}, identifying: {} })
    assertEquals(out, { created: false, existing: 'importer-44136fa3' })
    assertEquals(g.seen.length, 1)
  } finally {
    g.restore()
  }
})

Deno.test('run now: a Kyverno denial reaches the person, with its message', async () => {
  const g = fakeGateway({ 'POST /api/k8s/': { status: 400, body: { kind: 'Status', code: 400, message: 'admission webhook denied: image differs from the template' } } })
  try {
    await assertRejects(() => runNow({ namespace: 'prod', batchJob: 'importer', template, params: {}, identifying: {} }), Error, 'image differs')
    // A mutation is never retried.
    assertEquals(g.seen.length, 1)
  } finally {
    g.restore()
  }
})

Deno.test('restart: POSTs the -r<n> name with the trigger and the run it continues', async () => {
  const g = fakeGateway({ 'POST /api/k8s/apis/batch/v1/namespaces/prod/jobs': (req) => ({ status: 201, body: req.body }) })
  try {
    await restartRun({ namespace: 'prod', name: 'importer-09932cb3-r1', template, params: { businessDate: '2026-11-03' }, restartOf: 'importer-09932cb3' })
    const body = g.seen[0].body as RunObject
    assertEquals(body.metadata.name, 'importer-09932cb3-r1')
    assertEquals(body.metadata.labels?.['adhar.io/batch-trigger'], 'restart')
    const env = body.spec!.template!.spec!.containers![0].env!
    assertEquals(env.find((e) => e.name === 'ADHAR_BATCH_TRIGGER')?.value, 'restart')
    assertEquals(env.find((e) => e.name === 'ADHAR_BATCH_RESTART_OF')?.value, 'importer-09932cb3')
  } finally {
    g.restore()
  }
})

Deno.test('stop and resume: a merge patch on the Job, nothing else', async () => {
  const native: RunObject = { apiVersion: 'batch/v1', metadata: { name: 'r', namespace: 'prod', uid: 'u' } }
  const g = fakeGateway({ 'PATCH /api/k8s/apis/batch/v1/namespaces/prod/jobs/r': { status: 200, body: {} } })
  try {
    await stopRun(native)
    await resumeRun(native)
    assertEquals(g.seen.map((s) => s.body), [{ spec: { suspend: true } }, { spec: { suspend: false } }])
    assertEquals(g.seen[0].contentType, 'application/merge-patch+json')
  } finally {
    g.restore()
  }
})

Deno.test('stop: a Volcano Job gets a Command in its namespace', async () => {
  const volcano: RunObject = { apiVersion: 'batch.volcano.sh/v1alpha1', metadata: { name: 'r', namespace: 'prod', uid: 'u' } }
  const g = fakeGateway({ 'POST /api/k8s/apis/bus.volcano.sh/v1alpha1/namespaces/prod/commands': { status: 201, body: {} } })
  try {
    await stopRun(volcano)
    assertEquals((g.seen[0].body as { action: string }).action, 'AbortJob')
  } finally {
    g.restore()
  }
})

Deno.test('hold and release: the annotation on the BatchJob', async () => {
  const g = fakeGateway({ 'PATCH /api/k8s/apis/platform.adhar.io/v1alpha1/namespaces/prod/batchjobs/importer': { status: 200, body: {} } })
  try {
    await setHold('prod', 'importer', 'late file')
    await setHold('prod', 'importer', null)
    assertEquals(g.seen.map((s) => s.body), [
      { metadata: { annotations: { 'adhar.io/batch-hold': 'late file' } } },
      { metadata: { annotations: { 'adhar.io/batch-hold': null } } },
    ])
  } finally {
    g.restore()
  }
})

Deno.test('prometheus: through /api/prom/batch; an empty vector is an answer, a refusal is not', async () => {
  const g = fakeGateway({
    'POST /api/prom/batch': (req) => {
      const item = (req.body as { items: Array<{ kind: string; query: string }> }).items[0]
      if (item.query === 'broken') return { status: 200, body: { results: [{ status: 200, body: { status: 'error', error: 'bad query' } }] } }
      if (item.query === 'down') return { status: 200, body: { results: [{ status: 503, body: 'nope' }] } }
      if (item.kind === 'range') return { status: 200, body: { results: [{ status: 200, body: { data: { result: [{ values: [[10, '1.5'], [20, 'NaN']] }] } } }] } }
      if (item.query === 'empty') return { status: 200, body: { results: [{ status: 200, body: { data: { result: [] } } }] } }
      return { status: 200, body: { results: [{ status: 200, body: { data: { result: [{ metric: { a: 'b' }, value: [1, '2'] }] } } }] } }
    },
  })
  try {
    assertEquals(await promInstant('q'), [{ labels: { a: 'b' }, value: 2 }])
    assertEquals(await promInstant('empty'), [])
    await assertRejects(() => promInstant('broken'), Error, 'bad query')
    await assertRejects(() => promInstant('down'), Error, 'not configured')
    assertEquals(await promRange('r', 0, 100_000), [[10_000, 1.5]])
  } finally {
    g.restore()
  }
})

Deno.test('restart names: only this job, only this namespace', () => {
  const runs = [
    { namespace: 'prod', batchJob: 'a', name: 'a-1' },
    { namespace: 'dev', batchJob: 'a', name: 'a-2' },
    { namespace: 'prod', batchJob: 'b', name: 'b-1' },
  ]
  assertEquals(runNamesOf(runs, 'prod', 'a'), ['a-1'])
})
