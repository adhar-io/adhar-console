import { useCallback, useMemo, useState } from 'react'
import {
  Button,
  DataTable,
  EmptyState,
  Input,
  Select,
  StatusBadge,
  usePublicUrl,
  useToast,
  type Column,
  type StatusKind,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatMetric, formatRelative, METRIC_DEFS, yMaxFor } from '@adhar/utils'
import {
  alignedPoints,
  chaosReportHtml,
  type ChaosRunReport,
  commitUrl,
  compareRuns,
  type ExperimentRecord,
  faultTitle,
  headline,
  historyOf,
  matchesCommit,
  reportFileName,
  resilienceScore,
  runGrade,
  runVerdict,
  shaQuery,
  shortSha,
  statusText,
  TRIGGER_LABEL,
  VERDICT_LABEL,
  type RunVerdict,
} from '../data/chaos-report.ts'
import { useChaosReports } from '../data/chaos-report-hooks.ts'
import { ChaosChart, METRIC_TOKEN } from '../components/chaos-chart.tsx'
import { ChaosDrawer, Panel } from './chaos-run-canvas.tsx'

/**
 * Run reports — one Chaos Engineering report per resilience run, per
 * application, tagged with the commit that was under test.
 *
 * The question this tab answers is the one a promotion asks: "what did chaos
 * prove about THIS change?". So the commit is the primary filter — paste a
 * full or short SHA and the list narrows to the runs of that build, in every
 * environment it reached — and Deliver's Kargo views link here with it set.
 *
 * The console's server records every run as it lands (the runner itself only
 * keeps the latest per application), so the history does not depend on anyone
 * having had this page open. Newer reports also carry the run's timeline and
 * the target's metrics over the run window; two runs of one application can
 * be compared side by side, metrics overlaid.
 */

export const VERDICT_KIND: Record<RunVerdict, StatusKind> = { survived: 'healthy', failed: 'failed', inconclusive: 'degraded' }

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Revoke after the click has been handled, or some browsers cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** The report's link back into the console, and its public commit link. */
function useReportMeta() {
  const publicUrl = usePublicUrl()
  return useCallback((r: ChaosRunReport) => {
    const raw = commitUrl(r.repoUrl, r.commit)
    const origin = typeof location === 'undefined' ? '' : location.origin
    return {
      generatedAt: new Date().toISOString(),
      consoleUrl: `${origin}/deliver?section=chaos&tab=reports&report=${encodeURIComponent(r.id)}`,
      ...(raw ? { commitHref: publicUrl(raw, 'gitea') } : {}),
    }
  }, [publicUrl])
}

export function useDownloads(all: ChaosRunReport[]) {
  const toast = useToast()
  const metaOf = useReportMeta()
  const [busy, setBusy] = useState<string | null>(null)
  const pdf = async (r: ChaosRunReport) => {
    setBusy(r.id)
    try {
      // Own chunk: the PDF writer costs nothing until someone downloads one.
      const { chaosReportPdf } = await import('../data/chaos-report-pdf.ts')
      const bytes = chaosReportPdf(r, historyOf(all, r), metaOf(r))
      download(reportFileName(r, 'pdf'), new Blob([bytes as BlobPart], { type: 'application/pdf' }))
      toast.success(`Downloaded ${reportFileName(r, 'pdf')}`)
    } catch (e) {
      toast.error(`The PDF could not be built: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  const html = (r: ChaosRunReport) => {
    try {
      download(reportFileName(r, 'html'), new Blob([chaosReportHtml(r, historyOf(all, r), metaOf(r))], { type: 'text/html;charset=utf-8' }))
      toast.success(`Downloaded ${reportFileName(r, 'html')}`)
    } catch (e) {
      toast.error(`The report could not be built: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { pdf, html, busy }
}

export function ChaosReports({ namespace, commit, app, onFilter, onRunSuites, onOpen, onCompare }: {
  namespace?: string
  commit: string
  app: string
  onFilter(f: { commit?: string; app?: string }): void
  onRunSuites(): void
  onOpen(id: string): void
  onCompare(a: string, b: string): void
}) {
  const q = useChaosReports()
  const publicUrl = usePublicUrl()
  const all = useMemo(() => q.data?.items ?? [], [q.data])
  const scoped = useMemo(() => all.filter((r) => !namespace || r.namespace === namespace), [all, namespace])
  const apps = useMemo(() => [...new Set(scoped.map((r) => r.app))].sort(), [scoped])
  const sha = shaQuery(commit)
  const shaInvalid = commit.trim() !== '' && !sha
  const rows = scoped.filter((r) => (!app || r.app === app) && (!sha || matchesCommit(r, sha)))
  const downloads = useDownloads(all)

  const columns: Column<ChaosRunReport>[] = [
    {
      key: 'app',
      header: 'Application',
      pinned: true,
      value: (r) => r.app,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-content">{r.app}</div>
          <div className="truncate text-[11px] text-content-subtle">{r.environment} · {r.namespace}</div>
        </div>
      ),
    },
    {
      key: 'commit',
      header: 'Commit',
      value: (r) => r.commit ?? '',
      cell: (r) => {
        if (!r.commit) return <span className="text-[12px] text-content-subtle" title={r.commitNote}>unknown</span>
        const href = commitUrl(r.repoUrl, r.commit)
        const label = <span className="font-mono text-[12px]">{shortSha(r.commit)}</span>
        return href ? (
          <a href={publicUrl(href, 'gitea')} target="_blank" rel="noreferrer" title={r.commit} onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline dark:text-brand-300">{label}</a>
        ) : <span title={r.commit} className="text-content">{label}</span>
      },
    },
    {
      key: 'verdict',
      header: 'Verdict',
      value: (r) => VERDICT_LABEL[runVerdict(r)],
      cell: (r) => {
        const v = runVerdict(r)
        const judged = r.experiments.filter((e) => e.status === 'passed' || e.status === 'failed')
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadge kind={VERDICT_KIND[v]}>{VERDICT_LABEL[v]}</StatusBadge>
            <span className="text-[11px] tabular-nums text-content-subtle">{judged.filter((e) => e.status === 'passed').length}/{judged.length} faults</span>
          </div>
        )
      },
    },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      value: (r) => resilienceScore(r) ?? -1,
      cell: (r) => <span className="font-mono text-[12px] tabular-nums text-content">{resilienceScore(r) ?? '—'} <span className="text-content-subtle">{runGrade(r)}</span></span>,
    },
    {
      key: 'evidence',
      header: 'Evidence',
      sortable: false,
      cell: (r) => (
        <span className="text-[11px] text-content-subtle" title={r.metricsNote}>
          {r.metrics?.series.length ? `${r.metrics.series.length} metrics` : r.phases?.length ? 'timeline' : 'verdicts only'}
        </span>
      ),
    },
    {
      key: 'trigger',
      header: 'Triggered by',
      value: (r) => r.trigger,
      cell: (r) => <span className="text-[12px] text-content-muted" title={r.runId}>{TRIGGER_LABEL[r.trigger]}{r.triggeredByUser ? ` — ${r.triggeredByUser}` : ''}</span>,
    },
    {
      key: 'finished',
      header: 'Run',
      value: (r) => r.finishedAt,
      cell: (r) => <span title={formatAbsolute(r.finishedAt)} className="text-[12px] text-content-muted">{formatRelative(r.finishedAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      sortable: false,
      cell: (r) => {
        const prev = historyOf(all, r).previous
        return (
          <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {prev ? <Button variant="ghost" size="xs" title="Compare with the run before it" onClick={() => onCompare(prev.id, r.id)}>Compare</Button> : null}
            <Button variant="ghost" size="xs" disabled={downloads.busy === r.id} onClick={() => void downloads.pdf(r)}>PDF</Button>
          </div>
        )
      },
    },
  ]

  const empty = q.data && !q.data.configured ? (
    <EmptyState title="Run reports are not being kept" description={q.data.detail ?? 'The console database is not configured, so chaos runs cannot be recorded. Configure the console database and every run from then on gets a report.'} />
  ) : sha ? (
    <EmptyState
      title={`No chaos report for commit ${sha.slice(0, 12)}`}
      description="No recorded resilience run tested an image built from this commit. Runs happen when the build is promoted into an environment with a suite, hourly in test, or when you run a suite by hand."
      action={<Button variant="primary" onClick={onRunSuites}>Go to application suites</Button>}
    />
  ) : (
    <EmptyState
      title="No chaos runs recorded yet"
      description="A report is recorded every time the resilience runner tests an application — hourly, on promotion, or when you run a suite from Application suites."
      action={<Button variant="primary" onClick={onRunSuites}>Run a suite</Button>}
    />
  )

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h2 className="text-sm font-semibold text-content">Run reports</h2>
          <p className="text-[12px] text-content-muted">One report per resilience run, tagged with the commit of the image that was tested. Paste a commit to see what chaos proved about that change.</p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <div className="w-full sm:w-72">
            <Input value={commit} onChange={(e) => onFilter({ commit: e.target.value })} placeholder="Commit SHA (full or short)" aria-label="Filter by commit SHA" aria-invalid={shaInvalid || undefined} />
            {shaInvalid ? <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">A commit is 4–40 hexadecimal characters.</div> : null}
          </div>
          <div className="w-full sm:w-44">
            <Select value={app} onChange={(e) => onFilter({ app: e.target.value })} aria-label="Filter by application" options={[{ value: '', label: 'All applications' }, ...apps.map((a) => ({ value: a, label: a }))]} />
          </div>
        </div>
      </div>
      {q.error ? (
        <EmptyState compact title="Reports could not be read" description={(q.error as Error).message} action={<Button onClick={() => void q.refetch()}>Try again</Button>} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => onOpen(r.id)}
            loading={q.isLoading}
            tableId="chaos-reports"
            features={{ search: true, columns: true, density: true }}
            defaultSort={{ key: 'finished', dir: 'desc' }}
            searchPlaceholder="Search reports…"
            empty={empty}
          />
        </div>
      )}
    </section>
  )
}

/* ─────────────────────────── report drawer ─────────────────────────── */

export function ReportDrawer({ id, onClose, onCompare }: { id: string; onClose(): void; onCompare(a: string, b: string): void }) {
  const q = useChaosReports()
  const all = useMemo(() => q.data?.items ?? [], [q.data])
  const r = all.find((x) => x.id === id)
  const metaOf = useReportMeta()
  const downloads = useDownloads(all)
  const html = useMemo(() => (r ? chaosReportHtml(r, historyOf(all, r), metaOf(r)) : ''), [r, all, metaOf])
  const prev = r ? historyOf(all, r).previous : undefined
  return (
    <ChaosDrawer
      widthKey="platform.chaos-report"
      base="max-w-4xl"
      eyebrow={r ? `Chaos report · ${r.environment}` : 'Chaos report'}
      title={r ? <>{r.app}{r.commit ? <span className="font-mono ml-1.5 font-mono text-[13px] text-content-muted">@ {shortSha(r.commit)}</span> : null}</> : id}
      badge={r ? <StatusBadge kind={VERDICT_KIND[runVerdict(r)]}>{VERDICT_LABEL[runVerdict(r)]}</StatusBadge> : null}
      actions={r ? (
        <>
          {prev ? <Button size="sm" variant="ghost" onClick={() => onCompare(prev.id, r.id)}>Compare with previous</Button> : null}
          <Button size="sm" onClick={() => downloads.html(r)}>HTML</Button>
          <Button size="sm" variant="primary" disabled={downloads.busy === r.id} onClick={() => void downloads.pdf(r)}>Download PDF</Button>
        </>
      ) : null}
      onClose={onClose}
    >
      {q.isLoading ? (
        <div className="p-5 text-[12px] text-content-subtle">Loading the report…</div>
      ) : !r ? (
        <div className="p-5"><EmptyState title="This report is not in the history" description="It may have been pruned — the console keeps the newest 50 runs per application — or the link is from another console." action={<Button variant="primary" onClick={onClose}>Close</Button>} /></div>
      ) : (
        <div className="flex h-full flex-col">
          <div className="border-b border-edge-default bg-surface-raised px-5 py-2 text-[12px] text-content-muted">{headline(r)}</div>
          {/* The report is a standalone document with its own styles; an iframe
              keeps them from leaking into the console and vice versa. */}
          <iframe title={`Chaos report for ${r.app}`} srcDoc={html} sandbox="allow-popups allow-popups-to-escape-sandbox" className="min-h-0 w-full flex-1 bg-white" />
        </div>
      )}
    </ChaosDrawer>
  )
}

/* ─────────────────────────── compare ─────────────────────────── */

const CHANGE: Record<string, { label: string; tone: string }> = {
  better: { label: 'Better', tone: 'text-emerald-700 dark:text-emerald-400' },
  worse: { label: 'Worse', tone: 'text-rose-700 dark:text-rose-400' },
  same: { label: 'Same', tone: 'text-content-subtle' },
  new: { label: 'New fault', tone: 'text-content-subtle' },
  gone: { label: 'Not run now', tone: 'text-content-subtle' },
}

const cellOf = (e?: ExperimentRecord) => (e ? `${statusText(e.status)}${e.probeSuccessPercentage !== undefined ? ` · ${Number(e.probeSuccessPercentage.toFixed(1))}%` : ''}${e.recoverySeconds !== undefined ? ` · ${e.recoverySeconds}s` : ''}` : '—')

const offset = (ms: number) => {
  const s = Math.round(ms / 1000)
  const sign = s < 0 ? '−' : '+'
  const a = Math.abs(s)
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}

/**
 * Two runs of one application side by side: the verdict, probe and recovery
 * of every fault with the change between them, and each metric of both runs
 * overlaid on "time since the run started" so the same phase lines up.
 */
export function CompareDrawer({ a, b, onClose, onPick }: { a: string; b: string; onClose(): void; onPick(a: string, b: string): void }) {
  const q = useChaosReports()
  const all = useMemo(() => q.data?.items ?? [], [q.data])
  const ra = all.find((x) => x.id === a)
  const rb = all.find((x) => x.id === b)
  // Older on the left: "then" → "now".
  const [then, nowR] = ra && rb && ra.finishedAt > rb.finishedAt ? [rb, ra] : [ra, rb]
  const peers = nowR ? all.filter((x) => x.app === nowR.app && x.id !== nowR.id).sort((x, y) => y.finishedAt.localeCompare(x.finishedAt)) : []
  const cmp = then && nowR ? compareRuns(nowR, then) : undefined

  return (
    <ChaosDrawer widthKey="platform.chaos-compare" base="max-w-5xl" eyebrow="Compare runs" title={nowR?.app ?? 'Runs'} onClose={onClose}>
      {q.isLoading ? (
        <div className="p-5 text-[12px] text-content-subtle">Loading the reports…</div>
      ) : !then || !nowR ? (
        <div className="p-5"><EmptyState title="One of these runs is not in the history" description="It may have been pruned (the newest 50 runs per application are kept)." action={<Button variant="primary" onClick={onClose}>Close</Button>} /></div>
      ) : (
        <div className="space-y-4 p-4 sm:p-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {[then, nowR].map((r, i) => {
              const v = runVerdict(r)
              return (
                <div key={r.id} className={cn('rounded-xl border p-3.5', i === 1 ? 'border-brand-300 bg-brand-50/40 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised')}>
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
                    <span className={cn('inline-block h-0.5 w-4', i === 0 ? 'border-t-2 border-dashed border-content-subtle' : 'bg-brand-500')} />{i === 0 ? 'Then' : 'Now'}
                  </div>
                  {i === 0 ? (
                    <Select className="mt-1" value={r.id} onChange={(e) => onPick(e.target.value, nowR.id)} aria-label="Run to compare against" options={peers.map((x) => ({ value: x.id, label: `${x.finishedAt.slice(0, 16).replace('T', ' ')} · ${x.environment}${x.commit ? ` · ${shortSha(x.commit)}` : ''}` }))} />
                  ) : (
                    <div className="mt-1 text-[13px] font-medium text-content">{r.finishedAt.slice(0, 16).replace('T', ' ')} UTC · {r.environment}{r.commit ? ` · ${shortSha(r.commit)}` : ''}</div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <StatusBadge kind={VERDICT_KIND[v]}>{VERDICT_LABEL[v]}</StatusBadge>
                    <span className="font-mono text-[13px] font-semibold tabular-nums text-content">{resilienceScore(r) ?? '—'}<span className="text-[10px] text-content-subtle">/100 · {runGrade(r)}</span></span>
                    <span className="text-[11px] text-content-subtle">{TRIGGER_LABEL[r.trigger]}</span>
                  </div>
                </div>
              )
            })}
          </div>

          <Panel title="Faults" sub={cmp ? `overall ${CHANGE[cmp.overall].label.toLowerCase()}` : undefined}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead className="text-[10px] uppercase tracking-wide text-content-subtle">
                  <tr><th className="py-1.5 pr-2 font-medium">Fault</th><th className="px-2 py-1.5 font-medium">Then</th><th className="px-2 py-1.5 font-medium">Now</th><th className="px-2 py-1.5 text-right font-medium">Probe Δ</th><th className="px-2 py-1.5 text-right font-medium">Recovery Δ</th><th className="py-1.5 pl-2 text-right font-medium">Change</th></tr>
                </thead>
                <tbody>
                  {cmp?.rows.map((x) => {
                    const dp = x.after?.probeSuccessPercentage !== undefined && x.before?.probeSuccessPercentage !== undefined ? x.after.probeSuccessPercentage - x.before.probeSuccessPercentage : undefined
                    const dr = x.after?.recoverySeconds !== undefined && x.before?.recoverySeconds !== undefined ? x.after.recoverySeconds - x.before.recoverySeconds : undefined
                    return (
                      <tr key={x.name} className="border-t border-edge-default align-top">
                        <td className="py-1.5 pr-2"><div className="text-content">{faultTitle(x.name)}</div><span className="font-mono text-[10.5px] text-content-subtle">{x.name}</span></td>
                        <td className="px-2 py-1.5 tabular-nums text-content-muted">{cellOf(x.before)}</td>
                        <td className="px-2 py-1.5 tabular-nums text-content">{cellOf(x.after)}</td>
                        <td className={cn('px-2 py-1.5 text-right font-mono tabular-nums', dp === undefined || dp === 0 ? 'text-content-subtle' : dp > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400')}>{dp === undefined ? '—' : `${dp > 0 ? '+' : ''}${Number(dp.toFixed(1))}%`}</td>
                        <td className={cn('px-2 py-1.5 text-right font-mono tabular-nums', dr === undefined || dr === 0 ? 'text-content-subtle' : dr < 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400')}>{dr === undefined ? '—' : `${dr > 0 ? '+' : ''}${dr}s`}</td>
                        <td className={cn('py-1.5 pl-2 text-right font-medium', CHANGE[x.change].tone)}>{CHANGE[x.change].label}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Metrics, overlaid" sub="time since each run started · then dashed, now solid">
            {!then.metrics && !nowR.metrics ? (
              <div className="text-[12px] text-content-muted">Neither run carries target metrics — they were recorded before metrics were captured, or Prometheus was not reachable. Runs recorded from now on can be overlaid here.</div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {METRIC_DEFS.filter((d) => d.id !== 'probe').map((d) => {
                  const pa = alignedPoints(then, d.id)
                  const pb = alignedPoints(nowR, d.id)
                  if (!pa.length && !pb.length) return null
                  const xs = [...pa, ...pb].map((p) => p[0])
                  const dom: [number, number] = [Math.min(...xs), Math.max(...xs)]
                  const lastA = pa.at(-1)?.[1]
                  const lastB = pb.at(-1)?.[1]
                  return (
                    <div key={d.id} className="min-w-0 rounded-lg border border-edge-default p-2.5">
                      <div className="mb-1 flex items-baseline justify-between gap-2 text-[11.5px]">
                        <span className="font-medium text-content">{d.label}</span>
                        <span className="font-mono tabular-nums text-content-subtle">{formatMetric(lastA, d.unit)} → <span className="text-content">{formatMetric(lastB, d.unit)}</span></span>
                      </div>
                      <ChaosChart
                        lines={[
                          ...(pb.length ? [{ name: 'now', points: pb, color: METRIC_TOKEN[d.id] }] : []),
                          ...(pa.length ? [{ name: 'then', points: pa, color: 'var(--color-content-subtle)', dashed: true }] : []),
                        ]}
                        unit={d.unit}
                        domain={dom[1] > dom[0] ? dom : undefined}
                        yMax={yMaxFor(d.id, d.unit, [...pa, ...pb])}
                        height={110}
                        formatX={offset}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </Panel>
        </div>
      )}
    </ChaosDrawer>
  )
}
