import { type MouseEvent, useMemo, useState } from 'react'
import { cn } from '@adhar/utils'
import { CALC_LABEL, formatUnit, type GrafanaPanel, reduce, type VarMap } from '../data/grafana-board.ts'
import { type DisplayValue, displayValue, type FieldValue, interpolateLink, type ResolvedField } from '../data/grafana-fields.ts'
import { compareValues } from '../data/grafana-transforms.ts'
import { consoleBoardHref } from '../data/grafana-links.ts'
import { routeClick } from '../data/discover-links.ts'
import { contrastText } from './grafana-viz.tsx'
import { seriesColor } from './viz.tsx'

/**
 * Grafana table. Shows the (transformed) frames — one at a time with a frame
 * picker when several remain, as Grafana does — with per-column units,
 * value mappings, thresholds and cell display modes (`color-text`,
 * `color-background` basic/gradient, `gauge` basic/gradient/lcd), data links
 * (Grafana `/d/…` links open the board here in the console), the board's
 * `sortBy`, sortable headers, `custom.hidden` / width / align, and the
 * footer reducer.
 */

interface Col {
  field: ResolvedField
  key: string
  name: string
  hidden: boolean
  align: 'left' | 'right' | 'center'
  cell: { type: string; mode?: string; valueDisplayMode?: string }
  width?: number
  min: number
  max: number
}

const MAX_ROWS = 1000

export function TableViz({
  panel,
  frames,
  vars,
  grafanaBase,
  timeRange,
}: {
  panel: GrafanaPanel
  frames: Array<{ fields: ResolvedField[] }>
  vars: VarMap
  grafanaBase: string
  timeRange: { from: string; to: string }
}) {
  const usable = frames.filter((f) => f.fields.length > 0)
  const [frameIdx, setFrameIdx] = useState(0)
  const frame = usable[Math.min(frameIdx, usable.length - 1)]
  const opts = (panel.options ?? {}) as {
    showHeader?: boolean
    sortBy?: Array<{ displayName?: string; desc?: boolean }>
    footer?: { show?: boolean; reducer?: string[]; fields?: string | string[]; countRows?: boolean }
    cellHeight?: string
  }
  const initialSort = opts.sortBy?.[0]?.displayName ? { col: opts.sortBy[0].displayName, desc: !!opts.sortBy[0].desc } : null
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(initialSort)

  const cols = useMemo<Col[]>(() => {
    if (!frame) return []
    return frame.fields.map((f, i) => {
      const c = (f.config.custom ?? {}) as {
        hidden?: boolean
        align?: string
        width?: number
        cellOptions?: { type?: string; mode?: string; valueDisplayMode?: string }
        displayMode?: string
      }
      let cell = { type: c.cellOptions?.type ?? 'auto', mode: c.cellOptions?.mode, valueDisplayMode: c.cellOptions?.valueDisplayMode }
      // Pre-v10 `displayMode`.
      if (!c.cellOptions && c.displayMode) {
        const m = c.displayMode
        cell = m === 'color-background' ? { type: 'color-background', mode: 'gradient', valueDisplayMode: undefined }
          : m === 'color-background-solid' ? { type: 'color-background', mode: 'basic', valueDisplayMode: undefined }
          : m === 'color-text' ? { type: 'color-text', mode: undefined, valueDisplayMode: undefined }
          : m === 'gradient-gauge' ? { type: 'gauge', mode: 'gradient', valueDisplayMode: undefined }
          : m === 'lcd-gauge' ? { type: 'gauge', mode: 'lcd', valueDisplayMode: undefined }
          : m === 'basic' ? { type: 'gauge', mode: 'basic', valueDisplayMode: undefined }
          : cell
      }
      const nums = f.values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      const align = c.align === 'left' || c.align === 'right' || c.align === 'center' ? c.align : f.type === 'number' ? 'right' : 'left'
      return {
        field: f,
        key: `${i}:${f.name}`,
        name: f.displayName,
        hidden: !!c.hidden,
        align,
        cell,
        width: c.width,
        min: f.config.min ?? Math.min(0, ...nums),
        max: f.config.max ?? Math.max(...nums, 1),
      }
    })
  }, [frame])

  const shown = cols.filter((c) => !c.hidden)
  const n = frame?.fields[0]?.values.length ?? 0
  const order = useMemo(() => {
    const idx = Array.from({ length: n }, (_, i) => i)
    if (!sort) return idx
    const col = cols.find((c) => c.name === sort.col)
    if (!col) return idx
    return idx.sort((a, b) => {
      const va = col.field.values[a]
      const vb = col.field.values[b]
      // Empty cells stay at the bottom in both directions.
      if (va == null || vb == null) return compareValues(va, vb)
      return compareValues(va, vb) * (sort.desc ? -1 : 1)
    })
  }, [n, cols, sort])

  if (!frame) return <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">No data in this range</div>

  const rowRecord = (r: number) => {
    const rec: Record<string, FieldValue> = {}
    for (const c of cols) {
      rec[c.field.name] = c.field.values[r] ?? null
      rec[c.name] = c.field.values[r] ?? null
    }
    return rec
  }

  const compact = opts.cellHeight === 'sm' || !opts.cellHeight
  const footer = opts.footer?.show ? footerValues(shown, opts.footer) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {usable.length > 1 ? (
        <select
          aria-label="Table frame"
          value={frameIdx}
          onChange={(e) => setFrameIdx(Number(e.target.value))}
          className="mb-1 h-6 max-w-full self-start rounded border border-edge-default bg-surface-raised px-1.5 text-[11px] text-content"
        >
          {usable.map((f, i) => (
            <option key={i} value={i}>{f.fields.find((x) => x.type === 'number')?.displayName ?? `Frame ${i + 1}`}</option>
          ))}
        </select>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[11px]">
          {opts.showHeader === false ? null : (
            <thead>
              <tr className="border-b border-edge-subtle">
                {shown.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    style={c.width ? { width: c.width, minWidth: c.width } : undefined}
                    className={cn('sticky top-0 z-[1] whitespace-nowrap bg-surface-raised px-2 py-1 font-semibold text-content-subtle', c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left')}
                    aria-sort={sort?.col === c.name ? (sort.desc ? 'descending' : 'ascending') : undefined}
                  >
                    <button
                      type="button"
                      className="hover:text-content"
                      onClick={() => setSort((s) => (s?.col === c.name ? (s.desc ? { col: c.name, desc: false } : null) : { col: c.name, desc: true }))}
                    >
                      {c.name}
                      {sort?.col === c.name ? (sort.desc ? ' ↓' : ' ↑') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {order.slice(0, MAX_ROWS).map((r) => (
              <tr key={r} className="border-b border-edge-subtle/60 hover:bg-surface-sunken/60">
                {shown.map((c) => (
                  <Cell
                    key={c.key}
                    col={c}
                    value={c.field.values[r] ?? null}
                    compact={compact}
                    link={linkFor(c.field, rowRecord(r), vars, grafanaBase, timeRange)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
          {footer ? (
            <tfoot>
              <tr className="border-t border-edge-default">
                {shown.map((c, i) => (
                  <td key={c.key} className={cn('sticky bottom-0 bg-surface-raised px-2 py-1 font-semibold text-content', c.align === 'right' ? 'text-right' : 'text-left')}>
                    {footer[i] ?? ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
        {n > MAX_ROWS ? <div className="py-1 text-[10px] text-content-subtle">Showing {MAX_ROWS} of {n} rows</div> : null}
      </div>
    </div>
  )
}

function footerValues(cols: Col[], f: { reducer?: string[]; fields?: string | string[]; countRows?: boolean }): string[] {
  const calc = f.reducer?.[0] ?? 'sum'
  const only = Array.isArray(f.fields) ? f.fields : f.fields ? [f.fields] : []
  return cols.map((c, i) => {
    if (f.countRows) return i === 0 ? `Count ${c.field.values.length}` : ''
    if (c.field.type !== 'number' || (only.length && !only.includes(c.name))) return i === 0 ? (CALC_LABEL[calc] ?? calc) : ''
    const v = reduce(c.field.values as Array<number | null>, calc)
    return formatUnit(v, c.field.config.unit, c.field.config.decimals)
  })
}

function linkFor(field: ResolvedField, row: Record<string, FieldValue>, vars: VarMap, grafanaBase: string, t: { from: string; to: string }) {
  const l = field.config.links?.[0]
  if (!l?.url) return null
  const url = interpolateLink(l.url, row, vars, { __url_time_range: `from=${encodeURIComponent(t.from)}&to=${encodeURIComponent(t.to)}` })
  const inConsole = consoleBoardHref(url, typeof location !== 'undefined' ? location.search : '', t)
  if (inConsole) return { href: inConsole, title: l.title ?? 'Open', internal: true }
  const abs = /^https?:\/\//.test(url) ? url : grafanaBase ? `${grafanaBase.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}` : ''
  return abs ? { href: abs, title: l.title ?? 'Open', internal: false } : null
}

function Cell({
  col,
  value,
  compact,
  link,
}: {
  col: Col
  value: FieldValue
  compact: boolean
  link: { href: string; title: string; internal: boolean } | null
}) {
  const f = col.field
  const d: DisplayValue = f.type === 'time' && typeof value === 'number' && !f.config.unit
    ? { text: formatUnit(value, 'dateTimeAsIso'), numeric: value }
    : displayValue(f.config, value, seriesColor(Math.max(0, f.seriesIndex)), { min: col.min, max: col.max })
  const pad = compact ? 'px-2 py-0.5' : 'px-2 py-1.5'
  const alignCls = col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
  const text = link
    ? (
      <a
        href={link.href}
        title={link.title}
        {...(link.internal ? { onClick: (e: MouseEvent<HTMLAnchorElement>) => routeClick(e) } : { target: '_blank', rel: 'noopener noreferrer' })}
        className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
      >
        {d.text}
      </a>
    )
    : d.text
  const type = col.cell.type
  if (type === 'color-background' && d.color) {
    const bg = col.cell.mode === 'gradient'
      ? `linear-gradient(120deg, color-mix(in oklab, ${d.color} 70%, white), ${d.color})`
      : d.color
    return (
      <td className={cn(pad, alignCls, 'font-mono tabular-nums')} style={{ background: bg, color: contrastText(d.color) }}>
        {text}
      </td>
    )
  }
  if (type === 'color-text') {
    return <td className={cn(pad, alignCls, 'font-mono tabular-nums')} style={{ color: d.color }}>{text}</td>
  }
  if (type === 'gauge' && d.numeric != null) {
    const pct = Math.max(0, Math.min(1, (d.numeric - col.min) / Math.max(1e-12, col.max - col.min)))
    const color = d.color ?? 'var(--color-brand-500)'
    const lcd = col.cell.mode === 'lcd'
    const showText = col.cell.valueDisplayMode !== 'hidden'
    return (
      <td className={cn(pad, 'min-w-[7rem]')}>
        <div className="flex items-center gap-2">
          <div className="relative h-3 min-w-[3rem] flex-1 overflow-hidden rounded-sm bg-surface-sunken" role="meter" aria-valuenow={d.numeric} aria-valuemin={col.min} aria-valuemax={col.max} aria-label={`${col.name} ${d.text}`}>
            {lcd ? (
              <div className="absolute inset-0 flex gap-px">
                {Array.from({ length: 20 }, (_, i) => (
                  <span key={i} className="h-full flex-1" style={{ backgroundColor: color, opacity: (i + 0.5) / 20 <= pct ? 1 : 0.12 }} />
                ))}
              </div>
            ) : (
              <div
                className="h-full"
                style={{
                  width: `${pct * 100}%`,
                  background: col.cell.mode === 'gradient' ? `linear-gradient(to right, color-mix(in oklab, ${color} 35%, transparent), ${color})` : color,
                }}
              />
            )}
          </div>
          {showText ? (
            <span className="w-16 shrink-0 text-right font-mono tabular-nums" style={col.cell.valueDisplayMode === 'color' ? { color } : undefined}>{text}</span>
          ) : null}
        </div>
      </td>
    )
  }
  return (
    <td className={cn(pad, alignCls, 'max-w-[18rem] truncate', f.type === 'number' ? 'font-mono tabular-nums text-content' : 'text-content-muted')} title={typeof d.text === 'string' && d.text.length > 30 ? d.text : undefined}>
      {text}
    </td>
  )
}
