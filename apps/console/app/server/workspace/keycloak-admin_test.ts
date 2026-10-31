/**
 * The Keycloak admin client is strict now — every failure is a typed KcError —
 * and these pin the parts of the REST contract a mistake would silently break:
 * paging, exact top-level matching, Location parsing, the id cache's recovery
 * from a group re-created behind it, and the error mapping handlers rely on.
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { idFromLocation, KcError, kcErrorResponse, KeycloakAdmin, MEMBERS_CAP } from './keycloak-admin.ts'
import { FakeKeycloak } from './testing/fake-keycloak.ts'

const cfg = { base: 'http://kc.test', realm: 'adhar', clientId: 'adhar-console', clientSecret: 's' }

/** A client over a hand-written fetch: `routes` answers admin calls by path, token calls are automatic. */
function stubbed(route: (method: string, url: URL) => Response | Promise<Response>) {
  const calls: string[] = []
  const client = new KeycloakAdmin(cfg, {
    fetch: (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/openid-connect/token')) return Promise.resolve(Response.json({ access_token: 't', expires_in: 300 }))
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
      return Promise.resolve(route(init?.method ?? 'GET', url))
    },
  })
  return { client, calls }
}

Deno.test('group members are read page by page, and capped with truncated', async () => {
  const kc = new FakeKeycloak()
  kc.addGroup('org-big')
  for (let i = 0; i < 1203; i++) kc.join(kc.addUser({ username: `u${String(i).padStart(4, '0')}@x.test` }), 'org-big')
  const c = kc.client()
  const r = await c.listGroupMembers('org-big')
  assertEquals([r.members.length, r.truncated], [1203, false])
  assertEquals(kc.calls.filter((x) => x.path.endsWith('/members')).map((x) => x.query.get('first')), ['0', '500', '1000'])

  // A group past the cap comes back truncated rather than unbounded.
  let pages = 0
  const { client } = stubbed((_m, url) => {
    if (url.pathname.endsWith('/members')) {
      pages++
      return Response.json(Array.from({ length: 500 }, (_, i) => ({ id: `${url.searchParams.get('first')}-${i}`, username: 'u' })))
    }
    return Response.json([{ id: 'g1', name: 'org-huge', path: '/org-huge' }])
  })
  const huge = await client.listGroupMembers('org-huge')
  assertEquals([huge.members.length, huge.truncated, pages], [MEMBERS_CAP, true, MEMBERS_CAP / 500])
})

Deno.test('only a TOP-LEVEL group of exactly that name is found; a subgroup never is', async () => {
  const kc = new FakeKeycloak()
  kc.addGroup('org-acme-admin', 'some-parent') // a subgroup sharing the name
  const c = kc.client()
  assertEquals(await c.findGroup('org-acme-admin'), null)
  // ...and in a user's groups the subgroup does not count either.
  const u = kc.addUser({ username: 'sneaky@x.test' })
  const sub = [...kc.groups.values()].find((g) => g.name === 'org-acme-admin')!
  kc.members.get(sub.id)!.add(u)
  assertEquals(await c.getUserGroups(u), [])
  // A real top-level group is found, and its id cached.
  kc.addGroup('org-acme-admin')
  const g = await c.findGroup('org-acme-admin')
  assertEquals(g?.path, '/org-acme-admin')
})

Deno.test('ids come from the Location header', async () => {
  assertEquals(idFromLocation('http://kc/admin/realms/adhar/users/0b6d8f6e-1111-4c2c-9d8e-123456789abc'), '0b6d8f6e-1111-4c2c-9d8e-123456789abc')
  assertEquals(idFromLocation('/admin/realms/adhar/groups/g-1/'), 'g-1')
  assertEquals(idFromLocation(null), null)
  const kc = new FakeKeycloak()
  const c = kc.client()
  const id = await c.createUser({ email: 'new@x.test' })
  assertEquals(kc.users.get(id)?.username, 'new@x.test')
  const g = await c.ensureGroup('org-new')
  assertEquals(kc.groups.get(g.id)?.name, 'org-new')
})

Deno.test('a group deleted and re-created behind the id cache is re-resolved once', async () => {
  const kc = new FakeKeycloak()
  const c = kc.client()
  const u = kc.addUser({ username: 'a@x.test' })
  await c.ensureGroup('org-acme') // cached
  // Someone deletes the group in the admin console and creates it again.
  const old = [...kc.groups.values()].find((g) => g.name === 'org-acme')!
  kc.groups.delete(old.id)
  kc.members.delete(old.id)
  kc.addGroup('org-acme')
  await c.addUserToGroup(u, 'org-acme')
  assertEquals(kc.groupsOf(u), ['org-acme'])
  // Removal recovers the same way instead of reporting a stale "already gone".
  await c.removeUserFromGroup(u, 'org-acme')
  assertEquals(kc.groupsOf(u), [])
})

Deno.test('adding to a group that does not exist creates it; removing from one is a no-op', async () => {
  const kc = new FakeKeycloak()
  const c = kc.client()
  const u = kc.addUser({ username: 'a@x.test' })
  await c.addUserToGroup(u, 'ws-team-acme.ops')
  assertEquals(kc.groupsOf(u), ['ws-team-acme.ops'])
  await c.removeUserFromGroup(u, 'org-nothing')
  await c.deleteGroup('org-nothing')
  await c.removeUserFromGroup(crypto.randomUUID(), 'ws-team-acme.ops')
})

Deno.test('failures map to typed errors, and handlers map those to HTTP', async () => {
  const down = new FakeKeycloak()
  down.down = true
  const e1 = await assertRejects(() => down.client().getUser('x'), KcError)
  assertEquals(e1.code, 'unavailable')
  assertEquals(kcErrorResponse(e1)!.status, 503)

  const deny = new FakeKeycloak()
  deny.deny = true
  const e2 = await assertRejects(() => deny.client().listGroupMembers('org-x'), KcError)
  assertEquals([e2.code, e2.status], ['denied', 403])
  assert(e2.detail.includes('query-groups'), e2.detail)
  const r2 = kcErrorResponse(e2)!
  assertEquals([r2.status, (await r2.json()).error], [502, 'keycloak_denied'])

  const { client } = stubbed(() => Response.json({ errorMessage: 'boom' }, { status: 500 }))
  assertEquals((await assertRejects(() => client.getUserGroups('x'), KcError)).code, 'unavailable')
  const { client: c404 } = stubbed(() => new Response(null, { status: 404 }))
  assertEquals(await c404.getUser('x'), null, 'a missing user is null, not an error')
  assertEquals((await assertRejects(() => c404.getUserGroups('x'), KcError)).code, 'not_found')
  assertEquals(kcErrorResponse(new Error('not keycloak')), null)
})

Deno.test('createGroup is exclusive: a group that already exists is a conflict, never adopted', async () => {
  const kc = new FakeKeycloak()
  const c = kc.client()
  const made = await c.createGroup('org-gamma')
  assertEquals(made.name, 'org-gamma')
  assert(kc.hasGroup('org-gamma'))
  // A concurrent request that lost the race must not quietly share it.
  const e = await assertRejects(() => c.createGroup('org-gamma'), KcError)
  assertEquals(e.code, 'conflict')
  // ensureGroup stays idempotent for callers that want "exists either way".
  assertEquals((await c.ensureGroup('org-gamma')).id, made.id)
})

Deno.test('a user\'s groups are read exactly as Keycloak spells them', async () => {
  const kc = new FakeKeycloak()
  const u = kc.addUser({ username: 'u@x.test' })
  kc.join(u, 'ORG-ACME-ADMIN')
  kc.join(u, 'org-acme')
  assertEquals((await kc.client().getUserGroups(u)).sort(), ['ORG-ACME-ADMIN', 'org-acme'])
})

Deno.test('clients get fixed wording; a part-done write says so instead of "nothing was changed"', async () => {
  const down = new FakeKeycloak()
  down.down = true
  const e = await assertRejects(() => down.client().getUser('x'), KcError)
  const warn = console.warn
  console.warn = () => {}
  try {
    const whole = await kcErrorResponse(e)!.json()
    assert(/Nothing was changed/.test(whole.detail))
    assert(!whole.detail.includes('kc.test'), whole.detail)
    const part = await kcErrorResponse(e, { partial: true })!.json()
    assertEquals(part.partial, true)
    assert(!/Nothing was changed/.test(part.detail), part.detail)
    assert(/part of the change was made/i.test(part.detail), part.detail)
  } finally {
    console.warn = warn
  }
})

Deno.test('an admin token that dies early is replaced once, not reported as a refusal', async () => {
  let n = 0
  const { client, calls } = stubbed(() => (++n === 1 ? new Response(null, { status: 401 }) : Response.json({ id: 'u', username: 'a' })))
  assertEquals((await client.getUser('u'))?.username, 'a')
  assertEquals(calls.length, 2)
})

Deno.test('query values are encoded, never spliced into the path', async () => {
  const { client, calls } = stubbed(() => Response.json([]))
  await client.findUserByEmail('a+b&max=999@x.test')
  await client.findGroup('org-x&exact=false')
  assert(calls[0].includes('email=a%2Bb%26max%3D999%40x.test'), calls[0])
  assert(calls[1].includes('search=org-x%26exact%3Dfalse'), calls[1])
})

Deno.test('the set-password email: lifespan, redirect, and SMTP failure as email_failed', async () => {
  const kc = new FakeKeycloak()
  const c = kc.client()
  const u = kc.addUser({ username: 'a@x.test' })
  await c.executeActionsEmail(u, { clientId: 'adhar-console', redirectUri: 'https://console.example.test' })
  assertEquals(kc.emails[0].query.get('client_id'), 'adhar-console')
  assertEquals(kc.emails[0].query.get('lifespan'), '259200')
  kc.emailStatus = 500
  const e = await assertRejects(() => c.executeActionsEmail(u), KcError)
  assertEquals(e.code, 'email_failed')
})

Deno.test('whether the realm can send email is read from its SMTP settings, and cached', async () => {
  const kc = new FakeKeycloak()
  const c = kc.client()
  assertEquals(await c.emailConfigured(), true)
  kc.smtpHost = null
  assertEquals(await c.emailConfigured(), true, 'cached for five minutes')
  const fresh = kc.client()
  assertEquals(await fresh.emailConfigured(), false)
})

Deno.test('member listings are reused briefly, and a write through the client invalidates them', async () => {
  const kc = new FakeKeycloak()
  const c = kc.client()
  const a = kc.addUser({ username: 'a@x.test' })
  kc.join(a, 'org-acme')
  assertEquals((await c.listGroupMembers('org-acme')).members.length, 1)
  const b = kc.addUser({ username: 'b@x.test' })
  kc.join(b, 'org-acme') // behind the client's back
  assertEquals((await c.listGroupMembers('org-acme')).members.length, 1, 'served from the cache')
  assertEquals((await c.listGroupMembers('org-acme', { fresh: true })).members.length, 2, 'fresh bypasses it')
  await c.removeUserFromGroup(a, 'org-acme')
  assertEquals((await c.listGroupMembers('org-acme')).members.length, 1)
})

Deno.test('service accounts are never offered as people', async () => {
  const kc = new FakeKeycloak()
  kc.addUser({ username: 'service-account-adhar-console', email: 'sa@x.test' })
  kc.addUser({ username: 'sam@x.test' })
  const c = kc.client()
  assertEquals((await c.searchUsers('sa')).map((u) => u.username), ['sam@x.test'])
  assertEquals(await c.findUserByEmail('sa@x.test'), null)
})
