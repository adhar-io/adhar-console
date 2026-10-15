import { assertEquals } from 'jsr:@std/assert@1'
import { PlaneClient } from './index.ts'

/**
 * The newer Define features — intake, links, relations, search, lifecycle,
 * workflow, project members and stickies — against the routes and request
 * bodies of the Plane fork the platform runs (`adhar-io/plane`
 * `adhar-v1.4.2-1`, `apps/api/plane/api/urls/*` and `views/*`). Each call is
 * recorded and compared with what that source accepts.
 */
function recorder(responses: Record<string, unknown> = {}) {
  const calls: Array<{ route: string; body?: unknown }> = []
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const route = `${method} ${url.pathname}${url.search}`
    calls.push({ route, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = Object.keys(responses).find((k) => route.startsWith(k))
    const out = key ? responses[key] : method === 'DELETE' ? null : {}
    return Promise.resolve(out === null ? new Response(null, { status: 204 }) : Response.json(out))
  }) as typeof fetch
  return { client: PlaneClient.create({ baseUrl: 'http://plane.test', fetchImpl }), calls }
}

const P = '/api/v1/workspaces/acme/projects/p1'

Deno.test('intake: list by status, create with an issue body, triage by status', async () => {
  const { client, calls } = recorder({ [`GET ${P}/intake-issues/`]: { results: [{ id: 'x', issue: 'i1', status: -2, created_at: '' }], next_cursor: '' } })
  const rows = await client.listIntake('acme', 'p1', -2)
  assertEquals(rows.length, 1)
  await client.createIntake('acme', 'p1', { name: 'Bug' })
  await client.updateIntake('acme', 'p1', 'i1', { status: 2, duplicate_to: 'i9' })
  await client.deleteIntake('acme', 'p1', 'i1')
  assertEquals(calls.map((c) => c.route), [
    `GET ${P}/intake-issues/?status=-2`,
    `POST ${P}/intake-issues/`,
    `PATCH ${P}/intake-issues/i1/`,
    `DELETE ${P}/intake-issues/i1/`,
  ])
  assertEquals(calls[1].body, { issue: { priority: 'none', name: 'Bug' } })
  assertEquals(calls[2].body, { status: 2, duplicate_to: 'i9' })
})

Deno.test('links live under issues/, relations under work-items/ with relation_type + issues', async () => {
  const { client, calls } = recorder({ [`GET ${P}/work-items/i1/relations/`]: { blocked_by: [{ project_id: 'p1', issue_id: 'i2' }] } })
  await client.createLink('acme', 'p1', 'i1', { url: 'https://x.io', title: 'Spec' })
  await client.deleteLink('acme', 'p1', 'i1', 'l1')
  const rel = await client.listRelations('acme', 'p1', 'i1')
  await client.createRelation('acme', 'p1', 'i1', 'blocking', ['i3'])
  assertEquals(calls.map((c) => c.route), [
    `POST ${P}/issues/i1/links/`,
    `DELETE ${P}/issues/i1/links/l1/`,
    `GET ${P}/work-items/i1/relations/`,
    `POST ${P}/work-items/i1/relations/`,
  ])
  // Every group is present even when Plane omits it.
  assertEquals(rel.blocked_by, [{ project_id: 'p1', issue_id: 'i2' }])
  assertEquals(rel.relates_to, [])
  assertEquals(calls[3].body, { relation_type: 'blocking', issues: ['i3'] })
})

Deno.test('search is workspace-wide unless a project is given', async () => {
  const { client, calls } = recorder({ 'GET /api/v1/workspaces/acme/issues/search/': { issues: [{ id: 'i1', name: 'A', sequence_id: 4, project_id: 'p1', project__identifier: 'CON' }] } })
  const hits = await client.searchIssues('acme', 'CON-4')
  await client.searchIssues('acme', 'login', { project: 'p1', limit: 5 })
  assertEquals(hits[0].project__identifier, 'CON')
  assertEquals(calls[0].route, 'GET /api/v1/workspaces/acme/issues/search/?search=CON-4&limit=10&workspace_search=true')
  assertEquals(calls[1].route, 'GET /api/v1/workspaces/acme/issues/search/?search=login&limit=5&workspace_search=false&project_id=p1')
})

Deno.test('cycle, module and project lifecycle routes', async () => {
  const { client, calls } = recorder()
  await client.transferCycleIssues('acme', 'p1', 'c1', 'c2')
  await client.archiveCycle('acme', 'p1', 'c1')
  await client.unarchiveCycle('acme', 'p1', 'c1')
  await client.archiveModule('acme', 'p1', 'm1')
  await client.unarchiveModule('acme', 'p1', 'm1')
  await client.archiveProject('acme', 'p1')
  await client.unarchiveProject('acme', 'p1')
  assertEquals(calls.map((c) => c.route), [
    `POST ${P}/cycles/c1/transfer-issues/`,
    `POST ${P}/cycles/c1/archive/`,
    `DELETE ${P}/archived-cycles/c1/unarchive/`,
    `POST ${P}/modules/m1/archive/`,
    `DELETE ${P}/archived-modules/m1/unarchive/`,
    `POST ${P}/archive/`,
    `DELETE ${P}/archive/`,
  ])
  assertEquals(calls[0].body, { new_cycle_id: 'c2' })
})

Deno.test('project members come from the lite list; inactive members are hidden', async () => {
  const { client, calls } = recorder({
    [`GET ${P}/project-members-lite/`]: {
      results: [{ id: 'u1', role: 20, is_active: true }, { id: 'u2', role: 15, is_active: false }],
      next_cursor: '',
    },
  })
  const members = await client.listProjectMembers('acme', 'p1')
  await client.addProjectMember('acme', 'p1', 'u3', 15)
  assertEquals(members.map((m) => m.id), ['u1'])
  assertEquals(calls[1], { route: `POST ${P}/project-members/`, body: { member: 'u3', role: 15 } })
})

Deno.test('states, labels and stickies use their collection routes', async () => {
  const { client, calls } = recorder({ 'GET /api/v1/workspaces/acme/stickies/': [] })
  await client.createState('acme', 'p1', { name: 'QA', color: '#f00', group: 'started' })
  await client.updateState('acme', 'p1', 's1', { default: true })
  await client.deleteLabel('acme', 'p1', 'l1')
  await client.listStickies('acme')
  await client.updateSticky('acme', 'k1', { name: 'Hi' })
  assertEquals(calls.map((c) => c.route), [
    `POST ${P}/states/`,
    `PATCH ${P}/states/s1/`,
    `DELETE ${P}/labels/l1/`,
    'GET /api/v1/workspaces/acme/stickies/',
    'PATCH /api/v1/workspaces/acme/stickies/k1/',
  ])
})
