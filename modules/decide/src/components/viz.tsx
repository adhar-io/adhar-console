import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useElementWidth } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'

/**
 * Decide's charts. Drawn at the container's measured pixel width and a fixed
 * pixel height, so text stays 10–11 px at any width (shell-ui's
 * TimeSeriesChart scales its text with width). Thin marks, recessive grid,
 * one y-axis, hover tooltips, a legend whenever there are ≥ 2 series, and
 * labels in text colours — never in the series colour.
 *
 * Categorical slots are the validated reference palette (blue, orange, aqua,
 * yellow), stepped separately for dark mode. Status hues (emerald / amber /
 * rose) are reserved for state and always travel with an icon + label.
 */

const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100']
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500']

export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const el = document.documentElement
    const mo = new MutationObserver(() => setDark(el.classList.contains('dark')))
    mo.observe(el, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark
}

/** Categorical colour for slot `i` (0-based); past the fourth slot everything is "other" grey. */
export function useSeriesColor(): (i: number) => string {
  const dark = useIsDark()
  return (i: number) => (i < 4 ? (dark ? SERIES_DARK : SERIES_LIGHT)[i] : 'var(--color-content-subtle)')
}

export const STATUS_COLOR = {
  good: 'var(--color-emerald-500, #10b981)',
  warn: 'var(--color-amber-500, #f59e0b)',
  bad: 'var(--color-rose-500, #f43f5e)',
}

export interface Series {
  name: string
  points: Array<[number, number]>
  color: string
  dashed?: boolean
}

const fmtDay = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** A rounded axis top whose half is also round (axes label 0, half, top). */
function niceMax(v: number): number {
  if (!(v > 0)) return 2
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : n <= 8 ? 8 : 10) * p
}

export function Legend({ items, className }: { items: Array<{ name: string; color: string; dashed?: boolean }>; className?: string }) {
  if (items.length < 2) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-content-muted', className)}>
      {items.map((s) => (
        <span key={s.name} className="inline-flex items-center gap-1.5">
          <svg width="14" height="8" aria-hidden>
            <line x1="1" x2="13" y1="4" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '3 2' : undefined} strokeLinecap="round" />
          </svg>
          {s.name}
        </span>
      ))}
    </div>
  )
}

interface Frame {
  width: number
  height: number
  pad: { l: number; r: number; t: number; b: number }
}

function Axes({ f, top, x0, x1, formatY, formatX, ticks = 4 }: { f: Frame; top: number; x0: number; x1: number; formatY(v: number): string; formatX(t: number): string; ticks?: number }) {
  const plotH = f.height - f.pad.t - f.pad.b
  const y = (v: number) => f.pad.t + plotH - (v / top) * plotH
  const xs = Array.from({ length: ticks + 1 }, (_, i) => x0 + ((x1 - x0) * i) / ticks)
  const plotW = f.width - f.pad.l - f.pad.r
  return (
    <g>
      {[0, 0.5, 1].map((fr) => (
        <g key={fr}>
          <line
            x1={f.pad.l}
            x2={f.width - f.pad.r}
            y1={y(fr * top)}
            y2={y(fr * top)}
            stroke="var(--color-edge-default)"
            strokeWidth="1"
            strokeDasharray={fr === 0 ? undefined : '2 4'}
          />
          <text x={f.pad.l - 6} y={y(fr * top) + 3} textAnchor="end" fontSize="10" fill="var(--color-content-subtle)">
            {formatY(fr * top)}
          </text>
        </g>
      ))}
      {plotW > 160 &&
        xs.map((t, i) => (
          <text
            key={i}
            x={f.pad.l + (plotW * i) / ticks}
            y={f.height - 4}
            textAnchor={i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}
            fontSize="10"
            fill="var(--color-content-subtle)"
          >
            {formatX(t)}
          </text>
        ))}
    </g>
  )
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 70), Math.max(70, width - 70))
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-edge-default bg-surface-raised px-2 py-1.5 text-[11px] text-content shadow-md"
      style={{ left }}
    >
      {children}
    </div>
  )
}

function Empty({ height, label }: { height: number; label: string }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-edge-default px-3 text-center text-xs text-content-subtle" style={{ height }}>
      {label}
    </div>
  )
}

/** Multi-series line chart on a time axis. */
export function LineChart({
  series,
  height = 180,
  formatY = (v) => String(Math.round(v)),
  formatX = fmtDay,
  domain,
  yMax,
  refLines = [],
  emptyLabel = 'No data in this range.',
  showLegend = true,
}: {
  series: Series[]
  height?: number
  formatY?(v: number): string
  formatX?(t: number): string
  /** Fixed x-domain [from, to] (ms). Defaults to the data's extent. */
  domain?: [number, number]
  yMax?: number
  refLines?: Array<{ value: number; label: string }>
  emptyLabel?: string
  showLegend?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [hover, setHover] = useState<number | null>(null)
  const pts = series.flatMap((s) => s.points)
  const hasData = pts.length > 0
  const x0 = domain?.[0] ?? Math.min(...pts.map((p) => p[0]))
  const x1 = domain?.[1] ?? Math.max(...pts.map((p) => p[0]))
  const top = yMax ?? niceMax(Math.max(...pts.map((p) => p[1]), ...refLines.map((r) => r.value), 0) * 1.05)
  const f: Frame = { width, height, pad: { l: 44, r: 10, t: 10, b: 20 } }
  const plotW = Math.max(1, width - f.pad.l - f.pad.r)
  const plotH = height - f.pad.t - f.pad.b
  const x = (t: number) => f.pad.l + ((t - x0) / Math.max(1, x1 - x0)) * plotW
  const y = (v: number) => f.pad.t + plotH - (Math.min(v, top) / top) * plotH
  const times = useMemo(() => [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b), [pts])
  const hoverT = hover == null || !times.length ? null : times.reduce((b, t) => (Math.abs(x(t) - hover) < Math.abs(x(b) - hover) ? t : b), times[0])
  return (
    <div className="space-y-2">
      {showLegend ? <Legend items={series} /> : null}
      <div ref={ref} className="relative" style={{ height }}>
        {!hasData ? <Empty height={height} label={emptyLabel} /> : width > 0
          ? (
            <svg
              width={width}
              height={height}
              className="block"
              onMouseMove={(e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)}
              onMouseLeave={() => setHover(null)}
              role="img"
            >
              <Axes f={f} top={top} x0={x0} x1={x1} formatY={formatY} formatX={formatX} />
              {refLines.map((r) => (
                <g key={r.label}>
                  <line x1={f.pad.l} x2={width - f.pad.r} y1={y(r.value)} y2={y(r.value)} stroke="var(--color-content-subtle)" strokeDasharray="4 3" strokeWidth="1" />
                  <text x={width - f.pad.r - 2} y={y(r.value) - 3} textAnchor="end" fontSize="10" fill="var(--color-content-muted)">
                    {r.label}
                  </text>
                </g>
              ))}
              {series.map((s) => {
                const p = [...s.points].sort((a, b) => a[0] - b[0])
                if (!p.length) return null
                if (p.length === 1) return <circle key={s.name} cx={x(p[0][0])} cy={y(p[0][1])} r="3" fill={s.color} />
                return (
                  <path
                    key={s.name}
                    d={p.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="2"
                    strokeDasharray={s.dashed ? '5 4' : undefined}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                )
              })}
              {hoverT != null
                ? (
                  <g>
                    <line x1={x(hoverT)} x2={x(hoverT)} y1={f.pad.t} y2={f.pad.t + plotH} stroke="var(--color-content-subtle)" strokeDasharray="2 3" />
                    {series.map((s) => {
                      const p = s.points.find((q) => q[0] === hoverT)
                      return p ? <circle key={s.name} cx={x(p[0])} cy={y(p[1])} r="4" fill={s.color} stroke="var(--color-surface-raised)" strokeWidth="2" /> : null
                    })}
                  </g>
                )
                : null}
            </svg>
          )
          : null}
        {hoverT != null && hasData
          ? (
            <Tooltip x={x(hoverT)} width={width}>
              <div className="mb-0.5 text-content-subtle">{formatX(hoverT)}</div>
              {series.map((s) => {
                const p = s.points.find((q) => q[0] === hoverT)
                return p
                  ? (
                    <div key={s.name} className="flex items-center gap-1.5 whitespace-nowrap">
                      <span className="inline-block h-0.5 w-2.5 rounded" style={{ background: s.color }} />
                      <span className="text-content-muted">{s.name}</span>
                      <span className="ml-auto pl-2 font-medium tabular-nums">{formatY(p[1])}</span>
                    </div>
                  )
                  : null
              })}
            </Tooltip>
          )
          : null}
      </div>
    </div>
  )
}

/** Stacked columns per time bucket (first series at the base). */
export function ColumnChart({
  series,
  height = 160,
  formatY = (v) => String(Math.round(v)),
  formatX = fmtDay,
  emptyLabel = 'No data in this range.',
  showLegend = true,
}: {
  series: Series[]
  height?: number
  formatY?(v: number): string
  formatX?(t: number): string
  emptyLabel?: string
  showLegend?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [hover, setHover] = useState<number | null>(null)
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b)
  const valueAt = (s: Series, t: number) => s.points.find((p) => p[0] === t)?.[1] ?? 0
  const totals = times.map((t) => series.reduce((a, s) => a + valueAt(s, t), 0))
  const any = totals.some((v) => v > 0)
  const top = Math.max(2, niceMax(Math.max(...totals, 0) * 1.05))
  const f: Frame = { width, height, pad: { l: 36, r: 6, t: 8, b: 20 } }
  const plotW = Math.max(1, width - f.pad.l - f.pad.r)
  const plotH = height - f.pad.t - f.pad.b
  const slot = plotW / Math.max(1, times.length)
  const barW = Math.max(1, Math.min(28, slot - Math.max(1, Math.min(4, slot * 0.3))))
  const y = (v: number) => (v / top) * plotH
  return (
    <div className="space-y-2">
      {showLegend ? <Legend items={series} /> : null}
      <div ref={ref} className="relative" style={{ height }}>
        {!any ? <Empty height={height} label={emptyLabel} /> : width > 0
          ? (
            <svg width={width} height={height} className="block" onMouseLeave={() => setHover(null)} role="img">
              <Axes f={f} top={top} x0={times[0]} x1={times[times.length - 1]} formatY={formatY} formatX={formatX} ticks={Math.min(4, Math.max(1, times.length - 1))} />
              {times.map((t, i) => {
                let base = f.pad.t + plotH
                const cx = f.pad.l + slot * i + slot / 2
                return (
                  <g key={t} onMouseEnter={() => setHover(i)}>
                    <rect x={f.pad.l + slot * i} y={f.pad.t} width={slot} height={plotH} fill={hover === i ? 'var(--color-surface-sunken)' : 'transparent'} />
                    {series.map((s, si) => {
                      const v = valueAt(s, t)
                      if (v <= 0) return null
                      const h = Math.max(1, y(v))
                      base -= h
                      const isTop = series.slice(si + 1).every((o) => valueAt(o, t) <= 0)
                      return (
                        <rect
                          key={s.name}
                          x={cx - barW / 2}
                          y={base}
                          width={barW}
                          height={Math.max(1, h - (isTop ? 0 : 1))}
                          rx={isTop ? Math.min(2, barW / 2) : 0}
                          fill={s.color}
                        />
                      )
                    })}
                  </g>
                )
              })}
            </svg>
          )
          : null}
        {hover != null && any
          ? (
            <Tooltip x={f.pad.l + slot * hover + slot / 2} width={width}>
              <div className="mb-0.5 text-content-subtle">{formatX(times[hover])}</div>
              {series.map((s) => (
                <div key={s.name} className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="inline-block size-2 rounded-sm" style={{ background: s.color }} />
                  <span className="text-content-muted">{s.name}</span>
                  <span className="ml-auto pl-2 font-medium tabular-nums">{formatY(valueAt(s, times[hover]))}</span>
                </div>
              ))}
            </Tooltip>
          )
          : null}
      </div>
    </div>
  )
}

/** Ranked horizontal bars (HTML — wraps on phones, labels in text colours). */
export function RankBars({
  rows,
  format,
  color,
  empty = 'Nothing to rank.',
  onSelect,
}: {
  rows: Array<{ key: string; label: ReactNode; value: number; sub?: ReactNode; href?: string }>
  format(v: number): string
  color: string
  empty?: string
  onSelect?(key: string): void
}) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 0)
  if (!rows.length) return <p className="py-4 text-center text-xs text-content-subtle">{empty}</p>
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate text-content">{r.label}</span>
              <span className="shrink-0 tabular-nums text-content">{format(r.value)}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-surface-sunken">
              <div className="h-1.5 rounded-full" style={{ width: `${max ? Math.max(1, (Math.abs(r.value) / max) * 100) : 0}%`, background: color }} />
            </div>
            {r.sub ? <div className="mt-0.5 text-[11px] text-content-subtle">{r.sub}</div> : null}
          </>
        )
        return (
          <li key={r.key}>
            {onSelect
              ? (
                <button type="button" onClick={() => onSelect(r.key)} className="block w-full rounded-md text-left hover:bg-surface-sunken/60">
                  {inner}
                </button>
              )
              : r.href
              ? <a href={r.href} className="block rounded-md hover:bg-surface-sunken/60">{inner}</a>
              : inner}
          </li>
        )
      })}
    </ul>
  )
}

/** Categorical columns (distribution bins). */
export function BinChart({ bins, color, height = 140, unit = 'changes' }: { bins: Array<{ label: string; count: number }>; color: string; height?: number; unit?: string }) {
  const max = Math.max(...bins.map((b) => b.count), 0)
  const [hover, setHover] = useState<number | null>(null)
  if (!max) return <Empty height={height} label="No samples in this range." />
  return (
    <div className="flex items-end gap-1.5" style={{ height }} onMouseLeave={() => setHover(null)}>
      {bins.map((b, i) => (
        <div key={b.label} className="relative flex h-full min-w-0 flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
          {hover === i
            ? (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] text-content shadow-md">
                {b.label}: <span className="font-medium tabular-nums">{b.count}</span> {unit}
              </div>
            )
            : null}
          <div className="text-center text-[10px] tabular-nums text-content-muted">{b.count || ''}</div>
          <div className="rounded-t-[3px]" style={{ height: `${(b.count / max) * (height - 34)}px`, minHeight: b.count ? 2 : 0, background: color, opacity: hover == null || hover === i ? 1 : 0.6 }} />
          <div className="mt-1 truncate text-center text-[10px] text-content-subtle">{b.label}</div>
        </div>
      ))}
    </div>
  )
}

/** A tiny trend line for tiles (no axes; the tile names the series). */
export function Spark({ points, color, height = 28 }: { points: Array<[number, number]>; color: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const p = [...points].sort((a, b) => a[0] - b[0])
  const max = Math.max(...p.map((q) => q[1]), 0) || 1
  const t0 = p[0]?.[0] ?? 0
  const t1 = p[p.length - 1]?.[0] ?? 1
  const x = (t: number) => 1 + ((t - t0) / Math.max(1, t1 - t0)) * (width - 2)
  const y = (v: number) => height - 2 - (v / max) * (height - 4)
  return (
    <div ref={ref} style={{ height }} aria-hidden>
      {width > 0 && p.length > 1
        ? (
          <svg width={width} height={height} className="block">
            <path d={p.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        )
        : null}
    </div>
  )
}

/** A two-part meter (e.g. used vs requested) with its labels in text colours. */
export function Meter({ value, max, color, label }: { value: number; max: number; color: string; label?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div>
      <div className="h-1.5 rounded-full bg-surface-sunken">
        <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      {label ? <div className="mt-1 text-[11px] text-content-muted">{label}</div> : null}
    </div>
  )
}
