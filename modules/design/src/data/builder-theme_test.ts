import { assert, assertEquals } from 'jsr:@std/assert@1'
import { hexToHslTriplet, themeFromTokenSet } from './builder-theme.ts'
import type { TokenSet } from './types.ts'

const set = (color: TokenSet['color'], radius: TokenSet['radius'] = []): TokenSet => ({
  color, radius, spacing: [], typography: [], elevation: [], motion: [], breakpoint: [],
})

Deno.test('hex → HSL triplet', () => {
  assertEquals(hexToHslTriplet('#ffffff'), '0 0% 100%')
  assertEquals(hexToHslTriplet('#000'), '0 0% 0%')
  assertEquals(hexToHslTriplet('#4f46e5'), '243 75% 59%')
  assertEquals(hexToHslTriplet('rebeccapurple'), null)
})

Deno.test('workspace tokens become the Workspace theme', () => {
  const t = themeFromTokenSet(set([
    { name: '--adhar-color-primary', value: '#0f172a', role: 'Primary surface' },
    { name: '--adhar-color-accent', value: '#4f46e5', role: 'Accent / link' },
    { name: '--adhar-color-danger', value: '#e11d48', role: 'Danger' },
    { name: '--adhar-color-border', value: '#e2e8f0', role: 'Border' },
  ], [{ name: 'radius-sm', value: '4px' }, { name: 'radius-md', value: '8px' }, { name: 'radius-lg', value: '12px' }]))!
  assertEquals(t.id, 'workspace')
  assertEquals(t.light.primary, hexToHslTriplet('#0f172a'))
  assertEquals(t.light.primaryForeground, '0 0% 100%')
  assertEquals(t.light.ring, hexToHslTriplet('#4f46e5'))
  assertEquals(t.light.destructive, hexToHslTriplet('#e11d48'))
  assertEquals(t.light.border, hexToHslTriplet('#e2e8f0'))
  assertEquals(t.light.radius, '8px')
  // A navy primary would vanish on dark surfaces — the accent stands in.
  assertEquals(t.dark.primary, hexToHslTriplet('#4f46e5'))
})

Deno.test('explicit dark token values drive the dark variant', () => {
  const t = themeFromTokenSet(set([{ name: 'primary', value: '#2563eb', role: 'Primary', dark: '#60a5fa' }]))!
  assertEquals(t.dark.primary, hexToHslTriplet('#60a5fa'))
})

Deno.test('no usable colours → no theme', () => {
  assertEquals(themeFromTokenSet(null), null)
  assertEquals(themeFromTokenSet(set([{ name: 'border', value: '#eee', role: 'Border' }])), null)
  assert(themeFromTokenSet(set([{ name: 'brand', value: 'nope', role: 'Primary' }])) === null)
})
