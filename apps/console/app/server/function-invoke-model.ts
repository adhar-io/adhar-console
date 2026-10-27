/**
 * The pure half of `POST /api/functions/invoke` (function-invoke.ts): request
 * validation, the targets a Function may be called at, header hygiene and the
 * size caps. No I/O, so every rule is unit-tested (function-invoke_test.ts).
 *
 * The rules exist because the console server makes this call, not the
 * browser. Calling a function from the page broke three ways at once — CORS,
 * mixed content, and a Knative URL that only resolves inside the cluster — and
 * it put the browser in charge of WHERE the request went. Here the target is
 * never taken from the caller: it is the Function's own published URL (or its
 * in-cluster address), read as the caller after an RBAC check, and only hosts
 * that belong to that Function or to the platform's domain are ever dialled.
 */
import { platformRouteHost } from '@adhar/utils'

export const INVOKE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type InvokeMethod = (typeof INVOKE_METHODS)[number]

/** Request body forwarded to the function. A test payload, not an upload. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024
/** Response body returned to the browser; the rest is cut and flagged `truncated`. */
export const MAX_RESPONSE_BODY_BYTES = 256 * 1024
export const MAX_PATH_LENGTH = 2048
export const MAX_HEADERS = 32
export const MAX_HEADER_VALUE_LENGTH = 4096
/** Covers a cold start (scale from zero) without holding a request open for long. */
export const DEFAULT_TIMEOUT_MS = 15_000
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 30_000

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
/** RFC 9110 `token` — what a header field name may be made of. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Headers the caller may not set: hop-by-hop and framing headers the fetch
 * layer owns, and identity headers a proxy or the function would trust as
 * coming from the platform. Rejected with a reason rather than dropped, so a
 * test that "worked" never silently sent something else.
 */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
])

/** Response headers never handed back to the browser. */
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2'])

export interface InvokeRequest {
  namespace: string
  name: string
  method: InvokeMethod
  /** Path + query, always starting with `/`. */
  path: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

export type InvokeValidation =
  | { ok: true; request: InvokeRequest }
  | { ok: false; status: number; error: string; detail: string }

const bad = (error: string, detail: string): InvokeValidation => ({ ok: false, status: 400, error, detail })

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** Validate the browser's request. Pure. */
export function validateInvokeRequest(raw: unknown): InvokeValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('invalid_body', 'Expected a JSON object.')
  const b = raw as Record<string, unknown>

  const namespace = typeof b.namespace === 'string' ? b.namespace : ''
  const name = typeof b.name === 'string' ? b.name : ''
  if (!DNS_LABEL.test(namespace)) return bad('invalid_namespace', 'namespace must be a DNS-1123 label.')
  if (!DNS_LABEL.test(name)) return bad('invalid_name', 'name must be a DNS-1123 label.')

  const method = (typeof b.method === 'string' && b.method ? b.method : 'GET').toUpperCase()
  if (!(INVOKE_METHODS as readonly string[]).includes(method)) {
    return bad('invalid_method', `method must be one of ${INVOKE_METHODS.join(', ')}.`)
  }

  const path = b.path === undefined || b.path === '' ? '/' : b.path
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    return bad('invalid_path', 'path must start with a single "/" — it is appended to the function URL.')
  }
  // deno-lint-ignore no-control-regex
  if (/[\s\x00-\x1f\x7f\\]/.test(path)) return bad('invalid_path', 'path may not contain spaces, control characters or backslashes.')
  if (path.length > MAX_PATH_LENGTH) return bad('invalid_path', `path is longer than ${MAX_PATH_LENGTH} characters.`)

  const headers: Record<string, string> = {}
  if (b.headers !== undefined && b.headers !== null) {
    if (typeof b.headers !== 'object' || Array.isArray(b.headers)) return bad('invalid_headers', 'headers must be an object of name → value.')
    const entries = Object.entries(b.headers as Record<string, unknown>)
    if (entries.length > MAX_HEADERS) return bad('invalid_headers', `at most ${MAX_HEADERS} headers.`)
    for (const [k, v] of entries) {
      const key = k.trim()
      if (!HEADER_NAME.test(key)) return bad('invalid_headers', `"${k}" is not a valid header name.`)
      if (typeof v !== 'string') return bad('invalid_headers', `header ${key} must be a string.`)
      if (/[\r\n]/.test(v)) return bad('invalid_headers', `header ${key} may not contain line breaks.`)
      if (v.length > MAX_HEADER_VALUE_LENGTH) return bad('invalid_headers', `header ${key} is longer than ${MAX_HEADER_VALUE_LENGTH} characters.`)
      if (FORBIDDEN_HEADERS.has(key.toLowerCase())) {
        return bad('forbidden_header', `${key} is set by the platform and cannot be sent from here.`)
      }
      headers[key.toLowerCase()] = v
    }
  }

  let body: string | undefined
  if (b.body !== undefined && b.body !== null && b.body !== '') {
    if (typeof b.body !== 'string') return bad('invalid_body', 'body must be a string (send JSON as text).')
    if (method === 'GET' || method === 'HEAD') return bad('body_not_allowed', `${method} requests carry no body.`)
    if (byteLength(b.body) > MAX_REQUEST_BODY_BYTES) {
      return bad('body_too_large', `body is larger than ${MAX_REQUEST_BODY_BYTES / 1024} KiB.`)
    }
    body = b.body
  }

  const t = typeof b.timeoutMs === 'number' && Number.isFinite(b.timeoutMs) ? b.timeoutMs : DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(t)))

  return { ok: true, request: { namespace, name, method: method as InvokeMethod, path, headers, body, timeoutMs } }
}

/* ─────────────────────────── where a function answers ─────────────────────────── */

/** The subset of a Function XR the invoke route reads. */
export interface InvokableFunction {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  spec?: { parameters?: { hostname?: string; visibility?: string; environment?: string } }
  status?: { url?: string; address?: string }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * May the console dial `raw` on behalf of this Function? Only plain http(s)
 * URLs without credentials, on a host that is either the Function's own
 * cluster-local Service (`<name>.<namespace>.svc[.cluster.local]`, what
 * Knative publishes as its address) or a name under the platform's domain
 * (where the Gateway publishes functions). Never an IP literal.
 */
export function isAllowedTarget(raw: string, fn: { name: string; namespace: string }, baseDomain?: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || IPV4.test(host) || host.includes(':') || host.startsWith('[')) return false
  const local = [`${fn.name}.${fn.namespace}.svc.cluster.local`, `${fn.name}.${fn.namespace}.svc`]
  if (local.includes(host)) return true
  const base = (baseDomain ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\.+|\.+$/g, '')
  return Boolean(base) && host.endsWith(`.${base}`)
}

/** The environment a Function serves, as the platform labels it. */
function environmentOf(fn: InvokableFunction): string | undefined {
  const env = fn.metadata.labels?.['adhar.io/environment'] ?? fn.spec?.parameters?.environment
  if (env) return env
  const ns = fn.metadata.namespace ?? ''
  return ['dev', 'test', 'prod'].includes(ns) ? ns : undefined
}

/**
 * Where to call the Function, best first: its published URL, then (when the
 * platform has not written one yet) the platform route the composition will
 * publish it on, then its in-cluster address. Every candidate passes
 * `isAllowedTarget`; the list is empty when there is nowhere safe to go.
 */
export function invokeTargets(fn: InvokableFunction, baseDomain?: string): string[] {
  const name = fn.metadata.name
  const namespace = fn.metadata.namespace ?? ''
  const params = fn.spec?.parameters ?? {}
  const out: string[] = []
  const add = (u: string | undefined) => {
    const v = (u ?? '').trim().replace(/\/+$/, '')
    if (v && !out.includes(v) && isAllowedTarget(v, { name, namespace }, baseDomain)) out.push(v)
  }
  add(fn.status?.url)
  if (!fn.status?.url && params.visibility !== 'cluster') {
    if (params.hostname) add(`https://${params.hostname}`)
    const env = environmentOf(fn)
    if (env && baseDomain) add(`https://${platformRouteHost(name, env, baseDomain)}`)
  }
  add(fn.status?.address)
  if (namespace) add(`http://${name}.${namespace}.svc.cluster.local`)
  return out
}

/** `base` + `path` (which starts with `/`), never doubling the slash. */
export function joinTarget(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

/* ─────────────────────────── headers and bodies ─────────────────────────── */

/** The request headers sent upstream: the caller's (validated) plus the console's agent. */
export function upstreamHeaders(request: Pick<InvokeRequest, 'headers' | 'body'>): Record<string, string> {
  const out: Record<string, string> = { 'user-agent': 'adhar-console-invoke', ...request.headers }
  if (request.body !== undefined && !out['content-type']) out['content-type'] = 'application/json'
  return out
}

/** The response headers handed back: lower-cased, cookies dropped, at most 64. */
export function responseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  let n = 0
  h.forEach((value, key) => {
    const k = key.toLowerCase()
    if (DROPPED_RESPONSE_HEADERS.has(k) || n >= 64) return
    out[k] = value
    n++
  })
  return out
}

/** Bodies that are shown as text; anything else is reported by size only. */
export function isTextual(contentType: string | null | undefined): boolean {
  const ct = (contentType ?? '').toLowerCase()
  if (!ct) return true
  return /^text\/|json|xml|javascript|yaml|x-www-form-urlencoded|graphql|event-stream/.test(ct)
}

/** Read at most `cap` bytes of a body, then stop reading. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  cap = MAX_RESPONSE_BODY_BYTES,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      if (size + value.length > cap) {
        chunks.push(value.subarray(0, cap - size))
        size = cap
        truncated = true
        break
      }
      chunks.push(value)
      size += value.length
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {})
    else reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.length
  }
  return { bytes, truncated }
}
