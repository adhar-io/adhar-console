import { type ReactNode } from 'react'
import { Button, Modal, StatusBadge, type StatusKind } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { RolloutPhase, RolloutView } from '../data/rollout-state.ts'
import type { HistoryOutcome } from '../data/rollout-history.ts'
import { OUTCOME_LABEL } from '../data/rollout-history.ts'

/**
 * Building blocks of the Rollouts page — status pills (icon + label, never
 * colour alone), the replica / traffic bars and the step ladder of the
 * current rollout, the summary tile and the confirm dialog.
 */

/* ─────────── icons ─────────── */

type IconProps = { className?: string }
const svg = (path: ReactNode) => ({ className }: IconProps) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={cn('h-3.5 w-3.5 shrink-0', className)}
  >
    {path}
  </svg>
)

export const IconCheck = svg(<path d="M3.5 8.5l3 3 6-7" />)
export const IconPause = svg(<><path d="M6 4v8" /><path d="M10 4v8" /></>)
export const IconProgress = svg(<><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 3v2.5h-2.5" /></>)
export const IconAlert = svg(<><path d="M8 2.5l6 10.5H2z" /><path d="M8 7v2.5" /><path d="M8 11.6v.1" /></>)
export const IconStop = svg(<><circle cx="8" cy="8" r="5.5" /><path d="M6 6l4 4M10 6l-4 4" /></>)
export const IconUnknown = svg(<><circle cx="8" cy="8" r="5.5" /><path d="M6.6 6.4a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9v.3" /><path d="M8 11.2v.1" /></>)
export const IconHistory = svg(<><path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7" /><path d="M2.5 2.5v2.5H5" /><path d="M8 5.5V8l1.8 1.2" /></>)
export const IconClose = svg(<path d="M4 4l8 8M12 4l-8 8" />)
export const IconLink = svg(<><path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.6.6" /><path d="M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.6-.6" /></>)
export const IconChevron = svg(<path d="M6 4l4 4-4 4" />)
export const IconCopy = svg(<><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7" /></>)
export const IconRollback = svg(<><path d="M4.5 6.5H10a3 3 0 0 1 0 6H7" /><path d="M6.5 4.5l-2 2 2 2" /></>)

/* ─────────── status pills ─────────── */

export const PHASE_KIND: Record<RolloutPhase, StatusKind> = {
  Healthy: 'healthy',
  Progressing: 'progressing',
  Degraded: 'degraded',
  Paused: 'paused',
  Unknown: 'unknown',
}

const PHASE_ICON: Record<RolloutPhase, (p: IconProps) => ReactNode> = {
  Healthy: IconCheck,
  Progressing: IconProgress,
  Degraded: IconAlert,
  Paused: IconPause,
  Unknown: IconUnknown,
}

/**
 * Neutral pill. StatusBadge's `unknown` kind uses the slate ramp, which the
 * console inverts in dark mode — its text goes dark-on-dark there.
 */
function NeutralPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md bg-surface-sunken px-2 py-0.5 text-xs font-medium text-content-muted ring-1 ring-inset ring-edge-default',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** A Rollout's state: Aborted wins over the phase it causes. */
export function PhasePill({ phase, aborted, className }: { phase: RolloutPhase; aborted?: boolean; className?: string }) {
  if (aborted) {
    return (
      <StatusBadge kind="failed" dot={false} className={className}>
        <IconStop /> Aborted
      </StatusBadge>
    )
  }
  const Icon = PHASE_ICON[phase] ?? IconUnknown
  if (!PHASE_KIND[phase] || phase === 'Unknown') {
    return <NeutralPill className={className}><IconUnknown /> {phase || 'Unknown'}</NeutralPill>
  }
  return (
    <StatusBadge kind={PHASE_KIND[phase] ?? 'unknown'} dot={false} className={className}>
      <Icon className={phase === 'Progressing' ? 'motion-safe:animate-spin [animation-duration:2.4s]' : undefined} /> {phase}
    </StatusBadge>
  )
}

export const OUTCOME_KIND: Record<HistoryOutcome, StatusKind> = {
  live: 'healthy',
  'in-flight': 'progressing',
  stable: 'info',
  superseded: 'unknown',
  aborted: 'failed',
  degraded: 'degraded',
}

const OUTCOME_ICON: Record<HistoryOutcome, (p: IconProps) => ReactNode> = {
  live: IconCheck,
  'in-flight': IconProgress,
  stable: IconCheck,
  superseded: IconHistory,
  aborted: IconStop,
  degraded: IconAlert,
}

export function OutcomePill({ outcome }: { outcome: HistoryOutcome }) {
  const Icon = OUTCOME_ICON[outcome]
  if (OUTCOME_KIND[outcome] === 'unknown') return <NeutralPill><Icon /> {OUTCOME_LABEL[outcome]}</NeutralPill>
  return (
    <StatusBadge kind={OUTCOME_KIND[outcome]} dot={false}>
      <Icon /> {OUTCOME_LABEL[outcome]}
    </StatusBadge>
  )
}

const ANALYSIS_KIND: Record<string, StatusKind> = {
  Successful: 'healthy',
  Running: 'progressing',
  Pending: 'unknown',
  Inconclusive: 'paused',
  Failed: 'failed',
  Error: 'degraded',
}

export function AnalysisPill({ phase }: { phase: string }) {
  const kind = ANALYSIS_KIND[phase] ?? 'unknown'
  const Icon = kind === 'healthy'
    ? IconCheck
    : kind === 'progressing'
    ? IconProgress
    : kind === 'failed'
    ? IconStop
    : kind === 'degraded' || kind === 'paused'
    ? IconAlert
    : IconUnknown
  if (kind === 'unknown') return <NeutralPill><Icon /> {phase}</NeutralPill>
  return (
    <StatusBadge kind={kind} dot={false}>
      <Icon /> {phase}
    </StatusBadge>
  )
}

export function strategyLabel(s: string): string {
  return s === 'canary' ? 'Canary' : s === 'blueGreen' ? 'Blue/green' : s === 'mixed' ? 'Mixed strategies' : 'No strategy'
}

/* ─────────── the current rollout ─────────── */

/**
 * How far the new version has actually got. A phase of Progressing says
 * nothing about whether two replicas or twenty have been replaced.
 */
export function ReplicaBar({ replicas: p }: { replicas: RolloutView['replicas'] }) {
  const desired = Math.max(p.desired, p.current, 1)
  const pct = (n: number) => `${Math.min(100, (n / desired) * 100)}%`
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]">
        <span className="font-semibold text-content-subtle">Replicas</span>
        <span className="font-mono tabular-nums text-content-muted">
          {p.updated}/{p.desired} updated · {p.available} available
        </span>
      </div>
      <div
        className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`${p.updated} of ${p.desired} replicas updated, ${p.ready} ready, ${p.available} available`}
      >
        <span className="h-full bg-emerald-500" style={{ width: pct(Math.min(p.updated, p.available)) }} />
        <span className="h-full bg-indigo-400" style={{ width: pct(Math.max(0, p.updated - p.available)) }} />
      </div>
    </div>
  )
}

/** The split the canary is actually taking right now. */
export function TrafficSplit({ weights }: { weights: { canary: number; stable: number } }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[11px]">
        <span className="font-semibold text-content-subtle">Traffic</span>
        <span className="font-mono tabular-nums text-content-muted">
          {weights.canary}% canary · {weights.stable}% stable
        </span>
      </div>
      <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-surface-sunken" role="img" aria-label={`${weights.canary}% of traffic on the canary`}>
        <span className="h-full bg-brand-500" style={{ width: `${weights.canary}%` }} />
        <span className="h-full bg-edge-strong" style={{ width: `${weights.stable}%` }} />
      </div>
    </div>
  )
}

/** Every canary step, the current one marked. Scrolls inside itself on a phone. */
export function StepLadder({ rollout: r }: { rollout: RolloutView }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="font-semibold text-content-subtle">Canary steps</span>
        <span className="font-mono tabular-nums text-content-muted">
          {Math.min(r.currentStep + 1, r.totalSteps)} / {r.totalSteps}
        </span>
      </div>
      <ol className="mt-1.5 flex gap-1 overflow-x-auto pb-1">
        {r.steps.map((s, i) => {
          const paused = s.state === 'current' && r.phase === 'Paused'
          return (
            <li
              key={i}
              title={s.label}
              aria-current={s.state === 'current' ? 'step' : undefined}
              className={cn(
                'flex min-w-26 flex-1 flex-col rounded-md border p-2',
                s.state === 'current'
                  ? paused
                    ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10'
                    : 'border-brand-400 bg-brand-50 dark:border-brand-500/40 dark:bg-brand-500/10'
                  : s.state === 'done'
                  ? 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-500/30 dark:bg-emerald-500/10'
                  : 'border-edge-subtle bg-surface-sunken/40',
              )}
            >
              <span className="flex items-center gap-1 font-mono text-[10px] text-content-subtle">
                {s.state === 'done'
                  ? <IconCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  : s.state === 'current'
                  ? paused
                    ? <IconPause className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                    : <IconProgress className="h-3 w-3 text-brand-600 dark:text-brand-300" />
                  : <span className="h-1.5 w-1.5 rounded-full bg-content-subtle/60" />}
                step {i + 1}
              </span>
              <span className="mt-1 truncate text-[11px] font-medium text-content">{s.label}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function Note({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn' | 'error'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 text-[11px] leading-relaxed',
        tone === 'warn'
          ? 'border-amber-200/70 bg-amber-50/60 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
          : tone === 'error'
          ? 'border-rose-200/70 bg-rose-50/60 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
          : 'border-edge-subtle bg-surface-sunken/40 text-content-muted',
      )}
    >
      {children}
    </div>
  )
}

/* ─────────── summary tile ─────────── */

const TONE_TEXT: Partial<Record<StatusKind, string>> = {
  healthy: 'text-emerald-600 dark:text-emerald-300',
  degraded: 'text-rose-600 dark:text-rose-300',
  failed: 'text-rose-600 dark:text-rose-300',
  paused: 'text-amber-600 dark:text-amber-300',
  progressing: 'text-indigo-600 dark:text-indigo-300',
}

export function Stat({
  label,
  value,
  hint,
  tone,
  active,
  onClick,
}: {
  label: string
  value: number | string
  hint?: string
  tone?: StatusKind
  active?: boolean
  onClick?(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? Boolean(active) : undefined}
      className={cn(
        'min-w-0 rounded-xl border px-3.5 py-3 text-left transition-colors',
        active
          ? 'border-brand-300 bg-brand-50/70 dark:border-brand-500/40 dark:bg-brand-500/10'
          : 'border-edge-default bg-surface-raised',
        onClick ? 'hover:border-edge-strong' : 'cursor-default',
      )}
    >
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold leading-none tabular-nums', tone ? TONE_TEXT[tone] ?? 'text-content' : 'text-content')}>
        {value}
      </div>
      {hint ? <div className="mt-1 truncate text-[11px] text-content-subtle">{hint}</div> : null}
    </button>
  )
}

/* ─────────── confirm ─────────── */

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm(): void
  onClose(): void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-content-muted">{children}</div>
    </Modal>
  )
}
