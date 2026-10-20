import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useElementWidth } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'

/**
 * Define's report charts (adapted from Decide's `viz.tsx`; copied, not
 * imported — modules don't share source).
 *
 * Drawn at the container's measured pixel width and a FIXED pixel height so
 * text stays 10–11 px at any width (shell-ui's TimeSeriesChart scales its
 * text with width). Thin marks, recessive grid, one y-axis, hover tooltips,
 * a legend whenever there are ≥ 2 series, and labels in text colours — never
 * in the series colour.
 *
 * Categorical slots are the validated reference palette in its fixed order
 * (blue, orange, aqua, yellow, magenta, green, violet, red — adjacent pairs
 * pass the CVD and normal-vision gates in both modes), stepped separately for
 * dark mode. Scatter / all-pairs forms use at most the first three slots.
 */

const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']

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

/** Categorical colour for slot `i`; past the eighth slot everything is "other" grey. */
export function useSeriesColor(): (i: number) => string {
  const dark = useIsDark()
  return (i: number) => (i < 8 ? (dark ? SERIES_DARK : SERIES_LIGHT)[i] : 'var(--color-content-subtle)')
}

export const MUTED = 'var(--color-content-subtle)'

export interface Series {
  name: string
  points: Array<[number, number]>
  color: string
  dashed?: boolean
}

export const fmtDay = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })
const fmtNum = (v: number) => (Math.abs(v) >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1))

function niceMax(v: number): number {
  if (!(v > 0)) return 2
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 2 ? 2 : n <= 4 ? 4 : n <= 6 ? 6 : n <= 8 ? 8 : 10) * p
}

export function Legend({ items, className }: { items: Array<{ name: string; color: string; dashed?: boolean; swatch?: 'line' | 'box' | 'dot' }>; className?: string }) {
  if (items.length < 2) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-content-muted', className)}>
      {items.map((s) => (
        <span key={s.name} className="inline-flex items-center gap-1.5">
          {s.swatch === 'box'
            ? <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />
            : s.swatch === 'dot'
            ? <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
            : (
              <svg width="14" height="8" aria-hidden>
                <line x1="1" x2="13" y1="4" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '3 2' : undefined} strokeLinecap="round" />
              </svg>
            )}
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
  const plotW = f.width - f.pad.l - f.pad.r
  const xs = Array.from({ length: ticks + 1 }, (_, i) => x0 + ((x1 - x0) * i) / ticks)
  return (
    <g>
      {[0, 0.5, 1].map((fr) => (
        <g key={fr}>
          <line x1={f.pad.l} x2={f.width - f.pad.r} y1={y(fr * top)} y2={y(fr * top)} stroke="var(--color-edge-default)" strokeWidth="1" strokeDasharray={fr === 0 ? undefined : '2 4'} />
          <text x={f.pad.l - 6} y={y(fr * top) + 3} textAnchor="end" fontSize="10" fill="var(--color-content-subtle)">{formatY(fr * top)}</text>
        </g>
      ))}
      {plotW > 160 &&
        xs.map((t, i) => (
          <text key={i} x={f.pad.l + (plotW * i) / ticks} y={f.height - 4} textAnchor={i === 0 ? 'start' : i === ticks ? 'end' : 'middle'} fontSize="10" fill="var(--color-content-subtle)">
            {formatX(t)}
          </text>
        ))}
    </g>
  )
}

function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 80), Math.max(80, width - 80))
  return (
    <div className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-edge-default bg-surface-raised px-2 py-1.5 text-[11px] text-content shadow-md" style={{ left }}>
      {children}
    </div>
  )
}

function TipRow({ color, name, value, box }: { color: string; name: ReactNode; value: ReactNode; box?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      <span className={box ? 'inline-block size-2 rounded-sm' : 'inline-block h-0.5 w-2.5 rounded'} style={{ background: color }} />
      <span className="text-content-muted">{name}</span>
      <span className="ml-auto pl-2 font-medium tabular-nums">{value}</span>
    </div>
  )
}

export function ChartEmpty({ height, label }: { height: number; label: ReactNode }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-edge-default px-3 text-center text-xs text-content-subtle" style={{ height }}>
      {label}
    </div>
  )
}

/* ───── line chart ───── */

export function LineChart({
  series,
  height = 200,
  formatY = fmtNum,
  formatX = fmtDay,
  domain,
  yMax,
  refLines = [],
  emptyLabel = 'No data in this range.',
  showLegend = true,
  ariaLabel,
}: {
  series: Series[]
  height?: number
  formatY?(v: number): string
  formatX?(t: number): string
  domain?: [number, number]
  yMax?: number
  refLines?: Array<{ value: number; label: string }>
  emptyLabel?: ReactNode
  showLegend?: boolean
  ariaLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [hover, setHover] = useState<number | null>(null)
  const pts = series.flatMap((s) => s.points)
  const hasData = pts.length > 0
  const x0 = domain?.[0] ?? Math.min(...pts.map((p) => p[0]))
  const x1 = domain?.[1] ?? Math.max(...pts.map((p) => p[0]))
  const top = yMax ?? niceMax(Math.max(...pts.map((p) => p[1]), ...refLines.map((r) => r.value), 0) * 1.05)
  const f: Frame = { width, height, pad: { l: 40, r: 10, t: 10, b: 20 } }
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
        {!hasData ? <ChartEmpty height={height} label={emptyLabel} /> : width > 0
          ? (
            <svg width={width} height={height} className="block" role="img" aria-label={ariaLabel} onMouseMove={(e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)} onMouseLeave={() => setHover(null)}>
              <Axes f={f} top={top} x0={x0} x1={x1} formatY={formatY} formatX={formatX} />
              {refLines.map((r) => (
                <g key={r.label}>
                  <line x1={f.pad.l} x2={width - f.pad.r} y1={y(r.value)} y2={y(r.value)} stroke="var(--color-content-subtle)" strokeDasharray="4 3" strokeWidth="1" />
                  <text x={width - f.pad.r - 2} y={y(r.value) - 3} textAnchor="end" fontSize="10" fill="var(--color-content-muted)">{r.label}</text>
                </g>
              ))}
              {series.map((s) => {
                const p = [...s.points].sort((a, b) => a[0] - b[0])
                if (!p.length) return null
                if (p.length === 1) return <circle key={s.name} cx={x(p[0][0])} cy={y(p[0][1])} r="3" fill={s.color} />
                return <path key={s.name} d={p.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
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
                return p ? <TipRow key={s.name} color={s.color} name={s.name} value={formatY(p[1])} /> : null
              })}
            </Tooltip>
          )
          : null}
      </div>
    </div>
  )
}

/* ───── stacked columns on a time axis ───── */

export function ColumnChart({
  series,
  height = 180,
  formatY = fmtNum,
  formatX = fmtDay,
  emptyLabel = 'No data in this range.',
  showLegend = true,
}: {
  series: Series[]
  height?: number
  formatY?(v: number): string
  formatX?(t: number): string
  emptyLabel?: ReactNode
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
      {showLegend ? <Legend items={series.map((s) => ({ ...s, swatch: 'box' as const }))} /> : null}
      <div ref={ref} className="relative" style={{ height }}>
        {!any ? <ChartEmpty height={height} label={emptyLabel} /> : width > 0
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
                      return <rect key={s.name} x={cx - barW / 2} y={base} width={barW} height={Math.max(1, h - (isTop ? 0 : 2))} rx={isTop ? Math.min(2, barW / 2) : 0} fill={s.color} />
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
              {series.map((s) => <TipRow key={s.name} box color={s.color} name={s.name} value={formatY(valueAt(s, times[hover]))} />)}
            </Tooltip>
          )
          : null}
      </div>
    </div>
  )
}

/* ───── grouped bars on named categories (velocity, sprint comparison) ───── */

export function GroupedBars({
  categories,
  series,
  height = 200,
  formatY = fmtNum,
  emptyLabel = 'Nothing to compare yet.',
}: {
  categories: string[]
  series: Array<{ name: string; color: string; values: number[] }>
  height?: number
  formatY?(v: number): string
  emptyLabel?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(0, ...series.flatMap((s) => s.values))
  const top = niceMax(max * 1.05)
  const f: Frame = { width, height, pad: { l: 36, r: 6, t: 8, b: 22 } }
  const plotW = Math.max(1, width - f.pad.l - f.pad.r)
  const plotH = height - f.pad.t - f.pad.b
  const slot = plotW / Math.max(1, categories.length)
  const inner = Math.min(slot * 0.75, series.length * 22)
  const bw = Math.max(2, inner / Math.max(1, series.length) - 2)
  const yv = (v: number) => f.pad.t + plotH - (v / top) * plotH
  return (
    <div className="space-y-2">
      <Legend items={series.map((s) => ({ name: s.name, color: s.color, swatch: 'box' as const }))} />
      <div ref={ref} className="relative" style={{ height }}>
        {!categories.length || max <= 0 ? <ChartEmpty height={height} label={emptyLabel} /> : width > 0
          ? (
            <svg width={width} height={height} className="block" onMouseLeave={() => setHover(null)} role="img">
              {[0, 0.5, 1].map((fr) => (
                <g key={fr}>
                  <line x1={f.pad.l} x2={width - f.pad.r} y1={yv(fr * top)} y2={yv(fr * top)} stroke="var(--color-edge-default)" strokeDasharray={fr ? '2 4' : undefined} />
                  <text x={f.pad.l - 6} y={yv(fr * top) + 3} textAnchor="end" fontSize="10" fill="var(--color-content-subtle)">{formatY(fr * top)}</text>
                </g>
              ))}
              {categories.map((c, i) => {
                const x0 = f.pad.l + slot * i + (slot - inner) / 2
                return (
                  <g key={c + i} onMouseEnter={() => setHover(i)}>
                    <rect x={f.pad.l + slot * i} y={f.pad.t} width={slot} height={plotH} fill={hover === i ? 'var(--color-surface-sunken)' : 'transparent'} />
                    {series.map((s, si) => {
                      const v = s.values[i] ?? 0
                      const h = Math.max(v > 0 ? 1 : 0, (v / top) * plotH)
                      return <rect key={s.name} x={x0 + si * (bw + 2)} y={f.pad.t + plotH - h} width={bw} height={h} rx={Math.min(2, bw / 2)} fill={s.color} />
                    })}
                    {slot > 36
                      ? (
                        <text x={f.pad.l + slot * i + slot / 2} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--color-content-subtle)">
                          {c.length > Math.floor(slot / 6) ? `${c.slice(0, Math.max(3, Math.floor(slot / 6) - 1))}…` : c}
                        </text>
                      )
                      : null}
                  </g>
                )
              })}
            </svg>
          )
          : null}
        {hover != null
          ? (
            <Tooltip x={f.pad.l + slot * hover + slot / 2} width={width}>
              <div className="mb-0.5 text-content-subtle">{categories[hover]}</div>
              {series.map((s) => <TipRow key={s.name} box color={s.color} name={s.name} value={formatY(s.values[hover] ?? 0)} />)}
            </Tooltip>
          )
          : null}
      </div>
    </div>
  )
}

/* ───── stacked area (cumulative flow) ───── */

export function StackedArea({
  series,
  height = 240,
  formatY = fmtNum,
  formatX = fmtDay,
  emptyLabel = 'No history yet.',
}: {
  /** Bottom series first. All series share the same timestamps. */
  series: Series[]
  height?: number
  formatY?(v: number): string
  formatX?(t: number): string
  emptyLabel?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [hover, setHover] = useState<number | null>(null)
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b)
  const valueAt = (s: Series, t: number) => s.points.find((p) => p[0] === t)?.[1] ?? 0
  const stacks = times.map((t) => {
    let acc = 0
    return series.map((s) => {
      const lo = acc
      acc += valueAt(s, t)
      return [lo, acc] as [number, number]
    })
  })
  const top = niceMax(Math.max(0, ...stacks.map((st) => st[st.length - 1]?.[1] ?? 0)) * 1.05)
  const f: Frame = { width, height, pad: { l: 40, r: 10, t: 10, b: 20 } }
  const plotW = Math.max(1, width - f.pad.l - f.pad.r)
  const plotH = height - f.pad.t - f.pad.b
  const x0 = times[0] ?? 0
  const x1 = times[times.length - 1] ?? 1
  const x = (t: number) => f.pad.l + ((t - x0) / Math.max(1, x1 - x0)) * plotW
  const y = (v: number) => f.pad.t + plotH - (v / top) * plotH
  const hoverIdx = hover == null || !times.length ? null : times.reduce((b, t, i) => (Math.abs(x(t) - hover) < Math.abs(x(times[b]) - hover) ? i : b), 0)
  return (
    <div className="space-y-2">
      <Legend items={[...series].reverse().map((s) => ({ name: s.name, color: s.color, swatch: 'box' as const }))} />
      <div ref={ref} className="relative" style={{ height }}>
        {times.length < 2 ? <ChartEmpty height={height} label={emptyLabel} /> : width > 0
          ? (
            <svg width={width} height={height} className="block" role="img" onMouseMove={(e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)} onMouseLeave={() => setHover(null)}>
              <Axes f={f} top={top} x0={x0} x1={x1} formatY={formatY} formatX={formatX} />
              {series.map((s, si) => {
                const upper = times.map((t, i) => `${x(t).toFixed(1)},${y(stacks[i][si][1]).toFixed(1)}`)
                const lower = times.map((t, i) => `${x(t).toFixed(1)},${y(stacks[i][si][0]).toFixed(1)}`).reverse()
                return <path key={s.name} d={`M${upper.join(' L')} L${lower.join(' L')} Z`} fill={s.color} fillOpacity="0.85" stroke="var(--color-surface-raised)" strokeWidth="1" />
              })}
              {hoverIdx != null ? <line x1={x(times[hoverIdx])} x2={x(times[hoverIdx])} y1={f.pad.t} y2={f.pad.t + plotH} stroke="var(--color-content)" strokeOpacity="0.5" strokeDasharray="2 3" /> : null}
            </svg>
          )
          : null}
        {hoverIdx != null && times.length >= 2
          ? (
            <Tooltip x={x(times[hoverIdx])} width={width}>
              <div className="mb-0.5 text-content-subtle">{formatX(times[hoverIdx])}</div>
              {[...series].reverse().map((s) => <TipRow key={s.name} box color={s.color} name={s.name} value={formatY(valueAt(s, times[hoverIdx]))} />)}
            </Tooltip>
          )
          : null}
      </div>
    </div>
  )
}

/* ───── scatter (control chart) ───── */

export interface ScatterPoint {
  id: string
  t: number
  v: number
  label: ReactNode
}

export function Scatter({
  points,
  line,
  refLines = [],
  color,
  lineColor,
  height = 240,
  formatY = (v) => `${fmtNum(v)}d`,
  formatX = fmtDay,
  emptyLabel = 'Nothing finished in this range.',
  pointName = 'Item',
  lineName = 'Rolling average',
  onSelect,
}: {
  points: ScatterPoint[]
  line?: Array<[number, number]>
  refLines?: Array<{ value: number; label: string }>
  color: string
  lineColor: string
  height?: number
  formatY?(v: number): string
  formatX?(t: number): string
  emptyLabel?: ReactNode
  pointName?: string
  lineName?: string
  onSelect?(id: string): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [hover, setHover] = useState<number | null>(null)
  const top = niceMax(Math.max(0, ...points.map((p) => p.v), ...refLines.map((r) => r.value)) * 1.05)
  const f: Frame = { width, height, pad: { l: 40, r: 10, t: 10, b: 20 } }
  const plotW = Math.max(1, width - f.pad.l - f.pad.r)
  const plotH = height - f.pad.t - f.pad.b
  const t0 = Math.min(...points.map((p) => p.t))
  const t1 = Math.max(...points.map((p) => p.t))
  const pad = Math.max(1, (t1 - t0) * 0.03)
  const x0 = t0 - pad
  const x1 = t1 + pad
  const x = (t: number) => f.pad.l + ((t - x0) / Math.max(1, x1 - x0)) * plotW
  const y = (v: number) => f.pad.t + plotH - (Math.min(v, top) / top) * plotH
  const hp = hover != null ? points[hover] : null
  return (
    <div className="space-y-2">
      <Legend items={[{ name: pointName, color, swatch: 'dot' as const }, ...(line?.length ? [{ name: lineName, color: lineColor }] : [])]} />
      <div ref={ref} className="relative" style={{ height }}>
        {!points.length ? <ChartEmpty height={height} label={emptyLabel} /> : width > 0
          ? (
            <svg width={width} height={height} className="block" role="img" onMouseLeave={() => setHover(null)}>
              <Axes f={f} top={top} x0={x0} x1={x1} formatY={formatY} formatX={formatX} />
              {refLines.map((r) => (
                <g key={r.label}>
                  <line x1={f.pad.l} x2={width - f.pad.r} y1={y(r.value)} y2={y(r.value)} stroke="var(--color-content-subtle)" strokeDasharray="4 3" />
                  <text x={width - f.pad.r - 2} y={y(r.value) - 3} textAnchor="end" fontSize="10" fill="var(--color-content-muted)">{r.label}</text>
                </g>
              ))}
              {line && line.length > 1
                ? <path d={line.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" />
                : null}
              {points.map((p, i) => (
                <g key={p.id} onMouseEnter={() => setHover(i)} onClick={() => onSelect?.(p.id)} className={onSelect ? 'cursor-pointer' : undefined}>
                  <circle cx={x(p.t)} cy={y(p.v)} r="9" fill="transparent" />
                  <circle cx={x(p.t)} cy={y(p.v)} r={hover === i ? 5 : 4} fill={color} fillOpacity={hover == null || hover === i ? 0.9 : 0.5} stroke="var(--color-surface-raised)" strokeWidth="2" />
                </g>
              ))}
            </svg>
          )
          : null}
        {hp
          ? (
            <Tooltip x={x(hp.t)} width={width}>
              <div className="mb-0.5 max-w-56 truncate text-content">{hp.label}</div>
              <div className="text-content-subtle">Done {formatX(hp.t)} · <span className="font-medium text-content">{formatY(hp.v)}</span></div>
            </Tooltip>
          )
          : null}
      </div>
    </div>
  )
}

/* ───── mini burndown (tiles; fixed size, no axes) ───── */

export function MiniBurn({ remaining, ideal, color, width = 140, height = 40 }: { remaining: Array<[number, number]>; ideal: Array<[number, number]>; color: string; width?: number; height?: number }) {
  const all = [...remaining, ...ideal]
  if (all.length < 2) return <div style={{ width, height }} className="rounded bg-surface-sunken/60" aria-hidden />
  const t0 = Math.min(...all.map((p) => p[0]))
  const t1 = Math.max(...all.map((p) => p[0]))
  const max = Math.max(1, ...all.map((p) => p[1]))
  const x = (t: number) => 2 + ((t - t0) / Math.max(1, t1 - t0)) * (width - 4)
  const y = (v: number) => height - 2 - (v / max) * (height - 4)
  const path = (pts: Array<[number, number]>) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} className="block shrink-0" role="img" aria-label="Burndown: remaining work against the ideal line">
      <path d={path(ideal)} fill="none" stroke="var(--color-content-subtle)" strokeWidth="1" strokeDasharray="3 3" />
      {remaining.length > 1 ? <path d={path(remaining)} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" /> : null}
    </svg>
  )
}

/* ───── ranked bars + meter ───── */

export function RankBars({
  rows,
  format,
  color,
  empty = 'Nothing to rank.',
  onSelect,
}: {
  rows: Array<{ key: string; label: ReactNode; value: number; sub?: ReactNode }>
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
              ? <button type="button" onClick={() => onSelect(r.key)} className="block w-full rounded-md px-1 py-0.5 text-left hover:bg-surface-sunken/60">{inner}</button>
              : inner}
          </li>
        )
      })}
    </ul>
  )
}

export function Meter({ value, max = 100, color, label, className }: { value: number; max?: number; color: string; label?: ReactNode; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div className={className}>
      <div className="h-1.5 rounded-full bg-surface-sunken" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      {label ? <div className="mt-1 text-[11px] text-content-muted">{label}</div> : null}
    </div>
  )
}

/** A segmented bar (distribution) with an HTML legend in text colours. */
export function SegmentBar({ parts, onSelect }: { parts: Array<{ key: string; label: string; value: number; color: string }>; onSelect?(key: string): void }) {
  const total = parts.reduce((a, p) => a + p.value, 0)
  if (!total) return <p className="py-3 text-center text-xs text-content-subtle">Nothing here yet.</p>
  return (
    <div className="space-y-2.5">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
        {parts.filter((p) => p.value > 0).map((p) => (
          <div key={p.key} title={`${p.label}: ${p.value}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
        {parts.map((p) => (
          <li key={p.key}>
            <button type="button" disabled={!onSelect} onClick={() => onSelect?.(p.key)} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] hover:bg-surface-sunken/60 disabled:hover:bg-transparent">
              <span className="inline-block size-2 shrink-0 rounded-sm" style={{ background: p.color }} />
              <span className="min-w-0 flex-1 truncate text-content-muted">{p.label}</span>
              <span className="tabular-nums text-content">{p.value}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
