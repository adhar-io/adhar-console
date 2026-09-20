import { platformDomain } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'

/**
 * `GET /api/catalog/routes?name=<entity>[&namespace=<ns>][&app=<argocd-app>]`
 *
 * Where a catalog entity is actually REACHABLE — the URLs a human can open.
 *
 * The drawer already showed sync status, health and a revision, which answers
 * "did it deploy" but not "where is it". That second question is the one people
 * came to the catalog with, and they were answering it by guessing a hostname
 * or digging through Argo CD's resource tree.
 *
 * Discovery is by BACKEND, not by name. A route called `billing` is weak
 * evidence; a route whose `backendRefs` names the `billing` Service is the
 * cluster stating the relationship. Name matching stays as a secondary signal
 * (with the same conservative environment suffixes the Argo CD matcher uses)
 * because a route may front a Gateway-level rewrite rather than a Service
 * directly, but a backend match is reported as such so the UI can rank it.
 *
 * Both Gateway API HTTPRoutes and legacy Ingresses are read: the platform's own
 * golden paths emit HTTPRoutes, but an adopted workload may well have arrived
 * with an Ingress and it is still the way in.
 *
 * Read-only, with the caller's identity, so the apiserver enforces their RBAC.
 * Failures degrade to an empty list with a machine-readable `error` rather than
 * breaking the drawer — not knowing a URL is a smaller problem than a tab that
 * will not open.
 */

/** Environment suffixes recognised on route names (`billing-prod`). */
const ENV_SUFFIXES = [
  'prod', 'production', 'staging', 'stage', 'stg', 'dev', 'development',
  'qa', 'test', 'uat', 'preview', 'canary', 'sandbox',
] as const

export interface EntityRoute {
  /** Opened by the UI. Always absolute. */
  url: string
  host: string
  /** Longest path prefix the rule matches, `/` when unconstrained. */
  path: string
  kind: 'HTTPRoute' | 'Ingress'
  name: string
  namespace: string
  /** The Service the rule forwards to, when the manifest names one. */
  service?: string
  /**
   * How this route was tied to the entity. `backend` is the cluster asserting
   * it; `name` is a heuristic. The UI leads with backend matches.
   */
  via: 'backend' | 'name'
  /** True when the route's own TLS/listener implies https. */
  secure: boolean
}

export interface EntityRoutes {
  entity: string
  routes: EntityRoute[]
  error?: string
  detail?: string
}

interface HttpRouteDoc {
  metadata?: { name?: string; namespace?: string }
  spec?: {
    hostnames?: string[]
    parentRefs?: Array<{ name?: string; sectionName?: string }>
    rules?: Array<{
      matches?: Array<{ path?: { type?: string; value?: string } }>
      backendRefs?: Array<{ name?: string; kind?: string; port?: number }>
    }>
  }
}

interface IngressDoc {
  metadata?: { name?: string; namespace?: string }
  spec?: {
    tls?: Array<{ hosts?: string[] }>
    rules?: Array<{
      host?: string
      http?: {
        paths?: Array<{
          path?: string
          backend?: { service?: { name?: string; port?: { number?: number } } }
        }>
      }
    }>
  }
}

function nameMatches(routeName: string, entity: string): boolean {
  const a = routeName.toLowerCase()
  const n = entity.toLowerCase()
  if (a === n) return true
  return ENV_SUFFIXES.some((s) => a === `${n}-${s}`)
}

/** The candidate names a route's backend may carry for this entity. */
function backendMatches(service: string | undefined, entity: string): boolean {
  if (!service) return false
  const s = service.toLowerCase()
  const n = entity.toLowerCase()
  if (s === n) return true
  // Charts commonly suffix the Service: `billing-svc`, `billing-http`, `billing-web`.
  return ['svc', 'service', 'http', 'web', 'api'].some((suf) => s === `${n}-${suf}`) ||
    ENV_SUFFIXES.some((suf) => s === `${n}-${suf}`)
}

/** `https` unless the platform's own entry URL says otherwise. */
function publicScheme(): string {
  return platformDomain()?.protocol ?? 'https:'
}

/**
 * The port to append. HTTPRoute hostnames never carry one, but a laptop install
 * publishes the gateway on a non-default port and a URL without it 404s in the
 * browser — so the platform domain's port is re-applied.
 */
function publicPort(): string {
  const host = platformDomain()?.host ?? ''
  const m = /:(\d+)$/.exec(host)
  return m ? m[1] : ''
}

function absolute(host: string, path: string, secure: boolean): string {
  const scheme = secure ? 'https:' : publicScheme()
  const port = publicPort()
  const p = path && path !== '/' ? path : ''
  return `${scheme}//${host}${port ? `:${port}` : ''}${p}`
}

/** Longest path prefix across a rule's matches — the most specific entry point. */
function rulePath(rule: NonNullable<NonNullable<HttpRouteDoc['spec']>['rules']>[number]): string {
  const paths = (rule.matches ?? [])
    .map((m) => m.path?.value)
    .filter((v): v is string => !!v && v.startsWith('/'))
  if (!paths.length) return '/'
  return paths.reduce((a, b) => (b.length > a.length ? b : a))
}

function collectHttpRoutes(items: HttpRouteDoc[], entity: string): EntityRoute[] {
  const out: EntityRoute[] = []
  for (const it of items) {
    const name = it.metadata?.name ?? ''
    const namespace = it.metadata?.namespace ?? ''
    const hosts = (it.spec?.hostnames ?? []).filter((h) => h && !h.includes('*'))
    if (!hosts.length) continue
    // A Gateway listener named `https` (the platform's convention) means TLS
    // terminates at the edge even though the route itself declares no TLS.
    const secure = (it.spec?.parentRefs ?? []).some((p) => (p.sectionName ?? '').toLowerCase().includes('https'))
    for (const rule of it.spec?.rules ?? []) {
      const backend = (rule.backendRefs ?? []).find((b) => (b.kind ?? 'Service') === 'Service' && backendMatches(b.name, entity))
      const via: EntityRoute['via'] | undefined = backend ? 'backend' : nameMatches(name, entity) ? 'name' : undefined
      if (!via) continue
      const path = rulePath(rule)
      for (const host of hosts) {
        out.push({
          url: absolute(host, path, secure),
          host,
          path,
          kind: 'HTTPRoute',
          name,
          namespace,
          ...(backend?.name ? { service: backend.name } : {}),
          via,
          secure,
        })
      }
    }
  }
  return out
}

function collectIngresses(items: IngressDoc[], entity: string): EntityRoute[] {
  const out: EntityRoute[] = []
  for (const it of items) {
    const name = it.metadata?.name ?? ''
    const namespace = it.metadata?.namespace ?? ''
    const tlsHosts = new Set((it.spec?.tls ?? []).flatMap((t) => t.hosts ?? []).map((h) => h.toLowerCase()))
    for (const rule of it.spec?.rules ?? []) {
      const host = rule.host
      if (!host || host.includes('*')) continue
      for (const p of rule.http?.paths ?? []) {
        const svc = p.backend?.service?.name
        const via: EntityRoute['via'] | undefined = backendMatches(svc, entity)
          ? 'backend'
          : nameMatches(name, entity)
          ? 'name'
          : undefined
        if (!via) continue
        const path = p.path && p.path.startsWith('/') ? p.path : '/'
        const secure = tlsHosts.has(host.toLowerCase())
        out.push({
          url: absolute(host, path, secure),
          host,
          path,
          kind: 'Ingress',
          name,
          namespace,
          ...(svc ? { service: svc } : {}),
          via,
          secure,
        })
      }
    }
  }
  return out
}

/** Backend matches first, then https, then shorter paths (the app's root). */
function rank(a: EntityRoute, b: EntityRoute): number {
  if (a.via !== b.via) return a.via === 'backend' ? -1 : 1
  if (a.secure !== b.secure) return a.secure ? -1 : 1
  if (a.path.length !== b.path.length) return a.path.length - b.path.length
  return a.host.localeCompare(b.host)
}

export async function handleEntityRoutes(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'GET') return new Response('Method Not Allowed', { status: 405 })
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  const url = new URL(req.url)
  const entity = (url.searchParams.get('name') ?? '').trim()
  const namespace = (url.searchParams.get('namespace') ?? '').trim()
  if (!entity) return Response.json({ entity: '', routes: [], error: 'missing_name' }, { status: 400 })

  const id = await resolveIdentity(req)
  if (!id) {
    const res = unauthorized('session_expired')
    if (auth.refreshedCookie) res.headers.append('set-cookie', auth.refreshedCookie)
    return res
  }

  const scope = namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''
  const reply = (body: EntityRoutes, status = 200) => {
    const res = Response.json(body, { status })
    if (auth.refreshedCookie) res.headers.append('set-cookie', auth.refreshedCookie)
    return res
  }

  try {
    // Both lists in parallel, and a failure of either is not fatal: a cluster
    // without the Gateway API CRDs still has Ingresses, and vice versa.
    const [routesRes, ingressRes] = await Promise.all([
      apiServerFetch(id, `/apis/gateway.networking.k8s.io/v1${scope}/httproutes`, { search: '?limit=500' })
        .catch(() => undefined),
      apiServerFetch(id, `/apis/networking.k8s.io/v1${scope}/ingresses`, { search: '?limit=500' })
        .catch(() => undefined),
    ])

    const found: EntityRoute[] = []
    let forbidden = false

    if (routesRes?.ok) {
      const body = (await routesRes.json()) as { items?: HttpRouteDoc[] }
      found.push(...collectHttpRoutes(body.items ?? [], entity))
    } else if (routesRes) {
      if (routesRes.status === 403) forbidden = true
      await routesRes.body?.cancel()
    }

    if (ingressRes?.ok) {
      const body = (await ingressRes.json()) as { items?: IngressDoc[] }
      found.push(...collectIngresses(body.items ?? [], entity))
    } else if (ingressRes) {
      if (ingressRes.status === 403) forbidden = true
      await ingressRes.body?.cancel()
    }

    // One entry per URL: a route with several hostnames and an Ingress fronting
    // the same host would otherwise render the same button twice.
    const byUrl = new Map<string, EntityRoute>()
    for (const r of found.sort(rank)) if (!byUrl.has(r.url)) byUrl.set(r.url, r)
    const routes = [...byUrl.values()]

    if (!routes.length && forbidden) {
      return reply({ entity, routes: [], error: 'forbidden' }, 200)
    }
    return reply({ entity, routes })
  } catch (e) {
    return reply(
      { entity, routes: [], error: 'apiserver_error', detail: (e instanceof Error ? e.message : String(e)).slice(0, 500) },
      200,
    )
  }
}
