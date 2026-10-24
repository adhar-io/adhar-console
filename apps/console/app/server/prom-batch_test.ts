import { assertEquals } from 'jsr:@std/assert'
import { itemPath } from './prom-batch.ts'

Deno.test('itemPath builds instant and range paths', () => {
  assertEquals(itemPath({ kind: 'instant', query: 'up' }), 'api/v1/query?query=up')
  assertEquals(
    itemPath({ kind: 'range', query: 'up', start: 1, end: 61, step: 30 }),
    'api/v1/query_range?query=up&start=1&end=61&step=30',
  )
})

Deno.test('itemPath rejects malformed items', () => {
  assertEquals(itemPath(null), null)
  assertEquals(itemPath({ kind: 'instant', query: '' }), null)
  assertEquals(itemPath({ kind: 'range', query: 'up', start: 1, end: 0, step: 30 }), null)
  assertEquals(itemPath({ kind: 'range', query: 'up', start: 1, end: 2, step: 0 }), null)
  assertEquals(itemPath({ kind: 'delete', query: 'up' }), null)
})
