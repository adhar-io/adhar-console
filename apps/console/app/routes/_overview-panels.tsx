import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AreaChart,
  BarChart,
  HeatMap,
  Sparkline,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import {
  useAirbyteConnections,
  useBiDashboards,
  useBusinessKpis,
  useDefineSignals,
  useDeliverApplications,
  useDevelopPRs,
  useDevelopRepos,
  useDiscoverAlerts,
  useDiscoverSlos,
  useFalcoEvents,
  useGoldenSignals,
  usePostHogActivity,
  useTrivyReports,
} from '~/data/cross-module-signals.ts'

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
      <div className="grid grid-cols-3 gap-3">
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
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Open PRs" value={list.length} tone="amber" />
        <Stat label="Conflicts" value={conflicts} tone={conflicts ? 'rose' : 'slate'} />
        <Stat label="Repos" value={repos.data?.length ?? 0} tone="brand" />
      </div>
      {list.length > 0 ? (
        <ul className="mt-3 divide-y divide-edge-subtle rounded-lg border border-edge-subtle bg-white">
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
      <div className="grid grid-cols-3 gap-3">
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
      <div className="grid grid-cols-3 gap-3">
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
      <div className="grid grid-cols-4 gap-2">
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
      <PanelHead title="Alerts" subtitle="Alertmanager · live" to="/discover?alerts" />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Firing" value={firing.length} tone={firing.length ? 'rose' : 'emerald'} />
        <Stat label="Critical" value={critical} tone={critical ? 'rose' : 'slate'} />
        <Stat label="Pending" value={list.filter((a) => a.state === 'pending').length} tone="amber" />
      </div>
      <ul className="mt-3 space-y-1">
        {firing.slice(0, 3).map((a) => (
          <li
            key={a.fingerprint}
            className="rounded-md border border-rose-200/70 bg-rose-50/40 px-2 py-1.5 text-[11px]"
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

/* ───── Discover · SLO health ───── */

export function SloPanel() {
  const q = useDiscoverSlos()
  const list = q.data ?? []
  const meeting = list.filter((s) => s.current >= s.objective).length
  const burning = list.filter((s) => s.errorBudgetRemaining < 0.5).length
  const minBudget =
    list.length > 0 ? Math.min(...list.map((s) => s.errorBudgetRemaining * 100)) : 100
  return (
    <PanelCard>
      <PanelHead title="SLO health" subtitle={`${list.length} objectives`} to="/discover?slos" />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Meeting" value={meeting} tone="emerald" />
        <Stat label="Burning" value={burning} tone={burning ? 'rose' : 'slate'} />
        <Stat label="Min budget" value={`${minBudget.toFixed(0)}%`} tone={minBudget < 30 ? 'rose' : minBudget < 70 ? 'amber' : 'emerald'} />
      </div>
      <ul className="mt-3 space-y-1.5">
        {list.slice(0, 3).map((s) => {
          const meetingThis = s.current >= s.objective
          return (
            <li
              key={s.name}
              className="rounded-md border border-edge-subtle bg-surface-sunken/40 px-2 py-1.5 text-[11px]"
            >
              <div className="flex items-center justify-between">
                <span className="truncate font-medium text-content">{s.name}</span>
                <span className={`font-mono tabular-nums ${meetingThis ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {s.current.toFixed(2)}%
                </span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={`h-full ${meetingThis ? 'bg-emerald-500' : 'bg-rose-500'}`}
                  style={{ width: `${Math.max(0, Math.min(100, s.current))}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── Discover · golden signals ───── */

export function GoldenSignalsPanel() {
  const { rps, errors, p95 } = useGoldenSignals()
  const rpsTotal = sumLastValues(rps.data ?? [])
  const errAvg = avgLastValues(errors.data ?? [])
  const p95Max = maxLastValues(p95.data ?? [])
  return (
    <PanelCard>
      <PanelHead title="Golden signals" subtitle="Last hour · all services" to="/discover?metrics" />
      <div className="grid grid-cols-3 gap-3">
        <SignalTile
          label="RPS"
          value={rpsTotal.toFixed(0)}
          series={rps.data?.[0]?.values.map(([, v]) => Number(v)) ?? []}
          color="var(--color-brand-500)"
        />
        <SignalTile
          label="Errors"
          value={`${errAvg.toFixed(2)}%`}
          series={errors.data?.[0]?.values.map(([, v]) => Number(v)) ?? []}
          color="var(--color-rose-500)"
        />
        <SignalTile
          label="p95"
          value={`${p95Max.toFixed(0)}ms`}
          series={p95.data?.[0]?.values.map(([, v]) => Number(v)) ?? []}
          color="var(--color-amber-500)"
        />
      </div>
    </PanelCard>
  )
}

/* ───── Discover · runtime (Falco) ───── */

export function RuntimePanel() {
  const q = useFalcoEvents()
  const list = q.data ?? []
  const critical = list.filter(
    (e) => e.priority === 'Critical' || e.priority === 'Alert' || e.priority === 'Emergency',
  ).length
  return (
    <PanelCard>
      <PanelHead title="Runtime · 6h" subtitle="Falco events" to="/discover?runtime" />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Total" value={list.length} tone="brand" />
        <Stat label="Critical" value={critical} tone={critical ? 'rose' : 'slate'} />
        <Stat label="Warnings" value={list.filter((e) => e.priority === 'Warning').length} tone="amber" />
      </div>
      <ul className="mt-3 space-y-1">
        {list.slice(0, 3).map((e) => (
          <li
            key={e.id}
            className="rounded-md border border-edge-subtle bg-surface-sunken/40 px-2 py-1.5 text-[11px]"
          >
            <div className="flex items-center gap-2">
              <StatusBadge
                kind={
                  e.priority === 'Critical' || e.priority === 'Alert' || e.priority === 'Emergency'
                    ? 'failed'
                    : e.priority === 'Error'
                      ? 'degraded'
                      : 'progressing'
                }
              >
                {e.priority.toLowerCase()}
              </StatusBadge>
              <span className="truncate font-medium text-content">{e.rule}</span>
            </div>
            <div className="mt-0.5 text-[10px] text-content-subtle">
              {formatRelative(e.timestamp)}
            </div>
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
    <div className="rounded-lg border border-edge-subtle bg-linear-to-br from-brand-50/40 to-white p-3 ring-1 ring-inset ring-edge-subtle">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {q.name}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums text-content">{formatted}</span>
        {q.scalar_delta != null ? (
          <span
            className={`font-mono text-[10px] tabular-nums ${
              delta >= 0 ? 'text-emerald-700' : 'text-rose-700'
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
              {d.cards.length} cards · {d.view_count ?? 0} views
            </span>
          </li>
        ))}
      </ul>
    </PanelCard>
  )
}

/* ───── Cost trend · 30-day spend ───── */

export function CostTrendPanel() {
  const series = useMemo(() => buildCostSeries(30), [])
  const total = series.reduce((s, v) => s + v, 0)
  const previousTotal = series.slice(0, 15).reduce((s, v) => s + v, 0)
  const recentTotal = series.slice(15).reduce((s, v) => s + v, 0)
  const delta = previousTotal === 0 ? 0 : (recentTotal - previousTotal) / previousTotal
  const peak = Math.max(...series)
  const peakIdx = series.indexOf(peak)
  const peakDate = relDay(29 - peakIdx)
  return (
    <PanelCard>
      <PanelHead title="Cloud spend · 30 days" subtitle="All providers · USD" to="/settings?section=allocation" />
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
            ${(total / 1000).toFixed(1)}k
          </div>
          <div className={cn('mt-0.5 text-[11px] font-medium', delta > 0 ? 'text-rose-700' : 'text-emerald-700')}>
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
          <span>{relDay(29)}</span>
          <span>today</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-edge-subtle pt-3 text-[11px]">
        <CostBreak label="Compute" value={Math.round(total * 0.55)} share={55} />
        <CostBreak label="Storage" value={Math.round(total * 0.22)} share={22} />
        <CostBreak label="Network" value={Math.round(total * 0.23)} share={23} />
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

function buildCostSeries(days: number): number[] {
  // Stable pseudo-random: deterministic per-position so the chart doesn't
  // flicker on re-render. A real BFF call replaces this in prod.
  const out: number[] = []
  for (let i = 0; i < days; i++) {
    const base = 800 + Math.sin(i / 3.1) * 120 + Math.cos(i / 7.5) * 60
    const jitter = ((i * 9301 + 49297) % 233) / 233
    out.push(Math.max(120, base + jitter * 220 + i * 4))
  }
  return out
}

function relDay(daysAgo: number): string {
  if (daysAgo === 0) return 'today'
  if (daysAgo === 1) return 'yesterday'
  return `${daysAgo}d ago`
}

/* ───── Deploy heatmap · 12-week deploy frequency ───── */

export function DeployHeatmapPanel() {
  const cells = useMemo(() => buildDeployCells(12), [])
  const total = cells.reduce((s, v) => s + v, 0)
  const peak = Math.max(...cells)
  const active = cells.filter((c) => c > 0).length
  const dayLabels = ['Mon', 'Wed', 'Fri']
  return (
    <PanelCard>
      <PanelHead title="Deploys · last 12 weeks" subtitle="GitOps releases per day" to="/deliver?section=releases" />
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
            {total}
          </div>
          <div className="text-[11px] text-content-muted">
            {active}/84 active days · peak {peak}/day
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

function buildDeployCells(weeks: number): number[] {
  const total = 7 * weeks
  const out: number[] = []
  for (let i = 0; i < total; i++) {
    const day = i % 7
    // Lower activity on weekends.
    const weekendBias = day === 5 || day === 6 ? 0.2 : 1
    const seed = ((i * 73) % 97) / 97
    const v = seed * weekendBias
    out.push(v < 0.18 ? 0 : v)
  }
  return out
}

/* ───── Latency distribution · histogram with p50/p95/p99 ───── */

export function LatencyDistributionPanel() {
  const buckets = useMemo(() => buildLatencyBuckets(), [])
  const total = buckets.reduce((s, b) => s + b.count, 0)
  const p50 = percentile(buckets, total, 0.5)
  const p95 = percentile(buckets, total, 0.95)
  const p99 = percentile(buckets, total, 0.99)
  const peakIdx = buckets.findIndex((b) => b.count === Math.max(...buckets.map((x) => x.count)))
  return (
    <PanelCard>
      <PanelHead title="Latency · request distribution" subtitle="Last 1h · all services" to="/discover?section=metrics" />
      <div className="grid grid-cols-3 gap-2">
        <PercentileTile label="p50" ms={p50.ms} tone="emerald" />
        <PercentileTile label="p95" ms={p95.ms} tone={p95.ms > 500 ? 'amber' : 'brand'} />
        <PercentileTile label="p99" ms={p99.ms} tone={p99.ms > 1000 ? 'rose' : 'amber'} />
      </div>
      <div className="mt-3 relative">
        <div className="flex h-28 items-end gap-[2px]">
          {buckets.map((b, i) => {
            const max = Math.max(...buckets.map((x) => x.count))
            const h = (b.count / max) * 100
            const isPeak = i === peakIdx
            return (
              <div
                key={i}
                className={cn('flex-1 rounded-t-sm transition-[height] duration-500', isPeak ? 'bg-brand-600' : 'bg-brand-400/70')}
                style={{ height: `${Math.max(2, h)}%` }}
                title={`${b.label}: ${b.count}`}
              />
            )
          })}
        </div>
        {/* p50/p95/p99 markers */}
        <PercentileMarker buckets={buckets} idx={p50.idx} label="p50" tone="emerald" />
        <PercentileMarker buckets={buckets} idx={p95.idx} label="p95" tone="amber" />
        <PercentileMarker buckets={buckets} idx={p99.idx} label="p99" tone="rose" />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-content-subtle">
        <span>0ms</span>
        <span>{buckets[buckets.length - 1].edge}ms+</span>
      </div>
    </PanelCard>
  )
}

interface LatencyBucket {
  label: string
  edge: number
  count: number
}

function buildLatencyBuckets(): LatencyBucket[] {
  // Log-bucketed edges: 10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400.
  const edges = [10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400]
  // Skewed-right distribution centred ~80ms.
  const counts = [120, 380, 920, 1480, 1120, 540, 220, 90, 30, 8]
  return edges.map((e, i) => ({ label: `${e}`, edge: e, count: counts[i] }))
}

function percentile(buckets: LatencyBucket[], total: number, q: number): { ms: number; idx: number } {
  const target = total * q
  let acc = 0
  for (let i = 0; i < buckets.length; i++) {
    acc += buckets[i].count
    if (acc >= target) {
      return { ms: buckets[i].edge, idx: i }
    }
  }
  return { ms: buckets[buckets.length - 1].edge, idx: buckets.length - 1 }
}

function PercentileTile({
  label,
  ms,
  tone,
}: {
  label: string
  ms: number
  tone: 'emerald' | 'amber' | 'rose' | 'brand'
}) {
  const color =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'amber'
        ? 'text-amber-700'
        : tone === 'rose'
          ? 'text-rose-700'
          : 'text-brand-700'
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/60 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className={cn('mt-0.5 font-mono text-base font-semibold tabular-nums', color)}>
        {ms}ms
      </div>
    </div>
  )
}

function PercentileMarker({
  buckets,
  idx,
  label,
  tone,
}: {
  buckets: LatencyBucket[]
  idx: number
  label: string
  tone: 'emerald' | 'amber' | 'rose'
}) {
  const left = ((idx + 0.5) / buckets.length) * 100
  const colorClass =
    tone === 'emerald' ? 'border-emerald-500 text-emerald-700' : tone === 'amber' ? 'border-amber-500 text-amber-700' : 'border-rose-500 text-rose-700'
  return (
    <div
      className={cn(
        'pointer-events-none absolute -top-2 -translate-x-1/2 rounded-md border bg-white px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider shadow-sm',
        colorClass,
      )}
      style={{ left: `${left}%` }}
    >
      {label}
    </div>
  )
}

/* ───── Service topology · mini graph ───── */

export function ServiceTopologyPanel() {
  // Hand-curated 8-node mesh that reads cleanly at the panel size.
  const nodes: TopologyNode[] = [
    { id: 'gw', label: 'gateway', x: 60, y: 60, health: 'healthy' },
    { id: 'api', label: 'api', x: 180, y: 60, health: 'healthy' },
    { id: 'auth', label: 'auth', x: 180, y: 130, health: 'healthy' },
    { id: 'pay', label: 'payments', x: 300, y: 30, health: 'degraded' },
    { id: 'orders', label: 'orders', x: 300, y: 100, health: 'healthy' },
    { id: 'pg', label: 'postgres', x: 420, y: 60, health: 'healthy' },
    { id: 'cache', label: 'redis', x: 420, y: 140, health: 'healthy' },
    { id: 'feed', label: 'feed', x: 60, y: 130, health: 'failed' },
  ]
  const edges: [string, string][] = [
    ['gw', 'api'],
    ['gw', 'auth'],
    ['api', 'pay'],
    ['api', 'orders'],
    ['orders', 'pg'],
    ['pay', 'pg'],
    ['orders', 'cache'],
    ['feed', 'gw'],
  ]
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const HEALTH_COLOR: Record<TopologyNode['health'], string> = {
    healthy: 'var(--color-brand-500)',
    degraded: '#f59e0b',
    failed: '#f43f5e',
  }
  return (
    <PanelCard>
      <PanelHead title="Service topology" subtitle="8 services · live health" to="/discover?section=servicemap" />
      <div className="overflow-hidden rounded-xl border border-edge-subtle bg-surface-sunken/40 p-2">
        <svg viewBox="0 0 480 180" preserveAspectRatio="xMidYMid meet" className="h-full w-full">
          <defs>
            <pattern id="topo-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(15,23,42,0.05)" strokeWidth="1" />
            </pattern>
            <marker id="topo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill="rgba(15,23,42,0.4)" />
            </marker>
          </defs>
          <rect width="100%" height="100%" fill="url(#topo-grid)" />
          {edges.map(([a, b], i) => {
            const sa = byId[a]
            const sb = byId[b]
            return (
              <line
                key={i}
                x1={sa.x}
                y1={sa.y}
                x2={sb.x}
                y2={sb.y}
                stroke="rgba(15,23,42,0.32)"
                strokeWidth="1.5"
                markerEnd="url(#topo-arrow)"
              />
            )
          })}
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

/* ───── Team activity · 24×7 commits-per-hour heatmap ───── */

export function TeamActivityPanel() {
  const cells = useMemo(() => buildActivityCells(), [])
  const total = cells.reduce((s, v) => s + v, 0)
  const peak = Math.max(...cells)
  const peakIdx = cells.indexOf(peak)
  const peakDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Math.floor(peakIdx / 24)]
  const peakHour = peakIdx % 24
  return (
    <PanelCard>
      <PanelHead title="Team activity" subtitle="Commits by day × hour · 7-day window" to="/develop?section=commits" />
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
            {total.toLocaleString()}
          </div>
          <div className="text-[11px] text-content-muted">
            commits · peak {peakDay} {String(peakHour).padStart(2, '0')}:00
          </div>
        </div>
        <div className="font-mono text-[10px] text-content-subtle">UTC</div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <ActivityHeatmap cells={cells} />
      </div>
    </PanelCard>
  )
}

function buildActivityCells(): number[] {
  // 7 days × 24 hours. Activity peaks weekdays 10–16 UTC.
  const out: number[] = []
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const isWeekday = d > 0 && d < 6
      const officeHours = h >= 9 && h <= 17
      const base = isWeekday ? (officeHours ? 7 : 1) : 1
      const seed = ((d * 31 + h * 13) % 11) / 11
      const v = base + Math.round(seed * 6 * (officeHours ? 1 : 0.4))
      out.push(v)
    }
  }
  return out
}

function ActivityHeatmap({ cells }: { cells: number[] }) {
  const max = Math.max(1, ...cells)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return (
    <div className="inline-flex flex-col gap-[3px]">
      <div className="ml-7 flex gap-[3px] font-mono text-[8px] text-content-subtle">
        {Array.from({ length: 24 }).map((_, h) => (
          <span key={h} className="inline-block w-3 text-center">
            {h % 6 === 0 ? h.toString().padStart(2, '0') : ''}
          </span>
        ))}
      </div>
      {days.map((day, d) => (
        <div key={day} className="flex items-center gap-[3px]">
          <span className="w-6 font-mono text-[9px] text-content-subtle">{day}</span>
          {Array.from({ length: 24 }).map((_, h) => {
            const v = cells[d * 24 + h]
            const intensity = v / max
            const opacity = intensity === 0 ? 0.06 : 0.15 + intensity * 0.85
            return (
              <span
                key={h}
                title={`${day} ${String(h).padStart(2, '0')}:00 — ${v} commits`}
                className="inline-block h-3 w-3 rounded-[2px] transition-transform hover:scale-125"
                style={{ backgroundColor: 'var(--color-brand-500)', opacity }}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

/* ───── Region spread · pods per region ───── */

export function RegionSpreadPanel() {
  const regions = [
    { name: 'us-east-1', label: 'US East (Virginia)', cloud: 'AWS', pods: 184, percent: 38 },
    { name: 'eu-west-1', label: 'EU West (Ireland)', cloud: 'AWS', pods: 122, percent: 25 },
    { name: 'us-central1', label: 'US Central (Iowa)', cloud: 'GCP', pods: 86, percent: 18 },
    { name: 'ap-south-1', label: 'AP South (Mumbai)', cloud: 'AWS', pods: 60, percent: 12 },
    { name: 'fra-dc-2', label: 'On-prem (Frankfurt)', cloud: 'On-prem', pods: 32, percent: 7 },
  ]
  const total = regions.reduce((s, r) => s + r.pods, 0)
  return (
    <PanelCard>
      <PanelHead title="Geographic spread" subtitle="Pods · live across all clusters" to="/platform?section=clusters" />
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
            {total}
          </div>
          <div className="text-[11px] text-content-muted">
            pods · {regions.length} regions · {new Set(regions.map((r) => r.cloud)).size} clouds
          </div>
        </div>
        <span className="rounded-md bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700">
          multi-cloud
        </span>
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

/* ───── DORA radar · 4-axis maturity vs elite benchmark ───── */

export function DoraRadarPanel() {
  // Each metric normalised to 0..1 — higher always = better.
  const metrics = [
    { label: 'Deploy freq.', value: 0.78, raw: '12.4 / day', target: 1.0 },
    { label: 'Lead time', value: 0.62, raw: '4h 30m', target: 1.0 },
    { label: 'Change-fail rate', value: 0.55, raw: '4.2%', target: 1.0 },
    { label: 'MTTR', value: 0.71, raw: '32m', target: 1.0 },
  ]
  const tier = elitTier(metrics)
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
                tier === 'Elite' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : tier === 'High' ? 'bg-sky-50 text-sky-700 ring-sky-200' : 'bg-amber-50 text-amber-700 ring-amber-200',
              )}
            >
              {tier}
            </span>
            <span className="text-[11px] text-content-muted">
              avg {(metrics.reduce((s, m) => s + m.value, 0) / metrics.length * 100).toFixed(0)}% of elite
            </span>
          </div>
          {metrics.map((m) => (
            <div key={m.label}>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-content">{m.label}</span>
                <span className="font-mono tabular-nums text-content-muted">{m.raw}</span>
              </div>
              <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className="h-full bg-linear-to-r from-brand-500 to-brand-400"
                  style={{ width: `${Math.min(100, m.value * 100)}%` }}
                />
              </div>
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

function elitTier(metrics: RadarMetric[]): 'Elite' | 'High' | 'Medium' {
  const avg = metrics.reduce((s, m) => s + m.value, 0) / metrics.length
  if (avg >= 0.85) return 'Elite'
  if (avg >= 0.6) return 'High'
  return 'Medium'
}

/* ───── Pipeline funnel · commits → builds → tests → deploys → prod ───── */

export function PipelineFunnelPanel() {
  const stages = [
    { label: 'Commits', value: 482, color: 'oklch(0.71 0.13 262)' },
    { label: 'Builds', value: 426, color: 'oklch(0.66 0.14 250)' },
    { label: 'Tests passed', value: 392, color: 'oklch(0.62 0.16 230)' },
    { label: 'Deploys', value: 311, color: 'oklch(0.58 0.18 215)' },
    { label: 'Promoted to prod', value: 142, color: 'oklch(0.54 0.18 200)' },
  ]
  const max = stages[0].value
  return (
    <PanelCard>
      <PanelHead title="Delivery funnel · 7d" subtitle="Commits to production" to="/deliver?section=releases" />
      <div className="flex flex-col gap-1.5">
        {stages.map((s, i) => {
          const pct = (s.value / max) * 100
          const conversion = i === 0 ? 100 : Math.round((s.value / stages[i - 1].value) * 100)
          const dropped = i === 0 ? 0 : stages[i - 1].value - s.value
          return (
            <div key={s.label} className="space-y-0.5">
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="font-medium text-content">{s.label}</span>
                <span className="font-mono tabular-nums text-content-muted">
                  {s.value.toLocaleString()}
                  <span className="ml-2 text-content-subtle">{conversion}%</span>
                </span>
              </div>
              <div
                className="relative h-7 overflow-hidden rounded-md transition-all"
                style={{
                  width: `${Math.max(20, pct)}%`,
                  background: `linear-gradient(90deg, ${s.color} 0%, color-mix(in oklch, ${s.color} 65%, white) 100%)`,
                }}
              >
                {dropped > 0 ? (
                  <span className="absolute inset-y-0 right-2 flex items-center font-mono text-[10px] font-semibold text-white/85">
                    -{dropped}
                  </span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-baseline justify-between border-t border-edge-subtle pt-2 text-[11px]">
        <span className="text-content-subtle">End-to-end conversion</span>
        <span className="font-mono tabular-nums font-semibold text-content">
          {Math.round((stages[stages.length - 1].value / stages[0].value) * 100)}%
        </span>
      </div>
    </PanelCard>
  )
}

/* ───── Traffic stream · stacked area RPS by top service ───── */

export function TrafficStreamPanel() {
  const series = useMemo(() => buildTrafficSeries(), [])
  const totals = series[0].points.map((_, i) =>
    series.reduce((s, srv) => s + srv.points[i], 0),
  )
  const peak = Math.max(...totals)
  return (
    <PanelCard>
      <PanelHead title="Traffic · top services" subtitle="RPS over last hour · stacked" to="/discover?section=metrics" />
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
            {Math.round(totals[totals.length - 1])}
            <span className="ml-1 text-sm font-normal text-content-muted">rps</span>
          </div>
          <div className="text-[11px] text-content-muted">peak {Math.round(peak)} rps · last hour</div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1 text-[10px] text-content-muted">
              <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3">
        <StackedAreaChart series={series} height={120} />
        <div className="mt-1 flex items-baseline justify-between text-[10px] text-content-subtle">
          <span>−60m</span>
          <span>−30m</span>
          <span>now</span>
        </div>
      </div>
    </PanelCard>
  )
}

interface StackedSeries { label: string; color: string; points: number[] }

function buildTrafficSeries(): StackedSeries[] {
  const N = 60
  // Synthetic but stable per-position values so the chart doesn't flicker.
  const wave = (phase: number, base: number, amp: number) =>
    Array.from({ length: N }, (_, i) => base + Math.sin((i + phase) / 5) * amp + (((i * 17) % 11) / 11) * amp * 0.4)
  return [
    { label: 'gateway', color: 'oklch(0.62 0.18 262)', points: wave(0, 220, 60) },
    { label: 'api', color: 'oklch(0.7 0.14 230)', points: wave(2, 140, 40) },
    { label: 'orders', color: 'oklch(0.74 0.12 200)', points: wave(4, 90, 28) },
    { label: 'payments', color: 'oklch(0.78 0.1 170)', points: wave(6, 50, 18) },
  ]
}

function StackedAreaChart({ series, height }: { series: StackedSeries[]; height: number }) {
  if (!series.length || !series[0].points.length) return null
  const W = 320
  const H = height
  const N = series[0].points.length
  // Compute cumulative stacks per position.
  const stack: number[][] = []
  for (let i = 0; i < N; i++) {
    let acc = 0
    const col: number[] = []
    for (const s of series) {
      col.push(acc)
      acc += s.points[i]
    }
    col.push(acc) // top
    stack.push(col)
  }
  const totals = stack.map((c) => c[c.length - 1])
  const max = Math.max(1, ...totals)
  const x = (i: number) => (i / (N - 1)) * W
  const y = (v: number) => H - (v / max) * (H - 4) - 2
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full" style={{ height }}>
      {series.map((s, idx) => {
        const top = stack.map((col, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(col[idx + 1]).toFixed(1)}`).join(' ')
        const bottom = stack
          .slice()
          .reverse()
          .map((col, j) => {
            const i = N - 1 - j
            return `L${x(i).toFixed(1)},${y(col[idx]).toFixed(1)}`
          })
          .join(' ')
        return <path key={s.label} d={`${top} ${bottom} Z`} fill={s.color} fillOpacity="0.85" />
      })}
    </svg>
  )
}

/* ───── Storage treemap · namespace distribution ───── */

export function StorageTreemapPanel() {
  const items = [
    { label: 'data', value: 1240, color: 'oklch(0.62 0.18 262)' },
    { label: 'monitoring', value: 760, color: 'oklch(0.66 0.14 230)' },
    { label: 'logs', value: 540, color: 'oklch(0.7 0.13 200)' },
    { label: 'backups', value: 380, color: 'oklch(0.74 0.11 170)' },
    { label: 'argocd', value: 220, color: 'oklch(0.74 0.13 30)' },
    { label: 'kyverno', value: 140, color: 'oklch(0.72 0.14 350)' },
    { label: 'misc', value: 90, color: 'oklch(0.7 0.02 260)' },
  ]
  const total = items.reduce((s, i) => s + i.value, 0)
  const W = 320
  const H = 180
  const rects = squarify(items, 0, 0, W, H)
  return (
    <PanelCard>
      <PanelHead title="Storage · by namespace" subtitle="PVC + object usage · GB" to="/platform?section=storage" />
      <div className="flex items-baseline justify-between">
        <div className="text-2xl font-semibold tabular-nums tracking-tight text-content">
          {(total / 1024).toFixed(1)} TB
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
                      {item.value} GB · {Math.round((item.value / total) * 100)}%
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

/* ───── Service health grid · 12 mini sparklines ───── */

export function ServiceHealthGridPanel() {
  const services = useMemo(() => buildServiceTiles(), [])
  return (
    <PanelCard>
      <PanelHead title="Service health · grid" subtitle="p95 latency · last 30 minutes" to="/discover?section=servicemap" />
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {services.map((s) => {
          const last = s.points[s.points.length - 1]
          const tone =
            s.health === 'healthy' ? 'bg-emerald-500' : s.health === 'degraded' ? 'bg-amber-500' : 'bg-rose-500'
          const color =
            s.health === 'healthy' ? 'var(--color-brand-500)' : s.health === 'degraded' ? '#f59e0b' : '#f43f5e'
          return (
            <div
              key={s.name}
              className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="flex items-center gap-1.5 truncate">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone)} />
                  <code className="truncate font-mono text-[10px] text-content">{s.name}</code>
                </span>
                <span className="font-mono text-[10px] tabular-nums text-content-muted">
                  {Math.round(last)}ms
                </span>
              </div>
              <Sparkline points={s.points} color={color} height={24} strokeWidth={1.25} />
            </div>
          )
        })}
      </div>
    </PanelCard>
  )
}

interface ServiceTile { name: string; points: number[]; health: 'healthy' | 'degraded' | 'failed' }

function buildServiceTiles(): ServiceTile[] {
  const names = ['gateway', 'api', 'auth', 'orders', 'payments', 'feed', 'search', 'recs', 'mailer', 'billing', 'reports', 'jobs']
  return names.map((name, i) => {
    const N = 24
    const base = 50 + (i * 13) % 80
    const amp = 20 + (i * 7) % 30
    const spike = i === 4 ? 2.5 : i === 7 ? 1.6 : 1
    const points = Array.from({ length: N }, (_, k) => base + Math.sin((k + i) / 2.5) * amp + (((k * 11 + i) % 17) / 17) * amp * 0.6 * spike)
    const last = points[points.length - 1]
    const health: ServiceTile['health'] = last > 220 ? 'failed' : last > 110 ? 'degraded' : 'healthy'
    return { name, points, health }
  })
}

/* ───── Budget bullet · target vs actual per cost center ───── */

export function BudgetBulletPanel() {
  const items = [
    { label: 'R&D Engineering', code: 'CC-100', actual: 8412, target: 12000, prior: 11920 },
    { label: 'Data & Analytics', code: 'CC-200', actual: 4980, target: 6500, prior: 6210 },
    { label: 'Customer Ops', code: 'CC-300', actual: 1430, target: 3200, prior: 2980 },
    { label: 'Corporate IT', code: 'CC-900', actual: 1620, target: 1800, prior: 1740 },
  ]
  return (
    <PanelCard>
      <PanelHead title="Budget · MTD vs target" subtitle="Cost center performance · USD" to="/settings?section=budgets" />
      <div className="space-y-3">
        {items.map((it) => (
          <Bullet key={it.code} item={it} />
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
    ratio > 1 ? 'text-rose-700' : ratio > 0.9 ? 'text-amber-700' : 'text-content-muted'
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
      <div className="relative mt-1 h-2.5 overflow-hidden rounded-full bg-rose-100">
        {/* warn band */}
        <div className="absolute inset-y-0 left-0 bg-amber-100" style={{ width: `${warn}%` }} />
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

function PanelCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-edge-default bg-white p-5 shadow-sm transition-shadow hover:shadow">
      {children}
    </div>
  )
}

function PanelHead({
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
      <Link
        to={to}
        className="shrink-0 text-[11px] font-medium text-brand-700 hover:text-brand-800 hover:underline"
      >
        Open →
      </Link>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone: 'emerald' | 'amber' | 'rose' | 'slate' | 'brand' | 'violet'
}) {
  const toneText = {
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    rose: 'text-rose-700',
    slate: 'text-content',
    brand: 'text-brand-700',
    violet: 'text-violet-700',
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
    rose: 'bg-rose-50 text-rose-700',
    amber: 'bg-amber-50 text-amber-700',
    sky: 'bg-sky-50 text-sky-700',
    slate: 'bg-slate-50 text-slate-700',
  }[tone]
  return (
    <div className={`rounded-md p-2 text-center ${cls}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function SignalTile({
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
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          {label}
        </span>
        <span className="text-base font-semibold tabular-nums text-content">{value}</span>
      </div>
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
function avgLastValues(arr: MetricSeries[]): number {
  if (!arr.length) return 0
  return sumLastValues(arr) / arr.length
}
function maxLastValues(arr: MetricSeries[]): number {
  return arr.reduce((m, s) => Math.max(m, lastValue(s)), 0)
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
  const golden = useGoldenSignals()
  const apps = useDeliverApplications()
  const slos = useDiscoverSlos()
  const trivy = useTrivyReports()

  // Sub-scores 0–100, each computed from the relevant module signal.
  const reliability = useMemo(() => {
    const ok = (apps.data ?? []).filter((a) => a.health === 'Healthy' && a.sync === 'Synced').length
    const total = (apps.data ?? []).length
    if (total === 0) return 95
    return Math.round((ok / total) * 100)
  }, [apps.data])

  const slo = useMemo(() => {
    const list = slos.data ?? []
    if (list.length === 0) return 92
    const passing = list.filter((s) => (s.errorBudgetRemaining ?? 0) > 0.25).length
    return Math.round((passing / list.length) * 100)
  }, [slos.data])

  const security = useMemo(() => {
    const reports = trivy.data ?? []
    const crit = reports.reduce((acc, r) => acc + (r.summary?.CRITICAL ?? 0), 0)
    const high = reports.reduce((acc, r) => acc + (r.summary?.HIGH ?? 0), 0)
    return Math.max(0, 100 - crit * 8 - high * 2)
  }, [trivy.data])

  const performance = useMemo(() => {
    const series = golden.data ?? []
    const errs = series.filter((s) => /error|5xx/i.test(s.metric.__name__ ?? ''))
    const errAvg = avgLastValues(errs)
    const score = errAvg > 0 ? Math.max(40, 100 - Math.round(errAvg * 1000)) : 96
    return Math.min(100, score)
  }, [golden.data])

  const overall = Math.round((reliability + slo + security + performance) / 4)
  const tone = overall >= 90 ? 'emerald' : overall >= 75 ? 'brand' : overall >= 60 ? 'amber' : 'rose'

  return (
    <PanelCard>
      <PanelHead title="Platform health" subtitle="Reliability · SLOs · security · perf" to="/decide" />
      <div className="grid flex-1 grid-cols-1 items-center gap-5 sm:grid-cols-[auto_1fr]">
        <RadialScore value={overall} tone={tone} />
        <div className="grid grid-cols-2 gap-3">
          <SubScore label="Reliability" value={reliability} icon={<IconShield />} />
          <SubScore label="SLO health" value={slo} icon={<IconTarget />} />
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
  value: number
  tone: 'emerald' | 'brand' | 'amber' | 'rose'
}) {
  const r = 64
  const stroke = 12
  const c = 2 * Math.PI * r
  const offset = c - (Math.max(0, Math.min(100, value)) / 100) * c
  const ring = {
    emerald: 'stroke-emerald-500',
    brand: 'stroke-brand-500',
    amber: 'stroke-amber-500',
    rose: 'stroke-rose-500',
  }[tone]
  const text = {
    emerald: 'text-emerald-700',
    brand: 'text-brand-700',
    amber: 'text-amber-700',
    rose: 'text-rose-700',
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
          {value}
        </div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-content-subtle">
          / 100
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
  value: number
  icon: React.ReactNode
}) {
  const tone = value >= 90 ? 'emerald' : value >= 75 ? 'brand' : value >= 60 ? 'amber' : 'rose'
  const bar = {
    emerald: 'bg-emerald-500',
    brand: 'bg-brand-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
  }[tone]
  const swatch = {
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200/60',
    brand: 'bg-brand-50 text-brand-700 ring-brand-200/60',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200/60',
    rose: 'bg-rose-50 text-rose-700 ring-rose-200/60',
  }[tone]
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('inline-flex h-5 w-5 items-center justify-center rounded-md ring-1', swatch)}>
            {icon}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            {label}
          </span>
        </span>
        <span className="font-mono text-sm font-semibold tabular-nums text-content">{value}</span>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={cn('h-full rounded-full transition-[width]', bar)}
          style={{ width: `${value}%`, transitionDuration: '500ms' }}
        />
      </div>
    </div>
  )
}

/* ───────────────────────────────────────────────────────────
 * Engineering Velocity — sparkline grid of key flow metrics
 * ─────────────────────────────────────────────────────────── */

export function EngineeringVelocityPanel() {
  // Synthesise plausible 14-day values for each metric. In production this
  // would come from a /metrics aggregation BFF endpoint.
  const tracks = useMemo(() => {
    const seed = (a: number, b: number, c: number) => {
      const out: number[] = []
      let v = a
      for (let i = 0; i < 14; i++) {
        v += (Math.sin(i * b) + Math.cos(i * c)) * 2
        out.push(Math.max(0, Math.round(v + i * 0.4)))
      }
      return out
    }
    return [
      {
        id: 'prs',
        label: 'PRs merged',
        unit: '/wk',
        series: seed(38, 0.5, 0.7),
        tone: 'brand' as const,
        icon: <IconGitMerge />,
      },
      {
        id: 'deploys',
        label: 'Deploys',
        unit: '/wk',
        series: seed(22, 0.7, 1.1),
        tone: 'emerald' as const,
        icon: <IconRocket />,
      },
      {
        id: 'leadtime',
        label: 'Lead time',
        unit: 'h',
        series: seed(14, 0.6, 0.8).map((v) => Math.max(2, 18 - v * 0.05)),
        tone: 'sky' as const,
        icon: <IconClockSm />,
      },
      {
        id: 'incidents',
        label: 'Incidents',
        unit: '/wk',
        series: seed(3, 0.4, 0.6).map((v) => Math.max(0, 3 + Math.round((v - 30) / 10))),
        tone: 'amber' as const,
        icon: <IconAlertSm />,
      },
    ]
  }, [])

  return (
    <PanelCard>
      <PanelHead
        title="Engineering velocity"
        subtitle="14-day flow metrics across the org"
        to="/decide"
      />
      <div className="grid flex-1 grid-cols-2 gap-3 lg:grid-cols-4">
        {tracks.map((t) => (
          <VelocityTile key={t.id} {...t} />
        ))}
      </div>
    </PanelCard>
  )
}

function VelocityTile({
  label,
  unit,
  series,
  tone,
  icon,
}: {
  label: string
  unit: string
  series: number[]
  tone: 'brand' | 'emerald' | 'sky' | 'amber'
  icon: React.ReactNode
}) {
  const last = series[series.length - 1] ?? 0
  const prev = series[series.length - 8] ?? last
  const delta = prev > 0 ? Math.round(((last - prev) / prev) * 100) : 0
  const positive = label === 'Lead time' || label === 'Incidents' ? delta < 0 : delta >= 0

  const sparkColor = {
    brand: 'oklch(0.51 0.19 262)',
    emerald: 'oklch(0.6 0.16 155)',
    sky: 'oklch(0.6 0.13 230)',
    amber: 'oklch(0.66 0.16 70)',
  }[tone]
  const swatch = {
    brand: 'bg-brand-50 text-brand-700 ring-brand-200/60',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200/60',
    sky: 'bg-sky-50 text-sky-700 ring-sky-200/60',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200/60',
  }[tone]

  return (
    <div className="rounded-xl border border-edge-subtle bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <span className={cn('inline-flex h-7 w-7 items-center justify-center rounded-md ring-1', swatch)}>
          {icon}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
            positive
              ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60'
              : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200/60',
          )}
        >
          <span>{positive ? '↑' : '↓'}</span>
          {Math.abs(delta)}%
        </span>
      </div>
      <div className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="font-mono text-xl font-semibold tabular-nums text-content">{last}</span>
        <span className="text-[11px] text-content-subtle">{unit}</span>
      </div>
      <div className="mt-2 h-8">
        <Sparkline points={series} color={sparkColor} height={32} />
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

function IconTarget() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
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

function IconGitMerge() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
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

function IconClockSm() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

function IconAlertSm() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

/* ───────────────────────────────────────────────────────────
 * Resource Utilization — 3 radial gauges (CPU / Memory / Storage)
 * ─────────────────────────────────────────────────────────── */

export function ResourceUtilizationPanel() {
  // Synthesise plausible cluster-wide resource usage. Production swap:
  //  - CPU: sum of pod CPU usage / sum of node allocatable
  //  - Mem: sum of pod memory / sum of node allocatable
  //  - Storage: sum of PVC `used` / sum of PVC `capacity`
  const cpu = { used: 142, total: 256, unit: 'cores' }
  const mem = { used: 612, total: 1024, unit: 'GiB' }
  const storage = { used: 8.2, total: 24, unit: 'TiB' }

  const cpuPct = pct(cpu.used, cpu.total)
  const memPct = pct(mem.used, mem.total)
  const storagePct = pct(storage.used, storage.total)

  return (
    <PanelCard>
      <PanelHead title="Resource utilization" subtitle="Cluster-wide live consumption" to="/platform" />
      <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-3">
        <ResourceGauge
          label="CPU"
          value={cpuPct}
          used={`${cpu.used} ${cpu.unit}`}
          total={`${cpu.total} ${cpu.unit}`}
          icon={<IconCpu />}
        />
        <ResourceGauge
          label="Memory"
          value={memPct}
          used={`${mem.used} ${mem.unit}`}
          total={`${mem.total} ${mem.unit}`}
          icon={<IconMemory />}
        />
        <ResourceGauge
          label="Storage"
          value={storagePct}
          used={`${storage.used} ${storage.unit}`}
          total={`${storage.total} ${storage.unit}`}
          icon={<IconHardDrive />}
        />
      </div>
    </PanelCard>
  )
}

function ResourceGauge({
  label,
  value,
  used,
  total,
  icon,
}: {
  label: string
  value: number
  used: string
  total: string
  icon: React.ReactNode
}) {
  const tone = value >= 85 ? 'rose' : value >= 70 ? 'amber' : 'emerald'
  const ringClass = {
    emerald: 'stroke-emerald-500',
    amber: 'stroke-amber-500',
    rose: 'stroke-rose-500',
  }[tone]
  const swatch = {
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200/60',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200/60',
    rose: 'bg-rose-50 text-rose-700 ring-rose-200/60',
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
    if (list.length === 0) {
      // Fallback synthetic timeline when alertmanager is empty.
      const now = Date.now()
      return [
        {
          id: 'i1',
          title: 'Payments p95 spike resolved',
          severity: 'sev2' as const,
          message: 'p95 latency briefly exceeded 800 ms; recovered after pod restart.',
          ts: new Date(now - 18 * 60_000).toISOString(),
        },
        {
          id: 'i2',
          title: 'Argo CD app drift detected',
          severity: 'sev3' as const,
          message: 'orders-svc out of sync — auto-prune scheduled.',
          ts: new Date(now - 47 * 60_000).toISOString(),
        },
        {
          id: 'i3',
          title: 'Catalog read replica failed over',
          severity: 'sev2' as const,
          message: 'Replica reattached; lag back to <100 ms.',
          ts: new Date(now - 3 * 3_600_000).toISOString(),
        },
        {
          id: 'i4',
          title: 'Trivy scan completed',
          severity: 'info' as const,
          message: '0 critical, 4 high CVEs across 12 images.',
          ts: new Date(now - 7 * 3_600_000).toISOString(),
        },
        {
          id: 'i5',
          title: 'Nightly backup succeeded',
          severity: 'info' as const,
          message: 'Velero backup of 12 namespaces · 8.2 GiB.',
          ts: new Date(now - 14 * 3_600_000).toISOString(),
        },
      ]
    }
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
        ts: a.activeAt ?? new Date().toISOString(),
      }
    })
  }, [list])

  return (
    <PanelCard>
      <PanelHead title="Incident timeline" subtitle="Last 5 events from Alertmanager" to="/discover" />
      <ol className="relative ml-3 flex-1 space-y-3 border-l border-edge-subtle pl-4">
        {items.map((it) => (
          <li key={it.id} className="relative">
            <span
              className={cn(
                'absolute -left-[19px] top-1 inline-flex h-2.5 w-2.5 rounded-full ring-2 ring-white',
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
    sev1: 'bg-rose-100 text-rose-800 ring-rose-200/60',
    sev2: 'bg-amber-100 text-amber-800 ring-amber-200/60',
    sev3: 'bg-sky-100 text-sky-800 ring-sky-200/60',
    info: 'bg-emerald-100 text-emerald-800 ring-emerald-200/60',
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

/* ───────────────────────────────────────────────────────────
 * Build pipeline runtime — box plot per repo
 * ─────────────────────────────────────────────────────────── */

export function BuildRuntimePanel() {
  // Synthesised distributions for top 5 repos. Real BFF would aggregate
  // build durations per repo from the CI provider over the last 7 days.
  const rows = useMemo(
    () => [
      { repo: 'web', min: 1.2, q1: 2.4, med: 3.1, q3: 4.0, max: 6.8, n: 142 },
      { repo: 'api', min: 1.8, q1: 3.2, med: 4.4, q3: 6.1, max: 9.5, n: 96 },
      { repo: 'orders-svc', min: 2.1, q1: 3.8, med: 5.0, q3: 6.6, max: 11.2, n: 71 },
      { repo: 'cart', min: 0.9, q1: 1.6, med: 2.0, q3: 2.9, max: 5.0, n: 188 },
      { repo: 'catalog', min: 1.4, q1: 2.8, med: 3.6, q3: 4.7, max: 7.4, n: 117 },
    ],
    [],
  )
  const max = Math.max(...rows.map((r) => r.max))
  return (
    <PanelCard>
      <PanelHead title="CI build duration" subtitle="7-day distribution per repo" to="/develop" />
      <div className="flex-1 space-y-2">
        {rows.map((r) => (
          <BoxPlotRow key={r.repo} row={r} scaleMax={max} />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px] text-content-subtle">
        <span>0 min</span>
        <span>{max.toFixed(1)} min</span>
      </div>
    </PanelCard>
  )
}

function BoxPlotRow({
  row,
  scaleMax,
}: {
  row: { repo: string; min: number; q1: number; med: number; q3: number; max: number; n: number }
  scaleMax: number
}) {
  const px = (v: number) => `${(v / scaleMax) * 100}%`
  const tone = row.med >= 5 ? 'amber' : row.med >= 3 ? 'sky' : 'emerald'
  const fill = {
    emerald: 'bg-emerald-200/70',
    sky: 'bg-sky-200/70',
    amber: 'bg-amber-200/70',
  }[tone]
  const stroke = {
    emerald: 'bg-emerald-600',
    sky: 'bg-sky-600',
    amber: 'bg-amber-600',
  }[tone]
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-mono text-content">{row.repo}</span>
        <span className="text-content-subtle">
          <span className="font-mono tabular-nums text-content">{row.med.toFixed(1)}</span>
          <span className="text-content-subtle"> min · {row.n} runs</span>
        </span>
      </div>
      <div className="relative mt-1 h-3 w-full">
        {/* whisker line */}
        <div
          className="absolute top-1/2 h-px -translate-y-1/2 bg-edge-default"
          style={{ left: px(row.min), width: px(row.max - row.min) }}
        />
        {/* IQR box */}
        <div
          className={cn('absolute top-0 h-3 rounded-sm', fill)}
          style={{ left: px(row.q1), width: px(row.q3 - row.q1) }}
        />
        {/* median tick */}
        <div
          className={cn('absolute top-0 h-3 w-0.5', stroke)}
          style={{ left: px(row.med) }}
        />
        {/* min/max ticks */}
        <div
          className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-edge-strong"
          style={{ left: px(row.min) }}
        />
        <div
          className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-edge-strong"
          style={{ left: px(row.max) }}
        />
      </div>
    </div>
  )
}

/* ───────────────────────────────────────────────────────────
 * Top error sources — ranked horizontal bars
 * ─────────────────────────────────────────────────────────── */

export function TopErrorSourcesPanel() {
  // Pull plausible per-service error rates from the golden signals stream
  // when available, otherwise fall back to a synthesised set so the panel
  // stays meaningful in development.
  const golden = useGoldenSignals()
  const rows = useMemo(() => {
    const series = golden.data ?? []
    const errs = series.filter((s) =>
      /error|5xx|fail/i.test(s.metric.__name__ ?? ''),
    )
    const map = new Map<string, number>()
    for (const e of errs) {
      const svc = (e.metric.service ?? e.metric.app ?? 'unknown') as string
      const last = lastValue(e)
      map.set(svc, (map.get(svc) ?? 0) + last)
    }
    const list = Array.from(map.entries()).map(([service, rate]) => ({ service, rate }))
    if (list.length === 0) {
      return [
        { service: 'payments', rate: 0.041 },
        { service: 'orders', rate: 0.028 },
        { service: 'catalog', rate: 0.019 },
        { service: 'cart', rate: 0.012 },
        { service: 'web', rate: 0.008 },
        { service: 'image-cdn', rate: 0.004 },
      ]
    }
    return list.sort((a, b) => b.rate - a.rate).slice(0, 6)
  }, [golden.data])
  const max = Math.max(0.001, ...rows.map((r) => r.rate))

  return (
    <PanelCard>
      <PanelHead title="Top error sources" subtitle="5xx rate by service · last hour" to="/decide" />
      <ul className="flex-1 space-y-2.5">
        {rows.map((r) => {
          const pctW = (r.rate / max) * 100
          const tone = r.rate >= 0.03 ? 'rose' : r.rate >= 0.01 ? 'amber' : 'emerald'
          const bar = {
            emerald: 'bg-emerald-500',
            amber: 'bg-amber-500',
            rose: 'bg-rose-500',
          }[tone]
          const text = {
            emerald: 'text-emerald-700',
            amber: 'text-amber-700',
            rose: 'text-rose-700',
          }[tone]
          return (
            <li key={r.service}>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="font-mono font-medium text-content">{r.service}</span>
                <span className={cn('font-mono tabular-nums', text)}>
                  {(r.rate * 100).toFixed(2)}%
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={cn('h-full rounded-full transition-[width]', bar)}
                  style={{ width: `${pctW}%`, transitionDuration: '500ms' }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
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

function IconHardDrive() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="22" x2="2" y1="12" y2="12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
      <line x1="6" x2="6.01" y1="16" y2="16" />
      <line x1="10" x2="10.01" y1="16" y2="16" />
    </svg>
  )
}

/* ───────────────────────────────────────────────────────────
 * Cache performance — donut hit ratio + miss/eviction stats
 * ─────────────────────────────────────────────────────────── */

export function CachePerformancePanel() {
  const hits = 8_614_223
  const misses = 612_481
  const evictions = 4_220
  const ratio = hits / (hits + misses)
  const r = 36
  const stroke = 9
  const c = 2 * Math.PI * r
  const offset = c - ratio * c
  return (
    <PanelCard>
      <PanelHead title="Cache performance" subtitle="Redis cluster · last hour" to="/decide" />
      <div className="grid flex-1 grid-cols-[auto_1fr] items-center gap-4">
        <div className="relative h-24 w-24">
          <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
            <circle cx="48" cy="48" r={r} fill="none" strokeWidth={stroke} className="stroke-edge-default" />
            <circle
              cx="48"
              cy="48"
              r={r}
              fill="none"
              strokeLinecap="round"
              strokeWidth={stroke}
              strokeDasharray={c}
              strokeDashoffset={offset}
              className="stroke-emerald-500"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="font-mono text-xl font-semibold tabular-nums text-content">
              {(ratio * 100).toFixed(1)}
              <span className="text-xs font-normal text-content-subtle">%</span>
            </div>
            <div className="text-[9px] font-semibold uppercase tracking-wider text-content-subtle">hit rate</div>
          </div>
        </div>
        <ul className="space-y-1.5 text-[12px]">
          <KvLine label="Hits" value={fmtCount(hits)} tone="emerald" />
          <KvLine label="Misses" value={fmtCount(misses)} tone="amber" />
          <KvLine label="Evictions" value={fmtCount(evictions)} tone="rose" />
        </ul>
      </div>
    </PanelCard>
  )
}

function KvLine({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'emerald' | 'amber' | 'rose' | 'sky'
}) {
  const dot = {
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
    sky: 'bg-sky-500',
  }[tone]
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="inline-flex items-center gap-2 text-content-muted">
        <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
        {label}
      </span>
      <span className="font-mono tabular-nums text-content">{value}</span>
    </li>
  )
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

/* ───────────────────────────────────────────────────────────
 * Database pool — connection utilisation + slow queries
 * ─────────────────────────────────────────────────────────── */

export function DatabasePoolPanel() {
  const pools = useMemo(
    () => [
      { db: 'orders-pg', used: 38, max: 50, slow: 4 },
      { db: 'catalog-pg', used: 22, max: 40, slow: 1 },
      { db: 'payments-pg', used: 17, max: 30, slow: 0 },
      { db: 'audit-mongo', used: 9, max: 25, slow: 0 },
    ],
    [],
  )
  return (
    <PanelCard>
      <PanelHead title="Database pool" subtitle="Connection utilisation + slow queries" to="/decide" />
      <ul className="flex-1 space-y-2.5">
        {pools.map((p) => {
          const pctUsed = Math.round((p.used / p.max) * 100)
          const tone = pctUsed >= 85 ? 'rose' : pctUsed >= 70 ? 'amber' : 'emerald'
          const bar = {
            emerald: 'bg-emerald-500',
            amber: 'bg-amber-500',
            rose: 'bg-rose-500',
          }[tone]
          return (
            <li key={p.db}>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="font-mono text-content">{p.db}</span>
                <span className="text-content-subtle">
                  <span className="font-mono tabular-nums text-content">
                    {p.used}/{p.max}
                  </span>
                  {p.slow > 0 ? (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-rose-700 ring-1 ring-rose-200">
                      {p.slow} slow
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={cn('h-full rounded-full transition-[width]', bar)}
                  style={{ width: `${pctUsed}%`, transitionDuration: '500ms' }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───────────────────────────────────────────────────────────
 * Queue depth — Kafka topic lag with stacked stripes
 * ─────────────────────────────────────────────────────────── */

export function QueueDepthPanel() {
  const topics = useMemo(
    () => [
      { topic: 'orders.events.v1', lag: 12_400, partitions: 12, tone: 'amber' as const },
      { topic: 'audit.events.v2', lag: 480, partitions: 6, tone: 'emerald' as const },
      { topic: 'lake.events', lag: 47_300, partitions: 24, tone: 'rose' as const },
      { topic: 'notifications', lag: 130, partitions: 4, tone: 'emerald' as const },
      { topic: 'fraud.scores', lag: 2_900, partitions: 8, tone: 'amber' as const },
    ],
    [],
  )
  const max = Math.max(...topics.map((t) => t.lag))
  return (
    <PanelCard>
      <PanelHead title="Queue depth" subtitle="Top Kafka consumer lag" to="/discover" />
      <ul className="flex-1 space-y-2">
        {topics.map((t) => {
          const w = (t.lag / max) * 100
          const fill = {
            emerald: 'bg-emerald-500',
            amber: 'bg-amber-500',
            rose: 'bg-rose-500',
          }[t.tone]
          return (
            <li key={t.topic}>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="truncate font-mono text-content">{t.topic}</span>
                <span className="text-content-muted">
                  <span className="font-mono tabular-nums text-content">{fmtCount(t.lag)}</span>
                  <span className="text-content-subtle"> · {t.partitions}p</span>
                </span>
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

/* ───────────────────────────────────────────────────────────
 * Cert expiry — TLS certificates expiring soon
 * ─────────────────────────────────────────────────────────── */

export function CertExpiryPanel() {
  const certs = useMemo(
    () => [
      { host: 'app.acme.io', daysLeft: 6, issuer: 'letsencrypt' },
      { host: 'api.acme.io', daysLeft: 14, issuer: 'letsencrypt' },
      { host: 'admin.acme.io', daysLeft: 27, issuer: 'letsencrypt' },
      { host: 'mesh.internal.acme', daysLeft: 88, issuer: 'mesh-ca' },
      { host: 'gateway.acme.io', daysLeft: 142, issuer: 'aws-acm' },
    ],
    [],
  )
  return (
    <PanelCard>
      <PanelHead title="Certificate expiry" subtitle="TLS certs across all routes" to="/platform" />
      <ul className="flex-1 divide-y divide-edge-subtle">
        {certs.map((c) => {
          const tone =
            c.daysLeft <= 7 ? 'rose' : c.daysLeft <= 30 ? 'amber' : 'emerald'
          const pillCls = {
            emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200/60',
            amber: 'bg-amber-50 text-amber-700 ring-amber-200/60',
            rose: 'bg-rose-50 text-rose-700 ring-rose-200/60',
          }[tone]
          return (
            <li key={c.host} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
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
  const pods = useMemo(
    () => [
      { pod: 'orders-svc-7c9b', restarts: 12, namespace: 'acme-console' },
      { pod: 'payments-svc-4a2f', restarts: 8, namespace: 'acme-console' },
      { pod: 'lake-ingest-5d8e', restarts: 5, namespace: 'acme-data' },
      { pod: 'web-3b1c', restarts: 3, namespace: 'acme-console' },
      { pod: 'fraud-detection-9f0a', restarts: 2, namespace: 'acme-data' },
    ],
    [],
  )
  const max = Math.max(...pods.map((p) => p.restarts))
  return (
    <PanelCard>
      <PanelHead title="Pod restarts" subtitle="Top pods · last 24 hours" to="/platform" />
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
  lagMs: number
  status: 'healthy' | 'syncing' | 'failover' | 'degraded'
}

export function CnpgClustersPanel() {
  const clusters = useMemo<CnpgCluster[]>(
    () => [
      {
        name: 'orders-db',
        namespace: 'acme-console',
        primary: 'orders-db-1',
        instances: 3,
        ready: 3,
        pgVersion: '16.4',
        sizeGb: 128,
        lagMs: 12,
        status: 'healthy',
      },
      {
        name: 'payments-db',
        namespace: 'acme-console',
        primary: 'payments-db-2',
        instances: 3,
        ready: 3,
        pgVersion: '16.4',
        sizeGb: 84,
        lagMs: 28,
        status: 'healthy',
      },
      {
        name: 'analytics-warehouse',
        namespace: 'acme-data',
        primary: 'analytics-warehouse-1',
        instances: 5,
        ready: 4,
        pgVersion: '16.3',
        sizeGb: 612,
        lagMs: 1840,
        status: 'syncing',
      },
      {
        name: 'identity-db',
        namespace: 'platform',
        primary: 'identity-db-1',
        instances: 3,
        ready: 2,
        pgVersion: '15.7',
        sizeGb: 22,
        lagMs: 64,
        status: 'degraded',
      },
    ],
    [],
  )

  const tones: Record<CnpgCluster['status'], string> = {
    healthy: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    syncing: 'border-sky-200 bg-sky-50 text-sky-700',
    failover: 'border-amber-200 bg-amber-50 text-amber-700',
    degraded: 'border-rose-200 bg-rose-50 text-rose-700',
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
                  <div className="text-content-subtle">{c.sizeGb} GB</div>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-3 text-[10px] text-content-muted">
                <div className="flex-1">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white">
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
                <span className="tabular-nums">
                  lag <span className={c.lagMs > 1000 ? 'text-amber-700' : 'text-content'}>
                    {c.lagMs < 1000 ? `${c.lagMs} ms` : `${(c.lagMs / 1000).toFixed(1)} s`}
                  </span>
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
  status: 'online' | 'rebalancing' | 'offline'
  partitions: number
  leaderPartitions: number
  underReplicated: number
  bytesInPerSec: number
}

export function KafkaBrokersPanel() {
  const brokers = useMemo<KafkaBroker[]>(
    () => [
      { id: 0, host: 'kafka-0', status: 'online', partitions: 184, leaderPartitions: 62, underReplicated: 0, bytesInPerSec: 4_200_000 },
      { id: 1, host: 'kafka-1', status: 'online', partitions: 184, leaderPartitions: 61, underReplicated: 0, bytesInPerSec: 3_900_000 },
      { id: 2, host: 'kafka-2', status: 'rebalancing', partitions: 184, leaderPartitions: 58, underReplicated: 4, bytesInPerSec: 3_600_000 },
      { id: 3, host: 'kafka-3', status: 'online', partitions: 184, leaderPartitions: 60, underReplicated: 0, bytesInPerSec: 4_050_000 },
      { id: 4, host: 'kafka-4', status: 'online', partitions: 184, leaderPartitions: 59, underReplicated: 0, bytesInPerSec: 4_180_000 },
    ],
    [],
  )
  const totalUnderReplicated = brokers.reduce((s, b) => s + b.underReplicated, 0)
  const totalLeaders = brokers.reduce((s, b) => s + b.leaderPartitions, 0)
  const totalBytes = brokers.reduce((s, b) => s + b.bytesInPerSec, 0)
  const onlineCount = brokers.filter((b) => b.status === 'online').length

  const dotTone: Record<KafkaBroker['status'], string> = {
    online: 'bg-emerald-500',
    rebalancing: 'bg-amber-500',
    offline: 'bg-rose-500',
  }

  return (
    <PanelCard>
      <PanelHead
        title="Kafka brokers"
        subtitle="Strimzi · broker liveness + ISR"
        to="/platform"
      />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat
          label="Online"
          value={`${onlineCount}/${brokers.length}`}
          tone={onlineCount === brokers.length ? 'emerald' : 'amber'}
        />
        <Stat
          label="Under-rep."
          value={totalUnderReplicated}
          tone={totalUnderReplicated === 0 ? 'emerald' : 'rose'}
        />
        <Stat label="Throughput" value={`${(totalBytes / 1_000_000).toFixed(1)} MB/s`} tone="brand" />
      </div>
      <ul className="flex-1 space-y-1.5">
        {brokers.map((b) => {
          const leaderPct = totalLeaders > 0 ? (b.leaderPartitions / totalLeaders) * 100 : 0
          return (
            <li key={b.id} className="rounded-md bg-surface-sunken/40 px-2.5 py-1.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className={cn('h-2 w-2 flex-none rounded-full', dotTone[b.status])} />
                <span className="font-mono text-content">{b.host}</span>
                <span className="text-content-subtle">·</span>
                <span className="text-content-muted capitalize">{b.status}</span>
                <span className="ml-auto tabular-nums text-content-muted">
                  {(b.bytesInPerSec / 1_000_000).toFixed(1)} MB/s
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] tabular-nums text-content-subtle">
                <span>
                  {b.leaderPartitions} leader · {b.partitions} total
                </span>
                {b.underReplicated > 0 ? (
                  <span className="text-rose-700">· {b.underReplicated} under-rep</span>
                ) : null}
                <div className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-white">
                  <div
                    className="h-full rounded-full bg-sky-500"
                    style={{ width: `${leaderPct}%` }}
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── Platform tools health ───── */

interface ToolHealth {
  name: string
  category: 'ci-cd' | 'observability' | 'security' | 'data' | 'identity' | 'registry'
  status: 'healthy' | 'degraded' | 'down' | 'unknown'
  version: string
  latencyMs: number | null
  href: string
}

export function ToolsHealthPanel() {
  const tools = useMemo<ToolHealth[]>(
    () => [
      { name: 'ArgoCD', category: 'ci-cd', status: 'healthy', version: '2.13.1', latencyMs: 42, href: '/deliver' },
      { name: 'Argo Rollouts', category: 'ci-cd', status: 'healthy', version: '1.7.2', latencyMs: 38, href: '/deliver' },
      { name: 'Argo Workflows', category: 'ci-cd', status: 'healthy', version: '3.5.10', latencyMs: 51, href: '/deliver' },
      { name: 'Kargo', category: 'ci-cd', status: 'healthy', version: '1.0.4', latencyMs: 33, href: '/deliver' },
      { name: 'Crossplane', category: 'ci-cd', status: 'healthy', version: '1.17.1', latencyMs: 48, href: '/platform' },
      { name: 'Gitea', category: 'ci-cd', status: 'healthy', version: '1.22.3', latencyMs: 71, href: '/develop' },
      { name: 'Harbor', category: 'registry', status: 'degraded', version: '2.11.1', latencyMs: 412, href: '/deliver' },
      { name: 'Kyverno', category: 'security', status: 'healthy', version: '1.13.0', latencyMs: 28, href: '/deliver' },
      { name: 'Falco', category: 'security', status: 'healthy', version: '0.39.0', latencyMs: 62, href: '/deliver' },
      { name: 'Trivy Operator', category: 'security', status: 'healthy', version: '0.23.1', latencyMs: 84, href: '/deliver' },
      { name: 'Keycloak', category: 'identity', status: 'healthy', version: '26.0', latencyMs: 96, href: '/settings' },
      { name: 'Prometheus', category: 'observability', status: 'healthy', version: '2.55.0', latencyMs: 19, href: '/discover' },
      { name: 'Grafana', category: 'observability', status: 'healthy', version: '11.4.0', latencyMs: 44, href: '/discover' },
      { name: 'Loki', category: 'observability', status: 'healthy', version: '3.3.0', latencyMs: 58, href: '/discover' },
      { name: 'Tempo', category: 'observability', status: 'healthy', version: '2.7.0', latencyMs: 67, href: '/discover' },
      { name: 'Mimir', category: 'observability', status: 'healthy', version: '2.14.0', latencyMs: 73, href: '/discover' },
      { name: 'CloudNativePG', category: 'data', status: 'healthy', version: '1.24.1', latencyMs: 31, href: '/platform' },
      { name: 'Strimzi (Kafka)', category: 'data', status: 'degraded', version: '0.44.0', latencyMs: 188, href: '/platform' },
      { name: 'Redis Operator', category: 'data', status: 'healthy', version: '0.18.0', latencyMs: 22, href: '/platform' },
      { name: 'Plane', category: 'ci-cd', status: 'healthy', version: '0.23.1', latencyMs: 92, href: '/define' },
    ],
    [],
  )

  const healthy = tools.filter((t) => t.status === 'healthy').length
  const degraded = tools.filter((t) => t.status === 'degraded').length
  const down = tools.filter((t) => t.status === 'down').length

  const dotTone: Record<ToolHealth['status'], string> = {
    healthy: 'bg-emerald-500',
    degraded: 'bg-amber-500',
    down: 'bg-rose-500',
    unknown: 'bg-slate-300',
  }

  const labelTone: Record<ToolHealth['status'], string> = {
    healthy: 'text-emerald-700',
    degraded: 'text-amber-700',
    down: 'text-rose-700',
    unknown: 'text-content-subtle',
  }

  return (
    <PanelCard>
      <PanelHead title="Platform tools" subtitle="Liveness probes across the stack" to="/platform" />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Healthy" value={healthy} tone="emerald" />
        <Stat label="Degraded" value={degraded} tone={degraded > 0 ? 'amber' : 'slate'} />
        <Stat label="Down" value={down} tone={down > 0 ? 'rose' : 'slate'} />
      </div>
      <div className="grid flex-1 grid-cols-2 gap-1.5 overflow-y-auto md:grid-cols-3 xl:grid-cols-4">
        {tools.map((t) => (
          <Link
            key={t.name}
            to={t.href}
            className="group flex items-center gap-2 rounded-md border border-edge-subtle bg-white px-2 py-1.5 text-[11px] transition-colors hover:border-edge-strong hover:bg-surface-sunken"
          >
            <span className={cn('h-1.5 w-1.5 flex-none rounded-full', dotTone[t.status])} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-content group-hover:text-brand-700">
                {t.name}
              </div>
              <div className="flex items-center gap-1 text-[10px] text-content-subtle">
                <span>v{t.version}</span>
                {t.latencyMs != null ? (
                  <>
                    <span>·</span>
                    <span className={labelTone[t.status]}>{t.latencyMs} ms</span>
                  </>
                ) : null}
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
  const events = useMemo<K8sEvent[]>(() => {
    const now = Date.now()
    const ago = (s: number) => new Date(now - s * 1000).toISOString()
    return [
      {
        at: ago(8),
        type: 'Warning',
        reason: 'Unhealthy',
        object: 'pod/payments-svc-4a2f',
        namespace: 'acme-console',
        message: 'Readiness probe failed: HTTP 503 from /healthz',
      },
      {
        at: ago(34),
        type: 'Normal',
        reason: 'Scheduled',
        object: 'pod/orders-svc-7c9b',
        namespace: 'acme-console',
        message: 'Successfully assigned to node prod-pool-3',
      },
      {
        at: ago(52),
        type: 'Normal',
        reason: 'Pulled',
        object: 'pod/orders-svc-7c9b',
        namespace: 'acme-console',
        message: 'Container image "registry.adhar.io/orders:v1.4.2" pulled in 4.1s',
      },
      {
        at: ago(78),
        type: 'Warning',
        reason: 'BackOff',
        object: 'pod/lake-ingest-5d8e',
        namespace: 'acme-data',
        message: 'Back-off restarting failed container — exit code 137 (OOMKilled)',
      },
      {
        at: ago(112),
        type: 'Normal',
        reason: 'Synced',
        object: 'application/orders-svc',
        namespace: 'argocd',
        message: 'Application synced to revision abf8c2e',
      },
      {
        at: ago(184),
        type: 'Warning',
        reason: 'PolicyViolation',
        object: 'deployment/billing-svc',
        namespace: 'acme-console',
        message: 'Kyverno blocked: container missing image digest pin',
      },
      {
        at: ago(243),
        type: 'Normal',
        reason: 'ScalingReplicaSet',
        object: 'deployment/web',
        namespace: 'acme-console',
        message: 'Scaled up replica set web-7d8f to 6',
      },
      {
        at: ago(298),
        type: 'Warning',
        reason: 'FailedMount',
        object: 'pod/identity-db-2',
        namespace: 'platform',
        message: 'MountVolume.SetUp failed for volume "data" — timed out',
      },
      {
        at: ago(372),
        type: 'Normal',
        reason: 'Killing',
        object: 'pod/web-3b1c',
        namespace: 'acme-console',
        message: 'Stopping container web — replaced by rollout step 3/5',
      },
    ]
  }, [])

  const warnings = events.filter((e) => e.type === 'Warning').length

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
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-emerald-100 text-emerald-800',
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

export function GiteaRepoMetricsPanel() {
  const repos = useDevelopRepos()
  const total = repos.data?.length ?? 32
  const commits7d = useMemo(
    () => [42, 58, 71, 64, 88, 51, 24].reduce((s, n) => s + n, 0),
    [],
  )
  const commitSeries = useMemo(() => [42, 58, 71, 64, 88, 51, 24], [])
  const branches = total * 4 + 12
  const stars = 187
  const forks = 24

  const langs = useMemo<GiteaLang[]>(
    () => [
      { name: 'TypeScript', pct: 48, color: 'oklch(0.58 0.16 245)' },
      { name: 'Go', pct: 22, color: 'oklch(0.66 0.13 200)' },
      { name: 'Python', pct: 14, color: 'oklch(0.7 0.14 90)' },
      { name: 'Rust', pct: 9, color: 'oklch(0.6 0.18 30)' },
      { name: 'Other', pct: 7, color: 'oklch(0.7 0.02 260)' },
    ],
    [],
  )

  const max = Math.max(...commitSeries)

  return (
    <PanelCard>
      <PanelHead title="Code repositories" subtitle="Gitea · org-wide activity" to="/develop" />
      <div className="mb-3 grid grid-cols-4 gap-2">
        <Stat label="Repos" value={total} tone="brand" />
        <Stat label="Commits 7d" value={commits7d} tone="emerald" />
        <Stat label="Branches" value={branches} tone="slate" />
        <Stat label="Stars" value={`${stars}/${forks}f`} tone="amber" />
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-baseline justify-between text-[10px] text-content-subtle">
          <span className="font-semibold uppercase tracking-wider">Commits · last 7 days</span>
          <span className="tabular-nums text-content-muted">{commits7d} total</span>
        </div>
        <div className="flex h-12 items-end gap-1">
          {commitSeries.map((v, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm bg-brand-500/80 transition-colors hover:bg-brand-600"
              style={{ height: `${(v / max) * 100}%` }}
              title={`${v} commits`}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[9px] text-content-subtle">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
      </div>

      <div className="flex-1 space-y-1.5">
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

export function PrThroughputPanel() {
  const opened7d = 38
  const merged7d = 42
  const closed7d = 4
  const avgCycleHours = 26
  const medianFirstReviewHours = 4.5
  const reviewDepthAvg = 2.3

  const cycleHistogram = useMemo(
    () => [
      { bucket: '<4h', count: 6 },
      { bucket: '4–12h', count: 11 },
      { bucket: '12–24h', count: 9 },
      { bucket: '1–2d', count: 8 },
      { bucket: '2–4d', count: 5 },
      { bucket: '>4d', count: 3 },
    ],
    [],
  )
  const histMax = Math.max(...cycleHistogram.map((b) => b.count))

  const reviewers = useMemo<ReviewerLoad[]>(
    () => [
      { name: 'maya@acme', reviews: 18, avgHours: 3.2 },
      { name: 'priya@acme', reviews: 14, avgHours: 5.8 },
      { name: 'leo@acme', reviews: 11, avgHours: 7.1 },
      { name: 'tapas@acme', reviews: 9, avgHours: 4.4 },
    ],
    [],
  )
  const maxReviews = Math.max(...reviewers.map((r) => r.reviews))

  const mergeRatio = opened7d > 0 ? Math.round((merged7d / opened7d) * 100) : 0

  return (
    <PanelCard>
      <PanelHead title="PR throughput" subtitle="Last 7 days · cycle + review load" to="/develop" />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Opened" value={opened7d} tone="brand" />
        <Stat label="Merged" value={merged7d} tone="emerald" />
        <Stat label="Avg cycle" value={`${avgCycleHours}h`} tone={avgCycleHours <= 24 ? 'emerald' : 'amber'} />
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-baseline justify-between text-[10px] text-content-subtle">
          <span className="font-semibold uppercase tracking-wider">Cycle-time histogram</span>
          <span className="tabular-nums text-content-muted">
            median 1st-review {medianFirstReviewHours}h
          </span>
        </div>
        <div className="flex h-14 items-end gap-1">
          {cycleHistogram.map((b) => (
            <div key={b.bucket} className="flex flex-1 flex-col items-center gap-0.5">
              <div
                className="w-full rounded-sm bg-sky-500/80 transition-colors hover:bg-sky-600"
                style={{ height: `${(b.count / histMax) * 100}%` }}
                title={`${b.count} PRs in ${b.bucket}`}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[9px] text-content-subtle">
          {cycleHistogram.map((b) => (
            <span key={b.bucket}>{b.bucket}</span>
          ))}
        </div>
      </div>

      <div className="flex-1 space-y-1.5">
        <div className="flex items-center justify-between text-[10px] text-content-subtle">
          <span className="font-semibold uppercase tracking-wider">Top reviewers</span>
          <span className="text-content-muted">avg {reviewDepthAvg} per PR · {mergeRatio}% merged · {closed7d} closed</span>
        </div>
        <ul className="space-y-1">
          {reviewers.map((r) => {
            const w = (r.reviews / maxReviews) * 100
            return (
              <li key={r.name} className="text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-content">{r.name}</span>
                  <span className="tabular-nums text-content-muted">
                    {r.reviews} · {r.avgHours}h
                  </span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full bg-violet-500"
                    style={{ width: `${w}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </PanelCard>
  )
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
  const synced = apps.filter((a) => a.status.sync.status === 'Synced').length
  const outOfSync = apps.length - synced
  const healthyCount = apps.filter((a) => a.status.health.status === 'Healthy').length

  const driftBars = useMemo(
    () => [
      { label: 'Synced + Healthy', count: Math.min(synced, healthyCount), tone: 'emerald' as const },
      { label: 'Synced · Degraded', count: Math.max(0, synced - healthyCount), tone: 'amber' as const },
      { label: 'OutOfSync', count: outOfSync, tone: 'rose' as const },
    ],
    [synced, healthyCount, outOfSync],
  )
  const totalApps = apps.length || 1

  const recent = useMemo<SyncEvent[]>(() => {
    const now = Date.now()
    const ago = (m: number) => new Date(now - m * 60_000).toISOString()
    return [
      { at: ago(3), app: 'orders-svc', result: 'synced', revision: 'abf8c2e' },
      { at: ago(11), app: 'web', result: 'synced', revision: '7c91d4a' },
      { at: ago(28), app: 'payments-svc', result: 'failed', revision: 'd402ea1' },
      { at: ago(46), app: 'lake-ingest', result: 'degraded', revision: 'b21ff09' },
      { at: ago(72), app: 'fraud-detection', result: 'synced', revision: '5ee8c12' },
      { at: ago(118), app: 'identity-bff', result: 'synced', revision: '9aa1e7d' },
    ]
  }, [])

  const tones: Record<SyncEvent['result'], { dot: string; label: string }> = {
    synced: { dot: 'bg-emerald-500', label: 'text-emerald-700' },
    failed: { dot: 'bg-rose-500', label: 'text-rose-700' },
    degraded: { dot: 'bg-amber-500', label: 'text-amber-700' },
  }

  return (
    <PanelCard>
      <PanelHead title="GitOps sync" subtitle="ArgoCD · drift + recent syncs" to="/deliver" />
      <div className="mb-3 grid grid-cols-3 gap-2">
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
        <ul className="mt-1.5 grid grid-cols-3 gap-x-2 text-[10px]">
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
              <code className="ml-auto flex-none rounded bg-white px-1 py-0.5 font-mono text-[10px] text-content-muted ring-1 ring-edge-subtle">
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

interface QuotaUsage {
  label: string
  used: number
  limit: number
  unit: string
}

export function TenantOverviewPanel() {
  const tenant = useMemo(
    () => ({
      name: 'Acme Corp',
      slug: 'acme',
      plan: 'Business',
      region: 'us-east-1',
      members: 42,
      environments: 4,
      apps: 28,
      monthlySpend: 4_280,
      planQuota: 6_000,
      contacts: [
        { name: 'Tapas Jena', role: 'Owner', email: 'tapas@acme.io' },
        { name: 'Maya Patel', role: 'Platform Lead', email: 'maya@acme.io' },
        { name: 'Leo Park', role: 'Billing', email: 'leo@acme.io' },
      ],
    }),
    [],
  )

  const quotas = useMemo<QuotaUsage[]>(
    () => [
      { label: 'Workloads', used: 62, limit: 100, unit: '' },
      { label: 'Storage', used: 1240, limit: 2000, unit: 'GB' },
      { label: 'CI minutes', used: 8400, limit: 12_000, unit: 'min' },
      { label: 'Members', used: 42, limit: 50, unit: '' },
    ],
    [],
  )

  const billingPct = Math.round((tenant.monthlySpend / tenant.planQuota) * 100)

  return (
    <PanelCard>
      <PanelHead title="Tenant overview" subtitle="Active organization · plan + quotas" to="/settings" />
      <div className="mb-3 flex items-start gap-3 rounded-xl border border-edge-subtle bg-surface-sunken/40 p-3">
        <div
          className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-brand-600 text-sm font-semibold text-white"
          aria-hidden
        >
          {tenant.name
            .split(' ')
            .map((p) => p[0])
            .join('')
            .slice(0, 2)
            .toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-content">{tenant.name}</span>
            <span className="rounded-md border border-brand-200 bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
              {tenant.plan}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-content-muted">
            <span>slug:{tenant.slug}</span>
            <span>·</span>
            <span>{tenant.region}</span>
            <span>·</span>
            <span>{tenant.members} members</span>
            <span>·</span>
            <span>{tenant.environments} envs</span>
            <span>·</span>
            <span>{tenant.apps} apps</span>
          </div>
        </div>
      </div>

      <div className="mb-3 space-y-1.5">
        <div className="flex items-baseline justify-between text-[10px]">
          <span className="font-semibold uppercase tracking-wider text-content-subtle">
            Plan usage
          </span>
          <span className="tabular-nums text-content-muted">
            ${tenant.monthlySpend.toLocaleString()} / ${tenant.planQuota.toLocaleString()}
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div
            className={cn(
              'h-full rounded-full',
              billingPct < 75 ? 'bg-emerald-500' : billingPct < 90 ? 'bg-amber-500' : 'bg-rose-500',
            )}
            style={{ width: `${Math.min(100, billingPct)}%` }}
          />
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        {quotas.map((q) => {
          const p = pct(q.used, q.limit)
          const tone = p < 75 ? 'emerald' : p < 90 ? 'amber' : 'rose'
          const fill = {
            emerald: 'bg-emerald-500',
            amber: 'bg-amber-500',
            rose: 'bg-rose-500',
          }[tone]
          return (
            <div
              key={q.label}
              className="rounded-lg border border-edge-subtle bg-white p-2.5"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
                  {q.label}
                </span>
                <span className="text-[10px] tabular-nums text-content-muted">{p}%</span>
              </div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-content">
                {q.used.toLocaleString()}
                {q.unit ? <span className="text-content-muted"> {q.unit}</span> : null}
                <span className="text-[11px] font-normal text-content-subtle">
                  {' '}
                  / {q.limit.toLocaleString()}
                  {q.unit ? ` ${q.unit}` : ''}
                </span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={cn('h-full rounded-full', fill)}
                  style={{ width: `${Math.min(100, p)}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex-1 space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Key contacts
        </div>
        <ul className="space-y-1">
          {tenant.contacts.map((c) => (
            <li
              key={c.email}
              className="flex items-center gap-2 rounded-md bg-surface-sunken/40 px-2 py-1.5 text-[11px]"
            >
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-white text-[10px] font-semibold text-content ring-1 ring-edge-subtle">
                {c.name
                  .split(' ')
                  .map((p) => p[0])
                  .join('')
                  .slice(0, 2)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-content">{c.name}</div>
                <div className="truncate text-[10px] text-content-subtle">{c.email}</div>
              </div>
              <span className="flex-none rounded-md bg-white px-1.5 py-0.5 text-[10px] font-medium text-content-muted ring-1 ring-edge-subtle">
                {c.role}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </PanelCard>
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

  // Synthesize a burndown line: ideal vs. actual remaining over the cycle.
  const days = 14
  const remaining = total - completed
  const ideal = useMemo(
    () => Array.from({ length: days }, (_, i) => Math.round(total - (total / (days - 1)) * i)),
    [total],
  )
  const actual = useMemo(() => {
    // Slow start, faster mid-cycle.
    const elapsed = Math.min(days - 1, Math.max(2, days - Math.ceil((remaining / Math.max(total, 1)) * days)))
    const out: number[] = []
    for (let i = 0; i < days; i++) {
      if (i > elapsed) {
        out.push(remaining)
        continue
      }
      const factor = 1 - Math.pow(i / elapsed, 1.4) * (1 - remaining / Math.max(total, 1))
      out.push(Math.max(remaining, Math.round(total * factor)))
    }
    return out
  }, [total, remaining])

  const max = Math.max(...ideal, ...actual, 1)
  const w = 200
  const h = 60
  const stepX = w / (days - 1)
  const idealPath = ideal.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * stepX} ${h - (v / max) * h}`).join(' ')
  const actualPath = actual
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * stepX} ${h - (v / max) * h}`)
    .join(' ')

  const onTrack = actual[Math.min(actual.length - 1, days - 3)] <= ideal[Math.min(ideal.length - 1, days - 3)]
  const endLabel = active?.end_date ? formatRelative(active.end_date) : '—'

  return (
    <PanelCard>
      <PanelHead
        title="Sprint progress"
        subtitle={active?.name ?? 'No active cycle'}
        to="/define"
      />
      <div className="mb-3 grid grid-cols-4 gap-2">
        <Stat label="Total" value={total} tone="brand" />
        <Stat label="Done" value={completed} tone="emerald" />
        <Stat label="In-flight" value={started} tone="amber" />
        <Stat label="Backlog" value={backlog} tone="slate" />
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-baseline justify-between text-[10px]">
          <span className="font-semibold uppercase tracking-wider text-content-subtle">Burndown</span>
          <span
            className={cn(
              'tabular-nums',
              onTrack ? 'text-emerald-700' : 'text-amber-700',
            )}
          >
            {onTrack ? 'On track' : 'Behind ideal'} · ends {endLabel}
          </span>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full">
          <path d={idealPath} fill="none" stroke="oklch(0.7 0.02 260)" strokeWidth="1" strokeDasharray="3 3" />
          <path d={actualPath} fill="none" stroke="oklch(0.51 0.19 262)" strokeWidth="1.75" />
        </svg>
        <div className="flex items-center gap-3 text-[10px] text-content-subtle">
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 bg-content-subtle" /> Ideal
          </span>
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 bg-brand-600" /> Actual
          </span>
          <span className="ml-auto tabular-nums">
            {progress}% complete · {remaining} remaining
          </span>
        </div>
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

  // Fall back to representative numbers when the stub returns nothing.
  const fallback = open.length === 0
  const safe = fallback
    ? { urgent: 3, high: 12, medium: 24, low: 18, none: 6 }
    : byPriority
  const safeAging = fallback ? { week: 18, month: 22, quarter: 14, stale: 9 } : aging
  const totalOpen = Object.values(safe).reduce((s, n) => s + n, 0)

  const priorityRows: { key: keyof typeof safe; label: string; tone: string; fill: string }[] = [
    { key: 'urgent', label: 'Urgent', tone: 'text-rose-700', fill: 'bg-rose-500' },
    { key: 'high', label: 'High', tone: 'text-amber-700', fill: 'bg-amber-500' },
    { key: 'medium', label: 'Medium', tone: 'text-sky-700', fill: 'bg-sky-500' },
    { key: 'low', label: 'Low', tone: 'text-emerald-700', fill: 'bg-emerald-500' },
    { key: 'none', label: 'Triage', tone: 'text-content-muted', fill: 'bg-slate-400' },
  ]

  const agingMax = Math.max(safeAging.week, safeAging.month, safeAging.quarter, safeAging.stale, 1)

  const triagePct = pct(safe.none, totalOpen)
  const groomingHealth = triagePct < 10 ? 'healthy' : triagePct < 25 ? 'fair' : 'stale'
  const groomingTone = {
    healthy: 'text-emerald-700',
    fair: 'text-amber-700',
    stale: 'text-rose-700',
  }[groomingHealth]

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
        <div className="grid grid-cols-4 gap-1.5 text-[10px]">
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
  plan: 'free' | 'team' | 'business' | 'enterprise'
  cpu: number
  cpuLimit: number
  memGb: number
  memLimit: number
  storageGb: number
  storageLimit: number
  monthlySpend: number
}

export function TenantUsagePanel() {
  const tenants = useMemo<TenantUsage[]>(
    () => [
      { tenant: 'acme', plan: 'business', cpu: 124, cpuLimit: 200, memGb: 384, memLimit: 512, storageGb: 1240, storageLimit: 2000, monthlySpend: 4280 },
      { tenant: 'globex', plan: 'enterprise', cpu: 218, cpuLimit: 400, memGb: 712, memLimit: 1024, storageGb: 4180, storageLimit: 6000, monthlySpend: 12_400 },
      { tenant: 'initech', plan: 'team', cpu: 38, cpuLimit: 80, memGb: 122, memLimit: 256, storageGb: 320, storageLimit: 800, monthlySpend: 980 },
      { tenant: 'umbrella', plan: 'business', cpu: 164, cpuLimit: 200, memGb: 442, memLimit: 512, storageGb: 1820, storageLimit: 2000, monthlySpend: 5320 },
      { tenant: 'stark-ind', plan: 'enterprise', cpu: 312, cpuLimit: 400, memGb: 880, memLimit: 1024, storageGb: 5210, storageLimit: 6000, monthlySpend: 14_120 },
      { tenant: 'wayne-tech', plan: 'team', cpu: 22, cpuLimit: 80, memGb: 64, memLimit: 256, storageGb: 110, storageLimit: 800, monthlySpend: 480 },
    ],
    [],
  )

  const aggregateSpend = tenants.reduce((s, t) => s + t.monthlySpend, 0)
  const aggregateCpu = tenants.reduce((s, t) => s + t.cpu, 0)
  const aggregateMem = tenants.reduce((s, t) => s + t.memGb, 0)

  const planTone: Record<TenantUsage['plan'], string> = {
    free: 'border-edge-default bg-white text-content-muted',
    team: 'border-sky-200 bg-sky-50 text-sky-700',
    business: 'border-brand-200 bg-brand-50 text-brand-700',
    enterprise: 'border-violet-200 bg-violet-50 text-violet-700',
  }

  return (
    <PanelCard>
      <PanelHead
        title="Tenant usage"
        subtitle={`${tenants.length} active tenants · platform admin view`}
        to="/settings"
      />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="MRR" value={`$${(aggregateSpend / 1000).toFixed(1)}k`} tone="emerald" />
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
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-white text-[11px] font-semibold text-content ring-1 ring-edge-subtle">
                  {t.tenant.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[12px] text-content">{t.tenant}</span>
                    <span
                      className={cn(
                        'rounded-md border px-1.5 py-0.5 text-[10px] font-medium capitalize',
                        planTone[t.plan],
                      )}
                    >
                      {t.plan}
                    </span>
                  </div>
                  <div className="text-[10px] text-content-subtle">
                    ${t.monthlySpend.toLocaleString()}/mo
                  </div>
                </div>
                <span
                  className={cn(
                    'flex-none text-[10px] font-medium tabular-nums',
                    hot >= 90 ? 'text-rose-700' : hot >= 75 ? 'text-amber-700' : 'text-content-muted',
                  )}
                >
                  {hot}%
                </span>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
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
      <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white">
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

export function AuditLogPanel() {
  const events = useMemo<AuditEvent[]>(() => {
    const now = Date.now()
    const ago = (s: number) => new Date(now - s * 60_000).toISOString()
    return [
      {
        at: ago(2),
        actor: 'maya@acme.io',
        action: 'role.granted',
        resource: 'role/platform-admin → leo@acme.io',
        tenant: 'acme',
        severity: 'warning',
      },
      {
        at: ago(8),
        actor: 'system:argocd',
        action: 'secret.read',
        resource: 'secret/payments-db-creds',
        tenant: 'acme',
        severity: 'info',
      },
      {
        at: ago(24),
        actor: 'tapas@acme.io',
        action: 'tenant.created',
        resource: 'tenant/wayne-tech',
        tenant: 'platform',
        severity: 'info',
      },
      {
        at: ago(38),
        actor: 'unknown',
        action: 'login.failed',
        resource: 'user/admin@globex.com',
        tenant: 'globex',
        severity: 'critical',
      },
      {
        at: ago(52),
        actor: 'priya@acme.io',
        action: 'policy.modified',
        resource: 'kyverno/require-image-digest',
        tenant: 'platform',
        severity: 'warning',
      },
      {
        at: ago(94),
        actor: 'system:keycloak',
        action: 'token.revoked',
        resource: 'session/sess-7c91d4a',
        tenant: 'acme',
        severity: 'info',
      },
      {
        at: ago(140),
        actor: 'leo@acme.io',
        action: 'billing.plan_changed',
        resource: 'tenant/acme → enterprise',
        tenant: 'acme',
        severity: 'info',
      },
    ]
  }, [])

  const tones: Record<AuditEvent['severity'], { dot: string; pill: string }> = {
    info: { dot: 'bg-slate-400', pill: 'bg-slate-100 text-slate-700' },
    warning: { dot: 'bg-amber-500', pill: 'bg-amber-100 text-amber-800' },
    critical: { dot: 'bg-rose-500', pill: 'bg-rose-100 text-rose-800' },
  }

  const critical = events.filter((e) => e.severity === 'critical').length
  const warnings = events.filter((e) => e.severity === 'warning').length

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
  lastSuccess: string
  size: string
  durationMin: number
  status: 'completed' | 'in-progress' | 'failed' | 'partial'
  rpoMin: number
}

export function BackupStatusPanel() {
  const backups = useMemo<BackupRow[]>(() => {
    const now = Date.now()
    const ago = (m: number) => new Date(now - m * 60_000).toISOString()
    return [
      { name: 'platform-daily', type: 'velero', scope: 'all-namespaces', lastSuccess: ago(48), size: '12.4 GB', durationMin: 14, status: 'completed', rpoMin: 60 },
      { name: 'acme-db-pitr', type: 'cnpg', scope: 'orders-db', lastSuccess: ago(8), size: '128 GB', durationMin: 6, status: 'completed', rpoMin: 5 },
      { name: 'globex-warehouse', type: 'cnpg', scope: 'analytics-warehouse', lastSuccess: ago(180), size: '612 GB', durationMin: 42, status: 'partial', rpoMin: 60 },
      { name: 'identity-hourly', type: 'cnpg', scope: 'identity-db', lastSuccess: ago(28), size: '22 GB', durationMin: 4, status: 'completed', rpoMin: 15 },
      { name: 'tenant-snapshots', type: 'velero', scope: 'acme-data', lastSuccess: ago(720), size: '38 GB', durationMin: 22, status: 'failed', rpoMin: 1440 },
    ]
  }, [])

  const completed = backups.filter((b) => b.status === 'completed').length
  const failed = backups.filter((b) => b.status === 'failed').length
  const partial = backups.filter((b) => b.status === 'partial').length

  const tones: Record<BackupRow['status'], { dot: string; pill: string; label: string }> = {
    completed: { dot: 'bg-emerald-500', pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', label: 'OK' },
    'in-progress': { dot: 'bg-sky-500', pill: 'border-sky-200 bg-sky-50 text-sky-700', label: 'Running' },
    failed: { dot: 'bg-rose-500', pill: 'border-rose-200 bg-rose-50 text-rose-700', label: 'Failed' },
    partial: { dot: 'bg-amber-500', pill: 'border-amber-200 bg-amber-50 text-amber-700', label: 'Partial' },
  }

  return (
    <PanelCard>
      <PanelHead title="Backup status" subtitle="Velero + CloudNativePG · last 24h" to="/platform" />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="OK" value={completed} tone="emerald" />
        <Stat label="Partial" value={partial} tone={partial > 0 ? 'amber' : 'slate'} />
        <Stat label="Failed" value={failed} tone={failed > 0 ? 'rose' : 'slate'} />
      </div>
      <ul className="flex-1 space-y-1.5 overflow-y-auto">
        {backups.map((b) => {
          const t = tones[b.status]
          const rpoLabel =
            b.rpoMin < 60 ? `${b.rpoMin}m` : b.rpoMin < 1440 ? `${Math.round(b.rpoMin / 60)}h` : `${Math.round(b.rpoMin / 1440)}d`
          return (
            <li
              key={b.name}
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
                <span className="ml-auto flex-none rounded-sm bg-white px-1 py-0.5 text-[10px] uppercase tracking-wide text-content-muted ring-1 ring-edge-subtle">
                  {b.type}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-content-muted tabular-nums">
                <span>scope:{b.scope}</span>
                <span>·</span>
                <span>{b.size}</span>
                <span>·</span>
                <span>{b.durationMin}m</span>
                <span>·</span>
                <span>RPO {rpoLabel}</span>
                <span className="ml-auto text-content-subtle">{formatRelative(b.lastSuccess)}</span>
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── Workflow runs (live Argo Workflows feed) ───── */

interface WorkflowRun {
  name: string
  repo: string
  phase: 'Succeeded' | 'Running' | 'Failed' | 'Pending' | 'Error'
  startedAt: string
  durationSec: number | null
  progress: string
  retries: number
  trigger: 'commit' | 'manual' | 'schedule' | 'pr'
}

export function WorkflowRunsPanel() {
  const runs = useMemo<WorkflowRun[]>(() => {
    const now = Date.now()
    const ago = (m: number) => new Date(now - m * 60_000).toISOString()
    return [
      { name: 'adhar-console-build-xyz12', repo: 'adhar/adhar-console', phase: 'Succeeded', startedAt: ago(8), durationSec: 277, progress: '4/4', retries: 0, trigger: 'commit' },
      { name: 'billing-service-build-abc99', repo: 'acme/billing-service', phase: 'Running', startedAt: ago(2), durationSec: null, progress: '2/5', retries: 0, trigger: 'pr' },
      { name: 'fraud-detection-train-9f0a', repo: 'acme/fraud-detection', phase: 'Running', startedAt: ago(14), durationSec: null, progress: '3/8', retries: 1, trigger: 'schedule' },
      { name: 'orders-svc-build-7c91', repo: 'acme/orders-svc', phase: 'Succeeded', startedAt: ago(38), durationSec: 184, progress: '4/4', retries: 0, trigger: 'commit' },
      { name: 'payments-svc-build-d402', repo: 'acme/payments-svc', phase: 'Failed', startedAt: ago(46), durationSec: 122, progress: '2/4', retries: 2, trigger: 'commit' },
      { name: 'lake-ingest-nightly-b21f', repo: 'acme/data-platform', phase: 'Succeeded', startedAt: ago(72), durationSec: 1840, progress: '6/6', retries: 0, trigger: 'schedule' },
      { name: 'identity-bff-deploy-9aa1', repo: 'platform/identity-bff', phase: 'Succeeded', startedAt: ago(118), durationSec: 96, progress: '3/3', retries: 0, trigger: 'manual' },
    ]
  }, [])

  const running = runs.filter((r) => r.phase === 'Running').length
  const failed24h = runs.filter((r) => r.phase === 'Failed' || r.phase === 'Error').length
  const succeeded24h = runs.filter((r) => r.phase === 'Succeeded').length
  const successRate = pct(succeeded24h, succeeded24h + failed24h)

  const phaseTone: Record<WorkflowRun['phase'], { dot: string; pill: string; bar: string }> = {
    Succeeded: { dot: 'bg-emerald-500', pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500' },
    Running: { dot: 'bg-sky-500', pill: 'border-sky-200 bg-sky-50 text-sky-700', bar: 'bg-sky-500' },
    Failed: { dot: 'bg-rose-500', pill: 'border-rose-200 bg-rose-50 text-rose-700', bar: 'bg-rose-500' },
    Error: { dot: 'bg-rose-500', pill: 'border-rose-200 bg-rose-50 text-rose-700', bar: 'bg-rose-500' },
    Pending: { dot: 'bg-slate-400', pill: 'border-slate-200 bg-slate-50 text-slate-700', bar: 'bg-slate-400' },
  }

  const triggerLabel: Record<WorkflowRun['trigger'], string> = {
    commit: 'push',
    manual: 'manual',
    schedule: 'cron',
    pr: 'pr',
  }

  function fmtDuration(sec: number | null): string {
    if (sec == null) return '—'
    if (sec < 60) return `${sec}s`
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
    return `${(sec / 3600).toFixed(1)}h`
  }

  function progressPct(progress: string): number {
    const [d, t] = progress.split('/').map(Number)
    if (!Number.isFinite(d) || !Number.isFinite(t) || t === 0) return 0
    return Math.round((d / t) * 100)
  }

  return (
    <PanelCard>
      <PanelHead
        title="CI workflow runs"
        subtitle="Argo Workflows · live executions"
        to="/develop"
      />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Running" value={running} tone="brand" />
        <Stat label="Success" value={`${successRate}%`} tone={successRate >= 90 ? 'emerald' : 'amber'} />
        <Stat label="Failed" value={failed24h} tone={failed24h > 0 ? 'rose' : 'slate'} />
      </div>
      <ul className="flex-1 space-y-1.5 overflow-y-auto">
        {runs.map((r) => {
          const t = phaseTone[r.phase]
          const p = progressPct(r.progress)
          return (
            <li
              key={r.name}
              className="rounded-xl border border-edge-subtle bg-surface-sunken/40 p-2.5"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span className={cn('h-1.5 w-1.5 flex-none rounded-full', t.dot, r.phase === 'Running' && 'animate-pulse')} />
                <span className="truncate font-mono text-content">{r.name}</span>
                <span
                  className={cn(
                    'flex-none rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                    t.pill,
                  )}
                >
                  {r.phase}
                </span>
                <span className="ml-auto flex-none rounded-sm bg-white px-1 py-0.5 text-[10px] uppercase tracking-wide text-content-muted ring-1 ring-edge-subtle">
                  {triggerLabel[r.trigger]}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-content-muted">
                <span className="truncate">{r.repo}</span>
                <span className="ml-auto flex-none tabular-nums">
                  {r.progress} · {fmtDuration(r.durationSec)}
                  {r.retries > 0 ? <span className="text-amber-700"> · {r.retries} retry</span> : null}
                  <span className="text-content-subtle"> · {formatRelative(r.startedAt)}</span>
                </span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    t.bar,
                    r.phase === 'Running' && 'animate-pulse',
                  )}
                  style={{ width: `${p}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── Pipeline success-rate trend ───── */

export function PipelineSuccessTrendPanel() {
  // 14-day series: succeeded + failed counts per day.
  const series = useMemo(() => {
    const seed = (a: number, b: number) => Array.from({ length: 14 }, (_, i) => Math.max(0, Math.round(a + Math.sin(i * b) * 6)))
    const succeeded = seed(38, 0.6)
    const failed = seed(4, 0.9).map((v) => Math.max(0, v - 2))
    return succeeded.map((s, i) => ({ day: i, succeeded: s, failed: failed[i] }))
  }, [])

  const totalSucc = series.reduce((s, d) => s + d.succeeded, 0)
  const totalFail = series.reduce((s, d) => s + d.failed, 0)
  const overall = pct(totalSucc, totalSucc + totalFail)
  const last7Succ = series.slice(-7).reduce((s, d) => s + d.succeeded, 0)
  const last7Fail = series.slice(-7).reduce((s, d) => s + d.failed, 0)
  const trend7d = pct(last7Succ, last7Succ + last7Fail)
  const delta = trend7d - overall

  const max = Math.max(...series.map((d) => d.succeeded + d.failed), 1)
  const avgDuration = '4m 32s'
  const p95Duration = '12m 18s'
  const flakyRate = 3.2

  return (
    <PanelCard>
      <PanelHead
        title="Pipeline success"
        subtitle="14-day pass/fail trend across all workflows"
        to="/develop"
      />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Success" value={`${overall}%`} tone={overall >= 90 ? 'emerald' : 'amber'} />
        <Stat label="Avg" value={avgDuration} tone="brand" />
        <Stat label="p95" value={p95Duration} tone="violet" />
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-baseline justify-between text-[10px]">
          <span className="font-semibold uppercase tracking-wider text-content-subtle">
            Daily run volume
          </span>
          <span className={cn('tabular-nums', delta >= 0 ? 'text-emerald-700' : 'text-rose-700')}>
            7d {trend7d}% ({delta >= 0 ? '+' : ''}
            {delta}pp)
          </span>
        </div>
        <div className="flex h-16 items-end gap-1">
          {series.map((d, i) => {
            const total = d.succeeded + d.failed
            const totalH = (total / max) * 100
            const failH = total > 0 ? (d.failed / total) * totalH : 0
            const succH = totalH - failH
            return (
              <div
                key={i}
                className="flex flex-1 flex-col-reverse"
                title={`Day ${i + 1}: ${d.succeeded} ok / ${d.failed} fail`}
              >
                <div className="rounded-b-sm bg-emerald-500/80" style={{ height: `${succH}%` }} />
                <div className="bg-rose-500/80" style={{ height: `${failH}%` }} />
              </div>
            )
          })}
        </div>
        <div className="mt-1 flex items-center gap-3 text-[10px] text-content-subtle">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Succeeded
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> Failed
          </span>
          <span className="ml-auto tabular-nums text-content-muted">
            {totalSucc} ok · {totalFail} fail
          </span>
        </div>
      </div>

      <div className="flex-1">
        <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2.5 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="font-medium text-content">Flaky rate</span>
            <span
              className={cn(
                'font-medium tabular-nums',
                flakyRate < 2
                  ? 'text-emerald-700'
                  : flakyRate < 5
                    ? 'text-amber-700'
                    : 'text-rose-700',
              )}
            >
              {flakyRate}%
            </span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white">
            <div
              className={cn(
                'h-full rounded-full',
                flakyRate < 2 ? 'bg-emerald-500' : flakyRate < 5 ? 'bg-amber-500' : 'bg-rose-500',
              )}
              style={{ width: `${Math.min(100, flakyRate * 10)}%` }}
            />
          </div>
          <div className="mt-1 text-[10px] text-content-subtle">
            Re-runs that pass on retry · target &lt; 2%
          </div>
        </div>
      </div>
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

export function PipelineStagePerformancePanel() {
  const stages = useMemo<StagePerf[]>(
    () => [
      { name: 'Checkout', avgSec: 8, p95Sec: 14, failRate: 0.1 },
      { name: 'Build', avgSec: 124, p95Sec: 246, failRate: 1.8 },
      { name: 'Test', avgSec: 96, p95Sec: 188, failRate: 4.2 },
      { name: 'Scan', avgSec: 42, p95Sec: 78, failRate: 0.9 },
      { name: 'Push image', avgSec: 28, p95Sec: 48, failRate: 0.4 },
      { name: 'Deploy', avgSec: 36, p95Sec: 92, failRate: 1.2 },
    ],
    [],
  )

  const max = Math.max(...stages.map((s) => s.p95Sec))
  const totalAvg = stages.reduce((s, x) => s + x.avgSec, 0)
  const slowest = stages.reduce((a, b) => (a.p95Sec > b.p95Sec ? a : b))
  const flakiest = stages.reduce((a, b) => (a.failRate > b.failRate ? a : b))

  function fmt(sec: number): string {
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m ${sec % 60}s`
  }

  return (
    <PanelCard>
      <PanelHead
        title="Pipeline stages"
        subtitle="Per-stage duration · last 7 days"
        to="/develop"
      />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Total avg" value={fmt(totalAvg)} tone="brand" />
        <Stat label="Slowest" value={slowest.name} tone="violet" />
        <Stat label="Flakiest" value={flakiest.name} tone={flakiest.failRate > 3 ? 'rose' : 'amber'} />
      </div>
      <ul className="flex-1 space-y-2">
        {stages.map((s) => {
          const avgPct = (s.avgSec / max) * 100
          const p95Pct = (s.p95Sec / max) * 100
          return (
            <li key={s.name} className="text-[11px]">
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-content">{s.name}</span>
                <span className="tabular-nums text-content-muted">
                  avg {fmt(s.avgSec)} · p95 {fmt(s.p95Sec)}
                  {s.failRate > 2 ? (
                    <span className="text-rose-700"> · {s.failRate}% fail</span>
                  ) : null}
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
                <div className="relative h-full">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-sky-300"
                    style={{ width: `${p95Pct}%` }}
                    title={`p95 ${fmt(s.p95Sec)}`}
                  />
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-sky-600"
                    style={{ width: `${avgPct}%` }}
                    title={`avg ${fmt(s.avgSec)}`}
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-content-subtle">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-600" /> avg
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-300" /> p95
        </span>
      </div>
    </PanelCard>
  )
}

/* ───── Workflow triggers + templates ───── */

interface Template {
  name: string
  uses7d: number
  avgDuration: string
  successRate: number
}

export function WorkflowTriggersPanel() {
  const triggers = useMemo(
    () => [
      { source: 'commit', count: 184, color: 'oklch(0.51 0.19 262)' },
      { source: 'pull_request', count: 96, color: 'oklch(0.6 0.16 155)' },
      { source: 'schedule', count: 42, color: 'oklch(0.66 0.16 70)' },
      { source: 'manual', count: 18, color: 'oklch(0.7 0.02 260)' },
      { source: 'webhook', count: 12, color: 'oklch(0.6 0.18 30)' },
    ],
    [],
  )

  const total = triggers.reduce((s, t) => s + t.count, 0)

  const templates = useMemo<Template[]>(
    () => [
      { name: 'go-build-test-publish', uses7d: 124, avgDuration: '3m 48s', successRate: 96 },
      { name: 'node-ci-deploy', uses7d: 88, avgDuration: '5m 12s', successRate: 92 },
      { name: 'python-train-publish', uses7d: 22, avgDuration: '14m 22s', successRate: 88 },
      { name: 'security-scan', uses7d: 184, avgDuration: '1m 4s', successRate: 99 },
    ],
    [],
  )
  const maxUses = Math.max(...templates.map((t) => t.uses7d))

  return (
    <PanelCard>
      <PanelHead
        title="Pipeline triggers"
        subtitle={`${total} runs / 7d · trigger sources + top templates`}
        to="/develop"
      />

      <div className="mb-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          By trigger source
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          {triggers.map((t) => (
            <div
              key={t.source}
              style={{ width: `${(t.count / total) * 100}%`, backgroundColor: t.color }}
              title={`${t.source} · ${t.count} runs`}
            />
          ))}
        </div>
        <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
          {triggers.map((t) => (
            <li key={t.source} className="flex items-center gap-1.5 text-content-muted">
              <span
                className="h-1.5 w-1.5 flex-none rounded-full"
                style={{ backgroundColor: t.color }}
              />
              <span className="flex-1 truncate font-mono">{t.source}</span>
              <span className="tabular-nums text-content">{t.count}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex-1 space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Top workflow templates
        </div>
        <ul className="space-y-1.5">
          {templates.map((t) => {
            const w = (t.uses7d / maxUses) * 100
            const okTone =
              t.successRate >= 95
                ? 'text-emerald-700'
                : t.successRate >= 90
                  ? 'text-amber-700'
                  : 'text-rose-700'
            return (
              <li key={t.name} className="text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-content">{t.name}</span>
                  <span className="tabular-nums text-content-muted">
                    {t.uses7d} runs · {t.avgDuration} ·{' '}
                    <span className={okTone}>{t.successRate}%</span>
                  </span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                  <div className="h-full rounded-full bg-violet-500" style={{ width: `${w}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </PanelCard>
  )
}

/* ───── Cilium network flows ───── */

interface FlowTalker {
  source: string
  destination: string
  protocol: 'http' | 'grpc' | 'tcp' | 'dns'
  flowsPerMin: number
  dropped: number
}

export function CiliumNetworkFlowPanel() {
  const flows = useMemo<FlowTalker[]>(
    () => [
      { source: 'web', destination: 'orders-svc', protocol: 'http', flowsPerMin: 12_400, dropped: 0 },
      { source: 'web', destination: 'identity-bff', protocol: 'grpc', flowsPerMin: 9_800, dropped: 12 },
      { source: 'orders-svc', destination: 'orders-db', protocol: 'tcp', flowsPerMin: 8_200, dropped: 0 },
      { source: 'payments-svc', destination: 'payments-db', protocol: 'tcp', flowsPerMin: 6_400, dropped: 0 },
      { source: 'fraud-detection', destination: 'analytics-warehouse', protocol: 'grpc', flowsPerMin: 4_100, dropped: 84 },
      { source: 'lake-ingest', destination: 'kafka', protocol: 'tcp', flowsPerMin: 3_800, dropped: 0 },
    ],
    [],
  )

  const totalFlows = flows.reduce((s, f) => s + f.flowsPerMin, 0)
  const totalDropped = flows.reduce((s, f) => s + f.dropped, 0)
  const max = Math.max(...flows.map((f) => f.flowsPerMin))
  const dropRate = pct(totalDropped, totalFlows / 60)

  // Network policy posture
  const policies = { allow: 184, deny: 22, audit: 8 }
  const policyTotal = policies.allow + policies.deny + policies.audit

  const protoTone: Record<FlowTalker['protocol'], string> = {
    http: 'bg-sky-500',
    grpc: 'bg-violet-500',
    tcp: 'bg-emerald-500',
    dns: 'bg-amber-500',
  }

  return (
    <PanelCard>
      <PanelHead
        title="Cilium network flows"
        subtitle="Hubble · top talkers + policy posture"
        to="/platform"
      />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Flows/min" value={totalFlows.toLocaleString()} tone="brand" />
        <Stat
          label="Dropped"
          value={totalDropped}
          tone={totalDropped === 0 ? 'emerald' : totalDropped > 100 ? 'rose' : 'amber'}
        />
        <Stat label="Drop rate" value={`${dropRate}%`} tone={dropRate < 1 ? 'emerald' : 'amber'} />
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-baseline justify-between text-[10px]">
          <span className="font-semibold uppercase tracking-wider text-content-subtle">
            Network policies
          </span>
          <span className="tabular-nums text-content-muted">{policyTotal} active</span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div
            className="bg-emerald-500"
            style={{ width: `${(policies.allow / policyTotal) * 100}%` }}
            title={`Allow · ${policies.allow}`}
          />
          <div
            className="bg-rose-500"
            style={{ width: `${(policies.deny / policyTotal) * 100}%` }}
            title={`Deny · ${policies.deny}`}
          />
          <div
            className="bg-amber-500"
            style={{ width: `${(policies.audit / policyTotal) * 100}%` }}
            title={`Audit · ${policies.audit}`}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-content-muted">
          <span>
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" />
            Allow {policies.allow}
          </span>
          <span>
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-rose-500 align-middle" />
            Deny {policies.deny}
          </span>
          <span>
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" />
            Audit {policies.audit}
          </span>
        </div>
      </div>

      <div className="flex-1 space-y-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
          Top talkers · last 5 min
        </div>
        <ul className="space-y-1">
          {flows.map((f, i) => {
            const w = (f.flowsPerMin / max) * 100
            return (
              <li key={i} className="text-[11px]">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-content">{f.source}</span>
                  <span className="text-content-subtle">→</span>
                  <span className="truncate font-mono text-content">{f.destination}</span>
                  <span
                    className={cn(
                      'flex-none rounded-sm px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white',
                      protoTone[f.protocol],
                    )}
                  >
                    {f.protocol}
                  </span>
                  <span className="ml-auto flex-none tabular-nums text-content-muted">
                    {(f.flowsPerMin / 1000).toFixed(1)}k/m
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                    <div
                      className={cn('h-full rounded-full', protoTone[f.protocol])}
                      style={{ width: `${w}%` }}
                    />
                  </div>
                  {f.dropped > 0 ? (
                    <span className="flex-none text-[10px] text-rose-700">
                      {f.dropped} dropped
                    </span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </PanelCard>
  )
}

/* ───── Service-mesh traffic ───── */

interface MeshService {
  name: string
  rps: number
  errorRate: number
  p50ms: number
  p95ms: number
  p99ms: number
  trend: number[]
}

export function ServiceMeshTrafficPanel() {
  const services = useMemo<MeshService[]>(
    () => [
      { name: 'web', rps: 1240, errorRate: 0.4, p50ms: 18, p95ms: 96, p99ms: 184, trend: [120, 140, 132, 148, 156, 144, 162] },
      { name: 'orders-svc', rps: 890, errorRate: 0.2, p50ms: 12, p95ms: 64, p99ms: 122, trend: [80, 88, 84, 92, 96, 88, 102] },
      { name: 'payments-svc', rps: 642, errorRate: 1.8, p50ms: 28, p95ms: 142, p99ms: 312, trend: [62, 70, 68, 78, 84, 76, 88] },
      { name: 'identity-bff', rps: 1820, errorRate: 0.1, p50ms: 8, p95ms: 32, p99ms: 64, trend: [180, 192, 188, 200, 208, 196, 212] },
      { name: 'fraud-detection', rps: 184, errorRate: 0.6, p50ms: 88, p95ms: 412, p99ms: 880, trend: [16, 18, 20, 22, 24, 20, 18] },
    ],
    [],
  )

  const totalRps = services.reduce((s, x) => s + x.rps, 0)
  const avgError =
    services.reduce((s, x) => s + x.errorRate * x.rps, 0) / Math.max(totalRps, 1)
  const max = Math.max(...services.map((s) => s.rps))

  return (
    <PanelCard>
      <PanelHead
        title="Service mesh traffic"
        subtitle="Cilium L7 · request rate + tail latency"
        to="/discover"
      />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Total RPS" value={totalRps.toLocaleString()} tone="brand" />
        <Stat
          label="Error rate"
          value={`${avgError.toFixed(2)}%`}
          tone={avgError < 1 ? 'emerald' : avgError < 3 ? 'amber' : 'rose'}
        />
        <Stat label="Services" value={services.length} tone="violet" />
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {services.map((s) => {
          const w = (s.rps / max) * 100
          const errTone =
            s.errorRate < 1 ? 'text-emerald-700' : s.errorRate < 3 ? 'text-amber-700' : 'text-rose-700'
          const latTone =
            s.p95ms < 100 ? 'text-emerald-700' : s.p95ms < 300 ? 'text-amber-700' : 'text-rose-700'
          const trendMax = Math.max(...s.trend)
          return (
            <div
              key={s.name}
              className="rounded-xl border border-edge-subtle bg-surface-sunken/40 p-2.5"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span className="truncate font-mono text-content">{s.name}</span>
                <span className="ml-auto tabular-nums text-content-muted">
                  {s.rps.toLocaleString()} rps
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-white">
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${w}%` }} />
                </div>
                <div className="flex h-4 flex-none items-end gap-0.5">
                  {s.trend.map((v, i) => (
                    <div
                      key={i}
                      className="w-1 rounded-sm bg-brand-400"
                      style={{ height: `${(v / trendMax) * 100}%` }}
                    />
                  ))}
                </div>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] tabular-nums text-content-muted">
                <span>p50 <span className="text-content">{s.p50ms}ms</span></span>
                <span>·</span>
                <span>
                  p95 <span className={latTone}>{s.p95ms}ms</span>
                </span>
                <span>·</span>
                <span>p99 <span className="text-content">{s.p99ms}ms</span></span>
                <span className="ml-auto">
                  err <span className={errTone}>{s.errorRate}%</span>
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </PanelCard>
  )
}

/* ───── mTLS coverage ───── */

interface MtlsService {
  name: string
  state: 'mtls' | 'plaintext' | 'mixed'
  trafficRps: number
  certExpiresIn: number // days
}

export function MtlsCoveragePanel() {
  const services = useMemo<MtlsService[]>(
    () => [
      { name: 'web', state: 'mtls', trafficRps: 1240, certExpiresIn: 88 },
      { name: 'orders-svc', state: 'mtls', trafficRps: 890, certExpiresIn: 88 },
      { name: 'payments-svc', state: 'mtls', trafficRps: 642, certExpiresIn: 14 },
      { name: 'identity-bff', state: 'mtls', trafficRps: 1820, certExpiresIn: 88 },
      { name: 'fraud-detection', state: 'mixed', trafficRps: 184, certExpiresIn: 60 },
      { name: 'lake-ingest', state: 'plaintext', trafficRps: 84, certExpiresIn: 0 },
    ],
    [],
  )

  const total = services.length
  const encrypted = services.filter((s) => s.state === 'mtls').length
  const mixed = services.filter((s) => s.state === 'mixed').length
  const plain = services.filter((s) => s.state === 'plaintext').length
  const coveragePct = pct(encrypted, total)

  // Cert renewal urgency
  const urgent = services.filter((s) => s.state !== 'plaintext' && s.certExpiresIn <= 30)
  const trafficCovered =
    services.filter((s) => s.state === 'mtls').reduce((sum, s) => sum + s.trafficRps, 0)
  const trafficTotal = services.reduce((sum, s) => sum + s.trafficRps, 0)
  const trafficPct = pct(trafficCovered, trafficTotal)

  const stateTone: Record<MtlsService['state'], { dot: string; pill: string; label: string }> = {
    mtls: { dot: 'bg-emerald-500', pill: 'border-emerald-200 bg-emerald-50 text-emerald-700', label: 'mTLS' },
    mixed: { dot: 'bg-amber-500', pill: 'border-amber-200 bg-amber-50 text-amber-700', label: 'Mixed' },
    plaintext: { dot: 'bg-rose-500', pill: 'border-rose-200 bg-rose-50 text-rose-700', label: 'Plain' },
  }

  return (
    <PanelCard>
      <PanelHead title="mTLS coverage" subtitle="SPIFFE identity · service-to-service encryption" to="/platform" />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Services" value={`${encrypted}/${total}`} tone={coveragePct >= 95 ? 'emerald' : 'amber'} />
        <Stat label="Traffic" value={`${trafficPct}%`} tone={trafficPct >= 95 ? 'emerald' : 'amber'} />
        <Stat
          label="Renew ≤30d"
          value={urgent.length}
          tone={urgent.length === 0 ? 'emerald' : urgent.length > 2 ? 'rose' : 'amber'}
        />
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-baseline justify-between text-[10px]">
          <span className="font-semibold uppercase tracking-wider text-content-subtle">
            Encryption posture
          </span>
          <span className="tabular-nums text-content-muted">{coveragePct}% encrypted</span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div
            className="bg-emerald-500"
            style={{ width: `${(encrypted / total) * 100}%` }}
            title={`mTLS · ${encrypted}`}
          />
          <div
            className="bg-amber-500"
            style={{ width: `${(mixed / total) * 100}%` }}
            title={`Mixed · ${mixed}`}
          />
          <div
            className="bg-rose-500"
            style={{ width: `${(plain / total) * 100}%` }}
            title={`Plaintext · ${plain}`}
          />
        </div>
      </div>

      <ul className="flex-1 space-y-1 overflow-y-auto">
        {services.map((s) => {
          const t = stateTone[s.state]
          const certTone =
            s.state === 'plaintext'
              ? 'text-content-subtle'
              : s.certExpiresIn <= 14
                ? 'text-rose-700'
                : s.certExpiresIn <= 30
                  ? 'text-amber-700'
                  : 'text-content-muted'
          return (
            <li
              key={s.name}
              className="flex items-center gap-2 rounded-md bg-surface-sunken/40 px-2 py-1.5 text-[11px]"
            >
              <span className={cn('h-1.5 w-1.5 flex-none rounded-full', t.dot)} />
              <span className="truncate font-mono text-content">{s.name}</span>
              <span
                className={cn(
                  'flex-none rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                  t.pill,
                )}
              >
                {t.label}
              </span>
              <span className="ml-auto flex-none tabular-nums text-[10px] text-content-muted">
                {s.trafficRps.toLocaleString()} rps
              </span>
              <span className={cn('flex-none text-[10px] tabular-nums', certTone)}>
                {s.state === 'plaintext'
                  ? 'no cert'
                  : s.certExpiresIn === 0
                    ? 'expired'
                    : `${s.certExpiresIn}d`}
              </span>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── Ingress / edge traffic ───── */

interface IngressRoute {
  host: string
  path: string
  rps: number
  p95ms: number
  status2xx: number
  status4xx: number
  status5xx: number
}

export function IngressTrafficPanel() {
  const routes = useMemo<IngressRoute[]>(
    () => [
      { host: 'app.acme.io', path: '/api/orders', rps: 420, p95ms: 96, status2xx: 96.2, status4xx: 3.4, status5xx: 0.4 },
      { host: 'app.acme.io', path: '/api/payments', rps: 248, p95ms: 142, status2xx: 94.8, status4xx: 3.6, status5xx: 1.6 },
      { host: 'app.acme.io', path: '/auth', rps: 612, p95ms: 32, status2xx: 99.6, status4xx: 0.4, status5xx: 0 },
      { host: 'admin.acme.io', path: '/api/*', rps: 88, p95ms: 188, status2xx: 92.4, status4xx: 7.2, status5xx: 0.4 },
      { host: 'cdn.acme.io', path: '/static/*', rps: 3_240, p95ms: 18, status2xx: 99.8, status4xx: 0.2, status5xx: 0 },
    ],
    [],
  )

  const totalRps = routes.reduce((s, r) => s + r.rps, 0)
  const overall5xx =
    routes.reduce((s, r) => s + (r.status5xx * r.rps) / 100, 0) / Math.max(totalRps, 1)
  const overall4xx =
    routes.reduce((s, r) => s + (r.status4xx * r.rps) / 100, 0) / Math.max(totalRps, 1)

  const max = Math.max(...routes.map((r) => r.rps))

  return (
    <PanelCard>
      <PanelHead
        title="Ingress traffic"
        subtitle="Edge proxy · top routes by RPS"
        to="/discover"
      />
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Total RPS" value={totalRps.toLocaleString()} tone="brand" />
        <Stat
          label="4xx"
          value={`${overall4xx.toFixed(2)}%`}
          tone={overall4xx < 2 ? 'emerald' : overall4xx < 5 ? 'amber' : 'rose'}
        />
        <Stat
          label="5xx"
          value={`${overall5xx.toFixed(2)}%`}
          tone={overall5xx < 0.5 ? 'emerald' : overall5xx < 2 ? 'amber' : 'rose'}
        />
      </div>

      <ul className="flex-1 space-y-1.5 overflow-y-auto">
        {routes.map((r, i) => {
          const w = (r.rps / max) * 100
          return (
            <li
              key={`${r.host}${r.path}-${i}`}
              className="rounded-xl border border-edge-subtle bg-surface-sunken/40 p-2.5"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span className="truncate font-mono text-content">{r.host}</span>
                <span className="truncate font-mono text-content-muted">{r.path}</span>
                <span className="ml-auto flex-none tabular-nums text-content">
                  {r.rps.toLocaleString()} rps
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white">
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${w}%` }} />
                </div>
                <span
                  className={cn(
                    'flex-none text-[10px] tabular-nums',
                    r.p95ms < 100 ? 'text-emerald-700' : r.p95ms < 300 ? 'text-amber-700' : 'text-rose-700',
                  )}
                >
                  p95 {r.p95ms}ms
                </span>
              </div>
              <div className="mt-1.5">
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white">
                  <div className="bg-emerald-500" style={{ width: `${r.status2xx}%` }} title={`2xx ${r.status2xx}%`} />
                  <div className="bg-amber-500" style={{ width: `${r.status4xx}%` }} title={`4xx ${r.status4xx}%`} />
                  <div className="bg-rose-500" style={{ width: `${r.status5xx}%` }} title={`5xx ${r.status5xx}%`} />
                </div>
                <div className="mt-0.5 flex justify-between text-[10px] text-content-muted tabular-nums">
                  <span className="text-emerald-700">2xx {r.status2xx}%</span>
                  <span className="text-amber-700">4xx {r.status4xx}%</span>
                  <span className="text-rose-700">5xx {r.status5xx}%</span>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </PanelCard>
  )
}

/* ───── helper ───── */

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}
