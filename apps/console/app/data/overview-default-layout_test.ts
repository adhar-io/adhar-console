import { assertEquals } from 'jsr:@std/assert@^1'
import { DEFAULT_ROWS, OPTIONAL_ROWS, packRows, rowSpan } from './overview-default-layout.ts'

Deno.test('every default Overview row fills the 12-column grid', () => {
  for (const row of [...DEFAULT_ROWS, ...OPTIONAL_ROWS]) {
    assertEquals(rowSpan(row), 12, `row ${row.map(([id]) => id).join(', ')}`)
  }
})

Deno.test('no panel appears twice in the default arrangement', () => {
  const ids = [...DEFAULT_ROWS, ...OPTIONAL_ROWS].flat().map(([id]) => id)
  assertEquals(new Set(ids).size, ids.length)
})

Deno.test('packRows leaves exact rows alone', () => {
  assertEquals(packRows([12, 6, 6, 4, 4, 4, 3, 3, 3, 3]), [12, 6, 6, 4, 4, 4, 3, 3, 3, 3])
})

Deno.test('packRows closes every short row', () => {
  // half + third (10) → two halves; a full row stays; two thirds (8) → two halves
  assertEquals(packRows([6, 4, 12, 4, 4]), [6, 6, 12, 6, 6])
  // a half that doesn't fit after two thirds starts a new row
  assertEquals(packRows([4, 4, 6, 6]), [6, 6, 6, 6])
  // quarter + third + quarter (10) → three thirds
  assertEquals(packRows([3, 4, 3]), [4, 4, 4])
  const rows = packRows([3, 6, 4, 4, 12, 3, 3, 4, 6, 6, 4])
  let used = 0
  for (const s of rows) {
    used += s
    if (used > 12) throw new Error('row overflow')
    if (used === 12) used = 0
  }
  assertEquals(used, 0)
})
