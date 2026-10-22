import { assertEquals, assertInstanceOf, assertRejects } from 'jsr:@std/assert@1'
import { HttpClient, HttpError, NetworkError, TimeoutError } from './http.ts'

/** A response whose headers arrive at once but whose body never finishes. */
function stallingBody(signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'))
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
    },
  })
  return new Response(body, { headers: { 'content-type': 'application/json' } })
}

Deno.test('timeout covers a body that stalls after the headers', async () => {
  const http = new HttpClient({
    baseUrl: 'http://example.test',
    timeoutMs: 30,
    fetchImpl: (_url, init) => Promise.resolve(stallingBody(init?.signal)),
  })
  await assertRejects(() => http.get('/slow'), TimeoutError)
})

Deno.test('raw responses are not cut off by the timeout once headers arrive', async () => {
  const http = new HttpClient({
    baseUrl: 'http://example.test',
    timeoutMs: 20,
    fetchImpl: (_url, init) => {
      const res = new Response('streamed', { headers: { 'content-type': 'text/plain' } })
      // Record whether the request signal was aborted while the caller read.
      init?.signal?.addEventListener('abort', () => aborted.push(true))
      return Promise.resolve(res)
    },
  })
  const aborted: boolean[] = []
  const res = await http.get<Response>('/logs', { response: 'raw' })
  await new Promise((r) => setTimeout(r, 50))
  assertEquals(await res.text(), 'streamed')
  assertEquals(aborted.length, 0)
})

Deno.test('fetch rejection becomes NetworkError; caller abort propagates as-is', async () => {
  const failing = new HttpClient({
    baseUrl: 'http://example.test',
    fetchImpl: () => Promise.reject(new TypeError('connection refused')),
  })
  const err = await assertRejects(() => failing.get('/x'), NetworkError)
  assertInstanceOf(err.cause, TypeError)

  const ctrl = new AbortController()
  const hanging = new HttpClient({
    baseUrl: 'http://example.test',
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')))
      }),
  })
  const p = hanging.get('/x', { signal: ctrl.signal })
  ctrl.abort()
  const abortErr = await assertRejects(() => p)
  assertEquals((abortErr as Error).name, 'AbortError')
})

Deno.test('non-2xx JSON bodies surface as HttpError with the parsed body', async () => {
  const http = new HttpClient({
    baseUrl: 'http://example.test',
    fetchImpl: () =>
      Promise.resolve(
        new Response(JSON.stringify({ userMessage: 'No Gitea account yet' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  })
  const err = await assertRejects(() => http.get('/x'), HttpError)
  assertEquals(err.status, 403)
  assertEquals(err.message, 'No Gitea account yet')
})
