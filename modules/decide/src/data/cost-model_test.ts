import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  blendedRates,
  dailyOf,
  efficiencyOf,
  evaluateBudget,
  forecastMonth,
  formatUsd,
  movers,
  prevSamePeriod,
  regroup,
  rightsize,
  rowsOf,
} from './cost-model.ts'
import { buildStats, toBuildRun } from './builds-model.ts'
import { toCsv } from './csv.ts'

const DAY = 86_400_000
const GiB = 1024 ** 3
const MiB = 1024 ** 2

Deno.test('rows: idle split out, pseudo keys dropped, efficiency cost-weighted', () => {
  const { rows, idle, allocated } = rowsOf({
    data: [{
      a: { totalCost: 10, cpuCost: 6, ramCost: 4, cpuCoreRequestAverage: 1, cpuCoreUsageAverage: 0.5, ramByteRequestAverage: 2, ramByteUsageAverage: 2 },
      __idle__: { totalCost: 5 },
      __unallocated__: { totalCost: 1 },
    }],
  })
  assertEquals(rows.length, 1)
  assertEquals(idle, 5)
  assertEquals(allocated, 10)
  assertAlmostEquals(rows[0].efficiency!, (0.5 * 6 + 1 * 4) / 10)
  assertEquals(efficiencyOf({ cpuReq: 0, cpuUsed: 0, ramReq: 0, ramUsed: 0, components: rows[0].components }), null)
})

Deno.test('regroup splits a multi-key row evenly', () => {
  const { rows } = rowsOf({ data: [{ ns1: { totalCost: 10 }, ns2: { totalCost: 4 } }] })
  const g = regroup(rows, (r) => (r.key === 'ns1' ? ['a', 'b'] : ['a']))
  assertEquals(g.map((r) => [r.key, r.total]), [['a', 9], ['b', 5]])
})

Deno.test('daily series and forecast use complete days only', () => {
  const now = Date.UTC(2026, 9, 11, 12) // Oct 11, 12:00 → 10.5 days elapsed
  const resp = {
    data: Array.from({ length: 11 }, (_, i) => ({
      x: { totalCost: i === 10 ? 3 : 10, window: { start: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() } },
    })),
  }
  const days = dailyOf(resp)
  assertEquals(days.length, 11)
  const f = forecastMonth(days, now)!
  assertEquals(f.mtd, 103)
  assertEquals(f.runRate, 10)
  assertEquals(f.basisDays, 7)
  assertAlmostEquals(f.forecast, 103 + 10 * (31 - 10.5))
  assertEquals(forecastMonth(days.slice(10), now), null)
})

Deno.test('previous month like-for-like', () => {
  const now = Date.UTC(2026, 9, 3, 6)
  const days = Array.from({ length: 30 }, (_, i) => ({ day: Date.UTC(2026, 8, 1) + i * DAY, total: 1, idle: 0, byKey: {} }))
  const p = prevSamePeriod(days, now)
  assertEquals(p.total, 3)
  assertEquals(p.full, 30)
  assertEquals(p.covered, true)
  assertEquals(prevSamePeriod([], now).covered, false)
})

Deno.test('movers rank by absolute delta, new spend has no pct', () => {
  const r = (key: string, total: number) => ({ key, total, components: { cpu: 0, ram: 0, gpu: 0, storage: 0, network: 0, other: 0 }, cpuReq: 0, cpuUsed: 0, ramReq: 0, ramUsed: 0, efficiency: null })
  const m = movers([r('a', 10), r('b', 50), r('c', 5)], [r('a', 20), r('b', 30)])
  assertEquals(m.map((x) => x.key), ['b', 'a', 'c'])
  assertEquals(m[2].pct, null)
  assertEquals(m[1].pct, -0.5)
})

Deno.test('budget status', () => {
  const b = { monthlyUsd: 100, alertPct: 80 }
  assertEquals(evaluateBudget(b, 120, 150).status, 'over')
  assertEquals(evaluateBudget(b, 50, 110).status, 'forecast-over')
  assertEquals(evaluateBudget(b, 85, 95).status, 'warning')
  assertEquals(evaluateBudget(b, 20, 60).status, 'ok')
  assertEquals(evaluateBudget(b, null, null).status, 'no-data')
})

Deno.test('rightsizing: over-provisioned with savings, under-provisioned flagged', () => {
  const rates = blendedRates([{ cpuCost: 73, cpuCoreHours: 730, ramCost: 7.3, ramByteHours: 730 * GiB }])
  assertAlmostEquals(rates.cpu!, 0.1)
  assertAlmostEquals(rates.ramGiB!, 0.01)
  const recs = rightsize(
    [
      { namespace: 'a', container: 'api', cpuReq: 1, cpuP95: 0.1, memReq: 2 * GiB, memMax: 200 * MiB, replicas: 2 },
      { namespace: 'a', container: 'ok', cpuReq: 0.2, cpuP95: 0.15, memReq: 256 * MiB, memMax: 200 * MiB, replicas: 1 },
      { namespace: 'a', container: 'hot', cpuReq: 0.1, cpuP95: 0.3, memReq: 256 * MiB, memMax: 100 * MiB, replicas: 1 },
    ],
    rates,
  )
  assertEquals(recs.map((r) => [r.container, r.kind]), [['api', 'over'], ['hot', 'under']])
  assertAlmostEquals(recs[0].cpuRec!, 0.12)
  assertEquals(recs[0].memRec, 240 * MiB)
  // (0.88 cores × 0.1 + (2 GiB − 240 MiB) × 0.01) × 730 × 2
  assertAlmostEquals(recs[0].monthlySavings!, (0.88 * 0.1 + ((2 * GiB - 240 * MiB) / GiB) * 0.01) * 730 * 2, 1e-6)
  // 'hot' is under on CPU (risk wins the kind) but still frees memory.
  assertAlmostEquals(recs[1].monthlySavings!, (128 / 1024) * 0.01 * 730)
})

Deno.test('build stats: success excludes cancelled, durations and queue', () => {
  const mk = (name: string, status: string, reason: string, created: string, start: string, end: string) =>
    toBuildRun({
      metadata: { name, creationTimestamp: created, labels: { 'tekton.dev/pipeline': 'app-ci' } },
      status: { conditions: [{ type: 'Succeeded', status, reason }], startTime: start, completionTime: end },
    })
  const runs = [
    mk('a', 'True', 'Succeeded', '2026-10-01T00:00:00Z', '2026-10-01T00:00:10Z', '2026-10-01T00:01:10Z'),
    mk('b', 'False', 'Failed', '2026-10-01T00:00:00Z', '2026-10-01T00:00:20Z', '2026-10-01T00:03:20Z'),
    mk('c', 'False', 'Cancelled', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-01T00:00:30Z'),
  ]
  const s = buildStats(runs, Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2))
  assertEquals([s.total, s.succeeded, s.failed, s.cancelled], [3, 1, 1, 1])
  assertEquals(s.successRate, 0.5)
  assertEquals(s.durationP50, 120)
  assertEquals(s.queueP50, 10)
  assertEquals(s.byPipeline[0].pipeline, 'app-ci')
})

Deno.test('csv quoting and formula guard', () => {
  assertEquals(toCsv(['a', 'b'], [['x,y', '=SUM(1)'], [1.5, null]]), 'a,b\r\n"x,y",\'=SUM(1)\r\n1.5,\r\n')
  assertEquals(formatUsd(12345), '$12.3K')
  assertEquals(formatUsd(-5.5, { precise: true }), '−$5.50')
})

Deno.test('spend windows: MTD compares the same elapsed span of last month', async () => {
  const { spendWindow } = await import('./cost-model.ts')
  const now = Date.UTC(2026, 9, 20, 12, 30)
  const w = spendWindow('mtd', now)
  assertEquals([w.start, w.end], [Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 20, 12)])
  assertEquals([w.prevStart, w.prevEnd], [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 20, 12)])
  const lm = spendWindow('lastmonth', now)
  assertEquals([lm.start, lm.end, lm.prevStart, lm.prevEnd], [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1), Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1)])
  const d7 = spendWindow('7d', now)
  assertEquals(d7.end - d7.start, 7 * DAY)
  assertEquals(d7.prevEnd, d7.start)
  assertEquals(spendWindow('bogus', now).id, 'mtd')
})
