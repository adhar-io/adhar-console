import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  AppShell,
  DEFAULT_APP_LINKS,
  DonutGauge,
  Sparkline,
  StatusBadge,
  useNotifications,
  type AppLink,
  type Notification,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import { STUB_USER, useOptionalSession } from '@adhar-console/auth'
import { summarizeCluster, useClusterSignals } from '~/data/cluster-signals.ts'
import {
  ALL_PANEL_IDS,
  CATEGORY_ORDER,
  DEFAULT_LAYOUT as DEFAULT_OVERVIEW_LAYOUT,
  type ArrangeMode,
  type OverviewLayout,
  type PanelCategory,
  type PanelId,
  type PanelSize,
  useOverviewLayout,
  useSaveOverviewLayout,
} from '~/data/overview-prefs.ts'
import { DraggableGrid } from '~/components/draggable-grid.tsx'
import { getLayoutData } from '~/server/session.ts'
import {
  AlertsPanel,
  AnalyticsPanel,
  AuditLogPanel,
  BackupStatusPanel,
  BiDashboardsPanel,
  BudgetBulletPanel,
  BusinessKpisPanel,
  BuildRuntimePanel,
  CachePerformancePanel,
  CertExpiryPanel,
  CiliumNetworkFlowPanel,
  CnpgClustersPanel,
  CostTrendPanel,
  DatabasePoolPanel,
  DefineIssuesPanel,
  DeliverAppsPanel,
  DeployHeatmapPanel,
  DevelopPRsPanel,
  DoraRadarPanel,
  EngineeringVelocityPanel,
  GiteaRepoMetricsPanel,
  GitOpsSyncPanel,
  GoldenSignalsPanel,
  IncidentTimelinePanel,
  IngressTrafficPanel,
  IssueBacklogPanel,
  K8sEventsPanel,
  KafkaBrokersPanel,
  LatencyDistributionPanel,
  MtlsCoveragePanel,
  PipelineFunnelPanel,
  PipelinesPanel,
  PipelineStagePerformancePanel,
  PipelineSuccessTrendPanel,
  PlatformHealthPanel,
  PodRestartsPanel,
  PrThroughputPanel,
  QueueDepthPanel,
  RegionSpreadPanel,
  ResourceUtilizationPanel,
  RuntimePanel,
  ServiceHealthGridPanel,
  ServiceTopologyPanel,
  ServiceMeshTrafficPanel,
  SloPanel,
  SprintProgressPanel,
  StorageTreemapPanel,
  TeamActivityPanel,
  TenantOverviewPanel,
  TenantUsagePanel,
  ToolsHealthPanel,
  TopErrorSourcesPanel,
  TrafficStreamPanel,
  VulnSummaryPanel,
  WorkflowRunsPanel,
  WorkflowTriggersPanel,
} from './_overview-panels.tsx'

export const Route = createFileRoute('/')({
  loader: () => getLayoutData(),
  head: () => ({
    meta: [
      { title: 'Overview · Adhar Console' },
      {
        name: 'description',
        content:
          'Unified operator UI for the Adhar platform — Define, Design, Develop, Deliver, Discover, Decide.',
      },
    ],
  }),
  component: LandingPage,
})

/* ───────────────────── panel registry ───────────────────── */

// Types live in `~/data/overview-prefs.ts` so the persistence layer can
// validate ids and so the registry keys are kept in lockstep with what the
// preferences API understands.
const _ensureIdsAlign: PanelId = ALL_PANEL_IDS[0]
void _ensureIdsAlign

interface PanelDef {
  id: PanelId
  title: string
  description: string
  category: PanelCategory
  /** Default size — user can override per-panel via the customize sheet. */
  defaultSize: PanelSize
  render(ctx: PanelCtx): ReactNode
}

interface PanelCtx {
  notifications: Notification[]
}

const SIZE_LABEL: Record<PanelSize, string> = {
  sm: 'Quarter',
  md: 'Third',
  lg: 'Half',
  xl: 'Full',
}

/** col-span values on a 12-col grid. xl panels always span the full row to
 *  avoid awkward leftover columns. Smaller sizes pack tighter at 2xl so the
 *  full-width content area doesn't leave panels stretched. */
const SIZE_COLSPAN: Record<PanelSize, string> = {
  sm: 'col-span-12 sm:col-span-6 lg:col-span-3 2xl:col-span-2',
  md: 'col-span-12 sm:col-span-6 lg:col-span-4 2xl:col-span-3',
  lg: 'col-span-12 lg:col-span-6',
  xl: 'col-span-12',
}

const CATEGORY_LABEL: Record<PanelCategory, string> = {
  'cross-cutting': 'Cross-cutting',
  business: 'Business',
  lifecycle: 'Lifecycle',
  reliability: 'Reliability & ops',
  security: 'Security',
  product: 'Product analytics',
  shortcuts: 'Shortcuts',
}

const PANELS: PanelDef[] = [
  {
    id: 'dora',
    title: 'DORA metrics',
    description: 'Deploy frequency, lead time, change-failure rate, MTTR.',
    category: 'cross-cutting',
    defaultSize: 'xl',
    render: () => <DoraPanel />,
  },
  {
    id: 'cluster',
    title: 'Cluster snapshot',
    description: 'Live node / pod / deployment counts from the connected cluster.',
    category: 'cross-cutting',
    defaultSize: 'xl',
    render: () => <ClusterSnapshotPanel />,
  },
  {
    id: 'business-kpis',
    title: 'Business KPIs',
    description: 'MRR, NRR, top scalar metrics from Metabase.',
    category: 'business',
    defaultSize: 'lg',
    render: () => <BusinessKpisPanel />,
  },
  {
    id: 'analytics',
    title: 'Product analytics',
    description: 'PostHog DAU + top events over the last 24 hours.',
    category: 'product',
    defaultSize: 'lg',
    render: () => <AnalyticsPanel />,
  },
  {
    id: 'define-issues',
    title: 'Define · issues',
    description: 'Open + done issues, active cycle progress.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <DefineIssuesPanel />,
  },
  {
    id: 'develop-prs',
    title: 'Develop · PRs',
    description: 'Open pull requests across every repo in the org.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <DevelopPRsPanel />,
  },
  {
    id: 'deliver-apps',
    title: 'Deliver · apps',
    description: 'ArgoCD applications with sync × health status.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <DeliverAppsPanel />,
  },
  {
    id: 'golden-signals',
    title: 'Golden signals',
    description: 'RPS, error %, p95 latency across all services — last hour.',
    category: 'reliability',
    defaultSize: 'lg',
    render: () => <GoldenSignalsPanel />,
  },
  {
    id: 'alerts',
    title: 'Alerts',
    description: 'Firing + pending alerts from Alertmanager.',
    category: 'reliability',
    defaultSize: 'lg',
    render: () => <AlertsPanel />,
  },
  {
    id: 'slo-health',
    title: 'SLO health',
    description: 'Service-level objectives with burn-rate and error-budget.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <SloPanel />,
  },
  {
    id: 'vuln-summary',
    title: 'Vulnerabilities',
    description: 'Trivy CVE roll-up — critical / high / medium / low.',
    category: 'security',
    defaultSize: 'md',
    render: () => <VulnSummaryPanel />,
  },
  {
    id: 'runtime',
    title: 'Runtime security',
    description: 'Falco events from the last 6 hours.',
    category: 'security',
    defaultSize: 'md',
    render: () => <RuntimePanel />,
  },
  {
    id: 'pipelines',
    title: 'Data pipelines',
    description: 'Airbyte connections — sync status and throughput.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <PipelinesPanel />,
  },
  {
    id: 'bi-dashboards',
    title: 'BI dashboards',
    description: 'Metabase dashboards roll-up.',
    category: 'business',
    defaultSize: 'md',
    render: () => <BiDashboardsPanel />,
  },
  {
    id: 'compliance',
    title: 'Cluster posture',
    description:
      'Six short signals — policy, GitOps, rollouts, pods, nodes, deploys — at a glance.',
    category: 'security',
    defaultSize: 'xl',
    render: () => <CompliancePanel />,
  },
  {
    id: 'pinned-apps',
    title: 'Pinned apps',
    description: 'One-click launch to your most-used backing tools.',
    category: 'shortcuts',
    defaultSize: 'lg',
    render: () => <PinnedAppsPanel />,
  },
  {
    id: 'notifications',
    title: 'Recent notifications',
    description: 'Last five events from deploys, policy, and reviews.',
    category: 'shortcuts',
    defaultSize: 'lg',
    render: (ctx) => <RecentNotificationsPanel seed={ctx.notifications} />,
  },
  {
    id: 'cost-trend',
    title: 'Cloud spend',
    description: 'Rolling 30-day total spend with trend + per-category split.',
    category: 'business',
    defaultSize: 'md',
    render: () => <CostTrendPanel />,
  },
  {
    id: 'deploy-heatmap',
    title: 'Deploy heatmap',
    description: '12-week deploy frequency at a glance.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <DeployHeatmapPanel />,
  },
  {
    id: 'latency-distribution',
    title: 'Latency distribution',
    description: 'Request histogram with p50 / p95 / p99 markers.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <LatencyDistributionPanel />,
  },
  {
    id: 'service-topology',
    title: 'Service topology',
    description: 'Live service graph colored by health state.',
    category: 'reliability',
    defaultSize: 'lg',
    render: () => <ServiceTopologyPanel />,
  },
  {
    id: 'team-activity',
    title: 'Team activity',
    description: 'Day × hour commit heatmap across the org.',
    category: 'lifecycle',
    defaultSize: 'lg',
    render: () => <TeamActivityPanel />,
  },
  {
    id: 'region-spread',
    title: 'Geographic spread',
    description: 'Pod distribution across regions and clouds.',
    category: 'cross-cutting',
    defaultSize: 'md',
    render: () => <RegionSpreadPanel />,
  },
  {
    id: 'dora-radar',
    title: 'DORA radar',
    description: '4-axis radar of DORA metrics vs the elite benchmark.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <DoraRadarPanel />,
  },
  {
    id: 'pipeline-funnel',
    title: 'Delivery funnel',
    description: 'Commits → builds → tests → deploys → production.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <PipelineFunnelPanel />,
  },
  {
    id: 'traffic-stream',
    title: 'Traffic stream',
    description: 'Stacked-area RPS by top service over the last hour.',
    category: 'reliability',
    defaultSize: 'lg',
    render: () => <TrafficStreamPanel />,
  },
  {
    id: 'storage-treemap',
    title: 'Storage treemap',
    description: 'Namespace-level storage usage as proportional rectangles.',
    category: 'cross-cutting',
    defaultSize: 'md',
    render: () => <StorageTreemapPanel />,
  },
  {
    id: 'service-health-grid',
    title: 'Service health grid',
    description: 'Per-service p95 latency tiles with mini sparklines.',
    category: 'reliability',
    defaultSize: 'lg',
    render: () => <ServiceHealthGridPanel />,
  },
  {
    id: 'budget-bullet',
    title: 'Budget · bullet chart',
    description: 'Cost-center actuals vs target with prior-month markers.',
    category: 'business',
    defaultSize: 'md',
    render: () => <BudgetBulletPanel />,
  },
  {
    id: 'platform-health',
    title: 'Platform health score',
    description: 'Radial gauge of overall health with reliability, SLO, security, and perf sub-scores.',
    category: 'cross-cutting',
    defaultSize: 'lg',
    render: () => <PlatformHealthPanel />,
  },
  {
    id: 'engineering-velocity',
    title: 'Engineering velocity',
    description: 'Two-week flow metrics — PRs merged, deploys, lead time, incidents.',
    category: 'lifecycle',
    defaultSize: 'lg',
    render: () => <EngineeringVelocityPanel />,
  },
  {
    id: 'resource-utilization',
    title: 'Resource utilization',
    description: 'Live cluster CPU, memory, and storage usage as radial gauges.',
    category: 'cross-cutting',
    defaultSize: 'lg',
    render: () => <ResourceUtilizationPanel />,
  },
  {
    id: 'incident-timeline',
    title: 'Incident timeline',
    description: 'Last 5 alerts and incidents on a vertical timeline with severity dots.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <IncidentTimelinePanel />,
  },
  {
    id: 'build-runtime',
    title: 'CI build duration',
    description: 'Per-repo box plot of CI build durations over the last 7 days.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <BuildRuntimePanel />,
  },
  {
    id: 'top-error-sources',
    title: 'Top error sources',
    description: 'Services ranked by 5xx rate over the last hour.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <TopErrorSourcesPanel />,
  },
  {
    id: 'cache-performance',
    title: 'Cache performance',
    description: 'Hit ratio and miss/eviction stats across the platform cache fleet.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <CachePerformancePanel />,
  },
  {
    id: 'database-pool',
    title: 'Database pool',
    description: 'Per-database connection utilization and slow query counters.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <DatabasePoolPanel />,
  },
  {
    id: 'queue-depth',
    title: 'Queue depth',
    description: 'Kafka consumer-group lag for the busiest topics.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <QueueDepthPanel />,
  },
  {
    id: 'cert-expiry',
    title: 'Certificate expiry',
    description: 'TLS certificates approaching renewal, sorted by days remaining.',
    category: 'security',
    defaultSize: 'md',
    render: () => <CertExpiryPanel />,
  },
  {
    id: 'pod-restarts',
    title: 'Pod restarts',
    description: 'Pods with the highest restart counts in the last 24 hours.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <PodRestartsPanel />,
  },
  {
    id: 'cnpg-clusters',
    title: 'Database clusters',
    description: 'CloudNativePG cluster health — primary + replica, lag, size.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <CnpgClustersPanel />,
  },
  {
    id: 'kafka-brokers',
    title: 'Kafka brokers',
    description: 'Strimzi broker liveness, leader balance, ISR.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <KafkaBrokersPanel />,
  },
  {
    id: 'tools-health',
    title: 'Platform tools',
    description: 'Liveness probes across the entire backing-tool stack.',
    category: 'cross-cutting',
    defaultSize: 'lg',
    render: () => <ToolsHealthPanel />,
  },
  {
    id: 'k8s-events',
    title: 'Cluster events',
    description: 'Recent Normal + Warning events from the connected cluster.',
    category: 'reliability',
    defaultSize: 'lg',
    render: () => <K8sEventsPanel />,
  },
  {
    id: 'gitea-repos',
    title: 'Code repositories',
    description: 'Org-wide Gitea metrics — repos, commits, branches, language mix.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <GiteaRepoMetricsPanel />,
  },
  {
    id: 'pr-throughput',
    title: 'PR throughput',
    description: 'Cycle-time histogram + reviewer load over the last 7 days.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <PrThroughputPanel />,
  },
  {
    id: 'gitops-sync',
    title: 'GitOps sync',
    description: 'ArgoCD sync × health composition with recent sync history.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <GitOpsSyncPanel />,
  },
  {
    id: 'tenant-overview',
    title: 'Tenant overview',
    description: 'Active organization — plan, members, quotas, key contacts.',
    category: 'cross-cutting',
    defaultSize: 'lg',
    render: () => <TenantOverviewPanel />,
  },
  {
    id: 'sprint-progress',
    title: 'Sprint progress',
    description: 'Active Plane cycle with burndown and on-track signal.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <SprintProgressPanel />,
  },
  {
    id: 'issue-backlog',
    title: 'Issue backlog',
    description: 'Open issues by priority + age distribution.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <IssueBacklogPanel />,
  },
  {
    id: 'tenant-usage',
    title: 'Tenant usage',
    description: 'Top tenants by CPU / memory / storage with monthly spend.',
    category: 'cross-cutting',
    defaultSize: 'lg',
    render: () => <TenantUsagePanel />,
  },
  {
    id: 'audit-log',
    title: 'Audit log',
    description: 'Recent RBAC and sensitive-operation events across tenants.',
    category: 'security',
    defaultSize: 'md',
    render: () => <AuditLogPanel />,
  },
  {
    id: 'backup-status',
    title: 'Backup status',
    description: 'Velero + CloudNativePG backup health, RPO, last success.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <BackupStatusPanel />,
  },
  {
    id: 'workflow-runs',
    title: 'CI workflow runs',
    description: 'Live Argo Workflows execution feed with phase, progress, retries.',
    category: 'lifecycle',
    defaultSize: 'lg',
    render: () => <WorkflowRunsPanel />,
  },
  {
    id: 'pipeline-success',
    title: 'Pipeline success',
    description: 'Daily pass/fail volume + flaky-rate trend across all workflows.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <PipelineSuccessTrendPanel />,
  },
  {
    id: 'pipeline-stages',
    title: 'Pipeline stages',
    description: 'Per-stage avg + p95 duration with slowest/flakiest call-out.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <PipelineStagePerformancePanel />,
  },
  {
    id: 'workflow-triggers',
    title: 'Pipeline triggers',
    description: 'Run distribution by trigger source + top WorkflowTemplates.',
    category: 'lifecycle',
    defaultSize: 'md',
    render: () => <WorkflowTriggersPanel />,
  },
  {
    id: 'cilium-flows',
    title: 'Cilium network flows',
    description: 'Hubble top talkers, dropped packets, and network-policy posture.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <CiliumNetworkFlowPanel />,
  },
  {
    id: 'mesh-traffic',
    title: 'Service mesh traffic',
    description: 'Per-service request rate, p50/p95/p99 latency, error rate.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <ServiceMeshTrafficPanel />,
  },
  {
    id: 'mtls-coverage',
    title: 'mTLS coverage',
    description: 'SPIFFE identity status, encryption posture, cert renewal urgency.',
    category: 'security',
    defaultSize: 'md',
    render: () => <MtlsCoveragePanel />,
  },
  {
    id: 'ingress-traffic',
    title: 'Ingress traffic',
    description: 'Top edge routes by RPS, p95 latency, status-code mix.',
    category: 'reliability',
    defaultSize: 'md',
    render: () => <IngressTrafficPanel />,
  },
]

function sizeFor(layout: OverviewLayout, def: PanelDef): PanelSize {
  return layout.sizes?.[def.id] ?? def.defaultSize
}

/**
 * Resolve the panels to render (and their order) for the given layout.
 *
 * - `auto` mode: panels in `enabled` are sorted by category priority then
 *   their position in the registry. Stable, predictable, no manual control.
 * - `custom` mode: respects `layout.order` (falling back to `enabled` for
 *   panels not yet seen in the saved order — usually freshly-enabled ones).
 */
function resolveOrder(layout: OverviewLayout): PanelDef[] {
  const enabled = new Set(layout.enabled)
  const visiblePanels = PANELS.filter((p) => enabled.has(p.id))
  if (layout.mode === 'auto') {
    /*
     * Auto-arrange picks an order that *also packs nicely* on a 12-col
     * grid. We sort by category priority first, then by size DESC so each
     * row anchors with a wider card and the smaller cards trail it. Combined
     * with `grid-flow-row-dense` on the wrapper, gaps from odd colspan
     * combinations get back-filled by later small cards in the same
     * category — eliminating the awkward whitespace bands that the simple
     * registry-order sort produced.
     */
    const catRank = new Map(CATEGORY_ORDER.map((c, i) => [c, i]))
    const sizeWeight: Record<PanelSize, number> = { xl: 0, lg: 1, md: 2, sm: 3 }
    return [...visiblePanels].sort((a, b) => {
      const ra = catRank.get(a.category) ?? 99
      const rb = catRank.get(b.category) ?? 99
      if (ra !== rb) return ra - rb
      const sa = sizeWeight[a.defaultSize]
      const sb = sizeWeight[b.defaultSize]
      if (sa !== sb) return sa - sb
      return PANELS.indexOf(a) - PANELS.indexOf(b)
    })
  }
  // Custom: prefer explicit order, then any newly-enabled panels not yet ordered.
  const ranked = new Map<PanelId, number>()
  ;(layout.order ?? []).forEach((id, i) => ranked.set(id, i))
  const ordered = visiblePanels
    .slice()
    .sort((a, b) => {
      const ra = ranked.get(a.id) ?? Number.POSITIVE_INFINITY
      const rb = ranked.get(b.id) ?? Number.POSITIVE_INFINITY
      if (ra === rb) return PANELS.indexOf(a) - PANELS.indexOf(b)
      return ra - rb
    })
  return ordered
}

/* ───────────────────── page ───────────────────── */

function LandingPage() {
  const { tenants, activeTenant, notifications } = Route.useLoaderData()
  const user = useOptionalSession()?.user ?? STUB_USER
  const firstName = user.name.split(' ')[0]

  const layoutQuery = useOverviewLayout()
  const saveLayout = useSaveOverviewLayout()
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [savedHint, setSavedHint] = useState(false)

  const layout = layoutQuery.data ?? DEFAULT_OVERVIEW_LAYOUT

  const updateLayout = (next: OverviewLayout) => {
    saveLayout.mutate(next)
    setSavedHint(true)
    window.setTimeout(() => setSavedHint(false), 1500)
  }

  const visiblePanels = useMemo(() => resolveOrder(layout), [layout])

  /**
   * Drag commits implicitly switch the layout to "custom" mode and freeze
   * the new order — no explicit toggle needed. From that point on the user's
   * arrangement takes precedence over auto-arrange. They can opt back into
   * auto via the "Reset to auto" affordance in the Hero.
   */
  const onReorder = (next: PanelDef[]) => {
    const order = next.map((p) => p.id)
    updateLayout({ ...layout, mode: 'custom', order })
  }

  const resetToAuto = () => {
    if (layout.mode === 'auto') return
    updateLayout({ ...layout, mode: 'auto' })
  }

  return (
    <AppShell
      user={user}
      tenants={tenants}
      activeTenantId={activeTenant.id}
      onTenantChange={() => {}}
      crumbs={[{ label: 'Overview' }]}
      notifications={notifications}
      contentWidth="full"
    >
      <div className="space-y-6">
        <Hero
          firstName={firstName}
          orgName={activeTenant.name}
          mode={layout.mode}
          onResetAuto={resetToAuto}
          isSaving={saveLayout.isPending}
          savedHint={savedHint}
          onCustomize={() => setCustomizeOpen(true)}
        />
        {visiblePanels.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-edge-default bg-surface-raised/40 px-6 py-12 text-center">
            <div className="text-sm font-medium text-content">Your overview is empty</div>
            <p className="mt-1 text-xs text-content-muted">
              Click "Customize" to pick panels.
            </p>
          </div>
        ) : (
          <DraggableGrid
            items={visiblePanels}
            onReorder={onReorder}
            disabled={false}
            spanClassName={(p) => SIZE_COLSPAN[sizeFor(layout, p)]}
            render={(p) => p.render({ notifications })}
          />
        )}
      </div>

      {customizeOpen ? (
        <CustomizeSheet
          layout={layout}
          onChange={updateLayout}
          onClose={() => setCustomizeOpen(false)}
          onReset={() => updateLayout(DEFAULT_OVERVIEW_LAYOUT)}
        />
      ) : null}
    </AppShell>
  )
}

/* ───────────────────── arrange controls (rendered inside Hero) ───────────────────── */

/**
 * No explicit auto/drag toggle — the panel grid is always drag-enabled and
 * panels are auto-arranged by default. The first time a user reorders a
 * card, that custom order is persisted as their preference and takes over
 * from auto. A single contextual "Reset to auto" affordance gives them a
 * one-click way out — and it's only mounted when there's something to
 * reset.
 *
 * "Customize panels" sits beside it as a tertiary action because that
 * concern (visibility) is orthogonal to arrangement.
 */
function HeroArrangeControls({
  mode,
  onResetAuto,
  isSaving,
  savedHint,
}: {
  mode: ArrangeMode
  onResetAuto(): void
  isSaving: boolean
  savedHint: boolean
}) {
  const isCustom = mode === 'custom'
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {isCustom ? (
        <button
          type="button"
          onClick={onResetAuto}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface-raised px-2.5 text-[12px] font-semibold text-content ring-1 ring-inset ring-slate-900/10 transition-shadow hover:shadow-md"
        >
          <IconReset />
          <span>Reset to auto</span>
        </button>
      ) : null}

      <span
        className={cn(
          'inline-flex items-center gap-1 pl-1 text-[11px] transition-opacity duration-300',
          isSaving || savedHint ? 'opacity-100' : 'opacity-0',
        )}
        aria-live="polite"
      >
        {isSaving ? (
          <>
            <SpinnerDot /> <span className="text-white/80">Saving…</span>
          </>
        ) : savedHint ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="text-emerald-200">Saved</span>
          </>
        ) : null}
      </span>
    </div>
  )
}

function SpinnerDot() {
  return (
    <span className="relative flex h-1.5 w-1.5" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
    </span>
  )
}

function IconReset() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

// Legacy `<Panel>` wrapper kept for callers that wrap their children in a
// titled section. The new grid renders panel components directly — each
// panel is responsible for its own card chrome via `_overview-panels.tsx`.
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-content-subtle">
        {title}
      </h2>
      {children}
    </section>
  )
}
const _PanelKept = Panel

/* ───────────────────── hero ───────────────────── */

function Hero({
  firstName,
  orgName,
  mode,
  onResetAuto,
  isSaving,
  savedHint,
  onCustomize,
}: {
  firstName: string
  orgName: string
  mode: ArrangeMode
  onResetAuto(): void
  isSaving: boolean
  savedHint: boolean
  onCustomize(): void
}) {
  return (
    <section
      className="rise-in relative overflow-hidden rounded-2xl border border-brand-900/40 px-5 py-7 text-white shadow-lg sm:px-8 sm:py-10"
      style={{
        backgroundImage:
          'radial-gradient(ellipse at top left, var(--color-brand-500), transparent 60%), linear-gradient(135deg, var(--color-brand-900), var(--color-brand-950))',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full blur-3xl"
        style={{ backgroundColor: 'color-mix(in oklch, var(--color-brand-400) 35%, transparent)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 left-16 h-56 w-56 rounded-full blur-3xl"
        style={{ backgroundColor: 'color-mix(in oklch, var(--color-accent-500) 35%, transparent)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
          backgroundSize: '22px 22px',
        }}
      />
      <HeroIllustration />
      <div className="relative flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs uppercase tracking-[0.18em] text-white/60">{orgName}</div>
          <HeroArrangeControls
            mode={mode}
            onResetAuto={onResetAuto}
            isSaving={isSaving}
            savedHint={savedHint}
          />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Welcome back, {firstName}.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-white/75">
          Adhar Platform for the whole software lifecycle — requirements, design, delivery,
          observability, cost. Every capability is backed by an open-source tool; no black boxes, no
          lock-in.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <HeroLink to="/platform" variant="primary" trailing={<HeroArrowGlyph />}>
            Open Platform
          </HeroLink>
          <HeroLink onClick={onCustomize} variant="secondary" leading={<IconSliders />}>
            Customize
          </HeroLink>
          <HeroLink to="/onboarding" variant="ghost" trailing={<HeroArrowGlyph />}>
            Re-run onboarding
          </HeroLink>
        </div>
      </div>
    </section>
  )
}

function HeroLink({
  to,
  onClick,
  variant,
  leading,
  trailing,
  children,
}: {
  to?: string
  onClick?(): void
  variant: 'primary' | 'secondary' | 'ghost'
  leading?: ReactNode
  trailing?: ReactNode
  children: ReactNode
}) {
  // Three CTAs share one chip skeleton so the Hero row reads as a single
  // strip rather than three differently-shaped controls. The primary
  // variant uses the project's own `text-content` token (a near-black
  // already used by every panel) instead of `text-content`, which can be
  // overridden by the parent <section>'s `text-white` in some browsers'
  // visited-link / nested-anchor cases. We also pin the color directly on
  // the inner <span> so nothing in the cascade can wash the label out.
  const isPrimary = variant === 'primary'
  const cls = isPrimary
    ? 'bg-surface-raised shadow-sm ring-1 ring-inset ring-edge-default hover:bg-surface-sunken hover:shadow-md'
    : variant === 'secondary'
      ? 'border border-white/60 bg-white/15 text-white backdrop-blur-sm hover:border-white hover:bg-white/25'
      : 'text-white hover:bg-white/15'
  const labelColor = isPrimary ? 'text-content' : 'text-white'
  const className = cn(
    'inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold tracking-tight transition-all duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50',
    labelColor,
    cls,
  )
  const inner = (
    <>
      {leading ? <span className={labelColor}>{leading}</span> : null}
      <span className={labelColor}>{children}</span>
      {trailing ? <span className={labelColor}>{trailing}</span> : null}
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {inner}
      </button>
    )
  }
  return (
    <Link to={to ?? '/'} className={className}>
      {inner}
    </Link>
  )
}

function HeroArrowGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

/**
 * Decorative illustration anchored to the right of the Hero — a stylized
 * 3×3 dashboard-tile mock. The composition is self-referential: the hero
 * sits above a real panel grid, and the illustration is a quieter,
 * abstracted version of that grid with a sparkline and a few mini-charts
 * peeking through.
 *
 * Tiles use a single shared `hero-fill` gradient and a thin glass stroke so
 * the cluster reads as one cohesive surface, not a flea-market of shapes.
 * One tile lifts forward (the chart) to give the eye a focal anchor; a
 * single accent dot pulses to imply liveness without animating the whole
 * scene.
 */
function HeroIllustration() {
  /*
   * Strict grid: 12px gap between every tile, three columns of 76px tiles,
   * three rows of 52px tiles. The chart card is the only tile that breaks
   * single-cell — it spans cols 1-2 × rows 2-3 (164×116) so it reads as
   * the obvious focal anchor without any random overlap. Math:
   *   col xs: 164 / 252 / 340  (each +76 +12 → next col)
   *   row ys:  54 / 118 / 182  (each +52 +12 → next row)
   *   chart:  x=164, y=118, w=76+12+76=164, h=52+12+52=116
   */
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-0 bottom-0 hidden h-[90%] w-[52%] lg:block"
      style={{
        WebkitMaskImage:
          'radial-gradient(ellipse 85% 95% at 65% 55%, black 60%, transparent 100%)',
        maskImage: 'radial-gradient(ellipse 85% 95% at 65% 55%, black 60%, transparent 100%)',
      }}
    >
      <svg
        viewBox="0 0 440 280"
        preserveAspectRatio="xMaxYEnd meet"
        className="h-full w-full"
      >
        <defs>
          <linearGradient id="hero-tile" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.14)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.04)" />
          </linearGradient>
          <linearGradient id="hero-tile-lifted" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.24)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.08)" />
          </linearGradient>
          <linearGradient id="hero-spark" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
            <stop offset="100%" stopColor="rgba(255,255,255,1)" />
          </linearGradient>
          <linearGradient id="hero-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(125,211,252,0.5)" />
            <stop offset="100%" stopColor="rgba(125,211,252,0)" />
          </linearGradient>
          <radialGradient id="hero-glow" cx="50%" cy="55%" r="60%">
            <stop offset="0%" stopColor="rgba(125,211,252,0.28)" />
            <stop offset="100%" stopColor="rgba(125,211,252,0)" />
          </radialGradient>
        </defs>

        {/* Single ambient glow centered horizontally with the tile cluster
            (cluster spans x 152–432, center 292). Vertical center pushed
            down to `cy = r + a small margin` so the circle's top arc
            clears y=0 and reads as a full round shape. */}
        <circle cx="290" cy="210" r="200" fill="url(#hero-glow)" />

        <g opacity="0.92">
          {/* Top row — three stat tiles, evenly spaced. */}
          <HeroTile x={164} y={54} w={76} h={52} variant="kpi" />
          <HeroTile x={252} y={54} w={76} h={52} variant="bars" />
          <HeroTile x={340} y={54} w={76} h={52} variant="dot" />

          {/* Lifted chart card — spans 2 cols × 2 rows. The focal anchor. */}
          <HeroTile x={164} y={118} w={164} h={116} variant="chart" lifted />

          {/* Right column — two stacked secondary tiles balancing the chart. */}
          <HeroTile x={340} y={118} w={76} h={52} variant="donut" />
          <HeroTile x={340} y={182} w={76} h={52} variant="meter" />
        </g>

        {/* Live-pulse anchor — sits on the chart card's most-recent marker.
            Coordinates match the chart's last point in SVG space:
            x = 164 + (164 − 12) = 316; y = 118 + 30 ≈ 148. */}
        <g transform="translate(316,148)">
          <circle r="3" fill="white" />
          <circle r="6" fill="white" fillOpacity="0.2" />
          <circle r="10" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1">
            <animate attributeName="r" from="6" to="18" dur="2.8s" repeatCount="indefinite" />
            <animate
              attributeName="stroke-opacity"
              from="0.35"
              to="0"
              dur="2.8s"
              repeatCount="indefinite"
            />
          </circle>
        </g>
      </svg>
    </div>
  )
}

/**
 * Inner tile renderer. Each tile is the same rounded glass card; the
 * `variant` switches just the inner content (a sparkline, a donut, a row
 * of bars, …). The `lifted` flag adds a slightly stronger fill + a deeper
 * drop, which is what makes the chart card read as the focal point
 * without resorting to a different shape.
 */
function HeroTile({
  x,
  y,
  w,
  h,
  variant,
  lifted = false,
}: {
  x: number
  y: number
  w: number
  h: number
  variant: 'chart' | 'bars' | 'kpi' | 'donut' | 'dot' | 'rows' | 'meter'
  lifted?: boolean
}) {
  const fill = lifted ? 'url(#hero-tile-lifted)' : 'url(#hero-tile)'
  const strokeOpacity = lifted ? 0.5 : 0.22
  // Lifted tile gets a soft drop-shadow so the depth read is unambiguous.
  return (
    <g transform={`translate(${x},${y})`}>
      {lifted ? (
        <rect
          x="0"
          y="2"
          width={w}
          height={h}
          rx="12"
          fill="rgba(0,0,0,0.18)"
          opacity="0.5"
          style={{ filter: 'blur(6px)' }}
        />
      ) : null}
      <rect
        width={w}
        height={h}
        rx={lifted ? 12 : 10}
        fill={fill}
        stroke="white"
        strokeOpacity={strokeOpacity}
        strokeWidth="1"
      />
      {/* Top label bar — slightly longer on the lifted card so the chart
          card reads as a "real" titled chart rather than a stat tile. */}
      <rect
        x="12"
        y="11"
        width={lifted ? Math.min(w * 0.32, 64) : Math.min(w * 0.42, 40)}
        height="3"
        rx="1.5"
        fill="rgba(255,255,255,0.55)"
      />
      <HeroTileContent variant={variant} w={w} h={h} lifted={lifted} />
    </g>
  )
}

function HeroTileContent({
  variant,
  w,
  h,
  lifted = false,
}: {
  variant: 'chart' | 'bars' | 'kpi' | 'donut' | 'dot' | 'rows' | 'meter'
  w: number
  h: number
  lifted?: boolean
}) {
  switch (variant) {
    case 'chart': {
      /*
       * Lifted hero chart. We give it real chart chrome: a y-axis grid line
       * at the midpoint, ticks along the bottom, and a marker dot at the
       * latest value. The series is gently monotonic so the eye reads
       * "trending up" without optical noise.
       */
      const padX = 12
      const padTop = 26
      const padBottom = 18
      const left = padX
      const right = w - padX
      const top = padTop
      const bottom = h - padBottom
      const pts = [0.1, 0.22, 0.34, 0.3, 0.48, 0.52, 0.66, 0.6, 0.78, 0.85, 0.95]
      const xs = pts.map((_, i, arr) => left + ((right - left) * i) / (arr.length - 1))
      const ys = pts.map((p) => bottom - p * (bottom - top))
      const linePath = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x} ${ys[i]}`).join(' ')
      const areaPath = `${linePath} L ${right} ${bottom} L ${left} ${bottom} Z`
      const midY = top + (bottom - top) * 0.5
      // Bottom tick marks.
      const tickCount = 6
      return (
        <>
          {/* Stat readout under the title. */}
          <rect x="12" y="20" width="46" height="6" rx="2" fill="rgba(255,255,255,0.85)" />
          <rect x="62" y="22" width="20" height="3" rx="1.5" fill="rgba(167,243,208,0.85)" />

          {/* Midline grid. */}
          <line
            x1={left}
            y1={midY}
            x2={right}
            y2={midY}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
          {/* Baseline + ticks. */}
          <line
            x1={left}
            y1={bottom}
            x2={right}
            y2={bottom}
            stroke="rgba(255,255,255,0.18)"
            strokeWidth="1"
          />
          {Array.from({ length: tickCount }).map((_, i) => {
            const tx = left + ((right - left) * i) / (tickCount - 1)
            return (
              <line
                key={i}
                x1={tx}
                y1={bottom}
                x2={tx}
                y2={bottom + 4}
                stroke="rgba(255,255,255,0.18)"
                strokeWidth="1"
              />
            )
          })}

          {/* The chart itself. */}
          <path d={areaPath} fill="url(#hero-area)" />
          <path
            d={linePath}
            fill="none"
            stroke="url(#hero-spark)"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )
    }
    case 'bars': {
      // Six bars sitting on a baseline. Track expanded to fill the
      // smaller tile properly so the tallest bar reads at a glance.
      const bars = [0.4, 0.65, 0.55, 0.85, 0.6, 0.5]
      const colW = 5
      const gap = 4
      const totalW = bars.length * colW + (bars.length - 1) * gap
      const start = (w - totalW) / 2
      const baseY = h - 8
      const trackTop = 20
      return (
        <g>
          {bars.map((v, i) => {
            const barH = v * (baseY - trackTop)
            return (
              <rect
                key={i}
                x={start + i * (colW + gap)}
                y={baseY - barH}
                width={colW}
                height={barH}
                rx="1.5"
                fill="white"
                fillOpacity={0.4 + v * 0.5}
              />
            )
          })}
        </g>
      )
    }
    case 'kpi': {
      // Big number + delta chip + subtitle line. Tile is 76×52, so
      // everything sits between y=20 and y=42 (below the title bar at y=11).
      return (
        <>
          <rect x="12" y="20" width="28" height="9" rx="2" fill="rgba(255,255,255,0.95)" />
          <rect x="42" y="22" width="14" height="5" rx="2.5" fill="rgba(167,243,208,0.9)" />
          <rect x="12" y="34" width="48" height="2.5" rx="1.25" fill="rgba(255,255,255,0.4)" />
          <rect x="12" y="40" width="32" height="2.5" rx="1.25" fill="rgba(255,255,255,0.25)" />
        </>
      )
    }
    case 'donut': {
      // Smaller r leaves clean margins inside the 52-tall tile, and
      // pulling cy slightly up away from the bottom keeps the percentage
      // text from sitting on the tile edge.
      const cx = w / 2
      const cy = h / 2 + 4
      const r = 10
      return (
        <g>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="3" />
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="rgba(125,211,252,0.92)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * r * 0.72} ${2 * Math.PI * r}`}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
          <text
            x={cx}
            y={cy + 2.5}
            textAnchor="middle"
            fontSize="7"
            fontWeight="600"
            fill="rgba(255,255,255,0.96)"
          >
            72%
          </text>
        </g>
      )
    }
    case 'dot': {
      // Status rows — colored dot + text bar. Spacing tightened from 12
      // to 9 so all three rows clear the tile bottom with breathing room.
      const baseY = 22
      const rowGap = 9
      const rows: { tone: string; w: number; opacity: number }[] = [
        { tone: 'rgba(167,243,208,0.95)', w: 38, opacity: 0.75 },
        { tone: 'rgba(253,186,116,0.9)', w: 30, opacity: 0.55 },
        { tone: 'rgba(125,211,252,0.9)', w: 24, opacity: 0.5 },
      ]
      return (
        <g>
          {rows.map((r, i) => {
            const cy = baseY + i * rowGap
            return (
              <g key={i}>
                <circle cx="14" cy={cy} r="2.5" fill={r.tone} />
                <rect
                  x="22"
                  y={cy - 1.5}
                  width={r.w}
                  height="3"
                  rx="1.5"
                  fill={`rgba(255,255,255,${r.opacity})`}
                />
              </g>
            )
          })}
        </g>
      )
    }
    case 'rows': {
      // Leading label + trailing value, three rows. Compact spacing so
      // the rows don't overflow the smaller tile.
      const startY = 22
      const rowGap = 7
      return (
        <g>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect
                x="12"
                y={startY + i * rowGap}
                width={30 - i * 4}
                height="2.5"
                rx="1.25"
                fill="rgba(255,255,255,0.5)"
              />
              <rect
                x={w - 12 - (16 - i * 4)}
                y={startY + i * rowGap}
                width={16 - i * 4}
                height="2.5"
                rx="1.25"
                fill="rgba(255,255,255,0.88)"
              />
            </g>
          ))}
        </g>
      )
    }
    case 'meter': {
      // Title bar + tiny value chip on the right + filled track at the
      // bottom. Extra chip gives the tile something to read between the
      // two bars instead of feeling empty.
      const filled = 0.68
      const trackY = h - 12
      return (
        <g>
          <rect x="12" y="22" width="34" height="3" rx="1.5" fill="rgba(255,255,255,0.55)" />
          <rect x="50" y="21" width="16" height="5" rx="2" fill="rgba(167,243,208,0.85)" />
          <rect
            x="12"
            y={trackY}
            width={w - 24}
            height="3.5"
            rx="1.75"
            fill="rgba(255,255,255,0.15)"
          />
          <rect
            x="12"
            y={trackY}
            width={(w - 24) * filled}
            height="3.5"
            rx="1.75"
            fill="rgba(125,211,252,0.92)"
          />
        </g>
      )
    }
  }
  // Acknowledge `lifted` so TS sees it as referenced in case future variants
  // use it for in-tile decoration. Currently the visual lift comes from the
  // outer wrapper.
  void lifted
}

/* ───────────────────── panels ───────────────────── */

function ClusterSnapshotPanel() {
  const data = useClusterSignals()
  const s = summarizeCluster(data)
  const connected = s.connected
  const connecting = s.connecting

  // Rolling windows for the sparklines — recorded on each poll into local state
  // so the graph feels alive even on a calm cluster.
  const [history, setHistory] = useState<{
    pods: number[]
    nodes: number[]
    healthy: number[]
    deploys: number[]
  }>({ pods: [], nodes: [], healthy: [], deploys: [] })

  useEffect(() => {
    if (connecting) return
    setHistory((h) => ({
      pods: cap([...h.pods, s.pods.running]),
      nodes: cap([...h.nodes, s.nodes.ready]),
      healthy: cap([...h.healthy, s.healthyDeploymentsPct]),
      deploys: cap([...h.deploys, s.deployFrequencyPerWeek]),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.pods.running, s.nodes.ready, s.healthyDeploymentsPct, s.deployFrequencyPerWeek, connecting])

  const nodePct =
    s.nodes.total > 0 ? Math.round((s.nodes.ready / s.nodes.total) * 100) : 0
  const podPct = s.pods.total > 0 ? Math.round((s.pods.running / s.pods.total) * 100) : 0

  return (
    <div className="flex h-full flex-col rounded-2xl border border-edge-default bg-surface-raised p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={
              connecting
                ? 'h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400'
                : connected
                  ? 'h-1.5 w-1.5 rounded-full bg-emerald-500'
                  : 'h-1.5 w-1.5 rounded-full bg-rose-500'
            }
          />
          <span className="font-medium text-content">
            {connecting
              ? 'Connecting to cluster…'
              : connected
                ? 'Cluster connected'
                : 'Cluster unreachable'}
          </span>
          <span className="text-content-subtle">· updates every 15s</span>
        </div>
        <Link to="/platform" className="text-xs font-medium text-brand-700 dark:text-brand-300 hover:text-brand-800 dark:hover:text-brand-300">
          Open Platform →
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[auto_1fr]">
        {/* Left: Node readiness donut */}
        <div className="flex items-center justify-center rounded-xl border border-edge-subtle bg-surface-sunken/60 p-5">
          <DonutGauge
            value={nodePct}
            max={100}
            size={140}
            thickness={14}
            color={
              nodePct === 100
                ? 'var(--color-brand-500)'
                : nodePct >= 50
                  ? '#f59e0b'
                  : '#f43f5e'
            }
            label={
              <span>
                {nodePct}
                <span className="text-sm font-normal text-content-muted">%</span>
              </span>
            }
            caption={`${s.nodes.ready}/${s.nodes.total} nodes`}
          />
        </div>

        {/* Right: 4 stat tiles each with a sparkline */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Pods"
            value={`${s.pods.running}/${s.pods.total}`}
            sub={s.pods.failing ? `${s.pods.failing} failing` : `${podPct}% running`}
            tone={s.pods.failing ? 'rose' : 'emerald'}
            series={history.pods}
          />
          <StatTile
            label="Deployments"
            value={`${s.healthyDeploymentsPct}%`}
            sub={`${s.activeDeployments} / ${s.totalDeployments}`}
            tone={
              s.healthyDeploymentsPct >= 95
                ? 'emerald'
                : s.healthyDeploymentsPct >= 75
                  ? 'amber'
                  : 'rose'
            }
            series={history.healthy}
          />
          <StatTile
            label="Deploys / week"
            value={String(s.deployFrequencyPerWeek)}
            sub={s.deployFrequencyPerWeek > 0 ? 'live' : 'no recent'}
            tone="emerald"
            series={history.deploys}
          />
          <StatTile
            label="Policy"
            value={
              s.policy.installed
                ? s.policy.fail === 0
                  ? '100%'
                  : `${s.policy.fail} fail`
                : '—'
            }
            sub={s.policy.installed ? `${s.policy.pass} pass` : 'not installed'}
            tone={
              !s.policy.installed ? 'slate' : s.policy.fail === 0 ? 'emerald' : 'rose'
            }
          />
        </div>
      </div>
    </div>
  )
}

function StatTile({
  label,
  value,
  sub,
  tone,
  series,
}: {
  label: string
  value: string
  sub: string
  tone: 'emerald' | 'amber' | 'rose' | 'slate'
  series?: number[]
}) {
  const color =
    tone === 'emerald'
      ? 'var(--color-brand-500)'
      : tone === 'amber'
        ? '#f59e0b'
        : tone === 'rose'
          ? '#f43f5e'
          : 'var(--color-content-subtle)'
  return (
    <div className="relative overflow-hidden rounded-xl border border-edge-subtle bg-surface-sunken/80 p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-content">
        {value}
      </div>
      <div className={`mt-0.5 text-xs font-medium ${toneText(tone)}`}>{sub}</div>
      {series && series.length > 1 ? (
        <div className="pointer-events-none absolute -bottom-1 left-0 right-0 opacity-50">
          <Sparkline points={series} color={color} height={28} strokeWidth={1.25} />
        </div>
      ) : null}
    </div>
  )
}

function cap(arr: number[]) {
  const MAX = 30
  return arr.length > MAX ? arr.slice(arr.length - MAX) : arr
}

interface DoraStat {
  label: string
  value: string
  delta: string
  tone: 'emerald' | 'amber' | 'rose'
  series: number[]
}

const DORA_STATS: DoraStat[] = [
  {
    label: 'Deploys (7d)',
    value: '128',
    delta: '+24%',
    tone: 'emerald',
    series: [6, 8, 7, 9, 11, 12, 10, 14, 13, 16, 15, 18, 20, 22, 24],
  },
  {
    label: 'Lead time',
    value: '2h 14m',
    delta: '−18%',
    tone: 'emerald',
    series: [180, 175, 168, 172, 160, 158, 150, 144, 142, 138, 135, 132, 140, 138, 134],
  },
  {
    label: 'Change fail rate',
    value: '4.2%',
    delta: '+0.6pp',
    tone: 'amber',
    series: [3.2, 3.1, 3.4, 3.6, 3.5, 3.8, 3.7, 4.0, 4.1, 4.3, 4.2, 4.0, 4.1, 4.2, 4.2],
  },
  {
    label: 'MTTR',
    value: '32m',
    delta: '−42%',
    tone: 'emerald',
    series: [58, 55, 52, 48, 50, 45, 44, 40, 42, 38, 35, 36, 34, 33, 32],
  },
]

const DORA_COLOR: Record<DoraStat['tone'], string> = {
  emerald: 'var(--color-brand-500)',
  amber: '#f59e0b',
  rose: '#f43f5e',
}

function DoraPanel() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {DORA_STATS.map((s) => (
        <div
          key={s.label}
          className="group relative overflow-hidden rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-all duration-150 ease-smooth hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md"
        >
          <div className="relative z-10">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
                {s.label}
              </div>
              <div className={`text-xs font-medium ${toneText(s.tone)}`}>{s.delta}</div>
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-content">
              {s.value}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 opacity-60">
            <Sparkline points={s.series} color={DORA_COLOR[s.tone]} height={64} strokeWidth={1.25} />
          </div>
        </div>
      ))}
    </div>
  )
}

function CompliancePanel() {
  const data = useClusterSignals()
  const s = summarizeCluster(data)
  const podPct = s.pods.total > 0 ? Math.round((s.pods.running / s.pods.total) * 100) : 100
  const nodePct = s.nodes.total > 0 ? Math.round((s.nodes.ready / s.nodes.total) * 100) : 100
  const deployHealthy =
    s.totalDeployments > 0
      ? Math.round((s.activeDeployments / s.totalDeployments) * 100)
      : 100

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
      <ComplianceCard
        title="Policy compliance"
        badge={
          s.policy.installed ? (
            <StatusBadge kind={s.policy.fail === 0 ? 'healthy' : 'degraded'}>
              {s.policy.fail === 0 ? '100% pass' : `${s.policy.fail} failing`}
            </StatusBadge>
          ) : (
            <StatusBadge kind="unknown">Kyverno not installed</StatusBadge>
          )
        }
        description={
          s.policy.installed
            ? `${s.policy.fail} failing · ${s.policy.warn} warnings · ${s.policy.pass} passes`
            : 'Install Kyverno to surface policy reports on this panel.'
        }
      />
      <ComplianceCard
        title="GitOps drift"
        badge={
          s.argo.installed ? (
            <StatusBadge kind={s.argo.synced === s.argo.total ? 'healthy' : 'degraded'}>
              {s.argo.synced} / {s.argo.total} synced
            </StatusBadge>
          ) : (
            <StatusBadge kind="unknown">Argo CD not installed</StatusBadge>
          )
        }
        description={
          s.argo.installed
            ? `${s.argo.healthy} apps healthy · live across every namespace`
            : 'Install Argo CD to track GitOps drift.'
        }
      />
      <ComplianceCard
        title="Rollouts healthy"
        badge={
          s.rollouts.installed ? (
            <StatusBadge kind={s.rollouts.healthy === s.rollouts.total ? 'healthy' : 'progressing'}>
              {s.rollouts.healthy} / {s.rollouts.total}
            </StatusBadge>
          ) : (
            <StatusBadge kind="unknown">Argo Rollouts not installed</StatusBadge>
          )
        }
        description="Canary / blue-green progressive delivery status."
      />
      <ComplianceCard
        title="Pod health"
        badge={
          <StatusBadge kind={podPct >= 95 ? 'healthy' : podPct >= 80 ? 'progressing' : 'degraded'}>
            {podPct}% running
          </StatusBadge>
        }
        description={`${s.pods.running} / ${s.pods.total} pods running · ${s.pods.failing} failing`}
      />
      <ComplianceCard
        title="Node readiness"
        badge={
          <StatusBadge kind={nodePct === 100 ? 'healthy' : nodePct >= 75 ? 'progressing' : 'degraded'}>
            {s.nodes.ready} / {s.nodes.total} ready
          </StatusBadge>
        }
        description={
          s.nodes.total > 0
            ? `${s.nodes.total - s.nodes.ready} unavailable · auto-scaler online`
            : 'No nodes reported by the apiserver yet.'
        }
      />
      <ComplianceCard
        title="Deploy health"
        badge={
          <StatusBadge kind={deployHealthy >= 95 ? 'healthy' : deployHealthy >= 80 ? 'progressing' : 'degraded'}>
            {deployHealthy}% healthy
          </StatusBadge>
        }
        description={`${s.activeDeployments} / ${s.totalDeployments} deployments at desired replicas`}
      />
    </div>
  )
}

function ComplianceCard({
  title,
  badge,
  description,
}: {
  title: string
  badge: ReactNode
  description: string
}) {
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-content">{title}</div>
        {badge}
      </div>
      <div className="mt-2 text-xs text-content-muted">{description}</div>
    </div>
  )
}

const PINNED_APP_IDS = ['argocd', 'gitea', 'harbor', 'grafana', 'keycloak', 'kargo']

const APP_TINT: Record<string, string> = {
  argocd: 'from-sky-50 dark:from-sky-500/10 to-surface-raised',
  gitea: 'from-emerald-50 dark:from-emerald-500/10 to-surface-raised',
  harbor: 'from-violet-50 dark:from-violet-500/10 to-surface-raised',
  grafana: 'from-amber-50 dark:from-amber-500/10 to-surface-raised',
  keycloak: 'from-rose-50 dark:from-rose-500/10 to-surface-raised',
  kargo: 'from-brand-50 dark:from-brand-500/10 to-surface-raised',
}

function PinnedAppsPanel() {
  const pinned = PINNED_APP_IDS
    .map((id) => DEFAULT_APP_LINKS.find((a) => a.id === id))
    .filter((a): a is AppLink => !!a)
  return (
    <div className="flex h-full flex-col rounded-2xl border border-edge-default bg-surface-raised p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-content">Pinned apps</div>
          <div className="text-[11px] text-content-subtle">
            Jump into any backing tool · opens in a new tab
          </div>
        </div>
        <Link
          to="/status"
          className="text-[11px] font-medium text-brand-700 dark:text-brand-300 hover:text-brand-800 dark:hover:text-brand-300 hover:underline"
        >
          See all →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {pinned.map((a) => {
          const tint = APP_TINT[a.id] ?? 'from-surface-sunken to-surface-raised'
          return (
            <a
              key={a.id}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className={`group relative flex flex-col items-center gap-2 overflow-hidden rounded-xl border border-edge-default bg-linear-to-br ${tint} p-4 text-center transition-all hover:-translate-y-0.5 hover:border-brand-200 dark:hover:border-brand-500/25 hover:shadow-md`}
            >
              <span
                aria-hidden
                className="absolute right-2 top-2 text-content-subtle opacity-0 transition-opacity group-hover:opacity-100"
              >
                <IconArrowUpRight />
              </span>
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-raised shadow-sm ring-1 ring-edge-subtle [&>svg]:h-7 [&>svg]:w-7">
                {a.icon}
              </div>
              <div className="text-sm font-semibold text-content">{a.name}</div>
              <div className="truncate text-[11px] text-content-subtle">{a.description}</div>
            </a>
          )
        })}
      </div>
    </div>
  )
}

function IconArrowUpRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  )
}

function RecentNotificationsPanel({ seed }: { seed: Notification[] }) {
  const { items } = useNotifications(seed)
  const recent = items.slice(0, 5)
  if (!recent.length) {
    return (
      <div className="rounded-xl border border-edge-default bg-surface-raised p-6 text-center text-sm text-content-muted shadow-sm">
        You're all caught up.
      </div>
    )
  }
  return (
    <ul className="divide-y divide-edge-subtle rounded-xl border border-edge-default bg-surface-raised shadow-sm">
      {recent.map((n) => {
        const tone =
          n.kind === 'error'
            ? 'bg-rose-500'
            : n.kind === 'warning'
              ? 'bg-amber-500'
              : n.kind === 'success'
                ? 'bg-emerald-500'
                : 'bg-sky-500'
        const row = (
          <div className="flex items-start gap-3 px-4 py-3">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone}`} />
            <div className="min-w-0 flex-1">
              <div className={`text-sm leading-snug ${n.read ? 'text-content-muted' : 'font-medium text-content'}`}>
                {n.title}
              </div>
              {n.description ? (
                <div className="mt-0.5 line-clamp-2 text-xs text-content-muted">{n.description}</div>
              ) : null}
              <div className="mt-1 text-[11px] text-content-subtle">{safeRelative(n.at)}</div>
            </div>
          </div>
        )
        return (
          <li key={n.id} className="transition-colors hover:bg-surface-sunken">
            {n.href ? (
              <a
                href={n.href}
                target={n.href.startsWith('http') ? '_blank' : undefined}
                rel={n.href.startsWith('http') ? 'noreferrer' : undefined}
                className="block"
              >
                {row}
              </a>
            ) : (
              row
            )}
          </li>
        )
      })}
    </ul>
  )
}

/* ───────────────────── customize sheet ───────────────────── */

function CustomizeSheet({
  layout,
  onChange,
  onClose,
  onReset,
}: {
  layout: OverviewLayout
  onChange(next: OverviewLayout): void
  onClose(): void
  onReset(): void
}) {
  const enabled = new Set(layout.enabled)

  // Group panels by category. Within a category, enabled panels first
  // (in their layout order), then disabled panels appended.
  const byCat = useMemo(() => {
    const out: Record<PanelCategory, PanelDef[]> = {
      'cross-cutting': [],
      business: [],
      lifecycle: [],
      reliability: [],
      security: [],
      product: [],
      shortcuts: [],
    }
    for (const p of PANELS) out[p.category].push(p)
    return out
  }, [])

  const toggle = (id: PanelId) => {
    if (enabled.has(id)) {
      const nextEnabled = layout.enabled.filter((x) => x !== id)
      const nextOrder = (layout.order ?? layout.enabled).filter((x) => x !== id)
      onChange({ ...layout, enabled: nextEnabled, order: nextOrder })
    } else {
      const nextEnabled = [...layout.enabled, id]
      const nextOrder = [...(layout.order ?? layout.enabled), id]
      onChange({ ...layout, enabled: nextEnabled, order: nextOrder })
    }
  }

  /** Reorder operates on the saved `order` and pivots to custom mode. */
  const move = (id: PanelId, dir: -1 | 1) => {
    const arr = [...(layout.order ?? layout.enabled)]
    const idx = arr.indexOf(id)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= arr.length) return
    ;[arr[idx], arr[target]] = [arr[target], arr[idx]]
    onChange({ ...layout, order: arr, mode: 'custom' })
  }

  const setSize = (id: PanelId, size: PanelSize) => {
    onChange({
      ...layout,
      sizes: { ...(layout.sizes ?? {}), [id]: size },
    })
  }

  const enableAll = () => {
    const allIds = PANELS.map((p) => p.id)
    onChange({ ...layout, enabled: allIds, order: allIds })
  }
  const disableAll = () => {
    onChange({ ...layout, enabled: [], order: [] })
  }

  const orderedIds = layout.order ?? layout.enabled

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Customize overview"
        className="relative flex h-full w-full max-w-md flex-col border-l border-edge-default bg-surface-raised shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-edge-default px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-content">Customize overview</h2>
            <p className="mt-0.5 text-xs text-content-muted">
              Toggle, reorder, and resize panels — saved to this browser.
            </p>
            <div className="mt-2 flex items-center gap-2 text-[11px]">
              <span className="text-content-subtle">{layout.enabled.length} of {PANELS.length} enabled</span>
              <span className="text-content-subtle">·</span>
              <button
                type="button"
                onClick={enableAll}
                className="font-medium text-brand-700 dark:text-brand-300 hover:text-brand-800 dark:hover:text-brand-300"
              >
                Enable all
              </button>
              <span className="text-content-subtle">·</span>
              <button
                type="button"
                onClick={disableAll}
                className="font-medium text-content-muted hover:text-content"
              >
                Clear
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {(Object.keys(byCat) as PanelCategory[]).map((cat) => {
            const list = byCat[cat]
            if (!list.length) return null
            const onCount = list.filter((p) => enabled.has(p.id)).length
            return (
              <section key={cat}>
                <div className="mb-2 flex items-baseline justify-between">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
                    {CATEGORY_LABEL[cat]}
                  </h3>
                  <span className="font-mono text-[10px] text-content-subtle">
                    {onCount}/{list.length}
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {list.map((def) => {
                    const id = def.id
                    const on = enabled.has(id)
                    const idxInOrder = orderedIds.indexOf(id)
                    const canMoveUp = on && idxInOrder > 0
                    const canMoveDown =
                      on && idxInOrder >= 0 && idxInOrder < orderedIds.length - 1
                    const size = sizeFor(layout, def)
                    return (
                      <li
                        key={id}
                        className={`rounded-lg border px-3 py-2.5 transition-colors ${
                          on ? 'border-brand-200 dark:border-brand-500/25 bg-brand-50/40 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <label className="mt-0.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggle(id)}
                              className="h-4 w-4 accent-brand-600"
                            />
                          </label>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-content">{def.title}</div>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-content-muted">
                              {def.description}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col gap-1">
                            <button
                              type="button"
                              disabled={!canMoveUp}
                              onClick={() => move(id, -1)}
                              className="flex h-6 w-6 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-raised hover:text-content disabled:cursor-not-allowed disabled:opacity-30"
                              aria-label="Move up"
                            >
                              <IconChevronUp />
                            </button>
                            <button
                              type="button"
                              disabled={!canMoveDown}
                              onClick={() => move(id, 1)}
                              className="flex h-6 w-6 items-center justify-center rounded text-content-subtle transition-colors hover:bg-surface-raised hover:text-content disabled:cursor-not-allowed disabled:opacity-30"
                              aria-label="Move down"
                            >
                              <IconChevronDown />
                            </button>
                          </div>
                        </div>
                        {on ? (
                          <div className="mt-2 flex items-center gap-1 pl-7">
                            <span className="text-[10px] uppercase tracking-wider text-content-subtle">
                              size
                            </span>
                            {(['sm', 'md', 'lg', 'xl'] as PanelSize[]).map((s) => (
                              <button
                                key={s}
                                type="button"
                                onClick={() => setSize(id, s)}
                                className={
                                  size === s
                                    ? 'rounded-md bg-brand-100 dark:bg-brand-500/15 px-2 py-0.5 text-[10px] font-semibold text-brand-700 dark:text-brand-300'
                                    : 'rounded-md px-2 py-0.5 text-[10px] text-content-muted hover:bg-surface-sunken'
                                }
                                title={SIZE_LABEL[s]}
                              >
                                {SIZE_LABEL[s]}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-edge-default bg-surface-sunken px-5 py-3">
          <button
            type="button"
            onClick={onReset}
            className="text-xs font-medium text-content-muted hover:text-content"
          >
            Reset to default
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-brand-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-brand-700"
          >
            Done
          </button>
        </footer>
      </aside>
    </div>
  )
}

/* ───────────────────── utils + icons ───────────────────── */

function toneText(tone: 'emerald' | 'amber' | 'rose' | 'slate') {
  return tone === 'emerald'
    ? 'text-emerald-600'
    : tone === 'amber'
      ? 'text-amber-600'
      : tone === 'rose'
        ? 'text-rose-600'
        : 'text-content-subtle'
}

function safeRelative(at: string): string {
  try {
    return formatRelative(at)
  } catch {
    return at
  }
}

function IconSliders() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="4" y1="6" x2="14" y2="6" />
      <line x1="4" y1="12" x2="10" y2="12" />
      <line x1="4" y1="18" x2="16" y2="18" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="14" cy="12" r="2" />
      <circle cx="20" cy="18" r="2" />
    </svg>
  )
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function IconChevronUp() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m18 15-6-6-6 6" />
    </svg>
  )
}

function IconChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
