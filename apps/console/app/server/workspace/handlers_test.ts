/**
 * /api/workspace/* with Keycloak as the only user store.
 *
 * Every test drives the real handler and the real Keycloak admin client; only
 * the network (FakeKeycloak) and Postgres (MemoryDb) are fakes. What is pinned
 * here is what an operator relies on: membership comes from groups and is
 * written only there, every write is refused to non-admins (also when their
 * token is stale), Keycloak being down never reads as success, and nobody can
 * leave an organisation without an admin.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { handleWorkspace, type WorkspaceDeps } from './handlers.ts'
import { FakeKeycloak } from './testing/fake-keycloak.ts'
import { MemoryDb } from './testing/memory-store.ts'
import { OrgDirectory } from '../tenancy/directory.ts'
import { createLiveGroups } from '../tenancy/entitlement.ts'
import { NO_ACCESS, orgAccess } from '../tenancy/org-access.ts'
import type { RequestContext } from '../request-user.ts'
import type { TeamXrSummary, XrManifest } from '../control-plane.ts'
import { KIND } from './store.ts'

const ACME = 'acme-x1y2z'
const BETA = 'beta-q9w8e'

interface Harness {
  kc: FakeKeycloak
  db: MemoryDb
  directory: OrgDirectory
  deps: Partial<WorkspaceDeps>
  xr: { applied: XrManifest[]; deleted: XrManifest[]; backfilled: XrManifest[] }
  teamXrs: TeamXrSummary[]
  ids: Record<'alice' | 'bob' | 'carol' | 'dave' | 'pat' | 'olga' | 'nina', string>
}

/**
 * acme: alice (admin), bob (member, team payments), carol (invited member).
 * beta: olga (admin). Pat is a platform admin in no organisation; Dave and Nina
 * have Keycloak accounts and no organisation.
 */
function setup(): Harness {
  const kc = new FakeKeycloak()
  const db = new MemoryDb()
  db.put('_directory', 'workspace.org-directory', 'acme', { slug: 'acme', tenantId: ACME, name: 'Acme', createdAt: '2026-01-01T00:00:00Z' })
  db.put('_directory', 'workspace.org-directory', 'beta', { slug: 'beta', tenantId: BETA, name: 'Beta', createdAt: '2026-01-02T00:00:00Z' })
  db.put(ACME, KIND.team, 't-pay', { slug: 'payments', name: 'Payments', createdAt: '2026-01-01T00:00:00Z' })
  db.put(ACME, KIND.team, 't-plat', { slug: 'platform', name: 'Platform Team', createdAt: '2026-01-01T00:00:00Z' })
  db.put(BETA, KIND.team, 't-beta', { slug: 'payments', name: 'Beta payments', createdAt: '2026-01-01T00:00:00Z' })

  const ids = {
    alice: kc.addUser({ username: 'alice@acme.test', firstName: 'Alice', lastName: 'Admin' }),
    bob: kc.addUser({ username: 'bob@acme.test', firstName: 'Bob' }),
    carol: kc.addUser({ username: 'carol@acme.test', requiredActions: ['UPDATE_PASSWORD'] }),
    dave: kc.addUser({ username: 'dave@else.test' }),
    pat: kc.addUser({ username: 'pat@platform.test' }),
    olga: kc.addUser({ username: 'olga@beta.test' }),
    nina: kc.addUser({ username: 'nina@else.test', enabled: false }),
  }
  for (const g of ['org-acme', 'org-acme-admin']) kc.join(ids.alice, g)
  kc.join(ids.bob, 'org-acme')
  kc.join(ids.bob, 'ws-team-acme.payments')
  kc.join(ids.carol, 'org-acme')
  kc.join(ids.pat, 'platform-admin')
  for (const g of ['org-beta', 'org-beta-admin']) kc.join(ids.olga, g)

  const directory = new OrgDirectory(db.directorySource(), { log: () => {} })
  const client = kc.client()
  const xr = { applied: [] as XrManifest[], deleted: [] as XrManifest[], backfilled: [] as XrManifest[] }
  const h: Harness = { kc, db, directory, xr, teamXrs: [], ids, deps: {} }
  h.deps = {
    openStore: (t) => Promise.resolve(db.store(t)),
    kc: () => client,
    directory,
    liveGroups: createLiveGroups(() => client),
    applyXr: (m) => {
      xr.applied.push(m)
      return Promise.resolve({ ok: true, status: 200, detail: 'applied' })
    },
    backfillXrs: (ms) => void xr.backfilled.push(...ms),
    deleteConsoleXr: (m) => {
      xr.deleted.push(m)
      return Promise.resolve({ ok: true, status: 200, detail: 'deleted' })
    },
    teamXrs: () => Promise.resolve(h.teamXrs),
    consoleUrl: () => 'https://console.example.test',
    clientId: () => 'adhar-console',
  }
  return h
}

interface As {
  userId: string
  /** The TOKEN's groups; defaults to the user's groups in Keycloak right now. */
  groups?: string[]
  tenant?: string
}

async function call(
  h: Harness,
  as: As,
  method: string,
  subpath: string,
  body?: unknown,
  query = '',
): Promise<{ status: number; body: Record<string, any> }> {
  const tenant = as.tenant ?? ACME
  const entry = tenant.startsWith('_') ? null : await h.directory.byTenant(tenant)
  const groups = as.groups ?? h.kc.groupsOf(as.userId)
  const u = h.kc.users.get(as.userId)
  const ctx: RequestContext = {
    user: { id: as.userId, email: u?.email ?? '', name: u?.username ?? 'x', roles: ['viewer'], groups, tenants: [] },
    activeTenant: tenant,
    org: entry,
    access: entry ? orgAccess(groups, entry.slug) : NO_ACCESS,
    personal: !entry,
    degraded: false,
  }
  const req = new Request(`http://console.test/api/workspace/${subpath}${query}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const res = await handleWorkspace(req, subpath, { ...h.deps, context: () => Promise.resolve(ctx) })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

/* ─────────── reading membership ─────────── */

Deno.test('members are the union of org-<slug> and org-<slug>-admin, with their teams and account state', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.bob }, 'GET', 'members')
  assertEquals(r.status, 200)
  const by = Object.fromEntries(r.body.items.map((m: { email: string }) => [m.email, m]))
  assertEquals(Object.keys(by).sort(), ['alice@acme.test', 'bob@acme.test', 'carol@acme.test'])
  assertEquals(by['alice@acme.test'].role, 'admin')
  assertEquals(by['alice@acme.test'].name, 'Alice Admin')
  assertEquals(by['bob@acme.test'].role, 'member')
  assertEquals(by['bob@acme.test'].teams, ['payments'])
  assertEquals(by['carol@acme.test'].status, 'invited')
  assertEquals(by['bob@acme.test'].status, 'active')
  assertEquals(r.body.truncated, false)
  // Implicit admins are listed as groups, never as people.
  assertEquals(r.body.implicit.map((i: { group: string }) => i.group), ['platform-admin', 'platform-engineer', 'super-admin'])
  // Nothing about people was written to the console's database.
  assertEquals(h.db.all(ACME, KIND.member).length, 0)
})

Deno.test('an admin listed only in org-<slug>-admin is still listed once, as admin', async () => {
  const h = setup()
  const eve = h.kc.addUser({ username: 'eve@acme.test' })
  h.kc.join(eve, 'org-acme-admin')
  const r = await call(h, { userId: h.ids.alice }, 'GET', 'members')
  const eves = r.body.items.filter((m: { userId: string }) => m.userId === eve)
  assertEquals(eves.length, 1)
  assertEquals(eves[0].role, 'admin')
})

Deno.test('GET /me reads the role from groups and teams from Keycloak; nothing is enrolled', async () => {
  const h = setup()
  const me = await call(h, { userId: h.ids.bob }, 'GET', 'me')
  assertEquals(me.status, 200)
  assertEquals([me.body.role, me.body.via, me.body.orgSlug, me.body.isPlatformOrganisation], ['member', 'membership', 'acme', false])
  assertEquals(me.body.teams, ['payments'])
  assertEquals(me.body.org.name, 'Acme')
  // A platform admin is an admin of an organisation they are not listed in.
  const pat = await call(h, { userId: h.ids.pat }, 'GET', 'me')
  assertEquals([pat.body.role, pat.body.via], ['admin', 'platform-admin'])
  assertEquals(h.db.all(ACME, KIND.member).length, 0, 'GET /me must not create membership documents')
  assertEquals(h.kc.writes().length, 0, 'GET /me must not write to Keycloak')
})

Deno.test('someone in no organisation gets their own me, no teams, and 409 for everything else', async () => {
  const h = setup()
  const as = { userId: h.ids.dave, tenant: '_u_0123456789abcdef01234567' }
  const me = await call(h, as, 'GET', 'me')
  assertEquals(me.status, 200)
  assertEquals([me.body.role, me.body.org, me.body.orgSlug], [null, null, null])
  assertEquals((await call(h, as, 'GET', 'teams')).body, { items: [] })
  for (const [m, p] of [['GET', 'members'], ['POST', 'members'], ['GET', 'org'], ['GET', 'projects'], ['GET', 'audit']] as const) {
    const r = await call(h, as, m, p, m === 'POST' ? {} : undefined)
    assertEquals([r.status, r.body.error], [409, 'no_organisation'], `${m} ${p}`)
  }
})

Deno.test('invitations and ownership transfer are gone (410)', async () => {
  const h = setup()
  for (const [m, p] of [['GET', 'invitations'], ['POST', 'invitations'], ['POST', 'invitations/x/accept'], ['DELETE', 'invitations/x']] as const) {
    const r = await call(h, { userId: h.ids.alice }, m, p, m === 'GET' ? undefined : {})
    assertEquals([r.status, r.body.error], [410, 'invitations_removed'], `${m} ${p}`)
  }
  const t = await call(h, { userId: h.ids.alice }, 'POST', 'org/transfer', { userId: h.ids.bob })
  assertEquals([t.status, t.body.error], [410, 'ownership_removed'])
})

/* ─────────── adding people ─────────── */

Deno.test('an admin adds an existing account; the groups are the only record', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'members', { userId: h.ids.dave, teams: ['payments'] })
  assertEquals(r.status, 201)
  assertEquals([r.body.item.role, r.body.item.teams], ['member', ['payments']])
  assertEquals(h.kc.groupsOf(h.ids.dave), ['org-acme', 'ws-team-acme.payments'])
  assertEquals(h.db.all(ACME, KIND.member).length, 0)
  // And as admin: both groups, since admins are members too.
  const a = await call(h, { userId: h.ids.alice }, 'POST', 'members', { userId: h.ids.pat, role: 'admin' })
  assertEquals(a.status, 201)
  assert(h.kc.groupsOf(h.ids.pat).includes('org-acme') && h.kc.groupsOf(h.ids.pat).includes('org-acme-admin'))
})

Deno.test('adding refuses bad ids, unknown teams, missing accounts and existing members', async () => {
  const h = setup()
  const as = { userId: h.ids.alice }
  assertEquals((await call(h, as, 'POST', 'members', { userId: 'bob@acme.test' })).body.error, 'invalid_user_id')
  assertEquals((await call(h, as, 'POST', 'members', { userId: h.ids.dave, role: 'owner' })).body.error, 'invalid_role')
  assertEquals((await call(h, as, 'POST', 'members', { userId: h.ids.dave, teams: ['nope'] })).body.error, 'unknown_team')
  const missing = await call(h, as, 'POST', 'members', { userId: crypto.randomUUID() })
  assertEquals([missing.status, missing.body.error], [404, 'user_not_found'])
  const dup = await call(h, as, 'POST', 'members', { userId: h.ids.bob })
  assertEquals([dup.status, dup.body.error, dup.body.item.userId], [409, 'already_member', h.ids.bob])
  assertEquals(h.kc.groupsOf(h.ids.dave), [], 'nothing was added on any refusal')
})

Deno.test('group names never come from the client', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'members', {
    userId: h.ids.dave,
    group: 'platform-admin',
    groups: ['platform-admin', 'org-beta-admin'],
    teams: ['payments'],
  })
  assertEquals(r.status, 201)
  assertEquals(h.kc.groupsOf(h.ids.dave), ['org-acme', 'ws-team-acme.payments'])
})

Deno.test('a failed group add takes back what it added (no half-members)', async () => {
  const h = setup()
  // The team group add fails after the member group went in.
  h.kc.failOn = (c) => (c.method === 'PUT' && c.path.includes('/groups/') && h.kc.groups.get(c.path.split('/').pop()!)?.name === 'ws-team-acme.payments' ? 503 : null)
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'members', { userId: h.ids.dave, teams: ['payments'] })
  assertEquals([r.status, r.body.error], [503, 'keycloak_unavailable'])
  assertEquals(h.kc.groupsOf(h.ids.dave), [])
})

Deno.test('a new account is created, added and emailed a set-password link', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'users', { email: ' New.Person@Acme.TEST ', firstName: 'New\u0007', role: 'member', teams: ['payments'] })
  assertEquals(r.status, 201)
  assertEquals(r.body.setupEmail, { sent: true })
  const id = r.body.item.userId
  const u = h.kc.users.get(id)!
  assertEquals([u.username, u.email, u.firstName, u.requiredActions], ['new.person@acme.test', 'new.person@acme.test', 'New', ['UPDATE_PASSWORD']])
  assertEquals(r.body.item.status, 'invited')
  assertEquals(h.kc.groupsOf(id), ['org-acme', 'ws-team-acme.payments'])
  assertEquals(h.kc.emails.length, 1)
  assertEquals(h.kc.emails[0].actions, ['UPDATE_PASSWORD'])
  assertEquals(h.kc.emails[0].query.get('redirect_uri'), 'https://console.example.test')
  assertEquals(h.kc.emails[0].query.get('lifespan'), '259200')
})

Deno.test('no SMTP server on the realm: 422 before any account exists', async () => {
  const h = setup()
  h.kc.smtpHost = null
  const before = h.kc.users.size
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'users', { email: 'x@acme.test', role: 'member' })
  assertEquals([r.status, r.body.error], [422, 'keycloak_email_not_configured'])
  assertEquals(h.kc.users.size, before)
})

Deno.test('an email that already has an account is 409 user_exists, naming no account', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'users', { email: 'DAVE@else.test', role: 'member' })
  assertEquals([r.status, r.body.error], [409, 'user_exists'])
  // An organisation admin learns the address is taken, not whose account it is.
  assertEquals(r.body.userId, undefined)
  assertFalse(JSON.stringify(r.body).includes(h.ids.dave))
})

Deno.test('a failed group add after creating an account deletes the account it just made', async () => {
  const h = setup()
  h.kc.failOn = (c) => (c.method === 'PUT' && c.path.includes('/groups/') ? 503 : null)
  const before = h.kc.users.size
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'users', { email: 'temp@acme.test', role: 'admin' })
  assertEquals(r.status, 503)
  assertEquals(h.kc.users.size, before, 'the half-made account was removed')
  assert(![...h.kc.users.values()].some((u) => u.email === 'temp@acme.test'))
})

Deno.test('an email Keycloak cannot send still leaves the account in place, and says so', async () => {
  const h = setup()
  h.kc.emailStatus = 500
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'users', { email: 'mailfail@acme.test', role: 'member' })
  assertEquals(r.status, 201)
  assertEquals([r.body.setupEmail.sent, r.body.setupEmail.reason], [false, 'send_failed'])
  assert(h.kc.groupsOf(r.body.item.userId).includes('org-acme'))
})

Deno.test('a redirect the client does not allow does not stop the set-password email', async () => {
  const h = setup()
  h.kc.validRedirectPrefix = 'https://elsewhere.test'
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'users', { email: 'redir@acme.test', role: 'member' })
  assertEquals(r.body.setupEmail, { sent: true })
  assertEquals(h.kc.emails[0].query.get('redirect_uri'), null)
})

Deno.test('the set-password email is resent only to a member whose setup is pending', async () => {
  const h = setup()
  const ok = await call(h, { userId: h.ids.alice }, 'POST', `users/${h.ids.carol}/setup-email`, {})
  assertEquals([ok.status, ok.body.setupEmail.sent], [202, true])
  // Already set up: nothing to send — not "it no longer exists".
  const done = await call(h, { userId: h.ids.alice }, 'POST', `users/${h.ids.bob}/setup-email`, {})
  assertEquals([done.status, done.body.error], [409, 'setup_not_pending'])
  // Not in this organisation: the code is about that person, not the caller.
  const outside = await call(h, { userId: h.ids.alice }, 'POST', `users/${h.ids.dave}/setup-email`, {})
  assertEquals([outside.status, outside.body.error], [404, 'user_not_in_organisation'])
  h.kc.emailStatus = 500
  const fail = await call(h, { userId: h.ids.alice }, 'POST', `users/${h.ids.carol}/setup-email`, {})
  assertEquals([fail.status, fail.body.setupEmail.sent], [502, false])
  // Keycloak's SMTP error text stays in the server log.
  assertFalse(String(fail.body.detail).includes('Failed to send execute actions email'))
})

Deno.test('changing or removing someone not in the organisation names THEM, not the caller', async () => {
  const h = setup()
  for (const [m, p, b] of [['PATCH', `members/${h.ids.dave}`, { role: 'admin' }], ['DELETE', `members/${h.ids.dave}`, undefined]] as const) {
    const r = await call(h, { userId: h.ids.alice }, m, p, b)
    assertEquals([r.status, r.body.error], [404, 'user_not_in_organisation'], `${m} ${p}`)
  }
})

Deno.test('org admins look people up by exact email or username; platform admins may search', async () => {
  const h = setup()
  const exact = await call(h, { userId: h.ids.alice }, 'GET', 'users', undefined, '?q=dave@else.test')
  assertEquals([exact.body.mode, exact.body.items.length, exact.body.items[0].membership], ['exact', 1, null])
  const partial = await call(h, { userId: h.ids.alice }, 'GET', 'users', undefined, '?q=else')
  assertEquals(partial.body.items.length, 0, 'an org admin cannot enumerate the realm')
  const search = await call(h, { userId: h.ids.pat }, 'GET', 'users', undefined, '?q=acme.test')
  assertEquals(search.body.mode, 'search')
  assertEquals(search.body.items.map((u: { email: string }) => u.email).sort(), ['alice@acme.test', 'bob@acme.test', 'carol@acme.test'])
  assertEquals(search.body.items.find((u: { email: string }) => u.email === 'alice@acme.test').membership, 'admin')
  const short = await call(h, { userId: h.ids.pat }, 'GET', 'users', undefined, '?q=*a*')
  assertEquals([short.status, short.body.error], [400, 'invalid_query'])
  const member = await call(h, { userId: h.ids.bob }, 'GET', 'users', undefined, '?q=dave@else.test')
  assertEquals(member.status, 403)
})

/* ─────────── roles and removal ─────────── */

Deno.test('promotion writes both groups; demotion of the last admin is refused', async () => {
  const h = setup()
  const up = await call(h, { userId: h.ids.alice }, 'PATCH', `members/${h.ids.bob}`, { role: 'admin' })
  assertEquals([up.status, up.body.item.role], [200, 'admin'])
  assert(h.kc.groupsOf(h.ids.bob).includes('org-acme-admin'))
  // Two admins: one may step down.
  assertEquals((await call(h, { userId: h.ids.alice }, 'PATCH', `members/${h.ids.bob}`, { role: 'member' })).status, 200)
  assertFalse(h.kc.groupsOf(h.ids.bob).includes('org-acme-admin'))
  assert(h.kc.groupsOf(h.ids.bob).includes('org-acme'), 'a demoted admin stays a member')
  // One admin left: alice cannot demote herself — refused before any write,
  // not undone after one.
  const writes = h.kc.writes().length
  const last = await call(h, { userId: h.ids.alice }, 'PATCH', `members/${h.ids.alice}`, { role: 'member' })
  assertEquals([last.status, last.body.error], [409, 'cannot_demote_last_admin'])
  assert(h.kc.groupsOf(h.ids.alice).includes('org-acme-admin'))
  assertEquals(h.kc.writes().length, writes)
})

Deno.test('platform admins do not count as the remaining admin', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.pat }, 'PATCH', `members/${h.ids.alice}`, { role: 'member' })
  assertEquals([r.status, r.body.error], [409, 'cannot_demote_last_admin'])
})

Deno.test('a concurrent demotion that empties the admin group is undone', async () => {
  const h = setup()
  h.kc.join(h.ids.bob, 'org-acme-admin')
  // While alice is being demoted, someone else demotes bob.
  h.kc.afterWrite = (c) => {
    if (c.method === 'DELETE' && h.kc.groups.get(c.path.split('/').pop()!)?.name === 'org-acme-admin') {
      h.kc.afterWrite = null
      h.kc.leave(h.ids.bob, 'org-acme-admin')
    }
  }
  const r = await call(h, { userId: h.ids.pat }, 'PATCH', `members/${h.ids.alice}`, { role: 'member' })
  assertEquals([r.status, r.body.error], [409, 'cannot_demote_last_admin'])
  assert(h.kc.groupsOf(h.ids.alice).includes('org-acme-admin'), 'alice was put back')
})

Deno.test('removing a member strips their team groups, then admin, then membership', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.alice }, 'DELETE', `members/${h.ids.bob}`)
  assertEquals(r.status, 200)
  assertEquals(h.kc.groupsOf(h.ids.bob), [])
  const order = h.kc.writes().map((c) => h.kc.groups.get(c.path.split('/').pop()!)?.name)
  assertEquals(order, ['ws-team-acme.payments', 'org-acme'])
})

Deno.test('removal refuses yourself, non-members and the last admin', async () => {
  const h = setup()
  const self = await call(h, { userId: h.ids.alice }, 'DELETE', `members/${h.ids.alice}`)
  assertEquals([self.status, self.body.error], [400, 'cannot_remove_self'])
  assertEquals((await call(h, { userId: h.ids.alice }, 'DELETE', `members/${h.ids.dave}`)).status, 404)
  const last = await call(h, { userId: h.ids.pat }, 'DELETE', `members/${h.ids.alice}`)
  assertEquals([last.status, last.body.error], [409, 'cannot_remove_last_admin'])
  assertEquals((await call(h, { userId: h.ids.alice }, 'DELETE', 'members/not-a-uuid')).body.error, 'invalid_user_id')
})

Deno.test('a removal Keycloak interrupts reports partial and can be retried', async () => {
  const h = setup()
  let fail = true
  h.kc.failOn = (c) => (fail && c.method === 'DELETE' && h.kc.groups.get(c.path.split('/').pop()!)?.name === 'org-acme' ? 503 : null)
  const r = await call(h, { userId: h.ids.alice }, 'DELETE', `members/${h.ids.bob}`)
  assertEquals([r.status, r.body.partial], [503, true])
  fail = false
  assertEquals((await call(h, { userId: h.ids.alice }, 'DELETE', `members/${h.ids.bob}`)).status, 200)
  assertEquals(h.kc.groupsOf(h.ids.bob), [])
})

/* ─────────── who may write ─────────── */

Deno.test('a member is refused every write', async () => {
  const h = setup()
  const as = { userId: h.ids.bob }
  const writes: Array<[string, string, unknown?]> = [
    ['POST', 'members', { userId: h.ids.dave }],
    ['PATCH', `members/${h.ids.carol}`, { role: 'admin' }],
    ['DELETE', `members/${h.ids.carol}`],
    ['POST', 'users', { email: 'x@acme.test', role: 'member' }],
    ['POST', `users/${h.ids.carol}/setup-email`, {}],
    ['POST', 'teams', { name: 'Ops' }],
    ['PATCH', 'teams/t-pay', { name: 'X' }],
    ['DELETE', 'teams/t-pay'],
    ['POST', 'teams/t-pay/members', { userId: h.ids.carol }],
    ['DELETE', `teams/t-pay/members/${h.ids.bob}`],
    ['PUT', 'org', { name: 'Mine' }],
    ['DELETE', 'org', { confirm: 'Acme' }],
    ['POST', 'tokens', { name: 't', scopes: ['read'] }],
    ['POST', 'projects', { name: 'p' }],
  ]
  for (const [m, p, b] of writes) {
    const r = await call(h, as, m, p, b)
    assertEquals([r.status, r.body.error], [403, 'requires_org_admin'], `${m} ${p}`)
  }
  assertEquals(h.kc.writes().length, 0)
})

Deno.test('a platform admin may administer an organisation they are not in', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.pat }, 'POST', 'members', { userId: h.ids.dave })
  assertEquals(r.status, 201)
  assert(h.kc.groupsOf(h.ids.dave).includes('org-acme'))
})

Deno.test('an admin token that Keycloak no longer backs is refused (live check)', async () => {
  const h = setup()
  // Alice's token still says admin; Keycloak says she was demoted since.
  const token = h.kc.groupsOf(h.ids.alice)
  h.kc.leave(h.ids.alice, 'org-acme-admin')
  const r = await call(h, { userId: h.ids.alice, groups: token }, 'POST', 'members', { userId: h.ids.dave })
  assertEquals([r.status, r.body.error], [403, 'requires_org_admin'])
  assertEquals(h.kc.groupsOf(h.ids.dave), [])
})

Deno.test('Keycloak down: writes and the member list fail with 503, never 2xx', async () => {
  const h = setup()
  h.kc.down = true
  for (const [m, p, b] of [
    ['GET', 'members', undefined],
    ['POST', 'members', { userId: h.ids.dave }],
    ['PATCH', `members/${h.ids.bob}`, { role: 'admin' }],
    ['DELETE', `members/${h.ids.bob}`, undefined],
    ['POST', 'users', { email: 'x@acme.test', role: 'member' }],
    ['POST', 'teams', { name: 'Ops' }],
    ['DELETE', 'teams/t-pay', undefined],
    ['GET', 'teams/t-pay/members', undefined],
  ] as Array<[string, string, unknown]>) {
    const r = await call(h, { userId: h.ids.alice }, m, p, b)
    assertEquals([r.status, r.body.error], [503, 'keycloak_unavailable'], `${m} ${p}`)
  }
  assertEquals(h.db.all(ACME, KIND.team).length, 2, 'no team document was written or removed')
})

Deno.test('Keycloak refusing the console is 502 keycloak_denied; the role it lacks is named in the log only', async () => {
  const h = setup()
  h.kc.deny = true
  const logged: string[] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => void logged.push(a.join(' '))
  try {
    const r = await call(h, { userId: h.ids.alice }, 'GET', 'members')
    assertEquals([r.status, r.body.error], [502, 'keycloak_denied'])
    assertFalse(/query-groups|view-users|manage-users/.test(String(r.body.detail)), 'the realm-management role stays server-side')
    assert(logged.some((l) => l.includes('realm-management role "query-groups"')), logged.join('\n'))
  } finally {
    console.warn = warn
  }
})

Deno.test('Keycloak errors reach clients as fixed wording: no internal URL, no Keycloak text', async () => {
  const h = setup()
  h.kc.down = true
  const warn = console.warn
  console.warn = () => {}
  try {
    const r = await call(h, { userId: h.ids.alice }, 'GET', 'members')
    assertEquals(r.body.error, 'keycloak_unavailable')
    assertFalse(String(r.body.detail).includes('kc.test'), String(r.body.detail))
    assertFalse(String(r.body.detail).includes('connection refused'), String(r.body.detail))
    h.kc.down = false
    h.kc.emailStatus = 500
    const made = await call(h, { userId: h.ids.alice }, 'POST', 'users', { email: 'smtp@acme.test', role: 'member' })
    assertEquals(made.body.setupEmail.sent, false)
    assertFalse(String(made.body.setupEmail.detail).includes('Failed to send execute actions email'))
  } finally {
    console.warn = warn
  }
})

Deno.test('every admin write re-checks Keycloak — tokens, approvals and projects too', async () => {
  const h = setup()
  // Alice's token still says admin; Keycloak says she was demoted since.
  const token = h.kc.groupsOf(h.ids.alice)
  h.kc.leave(h.ids.alice, 'org-acme-admin')
  h.db.put(ACME, KIND.approval, 'ap-1', { scope: 'data-export', summary: 'x', status: 'pending', requestedBy: { id: h.ids.bob, label: 'bob' }, requestedAt: '' })
  h.db.put(ACME, KIND.project, 'p-1', { slug: 'p', name: 'P', tenantId: ACME, teams: [], giteaOrg: ACME, argoProject: 'x', harborProject: ACME, environments: ['dev'], createdAt: '' })
  h.db.put(ACME, KIND.token, 'tk-1', { name: 't', prefix: 'p', last4: '1234', hash: 'h', scopes: ['read'], ownerType: 'org', ownerId: ACME, createdAt: '' })
  for (const [m, p, b] of [
    ['POST', 'tokens', { name: 'minted-after-demotion', scopes: ['read'] }],
    ['DELETE', 'tokens/tk-1', undefined],
    ['POST', 'approvals/ap-1/approve', {}],
    ['POST', 'projects', { name: 'p2' }],
    ['PATCH', 'projects/p-1', { name: 'P2' }],
    ['DELETE', 'projects/p-1', undefined],
  ] as Array<[string, string, unknown]>) {
    const r = await call(h, { userId: h.ids.alice, groups: token }, m, p, b)
    assertEquals([r.status, r.body.error], [403, 'requires_org_admin'], `${m} ${p}`)
  }
  assertEquals(h.db.all(ACME, KIND.token).length, 1, 'no credential was minted, none revoked')
})

Deno.test('an account whose email Keycloak never verified is not added on the email alone', async () => {
  const h = setup()
  // Someone signed up with an address they need not own.
  const squatter = h.kc.addUser({ username: 'colleague@acme.test', emailVerified: false })
  const found = await call(h, { userId: h.ids.alice }, 'GET', 'users', undefined, '?q=colleague@acme.test')
  assertEquals([found.body.items[0].userId, found.body.items[0].emailVerified], [squatter, false])
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'members', { userId: squatter })
  assertEquals([r.status, r.body.error], [409, 'email_unverified'])
  // An org admin cannot vouch for it...
  const vouch = await call(h, { userId: h.ids.alice }, 'POST', 'members', { userId: squatter, allowUnverifiedEmail: true })
  assertEquals(vouch.body.error, 'email_unverified')
  assertEquals(h.kc.groupsOf(squatter), [])
  // ...a platform admin can, explicitly.
  const pat = await call(h, { userId: h.ids.pat }, 'POST', 'members', { userId: squatter, allowUnverifiedEmail: true })
  assertEquals(pat.status, 201)
  assert(h.kc.groupsOf(squatter).includes('org-acme'))
  // A verified account is added as before.
  assertEquals((await call(h, { userId: h.ids.alice }, 'POST', 'members', { userId: h.ids.dave })).status, 201)
})

Deno.test('account lookups are rate-limited per caller', async () => {
  const h = setup()
  let last = 0
  for (let i = 0; i < 61; i++) last = (await call(h, { userId: h.ids.alice }, 'GET', 'users', undefined, '?q=dave@else.test')).status
  assertEquals(last, 429)
  // Someone else is not held to alice's count.
  assertEquals((await call(h, { userId: h.ids.pat }, 'GET', 'users', undefined, '?q=dave@else.test')).status, 200)
})

Deno.test('the member list says whether Keycloak can email a set-password link', async () => {
  const h = setup()
  assertEquals((await call(h, { userId: h.ids.bob }, 'GET', 'members')).body.canEmail, true)
  const noSmtp = setup()
  noSmtp.kc.smtpHost = null
  assertEquals((await call(noSmtp, { userId: noSmtp.ids.bob }, 'GET', 'members')).body.canEmail, false)
})

Deno.test('the organisation shows the directory\'s slug, also for a settings document written before', async () => {
  const h = setup()
  // Written by the old console, which used the TENANT id as the slug.
  h.db.put(ACME, KIND.org, 'current', { slug: ACME, name: 'Acme', region: 'adhar-controlplane', plan: 'team', createdAt: '', ssoEnforced: false })
  const me = await call(h, { userId: h.ids.bob }, 'GET', 'me')
  assertEquals([me.body.orgSlug, me.body.org.slug, me.body.org.id], ['acme', 'acme', 'org-acme'])
  const org = await call(h, { userId: h.ids.bob }, 'GET', 'org')
  assertEquals([org.body.item.slug, org.body.item.id], ['acme', 'org-acme'])
  assertEquals((h.db.all<{ slug: string }>(ACME, KIND.org)[0]).data.slug, 'acme', 'the stored document is corrected once')

  // Even when the correction cannot be written, what is SHOWN is the directory's.
  const stale = setup()
  stale.db.put(ACME, KIND.org, 'current', { slug: ACME, name: 'Acme', region: 'adhar-controlplane', plan: 'team', createdAt: '', ssoEnforced: false })
  stale.deps.openStore = (t) => {
    const st = stale.db.store(t)
    return Promise.resolve({ ...st, put: (kind, id, data, by) => (kind === KIND.org ? Promise.reject(new Error('read-only')) : st.put(kind, id, data, by)) })
  }
  const shown = await call(stale, { userId: stale.ids.bob }, 'GET', 'me')
  assertEquals([shown.body.org.slug, shown.body.org.id], ['acme', 'org-acme'])
})

Deno.test('an admin of one organisation has no say in another', async () => {
  const h = setup()
  // Olga is admin of beta. Working in acme with her own groups she is nobody.
  const r = await call(h, { userId: h.ids.olga }, 'POST', 'members', { userId: h.ids.dave })
  assertEquals([r.status, r.body.error], [403, 'not_a_member'])
  // And acme's admin cannot reach beta's team by id from acme.
  const t = await call(h, { userId: h.ids.alice }, 'POST', 'teams/t-beta/members', { userId: h.ids.bob })
  assertEquals(t.status, 404)
  assertEquals(h.kc.membersOf('ws-team-beta.payments'), [])
})

/* ─────────── teams ─────────── */

Deno.test('creating a team makes its qualified group first, then the document and the Team XR', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'teams', { name: 'Ops Crew' })
  assertEquals(r.status, 201)
  assertEquals([r.body.item.slug, r.body.item.group, r.body.item.memberCount], ['ops-crew', 'ws-team-acme.ops-crew', 0])
  assert(h.kc.hasGroup('ws-team-acme.ops-crew'))
  assertEquals(h.xr.applied[0].spec.parameters, { name: 'ops-crew', organisation: 'acme', displayName: 'Ops Crew' })
  const dup = await call(h, { userId: h.ids.alice }, 'POST', 'teams', { name: 'ops crew' })
  assertEquals([dup.status, dup.body.error], [409, 'slug_taken'])
  // A slug someone TYPED is held to the Team XRD as typed...
  const bad = await call(h, { userId: h.ids.alice }, 'POST', 'teams', { name: 'Nine lives', slug: '9-lives' })
  assertEquals([bad.status, bad.body.error], [400, 'invalid_slug'])
})

Deno.test('a slug derived from the name is made to fit — never refused over a slug nobody typed', async () => {
  const h = setup()
  const digit = await call(h, { userId: h.ids.alice }, 'POST', 'teams', { name: '2026 Platform' })
  assertEquals([digit.status, digit.body.item.slug], [201, 't-2026-platform'])
  const long = await call(h, { userId: h.ids.alice }, 'POST', 'teams', { name: 'Platform Engineering and Developer Experience' })
  assertEquals([long.status, long.body.item.slug], [201, 'platform-engineering-and-developer-exper'])
  assert(h.kc.hasGroup('ws-team-acme.platform-engineering-and-developer-exper'))
  // A name nothing can be made from asks for a slug instead.
  const none = await call(h, { userId: h.ids.alice }, 'POST', 'teams', { name: '日本' })
  assertEquals([none.status, none.body.error], [400, 'invalid_slug'])
})

Deno.test('a team Keycloak could not create is not created at all', async () => {
  const h = setup()
  h.kc.failOn = (c) => (c.method === 'POST' && c.path === '/groups' ? 503 : null)
  const r = await call(h, { userId: h.ids.alice }, 'POST', 'teams', { name: 'Ops' })
  assertEquals(r.status, 503)
  assertEquals(h.db.all(ACME, KIND.team).length, 2)
  assertEquals(h.xr.applied.length, 0)
})

Deno.test('team lists count members from the group and say whether the platform binds it yet', async () => {
  const h = setup()
  h.teamXrs = [
    { organisation: 'acme', name: 'payments', group: 'ws-team-acme.payments' },
    { organisation: 'acme', name: 'platform', group: 'ws-team-platform' },
  ]
  const r = await call(h, { userId: h.ids.bob }, 'GET', 'teams')
  const by = Object.fromEntries(r.body.items.map((t: { slug: string }) => [t.slug, t]))
  assertEquals(by.payments.memberCount, 1)
  assertEquals(by.payments.accessBinding, 'current')
  assertEquals(by.platform.accessBinding, 'pending-platform-upgrade')
  assertEquals(by.platform.memberCount, 0)
  assertEquals(by.payments.keycloakGroup, 'ws-team-acme.payments')
  assertFalse('keycloakSynced' in by.payments)
  h.teamXrs = []
  assertEquals((await call(h, { userId: h.ids.bob }, 'GET', 'teams')).body.items[0].accessBinding, 'unknown')
})

Deno.test('a member count Keycloak cannot give is null, and the list says it is degraded', async () => {
  const h = setup()
  h.kc.failOn = (c) => (c.path.endsWith('/members') ? 503 : null)
  const r = await call(h, { userId: h.ids.bob }, 'GET', 'teams')
  assertEquals(r.status, 200)
  assertEquals(r.body.degraded, true)
  const by = Object.fromEntries(r.body.items.map((t: { slug: string; memberCount: number | null }) => [t.slug, t.memberCount]))
  assertEquals(by.payments, null, 'unknown, not zero')
  // A team whose group does not exist yet has no members — no call needed.
  assertEquals(by.platform, 0)
})

Deno.test('the first team is seeded, but nobody is put in it', async () => {
  const h = setup()
  const tenant = BETA
  h.db.store(tenant).remove(KIND.team, 't-beta')
  const r = await call(h, { userId: h.ids.olga, tenant }, 'GET', 'teams')
  assertEquals(r.body.items.map((t: { slug: string }) => t.slug), ['platform'])
  assertEquals(h.kc.writes().length, 0, 'seeding the team wrote nothing to Keycloak')
  assertEquals(h.kc.membersOf('ws-team-platform'), [])
})

Deno.test('team members: only organisation members (explicit or implicit) can be added', async () => {
  const h = setup()
  const add = await call(h, { userId: h.ids.alice }, 'POST', 'teams/t-pay/members', { userId: h.ids.carol })
  assertEquals([add.status, add.body.item.memberCount], [200, 2])
  assertEquals(h.kc.membersOf('ws-team-acme.payments').sort(), [h.ids.bob, h.ids.carol].sort())
  const outsider = await call(h, { userId: h.ids.alice }, 'POST', 'teams/t-pay/members', { userId: h.ids.dave })
  // About the person added — `not_a_member` would tell alice SHE is not one.
  assertEquals([outsider.status, outsider.body.error], [409, 'user_not_in_organisation'])
  // A platform admin is a member of every organisation without being listed.
  assertEquals((await call(h, { userId: h.ids.alice }, 'POST', 'teams/t-pay/members', { userId: h.ids.pat })).status, 200)
  const list = await call(h, { userId: h.ids.bob }, 'GET', 'teams/t-pay/members')
  assertEquals(list.body.items.length, 3)
  const rm = await call(h, { userId: h.ids.alice }, 'DELETE', `teams/t-pay/members/${h.ids.carol}`)
  assertEquals([rm.status, rm.body.item.memberCount], [200, 2])
})

Deno.test('a Team resource the console could not delete is reported, not implied gone', async () => {
  const h = setup()
  h.deps.deleteConsoleXr = (m) => {
    h.xr.deleted.push(m)
    return Promise.resolve({ ok: false, status: 403, detail: 'deleting Team/acme-payments failed (HTTP 403)' })
  }
  const r = await call(h, { userId: h.ids.alice }, 'DELETE', 'teams/t-pay')
  assertEquals([r.status, r.body.ok, r.body.controlPlaneSynced], [200, true, false])
  assert(String(r.body.controlPlaneDetail).includes('left in place'))
})

Deno.test('deleting a team deletes its group and its console-declared Team XR', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.alice }, 'DELETE', 'teams/t-pay')
  assertEquals([r.status, r.body.controlPlaneSynced], [200, true])
  assertFalse(h.kc.hasGroup('ws-team-acme.payments'))
  assertEquals(h.xr.deleted.map((m) => m.metadata.name), ['acme-payments'])
  assertEquals(h.db.all(ACME, KIND.team).length, 1)
  // beta's team of the same name is untouched.
  assertEquals(h.db.all(BETA, KIND.team).length, 1)
})

/* ─────────── the organisation ─────────── */

Deno.test('deleting an organisation deletes its groups first and keeps its namespace and Gitea org', async () => {
  const h = setup()
  const wrong = await call(h, { userId: h.ids.alice }, 'DELETE', 'org', { confirm: 'acme' })
  assertEquals([wrong.status, wrong.body.error], [400, 'confirmation_mismatch'])
  const r = await call(h, { userId: h.ids.alice }, 'DELETE', 'org', { confirm: 'Acme' })
  assertEquals(r.status, 200)
  assertEquals(r.body.retained, ['Organisation resource', 'namespace', 'Gitea organisation'])
  for (const g of ['org-acme', 'org-acme-admin', 'ws-team-acme.payments']) assertFalse(h.kc.hasGroup(g), g)
  assertEquals(h.db.all(ACME, KIND.team).length, 0)
  h.directory.invalidate()
  assertEquals(await h.directory.byTenant(ACME), null, 'the directory forgets it')
})

Deno.test('an organisation Keycloak cannot clean up is not deleted', async () => {
  const h = setup()
  h.kc.failOn = (c) => (c.method === 'DELETE' && c.path.startsWith('/groups/') ? 503 : null)
  const r = await call(h, { userId: h.ids.alice }, 'DELETE', 'org', { confirm: 'Acme' })
  assertEquals(r.status, 503)
  assertEquals(h.db.all(ACME, KIND.team).length, 2)
  assert(await h.directory.byTenant(ACME))
})

Deno.test('the platform organisation cannot be deleted', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.pat, tenant: 'default' }, 'DELETE', 'org', { confirm: 'Adhar' })
  assertEquals([r.status, r.body.error], [409, 'platform_organisation'])
  const me = await call(h, { userId: h.ids.pat, tenant: 'default' }, 'GET', 'me')
  assertEquals([me.body.orgSlug, me.body.isPlatformOrganisation], ['adhar', true])
})

Deno.test('renaming the organisation renames it in the shared directory too', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.alice }, 'PUT', 'org', { name: 'Acme Corp' })
  assertEquals([r.status, r.body.item.name], [200, 'Acme Corp'])
  assertEquals((await h.directory.byTenant(ACME))?.name, 'Acme Corp')
})

Deno.test('every member may read the organisation, its projects, approvals and audit', async () => {
  const h = setup()
  for (const p of ['org', 'projects', 'approvals', 'audit', 'audit/facets', 'tokens']) {
    assertEquals((await call(h, { userId: h.ids.bob }, 'GET', p)).status, 200, p)
  }
})
