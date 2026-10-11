import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { hierarchyRefKind } from './hierarchy-refs.ts'

// A Team's `organisation` and a Project's `team` are references to objects
// that already exist; the create form must offer them, not a free text box.
Deno.test('hierarchy fields resolve to the kind they name', () => {
  assertEquals(hierarchyRefKind('organisation'), 'Organisation')
  assertEquals(hierarchyRefKind('organization'), 'Organisation')
  assertEquals(hierarchyRefKind('team'), 'Team')
  assertEquals(hierarchyRefKind('project'), 'Project')
  assertEquals(hierarchyRefKind('Environment'), 'Environment')
})

Deno.test('ordinary fields are not references', () => {
  for (const f of ['name', 'displayName', 'cpuQuota', 'giteaPermission', 'teamSize', 'organisationName']) {
    assertEquals(hierarchyRefKind(f), undefined, f)
  }
})
