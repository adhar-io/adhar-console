import { decodeJwt, jwtVerify } from 'jose'
import { ClaimsSchema, type Claims } from './types.ts'
import { claimsToUser } from './claims.ts'
import type { ServerAuthConfig } from './config.ts'
import { getDiscovery, getJwks } from './discovery.ts'
import type { ServerSession } from './session-store.ts'

export { claimsToUser } from './claims.ts'

/**
 * Server-side OIDC operations against Keycloak — Authorization Code + PKCE,
 * confidential client. Used only by the BFF / server routes; never bundled
 * into the browser.
 */

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  token_type: string
  expires_in: number
  refresh_expires_in?: number
  scope?: string
}

/* ─────────── PKCE ─────────── */

function randomString(bytes = 32): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return base64url(arr)
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(32)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

export function randomNonce(): string {
  return randomString(16)
}

/* ─────────── authorize / end-session URLs ─────────── */

export async function buildAuthorizeUrl(
  cfg: ServerAuthConfig,
  opts: {
    redirectUri: string
    state: string
    nonce: string
    codeChallenge: string
    /** `register` jumps to Keycloak's hosted registration form. */
    intent?: 'login' | 'register'
  },
): Promise<string> {
  const { authorization_endpoint } = await getDiscovery(cfg)
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: cfg.scopes,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  })
  if (opts.intent === 'register') params.set('kc_action', 'register')
  return `${authorization_endpoint}?${params}`
}

export async function buildEndSessionUrl(
  cfg: ServerAuthConfig,
  opts: { idToken?: string; postLogoutRedirectUri: string },
): Promise<string> {
  const disc = await getDiscovery(cfg)
  const endpoint =
    disc.end_session_endpoint ?? `${cfg.issuer}/protocol/openid-connect/logout`
  const params = new URLSearchParams({ post_logout_redirect_uri: opts.postLogoutRedirectUri })
  if (opts.idToken) params.set('id_token_hint', opts.idToken)
  else params.set('client_id', cfg.clientId)
  return `${endpoint}?${params}`
}

/* ─────────── token endpoint calls ─────────── */

async function postToken(
  cfg: ServerAuthConfig,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const { token_endpoint } = await getDiscovery(cfg)
  body.set('client_id', cfg.clientId)
  body.set('client_secret', cfg.clientSecret)
  const res = await fetch(token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Token endpoint ${res.status}: ${text.slice(0, 300)}`)
  }
  return JSON.parse(text) as TokenResponse
}

export function exchangeCode(
  cfg: ServerAuthConfig,
  opts: { code: string; redirectUri: string; codeVerifier: string },
): Promise<TokenResponse> {
  return postToken(
    cfg,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
    }),
  )
}

export function refreshTokens(
  cfg: ServerAuthConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(
    cfg,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  )
}

/* ─────────── verification ─────────── */

/**
 * Verify an ID token's signature (against Keycloak's JWKS), issuer, audience,
 * and nonce, then return validated claims.
 */
export async function verifyIdToken(
  cfg: ServerAuthConfig,
  idToken: string,
  expectedNonce?: string,
): Promise<Claims> {
  const jwks = await getJwks(cfg)
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: cfg.issuer,
    audience: cfg.clientId,
    clockTolerance: '60s', // tolerate minor node/Keycloak clock drift
  })
  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error('OIDC nonce mismatch — possible replay.')
  }
  return ClaimsSchema.parse({
    sub: payload.sub,
    email: (payload.email as string) ?? '',
    name:
      (payload.name as string) ??
      (payload.preferred_username as string) ??
      (payload.email as string) ??
      'Unknown',
    preferred_username: payload.preferred_username,
    realm_access: payload.realm_access,
    resource_access: payload.resource_access,
    tenants: payload.tenants,
    exp: payload.exp ?? 0,
    iat: payload.iat ?? 0,
  })
}

/**
 * Verify an access token presented as a bearer (e.g. a PAT-less API client or
 * a backing tool forwarding back). Validates signature + issuer against JWKS.
 */
export async function verifyAccessToken(
  cfg: ServerAuthConfig,
  token: string,
): Promise<Claims> {
  const jwks = await getJwks(cfg)
  // NB: the access token's `aud` targets the apiserver (`adhar-cli`), not the
  // console's clientId, so we verify iss + signature but not audience here.
  const { payload } = await jwtVerify(token, jwks, {
    issuer: cfg.issuer,
    clockTolerance: '60s',
  })
  return ClaimsSchema.parse({
    sub: payload.sub,
    email: (payload.email as string) ?? '',
    name: (payload.name as string) ?? (payload.preferred_username as string) ?? 'Unknown',
    preferred_username: payload.preferred_username,
    realm_access: payload.realm_access,
    resource_access: payload.resource_access,
    tenants: payload.tenants,
    exp: payload.exp ?? 0,
    iat: payload.iat ?? 0,
  })
}

/* ─────────── token-set → ServerSession ─────────── */

/**
 * Build a `ServerSession` from a fresh token response. Verifies the ID token
 * and maps its claims to the app user.
 */
export async function sessionFromTokens(
  cfg: ServerAuthConfig,
  tokens: TokenResponse,
  opts: { nonce?: string; previous?: ServerSession } = {},
): Promise<ServerSession> {
  let claims: Claims
  if (tokens.id_token) {
    claims = await verifyIdToken(cfg, tokens.id_token, opts.nonce)
  } else {
    // Refresh responses may omit a new id_token — fall back to decoding the
    // (already signature-trusted from this same response) access token.
    const decoded = decodeJwt(tokens.access_token)
    claims = ClaimsSchema.parse({
      sub: decoded.sub,
      email: (decoded.email as string) ?? opts.previous?.user.email ?? '',
      name: (decoded.name as string) ?? opts.previous?.user.name ?? 'Unknown',
      realm_access: decoded.realm_access,
      resource_access: decoded.resource_access,
      tenants: decoded.tenants,
      exp: decoded.exp ?? 0,
      iat: decoded.iat ?? 0,
    })
  }
  const user = claimsToUser(claims, cfg.clientId)
  const activeTenant =
    opts.previous?.activeTenant && user.tenants.includes(opts.previous.activeTenant)
      ? opts.previous.activeTenant
      : user.tenants[0] ?? ''
  return {
    user,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? opts.previous?.refreshToken,
    idToken: tokens.id_token ?? opts.previous?.idToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    // Preserve the original login time across refreshes for the absolute cap.
    authTime: opts.previous?.authTime ?? Date.now(),
    activeTenant,
  }
}

/**
 * Best-effort refresh-token revocation at Keycloak's revocation endpoint —
 * defence-in-depth on logout so an exfiltrated refresh token dies immediately
 * (the stateless session cookie can't be revoked before its own expiry).
 */
export async function revokeToken(
  cfg: ServerAuthConfig,
  token: string,
  tokenTypeHint: 'refresh_token' | 'access_token' = 'refresh_token',
): Promise<void> {
  try {
    const disc = await getDiscovery(cfg)
    const endpoint = (disc as { revocation_endpoint?: string }).revocation_endpoint ??
      `${cfg.issuer}/protocol/openid-connect/revoke`
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: tokenTypeHint,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    })
  } catch (e) {
    console.error('[auth] token revocation failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}
