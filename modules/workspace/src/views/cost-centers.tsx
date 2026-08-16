import { useState } from 'react'
import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import {
  fmtMoney,
  isStoreUnavailable,
  useBillingCostCenters,
  useDeleteCostCenter,
  useSaveCostCenter,
  type Budget,
  type BudgetInput,
} from '../data/billing.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  SettingsRow,
  StatTile,
  TextField,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

interface CcForm {
  name: string
  code: string
  ownerEmail: string
  namespaces: string
  amountMonthly: number
}

const EMPTY_FORM: CcForm = { name: '', code: '', ownerEmail: '', namespaces: '', amountMonthly: 0 }

export function CostCenters() {
  const q = useBillingCostCenters()
  const save = useSaveCostCenter()
  const del = useDeleteCostCenter()

  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<CcForm>(EMPTY_FORM)

  const all = q.data ?? []
  const costConnected = all.some((c) => c.costSource === 'opencost')
  const totalBudget = all.reduce((s, c) => s + c.amountMonthly, 0)
  const mtd = costConnected ? all.reduce((s, c) => s + (c.currentSpend ?? 0), 0) : null
  const trailing = costConnected ? all.reduce((s, c) => s + (c.trailingMonthSpend ?? 0), 0) : null
  const utilization = mtd !== null && totalBudget ? Math.round((mtd / totalBudget) * 100) : null
  const dbGone = q.isError && isStoreUnavailable(q.error)

  const openEditor = (c?: Budget) => {
    setEditing(c ? c.id : 'new')
    setForm(
      c
        ? {
            name: c.name,
            code: c.code ?? '',
            ownerEmail: c.ownerEmail ?? '',
            namespaces: (c.namespaces ?? []).join(', '),
            amountMonthly: c.amountMonthly,
          }
        : EMPTY_FORM,
    )
  }

  const submit = () => {
    if (!form.name.trim()) return
    const input: BudgetInput = {
      name: form.name.trim(),
      code: form.code.trim() || undefined,
      ownerEmail: form.ownerEmail.trim() || undefined,
      namespaces: form.namespaces
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      amountMonthly: form.amountMonthly,
      alertThresholdPct: 80,
    }
    save.mutate(
      { id: editing === 'new' ? undefined : editing ?? undefined, input },
      { onSuccess: () => setEditing(null) },
    )
  }

  return (
    <ViewShell
      title="Cost centers"
      description="Chargeback structure: each cost center owns a budget cap and an explicit namespace allocation. Spend is metered from OpenCost per namespace."
      required={['billing', 'finance', 'owner']}
      actions={
        <RequirePermission perm="costcenters.write" required={['billing', 'finance', 'owner']} readOnly>
          <PrimaryButton onClick={() => openEditor()} disabled={dbGone}>
            <IconPlus /> New cost center
          </PrimaryButton>
        </RequirePermission>
      }
    >
      {dbGone ? (
        <EmptyState
          title="Connect a database"
          description="Cost centers are persisted in Postgres. Set DATABASE_URL for the console server."
        />
      ) : q.isError ? (
        <EmptyState
          title="Cost centers unavailable"
          description={q.error instanceof Error ? q.error.message : 'The billing API did not respond.'}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Cost centers" value={all.length} />
            <StatTile label="Combined budget" value={fmtMoney(totalBudget)} hint="this month" />
            <StatTile
              label="Spend (MTD)"
              value={mtd !== null ? fmtMoney(mtd) : 'n/a'}
              tone={
                utilization === null ? 'default' : utilization > 95 ? 'bad' : utilization > 80 ? 'warn' : 'good'
              }
              hint={utilization !== null ? `${utilization}% of budget` : 'cost data not connected'}
            />
            <StatTile
              label="Trailing month"
              value={trailing !== null ? fmtMoney(trailing) : 'n/a'}
              hint={trailing !== null ? 'previous full month' : 'cost data not connected'}
            />
          </div>

          {editing !== null ? (
            <SettingsCard title={editing === 'new' ? 'New cost center' : 'Edit cost center'}>
              <SettingsRow label="Name">
                <TextField value={form.name} onChange={(name) => setForm((f) => ({ ...f, name }))} placeholder="R&D Engineering" />
              </SettingsRow>
              <SettingsRow label="Code">
                <TextField value={form.code} onChange={(code) => setForm((f) => ({ ...f, code }))} placeholder="CC-100" mono />
              </SettingsRow>
              <SettingsRow label="Owner email">
                <TextField value={form.ownerEmail} onChange={(ownerEmail) => setForm((f) => ({ ...f, ownerEmail }))} type="email" placeholder="lead@example.com" />
              </SettingsRow>
              <SettingsRow
                label="Namespaces"
                description="Comma-separated namespace names whose metered cost is charged to this center."
              >
                <TextField
                  value={form.namespaces}
                  onChange={(namespaces) => setForm((f) => ({ ...f, namespaces }))}
                  placeholder="platform, web, infra"
                  mono
                />
              </SettingsRow>
              <SettingsRow label="Monthly budget (USD)">
                <TextField
                  value={form.amountMonthly ? String(form.amountMonthly) : ''}
                  onChange={(v) => setForm((f) => ({ ...f, amountMonthly: Number(v) || 0 }))}
                  type="number"
                />
              </SettingsRow>
              <div className="mt-4 flex items-center gap-2">
                <PrimaryButton onClick={submit} disabled={save.isPending || !form.name.trim()}>
                  {save.isPending ? 'Saving…' : 'Save cost center'}
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

          <SettingsCard
            title="Allocation"
            description="Each cost center owns a budget cap and a namespace allocation that scopes which workloads get charged to it."
          >
            <DataTable
              loading={q.isLoading}
              rows={all}
              rowKey={(c) => c.id}
              empty={
                <EmptyState
                  title="No cost centers yet"
                  description="Create one to route metered namespace spend to a team or business unit."
                  action={<PrimaryButton onClick={() => openEditor()}>New cost center</PrimaryButton>}
                />
              }
              columns={[
                {
                  key: 'cc',
                  header: 'Cost center',
                  cell: (c) => (
                    <div>
                      <div className="font-medium text-content">{c.name}</div>
                      <code className="text-[11px] text-content-muted">{c.code ?? '—'}</code>
                    </div>
                  ),
                },
                { key: 'owner', header: 'Owner', cell: (c) => c.ownerEmail ?? '—' },
                {
                  key: 'selector',
                  header: 'Namespaces',
                  cell: (c) => (
                    <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-content-muted">
                      {(c.namespaces ?? []).join(', ') || '—'}
                    </code>
                  ),
                },
                {
                  key: 'budget',
                  header: 'Monthly budget',
                  numeric: true,
                  cell: (c) => (
                    <span className="font-mono tabular-nums text-content">{fmtMoney(c.amountMonthly)}</span>
                  ),
                },
                {
                  key: 'spend',
                  header: 'Spend (MTD)',
                  cell: (c) => {
                    if (c.costSource !== 'opencost' || c.currentSpend === null) {
                      return <span className="text-[11px] text-content-subtle">cost data not connected</span>
                    }
                    const pct = c.amountMonthly ? Math.round((c.currentSpend / c.amountMonthly) * 100) : 0
                    const color = pct > 95 ? '#f43f5e' : pct > 80 ? '#f59e0b' : 'var(--color-brand-500)'
                    return (
                      <div className="min-w-[180px]">
                        <div className="flex items-baseline justify-between text-[11px]">
                          <span className="font-mono tabular-nums text-content">{fmtMoney(c.currentSpend)}</span>
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
                    if (c.overBudget === null) return <StatusBadge kind="unknown">no data</StatusBadge>
                    if (c.overBudget) return <StatusBadge kind="failed">over</StatusBadge>
                    const pct = c.amountMonthly && c.currentSpend !== null ? c.currentSpend / c.amountMonthly : 0
                    if (pct > 0.8) return <StatusBadge kind="paused">at risk</StatusBadge>
                    return <StatusBadge kind="healthy">on track</StatusBadge>
                  },
                },
                {
                  key: 'actions',
                  header: '',
                  cell: (c) => (
                    <div className="flex justify-end gap-1.5">
                      <SecondaryButton onClick={() => openEditor(c)}>Edit</SecondaryButton>
                      <SecondaryButton tone="rose" onClick={() => del.mutate(c.id)} disabled={del.isPending}>
                        Delete
                      </SecondaryButton>
                    </div>
                  ),
                },
              ]}
            />
          </SettingsCard>
        </>
      )}
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
