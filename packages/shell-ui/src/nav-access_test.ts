import { assert, assertEquals } from 'jsr:@std/assert@1'
import { accessCheckKey, CONSOLE_PERMISSIONS, consoleCheck } from '@adhar/auth'
import { type AccessGated, collectNavChecks, filterByAccess, navItemAllowed } from './nav-access.ts'

const billing = consoleCheck(CONSOLE_PERMISSIONS.billingView)
const create = consoleCheck(CONSOLE_PERMISSIONS.applicationsCreate)

type Row = AccessGated & { id: string; to?: string; children?: Row[] }

const tree: Row[] = [
  { id: 'home', to: '/' },
  { id: 'create', to: '/catalog', access: { check: create, mode: 'action' } },
  { id: 'billing', to: '/settings', access: { check: billing } },
  {
    id: 'group',
    children: [{ id: 'only-child', to: '/x', access: { check: billing } }],
  },
]

const answers = (entries: Array<[ReturnType<typeof consoleCheck>, boolean | undefined]>) =>
  new Map(entries.map(([c, v]) => [accessCheckKey(c), v]))

Deno.test('every distinct check in the tree is collected once', () => {
  const checks = collectNavChecks(tree)
  assertEquals(checks.length, 2)
})

Deno.test('a read-gated row stays while loading and when unknown; goes on a definite no', () => {
  const row = tree[2]
  assert(navItemAllowed(row, answers([])))
  assert(navItemAllowed(row, answers([[billing, undefined]])))
  assert(!navItemAllowed(row, answers([[billing, false]])))
})

Deno.test('an action row is hidden until a definite yes — no flash', () => {
  const row = tree[1]
  assert(!navItemAllowed(row, answers([])))
  assert(!navItemAllowed(row, answers([[create, false]])))
  assert(navItemAllowed(row, answers([[create, true]])))
})

Deno.test('filtering drops denied rows and empty pure groups, and keeps identity when nothing changes', () => {
  const all = answers([[billing, true], [create, true]])
  assertEquals(filterByAccess(tree, all), tree, 'same array when nothing is hidden')

  const denied = filterByAccess(tree, answers([[billing, false], [create, true]]))
  assertEquals(denied.map((r) => r.id), ['home', 'create'])
})
