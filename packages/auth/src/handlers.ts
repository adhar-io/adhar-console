import { getServerAuthConfig, resolvePublicOrigin, type ServerAuthConfig } from './config.ts'
import {
  clearCookie,
  parseCookies,
  serializeCookie,
  sign,
  unsign,
} from './cookies.ts'
import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  createPkce,
  exchangeCode,
  randomNonce,
  refreshTokens,
  sessionFromTokens,
} from './server.ts'
import {
  signSessionToken,
  toClientSession,
  verifySessionToken,
  type ServerSession,
} from './session-store.ts'

/**
 * Framework-agnostic HTTP handlers for the auth flow. Each takes a Web
 * `Request` and returns a Web `Response`, so they drop straight into a
 * TanStack Start server route, a Deno `serve` handler, or a test.
 *
 * Routes:
 *   GET  /api/auth/login    → redirect to Keycloak (sets txn cookie)
 *   GET  /api/auth/callback → code exchange, set session cookie, redirect back
 *   GET  /api/auth/logout   → clear session, redirect to Keycloak end-session
 *   GET  /api/auth/session  → JSON { user, ... } or 401
 */

const TXN_COOKIE = 'adhar_oidc_txn'
const REDIRECT_PATH = '/api/auth/callback'

interface TxnState {
  state: string
  nonce: string
  codeVerifier: string
  returnTo: string
}

/** Confine `returnTo` to same-origin absolute paths to prevent open redirects. */
function safeReturnTo(raw: string | null): string {
  if (!raw) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

function notConfigured(): Response {
  return new Response(JSON.stringify({ error: 'auth_not_configured' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  })
}

export async function handleLogin(req: Request): Promise<Response> {
  const cfg = getServerAuthConfig()
  if (!cfg) return notConfigured()
  const url = new URL(req.url)
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'))
  const intent = url.searchParams.get('intent') === 'register' ? 'register' : 'login'

  const { verifier, challenge } = await createPkce()
  const state = randomNonce()
  const nonce = randomNonce()
  const redirectUri = `${resolvePublicOrigin(cfg, req)}${REDIRECT_PATH}`

  const authorizeUrl = await buildAuthorizeUrl(cfg, {
    redirectUri,
    state,
    nonce,
    codeChallenge: challenge,
    intent,
  })

  const txn: TxnState = { state, nonce, codeVerifier: verifier, returnTo }
  const txnCookie = serializeCookie(
    TXN_COOKIE,
    await sign(JSON.stringify(txn), cfg.cookieSecret),
    { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'Lax', maxAge: 600 },
  )

  return new Response(null, {
    status: 302,
    headers: { location: authorizeUrl, 'set-cookie': txnCookie },
  })
}

export async function handleCallback(req: Request): Promise<Response> {
  const cfg = getServerAuthConfig()
  if (!cfg) return notConfigured()
  const url = new URL(req.url)
  const origin = resolvePublicOrigin(cfg, req)

  const errParam = url.searchParams.get('error')
  if (errParam) {
    const desc = url.searchParams.get('error_description') ?? errParam
    return redirectWithError(origin, desc)
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const cookies = parseCookies(req.headers.get('cookie'))
  const rawTxn = cookies[TXN_COOKIE]
  if (!code || !state || !rawTxn) {
    return redirectWithError(origin, 'Missing authorization code or session state.')
  }

  const txnJson = await unsign(rawTxn, cfg.cookieSecret)
  if (!txnJson) return redirectWithError(origin, 'Invalid sign-in state.')
  const txn = JSON.parse(txnJson) as TxnState
  if (txn.state !== state) return redirectWithError(origin, 'State mismatch — please retry sign-in.')

  let session: ServerSession
  try {
    const tokens = await exchangeCode(cfg, {
      code,
      redirectUri: `${origin}${REDIRECT_PATH}`,
      codeVerifier: txn.codeVerifier,
    })
    session = await sessionFromTokens(cfg, tokens, { nonce: txn.nonce })
  } catch (e) {
    return redirectWithError(origin, e instanceof Error ? e.message : 'Sign-in failed.')
  }

  // Fresh signup with no tenant yet → send through onboarding.
  const dest = session.user.tenants.length === 0 ? '/onboarding' : safeReturnTo(txn.returnTo)
  const headers = new Headers({ location: `${origin}${dest}` })
  headers.append('set-cookie', await sessionSetCookie(session, cfg))
  headers.append('set-cookie', clearCookie(TXN_COOKIE, { secure: cfg.cookieSecure }))
  return new Response(null, { status: 302, headers })
}

export async function handleLogout(req: Request): Promise<Response> {
  const cfg = getServerAuthConfig()
  const origin = cfg ? resolvePublicOrigin(cfg, req) : new URL(req.url).origin
  const headers = new Headers()

  if (!cfg) {
    headers.set('location', `${origin}/login`)
    return new Response(null, { status: 302, headers })
  }

  const current = await readSession(req, cfg)
  headers.append('set-cookie', clearCookie(cfg.cookieName, { secure: cfg.cookieSecure }))
  const endSession = await buildEndSessionUrl(cfg, {
    idToken: current?.idToken,
    postLogoutRedirectUri: `${origin}/login`,
  })
  headers.set('location', endSession)
  return new Response(null, { status: 302, headers })
}

export async function handleSession(req: Request): Promise<Response> {
  const cfg = getServerAuthConfig()
  if (!cfg) {
    return Response.json({ authenticated: false, configured: false }, { status: 200 })
  }
  const result = await getValidSession(req, cfg)
  if (!result) {
    return Response.json({ authenticated: false, configured: true }, { status: 200 })
  }
  const headers = new Headers({ 'content-type': 'application/json' })
  if (result.refreshedCookie) headers.append('set-cookie', result.refreshedCookie)
  return new Response(
    JSON.stringify({
      authenticated: true,
      configured: true,
      session: toClientSession(result.session),
    }),
    { status: 200, headers },
  )
}

/* ─────────── shared session helpers (used by proxy + handlers) ─────────── */

export async function readSession(
  req: Request,
  cfg: ServerAuthConfig,
): Promise<ServerSession | null> {
  const cookies = parseCookies(req.headers.get('cookie'))
  const raw = cookies[cfg.cookieName]
  if (!raw) return null
  return verifySessionToken(raw, cfg)
}

/**
 * Resolve the current session and transparently refresh the access token when
 * it is within 60s of expiry. Returns the (possibly refreshed) session plus a
 * `Set-Cookie` string the caller must attach when a refresh occurred.
 */
export async function getValidSession(
  req: Request,
  cfg: ServerAuthConfig,
): Promise<{ session: ServerSession; refreshedCookie?: string } | null> {
  const session = await readSession(req, cfg)
  if (!session) return null

  const needsRefresh = session.expiresAt - Date.now() < 60_000
  if (!needsRefresh) return { session }
  if (!session.refreshToken) return null

  try {
    const tokens = await refreshTokens(cfg, session.refreshToken)
    const next = await sessionFromTokens(cfg, tokens, { previous: session })
    return { session: next, refreshedCookie: await sessionSetCookie(next, cfg) }
  } catch {
    // Refresh failed (token revoked / Keycloak down) → treat as logged out.
    return null
  }
}

async function sessionSetCookie(session: ServerSession, cfg: ServerAuthConfig): Promise<string> {
  return serializeCookie(cfg.cookieName, await signSessionToken(session, cfg), {
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: 'Lax',
    maxAge: cfg.sessionTtlSeconds,
  })
}

function redirectWithError(origin: string, message: string): Response {
  const u = new URL(`${origin}/login`)
  u.searchParams.set('error', message)
  return new Response(null, { status: 302, headers: { location: u.toString() } })
}
