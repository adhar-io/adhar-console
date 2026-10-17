import { assertEquals } from 'jsr:@std/assert@1'
import { decodeParam, discoverHref, encodeParam } from './discover-links.ts'

Deno.test('discoverHref drops empties and quotes JSON-looking values', () => {
  assertEquals(discoverHref('metrics', { q: 'up', range: '1h', step: 60, ns: '', svc: null }), '/discover?section=metrics&q=up&range=1h&step=%2260%22')
})

Deno.test('encode/decode round-trip like TanStack Router', () => {
  for (const v of ['60', 'true', 'api', '{x}', 'sum(rate(a[5m]))']) assertEquals(decodeParam(encodeParam(v)), v)
  assertEquals(encodeParam('60'), '"60"')
  assertEquals(decodeParam('plain'), 'plain')
})
