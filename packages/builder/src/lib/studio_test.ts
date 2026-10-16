import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { studioFiles } from './project.ts'
import { addFileToFolder, findFileInTree, type CanvasNode } from './builder-types.ts'
import {
  bindingItems, countInstances, DATA_FOLDER, detachInstance, ensureFolder, expandBindings, getPath, homePage, interpolate,
  listPages, makeSymbol, moveFile, newDataSource, newPage, pageRoute, renderableNodes, resolveSymbols, setHomePage,
  slugify, SYMBOLS_FOLDER, templateFields,
} from './studio.ts'

const node = (type: string, text?: string, children: CanvasNode[] = [], extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id: `${type}-${Math.random().toString(36).slice(2, 7)}`, type, props: text ? { children: text } : {}, children, style: {}, ...extra })

Deno.test('pages: routes, home, add, reorder', () => {
  let files = studioFiles()
  const about = newPage('about us', listPages(files).map((p) => p.name))
  files = addFileToFolder(files, 'f_pages', about)
  assertEquals(about.name, 'AboutUs.tsx')
  assertEquals(pageRoute(listPages(files)[0], files), '/')
  assertEquals(pageRoute(about, files), '/about-us')
  files = setHomePage(files, about.id)
  assertEquals(homePage(files)?.id, about.id)
  assertEquals(listPages(files).filter((p) => p.home).length, 1)
  files = moveFile(files, about.id, -1)
  assertEquals(listPages(files)[0].id, about.id)
  assertEquals(slugify('NewCustomer.tsx'), 'new-customer')
})

Deno.test('symbols: make, instances resolve to the master, edits propagate, detach', () => {
  const card = node('card', undefined, [node('h3', 'Title')])
  const { symbol, instance } = makeSymbol(card, 'product card')
  assertEquals(symbol.name, 'ProductCard.tsx')
  assert(symbol.symbol)
  let files = addFileToFolder(studioFiles(), SYMBOLS_FOLDER, symbol)
  const page = [instance, { ...instance, id: 'second' }]
  assertEquals(countInstances(files, symbol.id), 0)
  files = addFileToFolder(files, 'f_pages', { id: 'p2', name: 'P2.tsx', type: 'file', language: 'tsx', nodes: page })
  assertEquals(countInstances(files, symbol.id), 2)
  // Pages don't list symbols.
  assert(!listPages(files).some((p) => p.symbol))

  let resolved = resolveSymbols(page, files)
  assertEquals(resolved[0].type, 'card')
  assertEquals(resolved[0].children[0].props.children, 'Title')
  // Edit the master once → every instance changes.
  const master = findFileInTree(files, symbol.id)!.nodes![0]
  master.children[0].props.children = 'Renamed'
  resolved = resolveSymbols(page, files)
  assertEquals(resolved.map((r) => r.children[0].props.children), ['Renamed', 'Renamed'])

  const detached = detachInstance(instance, files)!
  assertEquals(detached.type, 'card')
  assert(detached.id !== master.id)
})

Deno.test('symbols: a cycle renders as missing instead of looping', () => {
  const self: CanvasNode = { id: 'i', type: 'symbol', props: { symbolId: 'f_sym_x' }, children: [], style: {} }
  const files = addFileToFolder(studioFiles(), SYMBOLS_FOLDER, { id: 'f_sym_x', name: 'X.tsx', type: 'file', language: 'tsx', symbol: true, nodes: [node('div', undefined, [self])] })
  const out = resolveSymbols([self], files)
  assertStringIncludes(JSON.stringify(out), 'Missing component')
})

Deno.test('data: paths, templates, repeaters', () => {
  assertEquals(getPath({ a: { b: [1, { c: 'x' }] } }, 'a.b.1.c'), 'x')
  assertEquals(interpolate('Hi {{ user.name }} ({{missing}})', { user: { name: 'Ann' } }), 'Hi Ann ()')
  assertEquals(templateFields('{{a}} {{b.c}}'), ['a', 'b.c'])

  const src = newDataSource('Customers', JSON.stringify({ results: [{ name: 'A' }, { name: 'B' }] }))
  assertEquals(src.name, 'customers.json')
  const files = addFileToFolder(ensureFolder(studioFiles(), DATA_FOLDER), DATA_FOLDER, src)
  const list = node('flex-col', undefined, [node('span', 'Name: {{name}}')], { bind: { source: src.id, path: 'results' } })
  assertEquals(bindingItems(files, list.bind).length, 2)
  const [expanded] = expandBindings([list], files)
  assertEquals(expanded.children.map((c) => c.props.children), ['Name: A', 'Name: B'])
  assertEquals(new Set(expanded.children.map((c) => c.id)).size, 2)
  // Invalid JSON → no items, no throw.
  const bad = addFileToFolder(studioFiles(), 'f_data', { ...src, content: '{nope' })
  assertEquals(bindingItems(bad, list.bind), [])
  assertEquals(renderableNodes([list], bad)[0].children.length, 0)
})
