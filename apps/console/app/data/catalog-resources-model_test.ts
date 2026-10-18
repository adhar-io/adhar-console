import { assert, assertEquals } from 'jsr:@std/assert@1'
import type { ArgoTreeNode, KObj } from './catalog-composition-model.ts'
import { flatten, layoutTree } from './catalog-composition-model.ts'
import {
  buildAppGraph,
  comparable,
  diffChunks,
  envTabs,
  groupPods,
  hostnamesOf,
  imageTag,
  indexLive,
  lineDiff,
  managedIndex,
  networkGraph,
  oldReplicaSets,
  parseCpu,
  parseMem,
  podInfo,
  podRows,
  podUsage,
  resourceVisible,
  withLive,
  workloadReplicas,
} from './catalog-resources-model.ts'
import { toYaml } from './k8s-yaml.ts'

const APP: KObj = {
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Application',
  metadata: { name: 'orders-dev', namespace: 'argocd' },
  status: {
    sync: { status: 'OutOfSync' },
    health: { status: 'Degraded' },
    resources: [
      { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'dev', name: 'orders', status: 'Synced' },
      { version: 'v1', kind: 'Service', namespace: 'dev', name: 'orders', status: 'Synced' },
      { version: 'v1', kind: 'ConfigMap', namespace: 'dev', name: 'old', status: 'OutOfSync', requiresPruning: true },
      { group: 'gateway.networking.k8s.io', version: 'v1', kind: 'HTTPRoute', namespace: 'dev', name: 'orders', status: 'Synced' },
    ],
  },
}

const TREE: ArgoTreeNode[] = [
  { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'dev', name: 'orders', uid: 'd', health: { status: 'Degraded' }, images: ['ghcr.io/adhar/orders:1.4.2'] },
  { group: 'apps', version: 'v1', kind: 'ReplicaSet', namespace: 'dev', name: 'orders-new', uid: 'rn', parentRefs: [{ group: 'apps', kind: 'Deployment', namespace: 'dev', name: 'orders', uid: 'd' }], health: { status: 'Progressing' } },
  { group: 'apps', version: 'v1', kind: 'ReplicaSet', namespace: 'dev', name: 'orders-old', uid: 'ro', parentRefs: [{ group: 'apps', kind: 'Deployment', namespace: 'dev', name: 'orders', uid: 'd' }], health: { status: 'Healthy' } },
  { version: 'v1', kind: 'Pod', namespace: 'dev', name: 'orders-new-a', uid: 'p1', parentRefs: [{ group: 'apps', kind: 'ReplicaSet', namespace: 'dev', name: 'orders-new', uid: 'rn' }], health: { status: 'Degraded' }, info: [{ name: 'Status Reason', value: 'CrashLoopBackOff' }, { name: 'Restart Count', value: '7' }, { name: 'Containers', value: '0/1' }], networkingInfo: { labels: { app: 'orders' } }, images: ['ghcr.io/adhar/orders:1.4.2'] },
  { version: 'v1', kind: 'Pod', namespace: 'dev', name: 'orders-new-b', uid: 'p2', parentRefs: [{ group: 'apps', kind: 'ReplicaSet', namespace: 'dev', name: 'orders-new', uid: 'rn' }], health: { status: 'Healthy' }, networkingInfo: { labels: { app: 'orders' } } },
  { version: 'v1', kind: 'Pod', namespace: 'dev', name: 'stray', uid: 'p3', health: { status: 'Healthy' }, networkingInfo: { labels: { app: 'other' } } },
  { version: 'v1', kind: 'Service', namespace: 'dev', name: 'orders', uid: 's', health: { status: 'Healthy' }, networkingInfo: { targetLabels: { app: 'orders' } } },
  { version: 'v1', kind: 'Endpoints', namespace: 'dev', name: 'orders', uid: 'e', parentRefs: [{ kind: 'Service', namespace: 'dev', name: 'orders', uid: 's' }] },
  { version: 'v1', kind: 'ConfigMap', namespace: 'dev', name: 'old', uid: 'c' },
  { group: 'gateway.networking.k8s.io', version: 'v1', kind: 'HTTPRoute', namespace: 'dev', name: 'orders', uid: 'h', health: { status: 'Healthy' }, networkingInfo: { ingress: [{ hostname: 'orders.dev.example.com' }], targetRefs: [{ kind: 'Service', name: 'orders', namespace: 'dev' }] } },
]

Deno.test('app graph: Argo tree under the app, sync + prune from status.resources', () => {
  const g = buildAppGraph(APP, TREE)
  assertEquals(g.roots, ['argoproj.io/Application/argocd/orders-dev'])
  const root = g.nodes[g.roots[0]]
  assertEquals(root.status.level, 'degraded')
  assertEquals(root.status.sync, 'OutOfSync')
  assertEquals(g.nodes['apps/ReplicaSet/dev/orders-new'].parents, ['apps/Deployment/dev/orders'])
  assertEquals(g.nodes['core/Pod/dev/orders-new-a'].parents, ['apps/ReplicaSet/dev/orders-new'])
  assertEquals(g.nodes['core/Endpoints/dev/orders'].parents, ['core/Service/dev/orders'])
  const cm = g.nodes['core/ConfigMap/dev/old']
  assertEquals([cm.status.sync, cm.status.prune], ['OutOfSync', true])
  assertEquals(g.nodes['apps/Deployment/dev/orders'].images, ['ghcr.io/adhar/orders:1.4.2'])
})

Deno.test('old ReplicaSets fold away (live replicas 0, or no pods and healthy)', () => {
  const g = buildAppGraph(APP, TREE)
  assertEquals([...oldReplicaSets(g)], ['apps/ReplicaSet/dev/orders-old'])
  const vis = resourceVisible(g, {})!
  assert(!vis.has('apps/ReplicaSet/dev/orders-old'))
  assert(vis.has('apps/ReplicaSet/dev/orders-new'))
  assertEquals(resourceVisible(g, { showOld: true }), undefined)
  // a live RS scaled to zero is old even if Argo has not said so
  const live = indexLive([{ apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: { name: 'orders-new', namespace: 'dev' }, spec: { replicas: 0 }, status: {} }])
  assert(oldReplicaSets(withLive(g, live)).has('apps/ReplicaSet/dev/orders-new'))
  // filters keep ancestors and still hide the old RS
  const byHealth = resourceVisible(g, { health: 'degraded' })!
  assert(byHealth.has('core/Pod/dev/orders-new-a') && byHealth.has('apps/ReplicaSet/dev/orders-new') && byHealth.has(g.roots[0]))
  assert(!byHealth.has('core/Service/dev/orders'))
  const bySync = resourceVisible(g, { sync: 'OutOfSync' })!
  assert(bySync.has('core/ConfigMap/dev/old'))
  const rows = flatten(g, vis).map((r) => r.node.name)
  assert(!rows.includes('orders-old'))
  assert(layoutTree(g, vis).nodes.length === vis.size)
})

Deno.test('network view: route → service → selected pods, hostnames', () => {
  const g = networkGraph(buildAppGraph(APP, TREE))
  assertEquals(g.roots, ['gateway.networking.k8s.io/HTTPRoute/dev/orders'])
  assertEquals(g.nodes['gateway.networking.k8s.io/HTTPRoute/dev/orders'].children, ['core/Service/dev/orders'])
  assertEquals(g.nodes['core/Service/dev/orders'].children.sort(), ['core/Pod/dev/orders-new-a', 'core/Pod/dev/orders-new-b'])
  assert(!g.nodes['core/Pod/dev/stray'])
  assertEquals(hostnamesOf(g.nodes['gateway.networking.k8s.io/HTTPRoute/dev/orders']), ['orders.dev.example.com'])
  // from live specs when Argo has no networking info
  const bare = buildAppGraph(APP, TREE.map((n) => ({ ...n, networkingInfo: undefined })))
  const live = indexLive([
    { apiVersion: 'gateway.networking.k8s.io/v1', kind: 'HTTPRoute', metadata: { name: 'orders', namespace: 'dev' }, spec: { hostnames: ['o.example.com'], rules: [{ backendRefs: [{ name: 'orders', port: 80 }] }] } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'orders', namespace: 'dev' }, spec: { selector: { app: 'orders' } } },
    { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'orders-new-b', namespace: 'dev', labels: { app: 'orders', x: 'y' } }, spec: {}, status: { phase: 'Running' } },
  ])
  const g2 = networkGraph(withLive(bare, live))
  assertEquals(g2.nodes['core/Service/dev/orders'].children, ['core/Pod/dev/orders-new-b'])
  assertEquals(hostnamesOf(g2.nodes['gateway.networking.k8s.io/HTTPRoute/dev/orders']), ['o.example.com'])
})

Deno.test('pods: info from Argo or live, owner and node grouping, metrics', () => {
  const g0 = buildAppGraph(APP, TREE)
  const fromArgo = podInfo(g0.nodes['core/Pod/dev/orders-new-a'])!
  assertEquals([fromArgo.restarts, fromArgo.ready, fromArgo.reason], [7, '0/1', 'CrashLoopBackOff'])
  const live = indexLive([{
    apiVersion: 'v1', kind: 'Pod', metadata: { name: 'orders-new-b', namespace: 'dev' },
    spec: { nodeName: 'node-1', containers: [{ name: 'app', image: 'x:1' }, { name: 'sidecar', image: 'y:2' }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 2, state: { running: {} } }, { name: 'sidecar', ready: false, restartCount: 1, state: { waiting: { reason: 'ImagePullBackOff' } } }] },
  }])
  const g = withLive(g0, live)
  const b = podInfo(g.nodes['core/Pod/dev/orders-new-b'])!
  assertEquals([b.ready, b.restarts, b.nodeName, b.reason], ['1/2', 3, 'node-1', 'ImagePullBackOff'])
  assertEquals(b.containers.map((c) => c.state), ['running', 'waiting: ImagePullBackOff'])
  const usage = podUsage([{ metadata: { name: 'orders-new-b', namespace: 'dev' }, containers: [{ usage: { cpu: '250000000n', memory: '64Mi' } }, { usage: { cpu: '5m', memory: '1Gi' } }] }])
  const rows = podRows(g, usage)
  assertEquals(rows.map((r) => r.owner), ['Deployment/orders', 'Deployment/orders', '(no owner)'])
  assertEquals(rows.find((r) => r.node.name === 'orders-new-b')!.usage, { cpuMilli: 255, memBytes: 64 * 2 ** 20 + 2 ** 30 })
  const byNode = groupPods(rows, 'node')
  assertEquals(byNode.map((x) => x.key), ['node-1', 'Unscheduled'])
  const byOwner = groupPods(rows, 'owner')
  assertEquals(byOwner.map((x) => [x.key, x.rows.length, x.worst]), [['(no owner)', 1, 'healthy'], ['Deployment/orders', 2, 'degraded']])
  assertEquals([parseCpu('1'), parseCpu('500m'), parseMem('1Ki'), parseMem('2M')], [1000, 500, 1024, 2e6])
  assertEquals([imageTag('ghcr.io/a/b:1.2'), imageTag('localhost:5000/b'), imageTag('a@sha256:abcdef')], ['1.2', 'latest', 'sha256:abcdef'])
  assertEquals(workloadReplicas(withLive(g0, indexLive([{ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'orders', namespace: 'dev' }, spec: { replicas: 3 }, status: { readyReplicas: 1, replicas: 3 } }])).nodes['apps/Deployment/dev/orders']), { desired: 3, ready: 1, current: 3 })
})

Deno.test('desired vs live: managed-resources mapping and line diff', () => {
  const desired = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c', namespace: 'dev' }, data: { a: '1', b: '2' } }
  const liveObj = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c', namespace: 'dev', uid: 'u', resourceVersion: '9', managedFields: [{}], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{}' } }, data: { a: '1', b: '3' }, status: {} }
  const idx = managedIndex([
    { kind: 'ConfigMap', namespace: 'dev', name: 'c', targetState: JSON.stringify(desired), liveState: JSON.stringify(liveObj) },
    { group: 'apps', kind: 'Deployment', namespace: 'dev', name: 'gone', targetState: 'null', liveState: '{"kind":"Deployment","metadata":{"name":"gone"}}' },
  ])
  const c = idx.get('core/ConfigMap/dev/c')!
  assertEquals(comparable(c.live), { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c', namespace: 'dev' }, data: { a: '1', b: '3' } })
  assertEquals(idx.get('apps/Deployment/dev/gone')!.desired, undefined)
  const d = lineDiff(toYaml(comparable(c.desired)), toYaml(comparable(c.live)))
  assertEquals(d.filter((l) => l.type !== 'same').map((l) => `${l.type} ${l.text.trim()}`), ['del b: "2"', 'add b: "3"'])
  const big = lineDiff(Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 30 }, (_, i) => (i === 15 ? 'changed' : `l${i}`)).join('\n'))
  const chunks = diffChunks(big, 3)
  assertEquals(chunks.map((c) => c.type), ['skip', 'lines', 'skip'])
  assertEquals((chunks[0] as { count: number }).count, 12)
  assertEquals(lineDiff('a\nb', 'a\nb').every((l) => l.type === 'same'), true)
})

Deno.test('environment tabs follow Kargo order, then unscoped apps', () => {
  const app = (name: string) => ({ metadata: { name, namespace: 'argocd' } })
  const tabs = envTabs(
    [{ key: 'dev', label: 'Development', app: app('o-dev') }, { key: 'prod', label: 'Production', app: app('o-prod') }, { key: 'test', label: 'Test', app: app('o-test') }],
    [app('o-bootstrap'), app('o-dev')],
    ['dev', 'test', 'prod'],
  )
  assertEquals(tabs.map((t) => t.label), ['Development', 'Test', 'Production', 'o-bootstrap'])
  // A Kargo chain listing prod before test still shows dev → test → prod.
  assertEquals(
    envTabs([{ key: 'prod', label: 'Production', app: app('p') }, { key: 'dev', label: 'Development', app: app('d') }, { key: 'test', label: 'Test', app: app('t') }], [], ['prod', 'test', 'dev']).map((t) => t.label),
    ['Development', 'Test', 'Production'],
  )
  assertEquals(envTabs([{ key: 'b', label: 'B', app: app('b') }, { key: 'a', label: 'A', app: app('a') }], []).map((t) => t.label), ['B', 'A'])
})
