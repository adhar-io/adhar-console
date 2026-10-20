import type { MouseEvent, ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { Select, TeamScopeBar } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { type Band, BAND_LABEL } from '../data/dora-model.ts'
import type { SourceStatus } from '../data/dora.ts'
import { useSetDecideParams } from '../data/params.ts'
import type { DecideScope } from '../data/scope.ts'

/** An in-app link: a real href (copy / middle-click work), router navigation on a plain click. */
export function DLink({ href, className, children, title }: { href: string; className?: string; children: ReactNode; title?: string }) {
  const router = useRouter({ warn: false })
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (!router?.history) return
    e.preventDefault()
    router.history.push(href)
  }
  return (
    <a href={href} onClick={onClick} className={className} title={title}>
      {children}
    </a>
  )
}

/* ─────────── bands ─────────── */

const BAND_TONE: Record<Band, string> = {
  elite: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25',
  high: 'bg-sky-50 text-sky-800 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/25',
  medium: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25',
  low: 'bg-rose-50 text-rose-800 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/25',
}

function BandGlyph({ band }: { band: Band }) {
  const p = band === 'elite'
    ? 'M2 7 L5 4 L8 7 M2 10 L5 7 L8 10'
    : band === 'high'
    ? 'M2 8 L5 5 L8 8'
    : band === 'medium'
    ? 'M2 6 H8'
    : 'M2 5 L5 8 L8 5'
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden>
      <path d={p} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function BandBadge({ band, className }: { band: Band | null; className?: string }) {
  if (!band) {
    return (
      <span className={cn('inline-flex items-center rounded-md bg-surface-sunken px-1.5 py-0.5 text-[11px] font-medium text-content-subtle ring-1 ring-inset ring-edge-subtle', className)}>
        No band
      </span>
    )
  }
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset', BAND_TONE[band], className)}>
      <BandGlyph band={band} />
      {BAND_LABEL[band]}
    </span>
  )
}

/* ─────────── status (reserved hues, always icon + label) ─────────── */

export type Tone = 'good' | 'warn' | 'bad' | 'neutral'

const TONE: Record<Tone, string> = {
  good: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  bad: 'text-rose-700 dark:text-rose-300',
  neutral: 'text-content-muted',
}

export function StatusText({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  const icon = tone === 'good' ? '✓' : tone === 'warn' ? '!' : tone === 'bad' ? '✕' : '·'
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', TONE[tone], className)}>
      <span aria-hidden className="inline-flex size-3.5 items-center justify-center rounded-full ring-1 ring-current text-[9px] leading-none">{icon}</span>
      {children}
    </span>
  )
}

/** Change vs the previous period; `goodWhenUp` decides which direction is good. */
export function Delta({ current, previous, goodWhenUp, format, className }: {
  current: number | null
  previous: number | null
  goodWhenUp: boolean
  format?(diff: number, pct: number | null): string
  className?: string
}) {
  if (current == null || previous == null) return <span className={cn('text-[11px] text-content-subtle', className)}>no prior period</span>
  const diff = current - previous
  if (Math.abs(diff) < 1e-9) return <span className={cn('text-[11px] text-content-subtle', className)}>flat vs prior</span>
  const pct = previous ? diff / Math.abs(previous) : null
  const good = diff > 0 === goodWhenUp
  const text = format ? format(diff, pct) : pct == null ? 'new' : `${diff > 0 ? '+' : '−'}${Math.abs(pct * 100).toFixed(0)}%`
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums', good ? TONE.good : TONE.bad, className)}>
      <span aria-hidden>{diff > 0 ? '↑' : '↓'}</span>
      {text}
      <span className="ml-1 font-normal text-content-subtle">vs prior</span>
    </span>
  )
}

/* ─────────── layout pieces ─────────── */

export function SectionHeader({ title, href, linkLabel, children }: { title: string; href?: string; linkLabel?: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-content">{title}</h2>
      <div className="flex items-center gap-3">
        {children}
        {href
          ? (
            <DLink href={href} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
              {linkLabel ?? 'Details'} →
            </DLink>
          )
          : null}
      </div>
    </div>
  )
}

export function Panel({ title, sub, actions, children, className }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-xl border border-edge-default bg-surface-raised p-4', className)}>
      {title || actions
        ? (
          <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="min-w-[min(100%,16rem)] flex-1">
              {title ? <h3 className="text-sm font-semibold text-content">{title}</h3> : null}
              {sub ? <p className="mt-0.5 text-xs text-content-subtle">{sub}</p> : null}
            </div>
            {actions ? <div className="flex max-w-full flex-wrap items-center gap-2 overflow-x-auto">{actions}</div> : null}
          </div>
        )
        : null}
      {children}
    </section>
  )
}

/** A metric tile; the whole tile links to its detail view. */
export function Tile({ label, value, unit, sub, badge, footer, href, spark, className }: {
  label: string
  value: ReactNode
  unit?: string
  sub?: ReactNode
  badge?: ReactNode
  footer?: ReactNode
  href?: string
  spark?: ReactNode
  className?: string
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-content-muted">{label}</div>
        {badge}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums tracking-tight text-content">{value}</span>
        {unit ? <span className="text-xs text-content-subtle">{unit}</span> : null}
      </div>
      {sub ? <div className="mt-0.5 text-[11px] text-content-subtle">{sub}</div> : null}
      {spark ? <div className="mt-2">{spark}</div> : null}
      {footer ? <div className="mt-2">{footer}</div> : null}
    </>
  )
  const cls = cn('block min-w-0 rounded-xl border border-edge-default bg-surface-raised p-4', className)
  return href
    ? <DLink href={href} className={cn(cls, 'transition-colors hover:border-edge-strong hover:bg-surface-sunken/40')}>{body}</DLink>
    : <div className={cls}>{body}</div>
}

/** "Source missing" note naming the tool. */
export function SourceNote({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' }) {
  return (
    <div className={cn('rounded-lg border border-dashed px-3 py-2.5 text-xs', tone === 'warn' ? 'border-amber-400/60 text-content-muted' : 'border-edge-default text-content-subtle')}>
      {children}
    </div>
  )
}

export function SourceChips({ sources }: { sources: SourceStatus[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {sources.map((s) => (
        <li
          key={s.id}
          title={s.detail}
          className="inline-flex items-center gap-1.5 rounded-full border border-edge-default px-2 py-0.5 text-[11px] text-content-muted"
        >
          <span
            aria-hidden
            className={cn(
              'size-1.5 rounded-full',
              s.state === 'ok' ? 'bg-emerald-500' : s.state === 'empty' || s.state === 'loading' ? 'bg-slate-400' : s.state === 'missing' ? 'bg-amber-500' : 'bg-rose-500',
            )}
          />
          {s.label}
          <span className="text-content-subtle">
            {s.state === 'ok' ? 'connected' : s.state === 'empty' ? 'no data' : s.state === 'missing' ? 'not installed' : s.state === 'loading' ? '…' : 'unreachable'}
          </span>
        </li>
      ))}
    </ul>
  )
}

/* ─────────── scope row ─────────── */

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: ReadonlyArray<{ id: T; label: string }>
  onChange(v: T): void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full overflow-x-auto rounded-lg border border-edge-default bg-surface-raised p-0.5 [scrollbar-width:none]">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          onClick={() => onChange(o.id)}
          className={cn(
            'shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            o.id === value ? 'bg-surface-sunken text-content shadow-sm' : 'text-content-muted hover:text-content',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Time range + scope in one row above the content. The team lens is the
 * console's; the project filter narrows it and lives in the URL.
 */
export function ScopeRow({ scope, ranges, range, onRange, children }: {
  scope: DecideScope
  ranges: ReadonlyArray<{ id: string; label: string }>
  range: string
  onRange(id: string): void
  children?: ReactNode
}) {
  const set = useSetDecideParams()
  const options = [
    { value: '', label: scope.filtering ? `All ${scope.team} projects` : 'All projects' },
    ...scope.projects.map((p) => ({ value: p.slug, label: p.name || p.slug })),
  ]
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={range} options={ranges} onChange={onRange} label="Time range" />
        <Select
          aria-label="Project"
          value={scope.project}
          onChange={(e) => set({ project: e.target.value })}
          options={options}
          wrapperClassName="min-w-0 w-full sm:w-56"
          className="h-8 text-xs"
        />
        {children}
      </div>
      <TeamScopeBar team={scope.team} shown={scope.projects.length} total={scope.total} noun="projects" />
    </div>
  )
}

/** Copy the current URL (every view's state lives in it) and say so with a toast. */
export function copyLink(toast: { success(t: ReactNode): unknown; error(t: ReactNode): unknown }): void {
  const href = typeof location === 'undefined' ? '' : location.href
  const done = () => toast.success('Link copied — it opens this exact view')
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(href).then(done, () => toast.error('Could not copy the link'))
  } else {
    toast.error('Clipboard is not available here')
  }
}
