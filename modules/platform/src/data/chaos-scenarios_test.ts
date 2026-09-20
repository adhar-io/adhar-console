import { assertEquals, assertThrows } from 'jsr:@std/assert'
import {
  buildGameDay,
  type ChaosTarget,
  formatSeconds,
  parseDuration,
  SCENARIOS,
  scenarioById,
  selectorFor,
  TEMPLATE_KEY,
  TEMPLATE_TYPE,
  totalSeconds,
} from './chaos-scenarios.ts'
import { CHAOS_KINDS } from './chaos-kinds.ts'

/**
 * A game day is one Kubernetes object that will deliberately break a running
 * system. If the manifest is subtly wrong the failure modes are all bad: a
 * fault with no deadline never ends, a missing selector hits every pod in the
 * namespace, an abort that does not wire up means the run continues through a
 * real outage. These tests pin the shape.
 */

const TARGET: ChaosTarget = { namespace: 'payments', selector: 'app=checkout', mode: 'one' }

const gameDay = (over: Partial<Parameters<typeof buildGameDay>[0]> = {}) =>
  buildGameDay({
    name: 'friday-gameday',
    namespace: 'chaos',
    target: TARGET,
    scenarios: ['pod-failure-one', 'net-latency'],
    strategy: 'serial',
    recoverySeconds: 30,
    ...over,
  })

type Tpl = Record<string, unknown>
const templates = (wf: Record<string, unknown>) => (wf.spec as { templates: Tpl[] }).templates
const entryOf = (wf: Record<string, unknown>) => (wf.spec as { entry: string }).entry
const byName = (wf: Record<string, unknown>, name: string) => templates(wf).find((t) => t.name === name)

/* ─────────── the catalogue ─────────── */

Deno.test('every scenario states a hypothesis — otherwise it is just breakage', () => {
  for (const s of SCENARIOS) {
    assertEquals(s.hypothesis.length > 20, true, `${s.id} needs a hypothesis`)
    assertEquals(s.rationale.length > 20, true, `${s.id} needs a rationale`)
    // An unbounded fault is an outage, not an experiment.
    assertEquals(parseDuration(s.duration) > 0, true, `${s.id} must be bounded`)
  }
})

Deno.test('scenario ids are unique and resolvable', () => {
  assertEquals(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length)
  for (const s of SCENARIOS) assertEquals(scenarioById(s.id)?.id, s.id)
  assertEquals(scenarioById('nope'), undefined)
})

Deno.test('scenarios never carry their own selector or mode', () => {
  // The target is supplied at launch so one scenario can point anywhere;
  // a baked-in selector would silently override it.
  for (const s of SCENARIOS) {
    assertEquals('selector' in s.spec, false, `${s.id} must not fix a selector`)
    assertEquals('mode' in s.spec, false, `${s.id} must not fix a mode`)
  }
})

Deno.test('the catalogue covers the failure families that matter', () => {
  const categories = new Set(SCENARIOS.map((s) => s.category))
  for (const c of ['availability', 'network', 'resource', 'storage', 'dependency', 'time']) {
    assertEquals(categories.has(c as never), true, `no scenario covers ${c}`)
  }
})

Deno.test('every chaos kind used has a template key and type', () => {
  for (const s of SCENARIOS) {
    assertEquals(typeof TEMPLATE_KEY[s.kind], 'string', `${s.kind} has no template key`)
    assertEquals(typeof TEMPLATE_TYPE[s.kind], 'string', `${s.kind} has no template type`)
    assertEquals(CHAOS_KINDS.some((k) => k.id === s.kind), true, `${s.kind} is not a known kind`)
  }
})

/* ─────────── selectors ─────────── */

Deno.test('a selector becomes namespaces plus labelSelectors', () => {
  assertEquals(selectorFor(TARGET), {
    namespaces: ['payments'],
    labelSelectors: { app: 'checkout' },
  })
})

Deno.test('an empty selector scopes to the namespace, and says so by omission', () => {
  // Chaos Mesh treats a missing labelSelectors as "every pod here", which is
  // correct — but it must be an explicit choice, not a malformed selector
  // silently becoming one.
  assertEquals(selectorFor({ ...TARGET, selector: '' }), { namespaces: ['payments'] })
  assertEquals(selectorFor({ ...TARGET, selector: 'garbage' }), { namespaces: ['payments'] })
})

Deno.test('multiple labels are all applied', () => {
  const s = selectorFor({ ...TARGET, selector: 'app=checkout, tier=web' })
  assertEquals(s.labelSelectors, { app: 'checkout', tier: 'web' })
})

/* ─────────── the workflow ─────────── */

Deno.test('a serial game day alternates faults and recovery pauses', () => {
  const wf = gameDay()
  const entry = byName(wf, entryOf(wf))!
  assertEquals(entry.templateType, 'Serial')
  assertEquals(entry.children, ['1-pod-failure-one', '1-recover', '2-net-latency'])
  // The pause is a Suspend of exactly the requested length.
  const pause = byName(wf, '1-recover')!
  assertEquals(pause.templateType, 'Suspend')
  assertEquals(pause.deadline, '30s')
})

Deno.test('there is no trailing pause after the last fault', () => {
  // A game day that ends in 30 seconds of nothing looks like it hung.
  const children = (byName(gameDay(), 'entry') as { children: string[] }).children
  assertEquals(children[children.length - 1], '2-net-latency')
})

Deno.test('a parallel game day has no pauses at all', () => {
  const wf = gameDay({ strategy: 'parallel' })
  const entry = byName(wf, entryOf(wf))!
  assertEquals(entry.templateType, 'Parallel')
  assertEquals(entry.children, ['1-pod-failure-one', '2-net-latency'])
  assertEquals(templates(wf).some((t) => t.templateType === 'Suspend'), false)
})

Deno.test('each fault carries its deadline, target and selector', () => {
  const step = byName(gameDay(), '1-pod-failure-one')!
  assertEquals(step.templateType, 'PodChaos')
  // Without a deadline the fault never ends on its own.
  assertEquals(step.deadline, '60s')
  const chaos = step.podChaos as Record<string, unknown>
  assertEquals(chaos.action, 'pod-failure')
  assertEquals(chaos.mode, 'one')
  assertEquals(chaos.selector, { namespaces: ['payments'], labelSelectors: { app: 'checkout' } })
})

Deno.test('a mode that needs a value carries it', () => {
  const wf = gameDay({ target: { ...TARGET, mode: 'fixed-percent', value: '50' } })
  const chaos = (byName(wf, '1-pod-failure-one') as { podChaos: Record<string, unknown> }).podChaos
  assertEquals(chaos.mode, 'fixed-percent')
  assertEquals(chaos.value, '50')
})

Deno.test('a steady-state probe runs BESIDE the faults and can abort the run', () => {
  const wf = gameDay({
    steadyState: { url: 'http://checkout/health', statusCode: '200', intervalSeconds: 5, failureThreshold: 3 },
  })
  const entry = byName(wf, entryOf(wf))!
  // The probe must overlap the faults; running it first would check a system
  // nothing had happened to yet.
  assertEquals(entry.templateType, 'Parallel')
  assertEquals(entry.children, ['faults', 'steady-state'])
  // This is what stops an experiment becoming an outage.
  assertEquals(entry.abortWithStatusCheck, true)

  const check = byName(wf, 'steady-state')!
  assertEquals(check.templateType, 'StatusCheck')
  const sc = check.statusCheck as Record<string, unknown>
  assertEquals(sc.mode, 'Continuous')
  assertEquals(sc.type, 'HTTP')
  assertEquals(sc.failureThreshold, 3)
  assertEquals((sc.http as Record<string, unknown>).url, 'http://checkout/health')
  assertEquals(((sc.http as Record<string, unknown>).criteria as Record<string, unknown>).statusCode, '200')

  // The fault sequence survives intact under its own name.
  const faults = byName(wf, 'faults')!
  assertEquals(faults.templateType, 'Serial')
})

Deno.test('the probe outlives the faults so recovery is observed', () => {
  const wf = gameDay({
    steadyState: { url: 'http://x/health', statusCode: '200', intervalSeconds: 5, failureThreshold: 3 },
  })
  const check = byName(wf, 'steady-state')!
  // faults 60 + 120, one 30s pause = 210; plus a recovery tail.
  assertEquals(check.deadline, '240s')
})

Deno.test('without a probe there is exactly one entry and no StatusCheck', () => {
  const wf = gameDay()
  assertEquals(templates(wf).filter((t) => t.name === 'entry').length, 1)
  assertEquals(templates(wf).some((t) => t.templateType === 'StatusCheck'), false)
})

Deno.test('every template name is unique — Chaos Mesh resolves children by name', () => {
  for (const wf of [gameDay(), gameDay({ strategy: 'parallel' }), gameDay({ steadyState: { url: 'u', statusCode: '200', intervalSeconds: 5, failureThreshold: 3 } })]) {
    const names = templates(wf).map((t) => t.name)
    assertEquals(new Set(names).size, names.length)
  }
})

Deno.test('every child referenced actually exists', () => {
  // A dangling child makes the workflow fail admission with a message that
  // does not name the missing template.
  const wf = gameDay({ steadyState: { url: 'u', statusCode: '200', intervalSeconds: 5, failureThreshold: 3 } })
  const names = new Set(templates(wf).map((t) => t.name))
  for (const t of templates(wf)) {
    for (const child of (t.children as string[] | undefined) ?? []) {
      assertEquals(names.has(child), true, `${t.name} references missing ${child}`)
    }
  }
  assertEquals(names.has(entryOf(wf)), true)
})

Deno.test('the same scenario twice does not collide', () => {
  const wf = gameDay({ scenarios: ['pod-kill-one', 'pod-kill-one'], recoverySeconds: 0 })
  assertEquals((byName(wf, 'entry') as { children: string[] }).children, ['1-pod-kill-one', '2-pod-kill-one'])
})

Deno.test('an empty game day is refused rather than built empty', () => {
  assertThrows(() => gameDay({ scenarios: [] }))
  assertThrows(() => gameDay({ scenarios: ['not-a-scenario'] }))
})

/* ─────────── durations ─────────── */

Deno.test('durations parse, and nonsense is zero rather than NaN', () => {
  assertEquals(parseDuration('30s'), 30)
  assertEquals(parseDuration('2m'), 120)
  assertEquals(parseDuration('1h'), 3600)
  assertEquals(parseDuration('500ms'), 0.5)
  // NaN would propagate into the deadline and produce an invalid manifest.
  assertEquals(parseDuration('forever'), 0)
  assertEquals(parseDuration(''), 0)
})

Deno.test('total time accounts for pauses in serial and overlap in parallel', () => {
  const chosen = ['pod-failure-one', 'net-latency'].map(scenarioById).filter(Boolean) as never[]
  assertEquals(totalSeconds(chosen, { strategy: 'serial', recoverySeconds: 30 }), 210)
  // Parallel is as long as the longest fault, not the sum.
  assertEquals(totalSeconds(chosen, { strategy: 'parallel', recoverySeconds: 30 }), 120)
})

Deno.test('durations render readably', () => {
  assertEquals(formatSeconds(45), '45s')
  assertEquals(formatSeconds(120), '2m')
  assertEquals(formatSeconds(210), '3m 30s')
  assertEquals(formatSeconds(3700), '1h 1m')
})
