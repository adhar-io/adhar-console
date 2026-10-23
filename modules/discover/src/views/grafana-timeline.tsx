import { type KeyboardEvent, useMemo, useRef, useState } from 'react'
import { cn } from '@adhar/utils'
import { formatUnit, type GrafanaPanel, grafanaColor } from '../data/grafana-board.ts'
import { displayValue, type FieldValue, type ResolvedField } from '../data/grafana-fields.ts'
import {
  buildStateLane,
  buildStatusCells,
  formatSpan,
  type TimelineSegment,
  timelineLegend,
} from '../data/grafana-timeline.ts'
import { anchorOf, contrastText, HoverTip, monoWidth, Swatch, TimeAxis, useBox } from './grafana-viz.tsx'
import { seriesColor } from './viz.tsx'

/**
 * Grafana state timeline / status history.
 *
 * One lane per number field. State timeline draws merged state segments
 * (each state lasts until the next sample); status history draws one cell per
 * sample. Colours come from value mappings, else the field colour mode
 * (thresholds / fixed / palette); every box carries its text when it fits
 * (`showValue`), the legend lists the states, and the hover / keyboard
 * tooltip gives the value text and its time span. Keyboard: Tab to a lane,
 * ←/→ to walk its states.
 */

interface Lane {
  key: string
  name: string
  field: ResolvedField
  segments: TimelineSegment[]
}

const MAX_LANES = 60

export function TimelineViz({
  panel,
  fields,
  range,
  stepMs,
  kind,
}: {
  panel: GrafanaPanel
  fields: ResolvedField[]
  range: { start: number; end: number }
  stepMs?: number
  kind: 'state-timeline' | 'status-history'
}) {
  const plotRef = useRef<HTMLDivElement>(null)
  const box = useBox(plotRef)
  const [tip, setTip] = useState<{ lane: number; seg: number; x: number; y: number } | null>(null)
  const o = (panel.options ?? {}) as {
    mergeValues?: boolean
    showValue?: 'auto' | 'never' | 'always'
    rowHeight?: number
    colWidth?: number
    alignValue?: 'left' | 'center' | 'right'
    legend?: { showLegend?: boolean; displayMode?: string }
    tooltip?: { mode?: string }
  }
  const showValue = o.showValue ?? 'auto'
  const rowHeight = Math.max(0.1, Math.min(1, o.rowHeight ?? 0.9))
  const align = o.alignValue ?? 'left'

  const lanes = useMemo<Lane[]>(() => {
    const out: Lane[] = []
    for (const f of fields) {
      if (f.type === 'time') continue
      const time = f.frame.fields.find((x) => x.type === 'time')
      if (!time) continue
      const custom = (f.config.custom ?? {}) as { spanNulls?: boolean | number; insertNulls?: false | number; hideFrom?: { viz?: boolean } }
      if (custom.hideFrom?.viz) continue
      const display = (v: FieldValue) => displayValue(f.config, v, seriesColor(Math.max(0, f.seriesIndex)))
      const opts = {
        rangeStart: range.start,
        rangeEnd: range.end,
        mergeValues: o.mergeValues ?? true,
        spanNulls: custom.spanNulls ?? false,
        insertNulls: custom.insertNulls,
        stepMs: f.config.interval ?? stepMs,
        display,
      }
      const segments = kind === 'status-history' ? buildStatusCells(time.values, f.values, opts) : buildStateLane(time.values, f.values, opts)
      out.push({ key: `${f.frameIndex}:${f.name}:${f.seriesIndex}`, name: f.displayName, field: f, segments })
      if (out.length >= MAX_LANES) break
    }
    return out
  }, [fields, range.start, range.end, stepMs, kind, o.mergeValues])

  const cfg0 = lanes[0]?.field.config ?? panel.fieldConfig?.defaults ?? {}
  const legend = useMemo(
    () =>
      timelineLegend(
        cfg0,
        lanes.map((l) => l.segments),
        (v) => displayValue(cfg0, v, '').text || formatUnit(v, cfg0.unit, cfg0.decimals),
        (c) => grafanaColor(c),
      ),
    [lanes, cfg0],
  )
  const showLegend = o.legend?.showLegend !== false && o.legend?.displayMode !== 'hidden' && legend.length > 0

  const W = Math.max(1, box.w)
  const H = Math.max(1, box.h)
  const axisH = 16
  // Lane labels take what they need, up to ~35% of the panel (truncated beyond).
  const labelW = Math.min(Math.max(...lanes.map((l) => monoWidth(l.name, 10)), 24) + 10, Math.max(56, W * 0.35))
  const x0 = labelW
  const x1 = W - 6
  const laneH = lanes.length ? (H - axisH) / lanes.length : 0
  const sx = (t: number) => x0 + ((t - range.start) / Math.max(1, range.end - range.start)) * (x1 - x0)
  const truncate = (s: string, px: number) => {
    const max = Math.floor(px / (10 * 0.62))
    return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s
  }

  const tipSeg = tip ? lanes[tip.lane]?.segments[tip.seg] : null
  const focusSeg = (laneIdx: number, segIdx: number, el: Element | null) => {
    const lane = lanes[laneIdx]
    const seg = lane?.segments[segIdx]
    if (!seg || !el) return
    const r = el.getBoundingClientRect()
    const cx = r.left + (sx(seg.start) + sx(seg.end)) / 2
    setTip({ lane: laneIdx, seg: segIdx, x: Math.min(cx, r.right), y: anchorOf(el).y })
  }
  const onLaneKey = (e: KeyboardEvent<SVGGElement>, laneIdx: number) => {
    const lane = lanes[laneIdx]
    if (!lane?.segments.length) return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const cur = tip?.lane === laneIdx ? tip.seg : lane.segments.length
    const n = lane.segments.length
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1)))
    focusSeg(laneIdx, next, plotRef.current)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      <div ref={plotRef} className="relative min-h-[40px] flex-1" onMouseLeave={() => setTip(null)}>
        {box.w > 0 && lanes.length ? (
          <svg width={W} height={H} className="absolute inset-0 block" role="list" aria-label={`${panel.title ?? 'State timeline'}: ${lanes.length} lanes`}>
            <TimeAxis start={range.start} end={range.end} x0={x0} x1={x1} y={H} gridTop={0} />
            {lanes.map((lane, li) => {
              const y = li * laneH
              const bh = Math.max(2, laneH * rowHeight)
              const by = y + (laneH - bh) / 2
              const last = lane.segments[lane.segments.length - 1]
              return (
                <g
                  key={lane.key}
                  tabIndex={0}
                  role="listitem"
                  aria-label={`${lane.name}: ${lane.segments.length} ${kind === 'status-history' ? 'samples' : 'states'}${last ? `, now ${last.text}` : ', no data'}`}
                  onKeyDown={(e) => onLaneKey(e, li)}
                  onFocus={() => lane.segments.length && focusSeg(li, lane.segments.length - 1, plotRef.current)}
                  onBlur={() => setTip(null)}
                  className="outline-none focus-visible:[&>rect.lane-bg]:stroke-[var(--color-brand-500)]"
                >
                  <rect className="lane-bg" x={x0 - 1} y={by - 1} width={Math.max(0, x1 - x0 + 2)} height={bh + 2} fill="transparent" stroke="transparent" strokeWidth="1.5" rx="3" />
                  <text x={x0 - 6} y={y + laneH / 2 + 3.5} textAnchor="end" fontSize="10" fill="var(--color-content-muted)">
                    <title>{lane.name}</title>
                    {truncate(lane.name, x0 - 10)}
                  </text>
                  {lane.segments.map((seg, si) => {
                    const sxs = sx(seg.start)
                    const w = Math.max(kind === 'status-history' ? 1 : 0.75, sx(seg.end) - sxs)
                    const cw = kind === 'status-history' ? Math.max(0.75, w * Math.max(0.1, Math.min(1, o.colWidth ?? 0.9))) : w
                    const cx = kind === 'status-history' ? sxs + (w - cw) / 2 : sxs
                    const fill = seg.color ?? 'var(--color-content-subtle)'
                    const opacity = Math.min(1, ((lane.field.config.custom as { fillOpacity?: number } | undefined)?.fillOpacity ?? 70) / 100)
                    const textW = monoWidth(seg.text, 10)
                    const fits = textW + 6 <= cw
                    const show = showValue === 'always' || (showValue === 'auto' && fits)
                    const active = tip?.lane === li && tip.seg === si
                    const tx = align === 'center' ? cx + cw / 2 : align === 'right' ? cx + cw - 4 : cx + 4
                    return (
                      <g
                        key={si}
                        onMouseMove={(e) => setTip({ lane: li, seg: si, x: e.clientX, y: e.clientY })}
                      >
                        <rect
                          x={cx}
                          y={by}
                          width={cw}
                          height={bh}
                          fill={fill}
                          fillOpacity={opacity}
                          stroke={active ? 'var(--color-content)' : fill}
                          strokeOpacity={active ? 0.9 : 0}
                          strokeWidth={active ? 1.5 : 0}
                          rx={kind === 'status-history' ? 1.5 : 0}
                        />
                        {show && bh >= 11 ? (
                          <text
                            x={tx}
                            y={by + bh / 2 + 3.5}
                            textAnchor={align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'}
                            fontSize="10"
                            fill={contrastText(seg.color)}
                            style={{ pointerEvents: 'none' }}
                          >
                            {fits ? seg.text : truncate(seg.text, cw - 6)}
                          </text>
                        ) : null}
                      </g>
                    )
                  })}
                </g>
              )
            })}
          </svg>
        ) : null}
      </div>
      {showLegend ? (
        <ul className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-content-muted" aria-label="States">
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <Swatch shape="square" color={l.color} />
              {l.label}
            </li>
          ))}
        </ul>
      ) : null}
      {tip && tipSeg && o.tooltip?.mode !== 'none' ? (
        <HoverTip x={tip.x} y={tip.y}>
          <div className="text-content-subtle">{lanes[tip.lane]?.name}</div>
          <div className={cn('flex items-center gap-1.5 font-sans text-[11px] font-semibold')}>
            <Swatch shape="square" color={tipSeg.color} />
            {tipSeg.text}
          </div>
          <div className="text-content-subtle">{formatSpan(tipSeg.start, tipSeg.end)}</div>
        </HoverTip>
      ) : null}
    </div>
  )
}
