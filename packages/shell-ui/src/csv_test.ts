import { assertEquals } from 'jsr:@std/assert@1'
import { csvCell, toCsv } from './csv.ts'

Deno.test('cells that a spreadsheet would run as formulas are neutralised', () => {
  assertEquals(csvCell('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`)
  assertEquals(csvCell('@SUM(A1)'), "'@SUM(A1)")
  assertEquals(csvCell('+cmd'), "'+cmd")
  assertEquals(csvCell('-x'), "'-x")
  // Numbers stay numeric.
  assertEquals(csvCell('-12'), '-12')
  assertEquals(csvCell('+3.5'), '+3.5')
  assertEquals(csvCell('nginx-7d9f'), 'nginx-7d9f')
})

Deno.test('quoting follows RFC 4180 and the file carries a BOM', () => {
  assertEquals(csvCell('a,b'), '"a,b"')
  assertEquals(csvCell('line\r\nbreak'), '"line\r\nbreak"')
  assertEquals(toCsv([['Name', 'Ready'], ['café', '1/1']]), '﻿Name,Ready\r\ncafé,1/1')
})
