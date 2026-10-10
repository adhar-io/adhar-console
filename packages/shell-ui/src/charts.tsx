import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '@adhar/utils'
import { chartMax, chartPeak } from './chart-scale.ts'

/**
 * Zero-dep SVG charts used throughout the console.
 *
 * Every chart renders via an explicit viewBox so it scales cleanly to its
 * container — no JavaScript layout, no chart-library bloat, theme-aware via
 * the `--color-brand-*` / `--color-accent-*` design tokens. Line widths +
 * ease-curves follow the same vocabulary as the rest of the shell-ui.
 */

export type SeriesPoint = number | { v: number; t?: number | string; label?: string }

function normalize(points: SeriesPoint[]): Array<{ v: number; label?: string }> {
  return points.map((p) =>
    typeof p === 'number'
      ? { v: p }
      : { v: p.v, label: p.label ?? (p.t ? new Date(p.t).toLocaleTimeString() : undefined) },
  )
}

/* ───────────────────────────────────────────────────── Sparkline ── */

export function Sparkline({
  points,
  color = 'var(--color-brand-500)',
  height = 28,
  width,
  strokeWidth = 1.5,
  className,
}: {
  points: SeriesPoint[]
  color?: string
  height?: number
  /** Omit for a 100% responsive width (svg fills container). */
  width?: number | string
  strokeWidth?: number
  className?: string
}) {
  const data = useMemo(() => normalize(points), [points])
  const W = 120
  const H = height
  if (data.length < 2) {
    return (
      <svg width={width ?? '100%'} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className}>
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke={color} strokeOpacity="0.15" strokeDasharray="3 3" />
      </svg>
    )
  }
  const max = chartMax(data.map((d) => d.v))
  const step = W / (data.length - 1)
  const ys = data.map((d) => H - (d.v / max) * (H - 2) - 1)
  const path = ys.map((y, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y.toFixed(2)}`).join(' ')
  return (
    <svg
      width={width ?? '100%'}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
    >
      <path d={path} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/* ───────────────────────────────────────────────────── AreaChart ── */

export function AreaChart({
  points,
  color = 'var(--color-brand-500)',
  height = 96,
  strokeWidth = 1.5,
  showAxis = true,
  formatY = defaultFormat,
  emptyLabel = 'Awaiting samples…',
  className,
}: {
  points: SeriesPoint[]
  color?: string
  height?: number
  strokeWidth?: number
  /** Render the min/max axis labels under the chart. */
  showAxis?: boolean
  formatY?(v: number): string
  emptyLabel?: string
  className?: string
}) {
  const data = useMemo(() => normalize(points), [points])
  const W = 320
  const H = height
  if (data.length < 2) {
    return (
      <div className={cn('flex h-24 items-center justify-center rounded-lg border border-dashed border-edge-default text-xs text-content-subtle', className)}>
        {emptyLabel}
      </div>
    )
  }
  const values = data.map((d) => d.v)
  // `max` scales the drawing and is never 0; `peak` is what was measured and
  // is what the axis reports — a flat-zero series must not claim a peak of 1.
  const max = chartMax(values)
  const peak = chartPeak(values)
  const step = W / (data.length - 1)
  const ys = data.map((d) => H - (d.v / max) * (H - 6) - 3)
  const path = ys.map((y, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `${path} L${W},${H} L0,${H} Z`
  const uniqueId = useMemo(() => `grad-${Math.random().toString(36).slice(2, 9)}`, [])
  return (
    <div className={className}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={uniqueId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${uniqueId})`} />
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={(data.length - 1) * step} cy={ys[ys.length - 1]} r="2.5" fill={color} />
      </svg>
      {showAxis ? (
        <div className="mt-1 flex items-baseline justify-between text-[10px] text-content-subtle">
          <span>{formatY(0)}</span>
          <span className="tabular-nums">
            {data.length} pts · peak {formatY(peak)}
          </span>
          <span>{formatY(peak)}</span>
        </div>
      ) : null}
    </div>
  )
}

/* ───────────────────────────────────────────────────── BarChart ── */

export function BarChart({
  bars,
  color = 'var(--color-brand-500)',
  height = 96,
  formatY = defaultFormat,
  className,
}: {
  bars: Array<{ label: string; value: number; color?: string }>
  color?: string
  height?: number
  formatY?(v: number): string
  className?: string
}) {
  if (!bars.length) {
    return (
      <div className={cn('flex h-24 items-center justify-center rounded-lg border border-dashed border-edge-default text-xs text-content-subtle', className)}>
        No data
      </div>
    )
  }
  const max = Math.max(1, ...bars.map((b) => b.value))
  return (
    <div className={className}>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {bars.map((b, i) => {
          const h = (b.value / max) * 100
          // `h-full`: the bar's percentage height resolves against this
          // column, and a column without an explicit height collapses every
          // bar to its 3px minimum.
          return (
            <div key={i} className="group relative flex h-full flex-1 flex-col items-center justify-end">
              <div
                className="w-full rounded-t-md transition-[height] duration-500 ease-smooth"
                style={{
                  height: `${h}%`,
                  minHeight: b.value > 0 ? '3px' : '0',
                  backgroundColor: b.color ?? color,
                }}
              />
              <div className="pointer-events-none absolute -top-7 whitespace-nowrap rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 shadow-md transition-opacity group-hover:opacity-100">
                {formatY(b.value)}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-baseline justify-between text-[10px] font-medium uppercase tracking-wider text-content-subtle">
        {bars.map((b, i) => (
          <span key={i} className="flex-1 truncate text-center" title={b.label}>
            {b.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ───────────────────────────────────────────────────── DonutGauge ── */

export function DonutGauge({
  value,
  max = 100,
  size = 120,
  thickness = 12,
  color = 'var(--color-brand-500)',
  trackColor = 'var(--color-edge-default)',
  label,
  caption,
  className,
}: {
  value: number
  max?: number
  size?: number
  thickness?: number
  color?: string
  trackColor?: string
  label?: ReactNode
  caption?: ReactNode
  className?: string
}) {
  const clamped = Math.max(0, Math.min(max, value))
  const pct = (clamped / max) * 100
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  const dash = (pct / 100) * c
  return (
    <div className={cn('relative inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={thickness} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray 500ms cubic-bezier(0.32,0.72,0,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {label ? <div className="text-lg font-semibold tabular-nums text-content">{label}</div> : null}
        {caption ? <div className="text-[10px] font-medium uppercase tracking-wider text-content-subtle">{caption}</div> : null}
      </div>
    </div>
  )
}

/* ───────────────────────────────────────────────────── HeatMap ── */

/**
 * GitHub-style activity heatmap. `cells` is a flat 7×N grid (Sun…Sat rows,
 * left-to-right weeks) with intensity 0–1.
 */
export function HeatMap({
  cells,
  weeks,
  color = 'var(--color-brand-500)',
  cellSize = 11,
  gap = 2,
  className,
}: {
  cells: number[]
  weeks: number
  color?: string
  cellSize?: number
  gap?: number
  className?: string
}) {
  const total = 7 * weeks
  const data = cells.length === total ? cells : [...cells, ...new Array(total - cells.length).fill(0)]
  const w = weeks * (cellSize + gap) - gap
  const h = 7 * (cellSize + gap) - gap
  return (
    <svg width={w} height={h} className={cn('overflow-visible', className)}>
      {data.map((v, i) => {
        const row = i % 7
        const col = Math.floor(i / 7)
        const intensity = Math.max(0, Math.min(1, v))
        const opacity = intensity === 0 ? 0.08 : 0.15 + intensity * 0.85
        return (
          <rect
            key={i}
            x={col * (cellSize + gap)}
            y={row * (cellSize + gap)}
            width={cellSize}
            height={cellSize}
            rx={2}
            fill={color}
            fillOpacity={opacity}
          />
        )
      })}
    </svg>
  )
}

/* ───────────────────────────────────────────────────── LegendDot ── */

export function LegendDot({
  color,
  children,
}: {
  color: string
  children: ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-content-muted">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  )
}

function defaultFormat(v: number) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return String(Math.round(v))
}

/* ───────────────────────────────────────────────── TimeSeriesChart ── */

export interface TimeSeries {
  name: string
  /** Samples as [epoch ms, value]. Gaps are allowed; points are sorted on draw. */
  points: Array<[number, number]>
  color?: string
  /** Draw as a dashed reference line (e.g. "desired replicas") instead of a filled area. */
  dashed?: boolean
}

export interface Threshold {
  value: number
  label?: string
  color?: string
}

/**
 * A proper time-series chart for the metrics surfaces: gridlines, a time
 * axis, a value axis, several series on one plot (filled area for the first,
 * lines for the rest), optional threshold lines and a hover crosshair with a
 * tooltip. Still plain SVG, still theme-aware through tokens, so it costs
 * nothing to ship and looks identical in both modes.
 *
 * Nothing is interpolated: a series only draws where it has samples, so a
 * gap in collection shows as a gap, which is what an operator needs to see.
 */
export function TimeSeriesChart({
  series,
  height = 160,
  formatY = defaultFormat,
  formatTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  thresholds = [],
  yMax,
  emptyLabel = 'Awaiting samples…',
  className,
}: {
  series: TimeSeries[]
  height?: number
  formatY?(v: number): string
  formatTime?(t: number): string
  thresholds?: Threshold[]
  /** Pin the top of the value axis (e.g. 100 for a percentage). */
  yMax?: number
  emptyLabel?: string
  className?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 640
  const H = height
  const PAD = { l: 44, r: 12, t: 10, b: 22 }
  const plotW = W - PAD.l - PAD.r
  const plotH = H - PAD.t - PAD.b

  const data = useMemo(
    () =>
      series.map((s) => ({
        ...s,
        points: [...s.points].filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)).sort((a, b) => a[0] - b[0]),
      })),
    [series],
  )
  const all = data.flatMap((s) => s.points)
  const gradId = useMemo(() => `ts-${Math.random().toString(36).slice(2, 9)}`, [])
  if (all.length < 2) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-lg border border-dashed border-edge-default text-xs text-content-subtle',
          className,
        )}
        style={{ height }}
      >
        {emptyLabel}
      </div>
    )
  }
  const t0 = Math.min(...all.map((p) => p[0]))
  const t1 = Math.max(...all.map((p) => p[0]))
  const span = Math.max(1, t1 - t0)
  const peak = Math.max(chartPeak(all.map((p) => p[1])), ...thresholds.map((th) => th.value))
  const top = yMax ?? niceCeil(peak || 1)
  const x = (t: number) => PAD.l + ((t - t0) / span) * plotW
  const y = (v: number) => PAD.t + plotH - (Math.min(v, top) / top) * plotH
  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top)
  const tickCount = 4
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => t0 + (span * i) / tickCount)

  const pathOf = (pts: Array<[number, number]>) =>
    pts.map(([t, v], i) => `${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')

  // Hover: nearest sample of the primary series by time.
  const primary = data[0]
  const hoverT = hover === null ? null : t0 + ((hover - PAD.l) / plotW) * span
  const nearest = (pts: Array<[number, number]>, t: number) => {
    let best = pts[0]
    for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p
    return best
  }
  const hoverPts = hoverT === null ? [] : data.filter((s) => s.points.length).map((s) => ({ s, p: nearest(s.points, hoverT) }))
  const hoverX = hoverPts.length ? x(hoverPts[0].p[0]) : null

  return (
    <div className={cn('relative', className)}>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block"
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = ((e.clientX - r.left) / r.width) * W
          setHover(px < PAD.l || px > W - PAD.r ? null : px)
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={primary.color ?? 'var(--color-brand-500)'} stopOpacity="0.28" />
            <stop offset="100%" stopColor={primary.color ?? 'var(--color-brand-500)'} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* gridlines + value axis */}
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--color-edge-default)" strokeWidth="1" strokeDasharray={v === 0 ? undefined : '3 4'} />
            <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">
              {formatY(v)}
            </text>
          </g>
        ))}
        {/* time axis */}
        {ticks.map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={H - 6}
            textAnchor={i === 0 ? 'start' : i === tickCount ? 'end' : 'middle'}
            fontSize="9"
            fill="var(--color-content-subtle)"
            fontFamily="var(--font-mono)"
          >
            {formatTime(t)}
          </text>
        ))}
        {/* thresholds */}
        {thresholds.map((th) => (
          <g key={th.label ?? th.value}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(th.value)} y2={y(th.value)} stroke={th.color ?? 'var(--color-rose-500, #f43f5e)'} strokeWidth="1" strokeDasharray="4 3" strokeOpacity="0.8" />
            {th.label ? (
              <text x={W - PAD.r - 2} y={y(th.value) - 3} textAnchor="end" fontSize="9" fill={th.color ?? 'var(--color-rose-500, #f43f5e)'} fontFamily="var(--font-mono)">
                {th.label}
              </text>
            ) : null}
          </g>
        ))}
        {/* series */}
        {data.map((s, i) => {
          if (s.points.length < 2) return null
          const color = s.color ?? (i === 0 ? 'var(--color-brand-500)' : 'var(--color-accent-500)')
          const d = pathOf(s.points)
          const first = s.points[0]
          const last = s.points[s.points.length - 1]
          return (
            <g key={s.name}>
              {i === 0 && !s.dashed ? <path d={`${d} L${x(last[0]).toFixed(1)},${(PAD.t + plotH).toFixed(1)} L${x(first[0]).toFixed(1)},${(PAD.t + plotH).toFixed(1)} Z`} fill={`url(#${gradId})`} /> : null}
              <path d={d} fill="none" stroke={color} strokeWidth={s.dashed ? 1.25 : 1.75} strokeDasharray={s.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              {!s.dashed ? <circle cx={x(last[0])} cy={y(last[1])} r="3" fill={color} /> : null}
            </g>
          )
        })}
        {/* crosshair */}
        {hoverX !== null ? (
          <g>
            <line x1={hoverX} x2={hoverX} y1={PAD.t} y2={PAD.t + plotH} stroke="var(--color-content-subtle)" strokeWidth="1" strokeDasharray="2 3" />
            {hoverPts.map(({ s, p }, i) => (
              <circle key={s.name} cx={x(p[0])} cy={y(p[1])} r="3.5" fill={s.color ?? (i === 0 ? 'var(--color-brand-500)' : 'var(--color-accent-500)')} stroke="var(--color-surface-raised)" strokeWidth="1.5" />
            ))}
          </g>
        ) : null}
      </svg>
      {hoverPts.length ? (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-md border border-edge-default bg-surface-raised/95 px-2 py-1 font-mono text-[10px] text-content shadow-md backdrop-blur"
          style={{ left: `${Math.min(92, Math.max(8, ((hoverX ?? 0) / W) * 100))}%`, transform: 'translateX(-50%)' }}
        >
          <div className="text-content-subtle">{new Date(hoverPts[0].p[0]).toLocaleTimeString()}</div>
          {hoverPts.map(({ s, p }, i) => (
            <div key={s.name} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: s.color ?? (i === 0 ? 'var(--color-brand-500)' : 'var(--color-accent-500)') }} />
              <span className="text-content-muted">{s.name}</span>
              <span className="tabular-nums">{formatY(p[1])}</span>
            </div>
          ))}
        </div>
      ) : null}
      {data.length > 1 ? (
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-content-subtle">
          {data.map((s, i) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className={cn('inline-block h-0.5 w-3', s.dashed && 'border-t border-dashed bg-transparent')} style={s.dashed ? { borderColor: s.color ?? 'var(--color-accent-500)' } : { backgroundColor: s.color ?? (i === 0 ? 'var(--color-brand-500)' : 'var(--color-accent-500)') }} />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Round a chart ceiling up to a tidy number (1, 2, 2.5, 5 × 10ⁿ). */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  const m = v / base
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return step * base
}
