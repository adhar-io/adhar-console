import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { PlaneClient } from './index.ts'

/**
 * A tiny fake of Plane 1.4's public API — only the routes and response shapes
 * the console's client relies on, as verified against the upstream source.
 */
function fakePlane() {
  const calls: string[] = []
  const P = '/api/v1/workspaces/acme/projects/p1'
  const issue = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, priority: 'none', state: 's1', project: 'p1', workspace: 'w', created_at: '2026-10-01T00:00:00Z',
    assignees: [], labels: [], description_html: '<p>Body</p>', ...extra,
  })
  const page = (results: unknown[], next?: string) => ({
    results, next_cursor: next ?? '', next_page_results: Boolean(next), total_results: results.length,
  })
  const handler = (method: string, path: string, body: unknown): unknown => {
    const u = new URL(path, 'http://x')
    const cursor = u.searchParams.get('cursor')
    const route = `${method} ${u.pathname}`
    switch (route) {
      case `GET /api/v1/workspaces/acme/members/`:
        return [{ id: 'u1', first_name: 'Ada', email: 'ada@x.io', display_name: 'ada', role: 20 }]
      case `GET ${P}/issues/`:
        return cursor === '1000:1:0'
          ? page([issue('i3', { parent: 'i1' })])
          : page([issue('i1', { estimate_point: 'pt-5' }), issue('i2')], '1000:1:0')
      case `GET ${P}/cycles/`:
        return page([{ id: 'c1', name: 'Sprint', start_date: '2020-01-01', end_date: '2099-01-01', total_issues: 4, completed_issues: 1, cancelled_issues: 0 }])
      case `GET ${P}/modules/`:
        return page([{ id: 'm1', name: 'Auth', status: 'backlog' }])
      case `GET ${P}/cycles/c1/cycle-issues/`:
        return page([{ id: 'i1' }])
      case `GET ${P}/modules/m1/module-issues/`:
        return page([{ id: 'i2' }])
      case `GET ${P}/estimates/`:
        return { id: 'est1' }
      case `GET ${P}/estimates/est1/estimate-points/`:
        return [{ id: 'pt-3', value: '3' }, { id: 'pt-5', value: '5' }]
      case `PATCH ${P}/issues/i2/`:
        return issue('i2', body as Record<string, unknown>)
      case `POST ${P}/cycles/c1/cycle-issues/`:
      case `POST ${P}/modules/m1/module-issues/`:
        return []
      case `DELETE ${P}/modules/m1/module-issues/i2/`:
        return null
    }
    throw new Error(`unexpected ${route}`)
  }
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.replace('http://plane.test', '')
    calls.push(`${method} ${path}`)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const out = handler(method, path, body)
    return Promise.resolve(out === null ? new Response(null, { status: 204 }) : Response.json(out))
  }) as typeof fetch
  return { client: PlaneClient.create({ baseUrl: 'http://plane.test', fetchImpl }), calls }
}

Deno.test('listIssues follows the cursor, adds membership and resolves estimates', async () => {
  const { client, calls } = fakePlane()
  const rows = await client.listIssues('acme', 'p1')
  assertEquals(rows.map((r) => r.id), ['i1', 'i2', 'i3'])
  const i1 = rows.find((r) => r.id === 'i1')!
  assertEquals(i1.cycle, 'c1')
  assertEquals(i1.module, null)
  assertEquals(i1.estimate_point, 5)
  assertEquals(i1.estimate_point_id, 'pt-5')
  assertEquals(i1.description_stripped, 'Body')
  assertEquals(rows.find((r) => r.id === 'i2')!.module, 'm1')
  // Membership lookups only ask for ids.
  assertEquals(calls.some((c) => c.includes('cycle-issues/?fields=id')), true)
})

Deno.test('container filters read the container list instead of the whole project', async () => {
  const { client, calls } = fakePlane()
  const rows = await client.listIssues('acme', 'p1', { cycle: 'c1' })
  assertEquals(rows.map((r) => r.id), ['i1'])
  assertEquals(rows[0].cycle, 'c1')
  assertEquals(calls.some((c) => c.startsWith('GET /api/v1/workspaces/acme/projects/p1/issues/')), false)
})

Deno.test('cycles get a derived status and progress; modules keep backlog', async () => {
  const { client } = fakePlane()
  const [c] = await client.listCycles('acme', 'p1')
  assertEquals(c.status, 'current')
  assertEquals(c.progress, 25)
  const [m] = await client.listModules('acme', 'p1')
  assertEquals(m.status, 'backlog')
  assertEquals(m.members, [])
})

Deno.test('members are user-keyed with Plane 1.x roles', async () => {
  const { client } = fakePlane()
  const [m] = await client.listMembers('acme')
  assertEquals(m.id, 'u1')
  assertEquals(m.member?.id, 'u1')
  assertEquals(m.role, 20)
})

Deno.test('updateIssue maps the estimate to its point and moves cycle and module membership', async () => {
  const { client, calls } = fakePlane()
  const out = await client.updateIssue('acme', 'p1', 'i2', { estimate_point: 3, cycle: 'c1', module: null }, { cycle: null, module: 'm1' })
  const patch = calls.find((c) => c.startsWith('PATCH'))
  assertEquals(patch, 'PATCH /api/v1/workspaces/acme/projects/p1/issues/i2/')
  assertEquals(out.cycle, 'c1')
  assertEquals(out.module, null)
  assertEquals(calls.includes('POST /api/v1/workspaces/acme/projects/p1/cycles/c1/cycle-issues/'), true)
  assertEquals(calls.includes('DELETE /api/v1/workspaces/acme/projects/p1/modules/m1/module-issues/i2/'), true)
  assertEquals(out.estimate_point, 3)
})

Deno.test('an estimate value the project does not have is refused with the valid choices', async () => {
  const { client } = fakePlane()
  await assertRejects(
    () => client.updateIssue('acme', 'p1', 'i2', { estimate_point: 8 }),
    Error,
    'No estimate point 8. This project\'s points are 3, 5.',
  )
})

Deno.test('sub-issues come from the parent field', async () => {
  const { client } = fakePlane()
  const subs = await client.listSubIssues('acme', 'p1', 'i1')
  assertEquals(subs.map((s) => s.id), ['i3'])
})
