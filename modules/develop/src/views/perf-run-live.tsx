import { useMemo } from 'react'
import { AreaChart, Card, CardBody, CardHeader, EmptyState, StatusBadge } from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import { STAGE_ORDER, type TestRun, type TestRunStage } from '../data/k6.ts'
import { parseProgress, stageTimings, type ProgressSeries } from '../data/perf-progress.ts'

/**
 * A run while it is running.
 *
 * The stage rail and the live charts both answer "what is happening right
 * now", which the old drawer could not: it had a row of stage pills with no
 * durations and no output until the end-of-test summary appeared. A test that
 * takes twenty minutes showed nothing for twenty minutes.
 *
 * Everything drawn here is k6's own counters, parsed from the progress lines
 * it prints every second (see perf-progress.ts). Latency percentiles are
 * deliberately absent: k6 computes them once, at the end, so there is no
 * honest p95-over-time to draw, and the panel says so rather than plotting
 * something that looks like one.
 */

/* ─────────────────────────── stage rail ─────────────────────────── */

export type StageState = 'done' | 'active' | 'pending' | 'failed' | 'skipped'

export function stageStates(run: TestRun): Array<{ stage: TestRunStage; state: StageState }> {
  const current = (run.status?.stage ?? 'initialization') as TestRunStage
  const failed = current === 'error'
  const stopped = current === 'stopped'
  const reached = STAGE_ORDER.indexOf(current)
  return STAGE_ORDER.map((stage, i) => {
    if (failed || stopped) {
      // The walk stops where it stopped: stages after that point were never
      // reached, and drawing them as pending implies the run is still on its
      // way to them.
      return { stage, state: (i <= Math.max(reached, 0) ? 'done' : 'skipped') as StageState }
    }
    if (reached < 0) return { stage, state: 'pending' as StageState }
    if (i < reached) return { stage, state: 'done' as StageState }
    if (i === reached) return { stage, state: (current === 'finished' ? 'done' : 'active') as StageState }
    return { stage, state: 'pending' as StageState }
  })
}

const STAGE_HINT: Record<TestRunStage, string> = {
  initialization: 'The operator is preparing the run and checking the script.',
  initialized: 'The script parsed and k6 reported how much work it will do.',
  created: 'Runner pods have been created and are being scheduled.',
  started: 'k6 is generating load. The charts below update while it does.',
  finished: 'The run ended and printed its end-of-test summary.',
  stopped: 'Someone asked this run to stop before it finished.',
  error: 'The operator could not run the test. See the conditions and logs.',
}

/**
 * The stages as a CI pipeline reads them: a node per stage with its own
 * status, how long it took, and what it means — clickable, so a stage can be
 * selected and explained rather than only coloured in.
 */
export function StageRail({
  run,
  selected,
  onSelect,
}: {
  run: TestRun
  selected: TestRunStage | null
  onSelect(stage: TestRunStage | null): void
}) {
  const states = stageStates(run)
  const current = (run.status?.stage ?? 'initialization') as TestRunStage
  const terminal = current === 'error' || current === 'stopped'
  const endMs = useMemo(() => {
    const times = (run.status?.conditions ?? []).map((c) => Date.parse(c.lastTransitionTime)).filter(Number.isFinite)
    const latest = times.length ? Math.max(...times) : undefined
    return current === 'finished' || terminal ? latest : Date.now()
  }, [run.status?.conditions, current, terminal])

  const timings = useMemo(
    () => stageTimings(STAGE_ORDER, run.status?.conditions ?? [], endMs),
    [run.status?.conditions, endMs],
  )
  const secsOf = (s: TestRunStage) => timings.find((t) => t.stage === s)?.secs

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[12px] font-semibold text-content">Stages</div>
          {terminal ? (
            <StatusBadge kind={current === 'error' ? 'failed' : 'paused'}>{current}</StatusBadge>
          ) : null}
          <span className="ml-auto text-[11px] text-content-subtle">select a stage for what it means</span>
        </div>
      </CardHeader>
      <CardBody>
        {/* Horizontal on a desktop, a vertical list on a phone: five nodes with
            durations do not fit across 390px without truncating the one number
            the rail exists to show. */}
        <ol className="flex flex-col gap-1 sm:flex-row sm:items-stretch sm:gap-0">
          {states.map(({ stage, state }, i) => {
            const on = selected === stage
            const d = secsOf(stage)
            return (
              <li key={stage} className="flex min-w-0 flex-1 items-center gap-1 sm:block">
                <button
                  type="button"
                  onClick={() => onSelect(on ? null : stage)}
                  aria-pressed={on}
                  className={cn(
                    'group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors sm:flex-col sm:items-start sm:gap-1',
                    on ? 'bg-surface-sunken' : 'hover:bg-surface-sunken/60',
                  )}
                >
                  <span className="flex w-full items-center gap-1.5">
                    <StageDot state={state} />
                    {/* The connector lives between nodes, not after the last. */}
                    {i < states.length - 1 ? (
                      <span
                        aria-hidden
                        className={cn(
                          'hidden h-px flex-1 sm:block',
                          state === 'done' ? 'bg-emerald-400/70' : 'bg-edge-default',
                        )}
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 sm:w-full">
                    <span className={cn('block truncate text-[11.5px] font-medium', on ? 'text-content' : 'text-content-muted')}>
                      {stage}
                    </span>
                    <span className="block truncate font-mono text-[10.5px] tabular-nums text-content-subtle">
                      {state === 'pending' ? '—' : state === 'skipped' ? 'not reached' : d === undefined ? (state === 'active' ? 'running' : '—') : fmtSecs(d)}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>

        {selected ? (
          <div className="mt-2 rounded-lg border border-edge-subtle bg-surface-sunken/40 px-3 py-2">
            <div className="text-[11.5px] font-medium text-content">{selected}</div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-content-muted">{STAGE_HINT[selected]}</p>
            <StageConditions run={run} stage={selected} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

/** The operator's own words for one stage, when it had any. */
function StageConditions({ run, stage }: { run: TestRun; stage: TestRunStage }) {
  const rows = (run.status?.conditions ?? []).filter((c) => c.type.toLowerCase().includes(stage.toLowerCase()))
  if (!rows.length) {
    return <p className="mt-1 text-[11px] text-content-subtle">The operator recorded no condition for this stage.</p>
  }
  return (
    <ul className="mt-1.5 space-y-1">
      {rows.map((c) => (
        <li key={c.type} className="flex flex-wrap items-baseline gap-2 text-[11px]">
          <span className="font-mono text-content-muted">{c.type}</span>
          <span className="text-content-subtle">{c.reason || c.status}</span>
          {c.message && c.message !== c.reason ? <span className="text-content-subtle">{c.message}</span> : null}
        </li>
      ))}
    </ul>
  )
}

function StageDot({ state }: { state: StageState }) {
  const base = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold'
  if (state === 'done') {
    return <span className={cn(base, 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300')}>✓</span>
  }
  if (state === 'active') {
    return (
      <span className={cn(base, 'bg-brand-600 text-white')}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
      </span>
    )
  }
  if (state === 'failed') {
    return <span className={cn(base, 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300')}>!</span>
  }
  if (state === 'skipped') {
    return <span className={cn(base, 'bg-surface-sunken text-content-subtle')}>–</span>
  }
  return <span className={cn(base, 'border border-dashed border-edge-strong text-content-subtle')} />
}

/* ─────────────────────────── live charts ─────────────────────────── */

/**
 * Concurrency and throughput while the test runs, from k6's progress lines.
 * `running` decides the copy: the same charts are a live view during a run and
 * a record of one afterwards.
 */
export function LiveCharts({ lines, running }: { lines: readonly string[]; running: boolean }) {
  const series = useMemo(() => parseProgress(lines), [lines])

  if (!series.points.length) {
    return (
      <EmptyState
        compact
        title={running ? 'Waiting for the first progress line' : 'This run printed no progress lines'}
        description={
          running
            ? 'k6 prints its progress about once a second once the runners start generating load.'
            : 'k6 prints progress to stdout while it runs. If the runner was started quietly (--quiet) or its pod has already been cleaned up, there is nothing to plot.'
        }
      />
    )
  }

  return (
    <div className="space-y-3">
      <ProgressTiles series={series} running={running} />
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard
          title="Virtual users"
          hint="Concurrency k6 actually reached. A flat line under the target means the runners could not keep up."
          points={series.points.map((p) => ({ v: p.vus, label: fmtSecs(p.elapsedSecs) }))}
          color="var(--color-brand-500)"
          formatY={(v) => `${Math.round(v)} VUs`}
        />
        <ChartCard
          title="Iterations per second"
          hint="Completed iterations between one progress line and the next — the throughput k6 saw, not an average over the whole run."
          points={series.rate.map((r) => ({ v: r.perSec, label: fmtSecs(r.elapsedSecs) }))}
          color="var(--color-emerald-500)"
          formatY={(v) => `${v.toFixed(v < 10 ? 1 : 0)}/s`}
        />
      </div>
      <Card>
        <CardBody>
          <p className="text-[11.5px] leading-relaxed text-content-muted">
            Latency percentiles are not plotted over time because k6 does not produce them over time: it computes
            p90, p95 and p99 once, at the end, and prints them in the summary. They appear on the Summary tab as soon
            as the run finishes.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}

function ProgressTiles({ series, running }: { series: ProgressSeries; running: boolean }) {
  const last = series.last
  const elapsed = last?.elapsedSecs ?? 0
  const pct = series.percent ?? (series.plannedSecs ? Math.min(100, (elapsed / series.plannedSecs) * 100) : undefined)
  const tiles: Array<{ label: string; value: string; hint?: string }> = [
    { label: 'Virtual users', value: last ? String(last.vus) : '—', hint: series.peakVus ? `peak ${series.peakVus}` : undefined },
    { label: 'Iterations', value: last ? last.complete.toLocaleString() : '—', hint: last?.interrupted ? `${last.interrupted} interrupted` : 'none interrupted' },
    {
      label: 'Throughput',
      value: series.rate.length ? `${series.rate[series.rate.length - 1].perSec.toFixed(1)}/s` : '—',
      hint: 'last interval',
    },
    {
      label: 'Elapsed',
      value: fmtSecs(elapsed),
      hint: series.plannedSecs ? `of ${fmtSecs(series.plannedSecs)}` : running ? 'running' : 'total',
    },
  ]
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-edge-default bg-surface-raised px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{t.label}</div>
            <div className="mt-0.5 font-mono text-[17px] font-semibold tabular-nums leading-none text-content">{t.value}</div>
            {t.hint ? <div className="mt-1 truncate text-[10.5px] text-content-subtle">{t.hint}</div> : null}
          </div>
        ))}
      </div>
      {pct !== undefined ? (
        <div>
          <div className="flex items-baseline justify-between text-[11px] text-content-subtle">
            <span>{running ? 'Progress' : 'Completed'}</span>
            <span className="font-mono tabular-nums">{Math.round(pct)}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div
              className={cn('h-full rounded-full transition-[width] duration-500', running ? 'bg-brand-500' : 'bg-emerald-500')}
              style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ChartCard({
  title,
  hint,
  points,
  color,
  formatY,
}: {
  title: string
  hint: string
  points: Array<{ v: number; label?: string }>
  color: string
  formatY(v: number): string
}) {
  return (
    <Card>
      <CardHeader>
        <div className="text-[12px] font-semibold text-content">{title}</div>
      </CardHeader>
      <CardBody className="space-y-2">
        <AreaChart points={points} color={color} height={110} formatY={formatY} emptyLabel="Not enough samples yet" />
        <p className="text-[11px] leading-relaxed text-content-subtle">{hint}</p>
      </CardBody>
    </Card>
  )
}

/** `95s` / `2m 05s` / `1h 04m` — a duration a person reads at a glance. */
export function fmtSecs(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '—'
  if (secs < 60) return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
