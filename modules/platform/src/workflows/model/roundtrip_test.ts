import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { walk } from 'jsr:@std/fs@^1.0.0/walk'
import type { WfDoc } from './doc.ts'
import { commentsOf, edit, parse, print, reprint, splitStream, toJS } from './doc.ts'
import type { Op } from './ops.ts'
import { applyOp, applyOps, POSITIONS_ANNOTATION } from './ops.ts'
import { decodePositions } from './positions.ts'
import type { DesignerGraph } from './project.ts'
import { allNodes, project } from './project.ts'
import { RESOURCE_KINDS } from './shape.ts'
import { dependenciesOf, findCycle } from './validate.ts'
import { adharCheckout, PLATFORM_SOURCES, renderStackTemplate, unrenderedAction } from './corpus/render.ts'
import { platformCatalogue } from './testdata.ts'

/**
 * The corpus round trip (design 0026 §6.5, W2 acceptance 1).
 *
 * The corpus is real YAML the designer will be asked to open: every example
 * Argo ships at the pinned tag (`corpus/upstream`, v4.1.6), every workflow
 * template in the platform stack (`corpus/platform`) and hand-written files
 * with the things people do to YAML (`corpus/handwritten`: comments
 * everywhere, anchors, flow style, kubectl indentation).
 *
 * For every document in it:
 *   - opening and saving with no edit writes the bytes that were read;
 *   - an edit that changes nothing prints JSON-equal content with every
 *     comment kept;
 *   - the projection is deterministic;
 *   - rename, connect and disconnect followed by their inverses restore the
 *     content and the comments.
 */

const CORPUS = new URL('./corpus/', import.meta.url)
const CONSOLE_ROOT = new URL('../../../../../', import.meta.url).pathname.replace(/\/$/, '')
const opts = { catalogue: platformCatalogue() }

/**
 * Upstream examples the `yaml` library refuses and kubectl accepts. Eight
 * continue a quoted scalar on a line indented no deeper than its key; one
 * repeats a key. The designer opens them with the canvas frozen ("YAML has
 * errors") and saves them untouched — it never auto-fixes. Pinned so that a
 * library upgrade that changes the list is noticed either way.
 */
const UNPARSEABLE: Readonly<Record<string, string>> = {
  'upstream/ci-output-artifact.yaml': 'MISSING_CHAR',
  'upstream/ci.yaml': 'MISSING_CHAR',
  'upstream/influxdb-ci.yaml': 'MISSING_CHAR',
  'upstream/k8s-orchestration.yaml': 'MISSING_CHAR',
  'upstream/k8s-patch-json-workflow.yaml': 'DUPLICATE_KEY',
  'upstream/nested-workflow.yaml': 'MISSING_CHAR',
  'upstream/secrets.yaml': 'MISSING_CHAR',
  'upstream/sidecar.yaml': 'MISSING_CHAR',
  'upstream/volumes-emptydir.yaml': 'MISSING_CHAR',
}

interface CorpusDoc {
  file: string
  index: number
  text: string
}

async function corpus(): Promise<{ files: Map<string, string>; docs: CorpusDoc[] }> {
  const files = new Map<string, string>()
  for await (const e of walk(CORPUS, { exts: ['.yaml'] })) files.set(e.path.slice(CORPUS.pathname.length), await Deno.readTextFile(e.path))
  const sorted = new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)))
  const docs: CorpusDoc[] = []
  for (const [file, text] of sorted) splitStream(text).forEach((part, index) => docs.push({ file, index, text: part }))
  return { files: sorted, docs }
}

const { files: FILES, docs: DOCS } = await corpus()
const where = (d: CorpusDoc) => `${d.file}#${d.index}`

/** Every `# comment` line of the source, as text: the check that does not trust the parser's own view of comments. */
function commentLines(text: string): string[] {
  const d = parse(text)
  // Only real comments: a `#` inside a scalar is content. The parser tells us which are which…
  const known = new Set(commentsOf(d))
  // …and the text tells us none went missing from the parser's list.
  return text.split('\n').map((l) => /^\s*#\s?(.*)$/.exec(l)?.[1]?.trim()).filter((c): c is string => Boolean(c) && known.has(c!))
}

/**
 * Content as a value, with the positions annotation decoded (the designer
 * writes it with sorted keys). Compared with `assertEquals`, which does not
 * care where in a task `depends` is written: an inverse puts it back under
 * `name`, which is the same task.
 */
function content(d: WfDoc): unknown {
  const v = structuredClone(toJS(d)) as { metadata?: { annotations?: Record<string, unknown> } } | null
  const ann = v?.metadata?.annotations
  if (ann && POSITIONS_ANNOTATION in ann) ann[POSITIONS_ANNOTATION] = decodePositions(ann[POSITIONS_ANNOTATION])
  return v
}

const sorted = (xs: string[]) => [...xs].sort()

Deno.test('the corpus is what the design says it is', () => {
  const count = (prefix: string) => [...FILES.keys()].filter((f) => f.startsWith(prefix)).length
  // Every example upstream ships at v4.1.6 (regenerate with the tag when Argo is bumped).
  assertEquals(count('upstream/'), 217)
  assertEquals(count('platform/'), PLATFORM_SOURCES.length)
  assert(count('handwritten/') >= 7)
  const license = Deno.readTextFileSync(new URL('upstream/LICENSE', CORPUS))
  assert(license.includes('Apache License'), 'the upstream examples keep their licence beside them')
  // The shapes §6.5 names are all present among documents that open.
  const graphs = DOCS.map((d) => parse(d.text)).filter((d) => !d.errors.length).map((d) => project(d, opts))
  const some = (what: string, p: (g: DesignerGraph) => boolean) => assert(graphs.some(p), `no corpus document has ${what}`)
  some('a DAG entrypoint', (g) => g.editable)
  some('a steps entrypoint', (g) => g.readOnly === 'steps')
  some('an exit handler', (g) => g.exitLane !== undefined)
  some('a hook', (g) => allNodes(g, true).some((n) => n.badges.hooks))
  some('a fan-out', (g) => allNodes(g, true).some((n) => n.badges.fanOut))
  some('a sub-flow', (g) => allNodes(g).some((n) => n.group))
  some('a depends expression', (g) => g.edges.some((e) => e.condition === 'Expression'))
  some('legacy dependencies', (g) => g.edges.some((e) => e.legacy))
  some('a templateRef', (g) => allNodes(g, true).some((n) => n.template.ref))
  some('a platform step', (g) => allNodes(g, true).some((n) => n.kind === 'approval'))
  for (const kind of RESOURCE_KINDS) some(`kind ${kind}`, (g) => g.resource.kind === kind)
  assert(DOCS.length > 240, `${DOCS.length} documents`)
})

Deno.test('a stream splits into its documents without losing a byte', () => {
  for (const [file, text] of FILES) assertEquals(splitStream(text).join(''), text, file)
})

Deno.test('acceptance 1: every corpus document opens, and saving it untouched writes the bytes that were read', () => {
  const failed: Record<string, string> = {}
  for (const d of DOCS) {
    const doc = parse(d.text)
    assertEquals(print(doc), d.text, where(d))
    if (doc.errors.length) {
      failed[d.file] = doc.errors[0].code
      // Opens frozen, with a diagnostic that says where, and refuses edits rather than guessing.
      const g = project(doc, opts)
      assertEquals(g.readOnly, 'yaml-errors', where(d))
      assert(g.diagnostics.length > 0 && g.diagnostics.every((x) => x.code === 'yaml/syntax' && x.range), where(d))
    }
  }
  assertEquals(failed, UNPARSEABLE)
})

Deno.test('acceptance 1: an edit that changes nothing is JSON-equal and keeps every comment', () => {
  let checked = 0
  let comments = 0
  for (const d of DOCS) {
    const doc = parse(d.text)
    if (doc.errors.length) continue
    for (const [how, text] of [['reprint', reprint(doc)], ['no-op edit', edit(doc, () => {}).source]] as const) {
      const again = parse(text)
      assertEquals(again.errors, [], `${where(d)}: ${how} does not parse`)
      assertEquals(JSON.stringify(toJS(again)), JSON.stringify(toJS(doc)), `${where(d)}: ${how} changed the content`)
      // The same comments (which node the parser hangs one on may differ, so as a multiset)…
      assertEquals(sorted(commentsOf(again)), sorted(commentsOf(doc)), `${where(d)}: ${how} lost a comment`)
      // …and, read off the text, the source's comment lines appear in the output in the same order.
      const out = text.split('\n').map((l) => /#\s?(.*)$/.exec(l)?.[1]?.trim()).filter((c): c is string => Boolean(c))
      let at = 0
      for (const c of commentLines(d.text)) {
        const i = out.indexOf(c, at)
        assert(i >= 0, `${where(d)}: ${how} dropped or reordered the comment "${c}"`)
        at = i + 1
      }
      // And printing is stable: a second pass changes nothing more.
      assertEquals(reprint(again), text, `${where(d)}: ${how} is not a fixed point`)
    }
    checked++
    comments += commentsOf(doc).length
  }
  assertEquals(checked, DOCS.length - Object.keys(UNPARSEABLE).length)
  assert(comments > 1000, `only ${comments} comments in the corpus: the check is not exercising much`)
})

Deno.test('the projection is deterministic over the corpus', () => {
  for (const d of DOCS) {
    const a = JSON.stringify(project(parse(d.text), opts))
    assertEquals(JSON.stringify(project(parse(d.text), opts)), a, where(d))
    // No canvas id is used twice (ReactFlow keys nodes and edges by them).
    const g = project(parse(d.text), opts)
    const uids = allNodes(g, false).map((n) => n.uid)
    if (!g.diagnostics.some((x) => x.code === 'graph/duplicate-name')) assertEquals(new Set(uids).size, uids.length, where(d))
  }
})

/** Comments that went with a line an edit REMOVED (a dependency that had one beside it): the only comments an edit may take. */
const removedWithTheirLine: string[] = []

/** Apply `op` then its inverse and hold the result to the original. Returns whether the op applied. */
function thereAndBack(d: CorpusDoc, doc: WfDoc, op: Op): boolean {
  const label = `${where(d)}: ${JSON.stringify(op)}`
  const r = applyOp(doc, op, opts)
  assert(r.inverse, `${label} has no inverse`)
  if (!r.inverse.length) return false
  assert(r.doc.source !== doc.source, `${label} changed nothing`)
  const back = applyOps(r.doc, r.inverse, opts).doc
  assertEquals(content(back), content(doc), `${label}: the inverse did not restore the content`)
  if (op.op === 'disconnect') {
    // Removing a list item removes the comment written on it; nothing else may go, and nothing may appear.
    const before = sorted(commentsOf(doc))
    const after = sorted(commentsOf(r.doc))
    const lost = before.filter((c, i) => before.indexOf(c) === i && !after.includes(c))
    assert(after.every((c) => before.includes(c)) && before.length - after.length === lost.length, `${label}: comments changed`)
    removedWithTheirLine.push(...lost.map((c) => `${where(d)}: ${c}`))
    assertEquals(sorted(commentsOf(back)), after, `${label}: the inverse lost a comment`)
    return true
  }
  assertEquals(sorted(commentsOf(back)), sorted(commentsOf(doc)), `${label}: a comment was lost`)
  assertEquals(sorted(commentsOf(r.doc)), sorted(commentsOf(doc)), `${label}: the edit itself lost a comment`)
  return true
}

function editableDags(doc: WfDoc): Array<{ nodes: ReturnType<typeof allNodes>; g: DesignerGraph }> {
  const g = project(doc, opts)
  const out = []
  if (g.editable) out.push({ nodes: g.nodes, g })
  if (g.exitLane?.editable) out.push({ nodes: g.exitLane.nodes, g })
  return out
}

Deno.test('rename and its inverse restore every editable corpus document', () => {
  let renames = 0
  for (const d of DOCS) {
    const doc = parse(d.text)
    if (doc.errors.length) continue
    for (const { nodes } of editableDags(doc)) {
      const taken = new Set(nodes.map((n) => n.id))
      for (const n of nodes) {
        const to = `${n.id}-renamed`
        if (taken.has(to) || !/^[A-Za-z0-9][-A-Za-z0-9]*$/.test(n.id)) continue
        if (thereAndBack(d, doc, { op: 'rename', node: n.uid, to })) renames++
      }
    }
  }
  assert(renames >= 130, `only ${renames} renames ran`)
})

Deno.test('connect, disconnect and their inverses restore every editable corpus document', () => {
  let connects = 0
  let disconnects = 0
  for (const d of DOCS) {
    const doc = parse(d.text)
    if (doc.errors.length) continue
    for (const { nodes, g } of editableDags(doc)) {
      const js = toJS(doc) as Record<string, unknown>
      const taskBody = (path: readonly (string | number)[]) => path.reduce<unknown>((v, k) => (v as Record<string | number, unknown>)?.[k], js) as Record<string, unknown>
      const edges = nodes.flatMap((n) => dependenciesOf(taskBody(n.path)).map((s) => ({ source: s, target: n.id })))
      const names = nodes.map((n) => n.id)
      const uid = new Map(nodes.map((n) => [n.id, n.uid]))
      // Every existing dependency: take it away and put it back.
      for (const e of edges) {
        if (!uid.has(e.source)) continue
        if (thereAndBack(d, doc, { op: 'disconnect', source: uid.get(e.source)!, target: uid.get(e.target)! })) disconnects++
      }
      // Every pair not yet connected that would not close a circle: connect (alternating results) and take it back.
      let k = 0
      for (const a of nodes) {
        for (const b of nodes) {
          if (a === b || edges.some((e) => e.source === a.id && e.target === b.id)) continue
          if (findCycle(names, [...edges, { source: a.id, target: b.id }])) continue
          if (g.diagnostics.some((x) => x.code === 'depends/syntax' && x.task?.uid === b.uid)) continue
          const condition = (['Succeeded', 'Failed', 'Skipped'] as const)[k++ % 3]
          const body = taskBody(b.path)
          // A legacy list has no exact inverse for a non-success edge (it migrates to depends); covered in ops_test.
          if (body.dependencies !== undefined && body.depends === undefined && condition !== 'Succeeded') continue
          if (thereAndBack(d, doc, { op: 'connect', source: a.uid, target: b.uid, condition })) connects++
        }
      }
    }
  }
  assert(connects >= 140 && disconnects >= 110, `${connects} connects, ${disconnects} disconnects`)
  // Exactly one comment in the whole corpus sits on a dependency line, and it goes only when that line does.
  assertEquals(removedWithTheirLine, ['handwritten/legacy-dependencies.yaml#0: the left side'])
})

Deno.test('the vendored platform templates are the ones the stack ships', async () => {
  for (const s of PLATFORM_SOURCES) {
    const text = FILES.get(s.corpus)
    assert(text, `${s.corpus} is missing from the corpus`)
    assertEquals(unrenderedAction(text), undefined, `${s.corpus} still holds a Go template action`)
  }
  const found = await adharCheckout(CONSOLE_ROOT)
  if (!found) return // no platform checkout beside the console: the vendored copies are all there is to check
  const adhar = await Deno.realPath(found)
  for (const s of PLATFORM_SOURCES) {
    const source = await Deno.readTextFile(`${adhar}/${s.source}`)
    const rendered = s.template ? renderStackTemplate(source) : source
    assertEquals(unrenderedAction(rendered), undefined, `${s.source} uses a template action corpus/render.ts does not handle`)
    assertEquals(FILES.get(s.corpus), rendered, `${s.corpus} no longer matches ${s.source}; copy it again (rendered through corpus/render.ts)`)
  }
  // Every workflow template the stack ships is in the corpus.
  const shipped: string[] = []
  for await (const e of walk(`${adhar}/platform/stack/packages`, { match: [/\.ya?ml(\.tmpl)?$/], skip: [/\/policy-tests\//, /\/crds[^/]*\.yaml$/, /\/node_modules\//] })) {
    const text = await Deno.readTextFile(e.path)
    if (/^apiVersion: argoproj\.io\/v1alpha1\s*\nkind: (?:Cluster)?WorkflowTemplate\s*$/m.test(text)) shipped.push(e.path.slice(adhar.length + 1))
  }
  assertEquals(sorted(shipped), sorted(PLATFORM_SOURCES.map((s) => s.source)))
})
