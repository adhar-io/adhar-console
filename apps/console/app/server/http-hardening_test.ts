import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { csrfRejected, guardJsonBody, RequestBodyError, withDeadline, withSecurityHeaders } from './http-hardening.ts'

const post = (headers: Record<string, string> = {}, body = '{}') =>
  new Request('https://console.example.com/api/workspace/members', { method: 'POST', headers, body })

Deno.test('csrf: a foreign Origin on a write is refused', async () => {
  const res = csrfRejected(post({ origin: 'https://app.example.com' }))
  assertEquals(res?.status, 403)
  assertEquals((await res!.json()).error, 'origin_not_allowed')
})

Deno.test('csrf: same origin, and no Origin at all (webhooks, curl), pass', () => {
  assertEquals(csrfRejected(post({ origin: 'https://console.example.com' })), null)
  assertEquals(csrfRejected(post()), null)
})

Deno.test('csrf: reads are never gated', () => {
  const req = new Request('https://console.example.com/api/teams', { headers: { origin: 'https://evil.test' } })
  assertEquals(csrfRejected(req), null)
})

Deno.test('json guard: malformed body is a 400 RequestBodyError, not a SyntaxError', async () => {
  const req = post({}, '{not json')
  guardJsonBody(req)
  const err = await assertRejects(() => req.json(), RequestBodyError)
  assertEquals(err.status, 400)
  assertEquals((await err.toResponse().json()).error, 'invalid_json')
})

Deno.test('json guard: an empty body is invalid_json', async () => {
  const req = new Request('https://c.test/api/x', { method: 'POST', body: '' })
  guardJsonBody(req)
  await assertRejects(() => req.json())
})

Deno.test('json guard: valid JSON parses as before', async () => {
  const req = post({}, '{"a":[1,2]}')
  guardJsonBody(req)
  assertEquals(await req.json(), { a: [1, 2] })
  assert(req.bodyUsed)
})

Deno.test('json guard: oversized body is 413, by declared length and by streamed length', async () => {
  const declared = post({ 'content-length': '999' }, '{}')
  guardJsonBody(declared, 10)
  assertEquals((await assertRejects(() => declared.json(), RequestBodyError)).status, 413)

  const streamed = post({}, JSON.stringify({ pad: 'x'.repeat(100) }))
  guardJsonBody(streamed, 10)
  assertEquals((await assertRejects(() => streamed.json(), RequestBodyError)).status, 413)
})

Deno.test('security headers: added when missing, never overriding a handler', () => {
  const res = withSecurityHeaders(new Response('x', { headers: { 'x-frame-options': 'DENY' } }))
  assertEquals(res.headers.get('x-content-type-options'), 'nosniff')
  assertEquals(res.headers.get('content-security-policy'), "frame-ancestors 'self'")
  assertEquals(res.headers.get('x-frame-options'), 'DENY')
  assertEquals(res.headers.get('strict-transport-security'), null)
})

Deno.test('security headers: immutable responses (redirects) are re-wrapped', () => {
  const res = withSecurityHeaders(Response.redirect('https://c.test/login', 302))
  assertEquals(res.status, 302)
  assertEquals(res.headers.get('location'), 'https://c.test/login')
  assertEquals(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
})

Deno.test('withDeadline: rejects after the deadline and clears its timer', async () => {
  await assertRejects(() => withDeadline(new Promise(() => {}), 5, 'too slow'), Error, 'too slow')
  assertEquals(await withDeadline(Promise.resolve(1), 1000, 'x'), 1)
})
