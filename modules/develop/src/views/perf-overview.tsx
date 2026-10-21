import { useMemo } from 'react'
import { formatAbsolute, formatRelative } from '@adhar/utils'
import { isRunning, type TestRun } from '../data/k6.ts'
import { nextRuns } from '../data/perf-cron.ts'
import type { PerfInsights } from '../data/perf-automation.ts'
import { Tile } from './perf-bits.tsx'

/**
 * The state of performance across every test, at a glance: how much is
 * covered, how much ran, how much of it passed, what has got worse and
 * what runs next. Every number comes from the result ConfigMaps, the
 * CronJobs and the gates in git — nothing is sampled or estimated.
 */
export function PerfOverview({ insights, runs }: { insights: PerfInsights; runs: TestRun[] }) {
  const { overview: o, schedules, tests, loading } = insights
  const inFlight = runs.filter(isRunning).length

  const next = useMemo(() => {
    const now = Date.now()
    return schedules
      .filter((s) => !s.suspend)
      .map((s) => ({ s, at: nextRuns(s.cron, now, 1, s.timeZone)[0] }))
      .filter((x): x is { s: typeof x.s; at: number } => x.at !== undefined)
      .sort((a, b) => a.at - b.at)
  }, [schedules])

  const first = next[0]
  const regressed = o.regressedTests
  // Results unreadable: those figures are unknown, not zero.
  const noRecords = insights.recordsError != null
  const unread = 'results unreadable'

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Tile label="Tests" value={tests.length} hint={`${schedules.length} schedule${schedules.length === 1 ? '' : 's'}`} />
      <Tile
        label="Runs · 7 days"
        value={noRecords ? '—' : o.runs7d}
        hint={noRecords ? unread : o.runs7d ? `${o.passed7d} passed · ${o.failed7d} failed` : 'no results kept yet'}
        loading={loading}
      />
      <Tile
        label="Pass rate · 7 days"
        value={noRecords || o.passRatePct === undefined ? '—' : `${o.passRatePct.toFixed(0)}%`}
        hint={noRecords ? unread : 'Gate verdicts, not just thresholds'}
        tone={o.passRatePct === undefined ? undefined : o.passRatePct >= 90 ? 'good' : o.passRatePct < 70 ? 'bad' : undefined}
        loading={loading}
      />
      <Tile
        label="Active regressions"
        value={noRecords ? '—' : regressed.length}
        hint={noRecords ? unread : regressed.length ? regressed.slice(0, 3).join(', ') + (regressed.length > 3 ? '…' : '') : 'latest runs vs baselines'}
        tone={regressed.length ? 'bad' : undefined}
        loading={loading}
      />
      <Tile
        label="In flight"
        value={inFlight}
        hint="TestRuns on the cluster now"
        tone={inFlight ? 'busy' : undefined}
      />
      <Tile
        label="Next scheduled"
        value={first ? <span title={formatAbsolute(new Date(first.at).toISOString())}>{formatRelative(new Date(first.at).toISOString())}</span> : '—'}
        hint={first
          ? `${first.s.test}${next.length > 1 ? ` · then ${next[1].s.test} ${formatRelative(new Date(next[1].at).toISOString())}` : ''}`
          : schedules.length
          ? 'every schedule is paused'
          : 'nothing scheduled'}
      />
    </div>
  )
}
