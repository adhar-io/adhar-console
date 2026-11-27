import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@^1.0.0'
import { buildResubmit, buildRun, catalogEntries, entryOf, homeOf, isSecretLike, paramSpecs, runStats, type TemplateObject, validateRun } from './catalog.ts'
import type { Workflow } from './nodes.ts'

/** The catalogue and the run form of design 0026 §6.9, and the Workflow a submit creates (§6.3). */

const WT: TemplateObject = {
  kind: 'WorkflowTemplate',
  metadata: {
    name: 'db-migration-check',
    namespace: 'shop-dev',
    labels: { 'adhar.io/team': 'payments', 'adhar.io/catalog-tags': 'db,release' },
    annotations: {
      'workflows.argoproj.io/title': 'DB migration check',
      'workflows.argoproj.io/description': 'Dry-runs pending migrations',
      'adhar.io/source': 'acme/shop@deploy/base/workflows/db-migration-check.yaml',
      'adhar.io/spec-hash': '3f2a9c1e00aa',
    },
  },
  spec: {
    entrypoint: 'main',
    arguments: {
      parameters: [
        { name: 'target', enum: ['dev', 'test'], value: 'dev', description: 'Which database' },
        { name: 'ticket' },
        { name: 'db-url', valueFrom: { configMapKeyRef: { name: 'db', key: 'url' } } },
        { name: 'api-token', value: '' },
      ],
    },
    templates: [{ name: 'main', dag: { tasks: [{ name: 'ok', templateRef: { name: 'adhar-steps', template: 'approval', clusterScope: true } }] } }],
  },
}

const CWT: TemplateObject = { kind: 'ClusterWorkflowTemplate', metadata: { name: 'adhar-steps', labels: {} }, spec: {} }
const CATALOGUE_CWT: TemplateObject = { kind: 'ClusterWorkflowTemplate', metadata: { name: 'smoke', labels: { 'adhar.io/catalog': 'true' } }, spec: { entrypoint: 'main' } }
const CRON: TemplateObject = {
  kind: 'CronWorkflow',
  metadata: { name: 'nightly', namespace: 'shop' },
  spec: { schedules: ['0 2 * * *'], workflowSpec: { workflowTemplateRef: { name: 'cleanup' }, serviceAccountName: 'adhar-workflow', arguments: { parameters: [{ name: 'days', value: '7' }] } } },
}

Deno.test('entries: title, home, tags, team, approvals; the step library is not a catalogue entry', () => {
  const all = catalogEntries([WT], [CWT, CATALOGUE_CWT], [CRON])
  assertEquals(all.map((e) => e.name), ['db-migration-check', 'nightly', 'smoke'])
  const e = all[0]
  assertEquals(e.title, 'DB migration check')
  assertEquals(e.home, 'App')
  assertEquals(e.tags, ['db', 'release'])
  assertEquals(e.team, 'payments')
  assertEquals(e.hasApprovals, true)
  assertEquals(all[1].schedules, ['0 2 * * *'])
})

// The platform's step libraries as the adhar repo ships them
// (argo-workflows/manifests/catalog/{adhar-steps,adhar-batch-steps}.yaml.tmpl):
// labelled adhar.io/catalog for the designer's palette, with templates that
// carry adhar.io/node-kind and NO entrypoint. A Run button on one would submit
// a workflow argo-server refuses (W2 integration, design 0026 drift 43).
const STEP_LIBRARY = (name: string, templates: Array<[string, string]>): TemplateObject => ({
  kind: 'ClusterWorkflowTemplate',
  metadata: { name, labels: { 'adhar.io/catalog': 'true', 'adhar.io/catalog-tags': 'approvals,checks,load' }, annotations: { 'workflows.argoproj.io/title': 'Platform steps' } },
  spec: { templates: templates.map(([n, kind]) => ({ name: n, metadata: { annotations: { 'adhar.io/node-kind': kind } } })) },
})

Deno.test('a catalogue step library is called from a workflow, never offered as a run', () => {
  const steps = STEP_LIBRARY('adhar-steps', [['approval', 'approval'], ['http-check', 'http-check'], ['wait-healthy', 'wait-healthy'], ['k6-load', 'k6']])
  const batch = STEP_LIBRARY('adhar-batch-steps', [['run', 'batch-job']])
  const all = catalogEntries([], [steps, batch, CATALOGUE_CWT], [])
  assertEquals(all.map((e) => e.name), ['smoke'])
  // A workflow that calls the catalogue approval by reference is one with approvals.
  assertEquals(entryOf(WT, 'WorkflowTemplate').hasApprovals, true)
})

Deno.test('homes come from provenance: app, project, platform, draft', () => {
  const m = (annotations: Record<string, string>, labels: Record<string, string> = {}, namespace = 'shop') => ({ metadata: { name: 'x', namespace, annotations, labels } })
  assertEquals(homeOf(m({ 'adhar.io/source': 'acme/shop-auto@automation/workflows/x.yaml' }), 'WorkflowTemplate'), 'Project')
  assertEquals(homeOf(m({}, { 'adhar.io/workflow-draft': 'true' }), 'WorkflowTemplate'), 'Draft')
  assertEquals(homeOf(m({}, {}, 'adhar-system'), 'WorkflowTemplate'), 'Platform')
  assertEquals(homeOf(m({}), 'ClusterWorkflowTemplate'), 'Platform')
  assertEquals(homeOf(m({}), 'WorkflowTemplate'), 'Unmanaged')
})

Deno.test('parameter schema: enum, required, from a ref, secret-like', () => {
  const p = paramSpecs(WT.spec!.arguments!.parameters)
  assertEquals(p.map((x) => [x.name, x.required, x.fromRef, x.secretLike]), [
    ['target', false, false, false],
    ['ticket', true, false, false],
    ['db-url', false, true, false],
    ['api-token', false, false, true],
  ])
  assertEquals(p[0].enum, ['dev', 'test'])
})

Deno.test('the run form refuses what the template does not allow', () => {
  const entry = entryOf(WT, 'WorkflowTemplate')
  const ok = validateRun({ entry, namespace: 'shop-dev', values: { ticket: 'OPS-1' } })
  assertEquals(ok, {})
  const bad = validateRun({ entry, namespace: 'shop-test', values: { target: 'prod', 'db-url': 'x', 'api-token': 'hunter2' }, labels: { 'app.kubernetes.io/name': 'x', 'adhar.io/ticket': 'bad value!' } })
  assertMatch(bad[''], /its own namespace/)
  assertEquals(bad.ticket, 'Required.')
  assertMatch(bad.target, /one of/)
  assertMatch(bad['db-url'], /ConfigMap or Secret/)
  assertMatch(bad['api-token'], /Secret/)
  assertMatch(bad['label:app.kubernetes.io/name'], /cannot be set/)
  assertMatch(bad['label:adhar.io/ticket'], /label value/)
})

Deno.test('a submit references the template, carries its version and NEVER names a service account', () => {
  const entry = entryOf(WT, 'WorkflowTemplate')
  const w = buildRun({ entry, namespace: 'shop-dev', values: { ticket: 'OPS-1', 'api-token': 'leak' }, labels: { 'adhar.io/ticket': 'OPS-1' } }, '3f2a9c1e00aa')
  assertEquals(w.metadata.generateName, 'db-migration-check-')
  assertEquals(w.metadata.namespace, 'shop-dev')
  assertEquals(w.spec, { workflowTemplateRef: { name: 'db-migration-check' }, arguments: { parameters: [{ name: 'ticket', value: 'OPS-1' }] } })
  assertEquals(w.metadata.labels, { 'adhar.io/ticket': 'OPS-1', 'adhar.io/template-spec-hash': '3f2a9c1e00aa', 'workflows.argoproj.io/workflow-template': 'db-migration-check' })
  assert(!JSON.stringify(w).includes('serviceAccount'), 'the console never chooses a run identity (INV-3)')
})

Deno.test('a cluster template is referenced cluster-scoped, in the namespace chosen', () => {
  const w = buildRun({ entry: entryOf(CATALOGUE_CWT, 'ClusterWorkflowTemplate'), namespace: 'shop-dev', values: {} }, undefined)
  assertEquals(w.spec?.workflowTemplateRef, { name: 'smoke', clusterScope: true })
  assertEquals(w.metadata.labels?.['workflows.argoproj.io/cluster-workflow-template'], 'smoke')
})

Deno.test('"Run now" on a cron runs its workflowSpec with the arguments given, labelled with the cron', () => {
  const w = buildRun({ entry: entryOf(CRON, 'CronWorkflow'), namespace: 'shop', values: { days: '30' } }, 'abc')
  assertEquals(w.metadata.labels?.['workflows.argoproj.io/cron-workflow'], 'nightly')
  assertEquals(w.spec?.arguments?.parameters, [{ name: 'days', value: '30' }])
  assertEquals(w.spec?.workflowTemplateRef, { name: 'cleanup' })
})

Deno.test('a plain resubmit is a new run from the same reference, labelled with where it came from', () => {
  const orig: Workflow = {
    metadata: { name: 'db-migration-check-k2x9q', generateName: 'db-migration-check-', namespace: 'shop-dev', labels: { 'workflows.argoproj.io/workflow-template': 'db-migration-check', 'workflows.argoproj.io/phase': 'Failed', 'workflows.argoproj.io/completed': 'true' } },
    spec: { workflowTemplateRef: { name: 'db-migration-check' }, arguments: { parameters: [{ name: 'ticket', value: 'OPS-1' }] }, shutdown: 'Stop' },
  }
  const w = buildResubmit(orig, { ticket: 'OPS-2' })
  assertEquals(w.metadata.generateName, 'db-migration-check-')
  assertEquals(w.metadata.labels, { 'workflows.argoproj.io/workflow-template': 'db-migration-check', 'workflows.argoproj.io/resubmitted-from-workflow': 'db-migration-check-k2x9q' })
  assertEquals(w.spec, { workflowTemplateRef: { name: 'db-migration-check' }, arguments: { parameters: [{ name: 'ticket', value: 'OPS-2' }] } })
})

Deno.test('run stats: last ten outcomes, 7-day success rate and p50', () => {
  const entry = entryOf(WT, 'WorkflowTemplate')
  const now = Date.parse('2026-11-25T12:00:00Z')
  const run = (i: number, phase: string, mins: number): Workflow => ({
    metadata: { name: `r${i}`, namespace: 'shop-dev', labels: { 'workflows.argoproj.io/workflow-template': 'db-migration-check' } },
    status: { phase, startedAt: new Date(now - (i + 1) * 3_600_000).toISOString(), finishedAt: new Date(now - (i + 1) * 3_600_000 + mins * 60_000).toISOString() },
  })
  const s = runStats(entry, [run(0, 'Succeeded', 2), run(1, 'Failed', 4), run(2, 'Succeeded', 6), { ...run(3, 'Running', 1), status: { phase: 'Running' } }], now)
  assertEquals(s.outcomes, ['ok', 'fail', 'ok'])
  assertEquals(s.runs, 3)
  assertEquals(Math.round(s.successRate! * 100), 67)
  assertEquals(s.p50Ms, 4 * 60_000)
})

Deno.test('the run form refuses secret-NAMED parameters by name part, not by substring', () => {
  for (const n of ['password', 'db-password', 'apiToken', 'api_key', 'API_KEY', 'client.secret', 'aws-access-key', 'credentials', 'githubToken', 'pass']) assert(isSecretLike(n), n)
  // A substring match refused these, and a required one could never be run from the console.
  for (const n of ['keyspace', 'monkey', 'passes', 'bypass-cache', 'tokenizer', 'partition', 'turnkey-id', 'secretary']) assert(!isSecretLike(n), n)
  const entry = entryOf({ ...WT, spec: { arguments: { parameters: [{ name: 'keyspace' }] } } }, 'WorkflowTemplate')
  assertEquals(validateRun({ entry, namespace: 'shop-dev', values: { keyspace: 'orders' } }), {})
  assertEquals(buildRun({ entry, namespace: 'shop-dev', values: { keyspace: 'orders' } }, undefined).spec?.arguments?.parameters, [{ name: 'keyspace', value: 'orders' }])
})

Deno.test('a required secret parameter says the template cannot run from the console, not just "Required."', () => {
  const entry = entryOf({ ...WT, spec: { arguments: { parameters: [{ name: 'db-password' }] } } }, 'WorkflowTemplate')
  assertMatch(validateRun({ entry, namespace: 'shop-dev', values: {} })['db-password'], /cannot be run from the console/)
})

Deno.test('a template with no parameters runs with no arguments at all', () => {
  const entry = entryOf({ ...WT, spec: { entrypoint: 'main' } }, 'WorkflowTemplate')
  assertEquals(entry.params, [])
  assertEquals(validateRun({ entry, namespace: 'shop-dev', values: {} }), {})
  assertEquals(buildRun({ entry, namespace: 'shop-dev', values: {} }, undefined).spec, { workflowTemplateRef: { name: 'db-migration-check' } })
})
