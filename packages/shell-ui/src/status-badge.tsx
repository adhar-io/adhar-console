import { cn } from '@adhar-console/utils'

export type StatusKind =
  | 'healthy'
  | 'degraded'
  | 'progressing'
  | 'paused'
  | 'failed'
  | 'unknown'
  | 'info'

const PILL: Record<StatusKind, string> = {
  healthy: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  degraded: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  progressing: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  paused: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  failed: 'bg-rose-100 text-rose-800 ring-rose-600/30',
  unknown: 'bg-slate-100 text-slate-700 ring-slate-600/20',
  info: 'bg-sky-50 text-sky-700 ring-sky-600/20',
}

const DOT: Record<StatusKind, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-rose-500',
  progressing: 'bg-indigo-500',
  paused: 'bg-amber-500',
  failed: 'bg-rose-600',
  unknown: 'bg-slate-400',
  info: 'bg-sky-500',
}

interface Props {
  kind: StatusKind
  children: React.ReactNode
  /** Show a leading dot. Defaults to true. Set to false for compact contexts. */
  dot?: boolean
  /** `progressing` kinds animate the dot by default. Set false to disable. */
  pulse?: boolean
  className?: string
}

export function StatusBadge({ kind, children, dot = true, pulse, className }: Props) {
  const shouldPulse = pulse ?? kind === 'progressing'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        PILL[kind],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            DOT[kind],
            shouldPulse && 'animate-pulse',
          )}
        />
      ) : null}
      {children}
    </span>
  )
}
