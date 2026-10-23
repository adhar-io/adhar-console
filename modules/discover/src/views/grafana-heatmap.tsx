import { type KeyboardEvent, useMemo, useRef, useState } from 'react'
import { formatUnit, type GrafanaPanel, grafanaColor, type PromSeries } from '../data/grafana-board.ts'
import type { ResolvedField } from '../data/grafana-fields.ts'
import {
  calculateHeatmap,
  heatmapFromBuckets,
  type HeatmapColorOptions,
  type HeatmapData,
  heatmapPalette,
  heatmapScale,
  histogram,
} from '../data/grafana-heatmap.ts'
import { axisTicks } from '../data/grafana-timeseries.ts'
import { formatSpan } from '../data/grafana-timeline.ts'
import { HoverTip, monoWidth, Swatch, TimeAxis, useBox, useIsDark } from './grafana-viz.tsx'
import { seriesColor, SERIES_MAX } from './viz.tsx'

/**
 * Grafana heatmap. Prometheus histogram buckets (`format: heatmap` / `le`
 * labels) are de-accumulated into rows; otherwise (or with `calculate`) the
 * raw samples are bucketed. Colour: quantised scheme (Spectral, Oranges …)
 * with linear / exponential scale, or opacity of one colour; cells at or
 * below `filterValues.le` are left empty; a colour-scale legend and a
 * hover / keyboard tooltip (time span, bucket, count).
 */

interface HeatmapOptions {
  calculate?: boolean
  calculation?: { yBuckets?: { mode?: string; value?: string; scale?: { type?: string; log?: number } }; xBuckets?: { value?: string } }
  cellGap?: number
  cellValues?: { unit?: string; decimals?: number }
  color?: HeatmapColorOptions
  filterValues?: { le?: number; ge?: number }
  legend?: { show?: boolean }
  tooltip?: { mode?: string; show?: boolean }
  yAxis?: { axisPlacement?: string; reverse?: boolean; unit?: string; decimals?: number; min?: number; max?: number }
  rowsFrame?: { layout?: string }
}

export function HeatmapViz({
  panel,
  series,
  fields,
  range,
}: {
  panel: GrafanaPanel
  /** Raw Prometheus series of the panel (histogram buckets keep their `le`). */
  series: PromSeries[]
  fields: ResolvedField[]
  range: { start: number; end: number }
}) {
  const o = (panel.options ?? {}) as HeatmapOptions
  const dark = useIsDark()
  const plotRef = useRef<HTMLDivElement>(null)
  const box = useBox(plotRef)
  const [tip, setTip] = useState<{ b: number; x: number; cx: number; cy: number } | null>(null)

  const data = useMemo<HeatmapData | null>(() => {
    if (!o.calculate) {
      const h = heatmapFromBuckets(series)
      if (h) return h
    }
    const raw = fields
      .filter((f) => f.type === 'number')
      .map((f) => {
        const time = f.frame.fields.find((x) => x.type === 'time')
        return (time?.values ?? []).map((t, i) => [Number(t), Number(f.values[i])] as [number, number])
      })
    const y = o.calculation?.yBuckets
    return calculateHeatmap(raw, {
      yScale: y?.scale?.type === 'log' ? 'log' : 'linear',
      logBase: y?.scale?.log,
      yBuckets: y?.mode === 'count' && Number(y.value) > 0 ? Number(y.value) : undefined,
    })
  }, [series, fields, o.calculate, o.calculation])

  const palette = useMemo(() => heatmapPalette(o.color ?? {}, dark), [o.color, dark])
  const hideLe = o.filterValues?.le ?? 1e-9
  const yUnit = o.yAxis?.unit ?? panel.fieldConfig?.defaults?.unit
  const cellUnit = o.cellValues?.unit ?? 'short'

  if (!data || !data.buckets.length) {
    return <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">No histogram buckets in this range</div>
  }

  const W = Math.max(1, box.w)
  const H = Math.max(1, box.h)
  const rows = data.buckets.length
  const reverse = !!o.yAxis?.reverse
  const yLabel = (v: number) => (v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : formatUnit(v, yUnit, o.yAxis?.decimals))
  const labels = data.buckets.map((b) => yLabel(b.hi))
  const side = o.yAxis?.axisPlacement === 'hidden' ? 'hidden' : o.yAxis?.axisPlacement === 'right' ? 'right' : 'left'
  const axisW = side === 'hidden' ? 4 : Math.ceil(Math.max(...labels.map((l) => monoWidth(l)), 16)) + 8
  const x0 = side === 'left' ? axisW : 4
  const x1 = W - (side === 'right' ? axisW : 6)
  const top = 4
  const bottom = H - 16
  const rowH = (bottom - top) / rows
  const rowY = (b: number) => (reverse ? top + b * rowH : bottom - (b + 1) * rowH)
  const sx = (t: number) => x0 + ((t - range.start) / Math.max(1, range.end - range.start)) * (x1 - x0)
  const gap = Math.max(0, o.cellGap ?? 1)
  const colorFor = (v: number) => {
    const t = heatmapScale(v, data.min, data.max, o.color ?? {})
    if (o.color?.mode === 'opacity') return { fill: grafanaColor(o.color.fill ?? 'dark-orange') ?? 'var(--color-orange-600)', op: Math.max(0.05, t) }
    return { fill: palette[Math.min(palette.length - 1, Math.max(0, Math.round(t * (palette.length - 1))))], op: 1 }
  }

  // Label every row edge that has room (≥ 12px apart).
  const every = Math.max(1, Math.ceil(12 / Math.max(1, rowH)))
  const numericTicks = data.ordinal ? [] : axisTicks(data.buckets[0].lo, data.buckets[rows - 1].hi, Math.max(2, Math.floor((bottom - top) / 30)))
  const tipCell = tip ? data.counts[tip.b]?.[tip.x] : null

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const cur = tip ?? { b: 0, x: data.xs.length - 1, cx: 0, cy: 0 }
    const x = Math.max(0, Math.min(data.xs.length - 1, cur.x + (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0)))
    const up = reverse ? -1 : 1
    const b = Math.max(0, Math.min(rows - 1, cur.b + (e.key === 'ArrowUp' ? up : e.key === 'ArrowDown' ? -up : 0)))
    const r = e.currentTarget.getBoundingClientRect()
    setTip({ b, x, cx: r.left + sx(data.xs[x]), cy: r.top + rowY(b) + rowH / 2 })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      <div
        ref={plotRef}
        className="relative min-h-[40px] flex-1 outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
        tabIndex={0}
        role="img"
        aria-label={`${panel.title ?? 'Heatmap'}: ${rows} buckets over ${data.xs.length} time columns, max ${formatUnit(data.max, cellUnit)} per cell`}
        onKeyDown={onKey}
        onBlur={() => setTip(null)}
        onMouseLeave={() => setTip(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const px = e.clientX - r.left
          const py = e.clientY - r.top
          if (px < x0 || px > x1 || py < top || py > bottom) return setTip(null)
          const t = range.start + ((px - x0) / Math.max(1, x1 - x0)) * (range.end - range.start)
          let x = data.xs.findIndex((s) => t >= s && t < s + data.xStep)
          if (x < 0) return setTip(null)
          const fromBottom = Math.floor((bottom - py) / rowH)
          const b = reverse ? Math.floor((py - top) / rowH) : fromBottom
          x = Math.max(0, x)
          setTip({ b: Math.max(0, Math.min(rows - 1, b)), x, cx: e.clientX, cy: e.clientY })
        }}
      >
        {box.w > 0 ? (
          <svg width={W} height={H} className="absolute inset-0 block">
            {data.counts.map((row, b) =>
              row.map((v, x) => {
                if (v == null || v <= hideLe) return null
                const c = colorFor(v)
                const cx = sx(data.xs[x])
                const cw = sx(data.xs[x] + data.xStep) - cx
                if (cx + cw < x0 || cx > x1) return null
                // Like Grafana, drop the gap on cells too small to keep it.
                const gx = cw < 4 * gap ? 0 : gap
                const gy = rowH < 4 * gap ? 0 : gap
                return (
                  <rect
                    key={`${b}-${x}`}
                    x={cx + gx / 2}
                    y={rowY(b) + gy / 2}
                    width={Math.max(0.5, cw - gx + (gx ? 0 : 0.4))}
                    height={Math.max(0.5, rowH - gy)}
                    fill={c.fill}
                    fillOpacity={c.op}
                  />
                )
              })
            )}
            {tip ? <rect x={sx(data.xs[tip.x])} y={rowY(tip.b)} width={Math.max(1, sx(data.xs[tip.x] + data.xStep) - sx(data.xs[tip.x]))} height={rowH} fill="none" stroke="var(--color-content)" strokeWidth="1.5" /> : null}
            {side !== 'hidden'
              ? data.ordinal
                ? data.buckets.map((bk, b) => {
                  if (b % every !== 0 && b !== rows - 1) return null
                  const y = reverse ? rowY(b) + rowH : rowY(b)
                  return (
                    <text key={b} x={side === 'left' ? x0 - 5 : x1 + 5} y={y + 3} textAnchor={side === 'left' ? 'end' : 'start'} fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">
                      {yLabel(bk.hi)}
                    </text>
                  )
                })
                : numericTicks.map((v) => {
                  const lo = data.buckets[0].lo
                  const hi = data.buckets[rows - 1].hi
                  const f = (v - lo) / Math.max(1e-12, hi - lo)
                  const y = reverse ? top + f * (bottom - top) : bottom - f * (bottom - top)
                  return (
                    <text key={v} x={side === 'left' ? x0 - 5 : x1 + 5} y={y + 3} textAnchor={side === 'left' ? 'end' : 'start'} fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">
                      {yLabel(v)}
                    </text>
                  )
                })
              : null}
            <TimeAxis start={range.start} end={range.end} x0={x0} x1={x1} y={H} />
          </svg>
        ) : null}
      </div>
      {o.legend?.show !== false ? (
        <div className="flex shrink-0 items-center gap-2 text-[10px] text-content-muted" aria-label="Colour scale">
          <span className="font-mono tabular-nums">{formatUnit(o.color?.min ?? data.min, cellUnit, o.cellValues?.decimals)}</span>
          <span
            aria-hidden
            className="h-2 w-32 max-w-[40%] rounded-sm"
            style={{
              background: o.color?.mode === 'opacity'
                ? `linear-gradient(to right, transparent, ${grafanaColor(o.color.fill ?? 'dark-orange')})`
                : `linear-gradient(to right, ${palette.filter((_, i) => i % Math.max(1, Math.floor(palette.length / 12)) === 0).concat(palette[palette.length - 1]).join(', ')})`,
            }}
          />
          <span className="font-mono tabular-nums">{formatUnit(o.color?.max ?? data.max, cellUnit, o.cellValues?.decimals)}</span>
        </div>
      ) : null}
      {tip && o.tooltip?.mode !== 'none' && o.tooltip?.show !== false ? (
        <HoverTip x={tip.cx} y={tip.cy}>
          <div className="text-content-subtle">{formatSpan(data.xs[tip.x], data.xs[tip.x] + data.xStep)}</div>
          <div>
            Bucket{' '}
            <span className="text-content">
              {data.ordinal ? `${yLabel(data.buckets[tip.b].lo)} – ${yLabel(data.buckets[tip.b].hi)}` : `${yLabel(data.buckets[tip.b].lo)} – ${yLabel(data.buckets[tip.b].hi)}`}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {tipCell != null && tipCell > hideLe ? <Swatch shape="square" color={colorFor(tipCell).fill} /> : null}
            Count <span className="font-semibold text-content">{tipCell == null ? '—' : formatUnit(tipCell, cellUnit, o.cellValues?.decimals)}</span>
          </div>
        </HoverTip>
      ) : null}
    </div>
  )
}

/** Grafana histogram panel: value distribution of every series (or combined). */
export function HistogramViz({ panel, fields }: { panel: GrafanaPanel; fields: ResolvedField[] }) {
  const o = (panel.options ?? {}) as { bucketSize?: number; bucketOffset?: number; bucketCount?: number; combine?: boolean }
  const ref = useRef<HTMLDivElement>(null)
  const box = useBox(ref)
  const [tip, setTip] = useState<{ i: number; s: number; x: number; y: number } | null>(null)
  const nums = fields.filter((f) => f.type === 'number').slice(0, SERIES_MAX)
  const groups = useMemo(() => {
    const all = nums.map((f) => f.values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))
    const flat = all.flat()
    if (!flat.length) return null
    const shared = histogram(flat, o)
    const size = shared.length ? shared[0].hi - shared[0].lo : 1
    const off = shared.length ? shared[0].lo : 0
    const per = o.combine || nums.length === 1 ? [shared] : all.map((v) => histogram(v, { bucketSize: size, bucketOffset: off }))
    return { per, edges: shared }
  }, [nums, o.bucketSize, o.bucketOffset, o.combine])
  if (!groups) return <div className="flex h-full items-center justify-center text-[11px] text-content-subtle">No values</div>
  const u = nums[0]?.config.unit
  const W = Math.max(1, box.w)
  const H = Math.max(1, box.h)
  const maxC = Math.max(1, ...groups.per.flat().map((b) => b.count))
  const ticks = axisTicks(0, maxC, Math.max(2, Math.floor(H / 40)))
  const x0 = Math.ceil(Math.max(...ticks.map((t) => monoWidth(String(t))))) + 8
  const x1 = W - 6
  const lo = groups.edges[0]?.lo ?? 0
  const hi = groups.edges[groups.edges.length - 1]?.hi ?? 1
  const sx = (v: number) => x0 + ((v - lo) / Math.max(1e-12, hi - lo)) * (x1 - x0)
  const sy = (c: number) => H - 16 - (c / Math.max(...ticks, 1)) * (H - 22)
  const xt = axisTicks(lo, hi, Math.max(2, Math.floor((x1 - x0) / 70)))
  const tb = tip ? groups.per[tip.s]?.[tip.i] : null
  return (
    <div ref={ref} className="relative h-full min-h-[40px]" role="img" aria-label={`${panel.title ?? 'Histogram'}: ${groups.edges.length} buckets`} onMouseLeave={() => setTip(null)}>
      {box.w > 0 ? (
        <svg width={W} height={H} className="absolute inset-0 block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x0} x2={x1} y1={sy(t)} y2={sy(t)} stroke="var(--color-edge-default)" strokeDasharray={t ? '3 4' : undefined} />
              <text x={x0 - 5} y={sy(t) + 3} textAnchor="end" fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">{t}</text>
            </g>
          ))}
          {xt.map((t) => (
            <text key={t} x={sx(t)} y={H - 3} textAnchor="middle" fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">{formatUnit(t, u)}</text>
          ))}
          {groups.per.map((bars, s) =>
            bars.map((b, i) => (
              <rect
                key={`${s}-${i}`}
                x={sx(b.lo) + 0.5}
                y={sy(b.count)}
                width={Math.max(0.5, sx(b.hi) - sx(b.lo) - 1)}
                height={Math.max(0, sy(0) - sy(b.count))}
                fill={seriesColor(s)}
                fillOpacity={groups.per.length > 1 ? 0.55 : 0.8}
                onMouseMove={(e) => setTip({ i, s, x: e.clientX, y: e.clientY })}
              />
            ))
          )}
        </svg>
      ) : null}
      {tip && tb ? (
        <HoverTip x={tip.x} y={tip.y}>
          <div className="text-content-subtle">{formatUnit(tb.lo, u)} – {formatUnit(tb.hi, u)}</div>
          <div className="flex items-center gap-1.5">
            <Swatch shape="square" color={seriesColor(tip.s)} />
            {groups.per.length > 1 ? nums[tip.s]?.displayName : 'Count'} <span className="font-semibold text-content">{tb.count}</span>
          </div>
        </HoverTip>
      ) : null}
    </div>
  )
}
