import { useMemo, useRef, useState } from 'react'
import { cn } from '@adhar/utils'
import { colorTone, formatUnit, type GrafanaPanel, grafanaColor, legacyCalc, reduce, type ThresholdTone } from '../data/grafana-board.ts'
import { type DisplayItem, displayItems, displayValue, type ResolvedField } from '../data/grafana-fields.ts'
import {
  arcPath,
  GAUGE_GAP,
  GAUGE_NAME_H,
  GAUGE_SWEEP,
  gaugeFraction,
  gaugeGeometry,
  gaugeGrid,
  polar,
  splitValueText,
  thresholdBands,
} from '../data/grafana-gauge.ts'
import { contrastText, HoverTip, Legend, Swatch, useBox } from './grafana-viz.tsx'
import { seriesColor } from './viz.tsx'

/**
 * Single-value Grafana panels: stat (colorMode value / background / none,
 * graphMode area sparkline, textMode, justify/orientation), gauge (240° arc
 * with threshold band), bar gauge (gradient / basic / lcd, name placement,
 * unfilled track, value colour) and pie / donut (legend with value and
 * percent). Values come from `reduceOptions`; text and colour from value
 * mappings, thresholds and per-field overrides. Warning / critical
 * thresholds also carry an icon + word so status is never colour alone.
 */

type Frames = Array<{ fields: ResolvedField[] }>

const TONE_ICON: Record<ThresholdTone, string> = { ok: '●', warn: '▲', bad: '■', info: '●', neutral: '' }
const TONE_LABEL: Record<ThresholdTone, string> = { ok: 'OK', warn: 'Warning', bad: 'Critical', info: '', neutral: '' }

function items(panel: GrafanaPanel, frames: Frames): DisplayItem[] {
  return displayItems(frames, panel.options?.reduceOptions, legacyCalc(panel.valueName), reduce)
}

function show(item: DisplayItem, range?: { min: number; max: number }) {
  const d = displayValue(item.field.config, item.value, seriesColor(Math.max(0, item.field.seriesIndex)), range)
  return { ...d, tone: d.mapped ? 'neutral' as ThresholdTone : colorTone(d.rawColor) }
}

function globalRange(list: DisplayItem[]): { min: number; max: number } {
  const v = list.map((i) => i.value).filter((x): x is number => x != null && Number.isFinite(x))
  return { min: Math.min(0, ...v), max: Math.max(...v, 0) || 1 }
}

/* ─────────── stat ─────────── */

export function StatViz({ panel, frames }: { panel: GrafanaPanel; frames: Frames }) {
  const list = useMemo(() => items(panel, frames).slice(0, 48), [panel, frames])
  const o = (panel.options ?? {}) as { colorMode?: string; graphMode?: string; textMode?: string; justifyMode?: string; orientation?: string }
  const ref = useRef<HTMLDivElement>(null)
  const box = useBox(ref)
  if (!list.length) return <NoValue panel={panel} />
  const many = list.length > 1
  // Grafana lays multiple stats out in a row when wide, a column when tall.
  const vertical = o.orientation === 'vertical' || (o.orientation !== 'horizontal' && box.h > box.w * 1.2)
  const cols = many ? (vertical ? 1 : Math.min(list.length, Math.max(1, Math.floor(box.w / 110)))) : 1
  const rows = Math.ceil(list.length / cols)
  const tileH = box.h > 0 ? (box.h - (rows - 1) * 6) / rows : 60
  const tileW = box.w > 0 ? (box.w - (cols - 1) * 6) / cols : 120
  return (
    <div
      ref={ref}
      className={cn('grid h-full min-h-0 gap-1.5', many ? 'overflow-auto' : '')}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: many ? `minmax(${Math.max(44, Math.min(tileH, 200))}px, 1fr)` : '1fr' }}
    >
      {list.map((it) => <StatTile key={it.key} item={it} many={many} mode={o} w={tileW} h={Math.max(44, tileH)} />)}
    </div>
  )
}

function StatTile({
  item,
  many,
  mode,
  w,
  h,
}: {
  item: DisplayItem
  many: boolean
  mode: { colorMode?: string; graphMode?: string; textMode?: string; justifyMode?: string }
  w: number
  h: number
}) {
  const d = show(item)
  const colorMode = mode.colorMode ?? 'value'
  const textMode = mode.textMode ?? 'auto'
  const showName = textMode === 'name' || textMode === 'value_and_name' || (textMode === 'auto' && many)
  const showVal = textMode !== 'name' && textMode !== 'none'
  const bg = colorMode === 'background' || colorMode === 'background_solid' ? d.color : undefined
  const fg = bg ? contrastText(d.color) : colorMode === 'value' ? d.color : undefined
  const spark = mode.graphMode === 'area' && item.spark.length > 1
  // Fit the value text to the tile like Grafana's auto sizing.
  const chars = Math.max(2, d.text.length)
  const size = Math.max(12, Math.min(h * (showName ? 0.38 : 0.5) * (spark ? 0.8 : 1), (w * 0.9) / (chars * 0.62), many ? 32 : 56))
  const warn = d.tone === 'warn' || d.tone === 'bad'
  return (
    <div
      className={cn('relative flex min-w-0 flex-col overflow-hidden rounded-md text-center', mode.justifyMode === 'center' || !many ? 'items-center justify-center' : 'items-center justify-center')}
      style={bg ? { background: colorMode === 'background' ? `linear-gradient(120deg, color-mix(in oklab, ${bg} 82%, white), ${bg})` : bg, color: fg } : undefined}
    >
      {spark ? <Spark points={item.spark} color={bg ? fg ?? '#fff' : d.color ?? 'var(--color-brand-500)'} onBg={!!bg} /> : null}
      <div className="relative z-[1] flex max-w-full flex-col items-center px-1">
        {showName ? <div className={cn('max-w-full truncate text-[11px]', bg ? '' : 'text-content-subtle')} title={item.name}>{item.name}</div> : null}
        {showVal ? (
          <div className={cn('flex items-baseline gap-1 font-semibold leading-tight tabular-nums', bg ? '' : 'text-content')} style={{ fontSize: size, color: bg ? undefined : fg }}>
            {colorMode !== 'none' && !bg && d.color && d.tone !== 'neutral' && d.tone !== 'info' ? (
              <span aria-hidden className="text-[0.45em]">{TONE_ICON[d.tone]}</span>
            ) : null}
            <span className="truncate">{d.text}</span>
          </div>
        ) : null}
        {warn && showVal ? <div className="text-[10px] font-medium" style={{ color: bg ? undefined : d.color }}>{TONE_LABEL[d.tone]}</div> : null}
      </div>
    </div>
  )
}

function Spark({ points, color, onBg }: { points: Array<[number, number]>; color: string; onBg: boolean }) {
  const t0 = points[0][0]
  const t1 = points[points.length - 1][0]
  const vs = points.map((p) => p[1])
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * 100
  const y = (v: number) => 100 - ((v - lo) / Math.max(1e-12, hi - lo)) * 100
  const line = points.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(2)},${y(v).toFixed(2)}`).join('')
  return (
    <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-[45%] w-full">
      <path d={`${line}L100,100L0,100Z`} fill={color} fillOpacity={onBg ? 0.25 : 0.15} />
      <path d={line} fill="none" stroke={color} strokeOpacity={onBg ? 0.7 : 0.9} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function NoValue({ panel }: { panel: GrafanaPanel }) {
  const nv = panel.fieldConfig?.defaults?.noValue
  return (
    <div className="flex h-full items-center justify-center">
      <span className={cn(nv ? 'text-2xl font-semibold text-content-muted' : 'text-[11px] text-content-subtle')}>{nv ?? 'No data'}</span>
    </div>
  )
}

/* ─────────── gauge ─────────── */

export function GaugeViz({ panel, frames }: { panel: GrafanaPanel; frames: Frames }) {
  const list = useMemo(() => items(panel, frames).slice(0, 24), [panel, frames])
  const o = (panel.options ?? {}) as { showThresholdMarkers?: boolean; showThresholdLabels?: boolean }
  const ref = useRef<HTMLDivElement>(null)
  const box = useBox(ref)
  if (!list.length) return <NoValue panel={panel} />
  const named = list.length > 1
  const grid = gaugeGrid(list.length, box.w, box.h, named)
  return (
    <div
      ref={ref}
      className={cn('grid h-full min-h-0 min-w-0', grid.scroll ? 'overflow-y-auto overflow-x-hidden' : 'overflow-hidden')}
      style={{
        gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
        gridAutoRows: grid.scroll ? `${grid.cellH}px` : `minmax(0, 1fr)`,
        gap: GAUGE_GAP,
      }}
    >
      {box.w > 0 && box.h > 0
        ? list.map((it) => (
          <Gauge
            key={it.key}
            item={it}
            w={grid.cellW}
            h={grid.cellH - (named ? GAUGE_NAME_H : 0)}
            markers={o.showThresholdMarkers !== false}
            labels={!!o.showThresholdLabels}
            named={named}
          />
        ))
        : null}
    </div>
  )
}

function Gauge({ item, w, h, markers, labels, named }: { item: DisplayItem; w: number; h: number; markers: boolean; labels: boolean; named: boolean }) {
  const cfg = item.field.config
  const min = cfg.min ?? 0
  const max = cfg.max ?? (cfg.unit === 'percentunit' ? 1 : 100)
  const d = show(item, { min, max })
  const steps = cfg.thresholds?.steps ?? []
  const fracOf = (v: number) => (cfg.thresholds?.mode === 'percentage' ? v / 100 : (v - min) / Math.max(1e-12, max - min))
  const labelTexts = steps.filter((s) => s.value != null).map((s) => formatUnit(s.value!, cfg.unit, cfg.decimals))
  const g = gaugeGeometry(w, h, {
    markers,
    labels,
    valueChars: d.text.length,
    labelChars: Math.max(0, ...labelTexts.map((t) => t.length)),
  })
  const pct = gaugeFraction(item.value, min, max)
  const color = d.color ?? 'var(--color-brand-500)'
  // Threshold colours are tuned for arcs, not text: yellow on white is
  // unreadable. Pull the value text toward the content colour so it reads in
  // both themes while still carrying the status hue.
  const textColor = color === 'var(--color-content)' ? color : `color-mix(in oklab, ${color} 70%, var(--color-content))`
  const warn = d.tone === 'warn' || d.tone === 'bad'
  const label = `${item.name}: ${d.text}${warn ? ` (${TONE_LABEL[d.tone]})` : ''}`
  const name = named ? <span className="block h-4 max-w-full truncate text-center text-[10.5px] leading-4 text-content-muted" title={item.name}>{item.name}</span> : null

  if (g.compact) {
    // Too small for a dial: value, then a thin bar carrying the same fill.
    return (
      <div className="flex min-h-0 min-w-0 flex-col items-stretch justify-center gap-1 px-1" role="meter" aria-valuenow={item.value ?? undefined} aria-valuemin={min} aria-valuemax={max} aria-label={label}>
        <span className="truncate text-center text-[13px] font-semibold tabular-nums" style={{ color: textColor }}>{d.text}</span>
        <span className="relative h-1.5 overflow-hidden rounded-full bg-surface-sunken">
          <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct * 100}%`, background: color }} />
        </span>
        {name}
      </div>
    )
  }

  const start = -GAUGE_SWEEP / 2
  const end = start + GAUGE_SWEEP
  const bands = thresholdBands(steps.map((s) => ({ value: s.value, color: grafanaColor(s.color) })), fracOf)
  const split = splitValueText(d.text)
  const sep = 0.8 // degrees between threshold segments
  return (
    <div className="flex min-h-0 min-w-0 flex-col items-center justify-center overflow-hidden">
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${g.w.toFixed(2)} ${g.h.toFixed(2)}`}
        preserveAspectRatio="xMidYMid meet"
        className="block min-h-0 flex-1"
        role="meter"
        aria-valuenow={item.value ?? undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label={label}
      >
        <path d={arcPath(g.cx, g.cy, g.r, start, end)} fill="none" stroke="var(--color-surface-sunken)" strokeWidth={g.thick} />
        {pct > 0 ? <path d={arcPath(g.cx, g.cy, g.r, start, start + GAUGE_SWEEP * Math.max(0.004, pct))} fill="none" stroke={color} strokeWidth={g.thick} /> : null}
        {g.markers
          ? bands.map((b, i) => (
            <path
              key={i}
              d={arcPath(g.cx, g.cy, g.markerR, start + GAUGE_SWEEP * b.a + (i ? sep / 2 : 0), start + GAUGE_SWEEP * b.b - (i < bands.length - 1 ? sep / 2 : 0))}
              fill="none"
              stroke={b.color ?? 'var(--color-edge-strong)'}
              strokeWidth={g.markerW}
            />
          ))
          : null}
        {g.labels
          ? steps.filter((s) => s.value != null).map((s, i) => {
            const deg = start + GAUGE_SWEEP * Math.max(0, Math.min(1, fracOf(s.value!)))
            const [x, y] = polar(g.cx, g.cy, g.labelR, deg)
            const anchor = Math.abs(x - g.cx) < g.labelR * 0.25 ? 'middle' : x < g.cx ? 'end' : 'start'
            return (
              <text key={i} x={x} y={y + g.labelFont * 0.35} textAnchor={anchor} fontSize={g.labelFont} fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">
                {formatUnit(s.value!, cfg.unit, cfg.decimals)}
              </text>
            )
          })
          : null}
        <text x={g.cx} y={g.valueY} textAnchor="middle" fontSize={g.valueFont} fontWeight="600" fill={textColor} style={{ fontVariantNumeric: 'tabular-nums' }}>
          {split.unit || split.prefix
            ? (
              <>
                {split.prefix ? <tspan fontSize={g.valueFont * 0.6}>{split.prefix}</tspan> : null}
                <tspan>{split.number}</tspan>
                {split.unit ? <tspan fontSize={g.valueFont * 0.55} dx={g.valueFont * 0.06} fill="var(--color-content-muted)" fontWeight="500">{split.unit}</tspan> : null}
              </>
            )
            : d.text}
        </text>
        {warn
          ? (
            <text x={g.cx} y={g.statusY} textAnchor="middle" fontSize={g.statusFont} fontWeight="500" fill={textColor}>
              {TONE_ICON[d.tone]} {TONE_LABEL[d.tone]}
            </text>
          )
          : null}
      </svg>
      {name}
    </div>
  )
}

/* ─────────── bar gauge ─────────── */

export function BarGaugeViz({ panel, frames }: { panel: GrafanaPanel; frames: Frames }) {
  const list = useMemo(() => items(panel, frames).slice(0, 200), [panel, frames])
  const o = (panel.options ?? {}) as { displayMode?: string; orientation?: string; showUnfilled?: boolean; valueMode?: string; namePlacement?: string; maxVizHeight?: number; minVizHeight?: number }
  const ref = useRef<HTMLDivElement>(null)
  const box = useBox(ref)
  if (!list.length) return <NoValue panel={panel} />
  const g = globalRange(list)
  const vertical = o.orientation === 'vertical' || (o.orientation !== 'horizontal' && box.h > box.w)
  if (vertical) return <VerticalBars panel={panel} list={list} range={g} />
  const nameLeft = o.namePlacement === 'left' || (o.namePlacement !== 'top' && box.w > 360)
  const rowH = Math.max(o.minVizHeight ?? 16, Math.min(o.maxVizHeight ?? 300, box.h > 0 ? box.h / list.length - (nameLeft ? 4 : 18) : 16))
  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col justify-center gap-1 overflow-auto pr-1">
      {list.map((it) => {
        const cfg = it.field.config
        const min = cfg.min ?? g.min
        const max = cfg.max ?? g.max
        const d = show(it, { min, max })
        const pct = it.value == null ? 0 : Math.max(0, Math.min(1, (it.value - min) / Math.max(1e-12, max - min)))
        const color = d.color ?? 'var(--color-brand-500)'
        const steps = cfg.thresholds?.steps ?? []
        const mode = o.displayMode ?? 'gradient'
        const fill = mode === 'gradient'
          ? (cfg.color?.mode ?? 'thresholds') === 'thresholds' && steps.length > 1
            ? `linear-gradient(to right, ${steps.map((s, i) => {
              const p = s.value == null ? 0 : Math.max(0, Math.min(100, ((s.value - min) / Math.max(1e-12, max - min)) * 100))
              return `${grafanaColor(s.color)} ${i === 0 ? 0 : p}%`
            }).join(', ')})`
            : `linear-gradient(to right, color-mix(in oklab, ${color} 30%, transparent), ${color})`
          : color
        const valueEl = o.valueMode === 'hidden' ? null : (
          <span className="shrink-0 text-right font-mono text-[11px] font-semibold tabular-nums" style={{ color: o.valueMode === 'text' ? undefined : color === 'var(--color-content)' ? undefined : color }}>
            {d.text}
          </span>
        )
        return (
          <div key={it.key} className={cn('min-w-0', nameLeft ? 'flex items-center gap-2' : '')}>
            <div className={cn('truncate text-[11px] text-content-muted', nameLeft ? 'w-[30%] shrink-0 text-right' : '')} title={it.name}>{it.name}</div>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div
                className={cn('relative min-w-0 flex-1 overflow-hidden rounded-sm', o.showUnfilled === false ? '' : 'bg-surface-sunken')}
                style={{ height: Math.max(6, Math.min(rowH, 40)) }}
                role="meter"
                aria-valuenow={it.value ?? undefined}
                aria-valuemin={min}
                aria-valuemax={max}
                aria-label={`${it.name}: ${d.text}`}
              >
                {mode === 'lcd' ? (
                  <div className="absolute inset-0 flex gap-px">
                    {Array.from({ length: 24 }, (_, i) => (
                      <span key={i} className="h-full flex-1" style={{ backgroundColor: color, opacity: (i + 0.5) / 24 <= pct ? 1 : 0.12 }} />
                    ))}
                  </div>
                ) : (
                  <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${pct * 100}%` }}>
                    <div className="h-full" style={{ width: pct > 0 ? `${100 / pct}%` : '100%', background: fill }} />
                  </div>
                )}
              </div>
              {valueEl}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function VerticalBars({ panel, list, range }: { panel: GrafanaPanel; list: DisplayItem[]; range: { min: number; max: number } }) {
  return (
    <div className="flex h-full min-h-0 items-end gap-1.5 overflow-x-auto" aria-label={panel.title}>
      {list.map((it) => {
        const cfg = it.field.config
        const min = cfg.min ?? range.min
        const max = cfg.max ?? range.max
        const d = show(it, { min, max })
        const pct = it.value == null ? 0 : Math.max(0, Math.min(1, (it.value - min) / Math.max(1e-12, max - min)))
        return (
          <div key={it.key} className="flex h-full min-w-[28px] flex-1 flex-col items-center gap-0.5">
            <span className="font-mono text-[10px] font-semibold tabular-nums" style={{ color: d.color }}>{d.text}</span>
            <div className="relative w-full flex-1 overflow-hidden rounded-sm bg-surface-sunken" role="meter" aria-valuenow={it.value ?? undefined} aria-label={`${it.name}: ${d.text}`}>
              <div className="absolute inset-x-0 bottom-0" style={{ height: `${pct * 100}%`, background: d.color ?? 'var(--color-brand-500)' }} />
            </div>
            <span className="max-w-full truncate text-[10px] text-content-subtle" title={it.name}>{it.name}</span>
          </div>
        )
      })}
    </div>
  )
}

/* ─────────── pie ─────────── */

export function PieViz({ panel, frames }: { panel: GrafanaPanel; frames: Frames }) {
  const list = useMemo(() => items(panel, frames).filter((i) => (i.value ?? 0) > 0).slice(0, 60), [panel, frames])
  const o = (panel.options ?? {}) as { pieType?: string; legend?: { showLegend?: boolean; displayMode?: string; placement?: string; values?: string[] }; displayLabels?: string[] }
  const ref = useRef<HTMLDivElement>(null)
  const box = useBox(ref)
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null)
  if (!list.length) return <NoValue panel={panel} />
  const total = list.reduce((a, b) => a + (b.value ?? 0), 0)
  const colorOf = (it: DisplayItem, i: number) => {
    const mode = it.field.config.color?.mode ?? 'palette-classic'
    if (mode.startsWith('palette') || mode === 'thresholds' && !it.field.config.thresholds?.steps?.length) return seriesColor(i)
    return show(it).color ?? seriesColor(i)
  }
  const legendRight = (o.legend?.placement ?? 'right') === 'right' && box.w > 360
  const showLegend = o.legend?.showLegend !== false
  const lv = o.legend?.values ?? []
  const size = Math.max(40, Math.min(legendRight ? box.w * 0.55 : box.w, box.h - (legendRight || !showLegend ? 0 : Math.min(box.h * 0.4, list.length * 16)))) - 4
  const r = size / 2
  const inner = o.pieType === 'donut' ? r * 0.6 : 0
  let acc = 0
  const slices = list.map((it, i) => {
    const a0 = (acc / total) * 360
    acc += it.value ?? 0
    const a1 = (acc / total) * 360
    return { it, i, a0, a1, color: colorOf(it, i) }
  })
  const rows = slices.map(({ it, i, color }) => {
    const d = show(it)
    const values: Record<string, string> = { value: d.text, percent: `${(((it.value ?? 0) / total) * 100).toFixed(1)}%` }
    return { key: it.key, name: it.name, color, values, raw: { value: it.value, percent: it.value }, i }
  })
  const tipRow = tip ? rows[tip.i] : null
  return (
    <div ref={ref} className={cn('flex h-full min-h-0 gap-2', legendRight ? 'flex-row items-center' : 'flex-col items-center')}>
      {box.w > 0 ? (
        <svg width={size} height={size} viewBox={`${-r - 1} ${-r - 1} ${size + 2} ${size + 2}`} className="shrink-0" role="img" aria-label={`${panel.title ?? 'Pie'}: ${rows.map((x) => `${x.name} ${x.values.percent}`).join(', ')}`} onMouseLeave={() => setTip(null)}>
          {slices.map((s) => {
            const full = s.a1 - s.a0 >= 359.99
            const p = (deg: number, rad: number) => polar(0, 0, rad, deg)
            const [ox0, oy0] = p(s.a0, r)
            const [ox1, oy1] = p(s.a1, r)
            const [ix1, iy1] = p(s.a1, inner)
            const [ix0, iy0] = p(s.a0, inner)
            const large = s.a1 - s.a0 > 180 ? 1 : 0
            const d = full
              ? `M0,${-r}A${r},${r} 0 1 1 -0.01,${-r}Z${inner ? `M0,${-inner}A${inner},${inner} 0 1 0 0.01,${-inner}Z` : ''}`
              : inner
              ? `M${ox0},${oy0}A${r},${r} 0 ${large} 1 ${ox1},${oy1}L${ix1},${iy1}A${inner},${inner} 0 ${large} 0 ${ix0},${iy0}Z`
              : `M0,0L${ox0},${oy0}A${r},${r} 0 ${large} 1 ${ox1},${oy1}Z`
            return (
              <path
                key={s.it.key}
                d={d}
                fill={s.color}
                fillRule="evenodd"
                stroke="var(--color-surface-raised)"
                strokeWidth="1"
                opacity={tip && tip.i !== s.i ? 0.55 : 1}
                onMouseMove={(e) => setTip({ i: s.i, x: e.clientX, y: e.clientY })}
              />
            )
          })}
        </svg>
      ) : null}
      {showLegend ? (
        <div className={cn('min-h-0 min-w-0 overflow-auto', legendRight ? 'max-h-full flex-1' : 'w-full')}>
          <Legend
            rows={rows}
            calcs={lv}
            calcLabels={{ value: 'Value', percent: 'Percent' }}
            mode={o.legend?.displayMode === 'table' ? 'table' : 'list'}
            placement={legendRight ? 'right' : 'bottom'}
            shape="square"
          />
        </div>
      ) : null}
      {tip && tipRow ? (
        <HoverTip x={tip.x} y={tip.y}>
          <div className="flex items-center gap-1.5">
            <Swatch shape="square" color={tipRow.color} />
            <span className="text-content-muted">{tipRow.name}</span>
            <span className="pl-2 font-semibold">{tipRow.values.value}</span>
            <span className="text-content-subtle">{tipRow.values.percent}</span>
          </div>
        </HoverTip>
      ) : null}
    </div>
  )
}
