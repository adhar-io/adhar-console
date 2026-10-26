/**
 * Gauge geometry and layout for the native Grafana gauge panel.
 *
 * Everything that decides where a dial's ink goes is computed here, from the
 * pixel box the dial gets, so nothing is ever drawn outside that box: the old
 * renderer sized the arc from the panel width and then drew the threshold
 * band *outside* the arc, which at common panel sizes pushed the band (and
 * the value arc's stroke) past the SVG edge, clipping the dial at the sides.
 *
 * The rule now is outside-in: start from the largest outer radius the box can
 * hold for a 240° dial (2R wide, 1.5R tall), then spend that radius inwards on
 * the threshold labels, the threshold band, a gap, and finally the value arc.
 * The value text is sized from the arc's inner radius and its length.
 *
 * JSX-free so the Deno test runner covers it (`grafana-gauge_test.ts`).
 */

/** Degrees of arc a Grafana gauge sweeps (gap at the bottom). */
export const GAUGE_SWEEP = 240
/** Height reserved under each dial for its name when a panel shows several. */
export const GAUGE_NAME_H = 16
/** Below this outer radius a dial is illegible: draw a compact readout instead. */
export const GAUGE_MIN_RADIUS = 26
/** Gap between dials in a multi-value panel. */
export const GAUGE_GAP = 8
/** Smallest cell a dial is given before the grid wraps and scrolls instead of squeezing. */
export const GAUGE_MIN_CELL = { w: 112, h: 96 }

/** Height of the dial's bounding box per unit of outer radius (top at -R, arc ends at +R/2). */
const HEIGHT_PER_R = 1.5
/** Breathing room so anti-aliased edges are not shaved by the viewBox. */
const EDGE = 2

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export interface GaugeGeometryInput {
  markers: boolean
  labels: boolean
  /** Characters in the value text (number + unit), to fit it inside the dial. */
  valueChars: number
  /** Longest threshold label, in characters (only used with `labels`). */
  labelChars?: number
}

export interface GaugeGeometry {
  /** Pixel box the SVG uses as its viewBox. */
  w: number
  h: number
  /** Too small for a dial; render a compact text + bar readout. */
  compact: boolean
  cx: number
  cy: number
  /** Outermost radius used by any ink. */
  outer: number
  /** Centre-line radius and stroke width of the track / value arc. */
  r: number
  thick: number
  /** Threshold band (0 width when off). */
  markers: boolean
  markerR: number
  markerW: number
  /** Threshold labels (0 font when off). */
  labels: boolean
  labelR: number
  labelFont: number
  /** Value text: font size and baseline. */
  valueFont: number
  valueY: number
  /** Optional status word under the value. */
  statusFont: number
  statusY: number
}

/** Outer radius a `w × h` box can hold for a 240° dial. */
export function gaugeRadius(w: number, h: number): number {
  return Math.max(0, Math.min((w - 2 * EDGE) / 2, (h - 2 * EDGE) / HEIGHT_PER_R))
}

/**
 * The geometry of one dial inside a `w × h` pixel box. Every radius and font
 * is derived from the box, so the dial is fully inside it at any size.
 */
export function gaugeGeometry(w: number, h: number, input: GaugeGeometryInput): GaugeGeometry {
  const W = Math.max(0, w)
  const H = Math.max(0, h)
  // Threshold labels sit outside the band; on the sides they are anchored to
  // run outwards (away from the dial), so reserve their width horizontally
  // beyond the half of the label band they start in.
  let labels = input.labels
  let labelFont = labels ? clamp(gaugeRadius(W, H) * 0.08, 8, 10) : 0
  const overhang = (font: number) => (labels ? Math.max(0, (input.labelChars ?? 3) * font * 0.6 - font * 0.75) : 0)
  let outer = Math.max(0, Math.min((W - 2 * EDGE - 2 * overhang(labelFont)) / 2, (H - 2 * EDGE) / HEIGHT_PER_R))
  if (labels && outer < 56) {
    // No room for labels: give their space back to the dial.
    labels = false
    labelFont = 0
    outer = gaugeRadius(W, H)
  }
  const markers = input.markers && outer >= 34
  const compact = outer < GAUGE_MIN_RADIUS

  const labelBand = labels ? labelFont * 1.5 : 0
  const markerW = markers ? clamp(outer * 0.035, 2, 5) : 0
  const markerGap = markers ? clamp(outer * 0.03, 1.5, 4) : 0
  const arcOuter = Math.max(0, outer - labelBand - markerW - markerGap)
  const thick = clamp(arcOuter * 0.2, 4, 28)
  const r = Math.max(0, arcOuter - thick / 2)
  const inner = Math.max(0, r - thick / 2)

  // Centre the dial's 2R × 1.5R bounding box in the cell.
  const cx = W / 2
  const cy = (H - outer * HEIGHT_PER_R) / 2 + outer

  const chars = Math.max(2, input.valueChars)
  const valueFont = clamp(Math.min(inner * 0.6, (inner * 1.7) / (chars * 0.58)), 10, 64)
  const statusFont = clamp(valueFont * 0.32, 9, 12)
  // Value centred on the dial; the status word below it, still above the arc ends.
  const valueY = cy + valueFont * 0.35
  const statusY = Math.min(valueY + statusFont * 1.4, cy + outer * 0.5)

  return {
    w: W,
    h: H,
    compact,
    cx,
    cy,
    outer,
    r,
    thick,
    markers,
    markerR: arcOuter + markerGap + markerW / 2,
    markerW,
    labels,
    labelR: arcOuter + markerGap + markerW + labelBand / 2,
    labelFont,
    valueFont,
    valueY,
    statusFont,
    statusY,
  }
}

/** Point on a circle, 0° = 12 o'clock, clockwise. */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

/** SVG path for a clockwise arc from `a0` to `a1` degrees. */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const f = (n: number) => n.toFixed(2)
  return `M${f(x0)},${f(y0)}A${f(r)},${f(r)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f(x1)},${f(y1)}`
}

/** Bounding box of every point the dial draws (for tests and sanity checks). */
export function gaugeInkBounds(g: GaugeGeometry): { x0: number; y0: number; x1: number; y1: number } {
  const start = -GAUGE_SWEEP / 2
  const radii = [g.r + g.thick / 2, g.r - g.thick / 2]
  if (g.markers) radii.push(g.markerR + g.markerW / 2)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let deg = start; deg <= start + GAUGE_SWEEP + 1e-9; deg += 1) {
    for (const rad of radii) {
      const [x, y] = polar(g.cx, g.cy, rad, deg)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return { x0, y0, x1, y1 }
}

export interface GaugeGrid {
  cols: number
  rows: number
  cellW: number
  cellH: number
  /** The cells need more height than the panel has: the grid scrolls. */
  scroll: boolean
}

/**
 * How to lay `n` dials out in a `w × h` panel: the column count that gives
 * each dial the largest radius, and — when even that would make dials too
 * small to read — wrap onto rows of a minimum cell size and scroll, rather
 * than squeeze them.
 */
export function gaugeGrid(n: number, w: number, h: number, named: boolean): GaugeGrid {
  const count = Math.max(1, n)
  const nameH = named ? GAUGE_NAME_H : 0
  const cell = (cols: number) => {
    const rows = Math.ceil(count / cols)
    const cellW = (w - (cols - 1) * GAUGE_GAP) / cols
    const cellH = (h - (rows - 1) * GAUGE_GAP) / rows
    return { cols, rows, cellW, cellH, radius: gaugeRadius(cellW, cellH - nameH) }
  }
  let best = cell(1)
  for (let cols = 2; cols <= count; cols++) {
    const c = cell(cols)
    if (c.radius > best.radius + 0.5) best = c
  }
  const roomy = best.cellW >= GAUGE_MIN_CELL.w && best.cellH >= GAUGE_MIN_CELL.h
  if (count === 1 || best.radius >= GAUGE_MIN_RADIUS * 1.6 || roomy) {
    return { cols: best.cols, rows: best.rows, cellW: Math.max(0, best.cellW), cellH: Math.max(0, best.cellH), scroll: false }
  }
  const cols = clamp(Math.floor((w + GAUGE_GAP) / (GAUGE_MIN_CELL.w + GAUGE_GAP)), 1, count)
  const rows = Math.ceil(count / cols)
  const cellW = Math.max(0, (w - (cols - 1) * GAUGE_GAP) / cols)
  const cellH = Math.max(GAUGE_MIN_CELL.h, (h - (rows - 1) * GAUGE_GAP) / rows)
  return { cols, rows, cellW, cellH, scroll: rows * cellH + (rows - 1) * GAUGE_GAP > h + 0.5 }
}

/**
 * "45.2%" → { prefix: '', number: '45.2', unit: '%' } so the unit can be set
 * smaller than the number. Text that is not a formatted number comes back
 * whole in `number`.
 */
export function splitValueText(text: string): { prefix: string; number: string; unit: string } {
  const m = /^([^\d+\-.]{0,3}?)\s*([+-]?(?:\d[\d,]*)(?:\.\d+)?)\s*([^\d\s][^\d]{0,7})?$/.exec(text.trim())
  if (!m) return { prefix: '', number: text, unit: '' }
  return { prefix: m[1] ?? '', number: m[2], unit: (m[3] ?? '').trim() }
}

/** Fraction (0..1) of the sweep a value fills; null/NaN → 0. */
export function gaugeFraction(value: number | null | undefined, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return 0
  return clamp((value - min) / Math.max(1e-12, max - min), 0, 1)
}

/** Threshold steps → coloured sweep segments (fractions of the dial). */
export function thresholdBands(
  steps: ReadonlyArray<{ value?: number | null; color?: string }>,
  frac: (v: number) => number,
): Array<{ a: number; b: number; color?: string }> {
  return steps
    .map((s, i) => {
      const a = s.value == null ? 0 : clamp(frac(s.value), 0, 1)
      const next = steps[i + 1]?.value
      const b = next == null ? 1 : clamp(frac(next), 0, 1)
      return { a, b, color: s.color }
    })
    .filter((x) => x.b > x.a)
}
