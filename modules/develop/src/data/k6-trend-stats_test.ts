import { assertEquals } from 'jsr:@std/assert@^1'
import {
  argsSetTrendStats,
  ENV_RW_TREND_STATS,
  ENV_SUMMARY_TREND_STATS,
  requestsP99,
  scriptSetsTrendStats,
  SUMMARY_TREND_STATS,
  usesPrometheusRw,
  withTrendStats,
} from './k6-trend-stats.ts'
import { testRunTemplate } from './perf-runner.ts'
import { DEFAULT_CONFIG } from './perf-format.ts'

const envOf = (spec: Record<string, unknown>) => ((spec.runner as { env?: Array<{ name: string; value?: string }> } | undefined)?.env ?? [])

Deno.test('withTrendStats asks for p(99) on the runner env, never in the shell-split arguments', () => {
  const spec = withTrendStats({ parallelism: 1, arguments: '--vus 5 --duration 30s', runner: { image: 'grafana/k6:1.3.0', env: [{ name: 'BASE_URL', value: 'http://x' }] } })
  assertEquals(spec.arguments, '--vus 5 --duration 30s')
  assertEquals(envOf(spec), [
    { name: 'BASE_URL', value: 'http://x' },
    { name: ENV_SUMMARY_TREND_STATS, value: SUMMARY_TREND_STATS },
  ])
  assertEquals((spec.runner as { image: string }).image, 'grafana/k6:1.3.0')
  assertEquals(SUMMARY_TREND_STATS.includes('p(99)'), true)
  // k6 envconfig splits on commas: no stat may contain one.
  assertEquals(SUMMARY_TREND_STATS.split(',').every((s) => /^(avg|min|med|max|p\(\d+(\.\d+)?\))$/.test(s)), true)
})

Deno.test('withTrendStats creates the runner block when there is none', () => {
  assertEquals(envOf(withTrendStats({ parallelism: 2 })), [{ name: ENV_SUMMARY_TREND_STATS, value: SUMMARY_TREND_STATS }])
})

Deno.test("withTrendStats respects the user's own choice", () => {
  const viaArgs = { arguments: '--summary-trend-stats=avg,p(99.9)' }
  assertEquals(withTrendStats(viaArgs), viaArgs)
  const viaArgv = { args: ['--summary-trend-stats', 'avg,p(50)'] }
  assertEquals(withTrendStats(viaArgv), viaArgv)
  const viaEnv = { runner: { env: [{ name: ENV_SUMMARY_TREND_STATS, value: 'avg' }] } }
  assertEquals(withTrendStats(viaEnv), viaEnv)
  // The env var outranks script options in k6, so a script that sets them is left alone.
  const spec = { parallelism: 1 }
  assertEquals(withTrendStats(spec, { script: 'export const options = { summaryTrendStats: ["avg", "p(99.9)"] }' }), spec)
})

Deno.test('withTrendStats is idempotent (a rerun of a run that already asked)', () => {
  const once = withTrendStats({ parallelism: 1 })
  assertEquals(withTrendStats(once), once)
})

Deno.test('remote-write runs get the same stats for the live series', () => {
  for (const args of ['-o experimental-prometheus-rw', '--out experimental-prometheus-rw', '--out=json=a.json,experimental-prometheus-rw']) {
    const env = envOf(withTrendStats({ arguments: args }))
    assertEquals(env.map((e) => e.name), [ENV_SUMMARY_TREND_STATS, ENV_RW_TREND_STATS], args)
  }
  assertEquals(usesPrometheusRw(undefined, [{ name: 'K6_OUT', value: 'experimental-prometheus-rw' }]), true)
  assertEquals(usesPrometheusRw('--out json=a.json'), false)
  const kept = withTrendStats({ arguments: '-o experimental-prometheus-rw', runner: { env: [{ name: ENV_RW_TREND_STATS, value: 'p(99)' }] } })
  assertEquals(envOf(kept).filter((e) => e.name === ENV_RW_TREND_STATS), [{ name: ENV_RW_TREND_STATS, value: 'p(99)' }])
})

Deno.test('detectors', () => {
  assertEquals(argsSetTrendStats('--vus 2 --summary-trend-stats=avg'), true)
  assertEquals(argsSetTrendStats('--summary-trend-statsx'), false)
  assertEquals(argsSetTrendStats(undefined), false)
  assertEquals(scriptSetsTrendStats('const o = { summaryTrendStats: [] }'), true)
  assertEquals(scriptSetsTrendStats('export default function () {}'), false)
  assertEquals(requestsP99(withTrendStats({})), true)
  assertEquals(requestsP99({ arguments: '--summary-trend-stats=avg,p(99)' }), true)
  assertEquals(requestsP99({}), false)
})

Deno.test('the schedule / CI TestRun template requests p(99) too', () => {
  const t = testRunTemplate({ test: 'checkout', config: { ...DEFAULT_CONFIG, env: { BASE_URL: 'http://x' } } })
  assertEquals(envOf(t.spec as Record<string, unknown>).map((e) => e.name), ['BASE_URL', ENV_SUMMARY_TREND_STATS])
  const own = testRunTemplate({ test: 'checkout', config: DEFAULT_CONFIG, script: 'export const options = { summaryTrendStats: ["p(99.9)"] }' })
  assertEquals(envOf(own.spec as Record<string, unknown>).some((e) => e.name === ENV_SUMMARY_TREND_STATS), false)
})
