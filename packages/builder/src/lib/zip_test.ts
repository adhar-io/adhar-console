import { assertEquals } from 'jsr:@std/assert@1'
import { crc32, zipFiles } from './zip.ts'

Deno.test('crc32 matches the reference value', () => {
  assertEquals(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
})

Deno.test('zip has local headers, central directory and end record', () => {
  const z = zipFiles([{ path: 'a.txt', content: 'hello' }, { path: 'src/é.ts', content: 'x' }])
  const dv = new DataView(z.buffer)
  assertEquals(dv.getUint32(0, true), 0x04034b50)
  const end = z.length - 22
  assertEquals(dv.getUint32(end, true), 0x06054b50)
  assertEquals(dv.getUint16(end + 10, true), 2)
  const cdOffset = dv.getUint32(end + 16, true)
  assertEquals(dv.getUint32(cdOffset, true), 0x02014b50)
})
