import { assertEquals } from 'jsr:@std/assert@1'
import { isHttpUrl, isSafeLinkUrl } from './safe-url.ts'

Deno.test('isSafeLinkUrl accepts web navigation', () => {
  for (const ok of ['https://gitea.example.io/acme/cart', 'http://x.io', 'mailto:team@x.io', '/catalog?entity=x', ' https://x.io ']) {
    assertEquals(isSafeLinkUrl(ok), true, ok)
  }
})

Deno.test('isSafeLinkUrl refuses script, data and off-origin targets', () => {
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.io', '/\\evil.io', 'https:///x', '', null, undefined]) {
    assertEquals(isSafeLinkUrl(bad), false, String(bad))
  }
})

Deno.test('isHttpUrl only accepts absolute http(s)', () => {
  assertEquals(isHttpUrl('https://gitea.x.io/acme/cart.git'), true)
  assertEquals(isHttpUrl('javascript:alert(1)'), false)
  assertEquals(isHttpUrl('/relative'), false)
  assertEquals(isHttpUrl('ftp://x.io'), false)
})
