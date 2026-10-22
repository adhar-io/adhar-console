import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { forwardableRequestHeader, proxyToolRequest, unsafeUpstreamPath } from './proxy.ts'

Deno.test('proxy: encoded traversal is refused, encoded slashes inside a name are not', () => {
  for (const p of ['/api/v1/..', '/a%2F..%2F..%2Fadmin', '/a/%2e%2e/b', '/a%5C..%5Cb', '/a/.%2E/b', '/a%0d%0aX', '/bad%E0%A4%A']) {
    assert(unsafeUpstreamPath(p), p)
  }
  for (const p of ['', '/api/v1/repos/o/r/branches/feat%2Fx', '/api/v2.0/projects/p/repositories/a%252Fb', '/v1/x..y', '/a/.well-known']) {
    assertFalse(unsafeUpstreamPath(p), p)
  }
})

Deno.test('proxy: identity / trusted-proxy headers from the client are not forwarded', () => {
  for (const h of ['Impersonate-User', 'impersonate-group', 'X-Scope-OrgID', 'X-WEBAUTH-USER', 'X-Forwarded-For', 'x-forwarded-user', 'Forwarded', 'X-Real-IP', 'X-Auth-Request-Email', 'X-Remote-User', 'Authorization', 'Cookie', 'Host']) {
    assertFalse(forwardableRequestHeader(h), h)
  }
  for (const h of ['accept', 'content-type', 'x-requested-with', 'if-none-match']) assert(forwardableRequestHeader(h), h)
})

Deno.test('proxy: /api/svc/k8s is refused — the gateway is the only cluster path', async () => {
  const res = await proxyToolRequest(new Request('https://c.test/api/svc/k8s/api/v1/secrets'), 'k8s', 'api/v1/secrets')
  assertEquals(res.status, 404)
})

Deno.test('proxy: prototype keys are not tools', async () => {
  for (const t of ['__proto__', 'constructor', 'toString']) {
    const res = await proxyToolRequest(new Request(`https://c.test/api/svc/${t}/x`), t, 'x')
    assertEquals(res.status, 404, t)
  }
})
