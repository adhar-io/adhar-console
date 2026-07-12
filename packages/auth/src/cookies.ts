/**
 * Cookie primitives — framework-agnostic, Web-Crypto based (works in Deno,
 * Node 20+, and the edge). No external dependency.
 *
 * Two cookies are used by the auth flow:
 *   - the **session** cookie (HttpOnly) holds a signed JWT minted by
 *     `session.ts`; helpers here only (de)serialize the `Set-Cookie` header.
 *   - the **transaction** cookie (HttpOnly, short-lived) carries the OIDC
 *     `state` / `nonce` / PKCE `code_verifier` / `returnTo` between `/login`
 *     and `/callback`. Its value is signed with HMAC here.
 */

export interface CookieAttributes {
  path?: string
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
  domain?: string
}

export function serializeCookie(
  name: string,
  value: string,
  attrs: CookieAttributes = {},
): string {
  const parts = [`${name}=${value}`]
  parts.push(`Path=${attrs.path ?? '/'}`)
  if (attrs.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(attrs.maxAge)}`)
  if (attrs.domain) parts.push(`Domain=${attrs.domain}`)
  if (attrs.httpOnly ?? true) parts.push('HttpOnly')
  if (attrs.secure) parts.push('Secure')
  parts.push(`SameSite=${attrs.sameSite ?? 'Lax'}`)
  return parts.join('; ')
}

/** Build a `Set-Cookie` value that deletes the named cookie. */
export function clearCookie(name: string, attrs: CookieAttributes = {}): string {
  return serializeCookie(name, '', { ...attrs, maxAge: 0 })
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const k = pair.slice(0, idx).trim()
    const v = pair.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

/* ─────────── HMAC sign / verify (for the transaction cookie) ─────────── */

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/** Sign an arbitrary string payload → `payload.signature` (both base64url). */
export async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret)
  const data = new TextEncoder().encode(payload)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
  return `${b64url(data)}.${b64url(sig)}`
}

/** Verify a `payload.signature` token (constant-time) and return the payload. */
export async function unsign(token: string, secret: string): Promise<string | null> {
  const dot = token.lastIndexOf('.')
  if (dot === -1) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  let payloadBytes: Uint8Array
  let sigBytes: Uint8Array
  try {
    payloadBytes = b64urlDecode(payloadB64)
    sigBytes = b64urlDecode(sigB64)
  } catch {
    return null
  }
  const key = await hmacKey(secret)
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes)
  if (!ok) return null
  return new TextDecoder().decode(payloadBytes)
}
