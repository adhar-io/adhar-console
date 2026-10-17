import { assert, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildPrototypeDoc, nodeToPrototypeHTML } from './prototype.ts'
import { studioFiles } from './project.ts'
import { addFileToFolder, type CanvasNode } from './builder-types.ts'
import { modalNode, n } from './blueprints.ts'
import { newDataSource, DATA_FOLDER } from './studio.ts'

Deno.test('prototype: every page, page bar, navigation, toggles, data, code previews', () => {
  const modal = modalNode('Confirm?')
  const src = newDataSource('people', JSON.stringify([{ name: 'Grace' }, { name: 'Ada' }]))
  let files = addFileToFolder(studioFiles(), DATA_FOLDER, src)
  files = addFileToFolder(files, 'f_pages', { id: 'p2', name: 'About.tsx', type: 'file', language: 'tsx', route: '/about', nodes: [n('h1', '', 'About')] })
  const home = files[0].children![0].children![0]
  home.nodes = [
    { ...n('button', 'btn', 'Go'), interactions: [{ trigger: 'click', action: 'navigate', targetPageId: 'p2' }] },
    { ...n('button', 'btn', 'Open'), interactions: [{ trigger: 'click', action: 'toggle-visibility', targetNodeId: modal.id }] },
    modal,
    { ...n('ul', ''), children: [n('li', '', '{{name}}')], bind: { source: src.id } },
    { id: 'c1', type: 'code', props: { code: '{items.map(...)}', label: 'items.map', preview: [n('li', '', 'Preview row')] }, children: [], style: {} },
  ]
  const html = buildPrototypeDoc({ files, css: '', themeVars: { '--b-primary': 'red' }, dark: false, scoped: true })
  assertStringIncludes(html, 'data-page="f_home"')
  assertStringIncludes(html, 'data-page="p2"')
  assertStringIncludes(html, 'data-goto="p2"')
  assertStringIncludes(html, 'data-nav="p2"')
  assertStringIncludes(html, `data-toggle="${modal.id}"`)
  assertStringIncludes(html, 'data-initially-hidden hidden')
  assertStringIncludes(html, '>Grace</li>')
  assertStringIncludes(html, 'Preview row')
  assertStringIncludes(html, 'class="adhar-builder adhar-repo-canvas"')
})

Deno.test('prototype escapes text and drops non-http URLs', () => {
  const node: CanvasNode = { id: 'a', type: 'button', props: { children: '<img src=x onerror=alert(1)>' }, children: [], style: {},
    interactions: [{ trigger: 'click', action: 'open-url', url: 'javascript:alert(1)' }] }
  const html = nodeToPrototypeHTML(node, new Set(), [])
  assert(!html.includes('<img'))
  assert(!html.includes('javascript:'))
  assertStringIncludes(html, '&lt;img')
})
