import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { usePaymentMethods, type PaymentMethod } from '../data/enterprise.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'
import { RequirePermission } from '../components/role-gate.tsx'

const KIND_LABEL: Record<PaymentMethod['kind'], string> = {
  card: 'Credit card',
  invoice: 'Net-30 invoice',
  ach: 'Bank (ACH)',
}

export function PaymentMethods() {
  const q = usePaymentMethods()
  const all = q.data ?? []
  const def = all.find((m) => m.isDefault)

  return (
    <ViewShell
      title="Payment methods"
      description="One default method is charged on the renewal date. Add a backup to avoid service interruption."
      required={['billing', 'owner']}
      actions={
        <RequirePermission perm="payments.write" required={['billing', 'owner']} readOnly>
          <PrimaryButton>
            <IconPlus /> Add method
          </PrimaryButton>
        </RequirePermission>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Methods on file" value={all.length} />
        <StatTile
          label="Default"
          value={def?.label ?? 'None'}
          tone={def ? 'good' : 'bad'}
          hint={def ? KIND_LABEL[def.kind] : 'Action required'}
        />
        <StatTile
          label="Card expiry"
          value={
            all.find((m) => m.kind === 'card')?.expiresOn
              ? formatYmToReadable(all.find((m) => m.kind === 'card')!.expiresOn!)
              : '—'
          }
        />
        <StatTile label="Invoicing email" value={all.find((m) => m.kind === 'invoice')?.identifier ?? '—'} />
      </div>

      <SettingsCard title="On file">
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(m) => m.id}
          empty={<EmptyState title="No payment methods on file" />}
          columns={[
            {
              key: 'method',
              header: 'Method',
              cell: (m) => (
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-12 items-center justify-center rounded-md bg-surface-sunken text-[10px] font-semibold uppercase tracking-widest text-content-muted ring-1 ring-edge-subtle">
                    {m.brand ?? m.kind.toUpperCase()}
                  </span>
                  <div>
                    <div className="font-medium text-content">{m.label}</div>
                    <code className="text-[11px] text-content-muted">{m.identifier}</code>
                  </div>
                </div>
              ),
            },
            {
              key: 'kind',
              header: 'Type',
              cell: (m) => (
                <StatusBadge kind={m.kind === 'card' ? 'info' : m.kind === 'invoice' ? 'progressing' : 'paused'}>
                  {KIND_LABEL[m.kind]}
                </StatusBadge>
              ),
            },
            {
              key: 'expires',
              header: 'Expires',
              cell: (m) => (m.expiresOn ? formatYmToReadable(m.expiresOn) : '—'),
            },
            {
              key: 'default',
              header: 'Default',
              cell: (m) =>
                m.isDefault ? <StatusBadge kind="healthy">Yes</StatusBadge> : '—',
            },
            { key: 'added-by', header: 'Added by', cell: (m) => m.addedBy },
            { key: 'added', header: 'Added', cell: (m) => formatRelative(m.addedAt) },
            {
              key: 'actions',
              header: '',
              cell: (m) => (
                <div className="flex justify-end gap-1.5">
                  {m.isDefault ? null : <SecondaryButton>Make default</SecondaryButton>}
                  <SecondaryButton tone="rose">Remove</SecondaryButton>
                </div>
              ),
            },
          ]}
        />
      </SettingsCard>

      <SettingsCard
        title="Billing contact"
        description="Invoices and payment failure alerts route here. Use a shared inbox to avoid single-person dependency."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Pair label="Primary email" value="ap@acme.com" />
          <Pair label="Cc" value="finance@acme.com" />
          <Pair label="Tax ID" value="US-FEIN 12-3456789" />
          <Pair label="Billing address" value="100 Market St · San Francisco · CA 94105" />
          <Pair label="Currency" value="USD" />
          <Pair label="Tax exempt" value="No" />
        </div>
      </SettingsCard>
    </ViewShell>
  )
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-content">{value}</div>
    </div>
  )
}

function formatYmToReadable(ym: string): string {
  // 2027-04 → Apr 2027
  const [y, m] = ym.split('-')
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const idx = (parseInt(m, 10) || 1) - 1
  return `${months[idx] ?? m} ${y}`
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export default PaymentMethods
