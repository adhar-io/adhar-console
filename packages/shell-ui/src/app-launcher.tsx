import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
import {
  AirbyteIcon,
  ArgoCDIcon,
  ArgoRolloutsIcon,
  ArgoWorkflowsIcon,
  CrossplaneIcon,
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
  OTelIcon,
  PlaneIcon,
  PrometheusIcon,
  TempoIcon,
} from './brand-icons.tsx'

export interface AppLink {
  id: string
  name: string
  description: string
  url: string
  category: AppCategory
  icon: ReactNode
}

type AppCategory =
  | 'Develop'
  | 'Deliver'
  | 'Observe'
  | 'Data'
  | 'Identity'
  | 'Policy'
  | 'Platform'

/**
 * Default app registry. Production should override this with values pulled from
 * the BFF (each tool's actual URL for the current tenant). URLs here use the
 * canonical dev hostnames used in the Adhar setup guide.
 */
export const DEFAULT_APP_LINKS: AppLink[] = [
  {
    id: 'gitea',
    name: 'Gitea',
    description: 'Source control + code review',
    url: 'https://gitea.adhar.local',
    category: 'Develop',
    icon: <GiteaIcon />,
  },
  {
    id: 'plane',
    name: 'Plane',
    description: 'Issues, roadmap, OKRs',
    url: 'https://plane.adhar.local',
    category: 'Develop',
    icon: <PlaneIcon />,
  },
  {
    id: 'argo-workflows',
    name: 'Argo Workflows',
    description: 'Container-native CI pipelines',
    url: 'https://workflows.adhar.local',
    category: 'Develop',
    icon: <ArgoWorkflowsIcon />,
  },

  {
    id: 'argocd',
    name: 'Argo CD',
    description: 'GitOps continuous delivery',
    url: 'https://argocd.adhar.local',
    category: 'Deliver',
    icon: <ArgoCDIcon />,
  },
  {
    id: 'kargo',
    name: 'Kargo',
    description: 'Multi-stage promotion',
    url: 'https://kargo.adhar.local',
    category: 'Deliver',
    icon: <KargoIcon />,
  },
  {
    id: 'argo-rollouts',
    name: 'Argo Rollouts',
    description: 'Progressive delivery',
    url: 'https://rollouts.adhar.local',
    category: 'Deliver',
    icon: <ArgoRolloutsIcon />,
  },
  {
    id: 'harbor',
    name: 'Harbor',
    description: 'Container registry',
    url: 'https://harbor.adhar.local',
    category: 'Deliver',
    icon: <HarborIcon />,
  },

  {
    id: 'grafana',
    name: 'Grafana',
    description: 'Dashboards & alerting',
    url: 'https://grafana.adhar.local',
    category: 'Observe',
    icon: <GrafanaIcon />,
  },
  {
    id: 'loki',
    name: 'Loki',
    description: 'Log aggregation',
    url: 'https://grafana.adhar.local/explore?left={"datasource":"loki"}',
    category: 'Observe',
    icon: <LokiIcon />,
  },
  {
    id: 'prometheus',
    name: 'Prometheus',
    description: 'Metrics (via Mimir)',
    url: 'https://mimir.adhar.local',
    category: 'Observe',
    icon: <PrometheusIcon />,
  },
  {
    id: 'tempo',
    name: 'Tempo',
    description: 'Distributed traces',
    url: 'https://tempo.adhar.local',
    category: 'Observe',
    icon: <TempoIcon />,
  },
  {
    id: 'otel',
    name: 'OpenTelemetry',
    description: 'Collector config',
    url: 'https://otel.adhar.local',
    category: 'Observe',
    icon: <OTelIcon />,
  },

  {
    id: 'airbyte',
    name: 'Airbyte',
    description: 'ELT & data ingestion',
    url: 'https://airbyte.adhar.local',
    category: 'Data',
    icon: <AirbyteIcon />,
  },
  {
    id: 'metabase',
    name: 'Metabase',
    description: 'BI & ad-hoc analytics',
    url: 'https://metabase.adhar.local',
    category: 'Data',
    icon: <MetabaseIcon />,
  },
  {
    id: 'iceberg',
    name: 'Iceberg',
    description: 'Lakehouse table format',
    url: 'https://iceberg.adhar.local',
    category: 'Data',
    icon: <IcebergIcon />,
  },
  {
    id: 'minio',
    name: 'MinIO',
    description: 'S3-compatible object store',
    url: 'https://minio.adhar.local',
    category: 'Data',
    icon: <MinIOIcon />,
  },

  {
    id: 'keycloak',
    name: 'Keycloak',
    description: 'Identity & SSO',
    url: 'https://keycloak.adhar.local',
    category: 'Identity',
    icon: <KeycloakIcon />,
  },

  {
    id: 'kyverno',
    name: 'Kyverno',
    description: 'Policy engine',
    url: 'https://kyverno.adhar.local',
    category: 'Policy',
    icon: <KyvernoIcon />,
  },
  {
    id: 'crossplane',
    name: 'Crossplane',
    description: 'Infra composition',
    url: 'https://crossplane.adhar.local',
    category: 'Platform',
    icon: <CrossplaneIcon />,
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    description: 'Cluster dashboard',
    url: 'https://dashboard.adhar.local',
    category: 'Platform',
    icon: <KubernetesIcon />,
  },
]

const CATEGORY_ORDER: AppCategory[] = [
  'Develop',
  'Deliver',
  'Observe',
  'Data',
  'Identity',
  'Policy',
  'Platform',
]

const CATEGORY_TONE: Record<AppCategory, { tile: string; ring: string; dot: string; chip: string }> = {
  Develop: {
    tile: 'bg-linear-to-br from-emerald-50/80 via-white to-white',
    ring: 'ring-emerald-100 group-hover:ring-emerald-200',
    dot: 'bg-emerald-400',
    chip: 'bg-emerald-50 text-emerald-700',
  },
  Deliver: {
    tile: 'bg-linear-to-br from-sky-50/80 via-white to-white',
    ring: 'ring-sky-100 group-hover:ring-sky-200',
    dot: 'bg-sky-400',
    chip: 'bg-sky-50 text-sky-700',
  },
  Observe: {
    tile: 'bg-linear-to-br from-amber-50/80 via-white to-white',
    ring: 'ring-amber-100 group-hover:ring-amber-200',
    dot: 'bg-amber-400',
    chip: 'bg-amber-50 text-amber-700',
  },
  Data: {
    tile: 'bg-linear-to-br from-violet-50/80 via-white to-white',
    ring: 'ring-violet-100 group-hover:ring-violet-200',
    dot: 'bg-violet-400',
    chip: 'bg-violet-50 text-violet-700',
  },
  Identity: {
    tile: 'bg-linear-to-br from-rose-50/80 via-white to-white',
    ring: 'ring-rose-100 group-hover:ring-rose-200',
    dot: 'bg-rose-400',
    chip: 'bg-rose-50 text-rose-700',
  },
  Policy: {
    tile: 'bg-linear-to-br from-fuchsia-50/80 via-white to-white',
    ring: 'ring-fuchsia-100 group-hover:ring-fuchsia-200',
    dot: 'bg-fuchsia-400',
    chip: 'bg-fuchsia-50 text-fuchsia-700',
  },
  Platform: {
    tile: 'bg-linear-to-br from-brand-50/80 via-white to-white',
    ring: 'ring-brand-100 group-hover:ring-brand-200',
    dot: 'bg-brand-400',
    chip: 'bg-brand-50 text-brand-700',
  },
}

interface AppLauncherProps {
  apps?: AppLink[]
}

/**
 * App launcher — grid-drawer of every backing tool in the platform, with brand
 * marks and one-click links. Replaces the "where do I find X?" tab chaos.
 */
export function AppLauncher({ apps = DEFAULT_APP_LINKS }: AppLauncherProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Autofocus the filter when the panel opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [open])

  // ESC closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const trimmed = query.trim().toLowerCase()
  const filtered = trimmed
    ? apps.filter(
        (a) =>
          a.name.toLowerCase().includes(trimmed) ||
          a.description.toLowerCase().includes(trimmed) ||
          a.category.toLowerCase().includes(trimmed),
      )
    : apps

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open app launcher"
        aria-expanded={open}
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150',
          open
            ? 'bg-brand-50 text-brand-700 shadow-sm ring-1 ring-brand-200'
            : 'text-content-muted hover:bg-surface-sunken hover:text-content',
        )}
      >
        <IconGrid />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-label="Application launcher"
            className="absolute right-0 top-full z-50 mt-2 w-160 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-edge-default bg-white shadow-2xl ring-1 ring-black/5"
          >
            <div className="relative overflow-hidden border-b border-edge-subtle bg-linear-to-br from-brand-50/60 via-white to-white px-4 py-3.5">
              <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-brand-100/40 blur-3xl" aria-hidden />
              <div className="relative flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-content">
                    <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-600/90 text-white shadow-sm">
                      <IconSparkle />
                    </span>
                    Adhar apps
                  </div>
                  <div className="mt-0.5 text-[11px] text-content-muted">
                    Jump into any backing tool — opens in a new tab.
                  </div>
                </div>
                <div className="relative">
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter apps…"
                    className="h-8 w-44 rounded-lg border border-edge-default bg-white/80 pl-7 pr-2 text-sm text-content shadow-sm backdrop-blur-sm transition-all focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20"
                  />
                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-subtle">
                    <IconSearch />
                  </span>
                </div>
              </div>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-4">
              {filtered.length === 0 ? (
                <div className="py-10 text-center">
                  <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-surface-sunken text-content-subtle">
                    <IconSearch />
                  </div>
                  <div className="text-sm font-medium text-content">No apps match "{query}"</div>
                  <div className="mt-0.5 text-xs text-content-muted">Try a different keyword.</div>
                </div>
              ) : trimmed ? (
                <AppGrid apps={filtered} onLaunch={() => setOpen(false)} />
              ) : (
                CATEGORY_ORDER.map((cat) => {
                  const rows = filtered.filter((a) => a.category === cat)
                  if (!rows.length) return null
                  const tone = CATEGORY_TONE[cat]
                  return (
                    <section key={cat} className="mb-5 last:mb-0">
                      <div className="mb-2 flex items-center gap-2 px-1">
                        <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} aria-hidden />
                        <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-muted">
                          {cat}
                        </h3>
                        <span className="text-[10px] font-mono tabular-nums text-content-subtle">
                          {rows.length}
                        </span>
                      </div>
                      <AppGrid apps={rows} onLaunch={() => setOpen(false)} />
                    </section>
                  )
                })
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-edge-subtle bg-surface-sunken/60 px-4 py-2 text-[11px] text-content-muted">
              <span>{DEFAULT_APP_LINKS.length} apps · {CATEGORY_ORDER.length} groups</span>
              <span className="font-mono text-content-subtle">esc to close</span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function AppGrid({ apps, onLaunch }: { apps: AppLink[]; onLaunch(): void }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {apps.map((a) => {
        const tone = CATEGORY_TONE[a.category]
        return (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer"
            onClick={onLaunch}
            className={cn(
              'group relative flex flex-col items-start gap-2.5 rounded-xl p-3 text-left transition-all duration-150',
              tone.tile,
              'ring-1',
              tone.ring,
              'hover:-translate-y-0.5 hover:shadow-md',
            )}
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-edge-subtle transition-transform duration-150 group-hover:scale-105 [&>svg]:h-7 [&>svg]:w-7">
              {a.icon}
            </div>
            <div className="min-w-0 w-full">
              <div className="truncate text-[13px] font-semibold text-content">{a.name}</div>
              <div className="mt-0.5 line-clamp-1 text-[11px] text-content-muted">
                {a.description}
              </div>
            </div>
            <span
              aria-hidden
              className="absolute right-2.5 top-2.5 text-content-subtle opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            >
              <IconArrowUpRight />
            </span>
          </a>
        )
      })}
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
