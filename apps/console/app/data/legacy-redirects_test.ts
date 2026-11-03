import { assertEquals } from 'jsr:@std/assert@1'
import { legacyRedirect } from './legacy-redirects.ts'

Deno.test('moved pages redirect to their new home', () => {
  assertEquals(legacyRedirect('platform', { section: 'ci' }), { to: '/develop', search: { section: 'builds' } })
  assertEquals(legacyRedirect('develop', { section: 'codebuilder' }), { to: '/design', search: { section: 'builder' } })
  assertEquals(legacyRedirect('platform', { section: 'chaos' }), { to: '/deliver', search: { section: 'chaos' } })
})

Deno.test('deep-link params survive where the page itself moved', () => {
  assertEquals(legacyRedirect('develop', { section: 'performance', run: 'ns/r1' }), { to: '/deliver', search: { section: 'performance', run: 'ns/r1' } })
  assertEquals(legacyRedirect('deliver', { section: 'functions', fn: 'x' }), { to: '/develop', search: { section: 'functions', fn: 'x' } })
})

Deno.test('current homes are left alone', () => {
  for (const [phase, section] of [['deliver', 'performance'], ['deliver', 'chaos'], ['develop', 'builds'], ['develop', 'functions'], ['platform', undefined]] as const) {
    assertEquals(legacyRedirect(phase, { section }), null)
  }
})
