import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@^1.0.0'
import { commentsOf, createValue, deleteNode, detectStyle, DocEditError, edit, expandMerges, getIn, hasIn, insertNode, mapStrings, needsQuoting, nodeAt, own, parse, pathAt, print, rangeOf, reprint, sameContent, setNode, splitStream, toJS } from './doc.ts'
import { corpusText } from './testdata.ts'

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
  assertEquals(detectStyle(SRC), { indentSeq: false, flowPadding: false, eol: '\n' })
  assertEquals(detectStyle('a:\n  - 1\nb: { c: 1 }\n'), { indentSeq: true, flowPadding: true, eol: '\n' })
  // Flow lists count, and brackets inside a script do not.
  assertEquals(parse('run: |\n  if [ -f x ]; then { echo; }; fi\nargs: [sh, -c]\n').style.flowPadding, false)
  assertEquals(parse('a: 1\n').style, { indentSeq: true, flowPadding: true, eol: '\n' })
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

/* ───────────── what Kubernetes reads is not what this library reads ───────────── */

/** Each line: a number as people write it in a manifest. YAML 1.1 (the API server) and 1.2 (this library) disagree about several. */
const NUMBERS = `mode: 0644
other: 0755
lead: 007
hex: 0x1F
exp: 1e3
exp2: 1.5E+3
frac: .5
plus: +1
float: 1.0
nan: .NaN
big: 123456789012345678901234567890
long: 12345678901234567890
tagged: !!int 0644
touch: 1
`

Deno.test('a number is written back as it was written: `mode: 0644` stays octal through an unrelated edit', () => {
  const d = parse(NUMBERS)
  assertEquals(d.errors, [])
  const next = edit(d, (doc) => setNode(doc, ['touch'], 2))
  // Every line but the edited one is byte for byte what it was.
  assertEquals(next.source, NUMBERS.replace('touch: 1', 'touch: 2'))
  assertEquals(reprint(d), NUMBERS)
})

Deno.test('a number that an edit changed is printed as the new number, never in the old spelling', () => {
  const d = parse('mode: 0644\nport: "0080"\nratio: 1.50\nmask: 0x1F\n')
  const next = edit(d, (doc) => {
    setNode(doc, ['mode'], 420)
    setNode(doc, ['mask'], 20)
    // A quoted string that becomes the number its digits spell must not come back as an (octal-looking) `0080`.
    setNode(doc, ['port'], 80)
    setNode(doc, ['ratio'], 2)
  })
  assertEquals(next.source, 'mode: 420\nport: 80\nratio: 2\nmask: 20\n')
  // Setting the value a number already has keeps its spelling.
  assertEquals(edit(d, (doc) => setNode(doc, ['mode'], 644)).source, d.source)
})

Deno.test('sameContent compares what the cluster would read: 644 is not 0644, yes is not "yes"', () => {
  assert(!sameContent(parse('mode: 644\n'), parse('mode: 0644\n')))
  assert(!sameContent(parse('on: yes\n'), parse('on: "yes"\n')))
  assert(!sameContent(parse('v: 1.0\n'), parse('v: 1\n')))
  assert(!sameContent(parse('k: {0644: a}\n'), parse('k: {644: a}\n')))
  // …and formatting is still only formatting.
  assert(sameContent(parse('mode: 0644   # rw-r--r--\nflag: yes\n'), parse('{mode: 0644, flag: yes}\n')))
  assert(sameContent(parse('a: "x"\nb: 1\n'), parse("b: 1\na: 'x'\n")) === false, 'key order is content to JSON.stringify, as before')
  assert(sameContent(parse('a: &x {b: 1}\nc: *x\n'), parse('a: {b: 1}\nc: {b: 1}\n')))
})

Deno.test('a Windows file stays a Windows file after an edit', () => {
  const lf = 'a: |\n  one\n  two\nlist:\n- x # note\n- y\nc: 1\n'
  const crlf = lf.replace(/\n/g, '\r\n')
  const d = parse(crlf)
  assertEquals(d.errors, [])
  assertEquals(d.style.eol, '\r\n')
  assertEquals(toJS(d), toJS(parse(lf)))
  const next = edit(d, (doc) => setNode(doc, ['c'], 2))
  assertEquals(next.source, crlf.replace('c: 1', 'c: 2'))
  assert(!/(^|[^\r])\n/.test(next.source), 'a bare \\n appeared')
  // A file with mixed endings is written as yaml writes it.
  assertEquals(parse('a: 1\r\nb: 2\n').style.eol, '\n')
  assertEquals(parse(lf).style.eol, '\n')
})

Deno.test('a date, a time and a word YAML 1.1 misreads are quoted wherever an edit puts them', () => {
  for (const s of ['2026-12-05', '2026-12-05T10:00:00Z', '2026-12-05 10:00:00 +01:00', '2026-1-5t10:00:00.5-05']) assert(needsQuoting(s), s)
  for (const s of ['2026-12', 'v2026-12-05', '2026-12-05T10:00', '12:00:00 2026-12-05']) assert(needsQuoting(s) === /^[0-9]+(:[0-5]?[0-9])+$/.test(s), s)
  const d = parse('a: build\nb: [build, test]\nc: |\n  build\n')
  let n = 0
  const next = edit(d, (doc) => void (n = mapStrings(doc, [], (v) => v.replace(/^build$/, 'no'))))
  assertEquals(n, 2)
  assertEquals(next.source, 'a: "no"\nb: ["no", test]\nc: |\n  build\n')
  assertEquals(toJS(next), { a: 'no', b: ['no', 'test'], c: 'build\n' })
})

/* ───────────── anchors, aliases and merge keys ───────────── */

const ANCHORED = `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: anch
  labels: &lbl
    team: a
  annotations: *lbl
spec:
  entrypoint: main
  templates:
  - name: main
    dag:
      tasks:
      - &first
        name: a # first
        template: echo
        arguments: &args
          parameters:
          - {name: msg, value: &v hi}
      - name: b
        depends: a
        template: echo
        arguments: *args
      # c is a, renamed
      - <<: *first
        name: c
        depends: "a && b"
      - name: d
        template: echo
        depends: c
        arguments: {parameters: [{name: msg, value: *v}]}
  - name: echo
    inputs: {parameters: [{name: msg}]}
    container: &ctr
      image: docker.io/library/busybox:1.37
      resources: {requests: {cpu: 10m, memory: 16Mi}}
  - name: echo2
    container: *ctr
`

/** Merge keys the hard way: a list of sources (earlier wins), a source that merges another, an alias to a list, an anchor defined twice. */
const MERGE_LISTS = `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata: {name: merges}
x-a: &a {cpu: 100m, memory: 1Gi, zone: [x, y]}
x-b: &b {cpu: 200m, disk: 5Gi}
x-c: &c
  <<: *a
  memory: 2Gi
x-both: &both [*a, *b]
spec:
  entrypoint: main
  one:
    <<: [*b, *a]
    own: 1
  two:
    own: 2
    <<: *c
  three:
    <<: *both
  again: &a {cpu: 1}
  late: *a
  list: [*a, *b, &inner {k: v}, *inner]
  templates: []
`

type Json = null | string | number | boolean | Json[] | { [k: string]: Json }
/** Plain data with no shared objects (`toJS` hands back ONE object for an anchor and its aliases) and keys in a fixed order. */
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x)))
const leaves = (v: Json, at: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] => {
  if (v && typeof v === 'object') {
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v)
    if (!keys.length) out.push(at)
    for (const k of keys) leaves((v as Record<string | number, Json>)[k], [...at, k], out)
  } else out.push(at)
  return out
}
const holder = (v: Json, path: (string | number)[]) => path.slice(0, -1).reduce<Json>((cur, k) => (cur as Record<string | number, Json>)[k], v) as Record<string | number, Json>

Deno.test('an edit changes the path it names and no other, through anchors, aliases and merge keys', () => {
  for (const [name, src] of [['inline', ANCHORED], ['merge lists', MERGE_LISTS], ['corpus', corpusText('handwritten/anchors-and-flow.yaml')]] as const) {
    const d = parse(src)
    assertEquals(d.errors, [], name)
    const before = plain(toJS(d))
    const paths = leaves(before)
    assert(paths.length > 25, name)
    for (const path of paths) {
      const where = `${name}: ${path.join('.')}`
      // set
      const want = plain(before)
      holder(want, path)[path[path.length - 1]] = 'SENTINEL'
      assertEquals(plain(toJS(edit(d, (doc) => setNode(doc, path, 'SENTINEL')))), want, `set ${where}`)
      // delete
      const gone = plain(before)
      const h = holder(gone, path)
      if (Array.isArray(h)) h.splice(path[path.length - 1] as number, 1)
      else delete h[path[path.length - 1]]
      assertEquals(plain(toJS(edit(d, (doc) => assert(deleteNode(doc, path), `nothing at ${where}`)))), gone, `delete ${where}`)
    }
    // insert into every list
    const lists = new Set(paths.flatMap((p) => p.flatMap((k, i) => (typeof k === 'number' ? [JSON.stringify(p.slice(0, i))] : []))))
    assert(lists.size > 3, name)
    for (const raw of lists) {
      const path = JSON.parse(raw) as (string | number)[]
      const want = plain(before)
      ;(path.reduce<Json>((cur, k) => (cur as Record<string | number, Json>)[k], want) as Json[]).push('SENTINEL')
      assertEquals(plain(toJS(edit(d, (doc) => void insertNode(doc, path, 'SENTINEL')))), want, `insert ${name}: ${path.join('.')}`)
    }
  }
})

Deno.test('what an edit does not touch keeps its anchors; what it touches gets its own copy', () => {
  const d = parse(ANCHORED)
  // Writing through an ALIAS (b.arguments is *args): b gets its own arguments, a keeps the anchor, d still reads *v.
  const viaAlias = edit(d, (doc) => setNode(doc, ['spec', 'templates', 0, 'dag', 'tasks', 1, 'arguments', 'parameters', 0, 'value'], 'yo'))
  assert(viaAlias.source.includes('arguments: &args'), viaAlias.source)
  assert(viaAlias.source.includes('- {name: msg, value: yo}'), viaAlias.source)
  assert(viaAlias.source.includes('value: *v'), viaAlias.source)
  assert(viaAlias.source.includes('<<: *first'), viaAlias.source)
  // Writing under an ANCHOR (labels is &lbl, annotations its alias): annotations keep what they had.
  const underAnchor = edit(d, (doc) => setNode(doc, ['metadata', 'labels', 'adhar.io/workflow-draft'], 'true'))
  assertEquals(getIn(underAnchor, ['metadata']), { name: 'anch', labels: { team: 'a', 'adhar.io/workflow-draft': 'true' }, annotations: { team: 'a' } })
  assert(!underAnchor.source.includes('lbl'), underAnchor.source)
  assert(underAnchor.source.includes('<<: *first') && underAnchor.source.includes('container: *ctr'), 'unrelated anchors were given up')
  // A key inherited through `<<` is written out before it is changed; the comment above the merge stays.
  const inherited = edit(d, (doc) => setNode(doc, ['spec', 'templates', 0, 'dag', 'tasks', 2, 'template'], 'echo2'))
  assertEquals(getIn(inherited, ['spec', 'templates', 0, 'dag', 'tasks', 2]), { template: 'echo2', arguments: { parameters: [{ name: 'msg', value: 'hi' }] }, name: 'c', depends: 'a && b' })
  assertEquals(getIn(inherited, ['spec', 'templates', 0, 'dag', 'tasks', 0, 'template']), 'echo')
  assertEquals(commentsOf(inherited), commentsOf(d))
  // A comment written above `<<:` stays where the inherited keys are written out.
  const noted = parse('base: &b {cpu: 100m, memory: 1Gi}\nuse:\n  name: x\n  # limits come from the base\n  <<: *b\n  memory: 2Gi\n')
  assertEquals(edit(noted, (doc) => setNode(doc, ['use', 'cpu'], '200m')).source, 'base: &b {cpu: 100m, memory: 1Gi}\nuse:\n  name: x\n  # limits come from the base\n  cpu: 200m\n  memory: 2Gi\n')
  // `own` reports the node, and `expandMerges` whether there was a merge to write out.
  edit(d, (doc) => {
    const c = own(doc, ['spec', 'templates', 0, 'dag', 'tasks', 2], { whole: true })
    assertEquals(nodeAt(doc, ['spec', 'templates', 0, 'dag', 'tasks', 2]), c)
    assertEquals(expandMerges(doc, c as Parameters<typeof expandMerges>[1]), false)
    assertEquals(own(doc, ['spec', 'nope', 'deeper']), undefined)
  })
})

Deno.test('removing an anchored node hands its anchor to the first alias, so the file still parses and still shares', () => {
  const d = parse(ANCHORED)
  // Task a holds &first, &args and &v; c merges *first, b aliases *args, d aliases *v.
  const next = edit(d, (doc) => assert(deleteNode(doc, ['spec', 'templates', 0, 'dag', 'tasks', 0])))
  assertEquals(next.errors, [])
  const want = plain(toJS(d)) as { spec: { templates: Array<{ dag: { tasks: Json[] } }> } }
  want.spec.templates[0].dag.tasks.splice(0, 1)
  assertEquals(plain(toJS(next)), want as unknown as Json)
  // The anchors moved to where the first alias stood; later aliases still point at them.
  assert(next.source.includes('arguments: &args'), next.source)
  assert(next.source.includes('value: *v') || next.source.includes('&v hi'), next.source)
  // Replacing an anchored value wholesale does the same.
  const replaced = edit(d, (doc) => setNode(doc, ['spec', 'templates', 1, 'container'], { image: 'x' }))
  assertEquals(getIn(replaced, ['spec', 'templates', 2, 'container']), { image: 'docker.io/library/busybox:1.37', resources: { requests: { cpu: '10m', memory: '16Mi' } } })
  assertEquals(getIn(replaced, ['spec', 'templates', 1, 'container']), { image: 'x' })
})

Deno.test('whatever goes wrong inside an edit is a DocEditError, and the snapshot is untouched', () => {
  const d = parse('a: &x {b: 1}\nc: *x\n')
  const e = assertThrows(() => edit(d, () => void (undefined as unknown as { boom: () => void }).boom()), DocEditError)
  assert(e.message.startsWith('The edit could not be written:'), e.message)
  // An alias left with no anchor cannot be printed; the library's own error is wrapped.
  assertThrows(() => edit(d, (doc) => void doc.deleteIn(['a'])), DocEditError)
  assertEquals(print(d), 'a: &x {b: 1}\nc: *x\n')
})
