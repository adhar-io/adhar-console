import { getServerAuthConfig, getValidSession } from '@adhar/auth/server'
import { getTool, type ToolDef } from './tool-registry.ts'
import { fetchWithApiServerClient } from './k8s/gateway.ts'
import { type CachedResponse, retryAfterMs, snapshot, toolGetCache } from './tool-cache.ts'
import { getRequestUser } from './request-user.ts'
import { toolPublicUrl } from './domain.ts'
import { env } from '@adhar/utils'
import {
  accountMissing,
  auditGiteaWrite,
  bodyNamesSudo,
  invalidateGiteaIdentity,
  isGiteaApiPath,
  isGiteaWrite,
  lookupFailed,
  mapSudoFailure,
  noIdentity,
  resolveGiteaUsername,
  stripClientSudo,
  sudoParamRefused,
  writePathRefused,
} from './gitea-sudo.ts'

/** The longest a request waits on a 429 before retrying once. */
const MAX_RATE_LIMIT_WAIT_MS = 5_000
const STRIP_RESPONSE = new Set(['set-cookie', 'content-encoding', 'content-length'])

function fromSnapshot(s: CachedResponse, cache: 'hit' | 'miss' | 'stale'): Response {
  const headers = new Headers()
  for (const [k, v] of s.headers) {
    const key = k.toLowerCase()
    if (!HOP_BY_HOP.has(key) && !STRIP_RESPONSE.has(key)) headers.set(k, v)
  }
  headers.set('x-adhar-cache', cache)
  // A 204/304 must not carry a body.
  const body = s.status === 204 || s.status === 304 ? null : s.body
  return new Response(body, { status: s.status, statusText: s.statusText, headers })
}

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

/**
 * Request headers a browser must never be able to set on a proxied call, on
 * top of HOP_BY_HOP. Every one of them is something an upstream TRUSTS from
 * whoever sits in front of it — which is the console, so a client-supplied
 * value would be believed as if the console had vouched for it:
 *   - `impersonate-*`: kube-apiserver impersonation (the console SA may hold
 *     the impersonate verb);
 *   - `x-scope-orgid`: the Loki/Mimir/Tempo tenant — the registry sets it where
 *     a tenant is configured, and leaving it client-settable elsewhere let a
 *     caller read another tenant's telemetry;
 *   - auth-proxy identity headers (Grafana `X-WEBAUTH-*`, oauth2-proxy
 *     `X-Auth-Request-*`, `X-Forwarded-User`/`-Email`, `X-Remote-*`);
 *   - `forwarded` / `x-forwarded-*` / `x-real-ip`: client IP and scheme claims
 *     upstreams use for allow-lists and redirects.
 */
const CLIENT_UNTRUSTED = /^(impersonate-|x-scope-orgid$|x-webauth-|x-auth-request-|x-forwarded-|x-real-ip$|forwarded$|x-remote-)/

/** True for a request header the proxy forwards from the client. */
export function forwardableRequestHeader(name: string): boolean {
  const key = name.toLowerCase()
  return !HOP_BY_HOP.has(key) && !CLIENT_UNTRUSTED.test(key)
}

/**
 * Reject an upstream path that climbs out of where the proxy points it.
 *
 * The router hands us an already-normalised pathname, so a literal `..` is
 * gone by the time it gets here — but a percent-encoded separator survives
 * (`a%2F..%2F..%2Fadmin`), and many upstreams decode before routing. Decoding
 * and splitting on both slash kinds catches that while still allowing an
 * encoded slash INSIDE a name (`feat%2Fx`, Harbor's `a%252Fb`).
 */
export function unsafeUpstreamPath(path: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return true
  }
  // Control characters (CR/LF/NUL) have no business in a path.
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f]/.test(decoded)) return true
  return decoded.split(/[/\\]/).some((seg) => seg === '.' || seg === '..')
}

/** Largest request body the proxy buffers (it must, to replay a login-mode retry). */
const MAX_PROXY_BODY_BYTES = 64 * 1024 * 1024

/**
 * How long the proxy waits for an upstream to START answering. Bodies are not
 * timed (SSE / large lists stream for as long as the client stays), but a tool
 * that accepts the connection and never responds no longer pins it forever.
 */
const UPSTREAM_HEADERS_TIMEOUT_MS = 60_000
/** Session-mint and identity-lookup calls are small; a stuck one fails fast. */
const AUX_FETCH_TIMEOUT_MS = 15_000

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
      signal: AbortSignal.timeout(AUX_FETCH_TIMEOUT_MS),
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
      // Most of the platform's own services need no credential adhar-controlplane —
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

/* ───────────────────────── Gitea: act as the user ───────────────────────── */

export interface GiteaWriteContext {
  /** Who the console says made the change (email, else id) — for the audit line. */
  actor: string
  /** The Gitea username the write runs as; absent only on a laptop without auth. */
  sudo?: string
  email?: string
  username?: string
  publicUrl: string
  adminGet: (path: string) => Promise<Response>
}

/**
 * Validate a `/api/svc/gitea` request and work out who it runs as. Returns the
 * query string to forward (client `sudo` removed) and, for a write, the
 * identity to `Sudo` as — or a Response to answer with instead.
 */
export async function guardGitea(
  def: ToolDef,
  request: Request,
  method: string,
  path: string,
  body: ArrayBuffer | undefined,
  headers: Headers,
  deps: {
    authConfigured: () => boolean
    getUser: typeof getRequestUser
  } = { authConfigured: () => Boolean(getServerAuthConfig()), getUser: getRequestUser },
): Promise<Response | { search: string; write?: GiteaWriteContext; refreshedCookie?: string }> {
  const search = stripClientSudo(new URL(request.url).search, headers)
  const write = isGiteaWrite(method)
  const publicUrl = toolPublicUrl('gitea', 'GITEA_URL')

  if (write) {
    if (!isGiteaApiPath(path)) return writePathRefused()
    if (await bodyNamesSudo(request.headers.get('content-type'), body)) return sudoParamRefused()
  }

  // No identity provider at all. On a laptop (`deno task dev:server`) the
  // console keeps acting as the configured Gitea account; in a cluster that
  // would hand the admin to anonymous callers, so writes are refused there.
  if (!deps.authConfigured()) {
    if (!write) return { search }
    if (env('KUBERNETES_SERVICE_HOST')) {
      return json(503, { error: 'auth_not_configured', message: 'Sign-in is not configured on this console, so it cannot make changes in Gitea.' })
    }
    return { search, write: { actor: 'local-dev', publicUrl, adminGet: adminGetter(def) } }
  }

  // Every Gitea request needs a session — reads run as the admin too.
  const auth = await deps.getUser(request)
  if (!auth) return json(401, { error: 'unauthenticated', message: 'Sign in to continue.' })
  if (!write) return { search, refreshedCookie: auth.refreshedCookie }

  const who = { email: auth.user.email, username: auth.user.username }
  const adminGet = adminGetter(def)
  const actor = auth.user.email || auth.user.id
  const resolved = await resolveGiteaUsername(who, adminGet)
  if (!resolved.ok) {
    auditGiteaWrite({ user: actor, method, path, status: 0, outcome: resolved.reason })
    const res = resolved.reason === 'no_account'
      ? accountMissing(publicUrl)
      : resolved.reason === 'no_identity'
      ? noIdentity()
      : lookupFailed('detail' in resolved ? resolved.detail : '')
    if (auth.refreshedCookie) res.headers.append('set-cookie', auth.refreshedCookie)
    return res
  }
  return {
    search,
    refreshedCookie: auth.refreshedCookie,
    write: { actor, sudo: resolved.username, ...who, publicUrl, adminGet },
  }
}

/** Plain admin `GET` against Gitea (identity lookups; never `Sudo`'d). */
function adminGetter(def: ToolDef): (path: string) => Promise<Response> {
  return async (p) => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (def.authMode === 'basic' && def.username && def.password) {
      headers.authorization = `Basic ${btoa(`${def.username}:${def.password}`)}`
    } else if (def.serviceToken) {
      headers.authorization = `Bearer ${def.serviceToken}`
    }
    return await fetch(`${def.baseUrl}${p}`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(AUX_FETCH_TIMEOUT_MS),
    })
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
  // The kube-apiserver is reached through the k8s gateway (`/api/k8s/…`), which
  // forwards the USER's identity. Here it would go out with the console's own
  // ServiceAccount token (`K8S_SA_TOKEN`) to every signed-in user — the
  // console's cluster privilege, handed to anyone. No client uses this route.
  if (tool === 'k8s') {
    return json(404, { error: 'unknown_tool', tool, detail: 'Use /api/k8s/… — the Kubernetes gateway.' })
  }
  const def = getTool(tool)
  if (!def) return json(404, { error: 'unknown_tool', tool })
  if (!def.baseUrl) return json(503, { error: 'tool_not_configured', tool })

  // Every tool needs a signed-in session, whatever credential the proxy then
  // injects. Only `user` mode used to check one: tools reached with the
  // console's OWN credentials (`service` / `basic` / `login` / `none` — Argo CD,
  // Harbor, Nexus, Plane, Strapi, Grafana, Kargo, …) answered anyone who could
  // reach the console, signed in or not, with those credentials (2026-10-22).
  // Internal callers (live.ts, coder-ide.ts) forward the user's cookie. On a
  // laptop without auth configured, local development keeps working.
  if (def.authMode !== 'user') {
    const cfg = getServerAuthConfig()
    if (cfg) {
      if (!(await getValidSession(request, cfg))) return json(401, { error: 'unauthenticated' })
    } else if (env('KUBERNETES_SERVICE_HOST')) {
      return json(503, { error: 'auth_not_configured', tool })
    }
  }

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
  if (unsafeUpstreamPath(path)) return json(400, { error: 'invalid_path' })
  const method = request.method.toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'
  // Buffer the body once so a login-mode retry can resend it (a stream can't be
  // replayed; an ArrayBuffer can) — under a cap, since it is held in memory.
  if (hasBody && Number(request.headers.get('content-length') ?? '0') > MAX_PROXY_BODY_BYTES) {
    return json(413, { error: 'request_entity_too_large', maxBytes: MAX_PROXY_BODY_BYTES })
  }
  const body = hasBody ? await request.arrayBuffer() : undefined
  if (body && body.byteLength > MAX_PROXY_BODY_BYTES) {
    return json(413, { error: 'request_entity_too_large', maxBytes: MAX_PROXY_BODY_BYTES })
  }

  // Client headers minus hop-by-hop/identity/trusted-proxy headers, plus the
  // tool's static headers. The per-attempt `authorization` is layered on top
  // of a copy of this.
  const baseHeaders = new Headers()
  for (const [k, v] of request.headers) {
    if (forwardableRequestHeader(k)) baseHeaders.set(k, v)
  }
  for (const [k, v] of Object.entries(def.headers ?? {})) baseHeaders.set(k, v)

  // Gitea is driven with ADMIN credentials: writes run as the signed-in user
  // via `Sudo`, and nobody may pick that user themselves. See gitea-sudo.ts.
  let search = incoming.search
  let giteaWrite: GiteaWriteContext | undefined
  let sessionCookie: string | undefined
  if (tool === 'gitea') {
    const g = await guardGitea(def, request, method, path, body, baseHeaders)
    if (g instanceof Response) return g
    search = g.search
    giteaWrite = g.write
    sessionCookie = g.refreshedCookie
  }

  const upstreamUrl = `${def.baseUrl}${def.stripPrefix ? path.replace(def.stripPrefix, '') : path}${search}`

  const attempt = async (
    forceLoginRefresh: boolean,
  ): Promise<{ upstream: Response; refreshedCookie?: string } | { error: Response }> => {
    const auth = await resolveToken(tool, def, request, { forceLoginRefresh })
    if ('error' in auth) return { error: auth.error }
    const headers = new Headers(baseHeaders)
    if (giteaWrite?.sudo) headers.set('Sudo', giteaWrite.sudo)
    if (auth.authHeader && !def.headers?.['x-api-key']) {
      headers.set(auth.authHeaderName ?? 'authorization', auth.authHeader)
    }
    // Abort when the browser goes away, or when the upstream has not started
    // answering in time; once headers arrive the body streams untimed.
    const headersTimer = new AbortController()
    const timer = setTimeout(
      () => headersTimer.abort(new DOMException('upstream did not answer in time', 'TimeoutError')),
      UPSTREAM_HEADERS_TIMEOUT_MS,
    )
    try {
      const init: RequestInit = {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.any([request.signal, headersTimer.signal]),
      }
      // The kube-apiserver goes through the dedicated HTTP/1.1 client (+ one
      // retry on a dead pooled connection) — see k8s/gateway.ts for why an h2
      // GOAWAY otherwise takes the whole cluster view down until restart. The
      // body is an ArrayBuffer here, so the retry can safely replay it.
      const upstream = tool === 'k8s'
        ? await fetchWithApiServerClient(upstreamUrl, init)
        : await fetch(upstreamUrl, init)
      return { upstream, refreshedCookie: auth.refreshedCookie }
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === 'TimeoutError'
      return {
        error: timedOut
          ? json(504, { error: 'upstream_timeout', tool })
          : json(502, { error: 'upstream_unreachable', detail: e instanceof Error ? e.message : '' }),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /*
   * Shared GET cache for tools the console calls with ONE service credential
   * that the upstream rate-limits (Plane). See tool-cache.ts.
   */
  const cacheMs = def.authMode === 'service' ? def.sharedGetCacheMs ?? 0 : 0
  const cachePrefix = `${tool}\0`
  if (cacheMs > 0 && method === 'GET') {
    const key = `${cachePrefix}${upstreamUrl}`
    const fresh = toolGetCache.get(key, cacheMs)
    if (fresh) return fromSnapshot(fresh, 'hit')
    let served: 'miss' | 'stale' = 'miss'
    const snap = await toolGetCache.coalesce(key, async () => {
      let r = await attempt(false)
      if ('error' in r) {
        // Unreachable upstream: the last good answer beats an error panel.
        const stale = toolGetCache.get(key, def.sharedGetStaleMs ?? 0)
        if (stale) {
          served = 'stale'
          return stale
        }
        return snapshot(r.error)
      }
      if (r.upstream.status === 429) {
        const stale = toolGetCache.get(key, def.sharedGetStaleMs ?? 0)
        if (stale) {
          await r.upstream.body?.cancel()
          served = 'stale'
          return stale
        }
        const wait = retryAfterMs(r.upstream.headers)
        if (wait !== undefined && wait <= MAX_RATE_LIMIT_WAIT_MS) {
          await r.upstream.body?.cancel()
          await new Promise((ok) => setTimeout(ok, wait + 100))
          r = await attempt(false)
          if ('error' in r) return snapshot(r.error)
        }
      }
      const s = await snapshot(r.upstream)
      if (s.status >= 200 && s.status < 300) toolGetCache.set(key, s)
      return s
    })
    return fromSnapshot(snap, served)
  }

  let result = await attempt(false)
  if ('error' in result) {
    if (giteaWrite) {
      auditGiteaWrite({ user: giteaWrite.actor, giteaUser: giteaWrite.sudo, method, path, status: result.error.status, outcome: 'upstream_error' })
    }
    return result.error
  }

  // A rate-limited write waits out a short window once rather than failing.
  if (cacheMs > 0 && result.upstream.status === 429) {
    const wait = retryAfterMs(result.upstream.headers)
    if (wait !== undefined && wait <= MAX_RATE_LIMIT_WAIT_MS) {
      await result.upstream.body?.cancel()
      await new Promise((ok) => setTimeout(ok, wait + 100))
      const retry = await attempt(false)
      if ('error' in retry) return retry.error
      result = retry
    }
  }
  // Any successful write makes the tool's cached reads suspect.
  if (cacheMs > 0 && result.upstream.status < 400) toolGetCache.invalidate(cachePrefix)

  // Refresh-on-failure (login mode only): a rotated/expired session token shows
  // up as an upstream 401/403. Invalidate the cache, re-mint once, and retry the
  // original request a single time.
  if (def.authMode === 'login' && (result.upstream.status === 401 || result.upstream.status === 403)) {
    await result.upstream.body?.cancel()
    const retry = await attempt(true)
    if ('error' in retry) return retry.error
    result = retry
  }

  let upstream = result.upstream
  const refreshedCookie = result.refreshedCookie ?? sessionCookie

  if (giteaWrite) {
    let status = upstream.status
    if (giteaWrite.sudo && (status === 403 || status === 404)) {
      const text = await upstream.text().catch(() => '')
      const ctx = giteaWrite
      const mapped = await mapSudoFailure(status, text, {
        giteaUser: ctx.sudo!,
        publicGiteaUrl: ctx.publicUrl,
        stillExists: async () => {
          invalidateGiteaIdentity(ctx.email)
          const again = await resolveGiteaUsername({ email: ctx.email, username: ctx.username }, ctx.adminGet)
          // Only a definite "no such account" changes the answer; a failed
          // lookup or a renamed account passes Gitea's own 404 through.
          return again.ok || again.reason !== 'no_account'
        },
      })
      upstream = mapped ?? new Response(text, { status, statusText: upstream.statusText, headers: upstream.headers })
      status = upstream.status
    }
    auditGiteaWrite({ user: giteaWrite.actor, giteaUser: giteaWrite.sudo, method, path, status })
  }

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
  for (const [k, v] of upstream.headers) {
    const key = k.toLowerCase()
    if (!HOP_BY_HOP.has(key) && !STRIP_RESPONSE.has(key)) respHeaders.set(k, v)
  }
  if (refreshedCookie) respHeaders.append('set-cookie', refreshedCookie)

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  })
}
