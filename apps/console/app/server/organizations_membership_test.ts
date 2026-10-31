/**
 * /api/organizations with membership from Keycloak groups. The switcher lists
 * what the caller's groups entitle (not a per-user list only the creator ever
 * had), creating an organisation makes its two groups first or not at all,
 * activating one is confirmed with Keycloak, and nobody leaves an organisation
 * without an admin.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { groupExistsIn, handleOrganizations, type OrganizationsDeps, type Registry, slugConflict } from './organizations.ts'
import { FakeKeycloak } from './workspace/testing/fake-keycloak.ts'
import { MemoryDb } from './workspace/testing/memory-store.ts'
import { OrgDirectory } from './tenancy/directory.ts'
import { createLiveGroups } from './tenancy/entitlement.ts'
import { NO_ACCESS, orgAccess } from './tenancy/org-access.ts'
import type { RequestContext } from './request-user.ts'
import type { XrManifest } from './control-plane.ts'

const ACME = 'acme-x1y2z'
const BETA = 'beta-q9w8e'

function setup() {
  const kc = new FakeKeycloak()
  const db = new MemoryDb()
  db.put('_directory', 'workspace.org-directory', 'acme', { slug: 'acme', tenantId: ACME, name: 'Acme', createdAt: '2026-01-01T00:00:00Z' })
  db.put('_directory', 'workspace.org-directory', 'beta', { slug: 'beta', tenantId: BETA, name: 'Beta', createdAt: '2026-01-02T00:00:00Z' })
  const ids = {
    alice: kc.addUser({ username: 'alice@acme.test' }),
    bob: kc.addUser({ username: 'bob@acme.test' }),
    pat: kc.addUser({ username: 'pat@platform.test' }),
    dave: kc.addUser({ username: 'dave@else.test' }),
  }
  for (const g of ['org-acme', 'org-acme-admin']) kc.join(ids.alice, g)
  kc.join(ids.bob, 'org-acme')
  kc.join(ids.bob, 'ws-team-acme.payments')
  kc.join(ids.pat, 'platform-admin')

  const directory = new OrgDirectory(db.directorySource(), { log: () => {} })
  const client = kc.client()
  const sessions: Array<{ tenantId: string; refresh: boolean }> = []
  const backfilled: XrManifest[] = []
  const migrated: string[] = []
  /** What a refreshed token's groups are; defaults to Keycloak's current answer. */
  const state = { refreshedGroups: null as string[] | null, tokenGroups: {} as Record<string, string[]> }
  const deps: Partial<OrganizationsDeps> = {
    unauthenticated: () => Promise.resolve('unauthenticated'),
    requirePermission: () => Promise.resolve(null),
    directory,
    kc: () => client,
    liveGroups: createLiveGroups(() => client),
    readRegistry: (userId, fallback) => {
      const raw = db.registry(userId) as unknown as Registry | undefined
      if (raw?.orgs?.length) return Promise.resolve({ orgs: raw.orgs, activeId: raw.activeId || raw.orgs[0].id })
      return Promise.resolve({
        orgs: [{ id: fallback || 'default', name: 'Default Organization', slug: fallback || 'default', createdAt: '' }],
        activeId: fallback || 'default',
        seeded: true,
      })
    },
    writeRegistry: (userId, _user, reg) => {
      db.setRegistry(userId, reg as unknown as Record<string, unknown>)
      return Promise.resolve(true)
    },
    issueSession: (_req, tenantId, opts) => {
      sessions.push({ tenantId, refresh: opts.refresh })
      return Promise.resolve({ cookie: `adhar_session=${tenantId || 'none'}; Path=/`, groups: state.refreshedGroups ?? [] })
    },
    renameWorkspaceDoc: () => Promise.resolve(),
    startProvisioning: (input) =>
      Promise.resolve({
        id: 'job-1',
        orgId: input.orgId,
        orgName: input.orgName,
        orgSlug: input.orgSlug,
        status: 'running' as const,
        steps: [],
        startedAt: '2026-01-01T00:00:00Z',
        requestedBy: input.user,
      }),
    backfillXrs: (ms) => void backfilled.push(...ms),
    slugChecks: { namespaceExists: () => Promise.resolve(false), groupExists: groupExistsIn(client) },
    isMigrated: () => Promise.resolve(true),
    migrateTenant: (t) => {
      migrated.push(t)
      return Promise.resolve({ status: 'migrated' })
    },
    originOk: () => true,
  }
  return { kc, db, ids, directory, deps, sessions, backfilled, migrated, state }
}

type H = ReturnType<typeof setup>

async function call(
  h: H,
  as: { userId: string; groups?: string[]; tenant?: string },
  method: string,
  subpath: string,
  body?: unknown,
) {
  const groups = as.groups ?? h.kc.groupsOf(as.userId)
  const tenant = as.tenant ?? ACME
  const org = tenant.startsWith('_') ? null : await h.directory.byTenant(tenant)
  const u = h.kc.users.get(as.userId)!
  const ctx: RequestContext = {
    user: { id: as.userId, email: u.email ?? '', name: u.username, roles: ['viewer'], groups, tenants: [] },
    activeTenant: tenant,
    org,
    access: org ? orgAccess(groups, org.slug) : NO_ACCESS,
    personal: !org,
    degraded: false,
  }
  const req = new Request(`http://console.test/api/organizations/${subpath}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const res = await handleOrganizations(req, subpath, { ...h.deps, context: () => Promise.resolve(ctx) })
  return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') }
}

/* ─────────── the list ─────────── */

Deno.test('the switcher lists the organisations the caller\'s groups entitle, with their role', async () => {
  const h = setup()
  const bob = await call(h, { userId: h.ids.bob }, 'GET', '')
  assertEquals(bob.body.organizations.map((o: { slug: string; role: string }) => `${o.slug}:${o.role}`), ['acme:member'])
  assertEquals(bob.body.activeId, ACME)
  // A member added in Keycloak sees the organisation at once — no registry entry needed.
  h.kc.join(h.ids.dave, 'org-beta')
  const dave = await call(h, { userId: h.ids.dave, groups: [], tenant: '_u_dave' }, 'GET', '')
  assertEquals(dave.body.organizations.map((o: { id: string }) => o.id), [BETA])
  assertEquals(dave.body.activeId, '')
})

Deno.test('platform admins see every organisation, the platform\'s first', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.pat, tenant: 'default' }, 'GET', '')
  assertEquals(r.body.organizations.map((o: { slug: string; via: string }) => `${o.slug}:${o.via}`), [
    'adhar:platform-admin',
    'acme:platform-admin',
    'beta:platform-admin',
  ])
})

Deno.test('Keycloak unreachable: the token\'s groups decide, and the list says it is degraded', async () => {
  const h = setup()
  h.kc.down = true
  const r = await call(h, { userId: h.ids.bob, groups: ['org-acme', 'org-beta'] }, 'GET', '')
  assertEquals(r.status, 200)
  assertEquals(r.body.degraded, true)
  assertEquals(r.body.organizations.map((o: { slug: string }) => o.slug), ['acme', 'beta'])
})

Deno.test('organisations the startup sweep has not reached are migrated before the list is built', async () => {
  const h = setup()
  h.db.setRegistry(h.ids.dave, { orgs: [{ id: 'gamma-z1z2z', slug: 'gamma', name: 'Gamma', createdAt: '2026-03-01T00:00:00Z', createdBy: h.ids.dave }], activeId: 'gamma-z1z2z' })
  h.deps.isMigrated = (t) => Promise.resolve(t !== 'gamma-z1z2z')
  h.deps.migrateTenant = (t) => {
    h.migrated.push(t)
    h.kc.join(h.ids.dave, 'org-gamma')
    return Promise.resolve({})
  }
  const r = await call(h, { userId: h.ids.dave, groups: [], tenant: '_u_dave' }, 'GET', '')
  assertEquals(h.migrated, ['gamma-z1z2z'])
  assertEquals(r.body.organizations.map((o: { slug: string }) => o.slug), ['gamma'])
})

Deno.test('the seed placeholder and reserved or platform slugs are never back-filled as Organisation XRs', async () => {
  const h = setup()
  await call(h, { userId: h.ids.bob }, 'GET', '')
  assertEquals(h.backfilled, [], 'a seeded registry publishes nothing')
  h.db.setRegistry(h.ids.pat, {
    orgs: [
      { id: 'default', slug: 'default', name: 'Default Organization', createdAt: '' },
      { id: 'adhar', slug: 'adhar', name: 'Adhar', createdAt: '' },
      { id: ACME, slug: 'acme', name: 'Acme', createdAt: '' },
    ],
    activeId: ACME,
  })
  await call(h, { userId: h.ids.pat, tenant: 'default' }, 'GET', '')
  assertEquals(h.backfilled.map((m) => m.metadata.name), ['acme'])
})

/* ─────────── create ─────────── */

Deno.test('creating an organisation makes both groups with the creator in both, before anything else', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.dave, tenant: '_u_dave', groups: [] }, 'POST', '', { name: 'Gamma Labs' })
  assertEquals(r.status, 201)
  assertEquals([r.body.organization.slug, r.body.organization.role, r.body.organization.via], ['gamma-labs', 'admin', 'membership'])
  assertEquals(h.kc.groupsOf(h.ids.dave), ['org-gamma-labs', 'org-gamma-labs-admin'])
  const id = r.body.activeId
  assertEquals((await h.directory.byTenant(id))?.slug, 'gamma-labs')
  assertEquals((h.db.registry(h.ids.dave) as { activeId: string }).activeId, id)
  // The session is re-issued on a REFRESHED token, so the new groups are in it.
  assertEquals(h.sessions, [{ tenantId: id, refresh: true }])
  assert(r.cookie?.includes(id))
})

Deno.test('Keycloak down while creating: 503 and nothing was created anywhere', async () => {
  const h = setup()
  h.kc.failOn = (c) => (c.method === 'PUT' ? 503 : null)
  const r = await call(h, { userId: h.ids.dave, tenant: '_u_dave', groups: [] }, 'POST', '', { name: 'Gamma' })
  assertEquals([r.status, r.body.error], [503, 'keycloak_unavailable'])
  assertFalse(h.kc.hasGroup('org-gamma'))
  assertFalse(h.kc.hasGroup('org-gamma-admin'))
  assertEquals(h.db.registry(h.ids.dave), undefined)
  assertEquals(await h.directory.bySlug('gamma'), null)
  assertEquals(h.sessions, [])
})

Deno.test('a name whose slug would be ambiguous, or taken, is refused', async () => {
  const h = setup()
  const as = { userId: h.ids.dave, tenant: '_u_dave', groups: [] }
  assertEquals((await call(h, as, 'POST', '', { name: 'Ops Admin' })).body.error, 'invalid_name')
  assertEquals((await call(h, as, 'POST', '', { name: '9 Lives' })).body.error, 'invalid_name')
  const taken = await call(h, as, 'POST', '', { name: 'Acme' })
  assertEquals([taken.status, taken.body.error], [409, 'name_taken'])
  // Only the admin group surviving is still a taken name.
  h.kc.addGroup('org-orphan-admin')
  assertEquals((await call(h, as, 'POST', '', { name: 'Orphan' })).body.error, 'name_taken')
})

Deno.test('the platform organisation and its environment namespaces are reserved, existing or not', async () => {
  const h = setup()
  // The namespace check cannot run (bootstrap, or no SA token): still refused.
  h.deps.slugChecks = { namespaceExists: () => Promise.resolve(null), groupExists: () => Promise.resolve(false) }
  for (const name of ['Adhar', 'dev', 'Test', 'prod']) {
    const r = await call(h, { userId: h.ids.dave, tenant: '_u_dave', groups: [] }, 'POST', '', { name })
    assertEquals([r.status, r.body.error], [409, 'name_reserved'], name)
  }
  assertEquals(h.kc.groupsOf(h.ids.dave), [], 'nothing was granted for a refused name')
})

Deno.test('two creates of one name: the second gets 409 and never joins, or deletes, the first one\'s groups', async () => {
  const h = setup()
  // The race: both requests passed the slug check before either created anything.
  h.deps.slugChecks = { namespaceExists: () => Promise.resolve(false), groupExists: () => Promise.resolve(false) }
  const first = await call(h, { userId: h.ids.dave, tenant: '_u_dave', groups: [] }, 'POST', '', { name: 'Gamma' })
  assertEquals(first.status, 201)
  const second = await call(h, { userId: h.ids.bob }, 'POST', '', { name: 'Gamma' })
  assertEquals([second.status, second.body.error], [409, 'name_taken'])
  assertFalse(h.kc.groupsOf(h.ids.bob).some((g) => g.startsWith('org-gamma')), 'the loser is not an admin of the winner\'s organisation')
  assert(h.kc.hasGroup('org-gamma') && h.kc.hasGroup('org-gamma-admin'), 'and the winner keeps its groups')
  assertEquals(h.kc.membersOf('org-gamma-admin'), [h.ids.dave])
})

Deno.test('a failure after the identity step takes the creator back out and deletes what it created', async () => {
  const h = setup()
  h.deps.writeRegistry = () => Promise.reject(new Error('database went away'))
  const err = console.error
  console.error = () => {}
  try {
    const r = await call(h, { userId: h.ids.dave, tenant: '_u_dave', groups: [] }, 'POST', '', { name: 'Gamma' })
    assertEquals(r.status, 500)
  } finally {
    console.error = err
  }
  assertEquals(h.kc.groupsOf(h.ids.dave), [])
  assertFalse(h.kc.hasGroup('org-gamma'))
  assertFalse(h.kc.hasGroup('org-gamma-admin'))
  assertEquals(await h.directory.bySlug('gamma'), null)
})

Deno.test('a slug check Keycloak cannot answer fails closed', async () => {
  const kc = new FakeKeycloak()
  kc.down = true
  const checks = { namespaceExists: () => Promise.resolve(false), groupExists: groupExistsIn(kc.client()) }
  assertEquals(await slugConflict('fresh', checks), 'taken')
  // No Keycloak to ask at all (a laptop) does not block.
  assertEquals(await slugConflict('fresh', { namespaceExists: () => Promise.resolve(null), groupExists: groupExistsIn(null) }), null)
})

/* ─────────── activate ─────────── */

Deno.test('activating an organisation the caller is not in is 404 not_a_member', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.bob }, 'POST', `${BETA}/activate`)
  assertEquals([r.status, r.body.error], [404, 'not_a_member'])
  assertEquals((await call(h, { userId: h.ids.bob }, 'POST', 'nope-11111/activate')).status, 404)
})

Deno.test('a membership the token does not show yet is confirmed live and the token refreshed', async () => {
  const h = setup()
  h.kc.join(h.ids.bob, 'org-beta')
  h.state.refreshedGroups = ['org-acme', 'org-beta']
  const r = await call(h, { userId: h.ids.bob, groups: ['org-acme'] }, 'POST', `${BETA}/activate`)
  assertEquals([r.status, r.body.activeId], [200, BETA])
  assertEquals(h.sessions, [{ tenantId: BETA, refresh: true }])
  assertEquals((h.db.registry(h.ids.bob) as { activeId: string }).activeId, BETA)
})

Deno.test('if even a fresh token lacks the membership, the caller must sign in again', async () => {
  const h = setup()
  h.kc.join(h.ids.bob, 'org-beta')
  h.state.refreshedGroups = ['org-acme']
  const r = await call(h, { userId: h.ids.bob, groups: ['org-acme'] }, 'POST', `${BETA}/activate`)
  assertEquals([r.status, r.body.error], [409, 'reauth_required'])
})

/* ─────────── rename ─────────── */

Deno.test('only an admin of THAT organisation may rename it', async () => {
  const h = setup()
  const member = await call(h, { userId: h.ids.bob }, 'PATCH', ACME, { name: 'Bob Co' })
  assertEquals([member.status, member.body.error], [403, 'requires_org_admin'])
  // Alice is acme's admin, not beta's.
  assertEquals((await call(h, { userId: h.ids.alice }, 'PATCH', BETA, { name: 'Mine' })).status, 403)
  const ok = await call(h, { userId: h.ids.alice }, 'PATCH', ACME, { name: 'Acme Corp' })
  assertEquals([ok.status, ok.body.organization.name], [200, 'Acme Corp'])
  assertEquals((await h.directory.byTenant(ACME))?.name, 'Acme Corp')
})

/* ─────────── leave ─────────── */

Deno.test('the last admin cannot leave; a member leaves and the session moves on', async () => {
  const h = setup()
  const last = await call(h, { userId: h.ids.alice }, 'DELETE', ACME)
  assertEquals([last.status, last.body.error], [409, 'cannot_leave_last_admin'])
  assert(h.kc.groupsOf(h.ids.alice).includes('org-acme-admin'))

  const bob = await call(h, { userId: h.ids.bob }, 'DELETE', ACME)
  assertEquals([bob.status, bob.body.switched, bob.body.activeId], [200, true, ''])
  assertEquals(h.kc.groupsOf(h.ids.bob), [], 'team, then membership')
  assertEquals(h.sessions.at(-1), { tenantId: '', refresh: true })
})

Deno.test('a platform admin has nothing to leave', async () => {
  const h = setup()
  const r = await call(h, { userId: h.ids.pat }, 'DELETE', ACME)
  assertEquals([r.status, r.body.error], [409, 'platform_admin_access'])
})

Deno.test('an admin may leave once another admin exists', async () => {
  const h = setup()
  h.kc.join(h.ids.bob, 'org-acme-admin')
  const r = await call(h, { userId: h.ids.alice }, 'DELETE', ACME)
  assertEquals(r.status, 200)
  assertEquals(h.kc.groupsOf(h.ids.alice), [])
  assertEquals(h.kc.membersOf('org-acme-admin'), [h.ids.bob])
})
