import { assertEquals } from 'jsr:@std/assert'
import {
  CHAOS_FAULTS,
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
