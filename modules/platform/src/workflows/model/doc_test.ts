import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@^1.0.0'
import { commentsOf, createValue, deleteNode, detectStyle, DocEditError, edit, getIn, hasIn, insertNode, mapStrings, needsQuoting, parse, pathAt, print, rangeOf, reprint, sameContent, setNode, splitStream, toJS } from './doc.ts'

/** §6.5: the parsed Document is the state. What is not edited is not rewritten; what is edited keeps its neighbours. */

const SRC = `# a workflow somebody wrote by hand
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: demo   # the name
  labels: {team: payments}
spec:
  entrypoint: main
  futureField:
    nested: [1, 2, 3]   # a field the designer has never heard of
  templates:
  - name: main
    dag:
      tasks:
      - name: a
        template: echo
      # b waits for a
      - name: b
        depends: "a"
        template: echo
  - name: echo
    container:
      image: "docker.io/library/busybox:1.37"
      args:
      - |
        echo one
        echo two
`

Deno.test('a document nobody edited prints as the bytes it was parsed from', () => {
  const d = parse(SRC)
  assertEquals(d.errors, [])
  assertEquals(print(d), SRC)
  // Odd formatting included: print never goes through the YAML printer.
  const odd = 'kind:   Workflow\nmetadata:    {name:   x}\n\n\n'
  assertEquals(print(parse(odd)), odd)
})

Deno.test('reprint keeps the content and every comment', () => {
  const d = parse(SRC)
  const again = parse(reprint(d))
  assertEquals(again.errors, [])
  assertEquals(toJS(again), toJS(d))
  assertEquals(commentsOf(again), commentsOf(d))
  assertEquals(commentsOf(d), ['a workflow somebody wrote by hand', 'the name', 'a field the designer has never heard of', 'b waits for a'])
})

Deno.test('the source style is detected and survives an edit', () => {
  assertEquals(detectStyle(SRC), { indentSeq: false, flowPadding: false })
  assertEquals(detectStyle('a:\n  - 1\nb: { c: 1 }\n'), { indentSeq: true, flowPadding: true })
  // Flow lists count, and brackets inside a script do not.
  assertEquals(parse('run: |\n  if [ -f x ]; then { echo; }; fi\nargs: [sh, -c]\n').style.flowPadding, false)
  assertEquals(parse('a: 1\n').style, { indentSeq: true, flowPadding: true })
  const next = edit(parse(SRC), (doc) => setNode(doc, ['spec', 'entrypoint'], 'other'))
  // kubectl-style list indentation and tight flow maps are still what the file uses.
  assert(next.source.includes('  templates:\n  - name: main'), next.source)
  assert(next.source.includes('labels: {team: payments}'), next.source)
})

Deno.test('an edit changes one thing and leaves comments, unknown fields and key order alone', () => {
  const d = parse(SRC)
  const next = edit(d, (doc) => setNode(doc, ['spec', 'templates', 1, 'container', 'image'], 'ghcr.io/acme/tool:2'))
  assertEquals(d.source, SRC, 'the input snapshot is immutable')
  assertEquals(getIn(next, ['spec', 'templates', 1, 'container', 'image']), 'ghcr.io/acme/tool:2')
  assertEquals(getIn(next, ['spec', 'futureField']), { nested: [1, 2, 3] })
  assertEquals(commentsOf(next), commentsOf(d))
  assertEquals(Object.keys(toJS(next) as object), Object.keys(toJS(d) as object))
  // The scalar kept its quoting.
  assert(next.source.includes('image: "ghcr.io/acme/tool:2"'), next.source)
  // The line-by-line diff is exactly the one line (the gap before a trailing comment is not content).
  const lines = (t: string) => t.split('\n').map((l) => l.replace(/\s+#/, ' #'))
  const a = lines(SRC)
  const b = lines(next.source)
  assertEquals(a.length, b.length)
  assertEquals(a.filter((l, i) => l !== b[i]).length, 1)
})

Deno.test('a comment beside a key that holds a map is kept, on its own line', () => {
  // yaml attaches it to the map; the first edit moves it under the key, later edits leave it there.
  const d = parse('spec:   # the spec\n  a: 1\n  b: 2\n')
  const once = edit(d, (doc) => setNode(doc, ['spec', 'a'], 2))
  assertEquals(commentsOf(once), ['the spec'])
  assertEquals(once.source, 'spec:\n  # the spec\n  a: 2\n  b: 2\n')
  assertEquals(edit(once, (doc) => setNode(doc, ['spec', 'a'], 1)).source, 'spec:\n  # the spec\n  a: 1\n  b: 2\n')
})

Deno.test('a document that does not parse is reported, printed untouched, and refuses edits', () => {
  const bad = 'kind: Workflow\nspec:\n  a: [1, 2\n  b: 3\n'
  const d = parse(bad)
  assert(d.errors.length > 0)
  assert(d.errors[0].range && d.errors[0].range.startLine >= 3)
  assertEquals(print(d), bad)
  assertEquals(toJS(d), null)
  assertThrows(() => edit(d, () => {}), DocEditError)
})

Deno.test('a duplicate key is an error, as it is for the API server', () => {
  const d = parse('a: 1\na: 2\n')
  assertEquals(d.errors.map((e) => e.code), ['DUPLICATE_KEY'])
})

Deno.test('a stream is split into its documents without losing a byte', () => {
  const stream = '# header\n---\na: 1\n---\n# second\nb: "---"\ntext: |\n  ---\n  indented marker is content\n--- \nc: 3\n'
  const parts = splitStream(stream)
  assertEquals(parts.join(''), stream)
  assertEquals(parts.length, 3)
  assertEquals(parts.map((p) => toJS(parse(p))), [{ a: 1 }, { b: '---', text: '---\nindented marker is content\n' }, { c: 3 }])
  assertEquals(splitStream('a: 1\n'), ['a: 1\n'])
  assertEquals(parse('a: 1\n---\nb: 2\n').errors.map((e) => e.code), ['MULTIPLE_DOCS'])
})

Deno.test('ranges and paths map between the text and the document', () => {
  const d = parse(SRC)
  const r = rangeOf(d, ['spec', 'templates', 0, 'dag', 'tasks', 1, 'depends'])!
  assertEquals(SRC.slice(r.start, r.end), '"a"')
  assertEquals(SRC.split('\n')[r.startLine - 1].trim(), 'depends: "a"')
  const k = rangeOf(d, ['spec', 'entrypoint'], 'key')!
  assertEquals(SRC.slice(k.start, k.end), 'entrypoint')
  assertEquals(rangeOf(d, ['spec', 'nope']), undefined)
  assertEquals(pathAt(d, r.start + 1), ['spec', 'templates', 0, 'dag', 'tasks', 1, 'depends'])
  assertEquals(pathAt(d, SRC.indexOf('demo')), ['metadata', 'name'])
  assert(hasIn(d, ['metadata', 'labels', 'team']))
  assert(!hasIn(d, ['metadata', 'labels', 'nope']))
})

Deno.test('strings YAML 1.1 would misread are written quoted', () => {
  for (const s of ['yes', 'no', 'on', 'off', 'y', 'N', '~', '1:30', '1_000', '0777', '0b11', '.inf', '<<', '=']) assert(needsQuoting(s), s)
  for (const s of ['true', 'hello', '1.5', 'v1', 'onward', '']) assert(!needsQuoting(s), s)
  const next = edit(parse('metadata:\n  labels:\n    a: b\n'), (doc) => {
    setNode(doc, ['metadata', 'labels', 'enabled'], 'yes')
    setNode(doc, ['metadata', 'labels', 'a'], 'on')
    setNode(doc, ['spec'], createValue(doc, { on: 'push' }))
  })
  assert(next.source.includes('enabled: "yes"'), next.source)
  assert(next.source.includes('a: "on"'), next.source)
  assert(next.source.includes('"on": push'), next.source)
  assertEquals(toJS(next), { metadata: { labels: { a: 'on', enabled: 'yes' } }, spec: { on: 'push' } })
})

Deno.test('setNode creates missing parents and refuses to walk through a scalar', () => {
  const d = parse('kind: Workflow\nmetadata:\n  name: x\n')
  const next = edit(d, (doc) => setNode(doc, ['metadata', 'annotations', 'k'], 'v'))
  assertEquals(getIn(next, ['metadata']), { name: 'x', annotations: { k: 'v' } })
  assertThrows(() => edit(d, (doc) => setNode(doc, ['kind', 'deeper'], 1)), DocEditError)
  // A quoted string that becomes a number does not stay a string.
  const n = edit(parse('a: "3"\n'), (doc) => setNode(doc, ['a'], 3))
  assertEquals(toJS(n), { a: 3 })
})

Deno.test('insertNode appends, inserts at an index and creates the list', () => {
  const d = parse('list:\n  - a\n  - c\n')
  const next = edit(d, (doc) => {
    assertEquals(insertNode(doc, ['list'], 'b', 1), 1)
    assertEquals(insertNode(doc, ['list'], 'd'), 3)
    assertEquals(insertNode(doc, ['fresh', 'items'], { name: 'x' }), 0)
  })
  assertEquals(toJS(next), { list: ['a', 'b', 'c', 'd'], fresh: { items: [{ name: 'x' }] } })
  assertThrows(() => edit(parse('a: 1\n'), (doc) => void insertNode(doc, ['a'], 1)), DocEditError)
  assertEquals(toJS(edit(next, (doc) => void deleteNode(doc, ['list', 0]))), { list: ['b', 'c', 'd'], fresh: { items: [{ name: 'x' }] } })
  assertEquals(edit(next, (doc) => assertEquals(deleteNode(doc, ['nope']), false)).source, next.source)
})

Deno.test('mapStrings rewrites string scalars in place and counts them', () => {
  const d = parse('a: "x1"   # keep\nb: [x1, 2, {c: x1}]\nn: 1\n')
  let changed = 0
  const next = edit(d, (doc) => void (changed = mapStrings(doc, [], (v) => v.replace('x1', 'y2'))))
  assertEquals(changed, 3)
  assertEquals(toJS(next), { a: 'y2', b: ['y2', 2, { c: 'y2' }], n: 1 })
  assert(next.source.includes('a: "y2" # keep') || next.source.includes('a: "y2"   # keep'), next.source)
})

Deno.test('sameContent ignores formatting and nothing else', () => {
  assert(sameContent(parse('a: {b: 1}\n'), parse('# c\na:\n  b: 1\n')))
  assert(!sameContent(parse('a: {b: 1}\n'), parse('a: {b: 2}\n')))
  assert(!sameContent(parse('a: [1\n'), parse('a: [1,\n')))
})

Deno.test('anchors and merge keys read as Kubernetes reads them', () => {
  const d = parse('base: &b {cpu: 100m}\nuse:\n  <<: *b\n  memory: 1Gi\n')
  assertEquals(d.errors, [])
  assertEquals(getIn(d, ['use']), { cpu: '100m', memory: '1Gi' })
})
