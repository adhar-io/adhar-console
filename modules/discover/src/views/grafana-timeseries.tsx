import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react'
import { cn } from '@adhar/utils'
import { CALC_LABEL, formatUnit, type GrafanaPanel, grafanaColor, reduce } from '../data/grafana-board.ts'
import { displayValue, fieldColor, type ResolvedField } from '../data/grafana-fields.ts'
import {
  axisRange,
  axisTicks,
  linePath,
  nearestIndex,
  type Pt,
  type SeriesStyle,
  seriesStyle,
  splitRuns,
  stackSeries,
} from '../data/grafana-timeseries.ts'
import { HoverTip, Legend, type LegendRow, monoWidth, Swatch, TimeAxis, useBox, useSeriesToggle } from './grafana-viz.tsx'
import { seriesColor, SERIES_MAX } from './viz.tsx'

/**
 * Native Grafana timeseries panel: line / bars / points draw styles, fill
 * opacity + opacity gradient, dashed line styles, smooth / step
 * interpolation, stacking (normal / percent), `negative-Y`, left/right axes
 * per unit, soft/hard min-max and log scale, threshold lines/areas, gaps per
 * insertNulls / spanNulls, a list or table legend with calcs (sortable), and
 * a multi/single tooltip. Keyboard: focus the plot and use ←/→.
 */

interface Series {
  key: string
  name: string
  color: string
  style: SeriesStyle
  field: ResolvedField
  points: Pt[]
  axis: string
  stepMs?: number
}

interface Axis {
  key: string
  unit?: string
  decimals?: number
  side: 'left' | 'right' | 'hidden'
  min: number
  max: number
  log?: number
  ticks: number[]
  width: number
}

const fmtTime = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function TimeseriesViz({
  panel,
  fields,
  range,
  stepMs,
}: {
  panel: GrafanaPanel
  fields: ResolvedField[]
  range: { start: number; end: number }
  stepMs?: number
}) {
  const gradPrefix = useId().replace(/:/g, '')
  const wrap = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const box = useBox(plotRef)
  const outer = useBox(wrap)
  const [hover, setHover] = useState<{ t: number; cx: number; cy: number; py: number } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const legendOpt = panel.options?.legend ?? {}
  const tooltipOpt = panel.options?.tooltip ?? {}

  // Series from every number field that has a time field in its frame.
  const all = useMemo<Series[]>(() => {
    const out: Series[] = []
    for (const f of fields) {
      if (f.type !== 'number') continue
      const time = f.frame.fields.find((x) => x.type === 'time')
      if (!time) continue
      const style = seriesStyle(f.config)
      if (style.hideViz && style.hideLegend) continue
      const points: Pt[] = time.values.map((t, i) => [Number(t), f.values[i] == null ? null : Number(f.values[i])])
      const lastVal = reduce(points.map((p) => p[1]), f.config.color?.seriesBy ?? 'lastNotNull')
      const c = fieldColor(f.config, lastVal, seriesColor(f.seriesIndex)).color ?? seriesColor(f.seriesIndex)
      out.push({
        key: `${f.frameIndex}:${f.name}:${f.seriesIndex}`,
        name: f.displayName,
        color: c,
        style,
        field: f,
        points,
        axis: `${f.config.unit ?? ''}|${style.axisPlacement === 'auto' ? '' : style.axisPlacement}`,
        stepMs: f.config.interval ?? stepMs,
      })
    }
    return out
  }, [fields, stepMs])

  const capped = showAll ? all : all.slice(0, SERIES_MAX)
  const { hidden, toggle } = useSeriesToggle(capped.map((s) => s.key))
  const visible = capped.filter((s) => !hidden.has(s.key) && !s.style.hideViz)

  const legendPlacement: 'bottom' | 'right' = legendOpt.placement === 'right' && outer.w >= 480 ? 'right' : 'bottom'
  const legendMode: 'list' | 'table' = legendOpt.displayMode === 'table' || (legendOpt as { asTable?: boolean }).asTable ? 'table' : 'list'
  const showLegend = legendOpt.showLegend !== false && legendOpt.displayMode !== 'hidden' && capped.some((s) => !s.style.hideLegend) && (capped.length > 1 || (legendOpt.calcs ?? []).length > 0)
  const calcs = (legendOpt.calcs ?? []).filter(Boolean)

  // Stacking + per-axis ranges.
  const stacked = useMemo(() => stackSeries(visible.map((s) => ({ points: s.points, style: s.style }))), [visible])
  const axes = useMemo<Axis[]>(() => {
    const keys = [...new Set(visible.map((s) => s.axis))]
    if (!keys.length) keys.push('|')
    return keys.map((key, i) => {
      const members = visible.map((s, j) => ({ s, j })).filter(({ s }) => s.axis === key)
      const first = members[0]?.s
      const cfg = first?.field.config ?? panel.fieldConfig?.defaults ?? {}
      const percent = members.some(({ s }) => s.style.stackMode === 'percent')
      const vals = members.flatMap(({ j }) => stacked[j].flatMap(([, b, t]) => [b, t]))
      const style = first?.style
      const thr = (panel.fieldConfig?.defaults?.custom as { thresholdsStyle?: { mode?: string } } | undefined)?.thresholdsStyle?.mode
      if (i === 0 && thr && thr !== 'off') {
        for (const st of panel.fieldConfig?.defaults?.thresholds?.steps ?? []) if (st.value != null && panel.fieldConfig?.defaults?.thresholds?.mode !== 'percentage') vals.push(st.value)
      }
      const r = percent
        ? { min: Math.min(0, ...vals), max: Math.max(1, ...vals) }
        : axisRange(vals, {
          min: cfg.min,
          max: cfg.max,
          softMin: style?.axisSoftMin,
          softMax: style?.axisSoftMax,
          log: style?.scaleLog,
          bars: members.some(({ s }) => s.style.drawStyle === 'bars'),
        })
      const placement = style?.axisPlacement ?? 'auto'
      const side: Axis['side'] = placement === 'hidden' ? 'hidden' : placement === 'right' ? 'right' : placement === 'left' ? 'left' : i === 0 ? 'left' : 'right'
      const plotH = Math.max(40, box.h - 18)
      const ticks = axisTicks(r.min, r.max, Math.max(2, Math.floor(plotH / 40)), style?.scaleLog, percent ? undefined : cfg.decimals)
      const unit = percent ? 'percentunit' : cfg.unit
      const width = side === 'hidden' ? 0 : Math.ceil(Math.max(...ticks.map((t) => monoWidth(formatUnit(t, unit, cfg.decimals))), 12)) + 8
      return { key, unit, decimals: cfg.decimals, side, min: r.min, max: r.max, log: style?.scaleLog, ticks, width }
    })
  }, [visible, stacked, box.h, panel.fieldConfig])

  const padL = Math.max(8, axes.filter((a) => a.side === 'left').reduce((m, a) => Math.max(m, a.width), 0))
  const padR = Math.max(10, axes.filter((a) => a.side === 'right').reduce((m, a) => Math.max(m, a.width), 0))
  const W = Math.max(1, box.w)
  const H = Math.max(1, box.h)
  const top = 6
  const bottom = H - 18
  const x0 = padL
  const x1 = W - padR
  const sx = (t: number) => x0 + ((t - range.start) / Math.max(1, range.end - range.start)) * (x1 - x0)
  const axisOf = (key: string) => axes.find((a) => a.key === key) ?? axes[0]
  const sy = (a: Axis, v: number) => {
    if (a.log) {
      const lv = Math.log(Math.max(v, a.min)) / Math.log(a.log)
      const l0 = Math.log(a.min) / Math.log(a.log)
      const l1 = Math.log(a.max) / Math.log(a.log)
      return bottom - ((lv - l0) / Math.max(1e-9, l1 - l0)) * (bottom - top)
    }
    return bottom - ((v - a.min) / Math.max(1e-12, a.max - a.min)) * (bottom - top)
  }

  // Legend rows with calcs on raw values.
  const legendRows: LegendRow[] = useMemo(() => capped.filter((s) => !s.style.hideLegend).map((s) => {
    const raw: Record<string, number | null> = {}
    const values: Record<string, string> = {}
    for (const c of calcs) {
      const v = reduce(s.points.map((p) => p[1]), c)
      raw[c] = v
      values[c] = c === 'count' ? String(v ?? 0) : displayValue(s.field.config, v, s.color).text
    }
    return { key: s.key, name: s.name, color: s.color, dash: !!s.style.dash, values, raw, dimmed: hidden.has(s.key) }
  }), [capped, calcs.join(','), hidden])

  // Tooltip rows at the hovered time.
  const allTimes = useMemo(() => [...new Set(visible.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b), [visible])
  const tipRows = useMemo(() => {
    if (!hover) return []
    const rows = visible
      .filter((s) => !s.style.hideTooltip)
      .map((s) => {
        const ts = s.points.map((p) => p[0])
        const i = nearestIndex(ts, hover.t)
        const p = i >= 0 ? s.points[i] : null
        const near = p && Math.abs(p[0] - hover.t) <= (s.stepMs ?? 60_000) * 1.5
        return { s, v: near ? p![1] : null, t: p?.[0] }
      })
    let out = rows
    if (tooltipOpt.mode === 'single') {
      // Nearest series to the pointer by pixel distance.
      let best = rows[0]
      let bd = Infinity
      for (const r of rows) {
        if (r.v == null) continue
        const j = visible.indexOf(r.s)
        const pt = stacked[j].find(([t]) => t === r.t)
        const y = pt ? sy(axisOf(r.s.axis), pt[2]) : Infinity
        const d = Math.abs(y - hover.py)
        if (d < bd) {
          bd = d
          best = r
        }
      }
      out = best ? [best] : []
    } else if (tooltipOpt.mode === 'none') out = []
    if (tooltipOpt.sort === 'desc') out = [...out].sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))
    if (tooltipOpt.sort === 'asc') out = [...out].sort((a, b) => (a.v ?? Infinity) - (b.v ?? Infinity))
    return out
  }, [hover, visible, stacked, tooltipOpt.mode, tooltipOpt.sort])

  const moveTo = (t: number, el: Element | null) => {
    const r = el?.getBoundingClientRect()
    if (!r) return
    setHover({ t, cx: r.left + sx(t), cy: r.top + top + 10, py: top + 10 })
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!allTimes.length) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const cur = hover ? nearestIndex(allTimes, hover.t) : allTimes.length - 1
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? allTimes.length - 1 : Math.max(0, Math.min(allTimes.length - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1)))
    moveTo(allTimes[next], e.currentTarget)
  }

  const thresholdsMode = (panel.fieldConfig?.defaults?.custom as { thresholdsStyle?: { mode?: string } } | undefined)?.thresholdsStyle?.mode ?? 'off'
  const steps = panel.fieldConfig?.defaults?.thresholds?.steps ?? []
  const a0 = axes[0]

  const summary = `${panel.title ?? 'Time series'}: ${visible.length} series` +
    (visible[0] ? `, ${visible[0].name} last ${displayValue(visible[0].field.config, reduce(visible[0].points.map((p) => p[1]), 'lastNotNull'), visible[0].color).text}` : '')

  return (
    <div ref={wrap} className={cn('flex h-full min-h-0', legendPlacement === 'right' ? 'flex-row gap-2' : 'flex-col gap-1')}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={plotRef}
          className="relative min-h-[60px] flex-1 outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50"
          tabIndex={0}
          role="img"
          aria-label={summary}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const px = e.clientX - r.left
            if (px < x0 || px > x1) return setHover(null)
            const t = range.start + ((px - x0) / Math.max(1, x1 - x0)) * (range.end - range.start)
            const snap = allTimes.length ? allTimes[nearestIndex(allTimes, t)] : t
            setHover({ t: snap, cx: e.clientX, cy: e.clientY, py: e.clientY - r.top })
          }}
          onMouseLeave={() => setHover(null)}
        >
          {box.w > 0 && box.h > 0 ? (
            <svg width={W} height={H} className="absolute inset-0 block overflow-visible">
              <defs>
                {visible.map((s, i) => (
                  <linearGradient key={s.key} id={`${gradPrefix}-g${i}`} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={Math.min(1, s.style.fillOpacity / 100)} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={s.style.gradientMode === 'opacity' || s.style.gradientMode === 'hue' ? 0 : Math.min(1, s.style.fillOpacity / 100)} />
                  </linearGradient>
                ))}
                <clipPath id={`${gradPrefix}-clip`}>
                  <rect x={x0} y={top - 2} width={Math.max(0, x1 - x0)} height={Math.max(0, bottom - top + 4)} />
                </clipPath>
              </defs>
              {/* value axes + gridlines (first axis owns the grid) */}
              {axes.map((a, ai) =>
                a.ticks.map((v) => {
                  const y = sy(a, v)
                  if (y < top - 1 || y > bottom + 1) return null
                  return (
                    <g key={`${a.key}-${v}`}>
                      {ai === 0 ? <line x1={x0} x2={x1} y1={y} y2={y} stroke="var(--color-edge-default)" strokeWidth="1" strokeDasharray={v === 0 ? undefined : '3 4'} opacity="0.8" /> : null}
                      {a.side === 'hidden' ? null : (
                        <text
                          x={a.side === 'left' ? x0 - 5 : x1 + 5}
                          y={y + 3}
                          textAnchor={a.side === 'left' ? 'end' : 'start'}
                          fontSize="9"
                          fill="var(--color-content-subtle)"
                          fontFamily="var(--font-mono)"
                        >
                          {formatUnit(v, a.unit, a.decimals)}
                        </text>
                      )}
                    </g>
                  )
                })
              )}
              <TimeAxis start={range.start} end={range.end} x0={x0} x1={x1} y={H} />
              <g clipPath={`url(#${gradPrefix}-clip)`}>
                {/* threshold areas */}
                {thresholdsMode.includes('area') && a0
                  ? steps.map((st, i) => {
                    const lo = st.value ?? a0.min
                    const hi = steps[i + 1]?.value ?? a0.max
                    const y1 = sy(a0, Math.max(a0.min, lo))
                    const y2 = sy(a0, Math.min(a0.max, hi))
                    if (y1 <= y2) return null
                    return <rect key={`ta${i}`} x={x0} y={y2} width={x1 - x0} height={y1 - y2} fill={grafanaColor(st.color)} opacity="0.12" />
                  })
                  : null}
                {/* series */}
                {visible.map((s, i) => (
                  <SeriesPaint
                    key={s.key}
                    s={s}
                    band={stacked[i]}
                    axis={axisOf(s.axis)}
                    sx={sx}
                    sy={sy}
                    grad={`url(#${gradPrefix}-g${i})`}
                    stepPx={s.stepMs ? (s.stepMs / Math.max(1, range.end - range.start)) * (x1 - x0) : 6}
                  />
                ))}
                {/* threshold lines */}
                {thresholdsMode !== 'off' && !thresholdsMode.startsWith('area') && a0
                  ? steps.filter((st) => st.value != null).map((st, i) => {
                    const y = sy(a0, st.value!)
                    return (
                      <line
                        key={`tl${i}`}
                        x1={x0}
                        x2={x1}
                        y1={y}
                        y2={y}
                        stroke={grafanaColor(st.color)}
                        strokeWidth="1"
                        strokeDasharray={thresholdsMode.startsWith('dashed') ? '6 4' : undefined}
                      />
                    )
                  })
                  : null}
              </g>
              {hover ? (
                <g aria-hidden>
                  <line x1={sx(hover.t)} x2={sx(hover.t)} y1={top} y2={bottom} stroke="var(--color-content-subtle)" strokeWidth="1" strokeDasharray="2 3" />
                  {tipRows.map(({ s, t, v }) => {
                    if (v == null || t == null) return null
                    const j = visible.indexOf(s)
                    const pt = stacked[j]?.find(([tt]) => tt === t)
                    if (!pt) return null
                    return <circle key={s.key} cx={sx(t)} cy={sy(axisOf(s.axis), pt[2])} r="3.5" fill={s.color} stroke="var(--color-surface-raised)" strokeWidth="1.5" />
                  })}
                </g>
              ) : null}
            </svg>
          ) : null}
          {visible.length === 0 && all.length > 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-[11px] text-content-subtle">All series hidden — click a legend item to show it</div>
          ) : null}
        </div>
        {all.length > SERIES_MAX ? (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-0.5 self-start text-[10px] text-content-subtle hover:text-content">
            {showAll ? 'Show fewer series' : `Showing ${SERIES_MAX} of ${all.length} series — show all`}
          </button>
        ) : null}
      </div>
      {showLegend ? (
        <div
          className={cn('min-h-0', legendPlacement === 'right' ? 'shrink-0' : 'max-h-[40%] shrink-0')}
          style={legendPlacement === 'right' ? { width: legendOpt.width ? Math.min(legendOpt.width, outer.w * 0.5) : Math.min(Math.max(160, outer.w * 0.32), 360) } : undefined}
        >
          <Legend
            rows={legendRows}
            calcs={calcs}
            calcLabels={CALC_LABEL}
            mode={legendMode}
            placement={legendPlacement}
            sortBy={legendOpt.sortBy}
            sortDesc={legendOpt.sortDesc}
            onToggle={toggle}
          />
        </div>
      ) : null}
      {hover && tipRows.length ? (
        <HoverTip x={hover.cx} y={hover.cy}>
          <div className="mb-0.5 text-content-subtle">{fmtTime(hover.t)}</div>
          {tipRows.map(({ s, v }) => (
            <div key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
              <Swatch color={s.color} dash={!!s.style.dash} />
              <span className="max-w-[220px] truncate text-content-muted">{s.name}</span>
              <span className="ml-auto pl-2 tabular-nums">{displayValue(s.field.config, v, s.color).text}</span>
            </div>
          ))}
        </HoverTip>
      ) : null}
    </div>
  )
}

function SeriesPaint({
  s,
  band,
  axis,
  sx,
  sy,
  grad,
  stepPx,
}: {
  s: Series
  band: Array<[number, number, number]>
  axis: Axis
  sx(t: number): number
  sy(a: Axis, v: number): number
  grad: string
  stepPx: number
}) {
  const st = s.style
  const stackedMode = st.stackMode !== 'none'
  // Runs follow gaps of the raw series; the band supplies stacked y values.
  const byT = new Map(band.map((b) => [b[0], b]))
  const runs = splitRuns(s.points, st.spanNulls, st.insertNulls === false ? false : (st.insertNulls ?? (s.stepMs ? s.stepMs : false)))
  const zero = sy(axis, Math.max(axis.min, Math.min(axis.max, axis.log ? axis.min : 0)))
  if (st.drawStyle === 'bars') {
    const w = Math.max(1, Math.min(40, stepPx * 0.8))
    const off = st.barAlignment === -1 ? 0 : st.barAlignment === 1 ? -w : -w / 2
    return (
      <g>
        {band.map(([t, b, top]) => {
          const y1 = sy(axis, top)
          const y0 = stackedMode ? sy(axis, b) : zero
          return <rect key={t} x={sx(t) + off} y={Math.min(y0, y1)} width={w} height={Math.max(0.5, Math.abs(y0 - y1))} fill={s.color} fillOpacity={st.fillOpacity > 0 ? Math.min(1, st.fillOpacity / 100) : 0.85} stroke={st.lineWidth > 0 ? s.color : undefined} strokeWidth={st.lineWidth > 0 ? 1 : 0} />
        })}
      </g>
    )
  }
  const showPts = st.drawStyle === 'points' || st.showPoints === 'always' || (st.showPoints === 'auto' && stepPx > 18)
  return (
    <g>
      {runs.map((run, ri) => {
        const pts = run.map(([t]) => byT.get(t)).filter((b): b is [number, number, number] => !!b)
        if (!pts.length) return null
        const topPx = pts.map(([t, , top]) => [sx(t), sy(axis, top)] as [number, number])
        const line = linePath(topPx, st.lineInterpolation)
        let area: string | null = null
        if (st.fillOpacity > 0 && st.drawStyle === 'line' && pts.length > 1) {
          if (stackedMode) {
            const botPx = pts.map(([t, b]) => [sx(t), sy(axis, b)] as [number, number]).reverse()
            area = `${line}L${botPx.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`
          } else {
            area = `${line}L${topPx[topPx.length - 1][0].toFixed(1)},${zero.toFixed(1)}L${topPx[0][0].toFixed(1)},${zero.toFixed(1)}Z`
          }
        }
        return (
          <g key={ri}>
            {area ? <path d={area} fill={grad} stroke="none" /> : null}
            {st.drawStyle === 'line' && st.lineWidth > 0 && pts.length > 1 ? (
              <path d={line} fill="none" stroke={s.color} strokeWidth={st.lineWidth} strokeDasharray={st.dash?.join(' ')} strokeLinejoin="round" strokeLinecap={st.dash?.[0] === 0 ? 'round' : 'butt'} />
            ) : null}
            {showPts || pts.length === 1
              ? topPx.map(([x, y], k) => <circle key={k} cx={x} cy={y} r={Math.max(1.5, st.pointSize / 2)} fill={s.color} />)
              : null}
          </g>
        )
      })}
    </g>
  )
}
