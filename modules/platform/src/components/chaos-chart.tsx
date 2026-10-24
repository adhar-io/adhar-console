import { useMemo, useRef, useState } from 'react'
import { useElementWidth } from '@adhar/shell-ui'
import { type ChartBand, chartScale, cn, formatMetric, type MetricPoint, type MetricUnit, type PhaseKind, segments } from '@adhar/utils'

/**
 * A time-series chart for chaos runs: the metric as a line (with a soft
 * area), the run's phases as shaded bands behind it — faults rose, recovery
 * amber, the load test indigo — so a dip reads against the fault that caused
 * it. Same geometry as the HTML and PDF reports (`chartScale` in
 * `@adhar/utils`), drawn with theme tokens so it holds in dark mode.
 *
 * Several series can share one chart (two runs overlaid); the first is filled.
 */

export const METRIC_TOKEN: Record<string, string> = {
  rps: 'var(--color-brand-500)',
  errors: 'var(--color-rose-500, #f43f5e)',
  p95: 'var(--color-amber-500, #f59e0b)',
  probe: 'var(--color-teal-500, #14b8a6)',
  ready: 'var(--color-emerald-500, #10b981)',
  restarts: 'var(--color-orange-500, #f97316)',
  cpu: 'var(--color-sky-500, #0ea5e9)',
  memory: 'var(--color-violet-500, #8b5cf6)',
}

export const BAND_TOKEN: Record<PhaseKind, string> = {
  fault: 'var(--color-rose-500, #f43f5e)',
  recovery: 'var(--color-amber-500, #f59e0b)',
  load: 'var(--color-brand-500)',
  prepare: 'var(--color-slate-400, #94a3b8)',
  pause: 'var(--color-slate-400, #94a3b8)',
  revert: 'var(--color-slate-500, #64748b)',
}

export const BAND_LABEL: Record<PhaseKind, string> = {
  fault: 'Fault injected',
  recovery: 'Recovering',
  load: 'Load test',
  prepare: 'Preparing',
  pause: 'Pause',
  revert: 'Revert',
}

export interface ChartLine {
  name: string
  points: MetricPoint[]
  color: string
  dashed?: boolean
}

export function ChaosChart({
  lines,
  unit,
  domain,
  bands = [],
  height = 132,
  yMax,
  now,
  formatX = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  emptyLabel = 'No samples yet',
  className,
}: {
  lines: ChartLine[]
  unit: MetricUnit
  domain?: [number, number]
  bands?: ChartBand[]
  height?: number
  yMax?: number
  /** Draws a "now" marker for a live run. */
  now?: number
  formatX?(t: number): string
  emptyLabel?: string
  className?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  // The viewBox is the element's real width, so axis text renders at its
  // real size instead of being squeezed with the plot.
  const box = useRef<HTMLDivElement>(null)
  const measured = useElementWidth(box)
  const W = measured > 0 ? Math.round(measured) : 560
  const H = height
  const frame = { width: W, height: H, pad: { l: 48, r: 8, t: 8, b: 20 } }
  const data = useMemo(() => lines.map((l) => ({ ...l, points: l.points.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && (!domain || (t >= domain[0] && t <= domain[1]))) })), [lines, domain])
  const scale = data.some((l) => l.points.length > 1) ? chartScale(data.map((l) => l.points), frame, { domain, yMax }) : undefined
  const gradId = useMemo(() => `cc-${Math.random().toString(36).slice(2, 9)}`, [])

  if (!scale) {
    return (
      <div ref={box} className={cn('flex items-center justify-center rounded-lg bg-surface-sunken/60 px-4 text-center text-[11px] text-content-subtle', className)} style={{ height }}>
        {emptyLabel}
      </div>
    )
  }
  const plotB = H - frame.pad.b
  const primary = data.find((l) => l.points.length > 1)!
  const hoverT = hover === null ? null : scale.t0 + ((hover - frame.pad.l) / (W - frame.pad.l - frame.pad.r)) * (scale.t1 - scale.t0)
  const nearest = (pts: MetricPoint[], t: number) => pts.reduce((best, p) => (Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best), pts[0])
  const hovered = hoverT === null ? [] : data.filter((l) => l.points.length).map((l) => ({ l, p: nearest(l.points, hoverT) }))
  const hx = hovered.length ? scale.x(hovered[0].p[0]) : null

  return (
    <div ref={box} className={cn('relative', className)}>
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block"
        role="img"
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = ((e.clientX - r.left) / r.width) * W
          setHover(px < frame.pad.l || px > W - frame.pad.r ? null : px)
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={primary.color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={primary.color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {bands.map((b, i) => (
          <rect
            key={`${b.kind}-${i}`}
            x={scale.x(b.start)}
            y={frame.pad.t}
            width={Math.max(1, scale.x(b.end) - scale.x(b.start))}
            height={plotB - frame.pad.t}
            fill={BAND_TOKEN[b.kind]}
            fillOpacity={b.kind === 'load' ? 0.07 : 0.12}
          >
            <title>{`${BAND_LABEL[b.kind]}${b.label ? ` · ${b.label}` : ''}`}</title>
          </rect>
        ))}
        {scale.yTicks.map((v, i) => (
          <g key={v}>
            <line x1={frame.pad.l} x2={W - frame.pad.r} y1={scale.y(v)} y2={scale.y(v)} stroke="var(--color-edge-default)" strokeDasharray={i === 0 ? undefined : '3 4'} />
            <text x={frame.pad.l - 6} y={scale.y(v) + 3} textAnchor="end" fontSize="10" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">
              {formatMetric(v, unit)}
            </text>
          </g>
        ))}
        {scale.xTicks.map((t, i) => (
          <text
            key={i}
            x={scale.x(t)}
            y={H - 5}
            textAnchor={i === 0 ? 'start' : i === scale.xTicks.length - 1 ? 'end' : 'middle'}
            fontSize="10"
            fill="var(--color-content-subtle)"
            fontFamily="var(--font-mono)"
          >
            {formatX(t)}
          </text>
        ))}
        {data.map((l, li) =>
          segments(l.points).filter((s) => s.length > 1).map((seg, si) => {
            const d = seg.map(([t, v], i) => `${i ? 'L' : 'M'}${scale.x(t).toFixed(1)},${scale.y(v).toFixed(1)}`).join(' ')
            return (
              <g key={`${l.name}-${si}`}>
                {li === 0 && !l.dashed ? <path d={`${d} L${scale.x(seg[seg.length - 1][0]).toFixed(1)},${plotB} L${scale.x(seg[0][0]).toFixed(1)},${plotB} Z`} fill={`url(#${gradId})`} /> : null}
                <path d={d} fill="none" stroke={l.color} strokeWidth={l.dashed ? 1.4 : 1.8} strokeDasharray={l.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </g>
            )
          })
        )}
        {now !== undefined && now >= scale.t0 && now <= scale.t1 ? (
          <line x1={scale.x(now)} x2={scale.x(now)} y1={frame.pad.t} y2={plotB} stroke="var(--color-content-subtle)" strokeDasharray="2 3" />
        ) : null}
        {hx !== null ? (
          <g>
            <line x1={hx} x2={hx} y1={frame.pad.t} y2={plotB} stroke="var(--color-content-muted)" strokeDasharray="2 3" />
            {hovered.map(({ l, p }) => <circle key={l.name} cx={scale.x(p[0])} cy={scale.y(p[1])} r="3.5" fill={l.color} stroke="var(--color-surface-raised)" strokeWidth="1.5" />)}
          </g>
        ) : null}
      </svg>
      {hovered.length && hx !== null ? (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-md border border-edge-default bg-surface-raised/95 px-2 py-1 font-mono text-[10px] text-content shadow-md backdrop-blur"
          style={{ left: `${Math.min(88, Math.max(12, (hx / W) * 100))}%`, transform: 'translateX(-50%)' }}
        >
          <div className="text-content-subtle">{formatX(hovered[0].p[0])}</div>
          {hovered.map(({ l, p }) => (
            <div key={l.name} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: l.color }} />
              {lines.length > 1 ? <span className="text-content-muted">{l.name}</span> : null}
              <span className="tabular-nums">{formatMetric(p[1], unit)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The legend for the phase bands that are actually on the charts. */
export function BandLegend({ bands, className }: { bands: ChartBand[]; className?: string }) {
  const kinds = [...new Set(bands.map((b) => b.kind))]
  if (!kinds.length) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-muted', className)}>
      {kinds.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: BAND_TOKEN[k], opacity: 0.45 }} />
          {BAND_LABEL[k]}
        </span>
      ))}
    </div>
  )
}
