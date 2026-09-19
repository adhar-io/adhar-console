import { assertEquals } from 'jsr:@std/assert'
import {
  CHAOS_KINDS,
  gvrFor,
  injectedCount,
  isLive,
  isPaused,
  isWindingDown,
  kindIdOf,
  modeLabel,
  modeNeedsValue,
  phaseOf,
  targetSummary,
  type ChaosExperiment,
} from './chaos-kinds.ts'

/**
 * Chaos is the one place in this console where a wrong status reading is
 * dangerous rather than annoying: the page's job is to tell someone whether a
 * fault is applied to a running system right now. These tests pin exactly that.
 */

const exp = (over: Partial<ChaosExperiment> = {}): ChaosExperiment => ({
  kind: 'PodChaos',
  metadata: { name: 'kill-checkout', namespace: 'chaos' },
  spec: { action: 'pod-failure', mode: 'one', selector: { namespaces: ['payments'] } },
  ...over,
})

const withStatus = (
  conditions: Array<[string, 'True' | 'False']>,
  recordPhases: string[] = [],
  desired?: string,
): ChaosExperiment =>
  exp({
    status: {
      conditions: conditions.map(([type, status]) => ({ type, status })),
      experiment: {
        ...(desired ? { desiredPhase: desired } : {}),
        containerRecords: recordPhases.map((phase, i) => ({ id: String(i), phase })),
      },
    },
  })

Deno.test('an experiment with the fault applied reads as injected', () => {
  assertEquals(phaseOf(withStatus([['AllInjected', 'True']], ['Injected'], 'Run')), 'injected')
  assertEquals(isLive(withStatus([['AllInjected', 'True']], ['Injected'], 'Run')), true)
})

Deno.test('selected but not yet applied is injecting, NOT injected', () => {
  // The window that matters: nothing is broken yet, and saying otherwise
  // would have someone chasing an outage that has not started.
  const e = withStatus([['Selected', 'True']], ['Not Injected'], 'Run')
  assertEquals(phaseOf(e), 'injecting')
  assertEquals(isLive(e), false)
})

Deno.test('an experiment that ran its duration is finished, not "stopped"', () => {
  // The controller sets desiredPhase=Stop both when a person pauses an
  // experiment AND when a bounded one reaches the end of its duration.
  // Reading the second as a manual halt mislabels every completed experiment.
  const e = withStatus([['AllRecovered', 'True']], ['Not Injected'], 'Stop')
  assertEquals(phaseOf(e), 'finished')
  assertEquals(isPaused(e), false)
  assertEquals(isLive(e), false)
})

Deno.test('an experiment a person halted is paused, even once recovered', () => {
  const e = exp({
    metadata: { name: 'x', namespace: 'chaos', annotations: { 'experiment.chaos-mesh.org/pause': 'true' } },
    status: {
      conditions: [{ type: 'AllRecovered', status: 'True' }],
      experiment: { desiredPhase: 'Stop', containerRecords: [{ phase: 'Not Injected' }] },
    },
  })
  assertEquals(phaseOf(e), 'paused')
  assertEquals(isLive(e), false)
})

Deno.test('paused while still applied is recovering — the fault is still out there', () => {
  const e = exp({
    metadata: {
      name: 'x',
      namespace: 'chaos',
      annotations: { 'experiment.chaos-mesh.org/pause': 'true' },
    },
    status: {
      conditions: [{ type: 'AllInjected', status: 'True' }],
      experiment: { desiredPhase: 'Stop', containerRecords: [{ phase: 'Injected' }] },
    },
  })
  assertEquals(phaseOf(e), 'recovering')
  // Still live: this is the assertion that stops the page saying "stopped"
  // while traffic is still being dropped.
  assertEquals(isLive(e), true)
})

Deno.test('paused with nothing applied is simply paused', () => {
  const e = exp({
    metadata: { name: 'x', namespace: 'chaos', annotations: { 'experiment.chaos-mesh.org/pause': 'true' } },
    status: { conditions: [], experiment: { desiredPhase: 'Stop', containerRecords: [{ phase: 'Not Injected' }] } },
  })
  assertEquals(phaseOf(e), 'paused')
  assertEquals(isLive(e), false)
})

Deno.test('pause means the annotation, and only the annotation', () => {
  assertEquals(
    isPaused(exp({ metadata: { name: 'x', annotations: { 'experiment.chaos-mesh.org/pause': 'true' } } })),
    true,
  )
  // desiredPhase=Stop alone is how a completed experiment looks too.
  assertEquals(isPaused(exp({ status: { experiment: { desiredPhase: 'Stop' } } })), false)
  assertEquals(isPaused(exp({ status: { experiment: { desiredPhase: 'Run' } } })), false)
  assertEquals(isPaused(exp()), false)

  // Winding down is the broader reading, and it covers both.
  assertEquals(isWindingDown(exp({ status: { experiment: { desiredPhase: 'Stop' } } })), true)
  assertEquals(isWindingDown(exp({ status: { experiment: { desiredPhase: 'Run' } } })), false)
})

Deno.test('both spellings of the records list are counted', () => {
  // Chaos Mesh renamed this field; a cluster on either version must report
  // the truth about how many targets are hit.
  assertEquals(
    injectedCount(exp({ status: { experiment: { containerRecords: [{ phase: 'Injected' }, { phase: 'Not Injected' }] } } })),
    { injected: 1, total: 2 },
  )
  assertEquals(
    injectedCount(exp({ status: { experiment: { Records: [{ phase: 'Injected' }, { phase: 'Injected' }] } } })),
    { injected: 2, total: 2 },
  )
  assertEquals(injectedCount(exp()), { injected: 0, total: 0 })
})

Deno.test('every kind maps to a distinct resource path and back', () => {
  const seen = new Set<string>()
  for (const kind of CHAOS_KINDS) {
    const gvr = gvrFor(kind.id)
    assertEquals(gvr.group, 'chaos-mesh.org')
    assertEquals(gvr.namespaced, true)
    assertEquals(seen.has(gvr.resource), false, `${gvr.resource} is duplicated`)
    seen.add(gvr.resource)
    // A list result carries the Kubernetes kind; it has to resolve back.
    assertEquals(kindIdOf(kind.kind), kind.id)
  }
  assertEquals(kindIdOf('NotAChaos'), undefined)
})

Deno.test('mode labels say what will actually be hit', () => {
  assertEquals(modeLabel('one'), 'one pod')
  assertEquals(modeLabel('all'), 'all pods')
  assertEquals(modeLabel('fixed', '3'), '3 pods')
  assertEquals(modeLabel('fixed-percent', '50'), '50% of pods')
  assertEquals(modeLabel('random-max-percent', '25'), 'up to 25% of pods')

  assertEquals(modeNeedsValue('one'), false)
  assertEquals(modeNeedsValue('all'), false)
  assertEquals(modeNeedsValue('fixed'), true)
  assertEquals(modeNeedsValue('fixed-percent'), true)
})

Deno.test('the target summary never implies a narrower blast radius than the spec', () => {
  // An empty namespace selector means EVERY namespace in Chaos Mesh. Rendering
  // that as blank would read as "nothing selected" — the opposite of the truth.
  assertEquals(targetSummary(exp({ spec: { mode: 'all', selector: {} } })), 'every namespace · all pods')
  assertEquals(
    targetSummary(exp({ spec: { mode: 'one', selector: { namespaces: ['payments'], labelSelectors: { app: 'api' } } } })),
    'payments · app=api · one pod',
  )
})
