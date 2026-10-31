import { assertEquals } from 'jsr:@std/assert@1'
import { countOrgSeats } from './usage-meter.ts'
import { FakeKeycloak } from '../workspace/testing/fake-keycloak.ts'

// Seats are the organisation's explicit members in Keycloak — not documents
// the console kept, which drifted from who could actually sign in.

Deno.test('seats are the union of the member and admin groups', async () => {
  const kc = new FakeKeycloak()
  const a = kc.addUser({ username: 'a@x.test' })
  const b = kc.addUser({ username: 'b@x.test' })
  const c = kc.addUser({ username: 'c@x.test' })
  for (const g of ['org-acme', 'org-acme-admin']) kc.join(a, g)
  kc.join(b, 'org-acme')
  kc.join(c, 'org-acme-admin') // admin-only still holds a seat, once
  kc.join(kc.addUser({ username: 'p@x.test' }), 'platform-admin') // not a seat of anyone's
  assertEquals(await countOrgSeats(kc.client(), 'acme'), 3)
  assertEquals(await countOrgSeats(kc.client(), 'empty'), 0)
})

Deno.test('a seat count Keycloak cannot give is unknown, never a guess', async () => {
  const kc = new FakeKeycloak()
  kc.addGroup('org-acme')
  kc.down = true
  assertEquals(await countOrgSeats(kc.client(), 'acme'), null)
  assertEquals(await countOrgSeats(null, 'acme'), null)
})
