import { assert, assertMatch, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { renderToStaticMarkup } from 'npm:react-dom@^19.2.0/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { accessCheckKey } from '@adhar/auth'
import { canResource } from '@adhar/shell-ui'
import { actionGates, type BatchJobXR, jobRows, type RunObject, type RunPod } from '../../data/batch-model.ts'
import type { PodGroup, VolcanoQueue } from '../../data/batch-queues-model.ts'
import { runGangKey } from '../../data/batch-queues.ts'
import { type DrawerFrame, RunDrawer } from './run-drawer.tsx'
import { JobDrawer } from './job-drawer.tsx'

/**
 * The two drawers on a cluster with Volcano (Phase 2 stage 2): the run drawer's
 * Gang section (FU-9) and Volcano task roles, a Volcano Job that is not a batch
 * run offering nothing (ST-6), and the job drawer's Scheduling section — the
 * queue a job targets and the DEC-3 warning when its gang does not fit. Each is
 * also rendered WITHOUT Volcano, where none of it may appear.
 */

const DrawerShell: DrawerFrame = ({ header, children, footer }) => <div>{header}{children}{footer}</div>

function mount(seed: (qc: QueryClient) => void, ui: ReactNode): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(qc)
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const NS = 'shop-prod'
const VOLCANO = { queues: true, podgroups: true }
const NO_VOLCANO = { queues: false, podgroups: false }
const seedVolcano = (qc: QueryClient, apis = VOLCANO) => qc.setQueryData(['batch', 'volcano'], apis)

const LABELS = { 'adhar.io/batch-job': 'settlement', 'adhar.io/application': 'settlement', 'adhar.io/environment': 'prod', 'adhar.io/organisation': 'acme', 'adhar.io/team': 'payments' }

const vcjob = (name: string, phase: string, labels: Record<string, string> = LABELS): RunObject => ({
  apiVersion: 'batch.volcano.sh/v1alpha1',
  kind: 'Job',
  metadata: { name, namespace: NS, uid: 'u-vc', creationTimestamp: '2026-11-14T09:00:00Z', labels },
  spec: { queue: 'acme-payments-prod', tasks: [{ name: 'manager', replicas: 1, template: { spec: { containers: [{ name: 'batch', image: 'img' }] } } }, { name: 'worker', replicas: 4, template: { spec: { containers: [{ name: 'batch', image: 'img' }] } } }] },
  status: { state: { phase } },
})

const gang = (phase: string, extra: Partial<PodGroup['status']> = {}): PodGroup => ({
  metadata: {
    name: 'settlement-aa-u-vc',
    namespace: NS,
    creationTimestamp: '2026-11-14T09:00:00Z',
    labels: { 'adhar.io/batch-job': 'settlement' },
    ownerReferences: [{ apiVersion: 'batch.volcano.sh/v1alpha1', kind: 'Job', name: 'settlement-aa', uid: 'u-vc' }],
  },
  spec: { minMember: 5, queue: 'acme-payments-prod', minResources: { cpu: '2500m', memory: '5Gi' } },
  status: { phase, conditions: phase === 'Pending' ? [{ type: 'Unschedulable', status: 'True', message: '5/5 tasks in gang unschedulable: 0/3 nodes are available, 3 Insufficient cpu' }] : [], ...extra },
})

const vpod = (task: 'manager' | 'worker', index: number): RunPod => ({
  metadata: {
    name: `settlement-aa-${task}-${index}`,
    namespace: NS,
    creationTimestamp: '2026-11-14T09:01:00Z',
    labels: { 'adhar.io/batch-job': 'settlement', 'volcano.sh/job-name': 'settlement-aa', 'volcano.sh/task-spec': task },
    annotations: { 'volcano.sh/task-index': String(index) },
  },
  status: { phase: 'Running', containerStatuses: [{ name: 'batch', state: { running: {} } }] },
})

function seedGates(qc: QueryClient, action: Parameters<typeof actionGates>[0], target: Parameters<typeof actionGates>[1], allowed: boolean) {
  for (const g of actionGates(action, target)) {
    qc.setQueryData(['k8s', 'can', '', accessCheckKey(canResource(g.gvr, g.verb, { namespace: g.namespace, name: g.name, subresource: g.subresource })), 'anonymous'], allowed)
  }
}

const runDrawer = (r: RunObject, seed: (qc: QueryClient) => void, tab = 'overview', pods: RunPod[] = []) =>
  mount((qc) => {
    qc.setQueryData(['batch', 'run', NS, r.metadata.name, 'VolcanoJob'], r)
    qc.setQueryData(['batch', 'run-pods', NS, r.metadata.name, 'VolcanoJob'], { items: pods, forbidden: false })
    seed(qc)
  }, <RunDrawer namespace={NS} name={r.metadata.name} kind='VolcanoJob' tab={tab} existingNames={[]} onTab={() => {}} onClose={() => {}} onOpenRun={() => {}} Frame={DrawerShell} />)

/* ─────────────────────────── run drawer ─────────────────────────── */

Deno.test('run drawer: a Volcano run shows its gang — phase, members up of its size, and why it waits (FU-9)', () => {
  const html = runDrawer(vcjob('settlement-aa', 'Pending'), (qc) => {
    seedVolcano(qc)
    qc.setQueryData(runGangKey(NS, 'settlement-aa', 'u-vc'), gang('Pending'))
  })
  assertMatch(html, /<h3[^>]*>Gang<\/h3>/)
  assertStringIncludes(html, 'Waiting for room')
  assertStringIncludes(html, '0 of 5')
  assertStringIncludes(html, 'acme-payments-prod')
  assertStringIncludes(html, '3 Insufficient cpu')
  assertStringIncludes(html, 'All 5 members start together or none does')
  // Running: the counts, and no wait reason left over from the wait.
  const running = runDrawer(vcjob('settlement-aa', 'Running'), (qc) => {
    seedVolcano(qc)
    qc.setQueryData(runGangKey(NS, 'settlement-aa', 'u-vc'), gang('Running', { running: 5 }))
  })
  assertStringIncludes(running, '5 of 5')
  assertStringIncludes(running, '5 running')
  assert(!running.includes('Insufficient cpu'))
  assert(!running.includes('start together or none does'))
})

Deno.test('run drawer: a gang cached for another run of the same name is not shown for this one', () => {
  // A Job and a Volcano Job of one name, or a run recreated under its old name: different uids, different gangs.
  assert(JSON.stringify(runGangKey(NS, 'settlement-aa', 'u-vc')) !== JSON.stringify(runGangKey(NS, 'settlement-aa', 'u-native')))
  const html = runDrawer(vcjob('settlement-aa', 'Pending'), (qc) => {
    seedVolcano(qc)
    qc.setQueryData(runGangKey(NS, 'settlement-aa', 'u-native'), gang('Running', { running: 5 }))
  })
  assert(!/<h3[^>]*>Gang<\/h3>/.test(html))
})

Deno.test('run drawer: without Volcano there is no Gang section, whatever the cache holds', () => {
  const html = runDrawer(vcjob('settlement-aa', 'Pending'), (qc) => {
    seedVolcano(qc, NO_VOLCANO)
    qc.setQueryData(runGangKey(NS, 'settlement-aa', 'u-vc'), gang('Pending'))
  })
  assert(!/<h3[^>]*>Gang<\/h3>/.test(html))
  assert(!html.includes('0 of 5'))
})

Deno.test('run drawer: Volcano pods are labelled by their task, so worker 0 is not the manager', () => {
  const html = runDrawer(vcjob('settlement-aa', 'Running'), seedVolcano, 'pods', [vpod('manager', 0), vpod('worker', 0), vpod('worker', 3)])
  assertMatch(html, /settlement-aa-manager-0<\/button><\/td><td[^>]*>manager #0</)
  assertMatch(html, /settlement-aa-worker-0<\/button><\/td><td[^>]*>worker #0</)
  assertMatch(html, /settlement-aa-worker-3<\/button><\/td><td[^>]*>worker #3</)
})

Deno.test('run drawer: a Volcano Job that is not a batch run is offered no Stop, Resume or Restart, and says why (ST-6)', () => {
  const { 'adhar.io/batch-job': _, ...notBatch } = LABELS
  const target = { namespace: NS, name: 'train-aa', kind: 'VolcanoJob' as const }
  const allowAll = (qc: QueryClient) => {
    seedVolcano(qc)
    for (const a of ['stop', 'resume', 'restart'] as const) seedGates(qc, a, target, true)
  }
  for (const phase of ['Running', 'Aborted', 'Failed']) {
    const html = runDrawer(vcjob('train-aa', phase, notBatch), allowAll)
    for (const b of ['>Stop<', '>Resume<', '>Restart<']) assert(!html.includes(b), `${phase}: ${b}`)
    assertStringIncludes(html, 'This Volcano Job carries no')
  }
  // The same Volcano Job as a batch run gets its AbortJob-backed Stop.
  const batch = runDrawer(vcjob('train-aa', 'Running'), allowAll)
  assertStringIncludes(batch, '>Stop<')
  assert(!batch.includes('This Volcano Job carries no'))
})

/* ─────────────────────────── job drawer: Scheduling (DEC-3) ─────────────────────────── */

const NOW = Date.parse('2026-11-14T09:40:00Z')

const job = (p: NonNullable<BatchJobXR['spec']>['parameters'] = {}, status: BatchJobXR['status'] = { scheduler: 'volcano', queue: 'acme-payments-prod' }): BatchJobXR => ({
  metadata: { name: 'settlement', namespace: NS, labels: LABELS },
  spec: { parameters: { job: 'settleJob', image: 'img', mode: 'partitioned', workers: 4, resources: { cpu: '500m', memory: '1Gi' }, ...p } },
  status,
})

const PROD: VolcanoQueue = {
  metadata: { name: 'acme-payments-prod', labels: { 'adhar.io/tier': 'prod', 'adhar.io/team': 'payments' } },
  spec: { parent: 'adhar-batch', capability: { cpu: '8', memory: '16Gi' }, deserved: { cpu: '2', memory: '4Gi' }, reclaimable: false },
  status: { state: 'Open', allocated: { cpu: '1', memory: '2Gi' } },
}

const jobDrawer = (j: BatchJobXR, seed: (qc: QueryClient) => void) => {
  const row = jobRows([j], [], { now: NOW })[0]
  return mount(seed, <JobDrawer row={row} now={NOW} tab='overview' onTab={() => {}} onClose={() => {}} onOpenRun={() => {}} Frame={DrawerShell} />)
}

const seedScheduling = (qc: QueryClient, leaf: { state: 'present' | 'missing' | 'denied'; leaf?: VolcanoQueue }, gangs: PodGroup[] = []) => {
  seedVolcano(qc)
  qc.setQueryData(['batch', 'queues', 'one', 'acme-payments-prod'], leaf)
  qc.setQueryData(['batch', 'scheduler-descriptor'], { state: 'present', scheduler: 'volcano', rootQueue: 'adhar-batch', prodDeservedCPU: '2', prodDeservedMemory: '4Gi' })
  qc.setQueryData(['batch', 'podgroups', 'namespace', NS], { items: gangs, forbidden: false })
}

Deno.test('job drawer: Scheduling names the queue, the gang and what it asks for, and the job’s waiting gang', () => {
  const html = jobDrawer(job({ resources: { cpu: '250m', memory: '512Mi' } }), (qc) => seedScheduling(qc, { state: 'present', leaf: PROD }, [gang('Pending')]))
  assertMatch(html, /<h3[^>]*>Scheduling<\/h3>/)
  assertMatch(html, /Queue<\/dt><dd[^>]*><span[^>]*><span[^>]*>acme-payments-prod<\/span>/)
  assertStringIncludes(html, '5 pods (1 manager + 4 workers), all-or-nothing')
  assertMatch(html, /Requests<\/dt><dd[^>]*>1.25 CPU · 2.5 GiB</)
  assertMatch(html, /Capability<\/dt><dd[^>]*>8 CPU · 16 GiB</)
  assertMatch(html, /Deserved<\/dt><dd[^>]*>2 CPU · 4 GiB</)
  assertMatch(html, /Allocated<\/dt><dd[^>]*>1 CPU · 2 GiB</)
  // Its gang, waiting, with Volcano's reason.
  assertMatch(html, /<td[^>]*>settlement-aa<\/td>/)
  assertStringIncludes(html, '3 Insufficient cpu')
  assertStringIncludes(html, '40m')
  // It fits: no warning.
  assert(!html.includes('cannot reclaim'))
  assert(!html.includes('can ever hold'))
})

Deno.test('job drawer: a gang over the prod share in every dimension is warned about, not left silently Pending (DEC-3)', () => {
  const html = jobDrawer(job(), (qc) => seedScheduling(qc, { state: 'present', leaf: PROD }))
  assertStringIncludes(html, 'Its gang of 5 (1 manager + 4 workers) asks for 2.5 CPU · 5 GiB')
  assertStringIncludes(html, 'cannot reclaim capacity from dev and test runs')
  const never = jobDrawer(job({ resources: { cpu: '500m', memory: '4Gi' } }), (qc) => seedScheduling(qc, { state: 'present', leaf: PROD }))
  assertStringIncludes(never, 'more than queue acme-payments-prod can ever hold')
})

Deno.test('job drawer: a prod leaf that does not exist, or cannot be read, is said', () => {
  const missing = jobDrawer(job(), (qc) => seedScheduling(qc, { state: 'missing' }))
  assertStringIncludes(missing, 'Queue acme-payments-prod does not exist')
  // Unreadable: the descriptor's prod share still answers, and the page says the queue itself is hidden.
  const denied = jobDrawer(job(), (qc) => seedScheduling(qc, { state: 'denied' }))
  assertStringIncludes(denied, 'You may not read this queue')
  assertStringIncludes(denied, 'more than the platform’s 2 CPU · 4 GiB prod share')
  assertStringIncludes(denied, '(the platform’s prod share)')
})

Deno.test('job drawer: an unreadable leaf is not warned about from the default prod share when the composition says it fits', () => {
  // The team's prod leaf is larger than the platform default; the composition read it.
  const fits = job({}, { scheduler: 'volcano', queue: 'acme-payments-prod', conditions: [{ type: 'QueueFits', status: 'True', reason: 'Fits', message: 'runs on queue acme-payments-prod' }] })
  const html = jobDrawer(fits, (qc) => seedScheduling(qc, { state: 'denied' }))
  assertMatch(html, /<h3[^>]*>Scheduling<\/h3>/)
  assertStringIncludes(html, 'You may not read this queue')
  assert(!html.includes('cannot reclaim'))
})

Deno.test('job drawer: the composition’s QueueFits condition is the warning when it is there', () => {
  const j = job({ resources: { cpu: '250m', memory: '512Mi' } }, {
    scheduler: 'volcano',
    queue: 'acme-payments-prod',
    conditions: [{ type: 'QueueFits', status: 'False', reason: 'QueueRejected', message: 'the prod leaf acme-payments-prod was refused: the batch root has no deserved share left' }],
  })
  const html = jobDrawer(j, (qc) => seedScheduling(qc, { state: 'present', leaf: PROD }))
  // In the Scheduling section's warning, above its facts — not only in the Conditions table further down.
  assertMatch(html, /<h3[^>]*>Scheduling<\/h3>(?:(?!<dt).)*the batch root has no deserved share left(?:(?!<dt).)*<dl/s)
})

Deno.test('job drawer: a job kept off Volcano because its prod leaf is unavailable still gets the warning (DEC-3)', () => {
  // What the composition renders when the batch root refused the team's prod leaf:
  // the native scheduler, no status.queue, and QueueFits=False LeafQueueUnavailable.
  const message = 'queue acme-payments-prod does not exist: Team acme-payments\'s BatchQueuesReady condition says why; until it is fixed this job runs on the native path'
  const j = job({}, { scheduler: 'kubernetes', conditions: [{ type: 'QueueFits', status: 'False', reason: 'LeafQueueUnavailable', message }] })
  const html = jobDrawer(j, (qc) => seedScheduling(qc, { state: 'missing' }))
  assertMatch(html, /<h3[^>]*>Scheduling<\/h3>(?:(?!<dt).)*BatchQueuesReady condition says why(?:(?!<dt).)*<dl/s)
  assertMatch(html, /Scheduler<\/dt><dd[^>]*>Not Volcano: its queue is unavailable/)
  // No leaf name is guessed from the job's environment label: the composition's message names it.
  assertMatch(html, /Queue<\/dt><dd[^>]*>None: its leaf queue is unavailable/)
  // The native path with nothing wrong (QueueFits=True NativeScheduler) shows no section.
  const fine = job({}, { scheduler: 'kubernetes', conditions: [{ type: 'QueueFits', status: 'True', reason: 'NativeScheduler', message: 'native' }] })
  assert(!/<h3[^>]*>Scheduling<\/h3>/.test(jobDrawer(fine, (qc) => seedScheduling(qc, { state: 'missing' }))))
})

Deno.test('job drawer: no Scheduling section without Volcano, or for a job on the native scheduler', () => {
  const without = jobDrawer(job(), (qc) => {
    seedScheduling(qc, { state: 'missing' })
    seedVolcano(qc, NO_VOLCANO)
  })
  assert(!/<h3[^>]*>Scheduling<\/h3>/.test(without))
  assert(!without.includes('does not exist'))
  const native = jobDrawer(job({}, { scheduler: 'kubernetes' }), (qc) => seedScheduling(qc, { state: 'missing' }))
  assert(!/<h3[^>]*>Scheduling<\/h3>/.test(native))
})
