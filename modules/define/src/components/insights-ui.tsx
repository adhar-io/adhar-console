import type { ReactNode } from 'react'
import { Select, Spinner, StatusBadge } from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import { type ErrorKind } from '../data/insights-data.ts'
import { type Group, GROUP_LABEL, isOverdue, type WorkItem } from '../data/insights-math.ts'
import { MUTED, useSeriesColor } from './insights-viz.tsx'

/** Shared bits for the dashboard, My Work and Reports. */

/** State-group colours: grey backlog, then the categorical slots in order. */
export function useGroupColor(): (g: Group) => string {
  const c = useSeriesColor()
  return (g) => (g === 'backlog' ? MUTED : g === 'unstarted' ? c(0) : g === 'started' ? c(1) : g === 'completed' ? c(2) : c(3))
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('flex min-w-0 flex-col rounded-xl border border-edge-default bg-surface-raised shadow-sm', className)}>
      <header className="flex items-start justify-between gap-3 border-b border-edge-subtle px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-content">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-[11px] text-content-subtle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      <div className={cn('min-w-0 flex-1 p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

export function Stat({ label, value, hint, onClick, tone }: { label: string; value: ReactNode; hint?: ReactNode; onClick?(): void; tone?: 'warn' | 'bad' }) {
  const body = (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums tracking-tight text-content', tone === 'bad' && 'text-rose-700 dark:text-rose-300', tone === 'warn' && 'text-amber-700 dark:text-amber-300')}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-content-muted">{hint}</div> : null}
    </>
  )
  return onClick
    ? (
      <button type="button" onClick={onClick} className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3 text-left transition-colors hover:border-edge-strong hover:bg-surface-sunken">
        {body}
      </button>
    )
    : <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">{body}</div>
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-3 text-[12px] text-content-muted">
      <Spinner size={12} /> {label}
    </div>
  )
}

const KIND_TITLE: Record<ErrorKind, string> = {
  rate: 'Plane is rate-limiting the console',
  permission: 'No permission',
  'not-configured': 'Not configured',
  store: 'Console database not configured',
  other: 'Could not load',
}

/** An honest inline state for a failed source. */
export function SourceNote({ kind, message, compact }: { kind: ErrorKind; message: string; compact?: boolean }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2 text-[12px]', kind === 'rate' ? 'border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200' : 'border-edge-default bg-surface-sunken/60 text-content-muted')}>
      <span className="font-semibold">{KIND_TITLE[kind]}.</span>
      {compact ? null : kind === 'rate' ? <> The console shares one Plane API key (60 requests a minute); data refreshes on its own once the minute passes.</> : <> {message}</>}
    </div>
  )
}

/** A short provenance line under a chart. */
export function Provenance({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[11px] leading-relaxed text-content-subtle">{children}</p>
}

export function ConsoleSideBadge({ label = 'Console-side' }: { label?: string }) {
  return (
    <span title="Stored in the console's database — Plane's API has no place for this data." className="inline-flex items-center rounded-full border border-edge-default bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-content-muted">
      {label}
    </span>
  )
}

const PRIORITY_DOT: Record<string, string> = {
  urgent: 'bg-rose-500',
  high: 'bg-orange-500',
  medium: 'bg-amber-400',
  low: 'bg-sky-400',
  none: 'bg-slate-300 dark:bg-slate-600',
}

export function PriorityMark({ p }: { p: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-content-muted" title={`Priority: ${p}`}>
      <span className={cn('inline-block size-1.5 rounded-full', PRIORITY_DOT[p] ?? PRIORITY_DOT.none)} />
      <span className="capitalize">{p === 'none' ? 'No priority' : p}</span>
    </span>
  )
}

const GROUP_KIND: Record<Group, 'unknown' | 'info' | 'progressing' | 'healthy' | 'failed'> = {
  backlog: 'unknown',
  unstarted: 'info',
  started: 'progressing',
  completed: 'healthy',
  cancelled: 'failed',
}

export function StateChip({ group, name }: { group: Group; name?: string }) {
  return <StatusBadge kind={GROUP_KIND[group]}>{name ?? GROUP_LABEL[group]}</StatusBadge>
}

/** One compact work-item row: key, title, state, priority, due. */
export function ItemRow({
  item,
  stateName,
  now,
  onOpen,
  trailing,
}: {
  item: WorkItem
  stateName?: string
  now: number
  onOpen?(): void
  trailing?: ReactNode
}) {
  const overdue = isOverdue(item, now)
  return (
    <li className="flex items-center gap-2 py-2">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {item.key ? <span className="shrink-0 font-mono text-[10px] font-semibold text-content-subtle">{item.key}</span> : null}
        <span className="min-w-0 flex-1 truncate text-[13px] text-content hover:underline">{item.name}</span>
      </button>
      <span className="hidden shrink-0 sm:inline"><PriorityMark p={item.priority} /></span>
      {item.targetDate
        ? <span className={cn('hidden shrink-0 text-[11px] tabular-nums sm:inline', overdue ? 'font-medium text-rose-700 dark:text-rose-300' : 'text-content-subtle')}>{overdue ? 'Overdue · ' : 'Due '}{item.targetDate}</span>
        : null}
      <span className="shrink-0"><StateChip group={item.group} name={stateName} /></span>
      {trailing}
    </li>
  )
}

export function UpdatedAgo({ at, fetching }: { at: number; fetching?: boolean }) {
  if (!at) return null
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-content-subtle">
      {fetching ? <Spinner size={10} /> : null}
      Updated {formatRelative(at)}
    </span>
  )
}

export function MiniSelect<T extends string>({ value, onChange, options, label, className }: { value: T; onChange(v: T): void; options: Array<{ value: T; label: string }>; label: string; className?: string }) {
  return (
    <label className={cn('inline-flex items-center gap-1.5 text-[11px] text-content-subtle', className)}>
      <span className="sr-only sm:not-sr-only">{label}</span>
      <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} options={options} className="h-8 py-1 text-[12px]" />
    </label>
  )
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase()
}

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span title={name} className="inline-flex shrink-0 items-center justify-center rounded-full bg-brand-50 font-semibold text-brand-700 ring-1 ring-inset ring-brand-200 dark:bg-brand-500/15 dark:text-brand-200 dark:ring-brand-500/30" style={{ width: size, height: size, fontSize: Math.max(9, size * 0.42) }}>
      {initials(name)}
    </span>
  )
}
