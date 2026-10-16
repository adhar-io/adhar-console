import { assertEquals } from 'jsr:@std/assert@1'
import { b64, joinPath, unb64 } from './encoding.ts'

Deno.test('base64 round-trips UTF-8', () => {
  const s = 'héllo — 世界 ✓'
  assertEquals(unb64(b64(s)), s)
  assertEquals(b64('hi'), 'aGk=')
})

Deno.test('joinPath tolerates slashes and empty bases', () => {
  assertEquals(joinPath('', 'src/a.ts'), 'src/a.ts')
  assertEquals(joinPath('/apps/web/', '/src/a.ts'), 'apps/web/src/a.ts')
  assertEquals(joinPath('  ', '.adhar/builder.json'), '.adhar/builder.json')
})
