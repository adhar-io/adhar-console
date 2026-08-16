import { env } from '@adhar-console/utils'
import { getServerAuthConfig, getValidSession } from '@adhar-console/auth/server'

/**
 * Kubernetes gateway — the server-side bridge between the browser and the
 * cluster's kube-apiserver.
 *
 * Design (mature, "better than a hardcoded client"):
 *   - **Discovery-driven & generic.** Instead of one endpoint per resource, the
 *     gateway transparently proxies the FULL apiserver REST surface at
 *     `/api/k8s/<apiserver-path>` — every built-in resource AND every CRD, with
 *     every verb (get/list/create/update/patch/delete). New CRDs work with zero
 *     code.
 *   - **Streaming.** `?watch=1` (live list deltas, NDJSON) and pod `log?follow=1`
 *     pass straight through as a streaming response — no buffering, no polling.
 *   - **Per-user identity.** The signed-in user's Keycloak access token (which
 *     carries the `adhar-cli` audience + `groups` claim) is forwarded as the
 *     Bearer, so the apiserver enforces that user's RBAC and native audit — the
 *     console holds no cluster privilege of its own.
 *   - **Meta endpoints** under `/api/k8s/-/…`: aggregated discovery, access
 *     review, server-side apply, and the configured cluster list.
 *   - **Multi-cluster ready.** `K8S_CLUSTERS` (JSON `[{name, apiUrl, default?}]`)
 *     registers named clusters; any request may pick one with `?cluster=<name>`.
 *     Unset → single-cluster `K8S_API_URL` behaviour, byte-for-byte unchanged.
 *
 * The apiserver + the user's RBAC are the authorization boundary; the gateway
 * itself is intentionally permissive (it only adds identity + streaming).
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
 * Strict allow-list of request headers we forward to the apiserver. A denylist
 * is unsafe here: the console injects the user's identity via the Bearer token,
 * so anything a client could set that the apiserver trusts — above all
 * `Impersonate-User`/`Impersonate-Group`/`Impersonate-Uid` — must NOT ride
 * through. Only these content-negotiation headers are ever forwarded.
 */
const FORWARD_HEADERS = new Set(['accept', 'accept-encoding', 'content-type'])

/** Max buffered request body (SSA manifests, patches). Guards against memory DoS. */
const MAX_BODY_BYTES = 3 * 1024 * 1024

/** Non-streaming upstream calls get a hard timeout; watch/follow stream instead. */
const UPSTREAM_TIMEOUT_MS = 30_000

/** True for streaming requests (watch list / log follow) that must not time out. */
function isStreaming(search: string): boolean {
  const q = new URLSearchParams(search)
  return q.get('watch') === '1' || q.get('watch') === 'true' || q.get('follow') === 'true'
}

/**
 * CSRF defense-in-depth. The session cookie is `SameSite=Lax`, but for
 * state-changing verbs we additionally reject any browser request whose `Origin`
 * isn't our own. A missing Origin (non-browser client, same-origin navigation)
 * is allowed — the cookie still gates it.
 */
export function originOk(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === new URL(req.url).host
  } catch {
    return false
  }
}

/** Structured audit line for the console tier (user + verb + resource + outcome). */
export function audit(entry: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'k8s.audit', ...entry }))
  } catch {
    // never let logging break a request
  }
}

/* ─────────────── cluster resolution (K8S_API_URL + K8S_CLUSTERS) ─────────────── */

export interface ClusterDef {
  name: string
  apiUrl: string
  default?: boolean
}

/** Selectors that always mean "the default cluster" (backward compatible). */
const DEFAULT_CLUSTER_ALIASES = new Set(['', 'default', 'local'])

let clustersParsed: { raw: string; clusters: ClusterDef[] } | null = null

/**
 * Parse `K8S_CLUSTERS` (JSON `[{name, apiUrl, default?}]`). Invalid JSON or
 * malformed entries are ignored with a server-side warning — never a crash.
 * Result is memoized per raw env value.
 */
export function parseClusters(): ClusterDef[] {
  const raw = env('K8S_CLUSTERS') ?? ''
  if (clustersParsed && clustersParsed.raw === raw) return clustersParsed.clusters
  let clusters: ClusterDef[] = []
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        clusters = parsed
          .filter(
            (c): c is { name: string; apiUrl: string; default?: unknown } =>
              typeof c === 'object' && c !== null &&
              typeof (c as { name?: unknown }).name === 'string' &&
              typeof (c as { apiUrl?: unknown }).apiUrl === 'string',
          )
          .map((c) => ({
            name: c.name,
            apiUrl: c.apiUrl.replace(/\/$/, ''),
            default: c.default === true,
          }))
      }
      if (!clusters.length) {
        console.warn('[k8s] K8S_CLUSTERS is set but has no valid {name, apiUrl} entries — ignoring')
      }
    } catch (e) {
      console.error('[k8s] K8S_CLUSTERS is not valid JSON — ignoring:', e instanceof Error ? e.message : e)
    }
  }
  clustersParsed = { raw, clusters }
  return clusters
}

/**
 * Resolve a `?cluster=` selector to an apiserver base URL.
 *   - Named cluster from `K8S_CLUSTERS` → its apiUrl.
 *   - Unset / `default` / `local` → `K8S_API_URL`, else the `K8S_CLUSTERS`
 *     entry marked default (or the first), else in-cluster DNS.
 *   - Unknown name → `null` (callers answer 400 — never silently fall back to
 *     a different cluster than the one the user asked for).
 */
export function resolveClusterBase(name?: string | null): string | null {
  const clusters = parseClusters()
  if (name != null && !DEFAULT_CLUSTER_ALIASES.has(name)) {
    const hit = clusters.find((c) => c.name === name)
    return hit ? hit.apiUrl : null
  }
  const envUrl = env('K8S_API_URL')
  if (envUrl) return envUrl.replace(/\/$/, '')
  const def = clusters.find((c) => c.default) ?? clusters[0]
  return def ? def.apiUrl : 'https://kubernetes.default.svc'
}

function apiServerBaseUrl(): string {
  // Default cluster — resolveClusterBase(undefined) never returns null.
  return resolveClusterBase(undefined) as string
}

export interface K8sIdentity {
  token: string
  user: { id: string; name: string; email: string }
  refreshedCookie?: string
}

/**
 * Short-TTL identity cache: session verification runs on EVERY gateway call
 * (hot path — list/watch/log all hit it), so a just-verified cookie is reused
 * for a few seconds. Entries are only cached when no cookie refresh was issued
 * (a refresh means the client is about to present a new cookie anyway). The
 * 10 s TTL bounds session-revocation lag to a window shorter than typical
 * token lifetimes.
 */
const ID_CACHE_TTL_MS = 10_000
const ID_CACHE_MAX = 512
const idCache = new Map<string, { at: number; id: K8sIdentity }>()

/**
 * Resolve the caller's Kubernetes identity (their Keycloak access token). When
 * `K8S_SA_TOKEN` is set (or an in-cluster SA token file exists) AND no user
 * session is present, we intentionally do NOT fall back to it for user-facing
 * calls — per-user impersonation is the security model. Returns null → 401.
 */
export async function resolveIdentity(req: Request): Promise<K8sIdentity | null> {
  const cfg = getServerAuthConfig()
  if (!cfg) return null
  const cookie = req.headers.get('cookie') ?? ''
  if (cookie) {
    const hit = idCache.get(cookie)
    if (hit && Date.now() - hit.at < ID_CACHE_TTL_MS) return hit.id
  }
  const result = await getValidSession(req, cfg)
  if (!result) return null
  const id: K8sIdentity = {
    token: result.session.accessToken,
    user: {
      id: result.session.user.id,
      name: result.session.user.name,
      email: result.session.user.email,
    },
    refreshedCookie: result.refreshedCookie,
  }
  if (cookie && !result.refreshedCookie) {
    if (idCache.size >= ID_CACHE_MAX) {
      const now = Date.now()
      for (const [k, v] of idCache) {
        if (now - v.at >= ID_CACHE_TTL_MS) idCache.delete(k)
      }
      // Still full of fresh entries → drop the oldest inserted.
      if (idCache.size >= ID_CACHE_MAX) {
        const oldest = idCache.keys().next().value
        if (oldest !== undefined) idCache.delete(oldest)
      }
    }
    idCache.set(cookie, { at: Date.now(), id })
  }
  return id
}

function unauthorized(): Response {
  return Response.json(
    { kind: 'Status', status: 'Failure', code: 401, reason: 'Unauthorized', message: 'Not signed in' },
    { status: 401 },
  )
}

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

/**
 * Low-level apiserver call with the given bearer token. Returns the raw
 * `Response` (body streamed) so watch/log-follow work without buffering.
 * `cluster` picks a named cluster from `K8S_CLUSTERS`; unset → default base.
 */
export function apiServerFetch(
  token: string,
  path: string,
  init: {
    method?: string
    body?: BodyInit | null
    headers?: Record<string, string>
    search?: string
    signal?: AbortSignal
    cluster?: string
  } = {},
): Promise<Response> {
  const base = resolveClusterBase(init.cluster)
  if (base === null) {
    return Promise.reject(new Error(`unknown cluster '${init.cluster}' — not in K8S_CLUSTERS`))
  }
  const clean = path.startsWith('/') ? path : `/${path}`
  const url = `${base}${clean}${init.search ?? ''}`
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  if (!headers.has('accept')) headers.set('accept', 'application/json')
  return fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body ?? undefined,
    redirect: 'manual',
    signal: init.signal,
  })
}

/**
 * Copy an apiserver Response back to the browser, dropping hop-by-hop headers.
 * Rate-limit metadata (`Retry-After` on 429, audit IDs, warnings) is NOT
 * hop-by-hop and passes through untouched so clients can back off correctly.
 */
function passthrough(upstream: Response, refreshedCookie?: string): Response {
  const headers = new Headers()
  for (const [k, v] of upstream.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'set-cookie') headers.set(k, v)
  }
  if (refreshedCookie) headers.append('set-cookie', refreshedCookie)
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  })
}

/**
 * Shape an upstream fetch failure into a client response. Logs internal detail
 * server-side; in dev the body carries the detail + a targeted hint (wrong
 * K8S_API_URL, missing DENO_CERT trust, apiserver down) — never in production.
 */
function upstreamFailure(
  e: unknown,
  ctx: { method: string; subpath: string; base: string; clientAborted: boolean },
): Response {
  const aborted = e instanceof DOMException && e.name === 'AbortError'
  if (aborted && ctx.clientAborted) {
    // Client went away — nothing to return.
    return new Response(null, { status: 499 })
  }
  const detailMsg = e instanceof Error ? e.message : String(e)
  console.error(`[k8s] upstream error ${ctx.method} /${ctx.subpath}:`, detailMsg)
  const dev = (env('NODE_ENV') ?? env('DENO_ENV')) !== 'production'
  return Response.json(
    {
      error: aborted ? 'apiserver_timeout' : 'apiserver_unreachable',
      ...(dev && !aborted
        ? {
            detail: detailMsg,
            apiUrl: ctx.base,
            hint: /certificate|self.signed|tls|ssl/i.test(detailMsg)
              ? 'TLS failure — set DENO_CERT to a bundle trusting the apiserver CA. See /api/diagnostics.'
              : 'Check K8S_API_URL points at your kube context server. See /api/diagnostics.',
          }
        : {}),
    },
    { status: aborted ? 504 : 502 },
  )
}

/* ── short-TTL cache for the API group listings (`/api`, `/apis`) ──
 * Discovery-adjacent, identical for every authenticated user (bound to the
 * system:discovery role), hit constantly by CRD-aware views. Same care as the
 * discovery cache: tiny TTL + in-flight de-dupe so a burst of tabs produces
 * one upstream call. Keyed per cluster; only 200s are cached. */
const GROUP_LIST_TTL_MS = 15_000
const groupListCache = new Map<string, { at: number; body: string }>()
const groupListInflight = new Map<string, Promise<string>>()

class UpstreamHttpError extends Error {
  constructor(public status: number, public bodyText: string, public contentType: string) {
    super(`upstream ${status}`)
    this.name = 'UpstreamHttpError'
  }
}

function groupListing(token: string, subpath: 'api' | 'apis', cluster?: string): Promise<string> {
  const key = `${cluster ?? ''}:${subpath}`
  const hit = groupListCache.get(key)
  if (hit && Date.now() - hit.at < GROUP_LIST_TTL_MS) return Promise.resolve(hit.body)
  const inflight = groupListInflight.get(key)
  if (inflight) return inflight
  // Deliberately NOT tied to the caller's req.signal — the fetch is shared, so
  // one departing client must not abort everyone else's request.
  const p = apiServerFetch(token, `/${subpath}`, {
    cluster,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
    .then(async (r) => {
      const text = await r.text()
      if (!r.ok) {
        throw new UpstreamHttpError(r.status, text, r.headers.get('content-type') ?? 'application/json')
      }
      groupListCache.set(key, { at: Date.now(), body: text })
      return text
    })
    .finally(() => groupListInflight.delete(key))
  groupListInflight.set(key, p)
  return p
}

/**
 * Main entry: dispatch `/api/k8s/<subpath>`.
 *   /api/k8s/-/discovery        → aggregated API discovery
 *   /api/k8s/-/access           → SelfSubjectAccessReview (POST)
 *   /api/k8s/-/rules            → SelfSubjectRulesReview for a namespace (POST)
 *   /api/k8s/-/apply            → server-side apply (POST)
 *   /api/k8s/-/clusters         → clusters configured via K8S_CLUSTERS
 *   /api/k8s/<api|apis|version|openapi/...>  → transparent apiserver proxy
 *
 * Every path accepts `?cluster=<name>` (stripped before forwarding upstream).
 */
export async function handleK8s(req: Request, subpath: string): Promise<Response> {
  const id = await resolveIdentity(req)
  if (!id) return unauthorized()

  const method = req.method.toUpperCase()
  const mutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'

  // CSRF defence-in-depth for state-changing verbs (meta apply/access included).
  if (mutating && !originOk(req)) {
    return Response.json({ error: 'origin_not_allowed' }, { status: 403 })
  }

  const url = new URL(req.url)

  // Validate the cluster selector up-front — an unknown name is a client error,
  // never a silent fallback to a different cluster.
  const clusterParam = url.searchParams.get('cluster') ?? undefined
  const clusterBase = resolveClusterBase(clusterParam)
  if (clusterBase === null) {
    return withCookie(
      Response.json({ error: 'unknown_cluster', cluster: clusterParam }, { status: 400 }),
      id.refreshedCookie,
    )
  }

  if (subpath.startsWith('-/')) {
    return withCookie(await handleMeta(req, subpath.slice(2), id, clusterParam), id.refreshedCookie)
  }

  // Transparent apiserver proxy — only allow real apiserver roots (defence in
  // depth; the base URL already fixes the host).
  if (!/^(api|apis|version|openapi|healthz|livez|readyz)(\/|$)/.test(subpath)) {
    return Response.json({ error: 'invalid_k8s_path' }, { status: 400 })
  }

  // `cluster` is gateway routing metadata — never forwarded upstream.
  const fwdParams = new URLSearchParams(url.search)
  fwdParams.delete('cluster')
  const search = fwdParams.toString() ? `?${fwdParams}` : ''

  // Cached, de-duplicated API group listings (`/api`, `/apis` with no query).
  if (method === 'GET' && (subpath === 'api' || subpath === 'apis') && !search) {
    try {
      const body = await groupListing(id.token, subpath, clusterParam)
      return withCookie(
        new Response(body, { headers: { 'content-type': 'application/json' } }),
        id.refreshedCookie,
      )
    } catch (e) {
      if (e instanceof UpstreamHttpError) {
        return withCookie(
          new Response(e.bodyText, { status: e.status, headers: { 'content-type': e.contentType } }),
          id.refreshedCookie,
        )
      }
      return upstreamFailure(e, { method, subpath, base: clusterBase, clientAborted: req.signal.aborted })
    }
  }

  // Strict allow-list — never forward Impersonate-*/auth/etc. (see FORWARD_HEADERS).
  const headers: Record<string, string> = {}
  for (const [k, v] of req.headers) {
    if (FORWARD_HEADERS.has(k.toLowerCase())) headers[k] = v
  }

  // Buffer the body under a hard cap (memory-DoS guard).
  let body: ArrayBuffer | undefined
  if (mutating) {
    const declared = Number(req.headers.get('content-length') ?? '0')
    if (declared > MAX_BODY_BYTES) {
      return Response.json({ error: 'request_entity_too_large', maxBytes: MAX_BODY_BYTES }, { status: 413 })
    }
    body = await req.arrayBuffer()
    if (body.byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: 'request_entity_too_large', maxBytes: MAX_BODY_BYTES }, { status: 413 })
    }
  }

  // Propagate client disconnect upstream; add a timeout for non-streaming calls
  // so a hung apiserver socket can't pin the connection forever. Streaming
  // (watch / log follow) is tied to req.signal ONLY: when the browser goes
  // away, the abort cancels the upstream fetch AND the passthrough body, so
  // long-lived streams never leak sockets or readers.
  const streaming = isStreaming(url.search)
  const signal = streaming
    ? req.signal
    : AbortSignal.any([req.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])

  const started = Date.now()
  let upstream: Response
  try {
    upstream = await apiServerFetch(id.token, `/${subpath}`, {
      method,
      headers,
      search,
      body,
      signal,
      cluster: clusterParam,
    })
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    if (mutating) {
      audit({
        user: id.user.id,
        method,
        path: subpath,
        ...(clusterParam ? { cluster: clusterParam } : {}),
        status: aborted ? 499 : 502,
        outcome: 'error',
        ms: Date.now() - started,
      })
    }
    return upstreamFailure(e, { method, subpath, base: clusterBase, clientAborted: req.signal.aborted })
  }
  if (mutating) {
    // Every mutating verb is audited with its outcome — success and failure.
    audit({
      user: id.user.id,
      method,
      path: subpath,
      ...(clusterParam ? { cluster: clusterParam } : {}),
      status: upstream.status,
      outcome: upstream.ok ? 'success' : 'failure',
      ms: Date.now() - started,
    })
  }
  // Streamed straight through — large LIST responses and watches are never
  // buffered in the gateway (Retry-After and friends survive; see passthrough).
  return passthrough(upstream, id.refreshedCookie)
}

/* ─────────────── meta endpoints ─────────────── */

async function handleMeta(
  req: Request,
  name: string,
  id: K8sIdentity,
  cluster?: string,
): Promise<Response> {
  switch (name) {
    case 'discovery':
      return discoveryResponse(id.token, cluster)
    case 'access':
      return accessReview(req, id.token, cluster)
    case 'rules':
      return rulesReview(req, id.token, cluster)
    case 'apply':
      return apply(req, id.token, id.user, cluster)
    case 'whoami':
      return Response.json({ user: id.user })
    case 'clusters':
      return clustersMeta()
    default:
      return Response.json({ error: 'unknown_meta', name }, { status: 404 })
  }
}

/** Clusters configured via K8S_CLUSTERS — names only, apiUrls stay server-side. */
function clustersMeta(): Response {
  const configured = parseClusters()
  if (!configured.length) {
    return Response.json({ clusters: [{ name: 'default', default: true }] })
  }
  const hasExplicitDefault = configured.some((c) => c.default)
  return Response.json({
    clusters: configured.map((c, i) => ({
      name: c.name,
      default: c.default || (!hasExplicitDefault && i === 0),
    })),
  })
}

/* ─────────────── discovery ─────────────── */

interface DiscoveredResource {
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
  /** True for subresources like pods/log (contains a slash). */
  subresource: boolean
}

const DISCOVERY_TTL_MS = 60_000
/** Per-cluster cache. Discovery output is identical for every authenticated
 * user (system:discovery), so it is deliberately not keyed by user. */
const discoveryCache = new Map<string, { at: number; data: DiscoveredResource[] }>()
/** In-flight de-dupe — N concurrent cold-cache callers → one upstream sweep. */
const discoveryInflight = new Map<string, Promise<DiscoveredResource[]>>()

async function loadDiscovery(token: string, cluster?: string): Promise<DiscoveredResource[]> {
  const key = cluster ?? ''
  const hit = discoveryCache.get(key)
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.data
  const inflight = discoveryInflight.get(key)
  if (inflight) return inflight

  const p = (async () => {
    const okJson = async (r: Response) => {
      if (!r.ok) throw new Error(`discovery upstream ${r.status}`)
      return r.json()
    }
    const [coreRes, groupsRes] = await Promise.all([
      apiServerFetch(token, '/api/v1', { cluster }).then(okJson),
      apiServerFetch(token, '/apis', { cluster }).then(okJson),
    ])
    const groupVersions: string[] = ['v1']
    for (const g of (groupsRes.groups ?? []) as Array<{ preferredVersion?: { groupVersion: string } }>) {
      if (g.preferredVersion?.groupVersion) groupVersions.push(g.preferredVersion.groupVersion)
    }
    const lists = await Promise.all(
      groupVersions.map((gv) =>
        apiServerFetch(token, gv === 'v1' ? '/api/v1' : `/apis/${gv}`, { cluster })
          .then((r) => (r.ok ? r.json() : { resources: [] }))
          .then((body) => ({ gv, resources: (body.resources ?? []) as RawApiResource[] }))
          .catch(() => ({ gv, resources: [] as RawApiResource[] })),
      ),
    )
    // core/v1 is already fetched; merge it in place of the duplicate.
    lists[0] = { gv: 'v1', resources: (coreRes.resources ?? []) as RawApiResource[] }

    const out: DiscoveredResource[] = []
    for (const { gv, resources } of lists) {
      const [group, version] = gv.includes('/') ? gv.split('/') : ['', gv]
      for (const r of resources) {
        out.push({
          group,
          version,
          groupVersion: gv,
          kind: r.kind,
          name: r.name,
          singularName: r.singularName || undefined,
          namespaced: r.namespaced,
          verbs: r.verbs ?? [],
          shortNames: r.shortNames,
          categories: r.categories,
          subresource: r.name.includes('/'),
        })
      }
    }
    discoveryCache.set(key, { at: Date.now(), data: out })
    return out
  })().finally(() => discoveryInflight.delete(key))

  discoveryInflight.set(key, p)
  return p
}

async function discoveryResponse(token: string, cluster?: string): Promise<Response> {
  const key = cluster ?? ''
  const hit = discoveryCache.get(key)
  const cached = Boolean(hit && Date.now() - hit.at < DISCOVERY_TTL_MS)
  try {
    const resources = await loadDiscovery(token, cluster)
    return Response.json({ resources, cached })
  } catch (e) {
    const detailMsg = e instanceof Error ? e.message : String(e)
    console.error('[k8s] discovery failed:', detailMsg)
    const dev = (env('NODE_ENV') ?? env('DENO_ENV')) !== 'production'
    return Response.json(
      { error: 'discovery_failed', ...(dev ? { detail: detailMsg } : {}) },
      { status: 502 },
    )
  }
}

interface RawApiResource {
  name: string
  singularName?: string
  namespaced: boolean
  kind: string
  verbs?: string[]
  shortNames?: string[]
  categories?: string[]
}

/* ─────────────── access review ─────────────── */

async function accessReview(req: Request, token: string, cluster?: string): Promise<Response> {
  let body: {
    verb?: string
    group?: string
    resource?: string
    namespace?: string
    name?: string
    subresource?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const review = {
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectAccessReview',
    spec: {
      resourceAttributes: {
        verb: body.verb ?? 'get',
        group: body.group ?? '',
        resource: body.resource ?? '',
        namespace: body.namespace,
        name: body.name,
        subresource: body.subresource,
      },
    },
  }
  const res = await apiServerFetch(token, '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(review),
    cluster,
  })
  const out = await res.json().catch(() => ({}))
  return Response.json({ allowed: Boolean(out?.status?.allowed), status: out?.status })
}

async function rulesReview(req: Request, token: string, cluster?: string): Promise<Response> {
  let body: { namespace?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const review = {
    apiVersion: 'authorization.k8s.io/v1',
    kind: 'SelfSubjectRulesReview',
    spec: { namespace: body.namespace ?? 'default' },
  }
  const res = await apiServerFetch(token, '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(review),
    cluster,
  })
  return passthrough(res)
}

/* ─────────────── server-side apply ─────────────── */

/**
 * Server-Side Apply. Body: { manifest: <object>, dryRun?: boolean, force?: boolean }.
 * Builds the resource path from the manifest's apiVersion/kind — but we need the
 * plural resource name, so we consult discovery. PATCH with
 * `application/apply-patch+yaml` + fieldManager.
 */
async function apply(
  req: Request,
  token: string,
  user: K8sIdentity['user'],
  cluster?: string,
): Promise<Response> {
  let body: { manifest?: KubeObject; dryRun?: boolean; force?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const m = body.manifest
  if (!m?.apiVersion || !m.kind || !m.metadata?.name) {
    return Response.json({ error: 'manifest_requires_apiVersion_kind_metadata.name' }, { status: 400 })
  }
  // Namespace must be a DNS-1123 label — reject anything that could alter the path.
  if (m.metadata.namespace && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(m.metadata.namespace)) {
    return Response.json({ error: 'invalid_namespace' }, { status: 400 })
  }
  // Resolve the plural resource name from discovery (cache-warm on first apply).
  let resources: DiscoveredResource[]
  try {
    resources = await loadDiscovery(token, cluster)
  } catch {
    return Response.json({ error: 'discovery_failed' }, { status: 502 })
  }
  const [group, version] = m.apiVersion.includes('/') ? m.apiVersion.split('/') : ['', m.apiVersion]
  const def = resources.find(
    (d) => !d.subresource && d.kind === m.kind && d.group === group && d.version === version,
  )
  if (!def) {
    return Response.json({ error: 'unknown_kind', kind: m.kind, apiVersion: m.apiVersion }, { status: 400 })
  }
  const root = group === '' ? `/api/${version}` : `/apis/${group}/${version}`
  const ns = def.namespaced && m.metadata.namespace
    ? `/namespaces/${encodeURIComponent(m.metadata.namespace)}`
    : ''
  const path = `${root}${ns}/${def.name}/${encodeURIComponent(m.metadata.name)}`
  // Don't steal field ownership by default — the caller must opt into force.
  const params = new URLSearchParams({ fieldManager: 'adhar-console', force: String(body.force ?? false) })
  if (body.dryRun) params.set('dryRun', 'All')

  const started = Date.now()
  let res: Response
  try {
    res = await apiServerFetch(token, path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/apply-patch+yaml' },
      search: `?${params}`,
      body: JSON.stringify(m),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cluster,
    })
  } catch (e) {
    audit({
      user: user.id,
      action: 'apply',
      kind: m.kind,
      apiVersion: m.apiVersion,
      name: m.metadata.name,
      namespace: m.metadata.namespace,
      ...(cluster ? { cluster } : {}),
      dryRun: Boolean(body.dryRun),
      status: 502,
      outcome: 'error',
      ms: Date.now() - started,
    })
    return upstreamFailure(e, {
      method: 'PATCH',
      subpath: path.slice(1),
      base: resolveClusterBase(cluster) ?? apiServerBaseUrl(),
      clientAborted: req.signal.aborted,
    })
  }
  audit({
    user: user.id,
    action: 'apply',
    kind: m.kind,
    apiVersion: m.apiVersion,
    name: m.metadata.name,
    namespace: m.metadata.namespace,
    ...(cluster ? { cluster } : {}),
    dryRun: Boolean(body.dryRun),
    status: res.status,
    outcome: res.ok ? 'success' : 'failure',
    ms: Date.now() - started,
  })
  return passthrough(res)
}

interface KubeObject {
  apiVersion?: string
  kind?: string
  metadata?: { name?: string; namespace?: string; [k: string]: unknown }
  [k: string]: unknown
}
