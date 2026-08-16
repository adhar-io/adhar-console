/**
 * Browser client for the console's Kubernetes gateway (`/api/k8s/*`).
 *
 * The gateway is a discovery-driven, streaming reverse proxy to the
 * kube-apiserver authenticated as the signed-in user (per-user RBAC). This
 * module is a thin, typed wrapper — it builds apiserver paths from a GVR and
 * handles the two streaming shapes the apiserver speaks:
 *   - **watch**: newline-delimited JSON (`{type, object}`) — `watch()`.
 *   - **log follow**: raw text chunks — `logStream()`.
 *
 * All requests are same-origin with the session cookie; no token touches the
 * browser.
 */

export interface GVR {
  group: string
  version: string
  resource: string
  namespaced?: boolean
}

export interface KubeMeta {
  name: string
  namespace?: string
  uid?: string
  resourceVersion?: string
  creationTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid: string }>
  deletionTimestamp?: string
}

export interface KubeObject<S = unknown, T = unknown> {
  apiVersion?: string
  kind?: string
  metadata: KubeMeta
  spec?: S
  status?: T
  [k: string]: unknown
}

export interface KubeList<T> {
  apiVersion?: string
  kind?: string
  metadata: { resourceVersion?: string; continue?: string }
  items: T[]
}

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'
export interface WatchEvent<T> {
  type: WatchEventType
  object: T
}

export interface DiscoveredResource {
  group: string
  version: string
  groupVersion: string
  kind: string
  name: string
  singularName?: string
  namespaced: boolean
  verbs: string[]
  shortNames?: string[]
  categories?: string[]
  subresource: boolean
}

const BASE = '/api/k8s'

function root(gvr: GVR): string {
  return gvr.group === '' || gvr.group === 'core'
    ? `/api/${gvr.version}`
    : `/apis/${gvr.group}/${gvr.version}`
}

/** Collection or single-object path for a GVR. */
export function resourcePath(gvr: GVR, opts: { namespace?: string; name?: string } = {}): string {
  const ns = gvr.namespaced && opts.namespace ? `/namespaces/${encodeURIComponent(opts.namespace)}` : ''
  const name = opts.name ? `/${encodeURIComponent(opts.name)}` : ''
  return `${root(gvr)}${ns}/${gvr.resource}${name}`
}

interface ListOpts {
  namespace?: string
  labelSelector?: string
  fieldSelector?: string
  limit?: number
  continue?: string
  /** Named cluster from the gateway's `K8S_CLUSTERS` map. Unset → default cluster. */
  cluster?: string
}

function listQuery(opts: ListOpts, extra?: Record<string, string>): string {
  const q = new URLSearchParams()
  if (opts.labelSelector) q.set('labelSelector', opts.labelSelector)
  if (opts.fieldSelector) q.set('fieldSelector', opts.fieldSelector)
  if (opts.limit) q.set('limit', String(opts.limit))
  if (opts.continue) q.set('continue', opts.continue)
  if (opts.cluster) q.set('cluster', opts.cluster)
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v)
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** Kubernetes apiserver `Status` body — the subset the console cares about. */
export interface K8sStatusBody {
  kind?: string
  apiVersion?: string
  status?: string
  message?: string
  reason?: string
  code?: number
  details?: { retryAfterSeconds?: number; name?: string; kind?: string; [k: string]: unknown }
  [k: string]: unknown
}

/** HTTP statuses that indicate a transient apiserver condition worth retrying. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * Typed Kubernetes error. Carries the parsed apiserver `Status` fields
 * (`reason`, `code`) plus a `retryable` hint so callers — and the built-in
 * bounded retry for idempotent reads — can react without string-matching.
 *
 * `status === 0` means the request never got an HTTP response (network/TLS/
 * abort); `reason` then distinguishes `NetworkError` / `TLSError` / `Timeout` /
 * `Aborted`.
 */
export class K8sError extends Error {
  /** Apiserver `Status.reason` (NotFound, Forbidden, Conflict, TooManyRequests…). */
  reason?: string
  /** Apiserver `Status.code` — usually mirrors the HTTP status. */
  code?: number
  /** True for transient failures that idempotent reads may safely retry. */
  retryable: boolean
  /** Server-suggested pause before retrying (from `Retry-After` / Status details). */
  retryAfterSeconds?: number

  constructor(
    public status: number,
    message: string,
    public body?: unknown,
    opts: { reason?: string; code?: number; retryable?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(message)
    this.name = 'K8sError'
    this.reason = opts.reason
    this.code = opts.code ?? (status || undefined)
    this.retryable = opts.retryable ?? TRANSIENT_STATUS.has(status)
    this.retryAfterSeconds = opts.retryAfterSeconds
  }

  get isNotFound(): boolean {
    return this.status === 404 || this.reason === 'NotFound'
  }
  get isForbidden(): boolean {
    return this.status === 403 || this.reason === 'Forbidden'
  }
  get isConflict(): boolean {
    return this.status === 409 || this.reason === 'Conflict'
  }

  /** Build from an HTTP status + a (possibly) apiserver `Status` body. */
  static fromStatus(
    status: number,
    body: unknown,
    fallbackMessage?: string,
    retryAfterHeader?: string | null,
  ): K8sError {
    const s = (typeof body === 'object' && body !== null ? body : {}) as K8sStatusBody
    const message =
      typeof s.message === 'string' && s.message
        ? s.message
        : fallbackMessage ?? `Kubernetes request failed (${status})`
    const headerSecs = retryAfterHeader != null ? Number(retryAfterHeader) : NaN
    const retryAfterSeconds =
      Number.isFinite(headerSecs) && headerSecs >= 0 ? headerSecs : s.details?.retryAfterSeconds
    return new K8sError(status, message, body, {
      reason: typeof s.reason === 'string' ? s.reason : undefined,
      code: typeof s.code === 'number' ? s.code : undefined,
      retryAfterSeconds,
    })
  }
}

export interface RetryPolicy {
  /** Total attempts including the first (default 3). */
  attempts?: number
  /** Backoff base in ms — attempt n waits rand(0, min(cap, base·2ⁿ⁻¹)) (default 250). */
  baseMs?: number
  /** Backoff ceiling in ms (default 2 000). */
  capMs?: number
  /** Ceiling for honouring a server-provided Retry-After (default 10 000). */
  retryAfterCapMs?: number
}

/**
 * Bounded, full-jitter retry for **idempotent reads only**. Retries errors the
 * normalizer marks `retryable` (429 / transient 5xx / network failures),
 * honours `Retry-After` when the server sent one, and always rethrows a
 * `K8sError`. Mutations must never go through this.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  normalize: (e: unknown) => K8sError,
  policy: RetryPolicy = {},
): Promise<T> {
  const attempts = policy.attempts ?? 3
  const baseMs = policy.baseMs ?? 250
  const capMs = policy.capMs ?? 2_000
  const retryAfterCapMs = policy.retryAfterCapMs ?? 10_000
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      const err = normalize(e)
      if (!err.retryable || attempt >= attempts) throw err
      const waitMs =
        err.retryAfterSeconds && err.retryAfterSeconds > 0
          ? Math.min(err.retryAfterSeconds * 1000, retryAfterCapMs)
          : Math.random() * Math.min(capMs, baseMs * 2 ** (attempt - 1))
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}

/** Normalize a browser fetch failure into a K8sError (status 0 = no response). */
function normalizeError(e: unknown): K8sError {
  if (e instanceof K8sError) return e
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new K8sError(0, 'Request aborted', undefined, { reason: 'Aborted', retryable: false })
  }
  return new K8sError(0, e instanceof Error ? e.message : String(e), undefined, {
    reason: 'NetworkError',
    retryable: true,
  })
}

function parseMaybeJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function reqOnce<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  const body = parseMaybeJson(text)
  if (!res.ok) {
    throw K8sError.fromStatus(
      res.status,
      body,
      `${res.status} ${res.statusText}`,
      res.headers.get('retry-after'),
    )
  }
  return body as T
}

/**
 * Gateway request. GETs get a bounded jittered retry on transient failures
 * (429 with Retry-After, 502/503/504, network errors); every other verb is a
 * mutation and fails fast on the first error — never retried.
 */
function req<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    return reqOnce<T>(path, init).catch((e) => {
      throw normalizeError(e)
    })
  }
  return retryTransient(() => reqOnce<T>(path, init), normalizeError)
}

/** `?cluster=<name>` suffix for meta/plain paths (no other query params). */
function clusterQ(cluster?: string): string {
  return cluster ? `?cluster=${encodeURIComponent(cluster)}` : ''
}

export const kube = {
  /** Full API discovery (built-ins + every CRD). Cached server-side. */
  discovery(opts: { cluster?: string } = {}): Promise<{ resources: DiscoveredResource[]; cached: boolean }> {
    return req(`/-/discovery${clusterQ(opts.cluster)}`)
  },

  /** Clusters configured on the gateway (`K8S_CLUSTERS`) — single default when unset. */
  clusters(): Promise<{ clusters: Array<{ name: string; default: boolean }> }> {
    return req(`/-/clusters`)
  },

  /** Cluster server version (`/version`) — a cheap connectivity + auth probe. */
  serverVersion(
    opts: { cluster?: string } = {},
  ): Promise<{ major?: string; minor?: string; gitVersion?: string; platform?: string }> {
    return req(`/version${clusterQ(opts.cluster)}`)
  },

  /** `/healthz` liveness probe. Never throws — returns a typed verdict. */
  async healthz(opts: { cluster?: string } = {}): Promise<{ healthy: boolean; error?: string }> {
    try {
      await req<string>(`/healthz${clusterQ(opts.cluster)}`)
      return { healthy: true }
    } catch (e) {
      return { healthy: false, error: e instanceof Error ? e.message : String(e) }
    }
  },

  list<T = KubeObject>(gvr: GVR, opts: ListOpts = {}): Promise<KubeList<T>> {
    return req(`${resourcePath(gvr, { namespace: opts.namespace })}${listQuery(opts)}`)
  },

  get<T = KubeObject>(
    gvr: GVR,
    namespace: string | undefined,
    name: string,
    opts: { cluster?: string } = {},
  ): Promise<T> {
    return req(`${resourcePath(gvr, { namespace, name })}${clusterQ(opts.cluster)}`)
  },

  delete<T = unknown>(
    gvr: GVR,
    namespace: string | undefined,
    name: string,
    opts: {
      propagationPolicy?: 'Foreground' | 'Background' | 'Orphan'
      cluster?: string
    } = {},
  ): Promise<T> {
    const q = new URLSearchParams()
    if (opts.propagationPolicy) q.set('propagationPolicy', opts.propagationPolicy)
    if (opts.cluster) q.set('cluster', opts.cluster)
    const s = q.toString()
    return req(`${resourcePath(gvr, { namespace, name })}${s ? `?${s}` : ''}`, { method: 'DELETE' })
  },

  /** JSON-merge patch (e.g. scale, annotate). */
  patch<T = KubeObject>(
    gvr: GVR,
    namespace: string | undefined,
    name: string,
    patch: unknown,
    type: 'merge' | 'json' | 'strategic' = 'merge',
    opts: { cluster?: string } = {},
  ): Promise<T> {
    const ct =
      type === 'json'
        ? 'application/json-patch+json'
        : type === 'strategic'
          ? 'application/strategic-merge-patch+json'
          : 'application/merge-patch+json'
    return req(`${resourcePath(gvr, { namespace, name })}${clusterQ(opts.cluster)}`, {
      method: 'PATCH',
      headers: { 'content-type': ct },
      body: JSON.stringify(patch),
    })
  },

  /** Server-side apply from a full manifest. Supports dry-run. */
  apply<T = KubeObject>(
    manifest: KubeObject,
    opts: { dryRun?: boolean; force?: boolean; cluster?: string } = {},
  ): Promise<T> {
    return req(`/-/apply${clusterQ(opts.cluster)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest, dryRun: opts.dryRun, force: opts.force }),
    })
  },

  /** Can the current user do <verb> on <resource>? (SelfSubjectAccessReview) */
  access(
    attrs: {
      verb: string
      group?: string
      resource: string
      namespace?: string
      name?: string
      subresource?: string
    },
    opts: { cluster?: string } = {},
  ): Promise<{ allowed: boolean }> {
    return req(`/-/access${clusterQ(opts.cluster)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(attrs),
    })
  },

  /**
   * Watch a collection. Reads the apiserver's NDJSON stream and calls `onEvent`
   * for each delta. Resolves when the stream ends (server closes / abort).
   * Pass `signal` (AbortController) to stop.
   */
  async watch<T = KubeObject>(
    gvr: GVR,
    opts: ListOpts & { resourceVersion?: string; signal?: AbortSignal },
    onEvent: (e: WatchEvent<T>) => void,
  ): Promise<void> {
    const extra: Record<string, string> = { watch: '1', allowWatchBookmarks: 'true' }
    if (opts.resourceVersion) extra.resourceVersion = opts.resourceVersion
    const path = `${resourcePath(gvr, { namespace: opts.namespace })}${listQuery(opts, extra)}`
    const res = await fetch(`${BASE}${path}`, { credentials: 'include', signal: opts.signal })
    if (!res.ok || !res.body) {
      const body = parseMaybeJson(await res.text().catch(() => ''))
      throw K8sError.fromStatus(res.status, body, `watch failed: ${res.status}`, res.headers.get('retry-after'))
    }
    await readNdjson(res.body, (line) => {
      try {
        onEvent(JSON.parse(line) as WatchEvent<T>)
      } catch {
        /* skip malformed line */
      }
    })
  },

  /**
   * Stream pod logs. When `follow`, resolves only when the stream ends; call
   * `onChunk` with each text chunk. Returns the text for non-follow.
   */
  async logStream(
    namespace: string,
    pod: string,
    opts: { container?: string; follow?: boolean; tailLines?: number; timestamps?: boolean; previous?: boolean; sinceSeconds?: number; signal?: AbortSignal; cluster?: string } = {},
    onChunk?: (text: string) => void,
  ): Promise<string> {
    const q = new URLSearchParams()
    if (opts.container) q.set('container', opts.container)
    if (opts.follow) q.set('follow', 'true')
    if (opts.tailLines) q.set('tailLines', String(opts.tailLines))
    if (opts.timestamps) q.set('timestamps', 'true')
    if (opts.previous) q.set('previous', 'true')
    if (opts.sinceSeconds) q.set('sinceSeconds', String(opts.sinceSeconds))
    if (opts.cluster) q.set('cluster', opts.cluster)
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${q}`
    const res = await fetch(`${BASE}${path}`, { credentials: 'include', signal: opts.signal })
    if (!res.ok || !res.body) {
      const body = parseMaybeJson(await res.text().catch(() => ''))
      throw K8sError.fromStatus(res.status, body, `logs failed: ${res.status}`, res.headers.get('retry-after'))
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let all = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        all += value
        onChunk?.(value)
      }
    }
    return all
  },
}

/* ─────────── exec (terminal) ─────────── */

export interface PodExecSession {
  /** Send stdin bytes (channel 0). */
  write(data: string | Uint8Array): void
  /** Send a TTY resize (channel 4). */
  resize(cols: number, rows: number): void
  /** stdout/stderr text (channels 1 + 2). */
  onData(cb: (text: string) => void): void
  onClose(cb: (info: { code: number; reason: string }) => void): void
  onError(cb: (err: Event) => void): void
  close(): void
  readonly socket: WebSocket
}

/**
 * Open an interactive exec session to a pod container. Speaks the apiserver's
 * `v5.channel.k8s.io` binary channel protocol directly (the gateway relays it
 * verbatim). Pair with an xterm terminal: `term.onData(s.write)` +
 * `s.onData(term.write)` + `s.resize(cols, rows)`.
 */
export function execPod(opts: {
  namespace: string
  pod: string
  container?: string
  command?: string[]
  tty?: boolean
  /** Named cluster from the gateway's `K8S_CLUSTERS` map. Unset → default cluster. */
  cluster?: string
}): PodExecSession {
  const q = new URLSearchParams({ namespace: opts.namespace, pod: opts.pod, tty: String(opts.tty ?? true) })
  if (opts.container) q.set('container', opts.container)
  if (opts.cluster) q.set('cluster', opts.cluster)
  for (const c of opts.command ?? []) q.append('command', c)
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${location.host}${BASE}/exec?${q}`, ['v5.channel.k8s.io'])
  ws.binaryType = 'arraybuffer'
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  let dataCb: (t: string) => void = () => {}

  ws.onmessage = (e) => {
    const buf = new Uint8Array(e.data as ArrayBuffer)
    if (buf.length < 1) return
    const channel = buf[0]
    // 1 = stdout, 2 = stderr, 3 = error/status stream.
    if (channel === 1 || channel === 2 || channel === 3) dataCb(dec.decode(buf.subarray(1)))
  }

  const frame = (channel: number, payload: Uint8Array) => {
    const out = new Uint8Array(payload.length + 1)
    out[0] = channel
    out.set(payload, 1)
    return out
  }

  return {
    socket: ws,
    write(data) {
      if (ws.readyState !== WebSocket.OPEN) return
      const bytes = typeof data === 'string' ? enc.encode(data) : data
      ws.send(frame(0, bytes))
    },
    resize(cols, rows) {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(frame(4, enc.encode(JSON.stringify({ Width: cols, Height: rows }))))
    },
    onData(cb) {
      dataCb = cb
    },
    onClose(cb) {
      ws.addEventListener('close', (e) => cb({ code: e.code, reason: e.reason }))
    },
    onError(cb) {
      ws.addEventListener('error', cb)
    },
    close() {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    },
  }
}

/** Read a ReadableStream of bytes as newline-delimited text lines. */
async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) onLine(line)
    }
  }
  if (buf.trim()) onLine(buf.trim())
}
