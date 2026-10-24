/**
 * Cross-run shapes for the Performance Center's overview, results and
 * schedules tabs: verdicts per day, one trend series per test, and the
 * scheduled runs coming up. Pure — computed from the kept result ConfigMaps
 * and the CronJobs, never sampled or estimated.
 */
import type { GateVerdict } from './perf-gate.ts'
import type { MetricKey, RunRecord } from './perf-results.ts'
import { nextRuns } from './perf-cron.ts'

const DAY = 24 * 3600 * 1000

export interface DayVerdicts {
  /** Local midnight that starts the day. */
  dayMs: number
  pass: number
  fail: number
  /** Runs with no verdict (no summary, nothing to judge). */
  noData: number
}

/** Local midnight of the day `t` falls in. */
export function dayStart(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Gate verdicts per local day, for the last `days` days including today.
 * Days with no runs are present with zeros — a gap in testing is information.
 */
export function dailyVerdicts(
  records: readonly RunRecord[],
  verdictOf: (r: RunRecord) => Pick<GateVerdict, 'status'>,
  nowMs: number,
  days = 14,
): DayVerdicts[] {
  const today = dayStart(nowMs)
  const out: DayVerdicts[] = []
  for (let i = days - 1; i >= 0; i--) {
    // Step back by calendar day, not 24h, so DST changes do not skip a day.
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    out.push({ dayMs: d.getTime(), pass: 0, fail: 0, noData: 0 })
  }
  const index = new Map(out.map((d, i) => [d.dayMs, i]))
  for (const r of records) {
    const t = Date.parse(r.startedAt ?? '')
    if (!Number.isFinite(t)) continue
    const i = index.get(dayStart(t))
    if (i === undefined) continue
    const s = verdictOf(r).status
    if (s === 'pass') out[i].pass++
    else if (s === 'fail') out[i].fail++
    else out[i].noData++
  }
  return out
}

export interface TestSeries {
  test: string
  points: Array<[number, number]>
}

/**
 * One series per test for a metric, over the window, for the `limit` tests
 * run most recently. Series are returned in test-name order so a test keeps
 * its colour when another one drops out of the set.
 */
export function testSeries(
  records: readonly RunRecord[],
  key: MetricKey,
  opts: { sinceMs?: number; limit?: number } = {},
): TestSeries[] {
  const by = new Map<string, Array<[number, number]>>()
  const latest = new Map<string, number>()
  for (const r of records) {
    const t = Date.parse(r.startedAt ?? '')
    const v = r.metrics?.[key] as number | undefined
    if (!Number.isFinite(t) || v === undefined || !Number.isFinite(v)) continue
    if (opts.sinceMs !== undefined && t < opts.sinceMs) continue
    const list = by.get(r.test) ?? []
    list.push([t, v])
    by.set(r.test, list)
    latest.set(r.test, Math.max(latest.get(r.test) ?? 0, t))
  }
  const keep = [...latest.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.limit ?? 5).map(([t]) => t)
  return keep.sort().map((test) => ({ test, points: by.get(test)!.sort((a, b) => a[0] - b[0]) }))
}

export interface UpcomingRun {
  at: number
  schedule: string
  test: string
  namespace: string
}

/** Every scheduled run in the next `horizonMs`, soonest first, capped at `max`. */
export function upcomingRuns(
  schedules: ReadonlyArray<{ name: string; test: string; namespace: string; cron: string; timeZone?: string; suspend?: boolean }>,
  nowMs: number,
  horizonMs = 7 * DAY,
  max = 50,
): UpcomingRun[] {
  const out: UpcomingRun[] = []
  for (const s of schedules) {
    if (s.suspend) continue
    let at: number[] = []
    try {
      at = nextRuns(s.cron, nowMs, max, s.timeZone)
    } catch {
      continue
    }
    for (const t of at) {
      if (t > nowMs + horizonMs) break
      out.push({ at: t, schedule: s.name, test: s.test, namespace: s.namespace })
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, max)
}
