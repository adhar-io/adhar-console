import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  GAUGE_MIN_CELL,
  GAUGE_NAME_H,
  gaugeFraction,
  gaugeGeometry,
  gaugeGrid,
  gaugeInkBounds,
  splitValueText,
  thresholdBands,
} from './grafana-gauge.ts'

const inside = (w: number, h: number, markers = true, labels = false) => {
  const g = gaugeGeometry(w, h, { markers, labels, valueChars: 5, labelChars: 4 })
  const b = gaugeInkBounds(g)
  return { g, b, ok: b.x0 >= 0 && b.y0 >= 0 && b.x1 <= w + 1e-6 && b.y1 <= h + 1e-6 }
}

Deno.test('the dial and its threshold band stay inside the box at any size', () => {
  // Includes the Adhar Platform board's 4- and 6-column gauges at 1440px
  // (≈160 × 184) and the full-width mobile panel (≈330 × 184).
  const sizes = [[160, 184], [330, 184], [184, 160], [600, 90], [90, 600], [1200, 400], [60, 60], [40, 300], [300, 40], [220, 1000]]
  for (const [w, h] of sizes) {
    for (const markers of [true, false]) {
      for (const labels of [true, false]) {
        const r = inside(w, h, markers, labels)
        if (r.g.compact) continue
        assert(r.ok, `${w}×${h} markers=${markers} labels=${labels}: ink ${JSON.stringify(r.b)}`)
      }
    }
  }
})

Deno.test('the old clipping case: band no longer overflows a wide-enough panel', () => {
  const { g, ok } = inside(160, 184)
  assert(ok)
  assert(g.markers)
  // The band is the outermost ink and it is inside the half-width.
  assert(g.markerR + g.markerW / 2 <= 80)
})

Deno.test('the radius comes from the limiting side', () => {
  const wide = gaugeGeometry(1000, 150, { markers: true, labels: false, valueChars: 4 })
  const tall = gaugeGeometry(150, 1000, { markers: true, labels: false, valueChars: 4 })
  assert(Math.abs(wide.outer - (150 - 4) / 1.5) < 1e-6)
  assert(Math.abs(tall.outer - (150 - 4) / 2) < 1e-6)
})

Deno.test('tiny boxes fall back to a compact readout, small ones drop markers and labels', () => {
  assertEquals(gaugeGeometry(40, 30, { markers: true, labels: true, valueChars: 4 }).compact, true)
  const small = gaugeGeometry(80, 70, { markers: true, labels: true, valueChars: 4 })
  assertEquals(small.compact, false)
  assertEquals(small.labels, false)
  assertEquals(small.markers, true)
  const tiny = gaugeGeometry(64, 48, { markers: true, labels: false, valueChars: 4 })
  assertEquals(tiny.markers, false)
})

Deno.test('the value text fits inside the arc', () => {
  for (const chars of [2, 5, 9, 14]) {
    const g = gaugeGeometry(200, 180, { markers: true, labels: false, valueChars: chars })
    const inner = g.r - g.thick / 2
    assert(g.valueFont <= inner * 0.6 + 1e-6 || g.valueFont === 10)
    assert(chars * g.valueFont * 0.58 <= inner * 1.7 + 1e-6 || g.valueFont === 10)
    assert(g.statusY <= g.cy + g.outer * 0.5 + 1e-6)
  }
})

Deno.test('one gauge fills the panel', () => {
  assertEquals(gaugeGrid(1, 300, 180, false), { cols: 1, rows: 1, cellW: 300, cellH: 180, scroll: false })
})

Deno.test('several gauges pick the column count that makes dials largest', () => {
  assertEquals(gaugeGrid(4, 800, 180, true).cols, 4)
  assertEquals(gaugeGrid(4, 300, 600, true).cols, 1)
  const sq = gaugeGrid(4, 400, 400, true)
  assertEquals([sq.cols, sq.rows], [2, 2])
})

Deno.test('many gauges in a small panel wrap and scroll instead of squeezing', () => {
  const g = gaugeGrid(12, 360, 180, true)
  assertEquals(g.scroll, true)
  assert(g.cellW >= GAUGE_MIN_CELL.w)
  assert(g.cellH >= GAUGE_MIN_CELL.h)
  assertEquals(g.cols, 3)
  assertEquals(g.rows, 4)
  assert(g.cellH - GAUGE_NAME_H > 0)
})

Deno.test('value text splits into number and unit', () => {
  assertEquals(splitValueText('45.2%'), { prefix: '', number: '45.2', unit: '%' })
  assertEquals(splitValueText('1.21 GiB'), { prefix: '', number: '1.21', unit: 'GiB' })
  assertEquals(splitValueText('$3.20'), { prefix: '$', number: '3.20', unit: '' })
  assertEquals(splitValueText('-12 ms'), { prefix: '', number: '-12', unit: 'ms' })
  assertEquals(splitValueText('N/A'), { prefix: '', number: 'N/A', unit: '' })
  assertEquals(splitValueText('—'), { prefix: '', number: '—', unit: '' })
})

Deno.test('fraction and threshold bands', () => {
  assertEquals(gaugeFraction(50, 0, 100), 0.5)
  assertEquals(gaugeFraction(150, 0, 100), 1)
  assertEquals(gaugeFraction(null, 0, 100), 0)
  const frac = (v: number) => v / 100
  assertEquals(thresholdBands([{ value: null, color: 'g' }, { value: 70, color: 'y' }, { value: 85, color: 'r' }], frac), [
    { a: 0, b: 0.7, color: 'g' },
    { a: 0.7, b: 0.85, color: 'y' },
    { a: 0.85, b: 1, color: 'r' },
  ])
  // A step beyond max collapses away.
  assertEquals(thresholdBands([{ value: null, color: 'g' }, { value: 120, color: 'r' }], frac), [{ a: 0, b: 1, color: 'g' }])
})

Deno.test('threshold labels reserve their sideways width', () => {
  const g = gaugeGeometry(400, 200, { markers: true, labels: true, valueChars: 5, labelChars: 4 })
  assert(g.labels)
  const textW = 4 * g.labelFont * 0.6
  // A label at 9 o'clock runs left from labelR; it must end inside the box.
  assert(g.cx - g.labelR - textW >= 0)
  assert(g.cx + g.labelR + textW <= 400)
})
