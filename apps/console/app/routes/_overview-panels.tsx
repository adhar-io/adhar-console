import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AreaChart,
  BarChart,
  HeatMap,
  Sparkline,
  Spinner,
  StatusBadge,
  useOrganizations,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { summarizeCluster, useClusterSignals } from '~/data/cluster-signals.ts'
import {
  useAirbyteConnections,
  useBiDashboards,
  useBusinessKpis,
  useDefineSignals,
  useDeliverApplications,
  useDevelopPRs,
  useDevelopRepos,
  useDiscoverAlerts,
  useGoldenSignals,
  usePostHogActivity,
  useTrivyReports,
} from '~/data/cross-module-signals.ts'
import {
  useAllPods,
  useBudget,
  useCertificates,
  useClusterEvents,
  useCostTrend,
  useCnpgBackups,
  useCnpgClusters,
  useCnpgScheduledBackups,
  useDoraApps,
  useEndpoints,
  useKafkas,
  useKafkaTopics,
  useNamespaces,
  useNodeMetrics,
  useNodes,
  usePvcs,
  useResourceQuotas,
  useServices,
  useToolsConfig,
  useVeleroBackups,
  parseBytes,
  parseCpu,
} from '~/data/platform-signals.ts'
import { leadTimeScore } from '~/data/dora-flow.ts'
import { useVolumeUsage } from '~/data/overview-metrics.ts'
import { useDoraLeadTime, useDoraOps } from '~/data/dora-ops.ts'
import {
  appWorkloads,
  changeFailureRate,
  type DeployEvent,
  formatDuration,
  mttrSummary,
} from '~/data/dora-radar-sources.ts'
import type { Generic } from '@adhar/api-clients/k8s'

/**
 * Cross-module Overview panels. Each one pulls from its module's stub-backed
 * client through `~/data/cross-module-signals.ts`, so the host never crosses
 * the Module Federation boundary. Designed to be small, glanceable, and
 * link to the relevant deep view.
 */

/* ───── Define · open issues + active cycle ───── */

export function DefineIssuesPanel() {
  const { projects, issues, cycles } = useDefineSignals()
  const project = projects.data?.[0]
  const list = issues.data ?? []
  const open = list.filter((i) => !i.completed_at).length
  const done = list.filter((i) => !!i.completed_at).length
  const total = list.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const active = (cycles.data ?? []).find((c) => c.status === 'current')

  return (
    <PanelCard>
      <PanelHead title="Define" subtitle={project?.name ?? 'No project'} to="/define" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Open" value={open} tone="amber" />
        <Stat label="Done" value={done} tone="emerald" />
        <Stat label="% done" value={`${pct}%`} tone="brand" />
      </div>
      {active ? (
        <div className="mt-3 rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
          <div className="flex items-baseline justify-between">
            <span className="truncate text-xs font-medium text-content">{active.name}</span>
            <StatusBadge kind="progressing">{active.progress ?? 0}%</StatusBadge>
          </div>
          <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div className="h-full bg-brand-500" style={{ width: `${active.progress ?? 0}%` }} />
          </div>
          <div className="mt-1 text-[10px] text-content-subtle">
            {active.completed_issues}/{active.total_issues} issues · ends{' '}
            {active.end_date ? formatRelative(active.end_date) : '—'}
          </div>
        </div>
      ) : null}
    </PanelCard>
  )
}

/* ───── Develop · open PRs + repos ───── */

export function DevelopPRsPanel() {
  const prs = useDevelopPRs()
  const repos = useDevelopRepos()
  const list = prs.data ?? []
  const conflicts = list.filter((p) => p.mergeable === false).length
  return (
    <PanelCard>
      <PanelHead
        title="Develop"
        subtitle={`${repos.data?.length ?? 0} repos · ${list.length} open PRs`}
        to="/develop"
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Open PRs" value={list.length} tone="amber" />
        <Stat label="Conflicts" value={conflicts} tone={conflicts ? 'rose' : 'slate'} />
        <Stat label="Repos" value={repos.data?.length ?? 0} tone="brand" />
      </div>
      {list.length > 0 ? (
        <ul className="mt-3 divide-y divide-edge-subtle rounded-lg border border-edge-subtle bg-surface-raised">
          {list.slice(0, 4).map((p) => (
            <li key={p.id} className="px-3 py-2 text-[11px]">
              <div className="flex items-center gap-2">
                <code className="font-mono text-content-muted">#{p.number}</code>
                <span className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[10px] text-content-muted">
                  {p.repo}
                </span>
                <span className="truncate text-content">{p.title}</span>
              </div>
              <div className="mt-0.5 text-content-subtle">
                {p.user.login} · {formatRelative(p.created_at)}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </PanelCard>
  )
}

/* ───── Develop · Airbyte data pipelines ───── */

export function PipelinesPanel() {
  const q = useAirbyteConnections()
  const list = q.data ?? []
  const running = list.filter((c) => c.last_sync_status === 'running').length
  const failed = list.filter((c) => c.last_sync_status === 'failed').length
  const succeeded = list.filter((c) => c.last_sync_status === 'succeeded').length
  return (
    <PanelCard>
      <PanelHead title="Data pipelines" subtitle="Airbyte connections" to="/develop?pipelines" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Connections" value={list.length} tone="brand" />
        <Stat label="Running" value={running} tone={running ? 'amber' : 'slate'} />
        <Stat label="Failed" value={failed} tone={failed ? 'rose' : 'emerald'} />
      </div>
      {list.length > 0 ? (
        <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
          <div className="h-full bg-emerald-500" style={{ width: `${(succeeded / list.length) * 100}%` }} />
          <div className="h-full bg-amber-500" style={{ width: `${(running / list.length) * 100}%` }} />
          <div className="h-full bg-rose-500" style={{ width: `${(failed / list.length) * 100}%` }} />
        </div>
      ) : null}
    </PanelCard>
  )
}

/* ───── Deliver · ArgoCD apps ───── */

export function DeliverAppsPanel() {
  const q = useDeliverApplications()
  const list = q.data ?? []
  const drift = list.filter((a) => a.status.sync.status === 'OutOfSync').length
  const degraded = list.filter((a) => a.status.health.status === 'Degraded').length
  return (
    <PanelCard>
      <PanelHead title="Deliver · GitOps" subtitle="ArgoCD applications" to="/deliver?apps" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Apps" value={list.length} tone="brand" />
        <Stat label="Drift" value={drift} tone={drift ? 'amber' : 'slate'} />
        <Stat label="Degraded" value={degraded} tone={degraded ? 'rose' : 'emerald'} />
      </div>
      <ul className="mt-3 space-y-1.5">
        {list.slice(0, 4).map((a) => {
          const sync = a.status.sync.status
          const health = a.status.health.status
          return (
            <li
              key={a.metadata.name}
              className="flex items-center gap-2 rounded-md bg-surface-sunken/40 px-2 py-1 text-[11px]"
            >
              <span
                className={
                  health === 'Healthy'
                    ? 'h-1.5 w-1.5 rounded-full bg-emerald-500'
                    : health === 'Degraded'
                      ? 'h-1.5 w-1.5 rounded-full bg-rose-500'
                      : 'h-1.5 w-1.5 rounded-full bg-amber-500'
                }
              />
              <span className="truncate font-medium text-content">{a.metadata.name}</span>
              <span className="ml-auto font-mono text-[10px] text-content-subtle">{sync}</span>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── Deliver · Trivy CVEs ───── */

export function VulnSummaryPanel() {
  const q = useTrivyReports()
  const list = q.data ?? []
  const totals = list.reduce(
    (acc, r) => ({
      critical: acc.critical + r.summary.critical,
      high: acc.high + r.summary.high,
      medium: acc.medium + r.summary.medium,
      low: acc.low + r.summary.low,
    }),
    { critical: 0, high: 0, medium: 0, low: 0 },
  )
  const grand = totals.critical + totals.high + totals.medium + totals.low || 1
  return (
    <PanelCard>
      <PanelHead title="Vulnerabilities" subtitle="Trivy reports" to="/deliver?scans" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <SevTile label="Crit" value={totals.critical} tone="rose" />
        <SevTile label="High" value={totals.high} tone="amber" />
        <SevTile label="Med" value={totals.medium} tone="sky" />
        <SevTile label="Low" value={totals.low} tone="slate" />
      </div>
      <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
        <div className="h-full bg-rose-500" style={{ width: `${(totals.critical / grand) * 100}%` }} />
        <div className="h-full bg-amber-500" style={{ width: `${(totals.high / grand) * 100}%` }} />
        <div className="h-full bg-sky-500" style={{ width: `${(totals.medium / grand) * 100}%` }} />
        <div className="h-full bg-slate-400" style={{ width: `${(totals.low / grand) * 100}%` }} />
      </div>
      <div className="mt-2 text-[10px] text-content-muted">
        {list.length} reports across {new Set(list.map((r) => r.namespace)).size} namespaces
      </div>
    </PanelCard>
  )
}

/* ───── Discover · alerts ───── */

export function AlertsPanel() {
  const q = useDiscoverAlerts()
  const list = q.data ?? []
  const firing = list.filter((a) => a.state === 'firing')
  const critical = firing.filter((a) => a.severity === 'critical').length
  return (
    <PanelCard>
      <PanelHead title="Alerts" subtitle="Prometheus rules · live" to="/discover?alerts" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Firing" value={firing.length} tone={firing.length ? 'rose' : 'emerald'} />
        <Stat label="Critical" value={critical} tone={critical ? 'rose' : 'slate'} />
        <Stat label="Pending" value={list.filter((a) => a.state === 'pending').length} tone="amber" />
      </div>
      <ul className="mt-3 space-y-1">
        {firing.slice(0, 3).map((a) => (
          <li
            key={a.fingerprint}
            className="rounded-md border border-rose-200/70 dark:border-rose-500/25 bg-rose-50/40 dark:bg-rose-500/10 px-2 py-1.5 text-[11px]"
          >
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.severity === 'critical' ? 'bg-rose-500' : 'bg-amber-500'}`} />
              <span className="truncate font-semibold text-content">{a.name}</span>
              <span className="ml-auto text-[10px] text-content-muted">
                {formatRelative(a.startsAt)}
              </span>
            </div>
            {a.summary ? (
              <div className="mt-0.5 line-clamp-1 text-content-muted">{a.summary}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

/* ───── Discover · product analytics (PostHog) ───── */

export function AnalyticsPanel() {
  const q = usePostHogActivity()
  const list = q.data ?? []
  const dau = new Set(list.map((e) => e.distinct_id)).size
  const counts: Record<string, number> = {}
  for (const e of list) counts[e.event] = (counts[e.event] ?? 0) + 1
  const top = Object.entries(counts).sort(([, a], [, b]) => b - a).slice(0, 4)
  return (
    <PanelCard>
      <PanelHead title="Product analytics" subtitle="PostHog · 24h" to="/discover?analytics" />
      <div className="grid grid-cols-2 gap-3">
        <Stat label="DAU" value={dau} tone="brand" />
        <Stat label="Events" value={list.length} tone="violet" />
      </div>
      {top.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            Top events
          </div>
          <BarChart
            bars={top.map(([label, value], i) => ({
              label,
              value,
              color: i === 0 ? 'var(--color-brand-500)' : 'var(--color-brand-400)',
            }))}
            height={Math.min(top.length * 22 + 8, 100)}
          />
        </div>
      ) : null}
    </PanelCard>
  )
}

/* ───── Decide · business KPIs ───── */

export function BusinessKpisPanel() {
  const q = useBusinessKpis()
  const all = q.data ?? []
  const scalars = all.filter((q) => q.scalar != null && q.display === 'scalar').slice(0, 4)
  return (
    <PanelCard>
      <PanelHead title="Business KPIs" subtitle="Metabase · live" to="/decide?dashboards" />
      <div className="grid grid-cols-2 gap-3">
        {scalars.map((q) => (
          <BusinessKpiTile key={q.id} q={q} />
        ))}
      </div>
    </PanelCard>
  )
}

function BusinessKpiTile({
  q,
}: {
  q: { name: string; scalar?: number; scalar_unit?: string; scalar_delta?: number }
}) {
  const delta = q.scalar_delta ?? 0
  const formatted = formatScalar(q.scalar ?? 0, q.scalar_unit)
  return (
    <div className="rounded-lg border border-edge-subtle bg-linear-to-br from-brand-50/40 dark:from-brand-500/10 to-surface-raised p-3 ring-1 ring-inset ring-edge-subtle">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {q.name}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums text-content">{formatted}</span>
        {q.scalar_delta != null ? (
          <span
            className={`font-mono text-[10px] tabular-nums ${
              delta >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'
            }`}
          >
            {delta >= 0 ? '+' : ''}
            {(delta * 100).toFixed(1)}%
          </span>
        ) : null}
      </div>
    </div>
  )
}

/* ───── Decide · BI dashboards roll-up ───── */

export function BiDashboardsPanel() {
  const q = useBiDashboards()
  const list = q.data ?? []
  return (
    <PanelCard>
      <PanelHead title="BI dashboards" subtitle="Metabase" to="/decide?dashboards" />
      <ul className="space-y-1.5">
        {list.slice(0, 5).map((d) => (
          <li
            key={d.id}
            className="flex items-center justify-between rounded-md border border-edge-subtle bg-surface-sunken/40 px-2 py-1.5 text-[11px]"
          >
            <span className="truncate font-medium text-content">{d.name}</span>
            <span className="ml-2 shrink-0 font-mono text-[10px] text-content-subtle">
              {d.cards ? `${d.cards.length} cards · ` : ''}
              {d.view_count ?? 0} views
            </span>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

/* ───── Cost trend · 30-day spend ───── */

export function CostTrendPanel() {
  const q = useCostTrend()
  const data = q.data
  const series = data?.series ?? []

  if (q.isLoading || q.isError || series.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Cloud spend · 30 days" subtitle="All providers · USD" to="/settings?section=allocation" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelEmpty message="Requires an OpenCost metrics source" />
        ) : (
          <PanelEmpty message="No spend data available" />
        )}
      </PanelCard>
    )
  }

  const total = data!.total
  const half = Math.floor(series.length / 2)
  const previousTotal = series.slice(0, half).reduce((s, v) => s + v, 0)
  const recentTotal = series.slice(half).reduce((s, v) => s + v, 0)
  const delta = previousTotal === 0 ? 0 : (recentTotal - previousTotal) / previousTotal
  const peak = Math.max(...series)
  const peakIdx = series.indexOf(peak)
  const peakDate = relDay(series.length - 1 - peakIdx)
  const categoryTotal = data!.compute + data!.storage + data!.network || 1
  const share = (v: number) => Math.round((v / categoryTotal) * 100)
  return (
    <PanelCard>
      <PanelHead title="Cloud spend · 30 days" subtitle="All providers · USD" to="/settings?section=allocation" />
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
            ${(total / 1000).toFixed(1)}k
          </div>
          <div className={cn('mt-0.5 text-[11px] font-medium', delta > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300')}>
            {delta > 0 ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(1)}% vs prior 15d
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Peak</div>
          <div className="font-mono text-[12px] tabular-nums text-content">${peak.toFixed(0)}</div>
          <div className="text-[10px] text-content-subtle">{peakDate}</div>
        </div>
      </div>
      <div className="mt-3">
        <AreaChart
          points={series}
          color="var(--color-brand-500)"
          height={120}
          showAxis={false}
          formatY={(v) => `$${Math.round(v)}`}
          emptyLabel="No spend data"
        />
        <div className="mt-1 flex items-baseline justify-between text-[10px] text-content-subtle">
          <span>{relDay(series.length - 1)}</span>
          <span>today</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 border-t border-edge-subtle pt-3 text-[11px]">
        <CostBreak label="Compute" value={Math.round(data!.compute)} share={share(data!.compute)} />
        <CostBreak label="Storage" value={Math.round(data!.storage)} share={share(data!.storage)} />
        <CostBreak label="Network" value={Math.round(data!.network)} share={share(data!.network)} />
      </div>
    </PanelCard>
  )
}

function CostBreak({ label, value, share }: { label: string; value: number; share: number }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className="font-mono text-[12px] tabular-nums text-content">${value.toLocaleString()}</div>
      <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full bg-brand-500"
          style={{ width: `${share}%` }}
        />
      </div>
    </div>
  )
}

function relDay(daysAgo: number): string {
  if (daysAgo === 0) return 'today'
  if (daysAgo === 1) return 'yesterday'
  return `${daysAgo}d ago`
}

/* ───── Deploy heatmap · 12-week deploy frequency ───── */

export function DeployHeatmapPanel() {
  const q = useDoraApps()
  const WEEKS = 12
  const DAYS = WEEKS * 7

  const { cells, total, peak, active } = useMemo(() => {
    const apps = q.data ?? []
    const counts = new Array<number>(DAYS).fill(0)
    const now = Date.now()
    for (const a of apps) {
      for (const h of a.status?.history ?? []) {
        if (!h.deployedAt) continue
        const t = new Date(h.deployedAt).getTime()
        if (!Number.isFinite(t)) continue
        const daysAgo = Math.floor((now - t) / 86_400_000)
        if (daysAgo < 0 || daysAgo >= DAYS) continue
        counts[DAYS - 1 - daysAgo] += 1
      }
    }
    const peak = Math.max(0, ...counts)
    const cells = counts.map((c) => (peak > 0 ? c / peak : 0))
    return {
      cells,
      total: counts.reduce((s, c) => s + c, 0),
      peak,
      active: counts.filter((c) => c > 0).length,
    }
  }, [q.data, DAYS])

  const dayLabels = ['Mon', 'Wed', 'Fri']

  if (q.isLoading || q.isError || total === 0) {
    return (
      <PanelCard>
        <PanelHead title="Deploys · last 12 weeks" subtitle="GitOps releases per day" to="/deliver?section=releases" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelEmpty message="Requires Argo CD deploy history" />
        ) : (
          <PanelEmpty message="No deploy history in the last 12 weeks" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="Deploys · last 12 weeks" subtitle="GitOps releases per day" to="/deliver?section=releases" />
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
            {total}
          </div>
          <div className="text-[11px] text-content-muted">
            {active}/{DAYS} active days · peak {peak}/day
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-content-subtle">
          <span>less</span>
          {[0, 0.3, 0.6, 0.85, 1].map((v, i) => (
            <span
              key={i}
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{
                backgroundColor: 'var(--color-brand-500)',
                opacity: v === 0 ? 0.08 : 0.15 + v * 0.85,
              }}
            />
          ))}
          <span>more</span>
        </div>
      </div>
      <div className="mt-3 flex items-start gap-2">
        <div className="flex flex-col justify-between py-0.5 text-[9px] font-mono text-content-subtle" style={{ height: 7 * 13 - 2 }}>
          {dayLabels.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <HeatMap cells={cells} weeks={12} cellSize={11} gap={2} color="var(--color-brand-500)" />
      </div>
    </PanelCard>
  )
}

/* ───── Service topology · mini graph ───── */

export function ServiceTopologyPanel() {
  const svc = useServices()
  const eps = useEndpoints()

  const HEALTH_COLOR: Record<TopologyNode['health'], string> = {
    healthy: 'var(--color-brand-500)',
    degraded: '#f59e0b',
    failed: '#f43f5e',
  }

  // Real service → health from its Endpoints (ready vs not-ready addresses).
  // We deliberately draw no edges: a real service-to-service call graph needs a
  // mesh (Cilium Hubble), and we never fabricate connections.
  const nodes = useMemo<TopologyNode[]>(() => {
    const services = (svc.data ?? []) as Array<{ metadata: { name: string; namespace?: string } }>
    const endpoints = (eps.data ?? []) as Array<
      Generic & {
        subsets?: Array<{ addresses?: unknown[]; notReadyAddresses?: unknown[] }>
      }
    >
    const epByKey = new Map<string, { ready: number; notReady: number }>()
    for (const e of endpoints) {
      const ready = (e.subsets ?? []).reduce((s, ss) => s + (ss.addresses?.length ?? 0), 0)
      const notReady = (e.subsets ?? []).reduce((s, ss) => s + (ss.notReadyAddresses?.length ?? 0), 0)
      epByKey.set(`${e.metadata.namespace ?? ''}/${e.metadata.name}`, { ready, notReady })
    }
    const list = services.slice(0, 8)
    const cx = 240
    const cy = 90
    const rx = list.length > 1 ? 190 : 0
    const ry = list.length > 1 ? 66 : 0
    return list.map((s, i) => {
      const ep = epByKey.get(`${s.metadata.namespace ?? ''}/${s.metadata.name}`)
      const health: TopologyNode['health'] = !ep
        ? 'healthy'
        : ep.ready === 0
          ? 'failed'
          : ep.notReady > 0
            ? 'degraded'
            : 'healthy'
      const angle = (-Math.PI / 2) + (i * (Math.PI * 2)) / Math.max(1, list.length)
      return {
        id: `${s.metadata.namespace ?? ''}/${s.metadata.name}`,
        label: s.metadata.name,
        x: list.length === 1 ? cx : cx + Math.cos(angle) * rx,
        y: list.length === 1 ? cy : cy + Math.sin(angle) * ry,
        health,
      }
    })
  }, [svc.data, eps.data])

  const loading = svc.isLoading || eps.isLoading
  return (
    <PanelCard>
      <PanelHead
        title="Service topology"
        subtitle={`${nodes.length} services · live health`}
        to="/discover?section=servicemap"
      />
      {loading ? (
        <PanelLoading />
      ) : svc.isError ? (
        <PanelError message="Could not reach the cluster" />
      ) : nodes.length === 0 ? (
        <PanelEmpty message="No Services found in the cluster" />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-edge-subtle bg-surface-sunken/40 p-2">
            <svg viewBox="0 0 480 180" preserveAspectRatio="xMidYMid meet" className="h-full w-full">
              <defs>
                <pattern id="topo-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                  <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(15,23,42,0.05)" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#topo-grid)" />
              {nodes.map((n) => (
                <g key={n.id}>
                  <circle cx={n.x} cy={n.y} r="14" fill={HEALTH_COLOR[n.health]} fillOpacity="0.18" />
                  <circle cx={n.x} cy={n.y} r="7" fill={HEALTH_COLOR[n.health]} stroke="white" strokeWidth="2" />
                  <text
                    x={n.x}
                    y={n.y + 26}
                    textAnchor="middle"
                    fontFamily="ui-monospace, monospace"
                    fontSize="10"
                    fontWeight="600"
                    fill="rgb(15 23 42)"
                  >
                    {n.label}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px]">
            <Legend dot="bg-brand-500" label={`${nodes.filter((n) => n.health === 'healthy').length} healthy`} />
            <Legend dot="bg-amber-500" label={`${nodes.filter((n) => n.health === 'degraded').length} degraded`} />
            <Legend dot="bg-rose-500" label={`${nodes.filter((n) => n.health === 'failed').length} failed`} />
          </div>
        </>
      )}
    </PanelCard>
  )
}

interface TopologyNode {
  id: string
  label: string
  x: number
  y: number
  health: 'healthy' | 'degraded' | 'failed'
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-content-muted">
      <span className={cn('h-2 w-2 rounded-full', dot)} />
      {label}
    </span>
  )
}

/* ───── Region spread · pods per region ───── */

export function RegionSpreadPanel() {
  const nodesQ = useNodes()
  const podsQ = useAllPods()

  const regions = useMemo(() => {
    const nodes = (nodesQ.data ?? []) as Array<{
      metadata: { name: string; labels?: Record<string, string> }
      spec?: { providerID?: string }
    }>
    const pods = (podsQ.data ?? []) as Array<{ spec?: { nodeName?: string } }>
    // node name → { region, cloud }
    const nodeInfo = new Map<string, { region: string; cloud: string }>()
    for (const n of nodes) {
      const region =
        n.metadata.labels?.['topology.kubernetes.io/region'] ??
        n.metadata.labels?.['failure-domain.beta.kubernetes.io/region'] ??
        'unknown'
      nodeInfo.set(n.metadata.name, { region, cloud: cloudOf(n.spec?.providerID) })
    }
    const byRegion = new Map<string, { name: string; cloud: string; pods: number; nodes: number }>()
    for (const info of nodeInfo.values()) {
      const cur = byRegion.get(info.region) ?? { name: info.region, cloud: info.cloud, pods: 0, nodes: 0 }
      cur.nodes += 1
      byRegion.set(info.region, cur)
    }
    for (const p of pods) {
      const node = p.spec?.nodeName
      if (!node) continue
      const info = nodeInfo.get(node)
      if (!info) continue
      const cur = byRegion.get(info.region)
      if (cur) cur.pods += 1
    }
    const list = Array.from(byRegion.values()).sort((a, b) => b.pods - a.pods)
    const total = list.reduce((s, r) => s + r.pods, 0) || 1
    return list.map((r) => ({
      name: r.name,
      label: `${r.nodes} node${r.nodes === 1 ? '' : 's'}`,
      cloud: r.cloud,
      pods: r.pods,
      percent: Math.round((r.pods / total) * 100),
    }))
  }, [nodesQ.data, podsQ.data])

  const total = regions.reduce((s, r) => s + r.pods, 0)
  const loading = nodesQ.isLoading || podsQ.isLoading
  if (loading || nodesQ.isError || regions.length === 0) {
    return (
      <PanelCard>
        <PanelHead
          title="Geographic spread"
          subtitle="Pods by node region · this cluster"
          to="/platform?section=clusters"
        />
        {loading ? (
          <PanelLoading />
        ) : nodesQ.isError ? (
          <PanelError message="Could not reach the cluster" />
        ) : (
          <PanelEmpty message="No nodes found" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="Geographic spread" subtitle="Pods by node region · this cluster" to="/platform?section=clusters" />
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
            {total}
          </div>
          <div className="text-[11px] text-content-muted">
            pods · {regions.length} region{regions.length === 1 ? '' : 's'} · {new Set(regions.map((r) => r.cloud)).size} cloud{new Set(regions.map((r) => r.cloud)).size === 1 ? '' : 's'}
          </div>
        </div>
        {new Set(regions.map((r) => r.cloud)).size > 1 ? (
          <span className="rounded-md bg-brand-50 dark:bg-brand-500/10 px-2 py-0.5 text-[10px] font-medium text-brand-700 dark:text-brand-300">
            multi-cloud
          </span>
        ) : null}
      </div>
      <ul className="mt-3 space-y-2">
        {regions.map((r) => (
          <li key={r.name}>
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <div className="flex items-center gap-2 truncate">
                <RegionDot cloud={r.cloud} />
                <span className="font-mono text-content">{r.name}</span>
                <span className="hidden truncate text-content-subtle sm:inline">· {r.label}</span>
              </div>
              <div className="flex items-baseline gap-1.5 font-mono">
                <span className="tabular-nums text-content">{r.pods}</span>
                <span className="text-content-subtle">{r.percent}%</span>
              </div>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${r.percent}%`,
                  background:
                    r.cloud === 'GCP'
                      ? 'linear-gradient(90deg, #4285F4, #34A853)'
                      : r.cloud === 'On-prem'
                        ? 'linear-gradient(90deg, var(--color-content-muted), var(--color-content-subtle))'
                        : 'linear-gradient(90deg, var(--color-brand-500), var(--color-brand-400))',
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

function RegionDot({ cloud }: { cloud: string }) {
  const cls =
    cloud === 'AWS'
      ? 'bg-amber-500'
      : cloud === 'GCP'
        ? 'bg-sky-500'
        : cloud === 'On-prem'
          ? 'bg-slate-400'
          : 'bg-brand-500'
  return <span className={cn('h-2 w-2 shrink-0 rounded-full', cls)} title={cloud} />
}

/** Map a node `spec.providerID` to a cloud label. */
function cloudOf(providerID?: string): string {
  if (!providerID) return 'On-prem'
  if (providerID.startsWith('aws:')) return 'AWS'
  if (providerID.startsWith('gce:')) return 'GCP'
  if (providerID.startsWith('azure:')) return 'Azure'
  return 'On-prem'
}

/* ───── DORA radar · 4-axis maturity vs elite benchmark ───── */

export function DoraRadarPanel() {
  const q = useDoraApps()
  const flow = useDoraLeadTime(q.data)
  const ops = useDoraOps()

  // All four axes come from the same sources as the DORA tiles on this page,
  // deliberately: the radar used to read lead time from PR cycle time and
  // change-fail rate from a point-in-time sync snapshot, so the two panels
  // sitting side by side could disagree about the same week.
  const { metrics, tier, avgAvailable } = useMemo(() => {
    const apps = q.data ?? []
    const now = Date.now()
    const windowDays = 30
    const windowMs = windowDays * 24 * 3600_000
    let deploys = 0
    const events: DeployEvent[] = []
    for (const a of apps) {
      const namespace = a.spec?.destination?.namespace || null
      const workloads = appWorkloads(a)
      for (const h of a.status?.history ?? []) {
        if (!h.deployedAt) continue
        const t = new Date(h.deployedAt).getTime()
        if (!Number.isFinite(t) || now - t >= windowMs) continue
        deploys += 1
        events.push({ namespace, atMs: t, workloads })
      }
    }
    const perDay = deploys / windowDays
    const cf = changeFailureRate(events, ops.incidents)
    const cfr = cf.rate
    const mttr = mttrSummary(ops.incidents)

    const list: Array<{ label: string; value: number; raw: string; target: number; available: boolean }> = [
      {
        label: 'Deploy freq.',
        value: Math.max(0, Math.min(1, perDay / 1)),
        raw: perDay >= 1 ? `${perDay.toFixed(1)} / day` : `${(perDay * 7).toFixed(1)} / wk`,
        target: 1,
        available: true,
      },
      flow.medianHours != null
        ? {
            label: 'Lead time',
            value: leadTimeScore(flow.medianHours),
            raw: formatDuration(flow.medianHours),
            target: 1,
            available: true,
          }
        : {
            label: 'Lead time',
            value: 0,
            raw: flow.isLoading ? '…' : 'no resolvable commits',
            target: 1,
            available: false,
          },
      {
        label: 'Change-fail rate',
        value: cfr == null ? 0 : Math.max(0, Math.min(1, 1 - cfr / 0.3)),
        raw: cfr == null ? 'no measurable deploys' : `${(cfr * 100).toFixed(1)}%`,
        target: 1,
        available: cfr != null,
      },
      mttr.medianHours != null
        ? {
            label: 'MTTR',
            // Elite restores service in under an hour; the score falls off
            // from there and bottoms out at a day.
            value: Math.max(0, Math.min(1, 1 - (mttr.medianHours - 1) / 23)),
            raw: formatDuration(mttr.medianHours),
            target: 1,
            available: true,
          }
        : {
            label: 'MTTR',
            value: 0,
            raw: ops.isLoading ? '…' : ops.isError ? 'Prometheus unreachable' : 'no recoveries yet',
            target: 1,
            available: false,
          },
    ]
    const avail = list.filter((m) => m.available)
    const avgAvailable = avail.length ? avail.reduce((s, m) => s + m.value, 0) / avail.length : 0
    const tier: 'Elite' | 'High' | 'Medium' =
      avgAvailable >= 0.85 ? 'Elite' : avgAvailable >= 0.6 ? 'High' : 'Medium'
    return { metrics: list, tier, avgAvailable }
  }, [q.data, flow.medianHours, flow.isLoading, ops.incidents, ops.isLoading, ops.isError])

  if (q.isLoading || q.isError) {
    return (
      <PanelCard>
        <PanelHead title="DORA · maturity radar" subtitle="vs elite benchmark · trailing 30d" to="/decide?section=dora" />
        {q.isLoading ? <PanelLoading /> : <PanelError message="ArgoCD unavailable" />}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="DORA · maturity radar" subtitle="vs elite benchmark · trailing 30d" to="/decide?section=dora" />
      <div className="grid grid-cols-[auto_1fr] items-center gap-4">
        <Radar metrics={metrics} />
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset',
                tier === 'Elite' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-200' : tier === 'High' ? 'bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-200' : 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-200',
              )}
            >
              {tier}
            </span>
            <span className="text-[11px] text-content-muted">
              avg {(avgAvailable * 100).toFixed(0)}% of elite
            </span>
          </div>
          {metrics.map((m) => (
            <div key={m.label}>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className={m.available ? 'text-content' : 'text-content-subtle'}>{m.label}</span>
                <span className="font-mono tabular-nums text-content-muted">{m.raw}</span>
              </div>
              {m.available ? (
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full bg-linear-to-r from-brand-500 to-brand-400"
                    style={{ width: `${Math.min(100, m.value * 100)}%` }}
                  />
                </div>
              ) : (
                <div className="mt-0.5 h-1 w-full rounded-full bg-surface-sunken" />
              )}
            </div>
          ))}
        </div>
      </div>
    </PanelCard>
  )
}

interface RadarMetric { label: string; value: number; target: number }

function Radar({ metrics }: { metrics: RadarMetric[] }) {
  const SIZE = 160
  const cx = SIZE / 2
  const cy = SIZE / 2
  const radius = SIZE / 2 - 18
  // Each axis at 90° spacing for a 4-metric radar.
  const angle = (i: number) => (-Math.PI / 2) + (i * (Math.PI * 2)) / metrics.length
  const point = (v: number, i: number) => ({
    x: cx + Math.cos(angle(i)) * radius * v,
    y: cy + Math.sin(angle(i)) * radius * v,
  })
  const valuePath = metrics.map((m, i) => point(m.value, i)).map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z'
  const targetPath = metrics.map((_, i) => point(1, i)).map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z'
  const labels = metrics.map((m, i) => {
    const p = point(1.18, i)
    return { ...p, label: m.label }
  })
  const rings = [0.25, 0.5, 0.75, 1]
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0">
      {/* Concentric rings */}
      {rings.map((r) => (
        <circle key={r} cx={cx} cy={cy} r={radius * r} fill="none" stroke="rgba(15,23,42,0.07)" />
      ))}
      {/* Axes */}
      {metrics.map((_, i) => {
        const p = point(1, i)
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="rgba(15,23,42,0.08)" />
      })}
      {/* Target / elite fill */}
      <path d={targetPath} fill="rgba(125,211,252,0.06)" stroke="rgba(125,211,252,0.4)" strokeDasharray="3 3" />
      {/* Value polygon */}
      <path d={valuePath} fill="rgba(99,102,241,0.22)" stroke="rgb(99,102,241)" strokeWidth="1.5" strokeLinejoin="round" />
      {/* Vertices */}
      {metrics.map((m, i) => {
        const p = point(m.value, i)
        return <circle key={i} cx={p.x} cy={p.y} r="3" fill="rgb(99,102,241)" />
      })}
      {/* Labels around the perimeter */}
      {labels.map((l, i) => (
        <text
          key={i}
          x={l.x}
          y={l.y}
          textAnchor={l.x > cx + 2 ? 'start' : l.x < cx - 2 ? 'end' : 'middle'}
          dominantBaseline={l.y < cy - 2 ? 'auto' : l.y > cy + 2 ? 'hanging' : 'middle'}
          fontFamily="ui-sans-serif, system-ui"
          fontSize="9"
          fontWeight="600"
          fill="rgb(71 85 105)"
        >
          {l.label}
        </text>
      ))}
    </svg>
  )
}

/* ───── Storage treemap · namespace distribution ───── */

const TREEMAP_PALETTE = [
  'oklch(0.62 0.18 262)',
  'oklch(0.66 0.14 230)',
  'oklch(0.7 0.13 200)',
  'oklch(0.74 0.11 170)',
  'oklch(0.74 0.13 30)',
  'oklch(0.72 0.14 350)',
  'oklch(0.68 0.15 90)',
  'oklch(0.7 0.02 260)',
]

export function StorageTreemapPanel() {
  const q = usePvcs()

  const items = useMemo(() => {
    const pvcs = (q.data ?? []) as Array<
      Generic & {
        spec?: { resources?: { requests?: { storage?: string } } }
        status?: { capacity?: { storage?: string } }
      }
    >
    const byNs = new Map<string, number>()
    for (const p of pvcs) {
      const bytes = parseBytes(
        p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage,
      )
      const ns = p.metadata.namespace ?? 'default'
      byNs.set(ns, (byNs.get(ns) ?? 0) + bytes)
    }
    const sorted = Array.from(byNs.entries())
      .map(([label, bytes]) => ({ label, value: Math.round(bytes / 1024 ** 3) }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value)
    const top = sorted.slice(0, 7)
    const restVal = sorted.slice(7).reduce((s, x) => s + x.value, 0)
    if (restVal > 0) top.push({ label: 'other', value: restVal })
    return top.map((x, i) => ({ ...x, color: TREEMAP_PALETTE[i % TREEMAP_PALETTE.length] }))
  }, [q.data])

  const total = items.reduce((s, i) => s + i.value, 0)
  const W = 320
  const H = 180
  const rects = squarify(items, 0, 0, W, H)
  if (q.isLoading || q.isError || items.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Storage · by namespace" subtitle="Requested PVC capacity · GiB" to="/platform?section=storage" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelError message="Could not reach the cluster" />
        ) : (
          <PanelEmpty message="No PersistentVolumeClaims found" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="Storage · by namespace" subtitle="Requested PVC capacity · GiB" to="/platform?section=storage" />
      <div className="flex items-baseline justify-between">
        <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
          {total >= 1024 ? `${(total / 1024).toFixed(1)} TiB` : `${total.toFixed(0)} GiB`}
        </div>
        <span className="font-mono text-[10px] text-content-subtle">{items.length} namespaces</span>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-edge-subtle">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-auto w-full">
          {rects.map((r, i) => {
            const item = items[i]
            const big = r.w * r.h > 2200
            return (
              <g key={item.label}>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={item.color} stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" />
                {big ? (
                  <>
                    <text
                      x={r.x + 8}
                      y={r.y + 16}
                      fontFamily="ui-sans-serif, system-ui"
                      fontSize="11"
                      fontWeight="700"
                      fill="white"
                    >
                      {item.label}
                    </text>
                    <text
                      x={r.x + 8}
                      y={r.y + 28}
                      fontFamily="ui-monospace, monospace"
                      fontSize="9"
                      fill="rgba(255,255,255,0.85)"
                    >
                      {item.value} GiB · {Math.round((item.value / total) * 100)}%
                    </text>
                  </>
                ) : null}
              </g>
            )
          })}
        </svg>
      </div>
    </PanelCard>
  )
}

interface TreeRect { x: number; y: number; w: number; h: number }

/**
 * Squarified treemap — places `items` into rectangles whose areas are
 * proportional to value, preferring near-square aspect ratios. A simple
 * row-based packer; good enough for a 6–10-item glance view.
 */
function squarify(
  items: { label: string; value: number }[],
  x: number,
  y: number,
  w: number,
  h: number,
): TreeRect[] {
  const total = items.reduce((s, i) => s + i.value, 0)
  if (total <= 0) return items.map(() => ({ x, y, w: 0, h: 0 }))
  const out: TreeRect[] = new Array(items.length)
  const order = items.map((_, i) => i).sort((a, b) => items[b].value - items[a].value)
  let remaining = order
  let curX = x
  let curY = y
  let curW = w
  let curH = h
  let curTotal = total
  while (remaining.length) {
    const horizontal = curW >= curH
    const slabSize = Math.min(remaining.length, 3)
    const slab = remaining.slice(0, slabSize)
    const slabValue = slab.reduce((s, idx) => s + items[idx].value, 0)
    const frac = slabValue / curTotal
    if (horizontal) {
      const slabW = curW * frac
      let oy = curY
      for (const idx of slab) {
        const f = items[idx].value / slabValue
        const slabH = curH * f
        out[idx] = { x: curX, y: oy, w: slabW, h: slabH }
        oy += slabH
      }
      curX += slabW
      curW -= slabW
    } else {
      const slabH = curH * frac
      let ox = curX
      for (const idx of slab) {
        const f = items[idx].value / slabValue
        const slabW = curW * f
        out[idx] = { x: ox, y: curY, w: slabW, h: slabH }
        ox += slabW
      }
      curY += slabH
      curH -= slabH
    }
    curTotal -= slabValue
    remaining = remaining.slice(slabSize)
  }
  return out
}

/* ───── Budget bullet · target vs actual per cost center ───── */

export function BudgetBulletPanel() {
  const q = useBudget()

  const { items, subtitle } = useMemo(() => {
    const data = q.data
    if (!data) return { items: [] as BulletItem[], subtitle: '' }
    const budgetConfigured = data.budget != null
    const items: BulletItem[] = data.namespaces.slice(0, 4).map((n) => ({
      label: n.namespace,
      code: `${Math.round(n.share * 100)}%`,
      actual: n.actual,
      // Target: proportional slice of the configured budget (real share), or
      // last-month spend as the baseline when no budget is configured.
      target: budgetConfigured ? Math.max(1, data.budget! * n.share) : Math.max(1, n.prior),
      prior: n.prior,
    }))
    const subtitle = budgetConfigured
      ? 'Namespace spend vs budget · USD'
      : 'Namespace spend vs last month · USD (budget not configured)'
    return { items, subtitle }
  }, [q.data])

  if (q.isLoading || q.isError || items.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Budget · MTD vs target" subtitle="Cost center performance · USD" to="/settings?section=budgets" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelEmpty message="Requires an OpenCost metrics source" />
        ) : (
          <PanelEmpty message="No cost allocation data available" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="Budget · MTD vs target" subtitle={subtitle} to="/settings?section=budgets" />
      <div className="space-y-3">
        {items.map((it) => (
          <Bullet key={it.label} item={it} />
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3 border-t border-edge-subtle pt-2 text-[10px] text-content-muted">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-brand-500" /> actual
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2.5 w-0.5 bg-content" /> prior month
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-3 rounded bg-edge-strong" /> safe
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-3 rounded bg-amber-200" /> warn
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-3 rounded bg-rose-200" /> over
        </span>
      </div>
    </PanelCard>
  )
}

interface BulletItem { label: string; code: string; actual: number; target: number; prior: number }

function Bullet({ item }: { item: BulletItem }) {
  const max = item.target * 1.15 // headroom past target so "over" is visible
  const actualPct = (item.actual / max) * 100
  const priorPct = (item.prior / max) * 100
  const safe = (item.target * 0.7) / max * 100
  const warn = (item.target * 0.9) / max * 100
  const target = (item.target / max) * 100
  const ratio = item.actual / item.target
  const tone =
    ratio > 1 ? 'text-rose-700 dark:text-rose-300' : ratio > 0.9 ? 'text-amber-700 dark:text-amber-300' : 'text-content-muted'
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-medium text-content">
          {item.label}
          <span className="ml-1.5 font-mono text-[10px] text-content-subtle">{item.code}</span>
        </span>
        <span className={cn('font-mono tabular-nums', tone)}>
          ${(item.actual / 1000).toFixed(1)}k
          <span className="text-content-subtle"> / ${(item.target / 1000).toFixed(1)}k</span>
          <span className={cn('ml-1.5 font-semibold', tone)}>{Math.round(ratio * 100)}%</span>
        </span>
      </div>
      <div className="relative mt-1 h-2.5 overflow-hidden rounded-full bg-rose-100 dark:bg-rose-500/15">
        {/* warn band */}
        <div className="absolute inset-y-0 left-0 bg-amber-100 dark:bg-amber-500/15" style={{ width: `${warn}%` }} />
        {/* safe band */}
        <div className="absolute inset-y-0 left-0 bg-edge-strong/40" style={{ width: `${safe}%` }} />
        {/* actual */}
        <div
          className="absolute inset-y-[3px] left-0 rounded-full bg-linear-to-r from-brand-500 to-brand-400 transition-[width] duration-500"
          style={{ width: `${Math.min(99, actualPct)}%`, height: '6px', top: '5px' }}
        />
        {/* prior-month tick */}
        <span
          aria-hidden
          className="absolute inset-y-0 w-0.5 bg-content"
          style={{ left: `${priorPct}%` }}
          title={`Prior: $${item.prior.toLocaleString()}`}
        />
        {/* target marker */}
        <span
          aria-hidden
          className="absolute -inset-y-0.5 w-[3px] rounded-full bg-content shadow-sm"
          style={{ left: `${target}%` }}
        />
      </div>
    </div>
  )
}

/* ─────────── shared atoms ─────────── */

export function PanelCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-edge-default bg-surface-raised p-5 shadow-sm transition-shadow hover:shadow">
      {children}
    </div>
  )
}

export function PanelHead({
  title,
  subtitle,
  to,
}: {
  title: string
  subtitle?: string
  to: string
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-content">{title}</div>
        {subtitle ? <div className="mt-0.5 truncate text-[11px] text-content-subtle">{subtitle}</div> : null}
      </div>
      {/* Arrow-only "open" affordance. It sits in the SAME row as the drag
          handle that draggable-grid renders at the card's top-right (`right-5
          top-5`, 24px wide) — the right margin reserves that slot plus a small
          gap so the two read as one aligned control group. */}
      <Link
        to={to}
        aria-label={`Open ${title}`}
        title={`Open ${title}`}
        data-no-drag
        className="mr-8 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-content-subtle transition-colors hover:bg-surface-sunken hover:text-brand-700 dark:hover:text-brand-300"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 12h14" />
          <path d="m13 6 6 6-6 6" />
        </svg>
      </Link>
    </div>
  )
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone: 'emerald' | 'amber' | 'rose' | 'slate' | 'brand' | 'violet'
}) {
  const toneText = {
    emerald: 'text-emerald-700 dark:text-emerald-300',
    amber: 'text-amber-700 dark:text-amber-300',
    rose: 'text-rose-700 dark:text-rose-300',
    slate: 'text-content',
    brand: 'text-brand-700 dark:text-brand-300',
    violet: 'text-violet-700 dark:text-violet-300',
  }[tone]
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${toneText}`}>{value}</div>
    </div>
  )
}

function SevTile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'rose' | 'amber' | 'sky' | 'slate'
}) {
  const cls = {
    rose: 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300',
    amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300',
    sky: 'bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300',
    slate: 'bg-surface-sunken text-content-muted',
  }[tone]
  return (
    <div className={`rounded-md p-2 text-center ${cls}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  )
}

/* ─────────── shared panel state atoms (loading / error / empty) ─────────── */

function PanelMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-8 text-center text-[11px] leading-relaxed text-content-subtle">
      {children}
    </div>
  )
}

export function PanelLoading() {
  return (
    <div className="flex flex-1 items-center justify-center py-8 text-content-subtle">
      <Spinner />
    </div>
  )
}

export function PanelError({ message }: { message?: string }) {
  return (
    <PanelMessage>
      <span className="text-rose-700 dark:text-rose-300">{message ?? 'Failed to load'}</span>
    </PanelMessage>
  )
}

export function PanelEmpty({ message }: { message: string }) {
  return <PanelMessage>{message}</PanelMessage>
}

export function SignalTile({
  label,
  value,
  series,
  color,
}: {
  label: string
  value: string
  series: number[]
  color: string
}) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2.5">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
      <div className="mt-0.5 truncate text-base font-semibold tabular-nums text-content">{value}</div>
      {series.length > 1 ? (
        <div className="mt-1">
          <Sparkline points={series} color={color} height={24} strokeWidth={1.5} />
        </div>
      ) : null}
    </div>
  )
}

/* ─────────── helpers ─────────── */

interface MetricSeries {
  values: Array<[number, string]>
}

function lastValue(s: MetricSeries): number {
  const last = s.values[s.values.length - 1]
  return last ? Number(last[1]) : 0
}
function sumLastValues(arr: MetricSeries[]): number {
  return arr.reduce((acc, s) => acc + lastValue(s), 0)
}


function formatScalar(v: number, unit?: string): string {
  if (unit === 'USD') {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
    if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
    return `$${v.toFixed(0)}`
  }
  if (unit === '%') return `${(v * 100).toFixed(1)}%`
  if (unit === '×') return `${v.toFixed(2)}×`
  if (unit === 'min') return `${v.toFixed(0)} min`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return v.toFixed(0)
}

/* ───────────────────────────────────────────────────────────
 * Platform Health Score — large radial gauge with sub-scores
 * ─────────────────────────────────────────────────────────── */

export function PlatformHealthPanel() {
  // Real, currently-reachable cluster signals — nodes / pods / Argo CD apps /
  // Kyverno policy reports — via the same authenticated /api/k8s gateway the
  // rest of the Overview uses. Prometheus (golden signals) drives Performance.
  const cluster = useClusterSignals()
  const s = summarizeCluster(cluster)
  const { errors } = useGoldenSignals()
  const nodesQ = useNodes()
  const nodeMetricsQ = useNodeMetrics()

  // Sub-scores 0–100, each from a real signal — or null (shown as "—") when the
  // source is genuinely absent (CRD not installed / no data). Never a fabricated
  // fallback number.

  // Reliability = ready-node ratio + running-pod ratio (whichever are present).
  const reliability = useMemo<number | null>(() => {
    const parts: number[] = []
    if (s.nodes.total > 0) parts.push((s.nodes.ready / s.nodes.total) * 100)
    if (s.pods.total > 0) parts.push((s.pods.running / s.pods.total) * 100)
    if (parts.length === 0) return null
    return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length)
  }, [s.nodes.total, s.nodes.ready, s.pods.total, s.pods.running])

  // Delivery = Argo CD apps Synced + Healthy ratio. Null when Argo CD is not
  // installed or reports no applications.
  const delivery = useMemo<number | null>(() => {
    if (!s.argo.installed || s.argo.total === 0) return null
    const okShare = (s.argo.synced + s.argo.healthy) / (s.argo.total * 2)
    return Math.round(okShare * 100)
  }, [s.argo.installed, s.argo.total, s.argo.synced, s.argo.healthy])

  // Security = Kyverno policy pass ratio. Null when Kyverno / policy reports are
  // not installed or nothing has been evaluated yet.
  const security = useMemo<number | null>(() => {
    if (!s.policy.installed) return null
    const evaluated = s.policy.pass + s.policy.fail + s.policy.warn
    if (evaluated === 0) return null
    return Math.round((s.policy.pass / evaluated) * 100)
  }, [s.policy.installed, s.policy.pass, s.policy.fail, s.policy.warn])

  // Performance — prefer the mesh 5xx share (Hubble golden signals) when it's
  // wired; otherwise fall back to live cluster resource headroom from
  // metrics-server (100 − the busier of CPU / memory saturation), which is a
  // real, always-reachable performance/capacity signal. Only "—" when neither
  // source is present.
  const performance = useMemo<number | null>(() => {
    // Mesh-wide 5xx share (Hubble), in percent: each point of 5xx costs ten
    // points of score, so 1% → 90 and 10% or worse → 0.
    const errPct = Number(errors.data?.[0]?.values.at(-1)?.[1])
    if (Number.isFinite(errPct)) {
      return Math.min(100, Math.max(0, Math.round(100 - errPct * 10)))
    }
    const nodes = (nodesQ.data ?? []) as Array<{
      status?: { allocatable?: Record<string, string> }
    }>
    const metrics = (nodeMetricsQ.data ?? []) as Array<{
      usage?: { cpu?: string; memory?: string }
    }>
    if (nodes.length === 0 || metrics.length === 0) return null
    const cpuTotal = nodes.reduce((a, n) => a + parseCpu(n.status?.allocatable?.cpu), 0)
    const memTotal = nodes.reduce((a, n) => a + parseBytes(n.status?.allocatable?.memory), 0)
    const cpuUsed = metrics.reduce((a, m) => a + parseCpu(m.usage?.cpu), 0)
    const memUsed = metrics.reduce((a, m) => a + parseBytes(m.usage?.memory), 0)
    const util: number[] = []
    if (cpuTotal > 0) util.push(cpuUsed / cpuTotal)
    if (memTotal > 0) util.push(memUsed / memTotal)
    if (util.length === 0) return null
    const busiest = Math.max(...util)
    return Math.min(100, Math.max(0, Math.round((1 - busiest) * 100)))
  }, [errors.data, nodesQ.data, nodeMetricsQ.data])

  const available = [reliability, delivery, security, performance].filter(
    (v): v is number => v != null,
  )
  const overall = available.length
    ? Math.round(available.reduce((sum, v) => sum + v, 0) / available.length)
    : null
  const tone =
    overall == null
      ? 'slate'
      : overall >= 90
        ? 'emerald'
        : overall >= 75
          ? 'brand'
          : overall >= 60
            ? 'amber'
            : 'rose'

  return (
    <PanelCard>
      <PanelHead title="Platform health" subtitle="Reliability · delivery · security · perf" to="/decide" />
      <div className="grid flex-1 grid-cols-1 items-center gap-5 sm:grid-cols-[auto_1fr]">
        {/* Centred when the panel stacks on a phone; beside the sub-scores from sm up. */}
        <div className="justify-self-center sm:justify-self-start">
          <RadialScore value={overall} tone={tone} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SubScore label="Reliability" value={reliability} icon={<IconShield />} />
          <SubScore label="Delivery" value={delivery} icon={<IconRocket />} />
          <SubScore label="Security" value={security} icon={<IconLock />} />
          <SubScore label="Performance" value={performance} icon={<IconBolt />} />
        </div>
      </div>
    </PanelCard>
  )
}

function RadialScore({
  value,
  tone,
}: {
  value: number | null
  tone: 'emerald' | 'brand' | 'amber' | 'rose' | 'slate'
}) {
  const na = value == null
  const r = 64
  const stroke = 12
  const c = 2 * Math.PI * r
  const offset = c - (Math.max(0, Math.min(100, value ?? 0)) / 100) * c
  const ring = {
    emerald: 'stroke-emerald-500',
    brand: 'stroke-brand-500',
    amber: 'stroke-amber-500',
    rose: 'stroke-rose-500',
    slate: 'stroke-edge-default',
  }[tone]
  const text = {
    emerald: 'text-emerald-700 dark:text-emerald-300',
    brand: 'text-brand-700 dark:text-brand-300',
    amber: 'text-amber-700 dark:text-amber-300',
    rose: 'text-rose-700 dark:text-rose-300',
    slate: 'text-content-subtle',
  }[tone]
  return (
    <div className="relative flex h-40 w-40 items-center justify-center">
      <svg width="160" height="160" viewBox="0 0 160 160" className="-rotate-90">
        <circle
          cx="80"
          cy="80"
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-edge-default"
        />
        <circle
          cx="80"
          cy="80"
          r={r}
          fill="none"
          strokeLinecap="round"
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={offset}
          className={cn(ring, 'transition-[stroke-dashoffset]')}
          style={{ transitionDuration: '600ms' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className={cn('font-mono text-4xl font-semibold tabular-nums tracking-tight', text)}>
          {na ? '—' : value}
        </div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-content-subtle">
          {na ? 'no data' : '/ 100'}
        </div>
      </div>
    </div>
  )
}

function SubScore({
  label,
  value,
  icon,
}: {
  label: string
  /** null ⇒ no data for this signal — shown honestly as "—", never faked. */
  value: number | null
  icon: React.ReactNode
}) {
  const na = value == null
  const tone = na
    ? 'slate'
    : value >= 90
      ? 'emerald'
      : value >= 75
        ? 'brand'
        : value >= 60
          ? 'amber'
          : 'rose'
  const bar = {
    emerald: 'bg-emerald-500',
    brand: 'bg-brand-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
    slate: 'bg-transparent',
  }[tone]
  const swatch = {
    emerald: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-200/60',
    brand: 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 ring-brand-200/60',
    amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-200/60',
    rose: 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-200/60',
    slate: 'bg-surface-sunken text-content-subtle ring-edge-subtle',
  }[tone]
  return (
    <div className="min-w-0 rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className={cn('inline-flex h-5 w-5 flex-none items-center justify-center rounded-md ring-1', swatch)}>
            {icon}
          </span>
          <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-content-subtle" title={label}>
            {label}
          </span>
        </span>
        <span className="font-mono text-sm font-semibold tabular-nums text-content">
          {na ? '—' : value}
        </span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={cn('h-full rounded-full transition-[width]', bar)}
          style={{ width: `${na ? 0 : value}%`, transitionDuration: '500ms' }}
        />
      </div>
    </div>
  )
}


/* ───── velocity icons ───── */

function IconShield() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}


function IconLock() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

function IconBolt() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}


function IconRocket() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  )
}


/* ───────────────────────────────────────────────────────────
 * Resource Utilization — 3 radial gauges (CPU / Memory / Storage)
 * ─────────────────────────────────────────────────────────── */

export function ResourceUtilizationPanel() {
  const nodesQ = useNodes()
  const metricsQ = useNodeMetrics()
  const pvcsQ = usePvcs()
  const volQ = useVolumeUsage()

  const gauges = useMemo(() => {
    const nodes = (nodesQ.data ?? []) as Array<{
      status?: { allocatable?: Record<string, string>; capacity?: Record<string, string> }
    }>
    const nodeMetrics = (metricsQ.data ?? []) as Array<
      Generic & { usage?: { cpu?: string; memory?: string } }
    >
    const pvcs = (pvcsQ.data ?? []) as Array<
      Generic & {
        status?: { phase?: string; capacity?: { storage?: string } }
        spec?: { resources?: { requests?: { storage?: string } } }
      }
    >

    const out: Array<{
      key: string
      label: string
      value: number
      used: string
      total: string
      hint?: string
      icon: React.ReactNode
    }> = []

    const cpuTotal = nodes.reduce((s, n) => s + parseCpu(n.status?.allocatable?.cpu), 0)
    const memTotal = nodes.reduce((s, n) => s + parseBytes(n.status?.allocatable?.memory), 0)

    // CPU / Memory need metrics-server (metrics.k8s.io). When it's absent these
    // gauges are simply omitted — the Storage gauge below is metrics-server
    // independent, so the panel still populates on a live cluster.
    if (nodeMetrics.length > 0 && cpuTotal > 0) {
      const cpuUsed = nodeMetrics.reduce((s, m) => s + parseCpu(m.usage?.cpu), 0)
      out.push({
        key: 'cpu',
        label: 'CPU',
        value: pct(cpuUsed, cpuTotal),
        used: `${cpuUsed.toFixed(1)} cores`,
        total: `${cpuTotal.toFixed(0)} cores`,
        icon: <IconCpu />,
      })
    }
    if (nodeMetrics.length > 0 && memTotal > 0) {
      const memUsed = nodeMetrics.reduce((s, m) => s + parseBytes(m.usage?.memory), 0)
      out.push({
        key: 'mem',
        label: 'Memory',
        value: pct(memUsed, memTotal),
        used: `${(memUsed / 1024 ** 3).toFixed(0)} GiB`,
        total: `${(memTotal / 1024 ** 3).toFixed(0)} GiB`,
        icon: <IconMemory />,
      })
    }
    // Storage — bytes actually written vs volume capacity, from kubelet's
    // volume stats in Prometheus. Only volumes whose CSI driver reports usage
    // count, so the hint says how many; with none reporting, the gauge is
    // left out rather than comparing PVC sizes against node disk.
    const volUsed = volQ.data?.used?.[0]?.value ?? 0
    const volCap = volQ.data?.capacity?.[0]?.value ?? 0
    const reporting = volQ.data?.reporting?.[0]?.value ?? 0
    if (volCap > 0) {
      const bound = pvcs.filter((p) => p.status?.phase === 'Bound').length
      out.push({
        key: 'storage',
        label: 'Storage',
        value: pct(volUsed, volCap),
        used: formatStorage(volUsed),
        total: formatStorage(volCap),
        hint: `${reporting} of ${bound} PVC${bound === 1 ? '' : 's'} reporting usage`,
        icon: <IconStorage />,
      })
    }
    return out
  }, [nodesQ.data, metricsQ.data, pvcsQ.data, volQ.data])

  const loading = nodesQ.isLoading || metricsQ.isLoading || pvcsQ.isLoading
  // Keep the multi-up gauge row balanced whatever the available signal count.
  const gridCols =
    gauges.length >= 3 ? 'sm:grid-cols-3' : gauges.length === 2 ? 'sm:grid-cols-2' : 'grid-cols-1'
  return (
    <PanelCard>
      <PanelHead title="Resource utilization" subtitle="Cluster-wide live consumption" to="/platform" />
      {loading ? (
        <PanelLoading />
      ) : nodesQ.isError && pvcsQ.isError ? (
        <PanelError message="Could not reach the cluster" />
      ) : gauges.length === 0 ? (
        <PanelEmpty message="Requires metrics-server (metrics.k8s.io) or kubelet volume stats in Prometheus" />
      ) : (
        <div className={cn('grid flex-1 grid-cols-1 gap-4', gridCols)}>
          {gauges.map((g) => (
            <ResourceGauge
              key={g.key}
              label={g.label}
              value={g.value}
              used={g.used}
              total={g.total}
              hint={g.hint}
              icon={g.icon}
            />
          ))}
        </div>
      )}
    </PanelCard>
  )
}

/** Human-readable storage size from bytes (GiB / TiB), honest 0 B when empty. */
function formatStorage(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const gib = bytes / 1024 ** 3
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TiB`
  if (gib >= 1) return `${gib.toFixed(0)} GiB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`
}

function ResourceGauge({
  label,
  value,
  used,
  total,
  hint,
  icon,
}: {
  label: string
  value: number
  used: string
  total: string
  hint?: string
  icon: React.ReactNode
}) {
  const tone = value >= 85 ? 'rose' : value >= 70 ? 'amber' : 'emerald'
  const ringClass = {
    emerald: 'stroke-emerald-500',
    amber: 'stroke-amber-500',
    rose: 'stroke-rose-500',
  }[tone]
  const swatch = {
    emerald: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-200/60',
    amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-200/60',
    rose: 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-200/60',
  }[tone]
  const r = 44
  const stroke = 9
  const c = 2 * Math.PI * r
  const offset = c - (Math.max(0, Math.min(100, value)) / 100) * c
  return (
    <div className="flex flex-col items-center rounded-xl border border-edge-subtle bg-surface-sunken/30 p-3">
      <div className="relative h-28 w-28">
        <svg width="112" height="112" viewBox="0 0 112 112" className="-rotate-90">
          <circle cx="56" cy="56" r={r} fill="none" strokeWidth={stroke} className="stroke-edge-default" />
          <circle
            cx="56"
            cy="56"
            r={r}
            fill="none"
            strokeLinecap="round"
            strokeWidth={stroke}
            strokeDasharray={c}
            strokeDashoffset={offset}
            className={cn(ringClass, 'transition-[stroke-dashoffset]')}
            style={{ transitionDuration: '600ms' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-content">
            {value}
            <span className="text-sm font-normal text-content-subtle">%</span>
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-md ring-1', swatch)}>
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
          {label}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-content-muted">
        <span className="font-medium text-content">{used}</span>
        <span className="text-content-subtle"> / {total}</span>
      </div>
      {hint ? <div className="mt-0.5 text-[10px] text-content-subtle">{hint}</div> : null}
    </div>
  )
}

/* ───────────────────────────────────────────────────────────
 * Incident timeline — vertical timeline with severity dots
 * ─────────────────────────────────────────────────────────── */

export function IncidentTimelinePanel() {
  const alerts = useDiscoverAlerts()
  const list = alerts.data ?? []

  const items = useMemo(() => {
    return list.slice(0, 5).map((a, i) => {
      const labels = (a.labels ?? {}) as Record<string, string>
      const annotations = (a.annotations ?? {}) as Record<string, string>
      const sev = (labels.severity ?? '').toLowerCase()
      const severity =
        sev.includes('crit') || sev === 'sev1'
          ? ('sev1' as const)
          : sev.includes('warn') || sev === 'sev2' || sev === 'high'
            ? ('sev2' as const)
            : sev === 'sev3' || sev === 'medium'
              ? ('sev3' as const)
              : ('info' as const)
      return {
        id: `${labels.alertname ?? 'alert'}-${i}`,
        title: labels.alertname ?? annotations.summary ?? 'Alert',
        severity,
        message: annotations.description ?? annotations.summary ?? '—',
        ts: a.startsAt,
      }
    })
  }, [list])

  if (alerts.isLoading || alerts.isError || items.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Incident timeline" subtitle="Latest alerts · Prometheus" to="/discover" />
        {alerts.isLoading ? (
          <PanelLoading />
        ) : alerts.isError ? (
          <PanelError message="Prometheus alerts are not reachable" />
        ) : (
          <PanelEmpty message="No alerts firing or pending" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="Incident timeline" subtitle="Latest alerts · Prometheus" to="/discover" />
      <ol className="relative ml-3 flex-1 space-y-3 border-l border-edge-subtle pl-4">
        {items.map((it) => (
          <li key={it.id} className="relative">
            <span
              className={cn(
                'absolute -left-[19px] top-1 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-surface-raised',
                {
                  sev1: 'bg-rose-500',
                  sev2: 'bg-amber-500',
                  sev3: 'bg-sky-500',
                  info: 'bg-emerald-500',
                }[it.severity],
              )}
            />
            <div className="flex flex-wrap items-center gap-2">
              <SeverityPill sev={it.severity} />
              <span className="text-[10px] uppercase tracking-wider text-content-subtle">
                {formatRelative(it.ts)}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[13px] font-medium text-content">{it.title}</div>
            {it.message ? (
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-content-muted">
                {it.message}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </PanelCard>
  )
}

function SeverityPill({ sev }: { sev: 'sev1' | 'sev2' | 'sev3' | 'info' }) {
  const cls = {
    sev1: 'bg-rose-100 dark:bg-rose-500/15 text-rose-800 dark:text-rose-300 ring-rose-200/60',
    sev2: 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 ring-amber-200/60',
    sev3: 'bg-sky-100 dark:bg-sky-500/15 text-sky-800 dark:text-sky-300 ring-sky-200/60',
    info: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 ring-emerald-200/60',
  }[sev]
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1',
        cls,
      )}
    >
      {sev}
    </span>
  )
}


/* ───── new-panel icons ───── */

function IconCpu() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3" />
      <path d="M15 1v3" />
      <path d="M9 20v3" />
      <path d="M15 20v3" />
      <path d="M20 9h3" />
      <path d="M20 14h3" />
      <path d="M1 9h3" />
      <path d="M1 14h3" />
    </svg>
  )
}

function IconMemory() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 19v-3" />
      <path d="M10 19v-3" />
      <path d="M14 19v-3" />
      <path d="M18 19v-3" />
      <path d="M8 11V9" />
      <path d="M16 11V9" />
      <path d="M12 11V9" />
      <path d="M2 15h20" />
      <path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z" />
    </svg>
  )
}

function IconStorage() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v6a9 3 0 0 0 18 0V5" />
      <path d="M3 11v6a9 3 0 0 0 18 0v-6" />
    </svg>
  )
}


/* ───────────────────────────────────────────────────────────
 * Cert expiry — TLS certificates expiring soon
 * ─────────────────────────────────────────────────────────── */

export function CertExpiryPanel() {
  const q = useCertificates()

  const certs = useMemo(() => {
    const raw = (q.data ?? []) as Array<
      Generic & {
        spec?: { dnsNames?: string[]; commonName?: string; issuerRef?: { name?: string } }
        status?: { notAfter?: string; renewalTime?: string }
      }
    >
    const now = Date.now()
    return raw
      .map((c) => {
        const notAfter = c.status?.notAfter
        const daysLeft = notAfter
          ? Math.floor((new Date(notAfter).getTime() - now) / 86_400_000)
          : null
        const host = c.spec?.commonName ?? c.spec?.dnsNames?.[0] ?? c.metadata.name
        return {
          key: `${c.metadata.namespace ?? ''}/${c.metadata.name}`,
          host,
          daysLeft,
          issuer: c.spec?.issuerRef?.name ?? c.metadata.namespace ?? '—',
        }
      })
      .filter((c): c is { key: string; host: string; daysLeft: number; issuer: string } => c.daysLeft != null)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 8)
  }, [q.data])

  if (q.isLoading || q.isError || certs.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Certificate expiry" subtitle="TLS certs across all routes" to="/platform" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelEmpty message="Requires cert-manager (cert-manager.io)" />
        ) : (
          <PanelEmpty message="No Certificates found" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="Certificate expiry" subtitle="TLS certs across all routes" to="/platform" />
      <ul className="flex-1 divide-y divide-edge-subtle">
        {certs.map((c) => {
          const tone =
            c.daysLeft <= 7 ? 'rose' : c.daysLeft <= 30 ? 'amber' : 'emerald'
          const pillCls = {
            emerald: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-200/60',
            amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-200/60',
            rose: 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-200/60',
          }[tone]
          return (
            <li key={c.key} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <div className="truncate font-mono text-[12px] text-content">{c.host}</div>
                <div className="text-[10px] text-content-subtle">via {c.issuer}</div>
              </div>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider tabular-nums ring-1',
                  pillCls,
                )}
              >
                {c.daysLeft}d
              </span>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───────────────────────────────────────────────────────────
 * Pod restarts — top pods by restart count over 24h
 * ─────────────────────────────────────────────────────────── */

export function PodRestartsPanel() {
  const q = useAllPods()

  const pods = useMemo(() => {
    const raw = (q.data ?? []) as Array<{
      metadata: { name: string; namespace?: string }
      status?: { containerStatuses?: Array<{ restartCount?: number }> }
    }>
    return raw
      .map((p) => ({
        pod: p.metadata.name,
        namespace: p.metadata.namespace ?? 'default',
        restarts: (p.status?.containerStatuses ?? []).reduce(
          (s, c) => s + (c.restartCount ?? 0),
          0,
        ),
      }))
      .filter((p) => p.restarts > 0)
      .sort((a, b) => b.restarts - a.restarts)
      .slice(0, 6)
  }, [q.data])

  const max = Math.max(1, ...pods.map((p) => p.restarts))

  if (q.isLoading || q.isError || pods.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Pod restarts" subtitle="Top pods · restarts since start" to="/platform" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelError message="Could not reach the cluster" />
        ) : (
          <PanelEmpty message="No pod restarts" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="Pod restarts" subtitle="Top pods by restart count" to="/platform" />
      <ul className="flex-1 space-y-2">
        {pods.map((p) => {
          const w = (p.restarts / max) * 100
          const tone = p.restarts >= 10 ? 'rose' : p.restarts >= 4 ? 'amber' : 'sky'
          const fill = {
            sky: 'bg-sky-500',
            amber: 'bg-amber-500',
            rose: 'bg-rose-500',
          }[tone]
          return (
            <li key={p.pod}>
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate font-mono text-content">{p.pod}</span>
                <span className="font-mono tabular-nums text-content">{p.restarts}</span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-content-subtle">
                ns:{p.namespace}
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={cn('h-full rounded-full', fill)}
                  style={{ width: `${w}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── CloudNativePG clusters ───── */

interface CnpgCluster {
  name: string
  namespace: string
  primary: string
  instances: number
  ready: number
  pgVersion: string
  sizeGb: number
  phase: string
  status: 'healthy' | 'syncing' | 'failover' | 'degraded'
}

export function CnpgClustersPanel() {
  const q = useCnpgClusters()
  const pvcsQ = usePvcs()

  const clusters = useMemo<CnpgCluster[]>(() => {
    const raw = (q.data ?? []) as Array<
      Generic & {
        spec?: { instances?: number; imageName?: string }
        status?: {
          instances?: number
          readyInstances?: number
          currentPrimary?: string
          targetPrimary?: string
          phase?: string
        }
      }
    >
    const pvcs = (pvcsQ.data ?? []) as Array<
      Generic & { status?: { capacity?: { storage?: string } } }
    >
    // Provisioned DB volume per cluster, via the cnpg.io/cluster PVC label.
    const sizeByCluster = new Map<string, number>()
    for (const p of pvcs) {
      const cluster = p.metadata.labels?.['cnpg.io/cluster']
      if (!cluster) continue
      sizeByCluster.set(
        cluster,
        (sizeByCluster.get(cluster) ?? 0) + parseBytes(p.status?.capacity?.storage),
      )
    }
    return raw.map((c) => {
      const instances = c.spec?.instances ?? c.status?.instances ?? 0
      const ready = c.status?.readyInstances ?? 0
      const phase = c.status?.phase ?? ''
      const status: CnpgCluster['status'] =
        instances > 0 && ready >= instances
          ? 'healthy'
          : ready > 0
            ? /switch|failover/i.test(phase)
              ? 'failover'
              : 'syncing'
            : 'degraded'
      const tag = c.spec?.imageName?.split(':').pop()
      return {
        name: c.metadata.name,
        namespace: c.metadata.namespace ?? 'default',
        primary: c.status?.currentPrimary ?? c.status?.targetPrimary ?? '—',
        instances,
        ready,
        pgVersion: tag && /^\d/.test(tag) ? tag.replace(/-.*$/, '') : '—',
        sizeGb: Math.round((sizeByCluster.get(c.metadata.name) ?? 0) / 1024 ** 3),
        phase: phase || (ready >= instances ? 'Healthy' : 'Degraded'),
        status,
      }
    })
  }, [q.data, pvcsQ.data])

  const tones: Record<CnpgCluster['status'], string> = {
    healthy: 'border-emerald-200 dark:border-emerald-500/25 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    syncing: 'border-sky-200 dark:border-sky-500/25 bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300',
    failover: 'border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300',
    degraded: 'border-rose-200 dark:border-rose-500/25 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300',
  }

  if (q.isLoading || q.isError || clusters.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Database clusters" subtitle="CloudNativePG · primary + replica health" to="/platform" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelEmpty message="Requires CloudNativePG (postgresql.cnpg.io)" />
        ) : (
          <PanelEmpty message="No CloudNativePG clusters found" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead
        title="Database clusters"
        subtitle="CloudNativePG · primary + replica health"
        to="/platform"
      />
      <ul className="flex-1 space-y-2.5">
        {clusters.map((c) => {
          const readiness = pct(c.ready, c.instances)
          return (
            <li
              key={`${c.namespace}/${c.name}`}
              className="rounded-xl border border-edge-subtle bg-surface-sunken/40 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-content">{c.name}</span>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium capitalize',
                        tones[c.status],
                      )}
                    >
                      {c.status}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-content-subtle">
                    ns:{c.namespace} · pg{c.pgVersion} · primary {c.primary}
                  </div>
                </div>
                <div className="text-right text-[11px] tabular-nums">
                  <div className="font-semibold text-content">
                    {c.ready}/{c.instances}
                  </div>
                  <div className="text-content-subtle">{c.sizeGb} GiB</div>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-3 text-[10px] text-content-muted">
                <div className="flex-1">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        readiness >= 100
                          ? 'bg-emerald-500'
                          : readiness >= 67
                            ? 'bg-sky-500'
                            : 'bg-rose-500',
                      )}
                      style={{ width: `${readiness}%` }}
                    />
                  </div>
                </div>
                <span className="truncate tabular-nums" title={c.phase}>
                  {c.phase}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── Kafka brokers ───── */

interface KafkaBroker {
  id: number
  host: string
  cluster: string
  status: 'online' | 'offline'
}

export function KafkaBrokersPanel() {
  const kafkasQ = useKafkas()
  const topicsQ = useKafkaTopics()
  const podsQ = useAllPods()

  // Brokers are the Strimzi broker PODS, with liveness from their Ready
  // condition. A KRaft cluster labels them `strimzi.io/broker-role=true`; a
  // ZooKeeper-era cluster names them `<cluster>-kafka`. Expected counts come
  // from the Kafka resource (`spec.kafka.replicas`, ZooKeeper mode) — node
  // pools carry their own replica counts and are not summed here.
  const { brokers, topicCount, partitionCount } = useMemo(() => {
    const kafkas = (kafkasQ.data ?? []) as Array<Generic & { status?: { conditions?: Array<{ type?: string; status?: string }> } }>
    const names = new Set(kafkas.map((k) => k.metadata.name))
    const topics = (topicsQ.data ?? []) as Array<Generic & { spec?: { partitions?: number } }>
    const brokers: KafkaBroker[] = (podsQ.data ?? [])
      .filter((p) => {
        const l = p.metadata.labels ?? {}
        return l['strimzi.io/kind'] === 'Kafka' && names.has(l['strimzi.io/cluster'] ?? '') &&
          (l['strimzi.io/broker-role'] === 'true' || (l['strimzi.io/name'] ?? '').endsWith('-kafka'))
      })
      .map((p) => {
        const ready = (p.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')
        const id = Number((p.metadata.name.match(/-(\d+)$/) ?? [])[1] ?? NaN)
        return {
          id: Number.isFinite(id) ? id : 0,
          host: p.metadata.name,
          cluster: p.metadata.labels?.['strimzi.io/cluster'] ?? '',
          status: ready ? ('online' as const) : ('offline' as const),
        }
      })
      .sort((a, b) => a.cluster.localeCompare(b.cluster) || a.id - b.id)
    const partitionCount = topics.reduce((s, t) => s + (t.spec?.partitions ?? 0), 0)
    return { brokers, topicCount: topics.length, partitionCount }
  }, [kafkasQ.data, topicsQ.data, podsQ.data])

  const onlineCount = brokers.filter((b) => b.status === 'online').length
  const dotTone: Record<KafkaBroker['status'], string> = {
    online: 'bg-emerald-500',
    offline: 'bg-rose-500',
  }

  if (kafkasQ.isLoading || kafkasQ.isError || brokers.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Kafka brokers" subtitle="Strimzi · broker liveness" to="/platform" />
        {kafkasQ.isLoading ? (
          <PanelLoading />
        ) : kafkasQ.isError ? (
          <PanelEmpty message="Requires Strimzi (kafka.strimzi.io)" />
        ) : (
          <PanelEmpty message={(kafkasQ.data ?? []).length ? 'No broker pods are running for the Kafka clusters' : 'No Kafka clusters found'} />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="Kafka brokers" subtitle="Strimzi · broker liveness" to="/platform" />
      <div className="mb-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Stat
          label="Online"
          value={`${onlineCount}/${brokers.length}`}
          tone={onlineCount === brokers.length ? 'emerald' : 'amber'}
        />
        <Stat label="Topics" value={topicCount} tone="brand" />
        <Stat label="Partitions" value={partitionCount} tone="violet" />
      </div>
      <ul className="flex-1 space-y-1.5 overflow-y-auto">
        {brokers.map((b) => (
          <li key={`${b.cluster}-${b.id}`} className="rounded-md bg-surface-sunken/40 px-2.5 py-1.5">
            <div className="flex items-center gap-2 text-[11px]">
              <span className={cn('h-2 w-2 flex-none rounded-full', dotTone[b.status])} />
              <span className="font-mono text-content">{b.host}</span>
              <span className="text-content-subtle">·</span>
              <span className="text-content-muted capitalize">{b.status}</span>
              <span className="ml-auto tabular-nums text-content-subtle">{b.cluster} · {b.id}</span>
            </div>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

/* ───── Platform tools health ───── */

interface ToolHealth {
  key: string
  name: string
  configured: boolean
  detail: string
  href: string
}

// Display metadata for the tools reported by /api/config (keys match the BFF
// tool-registry). Anything not listed falls back to the raw key + /platform.
const TOOL_META: Record<string, { name: string; href: string }> = {
  k8s: { name: 'Kubernetes', href: '/platform' },
  argocd: { name: 'ArgoCD', href: '/deliver' },
  'argo-rollouts': { name: 'Argo Rollouts', href: '/deliver' },
  kargo: { name: 'Kargo', href: '/deliver' },
  crossplane: { name: 'Crossplane', href: '/platform' },
  gitea: { name: 'Gitea', href: '/develop' },
  harbor: { name: 'Harbor', href: '/deliver' },
  kyverno: { name: 'Kyverno', href: '/deliver' },
  falco: { name: 'Falco', href: '/deliver' },
  trivy: { name: 'Trivy', href: '/deliver' },
  grafana: { name: 'Grafana', href: '/discover' },
  lgtm: { name: 'LGTM (Grafana)', href: '/discover' },
  metabase: { name: 'Metabase', href: '/decide' },
  opencost: { name: 'OpenCost', href: '/decide' },
  airbyte: { name: 'Airbyte', href: '/develop' },
  posthog: { name: 'PostHog', href: '/discover' },
  plane: { name: 'Plane', href: '/define' },
  coder: { name: 'Coder', href: '/develop' },
}

export function ToolsHealthPanel() {
  const q = useToolsConfig()

  const tools = useMemo<ToolHealth[]>(() => {
    const map: Record<string, { configured: boolean; url: string }> = q.data?.tools ?? {}
    return Object.entries(map)
      .map(([key, cfg]) => {
        const meta = TOOL_META[key]
        let detail = cfg.configured ? 'configured' : 'not configured'
        if (cfg.url) {
          try {
            detail = new URL(cfg.url).host
          } catch {
            detail = cfg.url
          }
        }
        return {
          key,
          name: meta?.name ?? key,
          configured: cfg.configured,
          detail,
          href: meta?.href ?? '/platform',
        }
      })
      .sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name))
  }, [q.data])

  const configured = tools.filter((t) => t.configured).length
  const unconfigured = tools.length - configured

  if (q.isLoading || q.isError || tools.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Platform tools" subtitle="Wiring across the stack" to="/platform" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelError message="Could not load /api/config" />
        ) : (
          <PanelEmpty message="No tools reported by /api/config" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead title="Platform tools" subtitle="Wiring across the stack" to="/platform" />
      <div className="mb-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Stat label="Configured" value={configured} tone="emerald" />
        <Stat label="Unconfigured" value={unconfigured} tone={unconfigured > 0 ? 'amber' : 'slate'} />
        <Stat label="Total" value={tools.length} tone="brand" />
      </div>
      <div className="grid flex-1 grid-cols-2 gap-1.5 overflow-y-auto md:grid-cols-3 xl:grid-cols-4">
        {tools.map((t) => (
          <Link
            key={t.key}
            to={t.href}
            className="group flex items-center gap-2 rounded-md border border-edge-subtle bg-surface-raised px-2 py-1.5 text-[11px] transition-colors hover:border-edge-strong hover:bg-surface-sunken"
          >
            <span
              className={cn(
                'h-1.5 w-1.5 flex-none rounded-full',
                t.configured ? 'bg-emerald-500' : 'bg-slate-300',
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">
                {t.name}
              </div>
              <div
                className={cn(
                  'truncate text-[10px]',
                  t.configured ? 'text-content-subtle' : 'text-content-subtle/70',
                )}
              >
                {t.detail}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </PanelCard>
  )
}

/* ───── Kubernetes events stream ───── */

interface K8sEvent {
  at: string
  type: 'Normal' | 'Warning'
  reason: string
  object: string
  namespace: string
  message: string
}

export function K8sEventsPanel() {
  const q = useClusterEvents()

  const events = useMemo<K8sEvent[]>(() => {
    const raw = (q.data ?? []) as Array<{
      metadata: { namespace?: string; creationTimestamp?: string }
      type: 'Normal' | 'Warning'
      reason: string
      message: string
      lastTimestamp?: string
      involvedObject: { kind: string; name: string; namespace?: string }
    }>
    return raw
      .map((e) => ({
        at: e.lastTimestamp ?? e.metadata.creationTimestamp ?? new Date().toISOString(),
        type: e.type,
        reason: e.reason,
        object: `${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}`,
        namespace: e.involvedObject.namespace ?? e.metadata.namespace ?? '—',
        message: e.message,
      }))
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 12)
  }, [q.data])

  const warnings = events.filter((e) => e.type === 'Warning').length

  if (q.isLoading || q.isError || events.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Cluster events" subtitle="Recent Kubernetes events" to="/platform" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelError message="Could not reach the cluster" />
        ) : (
          <PanelEmpty message="No recent events" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead
        title="Cluster events"
        subtitle={`${events.length} recent · ${warnings} warning${warnings === 1 ? '' : 's'}`}
        to="/platform"
      />
      <ul className="flex-1 space-y-1.5 overflow-y-auto">
        {events.map((e, i) => {
          const isWarn = e.type === 'Warning'
          return (
            <li
              key={`${e.at}-${i}`}
              className={cn(
                'rounded-md border-l-2 bg-surface-sunken/40 px-2.5 py-1.5',
                isWarn ? 'border-l-amber-500' : 'border-l-emerald-500',
              )}
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      'inline-flex flex-none items-center rounded-sm px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                      isWarn
                        ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300'
                        : 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
                    )}
                  >
                    {e.reason}
                  </span>
                  <span className="truncate font-mono text-content">{e.object}</span>
                </div>
                <span className="flex-none tabular-nums text-content-subtle">
                  {formatRelative(e.at)}
                </span>
              </div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-content-muted">
                {e.message}
              </div>
              <div className="text-[10px] text-content-subtle">ns:{e.namespace}</div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── Gitea repo metrics ───── */

interface GiteaLang {
  name: string
  pct: number
  color: string
}

const LANG_PALETTE = [
  'oklch(0.58 0.16 245)',
  'oklch(0.66 0.13 200)',
  'oklch(0.7 0.14 90)',
  'oklch(0.6 0.18 30)',
  'oklch(0.72 0.14 350)',
  'oklch(0.7 0.02 260)',
]

export function GiteaRepoMetricsPanel() {
  const repos = useDevelopRepos()

  const { total, stars, forks, openIssues, langs } = useMemo(() => {
    const list = (repos.data ?? []) as Array<{
      stars_count?: number
      forks_count?: number
      open_issues_count?: number
      language?: string
    }>
    const stars = list.reduce((s, r) => s + (r.stars_count ?? 0), 0)
    const forks = list.reduce((s, r) => s + (r.forks_count ?? 0), 0)
    const openIssues = list.reduce((s, r) => s + (r.open_issues_count ?? 0), 0)
    const byLang = new Map<string, number>()
    for (const r of list) {
      const lang = r.language?.trim()
      if (!lang) continue
      byLang.set(lang, (byLang.get(lang) ?? 0) + 1)
    }
    const withLang = Array.from(byLang.values()).reduce((s, n) => s + n, 0)
    const sorted = Array.from(byLang.entries()).sort((a, b) => b[1] - a[1])
    const top = sorted.slice(0, 5)
    const restCount = sorted.slice(5).reduce((s, [, n]) => s + n, 0)
    const entries = restCount > 0 ? [...top, ['Other', restCount] as [string, number]] : top
    const langs: GiteaLang[] = entries.map(([name, count], i) => ({
      name,
      pct: withLang > 0 ? Math.round((count / withLang) * 100) : 0,
      color: LANG_PALETTE[i % LANG_PALETTE.length],
    }))
    return { total: list.length, stars, forks, openIssues, langs }
  }, [repos.data])

  if (repos.isLoading || repos.isError || total === 0) {
    return (
      <PanelCard>
        <PanelHead title="Code repositories" subtitle="Gitea · org-wide activity" to="/develop" />
        {repos.isLoading ? (
          <PanelLoading />
        ) : repos.isError ? (
          <PanelEmpty message="Requires a Gitea source" />
        ) : (
          <PanelEmpty message="No repositories found" />
        )}
      </PanelCard>
    )
  }

  return (
    <PanelCard>
      <PanelHead title="Code repositories" subtitle="Gitea · org-wide activity" to="/develop" />
      <div className="mb-3 grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Stat label="Repos" value={total} tone="brand" />
        <Stat label="Stars" value={stars} tone="amber" />
        <Stat label="Forks" value={forks} tone="slate" />
        <Stat label="Open issues" value={openIssues} tone="emerald" />
      </div>

      <div className="flex-1 space-y-1.5">
        {langs.length === 0 ? (
          <div className="text-[10px] text-content-subtle">No language data reported</div>
        ) : null}
        <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Language mix
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          {langs.map((l) => (
            <div
              key={l.name}
              style={{ width: `${l.pct}%`, backgroundColor: l.color }}
              title={`${l.name} · ${l.pct}%`}
            />
          ))}
        </div>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
          {langs.map((l) => (
            <li key={l.name} className="flex items-center gap-1.5 text-content-muted">
              <span
                className="h-1.5 w-1.5 flex-none rounded-full"
                style={{ backgroundColor: l.color }}
              />
              <span className="flex-1 truncate">{l.name}</span>
              <span className="tabular-nums text-content">{l.pct}%</span>
            </li>
          ))}
        </ul>
      </div>
    </PanelCard>
  )
}

/* ───── PR throughput ───── */

interface ReviewerLoad {
  name: string
  reviews: number
  avgHours: number
}


/* ───── GitOps sync (ArgoCD) ───── */

interface SyncEvent {
  at: string
  app: string
  result: 'synced' | 'failed' | 'degraded'
  revision: string
}

export function GitOpsSyncPanel() {
  const q = useDeliverApplications()
  const apps = q.data ?? []
  // Counted per app, not by subtracting totals: an OutOfSync app can still be
  // Healthy, so `synced - healthy` mis-sized the middle bucket.
  const isSynced = (a: (typeof apps)[number]) => a.status.sync.status === 'Synced'
  const isHealthy = (a: (typeof apps)[number]) => a.status.health.status === 'Healthy'
  const syncedHealthy = apps.filter((a) => isSynced(a) && isHealthy(a)).length
  const syncedUnhealthy = apps.filter((a) => isSynced(a) && !isHealthy(a)).length
  const outOfSync = apps.filter((a) => !isSynced(a)).length
  const synced = syncedHealthy + syncedUnhealthy

  const driftBars = useMemo(
    () => [
      { label: 'Synced + Healthy', count: syncedHealthy, tone: 'emerald' as const },
      { label: 'Synced · Not healthy', count: syncedUnhealthy, tone: 'amber' as const },
      { label: 'OutOfSync', count: outOfSync, tone: 'rose' as const },
    ],
    [syncedHealthy, syncedUnhealthy, outOfSync],
  )
  const totalApps = apps.length || 1

  // Real recent sync operations from each app's status.operationState.
  const recent = useMemo<SyncEvent[]>(() => {
    return apps
      .filter((a) => a.status.operationState?.finishedAt)
      .map((a) => {
        const phase = a.status.operationState?.phase
        const result: SyncEvent['result'] =
          phase === 'Failed' || phase === 'Error'
            ? 'failed'
            : a.status.health.status === 'Degraded'
              ? 'degraded'
              : 'synced'
        return {
          at: a.status.operationState!.finishedAt!,
          app: a.metadata.name,
          result,
          revision: a.status.sync.revision ?? '',
        }
      })
      .sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime())
      .slice(0, 6)
  }, [apps])

  const tones: Record<SyncEvent['result'], { dot: string; label: string }> = {
    synced: { dot: 'bg-emerald-500', label: 'text-emerald-700 dark:text-emerald-300' },
    failed: { dot: 'bg-rose-500', label: 'text-rose-700 dark:text-rose-300' },
    degraded: { dot: 'bg-amber-500', label: 'text-amber-700 dark:text-amber-300' },
  }

  if (q.isLoading || q.isError || apps.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="GitOps sync" subtitle="ArgoCD · drift + recent syncs" to="/deliver" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelEmpty message="Requires an Argo CD source" />
        ) : (
          <PanelEmpty message="No Argo CD applications found" />
        )}
      </PanelCard>
    )
  }

  return (
    <PanelCard>
      <PanelHead title="GitOps sync" subtitle="ArgoCD · drift + recent syncs" to="/deliver" />
      <div className="mb-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Stat label="Apps" value={apps.length} tone="brand" />
        <Stat label="Synced" value={synced} tone={outOfSync === 0 ? 'emerald' : 'amber'} />
        <Stat label="Drift" value={outOfSync} tone={outOfSync === 0 ? 'emerald' : 'rose'} />
      </div>

      <div className="mb-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Sync × health composition
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          {driftBars.map((b) => {
            const fill = {
              emerald: 'bg-emerald-500',
              amber: 'bg-amber-500',
              rose: 'bg-rose-500',
            }[b.tone]
            return (
              <div
                key={b.label}
                className={fill}
                style={{ width: `${(b.count / totalApps) * 100}%` }}
                title={`${b.label} · ${b.count}`}
              />
            )
          })}
        </div>
        <ul className="mt-1.5 grid grid-cols-1 sm:grid-cols-3 gap-x-2 text-[10px]">
          {driftBars.map((b) => (
            <li key={b.label} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'h-1.5 w-1.5 flex-none rounded-full',
                  b.tone === 'emerald' && 'bg-emerald-500',
                  b.tone === 'amber' && 'bg-amber-500',
                  b.tone === 'rose' && 'bg-rose-500',
                )}
              />
              <span className="flex-1 truncate text-content-muted">{b.label}</span>
              <span className="tabular-nums text-content">{b.count}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex-1 space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Recent syncs
        </div>
        {recent.length === 0 ? (
          <div className="text-[10px] text-content-subtle">No recorded sync operations</div>
        ) : null}
        <ul className="space-y-1">
          {recent.map((e, i) => (
            <li
              key={`${e.app}-${i}`}
              className="flex items-center gap-2 rounded-md bg-surface-sunken/40 px-2 py-1.5 text-[11px]"
            >
              <span className={cn('h-1.5 w-1.5 flex-none rounded-full', tones[e.result].dot)} />
              <span className="truncate font-mono text-content">{e.app}</span>
              <span className={cn('flex-none text-[10px] capitalize', tones[e.result].label)}>
                {e.result}
              </span>
              <code className="ml-auto flex-none rounded bg-surface-raised px-1 py-0.5 font-mono text-[10px] text-content-muted ring-1 ring-edge-subtle">
                {e.revision.slice(0, 7)}
              </code>
              <span className="flex-none tabular-nums text-content-subtle">
                {formatRelative(e.at)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </PanelCard>
  )
}

/* ───── Tenant overview ───── */

/** Namespaces carry `adhar.io/org=<org slug>` to bind them to a tenant. */
const ORG_LABEL = 'adhar.io/org'

function safeFormatRelative(at: string): string {
  try {
    return formatRelative(at)
  } catch {
    return at
  }
}

type QuotaObject = Generic & {
  status?: { used?: Record<string, string>; hard?: Record<string, string> }
}

interface QuotaAgg {
  cpuUsed: number
  cpuHard: number
  memUsed: number
  memHard: number
  storageUsed: number
  storageHard: number
  quotaCount: number
}

function pickQuota(m: Record<string, string> | undefined, keys: string[]): string | undefined {
  if (!m) return undefined
  for (const k of keys) if (m[k] != null) return m[k]
  return undefined
}

/** Sum ResourceQuota status.used / status.hard across a set of quota objects. */
function aggregateQuotas(quotas: QuotaObject[]): QuotaAgg {
  const agg: QuotaAgg = {
    cpuUsed: 0,
    cpuHard: 0,
    memUsed: 0,
    memHard: 0,
    storageUsed: 0,
    storageHard: 0,
    quotaCount: quotas.length,
  }
  for (const q of quotas) {
    const used = q.status?.used
    const hard = q.status?.hard
    agg.cpuUsed += parseCpu(pickQuota(used, ['requests.cpu', 'cpu', 'limits.cpu']))
    agg.cpuHard += parseCpu(pickQuota(hard, ['requests.cpu', 'cpu', 'limits.cpu']))
    agg.memUsed += parseBytes(pickQuota(used, ['requests.memory', 'memory', 'limits.memory']))
    agg.memHard += parseBytes(pickQuota(hard, ['requests.memory', 'memory', 'limits.memory']))
    agg.storageUsed += parseBytes(pickQuota(used, ['requests.storage']))
    agg.storageHard += parseBytes(pickQuota(hard, ['requests.storage']))
  }
  return agg
}

export function TenantOverviewPanel() {
  // Tenant identity comes from the console's own organizations service
  // (/api/organizations, per-user, cookie-scoped). Per-tenant capacity comes
  // from the cluster: namespaces labelled `adhar.io/org=<slug>` and the
  // ResourceQuotas inside them. No hard-coded tenant — real org or honest empty.
  const org = useOrganizations()
  const nsQ = useNamespaces()
  const rqQ = useResourceQuotas()

  const active = useMemo(
    () => org.orgs.find((o) => o.id === org.activeId) ?? org.orgs[0],
    [org.orgs, org.activeId],
  )

  const view = useMemo(() => {
    if (!active) return null
    const namespaces = (nsQ.data ?? []) as Array<{
      metadata: { name: string; labels?: Record<string, string> }
    }>
    const nsNames = new Set(
      namespaces
        .filter((n) => n.metadata.labels?.[ORG_LABEL] === active.slug)
        .map((n) => n.metadata.name),
    )
    const quotas = (rqQ.data ?? []) as QuotaObject[]
    const scoped = quotas.filter((q) => nsNames.has(q.metadata.namespace ?? ''))
    return { nsCount: nsNames.size, agg: aggregateQuotas(scoped) }
  }, [active, nsQ.data, rqQ.data])

  // Loading: org list still resolving, or the cluster reads still in flight.
  if (org.loading || (active && (nsQ.isLoading || rqQ.isLoading))) {
    return (
      <PanelCard>
        <PanelHead title="Tenant overview" subtitle="Active organization · quotas" to="/settings" />
        <PanelLoading />
      </PanelCard>
    )
  }

  // No org resolved — not signed in / no organizations service.
  if (!active) {
    return (
      <PanelCard>
        <PanelHead title="Tenant overview" subtitle="Active organization · quotas" to="/settings" />
        <PanelEmpty message={org.error ? 'Requires a tenancy source' : 'No organizations found'} />
      </PanelCard>
    )
  }

  const agg = view?.agg
  const hasQuota = !!agg && (agg.cpuHard > 0 || agg.memHard > 0 || agg.storageHard > 0)
  const created = active.createdAt ? safeFormatRelative(active.createdAt) : null

  return (
    <PanelCard>
      <PanelHead
        title="Tenant overview"
        subtitle={`${active.name} · quota consumption`}
        to="/settings"
      />
      <div className="mb-3 flex items-center gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-500/10 text-sm font-semibold text-brand-700 dark:text-brand-300 ring-1 ring-brand-200/60">
          {active.name.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-content">{active.name}</div>
          <div className="truncate font-mono text-[11px] text-content-subtle">{active.slug}</div>
        </div>
        <div className="flex-none text-right">
          <div className="text-sm font-semibold tabular-nums text-content">{view?.nsCount ?? 0}</div>
          <div className="text-[10px] uppercase tracking-wider text-content-subtle">namespaces</div>
        </div>
      </div>

      {hasQuota && agg ? (
        <div className="flex-1 space-y-2.5">
          <QuotaBar
            label="CPU"
            usedLabel={`${agg.cpuUsed.toFixed(1)} / ${agg.cpuHard.toFixed(0)} cores`}
            pct={pct(agg.cpuUsed, agg.cpuHard)}
            fill="bg-sky-500"
          />
          <QuotaBar
            label="Memory"
            usedLabel={`${formatStorage(agg.memUsed)} / ${formatStorage(agg.memHard)}`}
            pct={pct(agg.memUsed, agg.memHard)}
            fill="bg-violet-500"
          />
          <QuotaBar
            label="Storage"
            usedLabel={`${formatStorage(agg.storageUsed)} / ${formatStorage(agg.storageHard)}`}
            pct={pct(agg.storageUsed, agg.storageHard)}
            fill="bg-emerald-500"
          />
          <div className="border-t border-edge-subtle pt-2 text-[10px] text-content-subtle">
            {agg.quotaCount} ResourceQuota{agg.quotaCount === 1 ? '' : 's'}
            {created ? ` · created ${created}` : ''}
          </div>
        </div>
      ) : (
        <PanelEmpty
          message={
            view && view.nsCount === 0
              ? `No namespaces labelled ${ORG_LABEL}=${active.slug}`
              : 'No quotas configured for this organization'
          }
        />
      )}
    </PanelCard>
  )
}

function QuotaBar({
  label,
  usedLabel,
  pct: p,
  fill,
}: {
  label: string
  usedLabel: string
  pct: number
  fill: string
}) {
  const tone = p >= 90 ? 'bg-rose-500' : p >= 75 ? 'bg-amber-500' : fill
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-medium text-content">{label}</span>
        <span className="tabular-nums text-content-muted">
          {usedLabel}
          <span className="ml-1.5 font-semibold text-content">{p}%</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.min(100, p)}%` }} />
      </div>
    </div>
  )
}

/* ───── Sprint progress (active cycle burndown) ───── */

export function SprintProgressPanel() {
  const { issues, cycles } = useDefineSignals()
  const cycleList = cycles.data ?? []
  const issueList = issues.data ?? []
  const active = cycleList.find((c) => c.status === 'current')
  const total = active?.total_issues ?? issueList.length
  const completed = active?.completed_issues ?? issueList.filter((i) => !!i.completed_at).length
  const progress = active?.progress ?? (total > 0 ? Math.round((completed / total) * 100) : 0)
  const started = active?.started_issues ?? 0
  const backlog = active?.backlog_issues ?? 0
  const remaining = total - completed
  const endLabel = active?.end_date ? formatRelative(active.end_date) : '—'

  return (
    <PanelCard>
      <PanelHead
        title="Sprint progress"
        subtitle={active?.name ?? 'No active cycle'}
        to="/define"
      />
      <div className="mb-3 grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Stat label="Total" value={total} tone="brand" />
        <Stat label="Done" value={completed} tone="emerald" />
        <Stat label="In-flight" value={started} tone="amber" />
        <Stat label="Backlog" value={backlog} tone="slate" />
      </div>

      <div className="mb-3 flex items-baseline justify-between text-[10px]">
        <span className="font-semibold uppercase tracking-wider text-content-subtle">Progress</span>
        <span className="tabular-nums text-content-muted">
          {progress}% complete · {remaining} remaining · ends {endLabel}
        </span>
      </div>

      <div className="flex-1">
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div className="h-full rounded-full bg-brand-500" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </PanelCard>
  )
}

/* ───── Issue backlog (priority + aging) ───── */

export function IssueBacklogPanel() {
  const { issues } = useDefineSignals()
  const list = issues.data ?? []
  const open = list.filter((i) => !i.completed_at)

  const byPriority = useMemo(() => {
    const counts: Record<'urgent' | 'high' | 'medium' | 'low' | 'none', number> = {
      urgent: 0,
      high: 0,
      medium: 0,
      low: 0,
      none: 0,
    }
    for (const i of open) counts[i.priority]++
    return counts
  }, [open])

  const aging = useMemo(() => {
    const now = Date.now()
    const buckets = { week: 0, month: 0, quarter: 0, stale: 0 }
    for (const i of open) {
      const d = i.created_at ? Date.parse(i.created_at) : NaN
      if (!Number.isFinite(d)) {
        buckets.stale++
        continue
      }
      const ageDays = (now - d) / 86_400_000
      if (ageDays < 7) buckets.week++
      else if (ageDays < 30) buckets.month++
      else if (ageDays < 90) buckets.quarter++
      else buckets.stale++
    }
    return buckets
  }, [open])

  // Real counts only — no fabricated fallback when there are no open issues.
  const safe = byPriority
  const safeAging = aging
  const totalOpen = open.length

  const priorityRows: { key: keyof typeof safe; label: string; tone: string; fill: string }[] = [
    { key: 'urgent', label: 'Urgent', tone: 'text-rose-700 dark:text-rose-300', fill: 'bg-rose-500' },
    { key: 'high', label: 'High', tone: 'text-amber-700 dark:text-amber-300', fill: 'bg-amber-500' },
    { key: 'medium', label: 'Medium', tone: 'text-sky-700 dark:text-sky-300', fill: 'bg-sky-500' },
    { key: 'low', label: 'Low', tone: 'text-emerald-700 dark:text-emerald-300', fill: 'bg-emerald-500' },
    { key: 'none', label: 'Triage', tone: 'text-content-muted', fill: 'bg-slate-400' },
  ]

  const agingMax = Math.max(safeAging.week, safeAging.month, safeAging.quarter, safeAging.stale, 1)

  const triagePct = pct(safe.none, totalOpen)
  const groomingHealth = triagePct < 10 ? 'healthy' : triagePct < 25 ? 'fair' : 'stale'
  const groomingTone = {
    healthy: 'text-emerald-700 dark:text-emerald-300',
    fair: 'text-amber-700 dark:text-amber-300',
    stale: 'text-rose-700 dark:text-rose-300',
  }[groomingHealth]

  if (issues.isLoading || issues.isError || totalOpen === 0) {
    return (
      <PanelCard>
        <PanelHead title="Issue backlog" subtitle="Open issues by priority & age" to="/define" />
        {issues.isLoading ? (
          <PanelLoading />
        ) : issues.isError ? (
          <PanelEmpty message="Requires a Plane source" />
        ) : (
          <PanelEmpty message="No open issues" />
        )}
      </PanelCard>
    )
  }

  return (
    <PanelCard>
      <PanelHead
        title="Issue backlog"
        subtitle={`${totalOpen} open · grooming ${groomingHealth}`}
        to="/define"
      />
      <div className="mb-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          By priority
        </div>
        <ul className="mt-1.5 space-y-1">
          {priorityRows.map((r) => {
            const v = safe[r.key]
            const w = totalOpen > 0 ? (v / totalOpen) * 100 : 0
            return (
              <li key={r.key} className="text-[11px]">
                <div className="flex items-baseline justify-between">
                  <span className={cn('font-medium', r.tone)}>{r.label}</span>
                  <span className="tabular-nums text-content-muted">
                    {v} <span className="text-content-subtle">· {Math.round(w)}%</span>
                  </span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                  <div className={cn('h-full rounded-full', r.fill)} style={{ width: `${w}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="flex-1 space-y-1.5">
        <div className="flex items-baseline justify-between text-[10px]">
          <span className="font-semibold uppercase tracking-wider text-content-subtle">
            Age distribution
          </span>
          <span className={cn('tabular-nums', groomingTone)}>{triagePct}% untriaged</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-1.5 text-[10px]">
          {(
            [
              { key: 'week', label: 'This week', tone: 'bg-emerald-500/80' },
              { key: 'month', label: '< 30d', tone: 'bg-sky-500/80' },
              { key: 'quarter', label: '< 90d', tone: 'bg-amber-500/80' },
              { key: 'stale', label: 'Stale', tone: 'bg-rose-500/80' },
            ] as const
          ).map((b) => {
            const v = safeAging[b.key]
            const h = (v / agingMax) * 100
            return (
              <div key={b.key} className="flex flex-col gap-1">
                <div className="flex h-12 items-end overflow-hidden rounded-md bg-surface-sunken">
                  <div className={cn('w-full rounded-t-md', b.tone)} style={{ height: `${h}%` }} />
                </div>
                <div className="text-center">
                  <div className="text-sm font-semibold tabular-nums text-content">{v}</div>
                  <div className="text-content-subtle">{b.label}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </PanelCard>
  )
}

/* ───── Tenant usage (multi-tenant control plane) ───── */

interface TenantUsage {
  tenant: string
  cpu: number
  cpuLimit: number
  memGb: number
  memLimit: number
  storageGb: number
  storageLimit: number
}

export function TenantUsagePanel() {
  // Real per-tenant capacity: namespaces labelled `adhar.io/org=<slug>` mapped
  // to their ResourceQuotas. When no namespace carries the org label we fall
  // back to per-namespace grouping (still real cluster data, never fabricated).
  const q = useResourceQuotas()
  const nsQ = useNamespaces()
  const org = useOrganizations()

  const { tenants, grouped } = useMemo(() => {
    const quotas = (q.data ?? []) as QuotaObject[]
    const namespaces = (nsQ.data ?? []) as Array<{
      metadata: { name: string; labels?: Record<string, string> }
    }>
    // namespace → org slug (only for labelled namespaces)
    const nsToOrg = new Map<string, string>()
    for (const n of namespaces) {
      const slug = n.metadata.labels?.[ORG_LABEL]
      if (slug) nsToOrg.set(n.metadata.name, slug)
    }
    const useOrgGrouping = nsToOrg.size > 0
    const slugToName = new Map(org.orgs.map((o) => [o.slug, o.name]))

    const byTenant = new Map<string, TenantUsage>()
    for (const qta of quotas) {
      const ns = qta.metadata.namespace ?? 'default'
      // Group key: org (when labels exist) — skip unlabelled namespaces — else ns.
      let key: string
      if (useOrgGrouping) {
        const slug = nsToOrg.get(ns)
        if (!slug) continue
        key = slugToName.get(slug) ?? slug
      } else {
        key = ns
      }
      const used = qta.status?.used
      const hard = qta.status?.hard
      const cpu = parseCpu(pickQuota(used, ['requests.cpu', 'cpu', 'limits.cpu']))
      const cpuLimit = parseCpu(pickQuota(hard, ['requests.cpu', 'cpu', 'limits.cpu']))
      const mem = parseBytes(pickQuota(used, ['requests.memory', 'memory', 'limits.memory']))
      const memLimit = parseBytes(pickQuota(hard, ['requests.memory', 'memory', 'limits.memory']))
      const storage = parseBytes(pickQuota(used, ['requests.storage']))
      const storageLimit = parseBytes(pickQuota(hard, ['requests.storage']))
      const cur = byTenant.get(key) ?? {
        tenant: key,
        cpu: 0,
        cpuLimit: 0,
        memGb: 0,
        memLimit: 0,
        storageGb: 0,
        storageLimit: 0,
      }
      cur.cpu += cpu
      cur.cpuLimit += cpuLimit
      cur.memGb += mem / 1024 ** 3
      cur.memLimit += memLimit / 1024 ** 3
      cur.storageGb += storage / 1024 ** 3
      cur.storageLimit += storageLimit / 1024 ** 3
      byTenant.set(key, cur)
    }
    const list = Array.from(byTenant.values())
      .filter((t) => t.cpuLimit > 0 || t.memLimit > 0 || t.storageLimit > 0)
      .sort((a, b) => b.cpu - a.cpu)
    return { tenants: list, grouped: useOrgGrouping ? 'tenants' : 'namespaces' }
  }, [q.data, nsQ.data, org.orgs])

  const aggregateCpu = Math.round(tenants.reduce((s, t) => s + t.cpu, 0))
  const aggregateMem = Math.round(tenants.reduce((s, t) => s + t.memGb, 0))

  const loading = q.isLoading || nsQ.isLoading
  if (loading || q.isError || tenants.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Tenant usage" subtitle="Per-tenant quota consumption" to="/settings" />
        {loading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelError message="Could not reach the cluster" />
        ) : (
          <PanelEmpty message="No tenants / no quotas configured" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead
        title="Tenant usage"
        subtitle={`${tenants.length} ${grouped} · quota consumption`}
        to="/settings"
      />
      <div className="mb-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Stat
          label={grouped === 'tenants' ? 'Tenants' : 'Namespaces'}
          value={tenants.length}
          tone="emerald"
        />
        <Stat label="CPU cores" value={aggregateCpu} tone="brand" />
        <Stat label="Memory" value={`${aggregateMem} GB`} tone="violet" />
      </div>
      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {tenants.map((t) => {
          const cpuPct = pct(t.cpu, t.cpuLimit)
          const memPct = pct(t.memGb, t.memLimit)
          const storagePct = pct(t.storageGb, t.storageLimit)
          const hot = Math.max(cpuPct, memPct, storagePct)
          return (
            <div
              key={t.tenant}
              className="rounded-xl border border-edge-subtle bg-surface-sunken/40 p-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-surface-raised text-[11px] font-semibold text-content ring-1 ring-edge-subtle">
                  {t.tenant.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[12px] text-content">{t.tenant}</span>
                  </div>
                  <div className="text-[10px] text-content-subtle">
                    {t.cpu.toFixed(1)} / {t.cpuLimit.toFixed(0)} cores
                  </div>
                </div>
                <span
                  className={cn(
                    'flex-none text-[10px] font-medium tabular-nums',
                    hot >= 90 ? 'text-rose-700 dark:text-rose-300' : hot >= 75 ? 'text-amber-700 dark:text-amber-300' : 'text-content-muted',
                  )}
                >
                  {hot}%
                </span>
              </div>
              <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                <UsageBar label="CPU" pct={cpuPct} fill="bg-sky-500" />
                <UsageBar label="Mem" pct={memPct} fill="bg-violet-500" />
                <UsageBar label="Disk" pct={storagePct} fill="bg-emerald-500" />
              </div>
            </div>
          )
        })}
      </div>
    </PanelCard>
  )
}

function UsageBar({ label, pct: p, fill }: { label: string; pct: number; fill: string }) {
  const tone = p >= 90 ? 'bg-rose-500' : p >= 75 ? 'bg-amber-500' : fill
  return (
    <div>
      <div className="flex items-baseline justify-between text-[10px]">
        <span className="text-content-subtle">{label}</span>
        <span className="tabular-nums text-content-muted">{p}%</span>
      </div>
      <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-raised">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.min(100, p)}%` }} />
      </div>
    </div>
  )
}

/* ───── Audit log feed ───── */

interface AuditEvent {
  at: string
  actor: string
  action: string
  resource: string
  tenant: string
  severity: 'info' | 'warning' | 'critical'
}

// Kubernetes event reasons that represent mutations (create/update/delete/scale)
// — used to derive an audit-style feed from the core event stream.
const MUTATION_REASONS = new Set([
  'Created',
  'Started',
  'Killing',
  'Deleted',
  'Scheduled',
  'ScalingReplicaSet',
  'SuccessfulCreate',
  'SuccessfulDelete',
  'SuccessfulUpdate',
  'Updated',
  'Provisioning',
  'ProvisioningSucceeded',
  'Preempting',
  'Pulled',
])

export function AuditLogPanel() {
  const q = useClusterEvents()

  const events = useMemo<AuditEvent[]>(() => {
    const raw = (q.data ?? []) as Array<{
      metadata: { namespace?: string; creationTimestamp?: string }
      type: 'Normal' | 'Warning'
      reason: string
      message: string
      lastTimestamp?: string
      involvedObject: { kind: string; name: string; namespace?: string }
      source?: { component?: string }
      reportingComponent?: string
    }>
    return raw
      .filter((e) => e.type === 'Warning' || MUTATION_REASONS.has(e.reason))
      .map((e) => {
        const severity: AuditEvent['severity'] = /fail|error|forbidden|denied/i.test(e.reason)
          ? 'critical'
          : e.type === 'Warning'
            ? 'warning'
            : 'info'
        return {
          at: e.lastTimestamp ?? e.metadata.creationTimestamp ?? new Date().toISOString(),
          actor: e.source?.component ?? e.reportingComponent ?? 'system',
          action: e.reason,
          resource: `${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}`,
          tenant: e.involvedObject.namespace ?? e.metadata.namespace ?? '—',
          severity,
        }
      })
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 12)
  }, [q.data])

  const tones: Record<AuditEvent['severity'], { dot: string; pill: string }> = {
    info: { dot: 'bg-slate-400', pill: 'bg-slate-100 text-content-muted' },
    warning: { dot: 'bg-amber-500', pill: 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300' },
    critical: { dot: 'bg-rose-500', pill: 'bg-rose-100 dark:bg-rose-500/15 text-rose-800 dark:text-rose-300' },
  }

  const critical = events.filter((e) => e.severity === 'critical').length
  const warnings = events.filter((e) => e.severity === 'warning').length

  if (q.isLoading || q.isError || events.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Audit log" subtitle="Mutating cluster events" to="/settings" />
        {q.isLoading ? (
          <PanelLoading />
        ) : q.isError ? (
          <PanelError message="Could not reach the cluster" />
        ) : (
          <PanelEmpty message="No audit events" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead
        title="Audit log"
        subtitle={`${events.length} recent · ${critical} critical · ${warnings} warning`}
        to="/settings"
      />
      <ul className="flex-1 space-y-1 overflow-y-auto">
        {events.map((e, i) => (
          <li
            key={`${e.at}-${i}`}
            className="rounded-md border-l-2 border-l-edge-strong bg-surface-sunken/40 px-2.5 py-1.5"
            style={{
              borderLeftColor:
                e.severity === 'critical'
                  ? 'oklch(0.6 0.18 30)'
                  : e.severity === 'warning'
                    ? 'oklch(0.7 0.16 70)'
                    : 'oklch(0.7 0.02 260)',
            }}
          >
            <div className="flex items-center gap-2 text-[11px]">
              <span className={cn('h-1.5 w-1.5 flex-none rounded-full', tones[e.severity].dot)} />
              <span className="truncate font-mono text-content">{e.action}</span>
              <span
                className={cn(
                  'flex-none rounded-sm px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                  tones[e.severity].pill,
                )}
              >
                {e.severity}
              </span>
              <span className="ml-auto flex-none tabular-nums text-content-subtle">
                {formatRelative(e.at)}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-content-muted">{e.resource}</div>
            <div className="text-[10px] text-content-subtle">
              by {e.actor} · ns:{e.tenant}
            </div>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

/* ───── Backup status (Velero + CNPG) ───── */

interface BackupRow {
  name: string
  type: 'velero' | 'cnpg'
  scope: string
  finishedAt: string
  durationMin: number | null
  status: 'completed' | 'in-progress' | 'failed' | 'partial'
}

function durationMinutes(start?: string, end?: string): number | null {
  if (!start || !end) return null
  const d = (new Date(end).getTime() - new Date(start).getTime()) / 60_000
  return Number.isFinite(d) && d >= 0 ? Math.round(d) : null
}

export function BackupStatusPanel() {
  const veleroQ = useVeleroBackups()
  const cnpgSchedQ = useCnpgScheduledBackups()
  const cnpgQ = useCnpgBackups()

  const backups = useMemo<BackupRow[]>(() => {
    const velero = (veleroQ.data ?? []) as Array<
      Generic & {
        spec?: { includedNamespaces?: string[] }
        status?: { phase?: string; startTimestamp?: string; completionTimestamp?: string }
      }
    >
    const cnpg = (cnpgQ.data ?? []) as Array<
      Generic & {
        spec?: { cluster?: { name?: string } }
        status?: { phase?: string; startedAt?: string; stoppedAt?: string }
      }
    >
    const veleroStatus = (p?: string): BackupRow['status'] =>
      p === 'Completed'
        ? 'completed'
        : p === 'InProgress' || p === 'New'
          ? 'in-progress'
          : /partial/i.test(p ?? '')
            ? 'partial'
            : 'failed'
    const cnpgStatus = (p?: string): BackupRow['status'] =>
      p === 'completed'
        ? 'completed'
        : p === 'running' || p === 'started'
          ? 'in-progress'
          : p === 'failed'
            ? 'failed'
            : 'partial'
    const rows: BackupRow[] = [
      ...velero.map((b) => ({
        name: b.metadata.name,
        type: 'velero' as const,
        scope: b.spec?.includedNamespaces?.join(', ') || 'all-namespaces',
        finishedAt: b.status?.completionTimestamp ?? b.metadata.creationTimestamp ?? '',
        durationMin: durationMinutes(b.status?.startTimestamp, b.status?.completionTimestamp),
        status: veleroStatus(b.status?.phase),
      })),
      ...cnpg.map((b) => ({
        name: b.metadata.name,
        type: 'cnpg' as const,
        scope: b.spec?.cluster?.name ?? b.metadata.namespace ?? '—',
        finishedAt: b.status?.stoppedAt ?? b.metadata.creationTimestamp ?? '',
        durationMin: durationMinutes(b.status?.startedAt, b.status?.stoppedAt),
        status: cnpgStatus(b.status?.phase),
      })),
    ]
    return rows
      .sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime())
      .slice(0, 8)
  }, [veleroQ.data, cnpgQ.data])

  const scheduleCount = (cnpgSchedQ.data ?? []).length
  const completed = backups.filter((b) => b.status === 'completed').length
  const failed = backups.filter((b) => b.status === 'failed').length
  const partial = backups.filter((b) => b.status === 'partial').length

  const tones: Record<BackupRow['status'], { dot: string; pill: string; label: string }> = {
    completed: { dot: 'bg-emerald-500', pill: 'border-emerald-200 dark:border-emerald-500/25 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', label: 'OK' },
    'in-progress': { dot: 'bg-sky-500', pill: 'border-sky-200 dark:border-sky-500/25 bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300', label: 'Running' },
    failed: { dot: 'bg-rose-500', pill: 'border-rose-200 dark:border-rose-500/25 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300', label: 'Failed' },
    partial: { dot: 'bg-amber-500', pill: 'border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300', label: 'Partial' },
  }

  const loading = veleroQ.isLoading || cnpgQ.isLoading
  if (loading || backups.length === 0) {
    return (
      <PanelCard>
        <PanelHead title="Backup status" subtitle="Velero + CloudNativePG" to="/platform" />
        {loading ? (
          <PanelLoading />
        ) : (
          <PanelEmpty message="No backups found (requires Velero or CloudNativePG)" />
        )}
      </PanelCard>
    )
  }
  return (
    <PanelCard>
      <PanelHead
        title="Backup status"
        subtitle={`Velero + CloudNativePG · ${scheduleCount} schedule${scheduleCount === 1 ? '' : 's'}`}
        to="/platform"
      />
      <div className="mb-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Stat label="OK" value={completed} tone="emerald" />
        <Stat label="Partial" value={partial} tone={partial > 0 ? 'amber' : 'slate'} />
        <Stat label="Failed" value={failed} tone={failed > 0 ? 'rose' : 'slate'} />
      </div>
      <ul className="flex-1 space-y-1.5 overflow-y-auto">
        {backups.map((b) => {
          const t = tones[b.status]
          return (
            <li
              key={`${b.type}-${b.name}`}
              className="rounded-xl border border-edge-subtle bg-surface-sunken/40 p-2.5"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span className={cn('h-1.5 w-1.5 flex-none rounded-full', t.dot)} />
                <span className="truncate font-mono text-content">{b.name}</span>
                <span
                  className={cn(
                    'flex-none rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                    t.pill,
                  )}
                >
                  {t.label}
                </span>
                <span className="ml-auto flex-none rounded-sm bg-surface-raised px-1 py-0.5 text-[10px] uppercase tracking-wide text-content-muted ring-1 ring-edge-subtle">
                  {b.type}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-content-muted tabular-nums">
                <span className="truncate">scope:{b.scope}</span>
                {b.durationMin != null ? (
                  <>
                    <span>·</span>
                    <span>{b.durationMin}m</span>
                  </>
                ) : null}
                <span className="ml-auto text-content-subtle">
                  {b.finishedAt ? formatRelative(b.finishedAt) : '—'}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── Pipeline stage performance ───── */

interface StagePerf {
  name: string
  avgSec: number
  p95Sec: number
  failRate: number
}

/* ───── Workflow triggers + templates ───── */

interface Template {
  name: string
  uses7d: number
  avgDuration: string
  successRate: number
}


/* ───── helper ───── */

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}
