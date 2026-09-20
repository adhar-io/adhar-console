import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '@adhar-console/utils'
import {
  type Facet,
  type FacetOption,
  type FacetValues,
  countActiveFilters,
  facetValue,
  filterChips,
  isFacetSelected,
  NO_FILTERS,
  toggleFacetValue,
} from './filter-model.ts'
import { Spinner } from './primitives.tsx'

/**
 * FilterBar — the console's one search / filter / action row.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REPLACES
 * ---------------------------------------------------------------------------
 * Nine views had defined their own `SearchInput`, copies that had drifted on
 * width, focus-ring colour, and whether there was a magnifier icon at all.
 * Beside them the filter controls ranged from nothing to six `<select>`
 * dropdowns competing for one row — at which point the controls are wider
 * than the content they filter and the bar wraps to three lines on a laptop.
 *
 * The Service Catalog's toolbar is the shape worth standardising on, and this
 * is it, generalised:
 *
 *   [ 🔍 search…                  / ] [ Filters ⌄ 3 ] [ ▦ ▤ ] [ Sort ⌄ ]  … [ actions ]
 *   ┌ chips for everything currently applied ────────────────────────────────┐
 *
 * Three properties matter and are why it is a component rather than a
 * convention:
 *
 *   • **Applied state is always visible.** Filters live behind a button, so
 *     the chip row underneath is the only thing stopping "why is this list
 *     empty?" — a collapsed `<select>` showing "Kind: API" three controls to
 *     the right is not something anyone notices.
 *   • **It degrades by dropping controls, not by wrapping.** Below `sm` the
 *     sort and view controls collapse; search and Filters stay. A toolbar
 *     that reflows into three rows on a phone pushes the content it filters
 *     off-screen.
 *   • **One keyboard contract.** `/` focuses search, `Esc` clears it (and
 *     closes the popover first), everywhere.
 *
 * The model — selection, chips, URL encoding, matching — lives in
 * `filter-model.ts` so it can be tested without a DOM.
 */

/* ───────────────────────────── search input ───────────────────────────── */

export interface SearchInputProps {
  value: string
  onChange(value: string): void
  placeholder?: string
  /** Accessible name. Defaults to the placeholder, else "Search". */
  label?: string
  /**
   * Bind a single-key shortcut that focuses this input. `false` disables it.
   * Ignored while the user is typing in another field.
   */
  shortcut?: string | false
  /** Fill the available width (the bar's default) rather than sit at a fixed size. */
  block?: boolean
  autoFocus?: boolean
  className?: string
  inputRef?: React.RefObject<HTMLInputElement | null>
}

/**
 * The console's search field.
 *
 * `type="text"`, not `type="search"`: Safari and Chrome render their own clear
 * affordance for `search` inputs, which sat on top of ours at different sizes
 * per browser and did not fire the same events. One clear button we control
 * is the whole point of standardising this.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  label,
  shortcut = '/',
  block = true,
  autoFocus = false,
  className,
  inputRef,
}: SearchInputProps) {
  const ownRef = useRef<HTMLInputElement | null>(null)
  const ref = inputRef ?? ownRef

  useEffect(() => {
    if (!shortcut) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== shortcut || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      // Don't steal the key from someone typing — including in a contenteditable
      // surface like the AI composer or a code editor.
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      ref.current?.focus()
      ref.current?.select()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [shortcut, ref])

  return (
    <div className={cn('relative h-9', block ? 'w-full min-w-0' : 'w-44 sm:w-64', className)}>
      <input
        ref={ref}
        type="text"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            // Stop here so Esc clears the query rather than also closing a
            // drawer this bar happens to be inside.
            e.stopPropagation()
            onChange('')
          }
        }}
        placeholder={placeholder}
        aria-label={label ?? (placeholder === 'Search…' ? 'Search' : placeholder)}
        className="h-full w-full rounded-lg border border-edge-default bg-surface-raised pl-9 pr-10 text-sm text-content placeholder:text-content-subtle transition-shadow focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
      />
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle">
        <IconSearch />
      </span>
      <span className="absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center">
        {value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-content-subtle transition-colors hover:bg-surface-sunken hover:text-content"
            aria-label="Clear search"
            title="Clear (Esc)"
          >
            <IconX />
          </button>
        ) : shortcut ? (
          <kbd className="pointer-events-none hidden rounded border border-edge-default bg-surface-sunken px-1 py-0.5 font-mono text-[10px] text-content-muted sm:block">
            {shortcut}
          </kbd>
        ) : null}
      </span>
    </div>
  )
}

/* ───────────────────────────── the bar ───────────────────────────── */

export interface ViewOption<V extends string = string> {
  value: V
  label: string
  icon: ReactNode
}

export interface SortOption<S extends string = string> {
  value: S
  label: string
}

export interface FilterBarProps<V extends string = string, S extends string = string> {
  /** Free-text search. Omit for a bar that only has facets and actions. */
  search?: Omit<SearchInputProps, 'block' | 'className' | 'inputRef'> & {
    inputRef?: React.RefObject<HTMLInputElement | null>
  }
  /** Facet definitions. An empty list hides the Filters button entirely. */
  facets?: Facet[]
  values?: FacetValues
  onValuesChange?(next: FacetValues): void
  /** Layout switch (grid / list / table). */
  view?: { value: V; onChange(v: V): void; options: ViewOption<V>[] }
  sort?: { value: S; onChange(v: S): void; options: SortOption<S>[] }
  /** Buttons for this page, pushed to the right. */
  actions?: ReactNode
  /** First load — replaces the status area with a spinner. */
  loading?: boolean
  /** Background refresh — a quieter signal that does not imply an empty list. */
  refreshing?: boolean
  /**
   * `"12 of 48"` style summary rendered before the actions. Pass a node so a
   * view can link or qualify it.
   */
  summary?: ReactNode
  className?: string
}

export function FilterBar<V extends string = string, S extends string = string>({
  search,
  facets = [],
  values = NO_FILTERS,
  onValuesChange,
  view,
  sort,
  actions,
  loading = false,
  refreshing = false,
  summary,
  className,
}: FilterBarProps<V, S>) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const activeCount = countActiveFilters(values)
  const chips = useMemo(() => filterChips(facets, values), [facets, values])

  // Close the popover on outside click or Esc. Esc is bound here rather than
  // via useOverlayDismiss because this popover must not lock page scroll —
  // it is an inline flyout, not a modal.
  useEffect(() => {
    if (!open) return
    const onClickAway = (e: MouseEvent) => {
      const a = anchorRef.current
      if (a && !a.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    globalThis.addEventListener('mousedown', onClickAway)
    globalThis.addEventListener('keydown', onEsc)
    return () => {
      globalThis.removeEventListener('mousedown', onClickAway)
      globalThis.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const emit = useCallback(
    (next: FacetValues) => onValuesChange?.(next),
    [onValuesChange],
  )
  const removeChip = useCallback(
    (facetId: string, value: string) => {
      const facet = facets.find((f) => f.id === facetId)
      // A chip for a value whose facet is gone can still be removed by id.
      emit(
        facet
          ? toggleFacetValue(values, facet, value)
          : { ...values, [facetId]: facetValue(values, facetId).filter((v) => v !== value) },
      )
    },
    [facets, values, emit],
  )

  const showFilters = facets.length > 0 && Boolean(onValuesChange)

  return (
    <div
      // NOT `overflow-hidden`, however much the rounded corners want it: the
      // filter popover is an absolutely-positioned child, and clipping the
      // container cuts it off below the bar's own height — it renders as a
      // header strip with no body. The chip row rounds its own bottom corners
      // instead.
      className={cn(
        'rounded-xl border border-edge-default bg-surface-raised shadow-sm',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {search ? (
          <div className="min-w-0 flex-1 basis-56">
            <SearchInput {...search} block />
          </div>
        ) : null}

        {showFilters ? (
          <div className="relative" ref={anchorRef}>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-haspopup="dialog"
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[12px] font-medium transition-colors',
                activeCount > 0
                  ? 'border-brand-700 bg-brand-600 text-white shadow-sm hover:bg-brand-700'
                  : 'border-edge-default bg-surface-raised text-content hover:border-edge-strong hover:bg-surface-sunken',
              )}
            >
              <IconFilter />
              <span>Filters</span>
              {activeCount > 0 ? (
                <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                  {activeCount}
                </span>
              ) : null}
              <IconChevron />
            </button>
            {open ? (
              <FilterPopover
                facets={facets}
                values={values}
                onChange={emit}
                onClose={() => setOpen(false)}
              />
            ) : null}
          </div>
        ) : null}

        {view && view.options.length > 1 ? <ViewSwitch {...view} /> : null}
        {sort && sort.options.length > 1 ? <SortMenu {...sort} /> : null}

        <div className="ml-auto flex items-center gap-2">
          {loading ? (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] text-content-subtle"
              aria-live="polite"
            >
              <Spinner size={11} />
              <span>Loading…</span>
            </span>
          ) : refreshing ? (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] text-content-subtle"
              title="Refreshing in the background"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
              <span className="hidden sm:inline">Refreshing</span>
            </span>
          ) : summary ? (
            <span className="text-[11px] tabular-nums text-content-subtle">{summary}</span>
          ) : null}
          {actions}
        </div>
      </div>

      {chips.length > 0 ? (
        <ActiveChips chips={chips} onRemove={removeChip} onClear={() => emit(NO_FILTERS)} />
      ) : null}
    </div>
  )
}

/* ───────────────────────────── chips ───────────────────────────── */

function ActiveChips({
  chips,
  onRemove,
  onClear,
}: {
  chips: ReturnType<typeof filterChips>
  onRemove(facetId: string, value: string): void
  onClear(): void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-b-xl border-t border-edge-subtle bg-surface-sunken/40 px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        Filtered by
      </span>
      {chips.map((c) => (
        <button
          key={`${c.facetId}:${c.value}`}
          type="button"
          onClick={() => onRemove(c.facetId, c.value)}
          title={`Remove ${c.facetLabel}: ${c.label}`}
          className="group inline-flex max-w-56 items-center gap-1 rounded-full border border-brand-200 bg-brand-50 py-0.5 pl-2 pr-1 text-[11px] text-brand-800 transition-colors hover:border-brand-300 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-200"
        >
          <span className="text-brand-600/70 dark:text-brand-300/70">{c.facetLabel}</span>
          <span className="truncate font-medium">{c.label}</span>
          <span className="inline-flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full text-brand-600/60 group-hover:bg-brand-600/15 group-hover:text-brand-700 dark:text-brand-300/60 dark:group-hover:text-brand-200">
            <IconX size={9} />
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="ml-1 text-[11px] text-content-subtle underline-offset-2 hover:text-content hover:underline"
      >
        Clear all
      </button>
    </div>
  )
}

/* ───────────────────────────── popover ───────────────────────────── */

function FilterPopover({
  facets,
  values,
  onChange,
  onClose,
}: {
  facets: Facet[]
  values: FacetValues
  onChange(next: FacetValues): void
  onClose(): void
}) {
  const titleId = useId()
  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      className="pop-in absolute right-0 top-full z-30 mt-2 w-88 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-edge-default bg-surface-raised shadow-xl sm:left-0 sm:right-auto"
    >
      <header className="flex items-center justify-between border-b border-edge-subtle bg-surface-sunken/40 px-4 py-2.5">
        <div className="flex items-center gap-2 text-[12px]">
          <IconFilter />
          <span id={titleId} className="font-semibold text-content">
            Filters
          </span>
          <button
            type="button"
            onClick={() => onChange(NO_FILTERS)}
            className="ml-2 text-[11px] text-content-subtle underline-offset-2 hover:text-content hover:underline"
          >
            Clear all
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
        >
          <IconX />
        </button>
      </header>

      <div className="max-h-112 overflow-y-auto px-4 py-3">
        {facets.map((facet) => (
          <FacetGroup
            key={facet.id}
            facet={facet}
            values={values}
            onToggle={(value) => onChange(toggleFacetValue(values, facet, value))}
          />
        ))}
      </div>
    </div>
  )
}

function FacetGroup({
  facet,
  values,
  onToggle,
}: {
  facet: Facet
  values: FacetValues
  onToggle(value: string): void
}) {
  // A long option list (tags, namespaces) is shown truncated with a "show all",
  // so one facet with 200 values can't bury every facet below it.
  const [expanded, setExpanded] = useState(false)
  const selected = facetValue(values, facet.id)
  const LIMIT = 12
  const overflowing = facet.collapsible && facet.options.length > LIMIT && !expanded
  // Never hide a selected option behind "show all" — the chip row would name a
  // filter whose control is invisible.
  const shown = overflowing
    ? facet.options
      .filter((o, i) => i < LIMIT || selected.includes(o.value))
      .slice(0, LIMIT + selected.length)
    : facet.options

  if (facet.options.length === 0) return null

  return (
    <section className="border-b border-edge-subtle py-3 last:border-b-0">
      <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {facet.label}
      </h4>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((o) => (
          <OptionPill
            key={o.value}
            option={o}
            active={isFacetSelected(values, facet.id, o.value)}
            onClick={() => onToggle(o.value)}
          />
        ))}
      </div>
      {overflowing ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-[11px] text-content-subtle underline-offset-2 hover:text-content hover:underline"
        >
          Show all {facet.options.length}
        </button>
      ) : null}
    </section>
  )
}

function OptionPill({
  option,
  active,
  onClick,
}: {
  option: FacetOption
  active: boolean
  onClick(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={option.disabled}
      aria-pressed={active}
      title={option.label ?? option.value}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
          : 'border-edge-default bg-surface-raised text-content hover:border-edge-strong hover:bg-surface-sunken',
      )}
    >
      <span className="truncate">{option.label ?? option.value}</span>
      {typeof option.count === 'number' ? (
        <span
          className={cn(
            'tabular-nums text-[10px]',
            active ? 'text-white/70' : 'text-content-subtle',
          )}
        >
          {option.count}
        </span>
      ) : null}
    </button>
  )
}

/* ───────────────────────────── view + sort ───────────────────────────── */

function ViewSwitch<V extends string>({
  value,
  onChange,
  options,
}: {
  value: V
  onChange(v: V): void
  options: ViewOption<V>[]
}) {
  return (
    <div
      role="group"
      aria-label="View mode"
      className="hidden h-9 items-center rounded-lg border border-edge-default bg-surface-raised p-0.5 shadow-sm sm:inline-flex"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          title={o.label}
          aria-label={o.label}
          aria-pressed={value === o.value}
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-md transition',
            value === o.value
              ? 'bg-surface-sunken text-content'
              : 'text-content-subtle hover:bg-surface-sunken hover:text-content',
          )}
        >
          {o.icon}
        </button>
      ))}
    </div>
  )
}

function SortMenu<S extends string>({
  value,
  onChange,
  options,
}: {
  value: S
  onChange(v: S): void
  options: SortOption<S>[]
}) {
  return (
    <label className="hidden h-9 items-center gap-1.5 rounded-lg border border-edge-default bg-surface-raised px-3 text-[12px] shadow-sm sm:inline-flex">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        Sort
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as S)}
        className="rounded border-0 bg-transparent px-1 py-0 text-[12px] text-content focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/* ───────────────────────────── icons ───────────────────────────── */

function IconSearch() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function IconX({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

function IconFilter() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 5h18l-7 8v6l-4 2v-8Z" />
    </svg>
  )
}

function IconChevron() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="opacity-70"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** Grid / list / table icons, so views don't each redraw them for the switch. */
export const VIEW_ICONS = {
  grid: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  list: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  ),
  table: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 10v10" />
    </svg>
  ),
} as const
