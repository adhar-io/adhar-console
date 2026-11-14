import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1.0.0'
import { type BatchJobXR, isBatchRun, podIndex, podRole, runActionsOf, type RunPod, speakerPod } from './batch-model.ts'
import {
  descriptorOf,
  gangPlanOf,
  gangsOfJob,
  jobQueueWarning,
  type PodGroup,
  podGroupOfRun,
  QUEUE_FIT_CONDITION,
  queueConditionOf,
  queueFitOf,
  queueOfJob,
  type SchedulerDescriptor,
  type VolcanoQueue,
} from './batch-queues-model.ts'

/**
 * Phase 2 stage 2 in the Console's pure half: a Volcano run's pods read the way
 * the CLI reads them (cmd/batch/gang.go), a run's gang is found as the CLI finds
 * it, and a job's gang is measured against its leaf queue (DEC-3) with the
 * capacity plugin's own rule for when prod may reclaim.
 */

/* ─────────────────────────── a Volcano run's pods (ST-6) ─────────────────────────── */

const vpod = (name: string, task: string | undefined, index: string, opts: { asLabel?: boolean; message?: string; role?: string } = {}): RunPod => ({
  metadata: {
    name,
    namespace: 'shop-prod',
    creationTimestamp: '2026-11-14T09:00:00Z',
    labels: {
      'adhar.io/batch-job': 'settlement',
      'volcano.sh/job-name': 'settlement-aa',
      ...(task ? { 'volcano.sh/task-spec': task } : {}),
      ...(opts.role ? { 'adhar.io/batch-role': opts.role } : {}),
      ...(opts.asLabel ? { 'volcano.sh/task-index': index } : {}),
    },
    annotations: opts.asLabel ? {} : { 'volcano.sh/task-index': index },
  },
  status: { phase: 'Succeeded', containerStatuses: [{ name: 'batch', state: { terminated: { exitCode: 0, message: opts.message } } }] },
})

Deno.test('volcano pods: the role falls back to the Volcano task, the index to the annotation', () => {
  assertEquals(podRole(vpod('m', 'manager', '0')), 'manager')
  assertEquals(podRole(vpod('w', 'worker', '3')), 'worker')
  // The composition's label wins over the task when both are there.
  assertEquals(podRole(vpod('x', 'worker', '0', { role: 'manager' })), 'manager')
  assertEquals(podRole(vpod('n', undefined, '0')), undefined)
  assertEquals(podIndex(vpod('w', 'worker', '3')), '3')
  assertEquals(podIndex(vpod('w', 'worker', '2', { asLabel: true })), '2')
})

Deno.test('volcano pods: worker-0 does not speak for the run, the manager task does', () => {
  const worker0 = vpod('settlement-aa-worker-0', 'worker', '0', { message: '{"v":1,"outcome":"failed"}' })
  const manager = vpod('settlement-aa-manager-0', 'manager', '0', { message: '{"v":1,"outcome":"completed"}' })
  assertEquals(speakerPod([worker0, manager])?.metadata.name, 'settlement-aa-manager-0')
  // A Volcano pod with no task label at index 0 is not taken for a manager either: its index counts within a task.
  const untasked = vpod('settlement-aa-x-0', undefined, '0', { message: '{"v":1,"outcome":"failed"}' })
  const other = { ...vpod('settlement-aa-y-1', undefined, '1', { message: '{"v":1,"outcome":"completed"}' }) }
  other.metadata.creationTimestamp = '2026-11-14T09:05:00Z'
  assertEquals(speakerPod([other, untasked])?.metadata.name, 'settlement-aa-y-1')
})

Deno.test('volcano runs: a Job or Volcano Job without adhar.io/batch-job is offered nothing', () => {
  const teamOwn = { metadata: { name: 'train', namespace: 'shop-prod', labels: { 'volcano.sh/queue': 'x' } } }
  assertEquals(isBatchRun(teamOwn), false)
  assertEquals(isBatchRun({ metadata: { name: 'settlement-aa', labels: { 'adhar.io/batch-job': 'settlement' } } }), true)
  for (const phase of ['running', 'pending', 'stopped', 'failed'] as const) {
    assertEquals(runActionsOf(phase, false), { stop: false, resume: false, restart: false }, phase)
  }
  assertEquals(runActionsOf('running', true).stop, true)
})

/* ─────────────────────────── a run's PodGroup ─────────────────────────── */

const pg = (name: string, owner: { name: string; uid?: string; apiVersion?: string }, extra: Partial<PodGroup['metadata']> = {}): PodGroup => ({
  metadata: { name, namespace: 'shop-prod', ownerReferences: [{ kind: 'Job', apiVersion: owner.apiVersion ?? 'batch.volcano.sh/v1alpha1', name: owner.name, uid: owner.uid }], ...extra },
  spec: { minMember: 5 },
})

Deno.test('run gang: the PodGroup the run owns by uid, before one that only shares its name', () => {
  const native = pg('podgroup-u-native', { name: 'settlement-aa', uid: 'u-native', apiVersion: 'batch/v1' })
  const volcano = pg('settlement-aa-u-vc', { name: 'settlement-aa', uid: 'u-vc' })
  assertEquals(podGroupOfRun({ name: 'settlement-aa', uid: 'u-vc' }, [native, volcano])?.metadata.name, 'settlement-aa-u-vc')
  assertEquals(podGroupOfRun({ name: 'settlement-aa', uid: 'u-native' }, [volcano, native])?.metadata.name, 'podgroup-u-native')
  // A run read without its uid matches by owner name.
  assertEquals(podGroupOfRun({ name: 'settlement-aa' }, [volcano])?.metadata.name, 'settlement-aa-u-vc')
  // The owner reference was not written yet: Volcano's names for it.
  const unowned: PodGroup = { metadata: { name: 'podgroup-u-late', namespace: 'shop-prod' } }
  assertEquals(podGroupOfRun({ name: 'single-aa', uid: 'u-late' }, [unowned])?.metadata.name, 'podgroup-u-late')
  assertEquals(podGroupOfRun({ name: 'nope', uid: 'u-nope' }, [native, volcano]), null)
})

Deno.test('job gangs: by the job label, or owned by one of its runs; finished gangs drop', () => {
  const labelled = pg('a-1', { name: 'settlement-zz' }, { labels: { 'adhar.io/batch-job': 'settlement' } })
  const owned = pg('b-1', { name: 'settlement-bb' })
  const foreign = pg('c-1', { name: 'other-aa' }, { labels: { 'adhar.io/batch-job': 'other' } })
  const done: PodGroup = { ...pg('d-1', { name: 'settlement-dd' }), status: { phase: 'Completed' } }
  assertEquals(gangsOfJob('settlement', ['settlement-bb', 'settlement-dd'], [labelled, owned, foreign, done]).map((g) => g.name).sort(), ['a-1', 'b-1'])
})

/* ─────────────────────────── a job's gang against its queue (DEC-3) ─────────────────────────── */

const job = (p: NonNullable<BatchJobXR['spec']>['parameters'] = {}, status: BatchJobXR['status'] = { scheduler: 'volcano', queue: 'acme-payments-prod' }, labels: Record<string, string> = {}): BatchJobXR => ({
  metadata: { name: 'settlement', namespace: 'shop-prod', labels },
  spec: { parameters: { job: 'settleJob', image: 'img', ...p } },
  status,
})

// §4.5's example gang: 1 manager + 4 workers at 500m / 1Gi each.
const EXAMPLE = { mode: 'partitioned' as const, workers: 4, resources: { cpu: '500m', memory: '1Gi' } }

Deno.test('gang plan: one pod for a single run, manager + workers for a partitioned one, with the composition defaults', () => {
  const single = gangPlanOf(job())
  assertEquals([single.shape, single.members, single.request.cpu, single.request.memory], ['single', 1, 1, 1536 * 2 ** 20])
  const example = gangPlanOf(job(EXAMPLE))
  assertEquals([example.shape, example.members, example.request.cpu, example.request.memory], ['gang', 5, 2.5, 5 * 2 ** 30])
  // Worker sizes are their own; workers default to 4.
  const sized = gangPlanOf(job({ mode: 'partitioned', resources: { cpu: '1', memory: '2Gi', workerCpu: '250m', workerMemory: '512Mi' } }))
  assertEquals([sized.members, sized.request.cpu, sized.request.memory], [5, 2, 4 * 2 ** 30])
})

const leaf = (name: string, spec: VolcanoQueue['spec']): VolcanoQueue => ({ metadata: { name, labels: { 'adhar.io/tier': name.split('-').at(-1)! } }, spec: { parent: 'adhar-batch', ...spec } })
const PROD = leaf('acme-payments-prod', { capability: { cpu: '8', memory: '16Gi' }, deserved: { cpu: '2', memory: '4Gi' }, reclaimable: false })

Deno.test('queue fit: a gang over the deserved share in EVERY dimension cannot reclaim; within one, it can', () => {
  const plan = gangPlanOf(job(EXAMPLE)) // 2.5 CPU / 5 GiB against 2 / 4 GiB
  const over = queueFitOf(plan, { name: PROD.metadata.name, leaf: PROD, state: 'present' })
  assertEquals(over.level, 'no-reclaim')
  assertStringIncludes(over.message!, 'gang of 5 (1 manager + 4 workers)')
  assertStringIncludes(over.message!, 'cannot reclaim')
  // Within the share on memory: Volcano lets it reclaim (LessEqualPartly…), so nothing is said.
  const roomy = leaf('acme-payments-prod', { capability: { cpu: '8', memory: '16Gi' }, deserved: { cpu: '2', memory: '6Gi' } })
  assertEquals(queueFitOf(plan, { name: 'acme-payments-prod', leaf: roomy, state: 'present' }).level, 'fits')
})

Deno.test('queue fit: a gang bigger than the capability in any dimension is never admitted', () => {
  const plan = gangPlanOf(job({ ...EXAMPLE, workers: 4, resources: { cpu: '500m', memory: '4Gi' } })) // 20 GiB
  const never = queueFitOf(plan, { name: PROD.metadata.name, leaf: PROD, state: 'present' })
  assertEquals(never.level, 'never')
  assertStringIncludes(never.message!, 'more than queue acme-payments-prod can ever hold (8 CPU · 16 GiB)')
  // A dev leaf (no deserved) is only measured against its capability.
  const dev = leaf('acme-payments-dev', { capability: { cpu: '4', memory: '8Gi' }, reclaimable: true })
  assertEquals(queueFitOf(gangPlanOf(job(EXAMPLE)), { name: 'acme-payments-dev', leaf: dev, state: 'present' }).level, 'fits')
  // An undeclared capability dimension does not limit.
  const cpuOnly = leaf('acme-payments-dev', { capability: { cpu: '4' } })
  assertEquals(queueFitOf(plan, { name: 'acme-payments-dev', leaf: cpuOnly, state: 'present' }).level, 'fits')
})

Deno.test('queue fit: a prod leaf that does not exist is said, as the reason its runs are refused', () => {
  const missing = queueFitOf(gangPlanOf(job()), { name: 'acme-payments-prod', state: 'missing' })
  assertEquals(missing.level, 'missing')
  assertStringIncludes(missing.message!, 'does not exist')
  assertStringIncludes(missing.message!, 'QueueRejected')
})

Deno.test('queue fit: an unreadable prod leaf is measured against the descriptor’s prod share; other tiers are unknown', () => {
  const d = descriptorOf({ data: { scheduler: 'volcano', rootQueue: 'adhar-batch', prodDeservedCPU: '2', prodDeservedMemory: '4Gi' } })
  assertEquals([d.prodDeservedCPU, d.prodDeservedMemory], ['2', '4Gi'])
  const plan = gangPlanOf(job(EXAMPLE))
  const fromDescriptor = queueFitOf(plan, { name: 'acme-payments-prod', state: 'denied' }, d)
  assertEquals([fromDescriptor.level, fromDescriptor.source], ['no-reclaim', 'descriptor'])
  assertEquals(queueFitOf(gangPlanOf(job()), { name: 'acme-payments-prod', state: 'denied' }, d).level, 'fits')
  assertEquals(queueFitOf(plan, { name: 'acme-payments-dev', state: 'denied' }, d).level, 'unknown')
  assertEquals(queueFitOf(plan, { name: 'acme-payments-prod', state: 'denied' }).level, 'unknown')
})

Deno.test('job queue: what the composition reports wins; else the leaf its NAMESPACE’s tier names', () => {
  assertEquals(queueOfJob(job()), { name: 'acme-payments-prod', reported: true })
  const ns = { 'adhar.io/organisation': 'acme', 'adhar.io/team': 'payments', 'adhar.io/environment': 'dev', 'adhar.io/tier': 'test' }
  // An environment named dev of tier test runs on the test leaf, as the composition names it.
  assertEquals(queueOfJob(job({}, { scheduler: 'volcano' }), ns), { name: 'acme-payments-test', reported: false })
  // The job's own environment label is never read as a tier: nothing is guessed from it.
  assertEquals(queueOfJob(job({}, { scheduler: 'volcano' }, { ...ns, 'adhar.io/tier': 'prod' })), undefined)
  // A namespace with no tier (or staging's, which has no leaf — DEC-8) names nothing.
  assertEquals(queueOfJob(job({}, { scheduler: 'volcano' }), { ...ns, 'adhar.io/tier': 'staging' }), undefined)
  const { 'adhar.io/tier': _tier, ...untiered } = { ...ns, 'adhar.io/environment': 'prod' }
  assertEquals(queueOfJob(job({}, { scheduler: 'volcano' }), untiered), undefined)
})

Deno.test('job queue: the composition’s QueueFits=False is read as the warning, anything else is not', () => {
  const c = (status: string) => job({}, { scheduler: 'volcano', conditions: [{ type: QUEUE_FIT_CONDITION, status, reason: 'GangExceedsDeserved', message: 'too big' }] })
  assertEquals(queueConditionOf(c('False'))?.message, 'too big')
  assertEquals(queueConditionOf(c('True')), undefined)
  assert(!queueConditionOf(job({}, { scheduler: 'volcano', conditions: [{ type: 'Held', status: 'False' }] })))
})

Deno.test('job queue: a fit from the descriptor’s prod share never contradicts the composition’s QueueFits', () => {
  const plan = gangPlanOf(job(EXAMPLE)) // 2.5 CPU / 5 GiB, over the 2 / 4 GiB default share
  const desc = queueFitOf(plan, { name: 'acme-payments-prod', state: 'denied' }, { state: 'present', prodDeservedCPU: '2', prodDeservedMemory: '4Gi' } as SchedulerDescriptor)
  assertEquals([desc.level, desc.source], ['no-reclaim', 'descriptor'])
  const withCondition = (status: string) => job(EXAMPLE, { scheduler: 'volcano', queue: 'acme-payments-prod', conditions: [{ type: QUEUE_FIT_CONDITION, status, reason: 'Fits', message: 'too big' }] })
  // The composition read the team's real leaf and found it fits: the default share does not say otherwise.
  assertEquals(jobQueueWarning(withCondition('True'), desc), undefined)
  // With no condition written yet, the descriptor's answer is all there is.
  assertStringIncludes(jobQueueWarning(job(EXAMPLE), desc)!, 'prod share in every dimension')
  // A fit against the leaf itself is a newer read of the same object, and is still said.
  const leafFit = queueFitOf(plan, { name: PROD.metadata.name, leaf: PROD, state: 'present' })
  assertStringIncludes(jobQueueWarning(withCondition('True'), leafFit)!, 'cannot reclaim')
  // The composition's False is the warning, as written.
  assertEquals(jobQueueWarning(withCondition('False'), { level: 'fits' }), 'too big')
  assertEquals(jobQueueWarning(job(), { level: 'fits', source: 'queue' }), undefined)
})
