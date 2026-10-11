import { assertEquals } from 'jsr:@std/assert@1'
import { retryAfterMs, SharedGetCache, snapshot } from './tool-cache.ts'

const entry = (at: number, text = 'x') => ({
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'application/json']] as Array<[string, string]>,
  body: new TextEncoder().encode(text),
  at,
})

Deno.test('fresh entries are served and old ones are not', () => {
  let now = 1_000
  const c = new SharedGetCache(() => now)
  c.set('plane\0/a', entry(1_000))
  assertEquals(c.get('plane\0/a', 500)?.status, 200)
  now = 1_600
  assertEquals(c.get('plane\0/a', 500), undefined)
  // Still usable as a stale stand-in under a longer window.
  assertEquals(c.get('plane\0/a', 10_000)?.status, 200)
})

Deno.test('concurrent misses share one upstream load', async () => {
  const c = new SharedGetCache()
  let calls = 0
  const load = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 10))
    return entry(Date.now())
  }
  const [a, b, d] = await Promise.all([c.coalesce('k', load), c.coalesce('k', load), c.coalesce('k', load)])
  assertEquals(calls, 1)
  assertEquals(a, b)
  assertEquals(b, d)
  await c.coalesce('k', load)
  assertEquals(calls, 2)
})

Deno.test('invalidate drops only the tool prefix', () => {
  const c = new SharedGetCache()
  c.set('plane\0/a', entry(Date.now()))
  c.set('plane\0/b', entry(Date.now()))
  c.set('gitea\0/a', entry(Date.now()))
  c.invalidate('plane\0')
  assertEquals(c.size, 1)
  assertEquals(c.get('gitea\0/a', 60_000)?.status, 200)
})

Deno.test('the cache is bounded and evicts the oldest first', () => {
  const c = new SharedGetCache()
  for (let i = 0; i < 510; i++) c.set(`k${i}`, entry(Date.now()))
  assertEquals(c.size, 500)
  assertEquals(c.get('k0', 60_000), undefined)
  assertEquals(c.get('k509', 60_000)?.status, 200)
})

Deno.test('retryAfterMs reads Retry-After seconds, dates and X-RateLimit-Reset', () => {
  const now = Date.parse('2026-10-11T10:00:00Z')
  assertEquals(retryAfterMs(new Headers({ 'retry-after': '3' }), now), 3_000)
  assertEquals(retryAfterMs(new Headers({ 'retry-after': 'Sun, 11 Oct 2026 10:00:02 GMT' }), now), 2_000)
  assertEquals(retryAfterMs(new Headers({ 'x-ratelimit-reset': String(now / 1000 + 4) }), now), 4_000)
  assertEquals(retryAfterMs(new Headers(), now), undefined)
})

Deno.test('snapshot buffers the body so it can be served many times', async () => {
  const s = await snapshot(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
  assertEquals(new TextDecoder().decode(s.body), '{"ok":true}')
  assertEquals(await new Response(s.body).text(), '{"ok":true}')
  assertEquals(await new Response(s.body).text(), '{"ok":true}')
})
