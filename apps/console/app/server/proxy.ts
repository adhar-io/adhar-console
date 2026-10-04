import { getServerAuthConfig, getValidSession } from '@adhar-console/auth/server'
import { getTool, type ToolDef } from './tool-registry.ts'
import { fetchWithApiServerClient } from './k8s/gateway.ts'

/**
 * Same-origin reverse proxy for backing tools.
 *
 * The browser calls `/api/svc/<tool>/<upstream-path>` with the session cookie;
 * this never carries a bearer token. The server resolves the cookie, looks up
 * the tool, injects the right upstream credential (the user's Keycloak access
 * token for `user` mode, or a service token for `service` mode), and forwards
 * the request. Tokens therefore never reach the browser.
 *
 * Hop-by-hop and identity headers are stripped before forwarding so the client
 * can't smuggle its own `Authorization` or spoof `cookie`.
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'authorization',
  'content-length',
])

function json(status: number, body: unknown, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(extra as Record<string, string>) },
  })
}

// ── login-mode session token cache ─────────────────────────────────────────
// Some tools (ArgoCD) authenticate with a short-lived session token minted from
// durable admin creds. The BFF mints that token on demand and caches it in this
// per-process module state (fine for the single BFF), reusing it until it nears
// expiry or an upstream 401/403 forces a re-mint. Credentials/tokens are never
// logged. The session POST uses the same `fetch` transport as every other
// proxied call, so the `DENO_CERT` trust store already configured for the
// runtime applies to it too — no per-request TLS handling needed here.

interface LoginTokenEntry {
  token: string
  /** Absolute expiry in epoch ms (from the JWT `exp` claim, or a safe default). */
  expMs: number
}

/** Cached session tokens, keyed by `tool + baseUrl`. */
const loginTokens = new Map<string, LoginTokenEntry>()
/** In-flight mints, keyed the same way, to coalesce concurrent callers. */
const loginMints = new Map<string, Promise<string>>()

/** Re-mint this many ms before the token's `exp` to avoid using a stale token. */
const LOGIN_REFRESH_SKEW_MS = 60_000
/** Fallback lifetime when the minted token carries no decodable `exp`. */
const LOGIN_DEFAULT_TTL_MS = 23 * 60 * 60 * 1000

function loginCacheKey(tool: string, baseUrl: string): string {
  // `\0` as an ESCAPE, not a raw NUL byte. A literal 0x00 in the source makes
  // this file binary to git and grep: `git diff` reported only
  // "Bin 11785 -> 12841 bytes" instead of the change, and `grep` skipped the
  // file entirely while searching for the proxy bug above. Same runtime value,
  // still a separator that cannot occur in a tool name or a URL.
  return `${tool}\0${baseUrl}`
}

/** Decode a JWT's `exp` claim to epoch ms. Returns undefined on any problem. */
function decodeJwtExpMs(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    b64 += '='.repeat((4 - (b64.length % 4)) % 4)
    const payload = JSON.parse(atob(b64)) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** POST admin creds to the tool's session endpoint and return the fresh token. */
async function mintLoginToken(def: ToolDef): Promise<string> {
  const login = def.login ?? {
    path: '/api/v1/session',
    body: (username: string, password: string) => ({ username, password }),
    tokenField: 'token',
  }
  let res: Response
  try {
    res = await fetch(`${def.baseUrl}${login.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(login.body(def.username ?? '', def.password ?? '')),
      redirect: 'manual',
    })
  } catch (e) {
    throw new Error(`session request failed: ${e instanceof Error ? e.message : 'network error'}`)
  }
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`session endpoint returned ${res.status}`)
  }
  let data: Record<string, unknown>
  try {
    data = await res.json()
  } catch {
    throw new Error('session response was not valid JSON')
  }
  const token = data[login.tokenField]
  if (typeof token !== 'string' || !token) throw new Error('session response had no token')
  return token
}

/**
 * Return a valid cached session token, minting one when absent, near expiry, or
 * when `forceRefresh` is set (used by the retry path after a 401/403). Concurrent
 * mints for the same key share one in-flight request (single-flight) so a burst
 * of requests doesn't stampede the session endpoint.
 */
async function getLoginToken(tool: string, def: ToolDef, forceRefresh: boolean): Promise<string> {
  const key = loginCacheKey(tool, def.baseUrl)
  if (forceRefresh) loginTokens.delete(key)

  const cached = loginTokens.get(key)
  if (cached && cached.expMs - LOGIN_REFRESH_SKEW_MS > Date.now()) return cached.token

  const inflight = loginMints.get(key)
  if (inflight) return inflight

  const p = mintLoginToken(def)
    .then((token) => {
      const expMs = decodeJwtExpMs(token) ?? Date.now() + LOGIN_DEFAULT_TTL_MS
      loginTokens.set(key, { token, expMs })
      return token
    })
    .finally(() => {
      loginMints.delete(key)
    })
  loginMints.set(key, p)
  return p
}

/**
 * Resolve the upstream credential header for a tool. Returns the header *name*
 * alongside its full value (scheme included) rather than a bare token, so each
 * mode can pick its own scheme and tools that don't speak Bearer — Metabase
 * wants `X-Metabase-Session` — are expressible. `opts.forceLoginRefresh`
 * re-mints a login-mode token.
 */
async function resolveToken(
  tool: string,
  def: ToolDef,
  request: Request,
  opts?: { forceLoginRefresh?: boolean },
): Promise<
  { authHeader?: string; authHeaderName?: string; refreshedCookie?: string } | { error: Response }
> {
  switch (def.authMode) {
    case 'none':
      return {}
    case 'service':
      // No token configured: forward the request unauthenticated rather than
      // refusing to make it.
      //
      // Most of the platform's own services need no credential in-cluster —
      // Prometheus, Loki, Mimir, Tempo, the Tekton dashboard, Falco — and
      // `service` is simply the mode that lets an *optional* token through when
      // one is set. Failing closed here meant the console answered 503 Service
      // Unavailable for a service that was healthy and would have answered the
      // question, and the UI understandably reported the tool as down.
      //
      // If a tool genuinely requires auth it now says so itself, with a 401 or
      // 403 the user can act on, instead of the console guessing on its behalf.
      if (!def.serviceToken) return {}
      return { authHeader: `Bearer ${def.serviceToken}` }
    case 'basic':
      if (!def.username || !def.password) {
        return { error: json(503, { error: 'basic_credentials_missing' }) }
      }
      return { authHeader: `Basic ${btoa(`${def.username}:${def.password}`)}` }
    case 'login': {
      if (!def.username || !def.password) {
        return { error: json(503, { error: 'login_credentials_missing' }) }
      }
      try {
        const token = await getLoginToken(tool, def, opts?.forceLoginRefresh ?? false)
        const scheme = def.login?.scheme ?? 'Bearer '
        return { authHeader: `${scheme}${token}`, authHeaderName: def.login?.header }
      } catch (e) {
        return {
          error: json(502, {
            error: 'login_session_failed',
            detail: e instanceof Error ? e.message : '',
          }),
        }
      }
    }
    default: {
      // user impersonation
      const cfg = getServerAuthConfig()
      if (!cfg) return { error: json(503, { error: 'auth_not_configured' }) }
      const result = await getValidSession(request, cfg)
      if (!result) return { error: json(401, { error: 'unauthenticated' }) }
      return {
        authHeader: `Bearer ${result.session.accessToken}`,
        refreshedCookie: result.refreshedCookie,
      }
    }
  }
}

/**
 * Proxy one request. `tool` is the registry key; `splat` is the remaining
 * upstream path (e.g. `api/v1/orgs/adhar/repos`).
 */
export async function proxyToolRequest(
  request: Request,
  tool: string,
  splat: string,
): Promise<Response> {
  const def = getTool(tool)
  if (!def) return json(404, { error: 'unknown_tool', tool })
  if (!def.baseUrl) return json(503, { error: 'tool_not_configured', tool })

  const incoming = new URL(request.url)
  // `splat` is a PATH ONLY. The query comes from the incoming URL, because that
  // is what a route splat gives us and what every HTTP caller already sets.
  //
  // Normalised rather than trusted, because a caller passing a full path+query
  // here is a silent, hard-to-see failure. `resolveCoderIdentity` did exactly
  // that: it passed `/api/v2/users?q=<email>&limit=5` as the splat AND set the
  // same query on the Request, so this line produced
  //   …/api/v2/users?q=<email>&limit=5?q=<email>&limit=5
  // and Coder answered 400 "Query param \"limit\" provided more than once".
  // The caller read that failure as "this person has no Coder account", tried to
  // create one, got 409 "User already exists" — for the account the lookup had
  // just failed to see — and told the operator to sign in to fix a problem
  // signing in could not fix. Stripping it here means no caller can reintroduce
  // that, and the leading-slash normalisation stops `//api/v2/...` too.
  const bare = splat.split('?')[0].split('#')[0].replace(/^\/+/, '')
  const path = bare ? `/${bare}` : ''
  const upstreamUrl = `${def.baseUrl}${def.stripPrefix ? path.replace(def.stripPrefix, '') : path}${incoming.search}`

  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'
  // Buffer the body once so a login-mode retry can resend it (a stream can't be
  // replayed; an ArrayBuffer can).
  const body = hasBody ? await request.arrayBuffer() : undefined

  // Client headers minus hop-by-hop/identity, plus the tool's static headers.
  // The per-attempt `authorization` is layered on top of a copy of this.
  const baseHeaders = new Headers()
  for (const [k, v] of request.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) baseHeaders.set(k, v)
  }
  for (const [k, v] of Object.entries(def.headers ?? {})) baseHeaders.set(k, v)

  const attempt = async (
    forceLoginRefresh: boolean,
  ): Promise<{ upstream: Response; refreshedCookie?: string } | { error: Response }> => {
    const auth = await resolveToken(tool, def, request, { forceLoginRefresh })
    if ('error' in auth) return { error: auth.error }
    const headers = new Headers(baseHeaders)
    if (auth.authHeader && !def.headers?.['x-api-key']) {
      headers.set(auth.authHeaderName ?? 'authorization', auth.authHeader)
    }
    try {
      const init: RequestInit = { method, headers, body, redirect: 'manual' }
      // The kube-apiserver goes through the dedicated HTTP/1.1 client (+ one
      // retry on a dead pooled connection) — see k8s/gateway.ts for why an h2
      // GOAWAY otherwise takes the whole cluster view down until restart. The
      // body is an ArrayBuffer here, so the retry can safely replay it.
      const upstream = tool === 'k8s'
        ? await fetchWithApiServerClient(upstreamUrl, init)
        : await fetch(upstreamUrl, init)
      return { upstream, refreshedCookie: auth.refreshedCookie }
    } catch (e) {
      return {
        error: json(502, { error: 'upstream_unreachable', detail: e instanceof Error ? e.message : '' }),
      }
    }
  }

  let result = await attempt(false)
  if ('error' in result) return result.error

  // Refresh-on-failure (login mode only): a rotated/expired session token shows
  // up as an upstream 401/403. Invalidate the cache, re-mint once, and retry the
  // original request a single time.
  if (def.authMode === 'login' && (result.upstream.status === 401 || result.upstream.status === 403)) {
    await result.upstream.body?.cancel()
    const retry = await attempt(true)
    if ('error' in retry) return retry.error
    result = retry
  }

  const upstream = result.upstream
  const refreshedCookie = result.refreshedCookie

  /*
   * Pass the upstream response through, dropping hop-by-hop headers, and attach
   * a refreshed session cookie if the token was rotated mid-request.
   *
   * `content-encoding` and `content-length` are dropped as well, and that is
   * not cosmetic. `fetch` decodes a compressed upstream body for us, so
   * `upstream.body` is already plaintext — forwarding the upstream's
   * `content-encoding: gzip` therefore hands the browser a gzip header over
   * bytes that are not gzip, and it fails the response outright with
   * ERR_CONTENT_DECODING_FAILED. The page then reports "Failed to fetch",
   * which reads as the tool being unreachable when the tool answered 200.
   *
   * ArgoCD surfaced it because it is the proxied tool whose responses are
   * large enough to be compressed — a 1.4 MB application list — so Deliver's
   * Apps and Environments pages showed "Couldn't reach ArgoCD" against a
   * perfectly healthy ArgoCD.
   *
   * `content-length` goes for the same reason: it describes the compressed
   * body we no longer have. Letting the runtime set both means it negotiates
   * compression with the actual client over the actual bytes.
   */
  const respHeaders = new Headers()
  const STRIP = new Set(['set-cookie', 'content-encoding', 'content-length'])
  for (const [k, v] of upstream.headers) {
    const key = k.toLowerCase()
    if (!HOP_BY_HOP.has(key) && !STRIP.has(key)) respHeaders.set(k, v)
  }
  if (refreshedCookie) respHeaders.append('set-cookie', refreshedCookie)

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  })
}
