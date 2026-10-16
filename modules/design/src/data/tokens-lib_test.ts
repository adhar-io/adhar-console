import { assert, assertAlmostEquals, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  contrastRatio,
  countTokens,
  diffTokenSets,
  importCss,
  importTokens,
  importW3C,
  mergeDefaults,
  mergeTokenSets,
  modularScale,
  parseColor,
  parseShadow,
  readableOn,
  shortName,
  toHex,
  tokensToCss,
  tokensToTailwindV4,
  tokensToW3C,
  wcag,
} from './tokens-lib.ts'
import { DEFAULT_TOKENS } from './tokens-seed.ts'
import type { TokenSet } from './types.ts'

Deno.test('parseColor handles hex, rgb, hsl and names', () => {
  assertEquals(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 })
  assertEquals(parseColor('#0f172a'), { r: 15, g: 23, b: 42, a: 1 })
  assertEquals(parseColor('rgba(15, 23, 42, 0.5)')?.a, 0.5)
  assertEquals(parseColor('rgb(15 23 42 / 50%)')?.a, 0.5)
  const red = parseColor('hsl(0, 100%, 50%)')!
  assertEquals([Math.round(red.r), Math.round(red.g), Math.round(red.b)], [255, 0, 0])
  assertEquals(parseColor('black'), { r: 0, g: 0, b: 0, a: 1 })
  assertEquals(parseColor('not-a-colour'), null)
  assertEquals(parseColor('#12'), null)
  assertEquals(toHex({ r: 15, g: 23, b: 42, a: 1 }), '#0f172a')
})

Deno.test('contrastRatio matches the WCAG reference values', () => {
  assertAlmostEquals(contrastRatio('#000', '#fff')!, 21, 0.001)
  assertAlmostEquals(contrastRatio('#fff', '#fff')!, 1, 0.001)
  // #767676 on white is the canonical "just passes AA" grey (4.54:1).
  assertAlmostEquals(contrastRatio('#767676', '#ffffff')!, 4.54, 0.01)
  assertEquals(contrastRatio('nope', '#fff'), null)
  // Translucent foreground is composited over the background first.
  assert(contrastRatio('rgba(0,0,0,0.5)', '#fff')! < contrastRatio('#000', '#fff')!)
})

Deno.test('wcag rates thresholds, rounding down', () => {
  assertEquals(wcag(21).level, 'AAA')
  assertEquals(wcag(7).level, 'AAA')
  assertEquals(wcag(4.5).level, 'AA')
  assertEquals(wcag(4.499).level, 'AA Large') // 4.49 < 4.5
  assertEquals(wcag(3).level, 'AA Large')
  assertEquals(wcag(2.9).level, 'Fail')
  assertEquals(readableOn('#0f172a'), '#ffffff')
  assertEquals(readableOn('#fef3c7'), '#000000')
})

Deno.test('mergeDefaults fills missing categories but keeps stored ones', () => {
  const stored = { color: [{ name: '--adhar-color-x', value: '#123456', role: 'X' }] } as Partial<TokenSet>
  const merged = mergeDefaults(stored)
  assertEquals(merged.color.length, 1)
  assertEquals(merged.spacing, DEFAULT_TOKENS.spacing)
  assertEquals(mergeDefaults(null), DEFAULT_TOKENS)
})

Deno.test('shortName strips the prefix and category', () => {
  assertEquals(shortName('--adhar-color-primary'), 'primary')
  assertEquals(shortName('--adhar-space-12'), '12')
  assertEquals(shortName('--adhar-text-2xl'), '2xl')
  assertEquals(shortName('--brand'), 'brand')
})

Deno.test('W3C export round-trips losslessly', () => {
  const doc = tokensToW3C(DEFAULT_TOKENS)
  const color = (doc.color as Record<string, Record<string, unknown>>).primary
  assertEquals(color.$type, 'color')
  assertEquals(color.$value, '#0f172a')
  const back = importW3C(JSON.parse(JSON.stringify(doc)))
  assertEquals(back.count, countTokens(DEFAULT_TOKENS))
  const merged = mergeTokenSets(DEFAULT_TOKENS, back.tokens, 'replace')
  const diff = diffTokenSets(DEFAULT_TOKENS, merged)
  assertEquals(diff, { added: [], removed: [], changed: [] })
})

Deno.test('W3C import accepts third-party DTCG documents with aliases', () => {
  const res = importW3C({
    brand: {
      $type: 'color',
      blue: { $value: '#3b82f6' },
      link: { $value: '{brand.blue}', $description: 'Links' },
    },
    space: { $type: 'dimension', sm: { $value: '8px' } },
    radius: { $type: 'dimension', md: { $value: '6px' } },
    heading: { $type: 'typography', $value: { fontSize: '24px', lineHeight: 1.25 } },
    weird: { $type: 'number', $value: 3 },
  })
  assertEquals(res.tokens.color?.map((c) => c.value), ['#3b82f6', '#3b82f6'])
  assertEquals(res.tokens.color?.[1].role, 'Links')
  assertEquals(res.tokens.spacing?.[0], { name: '--adhar-space-sm', value: '8px' })
  assertEquals(res.tokens.radius?.[0].value, '6px')
  assertEquals(res.tokens.typography?.[0].value, '24px / 30px')
  assertEquals(res.warnings.length, 1)
})

Deno.test('CSS import reads light + dark blocks and motion easing', () => {
  const css = `
    :root {
      /* brand */
      --adhar-color-primary: #0f172a;
      --adhar-space-2: 8px;
      --adhar-radius-md: 8px;
      --adhar-shadow-sm: 0 1px 2px rgba(0,0,0,.1);
      --adhar-duration-fast: 120ms;
      --adhar-duration-fast-ease: ease-out;
      --adhar-bp-md: 768px;
      --adhar-text-sm: 14px / 20px;
    }
    @media (prefers-color-scheme: dark) { :root { --adhar-color-primary: #f8fafc; } }
  `
  const res = importCss(css)
  assertEquals(res.tokens.color, [{ name: '--adhar-color-primary', value: '#0f172a', role: 'primary', dark: '#f8fafc' }])
  assertEquals(res.tokens.motion, [{ name: '--adhar-duration-fast', value: '120ms', curve: 'ease-out' }])
  assertEquals(res.tokens.spacing?.length, 1)
  assertEquals(res.tokens.radius?.length, 1)
  assertEquals(res.tokens.elevation?.length, 1)
  assertEquals(res.tokens.breakpoint?.length, 1)
  assertEquals(res.tokens.typography?.length, 1)
})

Deno.test('CSS export re-imports to the same set', () => {
  const res = importTokens(tokensToCss(DEFAULT_TOKENS))
  const merged = mergeTokenSets(DEFAULT_TOKENS, res.tokens, 'replace')
  const diff = diffTokenSets(DEFAULT_TOKENS, merged)
  // Roles are derived from names on CSS import; everything else must match.
  assertEquals(diff.added, [])
  assertEquals(diff.removed, [])
  for (const name of diff.changed) assert(name.includes('color') || name.includes('bp'), name)
})

Deno.test('importTokens auto-detects the legacy flat JSON and rejects junk', () => {
  const flat = JSON.stringify({ color: { '--adhar-color-x': '#ff0000' }, motion: { '--adhar-duration-x': '100ms ease-in' } })
  const res = importTokens(flat)
  assertEquals(res.tokens.color?.[0].value, '#ff0000')
  assertEquals(res.tokens.motion?.[0].curve, 'ease-in')
  assertThrows(() => importTokens(''), Error, 'Nothing to import')
  assertThrows(() => importTokens('{ nope'), Error, 'Invalid JSON')
  assertThrows(() => importTokens('{"a": 1}'), Error, 'No tokens')
})

Deno.test('Tailwind v4 export uses theme namespaces and a dark block', () => {
  const tw = tokensToTailwindV4(DEFAULT_TOKENS)
  assert(tw.includes('--color-primary: #0f172a;'))
  assert(tw.includes('--text-sm: 14px;'))
  assert(tw.includes('--text-sm--line-height: 20px;'))
  assert(tw.includes('--spacing-4: 16px;'))
  assert(tw.includes('.dark {'))
})

Deno.test('mergeTokenSets upserts by name', () => {
  const next = mergeTokenSets(DEFAULT_TOKENS, {
    color: [{ name: '--adhar-color-primary', value: '#000000', role: 'Primary' }, { name: '--adhar-color-new', value: '#fff', role: 'New' }],
  })
  assertEquals(next.color.find((c) => c.name === '--adhar-color-primary')?.value, '#000000')
  assertEquals(next.color.length, DEFAULT_TOKENS.color.length + 1)
  const d = diffTokenSets(DEFAULT_TOKENS, next)
  assertEquals(d.added, ['--adhar-color-new'])
  assertEquals(d.changed, ['--adhar-color-primary'])
})

Deno.test('modularScale produces a monotonic scale on a 4px line grid', () => {
  const scale = modularScale(16, 1.25)
  assertEquals(scale.find((s) => s.name.endsWith('-base'))?.value, '16px / 24px')
  const sizes = scale.map((s) => parseInt(s.value))
  for (let i = 1; i < sizes.length; i++) assert(sizes[i] > sizes[i - 1])
  for (const s of scale) assertEquals(parseInt(s.value.split('/')[1]) % 4, 0)
})

Deno.test('parseShadow parses single CSS shadows', () => {
  assertEquals(parseShadow('0 1px 2px rgba(15,23,42,0.05)'), {
    color: 'rgba(15,23,42,0.05)',
    offsetX: '0px',
    offsetY: '1px',
    blur: '2px',
    spread: '0px',
  })
  assertEquals(parseShadow('none'), null)
})
