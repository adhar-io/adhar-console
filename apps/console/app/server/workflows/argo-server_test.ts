import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import type { K8sIdentity } from '../k8s/gateway.ts'
import { ArgoClient, argoPath, ArgoUnavailable } from './argo-server.ts'

const ana: K8sIdentity = { token: 'kc-ana', user: { id: 'u-ana', name: 'Ana', email: 'ana@x.io', username: 'ana' } }
const bob: K8sIdentity = { token: 'kc-bob', user: { id: 'u-bob', name: 'Bob', email: 'bob@x.io', username: 'bob' } }

interface Seen {
  url: string
  auth: string | null
  method: string
  body?: string
}

function client(opts: { effective?: 'user' | 'impersonate' | 'service'; mint?: () => Promise<{ token: string; expiresAt: number } | null>; answer?: (s: Seen) => Response; base?: string }) {
  const seen: Seen[] = []
  let mints = 0
  let now = 1_000_000
  const c = new ArgoClient({
    baseUrl: () => opts.base ?? 'http://argo-server:2746',
    authState: () => ({ effective: opts.effective ?? 'user' }),
    mintToken: async () => {
      mints++
      return opts.mint ? await opts.mint() : { token: `sa-${mints}`, expiresAt: now + 600_000 }
    },
    fetch: ((url: string, init: RequestInit) => {
      const s: Seen = { url, auth: new Headers(init.headers).get('authorization'), method: init.method ?? 'GET', body: init.body as string | undefined }
      seen.push(s)
      return Promise.resolve(opts.answer ? opts.answer(s) : Response.json({ ok: true }))
    }) as typeof fetch,
    now: () => now,
  })
  return { c, seen, mints: () => mints, advance: (ms: number) => (now += ms) }
}

Deno.test('user mode: argo-server sees each caller\'s own token, never another\'s', async () => {
  const { c, seen, mints } = client({ effective: 'user' })
  await c.fetch(ana, argoPath.version())
  await c.fetch(bob, argoPath.version())
  assertEquals(seen.map((s) => s.auth), ['Bearer kc-ana', 'Bearer kc-bob'])
  assertEquals(mints(), 0)
})

Deno.test('impersonation mode: a TokenRequest for the console argo SA, reused under 8 minutes, then re-minted', async () => {
  const { c, seen, mints, advance } = client({ effective: 'impersonate' })
  const r1 = await c.fetch(ana, argoPath.version())
  const r2 = await c.fetch(bob, argoPath.version())
  assertEquals(r1.mode, 'service')
  assertEquals(r2.mode, 'service')
  assertEquals(mints(), 1)
  advance(8 * 60_000 + 1)
  await c.fetch(ana, argoPath.version())
  assertEquals(mints(), 2)
  assertEquals(seen.map((s) => s.auth), ['Bearer sa-1', 'Bearer sa-1', 'Bearer sa-2'])
})

Deno.test('no token for the SA is a 503-class failure, never an anonymous call', async () => {
  const { c, seen } = client({ effective: 'impersonate', mint: () => Promise.resolve(null) })
  const e = await assertRejects(() => c.fetch(ana, argoPath.version()), ArgoUnavailable)
  assertEquals(e.code, 'no_identity')
  assertEquals(seen.length, 0)
})

Deno.test('a user token argo-server refuses (401) is retried once as the service identity', async () => {
  const { c, seen } = client({ effective: 'user', answer: (s) => (s.auth === 'Bearer kc-ana' ? new Response('', { status: 401 }) : Response.json({ ok: true })) })
  const r = await c.fetch(ana, argoPath.version())
  assertEquals(r.mode, 'service')
  assertEquals(r.res.status, 200)
  assertEquals(seen.map((s) => s.auth), ['Bearer kc-ana', 'Bearer sa-1'])
})

Deno.test('not configured is reported as such', async () => {
  const { c } = client({ base: '' })
  const e = await assertRejects(() => c.fetch(ana, argoPath.version()), ArgoUnavailable)
  assertEquals(e.code, 'not_configured')
  assert(!c.configured)
})

Deno.test('the URL is the pinned path plus the BFF-built query, and the body is JSON', async () => {
  const { c, seen } = client({})
  await c.fetch(ana, argoPath.workflowAction('team-a', 'wf-1', 'retry'), { method: 'PUT', body: { name: 'wf-1', namespace: 'team-a' } })
  await c.fetch(ana, argoPath.archived(), { query: new URLSearchParams({ namespace: 'team-a' }) })
  assertEquals(seen[0].url, 'http://argo-server:2746/api/v1/workflows/team-a/wf-1/retry')
  assertEquals(seen[0].method, 'PUT')
  assertEquals(JSON.parse(seen[0].body ?? ''), { name: 'wf-1', namespace: 'team-a' })
  assertEquals(seen[1].url, 'http://argo-server:2746/api/v1/archived-workflows?namespace=team-a')
})

Deno.test('path builders encode every segment', () => {
  assertEquals(argoPath.artifact('ns', 'wf', 'wf-1', 'a b.txt'), '/artifact-files/ns/workflows/wf/wf-1/outputs/a%20b.txt')
  assertEquals(argoPath.archivedOne('x/../y'), '/api/v1/archived-workflows/x%2F..%2Fy')
})

Deno.test('a streamed download is bounded until argo-server answers, not for its whole body; a JSON call is bounded end to end', async () => {
  // A fetch whose body arrives slowly and dies when the call's signal aborts —
  // what a real fetch does with a deadline on a long download.
  const slowBody = ((_url: string, init: RequestInit) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          ctl.error(init.signal?.reason ?? new Error('aborted'))
        })
        timer = setTimeout(() => {
          ctl.enqueue(new TextEncoder().encode('artifact bytes'))
          ctl.close()
        }, 120)
      },
    })
    return Promise.resolve(new Response(body))
  }) as typeof fetch
  const mk = () => new ArgoClient({ baseUrl: () => 'http://argo-server:2746', authState: () => ({ effective: 'user' }), mintToken: () => Promise.resolve(null), fetch: slowBody, timeoutMs: 30 })
  const streamed = await mk().fetch(ana, argoPath.artifact('adhar-system', 'wf', 'wf-1', 'out'), { stream: true })
  assertEquals(await streamed.res.text(), 'artifact bytes')
  const bounded = await mk().fetch(ana, argoPath.version())
  await assertRejects(() => bounded.res.text())
})
