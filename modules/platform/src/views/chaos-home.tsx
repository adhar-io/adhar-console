import { useMemo, type ReactNode } from 'react'
import { Badge, Button, EmptyState, Skeleton, Sparkline, StatusBadge, type StatusKind } from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import { durationOf, faultById, faultOf, isLive, phaseOf, resultNameFor, targetSummary, verdictTally, type ChaosEngine, type ChaosResult } from '../data/chaos-kinds.ts'
import type { ChaosWorkflow } from '../data/chaos.ts'
import { clock, injectionStart, orderSteps, workflowPhase } from '../data/chaos-live.ts'
import { type ChaosRunReport, resilienceScore, runGrade, runVerdict, type RunVerdict, VERDICT_LABEL } from '../data/chaos-report.ts'
import type { ResilienceRun } from '../data/chaos-suite-hooks.ts'
import { runPhase } from '../data/chaos-suites.ts'
import type { ScorerApp } from '../data/chaos-live-hooks.ts'
import { useNow } from './chaos-run-canvas.tsx'

/**
 * The Chaos home: what is being broken right now, how each application has
 * done under chaos lately (verdicts, the run score trend, the scorer's
 * resilience grade), and where to go next. Every number is read from the
 * cluster or the recorded reports; with nothing recorded the sections say so
 * and offer the next step instead of showing zeros as if they meant something.
 */

const VERDICT_KIND: Record<RunVerdict, StatusKind> = { survived: 'healthy', failed: 'failed', inconclusive: 'degraded' }
const GRADE_TONE: Record<string, string> = {
  A: 'bg-emerald-500', B: 'bg-lime-500', C: 'bg-amber-500', D: 'bg-orange-500', F: 'bg-rose-500', '—': 'bg-slate-400',
}

export interface HomeProps {
  engines: ChaosEngine[]
  results: Map<string, ChaosResult>
  /** The top-bar namespace, when one is selected: everything here is scoped to it. */
  namespace?: string
  enginesLoading: boolean
  /** The engines could not be listed — nothing below may read as "nothing running". */
  enginesError?: Error
  onRetryEngines(): void
  workflows: ChaosWorkflow[]
  runs: ResilienceRun[]
  reports: ChaosRunReport[]
  reportsLoading: boolean
  reportsError?: Error | null
  onRetryReports(): void
  reportsConfigured: boolean
  scorer?: Map<string, ScorerApp>
  canLaunch: boolean
  canGameDay: boolean
  onNewExperiment(): void
  onNewGameDay(): void
  onTab(tab: 'experiments' | 'suites' | 'gamedays' | 'reports' | 'library'): void
  onOpenRun(name: string): void
  onOpenGameDay(name: string): void
  onOpenSuiteRun(job: string): void
  onOpenReport(id: string): void
  onCompare(a: string, b: string): void
}

export function ChaosHome(p: HomeProps) {
  const liveEngines = p.engines.filter((e) => isLive(e) || phaseOf(e) === 'injecting')
  const liveGd = p.workflows.filter((w) => ['running', 'pending', 'stopping'].includes(workflowPhase(w)))
  const liveRuns = p.runs.filter((r) => ['running', 'pending'].includes(runPhase(r.status)))
  const anything = liveEngines.length + liveGd.length + liveRuns.length > 0
  const now = useNow(anything)

  // Verdicts come from the ChaosResults, not the engines: the resilience
  // runner deletes its engines after every run and keeps their results, so
  // counting engines said "no verdict yet" with verdicts on the cluster.
  const tally = useMemo(() => verdictTally(p.results.values(), p.engines, p.namespace), [p.results, p.engines, p.namespace])
  const monthAgo = Date.now() - 30 * 86_400_000
  const recentReports = p.reports.filter((r) => Date.parse(r.finishedAt) >= monthAgo)
  const survived = recentReports.filter((r) => runVerdict(r) === 'survived').length
  const inProgress = liveEngines.length + liveGd.length + liveRuns.length

  return (
    <div className="space-y-5">
      <section aria-label="Running now" className="rounded-xl border border-edge-default bg-surface-raised">
        <div className="flex flex-wrap items-center gap-2 border-b border-edge-default px-4 py-2.5">
          <span className="relative flex size-2.5">
            {anything ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" /> : null}
            {/* Green only once the engines have been read and nothing is running: while
                loading, or when they could not be read, it is not known to be calm. */}
            <span className={cn('relative inline-flex size-2.5 rounded-full', anything ? 'bg-rose-500' : p.enginesLoading || p.enginesError ? 'bg-slate-400' : 'bg-emerald-500')} />
          </span>
          <h2 className="text-[13px] font-semibold text-content">Running now</h2>
          {/* Nothing is claimed until the engines have been read. */}
          {!p.enginesLoading && !p.enginesError ? (
            <span className="text-[11px] text-content-subtle">{anything ? `${inProgress} in progress` : 'nothing is being broken on purpose'}</span>
          ) : null}
        </div>
        {p.enginesLoading ? (
          <div className="space-y-2 p-4" aria-busy="true"><Skeleton height={44} /><Skeleton height={44} /></div>
        ) : p.enginesError && !anything ? (
          // An unreadable engine list must not read as "nothing is running":
          // during an incident that is exactly the wrong reassurance.
          <EmptyState
            bare
            compact
            tone="error"
            title="Experiments could not be read"
            description={`Whether a fault is applied right now is unknown. ${p.enginesError.message}`}
            action={<Button size="sm" onClick={p.onRetryEngines}>Try again</Button>}
          />
        ) : !anything ? (
          <div className="flex flex-wrap items-center gap-3 px-4 py-4">
            <p className="min-w-0 flex-1 basis-64 text-[12px] text-content-muted">
              No experiment, game day or suite run is in progress. Start with a pod delete on a non-critical workload — it is the fault real clusters survive — or run an application&apos;s own suite.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => p.onTab('suites')}>Run a suite</Button>
              {p.canLaunch ? <Button size="sm" variant="primary" onClick={p.onNewExperiment}>New experiment</Button> : null}
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-edge-subtle">
            {liveEngines.map((e) => {
              const r = resultNameFor(e) ? p.results.get(resultNameFor(e)!) : undefined
              const start = injectionStart(e, r) ?? NaN
              const dur = durationOf(e)
              const pct = Number.isFinite(start) && dur ? Math.min(1, (now - start) / (dur * 1000)) : undefined
              const phase = phaseOf(e)
              return (
                <LiveRow
                  key={e.metadata.name}
                  kind="Experiment"
                  title={e.metadata.name}
                  sub={`${faultById(faultOf(e))?.label ?? faultOf(e)} · ${targetSummary(e)}`}
                  status={<StatusBadge kind={phase === 'injected' ? 'failed' : phase === 'recovering' ? 'paused' : 'progressing'} pulse>{phase === 'injected' ? 'injecting' : phase === 'recovering' ? 'recovering' : 'starting'}</StatusBadge>}
                  progress={pct}
                  meta={Number.isFinite(start) && dur ? `${clock(now - start)} of ${clock(dur * 1000)}` : undefined}
                  onWatch={() => p.onOpenRun(e.metadata.name)}
                />
              )
            })}
            {liveGd.map((w) => {
              const steps = orderSteps(w).filter((s) => s.kind === 'scenario')
              const done = steps.filter((s) => s.phase === 'done' || s.phase === 'failed').length
              const cur = steps.find((s) => s.phase === 'running')
              return (
                <LiveRow
                  key={w.metadata.name}
                  kind="Game day"
                  title={w.metadata.name}
                  sub={[w.metadata.labels?.['adhar.io/chaos-target'], cur?.scenario?.title ?? 'between scenarios'].filter(Boolean).join(' · ')}
                  status={<StatusBadge kind="progressing" pulse>{workflowPhase(w) === 'stopping' ? 'stopping' : 'running'}</StatusBadge>}
                  progress={steps.length ? done / steps.length : undefined}
                  meta={`${done} of ${steps.length} scenarios`}
                  onWatch={() => p.onOpenGameDay(w.metadata.name)}
                />
              )
            })}
            {liveRuns.map((r) => (
              <LiveRow
                key={r.job}
                kind="Suite run"
                title={r.app}
                sub={`${r.environment} · ${r.triggeredBy === 'console' ? 'started from this page' : 'promotion gate'}`}
                status={<StatusBadge kind="progressing" pulse>{runPhase(r.status) === 'pending' ? 'starting' : 'running'}</StatusBadge>}
                meta={r.startTime ? `${clock(now - Date.parse(r.startTime))} so far` : undefined}
                onWatch={() => p.onOpenSuiteRun(r.job)}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* An unreadable source shows a dash, never a zero that means "none". */}
        <Tile label="Injecting now" value={p.enginesLoading ? undefined : p.enginesError ? '—' : String(p.engines.filter(isLive).length)} hint={p.enginesError ? 'Experiments could not be read' : 'Faults applied to a target this moment'} alarm={p.engines.some(isLive)} />
        <Tile label="Experiments" value={p.enginesLoading ? undefined : p.enginesError ? '—' : String(p.engines.length)} hint={p.enginesError ? 'Experiments could not be read' : p.namespace ? `ChaosEngines targeting ${p.namespace}` : 'ChaosEngines on this cluster'} />
        <Tile
          label="Hypotheses held"
          value={p.enginesLoading ? undefined : tally.judged ? `${tally.held}/${tally.judged}` : '—'}
          hint={p.enginesLoading
            ? 'Latest verdict per experiment and fault'
            : p.enginesError && !tally.judged
            ? 'Experiments could not be read'
            : tally.judged
            ? `Latest verdict per experiment and fault${tally.errored ? ` · ${tally.errored} ended without one` : ''}`
            : tally.errored
            ? `${tally.errored} experiment${tally.errored === 1 ? '' : 's'} ended without a verdict`
            : 'No experiment has a verdict yet'}
        />
        <Tile
          label="Suite runs survived · 30d"
          value={p.reportsLoading ? undefined : recentReports.length ? `${survived}/${recentReports.length}` : '—'}
          hint={p.reportsLoading ? 'Recorded resilience runs that survived every fault' : p.reportsError ? 'Run reports could not be read' : recentReports.length ? 'Recorded resilience runs that survived every fault' : 'No suite run recorded in 30 days'}
        />
      </div>

      <AppResilience {...p} />
    </div>
  )
}

function LiveRow({ kind, title, sub, status, progress, meta, onWatch }: { kind: string; title: string; sub: string; status: ReactNode; progress?: number; meta?: string; onWatch(): void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">{kind}</span>
          <span className="truncate text-[13px] font-medium text-content">{title}</span>
          {status}
        </div>
        <div className="truncate text-[11px] text-content-muted">{sub}</div>
      </div>
      <div className="flex w-full items-center gap-3 sm:w-auto">
        {progress !== undefined ? (
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken sm:w-36 sm:flex-none">
            <div className="h-full rounded-full bg-rose-500 transition-[width] duration-1000 ease-linear" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : null}
        {meta ? <span className="shrink-0 font-mono text-[11px] tabular-nums text-content-subtle">{meta}</span> : null}
        <Button size="sm" onClick={onWatch}>Watch live</Button>
      </div>
    </li>
  )
}

function Tile({ label, value, hint, alarm }: { label: string; value?: string; hint: string; alarm?: boolean }) {
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-3.5">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-content-subtle">{label}</div>
      {value === undefined ? <Skeleton height={28} width={56} className="mt-1" /> : (
        <div className={cn('mt-0.5 text-2xl font-semibold tabular-nums', alarm ? 'text-rose-600 dark:text-rose-400' : 'text-content')}>{value}</div>
      )}
      <div className="mt-0.5 text-[11px] text-content-subtle">{hint}</div>
    </div>
  )
}

/* ─────────────────────────── per application ─────────────────────────── */

interface AppRow {
  app: string
  latest: ChaosRunReport
  previous?: ChaosRunReport
  runs: ChaosRunReport[]
  trend: number[]
}

function AppResilience(p: HomeProps) {
  const rows = useMemo((): AppRow[] => {
    const by = new Map<string, ChaosRunReport[]>()
    for (const r of p.reports) {
      const l = by.get(r.app) ?? []
      l.push(r)
      by.set(r.app, l)
    }
    return [...by.entries()].map(([app, list]) => {
      const sorted = [...list].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
      const trend = sorted.slice(0, 12).reverse().map((r) => resilienceScore(r)).filter((n): n is number => n !== null)
      return { app, latest: sorted[0], previous: sorted.find((r) => r.id !== sorted[0].id && r.namespace === sorted[0].namespace), runs: sorted, trend }
    }).sort((a, b) => b.latest.finishedAt.localeCompare(a.latest.finishedAt))
  }, [p.reports])

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-content">Resilience by application</h2>
          <p className="text-[12px] text-content-muted">The latest recorded suite run of each application, its run-score trend, and the platform scorer&apos;s resilience grade.</p>
        </div>
        {rows.length ? <Button size="sm" variant="ghost" onClick={() => p.onTab('reports')}>All run reports</Button> : null}
      </div>
      {p.reportsLoading ? (
        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2" aria-busy="true">{[0, 1].map((i) => <Skeleton key={i} height={104} />)}</div>
      ) : p.reportsError ? (
        <EmptyState
          compact
          tone="error"
          title="Run reports could not be read"
          description={p.reportsError.message}
          action={<Button onClick={p.onRetryReports}>Try again</Button>}
        />
      ) : !p.reportsConfigured ? (
        <EmptyState compact title="Run reports are not being kept" description="The console database is not configured, so suite runs are not recorded. Configure it and every run from then on gets a report here." />
      ) : !rows.length ? (
        <EmptyState
          title="No suite runs recorded yet"
          description="A report is recorded every time the resilience runner tests an application — hourly, on promotion, or when you run a suite from Application suites."
          action={<Button onClick={() => p.onTab('suites')}>Go to application suites</Button>}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
          {rows.map((row) => {
            const v = runVerdict(row.latest)
            const grade = runGrade(row.latest)
            const score = resilienceScore(row.latest)
            const sc = p.scorer?.get(row.app)
            return (
              <li key={row.app} className="flex min-w-0 flex-col gap-2 rounded-xl border border-edge-default bg-surface-raised p-3.5">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-[15px] font-bold text-white', GRADE_TONE[grade] ?? 'bg-slate-400')} title="Grade of the latest run">{grade}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-[13px] font-semibold text-content">{row.app}</span>
                      <StatusBadge kind={VERDICT_KIND[v]}>{VERDICT_LABEL[v]}</StatusBadge>
                    </div>
                    <div className="truncate text-[11px] text-content-subtle" title={formatAbsolute(row.latest.finishedAt)}>
                      {row.latest.environment} · {formatRelative(row.latest.finishedAt)} · {row.runs.length} run{row.runs.length === 1 ? '' : 's'} recorded
                    </div>
                  </div>
                  <div className="w-24 shrink-0 text-right">
                    <div className="font-mono text-[15px] font-semibold tabular-nums text-content">{score ?? '—'}<span className="text-[10px] text-content-subtle">{score === null ? '' : '/100'}</span></div>
                    {row.trend.length >= 2 ? <Sparkline points={row.trend} height={20} color={v === 'failed' ? 'var(--color-rose-500, #f43f5e)' : 'var(--color-emerald-500, #10b981)'} /> : <div className="text-[10px] text-content-subtle">one run so far</div>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {sc?.resilience !== undefined ? (
                    <Badge tone={sc.resilience >= 80 ? 'emerald' : sc.resilience >= 60 ? 'amber' : 'rose'}>scorer resilience {sc.resilience}%</Badge>
                  ) : null}
                  {sc?.history && sc.history.length >= 2 ? (
                    <span className="inline-flex items-center gap-1.5 text-[10.5px] text-content-subtle" title="Overall scorecard score, per scorer run">
                      scorecard
                      <span className="w-16"><Sparkline points={sc.history.map((h) => h.score)} height={14} /></span>
                      {sc.score !== undefined ? `${sc.score}` : ''}
                    </span>
                  ) : null}
                  <span className="ml-auto flex gap-1.5">
                    {row.previous ? <Button size="xs" className="pointer-coarse:h-9" variant="ghost" onClick={() => p.onCompare(row.previous!.id, row.latest.id)}>Compare with previous</Button> : null}
                    <Button size="xs" className="pointer-coarse:h-9" onClick={() => p.onOpenReport(row.latest.id)}>Open report</Button>
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
