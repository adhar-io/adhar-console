import { DataTable, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { useGeneric } from '../data/hooks.ts'
import { age } from '../data/format.ts'

const POLICY_REPORT_GVR = {
  group: 'wgpolicyk8s.io',
  version: 'v1alpha2',
  resource: 'clusterpolicyreports',
  namespaced: false,
}

/**
 * Kyverno / `wgpolicyk8s.io` PolicyReports. Falls back to a guide when the
 * CRD isn't installed on the cluster.
 */
export function PolicyView() {
  const q = useGeneric(POLICY_REPORT_GVR)
  const is404 = q.isError && (q.error as { status?: number })?.status === 404
  if (is404) {
    return (
      <EmptyState
        title="Policy engine not installed"
        description={
          <>
            No <code className="font-mono">wgpolicyk8s.io</code> CRDs found. Install{' '}
            <a
              className="text-brand-700 dark:text-brand-300 underline"
              href="https://kyverno.io/docs/installation/"
              target="_blank"
              rel="noreferrer"
            >
              Kyverno
            </a>{' '}
            to see policy reports here.
          </>
        }
      />
    )
  }
  if (q.isError) {
    return <EmptyState title="Couldn't list policy reports" description={(q.error as Error).message} />
  }
  const rows = q.data ?? []
  if (!q.isLoading && rows.length === 0) {
    return (
      <EmptyState
        title="No policy reports yet"
        description="Kyverno is installed but hasn't produced any reports. Apply a policy to generate one."
      />
    )
  }

  const agg = rows.reduce(
    (acc, r) => {
      const s = ((r as unknown as { summary?: Record<string, number> }).summary ?? {}) as Record<string, number>
      acc.pass += s.pass ?? 0
      acc.fail += s.fail ?? 0
      acc.warn += s.warn ?? 0
      acc.error += s.error ?? 0
      return acc
    },
    { pass: 0, fail: 0, warn: 0, error: 0 },
  )

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile tone="emerald" label="Pass" value={agg.pass} />
        <SummaryTile tone="rose" label="Fail" value={agg.fail} />
        <SummaryTile tone="amber" label="Warn" value={agg.warn} />
        <SummaryTile tone="slate" label="Error" value={agg.error} />
      </div>

      <DataTable
        loading={q.isLoading}
        columns={[
          {
            key: 'name',
            header: 'Report',
            cell: (r) => <span className="font-medium text-content">{r.metadata.name}</span>,
          },
          {
            key: 'pass',
            header: 'Pass',
            numeric: true,
            cell: (r) => (r as unknown as { summary?: { pass?: number } }).summary?.pass ?? 0,
          },
          {
            key: 'fail',
            header: 'Fail',
            numeric: true,
            cell: (r) => (r as unknown as { summary?: { fail?: number } }).summary?.fail ?? 0,
          },
          {
            key: 'warn',
            header: 'Warn',
            numeric: true,
            cell: (r) => (r as unknown as { summary?: { warn?: number } }).summary?.warn ?? 0,
          },
          {
            key: 'age',
            header: 'Age',
            cell: (r) => age(r.metadata.creationTimestamp),
          },
          {
            key: 'health',
            header: 'Health',
            cell: (r) => {
              const s = ((r as unknown as { summary?: { fail?: number } }).summary ?? {}) as { fail?: number }
              return (
                <StatusBadge kind={(s.fail ?? 0) > 0 ? 'degraded' : 'healthy'}>
                  {(s.fail ?? 0) > 0 ? 'Violations' : 'Clean'}
                </StatusBadge>
              )
            },
          },
        ]}
        rows={rows}
        rowKey={(r) => r.metadata.name}
        empty={<EmptyState title="No policy reports" />}
      />
    </div>
  )
}

function SummaryTile({
  tone,
  label,
  value,
}: {
  tone: 'emerald' | 'rose' | 'amber' | 'slate'
  label: string
  value: number
}) {
  const tones = {
    emerald: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 ring-emerald-200 dark:ring-emerald-500/25',
    rose: 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 ring-rose-200 dark:ring-rose-500/25',
    amber: 'text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 ring-amber-200 dark:ring-amber-500/25',
    slate: 'text-content-muted bg-surface-sunken ring-edge-default',
  }
  return (
    <div className={`rounded-xl p-4 ring-1 ring-inset ${tones[tone]}`}>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wide">{label}</div>
    </div>
  )
}
