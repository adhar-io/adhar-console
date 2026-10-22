/**
 * Cross-cutting HTTP hardening applied by the router in `server.ts` to every
 * request, so each handler does not have to remember it:
 *
 *   - **CSRF**: state-changing `/api/*` calls must come from our own origin.
 *   - **JSON bodies**: a malformed or oversized body is the client's fault (400
 *     / 413), never an `internal_error` 500, and never an unbounded buffer.
 *   - **Security headers** that are safe for a Module Federation SPA.
 *
 * Kept out of `server.ts` so it can be unit-tested without booting a server.
 */
import { originOk } from './k8s/gateway.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** True for verbs that may change state. */
export function isMutating(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase())
}

/**
 * CSRF gate for the whole BFF.
 *
 * The session cookie is `SameSite=Lax`, which stops a cross-SITE form post —
 * but every app the platform hosts lives on a sibling subdomain of the
 * console's (`*.platform.<domain>`), and those are the SAME site. Any such app
 * (or an XSS in one) could otherwise POST to `/api/workspace/…`, `/api/scaffold`
 * or `/api/svc/gitea/…` with the victim's cookie. Only the k8s gateway, exec
 * and the live hub checked `Origin`; this applies the same rule everywhere.
 *
 * A request without `Origin` is allowed: browsers always send it on a
 * cross-origin (and same-origin non-GET) fetch, so its absence means a
 * non-browser caller — Alertmanager's webhook, curl, the BFF calling itself —
 * which the cookie or a bearer token still gates.
 */
export function csrfRejected(req: Request): Response | null {
  if (!isMutating(req.method)) return null
  if (originOk(req)) return null
  return Response.json(
    { error: 'origin_not_allowed', detail: 'This request did not come from the console.' },
    { status: 403 },
  )
}

/** Largest JSON request body any console endpoint accepts (templates, manifests, design files). */
export const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024

/** A client error raised while reading the request body — mapped to 400/413 by the router. */
export class RequestBodyError extends Error {
  constructor(
    public readonly code: 'invalid_json' | 'request_entity_too_large',
    message: string,
  ) {
    super(message)
    this.name = 'RequestBodyError'
  }
  get status(): number {
    return this.code === 'request_entity_too_large' ? 413 : 400
  }
  toResponse(): Response {
    return Response.json({ error: this.code, detail: this.message }, { status: this.status })
  }
}

async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new RequestBodyError('request_entity_too_large', `Request body exceeds ${maxBytes} bytes.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/**
 * Make `req.json()` fail as a CLIENT error.
 *
 * Dozens of handlers call `await req.json()` bare; a typo'd or empty body threw
 * a `SyntaxError` that the router's catch-all turned into a 500
 * `internal_error` (and an error log line) for what is a 400. The body is also
 * read under a size cap, since `json()` would otherwise buffer whatever a
 * client streams at it. Handlers that already wrap `json()` in a try/catch see
 * a rejected promise exactly as before.
 */
export function guardJsonBody(req: Request, maxBytes = MAX_JSON_BODY_BYTES): void {
  const native = req.json.bind(req)
  Object.defineProperty(req, 'json', {
    configurable: true,
    value: async (): Promise<unknown> => {
      // Already consumed / no stream: keep the platform's own error semantics.
      if (req.bodyUsed || !req.body) return native()
      const declared = Number(req.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new RequestBodyError('request_entity_too_large', `Request body exceeds ${maxBytes} bytes.`)
      }
      const bytes = await readCapped(req.body, maxBytes)
      const text = new TextDecoder().decode(bytes)
      try {
        return JSON.parse(text)
      } catch {
        throw new RequestBodyError('invalid_json', 'Request body is not valid JSON.')
      }
    },
  })
}

/**
 * Response headers every console response should carry, when the handler has
 * not set its own.
 *
 * Deliberately NOT included, and why:
 *   - a full `Content-Security-Policy` (script/style/connect-src): Module
 *     Federation loads remotes at runtime, Monaco spins up blob: workers and
 *     the design system injects inline styles; a policy tight enough to matter
 *     needs nonces threaded through the build. Only `frame-ancestors` is set.
 *   - `Strict-Transport-Security`: installs commonly run on a self-signed
 *     certificate (the DO cluster does), and HSTS removes the browser's
 *     "proceed anyway" escape hatch — it would lock operators out. TLS policy
 *     belongs to the ingress, which knows whether the cert is trusted.
 *   - `Cross-Origin-Opener-Policy`: the IDE/tool launchers rely on
 *     `window.open` to other origins.
 */
const SECURITY_HEADERS: ReadonlyArray<[string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  // Clickjacking: only the console may frame the console. `X-Frame-Options`
  // for older browsers; CSP `frame-ancestors` supersedes it where supported.
  ['x-frame-options', 'SAMEORIGIN'],
  ['content-security-policy', "frame-ancestors 'self'"],
]

/**
 * Add the security headers that are missing. Upgrade (101) responses are
 * returned untouched; responses with immutable headers (`Response.redirect`,
 * a fetched Response) are re-wrapped.
 */
export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res
  const missing = SECURITY_HEADERS.filter(([k]) => !res.headers.has(k))
  if (!missing.length) return res
  try {
    for (const [k, v] of missing) res.headers.set(k, v)
    return res
  } catch {
    const headers = new Headers(res.headers)
    for (const [k, v] of missing) headers.set(k, v)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

/**
 * Await `p`, or reject with `message` after `ms` — clearing the timer either
 * way (a bare `Promise.race` against `setTimeout` leaves one
 * pending timer per readiness probe).
 */
export async function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
