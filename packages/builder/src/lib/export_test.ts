import { assertEquals } from 'jsr:@std/assert@1'
import { defaultProjectFor, normalizeProject } from './project.ts'
import { extractFence } from './html-to-nodes.ts'
import { designThemeVars } from './design-theme.ts'

// The Argo export's tests live beside it, in argo-export_test.ts.

Deno.test('normalizeProject accepts the standalone builder file array and rejects junk', () => {
  const arr = defaultProjectFor('workflow').files
  assertEquals(normalizeProject(arr, 'legacy')?.name, 'legacy')
  assertEquals(normalizeProject({ nope: 1 }), null)
  assertEquals(normalizeProject(null), null)
  assertEquals(normalizeProject({ files: [], settings: { framework: 'svelte' } })?.settings.theme, 'adhar')
})

Deno.test('extractFence prefers the requested language', () => {
  const reply = 'Here:\n```css\na{}\n```\nand\n```html\n<div>x</div>\n```'
  assertEquals(extractFence(reply, ['html']), '<div>x</div>')
  assertEquals(extractFence(reply), 'a{}')
  assertEquals(extractFence('no code'), null)
})

Deno.test('design theme vars map onto --b-* with mode-scoped overrides', () => {
  const light = designThemeVars('adhar', false, { 'light.primary': '0 100% 50%', 'dark.primary': '120 100% 50%' })
  assertEquals(light['--b-primary'], 'hsl(0 100% 50%)')
  assertEquals(light['--b-primary-foreground'], 'hsl(0 0% 100%)')
  const dark = designThemeVars('adhar', true, { 'dark.primary': '120 100% 50%' })
  assertEquals(dark['--b-primary'], 'hsl(120 100% 50%)')
})
