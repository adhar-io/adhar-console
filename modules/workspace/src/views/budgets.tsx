import { StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { fmtMoney, useBudgets } from '../data/enterprise.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

export function Budgets() {
  const q = useBudgets()
  const all = q.data ?? []
  const exceeded = all.filter((b) => b.currentSpend / b.amount > 0.95).length

  return (
    <ViewShell
      title="Budgets"
      description="Spend caps, alert thresholds, and forecasts at any scope (org, environment, cost center, project). Hard limits block new resource creation when crossed."
      required={['billing', 'finance', 'owner']}
      actions={
        <RequirePermission perm="budgets.write" required={['billing', 'finance', 'owner']} readOnly>
          <PrimaryButton>
            <IconPlus /> New budget
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Active budgets" value={all.length} />
        <StatTile label="Over threshold" value={exceeded} tone={exceeded ? 'bad' : 'good'} />
        <StatTile
          label="Forecast (combined)"
          value={fmtMoney(all.reduce((s, b) => s + b.forecastSpend, 0))}
          hint="end of month"
        />
        <StatTile
          label="Alerts wired"
          value={all.reduce((s, b) => s + b.alertThresholds.length, 0)}
          hint="threshold notifications"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {all.map((b) => {
          const pctSpend = Math.round((b.currentSpend / b.amount) * 100)
          const pctForecast = Math.round((b.forecastSpend / b.amount) * 100)
          const tone =
            pctForecast >= 100
              ? '#f43f5e'
              : pctForecast >= 90
                ? '#f59e0b'
                : 'var(--color-brand-500)'
          return (
            <SettingsCard
              key={b.id}
              title={b.name}
              description={`Scope: ${b.scope}${b.scopeRef ? ` · ${b.scopeRef}` : ''}`}
              actions={
                <StatusBadge kind={pctForecast >= 100 ? 'failed' : pctForecast >= 90 ? 'paused' : 'healthy'}>
                  {pctForecast}% forecast
                </StatusBadge>
              }
            >
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 text-[12px]">
                  <KV label="Cap" value={fmtMoney(b.amount, b.currency)} />
                  <KV label="Spend (MTD)" value={fmtMoney(b.currentSpend, b.currency)} />
                  <KV label="Forecast" value={fmtMoney(b.forecastSpend, b.currency)} />
                  <KV label="Owner" value={b.ownerEmail} />
                </div>

                <div>
                  <div className="relative h-2 overflow-hidden rounded-full bg-surface-sunken">
                    {b.alertThresholds.map((t, i) => (
                      <span
                        key={i}
                        aria-hidden
                        className="absolute top-0 h-full w-px bg-content-subtle/50"
                        style={{ left: `${t * 100}%` }}
                      />
                    ))}
                    <div
                      className="h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${Math.min(100, pctSpend)}%`, backgroundColor: tone }}
                    />
                  </div>
                  <div className="mt-1 flex items-baseline justify-between text-[10px] font-mono uppercase tracking-wider text-content-subtle">
                    <span>0</span>
                    {b.alertThresholds.map((t) => (
                      <span key={t} className="absolute">
                        {Math.round(t * 100)}%
                      </span>
                    ))}
                    <span>{fmtMoney(b.amount, b.currency)}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <div className="flex flex-wrap gap-1.5">
                    {b.alertThresholds.map((t) => (
                      <span
                        key={t}
                        className={cn(
                          'rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset',
                          t === 1
                            ? 'bg-rose-50 text-rose-700 ring-rose-200'
                            : t >= 0.85
                              ? 'bg-amber-50 text-amber-700 ring-amber-200'
                              : 'bg-sky-50 text-sky-700 ring-sky-200',
                        )}
                      >
                        Alert @ {Math.round(t * 100)}%
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {b.hardLimit ? (
                      <StatusBadge kind="failed">Hard limit</StatusBadge>
                    ) : (
                      <StatusBadge kind="info">Soft limit</StatusBadge>
                    )}
                    <SecondaryButton>Edit</SecondaryButton>
                  </div>
                </div>
              </div>
            </SettingsCard>
          )
        })}
      </div>
    </ViewShell>
  )
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] font-medium text-content">{value}</div>
    </div>
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

export default Budgets
