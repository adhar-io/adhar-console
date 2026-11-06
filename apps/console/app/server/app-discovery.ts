import { derivePackageState, packageApplication, type RawArgoApplication } from '@adhar/utils'
import { apiServerFetch } from './k8s/gateway.ts'
import { getK8sServiceToken } from './tool-registry.ts'

/**
 * Dynamic app discovery from the cluster's Gateway API routes.
 *
 * The tool registry only knows apps whose `<TOOL>_URL` env is set on the
 * console Deployment. On a real platform the gateway exposes far more (n8n,
 * dagster, supabase, trino, coder, kargo, plane, …) — each as an `HTTPRoute`
 * with a public hostname under the platform base domain. So the "is this app
 * available?" question is answered authoritatively by the cluster itself: list
 * HTTPRoutes (the console SA carries `read-all`), keep hostnames under the base
 * domain, and map `<label>.<base>` → an app id + public URL. Merged into
 * `/api/config` so the app launcher shows every routed app, and known tools get
 * their real public URL instead of a derived guess.
 *
 * A route alone says the package was applied at some point, not that it is
 * there now, so each route is joined to the Argo CD Application that owns it
 * (its `tracking-id`): a package mid-install or mid-removal is left out, and so
 * is a route whose Application is gone. Routes with no owner are the bootstrap
 * components the controller installs before GitOps exists (Argo CD, Gitea).
 *
 * Read-only, cached briefly (the launcher refetches on every open and on every
 * watch event while it is open), and fails closed to an empty list — discovery
 * can only ADD apps, never hide configured ones.
 */

export interface DiscoveredApp {
  /** Registry / launcher id (hostname first label, aliased where they differ). */
  id: string
  host: string
  url: string
  /** `namespace/name` of the HTTPRoute, for diagnostics. */
  route: string
  /** The owning package's `adhar.io/category`, when it has one. */
  category?: string
  /**
   * `false` when what answers on this host is an API, not something a browser
   * can use (see {@link browserUiFromProbe}). Absent when not known.
   */
  ui?: boolean
}

/**
 * Below the launcher's watch debounce (`APP_CONFIG_SETTLE_MS` in shell-ui), so
 * the refetch a watch event triggers can never be answered from a list taken
 * before that event. It is also the ceiling on the apiserver load `/api/config`
 * can cause, and anyone may call that.
 */
export const TTL_MS = 2_000
let cache: { at: number; key: string; apps: DiscoveredApp[] } | null = null
let inflight: Promise<DiscoveredApp[]> | null = null

/** Hostname first-label → app id, where the ingress host differs from the id. */
const ALIAS: Record<string, string> = {
  'argo-rollout': 'argo-rollouts',
  'opensearch-dashboards': 'opensearch',
  'minio-console': 'minio',
}

/** Hosts that are the console itself or otherwise not user-facing apps. */
const SKIP = new Set(['console', 'localhost', 'www'])

/**
 * The launcher is for PLATFORM apps, and every platform package routes from the
 * platform namespace (ADR-0011). Teams' applications route from their
 * environment namespaces (`dev`, `test`, `prod`, …), and when an environment
 * repeats the host's first label their hostname is one label deep
 * (`my-service-dev.dev.adhar.io`), so the hostname rule alone let them in as
 * tiles (2026-10-24). They have their own home in the service catalog.
 */
export const PLATFORM_ROUTE_NAMESPACE = 'adhar-system'

/** True for an HTTPRoute that belongs to a platform package. */
export function isPlatformRoute(route: HttpRoute): boolean {
  return route.metadata?.namespace === PLATFORM_ROUTE_NAMESPACE
}

export interface HttpRoute {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> }
  spec?: { hostnames?: string[] }
}

/** The Application that owns a route (`<app>:<group>/<kind>:<ns>/<name>`); undefined for a bootstrap route. */
export function routeOwner(route: HttpRoute): string | undefined {
  const tracking = route.metadata?.annotations?.['argocd.argoproj.io/tracking-id']
  return tracking?.split(':')[0] || undefined
}

/**
 * Map a cluster's routes to the apps it offers right now.
 *
 * `applications` is `null` when they could not be read: nothing is then known
 * about ownership, and a transient 403 must not empty the drawer.
 */
export function routedApps(
  routes: HttpRoute[],
  applications: RawArgoApplication[] | null,
  domain: string,
  port: string,
  proto: string,
  now: number = Date.now(),
): DiscoveredApp[] {
  const byName = new Map((applications ?? []).map((a) => [a.metadata?.name ?? '', a]))
  const suffix = `.${domain}`
  const seen = new Map<string, DiscoveredApp>()
  for (const it of routes) {
    if (!isPlatformRoute(it)) continue
    const owner = routeOwner(it)
    const app = owner ? byName.get(owner) : undefined
    if (applications && owner) {
      // No Application left means a disabled package whose route outlived it.
      if (!app) continue
      const live = packageApplication(app)
      if (!derivePackageState({ desired: !live.deletingSince, app: live }, now).available) continue
    }
    for (const raw of it.spec?.hostnames ?? []) {
      const host = raw.toLowerCase()
      if (!host.endsWith(suffix)) continue
      const label = host.slice(0, -suffix.length)
      // exactly one label under the base — `a.b.<base>` is not an app tile
      if (!label || label.includes('.') || label.includes('*') || SKIP.has(label)) continue
      const id = ALIAS[label] ?? label
      if (seen.has(id)) continue
      const category = app?.metadata?.labels?.['adhar.io/category']
      seen.set(id, {
        id,
        host,
        url: `${proto}//${host}${port ? `:${port}` : ''}`,
        route: `${it.metadata?.namespace ?? '?'}/${it.metadata?.name ?? '?'}`,
        ...(category ? { category } : {}),
      })
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Does this response come from something a browser can use?
 *
 * Measured against every route on a live cluster, signed out and asking for
 * HTML: UIs answer 2xx HTML or redirect to their sign-in; `ai` and `mcp` answer
 * 401 text/plain, `faro` 404 text/plain. So a redirect or an HTML page is a UI,
 * and a 2xx or 4xx in anything else, or a 404 at the root in any format, is not.
 * A 5xx says nothing: the app may just be restarting, and that is what
 * `undefined` means. It cannot see through a sign-in gate; the launcher's
 * `HIDDEN_TOOL_IDS` covers the few APIs that sit behind one (Loki, Mimir).
 */
export function browserUiFromProbe(status: number, contentType: string): boolean | undefined {
  if (status >= 500 || status < 200) return undefined
  if (status >= 300 && status < 400) return true
  if (status === 404) return false
  return /\btext\/html\b/i.test(contentType)
}

/** A verdict stands until the package changes shape, which is rare; "don't know" is retried soon. */
const PROBE_TTL_MS = 10 * 60_000
const PROBE_RETRY_MS = 30_000
const PROBE_TIMEOUT_MS = 2_000
/** How long `/api/config` waits for probes of routes it has not seen before. */
const PROBE_BUDGET_MS = 1_500
const probes = new Map<string, { at: number; ui: boolean | undefined }>()

async function probe(url: string): Promise<void> {
  let ui: boolean | undefined
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    await res.body?.cancel()
    ui = browserUiFromProbe(res.status, res.headers.get('content-type') ?? '')
  } catch {
    // Unreachable from here (a self-signed edge, a port only the host maps) is
    // not evidence about the app: leave it as "don't know".
  }
  probes.set(url, { at: Date.now(), ui })
}

/** Attach what is known about each app's UI, waiting briefly for routes not yet probed. */
async function withUiVerdicts(apps: DiscoveredApp[]): Promise<DiscoveredApp[]> {
  const now = Date.now()
  const due = apps.filter((a) => {
    const seen = probes.get(a.url)
    return !seen || now - seen.at > (seen.ui === undefined ? PROBE_RETRY_MS : PROBE_TTL_MS)
  })
  if (due.length) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(due.map((a) => probe(a.url))),
      new Promise((resolve) => (timer = setTimeout(resolve, PROBE_BUDGET_MS))),
    ])
    clearTimeout(timer)
  }
  return apps.map((a) => {
    const ui = probes.get(a.url)?.ui
    return ui === undefined ? a : { ...a, ui }
  })
}

/**
 * Apps routed under `base` (e.g. `platform.adhar.io`, or `adhar.localtest.me:8443`
 * in dev — a port on the base is re-applied to the URLs; HTTPRoute hostnames
 * never carry one). `proto` is the public scheme (from AUTH_PUBLIC_URL).
 */
export async function discoverRoutedApps(base: string, proto = 'https:'): Promise<DiscoveredApp[]> {
  const [domain, port] = splitPort(base)
  if (!domain) return []
  const key = `${proto}//${base}`
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.apps
  if (inflight) return inflight

  // The age of the answer is the age of the list, not of the probes after it.
  const listedAt = Date.now()
  inflight = (async (): Promise<DiscoveredApp[]> => {
    try {
      const token = getK8sServiceToken()
      if (!token) return []
      const res = await apiServerFetch(token, '/apis/gateway.networking.k8s.io/v1/httproutes')
      if (!res.ok) return []
      const body = (await res.json()) as { items?: HttpRoute[] }
      return await withUiVerdicts(
        routedApps(body.items ?? [], await listApplications(token), domain, port, proto),
      )
    } catch {
      return [] // discovery is best-effort; never break /api/config
    } finally {
      inflight = null
    }
  })()

  const apps = await inflight
  cache = { at: listedAt, key, apps }
  return apps
}

/** Argo CD Applications, or `null` when they cannot be read (no Argo CD, no RBAC, an API error). */
async function listApplications(token: string): Promise<RawArgoApplication[] | null> {
  try {
    const res = await apiServerFetch(
      token,
      `/apis/argoproj.io/v1alpha1/namespaces/${PLATFORM_ROUTE_NAMESPACE}/applications`,
    )
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    return ((await res.json()) as { items?: RawArgoApplication[] }).items ?? []
  } catch {
    return null
  }
}

function splitPort(base: string): [string, string] {
  const m = /^([^:/]+)(?::(\d+))?$/.exec(base.trim())
  return m ? [m[1], m[2] ?? ''] : [base.trim(), '']
}
