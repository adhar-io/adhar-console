import { assert, assertEquals } from 'jsr:@std/assert@1'
import { PdfDocument } from './writer.ts'
import { type ChartBox, drawLineChart, Layout, lineCharts, timelineChart } from './kit.ts'

const decode = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('')

/** Every point a chart draws (rect corners, line ends, polyline vertices, text origins). */
function spy(doc: PdfDocument): Array<[number, number, string]> {
  const marks: Array<[number, number, string]> = []
  const d = doc as unknown as Record<string, (...a: unknown[]) => void>
  const wrap = (name: string, pick: (...a: never[]) => Array<[number, number]>) => {
    const orig = d[name].bind(doc)
    d[name] = (...a: unknown[]) => {
      for (const [x, y] of pick(...(a as never[]))) marks.push([x, y, name])
      orig(...a)
    }
  }
  wrap('rect', (x: number, top: number, w: number, h: number) => [[x, top], [x + w, top + h]])
  wrap('line', (x1: number, t1: number, x2: number, t2: number) => [[x1, t1], [x2, t2]])
  wrap('polyline', (pts: Array<[number, number]>) => pts)
  wrap('text', (_s: string, x: number, top: number) => [[x, top]])
  return marks
}

const inside = (b: ChartBox, [x, y]: [number, number, string]) => x >= b.x - 0.01 && x <= b.x + b.w + 0.01 && y >= b.top - 0.01 && y <= b.top + b.h + 0.01

const T0 = Date.parse('2026-10-22T09:50:00Z')
const pts = (n: number, f: (i: number) => number): Array<[number, number]> => Array.from({ length: n }, (_, i) => [T0 + i * 15_000, f(i)])

Deno.test('a chart never draws outside its box — spikes, out-of-domain points and bands are clipped', () => {
  const doc = new PdfDocument()
  doc.addPage()
  const marks = spy(doc)
  const box: ChartBox = { x: 40, top: 100, w: 250, h: 110 }
  drawLineChart(doc, box, {
    title: 'Error rate (5xx) — a title long enough that it has to be shortened to fit the chart box',
    caption: 'peak 12% during faults',
    series: [
      { points: [...pts(40, (i) => (i === 20 ? 1e9 : i % 5)), [T0 - 3600_000, 50], [T0 + 99 * 3600_000, 50]], color: [1, 0, 0] },
      { points: pts(40, () => -3), color: [0, 0, 1], dashed: true },
    ],
    bands: [{ start: T0 - 60_000, end: T0 + 5 * 60_000, color: [1, 0, 0] }, { start: T0 + 9 * 60_000, end: T0 + 99 * 3600_000, color: [1, 0.5, 0] }],
    domain: [T0, T0 + 39 * 15_000],
    yMax: 20,
    formatY: (v) => `${v}%`,
    formatX: (t) => new Date(t).toISOString().slice(11, 16),
  })
  assert(marks.length > 20)
  for (const m of marks) assert(inside(box, m), `mark ${m[2]} at ${m[0]},${m[1]} is outside the box`)
  assert(marks.some((m) => m[2] === 'polyline'))
})

Deno.test('an empty chart says why instead of drawing a flat line', () => {
  const doc = new PdfDocument()
  doc.addPage()
  const marks = spy(doc)
  const box: ChartBox = { x: 40, top: 100, w: 250, h: 110 }
  drawLineChart(doc, box, { title: 'p95 latency', series: [{ points: [], color: [0, 0, 0] }], emptyText: 'The application exports no HTTP request metrics.', formatY: String, formatX: String })
  assertEquals(marks.filter((m) => m[2] === 'polyline').length, 0)
  assert(decode(doc.output()).includes('(The application exports no HTTP request metrics.)'))
  for (const m of marks) assert(inside(box, m))
})

Deno.test('a chart grid paginates by row and a timeline stays within the margins', () => {
  const doc = new PdfDocument()
  doc.addPage()
  const L = new Layout(doc)
  L.y = 700
  const chart = { title: 'CPU', series: [{ points: pts(10, (i) => i), color: [0, 0, 1] as [number, number, number] }], formatY: String, formatX: String }
  lineCharts(L, [chart, chart, chart], { cols: 2, height: 110 })
  // The first row did not fit under y=700, the second fits under the first.
  assertEquals(doc.pageCount, 2)
  const marks = spy(doc)
  timelineChart(L, [
    { label: 'Load test', start: T0, end: T0 + 80_000, color: [0.4, 0.4, 0.9], note: 'passed' },
    { label: 'pod-delete', start: T0 + 81_000, end: T0 + 200_000, color: [0.9, 0.1, 0.3], note: 'Pass' },
  ], { formatX: (t) => new Date(t).toISOString().slice(11, 16) })
  for (const [x] of marks) assert(x >= 40 - 0.01 && x <= doc.width - 40 + 0.01)
  // The output is still a well-formed document.
  assert(decode(doc.output()).endsWith('%%EOF\n'))
})

Deno.test('polyline is one path with an optional dash', () => {
  const doc = new PdfDocument()
  doc.addPage()
  doc.polyline([[0, 0], [10, 10], [20, 0]], [1, 0, 0], 1, [2, 1])
  doc.polyline([[0, 0]], [1, 0, 0])
  const out = decode(doc.output())
  assertEquals((out.match(/\[2 1\] 0 d/g) ?? []).length, 1)
  assert(/0 841.89 m 10 831.89 l 20 841.89 l S/.test(out))
})
