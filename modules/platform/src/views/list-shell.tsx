import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'
import { Spinner } from '@adhar-console/shell-ui'

/**
 * Headlamp-style toolbar wrapping any resource list. Provides:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ [Title]  N visible / M total          [search] [filters] [refresh]│
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ <DataTable> (or any list body)                                   │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * - `search` is controlled — the parent owns the value.
 * - `filters` is a slot for status pills (or any inline filter UI).
 * - `lastUpdatedAt` produces a live "updated 5s ago" chip.
 * - `onRefresh` shows a manual refresh button next to the chip; while a
 *   refetch is in flight, the spinner replaces the icon.
 */
export interface ListShellProps {
  title?: string
  /** Total count of rows in the underlying dataset (pre-filter). */
  total: number
  /** Visible count after filters/search are applied. */
  visible?: number
  loading?: boolean
  /** True while a background refetch is happening. */
  isFetching?: boolean
  /** Epoch ms of last successful query — drives the "updated Xs ago" chip. */
  lastUpdatedAt?: number
  onRefresh?(): void
  search: string
  onSearchChange(q: string): void
  searchPlaceholder?: string
  /** Status / type / labels — rendered between search and refresh. */
  filters?: ReactNode
  /** Right-aligned actions (e.g. "Create"). */
  actions?: ReactNode
  /** Subtitle / caption shown beneath the title. */
  caption?: ReactNode
  children: ReactNode
}

export function ListShell({
  title,
  total,
  visible,
  loading = false,
  isFetching = false,
  lastUpdatedAt,
  onRefresh,
  search,
  onSearchChange,
  searchPlaceholder = 'Search by name…',
  filters,
  actions,
  caption,
  children,
}: ListShellProps) {
  const isFiltered = visible !== undefined && visible !== total
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-edge-default bg-white px-3 py-2 shadow-sm">
        {title ? (
          <div className="mr-2 flex min-w-0 items-baseline gap-2">
            <span className="text-sm font-semibold text-content">{title}</span>
            <span className="font-mono text-[11px] tabular-nums text-content-subtle">
              {isFiltered ? `${visible} / ${total}` : total}
            </span>
            {caption ? <span className="hidden text-[11px] text-content-subtle md:inline">· {caption}</span> : null}
          </div>
        ) : null}

        <div className="relative ml-auto order-2 flex w-full items-center sm:order-none sm:ml-0 sm:w-72">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-content-subtle">
            <SearchGlyph />
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            className={cn(
              'h-8 w-full rounded-lg border border-edge-default bg-white pl-8 pr-7 text-sm text-content placeholder:text-content-subtle',
              'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/20',
            )}
          />
          {search ? (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <ClearGlyph />
            </button>
          ) : null}
        </div>

        {filters ? <div className="flex flex-wrap items-center gap-1.5">{filters}</div> : null}

        <div className="ml-auto flex items-center gap-2">
          {lastUpdatedAt ? <UpdatedChip at={lastUpdatedAt} /> : null}
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Refresh"
              disabled={loading}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg border border-edge-default bg-white text-content-muted transition-colors',
                'hover:border-brand-300 hover:text-brand-700',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              {isFetching ? <Spinner size={14} /> : <RefreshGlyph />}
            </button>
          ) : null}
          {actions}
        </div>
      </div>
      {children}
    </div>
  )
}

/* ─────────────── status filter pill set ─────────────── */

export interface FilterPill<T extends string> {
  value: T
  label: string
  count?: number
  tone?: 'emerald' | 'amber' | 'rose' | 'sky' | 'violet' | 'slate'
}

const PILL_TONE: Record<NonNullable<FilterPill<string>['tone']>, string> = {
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200',
  sky: 'bg-sky-50 text-sky-700 ring-sky-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
}

export function StatusFilterPills<T extends string>({
  value,
  onChange,
  pills,
  allowAll = true,
}: {
  value: T | 'all'
  onChange(next: T | 'all'): void
  pills: FilterPill<T>[]
  allowAll?: boolean
}) {
  const items: Array<FilterPill<T> | { value: 'all'; label: string; count?: number; tone?: undefined }> =
    allowAll
      ? [{ value: 'all', label: 'All', count: pills.reduce((s, p) => s + (p.count ?? 0), 0) }, ...pills]
      : pills
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-white p-0.5">
      {items.map((p) => {
        const on = value === p.value
        const tone = on && p.tone ? PILL_TONE[p.tone] : ''
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange(p.value as T | 'all')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
              on
                ? p.tone
                  ? `ring-1 ring-inset ${tone}`
                  : 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200'
                : 'text-content-muted hover:bg-surface-sunken hover:text-content',
            )}
          >
            <span>{p.label}</span>
            {typeof p.count === 'number' ? (
              <span className="font-mono tabular-nums opacity-70">{p.count}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function UpdatedChip({ at }: { at: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  const ms = Date.now() - at
  const text = ms < 1000 ? 'just now' : ms < 60_000 ? `${Math.floor(ms / 1000)}s ago` : `${Math.floor(ms / 60_000)}m ago`
  return (
    <span
      title={new Date(at).toLocaleTimeString()}
      className="hidden items-center gap-1 rounded-md bg-surface-sunken px-2 py-1 text-[10px] font-medium text-content-subtle md:inline-flex"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      <span>updated {text}</span>
    </span>
  )
}

function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function ClearGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function RefreshGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

/** Helper — case-insensitive substring + label fuzzy match for resource lists. */
export function matchesSearch(haystack: string | undefined, q: string): boolean {
  if (!q) return true
  if (!haystack) return false
  return haystack.toLowerCase().includes(q.trim().toLowerCase())
}
