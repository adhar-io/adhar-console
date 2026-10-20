import { useMemo, useState } from 'react'
import {
  Button,
  type Column,
  DataTable,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@adhar/shell-ui'
import { ColumnChart, LineChart, Meter, RankBars, STATUS_COLOR, useSeriesColor } from '../components/viz.tsx'
import { copyLink, DLink, Panel, ScopeRow, SourceNote, StatusText, Tile, type Tone } from '../components/ui.tsx'
import {
  type Budget,
  type BudgetEval,
  type BudgetScope,
  type CostRow,
  daysInMonth,
  evaluateBudget,
  forecastMonth,
  formatBytes,
  formatCores,
  formatDeltaPct,
  formatUsd,
  monthStart,
  movers,
  prevMonthStart,
  prevSamePeriod,
  type Recommendation,
  regroup,
  rightsize,
  scaleForecast,
} from '../data/cost-model.ts'
import {
  aggregateParam,
  DIMENSIONS,
  type DimensionId,
  dimensionOf,
  envOfNamespace,
  PLATFORM,
  projectOfNamespace,
  scopeDays,
  SPEND_RANGES,
  spendWindow,
  useAllocation,
  useBudgets,
  useDailySpend,
  useDeleteBudget,
  useDeleteSpendView,
  useRightsizeUsage,
  useSaveBudget,
  useSaveSpendView,
  useSpendViews,
} from '../data/cost.ts'
import { downloadCsv, toCsv } from '../data/csv.ts'
import { decideHref, PARAM_KEYS, useDecideParams, useSetDecideParams } from '../data/params.ts'
import { type DecideScope, useDecideScope } from '../data/scope.ts'

/**
 * Spend — an OpenCost cost explorer. Allocation by namespace / project / team
 * / environment / workload / label, idle and efficiency, the month's daily
 * trend with a forecast, budgets (doc store `decide.budget`), movers against
 * the previous period, and rightsizing from Prometheus usage. All state lives
 * in the URL, so a view is shared by sharing its link (or saved by name).
 */

const DAY = 86_400_000
const fmtDay = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })

function errText(e: unknown): string {
  return (e as Error)?.message ?? 'unknown error'
}

/** Namespace-level rows → the requested dimension (scope-filtered). */
function useDimRows(rows: CostRow[] | undefined, dim: DimensionId, scope: DecideScope): CostRow[] {
  return useMemo(() => {
    if (!rows) return []
    const nsOf = (r: CostRow) => (dim === 'workload' ? r.namespace ?? r.key.split('/')[0] : r.key)
    const kept = dim === 'label' || !scope.inScope ? rows : rows.filter((r) => {
      const p = projectOfNamespace(nsOf(r))
      return p !== PLATFORM && scope.matches(p)
    })
    switch (dim) {
      case 'project':
        return regroup(kept, (r) => [projectOfNamespace(r.key)])
      case 'team':
        return regroup(kept, (r) => {
          const p = projectOfNamespace(r.key)
          if (p === PLATFORM) return [PLATFORM]
          const t = scope.teamsOf(p)
          return t.length ? t : ['(no team)']
        })
      case 'env':
        return regroup(kept, (r) => [envOfNamespace(r.key)])
      default:
        return kept
    }
  }, [rows, dim, scope])
}

export function SpendSummary() {
  const scope = useDecideScope()
  const params = useDecideParams()
  const set = useSetDecideParams()
  const toast = useToast()
  const color = useSeriesColor()
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000
  const win = spendWindow(params.range, now)
  const dim = dimensionOf(params.dim).id
  const labelKey = params.label ?? ''
  const agg = aggregateParam(dim, labelKey)

  const ms = monthStart(now)
  const dailyStart = Math.min(prevMonthStart(now), win.start)
  const daily = useDailySpend(dailyStart, now)
  const current = useAllocation(agg, win.start, win.end)
  const previous = useAllocation(agg, win.prevStart, win.prevEnd)
  const mtdNs = useAllocation('namespace', ms, now)
  const budgets = useBudgets()
  const usage = useRightsizeUsage(true)

  const keep = scope.inScope ? (ns: string) => {
    const p = projectOfNamespace(ns)
    return p !== PLATFORM && scope.matches(p)
  } : null
  const days = useMemo(() => scopeDays(daily.data ?? [], keep), [daily.data, scope])
  const allDays = daily.data ?? []
  const forecast = useMemo(() => forecastMonth(days, now), [days, now])
  const clusterForecast = useMemo(() => forecastMonth(allDays, now), [allDays, now])
  const prev = useMemo(() => prevSamePeriod(days, now), [days, now])
  const rows = useDimRows(current.data?.rows, dim, scope)
  const prevRows = useDimRows(previous.data?.rows, dim, scope)
  const rangeTotal = rows.reduce((s, r) => s + r.total, 0)
  const idle = scope.inScope || dim === 'label' ? null : current.data?.idle ?? null
  const eff = weightedEfficiency(rows)

  const recs = useMemo(() => {
    const all = rightsize(usage.data ?? [], mtdNs.data?.rates ?? { cpu: null, ramGiB: null })
    return scope.inScope ? all.filter((r) => keep?.(r.namespace)) : all
  }, [usage.data, mtdNs.data, scope])

  const budgetRows = useMemo(() => evaluateBudgets(budgets.data ?? [], mtdNs.data?.rows ?? [], clusterForecast, scope), [budgets.data, mtdNs.data, clusterForecast, scope])
  const alerts = budgetRows.filter((b) => b.eval.status === 'over' || b.eval.status === 'forecast-over' || b.eval.status === 'warning')

  const exportCsv = () => {
    if (!rows.length) {
      toast.info('Nothing to export for this view')
      return
    }
    const header = ['key', 'total_usd', 'share_pct', 'cpu_usd', 'ram_usd', 'gpu_usd', 'storage_usd', 'network_usd', 'other_usd', 'cpu_request_cores', 'cpu_used_cores', 'ram_request_bytes', 'ram_used_bytes', 'efficiency_pct', 'previous_usd']
    const prevBy = new Map(prevRows.map((r) => [r.key, r.total]))
    const body = rows.map((r) => [
      r.key,
      r.total,
      rangeTotal ? (r.total / rangeTotal) * 100 : 0,
      r.components.cpu,
      r.components.ram,
      r.components.gpu,
      r.components.storage,
      r.components.network,
      r.components.other,
      r.cpuReq,
      r.cpuUsed,
      r.ramReq,
      r.ramUsed,
      r.efficiency == null ? null : r.efficiency * 100,
      prevBy.get(r.key) ?? 0,
    ])
    downloadCsv(`spend-${dim}-${win.id}-${scope.project || scope.team || 'all'}`, toCsv(header, body))
    toast.success(`Exported ${rows.length} rows`)
  }

  const openCostDown = current.error && !current.data
  const notFound = (current.error as { status?: number } | null)?.status === 404 || (current.error as { status?: number } | null)?.status === 503

  return (
    <div className="space-y-6">
      <PageHeader
        title="Spend"
        actions={
          <div className="flex flex-wrap gap-2">
            <SavedViews />
            <Button size="sm" onClick={() => copyLink(toast)}>Copy link</Button>
            <Button size="sm" variant="primary" onClick={exportCsv}>Export CSV</Button>
          </div>
        }
      />

      <ScopeRow scope={scope} ranges={SPEND_RANGES} range={win.id} onRange={(id) => set({ range: id === 'mtd' ? '' : id })}>
        <Select
          aria-label="Group cost by"
          value={dim}
          onChange={(e) => set({ dim: e.target.value === 'project' ? '' : e.target.value })}
          options={DIMENSIONS.map((d) => ({ value: d.id, label: `By ${d.label.toLowerCase()}` }))}
          wrapperClassName="w-full sm:w-44"
          className="h-8 text-xs"
        />
        {dim === 'label'
          ? (
            <Input
              aria-label="Label key"
              placeholder="app.kubernetes.io/name"
              defaultValue={labelKey}
              onKeyDown={(e) => {
                if (e.key === 'Enter') set({ label: (e.target as HTMLInputElement).value.trim() })
              }}
              onBlur={(e) => set({ label: e.target.value.trim() })}
              className="h-8 w-full text-xs sm:w-56"
            />
          )
          : null}
      </ScopeRow>

      {openCostDown
        ? (
          <SourceNote tone="warn">
            OpenCost is {notFound ? 'not configured' : 'unreachable'} ({errText(current.error)}). Spend reads{' '}
            <code>/api/svc/opencost/allocation/compute</code>; set <code>OPENCOST_URL</code> on the console (in-cluster:
            <code> http://opencost.adhar-system.svc:9003</code>) to enable it. No figures are shown until it answers.
          </SourceNote>
        )
        : null}

      {alerts.length ? <BudgetAlerts rows={alerts} /> : null}

      <Kpis
        loading={daily.isLoading || current.isLoading}
        mtd={forecast?.mtd ?? sumMonth(days, now)}
        prev={prev}
        forecast={forecast}
        idle={idle}
        idleBase={idle == null ? null : rangeTotal + idle}
        eff={eff}
        rangeLabel={win.label}
        rangeTotal={current.data ? rangeTotal : null}
        scoped={!!scope.inScope}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="This month vs last month" sub="Cumulative spend by day of month; dashed line is the forecast to month end.">
          <MonthChart days={days} now={now} forecast={forecast} loading={daily.isLoading} />
        </Panel>
        <Panel title={`Daily spend · ${win.label.toLowerCase()}`} sub={idle == null ? 'In-scope namespaces.' : 'Allocated to workloads, plus idle (paid-for capacity nobody requested).'}>
          <ColumnChart
            height={200}
            formatY={(v) => formatUsd(v)}
            series={[
              { name: 'Allocated', points: days.filter((d) => d.day >= win.start && d.day < win.end).map((d) => [d.day, d.total - d.idle]), color: color(0) },
              ...(idle == null ? [] : [{ name: 'Idle', points: days.filter((d) => d.day >= win.start && d.day < win.end).map((d) => [d.day, d.idle] as [number, number]), color: color(3) }]),
            ]}
            emptyLabel={daily.error ? 'OpenCost did not return daily data.' : 'No cost recorded in this range.'}
          />
        </Panel>
      </div>

      <Panel
        title={`Allocation by ${dimensionOf(dim).label.toLowerCase()}`}
        sub={dim === 'label'
          ? `OpenCost label aggregation (${labelKey || 'app.kubernetes.io/name'}) is cluster-wide; the project filter does not apply.`
          : `${win.label}. Efficiency = share of CPU and memory spend backed by actual use.`}
      >
        {current.isLoading ? <Skeleton height={220} /> : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <RankBars
              rows={rows.slice(0, 8).map((r) => ({
                key: r.key,
                label: dim === 'project' && r.key !== PLATFORM ? <span className="text-brand-700 dark:text-brand-300">{r.key}</span> : r.key,
                value: r.total,
                sub: rangeTotal ? `${((r.total / rangeTotal) * 100).toFixed(1)}% of ${formatUsd(rangeTotal)}` : undefined,
              }))}
              format={(v) => formatUsd(v, { precise: true })}
              color={color(0)}
              empty="No allocation in this range."
              onSelect={dim === 'project' ? (k) => k !== PLATFORM && set({ project: k }) : undefined}
            />
            <AllocationTable rows={rows} prevRows={prevRows} total={rangeTotal} />
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Top movers"
          sub={`${win.label} vs ${win.id === 'mtd' ? 'the same days last month' : 'the period before'}, by ${dimensionOf(dim).label.toLowerCase()}.`}
        >
          <Movers rows={rows} prevRows={prevRows} loading={previous.isLoading} />
        </Panel>
        <Panel title="Budgets" sub="Monthly budgets stored for this organization. Status uses month-to-date spend and the forecast." actions={<BudgetEditorButton scope={scope} />}>
          <Budgets rows={budgetRows} error={budgets.error} loading={budgets.isLoading} scope={scope} />
        </Panel>
      </div>

      <Panel
        title="Rightsizing"
        sub="Containers whose requests are far from 7-day observed use (CPU p95, memory peak). Savings at the cluster's blended OpenCost rates."
      >
        <Rightsizing recs={recs} error={usage.error} loading={usage.isLoading} />
      </Panel>

      <p className="text-xs text-content-subtle">
        Source: OpenCost allocation API (<code>/allocation/compute</code>) through the console; usage from Prometheus. Platform namespaces
        (no <code>&lt;project&gt;-&lt;env&gt;</code> pattern) roll up as {PLATFORM}. Idle is shown only for the whole cluster.{' '}
        <DLink href={decideHref('dashboard')} className="text-brand-700 hover:underline dark:text-brand-300">Back to overview</DLink>
      </p>
    </div>
  )
}

function sumMonth(days: Array<{ day: number; total: number }>, now: number): number | null {
  const ms = monthStart(now)
  const m = days.filter((d) => d.day >= ms)
  return m.length ? m.reduce((s, d) => s + d.total, 0) : null
}

function weightedEfficiency(rows: CostRow[]): number | null {
  let w = 0
  let e = 0
  for (const r of rows) {
    if (r.efficiency == null) continue
    const weight = r.components.cpu + r.components.ram
    w += weight
    e += r.efficiency * weight
  }
  return w > 0 ? e / w : null
}

/* ─────────── KPIs ─────────── */

function Kpis({ loading, mtd, prev, forecast, idle, idleBase, eff, rangeLabel, rangeTotal, scoped }: {
  loading: boolean
  mtd: number | null
  prev: { total: number; full: number; covered: boolean }
  forecast: ReturnType<typeof forecastMonth>
  idle: number | null
  idleBase: number | null
  eff: number | null
  rangeLabel: string
  rangeTotal: number | null
  scoped: boolean
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={104} className="rounded-xl" />)}
      </div>
    )
  }
  const delta = mtd != null && prev.covered && prev.total > 0 ? (mtd - prev.total) / prev.total : null
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Tile
        label="Month to date"
        value={formatUsd(mtd)}
        sub={prev.covered ? `${formatUsd(prev.total)} same days last month` : 'no data for last month'}
        footer={delta == null ? null : <StatusText tone={delta > 0.1 ? 'warn' : 'neutral'}>{formatDeltaPct(delta)} vs last month</StatusText>}
      />
      <Tile
        label="Forecast · month end"
        value={formatUsd(forecast?.forecast)}
        sub={forecast ? `${formatUsd(forecast.low)}–${formatUsd(forecast.high)} · ${formatUsd(forecast.runRate, { precise: true })}/day over ${forecast.basisDays}d` : 'needs one complete day this month'}
      />
      <Tile label="Last month" value={prev.covered ? formatUsd(prev.full) : '—'} sub={prev.covered ? 'full month' : 'OpenCost has no data for it'} />
      <Tile
        label="Idle capacity"
        value={idle == null || !idleBase ? '—' : `${((idle / idleBase) * 100).toFixed(0)}%`}
        sub={idle == null ? (scoped ? 'cluster-wide only' : 'not reported') : `${formatUsd(idle)} of ${formatUsd(idleBase)} · ${rangeLabel.toLowerCase()}`}
      />
      <Tile
        label="Efficiency"
        value={eff == null ? '—' : `${Math.round(eff * 100)}%`}
        sub={rangeTotal == null ? 'no allocation data' : `of CPU + memory spend used · ${formatUsd(rangeTotal)} allocated`}
        footer={eff == null ? null : <StatusText tone={eff >= 0.6 ? 'good' : eff >= 0.35 ? 'warn' : 'bad'}>{eff >= 0.6 ? 'Healthy' : eff >= 0.35 ? 'Over-provisioned' : 'Mostly unused'}</StatusText>}
      />
    </div>
  )
}

/* ─────────── month chart ─────────── */

function MonthChart({ days, now, forecast, loading }: { days: Array<{ day: number; total: number }>; now: number; forecast: ReturnType<typeof forecastMonth>; loading: boolean }) {
  const color = useSeriesColor()
  const ms = monthStart(now)
  const ps = prevMonthStart(now)
  const dim = daysInMonth(now)
  const cum = (from: number, to: number, shift: number) => {
    let acc = 0
    return days.filter((d) => d.day >= from && d.day < to).map((d) => {
      acc += d.total
      return [d.day + shift + DAY, acc] as [number, number]
    })
  }
  const thisMonth = cum(ms, ms + dim * DAY, 0)
  const lastMonth = cum(ps, ms, ms - ps).filter(([t]) => t <= ms + dim * DAY)
  const end = ms + dim * DAY
  const fc: Array<[number, number]> = forecast && thisMonth.length ? [thisMonth[thisMonth.length - 1], [end, forecast.forecast]] : []
  if (loading) return <Skeleton height={220} />
  return (
    <LineChart
      height={200}
      domain={[ms, end]}
      formatY={(v) => formatUsd(v)}
      formatX={fmtDay}
      series={[
        { name: 'This month', points: thisMonth, color: color(0) },
        { name: 'Last month (same day)', points: lastMonth, color: color(1) },
        ...(fc.length ? [{ name: 'Forecast', points: fc, color: color(0), dashed: true }] : []),
      ]}
      emptyLabel="No daily cost from OpenCost yet."
    />
  )
}

/* ─────────── allocation table ─────────── */

function AllocationTable({ rows, prevRows, total }: { rows: CostRow[]; prevRows: CostRow[]; total: number }) {
  const prev = new Map(prevRows.map((r) => [r.key, r.total]))
  const columns: Column<CostRow>[] = [
    { key: 'key', header: 'Name', pinned: true, value: (r) => r.key, cell: (r) => <span className="font-medium text-content">{r.key}</span> },
    { key: 'total', header: 'Cost', numeric: true, value: (r) => r.total, cell: (r) => formatUsd(r.total, { precise: true }) },
    { key: 'share', header: 'Share', numeric: true, value: (r) => r.total, cell: (r) => (total ? `${((r.total / total) * 100).toFixed(1)}%` : '—') },
    {
      key: 'delta',
      header: 'vs prior',
      align: 'right',
      value: (r) => r.total - (prev.get(r.key) ?? 0),
      cell: (r) => {
        const p = prev.get(r.key) ?? 0
        return <span className="tabular-nums text-content-muted">{formatDeltaPct(p > 0 ? (r.total - p) / p : null)}</span>
      },
    },
    { key: 'cpu', header: 'CPU', numeric: true, value: (r) => r.components.cpu, cell: (r) => formatUsd(r.components.cpu, { precise: true }) },
    { key: 'ram', header: 'Memory', numeric: true, value: (r) => r.components.ram, cell: (r) => formatUsd(r.components.ram, { precise: true }) },
    { key: 'pv', header: 'Storage', numeric: true, value: (r) => r.components.storage, cell: (r) => formatUsd(r.components.storage, { precise: true }), defaultHidden: true },
    { key: 'net', header: 'Network', numeric: true, value: (r) => r.components.network, cell: (r) => formatUsd(r.components.network, { precise: true }), defaultHidden: true },
    { key: 'cpuReq', header: 'CPU req / used', align: 'right', value: (r) => r.cpuReq, cell: (r) => `${formatCores(r.cpuReq)} / ${formatCores(r.cpuUsed)}`, defaultHidden: true },
    { key: 'ramReq', header: 'Mem req / used', align: 'right', value: (r) => r.ramReq, cell: (r) => `${formatBytes(r.ramReq)} / ${formatBytes(r.ramUsed)}`, defaultHidden: true },
    {
      key: 'eff',
      header: 'Efficiency',
      align: 'right',
      value: (r) => r.efficiency ?? -1,
      cell: (r) => (r.efficiency == null ? '—' : `${Math.round(r.efficiency * 100)}%`),
    },
  ]
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      dense
      tableId="decide-spend-allocation"
      features={{ search: true, columns: true }}
      empty={<p className="py-6 text-center text-xs text-content-subtle">No allocation in this range.</p>}
    />
  )
}

/* ─────────── movers ─────────── */

function Movers({ rows, prevRows, loading }: { rows: CostRow[]; prevRows: CostRow[]; loading: boolean }) {
  if (loading) return <Skeleton height={160} />
  if (!prevRows.length) return <p className="py-4 text-center text-xs text-content-subtle">OpenCost has no data for the previous period, so there is nothing to compare.</p>
  const m = movers(rows, prevRows, 10)
  if (!m.length) return <p className="py-4 text-center text-xs text-content-subtle">Nothing moved by more than a cent.</p>
  return (
    <ul className="divide-y divide-edge-default">
      {m.map((x) => (
        <li key={x.key} className="flex items-center justify-between gap-3 py-2 text-sm">
          <span className="min-w-0 truncate text-content">{x.key}</span>
          <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
            <span className="text-xs text-content-subtle">{formatUsd(x.previous, { precise: true })} → {formatUsd(x.current, { precise: true })}</span>
            <span className={x.delta > 0 ? 'font-medium text-content' : 'text-content-muted'}>
              <span aria-hidden>{x.delta > 0 ? '↑' : '↓'}</span> {formatUsd(Math.abs(x.delta), { precise: true })}
            </span>
            <span className="w-12 text-right text-xs text-content-muted">{formatDeltaPct(x.pct)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/* ─────────── budgets ─────────── */

interface BudgetRow {
  budget: Budget
  eval: BudgetEval
}

function evaluateBudgets(budgets: Budget[], nsRows: CostRow[], clusterForecast: ReturnType<typeof forecastMonth>, scope: DecideScope): BudgetRow[] {
  const has = nsRows.length > 0
  return budgets.map((b) => {
    let mtd: number | null
    if (b.scope === 'total') {
      mtd = clusterForecast?.mtd ?? (has ? nsRows.reduce((s, r) => s + r.total, 0) : null)
    } else {
      const match = nsRows.filter((r) => {
        if (b.scope === 'namespace') return r.key === b.target
        const p = projectOfNamespace(r.key)
        if (b.scope === 'project') return p === b.target
        return scope.teamsOf(p).includes(b.target)
      })
      mtd = has ? match.reduce((s, r) => s + r.total, 0) : null
    }
    const forecast = b.scope === 'total' ? clusterForecast?.forecast ?? null : mtd == null ? null : scaleForecast(mtd, clusterForecast)
    return { budget: b, eval: evaluateBudget(b, mtd, forecast) }
  }).sort((a, b) => STATUS_ORDER[a.eval.status] - STATUS_ORDER[b.eval.status])
}

const STATUS_ORDER: Record<BudgetEval['status'], number> = { over: 0, 'forecast-over': 1, warning: 2, ok: 3, 'no-data': 4 }

function budgetTone(s: BudgetEval['status']): Tone {
  return s === 'over' ? 'bad' : s === 'forecast-over' || s === 'warning' ? 'warn' : s === 'ok' ? 'good' : 'neutral'
}

const STATUS_LABEL: Record<BudgetEval['status'], string> = {
  over: 'Over budget',
  'forecast-over': 'Forecast over',
  warning: 'Near limit',
  ok: 'On track',
  'no-data': 'No data',
}

function budgetTarget(b: Budget): string {
  return b.scope === 'total' ? 'Whole cluster' : `${b.scope} ${b.target}`
}

function BudgetAlerts({ rows }: { rows: BudgetRow[] }) {
  return (
    <div className="rounded-xl border border-amber-400/50 bg-surface-raised px-4 py-3">
      <ul className="space-y-1.5">
        {rows.map(({ budget: b, eval: e }) => (
          <li key={b.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <StatusText tone={budgetTone(e.status)}>{STATUS_LABEL[e.status]}</StatusText>
            <span className="font-medium text-content">{b.name}</span>
            <span className="text-xs text-content-muted">
              {budgetTarget(b)} · {formatUsd(e.mtd)} of {formatUsd(b.monthlyUsd)} ({Math.round(e.usedPct ?? 0)}%)
              {e.forecast != null ? ` · forecast ${formatUsd(e.forecast)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Budgets({ rows, error, loading, scope }: { rows: BudgetRow[]; error: unknown; loading: boolean; scope: DecideScope }) {
  const del = useDeleteBudget()
  const toast = useToast()
  const [editing, setEditing] = useState<Budget | null>(null)
  if (loading) return <Skeleton height={120} />
  if (error && !rows.length) {
    return <SourceNote tone="warn">Budgets live in the console document store (<code>decide.budget</code>), which is not available: {errText(error)}</SourceNote>
  }
  if (!rows.length) return <p className="py-4 text-center text-xs text-content-subtle">No budgets yet. Add one for the cluster, a project, a team or a namespace to get alerts here and on the overview.</p>
  return (
    <>
      <ul className="divide-y divide-edge-default">
        {rows.map(({ budget: b, eval: e }) => (
          <li key={b.id} className="py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-content">{b.name}</div>
                <div className="text-[11px] text-content-subtle">{budgetTarget(b)} · alert at {b.alertPct}%</div>
              </div>
              <div className="flex items-center gap-2">
                <StatusText tone={budgetTone(e.status)}>{STATUS_LABEL[e.status]}</StatusText>
                <Button size="xs" variant="ghost" onClick={() => setEditing(b)}>Edit</Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    del.mutate(b.id, {
                      onSuccess: () => toast.success(`Deleted budget ${b.name}`),
                      onError: (err) => toast.error(`Could not delete: ${errText(err)}`),
                    })}
                >
                  Delete
                </Button>
              </div>
            </div>
            <div className="mt-1.5">
              <Meter
                value={e.mtd ?? 0}
                max={b.monthlyUsd}
                color={e.status === 'over' ? STATUS_COLOR.bad : e.status === 'ok' ? STATUS_COLOR.good : STATUS_COLOR.warn}
                label={`${formatUsd(e.mtd)} of ${formatUsd(b.monthlyUsd)} this month${e.forecast != null ? ` · forecast ${formatUsd(e.forecast)} (${Math.round(e.forecastPct ?? 0)}%)` : ''}`}
              />
            </div>
          </li>
        ))}
      </ul>
      {editing ? <BudgetModal initial={editing} scope={scope} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

function BudgetEditorButton({ scope }: { scope: DecideScope }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Add budget</Button>
      {open
        ? (
          <BudgetModal
            initial={{ id: '', name: '', scope: scope.project ? 'project' : scope.team ? 'team' : 'total', target: scope.project || scope.team || '', monthlyUsd: 0, alertPct: 80 }}
            scope={scope}
            onClose={() => setOpen(false)}
          />
        )
        : null}
    </>
  )
}

function BudgetModal({ initial, scope, onClose }: { initial: Budget; scope: DecideScope; onClose(): void }) {
  const [b, setB] = useState<Budget>(initial)
  const save = useSaveBudget()
  const toast = useToast()
  const valid = b.name.trim() && b.monthlyUsd > 0 && (b.scope === 'total' || b.target.trim())
  const submit = () => {
    if (!valid) return
    save.mutate({ ...b, name: b.name.trim(), target: b.scope === 'total' ? '' : b.target.trim() }, {
      onSuccess: () => {
        toast.success(`Saved budget ${b.name.trim()}`)
        onClose()
      },
      onError: (err) => toast.error(`Could not save the budget: ${errText(err)}`),
    })
  }
  const targets: Record<BudgetScope, string[]> = {
    total: [],
    project: scope.projects.map((p) => p.slug),
    team: [...new Set(scope.projects.flatMap((p) => p.teams ?? []))],
    namespace: [],
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={initial.id ? 'Edit budget' : 'Add budget'}
      description="A monthly budget. Spend past the alert threshold, or forecast past the budget, shows here and on the Decide overview."
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>Save budget</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="Shop production" autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Applies to">
            <Select
              value={b.scope}
              onChange={(e) => setB({ ...b, scope: e.target.value as BudgetScope })}
              options={[
                { value: 'total', label: 'Whole cluster' },
                { value: 'project', label: 'Project' },
                { value: 'team', label: 'Team' },
                { value: 'namespace', label: 'Namespace' },
              ]}
            />
          </Field>
          {b.scope !== 'total'
            ? (
              <Field label={b.scope === 'namespace' ? 'Namespace' : b.scope === 'team' ? 'Team' : 'Project'} required>
                {targets[b.scope].length
                  ? <Select value={b.target} onChange={(e) => setB({ ...b, target: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...targets[b.scope].map((t) => ({ value: t, label: t }))]} />
                  : <Input value={b.target} onChange={(e) => setB({ ...b, target: e.target.value })} placeholder={b.scope === 'namespace' ? 'shop-prod' : ''} />}
              </Field>
            )
            : null}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Monthly budget (USD)" required>
            <Input type="number" min={1} step="any" value={b.monthlyUsd || ''} onChange={(e) => setB({ ...b, monthlyUsd: Number(e.target.value) })} />
          </Field>
          <Field label="Alert at (% of budget)">
            <Input type="number" min={1} max={100} value={b.alertPct} onChange={(e) => setB({ ...b, alertPct: Math.min(100, Math.max(1, Number(e.target.value) || 80)) })} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}

/* ─────────── rightsizing ─────────── */

function Rightsizing({ recs, error, loading }: { recs: Recommendation[]; error: unknown; loading: boolean }) {
  if (loading) return <Skeleton height={140} />
  if (error) {
    return (
      <SourceNote tone="warn">
        Prometheus did not answer ({errText(error)}). Rightsizing needs <code>container_cpu_usage_seconds_total</code>,{' '}
        <code>container_memory_working_set_bytes</code> (cAdvisor) and <code>kube_pod_container_resource_requests</code> (kube-state-metrics)
        through <code>/api/svc/prometheus</code>.
      </SourceNote>
    )
  }
  const total = recs.reduce((s, r) => s + (r.monthlySavings ?? 0), 0)
  const columns: Column<Recommendation>[] = [
    { key: 'name', header: 'Container', pinned: true, value: (r) => `${r.namespace}/${r.container}`, cell: (r) => <span><span className="font-medium text-content">{r.container}</span> <span className="text-xs text-content-subtle">{r.namespace}</span></span> },
    { key: 'kind', header: 'Finding', value: (r) => r.kind, cell: (r) => <StatusText tone={r.kind === 'under' ? 'bad' : 'warn'}>{r.kind === 'under' ? 'Under-provisioned' : 'Over-provisioned'}</StatusText> },
    { key: 'cpu', header: 'CPU req → rec', align: 'right', value: (r) => r.cpuReq, cell: (r) => `${formatCores(r.cpuReq)} → ${formatCores(r.cpuRec)}` },
    { key: 'mem', header: 'Mem req → rec', align: 'right', value: (r) => r.memReq, cell: (r) => `${formatBytes(r.memReq)} → ${formatBytes(r.memRec)}` },
    { key: 'replicas', header: 'Replicas', numeric: true, value: (r) => r.replicas, cell: (r) => r.replicas },
    { key: 'save', header: 'Saves / mo', numeric: true, value: (r) => r.monthlySavings ?? -1, cell: (r) => (r.monthlySavings == null ? '—' : formatUsd(r.monthlySavings, { precise: true })) },
    { key: 'why', header: 'Why', value: (r) => r.reason, cell: (r) => <span className="text-xs text-content-muted">{r.reason}</span>, defaultHidden: true },
  ]
  return (
    <div className="space-y-3">
      {recs.length
        ? (
          <p className="text-sm text-content">
            {recs.filter((r) => r.kind === 'over').length} over-provisioned · {recs.filter((r) => r.kind === 'under').length} under-provisioned
            {total > 0 ? <> · about <strong className="font-semibold">{formatUsd(total)}</strong>/month to reclaim</> : null}
          </p>
        )
        : null}
      <DataTable
        columns={columns}
        rows={recs}
        rowKey={(r) => `${r.namespace}/${r.container}`}
        dense
        features={{ search: true, columns: true }}
        empty={<p className="py-6 text-center text-xs text-content-subtle">Every container's requests are within 2× of its observed use.</p>}
      />
      <p className="text-[11px] text-content-subtle">
        Recommendation = CPU p95 × 1.2 and memory peak × 1.2 over 7 days. Flagged when the request is ≥ 2× that with real headroom (≥ 50m CPU or 64Mi), or below observed use.
      </p>
    </div>
  )
}

/* ─────────── saved views ─────────── */

function SavedViews() {
  const views = useSpendViews()
  const save = useSaveSpendView()
  const del = useDeleteSpendView()
  const params = useDecideParams()
  const set = useSetDecideParams()
  const toast = useToast()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const list = views.data ?? []
  const apply = (id: string) => {
    const v = list.find((x) => x.id === id)
    if (!v) return
    const cleared = Object.fromEntries(PARAM_KEYS.map((k) => [k, ''])) as Record<string, string>
    set({ ...cleared, ...v.params })
    toast.info(`Opened view ${v.name}`)
  }
  const onSave = () => {
    const n = name.trim()
    if (!n) return
    save.mutate({ name: n, params: Object.fromEntries(Object.entries(params).filter(([, v]) => v)) as Record<string, string> }, {
      onSuccess: () => {
        toast.success(`Saved view ${n}`)
        setNaming(false)
        setName('')
      },
      onError: (e) => toast.error(`Could not save the view: ${errText(e)}`),
    })
  }
  return (
    <>
      {list.length
        ? (
          <Select
            aria-label="Saved views"
            value=""
            onChange={(e) => apply(e.target.value)}
            options={[{ value: '', label: 'Saved views…' }, ...list.map((v) => ({ value: v.id, label: v.name }))]}
            wrapperClassName="w-40"
            className="h-8 text-xs"
          />
        )
        : null}
      <Button size="sm" onClick={() => setNaming(true)} disabled={!!views.error}>Save view</Button>
      {naming
        ? (
          <Modal
            open
            onClose={() => setNaming(false)}
            title="Save this view"
            description="Saves the range, project, grouping and label for everyone in the organization."
            footer={
              <div className="flex justify-end gap-2">
                <Button onClick={() => setNaming(false)}>Cancel</Button>
                <Button variant="primary" disabled={!name.trim()} loading={save.isPending} onClick={onSave}>Save view</Button>
              </div>
            }
          >
            <Field label="Name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Prod by team, last month" autoFocus onKeyDown={(e) => e.key === 'Enter' && onSave()} />
            </Field>
            {list.length
              ? (
                <div className="mt-4">
                  <div className="mb-1 text-xs font-medium text-content-muted">Existing views</div>
                  <ul className="divide-y divide-edge-default text-sm">
                    {list.map((v) => (
                      <li key={v.id} className="flex items-center justify-between py-1.5">
                        <span className="text-content">{v.name}</span>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => del.mutate(v.id, { onSuccess: () => toast.success(`Deleted view ${v.name}`), onError: (e) => toast.error(errText(e)) })}
                        >
                          Delete
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
              : null}
          </Modal>
        )
        : null}
    </>
  )
}

