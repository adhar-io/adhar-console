import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@^1.0.0'
import type { WfDoc } from './doc.ts'
import { commentsOf, getIn, parse, sameContent, toJS } from './doc.ts'
import type { Op } from './ops.ts'
import { applyOp, applyOps, DRAFT_EXPIRES_ANNOTATION, DRAFT_LABEL, draftExpiry, HAS_APPROVALS_LABEL, OpError, POSITIONS_ANNOTATION, renameTaskTokens, usesApprovals } from './ops.ts'
import { decodePositions } from './positions.ts'
import { allNodes, findNode, project } from './project.ts'
import { hasErrors, validate } from './validate.ts'
import { corpusText, platformCatalogue } from './testdata.ts'

/** §6.5: every edit is a mutation of the YAML tree. What it does not touch — comments, unknown fields, key order — stays. */

const CATALOGUE = platformCatalogue()
const opts = { catalogue: CATALOGUE }
const RELEASE = parse(corpusText('handwritten/release-check.yaml'))
const run = (d: WfDoc, ...ops: Op[]) => applyOps(d, ops, opts).doc
const js = (d: WfDoc) => toJS(d) as Record<string, any>
const tasks = (d: WfDoc, template = 0) => js(d).spec.templates[template].dag.tasks as Array<Record<string, any>>
const task = (d: WfDoc, name: string, template = 0) => tasks(d, template).find((t) => t.name === name)!
const code = (fn: () => unknown): string => {
  const e = assertThrows(fn, OpError)
  return e.code
}
/**
 * The content of a document with the positions annotation decoded: the
 * designer writes it with sorted keys, so a hand-ordered one is the same
 * positions in another order after any edit that touches it.
 */
const content = (d: WfDoc) => {
  const v = structuredClone(toJS(d)) as Record<string, any>
  const ann = v?.metadata?.annotations
  if (ann && POSITIONS_ANNOTATION in ann) ann[POSITIONS_ANNOTATION] = decodePositions(ann[POSITIONS_ANNOTATION])
  return v
}
/** Apply an op, then its inverse: the content must be what it was (and, unless the op removed a commented line, every comment). */
const undoes = (d: WfDoc, op: Op, comments = true) => {
  const r = applyOp(d, op, opts)
  assert(r.inverse, `${op.op} returned no inverse`)
  const back = applyOps(r.doc, r.inverse, opts).doc
  assertEquals(content(back), content(d), `inverse of ${JSON.stringify(op)}`)
  if (comments) assertEquals(commentsOf(back).sort(), commentsOf(d).sort())
  return r
}

const SMALL = parse(`apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: small
spec:
  entrypoint: main
  activeDeadlineSeconds: 600
  templates:
  - name: main
    dag:
      tasks:
      - name: a
        template: echo
      - name: b
        template: echo   # shares the template with a
  - name: echo
    suspend: {}
`)

/* ───────── add ───────── */

Deno.test('addNode appends a template and a task named from the palette, and writes its position', () => {
  const r = applyOp(SMALL, { op: 'addNode', palette: 'container', at: { x: 300.4, y: 40 } }, opts)
  assertEquals(r.created, { uid: 'run', task: 'run', dag: 'main', template: 'run' })
  assertEquals(tasks(r.doc).map((t) => t.name), ['a', 'b', 'run'])
  assertEquals(task(r.doc, 'run'), { name: 'run', template: 'run' })
  const tmpl = js(r.doc).spec.templates[2]
  assertEquals(tmpl.name, 'run')
  assertEquals(tmpl.container.securityContext.runAsNonRoot, true)
  assert(tmpl.container.resources.requests.cpu)
  assertEquals(decodePositions(getIn(r.doc, ['metadata', 'annotations', POSITIONS_ANNOTATION])), { run: { x: 300, y: 40 } })
  assertEquals(commentsOf(r.doc), commentsOf(SMALL))
  assert(!hasErrors(validate(r.doc)))
  // A second drop gets a fresh name; so does one that would collide with a template.
  const again = applyOp(r.doc, { op: 'addNode', palette: 'container' }, opts)
  assertEquals(again.created?.task, 'run-2')
  assertEquals(applyOp(SMALL, { op: 'addNode', palette: 'timer', name: 'pause' }, opts).created?.task, 'pause')
  undoes(SMALL, { op: 'addNode', palette: 'script', at: { x: 1, y: 2 } })
})

Deno.test('every palette entry that can be dropped produces a graph with no errors', () => {
  for (const id of ['container', 'script', 'resource', 'http', 'approval', 'timer', 'subflow', 'step:adhar-steps/http-check', 'step:adhar-steps/k6-load', 'step:adhar-steps/wait-healthy', 'step:adhar-batch-steps/run']) {
    const r = applyOp(SMALL, { op: 'addNode', palette: id }, opts)
    const g = project(r.doc, opts)
    const n = findNode(g, r.created!.uid)
    assert(n, id)
    assert(!hasErrors(g.diagnostics), `${id}: ${JSON.stringify(g.diagnostics.filter((x) => x.level === 'error'))}`)
  }
  assertEquals(code(() => applyOp(SMALL, { op: 'addNode', palette: 'template' }, opts)), 'invalid')
  assertEquals(code(() => applyOp(SMALL, { op: 'addNode', palette: 'nope' }, opts)), 'not-found')
  assertEquals(code(() => applyOp(SMALL, { op: 'addNode', palette: 'timer', name: 'a' }, opts)), 'exists')
  assertEquals(code(() => applyOp(SMALL, { op: 'addNode', palette: 'timer', name: 'echo' }, opts)), 'exists')
  assertEquals(code(() => applyOp(SMALL, { op: 'addNode', palette: 'timer', name: 'bad name' }, opts)), 'invalid-name')
})

Deno.test('an approval is a reference to adhar-steps, and labels the runs it will create', () => {
  const r = applyOp(SMALL, { op: 'addNode', palette: 'approval' }, opts)
  assertEquals(task(r.doc, 'approve').templateRef, { name: 'adhar-steps', template: 'approval', clusterScope: true })
  assertEquals(task(r.doc, 'approve').arguments.parameters.map((p: { name: string }) => p.name), ['question', 'approvers'])
  assertEquals(js(r.doc).spec.workflowMetadata.labels[HAS_APPROVALS_LABEL], 'true')
  assert(r.doc.source.includes(`${HAS_APPROVALS_LABEL}: "true"`), 'the label value is a string, not a boolean')
  assertEquals(js(r.doc).spec.templates.length, 2, 'no local template for a reference')
  assert(usesApprovals(r.doc, CATALOGUE))
  // Removing the last approval takes the label (and the maps it emptied) away again.
  const back = run(r.doc, { op: 'removeNode', node: 'approve' })
  assertEquals(toJS(back), toJS(SMALL))
  assert(!usesApprovals(back, CATALOGUE))
  // With two approvals, removing one keeps the label.
  const two = run(r.doc, { op: 'addNode', palette: 'approval' }, { op: 'removeNode', node: 'approve' })
  assertEquals(js(two).spec.workflowMetadata.labels[HAS_APPROVALS_LABEL], 'true')
})

Deno.test('addRef calls another template with the arguments it requires', () => {
  const r = applyOp(SMALL, { op: 'addRef', ref: { name: 'team-lib', template: 'deploy' }, arguments: [{ name: 'env', value: 'dev' }] }, opts)
  assertEquals(task(r.doc, 'deploy'), { name: 'deploy', templateRef: { name: 'team-lib', template: 'deploy' }, arguments: { parameters: [{ name: 'env', value: 'dev' }] } })
  assertEquals(findNode(project(r.doc, opts), 'deploy')!.kind, 'template')
  const step = applyOp(SMALL, { op: 'addNode', palette: 'step:adhar-steps/http-check' }, opts)
  assertEquals(task(step.doc, 'http-check').arguments.parameters, [{ name: 'url', value: '' }])
  assert(!js(step.doc).spec.workflowMetadata)
})

Deno.test('the exit lane is created on first use, and a leaf handler is wrapped, not lost', () => {
  const r = applyOp(SMALL, { op: 'addNode', palette: 'exit-handler' }, opts)
  assertEquals(js(r.doc).spec.onExit, 'on-exit')
  assertEquals(r.created, { uid: 'on-exit/notify', task: 'notify', dag: 'on-exit', template: 'notify' })
  const g = project(r.doc, opts)
  assertEquals(g.exitLane?.nodes.map((n) => n.uid), ['on-exit/notify'])
  // A second one joins the same lane.
  const more = applyOp(r.doc, { op: 'addNode', palette: 'timer', lane: 'exit' }, opts)
  assertEquals(more.created?.dag, 'on-exit')
  assertEquals(project(more.doc, opts).exitLane?.nodes.length, 2)

  const leaf = parse(SMALL.source.replace('  entrypoint: main\n', '  entrypoint: main\n  onExit: echo\n'))
  const w = applyOp(leaf, { op: 'addNode', palette: 'timer', lane: 'exit' }, opts)
  assertEquals(js(w.doc).spec.onExit, 'on-exit')
  assertEquals(tasks(w.doc, 3).map((t) => [t.name, t.template]), [['echo', 'echo'], ['wait', 'wait']])
  assert(w.changes.some((c) => c.includes('now runs inside')), w.changes.join('; '))
})

/* ───────── connect / disconnect ───────── */

Deno.test('connect writes depends under the name; Succeeded is the bare name', () => {
  const r = undoes(SMALL, { op: 'connect', source: 'a', target: 'b' })
  assertEquals(task(r.doc, 'b').depends, 'a')
  assert(/- name: b\n\s+depends: a\n\s+template: echo/.test(r.doc.source), r.doc.source)
  assertEquals(commentsOf(r.doc), commentsOf(SMALL))
  assertEquals(task(run(SMALL, { op: 'connect', source: 'a', target: 'b', condition: 'Failed' }), 'b').depends, 'a.Failed')
  assertEquals(task(run(SMALL, { op: 'connect', source: 'a', target: 'b', condition: 'Succeeded', explicit: true }), 'b').depends, 'a.Succeeded')
  // More terms join with &&.
  const three = run(SMALL, { op: 'addNode', palette: 'timer', name: 'c' }, { op: 'connect', source: 'a', target: 'c' }, { op: 'connect', source: 'b', target: 'c', condition: 'Errored' })
  assertEquals(task(three, 'c').depends, 'a && b.Errored')
  undoes(three, { op: 'disconnect', source: 'a', target: 'c' })
  undoes(three, { op: 'disconnect', source: 'b', target: 'c' })
  // Connecting again with another result changes the term; the same result is a no-op.
  assertEquals(task(run(three, { op: 'connect', source: 'a', target: 'c', condition: 'Skipped' }), 'c').depends, 'a.Skipped && b.Errored')
  undoes(three, { op: 'connect', source: 'a', target: 'c', condition: 'Skipped' })
  const same = applyOp(three, { op: 'connect', source: 'a', target: 'c' }, opts)
  assertEquals(same.doc, three)
  assertEquals(same.inverse, [])
})

Deno.test('connect refuses circles, strangers and expressions it cannot edit', () => {
  const ab = run(SMALL, { op: 'connect', source: 'a', target: 'b' })
  assertEquals(code(() => applyOp(ab, { op: 'connect', source: 'b', target: 'a' }, opts)), 'cycle')
  assertEquals(code(() => applyOp(ab, { op: 'connect', source: 'a', target: 'a' }, opts)), 'cycle')
  assertEquals(code(() => applyOp(ab, { op: 'connect', source: 'ghost', target: 'a' }, opts)), 'not-found')
  assertEquals(code(() => applyOp(ab, { op: 'connect', source: 'a', target: 'b', condition: 'Done' as never }, opts)), 'invalid')
  assertEquals(code(() => applyOp(RELEASE, { op: 'connect', source: 'build', target: 'exit-main/notify' }, opts)), 'invalid')
  // `approve` names scan inside (scan.Succeeded || scan.Skipped): that is text, not an edge.
  assertEquals(code(() => applyOp(RELEASE, { op: 'connect', source: 'scan', target: 'approve', condition: 'Failed' }, opts)), 'expression')
  // A new term on an expression is fine: it constrains the whole of it.
  assertEquals(task(run(RELEASE, { op: 'connect', source: 'build', target: 'approve' }), 'approve').depends, 'lint && unit && (scan.Succeeded || scan.Skipped) && build')
  // Disconnecting from an expression removes the task everywhere, and the inverse restores the text.
  const r = undoes(RELEASE, { op: 'disconnect', source: 'scan', target: 'approve' })
  assertEquals(task(r.doc, 'approve').depends, 'lint && unit')
  assertEquals(applyOp(RELEASE, { op: 'disconnect', source: 'tag', target: 'build' }, opts).doc, RELEASE)
})

Deno.test('legacy dependencies: a success edge appends; any other result migrates to depends', () => {
  const legacy = parse(SMALL.source.replace('- name: b\n', '- name: b\n        dependencies: [a]   # the old spelling\n'))
  const withC = run(legacy, { op: 'addNode', palette: 'timer', name: 'c' })
  const plain = undoes(withC, { op: 'connect', source: 'c', target: 'b' })
  assertEquals(task(plain.doc, 'b').dependencies, ['a', 'c'])
  assertEquals(task(plain.doc, 'b').depends, undefined)
  const migrated = applyOp(withC, { op: 'connect', source: 'c', target: 'b', condition: 'Failed' }, opts)
  assertEquals(task(migrated.doc, 'b').depends, 'a && c.Failed')
  assertEquals(task(migrated.doc, 'b').dependencies, undefined, 'never both (Argo CEL rule)')
  assert(migrated.changes.some((c) => c.includes('dependencies became depends')), migrated.changes.join('; '))
  assert(commentsOf(migrated.doc).includes('the old spelling'))
  assert(!validate(migrated.doc).some((x) => x.code === 'cel/depends-and-dependencies'))
  // The explicit migration, and removing the only dependency.
  const m = applyOp(legacy, { op: 'migrateDependencies', node: 'b' }, opts)
  assertEquals(task(m.doc, 'b'), { name: 'b', depends: 'a', template: 'echo' })
  assertEquals(Object.keys(task(m.doc, 'b')), ['name', 'depends', 'template'], 'depends takes the place dependencies had')
  assertEquals(applyOp(m.doc, { op: 'migrateDependencies', node: 'b' }, opts).doc, m.doc)
  // (The comment sat on the line that was removed; it goes with it.)
  const gone = undoes(legacy, { op: 'disconnect', source: 'a', target: 'b' }, false)
  assertEquals(task(gone.doc, 'b').dependencies, undefined)
})

/* ───────── remove ───────── */

Deno.test('removeNode takes the task, its terms elsewhere and its position; a shared template stays', () => {
  const r = applyOp(RELEASE, { op: 'removeNode', node: 'unit' }, opts)
  assertEquals(tasks(r.doc).map((t) => t.name), ['build', 'lint', 'scan', 'approve', 'tag'])
  assertEquals(task(r.doc, 'approve').depends, 'lint && (scan.Succeeded || scan.Skipped)')
  assert(!js(r.doc).spec.templates.some((t: { name: string }) => t.name === 'unit'), 'its own template goes with it')
  assert(!('unit' in decodePositions(getIn(r.doc, ['metadata', 'annotations', POSITIONS_ANNOTATION]))))
  assert(commentsOf(r.doc).includes('Three independent checks; each one alone can fail the run.'))
  // `announce` is still used by the hook on `tag`.
  const exit = applyOp(RELEASE, { op: 'removeNode', node: 'exit-main/notify' }, opts)
  assert(js(exit.doc).spec.templates.some((t: { name: string }) => t.name === 'announce'))
  assert(exit.changes.some((c) => c.includes('Kept the template "announce"')), exit.changes.join('; '))
  // A template shared by two tasks survives the first removal and goes with the last.
  const one = applyOp(SMALL, { op: 'removeNode', node: 'a' }, opts)
  assertEquals(js(one.doc).spec.templates.map((t: { name: string }) => t.name), ['main', 'echo'])
  const both = applyOp(one.doc, { op: 'removeNode', node: 'b' }, opts)
  assertEquals(js(both.doc).spec.templates.map((t: { name: string }) => t.name), ['main'])
  assertEquals(js(applyOp(one.doc, { op: 'removeNode', node: 'b', keepTemplate: true }, opts).doc).spec.templates.length, 2)
  // Legacy lists lose the name too.
  const legacy = parse(SMALL.source.replace('- name: b\n', '- name: b\n        dependencies: [a]\n'))
  assertEquals(task(run(legacy, { op: 'removeNode', node: 'a' }), 'b').dependencies, undefined)
  assertEquals(code(() => applyOp(SMALL, { op: 'removeNode', node: 'ghost' }, opts)), 'not-found')
})

/* ───────── rename ───────── */

Deno.test('rename rewrites the task, every depends term, every {{tasks.x}} token and the positions key', () => {
  const r = undoes(RELEASE, { op: 'rename', node: 'approve', to: 'sign-off' })
  assertEquals(task(r.doc, 'tag').depends, 'sign-off')
  assertEquals(task(r.doc, 'tag').when, '{{tasks.sign-off.outputs.parameters.decision}} == approve')
  assertEquals(task(r.doc, 'sign-off').templateRef.template, 'approval', 'the template called approval is not the task called approve')
  const p = decodePositions(getIn(r.doc, ['metadata', 'annotations', POSITIONS_ANNOTATION]))
  assertEquals(p['sign-off'], { x: 624, y: 116 })
  assert(!('approve' in p))
  assertEquals(commentsOf(r.doc), commentsOf(RELEASE))
  // Inside an expression, with the spacing left alone.
  const s = undoes(RELEASE, { op: 'rename', node: 'scan', to: 'sast' })
  assertEquals(task(s.doc, 'approve').depends, 'lint && unit && (sast.Succeeded || sast.Skipped)')
  assertEquals(task(s.doc, 'sast').template, 'scan', 'the template keeps its name')
  // A hook expression on the task itself.
  assertEquals(task(run(RELEASE, { op: 'rename', node: 'tag', to: 'release' }), 'release').hooks.running.expression, 'tasks.release.status == "Running"')
  // The exit lane has its own names.
  const e = undoes(RELEASE, { op: 'rename', node: 'exit-main/notify', to: 'tell' })
  assertEquals(decodePositions(getIn(e.doc, ['metadata', 'annotations', POSITIONS_ANNOTATION]))['exit-main/tell'], { x: 0, y: 404 })
  assertEquals(code(() => applyOp(RELEASE, { op: 'rename', node: 'scan', to: 'lint' }, opts)), 'exists')
  assertEquals(code(() => applyOp(RELEASE, { op: 'rename', node: 'scan', to: 'has space' }, opts)), 'invalid-name')
  assertEquals(applyOp(RELEASE, { op: 'rename', node: 'scan', to: 'scan' }, opts).doc, RELEASE)
})

Deno.test('rename matches tokens on their boundaries only', () => {
  const t = (s: string) => renameTaskTokens(s, 'build', 'compile')
  assertEquals(t('{{tasks.build.outputs.result}}'), '{{tasks.compile.outputs.result}}')
  assertEquals(t('{{tasks.build-image.outputs.result}}'), '{{tasks.build-image.outputs.result}}')
  assertEquals(t('{{tasks.build_x.outputs.result}}'), '{{tasks.build_x.outputs.result}}')
  assertEquals(t('{{tasks.rebuild.outputs.result}}'), '{{tasks.rebuild.outputs.result}}')
  assertEquals(t('{{subtasks.build.x}} {{my.tasks.build.x}}'), '{{subtasks.build.x}} {{my.tasks.build.x}}')
  assertEquals(t("{{=tasks['build'].outputs.result + tasks[\"build\"].status}}"), "{{=tasks['compile'].outputs.result + tasks[\"compile\"].status}}")
  assertEquals(t('tasks.build.status == "Succeeded" && tasks.build'), 'tasks.compile.status == "Succeeded" && tasks.compile')
  assertEquals(t('{{steps.build.outputs.result}} build'), '{{steps.build.outputs.result}} build')
  assertEquals(renameTaskTokens('{{steps.a.outputs.result}}', 'a', 'a', 'steps', 'tasks'), '{{tasks.a.outputs.result}}')
  // In a document: `build-image` and a string that merely contains the word are left alone.
  const d = parse(`apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata: {name: x}
spec:
  entrypoint: main
  templates:
  - name: main
    dag:
      target: build-image build
      tasks:
      - {name: build, template: t}
      - {name: build-image, depends: build, template: t}
      - name: use
        depends: "build && build-image.Succeeded"
        template: t
        arguments:
          parameters:
          - {name: a, value: "{{tasks.build.outputs.result}}/{{tasks.build-image.outputs.result}}"}
          - {name: b, value: "build it"}
    outputs:
      parameters:
      - {name: o, valueFrom: {parameter: "{{tasks.build.outputs.result}}"}}
  - name: t
    suspend: {}
`)
  const r = undoes(d, { op: 'rename', node: 'build', to: 'compile' })
  const main = js(r.doc).spec.templates[0]
  assertEquals(main.dag.target, 'build-image compile')
  assertEquals(main.dag.tasks[1], { name: 'build-image', depends: 'compile', template: 't' })
  assertEquals(main.dag.tasks[2].depends, 'compile && build-image.Succeeded')
  assertEquals(main.dag.tasks[2].arguments.parameters.map((p: { value: string }) => p.value), ['{{tasks.compile.outputs.result}}/{{tasks.build-image.outputs.result}}', 'build it'])
  assertEquals(main.outputs.parameters[0].valueFrom.parameter, '{{tasks.compile.outputs.result}}')
})

/* ───────── set / unset / insert / arguments ───────── */

Deno.test('set, unset and insert edit one path and know how to go back', () => {
  const image = ['spec', 'templates', 1, 'container', 'image']
  const r = undoes(RELEASE, { op: 'set', path: image, value: 'ghcr.io/adhar-io/builder:1.5.0' })
  assertEquals(getIn(r.doc, image), 'ghcr.io/adhar-io/builder:1.5.0')
  assertEquals(commentsOf(r.doc), commentsOf(RELEASE))
  undoes(RELEASE, { op: 'set', path: ['spec', 'templates', 1, 'retryStrategy', 'backoff', 'duration'], value: '10s' })
  undoes(RELEASE, { op: 'unset', path: ['spec', 'activeDeadlineSeconds'] }, false)
  undoes(RELEASE, { op: 'unset', path: ['spec', 'arguments', 'parameters', 1] }, false)
  undoes(RELEASE, { op: 'insert', path: ['spec', 'templates', 1, 'container', 'env'], value: { name: 'X', value: 'on' } })
  assertEquals(applyOp(RELEASE, { op: 'unset', path: ['spec', 'nope'] }, opts).doc, RELEASE)
  // A value YAML 1.1 would misread is quoted on the way in.
  const q = run(RELEASE, { op: 'set', path: ['spec', 'templates', 1, 'container', 'env', 0, 'value'], value: 'yes' })
  assert(q.source.includes('value: "yes"'), 'quoted')
  assertEquals(code(() => applyOp(RELEASE, { op: 'set', path: [], value: 1 }, opts)), 'invalid')
})

Deno.test('setArgument sets, adds and removes one argument of a task', () => {
  const r = undoes(RELEASE, { op: 'setArgument', node: 'approve', name: 'approvers', value: 'ws-team-risk' })
  assertEquals(task(r.doc, 'approve').arguments.parameters[1], { name: 'approvers', value: 'ws-team-risk' })
  const added = undoes(RELEASE, { op: 'setArgument', node: 'approve', name: 'timeout', value: '30m' })
  assertEquals(task(added.doc, 'approve').arguments.parameters.length, 3)
  const removed = undoes(RELEASE, { op: 'setArgument', node: 'build', name: 'revision' })
  assertEquals(task(removed.doc, 'build').arguments, undefined, 'the emptied arguments map goes too')
  assertEquals(applyOp(RELEASE, { op: 'setArgument', node: 'approve', name: 'approvers', value: 'ws-team-payments' }, opts).doc, RELEASE)
  assertEquals(applyOp(RELEASE, { op: 'setArgument', node: 'approve', name: 'nope' }, opts).doc, RELEASE)
})

/* ───────── positions / layout ───────── */

Deno.test('a drag merges into the annotation; auto-layout rewrites every position', () => {
  const r = undoes(RELEASE, { op: 'setPositions', positions: { build: { x: 5, y: 6 } } })
  const p = decodePositions(getIn(r.doc, ['metadata', 'annotations', POSITIONS_ANNOTATION]))
  assertEquals(p.build, { x: 5, y: 6 })
  assertEquals(p.lint, { x: 312, y: 0 })
  assertEquals(r.changes, [])
  // First drag on a template with no annotations at all.
  const first = undoes(SMALL, { op: 'setPositions', positions: { a: { x: 1, y: 2 } } })
  assertEquals(js(first.doc).metadata.annotations, { [POSITIONS_ANNOTATION]: '{"a":[1,2]}' })
  const laid = applyOp(r.doc, { op: 'autoLayout' }, opts)
  const after = project(laid.doc, opts)
  const bare = project(parse(RELEASE.source.replace(/^\s*adhar\.io\/designer-positions:.*\n/m, '')), opts)
  assertEquals(allNodes(after).map((n) => [n.uid, n.position.x, n.position.y]), allNodes(bare).map((n) => [n.uid, n.position.x, n.position.y]))
  assert(allNodes(after).every((n) => n.position.fromAnnotation))
  assertEquals(applyOp(laid.doc, { op: 'autoLayout' }, opts).doc.source, laid.doc.source, 'idempotent')
})

/* ───────── steps → DAG, leaf → DAG ───────── */

Deno.test('Convert to DAG: each group waits for the one before; continueOn and {{steps.x}} are carried over', () => {
  const steps = parse(corpusText('handwritten/steps-pipeline.yaml'))
  const r = applyOp(steps, { op: 'convertStepsToDag' }, opts)
  const t = tasks(r.doc)
  assertEquals(t.map((x) => [x.name, x.depends]), [
    ['fetch', undefined],
    ['test', 'fetch'],
    ['lint', 'fetch'],
    ['report', '(test.Succeeded || test.Skipped || test.Daemoned || test.Failed) && lint'],
  ])
  assertEquals(t[1].continueOn, undefined, 'continueOn cannot stay beside depends')
  assertEquals(t[3].when, '{{tasks.test.status}} != Skipped')
  assertEquals(t[3].arguments.parameters[0].value, 'report {{tasks.fetch.outputs.result}}')
  assertEquals(js(r.doc).spec.templates[0].steps, undefined)
  const g = project(r.doc, opts)
  assert(g.editable)
  assert(!hasErrors(g.diagnostics), JSON.stringify(g.diagnostics.filter((x) => x.level === 'error')))
  // Comments above a group stay above its first task. (The one on `continueOn.failed` went with that line.)
  for (const c of ['group 1', 'group 2 runs in parallel']) assert(commentsOf(r.doc).includes(c), c)
  assert(/# group 1\n\s+- name: fetch/.test(r.doc.source) && /# group 2 runs in parallel\n\s+- name: test/.test(r.doc.source), r.doc.source)
  assert(r.changes.some((c) => c.includes('continueOn of "test"')))
  assertEquals(code(() => applyOp(RELEASE, { op: 'convertStepsToDag' }, opts)), 'invalid')
})

Deno.test('Wrap in a DAG: a leaf entrypoint becomes the first step and still gets its parameters', () => {
  const leaf = parse(`apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata: {generateName: hello-}
spec:
  entrypoint: say
  arguments: {parameters: [{name: msg, value: hi}]}
  templates:
  - name: say   # the only template
    inputs: {parameters: [{name: msg}]}
    suspend: {}
`)
  assertEquals(project(leaf).readOnly, 'leaf-entry')
  const r = applyOp(leaf, { op: 'wrapEntry' }, opts)
  assertEquals(js(r.doc).spec.entrypoint, 'main')
  assertEquals(js(r.doc).spec.templates.map((t: { name: string }) => t.name), ['main', 'say'])
  assertEquals(tasks(r.doc), [{ name: 'say', template: 'say', arguments: { parameters: [{ name: 'msg', value: '{{workflow.parameters.msg}}' }] } }])
  assert(project(r.doc).editable)
  assertEquals(commentsOf(r.doc), commentsOf(leaf))
  assertEquals(code(() => applyOp(RELEASE, { op: 'wrapEntry' }, opts)), 'invalid')
})

/* ───────── drafts ───────── */

Deno.test('a draft is labelled "true" and expires seven days on, to the second', () => {
  const now = new Date('2026-11-28T10:15:30.123Z')
  assertEquals(draftExpiry(now), '2026-12-05T10:15:30Z')
  const r = applyOp(RELEASE, { op: 'stampDraft', expires: draftExpiry(now) }, opts)
  assertEquals(js(r.doc).metadata.labels[DRAFT_LABEL], 'true')
  assert(r.doc.source.includes(`${DRAFT_LABEL}: "true"`), 'a string: Kyverno #7 refuses anything but "true"')
  assertEquals(js(r.doc).metadata.annotations[DRAFT_EXPIRES_ANNOTATION], '2026-12-05T10:15:30Z')
  assert(/draft-expires: "?2026-12-05T10:15:30Z"?/.test(r.doc.source))
  assertEquals(typeof js(r.doc).metadata.annotations[DRAFT_EXPIRES_ANNOTATION], 'string')
  // Every save moves the expiry; nothing else.
  const later = applyOp(r.doc, { op: 'stampDraft', expires: draftExpiry(new Date('2026-11-29T00:00:00Z')) }, opts)
  assertEquals(js(later.doc).metadata.annotations[DRAFT_EXPIRES_ANNOTATION], '2026-12-06T00:00:00Z')
  assertEquals(commentsOf(later.doc), commentsOf(RELEASE))
  assertEquals(code(() => applyOp(RELEASE, { op: 'stampDraft', expires: 'next week' }, opts)), 'invalid')
  assertEquals(DRAFT_LABEL, 'adhar.io/workflow-draft')
  assertEquals(DRAFT_EXPIRES_ANNOTATION, 'adhar.io/draft-expires')
})

/* ───────── what an edit may not do ───────── */

Deno.test('no operation edits a document that does not parse, is not a workflow, or is not a DAG', () => {
  const broken = parse('kind: [oops\n')
  for (const op of [{ op: 'addNode', palette: 'timer' }, { op: 'set', path: ['a'], value: 1 }, { op: 'autoLayout' }, { op: 'stampDraft', expires: '2026-12-05T10:15:30Z' }] as Op[]) {
    assertEquals(code(() => applyOp(broken, op, opts)), 'unparseable')
    assertEquals(code(() => applyOp(parse('kind: ConfigMap\n'), op, opts)), 'not-editable')
  }
  const steps = parse(corpusText('handwritten/steps-pipeline.yaml'))
  assertEquals(code(() => applyOp(steps, { op: 'addNode', palette: 'timer' }, opts)), 'not-editable')
  assertEquals(code(() => applyOp(steps, { op: 'connect', source: 'fetch', target: 'test' }, opts)), 'not-editable')
})

Deno.test('the input snapshot is never changed, and a failed batch changes nothing', () => {
  const before = RELEASE.source
  const json = JSON.stringify(toJS(RELEASE))
  assertThrows(() => applyOps(RELEASE, [{ op: 'rename', node: 'scan', to: 'sast' }, { op: 'removeNode', node: 'ghost' }], opts), OpError)
  run(RELEASE, { op: 'removeNode', node: 'unit' }, { op: 'addNode', palette: 'approval' }, { op: 'autoLayout' })
  assertEquals(RELEASE.source, before)
  assertEquals(JSON.stringify(toJS(RELEASE)), json)
})

Deno.test('a six-node DAG built from the palette alone validates (acceptance 2, the model half)', () => {
  const blank = parse(`apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: six
  namespace: payments-dev
spec:
  entrypoint: main
  activeDeadlineSeconds: 3600
  templates:
  - name: main
    dag:
      tasks: []
`)
  const d = run(
    blank,
    { op: 'addNode', palette: 'container', name: 'build', at: { x: 0, y: 0 } },
    { op: 'addNode', palette: 'script', name: 'test', at: { x: 300, y: 0 } },
    { op: 'addNode', palette: 'http', name: 'probe', at: { x: 300, y: 120 } },
    { op: 'addNode', palette: 'approval', name: 'approve', at: { x: 600, y: 0 } },
    { op: 'addRef', ref: { name: 'team-lib', template: 'deploy' }, name: 'deploy', at: { x: 900, y: 0 } },
    { op: 'addNode', palette: 'container', name: 'fan', at: { x: 900, y: 120 } },
    { op: 'set', path: ['spec', 'templates', 0, 'dag', 'tasks', 5, 'withItems'], value: ['a', 'b', 'c'] },
    { op: 'connect', source: 'build', target: 'test' },
    { op: 'connect', source: 'build', target: 'probe' },
    { op: 'connect', source: 'test', target: 'approve' },
    { op: 'connect', source: 'probe', target: 'approve' },
    { op: 'connect', source: 'approve', target: 'deploy' },
    { op: 'connect', source: 'approve', target: 'fan' },
    { op: 'stampDraft', expires: draftExpiry(new Date('2026-11-28T00:00:00Z')) },
  )
  const g = project(d, opts)
  assertEquals(g.nodes.map((n) => [n.id, n.kind]), [['build', 'container'], ['test', 'script'], ['probe', 'http'], ['approve', 'approval'], ['deploy', 'template'], ['fan', 'container']])
  assertEquals(findNode(g, 'fan')!.badges.fanOut, 'items')
  assertEquals(g.edges.length, 6)
  assertEquals(g.diagnostics.filter((x) => x.level !== 'info').map((x) => x.code), [])
  assert(g.nodes.every((n) => n.position.fromAnnotation))
})

/* ───────── found by the verifier: the breaking inputs ───────── */

const head = (tasksYaml: string, more = '') => `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata: {name: x}
spec:
  entrypoint: main
  activeDeadlineSeconds: 60
  templates:
  - name: main
    dag:
      tasks:
${tasksYaml.replace(/^\n/, '').replace(/\s+$/, '')}
  - name: e
    suspend: {}
${more}`

Deno.test('every refusal is an OpError: nothing the YAML library or doc.ts throws reaches the canvas', () => {
  const d = parse(head(`      - name: a
        template: e`))
  // A list asked of a scalar, a path through a scalar: doc.ts refuses, the op reports it.
  assertEquals(code(() => applyOp(d, { op: 'insert', path: ['spec', 'entrypoint'], value: 'x' }, opts)), 'invalid')
  assertEquals(code(() => applyOp(d, { op: 'set', path: ['spec', 'entrypoint', 'deeper'], value: 1 }, opts)), 'invalid')
  // The library cannot print a !!binary scalar with unlimited line width; that is a refusal too, not a RangeError.
  const binary = parse(d.source.replace('metadata: {name: x}', 'metadata: {name: x, annotations: {blob: !!binary aGVsbG8=}}'))
  assertEquals(binary.errors, [])
  assertEquals(code(() => applyOp(binary, { op: 'rename', node: 'a', to: 'b' }, opts)), 'invalid')
  assertEquals(binary.source.includes('aGVsbG8='), true)
})

Deno.test('setting a field to what it already holds is no edit; unsetting an inherited key removes it', () => {
  // `mode: 0644` again: the same value must not reprint (or push an undo step).
  const d = parse(head(`      - &base
        name: a
        template: e
        arguments: {parameters: [{name: mode, value: 0644}]}
      - <<: *base
        name: b`))
  const value = ['spec', 'templates', 0, 'dag', 'tasks', 0, 'arguments', 'parameters', 0, 'value']
  for (const op of [
    { op: 'set', path: value, value: 644 },
    { op: 'set', path: ['spec', 'entrypoint'], value: 'main' },
    { op: 'set', path: ['spec', 'templates', 1], value: { name: 'e', suspend: {} } },
    // b inherits `template` through the merge: the same value there is no edit either.
    { op: 'set', path: ['spec', 'templates', 0, 'dag', 'tasks', 1, 'template'], value: 'e' },
  ] as Op[]) {
    const r = applyOp(d, op, opts)
    assertEquals(r.doc, d, JSON.stringify(op))
    assertEquals(r.inverse, [])
  }
  // A different type is a change: the string "644" is not the number.
  assert(applyOp(d, { op: 'set', path: value, value: '644' }, opts).doc !== d)
  // b's `template` comes from the merge; unset removes it from b and only from b, and the inverse puts it back.
  const inherited = ['spec', 'templates', 0, 'dag', 'tasks', 1, 'template']
  const r = undoes(d, { op: 'unset', path: inherited }, false)
  assertEquals(tasks(r.doc), [{ name: 'a', template: 'e', arguments: { parameters: [{ name: 'mode', value: 644 }] } }, { arguments: { parameters: [{ name: 'mode', value: 644 }] }, name: 'b' }])
  assert(r.doc.source.includes('value: 0644'), r.doc.source)
})

Deno.test('a graph that already holds a circle can still be edited; only the edge that would close one is refused', () => {
  const d = parse(head(`      - {name: a, template: e, depends: c}
      - {name: b, template: e, depends: a}
      - {name: c, template: e, depends: b}
      - {name: d, template: e}
      - {name: f, template: e}`))
  assert(validate(d).some((x) => x.code === 'graph/cycle'))
  // d and f are outside the circle: connecting them is an ordinary edge.
  assertEquals(task(run(d, { op: 'connect', source: 'd', target: 'f' }), 'f').depends, 'd')
  assertEquals(task(run(d, { op: 'connect', source: 'a', target: 'd' }), 'd').depends, 'a')
  // …and the way out of the circle works.
  assert(!validate(run(d, { op: 'disconnect', source: 'c', target: 'a' })).some((x) => x.code === 'graph/cycle'))
  // An edge that would close a NEW circle is still refused, directly or through others.
  const df = run(d, { op: 'connect', source: 'd', target: 'f' })
  assertEquals(code(() => applyOp(df, { op: 'connect', source: 'f', target: 'd' }, opts)), 'cycle')
  const chain = run(SMALL, { op: 'addNode', palette: 'timer', name: 'c' }, { op: 'connect', source: 'a', target: 'b' }, { op: 'connect', source: 'b', target: 'c' })
  assertEquals(code(() => applyOp(chain, { op: 'connect', source: 'c', target: 'a' }, opts)), 'cycle')
})

Deno.test('addRef of a catalogue step brings the arguments the step requires, and its title', () => {
  const ref = { name: 'adhar-steps', template: 'wait-healthy', clusterScope: true }
  const r = applyOp(SMALL, { op: 'addRef', ref }, opts)
  assertEquals(task(r.doc, 'wait-healthy'), { name: 'wait-healthy', templateRef: ref, arguments: { parameters: [{ name: 'kind', value: '' }, { name: 'name', value: '' }] } })
  assert(r.changes[0].includes('Wait until healthy'), r.changes[0])
  // The same step from the palette is the same task.
  assertEquals(task(run(SMALL, { op: 'addNode', palette: 'step:adhar-steps/wait-healthy' }), 'wait-healthy'), task(r.doc, 'wait-healthy'))
  // Arguments the caller passes win; an approval added by reference is still an approval.
  assertEquals(task(run(SMALL, { op: 'addRef', ref, arguments: [{ name: 'kind', value: 'Job' }] }), 'wait-healthy').arguments.parameters, [{ name: 'kind', value: 'Job' }])
  const approval = applyOp(SMALL, { op: 'addRef', ref: { name: 'adhar-steps', template: 'approval', clusterScope: true } }, opts)
  assertEquals(task(approval.doc, 'approval').arguments.parameters.map((p: { name: string }) => p.name), ['question', 'approvers'])
  assertEquals(js(approval.doc).spec.workflowMetadata.labels[HAS_APPROVALS_LABEL], 'true')
  // Without the catalogue, or for a template that is not in it, nothing is invented.
  assertEquals(task(applyOp(SMALL, { op: 'addRef', ref }).doc, 'wait-healthy').arguments, undefined)
  assertEquals(task(run(SMALL, { op: 'addRef', ref: { name: 'adhar-steps', template: 'wait-healthy' } }), 'wait-healthy').arguments, undefined, 'a namespaced template of the same name is not the catalogue step')
})

const STEPS = `apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata: {generateName: steps-}
spec:
  entrypoint: main
  activeDeadlineSeconds: 60
  x-groups:
    verify: &verify
    - {name: verify, template: e}
    tolerant: &tolerant {template: e, continueOn: {failed: true}}
  templates:
  - name: main
    steps:
    - - {name: build, template: e}
      - name: lint
        template: e
    - []
    - - name: test
        template: e
    # a group written once and used here
    - *verify
    - - {name: 3rd, template: e}
    - - <<: *tolerant
        name: again
    - - {name: end, template: e}
  - name: e
    suspend: {}
`

Deno.test('Convert to DAG: an empty group does not cut the chain, an aliased group is not lost, a digit name is called out', () => {
  const d = parse(STEPS)
  assertEquals(d.errors, [])
  // The projection: four columns, not five, and `test` waits for the group before the empty one.
  const g = project(d, opts)
  assertEquals(g.nodes.map((n) => [n.id, n.column]), [['build', 0], ['lint', 0], ['test', 1], ['verify', 2], ['3rd', 3], ['again', 4], ['end', 5]])
  assertEquals(g.edges.map((e) => `${e.source}>${e.target}`), ['build>test', 'lint>test', 'test>verify', 'verify>3rd', '3rd>again', 'again>end'])
  const r = applyOp(d, { op: 'convertStepsToDag' }, opts)
  assertEquals(tasks(r.doc), [
    { name: 'build', template: 'e' },
    { name: 'lint', template: 'e' },
    { name: 'test', template: 'e', depends: 'build && lint' },
    { name: 'verify', depends: 'test', template: 'e' },
    { name: '3rd', depends: 'verify', template: 'e' },
    // `again` INHERITED continueOn through a merge key; a DAG task with depends may not carry it, so it is said in what follows.
    { template: 'e', name: 'again', depends: '3rd' },
    { name: 'end', template: 'e', depends: '(again.Succeeded || again.Skipped || again.Daemoned || again.Failed)' },
  ])
  assert(!validate(r.doc).some((x) => x.code === 'cel/continue-on-with-depends'))
  // The group's own definition is untouched (its copy in the DAG is what gained `depends`), and its comment came along.
  assertEquals(js(r.doc).spec['x-groups'].verify, [{ name: 'verify', template: 'e' }])
  assert(/# a group written once and used here\n\s+- name: verify/.test(r.doc.source), r.doc.source)
  // The DAG says what the steps said.
  assertEquals(project(r.doc, opts).edges.map((e) => `${e.source}>${e.target}`), g.edges.map((e) => `${e.source}>${e.target}`))
  assert(r.changes.some((c) => c.includes('"3rd" begins with a digit')), JSON.stringify(r.changes))
  assert(validate(r.doc).some((x) => x.code === 'cel/task-name-digit'))
  // A step that is not a map cannot become a task: refused, not dropped.
  assertEquals(code(() => applyOp(parse(STEPS.replace('- []', '- [oops]')), { op: 'convertStepsToDag' }, opts)), 'invalid')
})

Deno.test('a task renamed to a word YAML 1.1 misreads is quoted everywhere it is written', () => {
  const d = parse(head(`      - name: a
        template: e
      - name: b
        depends: a
        template: e
      - name: c
        dependencies: [a, b]
        template: e
      - name: d
        depends: a && b
        template: e`))
  for (const to of ['no', 'on', 'y', '0755', '2026-12-05']) {
    const r = applyOp(d, { op: 'rename', node: 'a', to }, opts).doc
    assertEquals(tasks(r).map((t) => [t.name, t.depends ?? t.dependencies]), [[to, undefined], ['b', to], ['c', [to, 'b']], ['d', `${to} && b`]], to)
    assert(r.source.includes(`- name: "${to}"`) && r.source.includes(`depends: "${to}"`) && r.source.includes(`dependencies: ["${to}", b]`), r.source)
  }
  // A term left alone by a disconnect is quoted too.
  const no = run(d, { op: 'rename', node: 'b', to: 'no' }, { op: 'disconnect', source: 'a', target: 'd' })
  assert(no.source.includes('depends: "no"\n        template: e\n  - name: e'), no.source)
})

const SHARED = `apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: shared
  labels: &lbl
    team: a
  annotations: *lbl
spec:
  entrypoint: main
  activeDeadlineSeconds: 60
  templates:
  - name: main
    dag:
      tasks:
      - &first
        name: a # first
        template: echo
        arguments: &args
          parameters:
          - {name: msg, value: hi}
      - &second
        name: b
        depends: a
        template: echo
        arguments: *args
      - <<: *first
        name: c
        depends: "a && b"
      - {<<: *second, name: d}
  - name: echo
    inputs: {parameters: [{name: msg}]}
    suspend: {}
`

Deno.test('operations on a document with anchors change the node they name and no other', () => {
  const d = parse(SHARED)
  assertEquals(d.errors, [])
  const args = (x: WfDoc, name: string) => task(x, name).arguments.parameters[0].value
  // b's arguments are an alias of a's; c's come through a merge. Each is edited alone.
  for (const node of ['a', 'b', 'c', 'd']) {
    const r = run(d, { op: 'setArgument', node, name: 'msg', value: 'yo' })
    assertEquals(['a', 'b', 'c', 'd'].map((n) => args(r, n)), ['a', 'b', 'c', 'd'].map((n) => (n === node ? 'yo' : 'hi')), node)
    assertEquals(task(r, node).arguments.parameters, [{ name: 'msg', value: 'yo' }], 'the parameter keeps its name')
  }
  // A draft save writes a label and an annotation; `annotations: *lbl` must not make the label an annotation or the annotation a label.
  const draft = js(run(d, { op: 'stampDraft', expires: '2026-12-05T00:00:00Z' })).metadata
  assertEquals(draft.labels, { team: 'a', [DRAFT_LABEL]: 'true' })
  assertEquals(draft.annotations, { team: 'a', [DRAFT_EXPIRES_ANNOTATION]: '2026-12-05T00:00:00Z' })
  const dragged = js(run(d, { op: 'setPositions', positions: { a: { x: 1, y: 2 } } })).metadata
  assertEquals(dragged.labels, { team: 'a' })
  assertEquals(Object.keys(dragged.annotations), ['team', POSITIONS_ANNOTATION])
  // Removing the task that HOLDS the anchors leaves b and c whole.
  const removed = applyOp(d, { op: 'removeNode', node: 'a' }, opts).doc
  assertEquals(removed.errors, [])
  assertEquals(tasks(removed), [
    { name: 'b', template: 'echo', arguments: { parameters: [{ name: 'msg', value: 'hi' }] } },
    { template: 'echo', arguments: { parameters: [{ name: 'msg', value: 'hi' }] }, name: 'c', depends: 'b' },
    { template: 'echo', arguments: { parameters: [{ name: 'msg', value: 'hi' }] }, name: 'd' },
  ])
  // Disconnect on a task that merges another: the inherited keys stay, written out.
  const cut = run(d, { op: 'disconnect', source: 'a', target: 'c' })
  assertEquals(task(cut, 'c'), { template: 'echo', arguments: { parameters: [{ name: 'msg', value: 'hi' }] }, name: 'c', depends: 'b' })
  assertEquals(task(cut, 'a'), task(d, 'a'))
  // d INHERITS `depends: a` from b: cutting that edge removes it from d alone.
  const cutInherited = run(d, { op: 'disconnect', source: 'a', target: 'd' })
  assertEquals(task(cutInherited, 'd'), { template: 'echo', arguments: { parameters: [{ name: 'msg', value: 'hi' }] }, name: 'd' })
  assertEquals(task(cutInherited, 'b').depends, 'a')
  assertEquals(project(cutInherited, opts).edges.map((e) => e.id), ['a->b', 'a->c', 'b->c'])
  // …and an edge added to d does not appear on b.
  const joined = run(d, { op: 'connect', source: 'c', target: 'd' })
  assertEquals([task(joined, 'd').depends, task(joined, 'b').depends], ['a && c', 'a'])
  // A rename of the anchor holder: c keeps its own name and what it inherited, and now waits for the new name.
  const renamed = run(d, { op: 'rename', node: 'a', to: 'alpha' })
  assertEquals(tasks(renamed).map((t) => [t.name, t.template, t.depends]), [['alpha', 'echo', undefined], ['b', 'echo', 'alpha'], ['c', 'echo', 'alpha && b'], ['d', 'echo', 'alpha']])
  // A task that merged the renamed one has the keys written out, not an inline `<<:` map; the merge nobody touched is still a merge.
  assert(!renamed.source.includes('<<: *first') && !/<<:\s*\n/.test(renamed.source), renamed.source)
  // The expiry is written as a string in every YAML dialect.
  assert(run(d, { op: 'stampDraft', expires: '2026-12-05T00:00:00Z' }).source.includes(`${DRAFT_EXPIRES_ANNOTATION}: "2026-12-05T00:00:00Z"`))
})

Deno.test('publish is not skipped for a change only the cluster can see', () => {
  const d = parse(SMALL.source.replace('activeDeadlineSeconds: 600', 'activeDeadlineSeconds: 0600'))
  assertEquals(d.errors, [])
  assert(!sameContent(d, SMALL), '0600 and 600 are one number here and two to the API server')
})
