import { assertEquals } from 'jsr:@std/assert@1'
import { MetabaseClient, unwrapList } from './index.ts'

function fake(routes: Record<string, unknown>) {
  const fetchImpl = ((input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    if (!(path in routes)) throw new Error(`unexpected ${path}`)
    return Promise.resolve(Response.json(routes[path]))
  }) as typeof fetch
  return MetabaseClient.create({ baseUrl: 'http://mb.test', fetchImpl })
}

Deno.test('lists accept both the bare array and the { data, total } envelope', async () => {
  assertEquals(unwrapList([1, 2]), [1, 2])
  assertEquals(unwrapList({ data: [3], total: 1 }), [3])
  assertEquals(unwrapList({ error: 'nope' }), [])
  // Metabase ≥ 0.42 wraps /api/database — this is what crashed the SQL editor.
  const c = fake({ '/api/database': { data: [{ id: 1, name: 'Warehouse', engine: 'postgres' }], total: 1 }, '/api/card': [] })
  assertEquals((await c.listDatabases()).map((d) => d.name), ['Warehouse'])
  assertEquals(await c.listQuestions(), [])
})

Deno.test('dashboards read cards from dashcards (Metabase ≥ 0.47) and skip text cards', async () => {
  const c = fake({
    '/api/dashboard/7': { id: 7, name: 'KPIs', dashcards: [{ id: 1, card_id: 11 }, { id: 2, card_id: null }] },
    '/api/card/11': { id: 11, name: 'Revenue' },
  })
  const { dashboard, cards } = await c.getDashboard(7)
  assertEquals(cards.map((q) => q.name), ['Revenue'])
  assertEquals(dashboard.cards?.length, 2)
})

/* ───────────── Metabase 0.51 wire API ───────────── */

type Call = { method: string; path: string; search: string; body: unknown }

function recorder(handler: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input))
    const call: Call = {
      method: init?.method ?? 'GET',
      path: u.pathname,
      search: u.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    const r = handler(call)
    return Promise.resolve(Response.json(r.body, { status: r.status ?? 200 }))
  }) as typeof fetch
  return { calls, client: MetabaseClient.create({ baseUrl: 'http://mb.test', fetchImpl }) }
}

Deno.test('search sends repeated models and unwraps the envelope', async () => {
  const { calls, client } = recorder(() => ({ body: { data: [{ id: 1, model: 'dashboard', name: 'KPIs' }], total: 1 } }))
  const hits = await client.search({ q: 'kpi', models: ['dashboard', 'card'] })
  assertEquals(hits.map((h) => h.name), ['KPIs'])
  assertEquals(calls[0].search, '?q=kpi&models=dashboard&models=card')
})

Deno.test('dashboard detail normalises legacy ordered_cards and missing tabs', async () => {
  const { client } = recorder(() => ({ body: { id: 3, name: 'Old', ordered_cards: [{ id: 9, card_id: 4, row: 0, col: 0, size_x: 4, size_y: 4 }] } }))
  const d = await client.getDashboardDetail(3)
  assertEquals(d.dashcards.length, 1)
  assertEquals(d.tabs, [])
  assertEquals(d.parameters, [])
})

Deno.test('addCardToDashboard keeps every existing dashcard and appends below them', async () => {
  const { calls, client } = recorder((c) => {
    if (c.method === 'GET') {
      return {
        body: {
          id: 5,
          name: 'D',
          tabs: [{ id: 70, name: 'One' }],
          dashcards: [
            { id: 1, card_id: 11, dashboard_tab_id: 70, row: 0, col: 0, size_x: 12, size_y: 6 },
            { id: 2, card_id: null, dashboard_tab_id: 70, row: 6, col: 0, size_x: 24, size_y: 2, visualization_settings: { text: 'hi' } },
          ],
        },
      }
    }
    return { body: { id: 5, name: 'D', dashcards: (c.body as { dashcards: unknown[] }).dashcards } }
  })
  await client.addCardToDashboard(5, 42)
  const put = calls.find((c) => c.method === 'PUT')!
  assertEquals(put.path, '/api/dashboard/5')
  const body = put.body as { dashcards: Array<Record<string, unknown>>; tabs: unknown[] }
  assertEquals(body.dashcards.length, 3)
  assertEquals(body.dashcards[1].visualization_settings, { text: 'hi' })
  assertEquals(body.dashcards[2], {
    id: -1, card_id: 42, dashboard_tab_id: 70, row: 8, col: 0, size_x: 12, size_y: 6,
    parameter_mappings: [], visualization_settings: {}, series: [],
  })
  assertEquals(body.tabs, [{ id: 70, name: 'One' }])
})

Deno.test('runNative sends template tags and parameter values', async () => {
  const { calls, client } = recorder(() => ({ body: { status: 'completed', data: { rows: [[1]], cols: [{ name: 'x' }] }, row_count: 1 } }))
  const tag = { id: 't1', name: 'n', 'display-name': 'N', type: 'number' }
  const res = await client.runNative(2, 'select {{n}}', {
    templateTags: { n: tag },
    parameters: [{ type: 'category', value: 5, target: ['variable', ['template-tag', 'n']] }],
  })
  assertEquals(res.row_count, 1)
  assertEquals(calls[0].body, {
    database: 2,
    type: 'native',
    native: { query: 'select {{n}}', 'template-tags': { n: tag } },
    parameters: [{ type: 'category', value: 5, target: ['variable', ['template-tag', 'n']] }],
  })
})

Deno.test('recentViews falls back to the pre-0.50 endpoint and normalises both shapes', async () => {
  const { calls, client } = recorder((c) =>
    c.path === '/api/activity/recents'
      ? { status: 404, body: { message: 'nope' } }
      : { body: [{ model: 'dashboard', model_id: 4, model_object: { name: 'Sales' }, max_ts: '2026-10-01' }] }
  )
  assertEquals(await client.recentViews(), [
    { model: 'dashboard', id: 4, name: 'Sales', timestamp: '2026-10-01', display: undefined, moderated_status: undefined },
  ])
  assertEquals(calls.map((c) => c.path), ['/api/activity/recents', '/api/activity/recent_views'])
})

Deno.test('bookmarks toggle with POST / DELETE and archive is a PUT', async () => {
  const { calls, client } = recorder(() => ({ body: {} }))
  await client.setBookmark('dashboard', 3, true)
  await client.setBookmark('card', 8, false)
  await client.archiveCard(8)
  assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /api/bookmark/dashboard/3',
    'DELETE /api/bookmark/card/8',
    'PUT /api/card/8',
  ])
  assertEquals(calls[2].body, { archived: true })
})

Deno.test('the stub implements the whole interface', async () => {
  const s = MetabaseClient.stub()
  const d = await s.createDashboard({ name: 'New', collection_id: null })
  const after = await s.addCardToDashboard(d.id, 101)
  assertEquals(after.dashcards.length, 1)
  assertEquals((await s.runCard(101)).status, 'completed')
  assertEquals((await s.listCards()).length > 0, true)
})
