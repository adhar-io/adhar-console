import { assertEquals } from 'jsr:@std/assert@1'
import { PlaneInsightsClient } from './insights.ts'

const P = '/api/v1/workspaces/acme/projects/p1'

function fake() {
  const calls: string[] = []
  const issue = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, priority: 'none', state: 's1', project: 'p1', workspace: 'w', created_at: '2026-10-01T00:00:00Z', ...extra,
  })
  const fetchImpl = ((input: string | URL | Request) => {
    const path = String(input).replace('http://plane.test', '')
    calls.push(path)
    const u = new URL(path, 'http://x')
    const cursor = u.searchParams.get('cursor')
    let out: unknown
    switch (u.pathname) {
      case `${P}/issues/`:
        out = cursor
          ? { results: [issue('i3')], next_page_results: false }
          : { results: [issue('i1', { estimate_point: 'pt-5' }), issue('i2')], next_cursor: '1000:1:0', next_page_results: true }
        break
      case `${P}/estimates/`:
        out = { id: 'e1' }
        break
      case `${P}/estimates/e1/estimate-points/`:
        out = [{ id: 'pt-5', value: '5' }]
        break
      case `${P}/cycles/c1/cycle-issues/`:
        out = { results: [{ id: 'i1' }], next_page_results: false }
        break
      case `${P}/issues/i1/activities/`:
        out = { results: [{ id: 'a1', verb: 'updated', field: 'state', old_identifier: 's1', new_identifier: 's2', actor: 'u', created_at: '2026-10-02T00:00:00Z' }] }
        break
      default:
        return Promise.resolve(new Response('nope', { status: 404 }))
    }
    return Promise.resolve(Response.json(out))
  }) as typeof fetch
  return { client: PlaneInsightsClient.create({ baseUrl: 'http://plane.test', fetchImpl }), calls }
}

Deno.test('listIssuesLite reads the issue list only — no membership fan-out', async () => {
  const { client, calls } = fake()
  const rows = await client.listIssuesLite('acme', 'p1')
  assertEquals(rows.map((r) => r.id), ['i1', 'i2', 'i3'])
  assertEquals(rows[0].estimate_point, 5)
  assertEquals(rows[0].estimate_point_id, 'pt-5')
  assertEquals(rows[1].assignees, [])
  assertEquals(calls.some((c) => c.includes('/cycles/')), false)
  assertEquals(calls[0], `${P}/issues/?per_page=1000`)
})

Deno.test('cycle membership ids ask only for ids', async () => {
  const { client, calls } = fake()
  assertEquals(await client.listCycleIssueIds('acme', 'p1', 'c1'), ['i1'])
  assertEquals(calls[0], `${P}/cycles/c1/cycle-issues/?fields=id`)
})

Deno.test('issue history keeps the raw state identifiers', async () => {
  const { client } = fake()
  const [a] = await client.listIssueHistory('acme', 'p1', 'i1')
  assertEquals(a.new_identifier, 's2')
})
