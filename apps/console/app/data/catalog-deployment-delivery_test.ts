import { assertEquals } from 'jsr:@std/assert@1'
import type { argocd, kargo } from '@adhar/api-clients'
import type { KObj } from './catalog-composition-model.ts'
import {
  actorLabel,
  authorisationProblem,
  describeWorkload,
  diagnoseDelivery,
  expectedEnvs,
  findApplicationXR,
  isAuthorisationError,
  pickWorkload,
  projectOf,
  releaseHistory,
  workloadStatus,
} from './catalog-deployment-delivery.ts'
import { withExpectedEnvs } from './catalog-deployment-model.ts'

const xr = (over: Partial<KObj> = {}, params: Record<string, unknown> = { project: 'retail', environments: [{ name: 'dev' }, { name: 'test' }, { name: 'prod' }] }): KObj => ({
  apiVersion: 'platform.adhar.io/v1alpha1',
  kind: 'Application',
  metadata: { name: 'my-service', namespace: 'adhar-system' },
  spec: {
    parameters: params,
    crossplane: { compositionRef: { name: 'application-multienv' }, resourceRefs: [] },
  },
  status: { conditions: [{ type: 'Synced', status: 'True' }, { type: 'Ready', status: 'False', reason: 'Creating' }] },
  ...over,
})

const project = (envs: Array<{ name: string; namespace?: string }>): KObj => ({
  metadata: { name: 'retail', namespace: 'adhar-system' },
  status: { environments: envs },
})

const obj = (name: string, kind: string, manifestName: string, conds: Array<{ type: string; status: string; reason?: string; message?: string }>): KObj => ({
  apiVersion: 'kubernetes.m.crossplane.io/v1alpha1',
  kind: 'Object',
  metadata: { name, namespace: 'adhar-system', labels: { 'crossplane.io/composite': 'my-service' } },
  spec: { forProvider: { manifest: { apiVersion: 'x/v1', kind, metadata: { name: manifestName, namespace: 'retail' } } } },
  status: { conditions: conds },
})

const argoApp = (name: string, annotations?: Record<string, string>) =>
  ({ metadata: { name, namespace: 'adhar-system', labels: {}, ...(annotations ? { annotations } : {}) } }) as unknown as argocd.Application

const stage = (name: string, project = 'retail') => ({ name, project, phase: 'Steady' }) as unknown as kargo.Stage

const ENVS3 = [{ name: 'dev', namespace: 'retail-dev' }, { name: 'test', namespace: 'retail-test' }, { name: 'prod', namespace: 'retail-prod' }]

Deno.test('the XR is found by name case-insensitively, or by the annotation the entity declares', () => {
  const list = [xr(), { ...xr(), metadata: { name: 'shop-api', namespace: 'adhar-system' } }]
  assertEquals(findApplicationXR(list, 'My-Service')?.metadata.name, 'my-service')
  assertEquals(findApplicationXR(list, 'storefront', { 'adhar.io/application': 'shop-api' })?.metadata.name, 'shop-api')
  assertEquals(findApplicationXR(list, 'nothing'), undefined)
  assertEquals(projectOf(xr({}, { project: 'default' })), 'adhar')
  assertEquals(projectOf(xr({}, {})), 'adhar')
})

Deno.test('a project with no environments blocks delivery and says where to fix it', () => {
  const d = diagnoseDelivery({ xr: xr(), project: project([]), objects: [], argoApps: [], stages: [] })
  assertEquals(d.phase, 'blocked')
  assertEquals(d.headline, 'Project retail has no environments')
  assertEquals(d.envs, [])
})

Deno.test('a missing project is reported, not "not deployed"', () => {
  const d = diagnoseDelivery({ xr: xr(), project: null, objects: [], argoApps: [], stages: [] })
  assertEquals([d.phase, d.headline, d.project.found], ['blocked', 'Project retail does not exist', false])
})

Deno.test('a composition error surfaces the Synced message', () => {
  const failed = xr({ status: { conditions: [{ type: 'Synced', status: 'False', reason: 'ReconcileError', message: 'cannot compose resources: function-go-templating: template: error calling index: index out of range: 0' }] } })
  const d = diagnoseDelivery({ xr: failed, project: project(ENVS3), objects: [], argoApps: [], stages: [] })
  assertEquals(d.phase, 'failed')
  assertEquals(d.detail?.startsWith('cannot compose resources'), true)
})

Deno.test('per-env pieces: live, applying, failing with the provider error, never composed', () => {
  const objects = [
    obj('my-service-app-dev', 'Application', 'retail-my-service-dev', [{ type: 'Synced', status: 'True' }, { type: 'Ready', status: 'True' }]),
    obj('my-service-app-test', 'Application', 'retail-my-service-test', [{ type: 'Synced', status: 'False', reason: 'ReconcileError', message: 'cannot apply: applications.argoproj.io "retail-my-service-test" is forbidden: project retail not permitted' }]),
    obj('my-service-stage-dev', 'Stage', 'my-service-dev', [{ type: 'Ready', status: 'True' }]),
    obj('my-service-warehouse', 'Warehouse', 'my-service', [{ type: 'Ready', status: 'True' }]),
    obj('unrelated', 'Stage', 'billing-dev', [{ type: 'Synced', status: 'False', message: 'not mine' }]),
  ]
  objects[4].metadata.labels = { 'crossplane.io/composite': 'billing' }
  const d = diagnoseDelivery({ xr: xr(), project: project(ENVS3), objects, argoApps: [argoApp('retail-my-service-dev')], stages: [stage('my-service-dev')] })
  assertEquals(d.phase, 'failed')
  assertEquals(d.envs.map((e) => [e.env, e.namespace, e.app.state, e.stage.state]), [
    ['dev', 'retail-dev', 'live', 'live'],
    ['test', 'retail-test', 'failing', 'missing'],
    ['prod', 'retail-prod', 'missing', 'missing'],
  ])
  assertEquals(d.envs[1].app.reason?.includes('not permitted'), true)
  assertEquals(d.warehouse.state, 'live')
  assertEquals(d.objectErrors.map((o) => o.wraps), ['Application retail-my-service-test'])

  // Partial envs: the Environments section lists test/prod with the reason.
  const rows = withExpectedEnvs([{ key: 'dev', label: 'Development', app: argoApp('retail-my-service-dev'), namespace: 'retail-dev' }], expectedEnvs(d))
  assertEquals(rows.map((r) => [r.key, r.namespace, Boolean(r.missing)]), [['dev', 'retail-dev', false], ['test', 'retail-test', true], ['prod', 'retail-prod', true]])
  assertEquals(rows[1].missing?.startsWith('no Argo CD app yet — cannot apply'), true)
})

Deno.test('the app filter limits environments and unknown names are reported', () => {
  const d = diagnoseDelivery({ xr: xr({}, { project: 'retail', environments: [{ name: 'dev' }, { name: 'qa' }] }), project: project(ENVS3), objects: [], argoApps: [], stages: [] })
  assertEquals(d.envs.map((e) => e.env), ['dev'])
  assertEquals(d.unknownEnvs, ['qa'])
  assertEquals(d.phase, 'setting-up')
})

Deno.test('everything live is ready; live in the cluster but hidden from the Argo CD API is called out', () => {
  const ready = xr({ status: { conditions: [{ type: 'Synced', status: 'True' }, { type: 'Ready', status: 'True' }] } })
  const apps = ENVS3.map((e) => argoApp(`retail-my-service-${e.name}`))
  assertEquals(diagnoseDelivery({ xr: ready, project: project(ENVS3), objects: [], argoApps: apps, stages: [] }).phase, 'ready')
  const objs = ENVS3.map((e) => obj(`o-${e.name}`, 'Application', `retail-my-service-${e.name}`, [{ type: 'Ready', status: 'True' }, { type: 'Synced', status: 'True' }]))
  const hidden = diagnoseDelivery({ xr: ready, project: project(ENVS3), objects: objs, argoApps: [], stages: [] })
  assertEquals(hidden.headline, 'Argo CD does not list the applications')
})

Deno.test('Kargo authorisation: the app must name <project>:<stage>', () => {
  const s = stage('my-service-test')
  assertEquals(authorisationProblem(argoApp('a', { 'kargo.akuity.io/authorized-stage': 'retail:my-service-test' }), s), undefined)
  assertEquals(authorisationProblem(argoApp('a', {}), s)?.includes('missing kargo.akuity.io/authorized-stage: retail:my-service-test'), true)
  assertEquals(authorisationProblem(argoApp('a', { 'kargo.akuity.io/authorized-stage': 'retail:my-service-dev' }), s)?.includes('not retail:my-service-test'), true)
  assertEquals(authorisationProblem(argoApp('a'), s), undefined)
  assertEquals(isAuthorisationError('Application "x" is not authorized for stage'), true)
  assertEquals(isAuthorisationError('git push failed'), false)
})

Deno.test('rollout mapping: canary step, weight, pause and abort; Deployment fallback', () => {
  const ro: KObj = {
    kind: 'Rollout',
    metadata: { name: 'my-service', namespace: 'retail-test' },
    spec: { replicas: 3, strategy: { canary: { steps: [{ setWeight: 20 }, { pause: {} }, { setWeight: 50 }, { pause: { duration: '5m' } }] } } },
    status: { phase: 'Paused', currentStepIndex: 1, pauseConditions: [{ reason: 'CanaryPauseStep' }], canary: { weights: { canary: { weight: 20 } } }, readyReplicas: 3, updatedReplicas: 1, availableReplicas: 3 },
  }
  const w = workloadStatus(ro)!
  assertEquals([w.phase, w.paused, w.step, w.canaryWeight, w.strategy], ['Paused', true, { index: 1, total: 4 }, 20, 'canary'])
  assertEquals(describeWorkload(w), 'Paused · step 1/4 · canary 20% · 3/3 ready')
  assertEquals(workloadStatus({ ...ro, status: { ...ro.status, abort: true, phase: 'Degraded' } })!.phase, 'Aborted')
  const dep: KObj = { kind: 'Deployment', metadata: { name: 'my-service', namespace: 'retail-dev' }, spec: { replicas: 2 }, status: { readyReplicas: 1, updatedReplicas: 2, availableReplicas: 1 } }
  assertEquals(describeWorkload(workloadStatus(dep)!), 'Progressing · 1/2 ready')
  // Rollout wins over a same-named Deployment; other namespaces are ignored.
  assertEquals(pickWorkload([dep, { ...dep, metadata: { name: 'my-service', namespace: 'retail-test' } }, ro], 'my-service', 'retail-test')?.kind, 'Rollout')
  assertEquals(pickWorkload([dep], 'my-service', 'retail-prod'), undefined)
})

Deno.test('release history: this service\'s promotions, newest first, joined with freight', () => {
  const stages = [{ stage: stage('my-service-dev'), env: 'Development' }, { stage: stage('my-service-test'), env: 'Test' }]
  const sha = 'c'.repeat(40)
  const freight = [{ id: 'f1', alias: 'eager-fox', project: 'retail', images: [{ repoURL: 'h/library/my-service', tag: sha, digest: 'sha256:abc' }], verifiedIn: ['my-service-dev'], created: '2026-10-01T00:00:00Z' }] as kargo.Freight[]
  const promos = [
    { name: 'p1', project: 'retail', stage: 'my-service-dev', freight: 'f1', phase: 'Succeeded', created: '2026-10-02T00:00:00Z', finished: '2026-10-02T00:03:00Z', actor: 'email:alice@adhar.io', commit: 'd'.repeat(40) },
    { name: 'p2', project: 'retail', stage: 'my-service-test', freight: 'f1', phase: 'Failed', created: '2026-10-03T00:00:00Z', message: 'not authorized', actor: 'kargo controller' },
    { name: 'p3', project: 'retail', stage: 'billing-dev', freight: 'f9', phase: 'Succeeded', created: '2026-10-04T00:00:00Z' },
  ] as kargo.Promotion[]
  const h = releaseHistory(stages, promos, freight)
  assertEquals(h.map((r) => [r.promotion, r.env, r.phase, r.verified, r.actor]), [
    ['p2', 'Test', 'Failed', false, 'auto-promotion'],
    ['p1', 'Development', 'Succeeded', true, 'alice@adhar.io'],
  ])
  assertEquals(h[1].freight, { id: 'f1', label: 'my-service ccccccc', imageTag: sha, digest: 'sha256:abc', sourceCommit: sha })
  assertEquals(h[1].promotionCommit, 'd'.repeat(40))
  assertEquals(actorLabel(undefined), undefined)
})

/* ─────────── project-shared stages ─────────── */

const sharedStage = (env: string, origins: string[]) =>
  ({
    name: env,
    project: 'retail',
    phase: 'Steady',
    labels: { 'adhar.io/project': 'retail', 'adhar.io/environment': env, 'adhar.io/stage-scope': 'project' },
    origins,
  }) as unknown as kargo.Stage

const labelledArgo = (env: string, authorized?: string) =>
  ({
    metadata: {
      name: `retail-my-service-${env}`,
      namespace: 'adhar-system',
      labels: { 'adhar.io/project': 'retail', 'adhar.io/application': 'my-service', 'adhar.io/environment': env },
      annotations: authorized ? { 'kargo.akuity.io/authorized-stage': authorized } : {},
    },
  }) as unknown as argocd.Application

Deno.test('Kargo authorisation: the shared <project>:<env> form is accepted as well as <project>:<app>-<env>', () => {
  const shared = sharedStage('test', ['my-service', 'billing'])
  assertEquals(authorisationProblem(labelledArgo('test', 'retail:test'), shared), undefined)
  assertEquals(authorisationProblem(labelledArgo('test', 'retail:my-service-test'), shared), undefined)
  assertEquals(authorisationProblem(labelledArgo('test', 'retail:my-service-test'), stage('my-service-test')), undefined)
  assertEquals(authorisationProblem(labelledArgo('test', 'retail:prod'), shared)?.includes('not retail:test'), true)
})

Deno.test('delivery: an environment promoted through the project\'s shared stage counts as live', () => {
  const d = diagnoseDelivery({
    xr: xr({}, { project: 'retail' }),
    project: project(ENVS3),
    objects: [],
    argoApps: [],
    stages: [sharedStage('dev', ['my-service']), sharedStage('test', ['billing']), stage('my-service-test')],
  })
  assertEquals(d.envs.map((e) => [e.env, e.stage.name, e.stage.state]), [
    ['dev', 'dev', 'live'],
    // The shared test stage does not request my-service: its own stage it is.
    ['test', 'my-service-test', 'live'],
    ['prod', 'my-service-prod', 'missing'],
  ])
})

Deno.test('release history: in a shared stage only this service\'s promotions count', () => {
  const s = sharedStage('dev', ['my-service', 'billing'])
  const freight = [
    { id: 'f-mine', project: 'retail', warehouse: 'my-service', images: [], created: '2026-10-01T00:00:00Z' },
    { id: 'f-other', project: 'retail', warehouse: 'billing', images: [], created: '2026-10-01T00:00:00Z' },
  ] as kargo.Freight[]
  const promos = [
    { name: 'p-mine', project: 'retail', stage: 'dev', freight: 'f-mine', phase: 'Succeeded', created: '2026-10-02T00:00:00Z' },
    { name: 'p-other', project: 'retail', stage: 'dev', freight: 'f-other', phase: 'Succeeded', created: '2026-10-03T00:00:00Z' },
    { name: 'p-origin', project: 'retail', stage: 'dev', freight: 'f-gone', origin: 'my-service', phase: 'Failed', created: '2026-10-04T00:00:00Z' },
  ] as kargo.Promotion[]
  const h = releaseHistory([{ stage: s, env: 'retail · Development', shared: true }], promos, freight, 'my-service')
  assertEquals(h.map((r) => r.promotion), ['p-origin', 'p-mine'])
})

Deno.test('delivery: the control plane\'s published environments win, the app\'s own list is ignored', () => {
  const x = xr({
    status: {
      conditions: [{ type: 'Synced', status: 'True' }, { type: 'ProjectEnvironments', status: 'True', reason: 'OverrideIgnored', message: 'spec.parameters.environments is ignored' }],
      environments: [
        { name: 'dev', namespace: 'retail-dev', argoApplication: 'retail-my-service-dev', stage: 'dev' },
        { name: 'test', namespace: 'retail-test', argoApplication: 'retail-my-service-test', stage: 'test' },
      ],
    },
  }, { project: 'retail', environments: [{ name: 'prod' }] })
  const d = diagnoseDelivery({ xr: x, project: project(ENVS3), objects: [], argoApps: [], stages: [sharedStage('dev', ['my-service'])] })
  assertEquals(d.envs.map((e) => [e.env, e.app.name, e.stage.name, e.analysis.name, e.analysis.state]), [
    ['dev', 'retail-my-service-dev', 'dev', 'dev-health', 'live'],
    ['test', 'retail-my-service-test', 'test', 'test-health', 'missing'],
  ])
  assertEquals([d.wanted, d.wantedIgnored, d.unknownEnvs, d.inheritance?.reason], [['prod'], true, [], 'OverrideIgnored'])
})
