import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Overview-page layout preferences.
 *
 * Today the layout is persisted via a local "preferences service" that writes
 * to localStorage with simulated round-trip latency — a stand-in for the
 * future BFF endpoint backed by a relational table:
 *
 *     GET    /api/preferences/overview-layout
 *     PUT    /api/preferences/overview-layout
 *
 * When the BFF lands, swap `fetchOverviewLayout` / `persistOverviewLayout`
 * for `fetch()` calls — the UI is already wired through TanStack Query with
 * optimistic updates so it'll feel identical.
 */

export type PanelSize = 'sm' | 'md' | 'lg' | 'xl'

export type PanelCategory =
  | 'cross-cutting'
  | 'business'
  | 'lifecycle'
  | 'reliability'
  | 'security'
  | 'product'
  | 'shortcuts'

/**
 * Panel ids — exhaustive list of every panel the registry knows about.
 * Keep this in lockstep with `PANELS` in `routes/index.tsx`.
 */
export const ALL_PANEL_IDS = [
  'cluster',
  'business-kpis',
  'analytics',
  'define-issues',
  'develop-prs',
  'deliver-apps',
  'golden-signals',
  'alerts',
  'slo-health',
  'vuln-summary',
  'runtime',
  'pipelines',
  'bi-dashboards',
  'dora',
  'compliance',
  'pinned-apps',
  'notifications',
  'cost-trend',
  'deploy-heatmap',
  'latency-distribution',
  'service-topology',
  'team-activity',
  'region-spread',
  'dora-radar',
  'pipeline-funnel',
  'traffic-stream',
  'storage-treemap',
  'service-health-grid',
  'budget-bullet',
  'platform-health',
  'engineering-velocity',
  'resource-utilization',
  'incident-timeline',
  'build-runtime',
  'top-error-sources',
  'cache-performance',
  'database-pool',
  'queue-depth',
  'cert-expiry',
  'pod-restarts',
  'cnpg-clusters',
  'kafka-brokers',
  'tools-health',
  'k8s-events',
  'gitea-repos',
  'pr-throughput',
  'gitops-sync',
  'tenant-overview',
  'sprint-progress',
  'issue-backlog',
  'tenant-usage',
  'audit-log',
  'backup-status',
  'workflow-runs',
  'pipeline-success',
  'pipeline-stages',
  'workflow-triggers',
  'cilium-flows',
  'mesh-traffic',
  'mtls-coverage',
  'ingress-traffic',
] as const

export type PanelId = (typeof ALL_PANEL_IDS)[number]

export type ArrangeMode = 'auto' | 'custom'

export interface OverviewLayout {
  /** "auto": derived from category order; "custom": user has manually arranged. */
  mode: ArrangeMode
  /** Which panels are visible. */
  enabled: PanelId[]
  /** Per-panel size override. Falls back to PanelDef.defaultSize. */
  sizes?: Partial<Record<PanelId, PanelSize>>
  /** User's manually-arranged order — used when mode === 'custom'. */
  order?: PanelId[]
  /** ISO timestamp; bumped on every persist. */
  updatedAt?: string
}

/**
 * Default panel order — the arrangement the platform owner curated on the
 * Overview page (exported from their saved layout, Sept 2026). Every panel is
 * listed so "custom" mode has a stable position for anything a user enables.
 */
export const DEFAULT_ORDER: PanelId[] = [
  'dora',
  'cluster',
  'platform-health',
  'resource-utilization',
  'tools-health',
  'k8s-events',
  'tenant-overview',
  'tenant-usage',
  'slo-health',
  'region-spread',
  'storage-treemap',
  'golden-signals',
  'alerts',
  'engineering-velocity',
  'service-topology',
  'traffic-stream',
  'workflow-runs',
  'service-health-grid',
  'team-activity',
  'latency-distribution',
  'incident-timeline',
  'top-error-sources',
  'cache-performance',
  'database-pool',
  'queue-depth',
  'pod-restarts',
  'cnpg-clusters',
  'kafka-brokers',
  'backup-status',
  'cilium-flows',
  'mesh-traffic',
  'ingress-traffic',
  'define-issues',
  'develop-prs',
  'deliver-apps',
  'deploy-heatmap',
  'dora-radar',
  'pipeline-funnel',
  'build-runtime',
  'gitea-repos',
  'pr-throughput',
  'gitops-sync',
  'sprint-progress',
  'issue-backlog',
  'pipeline-success',
  'pipeline-stages',
  'cost-trend',
  'budget-bullet',
  'vuln-summary',
  'compliance',
  'runtime',
  'cert-expiry',
  'audit-log',
  'pinned-apps',
  'notifications',
  'analytics',
  'mtls-coverage',
]

/** Panels on by default, in the curated order. */
export const DEFAULT_ENABLED: PanelId[] = [
  'dora',
  'cluster',
  'platform-health',
  'resource-utilization',
  'tools-health',
  'k8s-events',
  'tenant-overview',
  'tenant-usage',
  'slo-health',
  'region-spread',
  'storage-treemap',
  'golden-signals',
  'alerts',
  'engineering-velocity',
  'service-topology',
  'traffic-stream',
  'workflow-runs',
  'service-health-grid',
  'team-activity',
  'latency-distribution',
  'incident-timeline',
  'top-error-sources',
  'cache-performance',
  'database-pool',
  'queue-depth',
  'pod-restarts',
  'cnpg-clusters',
  'kafka-brokers',
  'backup-status',
  'cilium-flows',
  'mesh-traffic',
  'ingress-traffic',
  'define-issues',
  'develop-prs',
  'deliver-apps',
  'deploy-heatmap',
  'dora-radar',
  'pipeline-funnel',
  'build-runtime',
  'gitea-repos',
  'pr-throughput',
  'gitops-sync',
  'sprint-progress',
  'issue-backlog',
  'pipeline-success',
  'pipeline-stages',
  'cost-trend',
  'budget-bullet',
  'vuln-summary',
  'compliance',
  'runtime',
  'cert-expiry',
  'audit-log',
  'pinned-apps',
  'notifications',
  'analytics',
  'mtls-coverage',
]

export const DEFAULT_LAYOUT: OverviewLayout = {
  // "auto" IS the curated order above — the page renders DEFAULT_ORDER as-is
  // in auto mode (no category sort, no row packing), so a fresh user sees the
  // platform owner's arrangement widget for widget. Dragging a card switches
  // the user to "custom" with their own order; there is no reset control.
  mode: 'auto',
  enabled: DEFAULT_ENABLED,
  sizes: {},
  order: DEFAULT_ORDER,
}

const STORAGE_KEY = 'adhar.preferences.overview'

/* ─────────── backend ─────────── */

/**
 * Production build → persist via the DB-backed API `/api/prefs/overview`
 * (cookie-authenticated, per-user). Dev SPA (no server) → localStorage with a
 * simulated round-trip so the UI behaves identically.
 */
function isProdBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { PROD?: boolean } }).env?.PROD)
  } catch {
    return false
  }
}

const PREFS_SCOPE = 'overview'

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function readStore(): OverviewLayout | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as OverviewLayout
    return sanitize(parsed)
  } catch {
    return null
  }
}

function writeStore(layout: OverviewLayout): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    /* storage quota — ignore */
  }
}

function sanitize(input: OverviewLayout): OverviewLayout {
  const validIds = new Set<string>(ALL_PANEL_IDS)
  const filterIds = (arr: readonly string[] | undefined) =>
    (arr ?? []).filter((id): id is PanelId => validIds.has(id))
  const enabled = filterIds(input.enabled)
  const order = filterIds(input.order)
  const mode: ArrangeMode = input.mode === 'custom' ? 'custom' : 'auto'
  return {
    mode,
    enabled: enabled.length ? enabled : DEFAULT_ENABLED,
    sizes: input.sizes ?? {},
    order: order.length ? order : enabled.length ? enabled : DEFAULT_ORDER,
    updatedAt: input.updatedAt,
  }
}

/** GET /api/prefs/overview */
async function fetchOverviewLayout(): Promise<OverviewLayout> {
  if (isProdBuild()) {
    try {
      const res = await fetch(`/api/prefs/${PREFS_SCOPE}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      if (res.ok) {
        const json = (await res.json()) as { data?: OverviewLayout | null }
        return json.data ? sanitize(json.data) : DEFAULT_LAYOUT
      }
    } catch {
      /* network/offline — fall back to defaults */
    }
    return DEFAULT_LAYOUT
  }
  await delay(60)
  return readStore() ?? DEFAULT_LAYOUT
}

/** PUT /api/prefs/overview */
async function persistOverviewLayout(next: OverviewLayout): Promise<OverviewLayout> {
  const stamped: OverviewLayout = sanitize({ ...next, updatedAt: new Date().toISOString() })
  if (isProdBuild()) {
    try {
      await fetch(`/api/prefs/${PREFS_SCOPE}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: stamped }),
      })
    } catch {
      /* optimistic update already applied client-side */
    }
    return stamped
  }
  await delay(120)
  writeStore(stamped)
  return stamped
}

/* ─────────── React Query hooks ─────────── */

const QUERY_KEY = ['preferences', 'overview-layout'] as const

export function useOverviewLayout() {
  return useQuery<OverviewLayout>({
    queryKey: QUERY_KEY,
    queryFn: fetchOverviewLayout,
    staleTime: 5 * 60_000,
    placeholderData: DEFAULT_LAYOUT,
  })
}

export function useSaveOverviewLayout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: persistOverviewLayout,
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: QUERY_KEY })
      const prev = qc.getQueryData<OverviewLayout>(QUERY_KEY)
      qc.setQueryData<OverviewLayout>(QUERY_KEY, sanitize(next))
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(QUERY_KEY, ctx.prev)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEY })
    },
  })
}

/* ─────────── helpers used by the page ─────────── */

/**
 * Stable category order used by "auto" arrange mode.
 * Higher-priority categories (cross-cutting metrics) come first.
 */
export const CATEGORY_ORDER: PanelCategory[] = [
  'cross-cutting',
  'reliability',
  'lifecycle',
  'business',
  'security',
  'product',
  'shortcuts',
]

/** Reorder helper — pure, never mutates the input. */
export function reorder<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= arr.length) return [...arr]
  const next = arr.slice()
  const [item] = next.splice(from, 1)
  const target = Math.max(0, Math.min(arr.length - 1, to))
  next.splice(target, 0, item)
  return next
}
