import { assert, assertEquals } from 'jsr:@std/assert@1'
import * as ui from '../../../../../modules/platform/src/workflows/data/api.ts'
import { submitterSlug as uiSlug } from '../../../../../modules/platform/src/workflows/data/nodes.ts'
import { isMine } from '../../../../../modules/platform/src/workflows/views/runs.tsx'
import { matchRoute, parseApprove, parseArchiveFilters, parseResubmit, parseRetry, type Route, submitterSlug } from './model.ts'

/**
 * The browser's data layer (modules/platform/src/workflows/data/api.ts) and
 * this BFF are two halves of one contract (design 0026 §6.3/§6.4) shipped from
 * one repository but written as separate modules. Every request the UI sends
 * must name a route the BFF serves, with a body and query its parsers accept —
 * a drift here is a button that always answers 404/400. And every route the
 * BFF serves is either called by the UI or named here with the phase that
 * calls it.
 */

type Sent = { method: string; path: string; query: URLSearchParams; body: unknown }

async function capture(fn: () => Promise<unknown> | unknown): Promise<Sent> {
  const sent: Sent[] = []
  const real = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://console.local')
    sent.push({ method: (init?.method ?? 'GET').toUpperCase(), path: u.pathname, query: u.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Promise.resolve(Response.json({ ok: true, items: [], lines: [] }))
  }) as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = real
  }
  assertEquals(sent.length, 1, 'one BFF call')
  return sent[0]
}

const UID = '0b9b5c5e-2f9f-4c1e-9d1a-3c1f2a1b0c9d'

const CALLS: Array<[string, () => Promise<unknown>, Route['op'], ((b: unknown) => { ok: boolean })?]> = [
  ['capabilities', () => ui.getCapabilities(), 'capabilities'],
  ['hydrated run', () => ui.getHydratedRun('shop-dev', 'nightly-abc'), 'run.get'],
  ['retry', () => ui.retryRun('shop-dev', 'nightly-abc', { restartSuccessful: true, nodeId: 'nightly-abc-123', parameters: ['env=test'] }), 'run.retry', parseRetry],
  ['memoized resubmit', () => ui.resubmitMemoized('shop-dev', 'nightly-abc', { parameters: ['env=test'] }), 'run.resubmit', parseResubmit],
  ['approve', () => ui.decideApproval('shop-dev', 'nightly-abc', { nodeId: 'nightly-abc-42', decision: 'approve', comment: 'LGTM' }), 'run.approve', parseApprove],
  ['reject', () => ui.decideApproval('shop-dev', 'nightly-abc', { nodeId: 'nightly-abc-42', decision: 'reject' }), 'run.approve', parseApprove],
  ['logs', () => ui.getRunLogs('shop-dev', 'nightly-abc', { node: 'nightly-abc-123', container: 'wait', tail: 200 }), 'run.logs'],
  ['archive list', () => ui.listArchive('shop-dev', { phase: 'Failed', template: 'nightly', submitter: 'oidc-ana-x.io', namePrefix: 'nightly', since: '2026-11-18T10:00:00Z', limit: 50 }), 'archive.list'],
  ['archive get', () => ui.getArchived('shop-dev', UID), 'archive.get'],
  ['archive retry', () => ui.retryArchived('shop-dev', UID, { restartSuccessful: false }), 'archive.retry', parseRetry],
  ['archive resubmit', () => ui.resubmitArchived('shop-dev', UID, { memoized: true }), 'archive.resubmit', parseResubmit],
  ['archive delete', () => ui.deleteArchived('shop-dev', UID), 'archive.delete'],
  ['engine', () => ui.getEngine(), 'engine.get'],
  ['suspend all', () => ui.suspendAllSchedules({ reason: 'incident 42' }), 'engine.suspend-all'],
]

/** BFF routes the W1 UI does not call yet, and who will. */
const NOT_CALLED_IN_W1: Partial<Record<Route['op'], string>> = {
  lint: 'the W2 designer (§6.7) validates through it',
}

for (const [what, fn, op, parse] of CALLS) {
  Deno.test(`the UI's ${what} request is a route the BFF serves (${op})`, async () => {
    const s = await capture(fn)
    assert(s.path.startsWith('/api/workflows/'), s.path)
    const m = matchRoute(s.method, s.path.slice('/api/workflows'.length))
    assert('route' in m, `${s.method} ${s.path}: ${'error' in m ? m.error : ''}`)
    assertEquals(m.route.op, op)
    if (parse) {
      const p = parse(s.body)
      assert(p.ok, `${what}: the BFF refuses the UI's body ${JSON.stringify(s.body)}: ${JSON.stringify(p)}`)
    }
    if (op === 'archive.list') {
      const f = parseArchiveFilters(s.query)
      assert(f.ok, `the BFF refuses the UI's archive query ${s.query}: ${JSON.stringify(f)}`)
      for (const k of s.query.keys()) assert(!/fieldselector|namespace/i.test(k), `the UI sent ${k}`)
    }
  })
}

Deno.test('the artifact link the UI renders is the BFF artifact route', () => {
  const url = new URL(ui.artifactUrl('adhar-system', 'nightly-abc', 'nightly-abc-123', 'report.html'), 'http://console.local')
  const m = matchRoute('GET', url.pathname.slice('/api/workflows'.length))
  assert('route' in m && m.route.op === 'run.artifact', JSON.stringify(m))
})

Deno.test('every BFF route is called by the UI, or names the phase that will call it', async () => {
  const called = new Set<string>(['run.artifact'])
  for (const [, fn] of CALLS) {
    const s = await capture(fn)
    const m = matchRoute(s.method, s.path.slice('/api/workflows'.length))
    if ('route' in m) called.add(m.route.op)
  }
  // The Route union, read from the module so a new route cannot hide.
  const src = await Deno.readTextFile(new URL('./model.ts', import.meta.url))
  const union = src.match(/export type Route =([\s\S]*?)\n\n/)?.[1] ?? ''
  const ops = [...union.matchAll(/op: '([a-z.-]+)'/g)].map((m) => m[1])
  assert(ops.length >= 10, 'parsed the Route union')
  for (const op of ops) {
    assert(called.has(op) || op in NOT_CALLED_IN_W1, `the BFF serves ${op} and the UI never calls it`)
  }
})

Deno.test('the UI, the BFF and Kyverno compute one adhar.io/submitter label', () => {
  for (const u of ['oidc:ana@x.io', 'oidc:Ana.B_C@Example.COM', 'system:serviceaccount:adhar-system:argo', `oidc:${'x'.repeat(80)}`, '--oidc:..weird__--']) {
    assertEquals(uiSlug(u), submitterSlug(u), u)
  }
  // "Mine" finds a run by the label Kyverno wrote for the API server's name.
  const run = { metadata: { name: 'r', namespace: 'shop-dev', labels: { 'adhar.io/submitter': submitterSlug('oidc:ana.b@x.io') } } }
  assert(isMine(run as never, { email: 'ana.b@x.io' }))
  assert(!isMine(run as never, { email: 'bob@x.io' }))
})
