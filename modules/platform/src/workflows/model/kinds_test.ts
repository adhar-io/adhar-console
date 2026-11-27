import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { parse, toJS } from './doc.ts'
import { APPROVAL_REF, CATALOGUE_NODE_KINDS, catalogueSteps, fieldsFor, inferKind, KIND_LABELS, kindOfRef, kindOfTemplate, palette, paletteEntry, refOf, SCRIPT_PRESETS, stepEntry, TEMPLATE_TYPES, templateTypeOf } from './kinds.ts'
import { validate } from './validate.ts'
import { platformCatalogue } from './testdata.ts'

/** §6.6: the palette, what each entry compiles to, and how a task in somebody's YAML is recognised. */

const CATALOGUE = platformCatalogue()

Deno.test('the catalogue is read from the step libraries the platform ships', () => {
  assertEquals(CATALOGUE.map((s) => `${s.ref.name}/${s.ref.template}=${s.nodeKind}`), [
    'adhar-batch-steps/run=batch-job',
    'adhar-steps/approval=approval',
    'adhar-steps/http-check=http-check',
    'adhar-steps/k6-load=k6',
    'adhar-steps/wait-healthy=wait-healthy',
  ])
  for (const s of CATALOGUE) {
    assert(s.ref.clusterScope)
    assert(s.title && s.title !== s.ref.template, `${s.ref.template} has no title`)
    assert(CATALOGUE_NODE_KINDS[s.nodeKind], s.nodeKind)
  }
  const approval = CATALOGUE.find((s) => s.ref.template === 'approval')!
  assertEquals(approval.inputs.map((i) => i.name), ['question', 'approvers', 'timeout', 'forbidSelfApproval'])
  assertEquals(approval.outputs, ['decision', 'approver', 'comment'])
})

Deno.test('a library is a catalogue ClusterWorkflowTemplate with no entrypoint; unknown kinds are left out', () => {
  const cwt = (over: Record<string, unknown>, kind = 'http-check') => ({
    metadata: { name: 'lib', labels: { 'adhar.io/catalog': 'true' } },
    spec: { templates: [{ name: 't', metadata: { annotations: { 'adhar.io/node-kind': kind } }, inputs: { parameters: [{ name: 'url' }, { name: 'method', default: 'GET', enum: ['GET', 'HEAD'] }] } }] },
    ...over,
  })
  const [s] = catalogueSteps([cwt({})])
  assertEquals(s.inputs, [
    { name: 'url', default: undefined, enum: undefined, description: undefined, required: true },
    { name: 'method', default: 'GET', enum: ['GET', 'HEAD'], description: undefined, required: false },
  ])
  assertEquals(s.title, 't')
  assertEquals(catalogueSteps([cwt({ metadata: { name: 'lib' } })]), [])
  assertEquals(catalogueSteps([{ ...cwt({}), spec: { ...cwt({}).spec, entrypoint: 't' } }]), [])
  assertEquals(catalogueSteps([cwt({}, 'something-new')]), [])
  assertEquals(catalogueSteps([null, 'x', {}]), [])
})

Deno.test('a kind is inferred from what a task references, never stored', () => {
  const templates = new Map<string, unknown>([
    ['c', { container: {} }],
    ['s', { script: {} }],
    ['r', { resource: {} }],
    ['h', { http: {} }],
    ['d', { dag: { tasks: [] } }],
    ['st', { steps: [] }],
    ['cs', { containerSet: {} }],
    ['da', { data: {} }],
    ['p', { plugin: {} }],
    ['timer', { suspend: { duration: '5m' } }],
    ['gate', { suspend: {} }],
    ['ask', { suspend: { duration: '1h' }, outputs: { parameters: [{ name: 'd', valueFrom: { supplied: {} } }] } }],
    ['empty', {}],
  ])
  const kind = (task: unknown) => inferKind(task, templates, CATALOGUE)
  assertEquals(['c', 's', 'r', 'h', 'd', 'st', 'cs', 'da', 'p', 'timer', 'gate', 'ask', 'empty', 'missing'].map((t) => kind({ template: t })), [
    'container', 'script', 'resource', 'http', 'subflow', 'steps', 'container-set', 'data', 'plugin', 'timer', 'suspend', 'suspend', 'unknown', 'unknown',
  ])
  assertEquals(kind({ inline: { container: {} } }), 'inline')
  assertEquals(kind({ templateRef: { name: 'adhar-steps', template: 'approval', clusterScope: true } }), 'approval')
  assertEquals(kind({ templateRef: { name: 'adhar-steps', template: 'k6-load', clusterScope: true } }), 'platform-step')
  assertEquals(kind({ templateRef: { name: 'adhar-batch-steps', template: 'run', clusterScope: true } }), 'batch-job')
  // A namespaced template that happens to be called adhar-steps is just a template.
  assertEquals(kind({ templateRef: { name: 'adhar-steps', template: 'approval' } }), 'template')
  assertEquals(kind({ templateRef: { name: 'team-lib', template: 'x' } }), 'template')
  assertEquals(kind(null), 'unknown')
  // Without a catalogue the platform's library names still read correctly.
  assertEquals(kindOfRef(APPROVAL_REF), 'approval')
  assertEquals(kindOfRef({ name: 'adhar-steps', template: 'run-gameday', clusterScope: true }), 'chaos')
  assertEquals(kindOfRef({ name: 'adhar-steps', template: 'wait-healthy', clusterScope: true }), 'platform-step')
  assertEquals(refOf({ templateRef: { name: 'a' } }), undefined)
  assertEquals(templateTypeOf({ container: null, script: {} }), 'script')
  assertEquals(kindOfTemplate(undefined), 'unknown')
  assertEquals(TEMPLATE_TYPES.length, 10)
})

Deno.test('the palette offers the built-ins, the catalogue steps, and only what the cluster can do', () => {
  const ids = (p: ReturnType<typeof palette>) => p.map((e) => e.id)
  assertEquals(ids(palette()), ['container', 'script', 'resource', 'http', 'approval', 'timer', 'subflow', 'exit-handler', 'template'])
  assertEquals(ids(palette(CATALOGUE)), ['container', 'script', 'resource', 'http', 'approval', 'timer', 'subflow', 'exit-handler', 'template', 'step:adhar-steps/http-check', 'step:adhar-steps/k6-load', 'step:adhar-steps/wait-healthy'])
  assert(ids(palette(CATALOGUE, { batch: true })).includes('step:adhar-batch-steps/run'))
  assertEquals(paletteEntry('step:adhar-batch-steps/run', CATALOGUE)?.requires, 'batch')
  assertEquals(paletteEntry('nope'), undefined)
  // The cluster's approval replaces the built-in one, under the same id.
  const approval = palette(CATALOGUE).filter((e) => e.kind === 'approval')
  assertEquals(approval.length, 1)
  assertEquals(approval[0].ref, APPROVAL_REF)
  assertEquals(approval[0].title, CATALOGUE.find((s) => s.ref.template === 'approval')!.title)
  assertEquals(approval[0].fields.find((f) => f.param === 'approvers')?.control, 'approvers')
  assertEquals(approval[0].fields.find((f) => f.param === 'timeout')?.control, 'duration')
  for (const e of palette(CATALOGUE, { batch: true, gamedays: true })) {
    assert(e.title && e.baseName && /^[a-z][a-z0-9-]*$/.test(e.baseName), e.id)
    assertEquals(new Set(e.fields.map((f) => f.id)).size, e.fields.length, `${e.id} has duplicate field ids`)
  }
})

Deno.test('every local palette entry compiles to one template type and validates clean', () => {
  for (const e of palette().filter((p) => p.action === 'local')) {
    const body = e.template!()
    assert(body !== e.template!(), `${e.id} hands out the same object twice`)
    assertEquals(TEMPLATE_TYPES.filter((t) => body[t] !== undefined).length, 1, e.id)
    assertEquals(kindOfTemplate(body), e.kind, e.id)
    const doc = { apiVersion: 'argoproj.io/v1alpha1', kind: 'WorkflowTemplate', metadata: { name: 'x' }, spec: { entrypoint: 'main', activeDeadlineSeconds: 60, templates: [{ name: 'main', dag: { tasks: [{ name: 'a', template: 'a' }] } }, { name: 'a', ...body }] } }
    const found = validate(parse(JSON.stringify(doc))).filter((x) => x.level !== 'info')
    assertEquals(found.map((x) => x.code), [], e.id)
  }
  // New containers and scripts are non-root with resources set (§6.6).
  for (const id of ['container', 'script']) {
    const body = paletteEntry(id)!.template!()[id] as { resources: unknown; securityContext: { runAsNonRoot: boolean } }
    assert(body.resources)
    assertEquals(body.securityContext.runAsNonRoot, true)
  }
  assertEquals(Object.keys(SCRIPT_PRESETS), ['bash', 'python', 'node', 'deno'])
})

Deno.test('a platform step asks for exactly the inputs its template declares', () => {
  const http = CATALOGUE.find((s) => s.ref.template === 'http-check')!
  const e = stepEntry(http)
  assertEquals(e.ref, { name: 'adhar-steps', template: 'http-check', clusterScope: true })
  assertEquals(e.fields.map((f) => f.param), http.inputs.map((i) => i.name))
  assertEquals(e.arguments, http.inputs.filter((i) => i.required).map((i) => ({ name: i.name, value: '' })))
  assert(e.arguments!.some((a) => a.name === 'url'))
  const batch = stepEntry(CATALOGUE.find((s) => s.kind === 'batch-job')!)
  assertEquals(batch.fields[0].control, 'batchjob-picker')
})

Deno.test('the inspector shows the kind’s fields, then the task’s, then retries for a local leaf', () => {
  const ids = (k: Parameters<typeof fieldsFor>[0], ref?: Parameters<typeof fieldsFor>[1], local = false) => fieldsFor(k, ref, CATALOGUE, local).map((f) => f.id)
  assertEquals(ids('timer', undefined, true), ['duration', 'when', 'depends'])
  assertEquals(ids('http', undefined, true).slice(-4), ['when', 'depends', 'retries', 'deadline'])
  assert(ids('container', undefined, true).includes('resources'))
  assertEquals(ids('approval', APPROVAL_REF), ['arg:question', 'arg:approvers', 'arg:timeout', 'arg:forbidSelfApproval', 'when', 'depends'])
  assertEquals(fieldsFor('approval', APPROVAL_REF).map((f) => f.id), ['arg:question', 'arg:approvers', 'arg:timeout', 'arg:forbidSelfApproval', 'when', 'depends'])
  assertEquals(ids('template', { name: 'team-lib', template: 'x' }), ['when', 'depends'])
  assertEquals(ids('unknown'), ['when', 'depends'])
  for (const k of Object.keys(KIND_LABELS)) assert(KIND_LABELS[k as keyof typeof KIND_LABELS])
})

Deno.test('the corpus libraries parse to what the catalogue reads', () => {
  // A guard on the test support itself: the catalogue is not empty by accident.
  assert(CATALOGUE.length >= 5)
  assert(toJS(parse('a: 1')) !== null)
})
