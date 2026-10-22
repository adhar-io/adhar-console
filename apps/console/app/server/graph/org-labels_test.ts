import { assertEquals } from 'jsr:@std/assert@1'
import { orgOfLabels } from './model.ts'

// Control-plane namespaces (dev/test/prod) carry adhar.io/organisation; the
// console's provisioner writes adhar.io/org. Both must resolve to the tenant.
Deno.test('a namespace belongs to its organisation under either label', () => {
  assertEquals(orgOfLabels({ 'adhar.io/organisation': 'adhar', 'adhar.io/team': 'platform' }), 'adhar')
  assertEquals(orgOfLabels({ 'adhar.io/org': 'acme' }), 'acme')
  assertEquals(orgOfLabels({ 'adhar.io/org': 'acme', 'adhar.io/organisation': 'other' }), 'acme')
  assertEquals(orgOfLabels({}), undefined)
  assertEquals(orgOfLabels(undefined), undefined)
})
