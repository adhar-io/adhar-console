import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@^1.0.0'
import { OpError } from './ops.ts'
import { apply, editText, hasChanges, isDirty, markSaved, MAX_UNDO, open, redo, text, undo } from './session.ts'
import { corpusText, platformCatalogue } from './testdata.ts'

/** §6.5: one document shared by the canvas and the YAML panel, with snapshot undo. */

const opts = { catalogue: platformCatalogue() }
const RELEASE = corpusText('handwritten/release-check.yaml')

Deno.test('opening and saving without an edit writes the bytes that were read', () => {
  const s = open(RELEASE, opts)
  assertEquals(text(s), RELEASE)
  assert(!isDirty(s) && !hasChanges(s) && !s.frozen)
  assertEquals(s.graph.nodes.length, 6)
  assertEquals(s.undo.length, 0)
})

Deno.test('a canvas edit is one undo step; undo restores the exact text, redo the exact edit', () => {
  const s0 = open(RELEASE, opts)
  const { session: s1, result } = apply(s0, { op: 'rename', node: 'scan', to: 'sast' }, opts)
  assertEquals(result.changes, ['Renamed "scan" to "sast"'])
  assertEquals(s1.changes, result.changes)
  assert(isDirty(s1) && hasChanges(s1))
  assert(s1.graph.nodes.some((n) => n.id === 'sast'))
  const s2 = apply(s1, { op: 'removeNode', node: 'unit' }, opts).session
  assertEquals(s2.undo.length, 2)
  const back1 = undo(s2, opts)
  assertEquals(text(back1), text(s1))
  const back0 = undo(back1, opts)
  assertEquals(text(back0), RELEASE, 'byte for byte, formatting included')
  assert(!isDirty(back0))
  assertEquals(undo(back0, opts), back0)
  const fwd = redo(redo(back0, opts), opts)
  assertEquals(text(fwd), text(s2))
  assertEquals(redo(fwd, opts), fwd)
  // A new edit after an undo drops the redo stack.
  const branched = apply(back1, { op: 'rename', node: 'lint', to: 'style' }, opts).session
  assertEquals(branched.redo.length, 0)
})

Deno.test('an operation that cannot apply throws and leaves the session as it was', () => {
  const s = open(RELEASE, opts)
  assertThrows(() => apply(s, { op: 'rename', node: 'scan', to: 'lint' }, opts), OpError)
  assertEquals(text(s), RELEASE)
  // An operation that changes nothing adds no undo step.
  const same = apply(s, { op: 'rename', node: 'scan', to: 'scan' }, opts).session
  assertEquals(same.undo.length, 0)
  assertEquals(apply(s, { op: 'setPositions', positions: { build: { x: 0, y: 116 } } }, opts).session.undo.length, 0)
})

Deno.test('typing is one undo step however many keystrokes it took', () => {
  let s = open(RELEASE, opts)
  for (const name of ['release-chec', 'release-che', 'release-ch', 'release-gate']) s = editText(s, RELEASE.replace('name: release-check', `name: ${name}`), opts)
  assertEquals(s.undo.length, 1)
  assertEquals(s.graph.resource.name, 'release-gate')
  assertEquals(text(undo(s, opts)), RELEASE)
  // A canvas edit in between starts a new typing step.
  const mixed = editText(apply(s, { op: 'rename', node: 'scan', to: 'sast' }, opts).session, text(s), opts)
  assertEquals(mixed.undo.length, 3)
})

Deno.test('broken YAML freezes the canvas on the last good graph and fixes nothing', () => {
  const s0 = open(RELEASE, opts)
  const broken = RELEASE.replace('entrypoint: main', 'entrypoint: [main')
  const s1 = editText(s0, broken, opts)
  assert(s1.frozen)
  assertEquals(text(s1), broken, 'what was typed is what a save would write')
  assertEquals(s1.graph.nodes.map((n) => n.id), s0.graph.nodes.map((n) => n.id))
  assertEquals(s1.graph.editable, false)
  assertEquals(s1.graph.readOnly, 'yaml-errors')
  assert(s1.graph.diagnostics.length > 0 && s1.graph.diagnostics.every((x) => x.code === 'yaml/syntax'))
  const e = assertThrows(() => apply(s1, { op: 'rename', node: 'scan', to: 'sast' }, opts), OpError)
  assertEquals(e.code, 'unparseable')
  // Fixing the text thaws it.
  const s2 = editText(s1, RELEASE, opts)
  assert(!s2.frozen && s2.graph.editable)
  // Opening a broken file has no last good graph to show.
  const cold = open(broken, opts)
  assert(cold.frozen)
  assertEquals(cold.graph.nodes, [])
})

Deno.test('dirty is about bytes; changes are about content', () => {
  const s = editText(open(RELEASE, opts), RELEASE.replace('activeDeadlineSeconds: 3600   # one hour is generous', 'activeDeadlineSeconds: 3600 # one hour'), opts)
  assert(isDirty(s))
  assert(!hasChanges(s), 'a comment and spacing are not content: publishing drops the file')
  const saved = markSaved(apply(s, { op: 'set', path: ['spec', 'activeDeadlineSeconds'], value: 7200 }, opts).session)
  assert(!isDirty(saved) && !hasChanges(saved))
  assert(isDirty(undo(saved, opts)))
})

Deno.test('undo keeps at most MAX_UNDO snapshots', () => {
  let s = open(RELEASE, opts)
  for (let i = 0; i < MAX_UNDO + 5; i++) s = apply(s, { op: 'set', path: ['spec', 'activeDeadlineSeconds'], value: 1000 + i }, opts).session
  assertEquals(s.undo.length, MAX_UNDO)
  assertEquals(MAX_UNDO, 100)
})
