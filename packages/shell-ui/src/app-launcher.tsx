import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
import {
  AirbyteIcon,
  ArgoCDIcon,
  ArgoRolloutsIcon,
  ArgoWorkflowsIcon,
  CoderIcon,
  CrossplaneIcon,
  FalcoIcon,
  GiteaIcon,
  GrafanaIcon,
  HarborIcon,
  IcebergIcon,
  KargoIcon,
  KeycloakIcon,
  KubernetesIcon,
  KyvernoIcon,
  LokiIcon,
  MetabaseIcon,
  MinIOIcon,
  OpenCostIcon,
  OTelIcon,
  PlaneIcon,
  PostHogIcon,
  PrometheusIcon,
  TektonIcon,
  TempoIcon,
  TrivyIcon,
  VaultIcon,
} from './brand-icons.tsx'

export type AppCategory =
  | 'Code'
  | 'Build & CI'
  | 'Deploy'
  | 'Registry'
  | 'Observe'
  | 'Data'
  | 'Security'
  | 'Platform'

export interface AppLink {
  id: string
  name: string
  description: string
  /** Static dev-canonical URL — the last-resort fallback; runtime resolution
   *  prefers the BFF-reported URL (see useResolvedApps). */
  url: string
  category: AppCategory
  icon: ReactNode
  /** BFF tool ids whose configured/url state drives this app. Defaults to
   *  `[id]`. First configured entry wins for URL resolution. */
  tools?: string[]
  /** Ingress subdomain when it differs from the id, for base-domain
   *  derivation (e.g. argo-workflows → `workflows.<base>`). */
  sub?: string
  /** Deep-link through another tool's UI — e.g. Loki opens Grafana Explore. */
  via?: { tool: string; path: string }
}

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
 */
export const DEFAULT_APP_LINKS: AppLink[] = [
  // ── Code ──────────────────────────────────────────────────────────────────
  {
    id: 'gitea',
    name: 'Gitea',
    description: 'Source control & code review',
    url: 'https://gitea.adhar.localtest.me:8443',
    category: 'Code',
    icon: <GiteaIcon />,
  },
  {
    id: 'plane',
    name: 'Plane',
    description: 'Issues, sprints & roadmaps',
    url: 'https://plane.adhar.localtest.me:8443',
    category: 'Code',
    icon: <PlaneIcon />,
  },
  {
    id: 'coder',
    name: 'Coder',
    description: 'Cloud development workspaces',
    url: 'https://coder.adhar.localtest.me:8443',
    category: 'Code',
    icon: <CoderIcon />,
  },

  // ── Build & CI ────────────────────────────────────────────────────────────
  {
    id: 'argo-workflows',
    name: 'Argo Workflows',
    description: 'Container-native CI pipelines',
    url: 'https://workflows.adhar.localtest.me:8443',
    category: 'Build & CI',
    sub: 'workflows',
    icon: <ArgoWorkflowsIcon />,
  },
  {
    id: 'tekton',
    name: 'Tekton',
    description: 'Kubernetes-native build tasks',
    url: 'https://tekton.adhar.localtest.me:8443',
    category: 'Build & CI',
    icon: <TektonIcon />,
  },

  // ── Deploy ────────────────────────────────────────────────────────────────
  {
    id: 'argocd',
    name: 'Argo CD',
    description: 'GitOps continuous delivery',
    url: 'https://argocd.adhar.localtest.me:8443',
    category: 'Deploy',
    icon: <ArgoCDIcon />,
  },
  {
    id: 'kargo',
    name: 'Kargo',
    description: 'Multi-stage promotion',
    url: 'https://kargo.adhar.localtest.me:8443',
    category: 'Deploy',
    icon: <KargoIcon />,
  },
  {
    id: 'argo-rollouts',
    name: 'Argo Rollouts',
    description: 'Progressive delivery & canaries',
    url: 'https://rollouts.adhar.localtest.me:8443',
    category: 'Deploy',
    sub: 'rollouts',
    icon: <ArgoRolloutsIcon />,
  },

  // ── Registry ──────────────────────────────────────────────────────────────
  {
    id: 'harbor',
    name: 'Harbor',
    description: 'Container images & artifacts',
    url: 'https://harbor.adhar.localtest.me:8443',
    category: 'Registry',
    icon: <HarborIcon />,
  },

  // ── Observe ───────────────────────────────────────────────────────────────
  {
    id: 'grafana',
    name: 'Grafana',
    description: 'Dashboards & alerting',
    url: GRAFANA_DEV,
    category: 'Observe',
    icon: <GrafanaIcon />,
  },
  {
    id: 'loki',
    name: 'Loki',
    description: 'Logs — Grafana Explore',
    url: `${GRAFANA_DEV}${exploreLeft('loki')}`,
    category: 'Observe',
    tools: ['grafana', 'loki'],
    via: { tool: 'grafana', path: exploreLeft('loki') },
    icon: <LokiIcon />,
  },
  {
    id: 'prometheus',
    name: 'Prometheus',
    description: 'Metrics — Mimir-backed',
    url: `${GRAFANA_DEV}${exploreLeft('prometheus')}`,
    category: 'Observe',
    tools: ['grafana', 'prometheus', 'mimir'],
    via: { tool: 'grafana', path: exploreLeft('prometheus') },
    icon: <PrometheusIcon />,
  },
  {
    id: 'tempo',
    name: 'Tempo',
    description: 'Traces — Grafana Explore',
    url: `${GRAFANA_DEV}${exploreLeft('tempo')}`,
    category: 'Observe',
    tools: ['grafana', 'tempo'],
    via: { tool: 'grafana', path: exploreLeft('tempo') },
    icon: <TempoIcon />,
  },
  {
    id: 'otel',
    name: 'OpenTelemetry',
    description: 'Collector & pipelines',
    url: 'https://otel.adhar.localtest.me:8443',
    category: 'Observe',
    icon: <OTelIcon />,
  },
  {
    id: 'opencost',
    name: 'OpenCost',
    description: 'Cost allocation & spend',
    url: 'https://opencost.adhar.localtest.me:8443',
    category: 'Observe',
    icon: <OpenCostIcon />,
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  {
    id: 'airbyte',
    name: 'Airbyte',
    description: 'ELT & data ingestion',
    url: 'https://airbyte.adhar.localtest.me:8443',
    category: 'Data',
    icon: <AirbyteIcon />,
  },
  {
    id: 'metabase',
    name: 'Metabase',
    description: 'BI & ad-hoc analytics',
    url: 'https://metabase.adhar.localtest.me:8443',
    category: 'Data',
    icon: <MetabaseIcon />,
  },
  {
    id: 'minio',
    name: 'MinIO',
    description: 'S3 object storage (RustFS)',
    url: 'https://minio.adhar.localtest.me:8443',
    category: 'Data',
    icon: <MinIOIcon />,
  },
  {
    id: 'iceberg',
    name: 'Iceberg',
    description: 'Lakehouse table format',
    url: 'https://iceberg.adhar.localtest.me:8443',
    category: 'Data',
    icon: <IcebergIcon />,
  },
  {
    id: 'posthog',
    name: 'PostHog',
    description: 'Product analytics & flags',
    url: 'https://posthog.adhar.localtest.me:8443',
    category: 'Data',
    icon: <PostHogIcon />,
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'keycloak',
    name: 'Keycloak',
    description: 'Identity & SSO',
    url: 'https://keycloak.adhar.localtest.me:8443',
    category: 'Security',
    icon: <KeycloakIcon />,
  },
  {
    id: 'vault',
    name: 'Vault',
    description: 'Secrets management',
    url: 'https://vault.adhar.localtest.me:8443',
    category: 'Security',
    icon: <VaultIcon />,
  },
  {
    id: 'kyverno',
    name: 'Kyverno',
    description: 'Policy engine',
    url: 'https://kyverno.adhar.localtest.me:8443',
    category: 'Security',
    icon: <KyvernoIcon />,
  },
  {
    id: 'falco',
    name: 'Falco',
    description: 'Runtime threat detection',
    url: 'https://falco.adhar.localtest.me:8443',
    category: 'Security',
    icon: <FalcoIcon />,
  },
  {
    id: 'trivy',
    name: 'Trivy',
    description: 'Image scanning (via Harbor)',
    url: 'https://harbor.adhar.localtest.me:8443',
    category: 'Security',
    tools: ['trivy', 'harbor'],
    sub: 'harbor',
    icon: <TrivyIcon />,
  },

  // ── Platform ──────────────────────────────────────────────────────────────
  {
    id: 'crossplane',
    name: 'Crossplane',
    description: 'Infrastructure composition',
    url: 'https://crossplane.adhar.localtest.me:8443',
    category: 'Platform',
    icon: <CrossplaneIcon />,
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    description: 'Cluster dashboard (Headlamp)',
    url: 'https://dashboard.adhar.localtest.me:8443',
    category: 'Platform',
    tools: ['k8s'],
    sub: 'dashboard',
    icon: <KubernetesIcon />,
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

interface ToolInfo {
  configured: boolean
  url: string
}

/** Tool ids in `/api/config` that are aliases of other entries — never tiles. */
const HIDDEN_TOOL_IDS = new Set(['lgtm'])

function titleize(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

function GenericAppIcon({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      className="flex h-10 w-10 items-center justify-center rounded-[9px] bg-surface-sunken text-sm font-bold uppercase text-content-muted ring-1 ring-edge-subtle"
    >
      {label.slice(0, 2)}
    </span>
  )
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
 */
function useResolvedApps(apps: AppLink[]): { apps: ResolvedApp[]; loading: boolean } {
  const [tools, setTools] = useState<Record<string, ToolInfo> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    fetch('/api/config', { credentials: 'include', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { tools?: Record<string, ToolInfo> } | null) => {
        if (!alive) return
        setTools(d?.tools ?? {})
        setLoading(false)
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const resolved = useMemo<ResolvedApp[]>(() => {
    const map = tools ?? {}
    // Infer the cluster base domain (e.g. adhar.localtest.me:8443) from any
    // configured tool URL, to build correct URLs for apps whose external URL
    // the BFF doesn't report.
    let base: { protocol: string; host: string } | null = null
    for (const t of Object.values(map)) {
      if (!t.configured || !t.url) continue
      try {
        const u = new URL(t.url)
        const rest = u.host.split('.').slice(1).join('.')
        if (rest) {
          base = { protocol: u.protocol, host: rest }
          break
        }
      } catch {
        /* skip malformed */
      }
    }

    const out = apps.map((a): ResolvedApp => {
      const toolIds = a.tools ?? [a.id]
      const infos = toolIds
        .map((id) => map[id])
        .filter((i): i is ToolInfo => Boolean(i))
      // Availability: the BFF's word when it knows the tool(s); apps unknown
      // to the BFF (custom `apps` prop entries) stay launchable as given.
      const configured = infos.length ? infos.some((i) => i.configured) : true

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
      return { ...a, url, configured }
    })

    // Surface BFF-configured tools that have no client metadata yet — dynamic
    // discovery must not silently drop them.
    const covered = new Set<string>()
    for (const a of apps) {
      covered.add(a.id)
      for (const t of a.tools ?? []) covered.add(t)
    }
    for (const [id, info] of Object.entries(map)) {
      if (covered.has(id) || HIDDEN_TOOL_IDS.has(id)) continue
      if (!info.configured || !info.url) continue
      out.push({
        id,
        name: titleize(id),
        description: 'Platform service',
        url: info.url,
        category: 'Platform',
        icon: <GenericAppIcon label={id} />,
        configured: true,
      })
    }
    return out
  }, [apps, tools])

  return { apps: resolved, loading: loading && tools === null }
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
 * in the platform. The catalogue is discovered dynamically from `/api/config`:
 * configured tools launch with their environment-correct URL; unconfigured
 * ones stay visible but dimmed. Pins and recents persist per user in
 * localStorage. Everything opens in a new tab under Keycloak SSO.
 */
export function AppLauncher({ apps = DEFAULT_APP_LINKS }: AppLauncherProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const { apps: resolved, loading } = useResolvedApps(apps)
  const [pins, setPins] = useStoredIds(PINS_KEY, 24)
  const [recents, setRecents] = useStoredIds(RECENTS_KEY, RECENTS_MAX)

  // Autofocus the search when the panel opens.
  useEffect(() => {
    if (open) {
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
    <div className="relative">
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
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Application launcher"
            onKeyDown={onPanelKeyDown}
            className="absolute right-0 top-full z-50 mt-2 w-160 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-2xl ring-1 ring-edge-default"
          >
            <div className="relative overflow-hidden border-b border-edge-subtle bg-linear-to-br from-brand-50/60 dark:from-brand-500/10 via-surface-raised to-surface-raised px-4 pb-3 pt-3.5">
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

            <div className="max-h-[65vh] overflow-y-auto p-4">
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
            <div className="flex items-center justify-between gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-4 py-2 text-[11px] text-content-muted">
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
  const iconBox = (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-raised shadow-sm ring-1 ring-edge-subtle transition-transform duration-150 group-hover:scale-105 [&>svg]:h-7 [&>svg]:w-7">
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
          'hover:-translate-y-0.5 hover:shadow-md focus-visible:-translate-y-0.5 focus-visible:shadow-md focus-visible:ring-2 focus-visible:ring-brand-400/40',
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
          'hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40',
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
      strokeWidth="2"
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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function IconArrowUpRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
      strokeWidth="2"
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
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
