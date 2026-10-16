import { assert, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildPrototypeDoc } from './prototype.ts'
import { createStarterProject } from './starters.ts'
import type { CanvasNode } from './builder-types.ts'
import { nodeToPrototypeHTML } from './prototype.ts'

Deno.test('prototype: every page, page bar, navigation, toggles, start page', () => {
  const p = createStarterProject({ name: 'x', starter: 'crud' })
  const html = buildPrototypeDoc({ files: p.files, css: '', themeVars: { '--b-primary': 'red' }, dark: false, startPageId: 'f_page_new' })
  assertStringIncludes(html, 'data-page="f_page_customers"')
  assertStringIncludes(html, 'data-page="f_page_new"')
  assertStringIncludes(html, 'data-goto="f_page_new"')
  assertStringIncludes(html, 'data-nav="f_page_new"')
  assertStringIncludes(html, 'data-toggle=')
  assertStringIncludes(html, 'data-initially-hidden hidden')
  assertStringIncludes(html, 'data-start="f_page_new"')
  // Data rows expanded from the bound source.
  assertStringIncludes(html, 'grace@cobol.dev')
  // Component instance resolved.
  assertStringIncludes(html, 'Acme Admin')
})

Deno.test('prototype escapes text and drops non-http URLs', () => {
  const n: CanvasNode = { id: 'a', type: 'button', props: { children: '<img src=x onerror=alert(1)>' }, children: [], style: {},
    interactions: [{ trigger: 'click', action: 'open-url', url: 'javascript:alert(1)' }] }
  const html = nodeToPrototypeHTML(n, new Set(), [])
  assert(!html.includes('<img'))
  assert(!html.includes('javascript:'))
  assertStringIncludes(html, '&lt;img')
})
