import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { parse } from './doc.ts'
import { allNodes, COL_GAP, diagnosticsFor, findNode, project } from './project.ts'
import { corpusText, platformCatalogue } from './testdata.ts'

/** §6.5: the canvas is a projection of the document — derived every time, never stored, always the same. */

const CATALOGUE = platformCatalogue()
const RELEASE = corpusText('handwritten/release-check.yaml')
const graph = (yaml: string) => project(parse(yaml), { catalogue: CATALOGUE })

Deno.test('a DAG entrypoint projects to nodes, typed by what they run', () => {
  const g = graph(RELEASE)
  assertEquals(g.resource, { kind: 'WorkflowTemplate', name: 'release-check', namespace: 'payments-dev' })
  assertEquals(g.entry, 'main')
  assert(g.editable)
  assertEquals(g.readOnly, undefined)
  assertEquals(g.nodes.map((n) => [n.id, n.kind]), [['build', 'container'], ['lint', 'script'], ['unit', 'container'], ['scan', 'http'], ['approve', 'approval'], ['tag', 'resource']])
  const approve = findNode(g, 'approve')!
  assertEquals(approve.template, { ref: { name: 'adhar-steps', template: 'approval', clusterScope: true } })
  assertEquals(approve.title, CATALOGUE.find((s) => s.ref.template === 'approval')!.title)
  assertEquals(approve.templatePath, undefined)
  const build = findNode(g, 'build')!
  assertEquals(build.template, { local: 'build' })
  assertEquals(build.path, ['spec', 'templates', 0, 'dag', 'tasks', 0])
  assertEquals(build.templatePath, ['spec', 'templates', 1])
  assertEquals(build.sharedBy, 0)
})

Deno.test('badges: when, retry, fan-out, hooks, expression', () => {
  const g = graph(RELEASE)
  const b = (id: string) => findNode(g, id)!.badges
  assertEquals(b('build'), { retry: 2 })
  assertEquals(b('unit'), { fanOut: 'items' })
  assertEquals(b('scan'), { when: '{{workflow.parameters.environment}} != dev' })
  assertEquals(b('approve'), { expression: true })
  assertEquals(b('tag'), { when: '{{tasks.approve.outputs.parameters.decision}} == approve', hooks: 1 })
  const more = graph(`apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata: {generateName: x-}
spec:
  entrypoint: main
  templates:
  - name: main
    dag:
      tasks:
      - {name: a, template: t, withParam: "{{workflow.parameters.list}}"}
      - {name: b, template: t, withSequence: {count: "3"}, continueOn: {failed: true}}
  - name: t
    activeDeadlineSeconds: 90
    suspend: {}
`)
  assertEquals(more.resource.name, 'x-')
  assertEquals(findNode(more, 'a')!.badges, { timeout: '90s', fanOut: 'param' })
  assertEquals(findNode(more, 'b')!.badges, { timeout: '90s', fanOut: 'sequence', continueOn: true })
  assertEquals(findNode(more, 'a')!.sharedBy, 1)
})

Deno.test('edges come from depends: one per term of a conjunction, dashed for an expression', () => {
  const g = graph(RELEASE)
  const into = (id: string) => g.edges.filter((e) => e.target === id).map((e) => [e.source, e.condition, e.bare ?? false])
  assertEquals(into('lint'), [['build', 'Succeeded', true]])
  assertEquals(into('unit'), [['build', 'Succeeded', false]])
  assertEquals(into('approve'), [['lint', 'Expression', false], ['unit', 'Expression', false], ['scan', 'Expression', false]])
  assertEquals(g.edges.find((e) => e.target === 'approve')!.expression, 'lint && unit && (scan.Succeeded || scan.Skipped)')
  assertEquals(new Set(g.edges.map((e) => e.id)).size, g.edges.length)
  const legacy = graph(corpusText('handwritten/legacy-dependencies.yaml'))
  assert(legacy.edges.length > 0)
  assert(legacy.edges.every((e) => e.legacy && e.condition === 'Succeeded'))
})

Deno.test('onExit is a lane of its own, keyed <template>/<task>', () => {
  const g = graph(RELEASE)
  assertEquals(g.exitLane?.template, 'exit-main')
  assertEquals(g.exitLane?.editable, true)
  assertEquals(g.exitLane?.nodes.map((n) => [n.uid, n.id, n.lane, n.dag]), [['exit-main/notify', 'notify', 'exit', 'exit-main']])
  assertEquals(allNodes(g).length, 7)
  // `announce` is used by the hook on `tag` and by the exit lane.
  assertEquals(g.templates.find((t) => t.name === 'announce')!.usedBy, ['exit-main/notify'])
  assertEquals(g.templates.map((t) => t.name), ['main', 'build', 'lint', 'unit', 'scan', 'tag', 'announce', 'exit-main'])
})

Deno.test('positions come from the annotation; a task without one is laid out', () => {
  const g = graph(RELEASE)
  assertEquals(findNode(g, 'approve')!.position, { x: 624, y: 116, fromAnnotation: true })
  assertEquals(findNode(g, 'exit-main/notify')!.position, { x: 0, y: 404, fromAnnotation: true })
  const bare = graph(RELEASE.replace(/^\s*adhar\.io\/designer-positions:.*\n/m, ''))
  assert(allNodes(bare).every((n) => !n.position.fromAnnotation))
  assertEquals(findNode(bare, 'build')!.position.x, 0)
  assertEquals(findNode(bare, 'lint')!.position.x, COL_GAP)
  assertEquals(findNode(bare, 'tag')!.position.x, 3 * COL_GAP)
  // The exit lane sits below everything in the main graph.
  const lowest = Math.max(...bare.nodes.map((n) => n.position.y))
  assert(findNode(bare, 'exit-main/notify')!.position.y > lowest)
  // A broken annotation is no positions, not an error.
  const broken = graph(RELEASE.replace(/(adhar\.io\/designer-positions:).*/, "$1 'not json'"))
  assert(allNodes(broken).every((n) => !n.position.fromAnnotation))
})

Deno.test('params read name, value, enum, description and secret references', () => {
  const g = graph(RELEASE)
  assertEquals(g.params.map((p) => [p.name, p.value, p.enum, p.description]), [
    ['revision', undefined, undefined, 'Git revision to check'],
    ['environment', 'dev', ['dev', 'test'], undefined],
    ['notify', 'on', undefined, undefined],
  ])
  assertEquals(g.params[1].path, ['spec', 'arguments', 'parameters', 1])
})

Deno.test('a steps entrypoint is read-only columns, one per parallel group', () => {
  const g = graph(corpusText('handwritten/steps-pipeline.yaml'))
  assertEquals(g.editable, false)
  assertEquals(g.readOnly, 'steps')
  assertEquals(g.nodes.map((n) => [n.id, n.column]), [['fetch', 0], ['test', 1], ['lint', 1], ['report', 2]])
  assertEquals(g.edges.map((e) => `${e.source}>${e.target}`), ['fetch>test', 'fetch>lint', 'test>report', 'lint>report'])
  assertEquals(findNode(g, 'test')!.badges.continueOn, true)
  assertEquals(findNode(g, 'lint')!.position, { x: COL_GAP, y: findNode(g, 'lint')!.position.y, fromAnnotation: false })
  assertEquals(findNode(g, 'fetch')!.sharedBy, 3)
})

Deno.test('a sub-flow is a group node holding its own graph; recursion is cut', () => {
  const g = graph(`apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata: {name: nested}
spec:
  entrypoint: main
  templates:
  - name: main
    dag:
      tasks:
      - {name: prepare, template: leaf}
      - {name: checks, depends: prepare, template: checks}
      - {name: again, template: main}
  - name: checks
    dag:
      tasks:
      - {name: a, template: leaf}
      - {name: b, depends: a.Failed, template: leaf}
  - name: leaf
    suspend: {}
`)
  const checks = findNode(g, 'checks')!
  assertEquals(checks.kind, 'subflow')
  assertEquals(checks.group?.template, 'checks')
  assertEquals(checks.group?.nodes.map((n) => n.uid), ['checks/a', 'checks/b'])
  assertEquals(checks.group?.edges.map((e) => [e.source, e.target, e.condition]), [['checks/a', 'checks/b', 'Failed']])
  assertEquals(findNode(g, 'again')!.group, { template: 'main', nodes: [], edges: [], recursive: true })
  assertEquals(allNodes(g).length, 3)
  assertEquals(allNodes(g, true).length, 5)
  assertEquals(findNode(g, 'checks/b')!.dag, 'checks')
})

Deno.test('what cannot be edited says why', () => {
  assertEquals(graph('kind: [oops\n').readOnly, 'yaml-errors')
  assertEquals(graph('kind: ConfigMap\napiVersion: v1\n').readOnly, 'not-a-workflow')
  assertEquals(graph(corpusText('handwritten/run-of-a-template.yaml')).readOnly, 'no-entry')
  const head = 'apiVersion: argoproj.io/v1alpha1\nkind: Workflow\nmetadata: {name: x}\nspec:\n'
  assertEquals(graph(`${head}  entrypoint: ghost\n  templates:\n  - {name: a, suspend: {}}\n`).readOnly, 'missing-entry')
  const leaf = graph(`${head}  entrypoint: a\n  onExit: bye\n  templates:\n  - {name: a, suspend: {duration: 5m}}\n  - {name: bye, suspend: {}}\n`)
  assertEquals(leaf.readOnly, 'leaf-entry')
  assertEquals(leaf.nodes.map((n) => [n.uid, n.kind]), [['a', 'timer']])
  assertEquals(leaf.exitLane?.nodes.map((n) => [n.uid, n.kind]), [['onExit/bye', 'suspend']])
  assertEquals(leaf.exitLane?.editable, false)
  for (const g of [graph('kind: [oops\n'), graph('kind: ConfigMap\n')]) assert(!g.editable && g.nodes.length === 0 && g.diagnostics.length > 0)
})

Deno.test('a CronWorkflow projects the workflow under spec.workflowSpec', () => {
  const g = graph(corpusText('handwritten/nightly-maintenance.yaml'))
  assertEquals(g.resource.kind, 'CronWorkflow')
  assert(g.editable)
  assert(g.nodes.length > 0)
  assertEquals(g.nodes[0].path.slice(0, 3), ['spec', 'workflowSpec', 'templates'])
})

Deno.test('diagnostics reach the node they are about, and every node sharing a broken template', () => {
  const g = graph(`apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata: {name: x}
spec:
  entrypoint: main
  activeDeadlineSeconds: 60
  templates:
  - name: main
    dag:
      tasks:
      - {name: a, template: bare}
      - {name: b, depends: a, continueOn: {failed: true}, template: bare}
      - {name: c, template: fine}
  - name: bare
    container: {image: docker.io/library/busybox:1}
  - name: fine
    suspend: {}
`)
  const of = (id: string) => diagnosticsFor(g, findNode(g, id)!).map((x) => x.code).sort()
  assertEquals(of('a'), ['platform/missing-resources'])
  assertEquals(of('b'), ['cel/continue-on-with-depends', 'platform/missing-resources'])
  assertEquals(of('c'), [])
})

Deno.test('the projection is deterministic and does not depend on the input object', () => {
  for (const f of ['handwritten/release-check.yaml', 'handwritten/steps-pipeline.yaml', 'handwritten/expression-depends.yaml', 'handwritten/anchors-and-flow.yaml']) {
    const text = corpusText(f)
    assertEquals(JSON.stringify(graph(text)), JSON.stringify(graph(text)), f)
  }
})

Deno.test('an empty steps group takes no column and does not cut the chain', () => {
  const g = graph(`apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata: {generateName: gaps-}
spec:
  entrypoint: main
  templates:
  - name: main
    steps:
    - - {name: a, template: e}
    - []
    - - {name: b, template: e}
      - {name: c, template: e}
    - []
    - []
    - - {name: d, template: e}
  - name: e
    suspend: {}
`)
  assertEquals(g.readOnly, 'steps')
  assertEquals(g.nodes.map((n) => [n.id, n.column]), [['a', 0], ['b', 1], ['c', 1], ['d', 2]])
  assertEquals(g.edges.map((e) => `${e.source}>${e.target}`), ['a>b', 'a>c', 'b>d', 'c>d'])
  assertEquals(findNode(g, 'd')!.position.x, 2 * COL_GAP)
})
