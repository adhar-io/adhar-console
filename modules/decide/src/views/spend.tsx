import { DataTable } from '@adhar-console/shell-ui'

interface Row {
  tenant: string
  monthly: string
  ondemand: string
  trend: string
  share: number
}

const ROWS: Row[] = [
  { tenant: 'acme', monthly: '$18,240', ondemand: '$3,120', trend: '+6.4%', share: 52 },
  { tenant: 'globex', monthly: '$11,650', ondemand: '$1,402', trend: '-2.1%', share: 33 },
  { tenant: 'platform', monthly: '$5,300', ondemand: '$0', trend: '+0.8%', share: 15 },
]

export function SpendSummary() {
  return (
    <DataTable
      columns={[
        { key: 'tenant', header: 'Tenant', cell: (r) => <span className="font-medium">{r.tenant}</span> },
        { key: 'monthly', header: 'Monthly (est.)', cell: (r) => r.monthly },
        { key: 'ondemand', header: 'On-demand', cell: (r) => r.ondemand },
        { key: 'trend', header: 'MoM', cell: (r) => r.trend },
        {
          key: 'share',
          header: 'Share',
          cell: (r) => (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-slate-900"
                  style={{ width: `${r.share}%` }}
                />
              </div>
              <span className="text-xs text-slate-500">{r.share}%</span>
            </div>
          ),
        },
      ]}
      rows={ROWS}
      rowKey={(r) => r.tenant}
    />
  )
}
