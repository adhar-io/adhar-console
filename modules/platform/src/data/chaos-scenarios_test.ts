import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  buildGameDay,
  CHECKER_IMAGE,
  formatSeconds,
  GAMEDAY_SERVICE_ACCOUNT,
  SCENARIOS,
  scenarioById,
  totalSeconds,
  type GameDayInput,
} from './chaos-scenarios.ts'
import { CHAOS_NAMESPACE, CHAOS_SERVICE_ACCOUNT, faultById } from './chaos-kinds.ts'
import { engineManifest } from './chaos.ts'

Deno.test('every scenario states a hypothesis — otherwise it is just breakage', () => {
  for (const s of SCENARIOS) {
    assertEquals(typeof s.hypothesis, 'string', s.id)
    assertEquals(s.hypothesis.length > 20, true, s.id)
    assertEquals(s.seconds > 0, true, s.id)
  }
})

Deno.test('scenario ids are unique and resolvable, and every fault they name is catalogued', () => {
  const ids = SCENARIOS.map((s) => s.id)
  assertEquals(new Set(ids).size, ids.length)
  for (const s of SCENARIOS) {
    assertEquals(scenarioById(s.id)?.id, s.id)
    assertEquals(faultById(s.fault)?.id, s.fault, `${s.id} names unknown fault ${s.fault}`)
  }
})

Deno.test('scenarios never carry their own target — the launcher supplies it', () => {
  for (const s of SCENARIOS) {
    assertEquals('PODS_AFFECTED_PERC' in s.env && s.blast !== 'high', false, s.id)
    assertEquals('TARGET_NODES' in s.env, false, s.id)
  }
})

Deno.test('the catalogue covers the failure families that matter', () => {
  const cats = new Set(SCENARIOS.map((s) => s.category))
  for (const c of ['availability', 'network', 'resource', 'storage', 'dependency', 'node']) assertEquals(cats.has(c as never), true, c)
})

const target: GameDayInput['target'] = { namespace: 'payments', label: 'app=checkout', mode: 'one' }

Deno.test('an engine manifest is a runnable Litmus ChaosEngine', () => {
  const m = engineManifest({ fault: 'pod-network-latency', name: 'x', targetNamespace: 'payments', label: 'app=checkout', mode: 'percent', percent: '50', env: { NETWORK_LATENCY: '250' } })
  assertEquals(m.kind, 'ChaosEngine')
  assertEquals(m.metadata.namespace, CHAOS_NAMESPACE)
  assertEquals(m.spec?.chaosServiceAccount, CHAOS_SERVICE_ACCOUNT)
  assertEquals(m.spec?.engineState, 'active')
  assertEquals(m.spec?.appinfo, { appns: 'payments', applabel: 'app=checkout', appkind: 'deployment' })
  const env = Object.fromEntries((m.spec?.experiments?.[0].spec?.components?.env ?? []).map((e) => [e.name, e.value]))
  assertEquals(env.NETWORK_LATENCY, '250')       // override wins
  assertEquals(env.TOTAL_CHAOS_DURATION, '60')   // catalogue default kept
  assertEquals(env.PODS_AFFECTED_PERC, '50')
})

Deno.test('a steady-state URL becomes a continuous Litmus http probe that fails the run', () => {
  const m = engineManifest({ fault: 'pod-delete', name: 'x', targetNamespace: 'p', mode: 'one', steadyState: { url: 'http://svc/health', statusCode: 200, intervalSeconds: 5 } })
  const probe = m.spec?.experiments?.[0].spec?.probe?.[0] as Record<string, unknown>
  assertEquals(probe.type, 'httpProbe')
  assertEquals(probe.mode, 'Continuous')
  assertEquals((probe.runProperties as Record<string, unknown>).stopOnFailure, true)
  assertEquals(((probe['httpProbe/inputs'] as Record<string, unknown>).method as Record<string, Record<string, string>>).get.responseCode, '200')
})

Deno.test('a node fault carries no appinfo and names the node', () => {
  const m = engineManifest({ fault: 'node-drain', name: 'x', targetNamespace: 'p', mode: 'one', node: 'w-1' })
  assertEquals(m.spec?.appinfo, undefined)
  const env = Object.fromEntries((m.spec?.experiments?.[0].spec?.components?.env ?? []).map((e) => [e.name, e.value]))
  assertEquals(env.TARGET_NODES, 'w-1')
})

Deno.test('a serial game day alternates faults and recovery pauses, then reverts', () => {
  const wf = buildGameDay({ name: 'gd', target, scenarios: ['pod-delete-one', 'net-latency'], strategy: 'serial', recoverySeconds: 30 }) as {
    spec: { entrypoint: string; onExit: string; serviceAccountName: string; templates: Array<Record<string, unknown>> }
    metadata: { namespace: string; labels: Record<string, string> }
  }
  assertEquals(wf.metadata.namespace, CHAOS_NAMESPACE)
  assertEquals(wf.spec.serviceAccountName, GAMEDAY_SERVICE_ACCOUNT)
  assertEquals(wf.spec.onExit, 'revert')
  const entry = wf.spec.templates.find((t) => t.name === wf.spec.entrypoint) as { steps: Array<Array<{ name: string }>> }
  assertEquals(entry.steps.map((g) => g.map((s) => s.name)), [['1-pod-delete-one'], ['1-recover'], ['2-net-latency']])
  const step = wf.spec.templates.find((t) => t.name === '1-pod-delete-one') as { container: { image: string; args: string[] }; inputs: { artifacts: Array<{ raw: { data: string } }> } }
  assertEquals(step.container.image, CHECKER_IMAGE)
  const eng = JSON.parse(step.inputs.artifacts[0].raw.data)
  assertEquals(eng.kind, 'ChaosEngine')
  assertEquals(eng.metadata.labels['adhar.io/chaos-gameday'], 'gd')
  assertEquals(eng.spec.experiments[0].name, 'pod-delete')
})

Deno.test('a parallel game day is one step group with no pauses', () => {
  const wf = buildGameDay({ name: 'gd', target, scenarios: ['pod-delete-one', 'net-latency'], strategy: 'parallel', recoverySeconds: 30 }) as {
    spec: { entrypoint: string; templates: Array<Record<string, unknown>> }
  }
  const entry = wf.spec.templates.find((t) => t.name === wf.spec.entrypoint) as { steps: Array<Array<{ name: string }>> }
  assertEquals(entry.steps.length, 1)
  assertEquals(entry.steps[0].length, 2)
  assertEquals(wf.spec.templates.some((t) => 'suspend' in t), false)
})

Deno.test('the revert step stops and deletes every engine the game day made', () => {
  const wf = buildGameDay({ name: 'gd', target, scenarios: ['pod-delete-one', 'net-latency'], strategy: 'serial', recoverySeconds: 0 }) as {
    spec: { templates: Array<Record<string, unknown>> }
  }
  const revert = wf.spec.templates.find((t) => t.name === 'revert') as { container: { args: string[] } }
  const script = revert.container.args[0]
  assertEquals(script.includes('gd-1-pod-delete'), true)
  assertEquals(script.includes('gd-2-pod-network-latency'), true)
  assertEquals(script.includes('"engineState":"stop"'), true)
  assertEquals(script.includes('delete chaosengine'), true)
})

Deno.test('a game day needs at least one scenario', () => {
  assertThrows(() => buildGameDay({ name: 'gd', target, scenarios: [], strategy: 'serial', recoverySeconds: 0 }))
})

Deno.test('duration arithmetic', () => {
  const chosen = ['pod-delete-one', 'net-latency'].map(scenarioById).filter(Boolean) as NonNullable<ReturnType<typeof scenarioById>>[]
  assertEquals(totalSeconds(chosen, { strategy: 'serial', recoverySeconds: 30 }), 60 + 30 + 120)
  assertEquals(totalSeconds(chosen, { strategy: 'parallel', recoverySeconds: 30 }), 120)
  assertEquals(formatSeconds(90), '1m 30s')
  assertEquals(formatSeconds(3600), '1h 0m')
})
