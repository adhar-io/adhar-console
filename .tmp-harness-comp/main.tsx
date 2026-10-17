import './styles.css'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@adhar/shell-ui'
import { useCompositionRoots } from '~/data/catalog-composition.ts'
import { CompositionTab } from '~/routes/_catalog-composition.tsx'
import { RawTab } from '~/routes/_catalog-raw.tsx'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const mode = params.get('mode') ?? 'full'

const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const cond = (type: string, status: string, reason?: string, message?: string) => ({ type, status, reason, message, lastTransitionTime: t(30) })

const D = (group: string, version: string, kind: string, name: string, namespaced = true) => ({ group, version, groupVersion: group ? `${group}/${version}` : version, kind, name, namespaced, verbs: ['get', 'list'], subresource: false })
const discovery = [
  ...(mode === 'nocrd' ? [] : [D('platform.adhar.io', 'v1alpha1', 'Application', 'applications'), D('platform.adhar.io', 'v1alpha1', 'Database', 'databases'), D('platform.adhar.io', 'v1alpha1', 'Cache', 'caches')]),
  D('argoproj.io', 'v1alpha1', 'Application', 'applications'),
  D('kubernetes.m.crossplane.io', 'v1alpha1', 'Object', 'objects'),
  D('kargo.akuity.io', 'v1alpha1', 'Warehouse', 'warehouses'),
  D('postgresql.cnpg.io', 'v1', 'Cluster', 'clusters'),
  D('apiextensions.crossplane.io', 'v1', 'Composition', 'compositions', false),
  D('apiextensions.crossplane.io', 'v1', 'CompositionRevision', 'compositionrevisions', false),
  D('', 'v1', 'Namespace', 'namespaces', false),
  D('', 'v1', 'Event', 'events'),
]

const objects: Record<string, unknown> = {
  '/apis/platform.adhar.io/v1alpha1/namespaces/adhar-system/applications/orders': {
    apiVersion: 'platform.adhar.io/v1alpha1', kind: 'Application',
    metadata: { name: 'orders', namespace: 'adhar-system', uid: '4a1c-orders', resourceVersion: '991', generation: 3, creationTimestamp: t(60 * 26), labels: { 'adhar.io/application': 'orders', 'adhar.io/project': 'adhar', 'adhar.io/managed-by': 'adhar-console' }, annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"big":"json"}', 'crossplane.io/composition-resource-name': 'app' }, managedFields: [{ manager: 'adhar-console', operation: 'Apply', fieldsV1: { 'f:spec': {} } }] },
    spec: {
      parameters: { project: 'adhar', displayName: 'orders', source: { repoURL: 'https://gitea/adhar/orders.git', path: 'deploy', targetRevision: 'main' } },
      crossplane: {
        compositionRef: { name: 'application.platform.adhar.io' },
        compositionRevisionRef: { name: 'application.platform.adhar.io-7f3a2c' },
        resourceRefs: [
          { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', name: 'orders-dev' },
          { apiVersion: 'platform.adhar.io/v1alpha1', kind: 'Database', name: 'orders-db' },
          { apiVersion: 'kubernetes.m.crossplane.io/v1alpha1', kind: 'Object', name: 'orders-ns' },
          { apiVersion: 'kargo.akuity.io/v1alpha1', kind: 'Warehouse', name: 'orders' },
        ],
      },
    },
    status: { conditions: [cond('Synced', 'True', 'ReconcileSuccess'), cond('Ready', 'False', 'Creating', 'Unready resources: orders-db')] },
  },
  '/apis/platform.adhar.io/v1alpha1/namespaces/adhar-system/databases/orders-db': {
    apiVersion: 'platform.adhar.io/v1alpha1', kind: 'Database', metadata: { name: 'orders-db', namespace: 'adhar-system', creationTimestamp: t(60 * 26), uid: 'db-1' },
    spec: { crossplane: { resourceRefs: [{ apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', name: 'orders-db' }] } },
    status: { conditions: [cond('Synced', 'False', 'ReconcileError', 'cannot apply composed resource "cluster": admission webhook denied the request: spec.instances must be >= 1'), cond('Ready', 'False', 'Creating')] },
  },
  '/apis/postgresql.cnpg.io/v1/namespaces/adhar-system/clusters/orders-db': {
    apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', metadata: { name: 'orders-db', namespace: 'adhar-system', creationTimestamp: t(60 * 25) }, status: { phase: 'Setting up primary' },
  },
  '/apis/kubernetes.m.crossplane.io/v1alpha1/namespaces/adhar-system/objects/orders-ns': {
    apiVersion: 'kubernetes.m.crossplane.io/v1alpha1', kind: 'Object', metadata: { name: 'orders-ns', namespace: 'adhar-system', creationTimestamp: t(60 * 26) },
    spec: { forProvider: { manifest: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'orders-dev' } } } },
    status: { conditions: [cond('Ready', 'True', 'Available'), cond('Synced', 'True', 'ReconcileSuccess')] },
  },
  '/api/v1/namespaces/orders-dev': { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'orders-dev', creationTimestamp: t(60 * 26) }, status: { phase: 'Active' } },
  '/apis/argoproj.io/v1alpha1/namespaces/adhar-system/applications/orders-dev': {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'Application', metadata: { name: 'orders-dev', namespace: 'adhar-system', creationTimestamp: t(60 * 26) },
    spec: { project: 'adhar', source: { repoURL: 'https://gitea/adhar/orders.git', path: 'deploy', targetRevision: 'main' }, destination: { server: 'https://kubernetes.default.svc', namespace: 'orders-dev' } },
    status: {
      sync: { status: 'OutOfSync', revision: 'abc123' }, health: { status: 'Degraded', message: 'Deployment orders has 0/2 ready' },
      resources: [
        { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'orders-dev', name: 'orders', status: 'Synced', health: { status: 'Degraded' } },
        { version: 'v1', kind: 'Service', namespace: 'orders-dev', name: 'orders', status: 'Synced', health: { status: 'Healthy' } },
        { version: 'v1', kind: 'ConfigMap', namespace: 'orders-dev', name: 'orders-config', status: 'OutOfSync' },
        { group: 'gateway.networking.k8s.io', version: 'v1', kind: 'HTTPRoute', namespace: 'orders-dev', name: 'orders', status: 'Synced', health: { status: 'Healthy' } },
      ],
    },
  },
  '/apis/apiextensions.crossplane.io/v1/compositions/application.platform.adhar.io': {
    apiVersion: 'apiextensions.crossplane.io/v1', kind: 'Composition', metadata: { name: 'application.platform.adhar.io', creationTimestamp: t(60 * 24 * 9) },
    spec: { compositeTypeRef: { apiVersion: 'platform.adhar.io/v1alpha1', kind: 'Application' }, mode: 'Pipeline', pipeline: [{ step: 'render', functionRef: { name: 'function-go-templating' }, input: { apiVersion: 'gotemplating.fn.crossplane.io/v1beta1', kind: 'GoTemplate', source: 'Inline', inline: { template: '---\napiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: {{ .observed.composite.resource.metadata.name }}-dev\n' } } }, { step: 'ready', functionRef: { name: 'function-auto-ready' } }] },
  },
}

const tree = [
  { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'orders-dev', name: 'orders', uid: 'd1', createdAt: t(60 * 25), health: { status: 'Degraded', message: 'Deployment "orders" exceeded its progress deadline' }, info: [{ name: 'Revision', value: 'Rev:4' }] },
  { group: 'apps', version: 'v1', kind: 'ReplicaSet', namespace: 'orders-dev', name: 'orders-7c9f', uid: 'r1', createdAt: t(40), parentRefs: [{ group: 'apps', kind: 'Deployment', namespace: 'orders-dev', name: 'orders', uid: 'd1' }], health: { status: 'Progressing' } },
  { version: 'v1', kind: 'Pod', namespace: 'orders-dev', name: 'orders-7c9f-x2k4', uid: 'p1', createdAt: t(39), parentRefs: [{ group: 'apps', kind: 'ReplicaSet', namespace: 'orders-dev', name: 'orders-7c9f', uid: 'r1' }], health: { status: 'Degraded', message: 'back-off 5m0s restarting failed container' }, info: [{ name: 'Status Reason', value: 'CrashLoopBackOff' }, { name: 'Restart Count', value: '12' }] },
  { version: 'v1', kind: 'Pod', namespace: 'orders-dev', name: 'orders-7c9f-9qz1', uid: 'p2', createdAt: t(39), parentRefs: [{ group: 'apps', kind: 'ReplicaSet', namespace: 'orders-dev', name: 'orders-7c9f', uid: 'r1' }], health: { status: 'Healthy' } },
  { version: 'v1', kind: 'Service', namespace: 'orders-dev', name: 'orders', uid: 's1', createdAt: t(60 * 25), health: { status: 'Healthy' } },
  { version: 'v1', kind: 'Endpoints', namespace: 'orders-dev', name: 'orders', uid: 'e1', createdAt: t(60 * 25), parentRefs: [{ kind: 'Service', namespace: 'orders-dev', name: 'orders', uid: 's1' }] },
  { version: 'v1', kind: 'ConfigMap', namespace: 'orders-dev', name: 'orders-config', uid: 'c1', createdAt: t(60 * 25) },
  { group: 'gateway.networking.k8s.io', version: 'v1', kind: 'HTTPRoute', namespace: 'orders-dev', name: 'orders', uid: 'h1', createdAt: t(60 * 25), health: { status: 'Healthy' } },
]

const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const u = new URL(href, location.origin)
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
  if (u.pathname.startsWith('/api/k8s')) {
    const p = u.pathname.slice('/api/k8s'.length)
    if (mode === 'forbidden') return json({ kind: 'Status', reason: 'Forbidden', code: 403, message: 'forbidden' }, 403)
    if (p === '/-/discovery') return json({ resources: discovery, cached: true })
    if (p.includes('/warehouses/')) return json({ kind: 'Status', reason: 'Forbidden', code: 403, message: 'warehouses.kargo.akuity.io "orders" is forbidden: User "dev" cannot get resource "warehouses"' }, 403)
    if (p.endsWith('/events')) return json({ items: [
      { metadata: { name: 'e1', creationTimestamp: t(3) }, type: 'Warning', reason: 'ComposeResources', message: 'cannot apply composed resource "cluster": admission webhook denied the request', count: 14, lastTimestamp: t(1), source: { component: 'crossplane' } },
      { metadata: { name: 'e2', creationTimestamp: t(20) }, type: 'Normal', reason: 'SelectComposition', message: 'Successfully selected composition revision', count: 1, lastTimestamp: t(20) },
    ] })
    if (/\/(databases|caches)$/.test(p)) return json({ items: [] })
    if (objects[p]) return json(objects[p])
    if (mode === 'empty' && p.includes('applications/orders')) return json({ kind: 'Status', code: 404, reason: 'NotFound' }, 404)
    return json({ kind: 'Status', reason: 'NotFound', code: 404, message: `${p} not found` }, 404)
  }
  if (u.pathname.includes('/resource-tree')) return json({ nodes: tree })
  return realFetch(input, init)
}) as typeof fetch

const entity = {
  apiVersion: 'backstage.io/v1alpha1' as const,
  kind: 'Component' as const,
  metadata: { name: mode === 'empty' ? 'lonely' : 'orders', namespace: 'default', title: 'Orders', description: 'Order service', tags: ['application', 'go'], annotations: { 'backstage.io/source-location': 'url:https://gitea/adhar/orders', 'adhar.io/owner': 'team-a' }, createdAt: t(60 * 26), updatedAt: t(5) },
  spec: { type: 'service' as const, owner: 'group:team-a', lifecycle: 'production' as const, system: 'system:commerce' },
  origin: 'live' as const,
}
const argoApps = mode === 'empty' ? [] : [{ metadata: { name: 'orders-dev', namespace: 'adhar-system' } }]

function App() {
  const roots = useCompositionRoots(entity as never, argoApps, true)
  const tab = params.get('tab') ?? 'composition'
  return (
    <div className="min-h-screen bg-surface-canvas p-4 sm:p-6">
      <div className="mx-auto max-w-[880px]">
        {tab === 'raw' ? <RawTab entity={entity as never} roots={roots} relationCount={3} /> : <CompositionTab roots={roots} />}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ToastProvider>
      <App />
    </ToastProvider>
  </QueryClientProvider>,
)
