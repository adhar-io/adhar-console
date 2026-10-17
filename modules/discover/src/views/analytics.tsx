import { useCallback, useMemo, useState } from 'react'
import { BarChart, Button, Modal, type TimeSeries, useToast } from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import {
  averageRetention,
  buildLifecycleQuery,
  buildPathsQuery,
  buildRetentionQuery,
  buildTrendsQuery,
  type ChartType,
  type DateRangeId,
  filtersToHogQL,
  hogqlString,
  intervalFor,
  parseLifecycle,
  parsePaths,
  parseRetention,
  parseTrends,
  pctChange,
  type PropertyFilter,
  rangeHours,
  TREND_MATHS,
  type TrendMath,
  type TrendSeries,
  usePHQuery,
  useHogQL,
  useSaveInsight,
  windowClause,
} from '../data/posthog.ts'
import { readParam } from '../data/discover-nav.ts'
import { Segmented, StatTile } from './discover-ui.tsx'
import { Loading, NoData, seriesColor, SERIES_MAX, VizStyle, Widget } from './viz.tsx'
import { FitTimeSeries, BreakdownPicker, Delta, EventPicker, FilterBar, fmtNum, fmtPct, OpenInPostHog, PostHogState, RangePicker } from './posthog-ui.tsx'

/**
 * Analytics — product analytics over PostHog.
 *
 * Every number on this page is a PostHog query answered live: active users
 * (DAU/WAU/MAU + stickiness) from a TrendsQuery, period totals and top
 * events/pages from HogQL (with the previous period for comparison), new vs
 * returning from a LifecycleQuery, a retention grid from a RetentionQuery and
 * page paths from a PathsQuery. The insight builder composes a TrendsQuery
 * (event × aggregation × breakdown × chart) and can save it as a PostHog
 * insight. Property filters and the date range apply page-wide.
 */
export function Analytics() {
  const [range, setRange] = useState<DateRangeId>('-7d')
  const [keyEvent, setKeyEvent] = useState<string | null>('$pageview')
  const [filters, setFilters] = useState<PropertyFilter[]>(() => {
    const c = readParam('cohort')
    return c ? [{ type: 'cohort', key: 'id', value: c }] : []
  })
  const where = filtersToHogQL(filters)
  const and = where ? ` and ${where}` : ''

  // Totals for this period and the one before it — one HogQL round-trip.
  const totals = useHogQL<{ cur_events: number; cur_users: number; prev_events: number; prev_users: number; cur_sessions: number; prev_sessions: number }>(
    ['totals', range],
    `select
  countIf(${windowClause(range)}) as cur_events,
  uniqIf(person_id, ${windowClause(range)}) as cur_users,
  uniqIf($session_id, ${windowClause(range)}) as cur_sessions,
  countIf(${windowClause(range, true)}) as prev_events,
  uniqIf(person_id, ${windowClause(range, true)}) as prev_users,
  uniqIf($session_id, ${windowClause(range, true)}) as prev_sessions
from events
where timestamp >= now() - interval ${rangeHours(range) * 2} hour${and}`,
  )

  // DAU / WAU / MAU need at least a month of context to mean anything.
  const activeRange: DateRangeId = rangeHours(range) < 24 * 30 ? '-30d' : range
  const active = usePHQuery(
    ['active', activeRange, filters],
    buildTrendsQuery((['dau', 'weekly_active', 'monthly_active'] as TrendMath[]).map((math) => ({ event: null, math, range: activeRange, interval: 'day', filters }))),
    parseTrends,
  )

  const retry = useCallback(() => {
    totals.refetch()
    active.refetch()
  }, [totals, active])

  if (totals.isError && active.isError) return <PostHogState error={totals.error} onRetry={retry} />

  const t = totals.data?.[0]
  const [dau, wau, mau] = [0, 1, 2].map((i) => active.data?.[i])
  const last = (s?: TrendSeries) => (s && s.data.length ? s.data[s.data.length - 1] : null)
  const stickiness = last(dau) != null && last(mau) ? (last(dau)! / last(mau)!) * 100 : null

  return (
    <div className="space-y-4">
      <VizStyle />
      <div className="flex flex-wrap items-center gap-2">
        <RangePicker value={range} onChange={setRange} />
        <EventPicker value={keyEvent} onChange={setKeyEvent} label="Key event (lifecycle, retention)" />
        <FilterBar filters={filters} onChange={setFilters} />
        <div className="ml-auto">
          <OpenInPostHog path="/insights" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="DAU" value={fmtNum(last(dau))} hint="unique users, latest day" />
        <StatTile label="WAU" value={fmtNum(last(wau))} hint="rolling 7 days" />
        <StatTile label="MAU" value={fmtNum(last(mau))} hint="rolling 30 days" />
        <StatTile label="Stickiness" value={fmtPct(stickiness)} hint="DAU ÷ MAU" />
        <StatTile label="Users" value={totals.isLoading ? '…' : fmtNum(t?.cur_users)} hint={t ? <Delta pct={pctChange(t.cur_users, t.prev_users)} /> : undefined} />
        <StatTile label="Events" value={totals.isLoading ? '…' : fmtNum(t?.cur_events)} hint={t ? <Delta pct={pctChange(t.cur_events, t.prev_events)} /> : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Widget className="xl:col-span-2" title="Active users" subtitle={`DAU, WAU and MAU per day · ${activeRange === range ? 'selected range' : 'last 30 days'}`}>
          {active.isLoading ? <Loading height={200} /> : active.isError ? <PostHogState compact error={active.error} onRetry={() => active.refetch()} /> : (
            <FitTimeSeries
              heightPx={200}
              series={(active.data ?? []).map((s, i) => ({ name: ['DAU', 'WAU', 'MAU'][i] ?? s.label, points: s.times.map((tm, j) => [tm, s.data[j]] as [number, number]), color: seriesColor(i) }))}
              formatY={(v) => fmtNum(v)}
              formatTime={(tm) => new Date(tm).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              emptyLabel="No events in this range"
            />
          )}
        </Widget>
        <Lifecycle event={keyEvent} range={range} filters={filters} />
      </div>

      <InsightBuilder range={range} filters={filters} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <TopEvents range={range} and={and} />
        <TopPages range={range} and={and} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Retention event={keyEvent ?? '$pageview'} />
        <Paths range={range} />
      </div>

      {t ? (
        <p className="text-[11px] text-content-subtle">
          {fmtNum(t.cur_sessions)} sessions in this period (<Delta pct={pctChange(t.cur_sessions, t.prev_sessions)} />). Filters apply to every widget except retention and paths.
        </p>
      ) : null}
    </div>
  )
}

/* ─────────── lifecycle ─────────── */

const LIFECYCLE: Array<{ id: string; label: string; hint: string }> = [
  { id: 'new', label: 'New', hint: 'first time' },
  { id: 'returning', label: 'Returning', hint: 'active last period too' },
  { id: 'resurrecting', label: 'Resurrecting', hint: 'back after a gap' },
  { id: 'dormant', label: 'Dormant', hint: 'went quiet' },
]

function Lifecycle({ event, range, filters }: { event: string | null; range: DateRangeId; filters: PropertyFilter[] }) {
  const q = buildLifecycleQuery(event, range === '-24h' ? '-7d' : range)
  if (filters.length) (q as Record<string, unknown>).properties = buildTrendsQuery({ event, math: 'total', range, filters }).properties
  const lc = usePHQuery(['lifecycle', event, range, filters], q, parseLifecycle)
  const totals = LIFECYCLE.map((l) => ({ ...l, n: Math.abs(lc.data?.[l.id]?.data.reduce((a, b) => a + b, 0) ?? 0) }))
  const active = totals.filter((x) => x.id !== 'dormant').reduce((a, b) => a + b.n, 0)
  return (
    <Widget title="New vs returning" subtitle={`${event ?? 'All events'} · users per status, summed over the range`}>
      {lc.isLoading ? <Loading height={200} /> : lc.isError ? <PostHogState compact error={lc.error} onRetry={() => lc.refetch()} /> : !lc.data || Object.keys(lc.data).length === 0 ? (
        <NoData title="No lifecycle data" hint="PostHog returned no users performing this event in the range." />
      ) : (
        <div className="space-y-3">
          {totals.map((x, i) => (
            <div key={x.id}>
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-content">{x.label} <span className="text-content-subtle">· {x.hint}</span></span>
                <span className="font-mono tabular-nums text-content">{fmtNum(x.n)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, (x.n / Math.max(1, ...totals.map((y) => y.n))) * 100)}%`, backgroundColor: seriesColor(i) }} />
              </div>
            </div>
          ))}
          <div className="text-[11px] text-content-muted">
            {active ? `${fmtPct((totals[0].n / active) * 100)} of active users were new` : 'No active users in the range'}
          </div>
        </div>
      )}
    </Widget>
  )
}

/* ─────────── insight builder ─────────── */

function InsightBuilder({ range, filters }: { range: DateRangeId; filters: PropertyFilter[] }) {
  const [event, setEvent] = useState<string | null>('$pageview')
  const [math, setMath] = useState<TrendMath>('total')
  const [mathProperty, setMathProperty] = useState('')
  const [breakdown, setBreakdown] = useState('')
  const [breakdownType, setBreakdownType] = useState<'event' | 'person'>('event')
  const [chart, setChart] = useState<ChartType>('line')
  const [compare, setCompare] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const needsProp = TREND_MATHS.find((m) => m.id === math)?.needsProperty
  const spec = { event, math, mathProperty: mathProperty || undefined, range, filters, breakdown: breakdown || undefined, breakdownType, compare }
  const query = needsProp && !mathProperty ? null : buildTrendsQuery(spec)
  const q = usePHQuery(['builder'], query, parseTrends)

  const series = q.data ?? []
  const current = series.filter((s) => s.compare !== 'previous')
  const previous = series.filter((s) => s.compare === 'previous')
  const label = (s: TrendSeries) => s.breakdown ?? (event ?? 'All events')
  const fmtTime = (tm: number) => intervalFor(range) === 'hour' ? new Date(tm).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(tm).toLocaleDateString([], { month: 'short', day: 'numeric' })

  const ts: TimeSeries[] = useMemo(() => {
    const out: TimeSeries[] = current.slice(0, SERIES_MAX).map((s, i) => ({ name: label(s), points: s.times.map((tm, j) => [tm, s.data[j]] as [number, number]), color: seriesColor(i) }))
    // Previous period drawn dashed on the current period's time axis.
    previous.slice(0, Math.max(0, SERIES_MAX - out.length)).forEach((p, i) => {
      const cur = current.find((c) => c.breakdown === p.breakdown) ?? current[i]
      if (!cur) return
      out.push({ name: `${label(p)} (previous)`, points: cur.times.map((tm, j) => [tm, p.data[j] ?? NaN] as [number, number]), color: seriesColor(current.indexOf(cur)), dashed: true })
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data])

  return (
    <Widget
      title="Insight builder"
      subtitle="Trends over any event — aggregation, breakdown, chart and period comparison"
      actions={<Button size="xs" disabled={!query || !q.data} onClick={() => setSaveOpen(true)}>Save as insight</Button>}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <EventPicker value={event} onChange={setEvent} allowAll />
        <select aria-label="Aggregation" value={math} onChange={(e) => setMath(e.target.value as TrendMath)} className="h-8 rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content">
          {TREND_MATHS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {needsProp ? (
          <input value={mathProperty} onChange={(e) => setMathProperty(e.target.value)} placeholder="numeric property, e.g. amount" className="h-8 w-48 rounded-md border border-edge-default bg-surface-raised px-2 text-[12px] text-content" />
        ) : null}
        <BreakdownPicker value={breakdown} type={breakdownType} onChange={(v, tp) => { setBreakdown(v); setBreakdownType(tp) }} />
        <label className="inline-flex items-center gap-1.5 text-[12px] text-content-muted">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="h-3 w-3" /> Compare to previous period
        </label>
        <div className="ml-auto">
          <Segmented<ChartType>
            ariaLabel="Chart type"
            size="xs"
            value={chart}
            onChange={setChart}
            options={[{ id: 'line', label: 'Line' }, { id: 'bar', label: 'Bar' }, { id: 'number', label: 'Number' }, { id: 'table', label: 'Table' }]}
          />
        </div>
      </div>
      {!query ? <NoData title="Pick a numeric property to aggregate" height={200} /> : q.isLoading ? <Loading height={220} /> : q.isError ? <PostHogState compact error={q.error} onRetry={() => q.refetch()} /> : current.length === 0 || current.every((s) => s.count === 0) ? (
        <NoData title="No matching events in this range" hint="Try a wider range, another event, or fewer filters." height={200} />
      ) : chart === 'line' ? (
        <div className={cn('grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]', q.isFetching && 'opacity-60')}>
          <div className="min-w-0">
            <FitTimeSeries heightPx={220} series={ts} formatY={(v) => fmtNum(v)} formatTime={fmtTime} />
            {current.length > SERIES_MAX ? <p className="mt-1 text-[11px] text-content-subtle">Showing the top {SERIES_MAX} of {current.length} breakdown values.</p> : null}
          </div>
          {/* Totals beside the chart: the number each line adds up to. */}
          <ul className="space-y-1.5 self-start text-[12px]">
            {current.slice(0, SERIES_MAX).map((s, i) => {
              const p = previous.find((x) => x.breakdown === s.breakdown)
              return (
                <li key={label(s)} className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: seriesColor(i) }} />
                  <span className="min-w-0 flex-1 truncate text-content" title={label(s)}>{label(s)}</span>
                  <span className="font-mono tabular-nums text-content">{fmtNum(s.count)}</span>
                  {compare ? <Delta pct={p ? pctChange(s.count, p.count) : null} /> : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : chart === 'bar' ? (
        <BarChart bars={current.slice(0, 15).map((s, i) => ({ label: label(s), value: s.count, color: seriesColor(i) }))} height={Math.min(28 * Math.min(current.length, 15) + 20, 420)} />
      ) : chart === 'number' ? (
        <div className="flex flex-wrap items-end gap-8 py-4">
          <div>
            <div className="text-4xl font-semibold tabular-nums text-content">{fmtNum(current.reduce((a, b) => a + b.count, 0))}</div>
            <div className="text-[11px] text-content-subtle">{TREND_MATHS.find((m) => m.id === math)?.label} · {event ?? 'All events'}</div>
          </div>
          {compare && previous.length ? (
            <Delta pct={pctChange(current.reduce((a, b) => a + b.count, 0), previous.reduce((a, b) => a + b.count, 0))} />
          ) : null}
        </div>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-edge-subtle text-left text-[11px] text-content-subtle">
              <th className="py-1.5 pr-2 font-medium">{breakdown || 'Series'}</th>
              <th className="py-1.5 pr-2 text-right font-medium">Total</th>
              {compare ? <th className="py-1.5 text-right font-medium">Previous</th> : null}
            </tr>
          </thead>
          <tbody>
            {current.map((s) => {
              const p = previous.find((x) => x.breakdown === s.breakdown)
              return (
                <tr key={label(s)} className="border-b border-edge-subtle/60">
                  <td className="py-1.5 pr-2 text-content">{label(s)}</td>
                  <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-content">{fmtNum(s.count)}</td>
                  {compare ? <td className="py-1.5 text-right font-mono tabular-nums text-content-muted">{p ? fmtNum(p.count) : '—'} {p ? <Delta pct={pctChange(s.count, p.count)} /> : null}</td> : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <SaveInsightModal open={saveOpen} onClose={() => setSaveOpen(false)} source={query} defaultName={`${TREND_MATHS.find((m) => m.id === math)?.label} of ${event ?? 'all events'}${breakdown ? ` by ${breakdown}` : ''}`} />
    </Widget>
  )
}

function SaveInsightModal({ open, onClose, source, defaultName }: { open: boolean; onClose(): void; source: Record<string, unknown> | null; defaultName: string }) {
  const [name, setName] = useState('')
  const save = useSaveInsight()
  const toast = useToast()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save insight to PostHog"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            variant="primary"
            loading={save.isPending}
            disabled={!source}
            onClick={() =>
              save.mutate(
                { name: name.trim() || defaultName, source: source! },
                {
                  onSuccess: () => {
                    toast.success('Insight saved in PostHog')
                    onClose()
                  },
                  onError: (e) => toast.error('PostHog did not save the insight', { description: (e as Error).message }),
                },
              )}
          >
            Save
          </Button>
        </div>
      }
    >
      <label className="block text-xs text-content-muted">
        Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} className="mt-1 h-9 w-full rounded-md border border-edge-default bg-surface-raised px-2 text-sm text-content" />
      </label>
    </Modal>
  )
}

/* ─────────── top events / pages ─────────── */

function TopEvents({ range, and }: { range: DateRangeId; and: string }) {
  const q = useHogQL<{ event: string; cur: number; prev: number; users: number }>(
    ['top-events', range, and],
    `select event, countIf(${windowClause(range)}) as cur, countIf(${windowClause(range, true)}) as prev, uniqIf(person_id, ${windowClause(range)}) as users
from events
where timestamp >= now() - interval ${rangeHours(range) * 2} hour${and}
group by event
order by cur desc
limit 12`,
  )
  return (
    <Widget title="Top events" subtitle="Count and unique users, vs the previous period">
      {q.isLoading ? <Loading /> : q.isError ? <PostHogState compact error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length || q.data.every((r) => !r.cur) ? (
        <NoData title="No events in this range" />
      ) : (
        <RankTable
          rows={q.data.filter((r) => r.cur > 0).map((r) => ({ key: r.event, label: r.event, value: r.cur, users: r.users, delta: pctChange(r.cur, r.prev) }))}
          mono
        />
      )}
    </Widget>
  )
}

function TopPages({ range, and }: { range: DateRangeId; and: string }) {
  const q = useHogQL<{ path: string; cur: number; prev: number; users: number }>(
    ['top-pages', range, and],
    `select coalesce(properties.$pathname, properties.$current_url) as path, countIf(${windowClause(range)}) as cur, countIf(${windowClause(range, true)}) as prev, uniqIf(person_id, ${windowClause(range)}) as users
from events
where event = ${hogqlString('$pageview')} and timestamp >= now() - interval ${rangeHours(range) * 2} hour${and}
group by path
order by cur desc
limit 12`,
  )
  return (
    <Widget title="Top pages" subtitle="$pageview by path, vs the previous period">
      {q.isLoading ? <Loading /> : q.isError ? <PostHogState compact error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length || q.data.every((r) => !r.cur) ? (
        <NoData title="No pageviews in this range" hint="Pages appear once the PostHog snippet captures $pageview." />
      ) : (
        <RankTable rows={q.data.filter((r) => r.cur > 0).map((r) => ({ key: r.path ?? '(unknown)', label: r.path ?? '(unknown)', value: r.cur, users: r.users, delta: pctChange(r.cur, r.prev) }))} mono />
      )}
    </Widget>
  )
}

function RankTable({ rows, mono = false }: { rows: Array<{ key: string; label: string; value: number; users: number; delta: number | null }>; mono?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <table className="w-full table-fixed text-[12px]">
      <thead>
        <tr className="text-left text-[10px] uppercase tracking-wider text-content-subtle">
          <th className="pb-1.5 font-medium">Name</th>
          <th className="w-20 pb-1.5 text-right font-medium">Count</th>
          <th className="w-16 pb-1.5 text-right font-medium">Users</th>
          <th className="w-24 pb-1.5 text-right font-medium">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-edge-subtle/60">
            <td className="py-1.5 pr-2">
              <div className={cn('truncate text-content', mono && 'font-mono text-[11px]')} title={r.label}>{r.label}</div>
              <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-surface-sunken">
                <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, backgroundColor: seriesColor(0) }} />
              </div>
            </td>
            <td className="py-1.5 text-right font-mono tabular-nums text-content">{fmtNum(r.value)}</td>
            <td className="py-1.5 text-right font-mono tabular-nums text-content-muted">{fmtNum(r.users)}</td>
            <td className="py-1.5 text-right"><Delta pct={r.delta} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* ─────────── retention + paths ─────────── */

function Retention({ event }: { event: string }) {
  const [period, setPeriod] = useState<'Day' | 'Week'>('Week')
  const q = usePHQuery(['retention', event, period], buildRetentionQuery({ event, period, intervals: period === 'Week' ? 8 : 14, firstTime: false }), parseRetention)
  const avg = useMemo(() => averageRetention(q.data ?? []), [q.data])
  return (
    <Widget
      title="Retention"
      subtitle={`People doing ${event} who came back, by ${period.toLowerCase()} cohort`}
      actions={<Segmented<'Day' | 'Week'> size="xs" ariaLabel="Retention period" value={period} onChange={setPeriod} options={[{ id: 'Day', label: 'Daily' }, { id: 'Week', label: 'Weekly' }]} />}
    >
      {q.isLoading ? <Loading /> : q.isError ? <PostHogState compact error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length || q.data.every((c) => c.size === 0) ? (
        <NoData title="No retention cohorts yet" hint="Cohorts form once people perform the key event." />
      ) : <RetentionGrid cohorts={q.data} avg={avg} prefix={period === 'Week' ? 'W' : 'D'} />}
    </Widget>
  )
}

export function RetentionGrid({ cohorts, avg, prefix }: { cohorts: ReturnType<typeof parseRetention>; avg: number[]; prefix: string }) {
  const len = Math.max(...cohorts.map((c) => c.pct.length))
  const cell = (v: number | undefined, i: number) => {
    if (v === undefined) return <td key={i} className="px-1.5 py-1" />
    const t = Math.max(0, Math.min(1, v / 100))
    return (
      <td key={i} className="px-1.5 py-1 text-right tabular-nums" style={{ backgroundColor: `color-mix(in oklab, var(--viz-1) ${Math.round(8 + t * 62)}%, transparent)` }}>
        <span className={t > 0.55 ? 'text-white' : 'text-content'}>{v.toFixed(0)}%</span>
      </td>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[10px]">
        <thead>
          <tr className="text-content-subtle">
            <th className="px-1.5 py-1 text-left font-medium">Cohort</th>
            <th className="px-1.5 py-1 text-right font-medium">People</th>
            {Array.from({ length: len }).map((_, i) => <th key={i} className="px-1.5 py-1 text-right font-medium">{prefix}{i}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-edge-subtle font-semibold">
            <td className="px-1.5 py-1 text-content">Average</td>
            <td className="px-1.5 py-1 text-right text-content-muted">{fmtNum(cohorts.reduce((a, b) => a + b.size, 0))}</td>
            {avg.map((v, i) => cell(v, i))}
          </tr>
          {cohorts.map((c) => (
            <tr key={c.date || c.label}>
              <td className="whitespace-nowrap px-1.5 py-1 text-content">{c.date ? new Date(c.date).toLocaleDateString([], { month: 'short', day: 'numeric' }) : c.label}</td>
              <td className="px-1.5 py-1 text-right text-content-muted">{fmtNum(c.size)}</td>
              {Array.from({ length: len }).map((_, i) => cell(c.size > 0 ? c.pct[i] : undefined, i))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Paths({ range }: { range: DateRangeId }) {
  const q = usePHQuery(['paths', range], buildPathsQuery(range === '-24h' ? '-7d' : range), parsePaths)
  const rows = (q.data ?? []).slice(0, 12)
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <Widget title="Top paths" subtitle="Most common page-to-page moves ($pageview)">
      {q.isLoading ? <Loading /> : q.isError ? <PostHogState compact error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? (
        <NoData title="No paths yet" hint="Paths appear once people view at least two pages in a session." />
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r, i) => (
            <li key={`${r.source}-${r.target}-${i}`} className="text-[11px]">
              <div className="flex items-center gap-1.5">
                <span className="w-6 shrink-0 text-[10px] text-content-subtle">#{r.step}</span>
                <span className="min-w-0 truncate font-mono text-content" title={r.from}>{r.from}</span>
                <span className="shrink-0 text-content-subtle">→</span>
                <span className="min-w-0 truncate font-mono text-content" title={r.to}>{r.to}</span>
                <span className="ml-auto shrink-0 font-mono tabular-nums text-content-muted">{fmtNum(r.value)}</span>
              </div>
              <div className="ml-7 mt-0.5 h-1 overflow-hidden rounded-full bg-surface-sunken">
                <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, backgroundColor: seriesColor(1) }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  )
}
