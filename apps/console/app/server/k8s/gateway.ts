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
 *     review, and server-side apply.
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

function apiServerBaseUrl(): string {
  return (env('K8S_API_URL') ?? 'https://kubernetes.default.svc').replace(/\/$/, '')
}

export interface K8sIdentity {
  token: string
  user: { id: string; name: string; email: string }
  refreshedCookie?: string
}

/**
 * Resolve the caller's Kubernetes identity (their Keycloak access token). When
 * `K8S_SA_TOKEN` is set (or an in-cluster SA token file exists) AND no user
 * session is present, we intentionally do NOT fall back to it for user-facing
 * calls — per-user impersonation is the security model. Returns null → 401.
 */
export async function resolveIdentity(req: Request): Promise<K8sIdentity | null> {
  const cfg = getServerAuthConfig()
  if (!cfg) return null
  const result = await getValidSession(req, cfg)
  if (!result) return null
  return {
    token: result.session.accessToken,
    user: {
      id: result.session.user.id,
      name: result.session.user.name,
      email: result.session.user.email,
    },
    refreshedCookie: result.refreshedCookie,
  }
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
 */
export function apiServerFetch(
  token: string,
  path: string,
  init: { method?: string; body?: BodyInit | null; headers?: Record<string, string>; search?: string } = {},
): Promise<Response> {
  const base = apiServerBaseUrl()
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
  })
}

/** Copy an apiserver Response back to the browser, dropping hop-by-hop headers. */
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
 * Main entry: dispatch `/api/k8s/<subpath>`.
 *   /api/k8s/-/discovery        → aggregated API discovery
 *   /api/k8s/-/access           → SelfSubjectAccessReview (POST)
 *   /api/k8s/-/rules            → SelfSubjectRulesReview for a namespace (POST)
 *   /api/k8s/-/apply            → server-side apply (POST)
 *   /api/k8s/<api|apis|version|openapi/...>  → transparent apiserver proxy
 */
export async function handleK8s(req: Request, subpath: string): Promise<Response> {
  const id = await resolveIdentity(req)
  if (!id) return unauthorized()

  if (subpath.startsWith('-/')) {
    return withCookie(await handleMeta(req, subpath.slice(2), id), id.refreshedCookie)
  }

  // Transparent apiserver proxy — only allow real apiserver roots (defence in
  // depth; the base URL already fixes the host).
  if (!/^(api|apis|version|openapi|healthz|livez|readyz)(\/|$)/.test(subpath)) {
    return Response.json({ error: 'invalid_k8s_path' }, { status: 400 })
  }

  const url = new URL(req.url)
  const method = req.method.toUpperCase()
  const headers: Record<string, string> = {}
  for (const [k, v] of req.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v
  }
  const hasBody = method !== 'GET' && method !== 'HEAD'
  let upstream: Response
  try {
    upstream = await apiServerFetch(id.token, `/${subpath}`, {
      method,
      headers,
      search: url.search,
      body: hasBody ? await req.arrayBuffer() : undefined,
    })
  } catch (e) {
    return Response.json(
      { error: 'apiserver_unreachable', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
  return passthrough(upstream, id.refreshedCookie)
}

/* ─────────────── meta endpoints ─────────────── */

async function handleMeta(req: Request, name: string, id: K8sIdentity): Promise<Response> {
  switch (name) {
    case 'discovery':
      return discovery(id.token)
    case 'access':
      return accessReview(req, id.token)
    case 'rules':
      return rulesReview(req, id.token)
    case 'apply':
      return apply(req, id.token)
    case 'whoami':
      return Response.json({ user: id.user })
    default:
      return Response.json({ error: 'unknown_meta', name }, { status: 404 })
  }
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

let discoveryCache: { at: number; data: DiscoveredResource[] } | null = null
const DISCOVERY_TTL_MS = 60_000

async function discovery(token: string): Promise<Response> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return Response.json({ resources: discoveryCache.data, cached: true })
  }
  try {
    const [coreRes, groupsRes] = await Promise.all([
      apiServerFetch(token, '/api/v1').then((r) => r.json()),
      apiServerFetch(token, '/apis').then((r) => r.json()),
    ])
    const groupVersions: string[] = ['v1']
    for (const g of (groupsRes.groups ?? []) as Array<{ preferredVersion?: { groupVersion: string } }>) {
      if (g.preferredVersion?.groupVersion) groupVersions.push(g.preferredVersion.groupVersion)
    }
    const lists = await Promise.all(
      groupVersions.map((gv) =>
        apiServerFetch(token, gv === 'v1' ? '/api/v1' : `/apis/${gv}`)
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
    discoveryCache = { at: Date.now(), data: out }
    return Response.json({ resources: out, cached: false })
  } catch (e) {
    return Response.json(
      { error: 'discovery_failed', detail: e instanceof Error ? e.message : String(e) },
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

async function accessReview(req: Request, token: string): Promise<Response> {
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
  })
  const out = await res.json().catch(() => ({}))
  return Response.json({ allowed: Boolean(out?.status?.allowed), status: out?.status })
}

async function rulesReview(req: Request, token: string): Promise<Response> {
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
async function apply(req: Request, token: string): Promise<Response> {
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
  // Resolve the plural resource name from discovery (cache-warm on first apply).
  if (!discoveryCache || Date.now() - discoveryCache.at >= DISCOVERY_TTL_MS) {
    await discovery(token)
  }
  const [group, version] = m.apiVersion.includes('/') ? m.apiVersion.split('/') : ['', m.apiVersion]
  const def = discoveryCache?.data.find(
    (d) => !d.subresource && d.kind === m.kind && d.group === group && d.version === version,
  )
  if (!def) {
    return Response.json({ error: 'unknown_kind', kind: m.kind, apiVersion: m.apiVersion }, { status: 400 })
  }
  const root = group === '' ? `/api/${version}` : `/apis/${group}/${version}`
  const ns = def.namespaced && m.metadata.namespace ? `/namespaces/${m.metadata.namespace}` : ''
  const path = `${root}${ns}/${def.name}/${encodeURIComponent(m.metadata.name)}`
  const params = new URLSearchParams({ fieldManager: 'adhar-console', force: String(body.force ?? true) })
  if (body.dryRun) params.set('dryRun', 'All')

  const res = await apiServerFetch(token, path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/apply-patch+yaml' },
    search: `?${params}`,
    body: JSON.stringify(m),
  })
  return passthrough(res)
}

interface KubeObject {
  apiVersion?: string
  kind?: string
  metadata?: { name?: string; namespace?: string; [k: string]: unknown }
  [k: string]: unknown
}
