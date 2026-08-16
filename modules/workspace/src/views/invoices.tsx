import { DataTable, EmptyState, StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  downloadInvoice,
  fmtMoney,
  isStoreUnavailable,
  useBillingInvoices,
  useGenerateInvoice,
  usePayInvoice,
  type Invoice,
  type InvoiceStatus,
} from '../data/billing.ts'
import {
  PrimaryButton,
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'

const STATUS_KIND: Record<InvoiceStatus, StatusKind> = {
  paid: 'healthy',
  open: 'progressing',
  void: 'unknown',
}

const isOverdue = (i: Invoice) => i.status === 'open' && new Date(i.dueAt).getTime() < Date.now()

function exportCsv(rows: Invoice[]) {
  const head = 'number,period,status,subtotal,tax,total,currency,issuedAt,dueAt,paidAt'
  const body = rows.map((i) =>
    [i.number, i.period, i.status, i.subtotal, i.tax, i.total, i.currency, i.issuedAt, i.dueAt, i.paidAt ?? ''].join(','),
  )
  const a = document.createElement('a')
  a.href = `data:text/csv;charset=utf-8,${encodeURIComponent([head, ...body].join('\n'))}`
  a.download = 'invoices.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function Invoices() {
  const q = useBillingInvoices()
  const generate = useGenerateInvoice()
  const pay = usePayInvoice()

  const all = q.data ?? []
  const open = all.filter((i) => i.status === 'open')
  const overdue = all.filter(isOverdue)
  const ytdPaid = all.filter((i) => i.status === 'paid').reduce((s, i) => s + i.total, 0)
  const outstanding = open.reduce((s, i) => s + i.total, 0)
  const latest = all[0]

  const dbGone = q.isError && isStoreUnavailable(q.error)

  return (
    <ViewShell
      title="Invoices"
      description="Generated per period from the persisted subscription plus metered usage overage — full line-item breakdown, idempotent per month."
      required={['billing', 'finance', 'owner']}
      actions={
        <>
          <SecondaryButton onClick={() => exportCsv(all)} disabled={all.length === 0}>
            <IconDownload /> Export CSV
          </SecondaryButton>
          <PrimaryButton onClick={() => generate.mutate(undefined)} disabled={generate.isPending || dbGone}>
            {generate.isPending ? 'Generating…' : 'Generate current period'}
          </PrimaryButton>
        </>
      }
    >
      {dbGone ? (
        <EmptyState
          title="Connect a database"
          description="Invoices are persisted in Postgres. Set DATABASE_URL for the console server to generate and store invoices."
        />
      ) : q.isError ? (
        <EmptyState
          title="Invoices unavailable"
          description={q.error instanceof Error ? q.error.message : 'The billing API did not respond.'}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label="Outstanding"
              value={fmtMoney(outstanding)}
              tone={outstanding > 0 ? 'warn' : 'good'}
            />
            <StatTile label="Overdue" value={overdue.length} tone={overdue.length > 0 ? 'bad' : 'good'} />
            <StatTile label="Paid (all time)" value={fmtMoney(ytdPaid)} tone="good" />
            <StatTile label="Invoices" value={all.length} hint="one per period" />
          </div>

          {generate.isError ? (
            <p className="text-[12px] text-rose-600">
              {generate.error instanceof Error ? generate.error.message : 'Generation failed.'}
            </p>
          ) : null}

          <SettingsCard title="History">
            <DataTable
              loading={q.isLoading}
              rows={all}
              rowKey={(i) => i.id}
              empty={
                <EmptyState
                  title="No invoices yet"
                  description="Generate the current period to create the first invoice from your subscription and metered usage."
                  action={
                    <PrimaryButton onClick={() => generate.mutate(undefined)} disabled={generate.isPending}>
                      Generate invoice
                    </PrimaryButton>
                  }
                />
              }
              columns={[
                {
                  key: 'number',
                  header: 'Invoice',
                  cell: (i) => (
                    <div>
                      <div className="font-mono text-[12px] text-content">{i.number}</div>
                      <div className="text-[11px] text-content-muted">
                        {i.periodStart} – {i.periodEnd}
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'amount',
                  header: 'Amount',
                  numeric: true,
                  cell: (i) => (
                    <span className="font-mono tabular-nums text-content">
                      {fmtMoney(i.total, i.currency)}
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (i) =>
                    isOverdue(i) ? (
                      <StatusBadge kind="failed">overdue</StatusBadge>
                    ) : (
                      <StatusBadge kind={STATUS_KIND[i.status]}>{i.status}</StatusBadge>
                    ),
                },
                {
                  key: 'due',
                  header: 'Due',
                  cell: (i) => (
                    <span className={isOverdue(i) ? 'text-rose-700' : ''}>
                      {formatRelative(i.dueAt)}
                    </span>
                  ),
                },
                {
                  key: 'paid',
                  header: 'Paid',
                  cell: (i) => (i.paidAt ? formatRelative(i.paidAt) : '—'),
                },
                {
                  key: 'actions',
                  header: '',
                  cell: (i) => (
                    <div className="flex justify-end gap-1.5">
                      <SecondaryButton onClick={() => void downloadInvoice(i.id)}>
                        <IconDownload /> Download
                      </SecondaryButton>
                      {i.status === 'open' ? (
                        <SecondaryButton onClick={() => pay.mutate(i.id)} disabled={pay.isPending}>
                          Mark paid
                        </SecondaryButton>
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
          </SettingsCard>

          {latest ? (
            <SettingsCard
              title={`Latest invoice — ${latest.number}`}
              description="Per-line breakdown exactly as it appears on the downloadable document."
            >
              <div className="overflow-hidden rounded-lg border border-edge-subtle">
                <table className="w-full text-sm">
                  <thead className="bg-surface-sunken text-[11px] uppercase tracking-wider text-content-subtle">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Description</th>
                      <th className="px-3 py-2 text-right font-medium">Quantity</th>
                      <th className="px-3 py-2 text-left font-medium">Unit</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge-subtle">
                    {latest.lineItems.map((l, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 text-content">{l.label}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                          {l.quantity.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-content-muted">{l.unit}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                          {fmtMoney(l.amount, latest.currency)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="px-3 py-2 text-content-muted" colSpan={3}>
                        Subtotal
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                        {fmtMoney(latest.subtotal, latest.currency)}
                      </td>
                    </tr>
                    <tr>
                      <td className="px-3 py-2 text-content-muted" colSpan={3}>
                        Tax ({Math.round(latest.taxRate * 100)}%)
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                        {fmtMoney(latest.tax, latest.currency)}
                      </td>
                    </tr>
                    <tr className="bg-surface-sunken/50 font-semibold">
                      <td className="px-3 py-2 text-content" colSpan={3}>
                        Total
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                        {fmtMoney(latest.total, latest.currency)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {latest.notes.length > 0 ? (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-[11px] text-content-muted">
                  {latest.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </SettingsCard>
          ) : null}
        </>
      )}
    </ViewShell>
  )
}

function IconDownload() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m6 11 6 6 6-6" />
      <path d="M5 21h14" />
    </svg>
  )
}

export default Invoices
