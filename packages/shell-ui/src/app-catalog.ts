import type { AppConfig } from './app-config.ts'

/**
 * Which apps the launcher offers, and where each one lives — pure, so it can be
 * tested without React (the launcher adds icons and everything visual).
 *
 * The cluster decides. `discoveredApps` in `/api/config` is what the gateway
 * routes for packages that are applied right now, and any app in it appears here
 * with no console change. The curated registry in `app-launcher.tsx` only adds a
 * better name, description and category to apps it recognises; it is never what
 * makes an app available.
 */

export type AppCategory =
  | 'Code'
  | 'Build & CI'
  | 'Deploy'
  | 'Registry'
  | 'Observe'
  | 'Data'
  | 'Security'
  | 'Platform'

/** The launcher's metadata for an app it recognises, without the icon. */
export interface AppDescriptor {
  id: string
  name: string
  description: string
  /** Static dev-canonical URL — the last-resort fallback; runtime resolution
   *  prefers the BFF-reported URL (see resolveApps). */
  url: string
  category: AppCategory
  /** BFF tool ids whose configured/url state drives this app. Defaults to
   *  `[id]`. First configured entry wins for URL resolution. */
  tools?: string[]
  /** Ingress subdomain when it differs from the id, for base-domain
   *  derivation (e.g. argo-rollouts → `rollouts.<base>`). */
  sub?: string
  /** Deep-link through another tool's UI — e.g. Loki opens Grafana Explore. */
  via?: { tool: string; path: string }
  /** Path appended to the app's own resolved origin (not used with `via`) —
   *  e.g. OpenBao's click-free Keycloak sign-in page. */
  path?: string
}

/**
 * Tool ids that must never become a tile.
 *
 * Every tool the BFF knows reports `configured: true`, because its URL is
 * DERIVED from the base domain rather than probed — so discovery happily
 * invented a tile for anything with a route, including things that answer
 * "authentication failure: no bearer token" or a bare 404 to a browser. A
 * launcher that offers a door onto an API is worse than one that omits it:
 * the person clicks, waits through a sign-in, and lands on nothing.
 *
 * The BFF's probe now catches any API that answers a browser as an API
 * (`ui: false`), so a new package needs no entry here. What remains is what no
 * probe can see:
 *   • aliases of another entry (`lgtm` is Grafana, `minio` is RustFS);
 *   • APIs behind a sign-in gate or an API-docs redirect, which look exactly
 *     like a UI from outside (`loki`, `tempo`, `mimir`, `agent`);
 *   • control-plane components that have never had a UI (Kyverno, Trivy and
 *     Falco report through Policy Reporter, which has its own tile).
 */
export const HIDDEN_TOOL_IDS: ReadonlySet<string> = new Set([
  'lgtm', 'minio', 'vault', 'k8s',
  'agent', 'ai', 'mcp', 'otel', 'faro',
  'loki', 'tempo', 'mimir',
  'crossplane', 'kyverno', 'trivy', 'falco', 'iceberg',
])

/** Name for an app the launcher has never heard of: `argo-workflows` → `Argo Workflows`. */
export function titleize(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** Launcher section for an unrecognised app, from its package's `adhar.io/category`. */
export function categoryForPackage(category: string | undefined): AppCategory {
  switch (category) {
    case 'data':
      return 'Data'
    case 'observability':
      return 'Observe'
    case 'security':
      return 'Security'
    default:
      return 'Platform'
  }
}

export type PlatformConfig = Pick<AppConfig, 'tools' | 'discoveredApps' | 'publicBaseDomain'>

export type ResolvedDescriptor<T extends AppDescriptor> = T & {
  /** True when the BFF reports a backing tool configured for this app. */
  configured: boolean
}

/** Where the page itself is served, for deriving a sibling host. */
export interface PageLocation {
  protocol: string
  host: string
}

/**
 * The cluster base domain apps are exposed under (`<tool>.<base>`), used to
 * build URLs for every app whose external URL the BFF doesn't report
 * (adhar-controlplane `.svc` URLs are hidden from the browser). Priority:
 *   1. `publicBaseDomain` from /api/config (ADHAR_BASE_DOMAIN / AUTH_PUBLIC_URL)
 *   2. the console's own origin minus its first label
 *      (console.platform.adhar.io → platform.adhar.io)
 *   3. any configured tool that does expose a public URL
 * Never the hardcoded dev hostnames — those are only a last-resort static
 * fallback when nothing about the running cluster is known at all.
 */
function baseDomain(cfg: Partial<PlatformConfig>, page?: PageLocation): { protocol: string; host: string } | null {
  const proto = page?.protocol ?? 'https:'
  const publicBase = (cfg.publicBaseDomain ?? '').trim()
  if (publicBase) return { protocol: proto, host: publicBase }
  if (page) {
    const rest = page.host.split('.').slice(1).join('.')
    if (rest.includes('.')) return { protocol: proto, host: rest }
  }
  for (const t of Object.values(cfg.tools ?? {})) {
    if (!t.configured || !t.url) continue
    try {
      const u = new URL(t.url)
      const rest = u.host.split('.').slice(1).join('.')
      if (rest) return { protocol: u.protocol, host: rest }
    } catch {
      /* skip malformed */
    }
  }
  return null
}

/**
 * Resolve each app's REAL launch URL + availability from `/api/config` (which
 * reports every backing tool's configured state and external URL for this
 * deployment). Resolution order per app:
 *
 *   1. `via` deep-link — e.g. Loki/Prometheus/Tempo open Grafana Explore when
 *      Grafana is configured (their raw endpoints are APIs, not UIs).
 *   2. The first configured backing tool's BFF-reported URL (authoritative).
 *   3. `https://<sub>.<clusterBaseDomain>` derived from the base domain
 *      inferred from any configured tool — covers configured tools whose
 *      external URL isn't reported (e.g. the k8s apiserver → dashboard host).
 *   4. The static dev-canonical URL as the last resort.
 *
 * Availability is the BFF's word: an app whose backing tools all report
 * unconfigured renders dimmed ("not set up"), never as a broken link. Tools
 * the BFF reports configured but that have no client metadata still surface
 * as generic tiles, so discovery is complete in both directions.
 *
 * `makeTile` adds what the launcher knows about an unrecognised app (its icon).
 */
export function resolveApps<T extends AppDescriptor>(
  apps: T[],
  cfg: Partial<PlatformConfig> | undefined,
  page: PageLocation | undefined,
  makeTile: (tile: AppDescriptor) => T,
): Array<ResolvedDescriptor<T>> {
  const map = cfg?.tools ?? {}
  const routes = cfg?.discoveredApps ?? []
  // Which tool ids the cluster's Gateway actually routes. Every tool reports
  // `configured: true` because its URL is DERIVED from the base domain, so
  // this is the only evidence that a door exists behind a tile.
  const routed = new Set(routes.map((a) => a.id))
  const base = baseDomain(cfg ?? {}, page)

  // Does this cluster tell us anything about its routes at all? Discovery
  // fails closed to an empty list (no RBAC, an API error, a dev build with no
  // cluster), and in that case the curated registry is all we have.
  const hasRouteEvidence = routed.size > 0

  const out = apps.map((a): ResolvedDescriptor<T> => {
    const toolIds = a.tools ?? [a.id]
    const infos = toolIds
      .map((id) => map[id])
      .filter((i): i is NonNullable<typeof i> => Boolean(i))
    // Availability.
    //
    // `info.configured` is NOT evidence that an app exists: every tool in the
    // registry reports configured:true because its URL is DERIVED from the
    // base domain rather than observed. The dynamic loop below has always
    // known this and required a route; the curated tiles above did not, and
    // that asymmetry is what put dead tiles in the drawer — a curated entry
    // the BFF has never heard of fell through to `true` and rendered as a
    // live app. On the AWS cluster (2026-10-09) that was `n8n` and
    // `pyroscope`, both `enabled: false` in every profile and therefore
    // never routed, plus `nexus`, whose Application had not synced. Three
    // tiles that cost a sign-in round trip to reach a 404.
    //
    // So when the cluster has told us its routes, a route (its own, its
    // `sub`, one of its backing tools, or the tool it deep-links through) or
    // an operator-set absolute URL is what makes a tile real.
    const routeIds = [a.id, a.sub, a.via?.tool, ...(a.tools ?? [])]
      .filter((id): id is string => Boolean(id))
    const hasRoute = routeIds.some((id) => routed.has(id))
    // Only an operator-set URL off the platform's base domain counts here: the
    // BFF also reports DERIVED `<tool>.<base>` URLs for every registry tool,
    // which kept uninstalled apps (MLflow, 2026-10-24) in the drawer. Older
    // BFFs don't send `explicit`; for them the route is the only evidence.
    const explicitUrl = infos.some((i) => i.configured && Boolean(i.url) && i.explicit === true)
    const configured = hasRouteEvidence
      ? hasRoute || explicitUrl
      : infos.length
        ? infos.some((i) => i.configured)
        : true

    let url = ''
    const viaInfo = a.via ? map[a.via.tool] : undefined
    if (a.via && viaInfo?.configured && viaInfo.url) {
      url = viaInfo.url.replace(/\/$/, '') + a.via.path
    } else {
      const primary = infos.find((i) => i.configured && i.url)
      if (primary) url = primary.url
      else if (base) url = `${base.protocol}//${a.sub ?? a.id}.${base.host}`
    }
    if (!url) url = a.url
    if (a.path && !a.via) url = url.replace(/\/+$/, '') + a.path
    return { ...a, url, configured }
  })

  // Surface what the cluster routes that has no client metadata — this is how a
  // package nobody has heard of reaches the drawer.
  const covered = new Set<string>()
  for (const a of apps) {
    covered.add(a.id)
    // `sub` too: the OpenBao tile is `id: 'vault'` with `sub: 'openbao'`,
    // so without this the tool id `openbao` counted as uncovered and the
    // launcher drew a second, generic OpenBao tile beside the real one.
    if (a.sub) covered.add(a.sub)
    for (const t of a.tools ?? []) covered.add(t)
  }
  for (const route of routes) {
    const { id } = route
    if (covered.has(id) || HIDDEN_TOOL_IDS.has(id)) continue
    // Routed, but what answers is an API: no door to offer.
    if (route.ui === false) continue
    // Tools reachable only via an adhar-controlplane URL report `url: ''` — derive
    // their public host from the base domain instead of dropping them, so
    // every configured platform app is launchable (not just the few whose
    // public URL the BFF happens to know).
    const url = route.url || map[id]?.url || (base ? `${base.protocol}//${id}.${base.host}` : '')
    if (!url) continue
    const tile = makeTile({
      id,
      name: titleize(id),
      description: 'Discovered from a route on this cluster',
      url,
      category: categoryForPackage(route.category),
    })
    out.push({ ...tile, configured: true })
  }
  // Drop what this cluster does not run. Dimming an app as "not set up" is
  // the right affordance for something an operator could still turn on in
  // THIS console; a package that is `enabled: false` in the profile is not
  // that, and a greyed-out row of them is noise in front of the apps that do
  // exist. Only ever filtered when discovery actually reported routes, so a
  // console with no cluster access still shows the full curated registry.
  return hasRouteEvidence ? out.filter((a) => a.configured) : out
}
