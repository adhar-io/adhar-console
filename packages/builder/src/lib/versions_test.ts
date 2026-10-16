import { assert, assertEquals } from 'jsr:@std/assert@1'
import { makeVersion, versionId, versionsOf } from './versions.ts'
import { defaultProjectFor } from './project.ts'

Deno.test('version ids are doc-store safe', () => {
  const id = versionId('design.wireframe.wf/1', 1_700_000_000_000)
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
  assert(id.startsWith('design.wireframe.wf-1--v'))
})

Deno.test('versions of one doc, newest first, junk skipped', () => {
  const p = defaultProjectFor('visual', 'A')
  const rows = [
    { id: '1', data: makeVersion('doc-a', 'First', p, new Date('2026-10-01T00:00:00Z')) },
    { id: '2', data: makeVersion('doc-b', 'Other doc', p, new Date('2026-10-03T00:00:00Z')) },
    { id: '3', data: makeVersion('doc-a', '', p, new Date('2026-10-02T00:00:00Z')) },
    { id: '4', data: { docId: 'doc-a', name: 'Broken', project: { nope: true } } },
    { id: '5', data: null },
  ]
  const list = versionsOf('doc-a', rows)
  assertEquals(list.map((v) => v.id), ['3', '1'])
  assert(list[0].name.startsWith('Version 2026-10-02'))
  assertEquals(list[1].project.name, 'A')
})
