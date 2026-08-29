#!/usr/bin/env -S deno run -A
/**
 * End-to-end test of the console's Keycloak OIDC login round-trip against a
 * MOCK OIDC provider, exercising the REAL handlers:
 *   handleLogin → (authorize) → handleCallback → handleSession
 *
 * Proves whether the server-side flow + session cookie actually authenticate a
 * user, and measures the session-cookie size (inline vs server-side store).
 */
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

const PORT = 7788
const ISSUER_BASE = `http://localhost:${PORT}`
const REALM = 'adhar'
const CLIENT_ID = 'adhar-console'
const CLIENT_SECRET = 'test-client-secret'

// ── env BEFORE importing the auth handlers ──
Deno.env.set('KEYCLOAK_URL', ISSUER_BASE)
Deno.env.set('KEYCLOAK_REALM', REALM)
Deno.env.set('KEYCLOAK_CLIENT_ID', CLIENT_ID)
Deno.env.set('AUTH_CLIENT_SECRET', CLIENT_SECRET)
Deno.env.set('AUTH_COOKIE_SECRET', 'test-cookie-secret-at-least-32-chars-long-xxxxx')
Deno.env.set('AUTH_PUBLIC_URL', 'http://localhost:5100')
Deno.env.set('AUTH_COOKIE_SECURE', 'false')
Deno.env.set('AUTH_SCOPES', 'openid profile email offline_access')
// no KEYCLOAK_INTERNAL_URL → discovery straight from the issuer

const { publicKey, privateKey } = await generateKeyPair('RS256')
const jwk = await exportJWK(publicKey)
jwk.kid = 'test-key'
jwk.alg = 'RS256'
jwk.use = 'sig'

// code → nonce so the /token id_token carries the right nonce
const codeNonce = new Map<string, string>()

function bigToken(sub: string, extraBytes: number): string {
  // A realistic-ish opaque token, padded to simulate Keycloak's large JWTs.
  return `${sub}.${'x'.repeat(extraBytes)}`
}

async function mockIssuerHandler(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname
  if (p === `/realms/${REALM}/.well-known/openid-configuration`) {
    return Response.json({
      issuer: `${ISSUER_BASE}/realms/${REALM}`,
      authorization_endpoint: `${ISSUER_BASE}/realms/${REALM}/protocol/openid-connect/auth`,
      token_endpoint: `${ISSUER_BASE}/realms/${REALM}/protocol/openid-connect/token`,
      jwks_uri: `${ISSUER_BASE}/realms/${REALM}/protocol/openid-connect/certs`,
      userinfo_endpoint: `${ISSUER_BASE}/realms/${REALM}/protocol/openid-connect/userinfo`,
      end_session_endpoint: `${ISSUER_BASE}/realms/${REALM}/protocol/openid-connect/logout`,
    })
  }
  if (p === `/realms/${REALM}/protocol/openid-connect/certs`) {
    return Response.json({ keys: [jwk] })
  }
  if (p === `/realms/${REALM}/protocol/openid-connect/token`) {
    const body = new URLSearchParams(await req.text())
    const code = body.get('code') ?? ''
    const nonce = codeNonce.get(code) ?? ''
    const now = Math.floor(Date.now() / 1000)
    const idToken = await new SignJWT({
      nonce,
      email: 'jane@acme.io',
      name: 'Jane Doe',
      preferred_username: 'jane',
      groups: ['/platform-admin'],
      tenants: ['acme'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(`${ISSUER_BASE}/realms/${REALM}`)
      .setSubject('user-jane-123')
      .setAudience(CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey)
    // Simulate Keycloak-sized access + refresh tokens (each ~1.6 KB).
    return Response.json({
      access_token: bigToken('at', 1600),
      refresh_token: bigToken('rt', 1600),
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 300,
      refresh_expires_in: 1800,
      scope: 'openid profile email offline_access',
    })
  }
  return new Response('not found', { status: 404 })
}

const server = Deno.serve({ port: PORT, onListen() {} }, mockIssuerHandler)

// ── import the REAL handlers after env is set ──
const { handleLogin, handleCallback, handleSession, setSessionStore } = await import(
  '../packages/auth/src/handlers.ts'
).then(async (h) => ({ ...h, ...(await import('../packages/auth/src/session-store.ts')) }))

function getSetCookies(res: Response): string[] {
  // Deno Headers supports getSetCookie()
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] }
  if (typeof anyHeaders.getSetCookie === 'function') return anyHeaders.getSetCookie()
  const one = res.headers.get('set-cookie')
  return one ? [one] : []
}
function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0]
}
function cookieValue(setCookie: string): string {
  return cookiePair(setCookie).split('=').slice(1).join('=')
}

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function runFlow(mode: 'inline' | 'server-store'): Promise<void> {
  console.log(`\n──────── ${mode} ────────`)
  const memStore = new Map<string, unknown>()
  setSessionStore(
    mode === 'server-store'
      ? {
          put: (id: string, s: unknown) => {
            memStore.set(id, s)
            return Promise.resolve()
          },
          get: (id: string) => Promise.resolve((memStore.get(id) as never) ?? null),
          del: (id: string) => {
            memStore.delete(id)
            return Promise.resolve()
          },
        }
      : null,
  )

  // 1) login → authorize URL + txn cookie
  const loginRes = await handleLogin(
    new Request('http://localhost:5100/api/auth/login?returnTo=/platform'),
  )
  const authorizeUrl = loginRes.headers.get('location') ?? ''
  const txnCookie = getSetCookies(loginRes).find((c) => c.startsWith('adhar_oidc_txn='))
  check('login → 302 to authorize', loginRes.status === 302 && authorizeUrl.includes('/protocol/openid-connect/auth'), authorizeUrl.slice(0, 80))
  check('login sets txn cookie', Boolean(txnCookie))
  const au = new URL(authorizeUrl)
  const state = au.searchParams.get('state') ?? ''
  const nonce = au.searchParams.get('nonce') ?? ''
  const redirectUri = au.searchParams.get('redirect_uri') ?? ''
  check('authorize has redirect_uri to callback', redirectUri === 'http://localhost:5100/api/auth/callback', redirectUri)

  // 2) simulate Keycloak issuing a code bound to the nonce
  const code = 'test-auth-code-123'
  codeNonce.set(code, nonce)

  // 3) callback with code + state + txn cookie
  const cbReq = new Request(
    `http://localhost:5100/api/auth/callback?code=${code}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: cookiePair(txnCookie ?? '') } },
  )
  const cbRes = await handleCallback(cbReq)
  const cbLocation = cbRes.headers.get('location') ?? ''
  const sessionSetCookie = getSetCookies(cbRes).find(
    (c) => c.startsWith('adhar_session=') || c.startsWith('__Host-adhar_session='),
  )
  check('callback → 302 (not back to /login)', cbRes.status === 302 && !cbLocation.includes('/login'), `location=${cbLocation}`)
  check('callback sets session cookie', Boolean(sessionSetCookie))
  const sessCookieVal = sessionSetCookie ? cookieValue(sessionSetCookie) : ''
  const sessCookieBytes = new TextEncoder().encode(sessCookieVal).length
  check(`session cookie < 4096 bytes (browser limit)`, sessCookieBytes < 4096, `${sessCookieBytes} bytes`)

  // 4) session endpoint with the session cookie → authenticated?
  const sessReq = new Request('http://localhost:5100/api/auth/session', {
    headers: { cookie: sessionSetCookie ? cookiePair(sessionSetCookie) : '' },
  })
  const sessRes = await handleSession(sessReq)
  const sessBody = (await sessRes.json()) as { authenticated?: boolean; session?: { user?: { email?: string } } }
  check('session endpoint → authenticated', sessBody.authenticated === true, JSON.stringify(sessBody).slice(0, 120))
  check('session carries the user', sessBody.session?.user?.email === 'jane@acme.io', sessBody.session?.user?.email ?? 'none')
}

try {
  await runFlow('inline')
  await runFlow('server-store')
} finally {
  await server.shutdown()
}

console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} CHECK(S) FAILED`}`)
Deno.exit(failures === 0 ? 0 : 1)
