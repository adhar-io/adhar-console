import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@^1.0.0'
import { addTerm, CONDITIONS, conjunctionTerms, dependsTerms, fromDependencies, parseDepends, printDepends, removeTask, renameTask, setCondition } from './depends.ts'

/** §6.5: Argo's `depends` — precedence, parentheses, `.Succeeded` and friends, and the three canvas edits. */

const round = (s: string) => {
  const r = parseDepends(s)
  if (!r.ok) throw new Error(r.message)
  return printDepends(r.ast)
}

Deno.test('! binds tighter than &&, which binds tighter than ||', () => {
  const r = parseDepends('a || b && !c')
  assert(r.ok && r.ast)
  assertEquals(r.ast.type, 'or')
  const or = r.ast as { type: 'or'; items: Array<{ type: string; items?: Array<{ type: string }> }> }
  assertEquals(or.items.map((i) => i.type), ['term', 'and'])
  assertEquals(or.items[1].items!.map((i) => i.type), ['term', 'not'])
})

Deno.test('printing keeps written parentheses and adds none', () => {
  for (const s of ['a', 'a && b', 'a || b && c', '(a || b) && c', '!a', '!(a && b)', 'a.Succeeded && (b.Failed || b.Errored)', '((a))', 'task-1.AnySucceeded || task_2.AllFailed']) {
    assertEquals(round(s), s)
  }
  assertEquals(round('  a&&b  ||c '), 'a && b || c')
  assertEquals(parseDepends(''), { ok: true, ast: null })
  assertEquals(parseDepends('   '), { ok: true, ast: null })
})

Deno.test('every result Argo knows parses; anything else is refused where it is', () => {
  assertEquals([...CONDITIONS], ['Succeeded', 'Failed', 'Errored', 'Skipped', 'Omitted', 'Daemoned', 'AnySucceeded', 'AllFailed'])
  for (const c of CONDITIONS) {
    assertEquals(dependsTerms(`a.${c}`).map((t) => t.condition), [c])
  }
  const bad = parseDepends('a && b.Done')
  assert(!bad.ok)
  assertEquals(bad.offset, 6)
  for (const s of ['a &&', '(a || b', 'a b', 'a & b', '&& a', 'a.']) assert(!parseDepends(s).ok, s)
  assertEquals(dependsTerms('a &&'), [])
})

Deno.test('a bare name and .Succeeded are kept apart', () => {
  assertEquals(dependsTerms('a && b.Succeeded').map((t) => t.condition), [undefined, 'Succeeded'])
  assertEquals(round('a && b.Succeeded'), 'a && b.Succeeded')
})

Deno.test('a pure conjunction is one edge per term; anything else is an expression', () => {
  assertEquals(conjunctionTerms('a && b.Failed && (c)')!.map((t) => [t.task, t.condition]), [['a', undefined], ['b', 'Failed'], ['c', undefined]])
  assertEquals(conjunctionTerms(''), [])
  assertEquals(conjunctionTerms('(a || b) && c'), null)
  assertEquals(conjunctionTerms('!a'), null)
  assertEquals(conjunctionTerms('a.Succeeded && a.Failed'), null, 'one edge cannot say two things')
  assertEquals(conjunctionTerms('a &&'), null)
})

Deno.test('legacy dependencies become the depends that means the same', () => {
  assertEquals(fromDependencies(['a', 'b', 'c']), 'a && b && c')
  assertEquals(fromDependencies([]), '')
  assertEquals(conjunctionTerms(fromDependencies(['a', 'b']))!.map((t) => t.task), ['a', 'b'])
})

Deno.test('addTerm joins with &&, in place when asked, and wraps a top-level ||', () => {
  assertEquals(addTerm('', 'a'), 'a')
  assertEquals(addTerm('a', 'b', 'Failed'), 'a && b.Failed')
  assertEquals(addTerm('a && c', 'b', undefined, 1), 'a && b && c')
  assertEquals(addTerm('a || b', 'c'), '(a || b) && c')
  assertThrows(() => addTerm('a &&', 'b'))
})

Deno.test('removeTask drops every reference and what it leaves empty', () => {
  assertEquals(removeTask('a && b && c', 'b'), { depends: 'a && c', index: 1, term: { task: 'b', condition: undefined, start: 5, end: 6 } })
  assertEquals(removeTask('a', 'a').depends, undefined)
  assertEquals(removeTask('(a || b) && c', 'a').depends, 'b && c')
  assertEquals(removeTask('(a || b) && c', 'c').depends, 'a || b')
  assertEquals(removeTask('!a && b', 'a').depends, 'b')
  assertEquals(removeTask('a.Failed && b', 'a').term?.condition, 'Failed')
  assertEquals(removeTask('a && b', 'zzz'), { depends: 'a && b', index: -1, term: undefined })
  // add ∘ remove is the identity on a conjunction.
  const r = removeTask('a && b.Failed && c', 'b')
  assertEquals(addTerm(r.depends!, 'b', r.term!.condition, r.index), 'a && b.Failed && c')
})

Deno.test('renameTask changes only whole task names, and keeps the spacing', () => {
  assertEquals(renameTask('build  &&  (build-image.Failed||build.Succeeded)', 'build', 'compile'), 'compile  &&  (build-image.Failed||compile.Succeeded)')
  assertEquals(renameTask('a && ab && a_b', 'a', 'z'), 'z && ab && a_b')
  assertEquals(renameTask('Succeeded.Succeeded', 'Succeeded', 'x'), 'x.Succeeded')
})

Deno.test('setCondition rewrites the references to one task', () => {
  assertEquals(setCondition('a && b', 'a', 'Failed'), 'a.Failed && b')
  assertEquals(setCondition('a.Failed && b', 'a', undefined), 'a && b')
  assertEquals(setCondition('a &&', 'a', 'Failed'), 'a &&')
})
