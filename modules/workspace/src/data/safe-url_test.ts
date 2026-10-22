import { assertEquals } from 'jsr:@std/assert@^1'
import { safeExternalHref } from './safe-url.ts'

Deno.test('safeExternalHref keeps http(s) URLs', () => {
  assertEquals(safeExternalHref('https://trust.example.com/soc2'), 'https://trust.example.com/soc2')
  assertEquals(safeExternalHref('  http://example.com  '), 'http://example.com/')
})

Deno.test('safeExternalHref rejects script, data and relative URLs', () => {
  assertEquals(safeExternalHref('javascript:alert(1)'), undefined)
  assertEquals(safeExternalHref(' JavaScript:alert(1)'), undefined)
  assertEquals(safeExternalHref('data:text/html,<script>alert(1)</script>'), undefined)
  assertEquals(safeExternalHref('trust.example.com/soc2'), undefined)
  assertEquals(safeExternalHref(''), undefined)
  assertEquals(safeExternalHref(undefined), undefined)
})
