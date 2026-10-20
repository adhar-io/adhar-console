import { useEffect, useMemo, useRef, useState } from 'react'
import { useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import type { metabase } from '@adhar/api-clients'
import { colKind, type ColKind, formatValue, type PivotModel, sortRowIndexes } from '../data/bi-chart.ts'
import { toTsv } from '../data/bi-sql.ts'
import { copyText, Icon, type IconName } from './bi-kit.tsx'

/**
 * Results grid: virtualised rows (thousands stay smooth), click-to-sort
 * headers with a column-type icon, a selectable cell (⌘C copies it, ⇧⌘C the
 * row), a per-row copy button, and optional pagination for the question view.
 */

const KIND_ICON: Record<ColKind, IconName> = { time: 'calendar', number: 'hash', category: 'text', boolean: 'toggle' }
const ROW_H = 30

export function DataGrid({
  cols,
  rows,
  height,
  pageSize,
  className,
  dense,
}: {
  cols: metabase.MbColumn[]
  rows: metabase.MbCell[][]
  /** Fixed pixel height of the scroll area. */
  height: number
  /** Paginate instead of virtualising. */
  pageSize?: number
  className?: string
  dense?: boolean
}) {
  const toast = useToast()
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [page, setPage] = useState(0)
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  const kinds = useMemo(() => cols.map((c, i) => colKind(c, rows, i)), [cols, rows])
  const order = useMemo(() => (sort ? sortRowIndexes(rows, sort.col, sort.dir) : rows.map((_, i) => i)), [rows, sort])
  const widths = useMemo(
    () =>
      cols.map((c, i) => {
        const head = (c.display_name ?? c.name).length * 7.2 + 40
        let max = 0
        for (let r = 0; r < Math.min(rows.length, 80); r++) max = Math.max(max, formatValue(rows[r][i], c).length)
        return Math.round(Math.min(360, Math.max(84, head, max * 7 + 20)))
      }),
    [cols, rows],
  )

  useEffect(() => {
    setPage(0)
    setSel(null)
    if (scroller.current) scroller.current.scrollTop = 0
    setScrollTop(0)
  }, [rows, sort])

  const pages = pageSize ? Math.max(1, Math.ceil(order.length / pageSize)) : 1
  const view = pageSize ? order.slice(page * pageSize, (page + 1) * pageSize) : order
  const rowH = dense ? 26 : ROW_H
  const start = pageSize ? 0 : Math.max(0, Math.floor(scrollTop / rowH) - 10)
  const end = pageSize ? view.length : Math.min(view.length, Math.ceil((scrollTop + height) / rowH) + 10)
  const visible = view.slice(start, end)

  const copyCell = async (r: number, c: number) => {
    const v = rows[r][c]
    const ok = await copyText(v == null ? '' : String(v))
    if (ok) toast.success('Copied cell')
    else toast.error('Clipboard is blocked by the browser')
  }
  const copyRow = async (r: number) => {
    const ok = await copyText(toTsv(cols, [rows[r]]))
    if (ok) toast.success('Copied row', { description: 'Tab-separated, with headers — pastes into a spreadsheet.' })
    else toast.error('Clipboard is blocked by the browser')
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (!sel) return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      if (e.shiftKey) void copyRow(sel.r)
      else void copyCell(sel.r, sel.c)
      return
    }
    const pos = view.indexOf(sel.r)
    const move = (dr: number, dc: number) => {
      const nr = view[Math.max(0, Math.min(view.length - 1, pos + dr))]
      const nc = Math.max(0, Math.min(cols.length - 1, sel.c + dc))
      if (nr != null) setSel({ r: nr, c: nc })
      e.preventDefault()
    }
    if (e.key === 'ArrowDown') move(1, 0)
    else if (e.key === 'ArrowUp') move(-1, 0)
    else if (e.key === 'ArrowLeft') move(0, -1)
    else if (e.key === 'ArrowRight') move(0, 1)
    else if (e.key === 'Escape') setSel(null)
  }

  const toggleSort = (i: number) =>
    setSort((s) => (!s || s.col !== i ? { col: i, dir: kinds[i] === 'number' ? 'desc' : 'asc' } : s.dir === (kinds[i] === 'number' ? 'desc' : 'asc') ? { col: i, dir: s.dir === 'asc' ? 'desc' : 'asc' } : null))

  const totalW = 48 + widths.reduce((a, w) => a + w, 0)

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="relative min-w-0 overflow-auto rounded-lg border border-edge-default bg-surface-raised outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40"
        style={{ height }}
        aria-label={`Results: ${rows.length} rows, ${cols.length} columns. Arrow keys move, Cmd+C copies the cell.`}
      >
        <table className="border-separate border-spacing-0 text-[12px]" style={{ width: totalW, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: 48 }} />
            {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="border-b border-edge-default bg-surface-sunken px-2 py-1.5 text-right text-[10px] font-medium text-content-subtle">#</th>
              {cols.map((c, i) => (
                <th key={`${c.name}-${i}`} className="border-b border-l border-edge-default bg-surface-sunken p-0 text-left">
                  <button
                    type="button"
                    onClick={() => toggleSort(i)}
                    title={`${c.display_name ?? c.name} · ${c.base_type?.replace('type/', '') ?? kinds[i]}${c.semantic_type ? ` · ${c.semantic_type.replace('type/', '')}` : ''} — click to sort`}
                    className="flex w-full items-center gap-1.5 px-2 py-1.5 font-semibold text-content hover:bg-surface-raised/60"
                  >
                    <Icon name={KIND_ICON[kinds[i]]} size={12} className="text-content-subtle" />
                    <span className="min-w-0 flex-1 truncate">{c.display_name ?? c.name}</span>
                    {sort?.col === i ? <span className="text-brand-700 dark:text-brand-300">{sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {start > 0 ? <tr style={{ height: start * rowH }} aria-hidden /> : null}
            {visible.map((r, k) => (
              <tr key={r} className="group" style={{ height: rowH }}>
                <td className="border-b border-edge-subtle bg-surface-raised px-1 text-right text-[10px] tabular-nums text-content-subtle">
                  <span className="group-hover:hidden">{(pageSize ? page * pageSize : 0) + start + k + 1}</span>
                  <button type="button" onClick={() => void copyRow(r)} title="Copy row" aria-label="Copy row" className="hidden h-5 w-full items-center justify-end text-content-subtle hover:text-content group-hover:inline-flex">
                    <Icon name="copy" size={12} />
                  </button>
                </td>
                {cols.map((c, i) => {
                  const v = rows[r][i]
                  const text = formatValue(v, c)
                  const selected = sel?.r === r && sel.c === i
                  return (
                    <td
                      key={i}
                      onClick={() => setSel({ r, c: i })}
                      onDoubleClick={() => void copyCell(r, i)}
                      title={text.length > 30 ? text : undefined}
                      className={cn(
                        'cursor-default truncate border-b border-l border-edge-subtle px-2',
                        kinds[i] === 'number' && 'text-right tabular-nums',
                        v == null ? 'text-content-subtle' : 'text-content',
                        selected ? 'bg-brand-50 outline outline-2 -outline-offset-2 outline-brand-400 dark:bg-brand-500/15' : 'group-hover:bg-surface-sunken/60',
                      )}
                    >
                      {v == null ? 'null' : text}
                    </td>
                  )
                })}
              </tr>
            ))}
            {!pageSize && end < view.length ? <tr style={{ height: (view.length - end) * rowH }} aria-hidden /> : null}
          </tbody>
        </table>
      </div>
      {pageSize && pages > 1 ? (
        <div className="mt-2 flex items-center justify-end gap-2 text-[12px] text-content-muted">
          <span className="tabular-nums">
            {page * pageSize + 1}–{Math.min(order.length, (page + 1) * pageSize)} of {order.length.toLocaleString()}
          </span>
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="rounded-md border border-edge-default px-2 py-0.5 hover:bg-surface-sunken disabled:opacity-40" aria-label="Previous page">
            ‹
          </button>
          <button type="button" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} className="rounded-md border border-edge-default px-2 py-0.5 hover:bg-surface-sunken disabled:opacity-40" aria-label="Next page">
            ›
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Compact read-only table for small dashboard cards (no virtualisation needed). */
export function MiniTable({ cols, rows, maxRows = 200 }: { cols: metabase.MbColumn[]; rows: metabase.MbCell[][]; maxRows?: number }) {
  const kinds = useMemo(() => cols.map((c, i) => colKind(c, rows, i)), [cols, rows])
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null)
  const order = useMemo(() => (sort ? sortRowIndexes(rows, sort.col, sort.dir) : rows.map((_, i) => i)).slice(0, maxRows), [rows, sort, maxRows])
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-[11.5px]">
        <thead className="sticky top-0 z-[1]">
          <tr>
            {cols.map((c, i) => (
              <th key={i} className="border-b border-edge-default bg-surface-raised p-0 text-left">
                <button
                  type="button"
                  onClick={() => setSort((s) => (!s || s.col !== i ? { col: i, dir: 'desc' } : s.dir === 'desc' ? { col: i, dir: 'asc' } : null))}
                  className={cn('flex w-full items-center gap-1 whitespace-nowrap px-2 py-1 font-semibold text-content-muted hover:text-content', kinds[i] === 'number' && 'justify-end')}
                >
                  {c.display_name ?? c.name}
                  {sort?.col === i ? <span>{sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((r) => (
            <tr key={r} className="hover:bg-surface-sunken/60">
              {cols.map((c, i) => (
                <td key={i} className={cn('max-w-64 truncate border-b border-edge-subtle px-2 py-1 text-content', kinds[i] === 'number' && 'text-right tabular-nums', rows[r][i] == null && 'text-content-subtle')}>
                  {rows[r][i] == null ? '—' : formatValue(rows[r][i], c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > maxRows ? <div className="px-2 py-1 text-[10px] text-content-subtle">Showing {maxRows} of {rows.length} rows</div> : null}
    </div>
  )
}

/** Pivot-lite: row × column groups with totals. */
export function PivotTable({ model, col }: { model: PivotModel; col?: metabase.MbColumn }) {
  const fmt = (v: number | null) => (v == null ? '—' : formatValue(v, col, { compact: true }))
  return (
    <div className="h-full overflow-auto">
      <table className="border-separate border-spacing-0 text-[11.5px]">
        <thead className="sticky top-0 z-[1]">
          <tr>
            <th className="sticky left-0 z-[2] border-b border-edge-default bg-surface-sunken px-2 py-1 text-left font-semibold text-content-muted">
              {model.rowHeader} \ {model.colHeader}
            </th>
            {model.colKeys.map((k) => (
              <th key={k} className="whitespace-nowrap border-b border-l border-edge-default bg-surface-sunken px-2 py-1 text-right font-semibold text-content-muted">
                {k}
              </th>
            ))}
            <th className="border-b border-l border-edge-default bg-surface-sunken px-2 py-1 text-right font-semibold text-content">Total</th>
          </tr>
        </thead>
        <tbody>
          {model.rowKeys.map((rk, i) => (
            <tr key={rk}>
              <th className="sticky left-0 whitespace-nowrap border-b border-edge-subtle bg-surface-raised px-2 py-1 text-left font-medium text-content">{rk}</th>
              {model.cells[i].map((v, j) => (
                <td key={j} className={cn('border-b border-l border-edge-subtle px-2 py-1 text-right tabular-nums', v == null ? 'text-content-subtle' : 'text-content')}>
                  {fmt(v)}
                </td>
              ))}
              <td className="border-b border-l border-edge-subtle bg-surface-sunken/50 px-2 py-1 text-right font-medium tabular-nums text-content">{fmt(model.rowTotals[i])}</td>
            </tr>
          ))}
          <tr>
            <th className="sticky left-0 bg-surface-sunken px-2 py-1 text-left font-semibold text-content">Total</th>
            {model.colTotals.map((v, j) => (
              <td key={j} className="border-l border-edge-subtle bg-surface-sunken px-2 py-1 text-right font-medium tabular-nums text-content">
                {fmt(v)}
              </td>
            ))}
            <td className="border-l border-edge-subtle bg-surface-sunken px-2 py-1 text-right font-semibold tabular-nums text-content">{fmt(model.grand)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/** Single-record view for Metabase "object" cards. */
export function ObjectDetail({ cols, row }: { cols: metabase.MbColumn[]; row: metabase.MbCell[] }) {
  return (
    <dl className="grid h-full grid-cols-[minmax(0,40%)_1fr] content-start gap-x-3 gap-y-1 overflow-auto text-[12px]">
      {cols.map((c, i) => (
        <div key={i} className="contents">
          <dt className="truncate text-content-muted">{c.display_name ?? c.name}</dt>
          <dd className="truncate text-content">{formatValue(row[i], c)}</dd>
        </div>
      ))}
    </dl>
  )
}
