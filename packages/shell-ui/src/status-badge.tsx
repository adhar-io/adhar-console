import { cn } from '@adhar/utils'

export type StatusKind =
  | 'healthy'
  | 'degraded'
  | 'progressing'
  | 'paused'
  | 'failed'
  | 'unknown'
  | 'info'

const PILL: Record<StatusKind, string> = {
  healthy:
    'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25',
  degraded:
    'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/25',
  progressing:
    'bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/25',
  paused:
    'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25',
  failed:
    'bg-rose-100 text-rose-800 ring-rose-600/30 dark:bg-rose-500/15 dark:text-rose-200 dark:ring-rose-400/30',
  // Theme tokens, not slate: the console remaps the slate ramp in dark mode,
  // which turned this pill's text dark-on-dark.
  unknown: 'bg-surface-sunken text-content-muted ring-edge-default',
  info: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/25',
}

const DOT: Record<StatusKind, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-rose-500',
  progressing: 'bg-indigo-500',
  paused: 'bg-amber-500',
  failed: 'bg-rose-600',
  unknown: 'bg-content-subtle',
  info: 'bg-sky-500',
}

/** The mark's own colour — a step stronger than the pill text so the shape reads. */
const MARK: Record<StatusKind, string> = {
  healthy: 'text-emerald-600 dark:text-emerald-400',
  degraded: 'text-rose-600 dark:text-rose-400',
  progressing: 'text-indigo-600 dark:text-indigo-400',
  paused: 'text-amber-600 dark:text-amber-400',
  failed: 'text-rose-700 dark:text-rose-300',
  unknown: 'text-content-subtle',
  info: 'text-sky-600 dark:text-sky-400',
}

interface Props {
  kind: StatusKind
  children: React.ReactNode
  /** Show the leading status mark. Defaults to true. Set to false for compact contexts. */
  dot?: boolean
  /** `progressing` kinds animate the dot by default. Set false to disable. */
  pulse?: boolean
  className?: string
}

/**
 * A status pill: colour, a SHAPE per kind, and the label.
 *
 * The leading mark used to be the same 6px dot for every kind, so "Healthy"
 * and "Degraded" differed only by green against red — the one pair of colours
 * the most common colour-vision deficiency cannot tell apart. Each kind now
 * has its own glyph (check, warning, cross, pause, ring …) so the state reads
 * from the shape too; the label still says it in words.
 */
export function StatusBadge({ kind, children, dot = true, pulse, className }: Props) {
  const shouldPulse = pulse ?? kind === 'progressing'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        PILL[kind],
        className,
      )}
    >
      {dot ? <StatusMark kind={kind} pulse={shouldPulse} /> : null}
      {children}
    </span>
  )
}

function StatusMark({ kind, pulse }: { kind: StatusKind; pulse: boolean }) {
  // In-progress states keep a (pulsing) dot: motion is their signal, and a
  // spinner in every row of a busy table is noise.
  if (pulse || kind === 'progressing' || kind === 'info') {
    return (
      <span aria-hidden className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
        <span className={cn('h-1.5 w-1.5 rounded-full', DOT[kind], pulse && 'animate-pulse')} />
      </span>
    )
  }
  const common = {
    width: 10,
    height: 10,
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: cn('shrink-0', MARK[kind]),
  }
  switch (kind) {
    case 'healthy':
      return <svg {...common}><path d="M2.5 6.3 5 8.8l4.5-5.3" /></svg>
    case 'degraded':
      return <svg {...common}><path d="M6 1.8 10.8 10H1.2Z" /><path d="M6 5.2v1.8" /><path d="M6 8.6h.01" strokeWidth={2.2} /></svg>
    case 'failed':
      return <svg {...common}><path d="M3 3l6 6M9 3 3 9" strokeWidth={2} /></svg>
    case 'paused':
      return <svg {...common}><path d="M4.2 2.8v6.4M7.8 2.8v6.4" strokeWidth={2} /></svg>
    default:
      return <svg {...common}><circle cx="6" cy="6" r="3.6" strokeDasharray="2 1.6" /></svg>
  }
}
