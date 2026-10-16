import { assert, assertEquals } from 'jsr:@std/assert@1'
import { BLUEPRINTS, findBlueprint, instantiate, searchBlueprints } from './blueprints.ts'
import { collectRepeaters } from './studio.ts'
import { STARTERS } from './starter-list.ts'
import { createStarterProject } from './starters.ts'
import { listPages } from './studio.ts'

Deno.test('palette covers app categories and composites build subtrees', () => {
  assertEquals(BLUEPRINTS.map((c) => c.id), ['layout', 'text', 'forms', 'data', 'navigation', 'feedback', 'media'])
  const form = instantiate(findBlueprint('form')!)
  assert(form.children.length >= 4)
  const table = instantiate(findBlueprint('data-table')!)
  assertEquals(collectRepeaters(table).length, 1)
  const modal = instantiate(findBlueprint('modal')!)
  // The modal's Cancel button closes the modal itself.
  assert(JSON.stringify(modal).includes(`"targetNodeId":"${modal.id}"`))
})

Deno.test('palette search uses keywords', () => {
  const hits = searchBlueprints(BLUEPRINTS, 'dropdown').flatMap((c) => c.items.map((i) => i.type))
  assertEquals(hits, ['select'])
})

Deno.test('every starter builds; multi-page ones have linked pages', () => {
  for (const s of STARTERS) {
    const p = createStarterProject({ name: s.label, starter: s.id })
    const pages = listPages(p.files)
    assert(pages.length >= 1, s.id)
    if (s.id !== 'blank') assert(pages.length >= 2, `${s.id} should be multi-page`)
    assertEquals(pages.filter((x) => x.home).length, 1, `${s.id} home`)
  }
})
