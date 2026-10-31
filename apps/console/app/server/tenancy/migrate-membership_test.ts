/**
 * The one-time move of the console's member documents into Keycloak groups.
 * What must hold: it is additive and idempotent (a second run makes no call),
 * a tenant is marked done only after everything for it succeeded, a retry
 * never re-grants what an admin changed since, the platform's own
 * organisation never hands out admin or team access by migration, and the old
 * unqualified team groups are reported, never turned into anyone's membership.
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import {
  isMigrated,
  LEGACY_MARKER_ID,
  migrateLegacyTeamGroups,
  migrateTenant,
  MIGRATION_ID,
  type MigrationDeps,
  PLAN_ID,
  runMembershipMigration,
} from './migrate-membership.ts'
import { type DirectoryEntry, OrgDirectory } from './directory.ts'
import { FakeKeycloak } from '../workspace/testing/fake-keycloak.ts'
import { MemoryDb } from '../workspace/testing/memory-store.ts'
import { KIND } from '../workspace/store.ts'
import type { TeamXrSummary } from '../control-plane.ts'

const ACME = 'acme-x1y2z'

function setup() {
  const kc = new FakeKeycloak()
  const db = new MemoryDb()
  db.put('_directory', 'workspace.org-directory', 'acme', { slug: 'acme', tenantId: ACME, name: 'Acme', createdAt: '2026-01-01T00:00:00Z' })
  const ids = {
    owner: kc.addUser({ username: 'owner@acme.test' }),
    admin: kc.addUser({ username: 'admin@acme.test' }),
    member: kc.addUser({ username: 'member@acme.test' }),
    billing: kc.addUser({ username: 'billing@acme.test' }),
    root: kc.addUser({ username: 'root@platform.test' }),
  }
  kc.join(ids.root, 'platform-admin')
  db.put(ACME, KIND.team, 't1', { slug: 'payments', name: 'Payments', createdAt: '2026-01-01T00:00:00Z' })
  db.put(ACME, KIND.team, 't2', { slug: 'platform', name: 'Platform Team', createdAt: '2026-01-01T00:00:00Z' })
  const m = (id: string, role: string, teams: string[] = []) => db.put(ACME, KIND.member, id, { email: `${id}@x`, name: id, role, teams, joinedAt: '' })
  m(ids.owner, 'owner', ['platform'])
  m(ids.admin, 'admin')
  m(ids.member, 'member', ['payments', 'gone'])
  m(ids.billing, 'billing')
  m(crypto.randomUUID(), 'member') // an account deleted from Keycloak since

  const logs: string[] = []
  const xrs: TeamXrSummary[] = [{ organisation: 'adhar', name: 'platform', group: 'ws-team-platform' }]
  const client = kc.client()
  const deps: MigrationDeps = {
    kc: client,
    directory: new OrgDirectory(db.directorySource(), { log: () => {} }),
    openStore: (t) => Promise.resolve(db.store(t)),
    listTenants: () => Promise.resolve([ACME]),
    teamXrs: () => Promise.resolve(xrs),
    log: (l) => void logs.push(l),
  }
  return { kc, db, ids, deps, logs, xrs }
}

Deno.test('members become group members: owners and admins are admins, billing and viewer plain members', async () => {
  const { kc, db, ids, deps, logs } = setup()
  const out = await migrateTenant(ACME, deps)
  assertEquals(out.status, 'migrated')
  assertEquals(kc.groupsOf(ids.owner), ['org-acme', 'org-acme-admin', 'ws-team-acme.platform'])
  assertEquals(kc.groupsOf(ids.admin), ['org-acme', 'org-acme-admin'])
  assertEquals(kc.groupsOf(ids.member), ['org-acme', 'ws-team-acme.payments'])
  assertEquals(kc.groupsOf(ids.billing), ['org-acme'])
  if (out.status === 'migrated') {
    assertEquals(out.counts.members, 5)
    assertEquals(out.counts.missingUsers, 1)
    assertEquals(out.counts.unknownTeams, 1)
    assertEquals(out.counts.addedAdmin, 2)
    assertEquals(out.counts.teamMemberships, 2)
  }
  const marker = (await db.store(ACME).get<Record<string, unknown>>(KIND.migration, MIGRATION_ID))!
  assertEquals(marker.data.orgSlug, 'acme')
  assert(db.all<{ action: string }>(ACME, KIND.audit).some((a) => a.data.action === 'member.migrated_to_keycloak'))
  assert(logs.some((l) => l.startsWith('[membership-migration] tenant=acme-x1y2z org=acme members=5 addedMember=4 addedAdmin=2')), logs.join('\n'))
  // Nothing is removed: the old documents stay for a rollback.
  assertEquals(db.all(ACME, KIND.member).length, 5)
})

Deno.test('a second run makes no Keycloak call at all', async () => {
  const { kc, deps } = setup()
  await migrateTenant(ACME, deps)
  const before = kc.calls.length
  assertEquals((await migrateTenant(ACME, deps)).status, 'already')
  assertEquals(kc.calls.length, before)
  assert(await isMigrated(ACME, deps))
})

Deno.test('the migration never removes anyone from any group', async () => {
  const { kc, ids, deps } = setup()
  kc.join(ids.member, 'ws-role-owner')
  kc.join(ids.member, 'ws-team-payments')
  await runMembershipMigration(deps)
  assertFalse(kc.writes().some((c) => c.method === 'DELETE'))
  assert(kc.groupsOf(ids.member).includes('ws-role-owner'))
  assert(kc.groupsOf(ids.member).includes('ws-team-payments'))
})

Deno.test('a tenant is marked only when every call for it succeeded, and the retry finishes it', async () => {
  const { kc, db, ids, deps } = setup()
  let failing = true
  kc.failOn = (c) => (failing && c.method === 'PUT' && c.path.startsWith(`/users/${ids.member}/`) ? 503 : null)
  const first = await migrateTenant(ACME, deps)
  assertEquals(first.status, 'failed')
  assertEquals(await db.store(ACME).get(KIND.migration, MIGRATION_ID), null)
  failing = false
  assertEquals((await migrateTenant(ACME, deps)).status, 'migrated')
  assertEquals(kc.groupsOf(ids.member), ['org-acme', 'ws-team-acme.payments'])
})

Deno.test('a tenant with no organisation in the directory is skipped without a marker', async () => {
  const { db, deps, logs } = setup()
  db.put('lost-aaaaa', KIND.member, 'x', { email: 'x', name: 'x', role: 'owner', teams: [], joinedAt: '' })
  assertEquals((await migrateTenant('lost-aaaaa', deps)).status, 'unresolved')
  assertEquals(await db.store('lost-aaaaa').get(KIND.migration, MIGRATION_ID), null)
  assert(logs.some((l) => l.includes('tenant=lost-aaaaa has no organisation')))
})

Deno.test('in the platform organisation old admins become members only, and platform admins are told', async () => {
  const { kc, db, ids, deps } = setup()
  db.put('default', KIND.member, ids.admin, { email: 'admin@acme.test', name: 'a', role: 'owner', teams: [], joinedAt: '' })
  db.put('default', KIND.member, ids.root, { email: 'root@platform.test', name: 'r', role: 'admin', teams: [], joinedAt: '' })
  const out = await migrateTenant('default', deps)
  assertEquals(out.status, 'migrated')
  // org-adhar-admin is Kubernetes admin of adhar/dev/test/prod: withheld.
  assertEquals(kc.groupsOf(ids.admin).filter((g) => g.startsWith('org-adhar')), ['org-adhar'])
  // Already a platform admin: granting it changes nothing they could not do.
  assert(kc.groupsOf(ids.root).includes('org-adhar-admin'))
  const marker = (await db.store('default').get<{ withheldAdmins: Array<{ userId: string }> }>(KIND.migration, MIGRATION_ID))!
  assertEquals(marker.data.withheldAdmins.map((w) => w.userId), [ids.admin])
  const notes = db.all<{ title: string; audience?: string[]; href?: string }>('default', 'console.notification')
  const note = notes.find((n) => n.data.title.includes('not migrated'))!
  assertEquals(note.data.audience, [ids.root])
  assertEquals(note.data.href, '/settings?section=members')
})

Deno.test('in the platform organisation team grants are held back too, and reported', async () => {
  const { kc, db, ids, deps } = setup()
  // The old first-team bootstrap put people in the default workspace's
  // "platform" team; the platform's Project binds ws-team-adhar.platform as
  // namespace admin of adhar, dev and test.
  db.put('default', KIND.team, 'tp', { slug: 'platform', name: 'Platform Team', createdAt: '' })
  db.put('default', KIND.member, ids.member, { email: 'member@acme.test', name: 'm', role: 'member', teams: ['platform'], joinedAt: '' })
  db.put('default', KIND.member, ids.root, { email: 'root@platform.test', name: 'r', role: 'member', teams: ['platform'], joinedAt: '' })
  assertEquals((await migrateTenant('default', deps)).status, 'migrated')
  assertFalse(
    kc.writes().some((c) => c.method === 'PUT' && c.path.startsWith(`/users/${ids.member}/`) && kc.groups.get(c.path.split('/').pop()!)?.name === 'ws-team-adhar.platform'),
    'no write puts an unvetted member in the platform team',
  )
  assertFalse(kc.groupsOf(ids.member).includes('ws-team-adhar.platform'))
  assert(kc.groupsOf(ids.member).includes('org-adhar'), 'they keep the default workspace as members')
  // A platform admin adds nothing they could not do already.
  assert(kc.groupsOf(ids.root).includes('ws-team-adhar.platform'))
  const marker = (await db.store('default').get<{ withheldTeams: Array<{ userId: string; team: string }> }>(KIND.migration, MIGRATION_ID))!
  assertEquals(marker.data.withheldTeams.map((w) => [w.userId, w.team]), [[ids.member, 'platform']])
  const note = db.all<{ description: string }>('default', 'console.notification').find((n) => n.data.description.includes('team membership'))
  assert(note, 'platform admins are told')
})

Deno.test('a retry never re-grants what an admin changed after the plan was made', async () => {
  const { kc, db, ids, deps } = setup()
  // The first run stops part-way: the owner's member group went in, the admin
  // group did not.
  let failing = true
  kc.failOn = (c) => (failing && c.method === 'PUT' && c.path.startsWith(`/users/${ids.owner}/`) && kc.groups.get(c.path.split('/').pop()!)?.name === 'org-acme-admin' ? 503 : null)
  assertEquals((await migrateTenant(ACME, deps)).status, 'failed')
  assert(kc.groupsOf(ids.owner).includes('org-acme'))
  const plan = (await db.store(ACME).get<{ startedAt: string; grants: Array<{ userId: string; group: string; applied?: boolean }> }>(KIND.migration, PLAN_ID))!
  assert(plan.data.grants.some((g) => g.userId === ids.owner && g.group === 'org-acme' && g.applied), 'progress is saved')
  // Meanwhile — after the plan, before the retry — an admin removes the owner
  // on the new Members page.
  kc.leave(ids.owner, 'org-acme')
  db.put(ACME, KIND.audit, 'a1', { actor: { type: 'user', id: ids.admin, label: 'admin' }, action: 'member.remove', target: { type: 'member', id: ids.owner, label: 'owner' }, outcome: 'success', at: plan.data.startedAt })
  // The retry starts later still: a plan made afresh now would postdate the removal.
  await new Promise((r) => setTimeout(r, 5))
  failing = false
  const out = await migrateTenant(ACME, deps)
  assertEquals(out.status, 'migrated')
  assertEquals(kc.groupsOf(ids.owner).filter((g) => g.startsWith('org-acme')), [], 'neither re-added nor made admin')
  if (out.status === 'migrated') assert(out.counts.skippedChanged >= 1)
  // Everyone the admin did not touch is finished as planned.
  assertEquals(kc.groupsOf(ids.member), ['org-acme', 'ws-team-acme.payments'])
})

Deno.test('an organisation named <x>-admin beside <x> is never migrated into', async () => {
  const { kc, db, deps } = setup()
  const victim = kc.addUser({ username: 'v@x.test' })
  db.put('acme-admin-11111', KIND.member, victim, { email: 'v@x.test', name: 'v', role: 'member', teams: [], joinedAt: '' })
  const acme: DirectoryEntry = { slug: 'acme', tenantId: ACME, name: 'Acme', createdAt: '' }
  const clash: DirectoryEntry = { slug: 'acme-admin', tenantId: 'acme-admin-11111', name: 'Acme Admin', createdAt: '' }
  // A stale directory that still resolves the pair (the real one drops it).
  deps.directory = {
    byTenant: (t: string) => Promise.resolve(t === clash.tenantId ? clash : t === ACME ? acme : null),
    bySlug: (s: string) => Promise.resolve(s === 'acme' ? acme : s === 'acme-admin' ? clash : null),
    put: () => Promise.resolve(),
  } as unknown as OrgDirectory
  const out = await migrateTenant('acme-admin-11111', deps)
  assertEquals(out.status, 'unresolved')
  assertEquals(kc.groupsOf(victim), [], 'org-acme-admin is acme\'s admin group')
  assertEquals(kc.writes().length, 0)
})

Deno.test('old ws-team-<team> groups are reported, never turned into anyone\'s membership', async () => {
  const { kc, db, ids, deps, xrs } = setup()
  db.put('_directory', 'workspace.org-directory', 'beta', { slug: 'beta', tenantId: 'beta-q9w8e', name: 'Beta', createdAt: '2026-01-02T00:00:00Z' })
  db.put('beta-q9w8e', KIND.team, 'b1', { slug: 'platform', name: 'Platform Team', createdAt: '' })
  db.put('beta-q9w8e', KIND.team, 'b2', { slug: 'shared', name: 'Shared', createdAt: '' })
  db.put(ACME, KIND.team, 't3', { slug: 'shared', name: 'Shared', createdAt: '' })
  deps.listTenants = () => Promise.resolve([ACME, 'beta-q9w8e'])
  xrs.push({ organisation: 'acme', name: 'payments' })
  const operator = kc.addUser({ username: 'operator@platform.test' })
  const drifter = kc.addUser({ username: 'drifter@x.test' })
  const loner = kc.addUser({ username: 'loner@x.test' })
  // The owner's console record places them in acme's "platform" team — the
  // tenant pass grants that; the old group adds nothing.
  kc.join(ids.owner, 'ws-team-platform')
  kc.join(operator, 'ws-team-platform') // no record: the platform's team? acme's? beta's? Nobody can say.
  kc.join(drifter, 'ws-team-shared') // two organisations have "shared"
  kc.join(loner, 'ws-team-payments') // only acme has "payments" — and still no record of acme adding them
  const writes = kc.writes().length

  const out = await migrateLegacyTeamGroups(deps)
  assertEquals(out.status, 'migrated')
  assertEquals(kc.writes().length, writes, 'the legacy pass writes nothing to Keycloak')
  for (const u of [operator, drifter, loner]) {
    assertFalse(kc.groupsOf(u).some((g) => g.startsWith('org-') || g.includes('.')), `${u} joined nothing`)
  }
  assertEquals([out.counts!.legacyCovered, out.counts!.ambiguousLegacy], [1, 3])
  const marker = (await db.store('_directory').get<{ ambiguous: Array<{ userId: string; team: string }> }>(KIND.migration, LEGACY_MARKER_ID))!
  assertEquals(marker.data.ambiguous.map((a) => `${a.team}:${a.userId}`).sort(), [`payments:${loner}`, `platform:${operator}`, `shared:${drifter}`].sort())
  // Platform admins are told who needs a decision.
  const note = db.all<{ title: string; audience?: string[] }>('default', 'console.notification').find((n) => n.data.title.includes('old team groups'))
  assertEquals(note?.data.audience, [ids.root])
  // Once.
  const before = kc.calls.length
  assertEquals((await migrateLegacyTeamGroups(deps)).status, 'already')
  assertEquals(kc.calls.length, before)
})

Deno.test('the sweep reports done only when nothing failed', async () => {
  const { kc, deps, logs } = setup()
  kc.down = true
  assertEquals((await runMembershipMigration(deps)).complete, false)
  assertFalse(logs.some((l) => l.includes('] done ')))
  kc.down = false
  const r = await runMembershipMigration(deps)
  assertEquals(r.complete, true)
  assertEquals(r.tenants, { [ACME]: 'migrated' })
  assert(logs.some((l) => l.startsWith('[membership-migration] done tenants=1 migrated=1')), logs.join('\n'))
})
