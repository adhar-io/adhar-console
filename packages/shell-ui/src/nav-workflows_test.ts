import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'

/**
 * Platform → Workflows (design 0026 §6.1). The tree is JSX and this runner
 * imports no React for it, so the row is read from the source: a level-1 row
 * between Kubernetes and Adhar Resources, for everyone who builds software,
 * whose every page is a section the Platform module's Workflows area serves —
 * and whose Engine page is for platform staff only.
 */

const nav = await Deno.readTextFile(new URL('./nav-tree.tsx', import.meta.url))
const gvr = await Deno.readTextFile(new URL('../../../modules/platform/src/workflows/data/gvr.ts', import.meta.url))
const home = await Deno.readTextFile(new URL('../../../modules/platform/src/home.tsx', import.meta.url))

Deno.test('the Workflows row sits between Kubernetes and Adhar Resources, for builders', () => {
  const level1 = [...nav.matchAll(/\n {6}\{\n(?: {8}\/\/.*\n)* {8}id: '([a-z-]+)'/g)].map((m) => m[1])
  const at = level1.indexOf('platform-workflows')
  assert(at > 0, 'no platform-workflows row')
  assertEquals([level1[at - 1], level1[at + 1]], ['platform-root', 'platform-resources'])
  const row = nav.slice(nav.indexOf("id: 'platform-workflows'"), nav.indexOf("id: 'platform-resources'"))
  assert(/icon: <IconWorkflow \/>/.test(row))
  assert(/roles: LIFECYCLE_ROLES/.test(row))
  assert(/id: 'platform\.workflow-engine'[^}]*roles: PLATFORM_OPS_ROLES/.test(row), 'Engine is for platform staff')
})

Deno.test('every Workflows page is a section the Workflows area serves, and Home routes them all to it', () => {
  const row = nav.slice(nav.indexOf("id: 'platform-workflows'"), nav.indexOf("id: 'platform-resources'"))
  const searches = [...row.matchAll(/\{ id: 'platform\.[a-z-]+', label: '[^']+', to: '\/platform', search: '([a-z-]+)'/g)].map((m) => m[1])
  const sections = JSON.parse(/export const SECTIONS = (\[[^\]]+\])/.exec(gvr)![1].replace(/'/g, '"'))
  assertEquals(searches, sections)
  assert(/section === 'workflows' \|\| Boolean\(section\?\.startsWith\('workflow-'\)\)/.test(home))
  assert(!/WorkflowsView/.test(home), 'the dead Temporal XR page is gone')
})
