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
 * Read-only, cached briefly (the launcher refetches on every open), and fails
 * closed to an empty list — discovery can only ADD apps, never hide configured
 * ones.
 */

export interface DiscoveredApp {
  /** Registry / launcher id (hostname first label, aliased where they differ). */
  id: string
  host: string
  url: string
  /** `namespace/name` of the HTTPRoute, for diagnostics. */
  route: string
}

const TTL_MS = 30_000
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

interface HttpRoute {
  metadata?: { name?: string; namespace?: string }
  spec?: { hostnames?: string[] }
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

  inflight = (async (): Promise<DiscoveredApp[]> => {
    try {
      const token = getK8sServiceToken()
      if (!token) return []
      const res = await apiServerFetch(token, '/apis/gateway.networking.k8s.io/v1/httproutes')
      if (!res.ok) return []
      const body = (await res.json()) as { items?: HttpRoute[] }
      const suffix = `.${domain}`
      const seen = new Map<string, DiscoveredApp>()
      for (const it of body.items ?? []) {
        for (const raw of it.spec?.hostnames ?? []) {
          const host = raw.toLowerCase()
          if (!host.endsWith(suffix)) continue
          const label = host.slice(0, -suffix.length)
          // exactly one label under the base — `a.b.<base>` is not an app tile
          if (!label || label.includes('.') || label.includes('*') || SKIP.has(label)) continue
          const id = ALIAS[label] ?? label
          if (seen.has(id)) continue
          seen.set(id, {
            id,
            host,
            url: `${proto}//${host}${port ? `:${port}` : ''}`,
            route: `${it.metadata?.namespace ?? '?'}/${it.metadata?.name ?? '?'}`,
          })
        }
      }
      return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
    } catch {
      return [] // discovery is best-effort; never break /api/config
    } finally {
      inflight = null
    }
  })()

  const apps = await inflight
  cache = { at: Date.now(), key, apps }
  return apps
}

function splitPort(base: string): [string, string] {
  const m = /^([^:/]+)(?::(\d+))?$/.exec(base.trim())
  return m ? [m[1], m[2] ?? ''] : [base.trim(), '']
}
