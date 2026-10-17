import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  addArgoResources,
  buildCompositionGraph,
  type CompNode,
  type CompositionFetcher,
  deriveStatus,
  flatten,
  type KObj,
  layoutTree,
  nodeId,
  type ObjRef,
  parseXrAnnotation,
  rollup,
  rootCandidates,
  summarize,
  visibleNodes,
} from './catalog-composition-model.ts'

const cond = (type: string, status: string, reason?: string, message?: string) => ({ type, status, reason, message })

function obj(apiVersion: string, kind: string, name: string, namespace: string | undefined, rest: Partial<KObj> = {}): KObj {
  return { apiVersion, kind, metadata: { name, namespace, uid: `${kind}-${name}`, creationTimestamp: '2026-10-01T00:00:00Z' }, ...rest }
}

/** Fetcher over a fixture map keyed by nodeId; unknown refs 404, `forbidden` ids 403. */
function fixtureFetcher(objects: KObj[], extra: { forbidden?: string[]; trees?: Record<string, unknown[]> } = {}): CompositionFetcher & { calls: string[] } {
  const byId = new Map(objects.map((o) => [nodeId({ apiVersion: o.apiVersion, kind: o.kind!, namespace: o.metadata.namespace, name: o.metadata.name }), o]))
  const calls: string[] = []
  return {
    calls,
    get(ref: ObjRef) {
      const id = nodeId({ group: ref.group, apiVersion: ref.apiVersion, kind: ref.kind, namespace: ref.namespace, name: ref.name })
      calls.push(id)
      if (extra.forbidden?.includes(id)) return Promise.reject(Object.assign(new Error('forbidden'), { status: 403 }))
      const o = byId.get(id)
      return o ? Promise.resolve(o) : Promise.reject(Object.assign(new Error('not found'), { status: 404 }))
    },
    normalize: (ref: ObjRef) => (ref.kind === 'Namespace' ? { ...ref, namespace: undefined } : ref),
    argoTree(app) {
      const t = extra.trees?.[app.name]
      return t ? Promise.resolve(t as never) : Promise.reject(new Error('no tree'))
    },
  }
}

const XR = obj('platform.adhar.io/v1alpha1', 'Application', 'orders', 'adhar-system', {
  spec: {
    crossplane: {
      compositionRef: { name: 'application-default' },
      compositionRevisionRef: { name: 'application-default-abc' },
      resourceRefs: [
        { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', name: 'orders-dev' },
        { apiVersion: 'platform.adhar.io/v1alpha1', kind: 'Database', name: 'orders-db' },
        { apiVersion: 'kubernetes.m.crossplane.io/v1alpha1', kind: 'Object', name: 'orders-ns' },
        { apiVersion: 'kargo.akuity.io/v1alpha1', kind: 'Warehouse', name: 'orders' },
      ],
    },
  },
  status: { conditions: [cond('Synced', 'True'), cond('Ready', 'False', 'Creating')] },
})

const DB = obj('platform.adhar.io/v1alpha1', 'Database', 'orders-db', 'adhar-system', {
  spec: { crossplane: { resourceRefs: [{ apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', name: 'orders-db' }] } },
  status: { conditions: [cond('Synced', 'False', 'ReconcileError', 'cannot apply composed resource')] },
})

const ARGO = obj('argoproj.io/v1alpha1', 'Application', 'orders-dev', 'adhar-system', {
  status: {
    sync: { status: 'OutOfSync' },
    health: { status: 'Progressing' },
    resources: [
      { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'orders-dev', name: 'orders', status: 'Synced', health: { status: 'Progressing' } },
      { version: 'v1', kind: 'Service', namespace: 'orders-dev', name: 'orders', status: 'OutOfSync' },
    ],
  },
})

const OBJECT = obj('kubernetes.m.crossplane.io/v1alpha1', 'Object', 'orders-ns', 'adhar-system', {
  spec: { forProvider: { manifest: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'orders-dev' } } } },
  status: { conditions: [cond('Ready', 'True'), cond('Synced', 'True')] },
})

const NS = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'orders-dev' }, status: { phase: 'Active' } } as KObj

Deno.test('walks XR refs recursively, through Objects, into Argo trees', async () => {
  const tree = [
    { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'orders-dev', name: 'orders', uid: 'd1', health: { status: 'Progressing' } },
    { group: 'apps', version: 'v1', kind: 'ReplicaSet', namespace: 'orders-dev', name: 'orders-7c', uid: 'r1', parentRefs: [{ group: 'apps', kind: 'Deployment', namespace: 'orders-dev', name: 'orders', uid: 'd1' }], health: { status: 'Progressing' } },
    { version: 'v1', kind: 'Pod', namespace: 'orders-dev', name: 'orders-7c-x', uid: 'p1', parentRefs: [{ kind: 'ReplicaSet', namespace: 'orders-dev', name: 'orders-7c', uid: 'r1' }], health: { status: 'Degraded', message: 'CrashLoopBackOff' }, info: [{ name: 'Restart Count', value: '4' }] },
    { version: 'v1', kind: 'Service', namespace: 'orders-dev', name: 'orders', uid: 's1', health: { status: 'Healthy' } },
  ]
  const f = fixtureFetcher([XR, DB, ARGO, OBJECT, NS], { forbidden: ['kargo.akuity.io/Warehouse/adhar-system/orders'], trees: { 'orders-dev': tree } })
  const g = await buildCompositionGraph([{ ref: { apiVersion: XR.apiVersion, kind: 'Application', name: 'orders', namespace: 'adhar-system' }, object: XR }], f)

  const xrId = 'platform.adhar.io/Application/adhar-system/orders'
  assertEquals(g.roots, [xrId])
  const root = g.nodes[xrId]
  assertEquals(root.source, 'composite')
  assertEquals(root.composition, 'application-default')
  assertEquals(root.compositionRevision, 'application-default-abc')
  assertEquals(root.status.level, 'progressing')
  assertEquals(root.children.length, 4)

  // v2 namespaced XR: composed refs without a namespace inherit the XR's.
  const db = g.nodes['platform.adhar.io/Database/adhar-system/orders-db']
  assertEquals(db.status.level, 'degraded')
  assertEquals(db.status.reason, 'ReconcileError')
  // nested composite's composed resource 404s → missing node, not a crash
  const cluster = g.nodes['postgresql.cnpg.io/Cluster/adhar-system/orders-db']
  assertEquals(cluster.status.level, 'missing')
  assertEquals(cluster.parents, [db.id])

  // RBAC 403 → node says "No access"
  assertEquals(g.nodes['kargo.akuity.io/Warehouse/adhar-system/orders'].status.label, 'No access')

  // provider-kubernetes Object → wrapped manifest
  const ns = g.nodes['core/Namespace//orders-dev']
  assertEquals(ns.status.level, 'healthy')
  assertEquals(ns.parents, ['kubernetes.m.crossplane.io/Object/adhar-system/orders-ns'])

  // Argo app → tree with parentRefs: Deployment → ReplicaSet → Pod
  const app = g.nodes['argoproj.io/Application/adhar-system/orders-dev']
  assertEquals(app.source, 'argo-app')
  assertEquals(app.status.sync, 'OutOfSync')
  const dep = g.nodes['apps/Deployment/orders-dev/orders']
  assertEquals(dep.parents, [app.id])
  assertEquals(dep.status.sync, 'Synced')
  const pod = g.nodes['core/Pod/orders-dev/orders-7c-x']
  assertEquals(pod.parents, ['apps/ReplicaSet/orders-dev/orders-7c'])
  assertEquals(pod.status.level, 'degraded')
  assertEquals(pod.info, [{ name: 'Restart Count', value: '4' }])
  assertEquals(g.nodes['core/Service/orders-dev/orders'].status.sync, 'OutOfSync')
  // The Argo resources were not fetched one by one.
  assert(!f.calls.some((c) => c.startsWith('apps/')))

  const s = summarize(g)
  assertEquals(s.worst, 'degraded')
  assertEquals(s.outOfSync, 2)
  assertEquals(rollup(g, app.id), 'degraded')
})

Deno.test('falls back to status.resources when the Argo tree is unavailable', () => {
  const nodes: Record<string, CompNode> = {}
  const appId = 'argoproj.io/Application/argocd/orders-dev'
  nodes[appId] = { id: appId, group: 'argoproj.io', kind: 'Application', name: 'orders-dev', source: 'argo-app', status: { level: 'progressing', label: 'Progressing' }, conditions: [], children: [], parents: [] }
  addArgoResources(nodes, appId, ARGO, undefined, { name: 'orders-dev' })
  assertEquals(nodes[appId].children.sort(), ['apps/Deployment/orders-dev/orders', 'core/Service/orders-dev/orders'])
  assertEquals(nodes['core/Service/orders-dev/orders'].status.level, 'progressing')
  assertEquals(nodes['core/Service/orders-dev/orders'].status.label, 'OutOfSync')
})

Deno.test('claims point at their composite; cycles and duplicates are read once', async () => {
  const claim = obj('platform.adhar.io/v1alpha1', 'DatabaseClaim', 'db', 'team-a', {
    spec: { resourceRef: { apiVersion: 'platform.adhar.io/v1alpha1', kind: 'XDatabase', name: 'db-xyz' } },
    status: { conditions: [cond('Ready', 'True'), cond('Synced', 'True')] },
  })
  const xr = obj('platform.adhar.io/v1alpha1', 'XDatabase', 'db-xyz', undefined, {
    spec: {
      compositionRef: { name: 'db' },
      resourceRefs: [
        { apiVersion: 'v1', kind: 'Secret', name: 's', namespace: 'team-a' },
        { apiVersion: 'v1', kind: 'Secret', name: 's', namespace: 'team-a' },
        { apiVersion: 'platform.adhar.io/v1alpha1', kind: 'DatabaseClaim', name: 'db', namespace: 'team-a' },
      ],
    },
    status: { conditions: [cond('Ready', 'True')] },
  })
  const secret = obj('v1', 'Secret', 's', 'team-a')
  const f = fixtureFetcher([claim, xr, secret])
  const g = await buildCompositionGraph([{ ref: { apiVersion: claim.apiVersion, kind: claim.kind!, name: 'db', namespace: 'team-a' } }], f)
  assertEquals(g.nodes['platform.adhar.io/DatabaseClaim/team-a/db'].source, 'claim')
  assertEquals(g.nodes['platform.adhar.io/XDatabase//db-xyz'].source, 'composite')
  assertEquals(f.calls.filter((c) => c === 'core/Secret/team-a/s').length, 1)
  // the back-edge to the claim is not linked (would be a cycle)
  assertEquals(g.nodes['platform.adhar.io/DatabaseClaim/team-a/db'].parents, [])
  assertEquals(flatten(g).map((r) => [r.node.kind, r.depth]), [['DatabaseClaim', 0], ['XDatabase', 1], ['Secret', 2]])
})

Deno.test('node cap marks the graph truncated', async () => {
  const refs = Array.from({ length: 10 }, (_, i) => ({ apiVersion: 'v1', kind: 'ConfigMap', name: `c${i}`, namespace: 'x' }))
  const root = obj('platform.adhar.io/v1alpha1', 'Application', 'a', 'x', { spec: { crossplane: { resourceRefs: refs } } })
  const g = await buildCompositionGraph([{ ref: { apiVersion: root.apiVersion, kind: 'Application', name: 'a', namespace: 'x' }, object: root }], fixtureFetcher([root]), { maxNodes: 4 })
  assert(g.truncated)
  assertEquals(Object.keys(g.nodes).length, 4)
})

Deno.test('deriveStatus covers Crossplane, workloads, pods and Argo apps', () => {
  assertEquals(deriveStatus(obj('x.io/v1', 'X', 'a', 'n', { status: { conditions: [cond('Ready', 'True'), cond('Synced', 'True')] } })).level, 'healthy')
  assertEquals(deriveStatus(obj('x.io/v1', 'X', 'a', 'n', { status: { conditions: [cond('Ready', 'False', 'ReconcileError')] } })).level, 'degraded')
  assertEquals(deriveStatus({ ...obj('x.io/v1', 'X', 'a', 'n', { status: { conditions: [cond('Ready', 'True')] } }), metadata: { name: 'a', annotations: { 'crossplane.io/paused': 'true' } } }).level, 'suspended')
  assertEquals(deriveStatus(obj('apps/v1', 'Deployment', 'a', 'n', { spec: { replicas: 3 }, status: { availableReplicas: 1 } })).label, '1/3 ready')
  assertEquals(deriveStatus(obj('apps/v1', 'Deployment', 'a', 'n', { spec: { replicas: 2 }, status: { availableReplicas: 2 } })).level, 'healthy')
  assertEquals(deriveStatus(obj('apps/v1', 'Deployment', 'a', 'n', { spec: { replicas: 2 }, status: { conditions: [cond('Progressing', 'False', 'ProgressDeadlineExceeded')] } })).level, 'degraded')
  assertEquals(deriveStatus(obj('v1', 'Pod', 'p', 'n', { status: { phase: 'Running', containerStatuses: [{ ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } })).label, 'CrashLoopBackOff')
  assertEquals(deriveStatus(obj('v1', 'Pod', 'p', 'n', { status: { phase: 'Running', containerStatuses: [{ ready: true }] } })).level, 'healthy')
  const argo = deriveStatus(obj('argoproj.io/v1alpha1', 'Application', 'a', 'argocd', { status: { health: { status: 'Healthy' }, sync: { status: 'Synced' }, operationState: { phase: 'Failed', message: 'hook failed' } } }))
  assertEquals([argo.level, argo.sync, argo.message], ['degraded', 'Synced', 'hook failed'])
  assertEquals(deriveStatus(obj('v1', 'ConfigMap', 'c', 'n')).level, 'none')
})

Deno.test('filters keep ancestors; layout centres parents on children', async () => {
  const f = fixtureFetcher([XR, DB, ARGO, OBJECT, NS])
  const g = await buildCompositionGraph([{ ref: { apiVersion: XR.apiVersion, kind: 'Application', name: 'orders', namespace: 'adhar-system' }, object: XR }], f)
  const vis = visibleNodes(g, { unhealthyOnly: true })!
  assert(vis.has('platform.adhar.io/Database/adhar-system/orders-db'))
  assert(vis.has(g.roots[0]))
  assert(!vis.has('core/Namespace//orders-dev'))
  assertEquals(visibleNodes(g, {}), undefined)
  const byKind = visibleNodes(g, { kind: 'Namespace' })!
  assertEquals([...byKind].sort(), ['core/Namespace//orders-dev', 'kubernetes.m.crossplane.io/Object/adhar-system/orders-ns', g.roots[0]].sort())

  const layout = layoutTree(g)
  const pos = new Map(layout.nodes.map((n) => [n.id, n]))
  assertEquals(pos.get(g.roots[0])!.col, 0)
  assert(layout.rows >= 4)
  const kids = g.nodes[g.roots[0]].children.map((c) => pos.get(c)!.row)
  assertEquals(pos.get(g.roots[0])!.row, (Math.min(...kids) + Math.max(...kids)) / 2)
  const collapsed = layoutTree(g, undefined, new Set([g.roots[0]]))
  assertEquals(collapsed.nodes.length, 1)
})

Deno.test('entity → root candidates', () => {
  assertEquals(parseXrAnnotation('Database.platform.adhar.io/team-a/orders-db'), { kind: 'Database', group: 'platform.adhar.io', namespace: 'team-a', name: 'orders-db' })
  assertEquals(parseXrAnnotation('Application/orders'), { kind: 'Application', group: undefined, name: 'orders' })
  assertEquals(parseXrAnnotation('nonsense'), undefined)
  const c = rootCandidates({ kind: 'Component', metadata: { name: 'orders' } })
  assertEquals(c[0], { kind: 'Application', group: 'platform.adhar.io', namespace: 'adhar-system', name: 'orders', via: 'Application XR named like the entity' })
  const explicit = rootCandidates({ kind: 'Component', metadata: { name: 'x', annotations: { 'adhar.io/xr': 'Cache/team/x-cache' } } })
  assertEquals(explicit.length, 1)
  assertEquals(explicit[0].namespace, 'team')
  assertEquals(rootCandidates({ kind: 'Group', metadata: { name: 'platform' } })[0].labelSelector, 'adhar.io/team=platform')
  assertEquals(rootCandidates({ kind: 'User', metadata: { name: 'u' } }), [])
})
