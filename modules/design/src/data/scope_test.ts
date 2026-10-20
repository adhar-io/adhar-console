import { assertEquals } from 'jsr:@std/assert@1'
import { defaultScope, inScope, ownerTeam, scopeFilter } from './scope.ts'

const projects = [{ slug: 'shop', teams: ['payments'] }, { slug: 'lab', teams: ['research', 'payments'] }, { slug: 'ops', teams: ['platform'] }]

Deno.test('owner team comes from the tag, else the project', () => {
  assertEquals(ownerTeam({ team: 'x', project: 'shop' }, projects), 'x')
  assertEquals(ownerTeam({ project: 'ops' }, projects), 'platform')
  assertEquals(ownerTeam({}, projects), undefined)
})

Deno.test('the team lens keeps the team’s and workspace-wide artifacts', () => {
  const lens = { filtering: true, team: 'payments', projects }
  const items = [{ id: 1 }, { id: 2, team: 'payments' }, { id: 3, project: 'lab' }, { id: 4, project: 'ops' }, { id: 5, team: 'platform' }]
  const r = scopeFilter(items, lens)
  assertEquals(r.shown.map((i) => i.id), [1, 2, 3])
  assertEquals(r.total, 5)
  assertEquals(inScope({ project: 'ops' }, { ...lens, filtering: false }), true)
})

Deno.test('new artifacts default to the active team and its only project', () => {
  assertEquals(defaultScope({ filtering: true, team: 'platform', projects }), { team: 'platform', project: 'ops' })
  assertEquals(defaultScope({ filtering: true, team: 'payments', projects }), { team: 'payments' })
  assertEquals(defaultScope({ filtering: false, team: '', projects }), {})
})
