import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { fmtMoney, useCostCenters } from '../data/enterprise.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function CostCenters() {
  const q = useCostCenters()
  const all = q.data ?? []
  const totalBudget = all.reduce((s, c) => s + c.monthlyBudget, 0)
  const mtd = all.reduce((s, c) => s + c.monthToDateSpend, 0)
  const trailing = all.reduce((s, c) => s + c.trailingMonthSpend, 0)
  const utilization = totalBudget ? Math.round((mtd / totalBudget) * 100) : 0

  return (
    <ViewShell
      title="Cost centers"
      description="Chargeback structure: every workload tagged with a cost center routes spend to the right team or BU. Edits require Billing or Finance."
      required={['billing', 'finance', 'owner']}
      actions={
        <RequirePermission perm="costcenters.write" required={['billing', 'finance', 'owner']} readOnly>
          <PrimaryButton>
            <IconPlus /> New cost center
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Cost centers" value={all.length} />
        <StatTile label="Combined budget" value={fmtMoney(totalBudget)} hint="this month" />
        <StatTile
          label="Spend (MTD)"
          value={fmtMoney(mtd)}
          tone={utilization > 95 ? 'bad' : utilization > 80 ? 'warn' : 'good'}
          hint={`${utilization}% of budget`}
        />
        <StatTile label="Trailing month" value={fmtMoney(trailing)} hint="run-rate baseline" />
      </div>

      <SettingsCard
        title="Allocation"
        description="Each cost center owns a budget cap and a tag selector that scopes which workloads get charged to it."
      >
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(c) => c.id}
          empty={<EmptyState title="No cost centers yet" />}
          columns={[
            {
              key: 'cc',
              header: 'Cost center',
              cell: (c) => (
                <div>
                  <div className="font-medium text-content">{c.name}</div>
                  <code className="text-[11px] text-content-muted">{c.code}</code>
                </div>
              ),
            },
            { key: 'owner', header: 'Owner', cell: (c) => c.ownerEmail },
            {
              key: 'selector',
              header: 'Tag selector',
              cell: (c) => (
                <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">
                  {c.tagSelector}
                </code>
              ),
            },
            {
              key: 'budget',
              header: 'Monthly budget',
              numeric: true,
              cell: (c) => (
                <span className="font-mono tabular-nums text-content">{fmtMoney(c.monthlyBudget)}</span>
              ),
            },
            {
              key: 'spend',
              header: 'Spend (MTD)',
              cell: (c) => {
                const pct = c.monthlyBudget ? Math.round((c.monthToDateSpend / c.monthlyBudget) * 100) : 0
                const color =
                  pct > 95 ? '#f43f5e' : pct > 80 ? '#f59e0b' : 'var(--color-brand-500)'
                return (
                  <div className="min-w-[180px]">
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="font-mono tabular-nums text-content">
                        {fmtMoney(c.monthToDateSpend)}
                      </span>
                      <span
                        className={cn(
                          'font-mono tabular-nums',
                          pct > 95 ? 'text-rose-700' : pct > 80 ? 'text-amber-700' : 'text-content-muted',
                        )}
                      >
                        {pct}%
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                      <div
                        className="h-full rounded-full transition-[width] duration-500"
                        style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
                      />
                    </div>
                  </div>
                )
              },
            },
            {
              key: 'status',
              header: 'Status',
              cell: (c) => {
                const pct = c.monthlyBudget ? c.monthToDateSpend / c.monthlyBudget : 0
                if (pct > 0.95) return <StatusBadge kind="failed">over</StatusBadge>
                if (pct > 0.8) return <StatusBadge kind="paused">at risk</StatusBadge>
                return <StatusBadge kind="healthy">on track</StatusBadge>
              },
            },
            {
              key: 'actions',
              header: '',
              cell: () => (
                <div className="flex justify-end gap-1.5">
                  <SecondaryButton>Open</SecondaryButton>
                  <SecondaryButton>Edit</SecondaryButton>
                </div>
              ),
            },
          ]}
        />
      </SettingsCard>
    </ViewShell>
  )
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export default CostCenters
