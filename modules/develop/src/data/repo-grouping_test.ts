import { assertEquals } from 'jsr:@std/assert'
import { groupByOwner, repoOwner } from './repo-grouping.ts'
import type { gitea } from '@adhar/api-clients'

/**
 * Repositories are shown as `owner/name` and sectioned by owner, so a long
 * list says which team or org each repo belongs to instead of presenting a
 * flat run of bare names.
 */

function repo(full: string, owner?: string): gitea.Repo {
  const [o, n] = full.split('/')
  return {
    id: Math.random(),
    name: n,
    full_name: full,
    ...(owner === undefined ? { owner: { login: o } } : owner === '' ? {} : { owner: { login: owner } }),
  } as unknown as gitea.Repo
}

Deno.test('the owner is read from the owner object when present', () => {
  assertEquals(repoOwner(repo('adhar/packages')), 'adhar')
})

Deno.test('the owner falls back to the qualified name when the object is absent', () => {
  // The search endpoints return `full_name` without an `owner` object.
  assertEquals(repoOwner(repo('platform-team/api', '')), 'platform-team')
})

Deno.test('one owner produces one unnamed section, not a heading over everything', () => {
  const list = [repo('adhar/packages'), repo('adhar/console')]
  assertEquals(groupByOwner(list), [{ owner: '', repos: list }])
})

Deno.test('a second owner is what makes the sections appear', () => {
  const a1 = repo('adhar/packages')
  const b1 = repo('payments/ledger')
  const a2 = repo('adhar/console')
  assertEquals(groupByOwner([a1, b1, a2]), [
    { owner: 'adhar', repos: [a1, a2] },
    { owner: 'payments', repos: [b1] },
  ])
})

/**
 * Sections follow the list's own order, so whichever sort the operator chose
 * still decides which section comes first — alphabetising here would quietly
 * override "most recently updated".
 */
Deno.test('section order follows the incoming sort, not the alphabet', () => {
  const z = repo('zeta/one')
  const a = repo('alpha/two')
  assertEquals(groupByOwner([z, a]).map((g) => g.owner), ['zeta', 'alpha'])
})

Deno.test('every repository survives the grouping exactly once', () => {
  const list = [repo('a/1'), repo('b/2'), repo('a/3'), repo('c/4'), repo('b/5')]
  const flat = groupByOwner(list).flatMap((g) => g.repos)
  assertEquals(flat.length, list.length)
  assertEquals(new Set(flat.map((r) => r.full_name)).size, 5)
})

Deno.test('an empty list does not produce a section', () => {
  assertEquals(groupByOwner([]), [{ owner: '', repos: [] }])
})
