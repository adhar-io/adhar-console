import { useMemo, type ReactNode } from 'react'
import { cn } from '@adhar-console/utils'

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
  const max = Math.max(1, ...data.map((d) => d.v))
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
  const max = Math.max(1, ...data.map((d) => d.v))
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
            {data.length} pts · peak {formatY(max)}
          </span>
          <span>{formatY(max)}</span>
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
          return (
            <div key={i} className="group relative flex flex-1 flex-col items-center justify-end">
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
