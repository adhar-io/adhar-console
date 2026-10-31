import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { PlanningClient, toPlanIssue, toPlanRelations } from './planning.ts'

/**
 * Planning routes against the fork the platform runs (`adhar-io/plane`
 * `adhar-v1.4.2-1`, `apps/api/plane/api/urls/*`). Each call is recorded and
 * compared with the path, query and body that source accepts.
 */
function recorder(responses: Record<string, unknown> = {}, statuses: Record<string, number> = {}) {
  const calls: Array<{ route: string; body?: unknown }> = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const route = `${method} ${url.pathname}${url.search}`
    calls.push({ route, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const sk = Object.keys(statuses).find((k) => route.startsWith(k))
    if (sk) return Promise.resolve(Response.json({ detail: 'Not found.' }, { status: statuses[sk] }))
    const key = Object.keys(responses).find((k) => route.startsWith(k))
    const out = key ? responses[key] : method === 'DELETE' ? null : {}
    return Promise.resolve(out === null ? new Response(null, { status: 204 }) : Response.json(out))
  }) as typeof fetch
  return { client: PlanningClient.create({ baseUrl: 'http://plane.test', fetchImpl }), calls }
}

const P = '/api/v1/workspaces/acme/projects/p1'

Deno.test('plan issues: expand=state folds the state group in and follows the cursor', async () => {
  const { client, calls } = recorder({
    [`GET ${P}/issues/?expand=state&cursor=100%3A1%3A0`]: { results: [{ id: 'i2', name: 'B', project: 'p1', state: 's2', priority: 'low', created_at: 'x' }], next_page_results: false },
    [`GET ${P}/issues/?expand=state`]: {
      results: [{ id: 'i1', name: 'A', project: 'p1', state: { id: 's1', group: 'started', name: 'Doing', color: '#f00' }, priority: 'high', assignees: ['u1'], labels: [], created_at: 'x' }],
      next_cursor: '100:1:0',
      next_page_results: true,
    },
  })
  const rows = await client.listPlanIssues('acme', 'p1')
  assertEquals(rows.map((r) => [r.id, r.state, r.state_group ?? null]), [['i1', 's1', 'started'], ['i2', 's2', null]])
  assertEquals(calls.map((c) => c.route), [`GET ${P}/issues/?expand=state`, `GET ${P}/issues/?expand=state&cursor=100%3A1%3A0`])
})

Deno.test('cycle + module membership: ids, add with {issues}, remove by issue id', async () => {
  const { client, calls } = recorder({ [`GET ${P}/cycles/c1/cycle-issues/`]: [{ id: 'i1' }, { id: 'i2' }] })
  assertEquals(await client.listCycleIssueIds('acme', 'p1', 'c1'), ['i1', 'i2'])
  await client.addCycleIssues('acme', 'p1', 'c1', ['i3'])
  await client.addCycleIssues('acme', 'p1', 'c1', [])
  await client.removeCycleIssue('acme', 'p1', 'c1', 'i3')
  await client.addModuleIssues('acme', 'p1', 'm1', ['i4'])
  await client.removeModuleIssue('acme', 'p1', 'm1', 'i4')
  assertEquals(calls.map((c) => c.route), [
    `GET ${P}/cycles/c1/cycle-issues/?fields=id`,
    `POST ${P}/cycles/c1/cycle-issues/`,
    `DELETE ${P}/cycles/c1/cycle-issues/i3/`,
    `POST ${P}/modules/m1/module-issues/`,
    `DELETE ${P}/modules/m1/module-issues/i4/`,
  ])
  assertEquals(calls[1].body, { issues: ['i3'] })
})

Deno.test('sprint lifecycle: dates PATCH on the cycle, transfer with new_cycle_id', async () => {
  const { client, calls } = recorder()
  await client.setCycleDates('acme', 'p1', 'c1', { start_date: '2026-10-01T00:00:00Z', end_date: '2026-10-14T23:59:59Z' })
  await client.transferCycle('acme', 'p1', 'c1', 'c2')
  assertEquals(calls.map((c) => c.route), [`PATCH ${P}/cycles/c1/`, `POST ${P}/cycles/c1/transfer-issues/`])
  assertEquals(calls[1].body, { new_cycle_id: 'c2' })
})

Deno.test('roadmap reschedule PATCHes issues/ and modules/ dates', async () => {
  const { client, calls } = recorder()
  await client.setIssueDates('acme', 'p1', 'i1', { start_date: '2026-10-02', target_date: null })
  await client.setModuleDates('acme', 'p1', 'm1', { target_date: '2026-11-01' })
  await client.setIssueState('acme', 'p1', 'i1', 's9')
  assertEquals(calls.map((c) => [c.route, c.body]), [
    [`PATCH ${P}/issues/i1/`, { start_date: '2026-10-02', target_date: null }],
    [`PATCH ${P}/modules/m1/`, { target_date: '2026-11-01' }],
    [`PATCH ${P}/issues/i1/`, { state: 's9' }],
  ])
})

Deno.test('project membership: POST returns the pk; role change and removal use it', async () => {
  const { client, calls } = recorder({ [`POST ${P}/project-members/`]: { id: 'pm-1', member: 'u1', role: 15 } })
  const m = await client.addProjectMembership('acme', 'p1', 'u1', 15)
  assertEquals(m.id, 'pm-1')
  await client.setProjectMemberRole('acme', 'p1', 'pm-1', 20)
  await client.removeProjectMembership('acme', 'p1', 'pm-1')
  assertEquals(calls.map((c) => c.route), [`POST ${P}/project-members/`, `PATCH ${P}/project-members/pm-1/`, `DELETE ${P}/project-members/pm-1/`])
  assertEquals(calls[1].body, { role: 20 })
})

Deno.test('estimates: a 404 (route not registered) is null, other errors surface', async () => {
  const a = recorder({}, { [`GET ${P}/estimates/`]: 404 })
  assertEquals(await a.client.estimatePoints('acme', 'p1'), null)
  const b = recorder({}, { [`GET ${P}/estimates/`]: 500 })
  await assertRejects(() => b.client.estimatePoints('acme', 'p1'))
})

Deno.test('estimates: after a 404 the client stops asking (saves the shared rate limit)', async () => {
  const { client, calls } = recorder({}, { [`GET ${P}/estimates/`]: 404 })
  assertEquals(await client.estimatePoints('acme', 'p1'), null)
  assertEquals(await client.estimatePoints('acme', 'p2'), null)
  assertEquals(calls.filter((c) => c.route.endsWith('/estimates/')).length, 1)
})

Deno.test('relations flatten to issue ids per type', async () => {
  const { client, calls } = recorder({ [`GET ${P}/work-items/i1/relations/`]: { blocked_by: [{ project_id: 'p1', issue_id: 'i2' }], blocking: ['i3'] } })
  const r = await client.relationsOf('acme', 'p1', 'i1')
  assertEquals([r.blocked_by, r.blocking, r.relates_to], [['i2'], ['i3'], []])
  assertEquals(calls[0].route, `GET ${P}/work-items/i1/relations/`)
  assertEquals(toPlanRelations(null).duplicate, [])
})

Deno.test('toPlanIssue tolerates a flat state id and expanded assignees', () => {
  const i = toPlanIssue({ id: 'x', name: 'n', project: { id: 'p' }, state: 's', assignees: [{ id: 'u' }], labels: ['l'], created_at: 't' })
  assertEquals([i.project, i.state, i.state_group, i.assignees, i.priority], ['p', 's', undefined, ['u'], 'none'])
})
