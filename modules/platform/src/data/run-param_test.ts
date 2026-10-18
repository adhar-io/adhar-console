import { assertEquals } from 'jsr:@std/assert@1'
import { readRunParam } from './run-param.ts'

Deno.test('?run= names a PipelineRun by namespace/name', () => {
  assertEquals(readRunParam('?section=builds&run=adhar-system/cart-ci-abc12'), { ns: 'adhar-system', name: 'cart-ci-abc12' })
  assertEquals(readRunParam('?section=builds&run=adhar-system%2Fcart-ci-abc12'), { ns: 'adhar-system', name: 'cart-ci-abc12' })
  assertEquals(readRunParam('?section=builds'), null)
  assertEquals(readRunParam('?run=no-namespace'), null)
  assertEquals(readRunParam('?run=/x'), null)
})
