import { assert, assertEquals } from 'jsr:@std/assert@1'
import { PdfDocument, textWidth, toWinAnsi, wrapText } from './pdf-writer.ts'

const decode = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('')

Deno.test('text is WinAnsi: typographic punctuation kept, the rest spelled or marked', () => {
  assertEquals(toWinAnsi('a — b · c ≤ d'), 'a \x97 b \xb7 c <= d')
  assertEquals(toWinAnsi('línea\n2'), 'línea 2')
  assertEquals(toWinAnsi('漢'), '?')
})

Deno.test('widths follow the font metrics and wrapping respects the width', () => {
  assertEquals(textWidth('ii', 'regular', 10), 4.44)
  assertEquals(textWidth('abc', 'mono', 10), 18)
  const lines = wrapText('the quick brown fox jumps over the lazy dog', 'regular', 10, 80)
  assert(lines.length > 1)
  for (const l of lines) assert(textWidth(l, 'regular', 10) <= 80)
  // A token longer than the line (a SHA) is broken, never overflowing.
  const sha = wrapText('a'.repeat(40), 'mono', 10, 60)
  assertEquals(sha.join(''), 'a'.repeat(40))
  for (const l of sha) assert(textWidth(l, 'mono', 10) <= 60)
})

Deno.test('the file is a well-formed PDF with a valid xref and escaped strings', () => {
  const doc = new PdfDocument({ title: 'T (1)' })
  doc.addPage()
  doc.text('Hello (world) \\ ok', 40, 60, { font: 'bold', size: 12 })
  doc.rect(40, 80, 100, 20, { fill: [0, 0, 1], radius: 4 })
  doc.circle(100, 200, 10, { stroke: [1, 0, 0] })
  doc.arc(100, 200, 10, 0.5, [0, 1, 0], 2)
  doc.link(40, 80, 100, 20, 'https://gitea.example/org/repo/commit/abc')
  doc.link(40, 80, 100, 20, 'javascript:alert(1)')
  doc.addPage()
  doc.text('Page two', 40, 60)
  const out = decode(doc.output())
  assert(out.startsWith('%PDF-1.4'))
  assert(out.trimEnd().endsWith('%%EOF'))
  assert(out.includes('(Hello \\(world\\) \\\\ ok) Tj'))
  assert(out.includes('/Count 2'))
  assertEquals((out.match(/\/Subtype \/Link/g) ?? []).length, 1) // only http(s) links
  // Every xref offset points at its object.
  const xref = Number(out.match(/startxref\n(\d+)/)![1])
  const table = out.slice(xref).split('\n').slice(3).filter((l) => / 00000 n $/.test(l))
  table.forEach((line, i) => assert(out.slice(Number(line.slice(0, 10))).startsWith(`${i + 1} 0 obj`)))
  // Stream lengths are byte lengths.
  for (const m of out.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length
    assertEquals(out.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream')
  }
})
