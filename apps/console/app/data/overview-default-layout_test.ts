import { assertEquals } from 'jsr:@std/assert@^1'
import { DEFAULT_ROWS, OPTIONAL_ROWS, rowSpan } from './overview-default-layout.ts'

Deno.test('every default Overview row fills the 12-column grid', () => {
  for (const row of [...DEFAULT_ROWS, ...OPTIONAL_ROWS]) {
    assertEquals(rowSpan(row), 12, `row ${row.map(([id]) => id).join(', ')}`)
  }
})

Deno.test('no panel appears twice in the default arrangement', () => {
  const ids = [...DEFAULT_ROWS, ...OPTIONAL_ROWS].flat().map(([id]) => id)
  assertEquals(new Set(ids).size, ids.length)
})
