import { assertEquals } from 'jsr:@std/assert'
import {
  ENTRY_TEMPLATE,
  findCycle,
  fromArgoSpec,
  layoutGraph,
  normaliseStepName,
  POSITIONS_ANNOTATION,
  type StepNode,
  templateNameFor,
  toArgoSpec,
  uniqueStepName,
  validateGraph,
  type WorkflowGraph,
} from './wf-model.ts'

/**
 * The conversion is the product; the canvas is a view of it. A designer that
 * cannot re-open what it wrote — or what someone edited in git — is a one-way
 * door people abandon, so round-tripping is what these tests mostly check.
 */

const step = (id: string, deps: string[] = [], over: Partial<StepNode> = {}): StepNode => ({
  id,
  label: id,
  image: 'alpine:3',
  command: `echo ${id}`,
  dependsOn: deps,
  x: 0,
  y: 0,
  ...over,
})

const graph = (steps: StepNode[], over: Partial<WorkflowGraph> = {}): WorkflowGraph => ({
  name: 'build-and-ship',
  namespace: 'ci',
  params: [],
  steps,
  ...over,
})

/* ─────────── names ─────────── */

Deno.test('step names are normalised to DNS-1123 labels', () => {
  assertEquals(normaliseStepName('Build & Test'), 'build-test')
  assertEquals(normaliseStepName('  __run__  '), 'run')
  assertEquals(normaliseStepName('UPPER'), 'upper')
})

Deno.test('normalising never leaves a leading or trailing dash', () => {
  // Argo rejects the whole object, and the error names the template rather
  // than the step the user was editing.
  assertEquals(normaliseStepName('-leading-'), 'leading')
  assertEquals(normaliseStepName(`${'a'.repeat(62)}-x`).endsWith('-'), false)
})

Deno.test('a duplicate name gets a suffix rather than overwriting', () => {
  assertEquals(uniqueStepName('build', []), 'build')
  assertEquals(uniqueStepName('build', ['build']), 'build-2')
  assertEquals(uniqueStepName('build', ['build', 'build-2']), 'build-3')
  assertEquals(uniqueStepName('Build Step!', ['build-step']), 'build-step-2')
})

Deno.test('a task and its template never share a name', () => {
  // Argo resolves `template:` against template names; a collision makes a
  // task reference itself.
  assertEquals(templateNameFor('build'), 'build-step')
  assertEquals(templateNameFor('build') === 'build', false)
})

/* ─────────── validation ─────────── */

Deno.test('a healthy graph has no problems', () => {
  assertEquals(validateGraph(graph([step('build'), step('test', ['build'])])), [])
})

Deno.test('an empty workflow is a problem', () => {
  assertEquals(validateGraph(graph([])).length, 1)
})

Deno.test('missing image or command are reported per step', () => {
  const problems = validateGraph(graph([step('build', [], { image: '', command: '' })]))
  assertEquals(problems.length, 2)
  assertEquals(problems.every((p) => p.step === 'build'), true)
})

Deno.test('a dependency on a step that does not exist is caught', () => {
  const problems = validateGraph(graph([step('test', ['build'])]))
  assertEquals(problems.some((p) => p.message.includes('not a step in this workflow')), true)
})

Deno.test('duplicate step names are caught', () => {
  const problems = validateGraph(graph([step('build'), step('build')]))
  assertEquals(problems.some((p) => p.message.includes('Two steps are called')), true)
})

Deno.test('a self-dependency is caught', () => {
  const problems = validateGraph(graph([step('build', ['build'])]))
  assertEquals(problems.some((p) => p.message.includes('cannot depend on itself')), true)
})

Deno.test('a dependency cycle is named, because Argo would just hang', () => {
  // Argo accepts a cyclic DAG and then never starts a task — the workflow
  // sits in Running with nothing explaining why.
  const problems = validateGraph(graph([step('a', ['c']), step('b', ['a']), step('c', ['b'])]))
  const cycle = problems.find((p) => p.message.includes('loop'))
  assertEquals(Boolean(cycle), true)
  assertEquals(cycle!.message.includes('→'), true)
})

Deno.test('findCycle returns the loop, and nothing for a DAG', () => {
  assertEquals(findCycle([step('a'), step('b', ['a'])]), null)
  const loop = findCycle([step('a', ['b']), step('b', ['a'])])
  assertEquals(loop !== null, true)
  assertEquals(loop!.length >= 2, true)
})

Deno.test('a diamond is not a cycle', () => {
  // The shape every real pipeline has; a naive visited-set would flag it.
  const steps = [step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])]
  assertEquals(findCycle(steps), null)
  assertEquals(validateGraph(graph(steps)), [])
})

/* ─────────── graph → Argo ─────────── */

Deno.test('the DAG references generated templates and sorted dependencies', () => {
  const spec = toArgoSpec(graph([step('build'), step('test', ['build'])]))
  const templates = (spec.spec as { templates: Array<Record<string, unknown>> }).templates
  const entry = templates.find((t) => t.name === ENTRY_TEMPLATE)!
  const tasks = (entry.dag as { tasks: Array<Record<string, unknown>> }).tasks
  assertEquals(tasks.map((t) => t.name), ['build', 'test'])
  assertEquals(tasks[0].template, 'build-step')
  // Sorted so a reordered canvas produces an identical spec — otherwise
  // every drag shows up as a diff.
  assertEquals(tasks[1].dependencies, ['build'])
  assertEquals('dependencies' in tasks[0], false)
})

Deno.test('a step becomes a container template running sh -c', () => {
  const spec = toArgoSpec(graph([step('build', [], { command: 'make build && make test' })]))
  const templates = (spec.spec as { templates: Array<Record<string, unknown>> }).templates
  const tpl = templates.find((t) => t.name === 'build-step')!
  const c = tpl.container as Record<string, unknown>
  assertEquals(c.image, 'alpine:3')
  assertEquals(c.command, ['sh', '-c'])
  assertEquals(c.args, ['make build && make test'])
})

Deno.test('positions ride in an annotation Argo ignores', () => {
  const spec = toArgoSpec(graph([step('build', [], { x: 120.4, y: 60.6 })]))
  const meta = spec.metadata as Record<string, unknown>
  const positions = JSON.parse((meta.annotations as Record<string, string>)[POSITIONS_ANNOTATION])
  assertEquals(positions.build, [120, 61])
})

Deno.test('generateName is used for a run, a fixed name for a template', () => {
  const run = toArgoSpec(graph([step('a')]), { generateName: true })
  assertEquals((run.metadata as Record<string, unknown>).generateName, 'build-and-ship-')
  const tpl = toArgoSpec(graph([step('a')]), { kind: 'WorkflowTemplate' })
  assertEquals(tpl.kind, 'WorkflowTemplate')
  assertEquals((tpl.metadata as Record<string, unknown>).name, 'build-and-ship')
})

Deno.test('workflow parameters and service account carry through', () => {
  const spec = toArgoSpec(
    graph([step('a')], { params: [{ name: 'tag', value: 'v1' }], serviceAccountName: 'argo-runner' }),
  )
  const s = spec.spec as Record<string, unknown>
  assertEquals(s.serviceAccountName, 'argo-runner')
  assertEquals((s.arguments as { parameters: unknown[] }).parameters, [{ name: 'tag', value: 'v1' }])
})

Deno.test('env and when survive the conversion', () => {
  const spec = toArgoSpec(graph([step('a', [], { env: { LOG: 'debug' }, when: '{{workflow.parameters.tag}} != ""' })]))
  const templates = (spec.spec as { templates: Array<Record<string, unknown>> }).templates
  const tasks = (templates[0].dag as { tasks: Array<Record<string, unknown>> }).tasks
  assertEquals(tasks[0].when, '{{workflow.parameters.tag}} != ""')
  const c = templates.find((t) => t.name === 'a-step')!.container as Record<string, unknown>
  assertEquals(c.env, [{ name: 'LOG', value: 'debug' }])
})

/* ─────────── round trip ─────────── */

Deno.test('a graph survives a round trip unchanged', () => {
  const original = graph(
    [
      step('build', [], { x: 100, y: 60, label: 'Build image' }),
      step('test', ['build'], { x: 100, y: 190 }),
      step('publish', ['test'], { x: 100, y: 320, env: { REGISTRY: 'harbor' } }),
    ],
    { params: [{ name: 'tag', value: 'v1' }], serviceAccountName: 'argo-runner' },
  )
  const back = fromArgoSpec(toArgoSpec(original))!
  assertEquals(back.name, original.name)
  assertEquals(back.namespace, original.namespace)
  assertEquals(back.params, original.params)
  assertEquals(back.serviceAccountName, original.serviceAccountName)
  assertEquals(back.steps.map((s) => s.id), ['build', 'test', 'publish'])
  assertEquals(back.steps[0].label, 'Build image')
  assertEquals(back.steps[1].dependsOn, ['build'])
  assertEquals(back.steps[2].env, { REGISTRY: 'harbor' })
  assertEquals(back.steps.map((s) => [s.x, s.y]), [[100, 60], [100, 190], [100, 320]])
})

Deno.test('a hand-written workflow opens, even without designer conventions', () => {
  // No `-step` naming, no positions annotation, inline argv rather than sh -c.
  // A designer that only reads its own output is one nobody can adopt.
  const handWritten = {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Workflow',
    metadata: { name: 'nightly', namespace: 'data' },
    spec: {
      entrypoint: 'pipeline',
      templates: [
        { name: 'pipeline', dag: { tasks: [{ name: 'extract', template: 'run' }, { name: 'load', template: 'run', dependencies: ['extract'] }] } },
        { name: 'run', container: { image: 'python:3.12', command: ['python'], args: ['-m', 'etl'] } },
      ],
    },
  }
  const g = fromArgoSpec(handWritten)!
  assertEquals(g.name, 'nightly')
  assertEquals(g.steps.map((s) => s.id), ['extract', 'load'])
  assertEquals(g.steps[0].image, 'python:3.12')
  // Not `sh -c`, so the argv is shown verbatim rather than silently rewritten.
  assertEquals(g.steps[0].command, 'python -m etl')
  // No saved positions, so it was laid out rather than stacked at the origin.
  assertEquals(g.steps.some((s) => s.y !== 0), true)
})

Deno.test('a corrupt positions annotation does not stop the workflow opening', () => {
  const spec = toArgoSpec(graph([step('a')]))
  ;((spec.metadata as Record<string, unknown>).annotations as Record<string, string>)[POSITIONS_ANNOTATION] = '{not json'
  assertEquals(fromArgoSpec(spec)?.steps.length, 1)
})

Deno.test('a steps-style workflow is refused rather than mangled', () => {
  // `steps:` is a different model this canvas does not represent; opening it
  // as an empty DAG would look like the designer had eaten the workflow.
  const stepsStyle = {
    metadata: { name: 'x', namespace: 'y' },
    spec: { entrypoint: 'main', templates: [{ name: 'main', steps: [[{ name: 'a', template: 'run' }]] }] },
  }
  assertEquals(fromArgoSpec(stepsStyle), null)
})

/* ─────────── layout ─────────── */

Deno.test('layout puts each step below its deepest dependency', () => {
  const laid = layoutGraph([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])])
  const y = (id: string) => laid.find((s) => s.id === id)!.y
  assertEquals(y('a') < y('b'), true)
  assertEquals(y('b'), y('c'))
  // Longest path: d is below BOTH b and c, not beside them.
  assertEquals(y('d') > y('b'), true)
})

Deno.test('a long chain does not cut back across the canvas', () => {
  const laid = layoutGraph([step('a'), step('b', ['a']), step('c', ['a', 'b'])])
  const y = (id: string) => laid.find((s) => s.id === id)!.y
  // c depends on both a and b; it must sit under b, not beside it.
  assertEquals(y('c') > y('b'), true)
})

Deno.test('layout terminates on a cycle instead of hanging', () => {
  // Cycles are reported by validateGraph; layout must not recurse forever.
  const laid = layoutGraph([step('a', ['b']), step('b', ['a'])])
  assertEquals(laid.length, 2)
})
