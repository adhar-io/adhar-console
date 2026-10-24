import { assertEquals } from 'jsr:@std/assert@^1'
import { latestPerSlot, podDetail, primaryRunner, runLifecycle, runProgress, fmtSecs, type PodLike, type RunLike } from './perf-run-model.ts'
import { parsePlan } from './perf-plan.ts'
import { SCRIPT_STAGES } from './testdata/k6-v1-runner-log.ts'

const RUN = 'reactapp-load-20261024-121418'
const T = (s: string) => `2026-10-24T04:${s}Z`

/** Pod shapes as the cluster returned them for a real run. */
function pod(name: string, labels: Record<string, string>, created: string, state: Record<string, unknown>, args: string[] = []): PodLike {
  return {
    metadata: { name, creationTimestamp: created, labels },
    spec: { containers: [{ name: 'k6', command: ['k6', 'run', '--quiet', ...args] }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'k6', restartCount: 0, state }] },
  }
}
const term = (startedAt: string, finishedAt: string, exitCode: number) => ({ terminated: { startedAt, finishedAt, exitCode, reason: exitCode ? 'Error' : 'Completed' } })

const INIT = pod(`${RUN}-initializer-gp8t5`, { 'job-name': `${RUN}-initializer`, k6_cr: RUN }, T('14:19'), term(T('14:22'), T('14:23'), 0))
const RUNNER = (state: Record<string, unknown>) => pod(`${RUN}-1-nncxc`, { 'job-name': `${RUN}-1`, k6_cr: RUN, runner: 'true' }, T('14:26'), state)
const STARTER = pod(`${RUN}-starter-6rt4q`, { 'job-name': `${RUN}-starter`, k6_cr: RUN }, T('14:48'), term(T('15:17'), T('15:24'), 0))

const run = (stage: string, conds: RunLike['status'] extends infer S ? S extends { conditions?: infer C } ? C : never : never = []): RunLike => ({
  metadata: { name: RUN, namespace: 'test', creationTimestamp: T('14:18') },
  spec: { parallelism: 1, paused: 'false' },
  status: { stage, conditions: conds },
})

Deno.test('pods: roles, runner index, terminated timings', () => {
  const r = podDetail(RUN, RUNNER(term(T('14:45'), T('16:31'), 0)))
  assertEquals(r.role, 'runner')
  assertEquals(r.index, 1)
  assertEquals(r.state, 'succeeded')
  assertEquals(r.startedAt, T('14:45'))
  assertEquals(podDetail(RUN, INIT).role, 'initializer')
  assertEquals(podDetail(RUN, STARTER).role, 'starter')
})

Deno.test('a finished, passing run: every phase done with real times', () => {
  const pods = [INIT, RUNNER(term(T('14:45'), T('16:31'), 0)), STARTER].map((p) => podDetail(RUN, p))
  const lc = runLifecycle(run('finished', [{ type: 'TestRunRunning', status: 'False', lastTransitionTime: T('16:33') }]), pods, Date.parse(T('20:00')))
  assertEquals(lc.outcome, 'passed')
  assertEquals(lc.phases.map((p) => p.state), ['done', 'done', 'done', 'done', 'done', 'done'])
  // Unpaused runners start generating load as soon as their container starts.
  assertEquals(lc.loadStartMs, Date.parse(T('14:45')))
  assertEquals(lc.loadEndMs, Date.parse(T('16:31')))
  assertEquals(lc.endMs, Date.parse(T('16:33')))
  const prog = runProgress(lc, parsePlan(SCRIPT_STAGES), Date.parse(T('20:00')))
  assertEquals(prog.elapsedSecs, 106)
  assertEquals(prog.pct, 100)
})

Deno.test('exit code 99 is "thresholds failed", not "failed"', () => {
  const pods = [INIT, RUNNER(term(T('14:45'), T('16:31'), 99))].map((p) => podDetail(RUN, p))
  const lc = runLifecycle(run('finished'), pods, Date.now())
  assertEquals(lc.outcome, 'thresholds-failed')
  assertEquals(lc.phases.at(-1)?.label, 'Thresholds failed')
})

Deno.test('a script error is a failure at the run phase, with the reason', () => {
  const pods = [INIT, RUNNER(term(T('14:45'), T('14:46'), 107))].map((p) => podDetail(RUN, p))
  const lc = runLifecycle(run('finished'), pods, Date.now())
  assertEquals(lc.outcome, 'failed')
  assertEquals(lc.outcomeDetail, 'k6 script error.')
  assertEquals(lc.phases.find((p) => p.id === 'running')?.state, 'failed')
})

Deno.test('a failed initializer stops the walk at initializing', () => {
  const bad = pod(`${RUN}-initializer-x`, { 'job-name': `${RUN}-initializer` }, T('14:19'), term(T('14:20'), T('14:21'), 1))
  const lc = runLifecycle(run('initialization'), [podDetail(RUN, bad)], Date.now())
  assertEquals(lc.outcome, 'failed')
  assertEquals(lc.current, 'initializing')
  assertEquals(lc.phases.map((p) => p.state), ['done', 'failed', 'skipped', 'skipped', 'skipped', 'failed'])
})

Deno.test('mid-run: generating load, progress against the plan, target VUs and segment', () => {
  const pods = [INIT, RUNNER({ running: { startedAt: T('14:45') } })].map((p) => podDetail(RUN, p))
  const now = Date.parse(T('15:30')) // 45s in
  const lc = runLifecycle(run('started', [{ type: 'TestRunRunning', status: 'True', lastTransitionTime: T('14:48') }]), pods, now)
  assertEquals(lc.current, 'running')
  assertEquals(lc.outcome, 'in-progress')
  assertEquals(lc.phases.find((p) => p.id === 'running')?.state, 'active')
  assertEquals(lc.phases.find((p) => p.id === 'finishing')?.state, 'pending')
  const prog = runProgress(lc, parsePlan(SCRIPT_STAGES), now)
  assertEquals(prog.elapsedSecs, 45)
  assertEquals(Math.round(prog.pct!), 43)
  assertEquals(prog.targetVus, 10)
  assertEquals(prog.segment, 'steady')
  assertEquals(prog.remainingSecs, 60)
})

Deno.test('created paused: held at starting until resumed', () => {
  const r = { ...run('created'), spec: { parallelism: 2, paused: 'true' } }
  const pods = [INIT, RUNNER({ running: { startedAt: T('14:45') } })].map((p) => podDetail(RUN, p))
  pods[1].paused = true
  const lc = runLifecycle(r, pods, Date.now())
  assertEquals(lc.heldPaused, true)
  assertEquals(lc.current, 'starting')
  assertEquals(lc.loadStartMs, undefined)
})

Deno.test('stopped runs are aborted; pods cleaned up still yields an outcome from the harvested exit code', () => {
  assertEquals(runLifecycle(run('stopped'), [], Date.now()).outcome, 'aborted')
  assertEquals(runLifecycle(run('finished'), [], Date.now()).outcome, 'unknown')
  assertEquals(runLifecycle(run('finished'), [], Date.now(), 99).outcome, 'thresholds-failed')
})

Deno.test('a retried runner counts once; the primary runner is the lowest live instance', () => {
  const old = podDetail(RUN, { ...RUNNER(term(T('14:30'), T('14:31'), 1)), metadata: { name: `${RUN}-1-aaaaa`, creationTimestamp: T('14:26'), labels: { 'job-name': `${RUN}-1`, runner: 'true' } } })
  const fresh = podDetail(RUN, { ...RUNNER({ running: { startedAt: T('14:45') } }), metadata: { name: `${RUN}-1-bbbbb`, creationTimestamp: T('14:40'), labels: { 'job-name': `${RUN}-1`, runner: 'true' } } })
  assertEquals(latestPerSlot([old, fresh]).map((p) => p.name), [`${RUN}-1-bbbbb`])
  assertEquals(primaryRunner([old, fresh])?.name, `${RUN}-1-bbbbb`)
})

Deno.test('durations read at a glance', () => {
  assertEquals(fmtSecs(5), '5s')
  assertEquals(fmtSecs(125), '2m 05s')
  assertEquals(fmtSecs(3840), '1h 04m')
  assertEquals(fmtSecs(undefined), '—')
})
