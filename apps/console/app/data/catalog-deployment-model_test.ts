import { assertEquals } from 'jsr:@std/assert@1'
import type { argocd, kargo } from '@adhar/api-clients'
import type { Entity } from './catalog.ts'
import { deriveDeployment, kargoEnvironments, orderKargoStages } from './catalog-deployment.ts'
import {
  alertMatches,
  appDashboardUrl,
  deployEvents,
  deployFrequency,
  describeTrigger,
  environmentRows,
  envNamespaces,
  giteaRepoRef,
  harborRepoOf,
  imageVersion,
  parseImage,
  routeEnvironment,
} from './catalog-deployment-model.ts'
import { summarise } from './catalog-pipelines.ts'

const entity = (name: string) => ({ kind: 'Component', metadata: { name, annotations: {} }, spec: {} }) as unknown as Entity

const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

/** An Argo CD Application the way the multienv composition creates it. */
const cpApp = (env: string, history: argocd.Application['status']['history'] = [], extra: Partial<argocd.Application['status']> = {}) =>
  ({
    metadata: { name: `adhar-shop-${env}`, namespace: 'adhar-system', labels: { 'adhar.io/application': 'shop', 'adhar.io/environment': env } },
    spec: {
      project: 'adhar',
      destination: { namespace: `adhar-${env}`, server: 'https://kubernetes.default.svc' },
      source: { repoURL: 'http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/shop.git', path: `deploy/envs/${env}`, targetRevision: 'main' },
      sources: [],
      syncPolicy: { automated: { prune: true, selfHeal: true }, syncOptions: [] },
    },
    status: {
      sync: { status: 'Synced', revision: SHA1 },
      health: { status: 'Healthy' },
      conditions: [],
      images: [],
      deployments: history.length,
      resources: { total: 4, outOfSync: 0, unhealthy: 0 },
      resourceList: [{ kind: 'Rollout', name: 'shop', namespace: `adhar-${env}` }],
      history,
      ...extra,
    },
  }) as unknown as argocd.Application

const stage = (name: string, labels: Record<string, string>, upstream: string[] = []) =>
  ({ name, project: 'adhar', labels, upstream, phase: 'Steady' }) as unknown as kargo.Stage

Deno.test('environments run in promotion order dev → test → prod, primary stays prod', () => {
  const d = deriveDeployment(entity('shop'), [cpApp('prod'), cpApp('dev'), cpApp('test')], { isLoading: false, isError: false })
  assertEquals(d.environments.map((e) => e.key), ['dev', 'test', 'prod'])
  assertEquals(d.primary?.metadata.name, 'adhar-shop-prod')
})

Deno.test("only this application's Kargo stages are its environments, in chain order", () => {
  const d = deriveDeployment(entity('shop'), [cpApp('dev'), cpApp('test'), cpApp('prod')], { isLoading: false, isError: false })
  const app = { 'adhar.io/application': 'shop' }
  const stages = orderKargoStages([
    stage('shop-prod', { ...app, 'adhar.io/environment': 'prod' }, ['shop-test']),
    stage('billing-dev', { 'adhar.io/application': 'billing', 'adhar.io/environment': 'dev' }),
    stage('shop-dev', { ...app, 'adhar.io/environment': 'dev' }),
    stage('shop-test', { ...app, 'adhar.io/environment': 'test' }, ['shop-dev']),
    stage('dev', {}),
  ])
  const k = kargoEnvironments(stages, d, 'shop')
  assertEquals(k.map((e) => e.stage.name), ['shop-dev', 'shop-test', 'shop-prod'])
  const rows = environmentRows(d, k)
  assertEquals(rows.map((r) => [r.key, r.app?.metadata.name, r.namespace]), [
    ['dev', 'adhar-shop-dev', 'adhar-dev'],
    ['test', 'adhar-shop-test', 'adhar-test'],
    ['prod', 'adhar-shop-prod', 'adhar-prod'],
  ])
  assertEquals(envNamespaces(rows), ['adhar-dev', 'adhar-test', 'adhar-prod'])
})

Deno.test("an unrelated service never gets another application's stages", () => {
  const base = cpApp('dev')
  const plain = {
    ...base,
    metadata: { name: 'grafana', namespace: 'adhar-system', labels: {} },
    spec: { ...base.spec, destination: { namespace: 'adhar-system', server: 'adhar-controlplane' } },
    status: { ...base.status, resourceList: [{ kind: 'Deployment', name: 'grafana', namespace: 'adhar-system' }] },
  } as unknown as argocd.Application
  const d = deriveDeployment(entity('grafana'), [plain], { isLoading: false, isError: false })
  const stages = [stage('shop-dev', { 'adhar.io/application': 'shop', 'adhar.io/environment': 'dev' }), stage('dev', {}), stage('test', {}, ['dev'])]
  assertEquals(kargoEnvironments(stages, d, 'grafana'), [])
})

Deno.test("the shared chain lists only this service's environments, never every service's stages", () => {
  const d = deriveDeployment(entity('shop'), [cpApp('dev'), cpApp('prod')], { isLoading: false, isError: false })
  // Unlabelled stages in one Kargo project: the shared env chain plus other
  // services' stages from before the labels existed.
  const stages = [stage('dev', {}), stage('test', {}, ['dev']), stage('prod', {}, ['test']), stage('cart-dev', {}), stage('billing-prod', {})]
  const k = kargoEnvironments(stages, d, 'shop')
  assertEquals(k.map((e) => [e.stage.name, e.app?.metadata.name]), [['dev', 'adhar-shop-dev'], ['prod', 'adhar-shop-prod']])
})

Deno.test('stages composed before the labels existed still match by <app>-<env>', () => {
  const d = deriveDeployment(entity('shop'), [cpApp('dev'), cpApp('test')], { isLoading: false, isError: false })
  const k = kargoEnvironments([stage('shop-dev', {}), stage('shop-test', {}, ['shop-dev']), stage('shopping-dev', {})], d, 'shop')
  assertEquals(k.map((e) => [e.stage.name, e.app?.metadata.name]), [['shop-dev', 'adhar-shop-dev'], ['shop-test', 'adhar-shop-test']])
})

Deno.test('sync history: newest first, live entry, rollback target, duration and initiator', () => {
  const dev = cpApp('dev', [
    { id: 1, revision: SHA2, deployedAt: '2026-10-10T10:00:00Z' },
    { id: 2, revision: SHA1, deployStartedAt: '2026-10-12T09:59:30Z', deployedAt: '2026-10-12T10:00:00Z', initiatedBy: { automated: true } },
  ])
  const prod = cpApp('prod', [{ id: 7, revisions: [SHA2], deployedAt: '2026-10-11T08:00:00Z', initiatedBy: { username: 'alice' } }])
  const d = deriveDeployment(entity('shop'), [dev, prod], { isLoading: false, isError: false })
  const ev = deployEvents(d)
  assertEquals(ev.map((e) => [e.env, e.id, e.current]), [['dev', 2, true], ['prod', 7, true], ['dev', 1, false]])
  assertEquals(ev[0].previousRevision, SHA2)
  assertEquals(ev[0].durationSecs, 30)
  assertEquals(ev[1].revision, SHA2)
  assertEquals(describeTrigger(ev[0]).label, 'Auto-sync')
  assertEquals(describeTrigger(ev[1]).label, 'Synced by alice')
  assertEquals(describeTrigger(ev[0], 'promote(test): sha256:abc [skip ci]'), { kind: 'promotion', label: 'Kargo promotion to test' })
  assertEquals(describeTrigger({}).kind, 'unknown')
})

Deno.test('deploy frequency buckets per UTC day per environment and stays honest when empty', () => {
  const now = Date.parse('2026-10-18T12:00:00Z')
  const ev = [
    { env: 'dev', deployedAt: '2026-10-18T01:00:00Z' },
    { env: 'dev', deployedAt: '2026-10-18T02:00:00Z' },
    { env: 'prod', deployedAt: '2026-10-17T23:59:00Z' },
    { env: undefined, deployedAt: '2026-10-05T10:00:00Z' },
    { env: 'test', deployedAt: '2026-09-01T10:00:00Z' },
  ].map((e, i) => ({ app: 'x', envLabel: '', id: i, current: false, ...e }))
  const f = deployFrequency(ev, 14, now)
  assertEquals(f.days.length, 14)
  assertEquals(f.days[13], { date: '2026-10-18', counts: { dev: 2 }, total: 2 })
  assertEquals(f.days[12], { date: '2026-10-17', counts: { prod: 1 }, total: 1 })
  assertEquals(f.days[0].date, '2026-10-05')
  assertEquals(f.days[0].counts, { other: 1 })
  assertEquals(f.total, 4)
  assertEquals(f.keys, ['dev', 'prod', 'other'])
  assertEquals(f.last, '2026-10-18T02:00:00Z')
  const empty = deployFrequency([ev[4]], 14, now)
  assertEquals(empty.total, 0)
  assertEquals(empty.last, '2026-09-01T10:00:00Z')
})

Deno.test('app-ci PipelineRuns: revision is the commit, PR runs carry their branch', () => {
  const push = summarise({
    metadata: { name: 'app-ci-shop-x1', namespace: 'adhar-system', labels: { 'adhar.io/app': 'shop', 'tekton.dev/pipeline': 'app-ci', 'triggers.tekton.dev/eventlistener': 'app-ci', 'triggers.tekton.dev/trigger': 'app-push' } },
    spec: { params: [{ name: 'repo-name', value: 'shop' }, { name: 'revision', value: SHA1 }] },
    status: { conditions: [{ type: 'Succeeded', status: 'True', reason: 'Succeeded' }], startTime: '2026-10-18T10:00:00Z', completionTime: '2026-10-18T10:04:05Z' },
  })
  assertEquals([push.commit, push.branch, push.trigger, push.repo, push.state, push.durationSecs], [SHA1, 'main', 'push', 'shop', 'succeeded', 245])
  const pr = summarise({
    metadata: { name: 'app-pr-ci-shop-y2', namespace: 'adhar-system', labels: { 'adhar.io/app': 'shop', 'adhar.io/preview': 'true' } },
    spec: { params: [{ name: 'repo-name', value: 'shop' }, { name: 'revision', value: SHA2 }, { name: 'git-ref', value: 'feature/cart' }] },
    status: { conditions: [{ type: 'Succeeded', status: 'False', reason: 'Failed', message: 'Tasks Completed: 3 (Failed: 1, Cancelled 0), Skipped: 2' }], startTime: '2026-10-18T10:00:00Z' },
  })
  assertEquals([pr.commit, pr.branch, pr.trigger, pr.state], [SHA2, 'feature/cart', 'pull-request', 'failed'])
  const manual = summarise({ metadata: { name: 'hand-made', namespace: 'team' }, spec: { params: [] }, status: {} })
  assertEquals([manual.trigger, manual.commit, manual.branch, manual.state], ['manual', undefined, undefined, 'pending'])
})

Deno.test('routes map to the environment whose namespace they live in, else a host token', () => {
  const d = deriveDeployment(entity('shop'), [cpApp('dev'), cpApp('prod')], { isLoading: false, isError: false })
  const rows = environmentRows(d, [])
  assertEquals(routeEnvironment({ namespace: 'adhar-dev', host: 'shop.example.com' }, rows), 'dev')
  assertEquals(routeEnvironment({ namespace: 'adhar-prod', host: 'shop.example.com' }, rows), 'prod')
  assertEquals(routeEnvironment({ namespace: 'elsewhere', host: 'shop-dev.example.com' }, rows), 'dev')
  assertEquals(routeEnvironment({ namespace: 'elsewhere', host: 'shop.prod.example.com' }, rows), 'prod')
  assertEquals(routeEnvironment({ namespace: 'elsewhere', host: 'shop.example.com' }, rows), undefined)
})

Deno.test('Gitea repo, Harbor repo and image versions', () => {
  assertEquals(giteaRepoRef('https://gitea.cloud.adhar.io/adhar/shop'), { org: 'adhar', repo: 'shop' })
  assertEquals(giteaRepoRef('https://code.example.com/adhar/shop.git', 'https://code.example.com'), { org: 'adhar', repo: 'shop' })
  assertEquals(giteaRepoRef('https://github.com/acme/shop'), undefined)
  const img = `harbor-core.adhar-system.svc.cluster.local/library/shop@sha256:${'c'.repeat(64)}`
  assertEquals(parseImage(img).path, 'library/shop')
  assertEquals(parseImage('nginx:1.27').host, 'docker.io')
  assertEquals(parseImage('localhost:5000/a/b:v1'), { repository: 'localhost:5000/a/b', host: 'localhost:5000', path: 'a/b', tag: 'v1' })
  assertEquals(harborRepoOf([img, 'nginx:1.27']), { project: 'library', repo: 'shop' })
  assertEquals(harborRepoOf(['nginx:1.27']), undefined)
  // Kargo pins by digest; Harbor knows which commit-SHA tag that digest carries.
  assertEquals(imageVersion(img, [{ digest: `sha256:${'c'.repeat(64)}`, tags: [{ name: SHA1 }] }]), { label: SHA1.slice(0, 7), commit: SHA1, digest: `sha256:${'c'.repeat(64)}` })
  assertEquals(imageVersion(img, []).label, 'c'.repeat(12))
  assertEquals(imageVersion('ghcr.io/acme/shop:1.4.0', undefined).label, '1.4.0')
})

Deno.test('monitoring: app dashboard per env, alerts scoped to where the service runs', () => {
  assertEquals(appDashboardUrl('https://grafana.x/', 'shop', 'dev'), 'https://grafana.x/d/app-shop?refresh=30s&var-env=dev')
  assertEquals(alertMatches({ rollout: 'shop', namespace: 'adhar-dev' }, 'shop', ['adhar-dev', 'adhar-prod']), true)
  assertEquals(alertMatches({ deployment: 'shop', namespace: 'other-team' }, 'shop', ['adhar-dev']), false)
  assertEquals(alertMatches({ pod: 'shop-7d9f-abc' }, 'shop', ['adhar-dev']), true)
  assertEquals(alertMatches({ pod: 'shopping-1' }, 'shop', []), false)
})

/* ─────────── the project's shared stages ─────────── */

const sharedStage = (env: string, byOrigin: Record<string, string>, extra: Partial<kargo.Stage> = {}) =>
  ({
    name: env,
    project: 'adhar',
    phase: 'Steady',
    labels: { 'adhar.io/project': 'adhar', 'adhar.io/environment': env, 'adhar.io/stage-scope': 'project' },
    origins: Object.keys(byOrigin),
    freightByOrigin: byOrigin,
    currentFreight: Object.values(byOrigin)[0],
    upstream: [],
    ...extra,
  }) as unknown as kargo.Stage

Deno.test("shared stages: the project's environments, each carrying only THIS app's freight", () => {
  const d = deriveDeployment(entity('shop'), [cpApp('dev'), cpApp('test'), cpApp('prod')], { isLoading: false, isError: false })
  const stages = [
    sharedStage('prod', { cart: 'f-cart-1', shop: 'f-shop-1' }, { lastPromoted: '2026-10-10T00:00:00Z', lastPromotionOrigin: 'cart' }),
    sharedStage('dev', { cart: 'f-cart-3', shop: 'f-shop-3' }, { currentPromotion: 'dev-x', currentPromotionOrigin: 'cart' }),
    sharedStage('test', { cart: 'f-cart-2', shop: 'f-shop-2' }, { currentPromotion: 'test-y', currentPromotionOrigin: 'shop' }),
  ]
  const envs = [{ name: 'dev', namespace: 'adhar-dev', order: 0, guardrails: [] }, { name: 'test', namespace: 'adhar-test', order: 1, guardrails: [] }, { name: 'prod', namespace: 'adhar-prod', order: 2, guardrails: [] }]
  const k = kargoEnvironments(stages, d, 'shop', { project: 'adhar', envs })
  assertEquals(k.map((e) => [e.env, e.label, e.shape, e.freight, e.app?.metadata.name]), [
    ['dev', 'adhar · Development', 'shared', 'f-shop-3', 'adhar-shop-dev'],
    ['test', 'adhar · Test', 'shared', 'f-shop-2', 'adhar-shop-test'],
    ['prod', 'adhar · Production', 'shared', 'f-shop-1', 'adhar-shop-prod'],
  ])
  // cart's running promotion is not shop's to abort; shop's own is.
  assertEquals([k[0].promotion, k[0].busyWithOther], [undefined, true])
  assertEquals(k[1].promotion, 'test-y')
  // prod's last promotion was cart's — not reported as shop's.
  assertEquals(k[2].lastPromoted, undefined)
  const rows = environmentRows(d, k)
  assertEquals(rows.map((r) => r.label), ['adhar · Development', 'adhar · Test', 'adhar · Production'])
})

Deno.test('shared stages never list another app as this service\'s environment', () => {
  const d = deriveDeployment(entity('shop'), [cpApp('dev')], { isLoading: false, isError: false })
  // The shared dev stage does not request shop — it is cart's and billing's.
  const k = kargoEnvironments([sharedStage('dev', { cart: 'f1', billing: 'f2' })], d, 'shop', { project: 'adhar' })
  assertEquals(k, [])
})

Deno.test('a shared-stage promotion commit names the application it promoted', () => {
  assertEquals(describeTrigger({}, 'promote(test): shop sha256:0123456789abcdef [skip ci]'), { kind: 'promotion', label: 'Kargo promotion of shop to test' })
})
