import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.0'
import { parseRunTemplate, type RunObject, type RunRow, runRows, type RunTemplate } from './batch-model.ts'
import { createBackfill, fetchHistory, readNamespaceCalendars, releaseBackfillRuns, replayDeadLetters } from './batch-history.ts'
import type { BackfillItem } from './batch-history-model.ts'

/**
 * The Phase-3 requests against a fake console: `fetch` is what both the BFF read
 * and `kube` call, so these assert the method, path and body each one sends.
 * The two writes are the ones a second client makes too (`adhar batch backfill`,
 * `adhar batch dlq --replay`), and Kyverno's run-integrity rule compares each
 * with the run template: what differs from it is asserted field by field.
 */

interface Seen {
  method: string
  url: string
  body?: unknown
}

type Reply = { status: number; body?: unknown } | ((req: Seen) => { status: number; body?: unknown })

function fakeConsole(routes: Record<string, Reply>) {
  const seen: Seen[] = []
  const saved = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const req: Seen = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    seen.push(req)
    const key = Object.keys(routes).filter((k) => `${req.method} ${url}`.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    const route = key ? routes[key] : { status: 500, body: { message: `no route for ${req.method} ${url}` } }
    const r = typeof route === 'function' ? route(req) : route
    return Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, statusText: String(r.status) }))
  }) as typeof fetch
  return { seen, restore: () => (globalThis.fetch = saved) }
}

const TESTDATA = new URL('./testdata/batch/', import.meta.url)
const template = async (): Promise<RunTemplate> => {
  const { template } = parseRunTemplate(JSON.parse(await Deno.readTextFile(new URL('run-template-importer.configmap.json', TESTDATA))))
  assert(template)
  return template
}

type Container = { name: string; image?: string; env?: Array<{ name: string; value?: string }> }
const batchContainer = (o: unknown): Container =>
  (o as { spec: { template: { spec: { containers: Container[] } } } }).spec.template.spec.containers.find((c) => c.name === 'batch')!
const envOf = (o: unknown, name: string) => batchContainer(o).env?.find((e) => e.name === name)?.value
const metaOf = (o: unknown) =>
  (o as { metadata: { name: string; namespace: string; labels: Record<string, string>; annotations?: Record<string, string> } }).metadata

const JOBS = '/api/k8s/apis/batch/v1/namespaces/prod/jobs'
const conflict = { status: 409, body: { kind: 'Status', status: 'Failure', reason: 'AlreadyExists', code: 409, message: 'exists' } }
const forbidden = { status: 403, body: { kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403, message: 'forbidden' } }

/* ─────────────────────────── /api/batch/history ─────────────────────────── */

Deno.test('history: the query is passed through, and the answer is read', async () => {
  const g = fakeConsole({
    'GET /api/batch/history': {
      status: 200,
      body: { state: 'read', events: [{ type: 'io.adhar.batch.run.failed', subject: 'prod/importer' }], total: 1, truncated: false, degraded: false },
    },
  })
  try {
    const r = await fetchHistory({ namespace: 'prod', job: 'importer', since: '7d', limit: 200 })
    assertEquals(g.seen[0].url, '/api/batch/history?namespace=prod&job=importer&since=7d&limit=200')
    assert(r.state === 'read')
    assertEquals(r.events.length, 1)
    await fetchHistory()
    assertEquals(g.seen[1].url, '/api/batch/history')
  } finally {
    g.restore()
  }
})

Deno.test('history: no bus is an answer; an ended session and a failing console are errors, never an empty history', async () => {
  const cases: Array<[Reply, (r: Awaited<ReturnType<typeof fetchHistory>>) => void]> = [
    [
      { status: 200, body: { state: 'unavailable', reason: 'no-bus', detail: 'no bridge', events: [] } },
      (r) => assertEquals(r, { state: 'unavailable', reason: 'no-bus', detail: 'no bridge' }),
    ],
    // A console that predates the endpoint.
    [{ status: 404, body: { error: 'not_found' } }, (r) => assertEquals([r.state, r.state === 'unavailable' && r.reason], ['unavailable', 'no-endpoint'])],
    // 200 with a body that is not a history.
    [{ status: 200, body: { hello: 'world' } }, (r) => assertEquals(r.state, 'unavailable')],
  ]
  for (const [reply, check] of cases) {
    const g = fakeConsole({ 'GET /api/batch/history': reply })
    try {
      check(await fetchHistory())
    } finally {
      g.restore()
    }
  }
  for (const [status, want] of [[401, 'session has ended'], [502, 'HTTP 502']] as const) {
    const g = fakeConsole({ 'GET /api/batch/history': { status, body: {} } })
    try {
      await assertRejects(() => fetchHistory(), Error, want)
    } finally {
      g.restore()
    }
  }
})

/* ─────────────────────────── calendars ─────────────────────────── */

Deno.test('calendars: listed by label as the user; refused is not "none"', async () => {
  const CMS = 'GET /api/k8s/api/v1/namespaces'
  const g = fakeConsole({
    [`${CMS}/prod/configmaps`]: {
      status: 200,
      body: { items: [{ metadata: { name: 'bank' }, data: { 'calendar.yaml': 'name: bank\nholidays: [2026-12-25]\n' } }] },
    },
    [`${CMS}/dev/configmaps`]: forbidden,
    [`${CMS}/gone/configmaps`]: { status: 404, body: { code: 404 } },
    [`${CMS}/down/configmaps`]: { status: 500, body: { code: 500, message: 'boom' } },
  })
  try {
    const prod = await readNamespaceCalendars('prod')
    assert(decodeURIComponent(g.seen[0].url).includes('labelSelector=adhar.io/batch-calendar=true'), g.seen[0].url)
    assertEquals(prod.state, 'read')
    // The list's items carry no namespace of their own: the one asked is theirs.
    assertEquals(prod.calendars.map((c) => [c.namespace, c.name, c.holidays]), [['prod', 'bank', ['2026-12-25']]])
    assertEquals(await readNamespaceCalendars('dev'), { namespace: 'dev', state: 'forbidden', calendars: [] })
    assertEquals((await readNamespaceCalendars('gone')).state, 'absent')
    await assertRejects(() => readNamespaceCalendars('down'))
  } finally {
    g.restore()
  }
})

/* ─────────────────────────── dead-letter replay ─────────────────────────── */

Deno.test('replay: the ops Job `adhar batch dlq --replay` creates — the template, the command and the execution', async () => {
  const t = await template()
  const g = fakeConsole({ [`POST ${JOBS}`]: (req) => ({ status: 201, body: req.body }) })
  try {
    const out = await replayDeadLetters({ namespace: 'prod', template: t, name: 'importer-ops-dlq-replay-97', executionId: 97 })
    assert(out.created)
    const sent = g.seen[0].body
    assertEquals([metaOf(sent).name, metaOf(sent).namespace, metaOf(sent).labels['adhar.io/batch-trigger']], ['importer-ops-dlq-replay-97', 'prod', 'ops'])
    assertEquals(
      [
        envOf(sent, 'ADHAR_BATCH_COMMAND'),
        envOf(sent, 'ADHAR_BATCH_EXECUTION_ID'),
        envOf(sent, 'ADHAR_BATCH_TRIGGER'),
        envOf(sent, 'ADHAR_BATCH_PARAMS'),
        envOf(sent, 'ADHAR_BATCH_RESTART_OF'),
      ],
      ['dlq-replay', '97', 'ops', '{}', undefined],
    )
    // Run integrity: the image is the template's, and an ops Job is never created suspended.
    assertEquals(batchContainer(sent).image, batchContainer(t.manifest).image)
    assertEquals((sent as RunObject).spec?.suspend, (t.manifest as RunObject).spec?.suspend)
    // The retry of a failed replay says what it retries.
    await replayDeadLetters({ namespace: 'prod', template: t, name: 'importer-ops-dlq-replay-97-r1', executionId: 97, restartOf: 'importer-ops-dlq-replay-97' })
    assertEquals([metaOf(g.seen[1].body).name, envOf(g.seen[1].body, 'ADHAR_BATCH_RESTART_OF')], [
      'importer-ops-dlq-replay-97-r1',
      'importer-ops-dlq-replay-97',
    ])
  } finally {
    g.restore()
  }
})

Deno.test('replay: one that already exists is found, not started twice', async () => {
  const g = fakeConsole({ [`POST ${JOBS}`]: conflict })
  try {
    assertEquals(await replayDeadLetters({ namespace: 'prod', template: await template(), name: 'importer-ops-dlq-replay-97', executionId: 97 }), {
      created: false,
      existing: 'importer-ops-dlq-replay-97',
    })
  } finally {
    g.restore()
  }
})

/* ─────────────────────────── backfill ─────────────────────────── */

const item = (date: string, action: BackfillItem['action'], runName = `importer-${date}`, restartOf?: string): BackfillItem => ({
  businessDate: date,
  run: runName,
  action,
  params: { businessDate: date, source: 'inbound/records.csv', dryRun: 'false' },
  ...(restartOf ? { restartOf } : {}),
})

Deno.test('backfill: native runs are created SUSPENDED, in date order, only for the dates that need one', async () => {
  const t = await template()
  const g = fakeConsole({ [`POST ${JOBS}`]: (req) => ({ status: 201, body: req.body }) })
  try {
    const out = await createBackfill({
      namespace: 'prod',
      template: t,
      volcano: false,
      items: [
        item('2026-11-01', 'completed'),
        item('2026-11-02', 'create'),
        item('2026-11-03', 'exists'),
        item('2026-11-04', 'restart', 'importer-x-r1', 'importer-x'),
        item('2026-11-05', 'stopped'),
        item('2026-11-06', 'create'),
      ],
    })
    assertEquals(g.seen.map((s) => metaOf(s.body).name), ['importer-2026-11-02', 'importer-x-r1', 'importer-2026-11-06'])
    assertEquals(out.map((o) => [o.item.businessDate, o.outcome.created]), [['2026-11-02', true], ['2026-11-04', true], ['2026-11-06', true]])
    for (const s of g.seen) assertEquals((s.body as RunObject).spec?.suspend, true, 'every run waits to be released')
    // And says whose it is, as the CLI's do: only a run carrying this mark is ever released by a backfill.
    for (const s of g.seen) assertEquals(metaOf(s.body).annotations?.['adhar.io/batch-queued'], 'backfill')
    const [first, restart] = g.seen.map((s) => s.body)
    assertEquals([metaOf(first).labels['adhar.io/batch-trigger'], envOf(first, 'ADHAR_BATCH_TRIGGER'), envOf(first, 'ADHAR_BATCH_RESTART_OF')], [
      'backfill',
      'backfill',
      undefined,
    ])
    assertEquals(JSON.parse(envOf(first, 'ADHAR_BATCH_PARAMS')!), { businessDate: '2026-11-02', source: 'inbound/records.csv', dryRun: 'false' })
    // A date that failed before is a restart of that run, as Restart makes one.
    assertEquals([envOf(restart, 'ADHAR_BATCH_TRIGGER'), envOf(restart, 'ADHAR_BATCH_RESTART_OF')], ['restart', 'importer-x'])
    assertEquals(envOf(first, 'ADHAR_BATCH_COMMAND'), undefined, 'a backfill run is the business job, not a command')
  } finally {
    g.restore()
  }
})

Deno.test('backfill: on Volcano nothing is suspended — the queue decides', async () => {
  const g = fakeConsole({ [`POST ${JOBS}`]: (req) => ({ status: 201, body: req.body }) })
  try {
    await createBackfill({ namespace: 'prod', template: await template(), volcano: true, items: [item('2026-11-02', 'create')] })
    assertEquals((g.seen[0].body as RunObject).spec?.suspend, undefined)
    assertEquals(metaOf(g.seen[0].body).annotations?.['adhar.io/batch-queued'], undefined, 'nothing is held back, so nothing is marked')
  } finally {
    g.restore()
  }
})

Deno.test('backfill: a run that already exists is found; the first refusal stops the loop and says what was created', async () => {
  const t = await template()
  const g = fakeConsole({
    [`POST ${JOBS}`]: (req) => {
      const name = metaOf(req.body).name
      return name === 'importer-2026-11-01' ? conflict : name === 'importer-2026-11-03' ? forbidden : { status: 201, body: req.body }
    },
  })
  try {
    const e = await assertRejects(
      () =>
        createBackfill({
          namespace: 'prod',
          template: t,
          volcano: false,
          items: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'].map((d) => item(d, 'create')),
        }),
      Error,
      '2026-11-03:',
    )
    const err = e as Error & { created: Array<{ item: BackfillItem; outcome: { created: boolean } }>; status?: number }
    assertEquals(err.status, 403)
    assertEquals(err.created.map((c) => [c.item.businessDate, c.outcome.created]), [['2026-11-01', false], ['2026-11-02', true]])
    assertEquals(g.seen.length, 3, 'nothing is created after the refusal')
  } finally {
    g.restore()
  }
})

Deno.test('release: spec.suspend=false on each queued run, in the order given, and the mark goes in the same patch', async () => {
  const queued = (name: string): RunObject => ({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: 'prod', uid: name, labels: { 'adhar.io/batch-job': 'importer' }, annotations: { 'adhar.io/batch-queued': 'backfill' } },
    spec: { suspend: true },
  })
  const runs: RunRow[] = runRows([queued('d2'), queued('d1')], [])
  const g = fakeConsole({ [`PATCH ${JOBS}/`]: { status: 200, body: {} } })
  try {
    const order = [runs.find((r) => r.name === 'd1')!, runs.find((r) => r.name === 'd2')!]
    assertEquals(await releaseBackfillRuns(order), ['d1', 'd2'])
    assertEquals(g.seen.map((s) => [s.method, s.url, s.body]), [
      ['PATCH', `${JOBS}/d1`, { metadata: { annotations: { 'adhar.io/batch-queued': null } }, spec: { suspend: false } }],
      ['PATCH', `${JOBS}/d2`, { metadata: { annotations: { 'adhar.io/batch-queued': null } }, spec: { suspend: false } }],
    ])
  } finally {
    g.restore()
  }
})
