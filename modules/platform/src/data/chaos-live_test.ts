import { assert, assertEquals } from 'jsr:@std/assert@1'
import { parseRunnerTimeline } from '@adhar/utils'
import type { ChaosEngine, ChaosResult } from './chaos-kinds.ts'
import { buildGameDay } from './chaos-scenarios.ts'
import type { ChaosWorkflow } from './chaos.ts'
import {
  addProbeSample,
  clock,
  engineRun,
  gameDayInputFrom,
  gameDayRun,
  observe,
  orderSteps,
  probeSegments,
  rerunManifest,
  rerunName,
  stepProgress,
  suiteRun,
  workflowPhase,
} from './chaos-live.ts'

const NOW = Date.parse('2026-10-22T10:00:00Z')
const iso = (dt: number) => new Date(NOW + dt).toISOString()

function engine(status?: ChaosEngine['status'], over: Partial<NonNullable<ChaosEngine['spec']>> = {}): ChaosEngine {
  return {
    metadata: { name: 'cart-pod-delete', namespace: 'adhar-system', creationTimestamp: iso(-60_000), labels: { 'adhar.io/chaos-gameday': 'gd', 'adhar.io/chaos-scenario': 's' } },
    spec: {
      engineState: 'active',
      appinfo: { appns: 'shop-test', applabel: 'app=cart' },
      experiments: [{ name: 'pod-delete', spec: { components: { env: [{ name: 'TOTAL_CHAOS_DURATION', value: '30' }] } } }],
      ...over,
    },
    ...(status ? { status } : {}),
  }
}
const result = (over: Partial<NonNullable<ChaosResult['status']>> = {}): ChaosResult => ({
  metadata: { name: 'cart-pod-delete-pod-delete', creationTimestamp: iso(-40_000) },
  status: { experimentStatus: { verdict: 'Awaited', probeSuccessPercentage: '' }, ...over },
})

Deno.test('an experiment walks scheduled → preparing → injecting → recovering → verdict', () => {
  assertEquals(engineRun(engine(), undefined, { now: NOW }).stage, 'scheduled')
  assertEquals(engineRun(engine({ engineStatus: 'initialized' }), undefined, { now: NOW }).stage, 'preparing')
  const inj = engineRun(engine({ engineStatus: 'initialized', experiments: [{ name: 'pod-delete', status: 'Running' }] }), result(), { now: NOW })
  assertEquals(inj.stage, 'injecting')
  assertEquals(inj.steps[1].status, 'running')
  assertEquals(inj.steps[1].start, NOW - 40_000)
  assertEquals(inj.active, true)
  // 40 s into a 30 s fault: the bar is full while the verdict is awaited.
  assertEquals(stepProgress(inj.steps[1], NOW), 1)

  const doneEngine = engine({ engineStatus: 'completed', experiments: [{ name: 'pod-delete', status: 'Completed', verdict: 'Pass' }] })
  const done = result({ experimentStatus: { verdict: 'Pass', probeSuccessPercentage: '100' } })
  // Litmus says pass, but the target is not ready yet: still recovering.
  const rec = engineRun(doneEngine, done, { now: NOW, targetReady: false, observed: { faultEndedAt: NOW - 5_000 } })
  assertEquals(rec.stage, 'recovering')
  assertEquals(rec.windows.map((w) => w.kind), ['fault', 'recovery'])
  const fin = engineRun(doneEngine, done, { now: NOW, targetReady: true, observed: { faultEndedAt: NOW - 5_000, recoveredAt: NOW - 1_000 } })
  assertEquals(fin.stage, 'verdict')
  assertEquals(fin.verdict, 'passed')
  assertEquals(fin.steps[1].probeSuccessPercentage, 100)
  assertEquals(fin.steps[1].recoverySeconds, 4)
  assertEquals(fin.active, false)
})

Deno.test('a stopped run reads stopped, and a run with no result does not crash', () => {
  const stopped = engineRun(engine({ engineStatus: 'stopped' }, { engineState: 'stop' }), undefined, { now: NOW })
  assertEquals(stopped.stage, 'verdict')
  assertEquals(stopped.verdict, 'stopped')
  const failed = engineRun(engine({ engineStatus: 'completed', experiments: [{ name: 'pod-delete', verdict: 'Fail' }] }), undefined, { now: NOW })
  assertEquals(failed.verdict, 'failed')
  assertEquals(failed.steps[1].start, undefined)
  const bare = engineRun({ metadata: { name: 'x' } }, undefined, { now: NOW })
  assertEquals(bare.steps[1].fault, 'unknown')
})

Deno.test('observation records when the fault ended and when the target was back, once', () => {
  let o = observe({}, { live: true, over: false, now: 1 })
  assertEquals(o, {})
  o = observe(o, { live: false, over: true, targetReady: false, now: 10 })
  assertEquals(o, { faultEndedAt: 10 })
  const same = observe(o, { live: false, over: true, targetReady: false, now: 20 })
  assert(same === o)
  o = observe(o, { live: false, over: true, targetReady: true, now: 30 })
  assertEquals(o, { faultEndedAt: 10, recoveredAt: 30 })
})

Deno.test('probe samples compress repeats and segment by verdict', () => {
  const r = (v: string, pct = '') => result({ probeStatuses: [{ name: 'steady-state', type: 'httpProbe', status: { verdict: v } }], experimentStatus: { probeSuccessPercentage: pct } })
  let s = addProbeSample([], r('Awaited'), 0)
  s = addProbeSample(s, r('Awaited'), 5)
  s = addProbeSample(s, r('Awaited'), 10)
  s = addProbeSample(s, r('Passed'), 15)
  s = addProbeSample(s, r('Failed', '80'), 20)
  assertEquals(s.map((x) => x.t), [0, 10, 15, 20])
  assertEquals(s[3].pct, 80)
  assertEquals(probeSegments(s, 'steady-state', 30), [
    { start: 0, end: 15, verdict: 'awaited' },
    { start: 15, end: 20, verdict: 'passed' },
    { start: 20, end: 30, verdict: 'failed' },
  ])
  assertEquals(addProbeSample(s, undefined, 40), s)
})

const LOG = [
  '2026-10-22T09:50:05Z adhar-resilience: cart: load test against http://cart',
  '2026-10-22T09:51:25Z adhar-resilience: cart: performance {"status":"passed"}',
  '2026-10-22T09:51:26Z adhar-resilience: cart: pod-delete chaos for 30s with a continuous probe on http://cart',
  '2026-10-22T09:52:20Z adhar-resilience: cart: pod-delete {"status":"passed","probeSuccessPercentage":100,"recoverySeconds":12}',
  '2026-10-22T09:52:21Z adhar-resilience: cart: pod-cpu-hog chaos for 30s with a continuous probe on http://cart',
].join('\n')

Deno.test('a suite run follows the log: done, running, and still-to-come faults', () => {
  const tl = parseRunnerTimeline(LOG, 'cart')
  const faults = [{ name: 'pod-delete', hypothesis: 'keeps serving' }, { name: 'pod-cpu-hog' }, { name: 'pod-network-latency' }]
  const live = suiteRun({ faults, timeline: tl, job: { startTime: '2026-10-22T09:49:50Z', phase: 'running' }, faultSeconds: 30 })
  assertEquals(live.steps.map((s) => `${s.id}:${s.status}`), ['prepare:passed', 'load-test:passed', 'pod-delete:passed', 'pod-cpu-hog:running', 'pod-network-latency:pending', 'verdict:pending'])
  assertEquals(live.stage, 'injecting')
  assertEquals(live.steps[2].recoverySeconds, 12)
  assertEquals(live.steps[2].hypothesis, 'keeps serving')
  // The Job ended before reaching the last fault: it was skipped, not pending forever.
  const ended = suiteRun({ faults, timeline: tl, job: { startTime: '2026-10-22T09:49:50Z', completionTime: '2026-10-22T09:53:00Z', phase: 'failed' } })
  assertEquals(ended.stage, 'verdict')
  assertEquals(ended.verdict, 'failed')
  assertEquals(ended.steps.find((s) => s.id === 'pod-network-latency')!.status, 'skipped')
  assertEquals(ended.steps.find((s) => s.id === 'pod-cpu-hog')!.status, 'error')
  // Nothing logged yet: preparing, everything pending.
  const fresh = suiteRun({ faults, job: { startTime: '2026-10-22T09:49:50Z', phase: 'running' } })
  assertEquals(fresh.stage, 'preparing')
  assertEquals(suiteRun({ faults, job: { phase: 'pending' } }).stage, 'scheduled')
})

const gd = (status?: ChaosWorkflow['status'], shutdown?: string): ChaosWorkflow => {
  const wf = buildGameDay({
    name: 'friday',
    target: { namespace: 'shop-test', label: 'app=cart', mode: 'percent', percent: '50' },
    scenarios: ['pod-delete-one', 'net-latency'],
    strategy: 'serial',
    recoverySeconds: 30,
    steadyState: { url: 'http://cart/healthz', statusCode: 200, intervalSeconds: 5 },
  }) as unknown as ChaosWorkflow
  if (shutdown) wf.spec = { ...wf.spec, shutdown }
  return { ...wf, ...(status ? { status } : {}) }
}

Deno.test('a game day shows every declared step, and a stopped one skips what it never reached', () => {
  const running = gd({ phase: 'Running', startedAt: iso(-90_000), nodes: { a: { id: 'a', name: 'a', templateName: '1-pod-delete-one', phase: 'Succeeded', startedAt: iso(-90_000), finishedAt: iso(-30_000) }, b: { id: 'b', name: 'b', templateName: '1-recover', phase: 'Running', startedAt: iso(-29_000) } } })
  assertEquals(orderSteps(running).map((s) => `${s.template}:${s.phase}`), ['1-pod-delete-one:done', '1-recover:running', '2-net-latency:pending', 'revert:pending'])
  const live = gameDayRun(running)
  assertEquals(live.stage, 'recovering')
  assertEquals(live.windows.map((w) => w.kind), ['fault', 'recovery'])
  assertEquals(workflowPhase(gd({ phase: 'Running', startedAt: iso(0) }, 'Stop')), 'stopping')
  const stopped = gd({ phase: 'Failed', startedAt: iso(-90_000), finishedAt: iso(0), nodes: {} }, 'Stop')
  assertEquals(workflowPhase(stopped), 'stopped')
  assertEquals(gameDayRun(stopped).verdict, 'stopped')
  assertEquals(orderSteps(stopped).every((s) => s.phase === 'skipped'), true)
  assertEquals(workflowPhase(gd({ phase: 'Failed' })), 'aborted')
})

Deno.test('a game day can be read back into the builder input that made it', () => {
  const input = gameDayInputFrom(gd(), 'friday-r2')!
  assertEquals(input.name, 'friday-r2')
  assertEquals(input.scenarios, ['pod-delete-one', 'net-latency'])
  assertEquals(input.target, { namespace: 'shop-test', label: 'app=cart', appKind: 'deployment', mode: 'percent', percent: '50' })
  assertEquals(input.recoverySeconds, 30)
  assertEquals(input.steadyState, { url: 'http://cart/healthz', statusCode: 200, intervalSeconds: 5 })
  // The rebuilt workflow names its engines after the new game day.
  assert(JSON.stringify(buildGameDay(input)).includes('friday-r2-1-pod-delete'))
  assertEquals(gameDayInputFrom({ metadata: { name: 'x' } }, 'y'), undefined)
})

Deno.test('re-runs copy the spec, reset state, leave the game day and get a fresh name', () => {
  const src = engine({ engineStatus: 'completed' }, { engineState: 'stop' })
  const m = rerunManifest(src, 'cart-pod-delete-r2')
  assertEquals(m.spec?.engineState, 'active')
  assertEquals(m.status, undefined)
  assertEquals(m.metadata.labels?.['adhar.io/chaos-gameday'], undefined)
  assertEquals(m.metadata.labels?.['adhar.io/rerun-of'], 'cart-pod-delete')
  assertEquals(m.spec?.appinfo, src.spec?.appinfo)
  // The source is not mutated.
  assertEquals(src.spec?.engineState, 'stop')
  assertEquals(rerunName('cart-pod-delete'), 'cart-pod-delete-r2')
  assertEquals(rerunName('cart-pod-delete-r2', ['cart-pod-delete-r3']), 'cart-pod-delete-r4')
  assert(rerunName('x'.repeat(63)).length <= 63)
  assertEquals(clock(65_000), '1m 05s')
  assertEquals(clock(4_000), '4s')
  assertEquals(clock(9 * 3_600_000 + 5 * 60_000 + 30_000), '9h 05m')
})

import { targetPods } from './chaos-live.ts'

Deno.test('target pods: readiness, terminating, restarts and the last reason', () => {
  const t = targetPods([
    { metadata: { name: 'cart-a' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'app', restartCount: 2, lastState: { terminated: { reason: 'OOMKilled' } } }] } },
    { metadata: { name: 'cart-b', deletionTimestamp: iso(0) }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } },
    { metadata: { name: 'cart-c' }, status: { phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'ContainerCreating' } } }] } },
  ])
  assertEquals(t.total, 3)
  assertEquals(t.ready, 1)
  assertEquals(t.restarts, 2)
  assertEquals(t.whole, false)
  assertEquals(t.rows.map((r) => r.state), ['Terminating', 'ContainerCreating', 'Running'])
  assertEquals(t.rows[2].lastReason, 'OOMKilled')
  assertEquals(targetPods([]).whole, false)
})

Deno.test('an Error verdict is "no verdict", and its 0% probe is not reported as a measurement', () => {
  const e = engine({ engineStatus: 'completed', experiments: [{ name: 'pod-delete', status: 'Completed', verdict: 'Error' }] })
  const r = result({ experimentStatus: { verdict: 'Error', probeSuccessPercentage: '0' } })
  const run = engineRun(e, r, { now: NOW })
  assertEquals(run.stage, 'verdict')
  assertEquals(run.verdict, 'error')
  assertEquals(run.steps[1].status, 'error')
  assertEquals(run.steps[1].probeSuccessPercentage, undefined)
  assertEquals(run.active, false)
})

Deno.test('a result left over from an earlier run of the same name does not date this run', () => {
  // Litmus reuses `<engine>-<fault>` across runs: the result predates the engine.
  const e = engine({ engineStatus: 'completed', experiments: [{ name: 'pod-delete', status: 'Completed', verdict: 'Pass', lastUpdateTime: iso(-10_000) }] })
  const stale: ChaosResult = { ...result({ experimentStatus: { verdict: 'Pass', probeSuccessPercentage: '100' } }), metadata: { name: 'cart-pod-delete-pod-delete', creationTimestamp: iso(-3_600_000) } }
  const run = engineRun(e, stale, { now: NOW })
  assertEquals(run.steps[1].start, undefined)
  // No invented window, and never a finish before the start.
  assertEquals(run.windows, [])
  assert(run.finishedAt === undefined || run.finishedAt >= (run.startedAt ?? 0))
})

Deno.test('a finished run opened later ends when Litmus last updated it, not now', () => {
  const e = engine({ engineStatus: 'completed', experiments: [{ name: 'pod-delete', status: 'Completed', verdict: 'Error', lastUpdateTime: iso(-20_000) }] })
  const run = engineRun(e, undefined, { now: NOW + 9 * 3_600_000 })
  assertEquals(run.active, false)
  assertEquals(run.startedAt, NOW - 60_000)
  assertEquals(run.finishedAt, NOW - 20_000)
})
