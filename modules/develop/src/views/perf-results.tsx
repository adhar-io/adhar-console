import { type ReactNode, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  type Column,
  DataTable,
  EmptyState,
  Modal,
  Select,
  StatusBadge,
  useToast,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import { durationSecs, fmtDuration } from '../data/k6.ts'
import { deleteRunRecord, type PerfInsights, usePinBaseline } from '../data/perf-automation.ts'
import { canAuthorPerf } from '../data/perf-suite.ts'
import { deleteResultCheck, useAllowedNamespaces } from '../data/access.ts'
import { compareRuns, compareToBaseline, isImprovement } from '../data/perf-gate.ts'
import { fmtMetric, METRIC_DEFS, type MetricKey, type RunRecord } from '../data/perf-results.ts'
import { Delta, RegressionBadge, TriggerBadge, VerdictBadge } from './perf-bits.tsx'

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
}: {
  insights: PerfInsights
  initialTest?: string
}) {
  const { records, configs, verdictOf, loading } = insights
  const [test, setTest] = useState(initialTest ?? '')
  const [selected, setSelected] = useState<string[]>([])
  const [open, setOpen] = useState<RunRecord | null>(null)
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
      defaultHidden: key === 'p99Ms',
      value: (r) => (r.metrics?.[key] as number | undefined) ?? -1,
      cell: (r) => <span className="tabular-nums text-[12px]">{fmtMetric(key, r.metrics?.[key] as number | undefined)}</span>,
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
            Every finished run, kept as a result ConfigMap and judged against the gate and baseline in git. Select two or
            more to compare.
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

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={KEY}
        onRowClick={setOpen}
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

      {open ? <RecordModal record={open} insights={insights} onClose={() => setOpen(null)} onPin={doPin} /> : null}
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

/* ─────────────────────────── one result ─────────────────────────── */

function RecordModal({
  record: r,
  insights,
  onClose,
  onPin,
}: {
  record: RunRecord
  insights: PerfInsights
  onClose(): void
  onPin(r: RunRecord): void
}) {
  const config = insights.configs.get(r.test)
  const verdict = insights.verdictOf(r)
  const baseline = config?.baseline
  const isBaseline = baseline?.run === r.run
  const deltas = baseline && !isBaseline ? compareToBaseline(r.metrics, baseline.metrics, config?.gate?.tolerance) : []
  const canPin = canAuthorPerf(insights.suite, r.test)

  return (
    <Modal
      open
      onClose={onClose}
      width="xl"
      title={<span className="font-mono text-base font-semibold text-content">{r.run}</span>}
      description={`${r.test} · ${r.namespace} · ${r.startedAt ? formatAbsolute(r.startedAt) : 'unknown start'}`}
      footer={
        <>
          {canPin && r.metrics && !isBaseline
            ? <Button variant="ghost" onClick={() => onPin(r)}>Pin as baseline</Button>
            : null}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="space-y-5">
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-[12px] font-semibold text-content">Gate verdict</h3>
            <VerdictBadge verdict={verdict} />
            {r.recordedVerdict && r.recordedVerdict !== (verdict.status === 'pass' ? 'pass' : 'fail')
              ? (
                <span className="text-[11px] text-content-subtle" title={r.recordedReasons}>
                  the runner recorded “{r.recordedVerdict}” with the gate as it was then
                </span>
              )
              : null}
          </div>
          {verdict.checks.length
            ? (
              <ul className="space-y-1">
                {verdict.checks.map((c) => (
                  <li key={c.id} className="flex items-baseline gap-2 text-[12px]">
                    <span className={cn('font-mono', c.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                      {c.passed ? '✓' : '✗'}
                    </span>
                    <span className="font-medium text-content">{c.label}</span>
                    <span className="text-content-muted">{c.detail}</span>
                  </li>
                ))}
              </ul>
            )
            : <p className="text-[12px] text-content-muted">The runner printed no end-of-test summary, so there is nothing to judge.</p>}
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-semibold text-content">
            {isBaseline ? 'This run is the baseline' : baseline ? `Against the baseline ${baseline.run}` : 'No baseline pinned'}
          </h3>
          {deltas.length
            ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="text-left text-[11px] text-content-subtle">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Metric</th>
                      <th className="py-1 pr-3 text-right font-medium">Baseline</th>
                      <th className="py-1 pr-3 text-right font-medium">This run</th>
                      <th className="py-1 pr-3 text-right font-medium">Change</th>
                      <th className="py-1 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge-subtle">
                    {deltas.map((d) => (
                      <tr key={d.key}>
                        <td className="py-1.5 pr-3 text-content">{d.label}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-content-muted">{fmtMetric(d.key, d.baseline)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-content">{fmtMetric(d.key, d.current)}</td>
                        <td className="py-1.5 pr-3 text-right">
                          <Delta pct={d.deltaPct} good={d.deltaPct === undefined ? undefined : isImprovement(d.key, d.deltaPct)} />
                        </td>
                        <td className="py-1.5">
                          {d.current === undefined || d.baseline === undefined
                            ? <span className="text-content-subtle">not comparable</span>
                            : d.regressed
                            ? <StatusBadge kind="failed">regressed</StatusBadge>
                            : d.improved
                            ? <StatusBadge kind="healthy">improved</StatusBadge>
                            : <span className="text-content-subtle">within tolerance</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
            : !baseline
            ? (
              <p className="text-[12px] text-content-muted">
                Pin a run you trust as the baseline and every later run is compared against it, with the tolerance set
                in the test’s gate.
              </p>
            )
            : null}
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-semibold text-content">Results</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {METRIC_DEFS.map((d) => (
              <div key={d.key} className="rounded-lg border border-edge-default px-3 py-2">
                <div className="text-[11px] text-content-subtle">{d.label}</div>
                <div className="font-mono text-[13px] text-content">{fmtMetric(d.key, r.metrics?.[d.key] as number | undefined)}</div>
              </div>
            ))}
          </div>
          {r.summary?.thresholds.length
            ? (
              <div className="mt-3 space-y-1">
                {r.summary.thresholds.map((t) => (
                  <div key={`${t.metric}:${t.expression}`} className="flex items-center gap-2 text-[12px]">
                    <span className={cn('font-mono', t.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                      {t.passed ? '✓' : '✗'}
                    </span>
                    <span className="text-content">{t.metric}</span>
                    <code className="text-[11px] text-content-muted">{t.expression}</code>
                  </div>
                ))}
              </div>
            )
            : null}
          {r.runners > 1
            ? (
              <p className="mt-2 text-[11px] text-content-subtle">
                Combined from {r.runners} runners: throughput is summed, the error rate weighted by requests, and each
                percentile is the worst runner’s.
              </p>
            )
            : null}
        </section>

        <section className="grid grid-cols-1 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
          {([
            ['Trigger', <TriggerBadge key="t" trigger={r.trigger} schedule={r.schedule} />],
            ['Schedule', r.schedule ?? '—'],
            ['Commit', r.commit ? <code key="c" className="font-mono">{r.commit.slice(0, 12)}</code> : '—'],
            ['Final stage', r.stage ?? '—'],
            ['Runner exit code', r.exitCode === undefined ? '—' : `${r.exitCode}${r.exitCode === 99 ? ' (thresholds crossed)' : ''}`],
            ['Duration', fmtDuration(durationSecs(r.startedAt, r.finishedAt))],
            ['Result object', <code key="o" className="font-mono">{r.namespace}/{r.resultName}</code>],
            ['Parallelism', String(r.parallelism ?? r.runners ?? 1)],
          ] as Array<[string, ReactNode]>).map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <span className="w-32 shrink-0 text-content-subtle">{k}</span>
              <span className="min-w-0 flex-1 break-words text-content">{v}</span>
            </div>
          ))}
        </section>
      </div>
    </Modal>
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
                  {row.values.map((v, i) => (
                    <td
                      key={KEY(runs[i])}
                      className={cn(
                        'py-1.5 pr-3 text-right tabular-nums',
                        row.best === i && 'font-semibold text-emerald-700 dark:text-emerald-300',
                        row.worst === i && 'text-rose-700 dark:text-rose-300',
                      )}
                    >
                      <div>{fmtMetric(row.key, v)}</div>
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
