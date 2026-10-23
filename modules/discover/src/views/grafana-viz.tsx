import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@adhar/utils'
import { formatTick, timeTicks } from '../data/grafana-timeline.ts'

/**
 * Shared chrome for the native Grafana panels: element measuring, a hover
 * tooltip portalled to <body> (z-[60]) so panels' overflow never clips it, a
 * Grafana-style legend (list or table with calcs, bottom or right), the time
 * axis, and a dark-mode probe for schemes that invert in dark themes.
 */

/** Observed content box of an element (0×0 before the first measurement). */
export function useBox(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [box, setBox] = useState({ w: 0, h: 0 })
  // The element can appear later (a component that first rendered an empty
  // state), so re-check it every render and re-observe when it changes.
  const [el, setEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (ref.current !== el) setEl(ref.current)
  })
  useLayoutEffect(() => {
    if (!el) return
    const r = el.getBoundingClientRect()
    setBox({ w: r.width, h: r.height })
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((es) => {
      const c = es[0]?.contentRect
      if (c) setBox((b) => (Math.abs(b.w - c.width) < 0.5 && Math.abs(b.h - c.height) < 0.5 ? b : { w: c.width, h: c.height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return box
}

/** True while the console is in dark mode (`.dark` on <html>). */
export function useIsDark(): boolean {
  const get = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const [dark, setDark] = useState(get)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(() => setDark(get()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

/** Hover / focus tooltip at viewport coordinates, portalled to <body>. */
export function HoverTip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x + 12, top: y + 12 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = globalThis.innerWidth || 1024
    const vh = globalThis.innerHeight || 768
    let left = x + 14
    let top = y + 14
    if (left + w > vw - 8) left = Math.max(8, x - w - 14)
    if (top + h > vh - 8) top = Math.max(8, y - h - 14)
    setPos({ left, top })
  }, [x, y, children])
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[60] max-w-[min(90vw,360px)] rounded-md border border-edge-default bg-surface-raised/95 px-2 py-1 font-mono text-[10px] text-content shadow-md backdrop-blur"
      style={{ left: pos.left, top: pos.top }}
    >
      {children}
    </div>,
    document.body,
  )
}

/** Tooltip anchor for keyboard focus: the element's centre in viewport px. */
export function anchorOf(el: Element | null): { x: number; y: number } {
  if (!el) return { x: 0, y: 0 }
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** Swatch for legends and tooltips: a line (optionally dashed) or a square. */
export function Swatch({ color, dash, shape = 'line' }: { color?: string; dash?: boolean; shape?: 'line' | 'square' }) {
  if (shape === 'square') return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color ?? 'var(--color-content-subtle)' }} />
  return (
    <span
      aria-hidden
      className={cn('inline-block w-3.5 shrink-0', dash ? 'h-0 border-t-2 border-dashed' : 'h-[3px] rounded-full')}
      style={dash ? { borderColor: color } : { backgroundColor: color }}
    />
  )
}

/* ─────────── legend ─────────── */

export interface LegendRow {
  key: string
  name: string
  color?: string
  dash?: boolean
  /** calc id → formatted value. */
  values?: Record<string, string>
  /** calc id → raw number (for sorting). */
  raw?: Record<string, number | null>
  dimmed?: boolean
}

/**
 * Grafana legend. List mode wraps items; table mode shows calc columns with
 * sortable headers. Clicking an item isolates that series (Grafana); clicking
 * the isolated one again shows all; ⌘/Ctrl-click toggles one series.
 */
export function Legend({
  rows,
  calcs = [],
  calcLabels,
  mode,
  placement,
  sortBy,
  sortDesc,
  onToggle,
  shape = 'line',
}: {
  rows: LegendRow[]
  calcs?: string[]
  calcLabels: Record<string, string>
  mode: 'list' | 'table'
  placement: 'bottom' | 'right'
  sortBy?: string
  sortDesc?: boolean
  onToggle?(key: string, additive: boolean): void
  shape?: 'line' | 'square'
}) {
  const initial = sortBy ? calcs.find((c) => (calcLabels[c] ?? c) === sortBy || c === sortBy) ?? (sortBy === 'Name' ? '__name' : undefined) : undefined
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(initial ? { col: initial, desc: !!sortDesc } : null)
  const sorted = useMemo(() => {
    if (!sort) return rows
    return [...rows].sort((a, b) => {
      if (sort.col === '__name') return a.name.localeCompare(b.name) * (sort.desc ? -1 : 1)
      const x = a.raw?.[sort.col] ?? null
      const y = b.raw?.[sort.col] ?? null
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return (x - y) * (sort.desc ? -1 : 1)
    })
  }, [rows, sort])
  const item = (r: LegendRow) => (
    <button
      type="button"
      onClick={(e) => onToggle?.(r.key, e.metaKey || e.ctrlKey)}
      className={cn('flex min-w-0 items-center gap-1.5 text-left hover:text-content', r.dimmed ? 'opacity-40' : '')}
      aria-pressed={!r.dimmed}
      title={r.name}
    >
      <Swatch color={r.color} dash={r.dash} shape={shape} />
      <span className="truncate">{r.name}</span>
    </button>
  )
  if (mode === 'table' && rows.length) {
    const head = (col: string, label: string, right = false) => (
      <th key={col} className={cn('sticky top-0 z-[1] bg-surface-raised px-1.5 py-0.5 font-medium text-content-subtle', right ? 'text-right' : 'text-left')}>
        <button
          type="button"
          className="hover:text-content"
          onClick={() => setSort((s) => (s?.col === col ? { col, desc: !s.desc } : { col, desc: true }))}
        >
          {label}
          {sort?.col === col ? (sort.desc ? ' ↓' : ' ↑') : ''}
        </button>
      </th>
    )
    return (
      <div className={cn('min-h-0 overflow-auto', placement === 'right' ? 'h-full' : 'max-h-full')}>
        <table className="w-full text-[10px] text-content-muted">
          <thead>
            <tr>
              {head('__name', 'Name')}
              {calcs.map((c) => head(c, calcLabels[c] ?? c, true))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.key} className="border-t border-edge-subtle/60">
                <td className="max-w-0 px-1.5 py-0.5">{item(r)}</td>
                {calcs.map((c) => (
                  <td key={c} className={cn('whitespace-nowrap px-1.5 py-0.5 text-right font-mono tabular-nums text-content', r.dimmed ? 'opacity-40' : '')}>
                    {r.values?.[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <div className={cn('min-h-0 overflow-auto text-[10px] text-content-muted', placement === 'right' ? 'flex h-full flex-col gap-1' : 'flex flex-wrap items-center gap-x-3 gap-y-0.5')}>
      {sorted.map((r) => (
        <div key={r.key} className="flex min-w-0 max-w-full items-center gap-1">
          {item(r)}
          {calcs.length ? (
            <span className="shrink-0 font-mono tabular-nums text-content">
              {calcs.map((c) => `${calcLabels[c] ?? c}: ${r.values?.[c] ?? ''}`).join('  ')}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** Series visibility as Grafana's legend toggles it. */
export function useSeriesToggle(keys: string[]) {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const toggle = (key: string, additive: boolean) => {
    setHidden((cur) => {
      if (additive) {
        const next = new Set(cur)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }
      const isolated = !cur.has(key) && keys.every((k) => k === key || cur.has(k))
      return isolated ? new Set() : new Set(keys.filter((k) => k !== key))
    })
  }
  return { hidden, toggle }
}

/* ─────────── axes ─────────── */

/** Bottom time axis inside an SVG (tick labels + optional gridlines). */
export function TimeAxis({
  start,
  end,
  x0,
  x1,
  y,
  gridTop,
}: {
  start: number
  end: number
  x0: number
  x1: number
  y: number
  gridTop?: number
}) {
  const w = Math.max(1, x1 - x0)
  const ticks = timeTicks(start, end, w)
  const sx = (t: number) => x0 + ((t - start) / Math.max(1, end - start)) * w
  return (
    <g aria-hidden>
      {ticks.map((t) => {
        const x = sx(t)
        const label = formatTick(t, end - start)
        const half = monoWidth(label) / 2
        // Keep edge labels inside the plot instead of clipping them.
        const anchor = x + half > x1 + 4 ? 'end' : x - half < x0 - 4 ? 'start' : 'middle'
        return (
          <g key={t}>
            {gridTop != null ? <line x1={x} x2={x} y1={gridTop} y2={y - 14} stroke="var(--color-edge-default)" strokeWidth="1" strokeDasharray="3 4" opacity="0.7" /> : null}
            <text x={anchor === 'end' ? Math.min(x, x1) : anchor === 'start' ? Math.max(x, x0) : x} y={y - 2} textAnchor={anchor} fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">
              {label}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/** Rough text width in px for 9px mono labels. */
export const monoWidth = (s: string, px = 9) => s.length * px * 0.62

/** Black or white text for a fill colour (falls back to white). */
export function contrastText(color?: string): string {
  if (!color) return 'var(--color-content)'
  if (color === 'var(--color-content)') return 'var(--color-surface-raised)'
  const tok = /var\(--color-([a-z]+)-(\d+)\)/.exec(color)
  if (tok) {
    const shade = Number(tok[2])
    const light = ['amber', 'yellow', 'lime'].includes(tok[1]) ? shade <= 500 : shade <= 300
    return light ? '#111' : '#fff'
  }
  const m =/^#([0-9a-f]{6})$/i.exec(color) ?? /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color)
  if (!m) return '#fff'
  const [r, g, b] = m.length === 2
    ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]
    : [Number(m[1]), Number(m[2]), Number(m[3])]
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff'
}
