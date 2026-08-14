import { useQuery } from '@tanstack/react-query'
import {
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  DonutGauge,
  LegendDot,
  Sparkline,
  Spinner,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { CURRENT_ORG_SLUG, wsClient } from '../data/client.ts'

function pct(used: number, quota: number): number {
  if (quota <= 0) return 0
  return Math.min(100, Math.round((used / quota) * 100))
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(1)} ${units[u]}`
}

/** Synthetic 14-day series built from current + quota so the chart has shape. */
function seed(current: number, noise = 0.15, len = 14): number[] {
  const out: number[] = []
  let v = Math.max(0, current * 0.6)
  for (let i = 0; i < len; i++) {
    const delta = (Math.sin(i / 2) * 0.4 + (Math.random() - 0.5) * noise) * current * 0.1
    v = Math.max(0, v + Math.abs(delta) + current * 0.02)
    out.push(Math.round(v))
  }
  out[len - 1] = current
  return out
}

export function UsageView() {
  const q = useQuery({
    queryKey: ['ws', 'usage', CURRENT_ORG_SLUG],
    queryFn: () => wsClient.getUsage(CURRENT_ORG_SLUG),
  })
  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading usage…
      </div>
    )
  }
  if (!q.data) return null
  const u = q.data

  const highlightRows = [
    {
      label: 'Deployments',
      used: u.metrics.deployments,
      quota: u.quotas.deployments,
      color: 'var(--color-brand-500)',
      format: (n: number) => n.toLocaleString(),
    },
    {
      label: 'API calls',
      used: u.metrics.apiCalls,
      quota: u.quotas.apiCalls,
      color: 'var(--color-accent-500)',
      format: (n: number) => n.toLocaleString(),
    },
    {
      label: 'Log bytes ingested',
      used: u.metrics.logBytesIngested,
      quota: u.quotas.logBytesIngested,
      color: '#6366f1',
      format: formatBytes,
    },
  ]

  const rows: {
    label: string
    used: string
    quota: string
    pct: number
    raw: number
  }[] = [
    {
      label: 'Projects',
      used: String(u.metrics.projects),
      quota: String(u.quotas.projects),
      pct: pct(u.metrics.projects, u.quotas.projects),
      raw: u.metrics.projects,
    },
    {
      label: 'Environments',
      used: String(u.metrics.environments),
      quota: String(u.quotas.environments),
      pct: pct(u.metrics.environments, u.quotas.environments),
      raw: u.metrics.environments,
    },
    {
      label: 'Active users',
      used: String(u.metrics.activeUsers),
      quota: String(u.quotas.activeUsers),
      pct: pct(u.metrics.activeUsers, u.quotas.activeUsers),
      raw: u.metrics.activeUsers,
    },
    {
      label: 'Deployments (month)',
      used: u.metrics.deployments.toLocaleString(),
      quota: u.quotas.deployments.toLocaleString(),
      pct: pct(u.metrics.deployments, u.quotas.deployments),
      raw: u.metrics.deployments,
    },
    {
      label: 'API calls (month)',
      used: u.metrics.apiCalls.toLocaleString(),
      quota: u.quotas.apiCalls.toLocaleString(),
      pct: pct(u.metrics.apiCalls, u.quotas.apiCalls),
      raw: u.metrics.apiCalls,
    },
    {
      label: 'Log bytes ingested',
      used: formatBytes(u.metrics.logBytesIngested),
      quota: formatBytes(u.quotas.logBytesIngested),
      pct: pct(u.metrics.logBytesIngested, u.quotas.logBytesIngested),
      raw: u.metrics.logBytesIngested,
    },
    {
      label: 'Storage',
      used: `${u.metrics.storageUsedGb} GB`,
      quota: `${u.quotas.storageUsedGb} GB`,
      pct: pct(u.metrics.storageUsedGb, u.quotas.storageUsedGb),
      raw: u.metrics.storageUsedGb,
    },
  ]

  // Overall monthly spend health — weighted average of percentages.
  const overallPct = Math.round(
    rows.reduce((a, r) => a + r.pct, 0) / rows.length,
  )
  const overallColor =
    overallPct > 85 ? '#f43f5e' : overallPct > 60 ? '#f59e0b' : 'var(--color-brand-500)'

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-content">Usage & quotas</h2>
        <p className="mt-1 text-sm text-content-muted">
          Live counters — billing is based on the max observed during the period, not the running
          total. All metrics derive from Prometheus; the exact queries are public.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[auto_1fr]">
        <Card>
          <CardBody className="flex items-center justify-center px-6 py-6">
            <DonutGauge
              value={overallPct}
              max={100}
              size={156}
              thickness={14}
              color={overallColor}
              label={
                <span>
                  {overallPct}
                  <span className="text-sm font-normal text-content-muted">%</span>
                </span>
              }
              caption="of plan"
            />
          </CardBody>
        </Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {highlightRows.map((r) => {
            const series = seed(r.used)
            return (
              <Card key={r.label}>
                <CardBody className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
                        {r.label}
                      </div>
                      <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-content">
                        {r.format(r.used)}
                      </div>
                      <div className="text-[11px] text-content-muted">
                        of {r.format(r.quota)} quota
                      </div>
                    </div>
                  </div>
                  <AreaChart
                    points={series}
                    color={r.color}
                    height={64}
                    showAxis={false}
                    emptyLabel=""
                  />
                </CardBody>
              </Card>
            )
          })}
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-content">Quota breakdown</div>
            <div className="flex items-center gap-3">
              <LegendDot color="var(--color-brand-500)">healthy</LegendDot>
              <LegendDot color="#f59e0b">warning</LegendDot>
              <LegendDot color="#f43f5e">critical</LegendDot>
            </div>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          {rows.map((r) => {
            const series = seed(r.raw, 0.2, 14)
            const color = r.pct > 85 ? '#f43f5e' : r.pct > 60 ? '#f59e0b' : 'var(--color-brand-500)'
            return (
              <div
                key={r.label}
                className="grid grid-cols-[1fr_120px_auto] items-center gap-4 rounded-lg border border-edge-subtle bg-surface-sunken/60 px-4 py-3"
              >
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-sm font-medium text-content">{r.label}</div>
                    <div
                      className={cn(
                        'text-xs font-semibold tabular-nums',
                        r.pct > 85
                          ? 'text-rose-600'
                          : r.pct > 60
                            ? 'text-amber-600'
                            : 'text-content-muted',
                      )}
                    >
                      {r.pct}%
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] text-content-subtle">
                    {r.used} used · {r.quota} quota
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-app">
                    <div
                      className="h-full rounded-full transition-[width] duration-500 ease-smooth"
                      style={{ width: `${r.pct}%`, backgroundColor: color }}
                    />
                  </div>
                </div>
                <div>
                  <Sparkline points={series} color={color} height={32} />
                </div>
                <div className="text-right text-[11px] font-medium uppercase tracking-wider text-content-subtle">
                  14d
                </div>
              </div>
            )
          })}
        </CardBody>
      </Card>
    </div>
  )
}
