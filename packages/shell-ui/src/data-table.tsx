import {
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@adhar-console/utils'

/**
 * DataTable — the console's grid.
 *
 * Every table in the console renders through this component, so the advanced
 * behaviour lives here once rather than being re-implemented per view:
 *
 *   • **Sorting**   — click a header to cycle asc → desc → none, shift-click to
 *                     sort by several columns. Natural (numeric-aware) collation,
 *                     so `node-2` sorts before `node-10` and `v1.9` before `v1.10`.
 *   • **Resizing**  — drag the divider between headers. The table switches to a
 *                     fixed layout on first resize, seeded from the measured
 *                     widths so nothing jumps.
 *   • **Reordering**— drag a header onto another. Enabled once the table has an
 *                     identity (`tableId`) or opts into the toolbar.
 *   • **Search**    — one box across every column's value.
 *   • **Filtering** — a per-column filter row: free text, or a multi-select for
 *                     columns with few distinct values.
 *   • **Columns**   — show/hide, with pinned columns locked in place.
 *   • **Density**   — comfortable / compact.
 *   • **Export**    — the rows and columns you are actually looking at, as CSV.
 *
 * The hard part is that a column declares `cell(row): ReactNode`, not a value —
 * so there is nothing obvious to sort or search on. Values are resolved in
 * three steps, best first:
 *
 *   1. `value(row)` when the column provides one (always preferred — it is the
 *      only way to sort on something the cell does not literally print, like a
 *      timestamp behind a "3m ago" label),
 *   2. `row[key]` — including dotted paths — when that is a primitive,
 *   3. the text content of the rendered cell, walked out of the React tree.
 *
 * Step 3 is what makes sort and search work across the whole console without
 * touching 38 call sites; steps 1 and 2 are what make it *correct* where it
 * matters. All of it is memoised per (row, column).
 *
 * Everything is opt-in-shaped: a table that passes nothing new behaves exactly
 * as it did, plus sorting and resizing.
 */

export type CellValue = string | number | boolean | Date | null | undefined

export interface Column<T> {
  key: string
  header: ReactNode
  cell(row: T): ReactNode
  className?: string
  /** Align cell content — defaults to 'left'. Headers follow cells. */
  align?: 'left' | 'right' | 'center'
  /** Render in a compact monospace numeric style (right-aligned, tabular-nums). */
  numeric?: boolean
  /** Shrink column to content width. */
  width?: 'auto' | number | string
  /** Lower bound when resizing. Defaults to 64px. */
  minWidth?: number
  /**
   * The sortable / searchable / filterable value behind this column. Provide it
   * whenever the cell shows something other than the value you want to order by
   * (relative times, formatted sizes, status icons).
   */
  value?(row: T): CellValue
  /** Force sorting off for this column. */
  sortable?: boolean
  /** Filter control. Defaults to a multi-select for low-cardinality columns, else text. */
  filter?: 'text' | 'select' | false
  /** Kept first and never hideable — use for the identifying column. */
  pinned?: boolean
  /** Start hidden; still available from the Columns menu. */
  defaultHidden?: boolean
}

export interface TableFeatures {
  search?: boolean
  filters?: boolean
  columns?: boolean
  density?: boolean
  export?: boolean
}

interface Props<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey(row: T): string
  onRowClick?(row: T): void
  empty?: ReactNode
  /** Render skeleton rows while loading. */
  loading?: boolean
  /** Sticky header — use inside a scrollable container. */
  stickyHeader?: boolean
  /** Adds subtle striping. Defaults to false. */
  striped?: boolean
  /** Compact row height. Overridden by the density control once the user picks one. */
  dense?: boolean
  /** Custom chrome rendered above the column headers. */
  toolbar?: ReactNode
  className?: string
  /**
   * Stable identity for this table. Enables column reordering and persists
   * order / widths / visibility / density / sort per browser.
   */
  tableId?: string
  /** Built-in toolbar. `true` turns everything on. */
  features?: boolean | TableFeatures
  /** Initial sort applied until the user chooses otherwise. */
  defaultSort?: { key: string; dir: SortDir }
  /** Text for the search box. */
  searchPlaceholder?: string
}

type SortDir = 'asc' | 'desc'
interface SortKey {
  key: string
  dir: SortDir
}

interface TablePrefs {
  order?: string[]
  widths?: Record<string, number>
  hidden?: string[]
  density?: 'comfortable' | 'compact'
  sort?: SortKey[]
}

const ALIGN: Record<NonNullable<Column<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
}

const DEFAULT_MIN_WIDTH = 64
/** Above this many distinct values a column filters as text rather than a picker. */
const SELECT_FILTER_MAX = 25
const PREFS_VERSION = 'v1'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/* ─────────────────────────── value resolution ─────────────────────────── */

/** Pull readable text out of a rendered cell, so any column is searchable. */
function textOf(node: ReactNode, depth = 0): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (depth > 8) return ''
  if (Array.isArray(node)) return node.map((n) => textOf(n, depth + 1)).join(' ')
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode; title?: unknown; 'aria-label'?: unknown }
    const children = textOf(props?.children, depth + 1)
    if (children.trim()) return children
    // Icon-only cells often carry their meaning in a label.
    const label = props?.['aria-label'] ?? props?.title
    return typeof label === 'string' ? label : ''
  }
  return ''
}

/** `a.b.c` lookup, primitives only. */
function pathValue(row: unknown, key: string): CellValue {
  if (!row || typeof row !== 'object') return undefined
  let node: unknown = row
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  if (node == null) return undefined
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node
  if (node instanceof Date) return node
  return undefined
}

function normalise(v: CellValue): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/* ─────────────────────────── preferences ─────────────────────────── */

function prefsKey(tableId: string): string {
  return `adhar.table.${tableId}.${PREFS_VERSION}`
}

function loadPrefs(tableId?: string): TablePrefs {
  if (!tableId) return {}
  try {
    const raw = globalThis.localStorage?.getItem(prefsKey(tableId))
    return raw ? (JSON.parse(raw) as TablePrefs) : {}
  } catch {
    return {}
  }
}

function savePrefs(tableId: string | undefined, prefs: TablePrefs) {
  if (!tableId) return
  try {
    globalThis.localStorage?.setItem(prefsKey(tableId), JSON.stringify(prefs))
  } catch {
    // private mode / quota — preferences are a convenience, never a requirement
  }
}

/* ─────────────────────────── component ─────────────────────────── */

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  loading = false,
  stickyHeader = false,
  striped = false,
  dense = false,
  toolbar,
  className,
  tableId,
  features,
  defaultSort,
  searchPlaceholder = 'Search…',
}: Props<T>) {
  const feat: TableFeatures = useMemo(
    () =>
      features === true
        ? { search: true, filters: true, columns: true, density: true, export: true }
        : features || {},
    [features],
  )
  const chrome = !!(feat.search || feat.filters || feat.columns || feat.density || feat.export)
  /** Reordering needs somewhere to remember itself, or it feels broken. */
  const canReorder = !!tableId || chrome

  const [prefs, setPrefsState] = useState<TablePrefs>(() => loadPrefs(tableId))
  const setPrefs = useCallback(
    (patch: Partial<TablePrefs>) => {
      setPrefsState((p) => {
        const next = { ...p, ...patch }
        savePrefs(tableId, next)
        return next
      })
    },
    [tableId],
  )

  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Record<string, string[]>>({})
  const [filterRow, setFilterRow] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const tableRef = useRef<HTMLTableElement>(null)
  const columnsBtnRef = useRef<HTMLButtonElement>(null)

  const sort = prefs.sort ?? (defaultSort ? [defaultSort] : [])
  const density = prefs.density ?? (dense ? 'compact' : 'comfortable')
  const cellPad = density === 'compact' ? 'px-3 py-1.5' : 'px-4 py-3'

  /* ── column order + visibility ── */
  const ordered = useMemo(() => {
    const byKey = new Map(columns.map((c) => [c.key, c]))
    const out: Column<T>[] = []
    // Pinned columns always lead, in their declared order.
    for (const c of columns) if (c.pinned) out.push(c)
    for (const key of prefs.order ?? []) {
      const c = byKey.get(key)
      if (c && !c.pinned && !out.includes(c)) out.push(c)
    }
    // Anything the saved order didn't know about (a new column) keeps its place.
    for (const c of columns) if (!out.includes(c)) out.push(c)
    return out
  }, [columns, prefs.order])

  const hidden = useMemo(() => {
    const set = new Set(prefs.hidden ?? columns.filter((c) => c.defaultHidden).map((c) => c.key))
    return set
  }, [prefs.hidden, columns])

  const visible = useMemo(() => ordered.filter((c) => c.pinned || !hidden.has(c.key)), [ordered, hidden])

  /* ── values: one memoised matrix drives sort, search, filters and export ── */
  const valueOf = useMemo(() => {
    const cache = new Map<string, string>()
    const raw = new Map<string, CellValue>()
    return {
      /** Comparable/searchable text for a cell. */
      text(col: Column<T>, row: T): string {
        const id = `${col.key} ${rowKey(row)}`
        const hit = cache.get(id)
        if (hit !== undefined) return hit
        let v: CellValue
        if (col.value) v = col.value(row)
        if (v == null) v = pathValue(row, col.key)
        let s = normalise(v)
        if (!s) {
          try {
            s = textOf(col.cell(row)).replace(/\s+/g, ' ').trim()
          } catch {
            s = ''
          }
        }
        raw.set(id, v)
        cache.set(id, s)
        return s
      },
      /** The typed value when there is one — used for numeric ordering. */
      raw(col: Column<T>, row: T): CellValue {
        const id = `${col.key} ${rowKey(row)}`
        if (!raw.has(id)) this.text(col, row)
        return raw.get(id)
      },
    }
    // Recomputed whenever the data or the columns change.
  }, [columns, rows, rowKey])

  /* ── filter → search → sort ── */
  const processed = useMemo(() => {
    let out = rows

    for (const [key, chosen] of Object.entries(filters)) {
      if (!chosen.length) continue
      const col = columns.find((c) => c.key === key)
      if (!col) continue
      const mode = filterModeFor(col, rows, valueOf)
      out = out.filter((r) => {
        const text = valueOf.text(col, r)
        return mode === 'select'
          ? chosen.includes(text)
          : chosen.every((needle) => text.toLowerCase().includes(needle.toLowerCase()))
      })
    }

    const needle = search.trim().toLowerCase()
    if (needle) {
      out = out.filter((r) => visible.some((c) => valueOf.text(c, r).toLowerCase().includes(needle)))
    }

    if (sort.length) {
      const keyed = sort
        .map((s) => ({ col: columns.find((c) => c.key === s.key), dir: s.dir }))
        .filter((s): s is { col: Column<T>; dir: SortDir } => !!s.col)
      if (keyed.length) {
        out = [...out].sort((a, b) => {
          for (const { col, dir } of keyed) {
            const cmp = compare(valueOf.raw(col, a), valueOf.text(col, a), valueOf.raw(col, b), valueOf.text(col, b))
            if (cmp !== 0) return dir === 'asc' ? cmp : -cmp
          }
          return 0
        })
      }
    }
    return out
  }, [rows, columns, visible, filters, search, sort, valueOf])

  /* ── sorting ── */
  const toggleSort = useCallback(
    (col: Column<T>, additive: boolean) => {
      if (col.sortable === false) return
      const current = sort.find((s) => s.key === col.key)
      const others = additive ? sort.filter((s) => s.key !== col.key) : []
      let next: SortKey[]
      if (!current) next = [...others, { key: col.key, dir: 'asc' }]
      else if (current.dir === 'asc') next = [...others, { key: col.key, dir: 'desc' }]
      else next = others
      setPrefs({ sort: next })
    },
    [sort, setPrefs],
  )

  /* ── resizing ── */
  const widths = prefs.widths ?? {}
  const hasWidths = Object.keys(widths).length > 0

  const startResize = useCallback(
    (col: Column<T>, e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const table = tableRef.current
      if (!table) return
      // Seed every column from the DOM on first resize so the switch to a
      // fixed layout doesn't reflow the whole table.
      const seeded: Record<string, number> = { ...widths }
      if (!hasWidths) {
        table.querySelectorAll<HTMLTableCellElement>('thead th[data-col]').forEach((th) => {
          const key = th.dataset.col
          if (key) seeded[key] = th.getBoundingClientRect().width
        })
      }
      const startX = e.clientX
      const startW = seeded[col.key] ?? DEFAULT_MIN_WIDTH
      const min = col.minWidth ?? DEFAULT_MIN_WIDTH
      let latest = seeded

      const onMove = (ev: PointerEvent) => {
        latest = { ...seeded, [col.key]: Math.max(min, Math.round(startW + (ev.clientX - startX))) }
        setPrefsState((p) => ({ ...p, widths: latest }))
      }
      const onUp = () => {
        globalThis.removeEventListener('pointermove', onMove)
        globalThis.removeEventListener('pointerup', onUp)
        document.body.classList.remove('select-none')
        setPrefs({ widths: latest })
      }
      document.body.classList.add('select-none')
      globalThis.addEventListener('pointermove', onMove)
      globalThis.addEventListener('pointerup', onUp)
    },
    [widths, hasWidths, setPrefs],
  )

  /* ── reordering ── */
  const [drag, setDrag] = useState<{ key: string; overKey: string | null } | null>(null)

  const startReorder = useCallback(
    (col: Column<T>, e: React.PointerEvent) => {
      if (!canReorder || col.pinned) return
      const startX = e.clientX
      const startY = e.clientY
      let active = false

      const onMove = (ev: PointerEvent) => {
        if (!active) {
          // A click should still sort; only a real drag reorders.
          if (Math.abs(ev.clientX - startX) < 6 && Math.abs(ev.clientY - startY) < 6) return
          active = true
          setDrag({ key: col.key, overKey: null })
        }
        const th = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('th[data-col]') as HTMLElement | null
        setDrag((d) => (d ? { ...d, overKey: th?.dataset.col ?? null } : d))
      }
      const onUp = () => {
        globalThis.removeEventListener('pointermove', onMove)
        globalThis.removeEventListener('pointerup', onUp)
        setDrag((d) => {
          if (d && active && d.overKey && d.overKey !== d.key) {
            const keys = ordered.filter((c) => !c.pinned).map((c) => c.key)
            const from = keys.indexOf(d.key)
            const to = keys.indexOf(d.overKey)
            if (from !== -1 && to !== -1) {
              keys.splice(to, 0, ...keys.splice(from, 1))
              setPrefs({ order: keys })
            }
          }
          return null
        })
      }
      globalThis.addEventListener('pointermove', onMove)
      globalThis.addEventListener('pointerup', onUp)
    },
    [canReorder, ordered, setPrefs],
  )

  /* ── filters ── */
  const activeFilters = Object.values(filters).filter((v) => v.length).length
  const clearAll = () => {
    setFilters({})
    setSearch('')
  }

  const exportCsv = () => {
    const head = visible.map((c) => csvCell(textOf(c.header) || c.key))
    const body = processed.map((r) => visible.map((c) => csvCell(valueOf.text(c, r))))
    const csv = [head, ...body].map((line) => line.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tableId ?? 'table'}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Nothing to show and the view supplied its own empty state — defer to it,
  // but only when the emptiness isn't something the user filtered into.
  const filteredToNothing = processed.length === 0 && rows.length > 0
  if (!loading && rows.length === 0 && empty) return <>{empty}</>

  return (
    <div className={cn('overflow-hidden rounded-xl border border-edge-default bg-surface-raised shadow-sm', className)}>
      {toolbar || chrome ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-edge-subtle bg-surface-sunken/60 px-3 py-2">
          {toolbar}
          {feat.search ? (
            <div className="relative min-w-45 flex-1 sm:max-w-xs">
              <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-content-subtle">
                <IconSearch />
              </span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label="Search this table"
                className="h-7 w-full rounded-md border border-edge-default bg-surface-app pl-7 pr-2 text-[12px] text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none"
              />
            </div>
          ) : null}

          <span className="ml-auto flex flex-wrap items-center gap-1">
            {search || activeFilters ? (
              <span className="mr-1 text-[11px] text-content-subtle">
                {processed.length} of {rows.length}
                <button type="button" onClick={clearAll} className="ml-1.5 font-medium text-content-muted underline-offset-2 hover:text-content hover:underline">
                  clear
                </button>
              </span>
            ) : null}

            {feat.filters ? (
              <ToolbarBtn on={filterRow || activeFilters > 0} onClick={() => setFilterRow((f) => !f)} title="Filter each column">
                <IconFilter /> Filters{activeFilters ? ` · ${activeFilters}` : ''}
              </ToolbarBtn>
            ) : null}

            {feat.columns ? (
              <div className="relative">
                <ToolbarBtn ref={columnsBtnRef} on={columnsOpen} onClick={() => setColumnsOpen((o) => !o)} title="Show or hide columns">
                  <IconColumns /> Columns
                </ToolbarBtn>
                {columnsOpen ? (
                  <ColumnsMenu
                    columns={ordered}
                    hidden={hidden}
                    onToggle={(key) => {
                      const next = new Set(hidden)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      setPrefs({ hidden: [...next] })
                    }}
                    onReset={() => setPrefs({ hidden: [], order: [], widths: {} })}
                    onClose={() => setColumnsOpen(false)}
                    anchorRef={columnsBtnRef}
                  />
                ) : null}
              </div>
            ) : null}

            {feat.density ? (
              <ToolbarBtn
                on={density === 'compact'}
                onClick={() => setPrefs({ density: density === 'compact' ? 'comfortable' : 'compact' })}
                title={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
              >
                <IconDensity /> {density === 'compact' ? 'Compact' : 'Cosy'}
              </ToolbarBtn>
            ) : null}

            {feat.export ? (
              <ToolbarBtn on={false} onClick={exportCsv} title="Download what you are looking at as CSV">
                <IconDownload /> CSV
              </ToolbarBtn>
            ) : null}
          </span>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table
          ref={tableRef}
          className="w-full border-collapse text-sm"
          style={hasWidths ? { tableLayout: 'fixed' } : undefined}
        >
          {hasWidths ? (
            <colgroup>
              {visible.map((c) => (
                <col key={c.key} style={widths[c.key] ? { width: widths[c.key] } : undefined} />
              ))}
            </colgroup>
          ) : null}
          <thead className={cn(stickyHeader && 'sticky top-0 z-10')}>
            <tr className="border-b border-edge-default bg-surface-sunken/60 text-left">
              {visible.map((c) => {
                const align = c.numeric ? 'right' : c.align ?? 'left'
                const sortIdx = sort.findIndex((s) => s.key === c.key)
                const active = sortIdx >= 0 ? sort[sortIdx] : null
                const sortable = c.sortable !== false
                return (
                  <th
                    key={c.key}
                    data-col={c.key}
                    scope="col"
                    aria-sort={active ? (active.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    style={!hasWidths && typeof c.width === 'number' ? { width: c.width } : undefined}
                    className={cn(
                      'relative text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle',
                      ALIGN[align],
                      c.numeric && 'tabular-nums',
                      drag?.key === c.key && 'opacity-40',
                      drag?.overKey === c.key && drag.key !== c.key && 'bg-brand-50 dark:bg-brand-500/10',
                      c.className,
                    )}
                  >
                    <span
                      role={sortable ? 'button' : undefined}
                      tabIndex={sortable ? 0 : undefined}
                      onPointerDown={(e) => {
                        if (e.button === 0) startReorder(c, e)
                      }}
                      onClick={(e) => sortable && toggleSort(c, e.shiftKey)}
                      onKeyDown={(e) => {
                        if (sortable && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault()
                          toggleSort(c, e.shiftKey)
                        }
                      }}
                      title={sortable ? 'Sort — shift-click to add a second column' : undefined}
                      className={cn(
                        'flex items-center gap-1',
                        cellPad,
                        align === 'right' && 'justify-end',
                        align === 'center' && 'justify-center',
                        sortable && 'cursor-pointer select-none hover:text-content',
                        canReorder && !c.pinned && 'touch-none',
                      )}
                    >
                      <span className="truncate">{c.header}</span>
                      {sortable ? (
                        <SortGlyph dir={active?.dir} order={sort.length > 1 && sortIdx >= 0 ? sortIdx + 1 : undefined} />
                      ) : null}
                    </span>
                    <span
                      onPointerDown={(e) => startResize(c, e)}
                      title="Drag to resize"
                      aria-hidden
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-brand-400/60"
                    />
                  </th>
                )
              })}
            </tr>
            {feat.filters && filterRow ? (
              <tr className="border-b border-edge-default bg-surface-sunken/40">
                {visible.map((c) => (
                  <th key={c.key} className="px-2 py-1 font-normal">
                    <ColumnFilter
                      column={c}
                      rows={rows}
                      valueOf={valueOf}
                      chosen={filters[c.key] ?? []}
                      onChange={(next) => setFilters((f) => ({ ...f, [c.key]: next }))}
                    />
                  </th>
                ))}
              </tr>
            ) : null}
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={`skeleton-${i}`} className="border-b border-edge-subtle last:border-0">
                  {visible.map((c) => (
                    <td key={c.key} className={cellPad}>
                      <span className="skeleton-shimmer block h-3 w-3/4 rounded" />
                    </td>
                  ))}
                </tr>
              ))
              : processed.map((r, idx) => (
                <tr
                  key={rowKey(r)}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={cn(
                    'border-b border-edge-subtle transition-colors duration-100 last:border-0',
                    striped && idx % 2 === 1 && 'bg-surface-sunken/40',
                    onRowClick && 'cursor-pointer hover:bg-brand-50/40 dark:hover:bg-brand-500/10',
                  )}
                >
                  {visible.map((c) => {
                    const align = c.numeric ? 'right' : c.align ?? 'left'
                    return (
                      <td
                        key={c.key}
                        className={cn(
                          cellPad,
                          'text-content',
                          ALIGN[align],
                          c.numeric && 'font-mono tabular-nums text-content-muted',
                          hasWidths && 'truncate',
                          c.className,
                        )}
                      >
                        {c.cell(r)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            {!loading && filteredToNothing ? (
              <tr>
                <td colSpan={visible.length} className="px-4 py-10 text-center">
                  <div className="text-[13px] font-medium text-content">Nothing matches</div>
                  <p className="mt-0.5 text-[12px] text-content-muted">
                    {rows.length} row{rows.length === 1 ? '' : 's'} are hidden by the current search and filters.
                  </p>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="mt-2 rounded-md border border-edge-default px-2.5 py-1 text-[12px] font-medium text-content-muted hover:text-content"
                  >
                    Clear search and filters
                  </button>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────────────────────── helpers ─────────────────────────── */

/** Numbers numerically, everything else with natural (numeric-aware) collation. */
function compare(rawA: CellValue, textA: string, rawB: CellValue, textB: string): number {
  const aEmpty = textA === ''
  const bEmpty = textB === ''
  // Blanks sort last in both directions — they are never the interesting rows.
  if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1
  if (typeof rawA === 'number' && typeof rawB === 'number') return rawA - rawB
  if (rawA instanceof Date && rawB instanceof Date) return rawA.getTime() - rawB.getTime()
  if (typeof rawA === 'boolean' && typeof rawB === 'boolean') return Number(rawA) - Number(rawB)
  return collator.compare(textA, textB)
}

interface ValueOf<T> {
  text(col: Column<T>, row: T): string
  raw(col: Column<T>, row: T): CellValue
}

function distinctValues<T>(col: Column<T>, rows: T[], valueOf: ValueOf<T>): string[] {
  const set = new Set<string>()
  for (const r of rows) {
    const v = valueOf.text(col, r)
    if (v) set.add(v)
    if (set.size > SELECT_FILTER_MAX) break
  }
  return [...set].sort(collator.compare)
}

function filterModeFor<T>(col: Column<T>, rows: T[], valueOf: ValueOf<T>): 'text' | 'select' | false {
  if (col.filter !== undefined) return col.filter
  return distinctValues(col, rows, valueOf).length <= SELECT_FILTER_MAX ? 'select' : 'text'
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function ColumnFilter<T>({
  column,
  rows,
  valueOf,
  chosen,
  onChange,
}: {
  column: Column<T>
  rows: T[]
  valueOf: ValueOf<T>
  chosen: string[]
  onChange(next: string[]): void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const mode = filterModeFor(column, rows, valueOf)
  if (mode === false) return null

  if (mode === 'text') {
    return (
      <input
        value={chosen[0] ?? ''}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        placeholder="Filter…"
        aria-label={`Filter ${textOf(column.header) || column.key}`}
        className="h-6 w-full min-w-0 rounded border border-edge-default bg-surface-app px-1.5 text-[11px] font-normal text-content placeholder:text-content-subtle focus:border-brand-400 focus:outline-none"
      />
    )
  }

  const options = distinctValues(column, rows, valueOf)
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-6 w-full items-center justify-between gap-1 rounded border px-1.5 text-[11px] font-normal',
          chosen.length ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300' : 'border-edge-default bg-surface-app text-content-subtle hover:text-content',
        )}
      >
        <span className="truncate">{chosen.length ? `${chosen.length} selected` : 'Any'}</span>
        <IconChevron />
      </button>
      {open ? (
        <Anchored anchorRef={triggerRef} width={192} onClose={() => setOpen(false)}>
          <div>
            {chosen.length ? (
              <button type="button" onClick={() => onChange([])} className="mb-1 block w-full rounded px-1.5 py-1 text-left text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content">
                Clear
              </button>
            ) : null}
            {options.length === 0 ? <p className="px-1.5 py-1 text-[11px] text-content-subtle">No values.</p> : null}
            {options.map((v) => {
              const on = chosen.includes(v)
              return (
                <label key={v} className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] font-normal text-content-muted hover:bg-surface-sunken">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onChange(on ? chosen.filter((x) => x !== v) : [...chosen, v])}
                    className="h-3 w-3 accent-current"
                  />
                  <span className="truncate" title={v}>{v}</span>
                </label>
              )
            })}
          </div>
        </Anchored>
      ) : null}
    </div>
  )
}

/**
 * A menu anchored to a trigger but rendered at the document root.
 *
 * The table card is `overflow-hidden` (rounded corners) and its body scrolls
 * horizontally, so anything rendered inside it gets clipped — the columns menu
 * lost its footer and the per-column filter dropdowns were cut off entirely.
 * Portalling to the body and positioning from the trigger's rect fixes both,
 * and keeps the menu glued to the trigger while the page scrolls.
 */
function Anchored({
  anchorRef,
  align = 'left',
  width,
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>
  align?: 'left' | 'right'
  width: number
  onClose(): void
  children: ReactNode
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      const left = align === 'right' ? Math.max(8, r.right - width) : Math.min(r.left, globalThis.innerWidth - width - 8)
      setPos({ top: r.bottom + 4, left })
    }
    place()
    globalThis.addEventListener('scroll', place, true)
    globalThis.addEventListener('resize', place)
    return () => {
      globalThis.removeEventListener('scroll', place, true)
      globalThis.removeEventListener('resize', place)
    }
  }, [anchorRef, align, width])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined' || !pos) return null
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" aria-hidden onClick={onClose} />
      <div
        style={{ position: 'fixed', top: pos.top, left: pos.left, width }}
        className="z-[61] max-h-72 overflow-y-auto rounded-lg border border-edge-default bg-surface-raised p-1 shadow-xl"
      >
        {children}
      </div>
    </>,
    document.body,
  )
}

function ColumnsMenu<T>({
  columns,
  hidden,
  onToggle,
  onReset,
  onClose,
  anchorRef,
}: {
  columns: Column<T>[]
  hidden: Set<string>
  onToggle(key: string): void
  onReset(): void
  onClose(): void
  anchorRef: RefObject<HTMLElement | null>
}) {
  return (
    <Anchored anchorRef={anchorRef} align="right" width={208} onClose={onClose}>
      <div>
        <div className="px-1.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Columns</div>
        {columns.map((c) => {
          const on = c.pinned || !hidden.has(c.key)
          return (
            <label
              key={c.key}
              className={cn('flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px]', c.pinned ? 'cursor-not-allowed text-content-subtle' : 'cursor-pointer text-content-muted hover:bg-surface-sunken hover:text-content')}
              title={c.pinned ? 'This column is pinned' : undefined}
            >
              <input type="checkbox" checked={on} disabled={c.pinned} onChange={() => onToggle(c.key)} className="h-3 w-3 accent-current" />
              <span className="truncate">{textOf(c.header) || c.key}</span>
            </label>
          )
        })}
        <div className="mt-1 border-t border-edge-subtle pt-1">
          <button type="button" onClick={() => { onReset(); onClose() }} className="block w-full rounded px-1.5 py-1 text-left text-[11px] font-medium text-content-muted hover:bg-surface-sunken hover:text-content">
            Reset layout
          </button>
        </div>
      </div>
    </Anchored>
  )
}

function SortGlyph({ dir, order }: { dir?: SortDir; order?: number }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-0.5', dir ? 'text-brand-600 dark:text-brand-400' : 'text-content-subtle/40')}>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {dir === 'desc' ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
      </svg>
      {order ? <span className="text-[8px] font-bold tabular-nums">{order}</span> : null}
    </span>
  )
}

const ToolbarBtn = forwardRef<HTMLButtonElement, { on: boolean; onClick(): void; title: string; children: ReactNode }>(
  function ToolbarBtn({ on, onClick, title, children }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors',
        on
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
          : 'border-edge-default bg-surface-raised text-content-muted hover:border-edge-strong hover:text-content',
      )}
    >
      {children}
    </button>
  )
})

const I = ({ children }: { children: ReactNode }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
    {children}
  </svg>
)
const IconSearch = () => <I><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>
const IconFilter = () => <I><path d="M3 5h18l-7 8v5l-4 2v-7z" /></I>
const IconColumns = () => <I><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></I>
const IconDensity = () => <I><path d="M3 6h18M3 12h18M3 18h18" /></I>
const IconDownload = () => <I><path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M5 21h14" /></I>
const IconChevron = () => <I><path d="m6 9 6 6 6-6" /></I>

export { textOf as cellText }
