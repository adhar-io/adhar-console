import { assertEquals } from 'jsr:@std/assert@1'
import {
  ancestors,
  buildTree,
  canMove,
  descendants,
  diffLines,
  diffStats,
  exportPath,
  extractIssueRefs,
  extractMentions,
  extractWikiLinks,
  type PageMeta,
  parseInline,
  parseMarkdown,
  plainText,
  safeHref,
  searchPages,
  taskOrdinal,
  TEMPLATES,
  toggleTaskAt,
} from './pages-model.ts'

const page = (id: string, parent: string | null, title = id, order = 0, excerpt = ''): PageMeta => ({
  id, project: 'p1', parent, title, order, version: 1, excerpt, createdAt: '2026-10-01', updatedAt: '2026-10-01', history: [],
})

Deno.test('page tree: nesting, order, breadcrumbs, loop-safe moves', () => {
  const pages = [page('a', null, 'Alpha', 1), page('b', null, 'Beta', 0), page('c', 'a', 'Child'), page('d', 'c', 'Deep'), page('o', 'missing', 'Orphan', 2)]
  const tree = buildTree(pages)
  assertEquals(tree.map((n) => n.page.id), ['b', 'a', 'o'])
  assertEquals(tree[1].children[0].children[0].page.id, 'd')
  assertEquals(tree[1].children[0].children[0].depth, 2)
  assertEquals(ancestors('d', pages).map((p) => p.id), ['a', 'c'])
  assertEquals(canMove('a', 'd', pages), false)
  assertEquals(canMove('d', 'b', pages), true)
  assertEquals(canMove('a', 'a', pages), false)
  assertEquals(descendants('a', pages).sort(), ['c', 'd'])
  // A stored cycle does not lose pages.
  const loop = [page('x', 'y'), page('y', 'x')]
  assertEquals(buildTree(loop).length + buildTree(loop).flatMap((n) => n.children).length, 2)
})

Deno.test('markdown parses to a safe AST', () => {
  const blocks = parseMarkdown('# Title\n\nHello **bold** and _it_ with `code`.\n\n- [x] done\n- [ ] todo\n\n1. one\n2. two\n\n> quote\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n---')
  assertEquals(blocks.map((b) => b.t), ['h', 'p', 'ul', 'ol', 'quote', 'table', 'code', 'hr'])
  const ul = blocks[2] as { t: 'ul'; items: Array<{ checked?: boolean }> }
  assertEquals(ul.items.map((i) => i.checked), [true, false])
  const code = blocks[6] as { t: 'code'; lang: string; v: string }
  assertEquals([code.lang, code.v], ['ts', 'const x = 1'])
})

Deno.test('links are sanitised — javascript: and data: never become hrefs', () => {
  assertEquals(safeHref('javascript:alert(1)'), null)
  assertEquals(safeHref('data:text/html,x'), null)
  assertEquals(safeHref('//evil.example'), null)
  assertEquals(safeHref('https://x.io/a'), 'https://x.io/a')
  assertEquals(safeHref('/define?section=pages'), '/define?section=pages')
  assertEquals(parseInline('[click](javascript:alert(1))')[0], { t: 'text', v: 'click' })
  assertEquals(parseInline('<img src=x onerror=alert(1)>'), [{ t: 'text', v: '<img src=x onerror=alert(1)>' }])
})

Deno.test('mentions, issue references and wiki links', () => {
  const md = 'Ping @alice and @[Bob Smith] about CON-12 and ABC-3, see [[Onboarding]]. mail a@b.io. Not x-CON-9.'
  assertEquals(extractMentions(md), ['alice', 'Bob Smith'])
  assertEquals(extractIssueRefs(md), ['CON-12', 'ABC-3'])
  assertEquals(extractIssueRefs(md, new Set(['CON'])), ['CON-12'])
  assertEquals(extractWikiLinks(md), ['Onboarding'])
  assertEquals(plainText('# T\n\n- [x] **a** [b](https://x)'), 'T a b')
})

Deno.test('line diff between versions', () => {
  const a = 'one\ntwo\nthree\nfour'
  const b = 'one\n2\nthree\nfour\nfive'
  const d = diffLines(a, b)
  assertEquals(d, [
    { op: 'eq', text: 'one' },
    { op: 'del', text: 'two' },
    { op: 'add', text: '2' },
    { op: 'eq', text: 'three' },
    { op: 'eq', text: 'four' },
    { op: 'add', text: 'five' },
  ])
  assertEquals(diffStats(d), { added: 2, removed: 1 })
  assertEquals(diffStats(diffLines('same', 'same')), { added: 0, removed: 0 })
})

Deno.test('search ranks title matches first; export paths follow the tree', () => {
  const pages = [page('a', null, 'Deploy runbook', 0, 'how to roll back a deploy'), page('b', null, 'Notes', 0, 'deploy happened on monday'), page('c', 'a', 'Rollback Steps!')]
  const hits = searchPages(pages, 'deploy')
  assertEquals(hits.map((h) => h.page.id), ['a', 'b'])
  assertEquals(searchPages(pages, 'deploy monday').map((h) => h.page.id), ['b'])
  assertEquals(exportPath(pages[2], pages), 'docs/deploy-runbook/rollback-steps.md')
  assertEquals(exportPath(pages[2], pages, '/wiki/'), 'wiki/deploy-runbook/rollback-steps.md')
})

Deno.test('templates render with context', () => {
  const prd = TEMPLATES.find((t) => t.id === 'prd')!.body({ title: 'Search', date: '2026-10-21', author: 'ada' })
  assertEquals(prd.startsWith('# Search'), true)
  assertEquals(extractMentions(prd), ['ada'])
  assertEquals(TEMPLATES.map((t) => t.id), ['blank', 'prd', 'rfc', 'retro', 'meeting', 'runbook'])
})

Deno.test('task toggles map rendered checkboxes back to source lines', () => {
  const md = '- [ ] a\n- plain\n- [x] b\n\n```\n- [ ] not a task\n```\n\n- [ ] c'
  const blocks = parseMarkdown(md)
  assertEquals(taskOrdinal(blocks, 0, 2), 1)
  assertEquals(toggleTaskAt(md, taskOrdinal(blocks, 0, 2)).split('\n')[2], '- [ ] b')
  const lastBlock = blocks.findLastIndex((b) => b.t === 'ul')
  assertEquals(toggleTaskAt(md, taskOrdinal(blocks, lastBlock, 0)).split('\n').at(-1), '- [x] c')
  assertEquals(toggleTaskAt(md, 0).split('\n')[0], '- [x] a')
})
