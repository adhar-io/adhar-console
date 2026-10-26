import { useMemo, useState } from 'react'
import { ResultTrend } from './perf-trends.tsx'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  type Column,
  DataTable,
  EmptyState,
  Modal,
  Select,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import { durationSecs, fmtDuration } from '../data/k6.ts'
import { deleteRunRecord, type PerfInsights, usePinBaseline } from '../data/perf-automation.ts'
import { canAuthorPerf } from '../data/perf-suite.ts'
import { deleteResultCheck, useAllowedNamespaces } from '../data/access.ts'
import { compareRuns, isImprovement } from '../data/perf-gate.ts'
import { METRIC_DEFS, type MetricKey, type RunRecord } from '../data/perf-results.ts'
import { Delta, MetricValue, RegressionBadge, TriggerBadge, VerdictBadge } from './perf-bits.tsx'

/**
 * Results — every run that has finished and been kept, across every test.
 *
 * This is the history the TestRun list cannot be: TestRuns are cleaned up,
 * results are not (until retention drops them). Each row carries the gate
 * verdict, computed against the gate and baseline committed in git, so the
 * page and the CI step that ran the test agree.
 */

const KEY = (r: RunRecord) => `${r.namespace}/${r.resultName}`

export function ResultsView({
  insights,
  initialTest,
  onOpenReport,
}: {
  insights: PerfInsights
  initialTest?: string
  /** Open a kept result's final report (the run drawer, on its Report tab). */
  onOpenReport(r: RunRecord): void
}) {
  const { records, configs, verdictOf, loading } = insights
  const [test, setTest] = useState(initialTest ?? '')
  const [selected, setSelected] = useState<string[]>([])
  const [comparing, setComparing] = useState(false)
  // Pinning is a commit to test.json (Gitea decides); deleting a kept result
  // deletes its ConfigMap — RBAC, per namespace the results live in.
  const canPin = (t: string) => canAuthorPerf(insights.suite, t)
  const deletableNs = useAllowedNamespaces(records.map((r) => r.namespace), (ns) => [deleteResultCheck(ns)])
  const canManage = deletableNs.size > 0 || canAuthorPerf(insights.suite)
  const toast = useToast()
  const pin = usePinBaseline()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)

  const testNames = useMemo(() => [...new Set(records.map((r) => r.test))].sort(), [records])
  const rows = useMemo(() => (test ? records.filter((r) => r.test === test) : records), [records, test])
  const chosen = useMemo(
    () => selected.map((k) => records.find((r) => KEY(r) === k)).filter((r): r is RunRecord => Boolean(r)),
    [selected, records],
  )

  const toggle = (r: RunRecord) =>
    setSelected((s) => (s.includes(KEY(r)) ? s.filter((k) => k !== KEY(r)) : [...s, KEY(r)]))

  const doPin = (r: RunRecord) => {
    setBusy(KEY(r))
    pin.mutate({ record: r }, {
      onSuccess: () => toast.success(`Pinned ${r.run} as the ${r.test} baseline`, { description: 'Committed to test.json.' }),
      onError: (e: Error) => toast.error('Could not pin the baseline', { description: e.message }),
      onSettled: () => setBusy(null),
    })
  }

  const doDelete = async (r: RunRecord) => {
    setBusy(KEY(r))
    try {
      await deleteRunRecord(r)
      toast.success(`Deleted the result of ${r.run}`)
      setSelected((s) => s.filter((k) => k !== KEY(r)))
      void qc.invalidateQueries({ queryKey: ['perf', 'results'] })
    } catch (e) {
      toast.error('Could not delete the result', { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const columns: Column<RunRecord>[] = [
    {
      key: 'select',
      header: '',
      pinned: true,
      sortable: false,
      filter: false,
      width: 32,
      cell: (r) => (
        <input
          type="checkbox"
          aria-label={`Select ${r.run} for comparison`}
          checked={selected.includes(KEY(r))}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggle(r)}
          className="h-3.5 w-3.5 rounded border-edge-default"
        />
      ),
    },
    {
      key: 'run',
      header: 'Run',
      pinned: true,
      value: (r) => r.run,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-[12px] text-content">{r.run}</div>
          <div className="truncate text-[11px] text-content-subtle">
            {r.test} · {r.namespace}
            {r.commit ? ` · ${r.commit.slice(0, 7)}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'started',
      header: 'Started',
      value: (r) => r.startedAt ?? '',
      cell: (r) =>
        r.startedAt
          ? (
            <span title={formatAbsolute(r.startedAt)} className="text-[12px] text-content-muted">
              {formatRelative(r.startedAt)}
            </span>
          )
          : <span className="text-content-subtle">—</span>,
    },
    {
      key: 'trigger',
      header: 'Trigger',
      value: (r) => r.trigger,
      cell: (r) => <TriggerBadge trigger={r.trigger} schedule={r.schedule} />,
    },
    {
      key: 'verdict',
      header: 'Gate',
      value: (r) => verdictOf(r).status,
      cell: (r) => <VerdictBadge verdict={verdictOf(r)} />,
    },
    {
      key: 'baseline',
      header: 'vs baseline',
      sortable: false,
      value: (r) => (verdictOf(r).regressions.length ? 'regressed' : 'ok'),
      cell: (r) => {
        const b = configs.get(r.test)?.baseline
        if (!b) return <span className="text-[11px] text-content-subtle">no baseline</span>
        return <RegressionBadge deltas={verdictOf(r).regressions} isBaseline={b.run === r.run} />
      },
    },
    ...(['p95Ms', 'p99Ms', 'errorRatePct', 'rps'] as MetricKey[]).map((key): Column<RunRecord> => ({
      key,
      header: METRIC_DEFS.find((d) => d.key === key)!.label.replace(' latency', ''),
      numeric: true,
      value: (r) => (r.metrics?.[key] as number | undefined) ?? -1,
      cell: (r) => <MetricValue k={key} m={r.metrics} className="tabular-nums text-[12px]" />,
    })),
    {
      key: 'duration',
      header: 'Duration',
      numeric: true,
      defaultHidden: true,
      value: (r) => durationSecs(r.startedAt, r.finishedAt) ?? -1,
      cell: (r) => <span className="tabular-nums text-[12px] text-content-muted">{fmtDuration(durationSecs(r.startedAt, r.finishedAt))}</span>,
    },
  ]

  if (canManage) {
    columns.push({
      key: 'actions',
      header: '',
      sortable: false,
      filter: false,
      cell: (r) => {
        const isBaseline = configs.get(r.test)?.baseline?.run === r.run
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {!isBaseline && r.metrics && canPin(r.test)
              ? (
                <Button size="xs" variant="ghost" disabled={busy === KEY(r)} onClick={() => doPin(r)}>
                  Pin baseline
                </Button>
              )
              : null}
            {deletableNs.has(r.namespace) ? <ConfirmButton disabled={busy === KEY(r)} onConfirm={() => doDelete(r)} /> : null}
          </div>
        )
      },
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-content">Results</div>
          <div className="text-[12px] text-content-muted">
            Every finished run, kept as a result ConfigMap and judged against the gate and baseline in git. Click one for its
            report; select two or more to compare.
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={test}
            onChange={(e) => setTest(e.target.value)}
            options={[{ value: '', label: 'All tests' }, ...testNames.map((t) => ({ value: t, label: t }))]}
          />
          {selected.length ? <Button variant="ghost" size="sm" onClick={() => setSelected([])}>Clear</Button> : null}
          <Button size="sm" disabled={chosen.length < 2} onClick={() => setComparing(true)}>
            Compare{chosen.length ? ` (${chosen.length})` : ''}
          </Button>
        </div>
      </div>

      {test ? <ResultTrend records={rows} baseline={configs.get(test)?.baseline?.metrics} /> : null}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={KEY}
        onRowClick={onOpenReport}
        loading={loading}
        tableId="k6-results"
        features={{ search: true, filters: true, columns: true, density: true, export: true }}
        defaultSort={{ key: 'started', dir: 'desc' }}
        searchPlaceholder="Search results…"
        empty={
          <EmptyState
            title="No results kept yet"
            description="A result is written when a run finishes — by the console for runs it starts, and by the runner for scheduled and CI runs. Run a test or add a schedule to start a history."
          />
        }
      />

      {comparing && chosen.length >= 2
        ? <CompareModal records={chosen} insights={insights} onClose={() => setComparing(false)} />
        : null}
    </div>
  )
}

/** Delete needs a second click; the viewer shows no confirm dialogs. */
function ConfirmButton({ onConfirm, disabled }: { onConfirm(): void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false)
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={disabled}
      className="text-rose-700 dark:text-rose-300"
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else setArmed(true)
      }}
    >
      {armed ? 'Confirm delete' : 'Delete'}
    </Button>
  )
}

/* ─────────────────────────── comparison ─────────────────────────── */

const COMPARE_KEYS: MetricKey[] = ['p95Ms', 'p99Ms', 'avgMs', 'medMs', 'errorRatePct', 'rps', 'checksPct']

export function CompareModal({
  records,
  insights,
  onClose,
}: {
  records: RunRecord[]
  insights: PerfInsights
  onClose(): void
}) {
  // Oldest first by default: "how did it change" reads left to right.
  const ordered = useMemo(
    () => [...records].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')),
    [records],
  )
  const [refKey, setRefKey] = useState(KEY(ordered[0]))
  const ref = ordered.find((r) => KEY(r) === refKey) ?? ordered[0]
  const runs = [ref, ...ordered.filter((r) => r !== ref)]
  const rows = compareRuns(runs.map((r) => r.metrics), COMPARE_KEYS)
  const tests = new Set(runs.map((r) => r.test))

  return (
    <Modal
      open
      onClose={onClose}
      width="xl"
      title="Compare runs"
      description={tests.size === 1
        ? `${runs.length} runs of ${[...tests][0]}`
        : `${runs.length} runs across ${tests.size} tests — different tests measure different things, so read the deltas with care.`}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-content-muted">
          <span>Deltas are measured from</span>
          <Select
            value={refKey}
            onChange={(e) => setRefKey(e.target.value)}
            options={ordered.map((r) => ({ value: KEY(r), label: r.run }))}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-content-subtle">
                <th className="py-1.5 pr-3 font-medium">Metric</th>
                {runs.map((r, i) => (
                  <th key={KEY(r)} className="py-1.5 pr-3 text-right font-medium">
                    <div className="truncate font-mono text-content" title={r.run}>{r.run}</div>
                    <div className="font-normal">
                      {r.startedAt ? formatRelative(r.startedAt) : '—'}
                      {i === 0 ? ' · reference' : ''}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              <tr>
                <td className="py-1.5 pr-3 text-content">Gate</td>
                {runs.map((r) => (
                  <td key={KEY(r)} className="py-1.5 pr-3 text-right"><VerdictBadge verdict={insights.verdictOf(r)} compact /></td>
                ))}
              </tr>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="py-1.5 pr-3 text-content">{row.label}</td>
                  {row.values.map((_v, i) => (
                    <td
                      key={KEY(runs[i])}
                      className={cn(
                        'py-1.5 pr-3 text-right tabular-nums',
                        row.best === i && 'font-semibold text-emerald-700 dark:text-emerald-300',
                        row.worst === i && 'text-rose-700 dark:text-rose-300',
                      )}
                    >
                      <MetricValue k={row.key} m={runs[i].metrics} className="block" />
                      <Delta
                        pct={row.deltasPct[i]}
                        good={row.deltasPct[i] === undefined ? undefined : isImprovement(row.key, row.deltasPct[i]!)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td className="py-1.5 pr-3 text-content">Trigger · commit</td>
                {runs.map((r) => (
                  <td key={KEY(r)} className="py-1.5 pr-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <TriggerBadge trigger={r.trigger} schedule={r.schedule} />
                      {r.commit ? <Badge>{r.commit.slice(0, 7)}</Badge> : null}
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-content-subtle">
          Best value per metric in green, worst in red. A different commit between two runs means the script changed
          too — the History tab of the test shows what.
        </p>
      </div>
    </Modal>
  )
}
