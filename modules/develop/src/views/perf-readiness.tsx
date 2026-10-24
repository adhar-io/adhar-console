import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Card, CardBody, CardHeader, EmptyState, Spinner, useToast } from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import {
  type ChaosRow,
  fmtGauge,
  type Gauge,
  readinessApplications,
  readinessReport,
  type ReadinessReport,
  type ScorerApplication,
  type Tone,
} from '../data/perf-readiness.ts'
import { useDevelopParams, useSetDevelopParams } from '../data/nav.ts'
import { reportHtml } from '../data/perf-report.ts'

/**
 * Readiness: one report per application that says whether it is fast enough
 * and survives failure, with the evidence beside every claim.
 *
 * Everything shown is what the platform scorer recorded — the automated load
 * test and chaos suite the resilience runner runs every hour, the live SLO,
 * the team's own Performance Center gates and game days. The page adds no
 * judgement of its own, and a measurement that was never taken says so.
 *
 * The report downloads as a PDF (perf-report-pdf.ts) or a standalone HTML
 * page (perf-report.ts) — observations, what they mean and ranked
 * recommendations — for a change record or release review.
 */
export function PerfReadiness() {
  const q = useQuery({
    queryKey: ['platform-scorecards', 'readiness'],
    queryFn: async () => {
      const res = await fetch('/api/scorecards', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`scorecards: ${res.status}`)
      return (await res.json()) as { configured?: boolean; lastRun?: string; services?: ScorerApplication[]; error?: string; detail?: string }
    },
    // The scorer runs on its own schedule (`lastRun`); nothing changes while
    // the page is open, so read once and keep it for a few minutes.
    staleTime: 5 * 60_000,
    retry: false,
  })
  const apps = useMemo(() => readinessApplications(q.data?.services ?? []), [q.data])
  // The open report is in the URL (`?app=`), so a scorecard can link straight
  // to one application's report and the link can be shared.
  const params = useDevelopParams()
  const setParams = useSetDevelopParams()
  const selected = params.app
  const setSelected = (app: string) => setParams({ app })
  const current = apps.find((a) => a.name === selected) ?? apps[0]
  const report = useMemo(() => (current ? readinessReport(current) : undefined), [current])

  if (q.isLoading) {
    return <div className="flex justify-center py-16"><Spinner /></div>
  }
  // `not_installed` is the honest "never ran here" case below; every other
  // code means the results exist (or may) but could not be read.
  if (q.isError || (q.data?.error && q.data.error !== 'not_installed')) {
    return (
      <EmptyState
        title="Couldn't read the platform scorer's results"
        description={
          q.error instanceof Error
            ? q.error.message
            : q.data?.error === 'forbidden'
            ? 'Your account may not read the adhar-scorecards ConfigMap. Ask a platform admin for access.'
            : `The scorer's results could not be read (${q.data?.error}${q.data?.detail ? `: ${q.data.detail}` : ''}).`
        }
        action={<Button size="sm" variant="secondary" onClick={() => q.refetch()}>Retry</Button>}
      />
    )
  }
  if (!q.data?.configured) {
    return (
      <EmptyState
        title="The platform scorer has not run here"
        description="Readiness reports come from the adhar-scorecards package, which tests every delivered application automatically. Enable it in the stack and the first report appears within the hour."
      />
    )
  }
  if (!apps.length) {
    return (
      <EmptyState
        title="No delivered applications yet"
        description="Create a service from a template. Once it is deployed to an environment, the platform load-tests it, runs chaos against it and reports here."
      />
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className="print:hidden">
        <CardHeader>
          <h3 className="text-sm font-semibold text-content">Applications</h3>
          <p className="mt-0.5 text-[11px] text-content-muted">
            Scored {q.data.lastRun ? formatRelative(q.data.lastRun) : 'recently'} · tested hourly
          </p>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-y divide-edge-subtle">
            {apps.map((a) => (
              <li key={a.name}>
                <button
                  type="button"
                  onClick={() => setSelected(a.name)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-sunken',
                    a.name === current?.name && 'bg-surface-sunken font-medium',
                  )}
                >
                  <span className="truncate">{a.name}</span>
                  <span className="flex items-center gap-1.5">
                    <CategoryPill label="Perf" value={a.categories?.performance ?? null} />
                    <CategoryPill label="Res" value={a.categories?.resilience ?? null} />
                    <GradeBadge grade={a.grade} small />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {report ? <Report report={report} /> : null}
    </div>
  )
}

/* ─────────────────────────── the report ─────────────────────────── */

function Report({ report: r }: { report: ReadinessReport }) {
  const toast = useToast()
  const [pdfBusy, setPdfBusy] = useState(false)
  const save = (data: BlobPart, type: string, ext: string) => {
    const url = URL.createObjectURL(new Blob([data], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${r.app}-performance-report-${new Date().toISOString().slice(0, 10)}.${ext}`
    a.click()
    // Revoke after the click has been handled, or some browsers cancel it.
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  const meta = () => ({ generatedAt: new Date().toISOString(), consoleUrl: globalThis.location?.href })
  const downloadHtml = () => save(reportHtml(r, meta()), 'text/html;charset=utf-8', 'html')
  const downloadPdf = async () => {
    setPdfBusy(true)
    try {
      // Its own chunk: the PDF writer loads only when someone asks for a PDF.
      const { perfReportPdf } = await import('../data/perf-report-pdf.ts')
      // The writer allocates a plain ArrayBuffer-backed array; the cast only narrows the type.
      save(perfReportPdf(r, meta()) as Uint8Array<ArrayBuffer>, 'application/pdf', 'pdf')
    } catch (err) {
      toast.error('Could not build the PDF', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setPdfBusy(false)
    }
  }
  return (
    <article className="space-y-4" aria-label={`Readiness report for ${r.app}`}>
      <Card>
        <CardBody className="flex flex-wrap items-center gap-5">
          <GradeBadge grade={r.grade} />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-content">{r.app}</h2>
            <p className="text-[12px] text-content-muted">
              Production readiness {r.score}/100
              {r.gradedOn ? <> · graded on <span className="font-mono">{r.gradedOn}</span></> : null}
              {r.testedIn ? <> · tested in <span className="font-mono">{r.testedIn}</span></> : null}
              {r.testedAt ? <> · <span title={formatAbsolute(r.testedAt)}>{formatRelative(r.testedAt)}</span></> : null}
            </p>
            {r.image ? <p className="mt-0.5 truncate font-mono text-[11px] text-content-subtle">{r.image}</p> : null}
          </div>
          <div className="flex gap-6">
            <ScoreRing label="Performance" value={r.performanceScore} />
            <ScoreRing label="Resilience" value={r.resilienceScore} />
          </div>
          <div className="flex gap-2 print:hidden">
            <Button size="sm" variant="secondary" onClick={downloadHtml}>Download HTML</Button>
            <Button size="sm" variant="primary" onClick={() => void downloadPdf()} loading={pdfBusy}>Download PDF</Button>
          </div>
        </CardBody>
        <div
          className={cn(
            'border-t border-edge-subtle px-4 py-2 text-[12px]',
            r.signals.some((s) => s.applicable && !s.passed) ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300',
          )}
        >
          {r.pending && !r.testedAt ? `Automated tests: ${r.pending}. ` : null}
          {r.verdict}
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          title="Automated load test"
          subtitle={r.testedIn ? `k6 against ${r.target ?? 'the application Service'}` : 'runs hourly in the test environment'}
          badge={<StatusPill tone={r.loadTone} text={r.loadStatus} />}
        >
          <GaugeList gauges={r.load} />
        </Section>

        <Section
          title="Live service levels"
          subtitle={r.sloEnvironment ? `Prometheus, last 24 h in ${r.sloEnvironment}` : 'from request metrics, once the service has traffic'}
        >
          {r.slo.length
            ? <GaugeList gauges={r.slo} />
            : <p className="text-[12px] text-content-muted">No request metrics yet. They appear once the service exports HTTP metrics and serves traffic.</p>}
        </Section>

        <Section title="Chaos suite" subtitle="Litmus, under a continuous steady-state probe">
          {r.chaos.length
            ? <div className="space-y-2">{r.chaos.map((c) => <ChaosLine key={c.experiment} row={c} />)}</div>
            : <p className="text-[12px] text-content-muted">No chaos experiment has run against this application yet.</p>}
        </Section>

        <Section title="Team evidence" subtitle="Performance Center gates and game days aimed at this application">
          <div className="space-y-3 text-[12px]">
            {r.perfCenter
              ? (
                <EvidenceLine
                  tone={r.perfCenter.tone}
                  title={`Performance Center · ${r.perfCenter.test}`}
                  status={r.perfCenter.verdict}
                  detail={`${r.perfCenter.count} result${r.perfCenter.count === 1 ? '' : 's'} across ${r.perfCenter.tests.join(', ')}` +
                    (r.perfCenter.reasons ? ` — ${r.perfCenter.reasons}` : '')}
                  at={r.perfCenter.at}
                />
              )
              : (
                <p className="text-content-muted">
                  No Performance Center test targets this application. Give a test a target selector of{' '}
                  <span className="font-mono">app={r.app}</span> and its gate verdicts count here and on the scorecard.
                </p>
              )}
            {r.gameDay
              ? (
                <EvidenceLine
                  tone={r.gameDay.tone}
                  title={`Game day · ${r.gameDay.experiment}`}
                  status={r.gameDay.verdict}
                  detail={`probe ${r.gameDay.probe ?? '?'}% · ${r.gameDay.count} fault run${r.gameDay.count === 1 ? '' : 's'}: ${r.gameDay.experiments.join(', ')}`}
                  at={r.gameDay.at}
                />
              )
              : <p className="text-content-muted">No game day has targeted this application yet.</p>}
          </div>
        </Section>
      </div>

      <Section title="Checks" subtitle="The performance and resilience signals the scorecard grades">
        <ul className="grid gap-x-6 gap-y-2 md:grid-cols-2">
          {r.signals.map((s) => (
            <li key={s.name} className="flex items-start gap-2 text-[12px]">
              <Dot tone={!s.applicable ? 'none' : s.passed ? 'good' : 'bad'} />
              <span className="min-w-0">
                <span className="font-medium text-content">{s.label}</span>
                <span className="block text-content-muted">
                  {!s.applicable ? 'Not applicable — ' : null}
                  {s.detail ?? (s.passed ? 'Pass' : 'Not met')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </article>
  )
}

/* ─────────────────────────── pieces ─────────────────────────── */

const TONE_TEXT: Record<Tone, string> = {
  good: 'text-emerald-700 dark:text-emerald-300',
  bad: 'text-rose-700 dark:text-rose-300',
  warn: 'text-amber-700 dark:text-amber-300',
  none: 'text-content-muted',
}
const TONE_BAR: Record<Tone, string> = {
  good: 'bg-emerald-500',
  bad: 'bg-rose-500',
  warn: 'bg-amber-500',
  none: 'bg-content-subtle/40',
}
const GRADE_TONE: Record<string, string> = {
  A: 'bg-emerald-600', B: 'bg-lime-600', C: 'bg-amber-500', D: 'bg-orange-600', F: 'bg-rose-600',
}

function GradeBadge({ grade, small }: { grade: string; small?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white',
        GRADE_TONE[grade] ?? 'bg-content-subtle',
        small ? 'h-5 w-5 text-[10px]' : 'h-14 w-14 text-2xl',
      )}
      aria-label={`grade ${grade}`}
    >
      {grade}
    </span>
  )
}

function toneFor(value: number | null): Tone {
  if (value === null) return 'none'
  return value >= 80 ? 'good' : value >= 60 ? 'warn' : 'bad'
}

function CategoryPill({ label, value }: { label: string; value: number | null }) {
  return (
    <span className={cn('font-mono text-[10px] tabular-nums', TONE_TEXT[toneFor(value)])} title={`${label} ${value ?? 'n/a'}`}>
      {value ?? '–'}
    </span>
  )
}

function ScoreRing({ label, value }: { label: string; value: number | null }) {
  const pct = value ?? 0
  const tone = toneFor(value)
  const stroke = { good: '#10b981', bad: '#f43f5e', warn: '#f59e0b', none: '#94a3b8' }[tone]
  const c = 2 * Math.PI * 22
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="56" height="56" viewBox="0 0 56 56" role="img" aria-label={`${label} ${value ?? 'not applicable'}`}>
        <circle cx="28" cy="28" r="22" fill="none" stroke="currentColor" strokeWidth="6" className="text-surface-sunken" />
        <circle
          cx="28" cy="28" r="22" fill="none" stroke={stroke} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 28 28)"
        />
        <text x="28" y="32" textAnchor="middle" className="fill-current text-[13px] font-semibold">
          {value ?? 'n/a'}
        </text>
      </svg>
      <span className="text-[11px] text-content-muted">{label}</span>
    </div>
  )
}

function Section({ title, subtitle, badge, children }: { title: string; subtitle?: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <Card className="break-inside-avoid">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-content">{title}</h3>
            {subtitle ? <p className="mt-0.5 text-[11px] text-content-muted">{subtitle}</p> : null}
          </div>
          {badge}
        </div>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  )
}

function StatusPill({ tone, text }: { tone: Tone; text: string }) {
  return (
    <span className={cn('rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium capitalize', TONE_TEXT[tone])}>
      {text}
    </span>
  )
}

function Dot({ tone }: { tone: Tone }) {
  return <span className={cn('mt-1 inline-block h-2 w-2 shrink-0 rounded-full', TONE_BAR[tone])} aria-hidden />
}

function GaugeList({ gauges }: { gauges: Gauge[] }) {
  return (
    <div className="space-y-3">
      {gauges.map((g) => (
        <div key={g.label}>
          <div className="flex items-baseline justify-between gap-2 text-[12px]">
            <span className="text-content-muted">{g.label}</span>
            <span className={cn('font-mono font-semibold tabular-nums', TONE_TEXT[g.tone])}>
              {fmtGauge(g)}
              {g.target !== undefined
                ? <span className="ml-1 font-normal text-content-subtle">/ {g.lowerIsBetter ? '<' : '>'} {fmtGauge({ value: g.target, unit: g.unit })}</span>
                : null}
            </span>
          </div>
          <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div className={cn('h-full rounded-full', TONE_BAR[g.tone])} style={{ width: `${Math.round(g.fill * 100)}%` }} />
            {g.target !== undefined
              ? <div className="absolute top-0 h-full w-px bg-content" style={{ left: `${Math.round((1 / 1.5) * 100)}%` }} title="target" />
              : null}
          </div>
          {g.note ? <p className="mt-0.5 text-[10px] text-content-subtle">{g.note}</p> : null}
        </div>
      ))}
    </div>
  )
}

function ChaosLine({ row }: { row: ChaosRow }) {
  return (
    <div className="flex items-start gap-3 rounded-md bg-surface-sunken px-3 py-2">
      <Dot tone={row.tone} />
      <div className="min-w-0 flex-1 text-[12px]">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium text-content">{row.title}</span>
          <span className={cn('font-mono text-[11px] capitalize', TONE_TEXT[row.tone])}>{row.status}</span>
        </div>
        <p className="text-content-muted">
          <span className="font-mono">{row.experiment}</span>
          {row.probePct !== undefined ? ` · probe ${row.probePct}% up` : ''}
          {row.recoverySeconds !== undefined ? ` · recovered in ${row.recoverySeconds}s` : ''}
        </p>
        {row.detail ? <p className="text-content-subtle">{row.detail}</p> : null}
      </div>
    </div>
  )
}

function EvidenceLine({ tone, title, status, detail, at }: { tone: Tone; title: string; status: string; detail: string; at?: string }) {
  return (
    <div className="flex items-start gap-2">
      <Dot tone={tone} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium text-content">{title}</span>
          <span className={cn('font-mono text-[11px] capitalize', TONE_TEXT[tone])}>{status}</span>
          {at ? <span className="text-[11px] text-content-subtle" title={formatAbsolute(at)}>{formatRelative(at)}</span> : null}
        </div>
        <p className="text-content-muted">{detail}</p>
      </div>
    </div>
  )
}
