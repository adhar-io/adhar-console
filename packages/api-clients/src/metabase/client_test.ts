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
