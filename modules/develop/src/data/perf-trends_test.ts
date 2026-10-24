import { assertEquals } from 'jsr:@std/assert@^1'
import { dailyVerdicts, dayStart, testSeries, upcomingRuns } from './perf-trends.ts'
import type { RunRecord } from './perf-results.ts'

const rec = (test: string, startedAt: string, p95?: number, verdict: 'pass' | 'fail' | 'no-data' = 'pass'): RunRecord & { v: string } =>
  ({ run: `${test}-${startedAt}`, test, namespace: 'n', resultName: 'x', startedAt, trigger: 'console', runners: 1, metrics: p95 === undefined ? undefined : { p95Ms: p95, thresholdsPassed: 0, thresholdsFailed: 0 }, v: verdict }) as RunRecord & { v: string }
const verdictOf = (r: RunRecord) => ({ status: (r as RunRecord & { v: 'pass' | 'fail' | 'no-data' }).v })

Deno.test('verdicts per day include empty days and ignore older runs', () => {
  const now = new Date(2026, 9, 24, 15, 0).getTime()
  const days = dailyVerdicts([
    rec('a', new Date(2026, 9, 24, 9).toISOString(), 1, 'pass'),
    rec('a', new Date(2026, 9, 24, 10).toISOString(), 1, 'fail'),
    rec('b', new Date(2026, 9, 22, 10).toISOString(), 1, 'no-data'),
    rec('b', new Date(2026, 8, 1).toISOString(), 1, 'fail'),
  ], verdictOf, now, 7)
  assertEquals(days.length, 7)
  assertEquals(days.at(-1), { dayMs: dayStart(now), pass: 1, fail: 1, noData: 0 })
  assertEquals(days.at(-3)?.noData, 1)
  assertEquals(days.reduce((n, d) => n + d.pass + d.fail + d.noData, 0), 3)
})

Deno.test('test series: most recent tests kept, returned in name order, gaps skipped', () => {
  const s = testSeries([
    rec('zeta', '2026-10-01T00:00:00Z', 10),
    rec('alpha', '2026-10-03T00:00:00Z', 20),
    rec('alpha', '2026-10-02T00:00:00Z', 30),
    rec('mid', '2026-09-01T00:00:00Z', 5),
    rec('nometrics', '2026-10-05T00:00:00Z'),
  ], 'p95Ms', { limit: 2 })
  assertEquals(s.map((x) => x.test), ['alpha', 'zeta'])
  assertEquals(s[0].points.map((p) => p[1]), [30, 20])
})

Deno.test('upcoming runs within the horizon, soonest first; suspended skipped', () => {
  const now = Date.UTC(2026, 9, 24, 0, 0)
  const u = upcomingRuns([
    { name: 'nightly', test: 'a', namespace: 'n', cron: '0 2 * * *', timeZone: 'UTC' },
    { name: 'hourly', test: 'b', namespace: 'n', cron: '0 * * * *', timeZone: 'UTC', suspend: true },
    { name: 'broken', test: 'c', namespace: 'n', cron: 'nope' },
  ], now, 3 * 24 * 3600 * 1000)
  assertEquals(u.map((x) => new Date(x.at).toISOString()), ['2026-10-24T02:00:00.000Z', '2026-10-25T02:00:00.000Z', '2026-10-26T02:00:00.000Z'])
})
