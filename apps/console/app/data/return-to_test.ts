import { assertEquals } from 'jsr:@std/assert@1'
import { safeReturnTo, splitReturnTo } from './return-to.ts'

Deno.test('safeReturnTo keeps same-origin paths with their query', () => {
  assertEquals(safeReturnTo('/deliver?section=flow'), '/deliver?section=flow')
  assertEquals(safeReturnTo('/'), '/')
})

Deno.test('safeReturnTo refuses off-origin and non-path targets', () => {
  for (const bad of ['//evil.io', '/\\evil.io', 'https://evil.io', 'javascript:alert(1)', '/\t/evil.io', '', undefined, null]) {
    assertEquals(safeReturnTo(bad), '/', String(bad))
  }
})

Deno.test('safeReturnTo refuses /login so a signed-in user cannot loop', () => {
  assertEquals(safeReturnTo('/login'), '/')
  assertEquals(safeReturnTo('/login?returnTo=/x'), '/')
  assertEquals(safeReturnTo('/login-help'), '/login-help')
})

Deno.test('splitReturnTo yields router to/search', () => {
  assertEquals(splitReturnTo('/deliver?section=flow&x=1'), { to: '/deliver', search: { section: 'flow', x: '1' } })
  assertEquals(splitReturnTo('//evil.io'), { to: '/', search: {} })
})
