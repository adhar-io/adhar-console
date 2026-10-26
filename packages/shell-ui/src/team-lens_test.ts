import { assertEquals } from 'jsr:@std/assert@1'
import { lensOrAll, teamProjectLens } from './team-lens.ts'

Deno.test('lensOrAll narrows while something matches', () => {
  assertEquals(lensOrAll([1, 2, 3, 4], (n) => n % 2 === 0), [2, 4])
})

Deno.test('lensOrAll shows everything when the lens would hide everything', () => {
  assertEquals(lensOrAll([1, 3], (n) => n % 2 === 0), [1, 3])
  assertEquals(lensOrAll([], () => false), [])
})

Deno.test('lensOrAll is a no-op when inactive', () => {
  assertEquals(lensOrAll([1, 2], () => false, false), [1, 2])
})

const projects = [{ slug: 'shop', teams: ['payments'] }, { slug: 'ops', teams: ['platform'] }, { slug: 'lab' }]

Deno.test('teamProjectLens keeps the team’s projects', () => {
  const r = teamProjectLens(projects, 'payments', true)
  assertEquals(r.filtering, true)
  assertEquals(r.projects.map((p) => p.slug), ['shop'])
})

Deno.test('teamProjectLens falls back to the organization for a team with no projects', () => {
  const r = teamProjectLens(projects, 'research', true)
  assertEquals(r.filtering, false)
  assertEquals(r.projects.length, 3)
})

Deno.test('teamProjectLens does nothing without a team or when not filtering', () => {
  assertEquals(teamProjectLens(projects, '', true).filtering, false)
  assertEquals(teamProjectLens(projects, 'payments', false).projects.length, 3)
})
