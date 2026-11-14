import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import { lensOrAll } from '@adhar/shell-ui'
import {
  belongsToTeam,
  candidateQueueNames,
  descriptorOf,
  formatBytes,
  formatCores,
  formatRes,
  gangProgress,
  gangRow,
  gangRows,
  nativePathNote,
  type PodGroup,
  parseQuantity,
  queueRows,
  queuesStateOf,
  resOf,
  rootOf,
  tierOf,
  type VolcanoQueue,
} from './batch-queues-model.ts'
import type { BatchJobXR } from './batch-model.ts'

/**
 * The Queues tab's rules (design 0025 §4.3, §4.5, §7.2, §11.3): which leaves are
 * the team's, what a gang's progress is, and when a queue is saturated — each
 * against the objects Volcano v1.16 actually serves (`scheduling.volcano.sh/v1beta1`).
 */

const NOW = Date.parse('2026-11-14T10:00:00Z')

const queue = (name: string, o: { parent?: string; labels?: Record<string, string>; spec?: VolcanoQueue['spec']; status?: VolcanoQueue['status'] } = {}): VolcanoQueue => ({
  apiVersion: 'scheduling.volcano.sh/v1beta1',
  kind: 'Queue',
  metadata: { name, labels: o.labels },
  spec: { parent: o.parent ?? 'adhar-batch', ...o.spec },
  status: { state: 'Open', ...o.status },
})

const pg = (name: string, o: { queue?: string; phase?: string; min?: number; running?: number; succeeded?: number; created?: string; owner?: { apiVersion: string; name: string }; conditions?: NonNullable<PodGroup['status']>['conditions']; min_res?: Record<string, string>; labels?: Record<string, string> } = {}): PodGroup => ({
  metadata: {
    name,
    namespace: 'shop-prod',
    creationTimestamp: o.created ?? '2026-11-14T09:50:00Z',
    labels: o.labels,
    ownerReferences: o.owner ? [{ apiVersion: o.owner.apiVersion, kind: 'Job', name: o.owner.name, controller: true }] : undefined,
  },
  spec: { minMember: o.min ?? 5, queue: o.queue ?? 'acme-payments-prod', minResources: o.min_res },
  status: { phase: o.phase ?? 'Pending', running: o.running, succeeded: o.succeeded, conditions: o.conditions },
})

Deno.test('quantities: cores and bytes the way manifests write them', () => {
  assertEquals(parseQuantity('2'), 2)
  assertEquals(parseQuantity('500m'), 0.5)
  assertEquals(parseQuantity('4Gi'), 4 * 2 ** 30)
  assertEquals(parseQuantity('1G'), 1e9)
  assertEquals(parseQuantity('1.5'), 1.5)
  assertEquals(parseQuantity('1e3'), 1000)
  assertEquals(parseQuantity(3), 3)
  assertEquals(parseQuantity('lots'), undefined)
  assertEquals(parseQuantity('2Xi'), undefined)
  assertEquals(parseQuantity(undefined), undefined)
  assertEquals(formatCores(0.25), '250m')
  assertEquals(formatCores(2), '2')
  assertEquals(formatCores(1.5), '1.5')
  assertEquals(formatBytes(4 * 2 ** 30), '4 GiB')
  assertEquals(formatBytes(512 * 2 ** 20), '512 MiB')
  assertEquals(formatRes(resOf({ cpu: '2', memory: '4Gi', 'nvidia.com/gpu': '1' })), '2 CPU · 4 GiB · 1 nvidia.com/gpu')
  assertEquals(formatRes(resOf(undefined)), '—')
})

Deno.test('names: a job’s reported queue wins, and every tier of its team is a candidate', () => {
  const jobs: BatchJobXR[] = [
    { metadata: { name: 'settle', namespace: 'shop-prod', labels: { 'adhar.io/organisation': 'acme', 'adhar.io/team': 'payments' } }, status: { queue: 'acme-payments-prod' } },
    { metadata: { name: 'import', namespace: 'web-dev' }, spec: { parameters: { organisation: 'acme', team: 'web' } } },
    // A queue the composition reported that does not follow the pattern is still read.
    { metadata: { name: 'odd', namespace: 'x' }, status: { queue: 'legacy-leaf' } },
  ]
  const projects = [{ metadata: { name: 'ledger' }, spec: { parameters: { organisation: 'acme', team: 'finance' } } }]
  assertEquals(candidateQueueNames(jobs, projects), [
    'acme-finance-dev',
    'acme-finance-prod',
    'acme-finance-test',
    'acme-payments-dev',
    'acme-payments-prod',
    'acme-payments-test',
    'acme-web-dev',
    'acme-web-prod',
    'acme-web-test',
    'legacy-leaf',
  ])
  // Without both an organisation and a team there is nothing to name.
  assertEquals(candidateQueueNames([{ metadata: { name: 'a', labels: { 'adhar.io/team': 'payments' } } }]), [])
  // A Project that omitted both parameters: what its composition RESOLVED (status) names the team.
  assertEquals(candidateQueueNames([], [{ metadata: { name: 'shop' }, status: { organisation: 'adhar', team: 'platform' } }]), [
    'adhar-platform-dev',
    'adhar-platform-prod',
    'adhar-platform-test',
  ])
  // ...and the resolved value wins over a parameter it overrode.
  assertEquals(candidateQueueNames([], [{ metadata: { name: 'x' }, spec: { parameters: { organisation: 'old', team: 'web' } }, status: { organisation: 'acme', team: 'web' } }])[0], 'acme-web-dev')
})

Deno.test('rows: only the leaves of the batch hierarchy, never the root or Volcano’s own', () => {
  const qs = [
    queue('adhar-batch', { parent: 'root', spec: { capability: { cpu: '12', memory: '24Gi' } }, status: { allocated: { cpu: '3', memory: '6Gi' } } }),
    queue('default', { parent: 'root' }),
    queue('root', { parent: '' }),
    queue('acme-payments-prod'),
    queue('acme-payments-dev'),
    queue('acme-payments-test'),
    queue('scratch', { parent: 'root' }),
    // Tier-named but parentless: Volcano files it under its own root, not under adhar-batch.
    { metadata: { name: 'ml-research-prod' }, spec: {}, status: { state: 'Open' } },
  ]
  const rows = queueRows(qs, [])
  assertEquals(rows.map((r) => r.name), ['acme-payments-dev', 'acme-payments-test', 'acme-payments-prod'])
  assertEquals(rows.map((r) => r.tier), ['dev', 'test', 'prod'])
  const root = rootOf(qs)
  assertEquals(root?.used, 0.25)
  assertEquals(rootOf(qs.slice(1)), undefined)
  // A root the descriptor renamed is honoured.
  assertEquals(queueRows([queue('acme-payments-prod', { parent: 'batch' })], [], 'batch').length, 1)
  assertEquals(queueRows([queue('acme-payments-prod', { parent: 'batch' })], []).length, 0)
})

Deno.test('tier: the environment label first, the name’s suffix second', () => {
  assertEquals(tierOf(queue('acme-payments-prod')), 'prod')
  assertEquals(tierOf(queue('acme-payments-x', { labels: { 'adhar.io/environment': 'test' } })), 'test')
  assertEquals(tierOf(queue('acme-payments-staging')), undefined)
  // The label the Team composition actually stamps on its leaves.
  assertEquals(tierOf(queue('acme-payments-x', { labels: { 'adhar.io/tier': 'dev' } })), 'dev')
})

Deno.test('saturated: allocated at capability WITH work waiting — the BatchQueueSaturated condition', () => {
  const full = { capability: { cpu: '4', memory: '8Gi' } }
  const gangs = gangRows([pg('g1', { queue: 'acme-payments-prod', min_res: { cpu: '2', memory: '2Gi' } })], NOW)
  const sat = queueRows([queue('acme-payments-prod', { spec: full, status: { allocated: { cpu: '4', memory: '6Gi' } } })], gangs)[0]
  assertEquals(sat.level, 'saturated')
  assertEquals(sat.waiting, 1)
  assertEquals(sat.demand.cpu, 2)
  assertEquals(sat.used, 1)
  // At capability with nothing waiting is not saturated.
  const idle = queueRows([queue('acme-payments-prod', { spec: full, status: { allocated: { cpu: '4' } } })], [])[0]
  assertEquals(idle.level, 'ok')
  // Waiting, with room left, is not saturated either.
  const room = queueRows([queue('acme-payments-prod', { spec: full, status: { allocated: { cpu: '1' } } })], gangs)[0]
  assertEquals(room.level, 'ok')
  // Volcano's own in-queue count is demand even when the caller cannot read the PodGroups.
  const counted = queueRows([queue('acme-payments-prod', { spec: full, status: { allocated: { memory: '8Gi' }, inqueue: 2 } })], [])[0]
  assertEquals(counted.level, 'saturated')
})

Deno.test('over-share: past deserved on a reclaimable leaf, which prod may take back', () => {
  const dev = queue('acme-payments-dev', { spec: { reclaimable: true, deserved: { cpu: '0' }, capability: { cpu: '4' } }, status: { allocated: { cpu: '2' } } })
  assertEquals(queueRows([dev], [])[0].level, 'over-share')
  // A dev leaf exactly as compositions/team/local.yaml emits it — reclaimable, NO deserved — is
  // best-effort to Volcano's capacity plugin: anything it holds is reclaimable, so it is over share.
  const composedDev = queue('acme-payments-dev', { spec: { reclaimable: true, capability: { cpu: '4', memory: '8Gi' } }, status: { allocated: { cpu: '1', memory: '1Gi' } } })
  assertEquals(queueRows([composedDev], [])[0].level, 'over-share')
  const idleDev = queue('acme-payments-dev', { spec: { reclaimable: true, capability: { cpu: '4' } }, status: {} })
  assertEquals(queueRows([idleDev], [])[0].level, 'ok')
  // A guarantee is a share too (Volcano: deserved = max(deserved, guarantee)).
  const guaranteed = queue('acme-payments-test', { spec: { reclaimable: true, guarantee: { resource: { cpu: '2' } } }, status: { allocated: { cpu: '1' } } })
  assertEquals(queueRows([guaranteed], [])[0].level, 'ok')
  const prod = queue('acme-payments-prod', { spec: { reclaimable: false, deserved: { cpu: '2' }, capability: { cpu: '4' } }, status: { allocated: { cpu: '3' } } })
  assertEquals(queueRows([prod], [])[0].level, 'ok')
  const closed = queue('acme-payments-test', { status: { state: 'Closed' } })
  assertEquals(queueRows([closed], [])[0].level, 'closed')
})

Deno.test('gang: progress, owner, wait and Volcano’s reason', () => {
  const g = gangRow(pg('settle-4f2a', {
    owner: { apiVersion: 'batch.volcano.sh/v1alpha1', name: 'settlement-1a2b3c4d' },
    labels: { 'adhar.io/batch-job': 'settlement' },
    created: '2026-11-14T09:20:00Z',
    conditions: [
      { type: 'Unschedulable', status: 'True', message: 'older', lastTransitionTime: '2026-11-14T09:21:00Z' },
      { type: 'Unschedulable', status: 'True', message: '5/5 tasks in gang unschedulable: 0/3 nodes are available, 3 Insufficient cpu', lastTransitionTime: '2026-11-14T09:40:00Z' },
      { type: 'Scheduled', status: 'False', message: 'not this one', lastTransitionTime: '2026-11-14T09:59:00Z' },
    ],
  }), NOW)
  assertEquals(g.run, { name: 'settlement-1a2b3c4d', kind: 'VolcanoJob' })
  assertEquals(g.batchJob, 'settlement')
  assertEquals(g.waitingMs, 40 * 60_000)
  assert(g.overdue, 'past the 30 minute BatchGangPending threshold')
  assertEquals(g.reason, '5/5 tasks in gang unschedulable: 0/3 nodes are available, 3 Insufficient cpu')
  assertEquals(gangProgress(g), { label: '0 of 5', fraction: 0 })

  const native = gangRow(pg('podgroup-abc', { owner: { apiVersion: 'batch/v1', name: 'import-0aa' }, phase: 'Running', min: 1, running: 1 }), NOW)
  assertEquals(native.run, { name: 'import-0aa', kind: 'Job' })
  assertEquals(native.waitingMs, undefined)
  assertEquals(native.reason, undefined)
  assert(!native.overdue)
  assertEquals(gangProgress(native), { label: '1 of 1', fraction: 1 })

  const fresh = gangRow(pg('fresh', { created: '2026-11-14T09:59:00Z' }), NOW)
  assert(!fresh.overdue, 'a minute is not a stuck gang')
})

Deno.test('gangs: finished ones drop out, the longest wait comes first', () => {
  const rows = gangRows([
    pg('running', { phase: 'Running', running: 5 }),
    pg('done', { phase: 'Completed', succeeded: 5 }),
    pg('new', { created: '2026-11-14T09:58:00Z' }),
    pg('old', { created: '2026-11-14T08:00:00Z' }),
    pg('inq', { phase: 'Inqueue' }),
  ], NOW)
  assertEquals(rows.map((r) => r.name), ['old', 'new', 'inq', 'running'])
})

Deno.test('team lens: by label, by name, and never an empty page', () => {
  const qs = [
    queue('acme-payments-prod', { labels: { 'adhar.io/team': 'payments' } }),
    queue('acme-web-dev'),
    queue('acme-web-prod'),
  ]
  assertEquals(lensOrAll(qs, (q) => belongsToTeam(q, 'web')).map((q) => q.metadata.name), ['acme-web-dev', 'acme-web-prod'])
  assertEquals(lensOrAll(qs, (q) => belongsToTeam(q, 'payments')).map((q) => q.metadata.name), ['acme-payments-prod'])
  // A team with no leaves here shows the organisation's rather than nothing.
  assertEquals(lensOrAll(qs, (q) => belongsToTeam(q, 'data')).length, 3)
  // A label that names another team is believed over a name that happens to match.
  assert(!belongsToTeam(queue('acme-web-prod', { labels: { 'adhar.io/team': 'payments' } }), 'web'))
})

Deno.test('descriptor: absent means the native path, refused means unknown', () => {
  assertEquals(descriptorOf(null).state, 'absent')
  assertEquals(descriptorOf(undefined, true).state, 'unknown')
  const d = descriptorOf({ data: { scheduler: 'volcano', version: 'v1.16.0', gang: 'true', rootQueue: 'adhar-batch', prodDeservedCPU: '2', prodDeservedMemory: '4Gi' } })
  assertEquals(d, { state: 'present', scheduler: 'volcano', version: 'v1.16.0', gang: true, rootQueue: 'adhar-batch', prodDeservedCPU: '2', prodDeservedMemory: '4Gi' })
  assertEquals(nativePathNote(d), undefined)
  assert(nativePathNote(descriptorOf(null))?.includes('native Kubernetes path'))
  assert(nativePathNote(descriptorOf({ data: { scheduler: 'kubernetes' } }))?.includes('kubernetes scheduler'))
  assertEquals(nativePathNote(descriptorOf(null, true)), undefined)
})

Deno.test('state: refused, empty and loading are told apart', () => {
  assertEquals(queuesStateOf({ isLoading: true, isError: false }, 0), 'loading')
  assertEquals(queuesStateOf({ isLoading: false, isError: true }, 0), 'error')
  assertEquals(queuesStateOf({ isLoading: false, isError: false, data: { items: [], denied: ['acme-web-dev'] } }, 0), 'forbidden')
  assertEquals(queuesStateOf({ isLoading: false, isError: false, data: { items: [], denied: [] } }, 0), 'empty')
  assertEquals(queuesStateOf({ isLoading: false, isError: false, data: { items: [{}], denied: ['x'] } }, 1), 'ready')
  // Read something, but none of it a team leaf: empty, not refused.
  assertEquals(queuesStateOf({ isLoading: false, isError: false, data: { items: [{}], denied: ['x'] } }, 0), 'empty')
})
