import type { ReactNode } from 'react'
import { cn } from '@adhar-console/utils'

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
  /** Compact row height. */
  dense?: boolean
  /** Rendered in the thead above the column headers, e.g. filter/search chrome. */
  toolbar?: ReactNode
  className?: string
}

const ALIGN: Record<NonNullable<Column<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
}

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
}: Props<T>) {
  if (!loading && rows.length === 0 && empty) return <>{empty}</>
  const cellPad = dense ? 'px-3 py-1.5' : 'px-4 py-3'
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-edge-default bg-white shadow-sm',
        className,
      )}
    >
      {toolbar ? (
        <div className="flex items-center gap-2 border-b border-edge-subtle bg-surface-sunken/60 px-3 py-2">
          {toolbar}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className={cn(stickyHeader && 'sticky top-0 z-10')}>
            <tr className="border-b border-edge-default bg-surface-sunken/60 text-left">
              {columns.map((c) => {
                const align = c.numeric ? 'right' : c.align ?? 'left'
                return (
                  <th
                    key={c.key}
                    scope="col"
                    style={typeof c.width === 'number' ? { width: c.width } : undefined}
                    className={cn(
                      cellPad,
                      'text-[11px] font-semibold uppercase tracking-[0.06em] text-content-subtle',
                      ALIGN[align],
                      c.numeric && 'tabular-nums',
                      c.className,
                    )}
                  >
                    {c.header}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-edge-subtle last:border-0">
                    {columns.map((c) => (
                      <td key={c.key} className={cellPad}>
                        <span className="skeleton-shimmer block h-3 w-3/4 rounded" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((r, idx) => (
                  <tr
                    key={rowKey(r)}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    className={cn(
                      'border-b border-edge-subtle transition-colors duration-100 last:border-0',
                      striped && idx % 2 === 1 && 'bg-surface-sunken/40',
                      onRowClick && 'cursor-pointer hover:bg-brand-50/40',
                    )}
                  >
                    {columns.map((c) => {
                      const align = c.numeric ? 'right' : c.align ?? 'left'
                      return (
                        <td
                          key={c.key}
                          className={cn(
                            cellPad,
                            'text-content',
                            ALIGN[align],
                            c.numeric && 'font-mono tabular-nums text-content-muted',
                            c.className,
                          )}
                        >
                          {c.cell(r)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
