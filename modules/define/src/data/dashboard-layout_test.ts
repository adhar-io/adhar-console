import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  addWidget,
  type DashboardLayout,
  DEFAULT_ROWS,
  defaultLayout,
  moveWidget,
  normalizeLayout,
  packLayout,
  packSpans,
  removeWidget,
  resizeWidget,
  rowsOf,
  SIZE_SPAN,
  SIZES,
  spanClass,
  type WidgetInstance,
  WIDGETS,
  type WidgetSize,
} from './dashboard-layout.ts'

const spans = (l: DashboardLayout) => packLayout(l.widgets).map((p) => p.span)
const rowSums = (s: number[], cols = 12) => rowsOf(s, cols).map((r) => r.reduce((n, i) => n + s[i], 0))
const allFull = (s: number[], cols = 12) => rowSums(s, cols).every((n) => n === cols)
const L = (sizes: WidgetSize[]): DashboardLayout => ({
  version: 1,
  scope: 'all',
  widgets: sizes.map((size, i) => ({ id: `w${i}`, type: WIDGETS[i % WIDGETS.length].type, size })),
})

Deno.test('default layout carries every widget once, scoped to all projects', () => {
  const l = defaultLayout()
  assertEquals(l.widgets.length, WIDGETS.length)
  assertEquals(new Set(l.widgets.map((w) => w.id)).size, WIDGETS.length)
  assertEquals(l.scope, 'all')
})

Deno.test('every default row fills the 12 columns exactly', () => {
  for (const row of DEFAULT_ROWS) assertEquals(row.reduce((n, [, s]) => n + SIZE_SPAN[s], 0), 12, row.map(([t]) => t).join(','))
  // …so packing the default changes nothing, on desktop and on tablet.
  const l = defaultLayout()
  assertEquals(spans(l), l.widgets.map((w) => SIZE_SPAN[w.size]))
  assert(allFull(packLayout(l.widgets).map((p) => p.spanMd)))
})

Deno.test('packSpans closes every row flush', () => {
  assertEquals(packSpans([12]), [12])
  assertEquals(packSpans([6, 6, 4, 4, 4]), [6, 6, 4, 4, 4])
  assertEquals(packSpans([6, 4]), [6, 6]) // two share evenly
  assertEquals(packSpans([8, 6]), [12, 12]) // 6 doesn't fit beside 8
  assertEquals(packSpans([4]), [12])
  assertEquals(packSpans([4, 4, 6]), [6, 6, 12])
  assertEquals(packSpans([3, 3, 3, 4, 4]), [4, 4, 4, 6, 6])
  assertEquals(packSpans([5, 4]), [6, 6])
  assertEquals(packSpans([3, 4, 3]), [4, 4, 4])
  assertEquals(packSpans([5, 5]), [6, 6])
  assertEquals(packSpans([2, 3, 2, 2, 2]), [2, 3, 2, 2, 3]) // 5 widgets: widen the last
  assertEquals(packSpans([]), [])
})

Deno.test('packSpans: random layouts never leave a gap (desktop and tablet)', () => {
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let t = 0; t < 500; t++) {
    const sizes = Array.from({ length: 1 + Math.floor(rnd() * 18) }, () => SIZES[Math.floor(rnd() * 4)])
    const packed = packLayout(L(sizes).widgets)
    assert(allFull(packed.map((p) => p.span)), `lg ${sizes.join('')}`)
    assert(allFull(packed.map((p) => p.spanMd)), `md ${sizes.join('')}`)
    for (const p of packed) assert([4, 6, 8, 12].includes(p.span), `span ${p.span} from ${sizes.join('')}`)
  }
})

Deno.test('tablet pack: thirds and halves pair up, a lone one goes full', () => {
  assertEquals(packLayout(L(['s', 's', 's']).widgets).map((p) => p.spanMd), [6, 6, 12])
  assertEquals(packLayout(L(['w', 's']).widgets).map((p) => p.spanMd), [12, 12])
})

Deno.test('add / remove / move', () => {
  let l = { ...defaultLayout(), widgets: defaultLayout().widgets.slice(0, 3) }
  assertEquals(l.widgets.map((w) => w.id), ['counters', 'my-open', 'due-soon'])
  l = addWidget(l, 'my-open')
  assertEquals(l.widgets[3].id, 'my-open-2')
  l = moveWidget(l, 'my-open-2', 0)
  assertEquals(l.widgets.map((w) => w.id), ['my-open-2', 'counters', 'my-open', 'due-soon'])
  l = moveWidget(l, 'counters', 99)
  assertEquals(l.widgets[3].id, 'counters')
  l = removeWidget(l, 'my-open')
  assertEquals(l.widgets.map((w) => w.id), ['my-open-2', 'due-soon', 'counters'])
  assert(allFull(spans(l)))
})

Deno.test('removing from the default leaves no gap', () => {
  let l = defaultLayout()
  for (const id of ['cycle-time', 'by-priority', 'okrs', 'counters']) {
    l = removeWidget(l, id)
    assert(allFull(spans(l)), id)
  }
})

Deno.test('resize: shrinking widens the row-mate so the choice shows', () => {
  const l = resizeWidget(L(['m', 'm']), 'w0', 's')
  assertEquals(l.widgets.map((w) => w.size), ['s', 'w'])
  assertEquals(spans(l), [4, 8])
})

Deno.test('resize: widening narrows or pushes row-mates', () => {
  assertEquals(spans(resizeWidget(L(['m', 'm']), 'w0', 'w')), [8, 4])
  assertEquals(spans(resizeWidget(L(['s', 's', 's']), 'w0', 'm')), [6, 6, 12])
  assertEquals(spans(resizeWidget(L(['s', 's', 's']), 'w1', 'w')), [4, 8, 12])
  assertEquals(spans(resizeWidget(L(['m', 'm', 'l']), 'w1', 'l')), [12, 12, 12])
})

Deno.test('resize: a lone full widget made smaller pulls the next one up', () => {
  const l = resizeWidget(L(['l', 'l', 'm', 'm']), 'w0', 's')
  assertEquals(spans(l), [4, 8, 6, 6])
  assertEquals(spans(resizeWidget(L(['l', 's', 's', 'l']), 'w0', 's')), [4, 4, 4, 12])
  // Last widget alone: nothing to pull — stays full rather than leave a gap.
  assertEquals(spans(resizeWidget(L(['m', 'm', 'l']), 'w2', 's')), [6, 6, 12])
})

Deno.test('resize: rows before the edited one are untouched', () => {
  const l = resizeWidget(L(['s', 'm', 'm', 'm']), 'w2', 's')
  // Row 1 was drawn [6,6] (s+m shared), row 2 [6,6].
  assertEquals(spans(l), [6, 6, 4, 8])
})

Deno.test('normalize drops unknown widgets, duplicates and bad sizes; team scope becomes all', () => {
  const l = normalizeLayout({
    scope: 'team',
    widgets: [
      { id: 'a', type: 'okrs', size: 'xl' },
      { id: 'a', type: 'intake', size: 's' },
      { id: 'b', type: 'nope', size: 's' },
      { id: 'c', type: 'recent', size: 'w' },
      null,
    ],
  })
  assertEquals(l.scope, 'all')
  assertEquals(l.widgets, [{ id: 'a', type: 'okrs', size: 'm' }, { id: 'c', type: 'recent', size: 'w' }] as WidgetInstance[])
  assertEquals(normalizeLayout({ scope: 'project', widgets: [] }).scope, 'project')
  assertEquals(normalizeLayout(undefined).widgets.length, WIDGETS.length)
})

Deno.test('spanClass is literal per breakpoint', () => {
  assertEquals(spanClass({ span: 8, spanMd: 12 }), 'col-span-1 md:col-span-12 lg:col-span-8')
})
