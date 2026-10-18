import { assert, assertEquals } from 'jsr:@std/assert@1'
import { type Freight, type Promotion, type Stage, toPromotion, toStage } from './index.ts'
import {
  appFreightInStage,
  appPromotions,
  appStage,
  argoAppFor,
  type ArgoAppLike,
  authorizedStageProblem,
  authorizedStageValues,
  buildProjectMatrix,
  groupStagesByEnvironment,
  isAuthorizedStage,
  isSharedStage,
  projectEnvironments,
  promotableFreightForApp,
} from './project-envs.ts'

/* ─────────── fixtures ─────────── */

const stage = (name: string, extra: Partial<Stage> = {}): Stage => ({ name, project: 'shop', phase: 'NotApplicable', ...extra })

/** The CURRENT shape: one chain per app, `<app>-<env>`, labelled. */
const perApp = (app: string, env: string, extra: Partial<Stage> = {}) =>
  stage(`${app}-${env}`, { labels: { 'adhar.io/application': app, 'adhar.io/environment': env, 'adhar.io/project': 'shop' }, warehouse: app, origins: [app], ...extra })

/** The NEW shape: one stage per project environment, one origin per app. */
const shared = (env: string, byOrigin: Record<string, string>, extra: Partial<Stage> = {}) =>
  stage(env, {
    labels: { 'adhar.io/environment': env, 'adhar.io/project': 'shop', 'adhar.io/stage-scope': 'project' },
    origins: ['cart', 'web'],
    freightByOrigin: byOrigin,
    currentFreight: Object.values(byOrigin)[0],
    ...extra,
  })

const freight = (id: string, app: string, extra: Partial<Freight> = {}): Freight => ({
  id,
  project: 'shop',
  warehouse: app,
  images: [{ repoURL: `harbor/shop/${app}`, tag: id.replace(/^f-/, 'v') }],
  created: `2026-10-0${id.length % 9}T00:00:00Z`,
  ...extra,
})

const argo = (app: string, env: string, extra: { image?: string; health?: string; sync?: string; annotations?: Record<string, string> } = {}): ArgoAppLike => ({
  metadata: {
    name: `shop-${app}-${env}`,
    labels: { 'adhar.io/project': 'shop', 'adhar.io/application': app, 'adhar.io/environment': env },
    ...(extra.annotations ? { annotations: extra.annotations } : {}),
  },
  spec: { destination: { namespace: `shop-${env}` } },
  status: { sync: { status: extra.sync ?? 'Synced', revision: 'abc1234def' }, health: { status: extra.health ?? 'Healthy' }, images: extra.image ? [extra.image] : [] },
})

const PROJECT = {
  metadata: { name: 'shop' },
  spec: { parameters: { environments: [{ name: 'prod', requireApproval: true, quota: { cpu: '8', memory: '16Gi' } }] } },
  status: {
    environments: [
      { name: 'prod', namespace: 'shop-prod', order: 2 },
      { name: 'dev', namespace: 'shop-dev', order: 0, autoPromote: true },
      { name: 'test', namespace: 'shop-test', order: 1 },
    ],
  },
}

/* ─────────── project environments ─────────── */

Deno.test('projectEnvironments: status order, namespaces and declared guardrails', () => {
  const envs = projectEnvironments(PROJECT)
  assertEquals(envs.map((e) => e.name), ['dev', 'test', 'prod'])
  assertEquals(envs.map((e) => e.namespace), ['shop-dev', 'shop-test', 'shop-prod'])
  assertEquals(envs[0].guardrails, ['auto-promote'])
  assertEquals(envs[2].guardrails, ['approval required', 'quota cpu 8 · memory 16Gi'])
  assertEquals(projectEnvironments({ metadata: { name: 'x' }, status: {} }), [])
})

Deno.test('projectEnvironments: missing order falls back to dev → test → prod', () => {
  const envs = projectEnvironments({ metadata: { name: 'p' }, status: { environments: [{ name: 'prod' }, { name: 'dev' }] } })
  // Index order is the fallback, so a published list keeps its sequence.
  assertEquals(envs.map((e) => e.name), ['prod', 'dev'])
  assertEquals(envs[0].namespace, 'p-prod')
})

/* ─────────── grouping, both shapes ─────────── */

Deno.test('groupStagesByEnvironment: current per-app stages group by their environment label', () => {
  const g = groupStagesByEnvironment([perApp('cart', 'dev'), perApp('cart', 'test'), perApp('web', 'dev')], 'shop', ['dev', 'test', 'prod'])
  assertEquals([...g.keys()].sort(), ['dev', 'test'])
  assertEquals(Object.keys(g.get('dev')!.perApp).sort(), ['cart', 'web'])
  assertEquals(g.get('dev')!.shared, undefined)
})

Deno.test('groupStagesByEnvironment: new shared stages are one per environment', () => {
  const g = groupStagesByEnvironment([shared('dev', { cart: 'f-2' }), shared('test', { cart: 'f-1' })], 'shop', ['dev', 'test'])
  assertEquals(g.get('dev')!.shared?.name, 'dev')
  assertEquals(Object.keys(g.get('dev')!.perApp), [])
  assert(isSharedStage(g.get('test')!.shared!))
})

Deno.test('groupStagesByEnvironment: unlabelled stages read by name; other projects are ignored', () => {
  const g = groupStagesByEnvironment(
    [stage('dev'), stage('cart-test'), stage('dev', { project: 'other' }), stage('legacy')],
    'shop',
    ['dev', 'test'],
  )
  assertEquals(g.get('dev')!.shared?.project, 'shop')
  assertEquals(Object.keys(g.get('test')!.perApp), ['cart'])
  assert(g.has('legacy'), 'an unknown stage is kept, not dropped')
})

Deno.test('groupStagesByEnvironment: mid-migration, both shapes land in the same environment', () => {
  const g = groupStagesByEnvironment([perApp('cart', 'dev'), shared('dev', { web: 'f-9' }, { origins: ['web'] })], 'shop', ['dev'])
  const dev = g.get('dev')!
  assertEquals(dev.shared?.name, 'dev')
  assertEquals(Object.keys(dev.perApp), ['cart'])
  // web goes through the shared stage; cart is not listed there and keeps its own.
  assertEquals(appStage(dev, 'web')?.shape, 'shared')
  assertEquals(appStage(dev, 'cart')?.shape, 'per-app')
  assertEquals(appStage(dev, 'cart')?.stage.name, 'cart-dev')
})

/* ─────────── per-app freight in a shared stage ─────────── */

Deno.test('appFreightInStage: a shared stage gives each app only its own freight', () => {
  const s = shared('dev', { cart: 'f-cart', web: 'f-web' })
  assertEquals(appFreightInStage(s, 'cart'), 'f-cart')
  assertEquals(appFreightInStage(s, 'web'), 'f-web')
  assertEquals(appFreightInStage(s, 'search'), undefined, 'never another app\'s current freight')
})

Deno.test('appFreightInStage: a per-app stage is the app\'s current freight', () => {
  assertEquals(appFreightInStage(perApp('cart', 'dev', { currentFreight: 'f-1' }), 'cart'), 'f-1')
})

Deno.test('appStage: a running promotion belongs to the app whose freight it carries', () => {
  const s = shared('test', { cart: 'f-1', web: 'f-2' }, { currentPromotion: 'test-abc', currentPromotionOrigin: 'web' })
  const g = { env: 'test', shared: s, perApp: {} }
  assertEquals(appStage(g, 'web')?.promotion, 'test-abc')
  assertEquals(appStage(g, 'cart')?.promotion, undefined)
  assertEquals(appStage(g, 'cart')?.busyWithOther, true)
  // Origin unknown on the stage: resolved through the freight.
  const s2 = shared('test', { cart: 'f-1' }, { currentPromotion: 'p', currentPromotionFreight: 'f-cart-new' })
  const byId = new Map([['f-cart-new', { warehouse: 'cart' }]])
  assertEquals(appStage({ env: 'test', shared: s2, perApp: {} }, 'cart', byId)?.promotion, 'p')
})

Deno.test('appStage: a shared stage that does not request the app is not its stage', () => {
  assertEquals(appStage({ env: 'dev', shared: shared('dev', { web: 'f' }, { origins: ['web'] }), perApp: {} }, 'cart'), undefined)
})

Deno.test('appPromotions: other apps\' promotions into a shared stage are excluded', () => {
  const s = shared('dev', { cart: 'f-c', web: 'f-w' })
  const promos: Promotion[] = [
    { name: 'dev-1', project: 'shop', stage: 'dev', freight: 'f-c', phase: 'Succeeded', created: '2026-10-01T00:00:00Z' },
    { name: 'dev-2', project: 'shop', stage: 'dev', freight: 'f-w', phase: 'Succeeded', created: '2026-10-02T00:00:00Z' },
    { name: 'dev-3', project: 'shop', stage: 'dev', freight: 'x', origin: 'cart', phase: 'Failed', created: '2026-10-03T00:00:00Z' },
  ]
  const byId = new Map([['f-c', { warehouse: 'cart' }], ['f-w', { warehouse: 'web' }]])
  const view = appStage({ env: 'dev', shared: s, perApp: {} }, 'cart', byId)!
  assertEquals(appPromotions(view, promos, byId).map((p) => p.name), ['dev-3', 'dev-1'])
})

Deno.test('promotableFreightForApp: only the app\'s own freight, verified upstream', () => {
  const s = shared('test', { cart: 'f-1', web: 'f-w1' }, { upstream: ['dev'] })
  const view = appStage({ env: 'test', shared: s, perApp: {} }, 'cart')!
  const all = [
    freight('f-1', 'cart', { verifiedIn: ['dev'] }), // current — excluded
    freight('f-2', 'cart', { verifiedIn: ['dev'] }),
    freight('f-3', 'cart'), // not verified upstream
    freight('f-4', 'cart', { approvedFor: ['test'] }),
    freight('f-w2', 'web', { verifiedIn: ['dev'] }), // another app
  ]
  assertEquals(promotableFreightForApp(view, all).map((f) => f.id).sort(), ['f-2', 'f-4'])
})

/* ─────────── authorised stage ─────────── */

Deno.test('isAuthorizedStage: accepts the shared and the per-app forms', () => {
  const ctx = { project: 'shop', app: 'cart', env: 'test' }
  assertEquals(authorizedStageValues('shop', 'cart', 'test'), ['shop:test', 'shop:cart-test'])
  assert(isAuthorizedStage('shop:test', ctx))
  assert(isAuthorizedStage('shop:cart-test', ctx))
  assert(!isAuthorizedStage('shop:cart-dev', ctx))
  assert(!isAuthorizedStage('other:test', ctx))
  assert(!isAuthorizedStage(undefined, ctx))
  // Whatever stage actually promotes it is always acceptable.
  assert(isAuthorizedStage('shop:qa-gate', { ...ctx, stage: { project: 'shop', name: 'qa-gate' } }))
})

/* ─────────── parsing the raw CRDs ─────────── */

Deno.test('toStage: a shared stage keeps every origin and its per-origin freight', () => {
  const s = toStage({
    metadata: { name: 'dev', namespace: 'shop', labels: { 'adhar.io/stage-scope': 'project', 'adhar.io/environment': 'dev' } },
    spec: {
      requestedFreight: [
        { origin: { kind: 'Warehouse', name: 'cart' }, sources: { direct: true } },
        { origin: { kind: 'Warehouse', name: 'web' }, sources: { direct: true } },
      ],
    },
    status: {
      freightHistory: [{ items: { 'Warehouse/cart': { name: 'f-c', origin: { kind: 'Warehouse', name: 'cart' } }, 'Warehouse/web': { name: 'f-w', origin: { kind: 'Warehouse', name: 'web' } } } }],
      currentPromotion: { name: 'dev-x', freight: { name: 'f-w2', origin: { kind: 'Warehouse', name: 'web' } } },
      lastPromotion: { name: 'dev-y', finishedAt: '2026-10-10T00:00:00Z', status: { phase: 'Succeeded' }, freight: { name: 'f-c', origin: { kind: 'Warehouse', name: 'cart' } } },
    },
  })
  assertEquals(s.origins, ['cart', 'web'])
  assertEquals(s.freightByOrigin, { cart: 'f-c', web: 'f-w' })
  assertEquals(s.currentPromotionOrigin, 'web')
  assertEquals(s.lastPromotionOrigin, 'cart')
})

Deno.test('toPromotion: records the origin of the promoted freight', () => {
  const p = toPromotion({ metadata: { name: 'dev-1', namespace: 'shop' }, spec: { stage: 'dev', freight: 'f' }, status: { phase: 'Running', freight: { name: 'f', origin: { kind: 'Warehouse', name: 'cart' } } } })
  assertEquals(p.origin, 'cart')
})

/* ─────────── matrix ─────────── */

Deno.test('buildProjectMatrix (shared): versions per app per env, drift against upstream', () => {
  const stages = [
    shared('dev', { cart: 'f-3', web: 'f-w1' }),
    shared('test', { cart: 'f-2', web: 'f-w1' }, { upstream: ['dev'] }),
    shared('prod', { web: 'f-w1' }, { upstream: ['test'] }),
  ]
  const fr = [freight('f-3', 'cart', { alias: 'brave-otter' }), freight('f-2', 'cart'), freight('f-w1', 'web')]
  const m = buildProjectMatrix({
    project: 'shop',
    envs: projectEnvironments(PROJECT),
    stages,
    freight: fr,
    argoApps: [argo('cart', 'dev'), argo('cart', 'test', { health: 'Degraded' }), argo('web', 'dev'), argo('web', 'test'), argo('web', 'prod')],
  })
  assertEquals(m.shape, 'shared')
  assertEquals(m.apps, ['cart', 'web'])
  const cart = m.rows.find((r) => r.app === 'cart')!
  assertEquals(cart.cells.map((c) => c.version?.label), ['brave-otter', 'v2', undefined])
  assertEquals(cart.drifted, ['test', 'prod'])
  assertEquals(cart.cells[1].driftFrom, 'dev')
  assertEquals(cart.cells[1].health, 'Degraded')
  assertEquals(cart.cells[0].namespace, 'shop-dev')
  const web = m.rows.find((r) => r.app === 'web')!
  assertEquals(web.drifted, [], 'the same freight everywhere is in step')
})

Deno.test('buildProjectMatrix (per-app, no Project XR): environments come from the stages', () => {
  const stages = [
    perApp('cart', 'dev', { currentFreight: 'f-2' }),
    perApp('cart', 'test', { currentFreight: 'f-2' }),
    perApp('cart', 'prod', { currentFreight: 'f-1' }),
  ]
  const m = buildProjectMatrix({ project: 'shop', envs: [], stages, freight: [freight('f-1', 'cart'), freight('f-2', 'cart')], argoApps: [] })
  assertEquals(m.shape, 'per-app')
  assertEquals(m.envs.map((e) => e.name), ['dev', 'test', 'prod'])
  assertEquals(m.rows[0].drifted, ['prod'])
})

Deno.test('buildProjectMatrix: falls back to the Argo CD image when there is no stage', () => {
  const m = buildProjectMatrix({
    project: 'shop',
    envs: projectEnvironments(PROJECT),
    stages: [],
    argoApps: [argo('api', 'dev', { image: 'harbor/shop/api:1.4.0' }), argo('api', 'test', { image: 'harbor/shop/api:1.4.0' }), argo('api', 'prod', { image: 'harbor/shop/api:1.3.0' })],
  })
  assertEquals(m.shape, 'none')
  assertEquals(m.rows[0].cells.map((c) => c.version?.label), ['1.4.0', '1.4.0', '1.3.0'])
  assertEquals(m.rows[0].drifted, ['prod'])
})

Deno.test('argoAppFor: labels first, `<project>-<app>-<env>` name as fallback', () => {
  const unlabelled: ArgoAppLike = { ...argo('cart', 'dev'), metadata: { name: 'shop-cart-dev' } }
  assertEquals(argoAppFor([unlabelled], 'shop', 'cart', 'dev')?.metadata.name, 'shop-cart-dev')
  assertEquals(argoAppFor([argo('cart', 'dev')], 'shop', 'web', 'dev'), undefined)
})

Deno.test('authorizedStageProblem: both forms pass, a wrong or missing one is named', () => {
  const ctxNew = { project: 'shop', app: 'cart', env: 'test', stage: { project: 'shop', name: 'test' } }
  const ctxOld = { ...ctxNew, stage: { project: 'shop', name: 'cart-test' } }
  assertEquals(authorizedStageProblem(argo('cart', 'test', { annotations: { 'kargo.akuity.io/authorized-stage': 'shop:test' } }), ctxNew), undefined)
  assertEquals(authorizedStageProblem(argo('cart', 'test', { annotations: { 'kargo.akuity.io/authorized-stage': 'shop:cart-test' } }), ctxOld), undefined)
  assert(authorizedStageProblem(argo('cart', 'test', { annotations: { 'kargo.akuity.io/authorized-stage': 'shop:cart-dev' } }), ctxNew)?.includes('not shop:test'))
  assert(authorizedStageProblem(argo('cart', 'test', { annotations: {} }), ctxNew)?.includes('missing'))
  assertEquals(authorizedStageProblem(argo('cart', 'test'), ctxNew), undefined, 'annotations not read')
})
