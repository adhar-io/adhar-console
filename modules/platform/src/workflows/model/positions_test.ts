import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { decodePositions, encodePositions, MAX_POSITIONS, positionKey } from './positions.ts'

/** §4.7: the `adhar.io/designer-positions` codec. Cosmetic, so unreadable input is no positions, never an error. */

Deno.test('positions survive a round trip as whole pixels with sorted keys', () => {
  const s = encodePositions({ b: { x: 10.4, y: -3.6 }, a: { x: 0, y: 0 }, 'on-exit/notify': { x: 312, y: 200 } })
  assertEquals(s, '{"a":[0,0],"b":[10,-4],"on-exit/notify":[312,200]}')
  assertEquals(decodePositions(s), { a: { x: 0, y: 0 }, b: { x: 10, y: -4 }, 'on-exit/notify': { x: 312, y: 200 } })
  // The same layout is the same string, whatever order it was built in.
  assertEquals(encodePositions({ a: { x: 0, y: 0 }, b: { x: 10, y: -4 } }), encodePositions({ b: { x: 10, y: -4 }, a: { x: 0, y: 0 } }))
})

Deno.test('unreadable annotations are no positions', () => {
  for (const raw of [undefined, null, '', '  ', 'not json', '[1,2]', '"x"', 'null', 42, {}]) assertEquals(decodePositions(raw), {})
  assertEquals(decodePositions('{"a":[1],"b":["1",2],"c":[1,2],"d":{"x":3,"y":4},"e":[null,null],"f":[1e999,0]}'), { c: { x: 1, y: 2 }, d: { x: 3, y: 4 } })
  assertEquals(encodePositions({ a: { x: NaN, y: 0 }, b: { x: 1, y: 2 } }), '{"b":[1,2]}')
})

Deno.test('an oversized annotation is cut off, not trusted', () => {
  const big: Record<string, [number, number]> = {}
  for (let i = 0; i < MAX_POSITIONS + 50; i++) big[`t${i}`] = [i, i]
  assertEquals(Object.keys(decodePositions(JSON.stringify(big))).length, MAX_POSITIONS)
})

Deno.test('entry tasks are keyed by name, others by template/task', () => {
  assertEquals(positionKey('main', 'main', 'build'), 'build')
  assertEquals(positionKey('main', 'on-exit', 'notify'), 'on-exit/notify')
})
