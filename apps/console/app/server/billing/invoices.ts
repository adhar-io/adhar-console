import type { PlanDef, Subscription } from './provider.ts'
import type { UsageReport } from './usage-meter.ts'

/**
 * Invoice generation + rendering.
 *
 * An invoice for a period is built from persisted facts only: the tenant's
 * subscription (seat charges from the public price list) plus metered usage
 * overage (live namespace count vs. the plan's included allowance). Metered
 * infrastructure cost from OpenCost is attached as an informational note —
 * the console never invents a dollar figure when the meter is offline.
 *
 * Documents are stored as `billing.invoice` with `id = period` (YYYY-MM), which
 * makes generation idempotent per period by construction.
 */

export interface InvoiceLine {
  label: string
  quantity: number
  unit: string
  /** USD per unit. */
  unitAmount: number
  amount: number
}

export type InvoiceStatus = 'open' | 'paid' | 'void'

export interface InvoiceDoc {
  number: string
  period: string
  periodStart: string
  periodEnd: string
  currency: 'USD'
  lineItems: InvoiceLine[]
  subtotal: number
  taxRate: number
  tax: number
  total: number
  status: InvoiceStatus
  issuedAt: string
  dueAt: string
  paidAt?: string
  /** Honest caveats: meter offline, tax not configured, informational cost. */
  notes: string[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Deterministic, human-scannable number: INV-<period>-<tenant>. */
export function invoiceNumber(period: string, tenant: string): string {
  return `INV-${period}-${tenant.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'ORG'}`
}

export function buildInvoice(input: {
  tenant: string
  period: string
  sub: Subscription
  plan: PlanDef
  usage: UsageReport
}): InvoiceDoc {
  const { tenant, period, sub, plan, usage } = input
  const now = new Date()
  const lineItems: InvoiceLine[] = []
  const notes: string[] = []

  // Seat charges — straight from the subscription and the public price list.
  lineItems.push({
    label: `${plan.name} plan — seats`,
    quantity: sub.seatsPurchased,
    unit: 'seat-month',
    unitAmount: plan.pricePerSeatMonthly,
    amount: round2(sub.seatsPurchased * plan.pricePerSeatMonthly),
  })
  if (plan.contactSales) {
    notes.push('Enterprise pricing is contractual — seat charges here are placeholders at $0.')
  }
  if (sub.billingCycle === 'annual') {
    notes.push('Subscription is billed annually; this document itemizes one month of the term.')
  }

  // Metered namespace overage — only when the live count is real.
  if (
    usage.clusterSource === 'kubernetes' &&
    usage.namespaces !== null &&
    plan.includedNamespaces !== null &&
    plan.namespaceOverageMonthly > 0 &&
    usage.namespaces > plan.includedNamespaces
  ) {
    const extra = usage.namespaces - plan.includedNamespaces
    lineItems.push({
      label: `Namespace overage (${usage.namespaces} live, ${plan.includedNamespaces} included)`,
      quantity: extra,
      unit: 'namespace-month',
      unitAmount: plan.namespaceOverageMonthly,
      amount: round2(extra * plan.namespaceOverageMonthly),
    })
  }
  if (usage.clusterSource === 'unavailable') {
    notes.push('Cluster was unreachable at generation time — metered overage was not assessed.')
  }

  if (usage.costSource === 'opencost' && usage.cost !== null) {
    notes.push(
      `Informational: metered infrastructure cost for this period (OpenCost) was $${usage.cost.toFixed(2)} — billed by your infrastructure provider, not on this invoice.`,
    )
  } else {
    notes.push('Cost metering (OpenCost) is not connected; no infrastructure cost is reported.')
  }

  const subtotal = round2(lineItems.reduce((s, l) => s + l.amount, 0))
  const taxRate = 0
  notes.push('Tax is not configured for this workspace (rate 0%).')

  return {
    number: invoiceNumber(period, tenant),
    period,
    periodStart: usage.windowStart.slice(0, 10),
    periodEnd: usage.windowEnd.slice(0, 10),
    currency: 'USD',
    lineItems,
    subtotal,
    taxRate,
    tax: 0,
    total: subtotal,
    status: 'open',
    issuedAt: now.toISOString(),
    dueAt: new Date(now.getTime() + 14 * 24 * 3600_000).toISOString(),
    notes,
  }
}

/* ─────────────────── rendering ─────────────────── */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const money = (n: number) => `$${n.toFixed(2)}`

/**
 * Self-contained HTML invoice (inline styles only) suitable for a `data:` URL
 * download or print-to-PDF — no external assets, no PDF library.
 */
export function renderInvoiceHtml(inv: InvoiceDoc, org: string): string {
  const rows = inv.lineItems
    .map(
      (l) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;">${esc(l.label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;text-align:right;">${l.quantity.toLocaleString()}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;">${esc(l.unit)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;text-align:right;">${money(l.unitAmount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;text-align:right;">${money(l.amount)}</td>
      </tr>`,
    )
    .join('\n')
  const notes = inv.notes.map((n) => `<li style="margin:4px 0;">${esc(n)}</li>`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(inv.number)}</title>
</head>
<body style="font-family:ui-sans-serif,system-ui,sans-serif;color:#1a1a1a;background:#fff;margin:0;padding:40px;">
  <div style="max-width:720px;margin:0 auto;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;">
      <h1 style="font-size:20px;margin:0;">Invoice ${esc(inv.number)}</h1>
      <span style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:${inv.status === 'paid' ? '#047857' : inv.status === 'void' ? '#6b7280' : '#b45309'};">${esc(inv.status)}</span>
    </div>
    <p style="margin:6px 0 0;font-size:13px;color:#555;">
      Workspace: <strong>${esc(org)}</strong> · Period ${esc(inv.periodStart)} – ${esc(inv.periodEnd)}
    </p>
    <p style="margin:2px 0 24px;font-size:13px;color:#555;">
      Issued ${esc(inv.issuedAt.slice(0, 10))} · Due ${esc(inv.dueAt.slice(0, 10))}${inv.paidAt ? ` · Paid ${esc(inv.paidAt.slice(0, 10))}` : ''}
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666;">
          <th style="padding:8px 12px;border-bottom:2px solid #1a1a1a;">Description</th>
          <th style="padding:8px 12px;border-bottom:2px solid #1a1a1a;text-align:right;">Qty</th>
          <th style="padding:8px 12px;border-bottom:2px solid #1a1a1a;">Unit</th>
          <th style="padding:8px 12px;border-bottom:2px solid #1a1a1a;text-align:right;">Unit price</th>
          <th style="padding:8px 12px;border-bottom:2px solid #1a1a1a;text-align:right;">Amount</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
      <tfoot>
        <tr><td colspan="4" style="padding:8px 12px;text-align:right;color:#555;">Subtotal</td><td style="padding:8px 12px;text-align:right;">${money(inv.subtotal)}</td></tr>
        <tr><td colspan="4" style="padding:8px 12px;text-align:right;color:#555;">Tax (${(inv.taxRate * 100).toFixed(0)}%)</td><td style="padding:8px 12px;text-align:right;">${money(inv.tax)}</td></tr>
        <tr><td colspan="4" style="padding:8px 12px;text-align:right;font-weight:600;">Total (${esc(inv.currency)})</td><td style="padding:8px 12px;text-align:right;font-weight:600;border-top:2px solid #1a1a1a;">${money(inv.total)}</td></tr>
      </tfoot>
    </table>
    <ul style="margin:24px 0 0;padding-left:18px;font-size:12px;color:#555;">
${notes}
    </ul>
  </div>
</body>
</html>`
}

/** Plaintext rendering (terminal-friendly / e-mail body). */
export function renderInvoiceText(inv: InvoiceDoc, org: string): string {
  const lines = [
    `Invoice ${inv.number} (${inv.status})`,
    `Workspace: ${org}`,
    `Period: ${inv.periodStart} – ${inv.periodEnd}`,
    `Issued: ${inv.issuedAt.slice(0, 10)}  Due: ${inv.dueAt.slice(0, 10)}`,
    '',
    ...inv.lineItems.map(
      (l) =>
        `  ${l.label} — ${l.quantity} ${l.unit} × ${money(l.unitAmount)} = ${money(l.amount)}`,
    ),
    '',
    `  Subtotal: ${money(inv.subtotal)}`,
    `  Tax (${(inv.taxRate * 100).toFixed(0)}%): ${money(inv.tax)}`,
    `  Total: ${money(inv.total)} ${inv.currency}`,
    '',
    ...inv.notes.map((n) => `  * ${n}`),
  ]
  return lines.join('\n')
}
