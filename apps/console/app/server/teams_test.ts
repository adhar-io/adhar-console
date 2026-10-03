import { assertEquals } from 'jsr:@std/assert'
import { listOrgTeams, parseGroups } from './teams.ts'

/**
 * The owner picker used to read one install-wide templates repo, so every
 * organisation on the platform was offered the same list — usually just the
 * two hardcoded defaults. A team in the tenant's own Gitea org is a real group
 * with real repository access, which is what "who owns this" is asking.
 */

function api(routes: Record<string, { status: number; body?: unknown }>) {
  return (path: string) => {
    const hit = routes[path]
    if (!hit) return Promise.resolve(new Response('not found', { status: 404 }))
    return Promise.resolve(
      new Response(hit.body === undefined ? '' : JSON.stringify(hit.body), {
        status: hit.status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
}

Deno.test('an org\'s teams come back as owner options', async () => {
  const call = api({
    '/orgs/acme/teams': {
      status: 200,
      body: [
        { name: 'Owners', description: '' },
        { name: 'payments', description: 'Payments Squad' },
      ],
    },
  })
  assertEquals(await listOrgTeams(call, 'acme'), [
    { name: 'Owners', title: 'Owners' },
    { name: 'payments', title: 'Payments Squad' },
  ])
})

Deno.test('a short description is the title, a blank one falls back to the name', async () => {
  const call = api({ '/orgs/acme/teams': { status: 200, body: [{ name: 'data-eng', description: '  ' }] } })
  assertEquals(await listOrgTeams(call, 'acme'), [{ name: 'data-eng', title: 'Data Eng' }])
})

/**
 * Gitea descriptions are free text and are often a whole sentence. As a
 * dropdown label that buries the name the operator is choosing.
 */
Deno.test('a sentence-length description does not become the label', async () => {
  const call = api({
    '/orgs/acme/teams': {
      status: 200,
      body: [{ name: 'developers', description: 'Mapped from the Keycloak platform-developer group' }],
    },
  })
  assertEquals(await listOrgTeams(call, 'acme'), [{ name: 'developers', title: 'Developers' }])
})

Deno.test('another org\'s teams are never returned', async () => {
  const call = api({ '/orgs/acme/teams': { status: 200, body: [{ name: 'payments' }] } })
  assertEquals(await listOrgTeams(call, 'other-org'), [])
})

/**
 * A 404 means the org was never provisioned on this Gitea; a 403 means the
 * service token cannot see it. Both have to fall through to the next source
 * rather than fail the picker, or the wizard cannot proceed at all.
 */
Deno.test('a missing or forbidden org yields no teams rather than an error', async () => {
  for (const status of [403, 404, 500]) {
    const call = api({ '/orgs/acme/teams': { status } })
    assertEquals(await listOrgTeams(call, 'acme'), [])
  }
})

Deno.test('a non-array body cannot become a team list', async () => {
  const call = api({ '/orgs/acme/teams': { status: 200, body: { message: 'nope' } } })
  assertEquals(await listOrgTeams(call, 'acme'), [])
})

Deno.test('a team with no name is skipped, not rendered blank', async () => {
  const call = api({ '/orgs/acme/teams': { status: 200, body: [{ description: 'ghost' }, { name: 'real' }] } })
  assertEquals(await listOrgTeams(call, 'acme'), [{ name: 'real', title: 'Real' }])
})

Deno.test('a transport failure is contained', async () => {
  const boom = () => Promise.reject(new Error('socket hang up'))
  assertEquals(await listOrgTeams(boom, 'acme'), [])
})

/* The catalog-descriptor fallback older installs still rely on. */

Deno.test('Group entities are read out of a catalog descriptor', () => {
  const yaml = [
    'apiVersion: backstage.io/v1alpha1',
    'kind: Group',
    'metadata:',
    '  name: platform',
    '  title: "Platform Team"',
    'spec:',
    '  type: team',
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Component',
    'metadata:',
    '  name: not-a-group',
  ].join('\n')
  assertEquals(parseGroups(yaml), [{ name: 'platform', title: 'Platform Team' }])
})
