import { useState } from 'react'
import { EmptyState, Spinner } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { fmtMoney, useAllocation, type AllocationDimension, type AllocationRow } from '../data/billing.ts'
import {
  SecondaryButton,
  SettingsCard,
  StatTile,
  ViewShell,
} from '../components/section-shell.tsx'

/** Real OpenCost aggregation dimensions — each slice is a live allocation query. */
const DIMS: { value: AllocationDimension; label: string }[] = [
  { value: 'namespace', label: 'Namespace' },
  { value: 'controller', label: 'Controller' },
  { value: 'service', label: 'Service' },
  { value: 'node', label: 'Node' },
  { value: 'cluster', label: 'Cluster' },
]

function exportCsv(dim: AllocationDimension, rows: AllocationRow[]) {
  const head = 'key,cost,cpuCoreHours,memGbHours,deltaMoM'
  const body = rows.map((r) => [r.key, r.amount, r.cpuCoreHours, r.memGbHours, r.delta ?? ''].join(','))
  const a = document.createElement('a')
  a.href = `data:text/csv;charset=utf-8,${encodeURIComponent([head, ...body].join('\n'))}`
  a.download = `cost-allocation-${dim}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function CostAllocation() {
  const [dim, setDim] = useState<AllocationDimension>('namespace')
  const q = useAllocation(dim)
  const rows = q.data?.rows ?? []
  const connected = q.data?.costSource === 'opencost'
  const total = rows.reduce((s, r) => s + r.amount, 0)
  const top = rows[0]
  const trending = rows.filter((r) => (r.delta ?? 0) > 0.15).length

  return (
    <ViewShell
      title="Cost allocation"
      description="Where the money is going — straight from the OpenCost allocation API, sliced by any aggregation dimension. Deltas compare against the previous equal window."
      actions={
        <SecondaryButton onClick={() => exportCsv(dim, rows)} disabled={rows.length === 0}>
          <IconDownload /> Export CSV
        </SecondaryButton>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Spend (period)"
          value={connected ? fmtMoney(total) : 'n/a'}
          hint={connected ? q.data?.period : 'cost data not connected'}
        />
        <StatTile
          label="Top spender"
          value={top ? top.label : '—'}
          hint={top ? fmtMoney(top.amount) : ''}
        />
        <StatTile
          label="Trending up"
          value={connected ? trending : '—'}
          tone={trending ? 'warn' : 'good'}
          hint=">15% vs previous window"
        />
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
        {q.isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-content-muted">
            <Spinner size={14} /> Querying OpenCost…
          </div>
        ) : q.isError ? (
          <EmptyState
            compact
            title="Allocation unavailable"
            description={q.error instanceof Error ? q.error.message : 'The billing API did not respond.'}
          />
        ) : !connected ? (
          <EmptyState
            compact
            title="Cost data not connected"
            description="Point OPENCOST_URL at your OpenCost allocation API (e.g. http://opencost.opencost.svc:9003) to see real spend. No figures are estimated."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            title="No allocation data for this window"
            description="OpenCost answered but returned no allocations for the current period."
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => {
              const max = rows[0]?.amount || 1
              const pct = (r.amount / max) * 100
              const deltaTone =
                r.delta === null
                  ? 'text-content-subtle'
                  : r.delta > 0.05
                    ? 'text-amber-700'
                    : r.delta < -0.05
                      ? 'text-emerald-700'
                      : 'text-content-subtle'
              return (
                <li key={r.key} className="rounded-lg border border-edge-subtle bg-surface-sunken/40 px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <code className="font-mono text-[13px] text-content">{r.label}</code>
                    <div className="flex items-center gap-3 text-[12px]">
                      <span className={cn('font-mono tabular-nums', deltaTone)}>
                        {r.delta === null
                          ? 'no prior data'
                          : `${r.delta > 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}%`}
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
        )}
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
