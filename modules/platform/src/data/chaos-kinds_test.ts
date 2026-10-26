import { assertEquals } from 'jsr:@std/assert@1'
import {
  appKindOfPods,
  CHAOS_FAULTS,
  type ChaosResult,
  errorReason,
  isOver,
  measuredProbe,
  verdictTally,
  durationOf,
  faultById,
  faultOf,
  isLive,
  modeLabel,
  phaseOf,
  podsAffected,
  resultNameFor,
  targetSummary,
  type ChaosEngine,
} from './chaos-kinds.ts'

/**
 * Chaos is the one place in this console where a wrong status reading is
 * dangerous rather than annoying: the page's job is to tell someone whether a
 * fault is applied to a running system right now. These tests pin exactly that.
 */

const engine = (over: Partial<ChaosEngine> = {}): ChaosEngine => ({
  kind: 'ChaosEngine',
  metadata: { name: 'kill-checkout', namespace: 'adhar-system' },
  spec: {
    engineState: 'active',
    appinfo: { appns: 'payments', applabel: 'app=checkout', appkind: 'deployment' },
    experiments: [{ name: 'pod-delete', spec: { components: { env: [{ name: 'TOTAL_CHAOS_DURATION', value: '30' }] } } }],
  },
  ...over,
})

const withStatus = (engineStatus: string, expStatus: string, verdict = 'Awaited', state: 'active' | 'stop' = 'active'): ChaosEngine =>
  engine({
    spec: { ...engine().spec, engineState: state },
    status: { engineStatus, experiments: [{ name: 'pod-delete', status: expStatus, verdict }] },
  })

Deno.test('a run whose runner reports the fault applied reads as injected', () => {
  assertEquals(phaseOf(withStatus('running', 'Running')), 'injected')
  assertEquals(isLive(withStatus('running', 'Running')), true)
})

Deno.test('active but not yet applied is injecting, NOT injected', () => {
  assertEquals(phaseOf(withStatus('initialized', 'Waiting for Job Creation')), 'injecting')
  assertEquals(isLive(withStatus('initialized', 'Waiting for Job Creation')), false)
  // A brand-new engine with no status at all has broken nothing yet.
  assertEquals(phaseOf(engine()), 'injecting')
})

Deno.test('a run that finished with a verdict is passed or failed, never "stopped"', () => {
  assertEquals(phaseOf(withStatus('completed', 'Completed', 'Pass')), 'passed')
  assertEquals(phaseOf(withStatus('completed', 'Completed', 'Fail')), 'failed')
  assertEquals(isLive(withStatus('completed', 'Completed', 'Pass')), false)
})

Deno.test('stop requested while the runner still reports the fault is recovering — the fault is still out there', () => {
  const e = withStatus('running', 'Running', 'Awaited', 'stop')
  assertEquals(phaseOf(e), 'recovering')
  assertEquals(isLive(e), true)
})

Deno.test('stop requested with nothing applied is simply stopped', () => {
  assertEquals(phaseOf(withStatus('stopped', 'Chaos Injection Stopped', 'Stopped', 'stop')), 'stopped')
  assertEquals(phaseOf(withStatus('initialized', 'Waiting for Job Creation', 'Awaited', 'stop')), 'stopped')
})

Deno.test('a completed engine is never live even if a stale status says Running', () => {
  assertEquals(isLive(withStatus('completed', 'Running', 'Pass')), false)
})

Deno.test('every catalogued fault is unique and resolvable', () => {
  const ids = CHAOS_FAULTS.map((f) => f.id)
  assertEquals(new Set(ids).size, ids.length)
  for (const id of ids) assertEquals(faultById(id)?.id, id)
  // Every fault has a bounded duration knob — nothing in the catalogue runs forever.
  for (const f of CHAOS_FAULTS) assertEquals(f.knobs.some((k) => k.env === 'TOTAL_CHAOS_DURATION'), true, f.id)
})

Deno.test('the result name is what Litmus writes: <engine>-<fault>', () => {
  assertEquals(resultNameFor(engine()), 'kill-checkout-pod-delete')
  assertEquals(faultOf(engine()), 'pod-delete')
  assertEquals(durationOf(engine()), 30)
})

Deno.test('mode labels say what will actually be hit', () => {
  assertEquals(modeLabel('one'), 'one pod')
  assertEquals(modeLabel('all'), 'all pods')
  assertEquals(modeLabel('percent', '30'), '30% of pods')
  assertEquals(podsAffected('one'), '')
  assertEquals(podsAffected('all'), '100')
  assertEquals(podsAffected('percent', '30'), '30')
})

Deno.test('the target summary never implies a narrower blast radius than the spec', () => {
  assertEquals(targetSummary(engine()), 'payments · app=checkout · one pod')
  const all = engine({
    spec: {
      ...engine().spec,
      appinfo: { appns: 'payments' },
      experiments: [{ name: 'pod-delete', spec: { components: { env: [{ name: 'PODS_AFFECTED_PERC', value: '100' }] } } }],
    },
  })
  assertEquals(targetSummary(all), 'payments · every pod · 100% of pods')
  const node = engine({ spec: { engineState: 'active', experiments: [{ name: 'node-drain', spec: { components: { env: [{ name: 'TARGET_NODES', value: 'w-2' }] } } }] } })
  assertEquals(targetSummary(node), 'node w-2')
})

Deno.test('a run Litmus ended with Error is "error" — an infrastructure result, not a failed hypothesis', () => {
  const e = withStatus('completed', 'Completed', 'Error')
  assertEquals(phaseOf(e), 'error')
  assertEquals(isLive(e), false)
  assertEquals(isOver(e), true)
})

Deno.test('isOver: finished, stopped and verdict-less completed runs are over; running ones are not', () => {
  assertEquals(isOver(withStatus('completed', 'Completed', 'Pass')), true)
  assertEquals(isOver(withStatus('completed', 'Completed', 'Fail')), true)
  assertEquals(isOver(withStatus('stopped', 'Chaos Injection Stopped', 'Stopped', 'stop')), true)
  // Completed with no verdict written: nothing more will happen to it.
  assertEquals(isOver(withStatus('completed', 'Completed', '')), true)
  assertEquals(isOver(withStatus('running', 'Running')), false)
  assertEquals(isOver(withStatus('running', 'Running', 'Awaited', 'stop')), false)
  assertEquals(isOver(engine()), false)
})

const result = (name: string, verdict: string, pct?: string, labels: Record<string, string> = {}, engineName?: string): ChaosResult => ({
  metadata: { name, namespace: 'adhar-system', labels },
  spec: { engine: engineName ?? name.replace(/-pod-.*$/, ''), experiment: 'pod-delete' },
  status: { experimentStatus: { verdict, ...(pct !== undefined ? { probeSuccessPercentage: pct } : {}) } },
})

Deno.test('measuredProbe: only a Pass or Fail verdict carries a probe measurement', () => {
  assertEquals(measuredProbe(result('a-pod-delete', 'Pass', '100')), 100)
  assertEquals(measuredProbe(result('a-pod-delete', 'Fail', '62.5')), 62.5)
  // Litmus writes 0 on a run that errored before its probes ran.
  assertEquals(measuredProbe(result('a-pod-delete', 'Error', '0')), undefined)
  assertEquals(measuredProbe(result('a-pod-delete', 'Awaited', 'Awaited')), undefined)
  assertEquals(measuredProbe(result('a-pod-delete', 'Pass', '')), undefined)
  assertEquals(measuredProbe(undefined), undefined)
})

Deno.test('verdictTally counts results — including ones whose engine is gone — and keeps errors apart', () => {
  // The resilience runner's results outlive its engines; these are what the
  // cluster really has on record.
  const results = [
    result('adhar-chaos-reactapp-pod-delete', 'Pass', '100', { 'adhar.io/chaos-target': 'test' }, 'adhar-chaos-reactapp'),
    result('adhar-chaos-reactapp-pod-network-latency', 'Error', '0', { 'adhar.io/chaos-target': 'test' }, 'adhar-chaos-reactapp'),
    result('kill-checkout-pod-delete', 'Fail', '40', {}, 'kill-checkout'),
  ]
  assertEquals(verdictTally(results, [engine()]), { held: 1, judged: 2, errored: 1 })
  // Namespace scope: the live engine says `payments`, the orphan results say `test`.
  assertEquals(verdictTally(results, [engine()], 'payments'), { held: 0, judged: 1, errored: 0 })
  assertEquals(verdictTally(results, [engine()], 'test'), { held: 1, judged: 1, errored: 1 })
})

Deno.test('appKindOfPods names the owner Litmus will look for', () => {
  const rollout = { metadata: { labels: { app: 'reactapp', 'rollouts-pod-template-hash': '6f5cccffb9' }, ownerReferences: [{ kind: 'ReplicaSet' }] } }
  const deploy = { metadata: { labels: { app: 'cache', 'pod-template-hash': '68d6bd4df5' }, ownerReferences: [{ kind: 'ReplicaSet' }] } }
  const sts = { metadata: { labels: { app: 'db' }, ownerReferences: [{ kind: 'StatefulSet' }] } }
  assertEquals(appKindOfPods([rollout, rollout]), 'rollout')
  assertEquals(appKindOfPods([deploy]), 'deployment')
  assertEquals(appKindOfPods([sts]), 'statefulset')
  assertEquals(appKindOfPods([{ metadata: { ownerReferences: [{ kind: 'DaemonSet' }] } }]), 'daemonset')
  // Mixed owners or bare pods: no single answer, so none is guessed.
  assertEquals(appKindOfPods([rollout, deploy]), undefined)
  assertEquals(appKindOfPods([{ metadata: {} }]), undefined)
  assertEquals(appKindOfPods([]), undefined)
})

Deno.test('errorReason unwraps the JSON reason Litmus nests in errorOutput', () => {
  const r = (reason?: string, errorCode?: string): ChaosResult => ({ metadata: { name: 'x' }, status: { experimentStatus: { verdict: 'Error', errorOutput: { ...(reason !== undefined ? { reason } : {}), ...(errorCode ? { errorCode } : {}) } } } })
  // Verbatim from a ChaosResult on the cluster.
  assertEquals(
    errorReason(r('{"errorCode":"STATUS_CHECKS_ERROR","phase":"ChaosInject","reason":"helper pod is in Pending state","target":"{podName: pod-network-latency-helper-eda2bo, namespace: adhar-system}"}', 'STATUS_CHECKS_ERROR')),
    'helper pod is in Pending state (ChaosInject)',
  )
  assertEquals(errorReason(r('target not found')), 'target not found')
  assertEquals(errorReason(r('', 'TARGET_SELECTION_ERROR')), 'TARGET_SELECTION_ERROR')
  assertEquals(errorReason(undefined), undefined)
})
