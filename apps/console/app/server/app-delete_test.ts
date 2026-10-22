import { assertEquals } from 'jsr:@std/assert'
import { repoRefusal, validateAppDelete } from './app-delete.ts'

Deno.test('validateAppDelete: a well-formed request', () => {
  assertEquals(validateAppDelete({ name: 'check-server', confirm: 'check-server' }), { ok: true, name: 'check-server', deleteRepo: false })
  assertEquals(validateAppDelete({ name: 'check-server', confirm: 'check-server', deleteRepo: true }), { ok: true, name: 'check-server', deleteRepo: true })
})

Deno.test('validateAppDelete: name must be a DNS-1123 label', () => {
  for (const name of ['', 'Check-Server', '-x', 'x-', 'a.b', 'a/b', '../etc', 'x'.repeat(64), 42, undefined]) {
    const v = validateAppDelete({ name, confirm: name })
    assertEquals(v.ok, false, `accepted ${String(name)}`)
    if (!v.ok) assertEquals(v.error, 'invalid_name')
  }
})

Deno.test('validateAppDelete: confirmation must equal the name exactly', () => {
  for (const confirm of [undefined, '', 'check', 'Check-Server', ' check-server']) {
    const v = validateAppDelete({ name: 'check-server', confirm })
    assertEquals(v.ok, false)
    if (!v.ok) assertEquals(v.error, 'confirm_mismatch')
  }
})

Deno.test('validateAppDelete: deleteRepo must be boolean when present', () => {
  const v = validateAppDelete({ name: 'a', confirm: 'a', deleteRepo: 'yes' })
  assertEquals(v.ok, false)
})

Deno.test('validateAppDelete: platform repositories are refused', () => {
  for (const name of ['packages', 'environments', 'adhar-templates', 'adhar']) {
    const v = validateAppDelete({ name, confirm: name, deleteRepo: true })
    assertEquals(v.ok, false)
    if (!v.ok) assertEquals(v.error, 'platform_app')
  }
})

Deno.test('validateAppDelete: not an object', () => {
  assertEquals(validateAppDelete(null).ok, false)
})

Deno.test('repoRefusal: mirrors, archived and platform repos are protected', () => {
  assertEquals(repoRefusal({ name: 'check-server' }), null)
  assertEquals(typeof repoRefusal({ name: 'check-server', mirror: true }), 'string')
  assertEquals(typeof repoRefusal({ name: 'check-server', archived: true }), 'string')
  assertEquals(typeof repoRefusal({ name: 'packages' }), 'string')
})
