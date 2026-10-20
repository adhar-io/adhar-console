import { useMemo, useState } from 'react'
import { cn } from '@adhar/utils'
import type { metabase } from '@adhar/api-clients'
import {
  type ChartModel,
  formatCompact,
  formatTime,
  formatTimeTick,
  formatValue,
  niceScale,
  type ScalarModel,
  type Slice,
} from '../data/bi-chart.ts'
import { ensureBiStyles, Icon, useWidth, vizColor } from './bi-kit.tsx'

/**
 * The BI chart marks, drawn as SVG at true pixel size (the container is
 * measured, so 11px labels stay 11px on any card width).
 *
 * Conventions: thin marks (2px lines, bars with a 2px gap), one y-axis,
 * recessive dashed gridlines, a legend for two or more series, text in text
 * colours (the swatch carries identity), a hover guide + tooltip on every
 * chart. Series colours come from the validated categorical palette in
 * `bi-kit.tsx`, assigned in order.
 */

export type XYKind = 'line' | 'area' | 'bar' | 'row' | 'combo' | 'scatter'

interface XYProps {
  model: ChartModel
  kind: XYKind
  height: number
  /** Column used to format y values (percent etc.). */
  yCol?: metabase.MbColumn
  stack?: 'stacked' | 'normalized' | null
  /** Per-series display for combo charts (`bar` | `line` | `area`). */
  seriesDisplay?: Record<string, string>
  goal?: { value: number; label?: string } | null
  showLegend?: boolean
  className?: string
}

const AXIS = 'var(--color-content-subtle)'
const GRID = 'var(--bi-grid)'
const BASE = 'var(--color-edge-strong, var(--color-edge-default))'

export function XYChart(props: XYProps) {
  ensureBiStyles()
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const { model, showLegend = true } = props
  const visible = useMemo(() => ({ ...model, series: model.series.filter((s) => !hidden.has(s.key)) }), [model, hidden])
  const legend = showLegend && model.series.length >= 2
  const legendH = legend ? 24 : 0
  const plotH = Math.max(80, props.height - legendH)
  return (
    <div className={cn('flex w-full min-w-0 flex-col', props.className)} style={{ height: props.height }}>
      {legend ? (
        <Legend
          items={model.series.map((s, i) => ({ key: s.key, name: s.name, color: vizColor(i) }))}
          hidden={hidden}
          onToggle={(k) =>
            setHidden((cur) => {
              const next = new Set(cur)
              if (next.has(k)) next.delete(k)
              else if (next.size < model.series.length - 1) next.add(k)
              return next
            })}
        />
      ) : null}
      <div ref={ref} className="relative min-h-0 w-full flex-1">
        {width > 0 ? (
          props.kind === 'row' ? (
            <RowPlot {...props} model={visible} allSeries={model.series} width={width} height={plotH} />
          ) : (
            <ColumnPlot {...props} model={visible} allSeries={model.series} width={width} height={plotH} />
          )
        ) : null}
      </div>
    </div>
  )
}

function Legend({
  items,
  hidden,
  onToggle,
}: {
  items: { key: string; name: string; color: string }[]
  hidden: Set<string>
  onToggle(k: string): void
}) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 overflow-x-auto whitespace-nowrap text-[11px] [scrollbar-width:none]">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onToggle(it.key)}
          aria-pressed={!hidden.has(it.key)}
          title={hidden.has(it.key) ? `Show ${it.name}` : `Hide ${it.name}`}
          className={cn('inline-flex items-center gap-1.5 text-content-muted hover:text-content', hidden.has(it.key) && 'opacity-40')}
        >
          <span className="inline-block h-2 w-2.5 rounded-[2px]" style={{ backgroundColor: it.color }} />
          <span className="max-w-40 truncate">{it.name}</span>
        </button>
      ))}
    </div>
  )
}

type PlotProps = XYProps & { width: number; height: number; allSeries: ChartModel['series'] }

function colorOf(all: ChartModel['series'], key: string): string {
  return vizColor(Math.max(0, all.findIndex((s) => s.key === key)))
}

function xLabel(model: ChartModel, v: number | string, span = 0, tick = false): string {
  if (model.xKind === 'time') return tick ? formatTimeTick(v as number, span, model.unit) : formatTime(v as number, model.unit)
  return String(v)
}

function measure(text: string, px = 11): number {
  return text.length * px * 0.62
}

/** Vertical bars / lines / areas / combo on a shared x. */
function ColumnPlot({ model, kind, width, height, yCol, stack, seriesDisplay, goal, allSeries }: PlotProps) {
  const [hover, setHover] = useState<number | null>(null)
  const n = model.x.length
  const isNorm = stack === 'normalized'
  const stacked = !!stack && (kind === 'bar' || kind === 'area')
  const displayOf = (key: string, i: number): 'bar' | 'line' | 'area' => {
    if (kind === 'combo') {
      const d = seriesDisplay?.[key]
      if (d === 'bar' || d === 'line' || d === 'area') return d
      return i === 0 ? 'bar' : 'line'
    }
    if (kind === 'scatter') return 'line'
    return kind === 'row' ? 'bar' : (kind as 'bar' | 'line' | 'area')
  }

  // Stacked totals / normalisation.
  const totals = model.x.map((_, xi) => model.series.reduce((a, s) => a + Math.abs(s.values[xi] ?? 0), 0))
  const valueAt = (si: number, xi: number): number | null => {
    const v = model.series[si].values[xi]
    if (v == null) return null
    return isNorm ? (totals[xi] ? v / totals[xi] : 0) : v
  }
  let lo = 0
  let hi = 0
  for (let xi = 0; xi < n; xi++) {
    if (stacked) {
      let pos = 0
      let neg = 0
      model.series.forEach((_, si) => {
        const v = valueAt(si, xi) ?? 0
        if (v >= 0) pos += v
        else neg += v
      })
      hi = Math.max(hi, pos)
      lo = Math.min(lo, neg)
    } else {
      model.series.forEach((_, si) => {
        const v = valueAt(si, xi)
        if (v != null) {
          hi = Math.max(hi, v)
          lo = Math.min(lo, v)
        }
      })
    }
  }
  if (goal) hi = Math.max(hi, goal.value)
  const scale = isNorm ? { lo: 0, hi: 1, step: 0.25 } : niceScale(lo, hi)
  const fmtY = (v: number) => (isNorm ? `${Math.round(v * 100)}%` : formatValue(v, yCol, { compact: true }))
  const ticks: number[] = []
  for (let v = scale.lo; v <= scale.hi + scale.step / 2; v += scale.step) ticks.push(+v.toFixed(10))
  // X labels are centred on their tick, so the first and last need half a label of room.
  const xLabels = model.x.map((v) => xLabel(model, v, model.xKind === 'time' && model.x.length > 1 ? (model.x[model.x.length - 1] as number) - (model.x[0] as number) : 0, true))
  const halfLabel = Math.min(48, Math.max(...xLabels.map((l) => measure(l, 10))) / 2)
  const padL = Math.min(72, Math.max(28, halfLabel, ...ticks.map((t) => measure(fmtY(t)) + 10)))
  const padR = Math.max(12, halfLabel)
  const padT = 8
  const padB = 22
  const plotW = Math.max(10, width - padL - padR)
  const plotH = Math.max(10, height - padT - padB)
  const y = (v: number) => padT + plotH - ((v - scale.lo) / (scale.hi - scale.lo || 1)) * plotH

  const hasBars = model.series.some((s, i) => displayOf(s.key, i) === 'bar')
  const timeLinear = model.xKind === 'time' && !hasBars && n > 1
  const t0 = timeLinear ? (model.x[0] as number) : 0
  const t1 = timeLinear ? (model.x[n - 1] as number) : 0
  const band = plotW / Math.max(1, n)
  const x = (xi: number) => (timeLinear ? padL + ((((model.x[xi] as number) - t0) / (t1 - t0 || 1)) * plotW) : padL + band * xi + band / 2)

  // X ticks: as many as fit.
  const labels = xLabels
  const maxLabel = Math.max(24, ...labels.map((l) => measure(l, 10)))
  const every = Math.max(1, Math.ceil((maxLabel + 16) / Math.max(1, timeLinear ? plotW / Math.max(1, n - 1) : band)))
  const tickIdx = model.x.map((_, i) => i).filter((i) => i % every === 0)

  const barSeries = model.series.map((s, i) => ({ s, i })).filter(({ s, i }) => displayOf(s.key, i) === 'bar')
  const groupW = Math.max(2, band * 0.72)
  const barW = stacked ? groupW : Math.max(1, (groupW - (barSeries.length - 1) * 2) / Math.max(1, barSeries.length))
  const zeroY = y(Math.max(scale.lo, Math.min(0, scale.hi)))

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - r.left
    if (px < padL - 4 || px > width - padR + 4) return setHover(null)
    let best = 0
    let bd = Infinity
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - px)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    setHover(best)
  }

  // Stacked bar offsets.
  const stackBase = (si: number, xi: number) => {
    const v = valueAt(si, xi) ?? 0
    let base = 0
    for (let k = 0; k < si; k++) {
      const w = valueAt(k, xi) ?? 0
      if (displayOf(model.series[k].key, k) !== displayOf(model.series[si].key, si)) continue
      if (Math.sign(w) === Math.sign(v) || (v >= 0 && w >= 0)) base += w
    }
    return base
  }

  return (
    <div className="relative h-full w-full">
      <svg width={width} height={height} className="block overflow-visible" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${kind} chart of ${model.yName || model.series.map((s) => s.name).join(', ')} by ${model.xName}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? BASE : GRID} strokeWidth={1} strokeDasharray={t === 0 ? undefined : '2 4'} />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill={AXIS} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmtY(t)}
            </text>
          </g>
        ))}
        {tickIdx.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 6}
            textAnchor="middle"
            fontSize={10}
            fill={AXIS}
          >
            {truncateLabel(labels[i], Math.max(4, Math.floor((band * every - 6) / 6)))}
          </text>
        ))}
        {hover != null ? <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} stroke={AXIS} strokeDasharray="2 3" strokeWidth={1} /> : null}
        {/* bars */}
        {barSeries.map(({ s }, bi) =>
          model.x.map((_, xi) => {
            const v = valueAt(model.series.indexOf(s), xi)
            if (v == null) return null
            const si = model.series.indexOf(s)
            const base = stacked ? stackBase(si, xi) : 0
            const yTop = y(base + v)
            const yBot = y(base)
            const left = stacked ? x(xi) - groupW / 2 : x(xi) - groupW / 2 + bi * (barW + 2)
            const h = Math.abs(yBot - yTop)
            const top = Math.min(yTop, yBot)
            return (
              <path
                key={`${s.key}-${xi}`}
                d={barPath(left, top, barW, Math.max(h, v === 0 ? 0 : 1), v >= 0 ? 'up' : 'down', stacked ? 1 : 3)}
                fill={colorOf(allSeries, s.key)}
                opacity={hover == null || hover === xi ? 1 : 0.55}
                stroke="var(--color-surface-raised)"
                strokeWidth={stacked ? 1 : 0}
              >
                <title>{`${s.name} · ${xLabel(model, model.x[xi])}: ${fmtFull(v, yCol, isNorm)}`}</title>
              </path>
            )
          })
        )}
        {/* lines / areas */}
        {model.series.map((s, si) => {
          const d = displayOf(s.key, allSeries.indexOf(s))
          if (d === 'bar') return null
          const color = colorOf(allSeries, s.key)
          const pts: Array<[number, number] | null> = model.x.map((_, xi) => {
            const v = valueAt(si, xi)
            if (v == null) return null
            const base = stacked && d === 'area' ? stackBase(si, xi) : 0
            return [x(xi), y(base + v)]
          })
          const segs = segments(pts)
          return (
            <g key={s.key}>
              {d === 'area'
                ? segs.map((seg, k) => {
                  const bases = seg.map(([px]) => {
                    const xi = model.x.findIndex((_, j) => Math.abs(x(j) - px) < 0.01)
                    return stacked ? y(stackBase(si, xi)) : zeroY
                  })
                  return (
                    <path
                      key={k}
                      d={`M${seg.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')}L${seg.map(([a], j) => `${a.toFixed(1)},${bases[j].toFixed(1)}`).reverse().join('L')}Z`}
                      fill={color}
                      opacity={0.16}
                    />
                  )
                })
                : null}
              {kind === 'scatter'
                ? null
                : segs.map((seg, k) => (
                  <path key={k} d={`M${seg.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')}`} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                ))}
              {/* Isolated points (a series with gaps) and scatter dots stay visible. */}
              {pts.map((p, xi) => {
                if (!p) return null
                const isolated = kind === 'scatter' || ((xi === 0 || !pts[xi - 1]) && (xi === n - 1 || !pts[xi + 1])) || n <= 24
                const hot = hover === xi
                if (!isolated && !hot) return null
                return <circle key={xi} cx={p[0]} cy={p[1]} r={hot ? 4.5 : kind === 'scatter' ? 4 : 2.5} fill={color} stroke="var(--color-surface-raised)" strokeWidth={hot ? 2 : 1} />
              })}
            </g>
          )
        })}
        {goal ? (
          <g>
            <line x1={padL} x2={width - padR} y1={y(goal.value)} y2={y(goal.value)} stroke="var(--color-content-muted)" strokeDasharray="5 4" strokeWidth={1} />
            <text x={width - padR} y={y(goal.value) - 4} textAnchor="end" fontSize={10} fill="var(--color-content-muted)">
              {goal.label || 'Goal'} {formatValue(goal.value, yCol, { compact: true })}
            </text>
          </g>
        ) : null}
      </svg>
      {hover != null ? (
        <Tooltip
          left={x(hover)}
          width={width}
          title={xLabel(model, model.x[hover])}
          rows={model.series.map((s, si) => ({ name: s.name, color: colorOf(allSeries, s.key), value: valueAt(si, hover) }))}
          format={(v) => fmtFull(v, yCol, isNorm)}
          total={stacked && model.series.length > 1 && !isNorm ? model.series.reduce((a, _, si) => a + (valueAt(si, hover) ?? 0), 0) : undefined}
        />
      ) : null}
    </div>
  )
}

function fmtFull(v: number | null, col?: metabase.MbColumn, norm?: boolean): string {
  if (v == null) return '—'
  if (norm) return `${(v * 100).toFixed(1)}%`
  return formatValue(v, col)
}

function truncateLabel(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s
}

/** A bar whose data-end is rounded and whose baseline end is square. */
function barPath(x: number, y: number, w: number, h: number, dir: 'up' | 'down' | 'right' | 'left', r0 = 3): string {
  const r = Math.max(0, Math.min(r0, w / 2, h))
  if (dir === 'up') return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
  if (dir === 'down') return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`
  const rr = Math.max(0, Math.min(r0, h / 2, w))
  if (dir === 'right') return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`
  return `M${x + w},${y}H${x + rr}Q${x},${y} ${x},${y + rr}V${y + h - rr}Q${x},${y + h} ${x + rr},${y + h}H${x + w}Z`
}

function segments(pts: Array<[number, number] | null>): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = []
  let cur: Array<[number, number]> = []
  for (const p of pts) {
    if (p) cur.push(p)
    else if (cur.length) {
      out.push(cur)
      cur = []
    }
  }
  if (cur.length) out.push(cur)
  return out
}

function Tooltip({
  left,
  width,
  title,
  rows,
  format,
  total,
}: {
  left: number
  width: number
  title: string
  rows: { name: string; color: string; value: number | null }[]
  format(v: number | null): string
  total?: number
}) {
  const flip = left > width * 0.6
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 max-w-64 rounded-md border border-edge-default bg-surface-raised/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur"
      style={flip ? { right: Math.max(4, width - left + 10) } : { left: Math.min(width - 40, left + 10) }}
    >
      <div className="mb-0.5 font-medium text-content">{title}</div>
      {rows.slice(0, 10).map((r) => (
        <div key={r.name} className="flex items-center gap-2 whitespace-nowrap">
          <span className="inline-block h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: r.color }} />
          <span className="min-w-0 flex-1 truncate text-content-muted">{r.name}</span>
          <span className="tabular-nums text-content">{format(r.value)}</span>
        </div>
      ))}
      {rows.length > 10 ? <div className="text-content-subtle">+{rows.length - 10} more</div> : null}
      {total != null ? (
        <div className="mt-0.5 flex justify-between gap-3 border-t border-edge-subtle pt-0.5">
          <span className="text-content-muted">Total</span>
          <span className="tabular-nums text-content">{format(total)}</span>
        </div>
      ) : null}
    </div>
  )
}

/** Horizontal bars — categories down the side, for long labels or many rows. */
function RowPlot({ model, width, height, yCol, allSeries }: PlotProps) {
  const [hover, setHover] = useState<number | null>(null)
  const n = model.x.length
  const labels = model.x.map((v) => xLabel(model, v))
  const padL = Math.min(Math.max(60, width * 0.38), Math.max(...labels.map((l) => measure(l, 11))) + 12)
  const padR = 56
  const plotW = Math.max(10, width - padL - padR)
  const rowH = Math.max(14, Math.min(28, height / Math.max(1, n)))
  const shown = Math.min(n, Math.floor(height / rowH))
  let lo = 0
  let hi = 0
  for (const s of model.series) for (const v of s.values.slice(0, shown)) if (v != null) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)]
  const scale = niceScale(lo, hi)
  const xv = (v: number) => padL + ((v - scale.lo) / (scale.hi - scale.lo || 1)) * plotW
  const per = model.series.length
  const barH = Math.max(3, (rowH * 0.7 - (per - 1) * 2) / per)
  return (
    <div className="relative h-full w-full">
      <svg width={width} height={height} className="block" role="img" aria-label={`Bar chart of ${model.yName} by ${model.xName}`} onMouseLeave={() => setHover(null)}>
        <line x1={xv(0)} x2={xv(0)} y1={0} y2={shown * rowH} stroke={BASE} strokeWidth={1} />
        {labels.slice(0, shown).map((l, i) => (
          <g key={i} onMouseEnter={() => setHover(i)}>
            <rect x={0} y={i * rowH} width={width} height={rowH} fill="transparent" />
            <text x={padL - 8} y={i * rowH + rowH / 2 + 3.5} textAnchor="end" fontSize={11} fill="var(--color-content-muted)">
              {truncateLabel(l, Math.floor((padL - 12) / 6.3))}
            </text>
            {model.series.map((s, si) => {
              const v = s.values[i]
              if (v == null) return null
              const x0 = xv(Math.min(0, v))
              const w = Math.max(1, Math.abs(xv(v) - xv(0)))
              const top = i * rowH + (rowH - (barH * per + (per - 1) * 2)) / 2 + si * (barH + 2)
              return (
                <g key={s.key}>
                  <path d={barPath(x0, top, w, barH, v >= 0 ? 'right' : 'left')} fill={colorOf(allSeries, s.key)} opacity={hover == null || hover === i ? 1 : 0.55} />
                  {per === 1 ? (
                    <text x={xv(v) + (v >= 0 ? 6 : -6)} y={top + barH / 2 + 3.5} textAnchor={v >= 0 ? 'start' : 'end'} fontSize={10.5} fill="var(--color-content)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatValue(v, yCol, { compact: true })}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </g>
        ))}
      </svg>
      {shown < n ? <div className="absolute bottom-0 right-1 text-[10px] text-content-subtle">{n - shown} more rows · view as table</div> : null}
      {hover != null ? (
        <Tooltip
          left={padL + plotW / 2}
          width={width}
          title={labels[hover]}
          rows={model.series.map((s) => ({ name: s.name, color: colorOf(allSeries, s.key), value: s.values[hover] }))}
          format={(v) => formatValue(v, yCol)}
        />
      ) : null}
    </div>
  )
}

/* ─────────── share (pie) ─────────── */

/**
 * Pie charts rendered as a single 100% bar plus a ranked list — shares are
 * compared by length, which reads far more accurately than angles, and every
 * slice keeps a text label and percentage (identity is never colour alone).
 */
export function ShareBars({ slices, col, height }: { slices: Slice[]; col?: metabase.MbColumn; height: number }) {
  ensureBiStyles()
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden" style={{ maxHeight: height }}>
      <div className="flex h-3.5 w-full shrink-0 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Share of total">
        {slices.map((s, i) => (
          <div
            key={s.label}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            title={`${s.label}: ${formatValue(s.value, col)} (${(s.share * 100).toFixed(1)}%)`}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${Math.max(0.4, s.share * 100)}%`, backgroundColor: vizColor(i), opacity: hover == null || hover === i ? 1 : 0.5 }}
          />
        ))}
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1 text-[12px]">
        {slices.map((s, i) => (
          <li key={s.label} className={cn('flex items-center gap-2 rounded px-1 py-0.5', hover === i && 'bg-surface-sunken')} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: vizColor(i) }} />
            <span className="min-w-0 flex-1 truncate text-content">{s.label}</span>
            <span className="tabular-nums text-content-muted">{formatValue(s.value, col, { compact: true })}</span>
            <span className="w-12 text-right font-medium tabular-nums text-content">{(s.share * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ─────────── funnel ─────────── */

export function FunnelBars({ slices, col }: { slices: Slice[]; col?: metabase.MbColumn }) {
  ensureBiStyles()
  // Funnels keep query order, not size order — callers pass the raw steps.
  const first = slices[0]?.value || 1
  return (
    <ul className="space-y-1.5 text-[12px]">
      {slices.map((s, i) => {
        const prev = i > 0 ? slices[i - 1].value : null
        return (
          <li key={s.label}>
            <div className="mb-0.5 flex items-baseline justify-between gap-2">
              <span className="truncate text-content">{s.label}</span>
              <span className="shrink-0 tabular-nums text-content-muted">
                {formatValue(s.value, col, { compact: true })} · {((s.value / first) * 100).toFixed(1)}%
                {prev ? <span className="text-content-subtle"> ({((s.value / prev) * 100).toFixed(0)}% of prev)</span> : null}
              </span>
            </div>
            <div className="h-2.5 w-full rounded-full bg-surface-sunken">
              <div className="h-full rounded-full" style={{ width: `${Math.max(0.5, (s.value / first) * 100)}%`, backgroundColor: vizColor(0) }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/* ─────────── numbers ─────────── */

function scalarText(v: ScalarModel['value'], col: metabase.MbColumn | undefined, compact: boolean): string {
  if (v == null) return '—'
  if (typeof v === 'number') return compact && Math.abs(v) >= 10_000 ? formatValue(v, col, { compact: true }) : formatValue(v, col)
  return formatValue(v, col)
}

export function ScalarView({
  model,
  height,
  prefix,
  suffix,
  compactOverride,
}: {
  model: ScalarModel
  height: number
  prefix?: string
  suffix?: string
  compactOverride?: boolean
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const text = `${prefix ?? ''}${scalarText(model.value, model.col, compactOverride ?? width < 260)}${suffix ?? ''}`
  const size = Math.max(20, Math.min(56, height * 0.42, (width / Math.max(4, text.length)) * 1.6))
  const change = model.change
  // Direction is shown with an arrow + sign + text, never colour alone.
  const up = change != null && change > 0
  const flat = change != null && Math.abs(change) < 0.0005
  return (
    <div ref={ref} className="flex h-full w-full flex-col items-center justify-center gap-1 text-center">
      <div className="font-semibold leading-none tracking-tight text-content" style={{ fontSize: size }} title={model.value == null ? 'No value' : String(model.value)}>
        {text}
      </div>
      {model.period ? <div className="text-[11px] text-content-subtle">{model.period}</div> : null}
      {change != null ? (
        <div className="mt-1 inline-flex flex-wrap items-center justify-center gap-1 text-[12px]">
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium tabular-nums',
              flat ? 'text-content-muted' : up ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300',
            )}
          >
            {flat ? '→' : up ? '▲' : '▼'} {up ? '+' : ''}
            {(change * 100).toFixed(1)}%
          </span>
          <span className="text-content-muted">
            vs {model.previousPeriod ?? 'previous'}
            {model.previous != null ? `: ${formatValue(model.previous, model.col, { compact: true })}` : ''}
          </span>
        </div>
      ) : null}
    </div>
  )
}

export function ProgressView({ value, goal, col }: { value: number | null; goal: number | null; col?: metabase.MbColumn }) {
  ensureBiStyles()
  if (value == null) return <div className="text-sm text-content-muted">No value</div>
  if (!goal) {
    return (
      <div className="flex h-full flex-col justify-center gap-1">
        <div className="text-3xl font-semibold text-content">{formatValue(value, col)}</div>
        <div className="text-[11px] text-content-subtle">No goal set on this card in Metabase</div>
      </div>
    )
  }
  const pct = value / goal
  const met = pct >= 1
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-3xl font-semibold text-content">{formatValue(value, col)}</span>
        <span className="text-[12px] text-content-muted">
          {met ? '✓ Goal met · ' : ''}
          {(pct * 100).toFixed(0)}% of {formatValue(goal, col, { compact: true })}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct * 100)}%`, backgroundColor: vizColor(0) }} />
      </div>
    </div>
  )
}

interface GaugeSegment {
  min: number
  max: number
  label?: string
  color?: string
}

/** Gauge as a segmented meter with a marker — segments carry their own labels. */
export function GaugeView({ value, segments, col }: { value: number | null; segments?: GaugeSegment[]; col?: metabase.MbColumn }) {
  ensureBiStyles()
  if (value == null) return <div className="text-sm text-content-muted">No value</div>
  const segs = segments?.length ? [...segments].sort((a, b) => a.min - b.min) : [{ min: 0, max: Math.max(value, 1) * 1.25 }]
  const lo = segs[0].min
  const hi = segs[segs.length - 1].max
  const pos = Math.max(0, Math.min(1, (value - lo) / (hi - lo || 1)))
  const inSeg = segs.find((s) => value >= s.min && value <= s.max)
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-content">{formatValue(value, col)}</span>
        {inSeg?.label ? <span className="text-[12px] text-content-muted">{inSeg.label}</span> : null}
      </div>
      <div className="relative pt-2">
        <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full">
          {segs.map((s, i) => (
            <div key={i} title={`${s.label ?? ''} ${formatCompact(s.min)}–${formatCompact(s.max)}`} style={{ width: `${((s.max - s.min) / (hi - lo || 1)) * 100}%`, backgroundColor: s.color ?? vizColor(i), opacity: 0.85 }} />
          ))}
        </div>
        <div className="absolute top-0 h-5 w-0.5 -translate-x-1/2 rounded bg-content" style={{ left: `${pos * 100}%` }} />
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-content-subtle">
          <span>{formatCompact(lo)}</span>
          <span>{formatCompact(hi)}</span>
        </div>
      </div>
    </div>
  )
}

export function MapPlaceholder({ href }: { href?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-edge-default p-4 text-center">
      <Icon name="map" size={22} className="text-content-subtle" />
      <div className="text-[12px] text-content-muted">Maps render in Metabase.</div>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">
          Open in Metabase ↗
        </a>
      ) : null}
    </div>
  )
}
