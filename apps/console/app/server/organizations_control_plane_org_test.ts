import { assertEquals } from 'jsr:@std/assert@1'
import { controlPlaneOrg, type Organization, type Registry } from './organizations.ts'

// Team XRs name their organisation by slug, taken from controlPlaneOrg. The
// seed placeholder ("Default Organization", slug `default`) once reached it
// unchecked and the cluster grew Team `default-platform` for an organisation
// that exists nowhere (2026-10-25).

const org = (id: string, slug = id): Organization => ({ id, name: id, slug, createdAt: '2026-10-25T00:00:00Z' })

Deno.test('a real organisation of the tenant is named', () => {
  const reg: Registry = { orgs: [org('adhar')], activeId: 'adhar' }
  assertEquals(controlPlaneOrg(reg, 'adhar')?.slug, 'adhar')
})

Deno.test('the seed placeholder is never named', () => {
  // The seed takes the tenant id as its slug, so it is not always `default`.
  const reg: Registry = { orgs: [org('acme')], activeId: 'acme', seeded: true }
  assertEquals(controlPlaneOrg(reg, 'acme'), undefined)
})

Deno.test('a reserved slug is never named, even outside the seed', () => {
  const reg: Registry = { orgs: [org('t-1', 'default'), org('t-2', 'adhar-system')], activeId: 't-1' }
  assertEquals(controlPlaneOrg(reg, 't-1'), undefined)
  assertEquals(controlPlaneOrg(reg, 't-2'), undefined)
})

Deno.test('no registry or another tenant names nothing', () => {
  assertEquals(controlPlaneOrg(null, 'adhar'), undefined)
  assertEquals(controlPlaneOrg({ orgs: [org('adhar')], activeId: 'adhar' }, 'other'), undefined)
})
