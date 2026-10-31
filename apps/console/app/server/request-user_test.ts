/**
 * Which organisation a request works in is re-decided on every request from
 * the caller's groups (tenancy/entitlement.ts, used by request-user.ts). These
 * pin what that decision protects: a removed member loses the organisation,
 * someone in no organisation gets a private tenant (never the shared default),
 * and a membership only Keycloak knows about yet still opens it.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { type EntitlementDeps, isPersonalTenantId, personalTenantId, resolveActiveTenant } from './tenancy/entitlement.ts'
import { OrgDirectory } from './tenancy/directory.ts'
import { MemoryDb } from './workspace/testing/memory-store.ts'
import { requestAccess } from './request-user.ts'
import { NO_ACCESS } from './tenancy/org-access.ts'

const ACME = 'acme-x1y2z'
const BETA = 'beta-q9w8e'

/**
 * `opened`: the organisations the user created or opened before (their
 * registry). By default both, so the choice below is about groups; the tests
 * about consent pass a narrower list.
 */
function deps(live: Record<string, string[] | null> = {}, activeId: string | null = null, opened: string[] = [ACME, BETA]) {
  const db = new MemoryDb()
  db.put('_directory', 'workspace.org-directory', 'acme', { slug: 'acme', tenantId: ACME, name: 'Acme', createdAt: '2026-01-01T00:00:00Z' })
  db.put('_directory', 'workspace.org-directory', 'beta', { slug: 'beta', tenantId: BETA, name: 'Beta', createdAt: '2026-01-02T00:00:00Z' })
  const asked: string[] = []
  const d: EntitlementDeps = {
    directory: new OrgDirectory(db.directorySource(), { log: () => {} }),
    liveGroups: {
      get: (userId) => {
        asked.push(userId)
        return Promise.resolve(userId in live ? live[userId] : null)
      },
      invalidate: () => {},
    },
    registryActiveId: () => Promise.resolve(activeId),
    registryOrgIds: () => Promise.resolve(opened),
    devMode: false,
  }
  return { d, asked, db }
}

Deno.test('the remembered organisation is kept while the token entitles it — without asking Keycloak', async () => {
  const { d, asked } = deps()
  const r = await resolveActiveTenant({ userId: 'u', groups: ['org-acme'], sessionTenant: ACME }, d)
  assertEquals([r.tenant, r.org?.slug, r.access.role, r.needsRefresh], [ACME, 'acme', 'member', false])
  assertEquals(asked, [])
})

Deno.test('a removed member falls back to an organisation they still belong to', async () => {
  const { d } = deps({ u: ['org-beta'] })
  const r = await resolveActiveTenant({ userId: 'u', groups: ['org-beta'], sessionTenant: ACME }, d)
  assertEquals([r.tenant, r.org?.slug, r.personal], [BETA, 'beta', false])
})

Deno.test('someone removed from their only organisation lands in a private tenant, never the default one', async () => {
  const { d } = deps({ u: [] })
  // Their next token no longer lists org-acme.
  const r = await resolveActiveTenant({ userId: 'u', groups: [], sessionTenant: ACME }, d)
  assertEquals(r.tenant, await personalTenantId('u'))
  assert(r.personal)
  assertEquals(r.org, null)
  assertFalse(r.tenant === 'default')
  // Until then the still-valid token is honoured — the documented window of
  // one access-token lifetime (writes re-check Keycloak live regardless).
  const stale = await resolveActiveTenant({ userId: 'u', groups: ['org-acme'], sessionTenant: ACME }, d)
  assertEquals(stale.tenant, ACME)
})

Deno.test('an organisation-less sign-up gets its own personal tenant', async () => {
  const { d } = deps({ newbie: [] })
  const r = await resolveActiveTenant({ userId: 'newbie', groups: ['base-user'], sessionTenant: '' }, d)
  assertEquals([r.personal, r.org, r.access.role], [true, null, null])
  // Two people never share one.
  const other = await resolveActiveTenant({ userId: 'other', groups: [], sessionTenant: '' }, deps({ other: [] }).d)
  assert(other.tenant !== r.tenant)
})

Deno.test('a personal tenant id can never be an organisation\'s tenant id', async () => {
  const id = await personalTenantId('0b6d8f6e-1111-4c2c-9d8e-123456789abc')
  assert(isPersonalTenantId(id))
  assertEquals(id.length, '_u_'.length + 24)
  // Organisation tenant ids match this (organizations.ts ID_RE): never with `_`.
  assertFalse(/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
})

Deno.test('a membership only Keycloak knows about yet still opens the organisation, and asks for a refresh', async () => {
  const { d } = deps({ u: ['org-beta'] })
  const r = await resolveActiveTenant({ userId: 'u', groups: [], sessionTenant: BETA }, d)
  assertEquals([r.tenant, r.needsRefresh], [BETA, true])
  // Without a remembered tenant it is chosen the same way.
  const fresh = await resolveActiveTenant({ userId: 'u', groups: [], sessionTenant: '' }, d)
  assertEquals([fresh.tenant, fresh.needsRefresh], [BETA, true])
})

Deno.test('the choice prefers the last activated organisation, then the platform\'s, then the first by name', async () => {
  const groups = ['org-acme', 'org-beta', 'platform-developer']
  assertEquals((await resolveActiveTenant({ userId: 'u', groups, sessionTenant: '' }, deps({ u: groups }, BETA).d)).tenant, BETA)
  assertEquals((await resolveActiveTenant({ userId: 'u', groups, sessionTenant: '' }, deps({ u: groups }).d)).tenant, 'default')
  const noPlatform = ['org-beta', 'org-acme']
  assertEquals((await resolveActiveTenant({ userId: 'u', groups: noPlatform, sessionTenant: '' }, deps({ u: noPlatform }).d)).tenant, ACME)
})

Deno.test('a platform admin may work in any organisation', async () => {
  const { d } = deps()
  const r = await resolveActiveTenant({ userId: 'p', groups: ['platform-admin'], sessionTenant: BETA }, d)
  assertEquals([r.tenant, r.access.role, r.access.via], [BETA, 'admin', 'platform-admin'])
})

Deno.test('Keycloak unreachable: the token\'s groups decide', async () => {
  const { d } = deps({ u: null })
  const r = await resolveActiveTenant({ userId: 'u', groups: ['org-beta'], sessionTenant: 'gone-11111' }, d)
  assertEquals([r.tenant, r.needsRefresh], [BETA, false])
})

Deno.test('an unreadable directory fails closed to the personal tenant, never the remembered one', async () => {
  const d: EntitlementDeps = {
    directory: new OrgDirectory({
      listStored: () => Promise.reject(new Error('db down')),
      putStored: () => Promise.resolve(),
      listRegistries: () => Promise.resolve([]),
    }),
    liveGroups: { get: () => Promise.resolve(null), invalidate: () => {} },
    registryActiveId: () => Promise.resolve(null),
    registryOrgIds: () => Promise.resolve([]),
    devMode: false,
  }
  // The session still names acme, perhaps for someone removed from it since:
  // nothing can be checked, so nothing of acme's is served (/api/store and the
  // other tenant-scoped routes only ever see `activeTenant`).
  const r = await resolveActiveTenant({ userId: 'u', groups: ['org-acme'], sessionTenant: ACME }, d)
  assertEquals([r.degraded, r.org, r.access.role, r.personal], [true, null, null, true])
  assertEquals(r.tenant, await personalTenantId('u'))
})

Deno.test('being added to an organisation does not move anyone into it; opening it does', async () => {
  // An admin of beta added this person; they have never opened beta.
  const { d } = deps({ u: ['org-beta'] }, null, [])
  const r = await resolveActiveTenant({ userId: 'u', groups: ['org-beta'], sessionTenant: '' }, d)
  assertEquals([r.personal, r.org], [true, null])
  // Once they open it (the switcher writes it to their registry) it is theirs.
  const after = await resolveActiveTenant({ userId: 'u', groups: ['org-beta'], sessionTenant: '' }, deps({ u: ['org-beta'] }, null, [BETA]).d)
  assertEquals(after.tenant, BETA)
  // The platform's own organisation needs no opening.
  const platform = await resolveActiveTenant({ userId: 'u', groups: ['platform-developer'], sessionTenant: '' }, deps({ u: ['platform-developer'] }, null, []).d)
  assertEquals(platform.tenant, 'default')
})

Deno.test('a console system tenant is never an organisation to work in', async () => {
  const { d, db } = deps({ u: ['org-sys'] })
  db.put('_directory', 'workspace.org-directory', 'sys', { slug: 'sys', tenantId: 'auth', name: 'Sys', createdAt: '2026-01-01T00:00:00Z' })
  const r = await resolveActiveTenant({ userId: 'u', groups: ['org-sys'], sessionTenant: 'auth' }, d)
  assert(r.tenant !== 'auth')
  assertEquals(r.org, null)
})

Deno.test('a membership Keycloak confirmed but the token lacks opens member views, never admin ones', () => {
  const acme = { slug: 'acme', tenantId: ACME, name: 'Acme', createdAt: '' }
  // Stale token, live says member: audit and billing views open.
  assertEquals(requestAccess([], { org: acme, access: { role: 'member', via: 'membership' } }), { role: 'member', via: 'membership' })
  // Live says admin: still only member until the token says admin.
  assertEquals(requestAccess([], { org: acme, access: { role: 'admin', via: 'membership' } }).role, 'member')
  // The token decides whenever it says anything.
  assertEquals(requestAccess(['org-acme-admin'], { org: acme, access: { role: 'admin', via: 'membership' } }).role, 'admin')
  assertEquals(requestAccess([], { org: acme, access: NO_ACCESS }), NO_ACCESS)
  assertEquals(requestAccess(['org-acme-admin'], { org: null, access: NO_ACCESS }), NO_ACCESS)
})

Deno.test('on a laptop without an identity provider the session tenant stands for itself', async () => {
  const { d } = deps()
  const r = await resolveActiveTenant({ userId: 'local-dev', groups: ['platform-admin'], sessionTenant: 'adhar' }, { ...d, devMode: true })
  assertEquals([r.tenant, r.org?.slug, r.access.role], ['adhar', 'adhar', 'admin'])
})
