import { assertEquals } from 'jsr:@std/assert@1'
import { MIN_REFRESH_MS, windowRefreshMs } from './refresh.ts'

Deno.test('windowRefreshMs — floors short windows at one minute', () => {
  assertEquals(windowRefreshMs(5 * 60_000), MIN_REFRESH_MS)
  assertEquals(windowRefreshMs(60 * 60_000), MIN_REFRESH_MS)
  assertEquals(windowRefreshMs(0), MIN_REFRESH_MS)
  assertEquals(windowRefreshMs(NaN), MIN_REFRESH_MS)
})

Deno.test('windowRefreshMs — long windows refresh proportionally less often', () => {
  assertEquals(windowRefreshMs(6 * 3_600_000), 6 * 60_000)
  assertEquals(windowRefreshMs(24 * 3_600_000), 24 * 60_000)
  assertEquals(windowRefreshMs(7 * 86_400_000), 168 * 60_000)
})
