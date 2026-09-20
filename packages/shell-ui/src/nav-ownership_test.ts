import { assertEquals } from 'jsr:@std/assert'
import { conflictingDestinations, ownsDestination, type NavOwnership } from './nav-ownership.ts'

/**
 * The bug: "CI Pipelines" (Develop) and "CI / CD" (Platform) both pointed at
 * /platform?section=ci. Both rows highlighted, and the sidebar's auto-expansion
 * followed whichever it found first — so clicking the Develop shortcut highlighted
 * the Platform row and flipped that group open instead.
 */

Deno.test('two independent rows sharing a destination is a conflict', () => {
  const tree: NavOwnership[] = [
    { id: 'develop', children: [{ id: 'develop.ci', to: '/platform', search: 'ci' }] },
    { id: 'platform', children: [{ id: 'platform.ci', to: '/platform', search: 'ci' }] },
  ]
  assertEquals(conflictingDestinations(tree), [
    { destination: '/platform?ci', rows: ['develop.ci', 'platform.ci'] },
  ])
})

Deno.test('declaring the borrowed row a cross-link resolves it', () => {
  const tree: NavOwnership[] = [
    {
      id: 'develop',
      children: [{ id: 'develop.ci', to: '/platform', search: 'ci', crossLink: true }],
    },
    { id: 'platform', children: [{ id: 'platform.ci', to: '/platform', search: 'ci' }] },
  ]
  assertEquals(conflictingDestinations(tree), [])
  // And the highlight goes to the owner, not the shortcut.
  assertEquals(ownsDestination({ id: 'develop.ci', to: '/platform', search: 'ci', crossLink: true }), false)
  assertEquals(ownsDestination({ id: 'platform.ci', to: '/platform', search: 'ci' }), true)
})

Deno.test('a parent sharing its first child destination is not a conflict', () => {
  // nav-item.tsx already gives the child the solid highlight and the parent the
  // subtle style, so flagging this pair would be a false positive.
  const tree: NavOwnership[] = [
    {
      id: 'platform-resources',
      to: '/platform',
      search: 'catalog',
      children: [{ id: 'platform.catalog', to: '/platform', search: 'catalog' }],
    },
  ]
  assertEquals(conflictingDestinations(tree), [])
})

Deno.test('a group with no destination never owns one', () => {
  assertEquals(ownsDestination({ id: 'develop' }), false)
})

/**
 * The real tree, read as source. The Deno runner has no React in its import map, so
 * nav-tree.tsx cannot be imported here — but its data can still be checked, and that
 * is what stops the next duplicate from being added silently.
 */
Deno.test('the shipped nav tree has no conflicting destinations', async () => {
  const src = await Deno.readTextFile(new URL('./nav-tree.tsx', import.meta.url))
  const owners = new Map<string, string[]>()

  // Each row is a single object literal; read id/to/search/crossLink out of it.
  for (const match of src.matchAll(/\{[^{}]*\bid:\s*'([^']+)'[^{}]*\}/g)) {
    const body = match[0]
    const id = match[1]
    const to = body.match(/\bto:\s*'([^']+)'/)?.[1]
    if (!to) continue
    if (/\bcrossLink:\s*true/.test(body)) continue
    const search = body.match(/\bsearch:\s*'([^']+)'/)?.[1] ?? ''
    const key = `${to}?${search}`
    owners.set(key, [...(owners.get(key) ?? []), id])
  }

  const conflicts = [...owners.entries()]
    .filter(([, rows]) => rows.length > 1)
    // The parent/child pair is legitimate: a parent row is declared with children,
    // so it never appears in this flat single-literal scan alongside its own child.
    .map(([destination, rows]) => `${destination} claimed by ${rows.join(', ')}`)

  assertEquals(
    conflicts,
    [],
    'mark the borrowed row `crossLink: true` so one URL highlights one row',
  )
})
