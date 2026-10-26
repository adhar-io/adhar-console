import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Skeleton, StatusBadge, type StatusKind, TimeSeriesChart, useOptionalUser, useToast } from '@adhar/shell-ui'
import { cn, formatMetric, type ReportTone } from '@adhar/utils'
import type { K6Summary, TestRun } from '../data/k6.ts'
import { LABEL_APPLICATION, LABEL_COMMIT, LABEL_TEST } from '../data/perf-format.ts'
import { LABEL_SCHEDULE, LABEL_TRIGGER, type RunMetrics, type RunRecord, type Trigger } from '../data/perf-results.ts'
import { evaluateGate, type GateVerdict } from '../data/perf-gate.ts'
import type { LoadPlan } from '../data/perf-plan.ts'
import { fmtSecs, type Lifecycle, type PodDetail } from '../data/perf-run-model.ts'
import type { LogGroup } from '../data/perf-live.ts'
import { scriptPathOf } from '../data/perf-location.ts'
import { usePerfSuite, usePerfTest } from '../data/perf-suite.ts'
import { fetchReportCharts, reportChartsKey, useReportCharts } from '../data/perf-run.ts'
import type { ReportChartInput } from '../data/perf-report-charts.ts'
import {
  buildRunReport,
  chartCaption,
  fmtUtc,
  inputFromRecord,
  previousRecord,
  reportFileName,
  type ReportChart,
  type ReportCharts,
  type RunReport,
  runReportHtml,
} from '../data/perf-run-report.ts'

/**
 * The final report of a run, in the console: the same model the HTML and PDF
 * downloads render (perf-run-report.ts), so the drawer, the files and the
 * Results table always show the same numbers.
 */

export function download(filename: string, data: string | Uint8Array, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** The deep link to a run's report: `?view=results&report=ns/name`, on whatever page the Performance Center is. */
export function reportLink(namespace: string, name: string): string {
  const u = new URL(globalThis.location?.href ?? 'http://localhost/')
  u.searchParams.delete('run')
  u.searchParams.set('report', `${namespace}/${name}`)
  return u.toString()
}

export interface FinalReportArgs {
  namespace: string
  name: string
  record?: RunRecord
  /** The gate verdict the Results table shows for this run; computed here when there is no kept result yet. */
  verdict?: GateVerdict
  run?: TestRun
  lc?: Lifecycle
  plan?: LoadPlan
  summary?: K6Summary
  metrics?: RunMetrics
  pods?: PodDetail[]
  logGroups?: LogGroup[]
  /** Every kept result, for the "previous run" comparison. */
  records?: RunRecord[]
  /** Read the Prometheus charts (only while the report is on screen). */
  charts: boolean
}

export interface FinalReport {
  report: RunReport
  chartsLoading: boolean
  chartsError?: string
  downloadHtml(): Promise<void>
  downloadPdf(): Promise<void>
  busy: false | 'html' | 'pdf'
}

/** Assemble a run's final report from whatever exists for it now. */
export function useFinalReport(a: FinalReportArgs): FinalReport {
  const toast = useToast()
  const qc = useQueryClient()
  const user = useOptionalUser()
  const [busy, setBusy] = useState<false | 'html' | 'pdf'>(false)
  const labels = a.run?.metadata.labels ?? {}
  const testName = a.record?.test ?? labels[LABEL_TEST]
  const suite = usePerfSuite()
  const testQ = usePerfTest(suite.data, testName ?? null)
  const test = testQ.data
  const config = test?.config

  const running = a.lc?.running ?? false
  const startMs = a.lc?.loadStartMs ?? a.lc?.createdMs ?? (a.record?.startedAt ? Date.parse(a.record.startedAt) : undefined)
  const endMs = a.lc?.loadEndMs ?? a.lc?.endMs ?? (a.record?.finishedAt ? Date.parse(a.record.finishedAt) : undefined)
  const application = a.record?.application ?? labels[LABEL_APPLICATION]
  const chartInput: ReportChartInput | null = !running && startMs !== undefined && endMs !== undefined && Number.isFinite(startMs) && Number.isFinite(endMs)
    ? { run: a.name, namespace: a.namespace, application, targetNamespace: config?.target?.namespace, startMs, endMs }
    : null
  const chartsQ = useReportCharts(chartInput, a.charts)

  const report = useMemo(() => {
    const base = a.record ? inputFromRecord(a.record) : undefined
    const stage = a.record?.stage ?? a.run?.status?.stage
    const metrics = a.metrics ?? a.record?.metrics
    const baseline = config?.baseline
    const verdict = a.verdict ?? (running ? undefined : evaluateGate({
      metrics,
      stage,
      exitCode: a.record?.exitCode,
      gate: config?.gate,
      baseline: baseline && baseline.run !== a.name ? baseline : undefined,
    }))
    const runEnv = ((a.run?.spec?.runner as { env?: Array<{ name: string; value?: string; valueFrom?: unknown }> } | undefined)?.env)
    const env = runEnv
      ? runEnv.map((e) => ({ name: e.name, value: e.value, ref: Boolean(e.valueFrom) }))
      : config ? Object.entries(config.env).map(([name, value]) => ({ name, value })) : undefined
    const cm = a.run?.spec?.script?.configMap
    const prev = a.records ? previousRecord({ run: a.name, test: testName, namespace: a.namespace, startedAt: a.record?.startedAt ?? a.run?.metadata.creationTimestamp }, a.records) : undefined
    return buildRunReport({
      ...(base ?? { run: a.name, namespace: a.namespace }),
      test: testName,
      application,
      commit: a.record?.commit ?? labels[LABEL_COMMIT],
      trigger: a.record?.trigger ?? (labels[LABEL_TRIGGER] as Trigger | undefined),
      schedule: a.record?.schedule ?? labels[LABEL_SCHEDULE],
      startedAt: a.record?.startedAt ?? a.run?.metadata.creationTimestamp,
      stage,
      parallelism: a.record?.parallelism ?? a.run?.spec?.parallelism,
      lifecycle: a.lc,
      plan: a.plan,
      summary: a.summary ?? a.record?.summary,
      metrics,
      verdict,
      baseline: baseline ? { run: baseline.run, metrics: baseline.metrics, pinnedAt: baseline.pinnedAt } : undefined,
      previous: prev ? { run: prev.run, startedAt: prev.startedAt, metrics: prev.metrics } : undefined,
      tolerance: config?.gate?.tolerance,
      config: {
        arguments: a.run ? a.run.spec?.arguments : config?.arguments,
        env,
        image: (a.run?.spec?.runner as { image?: string } | undefined)?.image,
        script: cm ? `ConfigMap ${cm.name}${cm.file ? ` / ${cm.file}` : ''}` : test?.location ? `${test.location.repo}/${scriptPathOf(test.location)}` : undefined,
        target: config?.target?.selector ? `${config.target.namespace ?? a.namespace} · ${config.target.selector}` : undefined,
      },
      pods: a.pods,
      logGroups: a.logGroups,
      charts: chartsQ.data,
      link: reportLink(a.namespace, a.name),
      generatedAt: new Date(),
      generatedBy: user?.email || user?.name || undefined,
    })
    // `labels` derives from a.run; the rest are the inputs.
  }, [a.record, a.run, a.lc, a.plan, a.summary, a.metrics, a.verdict, a.pods, a.logGroups, a.records, a.name, a.namespace, config, test, chartsQ.data, running, user, testName, application]) // eslint-disable-line react-hooks/exhaustive-deps

  /** The report with charts, reading them first if the tab never did. */
  const complete = useCallback(async (): Promise<RunReport> => {
    if (report.charts || !chartInput) return { ...report, generatedAt: new Date() }
    const charts = await qc.fetchQuery<ReportCharts>({ queryKey: reportChartsKey(chartInput), queryFn: () => fetchReportCharts(chartInput), staleTime: Infinity }).catch(() => undefined)
    return { ...report, charts, generatedAt: new Date() }
  }, [report, chartInput, qc]) // eslint-disable-line react-hooks/exhaustive-deps

  const downloadHtml = useCallback(async () => {
    setBusy('html')
    try {
      const r = await complete()
      download(reportFileName(r, 'html'), runReportHtml(r), 'text/html;charset=utf-8')
      toast.success('Report downloaded', { description: reportFileName(r, 'html') })
    } catch (e) {
      toast.error('Could not build the report', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }, [complete, toast])

  const downloadPdf = useCallback(async () => {
    setBusy('pdf')
    try {
      const [r, { runReportPdf }] = await Promise.all([complete(), import('../data/perf-run-report-pdf.ts')])
      download(reportFileName(r, 'pdf'), runReportPdf(r), 'application/pdf')
      toast.success('Report downloaded', { description: reportFileName(r, 'pdf') })
    } catch (e) {
      toast.error('Could not build the PDF', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }, [complete, toast])

  return {
    report,
    chartsLoading: chartsQ.isLoading && Boolean(chartInput) && a.charts,
    chartsError: chartsQ.error ? (chartsQ.error as Error).message : undefined,
    downloadHtml,
    downloadPdf,
    busy,
  }
}

/* ─────────────────────────── the view ─────────────────────────── */

const TONE_BADGE: Record<ReportTone, StatusKind> = { good: 'healthy', bad: 'failed', warn: 'degraded', none: 'unknown' }

const TONE_TEXT: Record<ReportTone, string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  bad: 'text-rose-600 dark:text-rose-400',
  warn: 'text-amber-600 dark:text-amber-400',
  none: 'text-content',
}

/** Report hexes → theme tokens, so the in-app charts follow light and dark. */
const THEME: Record<string, string> = {
  '#e11d48': 'var(--color-rose-500)',
  '#d97706': 'var(--color-amber-500)',
  '#0284c7': 'var(--color-accent-500)',
  '#4f46e5': 'var(--color-brand-500)',
  '#6366f1': 'var(--color-brand-400)',
  '#7c3aed': 'var(--color-brand-600)',
  '#059669': 'var(--color-emerald-500)',
  '#64748b': 'var(--color-slate-400)',
}

function NotRecorded({ text, note }: { text: string; note?: string }) {
  return note
    ? <span title={note} className="cursor-help border-b border-dotted border-content-subtle text-content-subtle">{text}</span>
    : <>{text}</>
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-edge-subtle pb-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{title}</h3>
        {aside ? <div className="ml-auto text-[11px] text-content-subtle">{aside}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function RunReportView({ fr, onCopyLink }: { fr: FinalReport; onCopyLink?(): void }) {
  const r = fr.report
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-full space-y-1 sm:basis-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge kind={TONE_BADGE[r.verdict.tone]}>{r.verdict.label}</StatusBadge>
            <span className="text-[11px] text-content-subtle">
              {r.startedAt ? fmtUtc(r.startedAt) : ''}{r.durationSecs !== undefined ? ` · ${fmtSecs(r.durationSecs)}` : ''}
            </span>
          </div>
          <p className="text-[13px] leading-relaxed text-content">{r.verdict.headline}</p>
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {onCopyLink ? <Button size="sm" variant="ghost" onClick={onCopyLink}>Copy link</Button> : null}
          <Button size="sm" variant="secondary" loading={fr.busy === 'html'} disabled={Boolean(fr.busy)} onClick={() => void fr.downloadHtml()}>HTML</Button>
          <Button size="sm" variant="primary" loading={fr.busy === 'pdf'} disabled={Boolean(fr.busy)} onClick={() => void fr.downloadPdf()}>Download PDF</Button>
        </div>
      </div>

      {r.verdict.reasons.length
        ? (
          <ul className="space-y-1 text-[12px]">
            {r.verdict.reasons.map((x) => (
              <li key={x} className={cn('flex gap-2', r.verdict.tone === 'bad' ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300')}>
                <span aria-hidden>•</span>
                <span className="min-w-0">{x}</span>
              </li>
            ))}
          </ul>
        )
        : null}
      {r.verdict.note ? <p className="text-[11px] text-content-subtle">{r.verdict.note}</p> : null}

      {r.kpis.length
        ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {r.kpis.map((k) => (
              <div key={k.label} className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-3 py-2.5">
                <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{k.label}</div>
                <div className={cn('mt-1 truncate font-mono text-[17px] font-semibold tabular-nums leading-none', k.value === 'not recorded' ? 'text-[13px]' : TONE_TEXT[k.tone ?? 'none'])}>
                  {k.value === 'not recorded' ? <NotRecorded text={k.value} note={r.latency.find((l) => l.key === 'p99Ms')?.note} /> : k.value}
                </div>
                {k.note ? <div className="mt-1 truncate text-[10px] text-content-subtle" title={k.note}>{k.note}</div> : null}
              </div>
            ))}
          </div>
        )
        : <p className="text-[12px] text-content-muted">No end-of-test summary was kept for this run, so there are no measurements.</p>}

      {r.latency.length
        ? (
          <Section title="Latency percentiles" aside="http_req_duration, whole run">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {r.latency.map((l) => (
                <div key={l.key} className="min-w-0 rounded-lg border border-edge-subtle px-2.5 py-2">
                  <div className="truncate text-[10px] text-content-subtle">{l.label}</div>
                  <div className="truncate font-mono text-[13px] tabular-nums text-content"><NotRecorded text={l.text} note={l.note} /></div>
                </div>
              ))}
            </div>
          </Section>
        )
        : null}

      <Section title="Gate and thresholds">
        {r.gate.length
          ? (
            <ul className="space-y-1">
              {r.gate.map((g) => (
                <li key={g.label} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12px]">
                  <Mark ok={g.passed} />
                  <span className="font-medium text-content">{g.label}</span>
                  <span className="min-w-0 text-content-muted">{g.detail}</span>
                </li>
              ))}
            </ul>
          )
          : <p className="text-[12px] text-content-muted">{r.verdict.label === 'In progress' ? 'The gate is judged once the run finishes.' : 'No gate was evaluated for this run.'}</p>}
        {r.thresholds.length
          ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-[12px]">
                <thead className="text-left text-[10px] uppercase tracking-wider text-content-subtle">
                  <tr><th className="py-1 pr-3 font-medium">Metric</th><th className="py-1 pr-3 font-medium">Rule</th><th className="py-1 pr-3 font-medium">Measured</th><th className="py-1 font-medium">Result</th></tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {r.thresholds.map((t) => (
                    <tr key={`${t.metric}:${t.expression}`}>
                      <td className="py-1.5 pr-3 font-mono text-[11px] text-content">{t.metric}</td>
                      <td className="py-1.5 pr-3 font-mono text-[11px] text-content-muted">{t.expression}</td>
                      <td className="py-1.5 pr-3 font-mono text-[11px] text-content-muted">{t.actual ?? '—'}</td>
                      <td className="py-1.5">{t.state === 'pending' ? <span className="text-content-subtle">not evaluated</span> : <Mark ok={t.state === 'pass'} label />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <p className="text-[12px] text-content-muted">The script declares no thresholds.</p>}
      </Section>

      {r.comparisons.map((c) => (
        <Section key={c.title} title={c.title} aside={<span className="font-mono">{c.against}{c.when ? ` · ${c.when}` : ''}</span>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[460px] text-[12px]">
              <thead className="text-left text-[10px] uppercase tracking-wider text-content-subtle">
                <tr><th className="py-1 pr-3 font-medium">Metric</th><th className="py-1 pr-3 text-right font-medium">Then</th><th className="py-1 pr-3 text-right font-medium">Now</th><th className="py-1 pr-3 text-right font-medium">Change</th><th className="py-1 font-medium">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-edge-subtle">
                {c.rows.map((x) => (
                  <tr key={x.key}>
                    <td className="py-1.5 pr-3 text-content">{x.label}</td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-content-muted"><NotRecorded text={x.before} note={x.before === 'not recorded' ? r.latency.find((l) => l.key === 'p99Ms')?.note ?? 'k6 was not asked for p99 on that run.' : undefined} /></td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-content"><NotRecorded text={x.now} note={x.now === 'not recorded' ? r.latency.find((l) => l.key === 'p99Ms')?.note : undefined} /></td>
                    <td className={cn('py-1.5 pr-3 text-right font-mono tabular-nums', x.status === 'regressed' ? 'text-rose-600 dark:text-rose-400' : x.status === 'improved' ? 'text-emerald-600 dark:text-emerald-400' : 'text-content-muted')}>{x.change ?? '—'}</td>
                    <td className="py-1.5">
                      {x.status === 'n/a'
                        ? <span className="text-content-subtle">not comparable</span>
                        : x.status === 'regressed'
                        ? <StatusBadge kind="failed">regressed</StatusBadge>
                        : x.status === 'improved'
                        ? <StatusBadge kind="healthy">improved</StatusBadge>
                        : <span className="text-content-subtle">within tolerance</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ))}

      <Section title="During the run" aside={r.charts?.load ? 'the run window, padded a minute either side' : undefined}>
        {fr.chartsLoading
          ? <div className="grid grid-cols-1 gap-3 lg:grid-cols-2"><Skeleton className="block h-40 w-full" /><Skeleton className="block h-40 w-full" /></div>
          : fr.chartsError
          ? <p className="text-[12px] text-content-muted">{fr.chartsError} The report still carries what k6 measured.</p>
          : r.charts
          ? (
            <>
              {r.charts.charts.length
                ? <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{r.charts.charts.map((c) => <ChartBox key={c.id} c={c} charts={r.charts!} />)}</div>
                : null}
              {r.charts.missing.length
                ? (
                  <ul className="space-y-0.5 text-[11px] text-content-subtle">
                    {r.charts.missing.map((m) => <li key={m.label}><span className="text-content-muted">{m.label}</span> — not charted: {m.reason}.</li>)}
                  </ul>
                )
                : null}
            </>
          )
          : <p className="text-[12px] text-content-muted">{r.verdict.label === 'In progress' ? 'Charted over the run’s window once it finishes — the Metrics tab shows it live.' : 'No time window is recorded for this run.'}</p>}
      </Section>

      {r.timeline.length
        ? (
          <Section title="Timeline">
            <ul className="space-y-1">
              {r.timeline.map((p) => (
                <li key={p.label} className="flex min-w-0 flex-wrap items-baseline gap-x-3 text-[12px]">
                  <span className={cn('w-28 shrink-0 font-medium', p.state === 'failed' ? 'text-rose-600 dark:text-rose-400' : 'text-content')}>{p.label}</span>
                  <span className="font-mono text-[11px] text-content-subtle">{fmtUtc(p.startMs)}</span>
                  {p.startMs !== undefined && p.endMs !== undefined ? <span className="font-mono text-[11px] text-content-muted">{fmtSecs((p.endMs - p.startMs) / 1000)}</span> : null}
                  {p.detail ? <span className="min-w-0 text-[11px] text-content-muted">{p.detail}</span> : null}
                </li>
              ))}
            </ul>
          </Section>
        )
        : null}

      <Section title="Environment and test configuration">
        <dl className="space-y-1">
          {r.config.map((c) => (
            <div key={c.label} className="flex flex-col gap-0.5 text-[12px] sm:flex-row sm:gap-3">
              <dt className="w-36 shrink-0 text-content-subtle">{c.label}</dt>
              <dd className={cn('min-w-0 flex-1 break-words text-content', c.mono && 'font-mono text-[11px]')}>{c.value}</dd>
            </div>
          ))}
        </dl>
        {r.environment.length
          ? (
            <div className="space-y-0.5 pt-2 font-mono text-[11px]">
              {r.environment.map((v) => (
                <div key={v.name} className="flex min-w-0 gap-2">
                  <span className="shrink-0 text-content-muted">{v.name}</span>
                  <span className="min-w-0 truncate text-content" title={v.value}>{v.value}</span>
                </div>
              ))}
            </div>
          )
          : null}
      </Section>

      {r.logs.length
        ? (
          <Section title={r.logs[0]?.count !== undefined ? 'Most frequent warnings and errors' : 'Errors logged'}>
            <ul className="space-y-1 font-mono text-[11px]">
              {r.logs.map((l) => (
                <li key={l.text} className="flex min-w-0 gap-2">
                  <span className="w-20 shrink-0 text-right text-content-subtle">{l.count !== undefined ? `${l.count}× ` : ''}{l.level}</span>
                  <span className="min-w-0 break-words text-content">{l.text}</span>
                </li>
              ))}
            </ul>
          </Section>
        )
        : null}

      {r.metrics.length
        ? (
          <details className="group">
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-content-subtle">All k6 metrics ({r.metrics.length})</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left font-mono text-[11px]">
                <tbody className="divide-y divide-edge-subtle">
                  {r.metrics.map((m) => (
                    <tr key={m.name}><td className="whitespace-nowrap py-1 pr-3 text-content-muted">{m.name}</td><td className="py-1 text-content">{m.raw}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )
        : null}

      {r.notes.length ? <div className="space-y-1 text-[11px] text-content-subtle">{r.notes.map((n) => <p key={n}>{n}</p>)}</div> : null}
    </div>
  )
}

function Mark({ ok, label }: { ok: boolean; label?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1 font-mono', ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
      <span aria-hidden>{ok ? '✓' : '✗'}</span>
      <span className={label ? '' : 'sr-only'}>{ok ? 'pass' : 'fail'}</span>
    </span>
  )
}

function ChartBox({ c, charts }: { c: ReportChart; charts: ReportCharts }) {
  const caption = chartCaption(c)
  const fmtT = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="min-w-0 rounded-xl border border-edge-default p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <div className="text-[12px] font-semibold text-content">{c.title}</div>
        <div className="text-[10px] text-content-subtle">{c.source}</div>
      </div>
      {caption ? <div className="mb-1 truncate text-[10px] text-content-subtle" title={caption}>{caption}</div> : null}
      <TimeSeriesChart
        height={130}
        series={c.series.map((s) => ({ name: s.label, color: THEME[s.color] ?? s.color, dashed: s.dashed, points: s.points.filter(([t]) => t >= charts.domain[0] && t <= charts.domain[1]) }))}
        formatY={(v) => formatMetric(v, c.unit)}
        formatTime={fmtT}
        yMax={c.yMax}
        emptyLabel="No samples in the run window"
      />
    </div>
  )
}
