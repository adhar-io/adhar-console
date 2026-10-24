import { assertEquals } from 'jsr:@std/assert@^1'
import { extractOptions, parseK6Duration, parsePlan, parsePlanArgs, plannedVuCurve, plannedVusAt, planSegments, segmentAt, UNKNOWN } from './perf-plan.ts'
import { SCRIPT_STAGES } from './testdata/k6-v1-runner-log.ts'

Deno.test('k6 durations', () => {
  assertEquals(parseK6Duration('30s'), 30)
  assertEquals(parseK6Duration('1m30s'), 90)
  assertEquals(parseK6Duration('1h'), 3600)
  assertEquals(parseK6Duration('500ms'), 0.5)
  assertEquals(parseK6Duration(1500), 1.5) // a bare number in options is milliseconds
  assertEquals(parseK6Duration('30'), undefined)
  assertEquals(parseK6Duration('soon'), undefined)
})

Deno.test('stages are read from a real script, with its thresholds', () => {
  const plan = parsePlan(SCRIPT_STAGES)
  assertEquals(plan.source, 'script')
  assertEquals(plan.totalSecs, 105)
  assertEquals(plan.maxVus, 10)
  assertEquals(plan.scenarios[0].stages, [
    { durationSecs: 30, target: 10 },
    { durationSecs: 60, target: 10 },
    { durationSecs: 15, target: 0 },
  ])
  assertEquals(plan.thresholds.map((t) => `${t.metric}:${t.expression}`), [
    'http_req_duration:p(95)<500',
    'http_req_failed:rate<0.01',
    'checks:rate>0.99',
  ])
})

Deno.test('the VU curve ramps from the start VUs and segments by kind', () => {
  const plan = parsePlan(SCRIPT_STAGES)
  assertEquals(plannedVuCurve(plan), [[0, 1], [30, 10], [90, 10], [105, 0]])
  assertEquals(Math.round(plannedVusAt(plan, 15)!), 6)
  assertEquals(planSegments(plan).map((s) => s.kind), ['ramp-up', 'steady', 'ramp-down'])
  assertEquals(segmentAt(plan, 45)?.kind, 'steady')
  assertEquals(segmentAt(plan, 100)?.kind, 'ramp-down')
})

Deno.test('CLI flags override the script', () => {
  assertEquals(parsePlanArgs('--vus 50 --duration=2m'), { vus: 50, durationSecs: 120 })
  const plan = parsePlan(SCRIPT_STAGES, '--vus 50 --duration 30s')
  assertEquals(plan.source, 'arguments')
  assertEquals(plan.totalSecs, 30)
  assertEquals(plan.maxVus, 50)
  // Thresholds still come from the script.
  assertEquals(plan.thresholds.length, 3)
  const staged = parsePlan(undefined, '--stage 10s:5,20s:5')
  assertEquals(staged.totalSecs, 30)
  assertEquals(staged.maxVus, 5)
})

Deno.test('computed values are unknown, never guessed', () => {
  const opts = extractOptions(`export const options = { vus: __ENV.VUS || 10, duration: '30s' }`)
  assertEquals(opts?.vus, UNKNOWN)
  assertEquals(opts?.duration, '30s')
  const plan = parsePlan(`export const options = { vus: __ENV.VUS || 10, duration: '30s' }`)
  assertEquals(plan.source, 'none')
  assertEquals(plan.totalSecs, undefined)
  assertEquals(parsePlan('export const options = buildOptions()').source, 'none')
})

Deno.test('scenarios: VU executors add up, arrival-rate ones contribute duration only', () => {
  const plan = parsePlan(`
    export const options = {
      scenarios: {
        browse: { executor: 'constant-vus', vus: 5, duration: '1m' },
        spike: { executor: 'ramping-vus', startTime: '30s', startVUs: 0, stages: [{ duration: '10s', target: 20 }, { duration: '10s', target: 0 }] },
        api: { executor: 'constant-arrival-rate', rate: 30, timeUnit: '1s', duration: '90s', preAllocatedVUs: 10, maxVUs: 40 },
      },
    }`)
  assertEquals(plan.source, 'script')
  assertEquals(plan.totalSecs, 90)
  assertEquals(plan.maxVus, 5 + 20 + 40)
  assertEquals(plannedVusAt(plan, 40), 5 + 20)
  assertEquals(plan.scenarios.find((s) => s.name === 'api')?.rate, '30/1s')
})

Deno.test('no options means one VU, one iteration — an upper bound, not a plan', () => {
  const plan = parsePlan('export default function () {}')
  assertEquals(plan.source, 'default')
  assertEquals(plan.totalIsUpperBound, true)
})

Deno.test('comments, trailing commas, quoted keys and template strings', () => {
  const opts = extractOptions(`export const options = {
    // ramp
    'stages': [ { duration: "10s", target: 3, }, ], /* block */
    tags: { env: \`\${x}\` },
  }`)
  assertEquals(Array.isArray(opts?.stages), true)
  assertEquals((opts?.tags as Record<string, unknown>).env, UNKNOWN)
})
