/**
 * Thin, strongly-typed HTTP client used by every Adhar Console API wrapper
 * (k8s, Gitea, Plane, Harbor, LGTM, Workspace).
 *
 * Design goals:
 *   • No framework dependency — `fetch` only, works in browsers, Deno, Node.
 *   • Zero `this`-detachment bugs — we never cache `window.fetch` as a
 *     property; see `callFetch` for why.
 *   • Absolute + path-only `baseUrl` both supported (production points at a
 *     BFF origin; dev proxies a path like `/kube-api`).
 *   • Request-level timeout + caller-supplied `AbortSignal` both honoured.
 *   • Error taxonomy: `HttpError` (response-level) vs `NetworkError`
 *     (connect/DNS/offline) vs `TimeoutError` so callers can react sensibly.
 *   • Content-negotiation aware: JSON paths auto-parse, log endpoints return
 *     text, and callers can opt into `raw` for binary.
 */

export interface HttpClientOptions {
  /** Absolute URL (`https://api.example.com/v1`) or path-only (`/kube-api`). */
  baseUrl: string
  /** Optional bearer token — set as `Authorization: Bearer <token>`. */
  token?: string
  /** Extra default headers merged onto every request. */
  headers?: Record<string, string>
  /** Default per-request timeout in ms. Defaults to 30 s. `0` disables. */
  timeoutMs?: number
  /** Optional override — useful for server-side Deno contexts or tests. */
  fetchImpl?: typeof fetch
  /** Credentials mode passed to every fetch call. Defaults to `same-origin`. */
  credentials?: RequestCredentials
}

export interface RequestOptions {
  query?: QueryParams
  body?: unknown
  /** Override the request timeout for this call only. */
  timeoutMs?: number
  /** Additional `AbortSignal` to merge with the internal timeout signal. */
  signal?: AbortSignal
  /** Extra headers just for this request. */
  headers?: Record<string, string>
  /**
   * Response handling. `json` (default) parses the body; `text` returns the
   * raw text (used by `podLogs`); `raw` returns the Response untouched.
   */
  response?: 'json' | 'text' | 'raw'
}

export type QueryParams = Record<string, string | number | boolean | undefined>

/** Thrown on any non-2xx response. Always includes parsed body if JSON. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: unknown,
    public url: string,
    public method: string,
  ) {
    super(
      typeof body === 'object' && body && 'message' in body
        ? `HTTP ${status} ${statusText} at ${method} ${url} — ${String((body as { message: unknown }).message)}`
        : `HTTP ${status} ${statusText} at ${method} ${url}`,
    )
    this.name = 'HttpError'
  }
}

/** Thrown when the request aborts due to the internal timeout. */
export class TimeoutError extends Error {
  constructor(
    public url: string,
    public method: string,
    public timeoutMs: number,
  ) {
    super(`Request timed out after ${timeoutMs}ms: ${method} ${url}`)
    this.name = 'TimeoutError'
  }
}

/** Thrown when `fetch` itself rejects — DNS, offline, CORS preflight, TLS. */
export class NetworkError extends Error {
  constructor(
    public url: string,
    public method: string,
    public cause: unknown,
  ) {
    super(
      `Network error: ${method} ${url}${cause instanceof Error ? ` — ${cause.message}` : ''}`,
    )
    this.name = 'NetworkError'
  }
}

/**
 * Browser-only "session expired" signal. Mirrors shell-ui's `notifyUnauthorized`
 * but inlined here to avoid a UI dependency in the base HTTP layer — the host
 * shell listens for the same `adhar:unauthorized` event and redirects to login.
 */
let lastUnauthorizedAt = 0
function signalUnauthorized(): void {
  if (typeof document === 'undefined') return
  const g = globalThis as unknown as {
    dispatchEvent?: (e: Event) => boolean
    CustomEvent?: typeof CustomEvent
  }
  if (typeof g.dispatchEvent !== 'function' || typeof g.CustomEvent !== 'function') return
  const now = Date.now()
  if (now - lastUnauthorizedAt < 1500) return
  lastUnauthorizedAt = now
  try {
    g.dispatchEvent(new g.CustomEvent('adhar:unauthorized'))
  } catch {
    /* ignore */
  }
}

export class HttpClient {
  private readonly baseUrl: string
  private readonly defaultHeaders: Record<string, string>
  private readonly timeoutMs: number
  private readonly fetchImpl?: typeof fetch
  private readonly credentials: RequestCredentials

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.defaultHeaders = {
      accept: 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    }
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.fetchImpl = opts.fetchImpl
    this.credentials = opts.credentials ?? 'same-origin'
  }

  /** Main entry — every verb helper funnels through here. */
  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query)
    const hasBody = opts.body !== undefined
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...opts.headers,
    }
    if (hasBody && !headers['content-type']) headers['content-type'] = 'application/json'

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    const signal = timeoutMs > 0 ? mergeSignals(controller.signal, opts.signal) : opts.signal
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new TimeoutError(url, method, timeoutMs)), timeoutMs) : undefined

    let res: Response
    try {
      res = await this.callFetch(url, {
        method,
        headers,
        body: hasBody ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
        credentials: this.credentials,
        signal,
      })
    } catch (err) {
      if (err instanceof TimeoutError) throw err
      if (isAbortError(err)) {
        if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
          throw controller.signal.reason
        }
        throw err // caller-supplied abort — let it propagate as-is
      }
      throw new NetworkError(url, method, err)
    } finally {
      if (timer) clearTimeout(timer)
    }

    // Response handling branches by opts.response + content-type.
    if (opts.response === 'raw') {
      if (!res.ok) {
        if (res.status === 401) signalUnauthorized()
        throw new HttpError(res.status, res.statusText, await safeBody(res), url, method)
      }
      return res as unknown as T
    }

    const ct = res.headers.get('content-type') ?? ''
    const isJson = ct.includes('application/json')
    const wantText = opts.response === 'text' || !isJson

    const text = await res.text()
    const parsed = wantText ? text : text ? safeJson(text) : undefined

    if (!res.ok) {
      if (res.status === 401) signalUnauthorized()
      throw new HttpError(res.status, res.statusText, parsed ?? text, url, method)
    }
    return parsed as T
  }

  /**
   * Build the absolute request URL from `baseUrl + path` + query params.
   *
   * Two WHATWG URL gotchas this works around:
   *   1. `new URL('/x', '/prefix/')` throws — the base must be an absolute URL
   *      (protocol + host). A bare path baseUrl like `/kube-api` needs the
   *      current origin prepended first.
   *   2. `new URL('/x', 'http://host/prefix/')` → `http://host/x`, NOT
   *      `http://host/prefix/x` — absolute paths replace the whole base path.
   *      So we always string-concatenate `baseUrl + path` up-front before
   *      parsing.
   */
  private buildUrl(path: string, query?: QueryParams): string {
    const suffix = path.startsWith('/') ? path : `/${path}`
    const combined = this.baseUrl + suffix
    const isAbsolute = /^https?:\/\//i.test(combined)
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : typeof globalThis !== 'undefined' && (globalThis as { location?: Location }).location?.origin
          ? (globalThis as { location: Location }).location.origin
          : 'http://127.0.0.1'
    const url = new URL(combined, isAbsolute ? undefined : origin)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }
    return url.toString()
  }

  /**
   * Invoke `fetch` safely.
   *
   * `window.fetch` is a method on the `Window` object and MUST be called with
   * `Window` as its `this`. Detaching it — e.g. `const f = window.fetch;
   * f(url)` or `this.fetchImpl = fetch; this.fetchImpl(url)` — causes
   * "Failed to execute 'fetch' on 'Window': Illegal invocation".
   *
   * We therefore either:
   *   - call the user-supplied `fetchImpl` (which they've already bound), or
   *   - call `globalThis.fetch` **directly as a property access** so the
   *     browser resolves `this` to Window (never `this.fetchImpl`).
   */
  private callFetch(url: string, init: RequestInit): Promise<Response> {
    if (this.fetchImpl) return this.fetchImpl(url, init)
    return globalThis.fetch(url, init)
  }

  /* ───── verb helpers ───── */

  get<T>(path: string, opts?: Omit<RequestOptions, 'body'>) {
    return this.request<T>('GET', path, opts)
  }
  post<T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) {
    return this.request<T>('POST', path, { ...opts, body })
  }
  put<T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) {
    return this.request<T>('PUT', path, { ...opts, body })
  }
  patch<T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) {
    return this.request<T>('PATCH', path, { ...opts, body })
  }
  delete<T>(path: string, opts?: Omit<RequestOptions, 'body'>) {
    return this.request<T>('DELETE', path, opts)
  }
}

/* ───── helpers ───── */

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text()
    return text ? safeJson(text) : undefined
  } catch {
    return undefined
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * Combine our internal timeout signal with a caller-supplied one so either
 * cancels the in-flight request. `AbortSignal.any` is the right tool but has
 * limited browser support (Safari < 17), so we fall back to a manual listener.
 */
function mergeSignals(internal: AbortSignal, external?: AbortSignal): AbortSignal {
  if (!external) return internal
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([internal, external])
  }
  const controller = new AbortController()
  const forward = (src: AbortSignal) => () => controller.abort((src as { reason?: unknown }).reason)
  if (internal.aborted) controller.abort((internal as { reason?: unknown }).reason)
  else internal.addEventListener('abort', forward(internal), { once: true })
  if (external.aborted) controller.abort((external as { reason?: unknown }).reason)
  else external.addEventListener('abort', forward(external), { once: true })
  return controller.signal
}
