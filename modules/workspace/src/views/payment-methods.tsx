import { useState } from 'react'
import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  isStoreUnavailable,
  useAddPaymentMethod,
  useBillingPaymentMethods,
  useDeletePaymentMethod,
  useSetDefaultPaymentMethod,
  type PaymentMethodInput,
  type PaymentMethodKind,
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

const KIND_LABEL: Record<PaymentMethodKind, string> = {
  card: 'Credit card',
  invoice: 'Net-30 invoice',
  ach: 'Bank (ACH)',
}

const EMPTY_FORM: PaymentMethodInput = { kind: 'card', label: '' }

export function PaymentMethods() {
  const q = useBillingPaymentMethods()
  const add = useAddPaymentMethod()
  const setDefault = useSetDefaultPaymentMethod()
  const remove = useDeletePaymentMethod()

  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<PaymentMethodInput>(EMPTY_FORM)

  const all = q.data ?? []
  const def = all.find((m) => m.isDefault)
  const card = all.find((m) => m.kind === 'card')
  const invoiceMethod = all.find((m) => m.kind === 'invoice')
  const dbGone = q.isError && isStoreUnavailable(q.error)

  const submit = () => {
    if (!form.label.trim()) return
    add.mutate(
      {
        ...form,
        brand: form.brand?.trim() || undefined,
        last4: form.last4?.trim() || undefined,
        expiresOn: form.expiresOn?.trim() || undefined,
        holder: form.holder?.trim() || undefined,
        email: form.email?.trim() || undefined,
      },
      {
        onSuccess: () => {
          setAdding(false)
          setForm(EMPTY_FORM)
        },
      },
    )
  }

  return (
    <ViewShell
      title="Payment methods"
      description="One default method is charged on the renewal date. Only processor metadata (brand, last 4, expiry) is stored here — never a full card number."
      required={['billing', 'owner']}
      actions={
        <RequirePermission perm="payments.write" required={['billing', 'owner']} readOnly>
          <PrimaryButton onClick={() => setAdding((v) => !v)} disabled={dbGone}>
            <IconPlus /> Add method
          </PrimaryButton>
        </RequirePermission>
      }
    >
      {dbGone ? (
        <EmptyState
          title="Connect a database"
          description="Payment-method metadata is persisted in Postgres. Set DATABASE_URL for the console server."
        />
      ) : q.isError ? (
        <EmptyState
          title="Payment methods unavailable"
          description={q.error instanceof Error ? q.error.message : 'The billing API did not respond.'}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Methods on file" value={all.length} />
            <StatTile
              label="Default"
              value={def?.label ?? 'None'}
              tone={def ? 'good' : all.length > 0 ? 'bad' : 'default'}
              hint={def ? KIND_LABEL[def.kind] : all.length > 0 ? 'Action required' : 'Add a method'}
            />
            <StatTile
              label="Card expiry"
              value={card?.expiresOn ? formatYmToReadable(card.expiresOn) : '—'}
            />
            <StatTile label="Invoicing email" value={invoiceMethod?.email ?? '—'} />
          </div>

          {adding ? (
            <SettingsCard
              title="Add payment method"
              description="Metadata only — the processor (or your AP workflow) owns the sensitive credentials. Full card numbers are rejected by the API."
            >
              <SettingsRow label="Type">
                <SelectField
                  value={form.kind}
                  onChange={(kind) => setForm((f) => ({ ...f, kind }))}
                  options={[
                    { value: 'card', label: 'Credit card' },
                    { value: 'invoice', label: 'Net-30 invoice' },
                    { value: 'ach', label: 'Bank (ACH)' },
                  ]}
                />
              </SettingsRow>
              <SettingsRow label="Label" description="How this method appears on billing pages.">
                <TextField
                  value={form.label}
                  onChange={(label) => setForm((f) => ({ ...f, label }))}
                  placeholder="Corporate Visa"
                />
              </SettingsRow>
              {form.kind === 'card' ? (
                <>
                  <SettingsRow label="Brand">
                    <TextField
                      value={form.brand ?? ''}
                      onChange={(brand) => setForm((f) => ({ ...f, brand }))}
                      placeholder="Visa"
                    />
                  </SettingsRow>
                  <SettingsRow label="Last 4 digits" description="Only the last 4 — never the full number.">
                    <TextField
                      value={form.last4 ?? ''}
                      onChange={(last4) => setForm((f) => ({ ...f, last4: last4.slice(0, 4) }))}
                      placeholder="4242"
                      mono
                    />
                  </SettingsRow>
                  <SettingsRow label="Expiry" description="YYYY-MM">
                    <TextField
                      value={form.expiresOn ?? ''}
                      onChange={(expiresOn) => setForm((f) => ({ ...f, expiresOn }))}
                      placeholder="2028-04"
                      mono
                    />
                  </SettingsRow>
                  <SettingsRow label="Cardholder">
                    <TextField
                      value={form.holder ?? ''}
                      onChange={(holder) => setForm((f) => ({ ...f, holder }))}
                      placeholder="ACME Finance"
                    />
                  </SettingsRow>
                </>
              ) : form.kind === 'invoice' ? (
                <SettingsRow label="AP email" description="Invoices are sent to this address.">
                  <TextField
                    value={form.email ?? ''}
                    onChange={(email) => setForm((f) => ({ ...f, email }))}
                    placeholder="ap@example.com"
                    type="email"
                  />
                </SettingsRow>
              ) : (
                <SettingsRow label="Account last 4">
                  <TextField
                    value={form.last4 ?? ''}
                    onChange={(last4) => setForm((f) => ({ ...f, last4: last4.slice(0, 4) }))}
                    placeholder="8821"
                    mono
                  />
                </SettingsRow>
              )}
              <div className="mt-4 flex items-center gap-2">
                <PrimaryButton onClick={submit} disabled={add.isPending || !form.label.trim()}>
                  {add.isPending ? 'Saving…' : 'Save method'}
                </PrimaryButton>
                <SecondaryButton onClick={() => setAdding(false)}>Cancel</SecondaryButton>
                {add.isError ? (
                  <span className="text-[12px] text-rose-600">
                    {add.error instanceof Error ? add.error.message : 'Save failed.'}
                  </span>
                ) : null}
              </div>
            </SettingsCard>
          ) : null}

          <SettingsCard title="On file">
            <DataTable
              loading={q.isLoading}
              rows={all}
              rowKey={(m) => m.id}
              empty={
                <EmptyState
                  title="No payment methods on file"
                  description="Add a method so renewals aren't interrupted."
                />
              }
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
                        <code className="text-[11px] text-content-muted">
                          {m.kind === 'invoice' ? m.email ?? '—' : m.last4 ? `•••• ${m.last4}` : '—'}
                        </code>
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
                  cell: (m) => (m.isDefault ? <StatusBadge kind="healthy">Yes</StatusBadge> : '—'),
                },
                { key: 'added-by', header: 'Added by', cell: (m) => m.addedBy ?? '—' },
                { key: 'added', header: 'Added', cell: (m) => formatRelative(m.addedAt) },
                {
                  key: 'actions',
                  header: '',
                  cell: (m) => (
                    <div className="flex justify-end gap-1.5">
                      {m.isDefault ? null : (
                        <SecondaryButton onClick={() => setDefault.mutate(m.id)} disabled={setDefault.isPending}>
                          Make default
                        </SecondaryButton>
                      )}
                      <SecondaryButton tone="rose" onClick={() => remove.mutate(m.id)} disabled={remove.isPending}>
                        Remove
                      </SecondaryButton>
                    </div>
                  ),
                },
              ]}
            />
          </SettingsCard>

          <SettingsCard
            title="Billing contact"
            description="Invoices and payment-failure alerts route to the default invoicing method's address."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Pair label="Primary email" value={invoiceMethod?.email ?? 'Not configured'} />
              <Pair label="Default method" value={def?.label ?? 'None'} />
              <Pair label="Currency" value="USD" />
              <Pair label="Tax" value="Not configured (0%)" />
            </div>
          </SettingsCard>
        </>
      )}
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
