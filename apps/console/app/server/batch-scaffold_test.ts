import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { inferFamily, isBatchTemplate, templateFamilyOf } from './templates.ts'
import { applicationManifest, applicationTypeOf, applyApplication, DASHBOARD_TYPES, dashboardTypeOf, WORKLOAD_LABEL } from './control-plane.ts'
import { scaffoldWorkload } from './scaffolder.ts'

/* ───────────── a batch template is its own family (design 0025 §7.5) ───────────── */

Deno.test('batch templates: by label, by name, by tag', () => {
  assert(isBatchTemplate('nightly', [], { 'adhar.io/workload': 'batch' }))
  assert(isBatchTemplate('springboot-batch-job', []))
  assert(isBatchTemplate('springboot-batch-partitioned', ['java']))
  assert(isBatchTemplate('nightly-import', ['Batch']))
  assert(!isBatchTemplate('springboot-batchless-api', []))
  assert(!isBatchTemplate('springboot-web-service', ['java']))
})

Deno.test('batch templates: claimed before the regexes that would otherwise take them', () => {
  // `etl` is the `data` regex's word; `worker` and `service` are the backend regex's.
  assertEquals(inferFamily('nightly-import', ['batch', 'etl']), 'batch')
  assertEquals(inferFamily('springboot-batch-worker', ['java']), 'batch')
  assertEquals(inferFamily('springboot-batch-job', ['etl', 'pipeline']), 'batch')
  // What is not batch stays where it was.
  assertEquals(inferFamily('spark-etl', ['etl']), 'data')
  assertEquals(inferFamily('springboot-web-service', ['java']), 'service')
  assertEquals(inferFamily('function-go-service', ['function']), 'function')
})

Deno.test('adhar.io/workload: what a template declares beats what its name says', () => {
  assertEquals(inferFamily('orders-service', [], { 'adhar.io/workload': 'batch' }), 'batch')
  assertEquals(inferFamily('orders-service', [], { 'adhar.io/workload': 'function' }), 'function')
  // Only the two workloads the platform deploys differently.
  assertEquals(inferFamily('orders-service', [], { 'adhar.io/workload': 'something' }), 'service')
})

Deno.test('the family reads labels out of a parsed template.yaml', () => {
  assertEquals(templateFamilyOf({ metadata: { name: 'x-service', labels: { 'adhar.io/workload': 'batch' } } }), 'batch')
  assertEquals(templateFamilyOf({ metadata: { name: 'springboot-batch-job', tags: ['java', 'etl'] } }), 'batch')
})

Deno.test('a batch scaffold registers an Application of type batch', () => {
  assertEquals(applicationTypeOf(undefined, 'batch'), 'batch')
  assertEquals(applicationTypeOf('batch-jvm', 'batch'), 'batch')
  // A dashboard alone does not make a workload.
  assertEquals(applicationTypeOf('batch-jvm'), undefined)
  const m = applicationManifest({ name: 'importer', project: 'shop', repoUrl: 'http://gitea/x.git', workload: 'batch', dashboardType: 'batch-jvm' })
  assertEquals(m.spec.parameters.type, 'batch')
  assertEquals(m.metadata.labels[WORKLOAD_LABEL], 'batch')
  assertEquals(m.metadata.labels['adhar.io/dashboard-type'], 'batch-jvm')
})

Deno.test('the batch-jvm dashboard is a type a template may declare', () => {
  assert((DASHBOARD_TYPES as readonly string[]).includes('batch-jvm'))
  assertEquals(dashboardTypeOf({ metadata: { labels: { 'adhar.io/dashboard-type': 'batch-jvm' } } }), 'batch-jvm')
})

Deno.test('the template decides the workload; the wizard only when it cannot be read', () => {
  assertEquals(scaffoldWorkload({ metadata: { name: 'springboot-batch-job', tags: ['java'] } }), 'batch')
  assertEquals(scaffoldWorkload({ metadata: { name: 'x', labels: { 'adhar.io/workload': 'batch' } } }), 'batch')
  assertEquals(scaffoldWorkload(null, { templateId: 'springboot-batch-job', tags: [] }), 'batch')
  assertEquals(scaffoldWorkload({ metadata: { name: 'springboot-web-service' } }), undefined)
  assertEquals(scaffoldWorkload({ metadata: { name: 'function-go-service' } }), 'function')
})

Deno.test('an older control plane refusing type batch still gets the Application, labelled', async () => {
  const saved = globalThis.fetch
  const bodies: Array<{ spec: { parameters: Record<string, unknown> }; metadata: { labels: Record<string, string> } }> = []
  globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    return Promise.resolve(
      'type' in body.spec.parameters
        ? new Response(JSON.stringify({ message: 'spec.parameters.type: Unsupported value: "batch"' }), { status: 422 })
        : new Response('{}', { status: 200 }),
    )
  }) as typeof fetch
  try {
    const out = await applyApplication(applicationManifest({ name: 'importer', project: 'shop', repoUrl: 'http://gitea/x.git', workload: 'batch' }), 'token')
    assertEquals(out.ok, true)
    assertEquals(bodies.length, 2)
    assertEquals(bodies[1].metadata.labels[WORKLOAD_LABEL], 'batch')
  } finally {
    globalThis.fetch = saved
  }
})
