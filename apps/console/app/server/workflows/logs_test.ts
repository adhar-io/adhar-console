import { assert, assertEquals } from 'jsr:@std/assert@1'
import { LOKI_MARGIN_MS, lokiSelector, lokiWindow, parseLogQuery } from './logs.ts'

/** Route-level behaviour (live → Loki, labelling, refusals) is in handler_test.ts. */

Deno.test('the log query is validated and bounded', () => {
  const q = parseLogQuery(new URLSearchParams({ node: 'wf-1', tail: '99999', follow: '1' }))
  assert(q.ok)
  assertEquals(q.value, { nodeId: 'wf-1', container: 'main', tail: 5000, follow: true })
  assert(!parseLogQuery(new URLSearchParams({})).ok)
  assert(!parseLogQuery(new URLSearchParams({ node: 'wf-1', container: 'istio-proxy' })).ok)
  assert(!parseLogQuery(new URLSearchParams({ node: 'wf-1', tail: '-1' })).ok)
  assert(!parseLogQuery(new URLSearchParams({ node: 'wf-1', uid: 'x' })).ok)
})

Deno.test('the Loki selector names the namespace, pod and container, quoted', () => {
  assertEquals(lokiSelector('shop', 'wf-main-1', 'main'), '{namespace="shop", pod="wf-main-1", container="main"}')
  assertEquals(lokiSelector('a"b', 'p', 'c'), '{namespace="a\\"b", pod="p", container="c"}')
})

Deno.test('the Loki window is the node\'s, widened, and never in the future', () => {
  const now = Date.parse('2026-11-25T10:00:00Z')
  const w = lokiWindow({ startedAt: '2026-11-25T09:00:00Z', finishedAt: '2026-11-25T09:10:00Z' }, now)
  assertEquals(w, { startMs: Date.parse('2026-11-25T09:00:00Z') - LOKI_MARGIN_MS, endMs: Date.parse('2026-11-25T09:10:00Z') + LOKI_MARGIN_MS })
  const running = lokiWindow({ startedAt: '2026-11-25T09:59:30Z' }, now)
  assertEquals(running.endMs, now)
})
