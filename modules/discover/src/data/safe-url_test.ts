import { assertEquals } from 'jsr:@std/assert@^1'
import { safeExternalUrl } from './safe-url.ts'

Deno.test('safeExternalUrl keeps absolute http(s) links', () => {
  assertEquals(safeExternalUrl('https://github.com/acme/app'), 'https://github.com/acme/app')
  assertEquals(safeExternalUrl('  http://runbooks.local/x?y=1  '), 'http://runbooks.local/x?y=1')
})

Deno.test('safeExternalUrl drops script and non-web schemes', () => {
  assertEquals(safeExternalUrl('javascript:alert(1)'), undefined)
  assertEquals(safeExternalUrl(' JaVaScRiPt:alert(1)'), undefined)
  assertEquals(safeExternalUrl('java\tscript:alert(1)'), undefined)
  assertEquals(safeExternalUrl('data:text/html,<script>alert(1)</script>'), undefined)
  assertEquals(safeExternalUrl('vbscript:msgbox(1)'), undefined)
  assertEquals(safeExternalUrl('file:///etc/passwd'), undefined)
})

Deno.test('safeExternalUrl drops relative, empty and malformed values', () => {
  assertEquals(safeExternalUrl('/relative/path'), undefined)
  assertEquals(safeExternalUrl('github.com/acme/app'), undefined)
  assertEquals(safeExternalUrl(''), undefined)
  assertEquals(safeExternalUrl(null), undefined)
  assertEquals(safeExternalUrl(undefined), undefined)
})
