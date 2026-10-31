import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { buildDirectory, DirectoryUnavailable, OrgDirectory, PLATFORM_ENTRY } from './directory.ts'
import { MemoryDb } from '../workspace/testing/memory-store.ts'

const reg = (userId: string, orgs: Array<Record<string, unknown>>) => ({ userId, data: { orgs, activeId: orgs[0]?.id ?? '' } })
const org = (id: string, slug: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ id, slug, name: slug.toUpperCase(), createdAt, ...extra })

Deno.test('the platform organisation is always adhar → default, and nobody can claim either half', () => {
  const { entries, conflicts } = buildDirectory(
    [{ id: 'adhar', data: { slug: 'adhar', tenantId: 'hijack-1abcd', name: 'Mine', createdAt: '2026-01-01T00:00:00Z' } }],
    [reg('u1', [org('adhar-xyz12', 'adhar', '2020-01-01T00:00:00Z'), org('default', 'evil', '2020-01-01T00:00:00Z')])],
  )
  assertEquals(entries[0], PLATFORM_ENTRY)
  assertEquals(entries.filter((e) => e.slug === 'adhar').length, 1)
  assertEquals(entries.filter((e) => e.tenantId === 'default').length, 1)
  assert(conflicts.some((c) => c.includes('platform')), conflicts.join('; '))
})

Deno.test('the platform organisation may be renamed, never moved', () => {
  const { entries } = buildDirectory([{ id: 'adhar', data: { slug: 'adhar', tenantId: 'default', name: 'Acme Platform', createdAt: '2026-01-01T00:00:00Z' } }], [])
  assertEquals([entries[0].slug, entries[0].tenantId, entries[0].name], ['adhar', 'default', 'Acme Platform'])
})

Deno.test('one slug in several registries: the earliest created wins, a stored entry beats them all', () => {
  const regs = [
    reg('u1', [org('acme-later', 'acme', '2026-05-01T00:00:00Z', { createdBy: 'u1' })]),
    reg('u2', [org('acme-first', 'acme', '2026-01-01T00:00:00Z', { createdBy: 'u2' })]),
  ]
  const { entries, conflicts } = buildDirectory([], regs)
  assertEquals(entries.find((e) => e.slug === 'acme')?.tenantId, 'acme-first')
  assertEquals(conflicts.length, 1)
  const stored = buildDirectory([{ id: 'acme', data: { slug: 'acme', tenantId: 'acme-later', name: 'Acme', createdAt: '2026-05-01T00:00:00Z' } }], regs)
  assertEquals(stored.entries.find((e) => e.slug === 'acme')?.tenantId, 'acme-later')
})

Deno.test('seeds, reserved slugs and the console\'s own tenants are not organisations', () => {
  const { entries } = buildDirectory([], [
    reg('u1', [
      org('default', 'default', '2026-01-01T00:00:00Z'), // the readRegistry seed
      org('acme-x1y2z', 'acme-x1y2z', '2026-01-01T00:00:00Z'), // a seed keyed to a session tenant
      org('kube-system-ab12c', 'kube-system', '2026-01-01T00:00:00Z'),
      org('_u_abc', 'personal', '2026-01-01T00:00:00Z'),
      org('Bad Id', 'bad', '2026-01-01T00:00:00Z'),
      org('acme-x1y2z', 'acme', '2026-01-01T00:00:00Z'),
    ]),
  ])
  assertEquals(entries.map((e) => `${e.slug}→${e.tenantId}`), ['adhar→default', 'acme→acme-x1y2z'])
})

Deno.test('a deleted organisation stays deleted although registries still name it', () => {
  const { entries } = buildDirectory(
    [{ id: 'acme', data: { slug: 'acme', tenantId: 'acme-x1y2z', name: 'Acme', createdAt: '2026-01-01T00:00:00Z', deletedAt: '2026-06-01T00:00:00Z' } }],
    [reg('u1', [org('acme-x1y2z', 'acme', '2026-01-01T00:00:00Z')])],
  )
  assertEquals(entries.map((e) => e.slug), ['adhar'])
})

Deno.test('a legacy x / x-admin pair: x-admin is dropped (never resolved, entitled or migrated) and reported', () => {
  const { entries, conflicts } = buildDirectory([], [reg('u1', [org('sys-11111', 'sys', '2026-01-01T00:00:00Z'), org('sys-admin-22222', 'sys-admin', '2026-01-02T00:00:00Z')])])
  assert(conflicts.some((c) => c.includes('sys-admin') && c.includes('admin group of sys')), conflicts.join('; '))
  // Its member group org-sys-admin IS sys's admin group: kept, it would make
  // every one of its members an admin of sys.
  assertEquals(entries.map((e) => e.slug), ['adhar', 'sys'])
  // A stored entry is no exception, and neither is the platform's own slug.
  const stored = buildDirectory(
    [{ id: 'adhar-admin', data: { slug: 'adhar-admin', tenantId: 'adhar-admin-33333', name: 'X', createdAt: '2026-01-01T00:00:00Z' } }],
    [],
  )
  assertEquals(stored.entries.map((e) => e.slug), ['adhar'])
  // Without its x, an x-admin is just a name.
  assertEquals(buildDirectory([], [reg('u1', [org('ops-admin-44444', 'ops-admin', '2026-01-01T00:00:00Z')])]).entries.map((e) => e.slug), ['adhar', 'ops-admin'])
})

Deno.test('one tenant holds one organisation, and never a console system tenant', () => {
  const { entries, conflicts } = buildDirectory(
    [{ id: 'acme', data: { slug: 'acme', tenantId: 'shared-11111', name: 'Acme', createdAt: '2026-02-01T00:00:00Z' } }],
    [
      reg('u1', [org('shared-11111', 'other', '2026-01-01T00:00:00Z')]),
      reg('u2', [org('auth', 'sessions', '2026-01-01T00:00:00Z')]),
    ],
  )
  // The stored entry keeps the tenant; the second slug for it is dropped.
  assertEquals(entries.map((e) => `${e.slug}→${e.tenantId}`), ['adhar→default', 'acme→shared-11111'])
  assert(conflicts.some((c) => c.includes('other') && c.includes('shared-11111')), conflicts.join('; '))
  // `auth` holds the session store; no organisation may be pointed at it.
  const sys = buildDirectory([{ id: 'sessions', data: { slug: 'sessions', tenantId: 'auth', name: 'S', createdAt: '' } }], [])
  assertEquals(sys.entries.map((e) => e.slug), ['adhar'])
})

Deno.test('an organisation created on another replica is found on a miss, without waiting out the cache', async () => {
  const db = new MemoryDb()
  let now = 0
  const here = new OrgDirectory(db.directorySource(), { log: () => {}, now: () => now })
  const there = new OrgDirectory(db.directorySource(), { log: () => {} })
  await here.entries() // warm cache, before the organisation exists
  now = 10_000
  await there.put({ slug: 'gamma', tenantId: 'gamma-z1z2z', name: 'Gamma', createdAt: '2026-03-01T00:00:00Z' }, 'u1')
  assertEquals(await here.byTenant('gamma-z1z2z'), null, 'a plain lookup is served from the cache')
  assertEquals((await here.byTenant('gamma-z1z2z', { refreshOnMiss: true }))?.slug, 'gamma')
  // ...and a miss for something that does not exist does not re-read on every call.
  let reads = 0
  const counting = new OrgDirectory({ ...db.directorySource(), listStored: () => (reads++, Promise.resolve([])) }, { now: () => now })
  await counting.byTenant('nope-11111', { refreshOnMiss: true })
  await counting.byTenant('nope-11111', { refreshOnMiss: true })
  assertEquals(reads, 1)
})

Deno.test('the directory caches, sees its own writes at once, and says when it cannot be read', async () => {
  const db = new MemoryDb()
  db.setRegistry('u1', { orgs: [org('acme-x1y2z', 'acme', '2026-01-01T00:00:00Z', { createdBy: 'u1' })], activeId: 'acme-x1y2z' })
  const dir = new OrgDirectory(db.directorySource(), { log: () => {} })
  assertEquals((await dir.byTenant('acme-x1y2z'))?.slug, 'acme')
  assertEquals((await dir.bySlug('adhar'))?.tenantId, 'default')
  await dir.put({ slug: 'beta', tenantId: 'beta-q9w8e', name: 'Beta', createdAt: '2026-02-01T00:00:00Z' }, 'u2')
  assertEquals((await dir.bySlug('beta'))?.tenantId, 'beta-q9w8e')
  const acme = (await dir.bySlug('acme'))!
  await dir.remove(acme, 'u1')
  assertEquals(await dir.bySlug('acme'), null)
  await assertRejects(() => dir.put({ slug: 'default', tenantId: 'x-11111', name: 'x', createdAt: '' }, 'u'))

  const broken = new OrgDirectory({
    listStored: () => Promise.reject(new Error('connection refused')),
    putStored: () => Promise.resolve(),
    listRegistries: () => Promise.resolve([]),
  })
  await assertRejects(() => broken.entries(), DirectoryUnavailable)
  // No database configured at all is not an error: just the platform organisation.
  assertEquals((await new OrgDirectory(null).entries()).map((e) => e.slug), ['adhar'])
})
