import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { parse } from './doc.ts'
import type { Diagnostic } from './validate.ts'
import { ALLOWED_REGISTRIES, findCycle, hasErrors, isCanvasEditable, looksSecret, registryOf, RULES, taskRefs, validate } from './validate.ts'
import upstream from './corpus/upstream-cel-rules.json' with { type: 'json' }

/**
 * §6.7 level A, and W2 acceptance 3: every CEL rule Argo's full CRD carries is
 * mirrored here, and every mirrored rule has a fixture that FAILS it. The
 * platform installs the minimal CRDs, so nothing else refuses these documents
 * before they run.
 */

const wt = (spec: string, kind = 'WorkflowTemplate') => `apiVersion: argoproj.io/v1alpha1
kind: ${kind}
metadata:
  name: fixture
spec:
${spec.replace(/^\n/, '').replace(/\s+$/, '').split('\n').map((l) => '  ' + l).join('\n')}
`

const LEAF = `- name: echo
  container:
    image: docker.io/library/busybox:1.37
    resources: {requests: {cpu: 100m, memory: 64Mi}}`

const indent = (s: string, n: number) => s.split('\n').map((l) => ' '.repeat(n) + l).join('\n')

/** A workflow around one DAG: `tasks` are the task list items, `extra` more templates, `head` more spec fields. */
const dag = (tasks: string, extra = '', head = '') =>
  wt(`entrypoint: main
activeDeadlineSeconds: 600
${head}
templates:
- name: main
  dag:
    tasks:
${indent(tasks, 4)}
${LEAF}
${extra}`.replace(/\n\n+/g, '\n'))

const GOOD = dag(`- name: a
  template: echo
- name: b
  depends: a
  template: echo`)

const codes = (yaml: string, opts = {}): string[] => {
  const d = parse(yaml)
  assertEquals(d.errors, [], yaml)
  return validate(d, opts).map((x) => x.code)
}
const diag = (yaml: string, code: string): Diagnostic => {
  const found = validate(parse(yaml)).find((x) => x.code === code)
  assert(found, `expected ${code} in:\n${yaml}\ngot ${JSON.stringify(codes(yaml))}`)
  return found
}

const many = (n: number, item: (i: number) => string) => Array.from({ length: n }, (_, i) => item(i)).join('\n')

/** One document per mirrored CEL rule that Argo's full CRD would refuse. */
const CEL_FIXTURES: Record<string, string> = {
  'cel/dag-max-tasks': dag(many(201, (i) => `- {name: t${i}, template: echo}`)),
  'cel/max-templates': dag('- {name: a, template: echo}', many(200, (i) => `- {name: extra${i}, suspend: {}}`)),
  'cel/max-parameters': dag('- {name: a, template: echo}', `- name: wide\n  suspend: {}\n  inputs:\n    parameters:\n${many(501, (i) => `    - {name: p${i}}`)}`),
  'cel/max-prometheus-metrics': dag('- {name: a, template: echo}', '', `metrics:\n  prometheus:\n${many(101, (i) => `  - {name: m${i}, help: h, counter: {value: "1"}}`)}`),
  'cel/task-name-digit': dag(`- name: a
  template: echo
- name: 2nd
  depends: a
  template: echo`),
  'cel/depends-and-dependencies': dag(`- name: a
  template: echo
- name: b
  depends: a
  dependencies: [a]
  template: echo`),
  'cel/continue-on-with-depends': dag(`- name: a
  template: echo
- name: b
  depends: a
  continueOn: {failed: true}
  template: echo`),
  'cel/one-template-type': dag('- {name: a, template: both}', `- name: both
  container:
    image: docker.io/library/busybox:1.37
    resources: {requests: {cpu: 100m}}
  suspend: {}`),
  'cel/timeout-on-steps-or-dag': dag('- {name: a, template: inner}', `- name: inner
  timeout: 5m
  steps:
  - - {name: s, template: echo}`),
  'cel/active-deadline-leaf-only': dag('- {name: a, template: inner}', `- name: inner
  activeDeadlineSeconds: 60
  dag:
    tasks:
    - {name: s, template: echo}`),
  'cel/one-artifact-location': dag('- {name: a, template: fetch}', `- name: fetch
  inputs:
    artifacts:
    - name: src
      path: /src
      git: {repo: https://example.com/x.git}
      http: {url: https://example.com/x.tgz}
  suspend: {}`),
  'cel/sequence-count-or-end': dag(`- name: a
  template: echo
  withSequence: {count: "3", end: "5"}`),
  'cel/manifest-or-manifest-from': dag('- {name: a, template: apply}', `- name: apply
  resource:
    action: apply
    manifest: "kind: ConfigMap"
    manifestFrom: {artifact: {name: m}}`),
  'cel/realtime-resources-duration': dag('- {name: a, template: echo}', '', `metrics:
  prometheus:
  - name: cpu
    help: h
    gauge: {realtime: true, value: "{{workflow.resourcesDuration.cpu}}"}`),
}

Deno.test('the base fixture is clean', () => {
  assertEquals(codes(GOOD), [])
})

Deno.test('every CEL rule in the pinned full CRD is mirrored by a rule here', () => {
  const mirrored = new Set(RULES.filter((r) => r.group === 'cel').map((r) => r.mirrors))
  for (const v of upstream.validations) assert(mirrored.has(v.message), `no rule mirrors the upstream CEL rule: ${v.message}`)
  // List ceilings: the four distinct lists the CRD caps.
  const ceilings: Record<string, string> = {
    'inputs.parameters': 'maxItems inputs.parameters',
    'metrics.prometheus': 'maxItems metrics.prometheus',
    'spec.templates': 'maxItems templates',
    'workflowSpec.templates': 'maxItems templates',
    'templateDefaults.dag.tasks': 'maxItems dag.tasks',
    'templates[].dag.tasks': 'maxItems dag.tasks',
  }
  for (const m of upstream.maxItems) {
    assert(ceilings[m.field], `no rule mirrors the upstream ceiling on ${m.field}`)
    assert(mirrored.has(ceilings[m.field]), ceilings[m.field])
  }
  assertEquals(Object.fromEntries(upstream.maxItems.map((m) => [m.field, m.max])), {
    'inputs.parameters': 500,
    'metrics.prometheus': 100,
    'spec.templates': 200,
    'workflowSpec.templates': 200,
    'templateDefaults.dag.tasks': 200,
    'templates[].dag.tasks': 200,
  })
  // And no rule claims to mirror something upstream does not have.
  const known = new Set([...upstream.validations.map((v) => v.message), ...Object.values(ceilings)])
  for (const r of RULES.filter((r) => r.group === 'cel')) assert(r.mirrors && known.has(r.mirrors), `${r.code} mirrors nothing in the pinned CRD`)
})

Deno.test('every mirrored CEL rule has a failing fixture', () => {
  const cel = RULES.filter((r) => r.group === 'cel').map((r) => r.code).sort()
  assertEquals(Object.keys(CEL_FIXTURES).sort(), cel)
})

for (const [code, yaml] of Object.entries(CEL_FIXTURES)) {
  Deno.test(`fails ${code}`, () => {
    const x = diag(yaml, code)
    assertEquals(x.level, 'error')
    assertEquals(x.source, 'client')
    assert(x.range, `${code} has no place in the YAML`)
    // The fixture breaks this rule and no other CEL rule.
    assertEquals(codes(yaml).filter((c) => c.startsWith('cel/')), [code])
    assert(hasErrors(validate(parse(yaml))))
  })
}

Deno.test('the ceilings sit exactly where the CRD puts them', () => {
  assert(!codes(dag(many(200, (i) => `- {name: t${i}, template: echo}`))).includes('cel/dag-max-tasks'))
  assert(codes(dag(many(200, (i) => `- {name: t${i}, template: echo}`))).includes('platform/large-dag'))
  assert(!codes(dag('- {name: a, template: echo}', many(198, (i) => `- {name: extra${i}, suspend: {}}`))).includes('cel/max-templates'))
  assert(!codes(dag('- {name: a, template: echo}', `- name: wide\n  suspend: {}\n  inputs:\n    parameters:\n${many(500, (i) => `    - {name: p${i}}`)}`)).includes('cel/max-parameters'))
})

Deno.test('the CEL rules hold where upstream scopes them, and not beyond', () => {
  // A digit-first name is fine on a task with no dependencies.
  assert(!codes(dag('- {name: 1st, template: echo}')).includes('cel/task-name-digit'))
  assert(codes(dag('- {name: a, template: echo}\n- {name: 2nd, dependencies: [a], template: echo}')).includes('cel/task-name-digit'))
  // continueOn with legacy dependencies is allowed.
  assert(!codes(dag('- {name: a, template: echo}\n- {name: b, dependencies: [a], continueOn: {failed: true}, template: echo}')).includes('cel/continue-on-with-depends'))
  // An empty timeout on a DAG is not a timeout (upstream: `t.timeout != ""`).
  assert(!codes(dag('- {name: a, template: inner}', '- name: inner\n  timeout: ""\n  dag:\n    tasks:\n    - {name: s, template: echo}')).includes('cel/timeout-on-steps-or-dag'))
  // realtime: false may read resourcesDuration.
  assert(!codes(dag('- {name: a, template: echo}', '', 'metrics:\n  prometheus:\n  - {name: cpu, help: h, gauge: {realtime: false, value: "{{workflow.resourcesDuration.cpu}}"}}')).includes('cel/realtime-resources-duration'))
  // Artifact locations are counted on outputs and arguments too.
  assert(codes(dag('- name: a\n  template: echo\n  arguments:\n    artifacts:\n    - {name: x, s3: {key: k}, raw: {data: d}}')).includes('cel/one-artifact-location'))
  // A CronWorkflow keeps its templates under workflowSpec.
  const cron = wt(`schedules: ["0 2 * * *"]
workflowSpec:
  entrypoint: main
  activeDeadlineSeconds: 600
  templates:
  - name: main
    timeout: 1h
    dag:
      tasks:
      - {name: a, template: echo}
${indent(LEAF, 2)}`, 'CronWorkflow')
  const x = diag(cron, 'cel/timeout-on-steps-or-dag')
  assertEquals(x.path, ['spec', 'workflowSpec', 'templates', 0, 'timeout'])
})

Deno.test('a diagnostic names its task, its template and its place in the text', () => {
  const yaml = CEL_FIXTURES['cel/continue-on-with-depends']
  const x = diag(yaml, 'cel/continue-on-with-depends')
  assertEquals(x.task, { dag: 'main', name: 'b', uid: 'b' })
  assertEquals(x.path, ['spec', 'templates', 0, 'dag', 'tasks', 1, 'continueOn'])
  assertEquals(yaml.slice(x.range!.start, x.range!.end), 'continueOn')
  const t = diag(CEL_FIXTURES['cel/one-template-type'], 'cel/one-template-type')
  assertEquals(t.template, 'both')
  assertEquals(CEL_FIXTURES['cel/one-template-type'].slice(t.range!.start, t.range!.end), 'suspend')
})

/* ───────── v4 semantics ───────── */

Deno.test('v4: schedule (singular) and synchronization.mutex/semaphore are refused', () => {
  const cron = (field: string) => wt(`${field}\nworkflowSpec:\n  entrypoint: main\n  activeDeadlineSeconds: 60\n  templates:\n  - name: main\n    suspend: {}`, 'CronWorkflow')
  assertEquals(diag(cron('schedule: "0 2 * * *"'), 'v4/cron-schedule').level, 'error')
  assert(!codes(cron('schedules: ["0 2 * * *"]')).includes('v4/cron-schedule'))
  assert(codes(dag('- {name: a, template: echo}', '', 'synchronization: {mutex: {name: m}}')).includes('v4/synchronization-singular'))
  assert(codes(dag('- {name: a, template: lock}', '- name: lock\n  synchronization: {semaphore: {configMapKeyRef: {name: c, key: k}}}\n  suspend: {}')).includes('v4/synchronization-singular'))
  assert(!codes(dag('- {name: a, template: echo}', '', 'synchronization: {mutexes: [{name: m}]}')).includes('v4/synchronization-singular'))
})

Deno.test('v4: an output read from a task that can be skipped needs a default', () => {
  const producer = (def: string) => `- name: produce
  container:
    image: docker.io/library/busybox:1.37
    resources: {requests: {cpu: 100m}}
  outputs:
    parameters:
    - name: out
      valueFrom: {path: /tmp/out${def}}`
  const tasks = (when: string) => `- name: gate
  template: echo
- name: p
  depends: gate
${when}  template: produce
- name: c
  depends: p
  template: echo
  arguments:
    parameters:
    - {name: v, value: "{{tasks.p.outputs.parameters.out}}"}`
  const x = diag(dag(tasks('  when: "{{workflow.parameters.go}} == yes"\n'), producer('')), 'v4/skipped-output-default')
  assertEquals(x.level, 'warning')
  assertEquals(x.template, 'produce')
  assertEquals(x.task?.name, 'p')
  // With a default it is fine; with no `when` anywhere it is fine.
  assert(!codes(dag(tasks('  when: "{{workflow.parameters.go}} == yes"\n'), producer(', default: none'))).includes('v4/skipped-output-default'))
  assert(!codes(dag(tasks(''), producer(''))).includes('v4/skipped-output-default'))
  // Downstream of a conditional counts as skippable.
  const downstream = `- name: gate
  when: "{{workflow.parameters.go}} == yes"
  template: echo
- name: p
  depends: gate
  template: produce
- name: c
  depends: p
  template: echo
  arguments:
    parameters:
    - {name: v, value: "{{tasks.p.outputs.parameters.out}}"}`
  assert(codes(dag(downstream, producer(''))).includes('v4/skipped-output-default'))
})

/* ───────── graph ───────── */

Deno.test('graph: cycles, unknown dependencies, dangling and undeclared reads', () => {
  const cyc = diag(dag('- {name: a, depends: c, template: echo}\n- {name: b, depends: a, template: echo}\n- {name: c, depends: b, template: echo}'), 'graph/cycle')
  assert(cyc.message.includes('a → b → c → a'), cyc.message)
  assertEquals(findCycle(['a', 'b'], [{ source: 'a', target: 'b' }]), null)
  assertEquals(findCycle(['a', 'b'], [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]), ['a', 'b', 'a'])
  assert(codes(dag('- {name: a, depends: ghost, template: echo}')).includes('graph/unknown-dependency'))
  assert(codes(dag('- {name: a, dependencies: [ghost], template: echo}')).includes('graph/unknown-dependency'))
  assert(codes(dag('- {name: a, depends: "b &&", template: echo}\n- {name: b, template: echo}')).includes('depends/syntax'))
  const read = (dep: string, ref: string) => dag(`- {name: build, template: echo}\n- name: use\n${dep}  template: echo\n  arguments:\n    parameters:\n    - {name: v, value: "{{tasks.${ref}.outputs.result}}"}`)
  assert(codes(read('  depends: build\n', 'ghost')).includes('graph/dangling-task-reference'))
  assert(codes(read('', 'build')).includes('graph/reference-without-dependency'))
  assertEquals(codes(read('  depends: build\n', 'build')), [])
  // Transitive dependencies count.
  assertEquals(codes(dag(`- {name: a, template: echo}\n- {name: b, depends: a, template: echo}\n- name: c\n  depends: b\n  template: echo\n  when: "{{tasks.a.outputs.result}} == ok"`)), [])
  assertEquals(taskRefs("{{tasks.a.outputs.result}} {{=tasks['b-1'].outputs.result}} subtasks.c.x tasks.d"), ['a', 'b-1'])
})

Deno.test('graph: targets, templates and names', () => {
  const target = dag('- {name: a, template: echo}\n- {name: b, depends: a, template: echo}\n- {name: stray, template: echo}').replace('      tasks:', '      target: b\n      tasks:')
  const unreachable = validate(parse(target)).filter((x) => x.code === 'graph/unreachable-task')
  assertEquals(unreachable.map((x) => x.task?.name), ['stray'])
  assert(codes(dag('- {name: a, template: ghost}')).includes('graph/missing-template'))
  assert(codes(dag('- {name: a}')).includes('graph/task-without-template'))
  assert(!codes(dag('- {name: a, templateRef: {name: lib, template: t}}')).includes('graph/task-without-template'))
  assert(codes(dag('- {name: a, template: echo}\n- {name: a, template: echo}')).includes('graph/duplicate-name'))
  assert(codes(dag('- {name: a, template: echo}', LEAF)).includes('graph/duplicate-name'))
  assert(codes(dag('- {name: bad_name, template: echo}')).includes('graph/invalid-name'))
  assertEquals(diag(dag('- {name: a, template: echo}', '- name: spare\n  suspend: {}'), 'graph/unused-template').level, 'info')
  assert(codes(GOOD.replace('entrypoint: main', 'entrypoint: nope')).includes('graph/missing-template'))
  // A template used only by onExit or a hook is used.
  assert(!codes(dag('- {name: a, template: echo}', '- name: bye\n  suspend: {}', 'onExit: bye')).includes('graph/unused-template'))
  assert(!codes(dag('- name: a\n  template: echo\n  hooks:\n    exit: {template: bye}', '- name: bye\n  suspend: {}')).includes('graph/unused-template'))
})

/* ───────── platform hints ───────── */

Deno.test('platform: resources, registries, identities, secrets, splicing, deadlines', () => {
  const leaf = (body: string) => dag('- {name: a, template: t}', `- name: t\n${indent(body, 2)}`)
  assert(codes(leaf('container:\n  image: docker.io/library/busybox:1.37')).includes('platform/missing-resources'))
  assert(codes(leaf('script:\n  image: docker.io/library/python:3.13\n  source: print(1)')).includes('platform/missing-resources'))
  const ok = 'resources: {limits: {cpu: 1}}'
  assert(codes(leaf(`container:\n  image: evil.example.com/x:1\n  ${ok}`)).includes('platform/image-registry'))
  for (const image of ['nginx:1.27', 'harbor.adhar.localtest.me/team/app:1', 'ghcr.io/acme/x:1', '{{inputs.parameters.image}}', 'localhost:5000/x']) {
    assertEquals(codes(leaf(`container:\n  image: "${image}"\n  ${ok}`)).includes('platform/image-registry'), image.startsWith('localhost'), image)
  }
  assertEquals(codes(leaf(`container:\n  image: evil.example.com/x:1\n  ${ok}`), { allowedRegistries: ['evil.example.com', 'docker.io'] }), ['graph/unused-template'])
  assertEquals(registryOf('nginx'), 'docker.io')
  assertEquals(registryOf('library/nginx:1'), 'docker.io')
  assertEquals(registryOf('localhost:5000/x'), 'localhost:5000')
  assertEquals(registryOf('quay.io/a/b@sha256:abc'), 'quay.io')
  assertEquals(registryOf('{{x}}'), undefined)
  assert(ALLOWED_REGISTRIES.includes('ghcr.io'))

  const sa = diag(dag('- {name: a, template: echo}', '', 'serviceAccountName: adhar-gameday'), 'platform/reserved-service-account')
  assertEquals(sa.level, 'error')
  assert(codes(leaf(`serviceAccountName: adhar-release\nsuspend: {}`)).includes('platform/reserved-service-account'))
  assert(!codes(dag('- {name: a, template: echo}', '', 'serviceAccountName: adhar-workflow')).includes('platform/reserved-service-account'))

  assert(codes(dag('- {name: a, template: echo}', '', 'arguments:\n  parameters:\n  - {name: dbPassword, value: hunter2}')).includes('platform/secret-parameter'))
  assert(!codes(dag('- {name: a, template: echo}', '', 'arguments:\n  parameters:\n  - {name: keyspace, value: x}\n  - {name: monkey, value: y}')).includes('platform/secret-parameter'))
  for (const n of ['password', 'api-key', 'API_TOKEN', 'dbPassword', 'client.secret']) assert(looksSecret(n), n)
  for (const n of ['keyspace', 'monkey', 'passes', 'tokenizer', 'name']) assert(!looksSecret(n), n)

  assert(codes(leaf(`script:\n  image: docker.io/library/bash:5\n  ${ok}\n  source: "echo {{inputs.parameters.msg}}"`)).includes('platform/parameter-in-script'))
  assert(!codes(leaf(`script:\n  image: docker.io/library/bash:5\n  ${ok}\n  source: "echo $PARAM_MSG"`)).includes('platform/parameter-in-script'))
  assertEquals(diag(leaf(`container:\n  image: docker.io/library/busybox:1\n  ${ok}\n  args: ["{{workflow.parameters.x}}"]`), 'platform/parameter-in-args').level, 'info')

  assertEquals(diag(GOOD.replace('  activeDeadlineSeconds: 600\n', ''), 'platform/no-deadline').level, 'info')
  assert(codes(GOOD.replace('activeDeadlineSeconds: 600', 'activeDeadlineSeconds: 90000')).includes('platform/deadline-too-long'))
})

/* ───────── documents ───────── */

Deno.test('documents that are not workflows, or do not parse, say so and nothing else', () => {
  assertEquals(codes('kind: ConfigMap\napiVersion: v1\n'), ['doc/not-a-workflow'])
  assertEquals(codes(''), ['doc/not-a-workflow'])
  assertEquals(codes(GOOD.replace('argoproj.io/v1alpha1', 'argoproj.io/v1')), ['doc/not-a-workflow'])
  const broken = validate(parse('kind: Workflow\nspec: [1, 2\n'))
  assertEquals([...new Set(broken.map((x) => x.code))], ['yaml/syntax'])
  assert(broken[0].range)
  // A step library (no entrypoint) is a valid thing to open.
  assertEquals(codes(GOOD.replace('  entrypoint: main\n', '')), [])
})

Deno.test('every rule has a unique code and every diagnostic uses a declared rule', () => {
  assertEquals(new Set(RULES.map((r) => r.code)).size, RULES.length)
  const declared = new Map(RULES.map((r) => [r.code, r.level]))
  for (const yaml of [GOOD, ...Object.values(CEL_FIXTURES)]) {
    for (const x of validate(parse(yaml))) assertEquals(x.level, declared.get(x.code), x.code)
  }
})

Deno.test('the canvas edits a conjunction; anything else is text', () => {
  assert(isCanvasEditable(undefined))
  assert(isCanvasEditable('a && b.Failed'))
  assert(!isCanvasEditable('a || b'))
})
