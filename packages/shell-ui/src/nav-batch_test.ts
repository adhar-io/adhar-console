import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'

/**
 * Develop → Batch's sidebar row. The tree is JSX and this runner imports no React
 * for it, so the row is read from the source: right after Functions (design 0025
 * §7.1), for the roles that build, and pointing at a section the module serves.
 */
Deno.test('the Batch row sits after Functions, for builders', async () => {
  const src = await Deno.readTextFile(new URL('./nav-tree.tsx', import.meta.url))
  const rows = [...src.matchAll(/\{ id: '(develop\.[a-z]+)'/g)].map((m) => m[1])
  assertEquals(rows[rows.indexOf('develop.functions') + 1], 'develop.batch')
  assert(/\{ id: 'develop\.batch', label: 'Batch', to: '\/develop', search: 'batch', roles: BUILDER_ROLES \}/.test(src))
})

Deno.test('the section the row points at is one the Develop module serves', async () => {
  const home = await Deno.readTextFile(new URL('../../../modules/develop/src/home.tsx', import.meta.url))
  assert(/active === 'batch' && <Batch \/>/.test(home))
  assert(/\| 'batch'/.test(home))
  assert(/SELF_HEADED = new Set<Section>\([^)]*'batch'/.test(home))
})
