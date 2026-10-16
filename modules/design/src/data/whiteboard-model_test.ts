import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  anchorPoint,
  type BoardEl,
  cloneElements,
  connectorEnds,
  connectorPath,
  fitCamera,
  frameChildren,
  migrateBoard,
  penFromPoints,
  pushHistory,
  redo,
  removeElements,
  reorder,
  resizeBox,
  toLegacy,
  translate,
  undo,
  wrapText,
  zoomAt,
} from './whiteboard-model.ts'

const sticky = (id: string, x = 0, y = 0): BoardEl => ({ id, kind: 'sticky', x, y, w: 100, h: 100, text: id, color: 'amber' })

Deno.test('migrates legacy notes + connections and round-trips to legacy', () => {
  const els = migrateBoard({
    notes: [
      { id: 'n1', text: 'A', color: 'amber', x: 10, y: 20, author: 'me' },
      { id: 'n2', text: 'B', color: 'sky', x: 300, y: 20, author: 'me' },
    ],
    connections: [{ from: 'n1', to: 'n2' }, { from: 'n1', to: 'gone' }],
  })
  assertEquals(els.length, 3)
  assertEquals(els[0].kind, 'sticky')
  const legacy = toLegacy(els)
  assertEquals(legacy.notes.map((n) => n.id), ['n1', 'n2'])
  assertEquals(legacy.connections, [{ from: 'n1', to: 'n2' }])
  // Existing element lists are returned untouched.
  assertEquals(migrateBoard({ elements: els, notes: [], connections: [] }), els)
})

Deno.test('anchor points sit on rect, ellipse and diamond outlines', () => {
  const box = { x: 0, y: 0, w: 100, h: 50 }
  assertEquals(anchorPoint(box, { x: 500, y: 25 }, 0), { x: 100, y: 25 })
  assertEquals(anchorPoint(box, { x: 50, y: -500 }, 0), { x: 50, y: 0 })
  const e = anchorPoint({ ...box, kind: 'ellipse' }, { x: 50, y: 500 }, 0)
  assertAlmostEquals(e.y, 50, 1e-9)
  const d = anchorPoint({ ...box, kind: 'diamond' }, { x: 1000, y: 25 }, 0)
  assertAlmostEquals(d.x, 100, 1e-9)
})

Deno.test('connector ends follow attached elements; paths per route', () => {
  const a = sticky('a', 0, 0)
  const b = sticky('b', 300, 0)
  const c: BoardEl = { id: 'c', kind: 'connector', from: { id: 'a', x: 0, y: 0 }, to: { id: 'b', x: 0, y: 0 }, color: 'ink', route: 'straight', arrow: 'end' }
  const byId = new Map([a, b, c].map((e) => [e.id, e]))
  const [p1, p2] = connectorEnds(c as never, byId)
  assertEquals(p1, { x: 104, y: 50 })
  assertEquals(p2, { x: 296, y: 50 })
  assertEquals(connectorPath(p1, p2, 'straight'), 'M104,50 L296,50')
  assert(connectorPath(p1, p2, 'elbow').split('L').length === 4)
  assert(connectorPath(p1, p2, 'curve').includes('C'))
})

Deno.test('resize keeps the opposite edge and minimum size', () => {
  const box = { x: 10, y: 10, w: 100, h: 100 }
  assertEquals(resizeBox(box, 'se', 20, 30), { x: 10, y: 10, w: 120, h: 130 })
  assertEquals(resizeBox(box, 'nw', 20, 20), { x: 30, y: 30, w: 80, h: 80 })
  assertEquals(resizeBox(box, 'w', 500, 0), { x: 94, y: 10, w: 16, h: 100 })
  const r = resizeBox({ x: 0, y: 0, w: 200, h: 100 }, 'se', 200, 0, true)
  assertEquals(r.w / r.h, 2)
})

Deno.test('remove drops attached connectors; clone re-points internal connectors', () => {
  const a = sticky('a', 0, 0)
  const b = sticky('b', 300, 0)
  const c: BoardEl = { id: 'c', kind: 'connector', from: { id: 'a', x: 0, y: 0 }, to: { id: 'b', x: 0, y: 0 }, color: 'ink', route: 'curve', arrow: 'end' }
  assertEquals(removeElements([a, b, c], new Set(['a'])).map((e) => e.id), ['b'])
  let n = 0
  const copies = cloneElements([a, b, c], new Set(['a', 'c']), (p) => `${p}${++n}`)
  assertEquals(copies.length, 2)
  const conn = copies.find((e) => e.kind === 'connector')!
  if (conn.kind !== 'connector') throw new Error()
  assertEquals(conn.from.id, copies[0].id)
  assertEquals(conn.to.id, undefined) // b was not copied → floats
})

Deno.test('translate, reorder, frame children', () => {
  const f: BoardEl = { id: 'f', kind: 'frame', x: 0, y: 0, w: 500, h: 500, text: 'Frame', color: 'slate' }
  const a = sticky('a', 10, 10)
  const out = sticky('o', 600, 0)
  assertEquals(frameChildren([f, a, out], new Set(['f'])), new Set(['a']))
  const moved = translate([f, a], new Set(['a']), 5, 5)
  assertEquals((moved[1] as { x: number }).x, 15)
  assertEquals(reorder([f, a, out], new Set(['f']), 'front').map((e) => e.id), ['a', 'o', 'f'])
})

Deno.test('word wrap with a fixed-width measure', () => {
  const m = (s: string) => s.length * 10
  assertEquals(wrapText('hello big world', 100, m), ['hello big', 'world'])
  assertEquals(wrapText('a\nb', 100, m), ['a', 'b'])
  assertEquals(wrapText('abcdefghijkl', 50, m), ['abcde', 'fghij', 'kl'])
})

Deno.test('history undo/redo', () => {
  const s1 = [sticky('a')]
  const s2 = [sticky('a'), sticky('b')]
  let h = pushHistory({ past: [], future: [] }, s1)
  const u = undo(h, s2)!
  assertEquals(u.elements, s1)
  h = u.history
  const r = redo(h, s1)!
  assertEquals(r.elements, s2)
  assertEquals(undo({ past: [], future: [] }, s1), null)
})

Deno.test('camera fit and zoom anchor', () => {
  const cam = fitCamera({ x: 0, y: 0, w: 1000, h: 500 }, 1200, 700, 100)
  assertEquals(cam.k, 1)
  const z = zoomAt({ x: 0, y: 0, k: 1 }, 2, 100, 100)
  assertEquals(z, { k: 2, x: -100, y: -100 })
  const pen = penFromPoints('p', [{ x: 10, y: 10 }, { x: 20, y: 30 }], 'ink', 2)!
  assertEquals([pen.x, pen.y, pen.w, pen.h], [10, 10, 10, 20])
  assertEquals(pen.points, [[0, 0], [10, 20]])
})
