import { assertEquals } from 'jsr:@std/assert@^1'
import {
  browsableKinds,
  cellsFor,
  cellText,
  deriveStatus,
  type ExploreKind,
  groupKinds,
  groupLabel,
  indexTableRows,
  kindForObject,
  kindParam,
  kubectlGet,
  printerColumns,
  pushRecent,
  resolveKind,
  searchKinds,
  togglePin,
  toneCounts,
} from './explore.ts'

const k = (group: string, kind: string, name: string, extra: Partial<ExploreKind> = {}): ExploreKind => ({
  group,
  version: 'v1',
  kind,
  name,
  namespaced: true,
  verbs: ['get', 'list', 'watch'],
  ...extra,
})

const KINDS: ExploreKind[] = [
  k('', 'Pod', 'pods', { shortNames: ['po'], categories: ['all'] }),
  k('', 'Service', 'services', { shortNames: ['svc'] }),
  k('', 'ConfigMap', 'configmaps', { shortNames: ['cm'] }),
  k('', 'Event', 'events', { shortNames: ['ev'] }),
  k('', 'Namespace', 'namespaces', { namespaced: false, shortNames: ['ns'] }),
  k('apps', 'Deployment', 'deployments', { shortNames: ['deploy'] }),
  k('apps', 'StatefulSet', 'statefulsets', { shortNames: ['sts'] }),
  k('apps', 'DaemonSet', 'daemonsets', { shortNames: ['ds'] }),
  k('events.k8s.io', 'Event', 'events', { shortNames: ['ev'] }),
  k('argoproj.io', 'Application', 'applications', { shortNames: ['app', 'apps'] }),
  k('pkg.crossplane.io', 'Provider', 'providers', { namespaced: false }),
  k('apiextensions.crossplane.io', 'Composition', 'compositions', { namespaced: false }),
]

Deno.test('browsableKinds drops subresources, non-listable kinds and duplicate versions', () => {
  const out = browsableKinds([
    k('apps', 'Deployment', 'deployments'),
    { ...k('apps', 'Deployment', 'deployments'), version: 'v1beta2' },
    k('apps', 'Scale', 'deployments/scale', { subresource: true }),
    k('authorization.k8s.io', 'SelfSubjectAccessReview', 'selfsubjectaccessreviews', { verbs: ['create'] }),
  ])
  assertEquals(out.map((r) => `${r.name}@${r.version}`), ['deployments@v1'])
})

Deno.test('searchKinds ranks short names and prefixes first', () => {
  assertEquals(searchKinds(KINDS, 'svc')[0].kind, 'Service')
  assertEquals(searchKinds(KINDS, 'cm')[0].kind, 'ConfigMap')
  assertEquals(searchKinds(KINDS, 'deploy')[0].kind, 'Deployment')
  assertEquals(searchKinds(KINDS, 'po')[0].kind, 'Pod')
  // CamelCase word start: "set" finds the *Set kinds.
  assertEquals(searchKinds(KINDS, 'set').map((r) => r.kind).sort(), ['DaemonSet', 'StatefulSet'])
  // Group label match and multi-token queries.
  assertEquals(searchKinds(KINDS, 'crossplane').map((r) => r.kind).sort(), ['Composition', 'Provider'])
  assertEquals(searchKinds(KINDS, 'argo app')[0].kind, 'Application')
  // Subsequence fallback.
  assertEquals(searchKinds(KINDS, 'dplymnt')[0].kind, 'Deployment')
  assertEquals(searchKinds(KINDS, 'zzz'), [])
  // Ties prefer the built-in group.
  assertEquals(searchKinds(KINDS, 'events')[0].group, '')
})

Deno.test('resolveKind accepts kubectl-style names', () => {
  assertEquals(resolveKind(KINDS, 'deployments.apps')?.kind, 'Deployment')
  assertEquals(resolveKind(KINDS, 'deploy')?.kind, 'Deployment')
  assertEquals(resolveKind(KINDS, 'Deployment')?.kind, 'Deployment')
  assertEquals(resolveKind(KINDS, 'events')?.group, '')
  assertEquals(resolveKind(KINDS, 'events.events.k8s.io')?.group, 'events.k8s.io')
  assertEquals(resolveKind(KINDS, 'nope'), undefined)
  assertEquals(resolveKind(KINDS, ''), undefined)
  assertEquals(kindParam(KINDS[0]), 'pods')
  assertEquals(kindParam(KINDS[5]), 'deployments.apps')
})

Deno.test('kindForObject follows owner references', () => {
  assertEquals(kindForObject(KINDS, 'apps/v1', 'Deployment')?.name, 'deployments')
  assertEquals(kindForObject(KINDS, 'v1', 'Namespace')?.name, 'namespaces')
  assertEquals(kindForObject(KINDS, 'apps/v1', 'Missing'), undefined)
})

Deno.test('groupKinds orders Core, built-ins, then merged extensions', () => {
  const groups = groupKinds(KINDS)
  assertEquals(groups.map((g) => g.label), ['Core', 'Apps', 'Events', 'Argo', 'Crossplane'])
  assertEquals(groups[0].items.map((r) => r.kind), ['ConfigMap', 'Event', 'Namespace', 'Pod', 'Service'])
  assertEquals(groups.find((g) => g.label === 'Crossplane')?.groups.sort(), ['apiextensions.crossplane.io', 'pkg.crossplane.io'])
  assertEquals(groupLabel('example.com'), 'example.com')
})

Deno.test('pins and recents', () => {
  assertEquals(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c'])
  assertEquals(pushRecent(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b'])
  assertEquals(togglePin(['a'], 'b'), ['a', 'b'])
  assertEquals(togglePin(['a', 'b'], 'a'), ['b'])
})

Deno.test('deriveStatus: pods', () => {
  assertEquals(deriveStatus({ kind: 'Pod', status: { phase: 'Running', containerStatuses: [{ ready: true }] } }), {
    text: 'Running',
    tone: 'healthy',
    detail: undefined,
  })
  assertEquals(
    deriveStatus({ kind: 'Pod', status: { phase: 'Running', containerStatuses: [{ ready: true }, { ready: false }] } })?.detail,
    '1 of 2 containers ready.',
  )
  assertEquals(
    deriveStatus({
      kind: 'Pod',
      status: { phase: 'Running', containerStatuses: [{ ready: false, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } } }] },
    }),
    { text: 'CrashLoopBackOff', tone: 'failed', detail: 'back-off' },
  )
  assertEquals(
    deriveStatus({ kind: 'Pod', status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] } })?.tone,
    'progressing',
  )
  assertEquals(deriveStatus({ kind: 'Pod', status: { phase: 'Succeeded', containerStatuses: [] } })?.tone, 'healthy')
})

Deno.test('deriveStatus: controllers, conditions, health', () => {
  assertEquals(deriveStatus({ spec: { replicas: 3 }, status: { replicas: 3, readyReplicas: 2 } }), {
    text: 'Progressing',
    tone: 'progressing',
    detail: '2 of 3 replicas ready.',
  })
  assertEquals(deriveStatus({ spec: { replicas: 2 }, status: { replicas: 2, readyReplicas: 2 } })?.tone, 'healthy')
  assertEquals(deriveStatus({ spec: { replicas: 0 }, status: { observedGeneration: 2 } })?.text, 'Scaled to 0')
  assertEquals(deriveStatus({ status: { desiredNumberScheduled: 4, numberReady: 4 } })?.text, 'Ready')
  assertEquals(
    deriveStatus({
      spec: { replicas: 1 },
      status: { replicas: 1, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] },
    })?.tone,
    'failed',
  )
  // Nodes: Ready=True wins, pressure conditions are False.
  assertEquals(
    deriveStatus({ status: { conditions: [{ type: 'MemoryPressure', status: 'False' }, { type: 'Ready', status: 'True' }] } })?.text,
    'Ready',
  )
  assertEquals(
    deriveStatus({ status: { conditions: [{ type: 'DiskPressure', status: 'True' }, { type: 'Ready', status: 'True' }] } })?.tone,
    'degraded',
  )
  // Crossplane: Ready but Synced=False.
  assertEquals(
    deriveStatus({ status: { conditions: [{ type: 'Synced', status: 'False', message: 'boom' }, { type: 'Ready', status: 'True' }] } }),
    { text: 'Ready · sync failed', tone: 'degraded', detail: 'boom' },
  )
  assertEquals(
    deriveStatus({ status: { conditions: [{ type: 'Ready', status: 'False', reason: 'ReconcileError', message: 'x' }] } }),
    { text: 'ReconcileError', tone: 'failed', detail: 'x' },
  )
  assertEquals(deriveStatus({ status: { conditions: [{ type: 'Ready', status: 'False', reason: 'Issuing' }] } })?.tone, 'degraded')
  assertEquals(deriveStatus({ status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } })?.text, 'Pending')
  assertEquals(deriveStatus({ status: { conditions: [{ type: 'Complete', status: 'True' }] } })?.text, 'Complete')
  assertEquals(deriveStatus({ status: { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] } })?.tone, 'failed')
  assertEquals(deriveStatus({ status: { active: 1 } })?.text, 'Running')
  // Argo CD health + sync.
  assertEquals(deriveStatus({ status: { health: { status: 'Healthy' }, sync: { status: 'Synced' } } })?.tone, 'healthy')
  assertEquals(deriveStatus({ status: { health: { status: 'Healthy' }, sync: { status: 'OutOfSync' } } }), {
    text: 'Healthy · OutOfSync',
    tone: 'degraded',
    detail: undefined,
  })
  assertEquals(deriveStatus({ status: { phase: 'Bound' } })?.tone, 'healthy')
  assertEquals(deriveStatus({ metadata: { deletionTimestamp: '2026-01-01T00:00:00Z' }, status: { phase: 'Active' } })?.text, 'Terminating')
  // No status → no column.
  assertEquals(deriveStatus({}), null)
  assertEquals(deriveStatus({ status: {} }), null)
  assertEquals(deriveStatus({ status: { loadBalancer: {} } }), null)
})

Deno.test('toneCounts tallies derived statuses', () => {
  assertEquals(toneCounts([{ text: 'a', tone: 'healthy' }, null, { text: 'b', tone: 'healthy' }, { text: 'c', tone: 'failed' }]), {
    healthy: 2,
    failed: 1,
  })
})

Deno.test('printer columns come from the apiserver Table, minus our own', () => {
  const table = {
    kind: 'Table',
    columnDefinitions: [
      { name: 'Name', type: 'string', format: 'name', priority: 0 },
      { name: 'Ready', type: 'string', priority: 0 },
      { name: 'Up-to-date', type: 'integer', priority: 0 },
      { name: 'Age', type: 'string', priority: 0 },
      { name: 'Containers', type: 'string', priority: 1 },
    ],
    rows: [
      { cells: ['web', '2/2', 2, '5d', 'nginx'], object: { metadata: { uid: 'u1', name: 'web', namespace: 'shop' } } },
      { cells: ['api', '0/1', 1, '1h', 'api'], object: { metadata: { name: 'api', namespace: 'shop' } } },
    ],
  }
  const cols = printerColumns(table)
  assertEquals(cols.map((c) => [c.name, c.index, c.wide]), [['Ready', 1, false], ['Up-to-date', 2, false], ['Containers', 4, true]])
  const idx = indexTableRows(table)
  assertEquals(cellsFor(idx, { uid: 'u1', name: 'web', namespace: 'shop' })?.[1], '2/2')
  assertEquals(cellsFor(idx, { uid: 'other', name: 'api', namespace: 'shop' })?.[1], '0/1')
  assertEquals(cellsFor(idx, { name: 'gone', namespace: 'shop' }), undefined)
  assertEquals(printerColumns(null), [])
  assertEquals(cellText(['a', 'b']), 'a, b')
  assertEquals(cellText(null), '')
  assertEquals(cellText(3), '3')
})

Deno.test('kubectl command', () => {
  assertEquals(kubectlGet(KINDS[5], { name: 'web', namespace: 'shop' }), 'kubectl get deployments.apps web -n shop -o yaml')
  assertEquals(kubectlGet(KINDS[4], { name: 'shop' }), 'kubectl get namespaces shop -o yaml')
})
