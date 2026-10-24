import { useMemo, useState } from 'react'
import { Card, CardBody, CardHeader, TimeSeriesChart } from '@adhar/shell-ui'
import { cn, formatAbsolute } from '@adhar/utils'
import { fmtMetric, type MetricKey, type RunRecord } from '../data/perf-results.ts'
import type { GateVerdict } from '../data/perf-gate.ts'
import { dailyVerdicts, testSeries, upcomingRuns } from '../data/perf-trends.ts'
import { fmtDay } from './perf-bits.tsx'

/**
 * Trend views shared by the Overview, Results and Schedules tabs. Every
 * point is a kept run (or a CronJob's next fire time) — nothing smoothed,
 * nothing interpolated across a day nobody tested.
 */

/** Categorical series colours, in a fixed order; a test keeps its slot by name order. */
const SERIES = ['var(--color-brand-500)', 'var(--color-accent-500)', 'var(--color-amber-500)', 'var(--color-emerald-500)', 'var(--color-rose-500)']

const TREND_METRICS: Array<[MetricKey, string]> = [
  ['p95Ms', 'p95 latency'],
  ['errorRatePct', 'Error rate'],
  ['rps', 'Throughput'],
]

export function TrendsSection({ records, verdictOf, nowMs }: {
  records: readonly RunRecord[]
  verdictOf(r: RunRecord): GateVerdict
  nowMs: number
}) {
  const [metric, setMetric] = useState<MetricKey>('p95Ms')
  const since = nowMs - 30 * 24 * 3600 * 1000
  const series = useMemo(() => testSeries(records, metric, { sinceMs: since, limit: 5 }), [records, metric, since])
  const days = useMemo(() => dailyVerdicts(records, verdictOf, nowMs, 14), [records, verdictOf, nowMs])
  if (!records.length) return null
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[12px] font-semibold text-content">Trend · last 30 days</div>
            <span className="text-[11px] text-content-subtle">one line per test, the five most recently run</span>
            <div role="radiogroup" aria-label="Metric" className="ml-auto flex overflow-hidden rounded-md border border-edge-default text-[11px]">
              {TREND_METRICS.map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={metric === k}
                  onClick={() => setMetric(k)}
                  className={cn('px-2 py-0.5', metric === k ? 'bg-surface-sunken font-medium text-content' : 'text-content-muted hover:text-content')}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <TimeSeriesChart
            series={series.map((s, i) => ({ name: s.test, points: s.points, color: SERIES[i % SERIES.length] }))}
            height={180}
            formatTime={fmtDay}
            formatY={(v) => fmtMetric(metric, v)}
            emptyLabel="No kept run in the last 30 days reported this metric"
          />
        </CardBody>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-semibold text-content">Gate verdicts · 14 days</div>
          </div>
        </CardHeader>
        <CardBody>
          <VerdictBars days={days} />
        </CardBody>
      </Card>
    </div>
  )
}

/** Stacked pass / fail / no-verdict bars per day, with a legend and per-day tooltip. */
function VerdictBars({ days }: { days: ReturnType<typeof dailyVerdicts> }) {
  const max = Math.max(1, ...days.map((d) => d.pass + d.fail + d.noData))
  const total = days.reduce((n, d) => n + d.pass + d.fail + d.noData, 0)
  return (
    <div>
      <div className="flex h-[132px] items-end gap-[2px]" role="img" aria-label={`${total} runs over 14 days`}>
        {days.map((d) => {
          const n = d.pass + d.fail + d.noData
          const label = `${new Date(d.dayMs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${d.pass} passed, ${d.fail} failed${d.noData ? `, ${d.noData} without a verdict` : ''}`
          return (
            <div key={d.dayMs} className="group relative flex h-full flex-1 flex-col justify-end" title={label}>
              {n === 0
                ? <div className="h-px w-full bg-edge-default" />
                : (
                  <div className="flex w-full flex-col gap-[2px]" style={{ height: `${(n / max) * 100}%` }}>
                    {d.fail ? <div className="w-full rounded-t-[3px] bg-rose-500" style={{ flex: d.fail }} /> : null}
                    {d.noData ? <div className={cn('w-full bg-gray-400', !d.fail && 'rounded-t-[3px]')} style={{ flex: d.noData }} /> : null}
                    {d.pass ? <div className={cn('w-full bg-emerald-500', !d.fail && !d.noData && 'rounded-t-[3px]')} style={{ flex: d.pass }} /> : null}
                  </div>
                )}
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-content-subtle">
        <span>{fmtDay(days[0].dayMs)}</span>
        <span>today</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-content-muted">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500" /> passed</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-rose-500" /> failed</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-gray-400" /> no verdict</span>
        <span className="ml-auto tabular-nums">{total} run{total === 1 ? '' : 's'}</span>
      </div>
    </div>
  )
}

/** One test's history: p95 against its baseline, and its error rate — two charts, one scale each. */
export function ResultTrend({ records, baseline }: { records: readonly RunRecord[]; baseline?: { p95Ms?: number; errorRatePct?: number } }) {
  const p95 = useMemo(() => testSeries(records, 'p95Ms', { limit: 1 })[0]?.points ?? [], [records])
  const err = useMemo(() => testSeries(records, 'errorRatePct', { limit: 1 })[0]?.points ?? [], [records])
  if (p95.length < 2 && err.length < 2) return null
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><div className="text-[12px] font-semibold text-content">p95 latency per run</div></CardHeader>
        <CardBody>
          <TimeSeriesChart
            series={[{ name: 'p95', points: p95 }]}
            height={140}
            formatTime={fmtDay}
            formatY={(v) => fmtMetric('p95Ms', v)}
            thresholds={baseline?.p95Ms !== undefined ? [{ value: baseline.p95Ms, label: 'baseline', color: 'var(--color-slate-400)' }] : []}
            emptyLabel="Fewer than two runs reported p95"
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader><div className="text-[12px] font-semibold text-content">Error rate per run</div></CardHeader>
        <CardBody>
          <TimeSeriesChart
            series={[{ name: 'errors', points: err, color: 'var(--color-rose-500)' }]}
            height={140}
            formatTime={fmtDay}
            formatY={(v) => fmtMetric('errorRatePct', v)}
            thresholds={baseline?.errorRatePct !== undefined ? [{ value: baseline.errorRatePct, label: 'baseline', color: 'var(--color-slate-400)' }] : []}
            emptyLabel="Fewer than two runs reported an error rate"
          />
        </CardBody>
      </Card>
    </div>
  )
}

/** The next week of scheduled runs, grouped by local day. */
export function UpcomingStrip({ schedules, nowMs }: {
  schedules: Parameters<typeof upcomingRuns>[0]
  nowMs: number
}) {
  const runs = useMemo(() => upcomingRuns(schedules, nowMs, 7 * 24 * 3600 * 1000, 40), [schedules, nowMs])
  const byDay = useMemo(() => {
    const m = new Map<string, typeof runs>()
    for (const r of runs) {
      const k = new Date(r.at).toDateString()
      m.set(k, [...(m.get(k) ?? []), r])
    }
    return [...m.entries()]
  }, [runs])
  if (!schedules.length) return null
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="text-[12px] font-semibold text-content">Coming up · next 7 days</div>
          <span className="text-[11px] text-content-subtle">in your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone})</span>
          <span className="ml-auto text-[11px] tabular-nums text-content-subtle">{runs.length}{runs.length === 40 ? '+' : ''} run{runs.length === 1 ? '' : 's'}</span>
        </div>
      </CardHeader>
      <CardBody>
        {!runs.length
          ? <p className="text-[12px] text-content-muted">Nothing is scheduled in the next week{schedules.every((s) => s.suspend) ? ' — every schedule is paused' : ''}.</p>
          : (
            <div className="flex gap-3 overflow-x-auto pb-1">
              {byDay.map(([day, list]) => (
                <div key={day} className="min-w-[9.5rem] shrink-0 rounded-lg border border-edge-subtle p-2">
                  <div className="mb-1 text-[11px] font-semibold text-content">
                    {new Date(list[0].at).toDateString() === new Date(nowMs).toDateString()
                      ? 'Today'
                      : new Date(list[0].at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                  </div>
                  <ul className="space-y-0.5">
                    {list.slice(0, 6).map((r) => (
                      <li key={`${r.schedule}-${r.at}`} className="flex gap-2 text-[11px]" title={formatAbsolute(new Date(r.at).toISOString())}>
                        <span className="font-mono tabular-nums text-content-muted">{new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        <span className="min-w-0 truncate text-content">{r.test}</span>
                      </li>
                    ))}
                    {list.length > 6 ? <li className="text-[10px] text-content-subtle">+{list.length - 6} more</li> : null}
                  </ul>
                </div>
              ))}
            </div>
          )}
      </CardBody>
    </Card>
  )
}
