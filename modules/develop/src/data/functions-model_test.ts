import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import type { kargo } from '@adhar/api-clients'
import {
  type ApplicationXR,
  buildRows,
  cellFor,
  deliveryRows,
  environmentColumns,
  type FunctionXR,
  functionEnvironment,
  functionEvents,
  functionMetricQueries,
  functionRef,
  functionState,
  functionTriggers,
  functionUrl,
  giteaTreeUrl,
  gitopsOwner,
  groupFacets,
  groupFunctions,
  groupHealth,
  type KRevision,
  lastDeployed,
  overlayDir,
  overridesBranch,
  overridesFileName,
  overridesPatchYaml,
  parseFunctionRef,
  parseHeaderLines,
  type PipelineRunLike,
  type PodAutoscaler,
  type PodLike,
  podRows,
  prettyBody,
  readyDigest,
  repoFromUrl,
  revisionRows,
  scaleLabel,
  scaleView,
  triggerLabel,
  validateOverrides,
  withPatchReference,
  worstHealth,
} from './functions-model.ts'

/* ───────────── fixtures ───────────── */

const READY = [
  { type: 'Synced', status: 'True' },
  { type: 'Ready', status: 'True' },
  { type: 'ServiceReady', status: 'True', reason: 'Ready' },
  { type: 'EdgeReady', status: 'True', reason: 'Published' },
  { type: 'TriggersReady', status: 'True', reason: 'HTTPOnly' },
]

function fn(name: string, namespace: string, over: Partial<FunctionXR> & { labels?: Record<string, string> } = {}): FunctionXR {
  const { labels, ...rest } = over
  return {
    apiVersion: 'platform.adhar.io/v1alpha1',
    kind: 'Function',
    metadata: {
      name,
      namespace,
      creationTimestamp: '2026-10-20T10:00:00Z',
      labels: { 'adhar.io/application': name, 'adhar.io/environment': namespace, 'adhar.io/project': 'shop', 'adhar.io/team': 'payments', 'platform.adhar.io/runtime': 'node22', ...labels },
    },
    spec: { parameters: { runtime: 'node22', image: `harbor/library/${name}:abc`, minScale: 0, maxScale: 20, timeoutSeconds: 30 } },
    status: { url: `https://${name}.${namespace}.cloud.adhar.io`, readyRevision: `${name}-00002`, latestRevision: `${name}-00002`, conditions: READY },
    ...rest,
  }
}

/* ───────────── identity ───────────── */

Deno.test('the environment: label, then the project namespace map, then the parameter, then a namespace that is one', () => {
  assertEquals(functionEnvironment(fn('a', 'dev')), 'dev')
  const bare: FunctionXR = { metadata: { name: 'a', namespace: 'shop-prod' } }
  assertEquals(functionEnvironment(bare, new Map([['shop-prod', 'prod']])), 'prod')
  assertEquals(functionEnvironment({ metadata: { name: 'a', namespace: 'x' }, spec: { parameters: { environment: 'test' } } }), 'test')
  assertEquals(functionEnvironment({ metadata: { name: 'a', namespace: 'test' } }), 'test')
  // A function in the platform namespace is in no environment — not "adhar-system".
  assertEquals(functionEnvironment({ metadata: { name: 'a', namespace: 'adhar-system' } }), undefined)
})

Deno.test('HTTP is always a trigger; event triggers come from triggers[] or the old shorthand', () => {
  assertEquals(functionTriggers(fn('a', 'dev')), ['http'])
  assertEquals(functionTriggers({ metadata: { name: 'a' }, spec: { parameters: { trigger: 'cron' } } }), ['http', 'cron'])
  assertEquals(
    functionTriggers({ metadata: { name: 'a' }, spec: { parameters: { trigger: 'cron', triggers: [{ type: 'topic' }, { type: 'cloudevent' }, { type: 'topic' }] } } }),
    ['http', 'topic', 'cloudevent'],
  )
  assertEquals(triggerLabel(['http', 'cron']), 'HTTP + cron')
})

/* ───────────── health ───────────── */

Deno.test('a function whose service, edge and triggers are ready is Ready', () => {
  const s = functionState(fn('a', 'dev'))
  assertEquals(s.health, 'ready')
  assertEquals(s.issues, [])
})

Deno.test('Crossplane still creating is deploying, not failed', () => {
  const s = functionState(fn('a', 'dev', { status: { conditions: [{ type: 'Synced', status: 'True' }, { type: 'Ready', status: 'False', reason: 'Creating' }] } }))
  assertEquals(s.health, 'deploying')
  assertEquals(s.label, 'Creating')
})

Deno.test('a Knative Service that is not serving fails the function even when Crossplane says Ready', () => {
  const s = functionState(fn('a', 'dev', {
    status: { conditions: [{ type: 'Ready', status: 'True' }, { type: 'ServiceReady', status: 'False', reason: 'RevisionFailed', message: 'image pull failed' }] },
  }))
  assertEquals(s.health, 'failed')
  assertEquals(s.label, 'RevisionFailed')
  assertEquals(s.message, 'image pull failed')
})

Deno.test('serving but not published at the edge is degraded, and says why', () => {
  const s = functionState(fn('a', 'dev', {
    status: {
      message: 'serving a-00001; edge: hostname a.dev.x is already claimed',
      conditions: [{ type: 'Ready', status: 'True' }, { type: 'ServiceReady', status: 'True' }, { type: 'EdgeReady', status: 'False', reason: 'HostClaimed', message: 'claimed by ns other' }],
    },
  }))
  assertEquals(s.health, 'degraded')
  assertEquals(s.issues, ['EdgeReady: HostClaimed — claimed by ns other'])
})

Deno.test('no status yet is Pending, a delete in flight is Deleting', () => {
  assertEquals(functionState({ metadata: { name: 'a' } }).label, 'Pending')
  assertEquals(functionState({ metadata: { name: 'a', deletionTimestamp: '2026-10-28T00:00:00Z' } }).health, 'deleting')
})

Deno.test('a group is as healthy as its least healthy environment', () => {
  assertEquals(worstHealth(['ready', 'failed', 'deploying']), 'failed')
  assertEquals(worstHealth(['ready', 'degraded']), 'degraded')
  assertEquals(worstHealth([]), undefined)
})

/* ───────────── scale ───────────── */

const pa = (name: string, rev: string, actual: number, desired?: number): PodAutoscaler => ({
  metadata: { name: rev, labels: { 'serving.knative.dev/service': name, 'serving.knative.dev/revision': rev } },
  status: { actualScale: actual, ...(desired === undefined ? {} : { desiredScale: desired }) },
})

const pod = (name: string, rev: string, ready: boolean, extra: Partial<PodLike['metadata']> = {}): PodLike => ({
  metadata: { name: `${rev}-deployment-abc-${Math.random().toString(36).slice(2, 7)}`, labels: { 'serving.knative.dev/service': name, 'serving.knative.dev/revision': rev }, creationTimestamp: '2026-10-27T00:00:00Z', ...extra },
  spec: { containers: [{ name: 'user-container' }, { name: 'queue-proxy' }] },
  status: {
    phase: 'Running',
    conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
    containerStatuses: [{ name: 'user-container', ready, restartCount: 1 }, { name: 'queue-proxy', ready: true, restartCount: 0 }],
  },
})

Deno.test('the autoscaler says scaled to zero: serving, min 0, nothing running or wanted', () => {
  const s = scaleView(fn('orders', 'dev'), { autoscalers: [pa('orders', 'orders-00002', 0, 0), pa('other', 'other-00001', 3, 3)] })
  assertEquals(s.source, 'autoscaler')
  assertEquals(s.actual, 0)
  assertEquals(s.scaledToZero, true)
  assertEquals(scaleLabel(s), '0 (0–20)')
})

Deno.test('the autoscaler wanting a pod is a cold start in progress, not scaled to zero', () => {
  const s = scaleView(fn('orders', 'dev'), { autoscalers: [pa('orders', 'orders-00002', 0, 1)] })
  assertEquals(s.scaledToZero, false)
  assertEquals(s.desired, 1)
})

Deno.test('without the autoscaler, live pods are counted; terminating ones are not', () => {
  const s = scaleView(fn('orders', 'dev'), {
    pods: [pod('orders', 'orders-00002', true), pod('orders', 'orders-00002', false), pod('orders', 'orders-00001', true, { deletionTimestamp: 'x' })],
  })
  assertEquals(s.source, 'pods')
  assertEquals(s.actual, 2)
  assertEquals(s.ready, 1)
})

Deno.test('a function that is not serving, or must keep a pod, is never "scaled to zero"', () => {
  const failing = fn('orders', 'dev', { status: { conditions: [{ type: 'ServiceReady', status: 'False', reason: 'RevisionFailed' }] } })
  assertEquals(scaleView(failing, { pods: [] }).scaledToZero, false)
  const warm = fn('orders', 'dev', { spec: { parameters: { minScale: 1, maxScale: 5 } } })
  assertEquals(scaleView(warm, { pods: [] }).scaledToZero, false)
  assertEquals(scaleView(fn('orders', 'dev')).source, 'none')
})

/* ───────────── URLs ───────────── */

Deno.test('the published URL is the URL', () => {
  assertEquals(functionUrl(fn('orders', 'dev'), 'cloud.adhar.io'), { url: 'https://orders.dev.cloud.adhar.io', derived: false, clusterOnly: false })
})

Deno.test('before it is published, the URL follows the platform route rule (and says it is derived)', () => {
  const bare = (ns: string): FunctionXR => ({ metadata: { name: 'orders', namespace: ns, labels: { 'adhar.io/environment': ns } } })
  assertEquals(functionUrl(bare('dev'), 'cloud.adhar.io').url, 'https://orders.dev.cloud.adhar.io')
  // `<env>` is the domain's first label → `<name>-<env>.<domain>`.
  assertEquals(functionUrl(bare('test'), 'test.adhar.io').url, 'https://orders-test.test.adhar.io')
  // A laptop install publishes on its port.
  assertEquals(functionUrl(bare('dev'), 'adhar.localtest.me:8443').url, 'https://orders.dev.adhar.localtest.me:8443')
  assertEquals(functionUrl(bare('dev'), 'cloud.adhar.io').derived, true)
  assertEquals(functionUrl(bare('dev'), '').url, undefined)
})

Deno.test('a cluster-only function is addressed inside the cluster; a custom hostname wins', () => {
  const internal: FunctionXR = { metadata: { name: 'orders', namespace: 'dev' }, spec: { parameters: { visibility: 'cluster' } } }
  assertEquals(functionUrl(internal, 'cloud.adhar.io'), { url: 'http://orders.dev.svc.cluster.local', derived: true, clusterOnly: true })
  const custom: FunctionXR = { metadata: { name: 'orders', namespace: 'dev' }, spec: { parameters: { hostname: 'orders.example.com' } } }
  assertEquals(functionUrl(custom, 'cloud.adhar.io').url, 'https://orders.example.com')
})

/* ───────────── GitOps ownership ───────────── */

Deno.test('Argo CD tracking makes a Function managed, and names the app that owns it', () => {
  assertEquals(gitopsOwner({ annotations: { 'argocd.argoproj.io/tracking-id': 'adhar-orders-dev:platform.adhar.io/Function:dev/orders' } }), {
    managed: true,
    argoApp: 'adhar-orders-dev',
  })
  assertEquals(gitopsOwner({ annotations: { 'argocd.argoproj.io/tracking-id': 'apps_orders-dev:platform.adhar.io/Function:dev/orders' } }), {
    managed: true,
    argoNamespace: 'apps',
    argoApp: 'orders-dev',
  })
  assertEquals(gitopsOwner({ labels: { 'app.kubernetes.io/instance': 'orders-dev' } }).managed, true)
  assertEquals(gitopsOwner({ labels: {}, annotations: {} }), { managed: false })
})

/* ───────────── grouping ───────────── */

Deno.test('functions group per application with one cell per environment, in promotion order', () => {
  const groups = groupFunctions([fn('orders', 'prod'), fn('orders', 'dev'), fn('cart', 'dev'), fn('orders', 'test')])
  assertEquals(groups.map((g) => g.name), ['cart', 'orders'])
  const orders = groups[1]
  assertEquals(orders.cells.map((c) => c.env), ['dev', 'test', 'prod'])
  assertEquals(orders.project, 'shop')
  assertEquals(orders.team, 'payments')
  assertEquals(cellFor(orders, 'test')?.fn.metadata.namespace, 'test')
  assertEquals(groupHealth(orders), 'ready')
})

Deno.test('a function app with nothing deployed yet is a pending row; a deployed one is not duplicated', () => {
  const apps: ApplicationXR[] = [
    { metadata: { name: 'invoices', labels: { 'adhar.io/workload': 'function' } }, spec: { parameters: { project: 'shop' } } },
    { metadata: { name: 'orders' }, spec: { parameters: { type: 'function', project: 'shop' } } },
    { metadata: { name: 'web' }, spec: { parameters: { type: 'web' } } },
  ]
  const groups = groupFunctions([fn('orders', 'dev')], { applications: apps })
  assertEquals(groups.map((g) => g.name), ['invoices', 'orders'])
  assertEquals(groupHealth(groups[0]), 'pending')
  assertEquals(groups[0].pendingApp?.metadata.name, 'invoices')
})

Deno.test('a function in no environment keeps a column named after its namespace', () => {
  const groups = groupFunctions([{ metadata: { name: 'legacy', namespace: 'adhar-system' } }])
  assertEquals(groups[0].cells[0].env, 'adhar-system')
  assertEquals(groups[0].cells[0].envKnown, false)
})

Deno.test('columns: the project’s environments first, then others in promotion order, then namespaces', () => {
  const groups = groupFunctions([fn('a', 'dev'), fn('b', 'qa', { labels: { 'adhar.io/environment': 'qa' } }), { metadata: { name: 'c', namespace: 'adhar-system' } }])
  assertEquals(environmentColumns(groups, ['dev', 'test', 'prod']), ['dev', 'test', 'prod', 'qa', 'adhar-system'])
  assertEquals(environmentColumns(groups), ['dev', 'qa', 'adhar-system'])
})

Deno.test('facets: status per environment, scaled-to-zero and pending included', () => {
  const failing = fn('orders', 'prod', { status: { conditions: [{ type: 'ServiceReady', status: 'False', reason: 'RevisionFailed' }] } })
  const [g] = groupFunctions([fn('orders', 'dev'), failing])
  const f = groupFacets(g, (c) => c.env === 'dev')
  assertEquals(f.status.sort(), ['failed', 'ready', 'scaled-to-zero'])
  assertEquals(f.environment, ['dev', 'prod'])
  assertEquals(f.project, ['shop'])
  assertEquals(f.runtime, ['node22'])
  assertEquals(f.trigger, ['http'])
  const [pending] = groupFunctions([], { applications: [{ metadata: { name: 'x', labels: { 'adhar.io/workload': 'function' } } }] })
  assertEquals(groupFacets(pending).status, ['pending'])
})

/* ───────────── revisions ───────────── */

const rev = (name: string, gen: number, ready: string, digest?: string): KRevision => ({
  metadata: { name, creationTimestamp: `2026-10-2${gen}T00:00:00Z`, labels: { 'serving.knative.dev/service': 'orders', 'serving.knative.dev/configurationGeneration': String(gen) } },
  spec: { containers: [{ name: 'user-container', image: `harbor/library/orders:${gen}` }] },
  status: {
    conditions: [{ type: 'Ready', status: ready, reason: ready === 'False' ? 'ExitCode1' : undefined }],
    containerStatuses: digest ? [{ name: 'user-container', imageDigest: `harbor/library/orders@sha256:${digest}` }] : [],
  },
})

Deno.test('revisions newest first, with the traffic each serves and which one is current', () => {
  const revs = [rev('orders-00001', 1, 'True', 'a'.repeat(64)), rev('orders-00003', 3, 'False'), rev('orders-00002', 2, 'True', 'b'.repeat(64))]
  const rows = revisionRows(revs, [{ latestRevision: true, percent: 90 }, { revisionName: 'orders-00001', percent: 10, tag: 'stable' }], { readyRevision: 'orders-00002' })
  assertEquals(rows.map((r) => r.name), ['orders-00003', 'orders-00002', 'orders-00001'])
  assertEquals(rows.map((r) => r.percent), [0, 90, 10])
  assertEquals(rows[0].latest, true)
  assertEquals(rows[0].ready, 'False')
  assertEquals(rows[1].current, true)
  assertEquals(rows[1].digest, `sha256:${'b'.repeat(64)}`)
  assertEquals(rows[2].tags, ['stable'])
})

Deno.test('last deploy is when the ready revision was created; its digest is what runs', () => {
  const revs = [rev('orders-00001', 1, 'True'), rev('orders-00002', 2, 'True', 'c'.repeat(64))]
  assertEquals(lastDeployed(fn('orders', 'dev'), revs), '2026-10-22T00:00:00Z')
  assertEquals(readyDigest(fn('orders', 'dev'), revs), `sha256:${'c'.repeat(64)}`)
  // No revisions readable: the ServiceReady transition stands in.
  const f = fn('orders', 'dev', { status: { conditions: [{ type: 'ServiceReady', status: 'True', lastTransitionTime: '2026-10-25T00:00:00Z' }] } })
  assertEquals(lastDeployed(f, []), '2026-10-25T00:00:00Z')
})

/* ───────────── pods, events, builds ───────────── */

Deno.test('pod rows: containers ready, restarts and the user container’s reason', () => {
  const p = pod('orders', 'orders-00002', false)
  p.status!.containerStatuses![0].state = { waiting: { reason: 'CrashLoopBackOff' } }
  const [row] = podRows([p])
  assertEquals(row.containers, '1/2')
  assertEquals(row.restarts, 1)
  assertEquals(row.reason, 'CrashLoopBackOff')
  assertEquals(row.revision, 'orders-00002')
})

Deno.test('events about the function and what it composes, newest first; a namesake prefix is not enough', () => {
  const ev = (name: string, at: string) => ({ metadata: { name: `${name}.1`, uid: `${name}-${at}` }, reason: 'R', message: 'm', involvedObject: { kind: 'Pod', name }, lastTimestamp: at })
  const rows = functionEvents([ev('orders', '2026-10-27T01:00:00Z'), ev('orders-00001-deployment-x', '2026-10-27T02:00:00Z'), ev('ordersx', '2026-10-27T03:00:00Z')], 'orders')
  assertEquals(rows.map((r) => r.object), ['Pod/orders-00001-deployment-x', 'Pod/orders'])
})

Deno.test('builds: app-ci runs for this app by label (or repo-name param), with state and a link', () => {
  const runs: PipelineRunLike[] = [
    {
      metadata: { name: 'app-ci-orders-1', namespace: 'adhar-system', labels: { 'adhar.io/app': 'orders', 'tekton.dev/pipeline': 'app-ci' } },
      spec: { params: [{ name: 'repo-name', value: 'orders' }, { name: 'revision', value: '3ba0d883' }] },
      status: { startTime: '2026-10-27T00:00:00Z', completionTime: '2026-10-27T00:10:00Z', conditions: [{ type: 'Succeeded', status: 'False', reason: 'Failed', message: 'Tasks Completed: 13 (Failed: 1)' }] },
    },
    {
      metadata: { name: 'app-ci-old', namespace: 'adhar-system', labels: { 'tekton.dev/pipeline': 'app-ci' } },
      spec: { params: [{ name: 'repo-name', value: 'orders' }] },
      status: { startTime: '2026-10-26T00:00:00Z', conditions: [{ type: 'Succeeded', status: 'Unknown', reason: 'Running' }] },
    },
    { metadata: { name: 'app-ci-cart', namespace: 'adhar-system', labels: { 'adhar.io/app': 'cart' } } },
  ]
  const rows = buildRows(runs, 'orders')
  assertEquals(rows.map((r) => [r.name, r.state]), [['app-ci-orders-1', 'failed'], ['app-ci-old', 'running']])
  assertEquals(rows[0].durationMs, 600_000)
  assertEquals(rows[0].revision, '3ba0d883')
  assertEquals(rows[0].href, '/develop?section=builds&run=adhar-system%2Fapp-ci-orders-1')
})

/* ───────────── delivery ───────────── */

Deno.test('delivery: the app’s own stage and the project’s shared stage both resolve to this app’s freight', () => {
  const stages = [
    { name: 'orders-dev', project: 'shop', phase: 'Steady', health: 'Healthy', labels: { 'adhar.io/application': 'orders', 'adhar.io/environment': 'dev' }, currentFreight: 'f1', lastPromoted: '2026-10-27T00:00:00Z', lastPromotionPhase: 'Succeeded' },
    { name: 'test', project: 'shop', phase: 'Promoting', labels: { 'adhar.io/stage-scope': 'project' }, origins: ['orders', 'cart'], freightByOrigin: { orders: 'f1', cart: 'f9' }, currentPromotion: 'p1', currentPromotionOrigin: 'cart' },
  ] as kargo.Stage[]
  const freight = [{ id: 'f1', project: 'shop', warehouse: 'orders', images: [{ repoURL: 'harbor/library/orders', tag: '3ba0d883abec17f17821b99429ec0267d46c7850' }], created: '2026-10-26T00:00:00Z' }] as kargo.Freight[]
  const rows = deliveryRows(stages, freight, 'shop', 'orders', ['dev', 'test', 'prod'])
  assertEquals(rows[0].stage, 'orders-dev')
  assertEquals(rows[0].freight, 'orders 3ba0d88')
  assertEquals(rows[0].lastPromotionPhase, 'Succeeded')
  assertEquals(rows[1].stage, 'test')
  assertEquals(rows[1].shape, 'shared')
  assertEquals(rows[1].busyWithOther, true)
  assertEquals(rows[1].promoting, false)
  assertEquals(rows[2].stage, undefined)
  assertEquals(deliveryRows(stages, freight, undefined, 'orders', ['dev']), [{ env: 'dev', promoting: false, busyWithOther: false }])
})

/* ───────────── repository ───────────── */

Deno.test('the repository from an Application source, public even when recorded in-cluster', () => {
  assertEquals(repoFromUrl('https://gitea.cloud.adhar.io/adhar/orders.git'), { org: 'adhar', repo: 'orders', webUrl: 'https://gitea.cloud.adhar.io/adhar/orders' })
  assertEquals(
    repoFromUrl('http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/orders.git', 'https://gitea.cloud.adhar.io/'),
    { org: 'adhar', repo: 'orders', webUrl: 'https://gitea.cloud.adhar.io/adhar/orders' },
  )
  assertEquals(repoFromUrl('http://gitea-http.adhar-system.svc.cluster.local:3000/adhar/orders.git')?.webUrl, undefined)
  assertEquals(repoFromUrl('not a url'), undefined)
  assertEquals(overlayDir('prod'), 'deploy/envs/prod')
  assertEquals(giteaTreeUrl('https://g/adhar/orders/', 'main', '/deploy/envs/dev'), 'https://g/adhar/orders/src/branch/main/deploy/envs/dev')
})

/* ───────────── change through a pull request ───────────── */

const OVERRIDES = { minScale: 1, maxScale: 10, timeoutSeconds: 60, targetConcurrency: 50, env: { LOG_LEVEL: 'debug', GREETING: 'say "hi"' }, removeEnv: ['OLD_FLAG'] }

Deno.test('overrides are validated the way the XRD and Knative will judge them', () => {
  assertEquals(validateOverrides(OVERRIDES), [])
  const bad = validateOverrides({ ...OVERRIDES, minScale: 5, maxScale: 2, timeoutSeconds: 900, targetConcurrency: 0, env: { '1BAD': 'x' } })
  assertEquals(bad.length, 4)
  assert(bad.some((e) => e.includes('cannot exceed')))
  assert(bad.some((e) => e.includes('600')))
})

Deno.test('the patch is a merge patch over this one Function; a removed variable is null', () => {
  const y = overridesPatchYaml('orders', OVERRIDES)
  assert(y.includes('kind: Function\nmetadata:\n  name: orders\n'))
  assert(y.includes('    minScale: 1\n    maxScale: 10\n    targetConcurrency: 50\n    timeoutSeconds: 60\n'))
  assert(y.includes('      GREETING: "say \\"hi\\""\n'))
  assert(y.includes('      OLD_FLAG: null\n'))
  assertEquals(overridesFileName('orders'), 'function-orders.patch.yaml')
  // No env changes, no env block.
  assertEquals(overridesPatchYaml('orders', { ...OVERRIDES, env: {}, removeEnv: [] }).includes('env:'), false)
})

Deno.test('the overlay lists the patch: appended, inserted at the list’s indentation, or left alone', () => {
  const file = 'function-orders.patch.yaml'
  const none = 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../../base'
  assertEquals(withPatchReference(none, file), `${none}\npatches:\n  - path: ${file}\n`)
  const flush = 'resources:\n- ../../base\npatches:\n- path: env.yaml\n  target:\n    kind: Function\n'
  assertEquals(withPatchReference(flush, file), `resources:\n- ../../base\npatches:\n- path: ${file}\n- path: env.yaml\n  target:\n    kind: Function\n`)
  const indented = 'patches:\n  - path: env.yaml\n'
  assertEquals(withPatchReference(indented, file), `patches:\n  - path: ${file}\n  - path: env.yaml\n`)
  assertEquals(withPatchReference('patches: []\n', file), `patches:\n  - path: ${file}\n`)
  const already = `patches:\n  - path: ./${file}\n`
  assertEquals(withPatchReference(already, file), already)
  // A flow-style list is not rewritten: the person edits it in Git.
  assertEquals(withPatchReference('patches: [{path: env.yaml}]\n', file), null)
})

Deno.test('the pull request branch names the function and the environment', () => {
  assertEquals(overridesBranch('orders', 'prod', 0), 'functions/orders-prod-0')
  assert(/^functions\/orders-dev-[0-9a-z]+$/.test(overridesBranch('Orders', 'dev')))
})

/* ───────────── metrics ───────────── */

Deno.test('request metrics ask for the OpenTelemetry names and the older Knative ones', () => {
  const q = functionMetricQueries('dev', 'orders')
  const rps = q.find((m) => m.id === 'rps')!.query
  assert(rps.includes('http_server_request_duration_seconds_count{k8s_namespace_name="dev",kn_service_name="orders"}'))
  assert(rps.includes(' or '))
  assert(rps.includes('revision_request_count{namespace_name="dev",service_name="orders"}'))
  const cpu = q.find((m) => m.id === 'cpu')!.query
  assert(cpu.includes('pod=~"orders-[0-9]+-deployment-.+",container="user-container"'))
  assertEquals(q.map((m) => m.id), ['rps', 'errors', 'p95', 'cpu', 'memory'])
})

/* ───────────── invoke helpers ───────────── */

Deno.test('header lines parse, and a malformed line is reported rather than guessed', () => {
  const { headers, errors } = parseHeaderLines('Content-Type: application/json\n# note\n\nX-Trace:  abc:def \nnot a header')
  assertEquals(headers, { 'Content-Type': 'application/json', 'X-Trace': 'abc:def' })
  assertEquals(errors, ['Line 5: expected "Name: value".'])
})

Deno.test('JSON bodies are indented, everything else is shown as it came', () => {
  assertEquals(prettyBody('{"a":1}', 'application/json'), '{\n  "a": 1\n}')
  assertEquals(prettyBody('{not json', 'application/json'), '{not json')
  assertEquals(prettyBody('hello', 'text/plain'), 'hello')
})

Deno.test('the drawer deep link is <namespace>/<name>', () => {
  assertEquals(functionRef('dev', 'orders'), 'dev/orders')
  assertEquals(parseFunctionRef('dev/orders'), { namespace: 'dev', name: 'orders' })
  assertEquals(parseFunctionRef('orders'), null)
  assertEquals(parseFunctionRef('dev/'), null)
})
