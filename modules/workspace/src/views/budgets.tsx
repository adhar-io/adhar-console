import { useState } from 'react'
import { EmptyState, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import {
  fmtMoney,
  isStoreUnavailable,
  useBillingBudgets,
  useDeleteBudget,
  useSaveBudget,
  type Budget,
  type BudgetInput,
} from '../data/billing.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const EMPTY_FORM: BudgetInput = {
  name: '',
  scope: 'organization',
  amountMonthly: 0,
  alertThresholdPct: 80,
}

export function Budgets() {
  const q = useBillingBudgets()
  const save = useSaveBudget()
  const del = useDeleteBudget()

  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<BudgetInput>(EMPTY_FORM)

  const all = q.data ?? []
  const costConnected = all.length === 0 || all.some((b) => b.costSource === 'opencost')
  const over = all.filter((b) => b.overBudget === true).length
  const forecastTotal = all.reduce((s, b) => s + (b.forecastSpend ?? 0), 0)
  const dbGone = q.isError && isStoreUnavailable(q.error)

  const openEditor = (b?: Budget) => {
    setEditing(b ? b.id : 'new')
    setForm(
      b
        ? {
            name: b.name,
            scope: b.scope === 'namespace' ? 'namespace' : 'organization',
            scopeRef: b.scopeRef,
            amountMonthly: b.amountMonthly,
            alertThresholdPct: b.alertThresholdPct,
            ownerEmail: b.ownerEmail,
          }
        : EMPTY_FORM,
    )
  }

  const submit = () => {
    if (!form.name.trim() || form.amountMonthly <= 0) return
    save.mutate(
      { id: editing === 'new' ? undefined : editing ?? undefined, input: form },
      { onSuccess: () => setEditing(null) },
    )
  }

  return (
    <ViewShell
      title="Budgets"
      description="Spend caps and alert thresholds at organization or namespace scope. Current spend is metered from OpenCost — when the meter isn't connected, no number is shown."
      required={['billing', 'finance', 'owner']}
      actions={
        <RequirePermission perm="budgets.write" required={['billing', 'finance', 'owner']} readOnly>
          <PrimaryButton onClick={() => openEditor()} disabled={dbGone}>
            <IconPlus /> New budget
          </PrimaryButton>
        </RequirePermission>
      }
    >
      {dbGone ? (
        <EmptyState
          title="Connect a database"
          description="Budgets are persisted in Postgres. Set DATABASE_URL for the console server."
        />
      ) : q.isError ? (
        <EmptyState
          title="Budgets unavailable"
          description={q.error instanceof Error ? q.error.message : 'The billing API did not respond.'}
        />
      ) : q.isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
          <Spinner size={14} /> Loading budgets…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Active budgets" value={all.length} />
            <StatTile
              label="Over budget"
              value={costConnected ? over : 'n/a'}
              tone={over ? 'bad' : 'good'}
              hint={costConnected ? 'metered spend > cap' : 'cost data not connected'}
            />
            <StatTile
              label="Forecast (combined)"
              value={costConnected && all.length > 0 ? fmtMoney(forecastTotal) : 'n/a'}
              hint={costConnected ? 'linear projection to month end' : 'cost data not connected'}
            />
            <StatTile label="Alerts wired" value={all.length} hint="one threshold per budget" />
          </div>

          {!costConnected && all.length > 0 ? (
            <p className="rounded-lg border border-edge-subtle bg-surface-sunken/60 px-4 py-2.5 text-[12px] text-content-muted">
              Cost data not connected — set <code className="font-mono">OPENCOST_URL</code> to meter
              spend against these caps. Caps and thresholds are saved and take effect as soon as the
              meter is live.
            </p>
          ) : null}

          {editing !== null ? (
            <SettingsCard title={editing === 'new' ? 'New budget' : 'Edit budget'}>
              <SettingsRow label="Name">
                <TextField
                  value={form.name}
                  onChange={(name) => setForm((f) => ({ ...f, name }))}
                  placeholder="Org · Monthly"
                />
              </SettingsRow>
              <SettingsRow label="Scope" description="Organization = all tenant namespaces.">
                <SelectField
                  value={form.scope ?? 'organization'}
                  onChange={(scope) => setForm((f) => ({ ...f, scope }))}
                  options={[
                    { value: 'organization', label: 'Organization' },
                    { value: 'namespace', label: 'Namespace' },
                  ]}
                />
              </SettingsRow>
              {form.scope === 'namespace' ? (
                <SettingsRow label="Namespace">
                  <TextField
                    value={form.scopeRef ?? ''}
                    onChange={(scopeRef) => setForm((f) => ({ ...f, scopeRef }))}
                    placeholder="production"
                    mono
                  />
                </SettingsRow>
              ) : null}
              <SettingsRow label="Monthly cap (USD)">
                <TextField
                  value={form.amountMonthly ? String(form.amountMonthly) : ''}
                  onChange={(v) => setForm((f) => ({ ...f, amountMonthly: Number(v) || 0 }))}
                  type="number"
                />
              </SettingsRow>
              <SettingsRow label="Alert threshold (%)" description="Notify when metered spend crosses this share of the cap.">
                <TextField
                  value={String(form.alertThresholdPct)}
                  onChange={(v) =>
                    setForm((f) => ({ ...f, alertThresholdPct: Math.min(100, Math.max(1, Number(v) || 80)) }))
                  }
                  type="number"
                />
              </SettingsRow>
              <SettingsRow label="Owner email">
                <TextField
                  value={form.ownerEmail ?? ''}
                  onChange={(ownerEmail) => setForm((f) => ({ ...f, ownerEmail }))}
                  placeholder="finance@example.com"
                  type="email"
                />
              </SettingsRow>
              <div className="mt-4 flex items-center gap-2">
                <PrimaryButton onClick={submit} disabled={save.isPending || !form.name.trim() || form.amountMonthly <= 0}>
                  {save.isPending ? 'Saving…' : 'Save budget'}
                </PrimaryButton>
                <SecondaryButton onClick={() => setEditing(null)}>Cancel</SecondaryButton>
                {save.isError ? (
                  <span className="text-[12px] text-rose-600">
                    {save.error instanceof Error ? save.error.message : 'Save failed.'}
                  </span>
                ) : null}
              </div>
            </SettingsCard>
          ) : null}

          {all.length === 0 && editing === null ? (
            <EmptyState
              title="No budgets yet"
              description="Create a spend cap for the organization or a single namespace — metered spend is tracked against it automatically."
              action={<PrimaryButton onClick={() => openEditor()}>New budget</PrimaryButton>}
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {all.map((b) => {
                const connected = b.costSource === 'opencost' && b.currentSpend !== null
                const pctSpend = connected ? Math.round((b.currentSpend! / b.amountMonthly) * 100) : null
                const pctForecast =
                  connected && b.forecastSpend !== null
                    ? Math.round((b.forecastSpend / b.amountMonthly) * 100)
                    : null
                const tone =
                  pctForecast === null
                    ? 'var(--color-brand-500)'
                    : pctForecast >= 100
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
                      pctForecast !== null ? (
                        <StatusBadge kind={pctForecast >= 100 ? 'failed' : pctForecast >= 90 ? 'paused' : 'healthy'}>
                          {pctForecast}% forecast
                        </StatusBadge>
                      ) : (
                        <StatusBadge kind="unknown">no cost data</StatusBadge>
                      )
                    }
                  >
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3 text-[12px]">
                        <KV label="Cap" value={fmtMoney(b.amountMonthly)} />
                        <KV
                          label="Spend (MTD)"
                          value={connected ? fmtMoney(b.currentSpend!) : 'not connected'}
                        />
                        <KV
                          label="Forecast"
                          value={connected && b.forecastSpend !== null ? fmtMoney(b.forecastSpend) : 'not connected'}
                        />
                        <KV label="Owner" value={b.ownerEmail ?? '—'} />
                      </div>

                      <div>
                        <div className="relative h-2 overflow-hidden rounded-full bg-surface-sunken">
                          <span
                            aria-hidden
                            className="absolute top-0 h-full w-px bg-content-subtle/50"
                            style={{ left: `${b.alertThresholdPct}%` }}
                          />
                          <div
                            className="h-full rounded-full transition-[width] duration-500"
                            style={{
                              width: `${Math.min(100, pctSpend ?? 0)}%`,
                              backgroundColor: tone,
                            }}
                          />
                        </div>
                        <div className="mt-1 flex items-baseline justify-between text-[10px] font-mono uppercase tracking-wider text-content-subtle">
                          <span>0</span>
                          <span>alert @ {b.alertThresholdPct}%</span>
                          <span>{fmtMoney(b.amountMonthly)}</span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <div>
                          {b.overBudget === true ? (
                            <StatusBadge kind="failed">Over budget</StatusBadge>
                          ) : b.overBudget === false ? (
                            <StatusBadge kind="healthy">Within cap</StatusBadge>
                          ) : (
                            <span className="text-content-subtle">Cost data not connected</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <SecondaryButton onClick={() => openEditor(b)}>Edit</SecondaryButton>
                          <SecondaryButton tone="rose" onClick={() => del.mutate(b.id)} disabled={del.isPending}>
                            Delete
                          </SecondaryButton>
                        </div>
                      </div>
                    </div>
                  </SettingsCard>
                )
              })}
            </div>
          )}
        </>
      )}
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
