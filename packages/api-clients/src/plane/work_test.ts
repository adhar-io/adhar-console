import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { parseIssueKey, planeToday, PlaneWorkClient } from './work.ts'

/** A fake of the Plane 1.4 public routes the work client uses. */
function fakePlane(opts: { estimates?: boolean } = {}) {
  const calls: Array<{ route: string; body?: unknown }> = []
  const P = '/api/v1/workspaces/acme/projects/p1'
  const item = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, priority: 'none', state: 's1', project: 'p1', workspace: 'w', created_at: '2026-10-01T00:00:00Z', ...extra,
  })
  const handler = (method: string, path: string): unknown => {
    const u = new URL(path, 'http://x')
    const route = `${method} ${u.pathname}`
    const cursor = u.searchParams.get('cursor')
    switch (route) {
      case `GET ${P}/issues/`:
        return cursor
          ? { results: [item('i3', { sort_order: 3 })], next_page_results: false, next_cursor: '' }
          : { results: [item('i1', { estimate_point: 'pt-5', sort_order: 1 }), item('i2', { labels: null })], next_page_results: true, next_cursor: '100:1:0' }
      case `GET ${P}/estimates/`:
        if (!opts.estimates) return { __status: 404 }
        return { id: 'e1' }
      case `GET ${P}/estimates/e1/estimate-points/`:
        return [{ id: 'pt-5', value: '5' }]
      case 'GET /api/v1/workspaces/acme/work-items/CON-42/':
        return item('i42', { sequence_id: 42 })
      case `PATCH ${P}/issues/i1/`:
        return item('i1', { sort_order: 1.5 })
      case `POST ${P}/cycles/c1/cycle-issues/`:
      case `POST ${P}/modules/m1/module-issues/`:
        return []
      case `DELETE ${P}/cycles/c1/cycle-issues/i1/`:
      case `DELETE ${P}/modules/m1/module-issues/i1/`:
        return null
      case `GET ${P}/issues/i1/issue-attachments/`:
        return [{ id: 'a1', attributes: { name: 'log.txt', size: 12 } }]
      case 'GET /api/v1/users/me/':
        return { id: 'bot', display_name: 'console-bot' }
    }
    throw new Error(`unexpected ${route}`)
  }
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace('http://plane.test', '')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ route: `${method} ${path}`, body })
    const out = handler(method, path) as { __status?: number } | null
    if (out && typeof out === 'object' && '__status' in out) return Promise.resolve(Response.json({ detail: 'nf' }, { status: out.__status }))
    return Promise.resolve(out === null ? new Response(null, { status: 204 }) : Response.json(out))
  }) as typeof fetch
  return { client: PlaneWorkClient.create({ baseUrl: 'http://plane.test', fetchImpl }), calls }
}

Deno.test('listIssuesLite follows the cursor without any membership fan-out', async () => {
  const { client, calls } = fakePlane()
  const rows = await client.listIssuesLite('acme', 'p1')
  assertEquals(rows.map((r) => r.id), ['i1', 'i2', 'i3'])
  assertEquals(rows[1].labels, [])
  assertEquals(rows[2].sort_order, 3)
  // The estimate is not resolvable (route not registered) — keep the id, no value.
  assertEquals(rows[0].estimate_point_id, 'pt-5')
  assertEquals(rows[0].estimate_point, null)
  assertEquals(calls.some((c) => c.route.includes('cycle-issues') || c.route.includes('module-issues')), false)
})

Deno.test('listIssuesLite resolves estimate values when the project exposes them', async () => {
  const { client } = fakePlane({ estimates: true })
  const rows = await client.listIssuesLite('acme', 'p1')
  assertEquals(rows[0].estimate_point, 5)
})

Deno.test('getIssueByKey reads the work-items key route and rejects non-keys', async () => {
  const { client } = fakePlane()
  assertEquals((await client.getIssueByKey('acme', 'con-42')).id, 'i42')
  await assertRejects(() => client.getIssueByKey('acme', 'hello'), Error, 'not a work item key')
})

Deno.test('bulk sprint/epic membership is one POST with every id', async () => {
  const { client, calls } = fakePlane()
  await client.addIssuesToCycle('acme', 'p1', 'c1', ['i1', 'i2'])
  await client.addIssuesToModule('acme', 'p1', 'm1', ['i1'])
  await client.addIssuesToCycle('acme', 'p1', 'c1', []) // no-op
  const posts = calls.filter((c) => c.route.startsWith('POST'))
  assertEquals(posts.length, 2)
  assertEquals(posts[0].body, { issues: ['i1', 'i2'] })
  await client.removeIssueFromCycle('acme', 'p1', 'c1', 'i1')
  await client.removeIssueFromModule('acme', 'p1', 'm1', 'i1')
  assertEquals(calls.filter((c) => c.route.startsWith('DELETE')).length, 2)
})

Deno.test('patchIssue sends rank; archiveIssue sends a Plane date', async () => {
  const { client, calls } = fakePlane()
  const out = await client.patchIssue('acme', 'p1', 'i1', { sort_order: 1.5 })
  assertEquals(out.sort_order, 1.5)
  await client.archiveIssue('acme', 'p1', 'i1', '2026-10-21')
  assertEquals(calls.at(-1)!.body, { archived_at: '2026-10-21' })
})

Deno.test('attachments and the API-key user', async () => {
  const { client } = fakePlane()
  assertEquals((await client.listAttachments('acme', 'p1', 'i1'))[0].attributes?.name, 'log.txt')
  assertEquals((await client.me()).display_name, 'console-bot')
})

Deno.test('parseIssueKey and planeToday', () => {
  assertEquals(parseIssueKey(' con-7 '), { identifier: 'CON', sequence: 7 })
  assertEquals(parseIssueKey('7'), undefined)
  assertEquals(planeToday(new Date('2026-10-21T23:00:00Z')), '2026-10-21')
})
