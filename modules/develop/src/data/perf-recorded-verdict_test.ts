import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1'
import { DEFAULT_GATE, gateEnv, gateFromEnv, type PerfGate, recordedVerdict } from './perf-gate.ts'
import type { RunMetrics } from './perf-results.ts'

const gate: PerfGate = { ...DEFAULT_GATE, p95Ms: 500, errorRatePct: 1, minRps: 10 }
const env = gateEnv({ test: 'my-service-load', namespace: 'test', gate, application: 'my-service' })

// The console reads back exactly the gate the in-cluster runner sources.
Deno.test('gateFromEnv is the inverse of gateEnv', () => {
  const back = gateFromEnv(env)
  assertEquals(back.gate, gate)
  assertEquals(back.baseline, undefined)
  const withBase = gateFromEnv(gateEnv({
    test: 't',
    namespace: 'n',
    gate: { ...gate, failOnRegression: true },
    baseline: { run: 'r-1', pinnedAt: 'x', metrics: { p95Ms: 120, rps: 50 } },
  }))
  assertEquals(withBase.gate.failOnRegression, true)
  assertEquals(withBase.baseline?.run, 'r-1')
  assertEquals(withBase.baseline?.metrics.p95Ms, 120)
})

const ok = { p95Ms: 54, avgMs: 20, errorRatePct: 0, rps: 126 } as unknown as RunMetrics

// my-service, 2026-10-22: a console-launched run that passed (exit 0) was
// recorded with no verdict, and the scorer held the grade back for it.
Deno.test('a passing console run is recorded as pass', () => {
  assertEquals(recordedVerdict({ metrics: ok, stage: 'finished', exitCode: 0 }, env), { verdict: 'pass', reasons: '' })
})

Deno.test('a run over its gate, with crossed thresholds, or with no summary is recorded as fail', () => {
  const slow = recordedVerdict({ metrics: { ...ok, p95Ms: 900 } as RunMetrics, stage: 'finished', exitCode: 0 }, env)
  assertEquals(slow.verdict, 'fail')
  assertStringIncludes(slow.reasons, '900')
  assertEquals(recordedVerdict({ metrics: ok, stage: 'finished', exitCode: 99 }, env).verdict, 'fail')
  assertEquals(recordedVerdict({ metrics: undefined, stage: 'finished', exitCode: 0 }, env), {
    verdict: 'fail',
    reasons: 'no end-of-test summary was found',
  })
  assertEquals(recordedVerdict({ metrics: ok, stage: 'error', exitCode: 0 }, env), {
    verdict: 'fail',
    reasons: 'run ended in stage error',
  })
})

// Without the artefact the default gate applies: the script's own thresholds.
Deno.test('with no artefact the default gate judges the run', () => {
  assertEquals(recordedVerdict({ metrics: ok, stage: 'finished', exitCode: 0 }, undefined).verdict, 'pass')
  assertEquals(recordedVerdict({ metrics: ok, stage: 'finished', exitCode: 99 }, undefined).verdict, 'fail')
})

// harvestRun lives in a React module this test cannot import; its contract is
// small enough to pin by source: the ConfigMap it applies carries the verdict.
Deno.test('the console harvester records the verdict it judged', async () => {
  const src = await Deno.readTextFile(new URL('./perf-automation.ts', import.meta.url))
  const harvest = src.slice(src.indexOf('export async function harvestRun'), src.indexOf('export function useHarvester'))
  assertStringIncludes(harvest, 'recordedVerdict(')
  assertStringIncludes(harvest, 'artefact?.data?.[GATE_KEY]')
  assertStringIncludes(harvest, 'resultConfigMap({ ...result, ...judged })')
})

// What the harvester writes is what the scorer and the page read back.
Deno.test('a recorded verdict survives the round trip through the result ConfigMap', async () => {
  const { recordFromConfigMap, resultConfigMap } = await import('./perf-results.ts')
  const cm = resultConfigMap({
    run: 'my-service-load-1',
    test: 'my-service-load',
    namespace: 'test',
    summaryText: '',
    trigger: 'console',
    exitCode: 0,
    application: 'my-service',
    verdict: 'fail',
    reasons: 'p95_ms 900 > 500',
  })
  const r = recordFromConfigMap(cm)
  assertEquals([r?.recordedVerdict, r?.recordedReasons], ['fail', 'p95_ms 900 > 500'])
})
