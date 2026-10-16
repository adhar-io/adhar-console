import { assert, assertEquals } from 'jsr:@std/assert@1'
import { defaultProjectFor } from '@adhar/builder/project'
import { copyName, filterProjects, isVisualProjectId, newProjectId, summarize } from './builder-library.ts'

const doc = (id: string, name: string, updatedAt: string) => ({
  id,
  data: { ...defaultProjectFor('visual', name) },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt,
})

Deno.test('library lists only visual projects, newest first, with page counts', () => {
  const list = summarize([
    doc('visual-a', 'Alpha', '2026-10-01T00:00:00Z'),
    doc('develop.code-builder', 'Code', '2026-10-09T00:00:00Z'),
    doc('visual-b', 'Beta', '2026-10-05T00:00:00Z'),
    { id: 'visual-bad', data: { nope: true }, createdAt: '', updatedAt: '2026-10-09T00:00:00Z' },
    doc('design.visual-builder', 'Old scratch', '2026-09-01T00:00:00Z'),
  ])
  assertEquals(list.map((p) => p.id), ['visual-b', 'visual-a', 'design.visual-builder'])
  assertEquals(list[0].pages, 1)
  assertEquals(filterProjects(list, 'alp').map((p) => p.name), ['Alpha'])
  assertEquals(filterProjects(list, '  ').length, 3)
})

Deno.test('project ids are doc-store safe and recognised', () => {
  const id = newProjectId(1_700_000_000_000, 0.123456)
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
  assert(isVisualProjectId(id))
  assert(!isVisualProjectId('develop.code-builder'))
})

Deno.test('copy names stay unique', () => {
  assertEquals(copyName('Landing', []), 'Landing (copy)')
  assertEquals(copyName('Landing', ['Landing (copy)']), 'Landing (copy 2)')
  assertEquals(copyName('Landing (copy)', ['Landing (copy)', 'Landing (copy 2)']), 'Landing (copy 3)')
})
