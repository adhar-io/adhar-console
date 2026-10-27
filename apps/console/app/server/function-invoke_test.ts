import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import {
  invokeTargets,
  isAllowedTarget,
  isTextual,
  joinTarget,
  MAX_REQUEST_BODY_BYTES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  readCapped,
  responseHeaders,
  upstreamHeaders,
  validateInvokeRequest,
} from './function-invoke-model.ts'
import { handleFunctionInvoke, type InvokeDeps } from './function-invoke.ts'

/* ───────────── request validation ───────────── */

Deno.test('a minimal request is a GET of / with the default timeout', () => {
  const v = validateInvokeRequest({ namespace: 'dev', name: 'orders' })
  assert(v.ok)
  if (v.ok) {
    assertEquals(v.request.method, 'GET')
    assertEquals(v.request.path, '/')
    assertEquals(v.request.headers, {})
    assertEquals(v.request.body, undefined)
    assertEquals(v.request.timeoutMs, 15_000)
  }
})

Deno.test('namespace and name must be DNS labels — they become an apiserver path', () => {
  for (const bad of [{ namespace: 'Dev', name: 'x' }, { namespace: 'dev', name: '../etc' }, { namespace: '', name: 'x' }, { name: 'x' }]) {
    const v = validateInvokeRequest(bad)
    assertEquals(v.ok, false, JSON.stringify(bad))
  }
})

Deno.test('the path is relative to the function: no scheme, no host, no protocol-relative trick', () => {
  for (const path of ['http://evil.example/', '//evil.example/x', 'relative', '/a b', '/a\\b', `/${'x'.repeat(3000)}`]) {
    const v = validateInvokeRequest({ namespace: 'dev', name: 'fn', path })
    assertEquals(v.ok, false, path)
    if (!v.ok) assertEquals(v.error, 'invalid_path')
  }
  const ok = validateInvokeRequest({ namespace: 'dev', name: 'fn', path: '/orders?limit=5' })
  assert(ok.ok)
})

Deno.test('methods are upper-cased and limited to the HTTP verbs a function serves', () => {
  const v = validateInvokeRequest({ namespace: 'dev', name: 'fn', method: 'post', body: '{}' })
  assert(v.ok)
  if (v.ok) assertEquals(v.request.method, 'POST')
  assertEquals(validateInvokeRequest({ namespace: 'dev', name: 'fn', method: 'CONNECT' }).ok, false)
  assertEquals(validateInvokeRequest({ namespace: 'dev', name: 'fn', method: 'TRACE' }).ok, false)
})

Deno.test('platform and hop-by-hop headers are refused with a reason, not silently dropped', () => {
  for (const h of ['Host', 'cookie', 'X-Forwarded-For', 'Transfer-Encoding', 'Content-Length']) {
    const v = validateInvokeRequest({ namespace: 'dev', name: 'fn', headers: { [h]: 'x' } })
    assertEquals(v.ok, false, h)
    if (!v.ok) assertEquals(v.error, 'forbidden_header')
  }
  const crlf = validateInvokeRequest({ namespace: 'dev', name: 'fn', headers: { 'x-a': 'one\r\nx-b: two' } })
  assertEquals(crlf.ok, false)
  const ok = validateInvokeRequest({ namespace: 'dev', name: 'fn', headers: { 'X-Request-Id': 'abc', Authorization: 'Bearer mine' } })
  assert(ok.ok)
  if (ok.ok) assertEquals(ok.request.headers, { 'x-request-id': 'abc', authorization: 'Bearer mine' })
})

Deno.test('the request body is capped, and GET/HEAD carry none', () => {
  const big = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1)
  const v = validateInvokeRequest({ namespace: 'dev', name: 'fn', method: 'POST', body: big })
  assertEquals(v.ok, false)
  if (!v.ok) assertEquals(v.error, 'body_too_large')
  // Multi-byte characters count as bytes, not characters.
  const wide = 'é'.repeat(MAX_REQUEST_BODY_BYTES / 2 + 1)
  assertEquals(validateInvokeRequest({ namespace: 'dev', name: 'fn', method: 'POST', body: wide }).ok, false)
  const get = validateInvokeRequest({ namespace: 'dev', name: 'fn', method: 'GET', body: '{}' })
  assertEquals(get.ok, false)
  if (!get.ok) assertEquals(get.error, 'body_not_allowed')
})

Deno.test('the timeout is clamped to what a request may hold the console for', () => {
  const lo = validateInvokeRequest({ namespace: 'dev', name: 'fn', timeoutMs: 1 })
  const hi = validateInvokeRequest({ namespace: 'dev', name: 'fn', timeoutMs: 10 * 60_000 })
  assert(lo.ok && hi.ok)
  if (lo.ok) assertEquals(lo.request.timeoutMs, MIN_TIMEOUT_MS)
  if (hi.ok) assertEquals(hi.request.timeoutMs, MAX_TIMEOUT_MS)
})

/* ───────────── targets ───────────── */

const FN = { name: 'orders', namespace: 'dev' }

Deno.test('only the function’s own service or the platform domain may be dialled', () => {
  assert(isAllowedTarget('http://orders.dev.svc.cluster.local', FN, 'cloud.adhar.io'))
  assert(isAllowedTarget('https://orders.dev.cloud.adhar.io', FN, 'cloud.adhar.io'))
  assert(isAllowedTarget('https://orders.dev.adhar.localtest.me:8443', FN, 'adhar.localtest.me:8443'))
  // Another function's service, the metadata endpoint, an IP, credentials, other schemes.
  assertEquals(isAllowedTarget('http://keycloak-http.adhar-system.svc.cluster.local:8080', FN, 'cloud.adhar.io'), false)
  assertEquals(isAllowedTarget('http://169.254.169.254/latest/meta-data', FN, 'cloud.adhar.io'), false)
  assertEquals(isAllowedTarget('http://[::1]/', FN, 'cloud.adhar.io'), false)
  assertEquals(isAllowedTarget('https://user:pw@orders.dev.cloud.adhar.io', FN, 'cloud.adhar.io'), false)
  assertEquals(isAllowedTarget('file:///etc/passwd', FN, 'cloud.adhar.io'), false)
  assertEquals(isAllowedTarget('https://evil.example', FN, 'cloud.adhar.io'), false)
  // No platform domain known: only the cluster-local address.
  assertEquals(isAllowedTarget('https://orders.dev.cloud.adhar.io', FN, undefined), false)
})

Deno.test('targets: the published URL first, then the in-cluster address', () => {
  const t = invokeTargets({
    metadata: { name: 'orders', namespace: 'dev' },
    status: { url: 'https://orders.dev.cloud.adhar.io/', address: 'http://orders.dev.svc.cluster.local' },
  }, 'cloud.adhar.io')
  assertEquals(t, ['https://orders.dev.cloud.adhar.io', 'http://orders.dev.svc.cluster.local'])
})

Deno.test('targets: before the platform writes status.url, the platform route is derived', () => {
  const t = invokeTargets({ metadata: { name: 'orders', namespace: 'test', labels: { 'adhar.io/environment': 'test' } } }, 'test.adhar.io')
  // `<env>` equals the domain's first label → `<name>-<env>.<domain>` (platformRouteHost).
  assertEquals(t, ['https://orders-test.test.adhar.io', 'http://orders.test.svc.cluster.local'])
})

Deno.test('targets: a status.url pointing somewhere else is never dialled', () => {
  const t = invokeTargets({
    metadata: { name: 'orders', namespace: 'dev' },
    status: { url: 'http://10.0.0.1:8080', address: 'http://keycloak-http.adhar-system.svc.cluster.local' },
  }, 'cloud.adhar.io')
  assertEquals(t, ['http://orders.dev.svc.cluster.local'])
})

Deno.test('targets: a cluster-only function is called on its address alone', () => {
  const t = invokeTargets({
    metadata: { name: 'orders', namespace: 'dev', labels: { 'adhar.io/environment': 'dev' } },
    spec: { parameters: { visibility: 'cluster' } },
  }, 'cloud.adhar.io')
  assertEquals(t, ['http://orders.dev.svc.cluster.local'])
})

Deno.test('joining a target and a path never doubles the slash', () => {
  assertEquals(joinTarget('https://a.b/', '/x?y=1'), 'https://a.b/x?y=1')
  assertEquals(joinTarget('https://a.b', '/'), 'https://a.b/')
})

/* ───────────── headers and bodies ───────────── */

Deno.test('upstream headers carry the console agent and a JSON default only with a body', () => {
  assertEquals(upstreamHeaders({ headers: {} }), { 'user-agent': 'adhar-console-invoke' })
  assertEquals(upstreamHeaders({ headers: {}, body: '{}' })['content-type'], 'application/json')
  assertEquals(upstreamHeaders({ headers: { 'content-type': 'text/plain' }, body: 'x' })['content-type'], 'text/plain')
})

Deno.test('cookies the function sets never reach the browser', () => {
  const h = new Headers({ 'Content-Type': 'application/json', 'Set-Cookie': 'sid=1', 'X-Trace': 'abc' })
  assertEquals(responseHeaders(h), { 'content-type': 'application/json', 'x-trace': 'abc' })
})

Deno.test('textual bodies are shown, binary ones are reported by size', () => {
  assert(isTextual('application/json; charset=utf-8'))
  assert(isTextual('text/html'))
  assert(isTextual(null))
  assertEquals(isTextual('image/png'), false)
  assertEquals(isTextual('application/octet-stream'), false)
})

Deno.test('a response body is read up to the cap and then cut', async () => {
  const stream = new Response('x'.repeat(5000)).body
  const { bytes, truncated } = await readCapped(stream, 1024)
  assertEquals(bytes.length, 1024)
  assertEquals(truncated, true)
  const small = await readCapped(new Response('hello').body, 1024)
  assertEquals(new TextDecoder().decode(small.bytes), 'hello')
  assertEquals(small.truncated, false)
})

/* ───────────── the route ───────────── */

const USER = { ok: true as const, user: { id: 'u1', email: 'ana@example.com', name: 'Ana', roles: [], groups: [] }, activeTenant: 't' }
const ID = { token: 't', user: { id: 'u1', name: 'Ana', email: 'ana@example.com' } }

function deps(over: Partial<InvokeDeps> = {}): Partial<InvokeDeps> {
  return {
    requireUser: (() => Promise.resolve(USER)) as unknown as InvokeDeps['requireUser'],
    authorize: () => Promise.resolve({ allowed: true, id: ID }),
    getFunction: () =>
      Promise.resolve({
        status: 200,
        fn: { metadata: { name: 'orders', namespace: 'dev' }, status: { url: 'https://orders.dev.cloud.adhar.io' } },
      }),
    baseDomain: () => 'cloud.adhar.io',
    fetch: () => Promise.resolve(new Response('{"hello":"world"}', { status: 200, headers: { 'content-type': 'application/json' } })),
    ...over,
  }
}

const post = (body: unknown) =>
  new Request('http://console.test/api/functions/invoke', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

Deno.test('route: the function is called at its own URL and the answer comes back', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const res = await handleFunctionInvoke(
    post({ namespace: 'dev', name: 'orders', method: 'POST', path: '/hello', body: '{"a":1}', headers: { 'x-test': '1' } }),
    deps({
      fetch: (input, init) => {
        calls.push({ url: String(input), init })
        return Promise.resolve(new Response('{"hello":"world"}', { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': 'a=b' } }))
      },
    }),
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.status, 201)
  assertEquals(body.url, 'https://orders.dev.cloud.adhar.io/hello')
  assertEquals(body.body, '{"hello":"world"}')
  assertEquals(body.headers['set-cookie'], undefined)
  assertEquals(calls.length, 1)
  assertEquals(calls[0].init?.method, 'POST')
  assertEquals(calls[0].init?.redirect, 'manual')
  assertEquals((calls[0].init?.headers as Record<string, string>)['x-test'], '1')
  // The caller's cookies never travel upstream.
  assertEquals((calls[0].init?.headers as Record<string, string>).cookie, undefined)
})

Deno.test('route: no session is a 401 and nothing is called', async () => {
  let called = false
  const res = await handleFunctionInvoke(
    post({ namespace: 'dev', name: 'orders' }),
    deps({
      requireUser: (() => Promise.resolve({ ok: false, error: 'unauthenticated' })) as unknown as InvokeDeps['requireUser'],
      fetch: () => {
        called = true
        return Promise.resolve(new Response('x'))
      },
    }),
  )
  assertEquals(res.status, 401)
  assertEquals(called, false)
})

Deno.test('route: a caller who may not get the Function is refused with the missing RBAC rule', async () => {
  let read = false
  const res = await handleFunctionInvoke(
    post({ namespace: 'dev', name: 'orders' }),
    deps({
      authorize: () => Promise.resolve({ allowed: false, degraded: false, id: ID }),
      getFunction: () => {
        read = true
        return Promise.resolve({ status: 200 })
      },
    }),
  )
  assertEquals(res.status, 403)
  const body = await res.json()
  assert(String(body.detail).includes('get functions.platform.adhar.io'))
  assertEquals(read, false)
})

Deno.test('route: a missing function is a 404, a function with no URL a 409', async () => {
  const missing = await handleFunctionInvoke(post({ namespace: 'dev', name: 'orders' }), deps({ getFunction: () => Promise.resolve({ status: 404 }) }))
  assertEquals(missing.status, 404)
  const noUrl = await handleFunctionInvoke(
    post({ namespace: 'dev', name: 'orders' }),
    deps({ getFunction: () => Promise.resolve({ status: 200, fn: { metadata: { name: 'orders' } } }), baseDomain: () => undefined }),
  )
  assertEquals(noUrl.status, 409)
})

Deno.test('route: an unreachable public URL falls through to the in-cluster address', async () => {
  const urls: string[] = []
  const res = await handleFunctionInvoke(
    post({ namespace: 'dev', name: 'orders' }),
    deps({
      fetch: (input) => {
        urls.push(String(input))
        if (String(input).startsWith('https://')) return Promise.reject(new TypeError('dns error: no such host'))
        return Promise.resolve(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }))
      },
    }),
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(urls, ['https://orders.dev.cloud.adhar.io/', 'http://orders.dev.svc.cluster.local/'])
  assertEquals(body.url, 'http://orders.dev.svc.cluster.local/')
  assertEquals(body.attempts.length, 2)
})

Deno.test('route: a timeout is reported once, not retried at the next address', async () => {
  let n = 0
  const res = await handleFunctionInvoke(
    post({ namespace: 'dev', name: 'orders', timeoutMs: 1000 }),
    deps({
      fetch: () => {
        n++
        return Promise.reject(new DOMException('The signal has been aborted', 'TimeoutError'))
      },
    }),
  )
  assertEquals(res.status, 504)
  assertEquals(n, 1)
})

Deno.test('route: invalid input is a 400 before anything is checked or called', async () => {
  let authorized = false
  const res = await handleFunctionInvoke(
    post({ namespace: 'dev', name: 'orders', path: 'http://evil.example' }),
    deps({
      authorize: () => {
        authorized = true
        return Promise.resolve({ allowed: true, id: ID })
      },
    }),
  )
  assertEquals(res.status, 400)
  assertEquals(authorized, false)
  const wrongVerb = await handleFunctionInvoke(new Request('http://console.test/api/functions/invoke'), deps())
  assertEquals(wrongVerb.status, 405)
})
