import { isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@adhar/utils'
import { type AppCategory, type AppDescriptor, resolveApps } from './app-catalog.ts'
import { APP_CONFIG_QUERY_KEY, useAppConfig, useLiveAppConfig } from './app-config.ts'
import { useClickOutside } from './use-click-outside.ts'
import { autofocusSearch } from './use-media-query.ts'
import {
  KubernetesIcon,
} from './brand-icons.tsx'
import { ToolLogo, toolLogoWantsLightTile } from './tool-logo.tsx'

export type { AppCategory } from './app-catalog.ts'

export interface AppLink extends AppDescriptor {
  icon: ReactNode
}

/** A launcher tile's official bundled logo (28px, inside the tile's own box). */
const logo = (tool: string) => <ToolLogo tool={tool} size={28} tile={false} />

/** Grafana Explore deep-link for a given datasource. */
const exploreLeft = (datasource: string) =>
  `/explore?left=${encodeURIComponent(JSON.stringify({ datasource }))}`

const GRAFANA_DEV = 'https://grafana.adhar.localtest.me:8443'

/**
 * Client-side app metadata registry, keyed by the SAME tool ids the BFF's
 * tool registry uses. Names, descriptions, brand icons and categories live
 * here (the BFF can't provide them); AVAILABILITY and the authoritative URL
 * come from `/api/config` at runtime. The `url` below is only the canonical
 * dev hostname used as a last-resort fallback (and by static call sites).
 *
 * This list is enrichment, not a gate: a package with no entry here still gets
 * a tile from its route (see `resolveApps`). An entry is only worth adding for a
 * better name, description or section than the generic ones.
 */
export const DEFAULT_APP_LINKS: AppLink[] = [
  // ── Code ──────────────────────────────────────────────────────────────────
  {
    id: 'gitea',
    name: 'Gitea',
    description: 'Source control & code review',
    url: 'https://gitea.adhar.localtest.me:8443',
    category: 'Code',
    icon: logo('gitea'),
  },
  {
    id: 'plane',
    name: 'Plane',
    description: 'Issues, sprints & roadmaps',
    url: 'https://plane.adhar.localtest.me:8443',
    category: 'Code',
    icon: logo('plane'),
  },
  {
    id: 'coder',
    name: 'Coder',
    description: 'Cloud development workspaces',
    url: 'https://coder.adhar.localtest.me:8443',
    category: 'Code',
    icon: logo('coder'),
  },

  // ── Build & CI ────────────────────────────────────────────────────────────
  {
    id: 'tekton',
    name: 'Tekton',
    description: 'Kubernetes-native build tasks',
    url: 'https://tekton.adhar.localtest.me:8443',
    category: 'Build & CI',
    icon: logo('tekton'),
  },

  // ── Deploy ────────────────────────────────────────────────────────────────
  {
    id: 'argocd',
    name: 'Argo CD',
    description: 'GitOps continuous delivery',
    url: 'https://argocd.adhar.localtest.me:8443',
    category: 'Deploy',
    icon: logo('argo'),
  },
  {
    id: 'kargo',
    name: 'Kargo',
    description: 'Multi-stage promotion',
    url: 'https://kargo.adhar.localtest.me:8443',
    category: 'Deploy',
    icon: logo('kargo'),
  },
  {
    id: 'argo-rollouts',
    name: 'Argo Rollouts',
    description: 'Progressive delivery & canaries',
    url: 'https://argo-rollout.adhar.localtest.me:8443',
    category: 'Deploy',
    sub: 'argo-rollout',
    icon: logo('argo'),
  },

  // ── Registry ──────────────────────────────────────────────────────────────
  {
    id: 'harbor',
    name: 'Harbor',
    description: 'Container images & artifacts',
    url: 'https://harbor.adhar.localtest.me:8443',
    category: 'Registry',
    icon: logo('harbor'),
  },

  // ── Observe ───────────────────────────────────────────────────────────────
  {
    id: 'grafana',
    name: 'Grafana',
    description: 'Dashboards & alerting',
    url: GRAFANA_DEV,
    category: 'Observe',
    icon: logo('grafana'),
  },
  {
    id: 'prometheus',
    name: 'Prometheus',
    description: 'Metrics, targets, alerts and rules',
    // Opens Prometheus's OWN UI at prometheus.<base>, which sits behind an
    // oauth2-proxy that signs a Keycloak-session user straight in. It used to
    // deep-link into Grafana Explore (`via: grafana`), so the tile never opened
    // Prometheus (2026-10-24). Loki and Tempo keep the Grafana route: they
    // have no UI of their own.
    url: 'https://prometheus.adhar.localtest.me:8443',
    category: 'Observe',
    icon: logo('prometheus'),
  },
  {
    id: 'hubble',
    name: 'Hubble',
    description: 'Network flows (Cilium)',
    url: 'https://hubble.adhar.localtest.me:8443',
    category: 'Observe',
    icon: logo('hubble'),
  },
  {
    id: 'kafka-ui',
    name: 'Kafka UI',
    description: 'Topics, consumers & messages',
    url: 'https://kafka-ui.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('kafka-ui'),
  },
  {
    id: 'jupyterhub',
    name: 'JupyterHub',
    description: 'Notebooks & data science',
    url: 'https://jupyterhub.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('jupyterhub'),
  },
  {
    id: 'opencost',
    name: 'OpenCost',
    description: 'Cost allocation & spend',
    url: 'https://opencost.adhar.localtest.me:8443',
    category: 'Observe',
    icon: logo('opencost'),
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  {
    id: 'airbyte',
    name: 'Airbyte',
    description: 'ELT & data ingestion',
    url: 'https://airbyte.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('airbyte'),
  },
  {
    id: 'metabase',
    name: 'Metabase',
    description: 'BI & ad-hoc analytics',
    url: 'https://metabase.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('metabase'),
  },
  {
    id: 'posthog',
    name: 'PostHog',
    description: 'Product analytics & flags',
    url: 'https://posthog.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('posthog'),
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'keycloak',
    name: 'Keycloak',
    description: 'Identity & SSO',
    url: 'https://keycloak.adhar.localtest.me:8443',
    category: 'Security',
    icon: logo('keycloak'),
  },
  {
    // The platform ships OpenBao, the Linux Foundation fork of Vault. Its
    // ingress is `openbao.<base>`; the `vault` Service is only an adhar-controlplane
    // compatibility alias, so deriving the host from the id gave a dead link.
    // The id stays `vault` so existing pins and the BFF tool id keep working.
    id: 'vault',
    name: 'OpenBao',
    description: 'Secrets management',
    sub: 'openbao',
    url: 'https://openbao.adhar.localtest.me:8443',
    // Opens OpenBao's click-free sign-in page, not the bare UI (2026-10-24):
    // OpenBao's own sign-in page needs a click (its OIDC runs in a popup) and
    // used to open on ?with=token. The page signs the user in through their
    // existing Keycloak session and hands the UI its token (platform repo:
    // security/keycloak/manifests/sso-start.yaml, openbao.html).
    path: '/adhar-sso/openbao.html',
    category: 'Security',
    icon: logo('openbao'),
  },
  {
    // Kyverno + Trivy have no standalone UI; Policy Reporter is where their
    // policy results and image-vulnerability reports actually render.
    id: 'policy-reporter',
    name: 'Policy Reporter',
    description: 'Kyverno policy & Trivy vulnerability reports',
    url: 'https://policy-reporter.adhar.localtest.me:8443',
    category: 'Security',
    icon: logo('kyverno'),
  },

  // ── Registry ──────────────────────────────────────────────────────────────
  {
    id: 'nexus',
    name: 'Nexus',
    description: 'Artifact & dependency repository',
    url: 'https://nexus.adhar.localtest.me:8443',
    category: 'Registry',
    icon: logo('nexus'),
  },

  // ── Platform ──────────────────────────────────────────────────────────────
  {
    // Headlamp is the cluster's web dashboard (replaces the old generic
    // "Kubernetes" tile, which pointed at a non-existent dashboard host).
    id: 'headlamp',
    name: 'Headlamp',
    description: 'Kubernetes cluster dashboard',
    url: 'https://headlamp.adhar.localtest.me:8443',
    category: 'Platform',
    icon: logo('headlamp'),
  },
  {
    // The platform ships LitmusChaos, not Chaos Mesh: `chaos-mesh.<domain>`
    // has no route any more and `litmus.<domain>` does. The console's own
    // Chaos page drives Litmus directly (ChaosEngine / ChaosResult), so this
    // entry is the Chaos Center UI for what the page does not cover.
    id: 'litmus',
    name: 'LitmusChaos',
    description: 'Chaos engineering experiments',
    url: 'https://litmus.adhar.localtest.me:8443',
    category: 'Platform',
    icon: logo('litmus'),
  },
  {
    id: 'n8n',
    name: 'n8n',
    description: 'Workflow automation',
    url: 'https://n8n.adhar.localtest.me:8443',
    category: 'Platform',
    icon: logo('n8n'),
  },
  {
    id: 'strapi',
    name: 'Strapi',
    description: 'Headless CMS & content API',
    url: 'https://strapi.adhar.localtest.me:8443',
    category: 'Code',
    icon: logo('strapi'),
  },
  {
    id: 'penpot',
    name: 'Penpot',
    description: 'Design & prototyping',
    url: 'https://penpot.adhar.localtest.me:8443',
    category: 'Code',
    icon: logo('penpot'),
  },

  // ── Observe (LGTM + Grafana products) ──────────────────────────────────────
  // Loki and Tempo have routes, but what answers on them is an API — opening
  // one in a browser lands on a sign-in page and then a 404. Grafana Explore
  // IS their UI, so these open it on the right datasource, exactly as
  // Prometheus already did. Mimir is gone entirely: the Prometheus tile
  // already lists it among its backing tools, so it was the same door twice.
  {
    id: 'loki',
    name: 'Loki',
    description: 'Logs — explore in Grafana',
    url: `${GRAFANA_DEV}${exploreLeft('loki')}`,
    category: 'Observe',
    tools: ['grafana', 'loki'],
    via: { tool: 'grafana', path: exploreLeft('loki') },
    icon: logo('loki'),
  },
  {
    id: 'tempo',
    name: 'Tempo',
    description: 'Traces — explore in Grafana',
    url: `${GRAFANA_DEV}${exploreLeft('tempo')}`,
    category: 'Observe',
    tools: ['grafana', 'tempo'],
    via: { tool: 'grafana', path: exploreLeft('tempo') },
    icon: logo('tempo'),
  },
  {
    id: 'pyroscope',
    name: 'Pyroscope',
    description: 'Continuous profiling',
    url: 'https://pyroscope.adhar.localtest.me:8443',
    category: 'Observe',
    icon: logo('pyroscope'),
  },
  {
    id: 'oncall',
    name: 'Grafana OnCall',
    description: 'On-call schedules & escalations',
    url: 'https://oncall.adhar.localtest.me:8443',
    category: 'Observe',
    icon: logo('oncall'),
  },

  // ── Data platform ──────────────────────────────────────────────────────────
  {
    id: 'dagster',
    name: 'Dagster',
    description: 'Data orchestration',
    url: 'https://dagster.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('dagster'),
  },
  {
    id: 'prefect',
    name: 'Prefect',
    description: 'Workflow orchestration',
    url: 'https://prefect.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('prefect'),
  },
  {
    id: 'kubeflow',
    name: 'Kubeflow',
    description: 'ML pipelines & notebooks',
    url: 'https://kubeflow.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('kubeflow'),
  },
  {
    id: 'mlflow',
    name: 'MLflow',
    description: 'Experiment tracking & model registry',
    url: 'https://mlflow.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('mlflow'),
  },
  {
    id: 'open-metadata',
    name: 'OpenMetadata',
    description: 'Data catalog & lineage',
    url: 'https://open-metadata.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('open-metadata'),
  },
  {
    id: 'opensearch',
    name: 'OpenSearch',
    description: 'Search & analytics',
    url: 'https://opensearch.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('opensearch'),
  },
  {
    id: 'trino',
    name: 'Trino',
    description: 'Distributed SQL queries',
    url: 'https://trino.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('trino'),
  },
  {
    id: 'rabbitmq',
    name: 'RabbitMQ',
    description: 'Message broker',
    url: 'https://rabbitmq.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('rabbitmq'),
  },
  {
    // The UI is Redis Commander (MIT; RedisInsight is SSPL), but nobody on this
    // platform asked for Redis Commander — they asked to look inside the
    // platform's Valkey. Without this entry the tile came from dynamic route
    // discovery as a generic grey square titled from its hostname, and clicking
    // it opened something branded for a different product entirely.
    id: 'valkey-admin',
    name: 'Valkey Admin',
    description: 'Browse & edit the platform caches',
    url: 'https://valkey-admin.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('valkey'),
  },
  {
    id: 'rustfs',
    name: 'RustFS',
    description: 'S3-compatible object storage',
    url: 'https://rustfs.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('rustfs'),
  },
  {
    id: 'libredb',
    name: 'LibreDB Studio',
    description: 'SQL browser & database studio',
    url: 'https://libredb.adhar.localtest.me:8443',
    category: 'Data',
    icon: logo('libredb-studio'),
  },
]

const CATEGORY_ORDER: AppCategory[] = [
  'Code',
  'Build & CI',
  'Deploy',
  'Registry',
  'Observe',
  'Data',
  'Security',
  'Platform',
]

const CATEGORY_TONE: Record<AppCategory, { tile: string; ring: string; dot: string }> = {
  Code: {
    tile: 'bg-linear-to-br from-emerald-50/80 dark:from-emerald-500/10 via-surface-raised to-surface-raised',
    ring: 'ring-emerald-100 dark:ring-emerald-500/20 group-hover:ring-emerald-200 dark:group-hover:ring-emerald-500/30',
    dot: 'bg-emerald-400',
  },
  'Build & CI': {
    tile: 'bg-linear-to-br from-cyan-50/80 dark:from-cyan-500/10 via-surface-raised to-surface-raised',
    ring: 'ring-cyan-100 dark:ring-cyan-500/20 group-hover:ring-cyan-200 dark:group-hover:ring-cyan-500/30',
    dot: 'bg-cyan-400',
  },
  Deploy: {
    tile: 'bg-linear-to-br from-sky-50/80 dark:from-sky-500/10 via-surface-raised to-surface-raised',
    ring: 'ring-sky-100 dark:ring-sky-500/20 group-hover:ring-sky-200 dark:group-hover:ring-sky-500/30',
    dot: 'bg-sky-400',
  },
  Registry: {
    tile: 'bg-linear-to-br from-teal-50/80 dark:from-teal-500/10 via-surface-raised to-surface-raised',
    ring: 'ring-teal-100 dark:ring-teal-500/20 group-hover:ring-teal-200 dark:group-hover:ring-teal-500/30',
    dot: 'bg-teal-400',
  },
  Observe: {
    tile: 'bg-linear-to-br from-amber-50/80 dark:from-amber-500/10 via-surface-raised to-surface-raised',
    ring: 'ring-amber-100 dark:ring-amber-500/20 group-hover:ring-amber-200 dark:group-hover:ring-amber-500/30',
    dot: 'bg-amber-400',
  },
  Data: {
    tile: 'bg-linear-to-br from-violet-50/80 dark:from-violet-500/10 via-surface-raised to-surface-raised',
    ring: 'ring-violet-100 dark:ring-violet-500/20 group-hover:ring-violet-200 dark:group-hover:ring-violet-500/30',
    dot: 'bg-violet-400',
  },
  Security: {
    tile: 'bg-linear-to-br from-rose-50/80 dark:from-rose-500/10 via-surface-raised to-surface-raised',
    ring: 'ring-rose-100 dark:ring-rose-500/20 group-hover:ring-rose-200 dark:group-hover:ring-rose-500/30',
    dot: 'bg-rose-400',
  },
  Platform: {
    tile: 'bg-linear-to-br from-brand-50/80 dark:from-brand-500/10 via-surface-raised to-surface-raised',
    ring: 'ring-brand-100 dark:ring-brand-500/20 group-hover:ring-brand-200 dark:group-hover:ring-brand-500/30',
    dot: 'bg-brand-400',
  },
}

interface AppLauncherProps {
  apps?: AppLink[]
}

export interface ResolvedApp extends AppLink {
  /** True when the BFF reports a backing tool configured for this app. */
  configured: boolean
}

// Dynamically-discovered tools have no client-side logo — default to the
// Kubernetes mark (every platform service runs on the cluster).
function GenericAppIcon(_props: { label: string }) {
  return <KubernetesIcon />
}

/**
 * Every platform app the running cluster actually exposes, with real brand
 * logos: the curated registry below merged with `/api/config` (configured
 * flag + authoritative URL) and with tools discovered from the cluster's
 * HTTPRoutes that have no client metadata. Used by the app launcher AND by
 * onboarding, so both show the same dynamically-discovered list.
 */
export function usePlatformApps(apps: AppLink[] = DEFAULT_APP_LINKS): { apps: ResolvedApp[]; loading: boolean } {
  return useResolvedApps(apps, true)
}

/**
 * `live`: keep the list current over the watch socket. The launcher turns it on
 * only while its panel is open (a closed drawer shows nothing, and every tab has
 * one) and refetches when it opens, so the list is right the moment anyone looks.
 */
function useResolvedApps(apps: AppLink[], live: boolean): { apps: ResolvedApp[]; loading: boolean } {
  const refetchInterval = useLiveAppConfig(live)
  const config = useAppConfig({ refetchInterval })
  const cfg = config.data
  const resolved = useMemo<ResolvedApp[]>(() => {
    const page = typeof window !== 'undefined'
      ? { protocol: window.location.protocol, host: window.location.host }
      : undefined
    return resolveApps<AppLink>(apps, cfg, page, (tile) => ({
      ...tile,
      icon: <ToolLogo tool={tile.id} size={28} tile={false} fallback={<GenericAppIcon label={tile.id} />} />,
    }))
  }, [apps, cfg])

  return { apps: resolved, loading: config.isLoading }
}

// ── Fuzzy matching (hand-rolled — no deps) ───────────────────────────────────

/**
 * Subsequence fuzzy score: every query char must appear in order. Consecutive
 * runs and word-boundary hits score higher; shorter targets get a small edge.
 * Returns -1 for no match.
 */
function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  let qi = 0
  let score = 0
  let streak = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak += 1
      score += 1 + streak * 2
      if (ti === 0 || ' -_&/().'.includes(t[ti - 1])) score += 8
      qi += 1
    } else {
      streak = 0
    }
  }
  if (qi < q.length) return -1
  return score + Math.max(0, 24 - t.length) * 0.25
}

/** Best weighted score across name/id/category/description; -1 = no match. */
function appScore(query: string, a: ResolvedApp): number {
  let best = -1
  const fields: Array<[string, number]> = [
    [a.name, 4],
    [a.id, 3],
    [a.category, 2],
    [a.description, 1],
  ]
  for (const [text, weight] of fields) {
    const s = fuzzyScore(query, text)
    if (s >= 0) best = Math.max(best, s * weight)
  }
  return best
}

// ── Pins + recents (localStorage) ────────────────────────────────────────────

const PINS_KEY = 'adhar.launcher.pins'
const RECENTS_KEY = 'adhar.launcher.recents'
const RECENTS_MAX = 8
const RECENTS_SHOWN = 6

function loadIds(key: string): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function useStoredIds(key: string, max: number): [string[], (ids: string[]) => void] {
  const [ids, setIdsState] = useState<string[]>(() => loadIds(key).slice(0, max))
  const setIds = (next: string[]) => {
    const capped = next.slice(0, max)
    setIdsState(capped)
    try {
      localStorage?.setItem(key, JSON.stringify(capped))
    } catch {
      /* storage unavailable — pins stay session-local */
    }
  }
  return [ids, setIds]
}

/**
 * App launcher — a searchable, keyboard-navigable drawer of every backing tool
 * in the platform. The catalogue is discovered dynamically from `/api/config`
 * and updates while open: configured tools launch with their environment-correct
 * URL; unconfigured ones stay visible but dimmed. Pins and recents persist per user in
 * localStorage. Everything opens in a new tab under Keycloak SSO.
 */
export function AppLauncher({ apps = DEFAULT_APP_LINKS }: AppLauncherProps) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  // A click anywhere outside the launcher closes it — including on the
  // sidebar and topbar, which sit above the old transparent backdrop.
  useClickOutside(rootRef, close, open, { escape: false })
  const { apps: resolved, loading } = useResolvedApps(apps, open)
  // Opening is the moment the list has to be right: a package may have been
  // enabled or disabled since this page loaded, and no watch runs while closed.
  useEffect(() => {
    if (open) void qc.invalidateQueries({ queryKey: APP_CONFIG_QUERY_KEY }, { cancelRefetch: false })
  }, [open, qc])
  const [pins, setPins] = useStoredIds(PINS_KEY, 24)
  const [recents, setRecents] = useStoredIds(RECENTS_KEY, RECENTS_MAX)

  // Autofocus the search when the panel opens — not on touch devices, where
  // it would raise the keyboard over the app grid.
  useEffect(() => {
    if (open) {
      if (!autofocusSearch()) return
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
    setQuery('')
  }, [open])

  // ESC (uncaptured by the panel) closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const trimmed = query.trim()
  const results = useMemo(() => {
    if (!trimmed) return null
    return resolved
      .map((a) => ({ a, s: appScore(trimmed, a) }))
      .filter((r) => r.s >= 0)
      .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name))
      .map((r) => r.a)
  }, [trimmed, resolved])

  const byId = useMemo(() => new Map(resolved.map((a) => [a.id, a])), [resolved])
  const pinnedApps = pins.map((id) => byId.get(id)).filter((a): a is ResolvedApp => Boolean(a))
  const recentApps = recents
    .map((id) => byId.get(id))
    .filter((a): a is ResolvedApp => Boolean(a) && a!.configured && !pins.includes(a!.id))
    .slice(0, RECENTS_SHOWN)

  const configuredCount = resolved.filter((a) => a.configured).length

  const togglePin = (id: string) =>
    setPins(pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id])

  const launch = (id: string) => {
    setRecents([id, ...recents.filter((r) => r !== id)])
    setOpen(false)
  }

  // Roving keyboard navigation over the visible tiles + `/` to search.
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    const panel = panelRef.current
    if (!panel) return
    if (e.key === 'Escape' && query) {
      // First ESC clears the query; the window listener (next ESC) closes.
      e.stopPropagation()
      setQuery('')
      inputRef.current?.focus()
      return
    }
    if (e.key === '/' && e.target !== inputRef.current) {
      e.preventDefault()
      inputRef.current?.focus()
      return
    }
    const nav = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!nav.includes(e.key)) return
    // Inside the search box, only ArrowDown drops into the grid — the rest
    // keep editing the text.
    if (e.target === inputRef.current && e.key !== 'ArrowDown') return
    const tiles = Array.from(panel.querySelectorAll<HTMLElement>('[data-app-tile]'))
    if (!tiles.length) return
    e.preventDefault()
    const idx = tiles.indexOf(document.activeElement as HTMLElement)
    let next: number
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tiles.length - 1
    else if (idx === -1) next = 0
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % tiles.length
    else next = (idx - 1 + tiles.length) % tiles.length
    tiles[next]?.focus()
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open app launcher"
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150',
          open
            ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 shadow-sm ring-1 ring-brand-200 dark:ring-brand-500/30'
            : 'text-content-muted hover:bg-surface-sunken hover:text-content',
        )}
      >
        <IconGrid />
      </button>
      {open ? (
        <>
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Application launcher"
            onKeyDown={onPanelKeyDown}
            className={cn(
              'z-50 overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-2xl ring-1 ring-edge-default',
              // Phones: the button is not the right-most icon, so a panel
              // anchored to it ran off the left edge. Pin it under the top bar
              // across the screen instead; from sm up it drops from the button.
              // It is a column capped to the screen, so the app list scrolls
              // inside it rather than running off the bottom.
              'fixed inset-x-2 top-[calc(3.5rem+env(safe-area-inset-top,0px)+0.5rem)] flex max-h-[calc(100dvh-4.5rem-env(safe-area-inset-top,0px))] flex-col',
              'sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:block sm:max-h-none sm:w-160 sm:max-w-[calc(100vw-2rem)]',
            )}
          >
            <div className="relative shrink-0 overflow-hidden border-b border-edge-subtle bg-linear-to-br from-brand-50/60 dark:from-brand-500/10 via-surface-raised to-surface-raised px-4 pb-3 pt-3.5">
              <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-brand-100/40 dark:bg-brand-500/15 blur-3xl" aria-hidden />
              <div className="relative flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-content">
                    <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-600/90 text-white shadow-sm">
                      <IconSparkle />
                    </span>
                    Adhar apps
                    <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-100 dark:ring-emerald-500/20">
                      <IconLock />
                      SSO
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-content-muted">
                    Opens in a new tab — you're signed in automatically via Keycloak SSO.
                  </div>
                </div>
                {loading ? null : (
                  <span className="shrink-0 rounded-full bg-surface-sunken px-2 py-1 font-mono text-[10px] tabular-nums text-content-muted ring-1 ring-inset ring-edge-subtle">
                    {configuredCount}/{resolved.length} configured
                  </span>
                )}
              </div>
              <div className="relative mt-2.5">
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search apps, categories…"
                  aria-label="Search apps"
                  className="h-9 w-full rounded-lg border border-edge-default bg-surface-raised/80 pl-8 pr-10 text-sm text-content shadow-sm backdrop-blur-sm transition-all placeholder:text-content-subtle focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
                />
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">
                  <IconSearch />
                </span>
                <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-edge-default bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-subtle">
                  /
                </kbd>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:max-h-[65vh] sm:flex-none">
              {loading ? (
                <LauncherSkeleton />
              ) : results ? (
                results.length === 0 ? (
                  <div className="py-10 text-center" role="status">
                    <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surface-sunken text-content-subtle">
                      <IconSearch />
                    </div>
                    <div className="text-sm font-medium text-content">No apps match "{query}"</div>
                    <div className="mt-0.5 text-xs text-content-muted">Try a different keyword.</div>
                  </div>
                ) : (
                  <section aria-label="Search results">
                    <div className="mb-2 flex items-center gap-2 px-1" aria-live="polite">
                      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-muted">
                        Results
                      </h3>
                      <span className="text-[10px] font-mono tabular-nums text-content-subtle">
                        {results.length}
                      </span>
                    </div>
                    <AppGrid apps={results} pins={pins} onTogglePin={togglePin} onLaunch={launch} />
                  </section>
                )
              ) : (
                <>
                  {pinnedApps.length > 0 ? (
                    <section aria-label="Pinned apps" className="mb-5">
                      <SectionHeader icon={<IconPin filled />} title="Pinned" count={pinnedApps.length} />
                      <AppGrid apps={pinnedApps} pins={pins} onTogglePin={togglePin} onLaunch={launch} />
                    </section>
                  ) : null}
                  {recentApps.length > 0 ? (
                    <section aria-label="Recently opened apps" className="mb-5">
                      <SectionHeader icon={<IconClock />} title="Recent" count={recentApps.length} />
                      <AppGrid apps={recentApps} pins={pins} onTogglePin={togglePin} onLaunch={launch} />
                    </section>
                  ) : null}
                  {CATEGORY_ORDER.map((cat) => {
                    const rows = resolved
                      .filter((a) => a.category === cat)
                      .sort((a, b) => Number(b.configured) - Number(a.configured))
                    if (!rows.length) return null
                    const ready = rows.filter((a) => a.configured).length
                    const tone = CATEGORY_TONE[cat]
                    return (
                      <section key={cat} aria-label={cat} className="mb-5 last:mb-0">
                        <SectionHeader
                          icon={<span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} aria-hidden />}
                          title={cat}
                          count={ready < rows.length ? `${ready}/${rows.length}` : rows.length}
                        />
                        <AppGrid apps={rows} pins={pins} onTogglePin={togglePin} onLaunch={launch} />
                      </section>
                    )
                  })}
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-4 py-2 text-[11px] text-content-muted">
              <span>
                {loading
                  ? 'Discovering apps…'
                  : `${configuredCount} of ${resolved.length} apps configured · single sign-on`}
              </span>
              <span className="font-mono text-content-subtle">↑↓ navigate · ↵ open · esc close</span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function SectionHeader({
  icon,
  title,
  count,
}: {
  icon: ReactNode
  title: string
  count: number | string
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <span className="flex items-center text-content-subtle">{icon}</span>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-muted">
        {title}
      </h3>
      <span className="text-[10px] font-mono tabular-nums text-content-subtle">{count}</span>
    </div>
  )
}

function LauncherSkeleton() {
  return (
    <div aria-hidden>
      <div className="mb-2 h-3 w-24 animate-pulse rounded bg-surface-sunken" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            className="h-26 animate-pulse rounded-xl bg-surface-sunken/70 ring-1 ring-edge-subtle"
            style={{ animationDelay: `${i * 60}ms` }}
          />
        ))}
      </div>
      <span className="sr-only">Loading apps…</span>
    </div>
  )
}

function AppGrid({
  apps,
  pins,
  onTogglePin,
  onLaunch,
}: {
  apps: ResolvedApp[]
  pins: string[]
  onTogglePin(id: string): void
  onLaunch(id: string): void
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {apps.map((a) => (
        <AppTile
          key={a.id}
          app={a}
          pinned={pins.includes(a.id)}
          onTogglePin={() => onTogglePin(a.id)}
          onLaunch={() => onLaunch(a.id)}
        />
      ))}
    </div>
  )
}

function AppTile({
  app: a,
  pinned,
  onTogglePin,
  onLaunch,
}: {
  app: ResolvedApp
  pinned: boolean
  onTogglePin(): void
  onLaunch(): void
}) {
  const tone = CATEGORY_TONE[a.category]
  // Dark-on-transparent official logos sit on a light tile in dark mode.
  const lightTile = isValidElement<{ tool?: string }>(a.icon) && a.icon.type === ToolLogo &&
    toolLogoWantsLightTile(a.icon.props.tool)
  const iconBox = (
    <div
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-raised shadow-sm ring-1 ring-edge-subtle transition-transform duration-150 group-hover:scale-105 [&>svg]:h-7 [&>svg]:w-7',
        lightTile && 'dark:bg-white',
      )}
    >
      {a.icon}
    </div>
  )
  const label = (
    <div className="min-w-0 w-full">
      <div className="flex items-center gap-1 text-[13px] font-semibold text-content">
        <span className="truncate">{a.name}</span>
        {a.configured ? (
          <span
            aria-hidden
            className="shrink-0 text-content-subtle opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <IconArrowUpRight />
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 line-clamp-1 text-[11px] text-content-muted">{a.description}</div>
    </div>
  )

  // Not configured in this deployment → keep it visible (the full catalogue
  // stays discoverable) but inert, never a dead link.
  if (!a.configured) {
    return (
      <div
        title={`${a.name} isn't configured in this environment yet`}
        aria-disabled
        className="relative flex cursor-not-allowed flex-col items-start gap-2.5 rounded-xl p-3 text-left opacity-55 ring-1 ring-edge-subtle"
      >
        <div className="grayscale">{iconBox}</div>
        {label}
        <span className="absolute right-2.5 top-2.5 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[9px] font-medium text-content-subtle">
          not set up
        </span>
      </div>
    )
  }

  return (
    <div className="group relative">
      <a
        href={a.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onLaunch}
        title={`Open ${a.name} — ${a.url}`}
        data-app-tile
        className={cn(
          'flex flex-col items-start gap-2.5 rounded-xl p-3 text-left transition-all duration-150 outline-none',
          tone.tile,
          'ring-1',
          tone.ring,
          'hover:-translate-y-0.5 hover:shadow-md focus-visible:-translate-y-0.5 focus-visible:shadow-md focus-visible:ring-2 focus-visible:ring-brand-500/40',
        )}
      >
        {iconBox}
        {label}
      </a>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          onTogglePin()
        }}
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${a.name}` : `Pin ${a.name}`}
        title={pinned ? `Unpin ${a.name}` : `Pin ${a.name}`}
        className={cn(
          'absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md transition-all duration-150',
          pinned
            ? 'text-amber-500 dark:text-amber-400 opacity-100'
            : 'text-content-subtle opacity-0 hover:text-content group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
          'hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40',
        )}
      >
        <IconPin filled={pinned} />
      </button>
    </div>
  )
}

function IconGrid() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function IconArrowUpRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  )
}

function IconSparkle() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2 13.6 8.4 20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2Z" />
    </svg>
  )
}

function IconLock() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

function IconPin({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2.62"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m12 2 3 6 6.5 1-4.75 4.6L17.9 20 12 16.9 6.1 20l1.15-6.4L2.5 9 9 8l3-6Z" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.62" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
