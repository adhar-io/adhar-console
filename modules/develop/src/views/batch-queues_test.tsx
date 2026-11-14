import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { setActiveTeam } from '@adhar/shell-ui'
import { Batch } from './batch.tsx'
import { BatchQueues } from './batch-queues.tsx'
import { RunGang } from '../components/batch/gang.tsx'
import type { BatchJobList, BatchJobXR } from '../data/batch-model.ts'
import type { PodGroup, SchedulerDescriptor, VolcanoQueue } from '../data/batch-queues-model.ts'
import type { PodGroupList, QueueList } from '../data/batch-queues-api.ts'
import { runGangKey } from '../data/batch-queues.ts'

/**
 * Develop → Batch → Queues rendered from a seeded query cache: the tab exists
 * only where Volcano is installed, and each state says what it knows — the
 * leaves, the gangs and why they wait — and nothing it does not.
 */

function page(seed: (qc: QueryClient) => void, ui: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function withLocation<T>(search: string, fn: () => T): T {
  const g = globalThis as unknown as { location?: unknown }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { value: { search, pathname: '/develop', protocol: 'https:' }, configurable: true })
  try {
    return fn()
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had)
    else delete g.location
  }
}

const job: BatchJobXR = {
  metadata: { name: 'settlement', namespace: 'shop-prod', labels: { 'adhar.io/organisation': 'acme', 'adhar.io/team': 'payments', 'adhar.io/application': 'settlement', 'adhar.io/environment': 'prod' } },
  spec: { parameters: { job: 'settleJob', image: 'img', mode: 'partitioned', workers: 4 } },
  status: { scheduler: 'volcano', queue: 'acme-payments-prod' },
}
const list: BatchJobList = { items: [job], scope: 'cluster', namespaces: ['shop-prod'], denied: [], installed: true }
const NAMES = 'acme-payments-dev,acme-payments-prod,acme-payments-test'

const queue = (name: string, spec: VolcanoQueue['spec'] = {}, status: VolcanoQueue['status'] = {}): VolcanoQueue => ({
  metadata: { name },
  spec: { parent: 'adhar-batch', ...spec },
  status: { state: 'Open', ...status },
})

const waitingGang: PodGroup = {
  metadata: {
    name: 'settlement-aa-0f1e',
    namespace: 'shop-prod',
    creationTimestamp: '2026-11-01T09:00:00Z',
    labels: { 'adhar.io/batch-job': 'settlement' },
    ownerReferences: [{ apiVersion: 'batch.volcano.sh/v1alpha1', kind: 'Job', name: 'settlement-aa' }],
  },
  spec: { minMember: 5, queue: 'acme-payments-prod', minResources: { cpu: '2500m', memory: '5Gi' } },
  status: { phase: 'Pending', conditions: [{ type: 'Unschedulable', status: 'True', message: '5/5 tasks in gang unschedulable: 0/3 nodes are available, 3 Insufficient cpu' }] },
}

function seedQueues(qc: QueryClient, q: Partial<QueueList>, pgs: Partial<PodGroupList> = {}, d: SchedulerDescriptor = { state: 'present', scheduler: 'volcano' }, names = NAMES) {
  qc.setQueryData(['batch', 'scheduler-descriptor'], d)
  qc.setQueryData(['batch', 'queues', 'adhar-batch', names], { items: [], scope: 'cluster', denied: [], missing: [], ...q })
  qc.setQueryData(['batch', 'podgroups', 'cluster', 'shop-prod'], { items: [], partial: false, ...pgs })
}

const queuesView = (ui: ReactNode = <BatchQueues list={list} projects={[]} onOpenRun={() => {}} />) => ui

Deno.test('tab: Queues exists only where discovery says Volcano is installed', () => {
  const seedBatch = (qc: QueryClient, volcano: boolean) => {
    qc.setQueryData(['batch', 'jobs', 'dev,prod,test'], list)
    qc.setQueryData(['batch', 'volcano'], { queues: volcano, podgroups: volcano })
  }
  const without = page((qc) => seedBatch(qc, false), <Batch />)
  assertStringIncludes(without, 'Runs')
  assert(!without.includes('>Queues<'), 'no Queues tab without Volcano')
  const withIt = page((qc) => seedBatch(qc, true), <Batch />)
  assertStringIncludes(withIt, '>Queues<')
  // A link to ?view=queues on a cluster without Volcano lands on Jobs, not on a broken tab.
  const deep = withLocation('?section=batch&view=queues', () => page((qc) => seedBatch(qc, false), <Batch />))
  assertStringIncludes(deep, 'settlement')
  assert(!deep.includes('Gangs waiting'))
})

Deno.test('queues: a leaf shows its capability, share, allocation and what waits in it', () => {
  const html = page((qc) =>
    seedQueues(qc, {
      items: [
        queue('adhar-batch', { parent: 'root', capability: { cpu: '12', memory: '24Gi' } }, { allocated: { cpu: '4', memory: '8Gi' } }),
        queue('acme-payments-prod', { capability: { cpu: '4', memory: '8Gi' }, deserved: { cpu: '2', memory: '4Gi' }, reclaimable: false, priority: 300 }, { allocated: { cpu: '4', memory: '6Gi' }, running: 1, pending: 1 }),
        queue('acme-payments-dev', { capability: { cpu: '4', memory: '8Gi' }, reclaimable: true, priority: 100 }),
      ],
    }, { items: [waitingGang] }), queuesView())
  // The hierarchy's ceiling, and the leaves in tier order without the root as a row.
  assertStringIncludes(html, 'All batch shares')
  assertStringIncludes(html, '12 CPU · 24 GiB')
  assert(html.indexOf('acme-payments-dev') < html.indexOf('acme-payments-prod'), 'dev before prod')
  assertStringIncludes(html, '4 CPU · 8 GiB')
  assertStringIncludes(html, '2 CPU · 4 GiB')
  // Allocated at capability with a gang waiting: the BatchQueueSaturated condition.
  assertStringIncludes(html, 'Saturated')
  assertStringIncludes(html, 'needs 2.5 CPU · 5 GiB')
  // The waiting gang: its run, progress, and Volcano's own reason.
  assertStringIncludes(html, 'settlement-aa')
  assertStringIncludes(html, '0 of 5')
  assertStringIncludes(html, 'Waiting for room')
  assertStringIncludes(html, '3 Insufficient cpu')
})

Deno.test('queues: a team member who may read none of its leaves is told so, not shown an empty hierarchy', () => {
  const html = page((qc) => seedQueues(qc, { scope: 'names', denied: ['acme-payments-dev', 'acme-payments-prod'] }), queuesView())
  assertStringIncludes(html, 'You may not read these batch queues')
  assertStringIncludes(html, 'acme-payments-dev, acme-payments-prod')
  assert(!html.includes('No batch queues for your team yet'))
})

Deno.test('queues: no leaves yet names what was looked for', () => {
  const html = page((qc) => seedQueues(qc, { scope: 'names', missing: ['acme-payments-dev', 'acme-payments-prod', 'acme-payments-test'] }), queuesView())
  assertStringIncludes(html, 'No batch queues for your team yet')
  assertStringIncludes(html, 'acme-payments-test')
  assert(!html.includes('You may not read'))
})

Deno.test('queues: Volcano served but batch on the native path says why nothing waits here', () => {
  const html = page((qc) => seedQueues(qc, { items: [queue('acme-payments-prod')] }, {}, { state: 'absent' }), queuesView())
  assertStringIncludes(html, 'native Kubernetes path')
  const unknown = page((qc) => seedQueues(qc, { items: [queue('acme-payments-prod')] }, {}, { state: 'unknown' }), queuesView())
  assert(!unknown.includes('native Kubernetes path'), 'a descriptor the caller may not read is not reported as absent')
})

Deno.test('queues: the team lens narrows to the active team, and never to nothing', () => {
  const items = [queue('acme-payments-prod'), queue('acme-web-dev'), queue('acme-web-prod')]
  try {
    setActiveTeam('web')
    const web = page((qc) => seedQueues(qc, { items }), queuesView())
    assertStringIncludes(web, 'acme-web-dev')
    assert(!web.includes('acme-payments-prod'))
    setActiveTeam('data')
    const none = page((qc) => seedQueues(qc, { items }), queuesView())
    for (const n of ['acme-payments-prod', 'acme-web-dev', 'acme-web-prod']) assertStringIncludes(none, n)
  } finally {
    setActiveTeam('')
  }
})

Deno.test('queues: unreadable PodGroups are named, so no gangs is not read as none', () => {
  const html = page((qc) => seedQueues(qc, { items: [queue('acme-payments-prod')] }, { partial: true }), queuesView())
  assertStringIncludes(html, 'not every gang')
})

Deno.test('run gang: the drawer section shows the gang, and nothing for a run without one', () => {
  const html = page((qc) => {
    qc.setQueryData(['batch', 'volcano'], { queues: true, podgroups: true })
    qc.setQueryData(runGangKey('shop-prod', 'settlement-aa'), waitingGang)
  }, <RunGang namespace='shop-prod' run='settlement-aa' />)
  assertStringIncludes(html, 'Gang')
  assertStringIncludes(html, '0 of 5')
  assertStringIncludes(html, 'acme-payments-prod')
  assertStringIncludes(html, 'Insufficient cpu')
  const none = page((qc) => {
    qc.setQueryData(['batch', 'volcano'], { queues: true, podgroups: true })
    qc.setQueryData(runGangKey('shop-prod', 'import-0aa'), null)
  }, <RunGang namespace='shop-prod' run='import-0aa' />)
  assertEquals(none, '')
  // Without Volcano nothing renders, even with a gang left in the cache from before it was removed.
  assertEquals(page((qc) => {
    qc.setQueryData(['batch', 'volcano'], { queues: false, podgroups: false })
    qc.setQueryData(runGangKey('shop-prod', 'settlement-aa'), waitingGang)
  }, <RunGang namespace='shop-prod' run='settlement-aa' />), '')
})
