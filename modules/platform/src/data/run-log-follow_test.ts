import { assertEquals } from 'jsr:@std/assert@1'
import { keepTail } from './run-log-follow.ts'

Deno.test('keepTail keeps the last N lines, trailing newline included', () => {
  assertEquals(keepTail('a\nb\nc\n', 2), 'b\nc\n')
  assertEquals(keepTail('a\nb\nc', 2), 'b\nc')
  assertEquals(keepTail('a\nb', 5), 'a\nb')
  assertEquals(keepTail('', 3), '')
  assertEquals(keepTail('a\nb', 0), '')
})
