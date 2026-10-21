import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import {
  bodyNamesSudo,
  invalidateGiteaIdentity,
  isGiteaApiPath,
  isGiteaWrite,
  mapSudoFailure,
  normalizeGiteaUsername,
  resolveGiteaUsername,
  stripClientSudo,
} from './gitea-sudo.ts'
import { guardGitea } from './proxy.ts'
import type { ToolDef } from './tool-registry.ts'

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer

Deno.test('writes are every non-safe method', () => {
  for (const m of ['POST', 'put', 'PATCH', 'DELETE']) assert(isGiteaWrite(m), m)
  for (const m of ['GET', 'head', 'OPTIONS']) assertFalse(isGiteaWrite(m), m)
})

Deno.test('writes only reach the REST API router', () => {
  assert(isGiteaApiPath('/api/v1/repos/adhar/x/pulls'))
  assertFalse(isGiteaApiPath('/adhar/x.git/git-receive-pack'))
  assertFalse(isGiteaApiPath('/api/packages/adhar/npm/x'))
  assertFalse(isGiteaApiPath('/api/v1/../user/settings'))
  assertFalse(isGiteaApiPath('/api/v10/x'))
  assertFalse(isGiteaApiPath('/api/v1/%2e%2e/user/settings'))
})

Deno.test('normalizeGiteaUsername mirrors Gitea NormalizeUserName', () => {
  assertEquals(normalizeGiteaUsername('jane.doe@acme.io'), 'jane.doe')
  assertEquals(normalizeGiteaUsername("O'Brien Zoë"), 'OBrien-Zoe')
  assertEquals(normalizeGiteaUsername('a+b~c@x'), 'a-b-c')
  assertEquals(normalizeGiteaUsername('Æsa@x'), 'AEsa')
})

Deno.test('client Sudo header and sudo query are stripped', () => {
  const h = new Headers({ SUDO: 'root', accept: 'application/json' })
  assertEquals(stripClientSudo('?limit=5&sudo=root&page=2', h), '?limit=5&page=2')
  assertFalse(h.has('sudo'))
  assertEquals(h.get('accept'), 'application/json')
  // Percent-encoded key — Go decodes it to `sudo` too.
  assertEquals(stripClientSudo('?%73udo=root', new Headers()), '')
  // Untouched when absent (no re-serialisation).
  assertEquals(stripClientSudo('?q=a%20b&x=1', new Headers()), '?q=a%20b&x=1')
  assertEquals(stripClientSudo('', new Headers()), '')
})

Deno.test('a form body naming sudo is detected', async () => {
  assert(await bodyNamesSudo('application/x-www-form-urlencoded', enc('title=x&sudo=root')))
  assertFalse(await bodyNamesSudo('application/x-www-form-urlencoded', enc('title=sudo')))
  assertFalse(await bodyNamesSudo('application/json', enc('{"sudo":"root"}')))
  const fd = new FormData()
  fd.set('sudo', 'root')
  const req = new Request('http://x', { method: 'POST', body: fd })
  assert(await bodyNamesSudo(req.headers.get('content-type'), await req.arrayBuffer()))
  const ok = new FormData()
  ok.set('attachment', new Blob(['hi']), 'sudo.txt')
  const req2 = new Request('http://x', { method: 'POST', body: ok })
  assertFalse(await bodyNamesSudo(req2.headers.get('content-type'), await req2.arrayBuffer()))
})

function giteaStub(routes: Record<string, () => Response>) {
  const calls: string[] = []
  return {
    calls,
    get: (p: string) => {
      calls.push(p)
      const hit = Object.entries(routes).find(([k]) => p.startsWith(k))
      return Promise.resolve(hit ? hit[1]() : new Response('{}', { status: 404 }))
    },
  }
}

Deno.test('username resolves by email via the admin email search, and is cached', async () => {
  invalidateGiteaIdentity()
  const g = giteaStub({
    '/api/v1/admin/emails/search': () =>
      Response.json([{ email: 'jane@acme.io.other', username: 'nope' }, { email: 'Jane@Acme.io', username: 'jane' }]),
  })
  assertEquals(await resolveGiteaUsername({ email: 'jane@acme.io', username: 'jane@acme.io' }, g.get), { ok: true, username: 'jane' })
  await resolveGiteaUsername({ email: 'JANE@acme.io' }, g.get)
  assertEquals(g.calls.length, 1)
})

Deno.test('no matching email means no account (negative-cached briefly)', async () => {
  invalidateGiteaIdentity()
  let t = 0
  const g = giteaStub({ '/api/v1/admin/emails/search': () => Response.json([]) })
  assertEquals(await resolveGiteaUsername({ email: 'new@acme.io' }, g.get, () => t), { ok: false, reason: 'no_account' })
  await resolveGiteaUsername({ email: 'new@acme.io' }, g.get, () => t)
  assertEquals(g.calls.length, 1)
  t = 60_000
  await resolveGiteaUsername({ email: 'new@acme.io' }, g.get, () => t)
  assertEquals(g.calls.length, 2)
})

Deno.test('fallback by normalised username only accepts the same email', async () => {
  invalidateGiteaIdentity()
  const same = giteaStub({
    '/api/v1/admin/emails/search': () => new Response('forbidden', { status: 403 }),
    '/api/v1/users/jane': () => Response.json({ login: 'jane', email: 'jane@acme.io' }),
  })
  assertEquals(await resolveGiteaUsername({ email: 'jane@acme.io', username: 'jane@acme.io' }, same.get), { ok: true, username: 'jane' })
  invalidateGiteaIdentity()
  const other = giteaStub({
    '/api/v1/admin/emails/search': () => new Response('forbidden', { status: 403 }),
    '/api/v1/users/jane': () => Response.json({ login: 'jane', email: 'jane@other.org' }),
  })
  assertEquals(await resolveGiteaUsername({ email: 'jane@acme.io', username: 'jane@acme.io' }, other.get), { ok: false, reason: 'no_account' })
})

Deno.test('no email in the session is not guessed', async () => {
  const g = giteaStub({})
  assertEquals(await resolveGiteaUsername({ username: 'jane' }, g.get), { ok: false, reason: 'no_identity' })
  assertEquals(g.calls.length, 0)
})

Deno.test('error mapping: non-admin credentials, missing account, permission, passthrough', async () => {
  const ctx = (exists: boolean) => ({ giteaUser: 'jane', publicGiteaUrl: 'https://gitea.example.io', stillExists: () => Promise.resolve(exists) })
  const notAdmin = await mapSudoFailure(403, JSON.stringify({ message: 'Only administrators allowed to sudo.' }), ctx(true))
  assertEquals(notAdmin?.status, 503)
  assertEquals((await notAdmin!.json()).error, 'gitea_sudo_unavailable')

  const missing = await mapSudoFailure(404, '{"message":"The target couldn\'t be found."}', ctx(false))
  assertEquals(missing?.status, 403)
  const body = await missing!.json()
  assertEquals(body.error, 'gitea_account_missing')
  assert(String(body.userMessage).includes('https://gitea.example.io'))
  assertEquals(body.message, body.userMessage)

  assertEquals(await mapSudoFailure(404, '{"message":"not found"}', ctx(true)), null)

  const denied = await mapSudoFailure(403, JSON.stringify({ message: 'user should have a permission to write to a repo' }), ctx(true))
  assertEquals(denied?.status, 403)
  const d = await denied!.json()
  assertEquals(d.error, 'gitea_forbidden')
  assert(String(d.userMessage).includes('jane'))

  assertEquals(await mapSudoFailure(422, '{}', ctx(true)), null)
})

/* ── guardGitea: the proxy's request gate ── */

const def: ToolDef = { baseUrl: 'http://gitea.test', authMode: 'basic', username: 'gitea_admin', password: 'pw' }
const user = (email = 'jane@acme.io') => ({
  user: { id: 'u1', email, name: 'Jane', username: email, roles: ['developer'], groups: [], tenants: ['adhar'] },
  activeTenant: 'adhar',
}) as Awaited<ReturnType<NonNullable<Parameters<typeof guardGitea>[6]>['getUser']>>

function withFetch(handler: (url: string) => Response, fn: () => Promise<void>) {
  return async () => {
    const real = globalThis.fetch
    globalThis.fetch = ((input: string | URL | Request) => Promise.resolve(handler(String(input instanceof Request ? input.url : input)))) as typeof fetch
    try {
      await fn()
    } finally {
      globalThis.fetch = real
    }
  }
}

const authed = (email?: string) => ({ authConfigured: () => true, getUser: () => Promise.resolve(user(email)) })

Deno.test('guard: a write gets the session user as sudo and client sudo is dropped', withFetch(
  (url) => url.includes('/admin/emails/search') ? Response.json([{ email: 'jane@acme.io', username: 'jane' }]) : new Response('', { status: 500 }),
  async () => {
    invalidateGiteaIdentity()
    const req = new Request('http://console/api/svc/gitea/api/v1/repos/adhar/x/branches?sudo=root', {
      method: 'POST',
      headers: { sudo: 'root', 'content-type': 'application/json' },
    })
    const headers = new Headers(req.headers)
    const out = await guardGitea(def, req, 'POST', '/api/v1/repos/adhar/x/branches', enc('{}'), headers, authed())
    assert(!(out instanceof Response))
    assertEquals(out.search, '')
    assertEquals(out.write?.sudo, 'jane')
    assertFalse(headers.has('sudo'))
  },
))

Deno.test('guard: a read stays on the admin identity but still loses client sudo', async () => {
  const req = new Request('http://console/api/svc/gitea/api/v1/orgs/adhar/repos?sudo=root&limit=50', { headers: { Sudo: 'root' } })
  const headers = new Headers(req.headers)
  const out = await guardGitea(def, req, 'GET', '/api/v1/orgs/adhar/repos', undefined, headers, authed())
  assert(!(out instanceof Response))
  assertEquals(out.search, '?limit=50')
  assertEquals(out.write, undefined)
  assertFalse(headers.has('sudo'))
})

Deno.test('guard: no session is refused, reads included', async () => {
  const req = new Request('http://console/api/svc/gitea/api/v1/orgs/adhar/repos')
  const out = await guardGitea(def, req, 'GET', '/api/v1/orgs/adhar/repos', undefined, new Headers(), {
    authConfigured: () => true,
    getUser: () => Promise.resolve(null),
  })
  assert(out instanceof Response)
  assertEquals(out.status, 401)
})

Deno.test('guard: a user with no Gitea account gets the clear error', withFetch(
  (url) => url.includes('/admin/emails/search') ? Response.json([]) : new Response('', { status: 500 }),
  async () => {
    invalidateGiteaIdentity()
    const req = new Request('http://console/api/svc/gitea/api/v1/repos/adhar/x/issues', { method: 'POST' })
    const out = await guardGitea(def, req, 'POST', '/api/v1/repos/adhar/x/issues', enc('{}'), new Headers(), authed('new@acme.io'))
    assert(out instanceof Response)
    assertEquals(out.status, 403)
    assertEquals((await out.json()).error, 'gitea_account_missing')
  },
))

Deno.test('guard: non-API writes and form-body sudo are refused', async () => {
  const push = new Request('http://console/api/svc/gitea/adhar/x.git/git-receive-pack', { method: 'POST' })
  const a = await guardGitea(def, push, 'POST', '/adhar/x.git/git-receive-pack', enc('x'), new Headers(), authed())
  assert(a instanceof Response)
  assertEquals(a.status, 403)

  const form = new Request('http://console/api/svc/gitea/api/v1/repos/adhar/x/issues', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  const b = await guardGitea(def, form, 'POST', '/api/v1/repos/adhar/x/issues', enc('title=t&sudo=root'), new Headers(), authed())
  assert(b instanceof Response)
  assertEquals(b.status, 400)
})
