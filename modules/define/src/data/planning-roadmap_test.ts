import { assert, assertEquals } from 'jsr:@std/assert@1'
import { barFor, criticalPath, dependencyEdges, edgePath, scheduleConflicts, shiftDates, type Span, ticks, timelineRange } from './planning-roadmap.ts'

const D = (s: string) => Date.parse(`${s}T00:00:00Z`)

Deno.test('range pads around dated spans and always includes today', () => {
  const r = timelineRange([{ id: 'a', start: '2026-10-10', end: '2026-10-20' }, { id: 'b' }], D('2026-09-01'), 'week')
  assertEquals(r.start, D('2026-08-25'))
  assertEquals(r.end, D('2026-10-28'))
})

Deno.test('bars: full spans, single-date markers, undated items skipped', () => {
  const r = { start: D('2026-10-01'), end: D('2026-11-01') }
  assertEquals(barFor({ id: 'a', start: '2026-10-03', end: '2026-10-05' }, r, 10), { x: 20, w: 30, partial: false })
  assertEquals(barFor({ id: 'b', end: '2026-10-02' }, r, 10), { x: 10, w: 10, partial: true })
  assertEquals(barFor({ id: 'c' }, r, 10), null)
})

Deno.test('ticks: Mondays at month zoom, months at quarter zoom', () => {
  const r = { start: D('2026-10-01'), end: D('2026-10-31') }
  assertEquals(ticks(r, 'month').map((t) => new Date(t.t).getUTCDate()), [5, 12, 19, 26])
  assertEquals(ticks({ start: D('2026-10-01'), end: D('2027-02-01') }, 'quarter').map((t) => t.label), ['Oct', 'Nov', 'Dec', 'Jan 2027', 'Feb'])
})

Deno.test('dragging moves both dates; resizing keeps start ≤ end', () => {
  const s: Span = { id: 'a', start: '2026-10-03', end: '2026-10-05' }
  assertEquals(shiftDates(s, 2, 'move'), { start_date: '2026-10-05', target_date: '2026-10-07' })
  assertEquals(shiftDates(s, 5, 'start'), { start_date: '2026-10-05', target_date: '2026-10-05' })
  assertEquals(shiftDates(s, -4, 'end'), { start_date: '2026-10-03', target_date: '2026-10-03' })
  assertEquals(shiftDates({ id: 'x', end: '2026-10-05' }, 1, 'move'), { start_date: null, target_date: '2026-10-06' })
})

Deno.test('dependency edges dedupe both directions; conflicts and the critical path', () => {
  const rel = new Map([
    ['a', { blocking: ['b'], blocked_by: [] }],
    ['b', { blocking: ['c'], blocked_by: ['a'] }],
    ['c', { blocking: [], blocked_by: ['b', 'hidden'] }],
    ['d', { blocking: ['c'], blocked_by: [] }],
  ])
  const edges = dependencyEdges(rel, new Set(['a', 'b', 'c', 'd']))
  assertEquals(edges, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'd', to: 'c' }])
  const spans = new Map<string, Span>([
    ['a', { id: 'a', start: '2026-10-01', end: '2026-10-03' }],
    ['b', { id: 'b', start: '2026-10-02', end: '2026-10-06' }],
    ['c', { id: 'c', start: '2026-10-07', end: '2026-10-09' }],
    ['d', { id: 'd', start: '2026-10-01', end: '2026-10-02' }],
  ])
  assertEquals(scheduleConflicts(edges, spans), [{ from: 'a', to: 'b' }])
  assertEquals([...criticalPath(edges, spans)].sort(), ['a', 'b', 'c'])
  assertEquals(criticalPath([], spans).size, 0)
  // A cycle does not hang.
  assert(criticalPath([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], spans).size <= 2)
})

Deno.test('edge paths route forward or around a conflict', () => {
  assertEquals(edgePath({ x: 0, w: 10, y: 5 }, { x: 40, y: 25 }), 'M10,5 H32 V25 H40')
  assert(edgePath({ x: 0, w: 50, y: 5 }, { x: 20, y: 25 }).includes('h8'))
})
