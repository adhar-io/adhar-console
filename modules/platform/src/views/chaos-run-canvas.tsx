import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  canResource,
  DrawerWidenButton,
  EmptyState,
  Skeleton,
  StatusBadge,
  useCan,
  useDrawerWidth,
  useOverlayDismiss,
  useToast,
  type StatusKind,
} from '@adhar/shell-ui'
import {
  bandsFrom,
  cn,
  formatAbsolute,
  formatMetric,
  type MetricId,
  METRIC_DEFS,
  type PhaseWindow,
  podRegexForApp,
  podRegexFromPods,
  yMaxFor,
} from '@adhar/utils'
import { BandLegend, ChaosChart, METRIC_TOKEN } from '../components/chaos-chart.tsx'
import {
  CHAOS_NAMESPACE,
  ENGINES_GVR,
  envOf,
  FAMILY_LABEL,
  faultById,
  faultOf,
  isLive,
  phaseOf,
  resultNameFor,
  targetSummary,
} from '../data/chaos-kinds.ts'
import {
  applyChaosEngine,
  deleteChaosEngine,
  stopChaosEngine,
  useChaosCluster,
  useChaosEngine,
  useChaosEngines,
  useChaosResult,
} from '../data/chaos.ts'
import {
  clock,
  engineRun,
  type LiveRun,
  observe,
  type Observed,
  type ProbeSample,
  probeSegments,
  rerunManifest,
  rerunName,
  type RunStep,
  STAGE_LABEL,
  STAGES,
  type StepStatus,
  stepProgress,
  suiteRun,
  type TargetPodRow,
  type Verdict,
} from '../data/chaos-live.ts'
import { useLiveTargetMetrics, useProbeTimeline, useRunTimeline, useTargetPods } from '../data/chaos-live-hooks.ts'
import { runPhase } from '../data/chaos-suites.ts'
import type { ResilienceRun } from '../data/chaos-suite-hooks.ts'

/**
 * The live run canvas — one picture of a chaos run while it happens, whatever
 * started it (an experiment, a game day, an application's suite):
 *
 *   ① the lifecycle, scheduled → preparing → injecting → recovering → verdict;
 *   ② what is happening now in a sentence, with the fault's progress and a
 *     recovery timer;
 *   ③ every step of the run (each fault of a suite or game day) with its
 *     status, timing, probe result and recovery;
 *   ④ the target's pods, live — readiness and restarts as the fault lands;
 *   ⑤ the steady-state probe as this page observed it;
 *   ⑥ the target's metrics with the fault windows shaded.
 *
 * Nothing is simulated. A time the cluster does not record (when recovery
 * began) is the moment this page observed it, and is labelled so.
 */

/* ─────────────────────────── shell ─────────────────────────── */

/** A ticking clock while `active` — for timers and progress bars. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [active, ms])
  return now
}

/** The console's side drawer: portalled to body at z-[60], Esc + focus trap, widen mode. */
export function ChaosDrawer({
  title,
  eyebrow,
  badge,
  actions,
  widthKey,
  base = 'max-w-4xl',
  onClose,
  children,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  badge?: ReactNode
  actions?: ReactNode
  widthKey: string
  base?: string
  onClose(): void
  children: ReactNode
}) {
  const width = useDrawerWidth(widthKey, { base })
  const panelRef = useRef<HTMLElement>(null)
  useOverlayDismiss(true, onClose, { focusRef: panelRef })
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim/50" onClick={onClose} />
      <aside ref={panelRef} tabIndex={-1} className={cn('relative flex h-full w-full flex-col border-l border-edge-default bg-surface-app shadow-2xl outline-none', width.className)}>
        <header className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-2 border-b border-edge-default bg-surface-raised px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            {eyebrow ? <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">{eyebrow}</div> : null}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-[15px] font-semibold text-content">{title}</h2>
              {badge}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {actions}
            <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-md px-2 py-1 text-content-subtle hover:bg-surface-sunken hover:text-content">
              ✕
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>,
    document.body,
  )
}

/* ─────────────────────────── lifecycle ─────────────────────────── */

const VERDICT_TEXT: Record<Verdict, string> = { passed: 'Survived', failed: 'Did not survive', stopped: 'Stopped', error: 'No verdict' }
const VERDICT_KIND: Record<Verdict, StatusKind> = { passed: 'healthy', failed: 'failed', stopped: 'paused', error: 'paused' }
const VERDICT_RING: Record<Verdict, string> = {
  passed: 'bg-emerald-500 text-white ring-emerald-500/30',
  failed: 'bg-rose-600 text-white ring-rose-500/30',
  stopped: 'bg-amber-500 text-white ring-amber-500/30',
  error: 'bg-amber-500 text-white ring-amber-500/30',
}

export function runBadge(run: LiveRun): ReactNode {
  if (run.verdict) return <StatusBadge kind={VERDICT_KIND[run.verdict]}>{VERDICT_TEXT[run.verdict]}</StatusBadge>
  return <StatusBadge kind={run.stage === 'injecting' ? 'failed' : run.stage === 'recovering' ? 'paused' : 'progressing'} pulse={run.active}>{STAGE_LABEL[run.stage].toLowerCase()}</StatusBadge>
}

export function LifecycleStepper({ run }: { run: LiveRun }) {
  const at = STAGES.indexOf(run.stage)
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label="Run lifecycle">
      {STAGES.map((s, i) => {
        const done = i < at || (s === 'verdict' && run.stage === 'verdict')
        const current = i === at && run.stage !== 'verdict'
        const isVerdict = s === 'verdict' && run.verdict
        return (
          <li key={s} className="relative flex flex-col items-center gap-1.5 text-center">
            {i > 0 ? (
              <span aria-hidden className={cn('absolute right-1/2 top-3 -z-0 mr-3.5 h-0.5 w-[calc(100%-1.75rem)]', i <= at ? 'bg-brand-500' : 'bg-edge-default')} />
            ) : null}
            <span
              className={cn(
                'relative z-10 flex size-6 items-center justify-center rounded-full text-[11px] font-semibold ring-4 transition-colors',
                isVerdict
                  ? VERDICT_RING[run.verdict!]
                  : done
                  ? 'bg-brand-600 text-white ring-brand-500/15'
                  : current
                  ? s === 'injecting'
                    ? 'bg-rose-600 text-white ring-rose-500/25'
                    : s === 'recovering'
                    ? 'bg-amber-500 text-white ring-amber-500/25'
                    : 'bg-brand-600 text-white ring-brand-500/25'
                  : 'bg-surface-sunken text-content-subtle ring-surface-raised',
              )}
            >
              {current && run.active ? <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-20" /> : null}
              {isVerdict ? (run.verdict === 'passed' ? '✓' : run.verdict === 'failed' ? '✕' : '■') : done ? '✓' : i + 1}
            </span>
            <span className={cn('text-[10.5px] leading-tight sm:text-[11px]', current || isVerdict ? 'font-semibold text-content' : done ? 'text-content-muted' : 'text-content-subtle')}>
              {isVerdict ? VERDICT_TEXT[run.verdict!] : STAGE_LABEL[s]}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/* ─────────────────────────── hero ─────────────────────────── */

function headlineOf(run: LiveRun, target: { ready?: number; total?: number }): string {
  const cur = run.steps.find((s) => s.status === 'running')
  switch (run.stage) {
    case 'scheduled':
      return 'Waiting to start.'
    case 'preparing':
      return cur?.kind === 'load' ? 'Load-testing the application before the first fault.' : 'Selecting targets and starting the experiment runner.'
    case 'injecting':
      return `Injecting: ${cur?.label ?? 'the fault'}${cur?.hypothesis ? ` — expect: ${cur.hypothesis}` : ''}`
    case 'recovering':
      return target.total ? `Recovering — ${target.ready ?? 0} of ${target.total} target pods ready.` : 'Recovering — waiting for the target to be whole again.'
    case 'verdict':
      return run.verdict === 'passed'
        ? 'Every hypothesis held: the system kept serving through the faults.'
        : run.verdict === 'failed'
        ? 'A hypothesis did not hold: the system stopped serving under a fault it was expected to survive.'
        : run.verdict === 'stopped'
        ? 'Stopped before it finished; the fault was recovered on the way out.'
        : 'Finished without a verdict — an infrastructure result, not one about the application.'
  }
}

export function RunHero({ run, now, target, recovery }: { run: LiveRun; now: number; target?: { ready?: number; total?: number }; recovery?: { since?: number; tookSeconds?: number } }) {
  const cur = run.steps.find((s) => s.status === 'running')
  const pct = cur ? stepProgress(cur, now) : undefined
  const elapsed = run.startedAt ? (run.finishedAt ?? now) - run.startedAt : undefined
  const tone = run.stage === 'injecting' ? 'border-rose-300/70 bg-rose-50/70 dark:border-rose-500/30 dark:bg-rose-500/10' : run.stage === 'recovering' ? 'border-amber-300/70 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10' : run.verdict === 'passed' ? 'border-emerald-300/70 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10' : run.verdict === 'failed' ? 'border-rose-300/70 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10' : 'border-edge-default bg-surface-raised'
  return (
    <div className={cn('rounded-xl border p-4', tone)}>
      <LifecycleStepper run={run} />
      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="text-[13px] font-medium text-content">{headlineOf(run, target ?? {})}</div>
          {cur && cur.seconds && pct !== undefined ? (
            <div className="mt-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                <div className={cn('h-full rounded-full transition-[width] duration-1000 ease-linear', cur.kind === 'fault' ? 'bg-rose-500' : 'bg-brand-500')} style={{ width: `${Math.round(pct * 100)}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-[11px] tabular-nums text-content-subtle">
                <span>{cur.label}</span>
                <span>{clock(now - (cur.start ?? now))} of {clock(cur.seconds * 1000)}{pct >= 1 ? ' · waiting for the verdict' : ''}</span>
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex gap-5">
          <Stat label={run.active ? 'Elapsed' : 'Took'} value={elapsed !== undefined ? clock(elapsed) : '—'} />
          {recovery?.tookSeconds !== undefined ? (
            <Stat label="Recovered in" value={`${recovery.tookSeconds}s`} hint="observed by this page" />
          ) : run.stage === 'recovering' && recovery?.since ? (
            <Stat label="Recovering for" value={clock(now - recovery.since)} hint="observed by this page" accent />
          ) : null}
          {target?.total ? <Stat label="Ready pods" value={`${target.ready ?? 0}/${target.total}`} accent={(target.ready ?? 0) < target.total} /> : null}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="text-right" title={hint}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-content-subtle">{label}</div>
      <div className={cn('font-mono text-lg font-semibold tabular-nums leading-tight', accent ? 'text-amber-700 dark:text-amber-300' : 'text-content')}>{value}</div>
    </div>
  )
}

/* ─────────────────────────── steps ─────────────────────────── */

const STEP_DOT: Record<StepStatus, string> = {
  pending: 'bg-surface-raised ring-edge-strong',
  running: 'bg-brand-600 ring-brand-500/30',
  passed: 'bg-emerald-500 ring-emerald-500/20',
  failed: 'bg-rose-600 ring-rose-500/25',
  error: 'bg-amber-500 ring-amber-500/25',
  skipped: 'bg-surface-sunken ring-edge-default',
  stopped: 'bg-amber-500 ring-amber-500/25',
}
const STEP_TEXT: Record<StepStatus, string> = { pending: 'pending', running: 'running', passed: 'passed', failed: 'failed', error: 'no verdict', skipped: 'skipped', stopped: 'stopped' }

export function StepList({ steps, now }: { steps: RunStep[]; now: number }) {
  return (
    <ol className="relative space-y-0">
      {steps.map((s, i) => {
        const pct = stepProgress(s, now)
        const dur = s.start ? (s.end ?? (s.status === 'running' ? now : s.start)) - s.start : undefined
        const def = s.fault ? faultById(s.fault) : undefined
        return (
          <li key={s.id} className="relative flex gap-3 pb-3 last:pb-0">
            {i < steps.length - 1 ? <span aria-hidden className="absolute left-[7px] top-4 h-full w-px bg-edge-default" /> : null}
            <span className={cn('relative mt-1 size-[15px] shrink-0 rounded-full ring-4', STEP_DOT[s.status])}>
              {s.status === 'running' ? <span className="absolute inset-0 animate-ping rounded-full bg-brand-500 opacity-40" /> : null}
            </span>
            <div className={cn('min-w-0 flex-1 rounded-lg border px-3 py-2', s.status === 'running' ? 'border-brand-300 bg-brand-50/50 dark:border-brand-500/40 dark:bg-brand-500/10' : 'border-edge-default bg-surface-raised', (s.status === 'pending' || s.status === 'skipped') && 'opacity-70')}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12.5px] font-medium text-content">{s.label}</span>
                {def ? <Badge>{FAMILY_LABEL[def.family]}</Badge> : null}
                {s.fault ? <span className="font-mono text-[10.5px] text-content-subtle">{s.fault}</span> : null}
                <span className={cn('ml-auto text-[11px] font-medium', s.status === 'failed' ? 'text-rose-700 dark:text-rose-400' : s.status === 'passed' ? 'text-emerald-700 dark:text-emerald-400' : 'text-content-subtle')}>
                  {STEP_TEXT[s.status]}
                </span>
              </div>
              {s.hypothesis ? <div className="mt-0.5 text-[11px] text-content-muted"><span className="font-medium text-content-subtle">Expect:</span> {s.hypothesis}</div> : null}
              {pct !== undefined ? (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-sunken">
                  <div className="h-full rounded-full bg-brand-500 transition-[width] duration-1000 ease-linear" style={{ width: `${Math.round(pct * 100)}%` }} />
                </div>
              ) : null}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] tabular-nums text-content-subtle">
                {s.start ? <span title={formatAbsolute(new Date(s.start).toISOString())}>started {new Date(s.start).toLocaleTimeString()}</span> : null}
                {dur !== undefined && dur > 0 ? <span>{s.status === 'running' ? 'for' : 'took'} {clock(dur)}</span> : s.seconds && s.status === 'pending' ? <span>planned {clock(s.seconds * 1000)}</span> : null}
                {s.probeSuccessPercentage !== undefined ? (
                  <span className={s.probeSuccessPercentage < 100 ? 'text-amber-700 dark:text-amber-400' : undefined}>probe {Number(s.probeSuccessPercentage.toFixed(1))}%</span>
                ) : null}
                {s.recoverySeconds !== undefined ? <span>recovered in {s.recoverySeconds}s</span> : null}
              </div>
              {s.detail ? <div className={cn('mt-1 text-[11px]', s.status === 'failed' ? 'text-rose-700 dark:text-rose-400' : 'text-content-muted')}>{s.detail}</div> : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/* ─────────────────────────── target pods ─────────────────────────── */

export function TargetPodsPanel({ rows, loading, error, title, note }: { rows?: TargetPodRow[]; loading: boolean; error?: Error | null; title: ReactNode; note?: ReactNode }) {
  const list = rows ?? []
  const ready = list.filter((r) => r.ready).length
  const restarts = list.reduce((a, r) => a + r.restarts, 0)
  return (
    <Panel
      title="Target pods"
      sub={title}
      right={list.length ? (
        <span className="text-[11px] tabular-nums text-content-muted">
          <span className={cn('font-semibold', ready < list.length ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-400')}>{ready}/{list.length}</span> ready
          {restarts ? <> · <span className="font-semibold text-orange-700 dark:text-orange-300">{restarts}</span> restarts</> : null}
        </span>
      ) : null}
    >
      {note ? <div className="text-[12px] text-content-muted">{note}</div> : loading ? (
        <div className="grid grid-cols-1 gap-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} height={30} />)}</div>
      ) : error ? (
        <div className="text-[12px] text-rose-600 dark:text-rose-400">The target&apos;s pods could not be read: {error.message}</div>
      ) : !list.length ? (
        <div className="text-[12px] text-content-subtle">No pod matches the target right now — a fault that deletes pods can briefly leave none.</div>
      ) : (
        <ul className="grid grid-cols-1 gap-1.5">
          {list.slice(0, 24).map((p) => (
            <li key={p.name} className="flex min-w-0 items-center gap-2 rounded-md border border-edge-default bg-surface-raised px-2.5 py-1.5">
              <span className={cn('size-2 shrink-0 rounded-full', p.ready ? 'bg-emerald-500' : p.state === 'Terminating' ? 'bg-amber-500' : 'bg-rose-500')} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-content" title={p.name}>{p.name}</span>
              <span className={cn('shrink-0 text-[10.5px]', p.ready ? 'text-content-subtle' : 'text-amber-700 dark:text-amber-300')}>{p.ready ? 'ready' : p.state}</span>
              {p.restarts ? <span className="shrink-0 text-[10.5px] font-medium text-orange-700 dark:text-orange-300" title={p.lastReason ? `last restart: ${p.lastReason}` : undefined}>↻{p.restarts}</span> : null}
            </li>
          ))}
          {list.length > 24 ? <li className="px-1 text-[11px] text-content-subtle">and {list.length - 24} more</li> : null}
        </ul>
      )}
    </Panel>
  )
}

export function Panel({ title, sub, right, children, className }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-edge-default bg-surface-raised p-3.5 sm:p-4', className)}>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-[12.5px] font-semibold text-content">{title}</h3>
        {sub ? <span className="min-w-0 truncate text-[11px] text-content-subtle">{sub}</span> : null}
        {right ? <span className="ml-auto">{right}</span> : null}
      </div>
      {children}
    </section>
  )
}

/* ─────────────────────────── probe ─────────────────────────── */

const PROBE_COLOR = { passed: 'bg-emerald-500', failed: 'bg-rose-500', awaited: 'bg-brand-400/60', na: 'bg-surface-sunken' } as const

export function ProbePanel({ samples, url, finalPct, active, now, hint }: { samples: ProbeSample[]; url?: string; finalPct?: number; active: boolean; now: number; hint?: ReactNode }) {
  const names = [...new Set(samples.flatMap((s) => Object.keys(s.probes)))]
  const start = samples[0]?.t
  const until = active ? now : samples[samples.length - 1]?.t ?? now
  const span = start ? Math.max(1, until - start) : 1
  return (
    <Panel
      title="Steady-state probe"
      sub={url ? <span className="font-mono text-[10.5px]">{url}</span> : undefined}
      right={finalPct !== undefined ? (
        <span className={cn('text-[12px] font-semibold tabular-nums', finalPct >= 100 ? 'text-emerald-700 dark:text-emerald-400' : finalPct >= 90 ? 'text-amber-700 dark:text-amber-300' : 'text-rose-700 dark:text-rose-400')}>{Number(finalPct.toFixed(1))}% succeeded</span>
      ) : null}
    >
      {!url && !names.length ? (
        <div className="text-[12px] text-content-muted">{hint ?? 'This run has no steady-state probe, so its verdict only says whether the fault ran — not whether the system kept serving.'}</div>
      ) : !names.length ? (
        <div className="text-[12px] text-content-subtle">{active ? 'Waiting for the runner to start the probe…' : 'The probe left no status on the result.'}</div>
      ) : (
        <div className="space-y-2">
          {names.map((n) => (
            <div key={n}>
              <div className="mb-1 flex justify-between text-[11px] text-content-muted"><span>{n}</span><span className="text-content-subtle">as observed while this page was open</span></div>
              <div className="flex h-3 overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={`Probe ${n} over time`}>
                {probeSegments(samples, n, until).map((seg, i) => (
                  <span key={i} className={cn('h-full', PROBE_COLOR[seg.verdict])} style={{ width: `${((seg.end - seg.start) / span) * 100}%` }} title={`${seg.verdict} · ${new Date(seg.start).toLocaleTimeString()}–${new Date(seg.end).toLocaleTimeString()}`} />
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-3 text-[10.5px] text-content-subtle">
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-emerald-500" />passing</span>
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-rose-500" />failing</span>
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-brand-400/60" />awaiting a result</span>
          </div>
        </div>
      )}
    </Panel>
  )
}

/* ─────────────────────────── metrics ─────────────────────────── */

export function LiveMetricsPanel({ namespace, podRegex, start, end, active, windows, now, unavailable }: {
  namespace?: string
  podRegex?: string
  start?: number
  end?: number
  active: boolean
  windows: PhaseWindow[]
  now: number
  /** Why metrics cannot be shown for this run at all (a node fault). */
  unavailable?: string
}) {
  const q = useLiveTargetMetrics({ namespace, podRegex, start, end, active })
  const data = q.data
  const domain: [number, number] | undefined = data ? [data.window.start, data.window.end] : undefined
  const bands = domain ? bandsFrom(windows, domain) : []
  const ids: MetricId[] = ['rps', 'errors', 'p95', 'ready', 'restarts', 'cpu', 'memory']
  return (
    <Panel
      title="Target metrics"
      sub={podRegex && namespace ? <span className="font-mono text-[10.5px]">{namespace} · pod=~{podRegex}</span> : undefined}
      right={data ? <BandLegend bands={bands} /> : null}
    >
      {unavailable ? (
        <div className="text-[12px] text-content-muted">{unavailable}</div>
      ) : !podRegex || !start ? (
        <div className="text-[12px] text-content-subtle">Metrics appear once the run has started and its target pods are known.</div>
      ) : q.isLoading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={150} />)}</div>
      ) : q.error ? (
        <EmptyState
          compact
          title={/not configured/.test((q.error as Error).message) ? 'No Prometheus for this console' : 'Metrics could not be read'}
          description={/not configured/.test((q.error as Error).message)
            ? 'Live metrics come from the console’s Prometheus (PROMETHEUS_URL or MIMIR_URL). Configure it and the request rate, errors, latency, pods and resources of the target show here, with the faults shaded.'
            : (q.error as Error).message}
        />
      ) : data ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {ids.map((id) => {
            const def = METRIC_DEFS.find((d) => d.id === id)!
            const s = data.series.find((x) => x.id === id)
            const miss = data.missing.find((x) => x.id === id)
            const last = s?.points[s.points.length - 1]?.[1]
            return (
              <div key={id} className="min-w-0 rounded-lg border border-edge-default p-2.5">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="truncate text-[11.5px] font-medium text-content" title={def.hint}>{def.label}</span>
                  <span className="shrink-0 font-mono text-[12px] font-semibold tabular-nums text-content">{s ? formatMetric(last, def.unit) : '—'}</span>
                </div>
                <ChaosChart
                  lines={s ? [{ name: def.label, points: s.points, color: METRIC_TOKEN[id] }] : []}
                  unit={def.unit}
                  domain={domain}
                  bands={bands}
                  height={110}
                  yMax={s ? yMaxFor(id, def.unit, s.points) : undefined}
                  now={active ? now : undefined}
                  emptyLabel={miss?.reason ?? 'No samples in the window'}
                />
              </div>
            )
          })}
        </div>
      ) : null}
    </Panel>
  )
}

/* ─────────────────────────── experiment drawer ─────────────────────────── */

/**
 * One experiment, live: the engine and its result polled every 3 s while it
 * runs, the target pods every 3 s, the metrics every 15 s. Stop, re-run and
 * delete are in the header, each asked of the user's own RBAC.
 */
export function ExperimentRunDrawer({ namespace = CHAOS_NAMESPACE, name, onClose, onOpenRun }: { namespace?: string; name: string; onClose(): void; onOpenRun(name: string): void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { cluster } = useChaosCluster()
  const eq = useChaosEngine(namespace, name)
  const engine = eq.data
  const live = engine ? !['passed', 'failed', 'stopped'].includes(phaseOf(engine)) : false
  const rq = useChaosResult(namespace, engine ? resultNameFor(engine) : undefined, live)
  const result = rq.data ?? undefined
  const fault = engine ? faultById(faultOf(engine)) : undefined
  const app = engine?.spec?.appinfo
  const [observed, setObserved] = useState<Observed>({})
  const over = engine ? ['passed', 'failed', 'stopped'].includes(phaseOf(engine)) || (engine.status?.engineStatus ?? '').toLowerCase() === 'completed' : false
  // Pods are watched closely until the target is whole again after the fault.
  const pods = useTargetPods({ namespace: app?.appns, selector: app?.applabel, live: !over || observed.recoveredAt === undefined, enabled: !!engine && !fault?.node })
  const all = useChaosEngines().all
  const targetReady = fault?.node ? undefined : pods.data ? pods.data.whole : undefined
  // Timers only for what this page actually watched: a run opened after it
  // ended has no observed fault end or recovery, and none is invented.
  const sawRunning = useRef(false)
  if (engine && !over) sawRunning.current = true
  useEffect(() => {
    if (!engine || !sawRunning.current) return
    setObserved((o) => observe(o, { live: isLive(engine), over, targetReady, now: Date.now() }))
  }, [engine, over, targetReady])
  // Readiness decides "still recovering" only for a run this page watched end;
  // an old run's target may be unready for reasons of its own.
  const watched = sawRunning.current
  const run = useMemo(() => (engine ? engineRun(engine, result, { now: Date.now(), targetReady: watched ? targetReady : undefined, observed }) : undefined), [engine, result, targetReady, observed, watched])
  const now = useNow(!!run?.active)
  const probes = useProbeTimeline(result, name)
  // The pod selector for metrics: fixed once known, so replacements a fault
  // causes do not churn the query.
  const regexRef = useRef<string | undefined>(undefined)
  if (!regexRef.current && pods.data?.raw.length) {
    regexRef.current = podRegexFromPods(pods.data.raw.map((p) => ({ name: p.metadata.name, templateHash: p.metadata.labels?.['pod-template-hash'] })))
  }

  const canStop = useCan(canResource(ENGINES_GVR, 'patch', { namespace, name }))
  const canDelete = useCan(canResource(ENGINES_GVR, 'delete', { namespace, name }))
  const canCreate = useCan(canResource(ENGINES_GVR, 'create', { namespace }))
  const [busy, setBusy] = useState<string | null>(null)
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['chaos'] })
  const act = async (what: string, f: () => Promise<unknown>, ok: string) => {
    setBusy(what)
    try {
      await f()
      toast.success(ok)
      invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const probe = engine?.spec?.experiments?.[0]?.spec?.probe?.[0] as { 'httpProbe/inputs'?: { url?: string } } | undefined
  const probeUrl = probe?.['httpProbe/inputs']?.url
  const pct = Number(result?.status?.experimentStatus?.probeSuccessPercentage)
  const env = engine ? envOf(engine) : {}

  const actions = engine ? (
    <>
      {canStop && live ? (
        <Button size="sm" variant="danger" disabled={busy !== null || phaseOf(engine) === 'recovering'} onClick={() => void act('stop', () => stopChaosEngine(namespace, name, cluster), 'Stopping — Litmus is recovering the fault')}>
          Stop
        </Button>
      ) : null}
      {canCreate ? (
        <Button
          size="sm"
          disabled={busy !== null || live}
          title={live ? 'Wait for this run to finish, or stop it, before running it again' : 'Run the same fault against the same target again'}
          onClick={() => {
            const next = rerunName(name, all.map((e) => e.metadata.name))
            void act('rerun', async () => {
              await applyChaosEngine(rerunManifest(engine, next), cluster)
              onOpenRun(next)
            }, `${next} launched`)
          }}
        >
          Re-run
        </Button>
      ) : null}
      {canDelete ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || isLive(engine)}
          title={isLive(engine) ? 'Stop the run first — deleting it now could leave the fault applied' : undefined}
          onClick={() => void act('delete', async () => {
            await deleteChaosEngine(engine, cluster)
            onClose()
          }, 'Run deleted')}
        >
          Delete
        </Button>
      ) : null}
    </>
  ) : null

  return (
    <ChaosDrawer
      widthKey="platform.chaos-run"
      eyebrow={fault ? `${FAMILY_LABEL[fault.family]} fault · ${fault.blast} blast radius` : 'Chaos experiment'}
      title={name}
      badge={run ? runBadge(run) : null}
      actions={actions}
      onClose={onClose}
    >
      {eq.isLoading ? (
        <div className="space-y-3 p-5"><Skeleton height={120} /><Skeleton height={180} /></div>
      ) : eq.gone ? (
        <div className="p-5"><EmptyState title="This run no longer exists" description="It was deleted — by someone else, or by the game day that created it once it finished. Its verdict is gone with it; suite runs keep theirs in Run reports." action={<Button variant="primary" onClick={onClose}>Close</Button>} /></div>
      ) : eq.error ? (
        <div className="p-5"><EmptyState title="The run could not be read" description={(eq.error as Error).message} action={<Button onClick={() => void eq.refetch()}>Try again</Button>} /></div>
      ) : engine && run ? (
        <div className="space-y-4 p-4 sm:p-5">
          <RunHero
            run={run}
            now={now}
            target={pods.data && !fault?.node ? { ready: pods.data.ready, total: pods.data.total } : undefined}
            recovery={{ since: observed.faultEndedAt, tookSeconds: observed.recoveredAt && observed.faultEndedAt ? Math.round((observed.recoveredAt - observed.faultEndedAt) / 1000) : undefined }}
          />
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl border border-edge-default bg-surface-raised p-3.5 text-[12px] sm:grid-cols-2">
            <Fact label="Fault">{fault?.label ?? faultOf(engine)} <span className="font-mono text-[11px] text-content-subtle">{faultOf(engine)}</span></Fact>
            <Fact label="Blast radius">{targetSummary(engine)}</Fact>
            <Fact label="Duration">{env.TOTAL_CHAOS_DURATION ? `${env.TOTAL_CHAOS_DURATION}s` : '—'}{env.CHAOS_INTERVAL ? ` · every ${env.CHAOS_INTERVAL}s` : ''}</Fact>
            <Fact label="Created">{engine.metadata.creationTimestamp ? formatAbsolute(engine.metadata.creationTimestamp) : '—'}</Fact>
          </dl>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Panel title="Steps"><StepList steps={run.steps} now={now} /></Panel>
            <div className="space-y-4">
              <TargetPodsPanel
                title={app ? `${app.appns}${app.applabel ? ` · ${app.applabel}` : ''}` : ''}
                rows={pods.data?.rows}
                loading={pods.isLoading}
                error={pods.error as Error | null}
                note={fault?.node ? `A node fault: it targets ${targetSummary(engine)}, so every pod on that node is affected, whichever team owns it.` : undefined}
              />
              <ProbePanel samples={probes} url={probeUrl} finalPct={Number.isFinite(pct) && result?.status?.experimentStatus?.probeSuccessPercentage !== '' ? pct : undefined} active={run.active} now={now} />
            </div>
          </div>
          <LiveMetricsPanel
            namespace={app?.appns}
            podRegex={regexRef.current}
            start={run.startedAt}
            end={run.finishedAt}
            active={run.active}
            windows={run.windows}
            now={now}
            unavailable={fault?.node ? 'Node faults affect every workload on the node; open the node in Platform → Nodes for its metrics.' : undefined}
          />
        </div>
      ) : null}
    </ChaosDrawer>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-content-subtle">{label}</dt>
      <dd className="m-0 truncate text-content">{children}</dd>
    </div>
  )
}

/* ─────────────────────────── suite run drawer ─────────────────────────── */

/**
 * One application's suite run (a resilience-runner gate Job), live: the
 * runner's timestamped log parsed into phases every 5 s, the app's pods, and
 * its metrics with the load test and each fault shaded.
 */
export function SuiteRunDrawer({ run, faults, onClose, onViewLog }: { run: ResilienceRun; faults: Array<{ name: string; hypothesis?: string }>; onClose(): void; onViewLog(): void }) {
  const phase = runPhase(run.status)
  const active = phase === 'running' || phase === 'pending'
  const tl = useRunTimeline(run.job, run.app, active)
  const model = useMemo(
    () => suiteRun({ faults, timeline: tl.data, job: { startTime: run.startTime, completionTime: run.completionTime, phase } }),
    [faults, tl.data, run.startTime, run.completionTime, phase],
  )
  const now = useNow(model.active)
  const podRegex = podRegexForApp(run.app)
  const pods = useTargetPods({ namespace: run.namespace, live: active })
  const rows = useMemo(() => {
    const re = new RegExp(`^${podRegex}$`)
    return pods.data?.rows.filter((r) => re.test(r.name))
  }, [pods.data, podRegex])
  const ready = rows?.filter((r) => r.ready).length
  return (
    <ChaosDrawer
      widthKey="platform.chaos-suite-run"
      eyebrow={`Resilience suite · ${run.environment}`}
      title={run.app}
      badge={runBadge(model)}
      actions={<Button size="sm" onClick={onViewLog}>{active ? 'Follow log' : 'View log'}</Button>}
      onClose={onClose}
    >
      <div className="space-y-4 p-4 sm:p-5">
        <RunHero run={model} now={now} target={rows ? { ready, total: rows.length } : undefined} />
        {tl.error ? <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">The runner&apos;s log could not be read ({(tl.error as Error).message}), so the steps below show only what the Job reports.</div> : null}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="Steps" sub={`Job ${run.job}`}><StepList steps={model.steps} now={now} /></Panel>
          <div className="space-y-4">
            <TargetPodsPanel title={`${run.namespace} · ${run.app}`} rows={rows} loading={pods.isLoading} error={pods.error as Error | null} />
            <ProbePanel
              samples={[]}
              url={undefined}
              active={model.active}
              now={now}
              hint={<>The runner probes the application continuously through every fault and records the share of polls that succeeded per fault — shown on each step as it finishes{model.steps.some((s) => s.probeSuccessPercentage !== undefined) ? '' : ' (none finished yet)'}.</>}
            />
          </div>
        </div>
        <LiveMetricsPanel namespace={run.namespace} podRegex={podRegex} start={model.startedAt} end={model.finishedAt} active={model.active} windows={model.windows} now={now} />
      </div>
    </ChaosDrawer>
  )
}
