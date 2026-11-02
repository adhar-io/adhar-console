import { assertEquals } from 'jsr:@std/assert@^1'
import { parseScanTable } from './scan-summaries.ts'

Deno.test('parseScanTable maps trivy printer columns by name, not position', () => {
  const rows = parseScanTable({
    kind: 'Table',
    columnDefinitions: [
      { name: 'Name' }, { name: 'Repository' }, { name: 'Tag' }, { name: 'Scanner' }, { name: 'Age' },
      { name: 'Critical' }, { name: 'High' }, { name: 'Medium' }, { name: 'Low' }, { name: 'Unknown' },
    ],
    rows: [
      { cells: ['rs-api-1', 'library/api', '1.0', 'Trivy', '2d', 2, 5, 9, 1, 0], object: { metadata: { name: 'rs-api-1', namespace: 'demo' } } },
      { cells: ['rs-web-1', 'library/web', '2.0', 'Trivy', '1d', '0', '3', 'x', 4, 1] },
    ],
  })
  assertEquals(rows, [
    { namespace: 'demo', name: 'rs-api-1', summary: { critical: 2, high: 5, medium: 9, low: 1, unknown: 0 } },
    { namespace: '', name: 'rs-web-1', summary: { critical: 0, high: 3, medium: 0, low: 4, unknown: 1 } },
  ])
})

Deno.test('parseScanTable tolerates a table without severity columns or rows', () => {
  assertEquals(parseScanTable({ kind: 'Table', columnDefinitions: [{ name: 'Name' }], rows: [{ cells: ['a'] }] }), [
    { namespace: '', name: 'a', summary: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } },
  ])
  assertEquals(parseScanTable({}), [])
})
