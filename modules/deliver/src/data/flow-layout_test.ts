import { assert, assertEquals } from 'jsr:@std/assert'
import { layoutSerpentine, rowShape } from './flow-layout.ts'

const OPTS = { nodeWidth: 100, nodeHeight: 50, colGap: 20, rowGap: 30, maxPerRow: 4 }

Deno.test('rows are balanced, never left holding one node', () => {
  assertEquals(rowShape(8, 4), { rows: 2, perRow: 4 })
  // Greedy packing would give 4 + 4 + 1.
  assertEquals(rowShape(9, 4), { rows: 3, perRow: 3 })
  assertEquals(rowShape(3, 4), { rows: 1, perRow: 3 })
  assertEquals(rowShape(0, 4), { rows: 0, perRow: 0 })
})

Deno.test('the eight-stage flow lays out as two rows of four', () => {
  const l = layoutSerpentine(8, OPTS)
  assertEquals(l.rows, 2)
  assertEquals(l.perRow, 4)
  assertEquals(l.pos.map((p) => p.row), [0, 0, 0, 0, 1, 1, 1, 1])
  // Row 0 runs left to right, row 1 back again.
  assertEquals(l.pos.map((p) => p.col), [0, 1, 2, 3, 3, 2, 1, 0])
  assertEquals(l.width, 4 * 100 + 3 * 20)
  assertEquals(l.height, 2 * 50 + 30)
})

/**
 * The whole point of the serpentine: the wrap is a short vertical drop, which
 * is what keeps the reading order obvious. A row that ran left-to-right twice
 * would need a connector sweeping all the way back across the canvas.
 */
Deno.test('the wrap drops straight down, in line with both nodes', () => {
  const l = layoutSerpentine(8, OPTS)
  const wraps = l.edges.filter((e) => e.dir === 'wrap')
  assertEquals(wraps.length, 1)
  const [w] = wraps
  assertEquals(w.from.x, w.to.x)
  assert(w.to.y > w.from.y, 'the wrap goes downward')
  // Bottom of the last node of row 0 to the top of the first node of row 1.
  assertEquals(w.from.y, 50)
  assertEquals(w.to.y, 80)
})

Deno.test('an in-row edge leaves by the side facing the next node', () => {
  const l = layoutSerpentine(8, OPTS)
  const row0 = l.edges[0]
  assertEquals(row0.dir, 'forward')
  assert(row0.to.x > row0.from.x, 'row 0 runs rightward')
  assertEquals(row0.from.x, 100) // right edge of node 0
  assertEquals(row0.to.x, 120) // left edge of node 1

  const row1 = l.edges[5]
  assertEquals(row1.dir, 'forward')
  assert(row1.to.x < row1.from.x, 'row 1 runs leftward')
  // Leaves by the left edge and arrives at the right edge of the node beside it.
  assertEquals(row1.from.x, l.pos[5].x)
  assertEquals(row1.to.x, l.pos[6].x + 100)
})

Deno.test('every in-row edge stays level', () => {
  for (const e of layoutSerpentine(8, OPTS).edges) {
    if (e.dir === 'forward') assertEquals(e.from.y, e.to.y)
  }
})

Deno.test('one edge leaves every node but the last', () => {
  for (const n of [1, 2, 5, 7, 8, 13]) {
    assertEquals(layoutSerpentine(n, OPTS).edges.length, n - 1)
  }
})

/** A short final row still begins under the node that feeds it. */
Deno.test('a ragged last row keeps the wrap vertical', () => {
  for (const n of [5, 6, 7, 10, 11]) {
    const l = layoutSerpentine(n, OPTS)
    for (const e of l.edges) {
      if (e.dir === 'wrap') assertEquals(e.from.x, e.to.x, `count ${n}`)
    }
  }
})

Deno.test('nodes never overlap', () => {
  const l = layoutSerpentine(11, OPTS)
  const seen = new Set<string>()
  for (const p of l.pos) {
    const key = `${p.row}:${p.col}`
    assert(!seen.has(key), `two nodes at ${key}`)
    seen.add(key)
  }
})

Deno.test('every node sits inside the reported canvas', () => {
  const l = layoutSerpentine(7, OPTS)
  for (const p of l.pos) {
    assert(p.x >= 0 && p.x + l.nodeWidth <= l.width, `x ${p.x}`)
    assert(p.y >= 0 && p.y + l.nodeHeight <= l.height, `y ${p.y}`)
  }
})

Deno.test('a single stage is a canvas one node big, with no edges', () => {
  const l = layoutSerpentine(1, OPTS)
  assertEquals(l.edges, [])
  assertEquals([l.width, l.height], [100, 50])
})

/** Nothing to draw must still be a usable canvas size, not zero. */
Deno.test('no stages does not collapse the canvas', () => {
  const l = layoutSerpentine(0, OPTS)
  assertEquals(l.pos, [])
  assertEquals(l.edges, [])
  assertEquals([l.width, l.height], [100, 50])
})
