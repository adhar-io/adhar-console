import { useState } from 'react'
import { cn } from '@adhar-console/utils'
import { fmtMoney, useAllocation, type AllocationDimension } from '../data/enterprise.ts'
import {
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'

const DIMS: { value: AllocationDimension; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'environment', label: 'Environment' },
  { value: 'team', label: 'Team' },
  { value: 'cluster', label: 'Cluster' },
  { value: 'service', label: 'Service' },
]

export function CostAllocation() {
  const [dim, setDim] = useState<AllocationDimension>('project')
  const q = useAllocation(dim)
  const rows = q.data ?? []
  const total = rows.reduce((s, r) => s + r.amount, 0)
  const top = rows[0]
  const trending = rows.filter((r) => r.delta > 0.15).length

  return (
    <ViewShell
      title="Cost allocation"
      description="Where the money is going. Slice by any dimension; export to your FP&A tooling for reconciliation."
      actions={
        <SecondaryButton>
          <IconDownload /> Export CSV
        </SecondaryButton>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Spend (MTD)" value={fmtMoney(total)} />
        <StatTile label="Top spender" value={top ? top.label : '—'} hint={top ? fmtMoney(top.amount) : ''} />
        <StatTile label="Trending up" value={trending} tone={trending ? 'warn' : 'good'} hint=">15% MoM" />
        <StatTile label="Dimension" value={DIMS.find((d) => d.value === dim)?.label ?? '—'} />
      </div>

      <div className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-surface-raised p-0.5">
        {DIMS.map((d) => {
          const on = dim === d.value
          return (
            <button
              key={d.value}
              type="button"
              onClick={() => setDim(d.value)}
              className={cn(
                'inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium transition-all',
                on
                  ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200'
                  : 'text-content-muted hover:bg-surface-sunken hover:text-content',
              )}
            >
              {d.label}
            </button>
          )
        })}
      </div>

      <SettingsCard
        title={`Spend by ${DIMS.find((d) => d.value === dim)?.label.toLowerCase()}`}
        description="Bars are normalized to the top contributor in this slice."
      >
        <ul className="space-y-2">
          {rows.map((r) => {
            const max = rows[0]?.amount ?? 1
            const pct = (r.amount / max) * 100
            const deltaTone = r.delta > 0.05 ? 'text-amber-700' : r.delta < -0.05 ? 'text-emerald-700' : 'text-content-subtle'
            return (
              <li key={r.key} className="rounded-lg border border-edge-subtle bg-surface-sunken/40 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <code className="font-mono text-[13px] text-content">{r.label}</code>
                  <div className="flex items-center gap-3 text-[12px]">
                    <span className={cn('font-mono tabular-nums', deltaTone)}>
                      {r.delta > 0 ? '+' : ''}
                      {(r.delta * 100).toFixed(1)}%
                    </span>
                    <span className="font-mono tabular-nums text-content">{fmtMoney(r.amount)}</span>
                  </div>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-app">
                  <div
                    className="h-full rounded-full bg-linear-to-r from-brand-500 to-brand-400 transition-[width] duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </SettingsCard>
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

export default CostAllocation
