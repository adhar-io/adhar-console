import { assert, assertEquals, assertRejects } from 'jsr:@std/assert'
import { createPlaneApi, PlaneError, PlaneLimiter } from './plane.ts'

/** A clock where sleeping advances time instantly, recording every wait. */
function virtualClock() {
  let t = 1_792_684_000_000
  const sleeps: number[] = []
  return { now: () => t, sleep: (ms: number) => (sleeps.push(ms), (t += ms), Promise.resolve()), sleeps, at: () => t }
}

const res = (status: number, headers: Record<string, string> = {}, body = '{}') => new Response(status === 204 ? null : body, { status, headers })

Deno.test('limiter: calls are spaced to the per-minute budget, in order', async () => {
  const clock = virtualClock()
  const lim = new PlaneLimiter(20, clock)
  const order: number[] = []
  const start = clock.at()
  await Promise.all([1, 2, 3].map((i) => lim.run(() => (order.push(i), Promise.resolve(res(200))))))
  assertEquals(order, [1, 2, 3])
  // 20/min → 3 s apart; the third call starts 6 s after the first.
  assertEquals(clock.at() - start, 6_000)
})

Deno.test('limiter: 429 waits for Retry-After, then succeeds', async () => {
  const clock = virtualClock()
  const lim = new PlaneLimiter(600, clock)
  let n = 0
  const r = await lim.run(() => Promise.resolve(++n === 1 ? res(429, { 'retry-after': '7' }) : res(201)))
  assertEquals(r.status, 201)
  assertEquals(n, 2)
  assert(clock.sleeps.includes(7_000), `slept ${clock.sleeps}`)
})

Deno.test('limiter: an almost-spent budget pauses until X-RateLimit-Reset', async () => {
  const clock = virtualClock()
  const lim = new PlaneLimiter(600, clock)
  const reset = Math.floor(clock.at() / 1000) + 40
  await lim.run(() => Promise.resolve(res(200, { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(reset) })))
  const before = clock.at()
  await lim.run(() => Promise.resolve(res(200)))
  assert(clock.at() - before >= 39_000, `waited only ${clock.at() - before} ms`)
})

Deno.test('limiter: gives up after maxAttempts and returns the last 429', async () => {
  const clock = virtualClock()
  const lim = new PlaneLimiter(600, clock, 3)
  let n = 0
  const r = await lim.run(() => (n++, Promise.resolve(res(429))))
  assertEquals(r.status, 429)
  assertEquals(n, 3)
})

Deno.test('limiter: one failed call does not poison the chain', async () => {
  const clock = virtualClock()
  const lim = new PlaneLimiter(600, clock, 1)
  await assertRejects(() => lim.run(() => Promise.reject(new Error('network down'))))
  assertEquals((await lim.run(() => Promise.resolve(res(200)))).status, 200)
})

Deno.test('client: API key header, v1 paths, list unwrapping, errors carry the status', async () => {
  const seen: Array<{ method: string; url: string; key: string | null; body?: string }> = []
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers)
    seen.push({ method: init?.method ?? 'GET', url: String(url), key: h.get('x-api-key'), body: init?.body as string | undefined })
    if (String(url).endsWith('/projects/?per_page=100')) return res(200, {}, JSON.stringify({ results: [{ id: 'p1', name: 'Platform Support', identifier: 'SUP' }], next_cursor: null }))
    if (String(url).includes('/issues/') && init?.method === 'POST') return res(201, {}, JSON.stringify({ id: 'i1', sequence_id: 7 }))
    if (String(url).includes('/states/')) return res(403, {}, '{"detail":"forbidden"}')
    return res(200)
  }) as typeof fetch
  const api = createPlaneApi({ baseUrl: 'http://plane-api:8000', headers: { 'x-api-key': 'k' }, workspace: 'adhar', publicUrl: 'https://plane.example', fetch: fetchFake, limiter: new PlaneLimiter(6000) })
  assertEquals((await api.listProjects())[0].identifier, 'SUP')
  const issue = await api.createIssue('p1', { name: '[incident] x', description_html: '<p>x</p>', priority: 'high', labels: ['l1'] })
  assertEquals(issue.sequence_id, 7)
  assertEquals(seen[1].url, 'http://plane-api:8000/api/v1/workspaces/adhar/projects/p1/issues/')
  assertEquals(JSON.parse(seen[1].body!).priority, 'high')
  assert(seen.every((s) => s.key === 'k'))
  const err = await assertRejects(() => api.listStates('p1'), PlaneError)
  assertEquals(err.status, 403)
  assertEquals(api.issueUrl('p1', 'i1'), 'https://plane.example/adhar/projects/p1/issues/i1')
})
