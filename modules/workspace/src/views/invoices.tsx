import { DataTable, EmptyState, StatusBadge, type StatusKind } from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import { fmtMoney, useInvoices, type InvoiceStatus } from '../data/enterprise.ts'
import {
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'

const STATUS_KIND: Record<InvoiceStatus, StatusKind> = {
  paid: 'healthy',
  open: 'progressing',
  overdue: 'failed',
  void: 'unknown',
}

export function Invoices() {
  const q = useInvoices()
  const all = q.data ?? []
  const open = all.filter((i) => i.status === 'open' || i.status === 'overdue')
  const overdue = all.filter((i) => i.status === 'overdue')
  const ytdPaid = all
    .filter((i) => i.status === 'paid')
    .reduce((s, i) => s + i.amount, 0)
  const outstanding = open.reduce((s, i) => s + i.amount, 0)

  return (
    <ViewShell
      title="Invoices"
      description="Every invoice with full line-item breakdown. Download PDFs, or wire your AP system to the BFF for an automated push."
      required={['billing', 'finance', 'owner']}
      actions={<SecondaryButton><IconDownload /> Export CSV</SecondaryButton>}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Outstanding" value={fmtMoney(outstanding)} tone={outstanding > 0 ? 'warn' : 'good'} />
        <StatTile label="Overdue" value={overdue.length} tone={overdue.length > 0 ? 'bad' : 'good'} />
        <StatTile label="Paid (YTD)" value={fmtMoney(ytdPaid)} tone="good" />
        <StatTile label="Invoices" value={all.length} hint="all-time" />
      </div>

      <SettingsCard title="History">
        <DataTable
          loading={q.isLoading}
          rows={all}
          rowKey={(i) => i.id}
          empty={<EmptyState title="No invoices yet" />}
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
                  {fmtMoney(i.amount, i.currency)}
                </span>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (i) => <StatusBadge kind={STATUS_KIND[i.status]}>{i.status}</StatusBadge>,
            },
            {
              key: 'due',
              header: 'Due',
              cell: (i) => (
                <span className={i.status === 'overdue' ? 'text-rose-700' : ''}>
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
                  <a
                    href={i.pdfUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-edge-default bg-surface-raised px-2.5 text-[12px] font-medium text-content shadow-sm transition-colors hover:border-edge-strong hover:bg-surface-sunken"
                  >
                    <IconDownload /> PDF
                  </a>
                  {i.status === 'open' || i.status === 'overdue' ? (
                    <SecondaryButton>Pay now</SecondaryButton>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </SettingsCard>

      {/* Latest invoice line breakdown */}
      {all[0] ? (
        <SettingsCard
          title={`Latest invoice — ${all[0].number}`}
          description="Per-line breakdown the same way it'll appear on the PDF."
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
                {all[0].lines.map((l, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-content">{l.label}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                      {l.quantity.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-content-muted">{l.unit}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                      {fmtMoney(l.amount, all[0].currency)}
                    </td>
                  </tr>
                ))}
                <tr className="bg-surface-sunken/50 font-semibold">
                  <td className="px-3 py-2 text-content" colSpan={3}>
                    Total
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-content">
                    {fmtMoney(all[0].amount, all[0].currency)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </SettingsCard>
      ) : null}
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
