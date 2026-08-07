import {
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  DonutGauge,
  EmptyState,
  LegendDot,
  Spinner,
  StatusBadge,
  type Column,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  formatPct,
  formatUsd,
  useCostBreakdown,
  type CostBreakdown,
  type CostComponents,
  type NamespaceCost,
} from '../data/cost.ts'

/**
 * Cloud-cost breakdown. Spend is fetched LIVE from OpenCost via
 * `useCostBreakdown` (`/api/svc/opencost/allocation/…`, OpenCost-shaped:
 * compute / memory / storage / network) and rolled up by namespace and by
 * workload, with MoM deltas, a 6-month trend and an optional configured budget.
 * No synthesized data — unreachable OpenCost renders an error/empty state.
 */

const COMPONENTS: Array<{ key: keyof CostComponents; label: string; color: string }> = [
  { key: 'compute', label: 'Compute', color: 'var(--color-brand-500)' },
  { key: 'memory', label: 'Memory', color: 'var(--color-accent-500)' },
  { key: 'storage', label: 'Storage', color: '#f59e0b' },
  { key: 'network', label: 'Network', color: '#6366f1' },
]

function MoM({ fraction }: { fraction: number }) {
  const up = fraction > 0
  return (
    <span
      className={cn(
        'font-mono text-xs tabular-nums',
        up ? 'text-rose-700' : fraction < 0 ? 'text-emerald-700' : 'text-content-muted',
      )}
    >
      {formatPct(fraction)}
    </span>
  )
}

function StackedComponents({ components, total }: { components: CostComponents; total: number }) {
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken">
        {COMPONENTS.map((c) => {
          const v = components[c.key]
          const pct = total > 0 ? (v / total) * 100 : 0
          return (
            <div
              key={c.key}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${pct}%`, backgroundColor: c.color }}
              title={`${c.label} · ${formatUsd(v)}`}
            />
          )
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {COMPONENTS.map((c) => {
          const v = components[c.key]
          const pct = total > 0 ? Math.round((v / total) * 100) : 0
          return (
            <div key={c.key} className="rounded-lg border border-edge-subtle bg-white px-3 py-2">
              <LegendDot color={c.color}>{c.label}</LegendDot>
              <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-content">
                {formatUsd(v)}
              </div>
              <div className="text-[10px] text-content-subtle">{pct}% of spend</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function BudgetCard({ cost }: { cost: CostBreakdown }) {
  if (cost.budget == null) {
    return (
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Monthly budget</div>
        </CardHeader>
        <CardBody>
          <EmptyState
            compact
            title="No budget configured"
            description="Set VITE_OPENCOST_MONTHLY_BUDGET to track spend against a threshold."
          />
        </CardBody>
      </Card>
    )
  }
  const budgetPct = Math.round((cost.monthlyTotal / cost.budget) * 100)
  const overBudget = cost.monthlyTotal > cost.budget
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-content">Monthly budget</div>
          <StatusBadge kind={overBudget ? 'degraded' : budgetPct >= 85 ? 'progressing' : 'healthy'}>
            {overBudget ? 'over budget' : budgetPct >= 85 ? 'near limit' : 'on track'}
          </StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="flex flex-col items-center gap-3">
        <DonutGauge
          value={cost.monthlyTotal}
          max={cost.budget}
          size={128}
          thickness={14}
          color={overBudget ? '#f43f5e' : budgetPct >= 85 ? '#f59e0b' : 'var(--color-brand-500)'}
          label={`${budgetPct}%`}
          caption="of budget"
        />
        <div className="w-full space-y-1 text-center text-xs text-content-muted">
          <div>
            {formatUsd(cost.monthlyTotal)} of {formatUsd(cost.budget)}
          </div>
          <div className={cn(overBudget ? 'font-medium text-rose-700' : 'text-content-subtle')}>
            {overBudget
              ? 'Over budget at the trailing 30-day run rate'
              : 'Within budget at the trailing 30-day run rate'}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

export function SpendSummary() {
  const query = useCostBreakdown()

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading OpenCost allocation…
      </div>
    )
  }
  if (query.isError) {
    return (
      <EmptyState
        title="Cost data unavailable"
        description={
          <>
            OpenCost could not be reached ({(query.error as Error)?.message ?? 'request failed'}).
            Configure <code className="font-mono">OPENCOST_URL</code> and ensure the OpenCost API is
            reachable through the console proxy.
          </>
        }
      />
    )
  }
  const cost = query.data
  if (!cost || cost.namespaces.length === 0) {
    return (
      <EmptyState
        title="No cost data"
        description="OpenCost returned no allocation for the selected window."
      />
    )
  }

  const columns: Column<NamespaceCost>[] = [
    {
      key: 'namespace',
      header: 'Namespace',
      cell: (r) => <div className="font-medium text-content">{r.namespace}</div>,
    },
    { key: 'monthly', header: 'Monthly', numeric: true, cell: (r) => formatUsd(r.total) },
    { key: 'mom', header: 'MoM', numeric: true, cell: (r) => <MoM fraction={r.momPct} /> },
    {
      key: 'share',
      header: 'Share',
      cell: (r) => (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken">
            <div className="h-full rounded-full bg-brand-500" style={{ width: `${r.share}%` }} />
          </div>
          <span className="w-10 text-right text-xs tabular-nums text-content-subtle">{r.share}%</span>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      {/* Hero + budget indicator. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
                  Estimated monthly spend
                </div>
                <div className="mt-1 flex items-baseline gap-3">
                  <span className="text-4xl font-semibold tabular-nums tracking-tight text-content">
                    {formatUsd(cost.monthlyTotal)}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                      cost.momPct > 0 ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700',
                    )}
                  >
                    {formatPct(cost.momPct)} MoM
                  </span>
                </div>
                <div className="mt-1 text-xs text-content-muted">
                  Trailing 30 days · OpenCost allocation
                </div>
              </div>
              <div className="flex gap-4 text-right">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-content-subtle">Prev month</div>
                  <div className="font-mono text-sm tabular-nums text-content-muted">
                    {formatUsd(cost.prevMonthTotal)}
                  </div>
                </div>
              </div>
            </div>
            <AreaChart
              points={cost.trend}
              color="var(--color-brand-500)"
              height={96}
              formatY={(v) => formatUsd(v)}
            />
            <div className="text-[10px] uppercase tracking-wider text-content-subtle">
              Trailing 6 months
            </div>
          </CardBody>
        </Card>

        <BudgetCard cost={cost} />
      </div>

      {/* Cost components (stacked). */}
      <Card>
        <CardHeader>
          <div className="text-sm font-semibold text-content">Cost by component</div>
          <div className="text-[11px] text-content-subtle">OpenCost allocation · compute / memory / storage / network</div>
        </CardHeader>
        <CardBody>
          <StackedComponents components={cost.components} total={cost.monthlyTotal} />
        </CardBody>
      </Card>

      {/* Breakdown by namespace. */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-content">By namespace</h3>
          <span className="text-[11px] text-content-subtle">{cost.namespaces.length} namespaces</span>
        </div>
        <DataTable columns={columns} rows={cost.namespaces} rowKey={(r) => r.namespace} striped />
      </div>

      {/* Top workloads. */}
      {cost.workloads.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-content">Top workloads</div>
              <span className="text-[11px] text-content-subtle">by monthly cost</span>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            <ul className="divide-y divide-edge-subtle">
              {cost.workloads.slice(0, 8).map((w) => {
                const pct = cost.monthlyTotal > 0 ? (w.total / cost.monthlyTotal) * 100 : 0
                return (
                  <li
                    key={`${w.namespace}/${w.workload}`}
                    className="flex items-center gap-4 px-5 py-2.5 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-content">{w.workload}</div>
                      <div className="text-[11px] text-content-subtle">
                        {w.namespace} · {w.kind}
                      </div>
                    </div>
                    <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-sunken">
                      <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="w-20 text-right font-mono text-sm tabular-nums text-content">
                      {formatUsd(w.total)}
                    </div>
                  </li>
                )
              })}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  )
}

export default SpendSummary
