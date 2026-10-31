import { assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { parseCookies, sign, unsign } from './cookies.ts'
import { getServerAuthConfig, type ServerAuthConfig } from './config.ts'
import { sessionFromTokens } from './server.ts'
import { claimsToUser } from './claims.ts'

Deno.test('parseCookies keeps going past a malformed percent-encoded value', () => {
  // `%E0%A4%A` is a truncated UTF-8 sequence — decodeURIComponent throws on it.
  const jar = parseCookies('other_app=%E0%A4%A; adhar_session=abc%20def; flag')
  assertEquals(jar.other_app, '%E0%A4%A')
  assertEquals(jar.adhar_session, 'abc def')
  assertEquals('flag' in jar, false)
})

Deno.test('signed transaction cookie rejects tampering', async () => {
  const secret = 'x'.repeat(32)
  const token = await sign('{"state":"s"}', secret)
  assertEquals(await unsign(token, secret), '{"state":"s"}')
  // Swap the payload (not a signature char — the last base64url char of a
  // 32-byte MAC carries ignored padding bits, so flipping it can be a no-op).
  const forged = `${btoa('{"state":"t"}').replace(/=+$/, '')}.${token.split('.')[1]}`
  assertEquals(await unsign(forged, secret), null)
  assertEquals(await unsign(token, 'y'.repeat(32)), null)
})

function withEnv(vars: Record<string, string>, fn: () => void) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]))
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v)
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k)
      else Deno.env.set(k, v)
    }
  }
}

Deno.test('non-numeric session TTLs fall back to the defaults instead of NaN', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      KEYCLOAK_URL: 'https://keycloak.example.test',
      AUTH_CLIENT_SECRET: 'secret',
      AUTH_COOKIE_SECRET: 'c'.repeat(32),
      AUTH_SESSION_TTL_SECONDS: '8h',
      AUTH_SESSION_ABSOLUTE_TTL_SECONDS: '3600',
    },
    () => {
      const cfg = getServerAuthConfig()!
      assertEquals(cfg.sessionTtlSeconds, 8 * 60 * 60)
      assertEquals(cfg.sessionAbsoluteTtlSeconds, 3600)
      // The default scope deliberately omits offline_access (SSO-bound refresh).
      assertEquals(cfg.scopes, 'openid profile email')
    },
  )
})

const b64url = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** An unsigned access token: refresh responses are decoded, not re-verified. */
const accessToken = (claims: Record<string, unknown>) => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`

Deno.test('a token refresh keeps the organisation the session is working in', async () => {
  // Keycloak emits no `tenants` claim, so the old rule ("keep it only if the
  // token lists it") reset every session to '' on its first refresh and an
  // organisation switch reverted within one access-token lifetime.
  const cfg = { clientId: 'adhar-console' } as ServerAuthConfig
  const previous = {
    user: { id: 'u-1', email: 'ana@example.test', name: 'Ana', roles: ['viewer' as const], groups: ['org-acme'], tenants: [] },
    accessToken: 'old',
    refreshToken: 'r-1',
    expiresAt: 0,
    authTime: 1,
    activeTenant: 'acme-x1y2z',
    sid: 'sid-1',
  }
  const next = await sessionFromTokens(
    cfg,
    {
      access_token: accessToken({ sub: 'u-1', email: 'ana@example.test', name: 'Ana', groups: ['org-acme', 'org-beta'], exp: 9, iat: 1 }),
      token_type: 'Bearer',
      expires_in: 300,
    },
    { previous },
  )
  assertEquals(next.activeTenant, 'acme-x1y2z')
  // The groups are the NEW token's — that is how a membership change arrives.
  assertEquals(next.user.groups, ['org-acme', 'org-beta'])
  assertEquals(next.sid, 'sid-1')
  assertEquals(next.authTime, 1)
})

Deno.test('a code exchange without an id_token cannot skip the nonce check', async () => {
  const cfg = { clientId: 'adhar-console' } as ServerAuthConfig
  await assertRejects(
    () =>
      sessionFromTokens(
        cfg,
        { access_token: 'a.b.c', token_type: 'Bearer', expires_in: 300 },
        { nonce: 'n-123' },
      ),
    Error,
    'nonce',
  )
})

Deno.test('group names keep their case; only role aliasing ignores it', () => {
  const u = claimsToUser({ sub: 'u', email: 'u@x', name: 'U', groups: ['/ORG-ACME-ADMIN', 'org-acme', '/parent/Platform-Admin'] } as never)
  // Kubernetes binds OIDC groups case-sensitively; the console must see what it sees.
  assertEquals(u.groups, ['ORG-ACME-ADMIN', 'org-acme', 'Platform-Admin'])
  // The UI persona role still aliases case-insensitively, as before (a display
  // choice; organisation access is decided from the exact group names above).
  assertEquals(u.roles, ['platform-admin'])
})
