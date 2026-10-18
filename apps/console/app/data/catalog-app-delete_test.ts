import { assertEquals } from 'jsr:@std/assert'
import { belongsToDeletingApp, composedRefs, pruneStaleScaffolded, roleCanDeleteApplications, splitApplications } from './catalog-app-delete-model.ts'
import type { Entity } from './catalog.ts'

const xr = (name: string, deletionTimestamp?: string) => ({ metadata: { name, ...(deletionTimestamp ? { deletionTimestamp } : {}) } })

Deno.test('splitApplications: XRs being deleted are not applications any more', () => {
  const { active, deleting } = splitApplications([xr('cart'), xr('check-server', '2026-10-18T10:00:00Z')])
  assertEquals(active.map((a) => a.metadata.name), ['cart'])
  assertEquals([...deleting], ['check-server'])
})

Deno.test('belongsToDeletingApp: by application label, else by name', () => {
  const deleting = new Set(['check-server'])
  assertEquals(belongsToDeletingApp({ metadata: { name: 'check-server' } }, deleting), true)
  assertEquals(belongsToDeletingApp({ metadata: { name: 'web', labels: { 'adhar.io/application': 'check-server' } } }, deleting), true)
  assertEquals(belongsToDeletingApp({ metadata: { name: 'cart' } }, deleting), false)
  assertEquals(belongsToDeletingApp({ metadata: { name: 'check-server' } }, new Set()), false)
})

Deno.test('composedRefs: Crossplane v1 and v2 shapes', () => {
  const ref = { apiVersion: 'v1', kind: 'Object', name: 'check-server-dev' }
  assertEquals(composedRefs({ apiVersion: 'x', kind: 'Application', metadata: { name: 'a' }, spec: { resourceRefs: [ref] } }), [{ kind: 'Object', name: 'check-server-dev' }])
  assertEquals(composedRefs({ apiVersion: 'x', kind: 'Application', metadata: { name: 'a' }, spec: { crossplane: { resourceRefs: [ref] } } }), [{ kind: 'Object', name: 'check-server-dev' }])
  assertEquals(composedRefs(undefined), [])
})

Deno.test('roleCanDeleteApplications mirrors the server gate', () => {
  for (const r of ['super-admin', 'platform-admin', 'platform-engineer', 'application-admin']) assertEquals(roleCanDeleteApplications(r), true)
  for (const r of ['developer', 'viewer', null, undefined]) assertEquals(roleCanDeleteApplications(r), false)
})

const scaffolded = (name: string, createdAt: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, namespace: 'default', createdAt, annotations: { 'adhar.io/git-repo': `https://gitea.example.com/adhar/${name}` } },
  spec: { type: 'service' },
  origin: 'registered',
} as Entity)

Deno.test('pruneStaleScaffolded: a deleted scaffolded app does not linger', () => {
  const now = Date.parse('2026-10-18T12:00:00Z')
  const old = scaffolded('check-server', '2026-10-18T10:00:00Z')
  const fresh = scaffolded('new-thing', '2026-10-18T11:55:00Z')
  const manual = { ...old, metadata: { ...old.metadata, name: 'hand-made', annotations: {} } } as Entity
  const live = [scaffolded('cart', '2026-01-01T00:00:00Z')]
  const out = pruneStaleScaffolded([old, fresh, manual], live, true, now).map((e) => e.metadata.name)
  assertEquals(out, ['new-thing', 'hand-made'])
  // Still live → kept; sources unhealthy → nothing is pruned.
  assertEquals(pruneStaleScaffolded([old], [old], true, now).length, 1)
  assertEquals(pruneStaleScaffolded([old], [], false, now).length, 1)
})
