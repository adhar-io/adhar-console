import { Card, CardBody, CardHeader, Sparkline, StatusBadge } from '@adhar-console/shell-ui'

/**
 * Per-service DORA summary. Chart data here is placeholder — wire to a real
 * DORA metrics source (Four Keys, or a Prometheus recording rule) by swapping
 * the ROWS array for a query hook.
 */

interface Row {
  service: string
  deploys: number
  leadTime: string
  cfr: string
  mttr: string
  tier: 'Elite' | 'High' | 'Medium' | 'Low'
  trend: number[]
}

const ROWS: Row[] = [
  {
    service: 'adhar-console',
    deploys: 22,
    leadTime: '1h 48m',
    cfr: '2.1%',
    mttr: '14 min',
    tier: 'Elite',
    trend: [2, 3, 5, 4, 7, 8, 6, 9, 11, 8, 12, 14, 10, 18, 22],
  },
  {
    service: 'billing-service',
    deploys: 14,
    leadTime: '3h 21m',
    cfr: '6.2%',
    mttr: '38 min',
    tier: 'High',
    trend: [1, 0, 2, 3, 2, 4, 5, 3, 6, 4, 8, 7, 9, 11, 14],
  },
  {
    service: 'customer-portal',
    deploys: 9,
    leadTime: '6h 02m',
    cfr: '3.3%',
    mttr: '51 min',
    tier: 'High',
    trend: [2, 3, 2, 1, 4, 2, 5, 3, 4, 6, 5, 7, 6, 8, 9],
  },
  {
    service: 'payments-api',
    deploys: 5,
    leadTime: '1d 2h',
    cfr: '8.1%',
    mttr: '2h 14m',
    tier: 'Medium',
    trend: [1, 1, 0, 2, 1, 1, 0, 2, 1, 3, 2, 3, 4, 4, 5],
  },
]

const TIER_CLASS: Record<Row['tier'], string> = {
  Elite: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  High: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  Medium: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  Low: 'bg-rose-50 text-rose-700 ring-rose-600/20',
}

const TIER_COLOR: Record<Row['tier'], string> = {
  Elite: 'var(--color-brand-500)',
  High: 'var(--color-accent-500)',
  Medium: '#f59e0b',
  Low: '#f43f5e',
}

export function DoraSummary() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-content">Per-service DORA</div>
            <div className="text-[11px] text-content-subtle">
              Last 15 days · ranked by deploy frequency
            </div>
          </div>
          <StatusBadge kind="info">{ROWS.length} services</StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="p-0">
        <div className="grid grid-cols-[1.2fr_0.6fr_repeat(3,0.8fr)_0.8fr] items-center gap-4 border-b border-edge-subtle bg-surface-sunken/60 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
          <span>Service</span>
          <span>Trend</span>
          <span className="text-right">Deploys</span>
          <span className="text-right">Lead time</span>
          <span className="text-right">CFR</span>
          <span className="text-right">Tier</span>
        </div>
        <ul className="divide-y divide-edge-subtle">
          {ROWS.map((r) => (
            <li
              key={r.service}
              className="grid grid-cols-[1.2fr_0.6fr_repeat(3,0.8fr)_0.8fr] items-center gap-4 px-5 py-3 text-sm transition-colors hover:bg-brand-50/30"
            >
              <div>
                <div className="font-medium text-content">{r.service}</div>
                <div className="text-[11px] text-content-subtle">MTTR {r.mttr}</div>
              </div>
              <div>
                <Sparkline
                  points={r.trend}
                  color={TIER_COLOR[r.tier]}
                  height={28}
                  strokeWidth={1.75}
                />
              </div>
              <div className="text-right font-mono tabular-nums text-content">{r.deploys}</div>
              <div className="text-right font-mono tabular-nums text-content-muted">{r.leadTime}</div>
              <div className="text-right font-mono tabular-nums text-content-muted">{r.cfr}</div>
              <div className="text-right">
                <span
                  className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TIER_CLASS[r.tier]}`}
                >
                  {r.tier}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

export default DoraSummary
