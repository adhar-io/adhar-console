import { type ReactNode, useMemo } from 'react'
import { Button, type Column, DataTable, PageHeader, Select, Skeleton, useToast } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { BinChart, ColumnChart, LineChart, Spark, STATUS_COLOR, useSeriesColor } from '../components/viz.tsx'
import { BandBadge, copyLink, Delta, DLink, Panel, ScopeRow, Segmented, SourceChips, SourceNote, StatusText } from '../components/ui.tsx'
import { downloadCsv, isoTime, toCsv } from '../data/csv.ts'
import {
  BENCHMARKS,
  type BreakdownRow,
  type DeployEvent,
  envRank,
  formatHours,
  formatPerDay,
  formatRate,
  histogram,
  type KeyMetrics,
  LEAD_BINS,
  type LeadTimeSample,
  type RestoreSample,
} from '../data/dora-model.ts'
import { type DoraDataset, useDora } from '../data/dora.ts'
import { decideHref, phaseHref, useDecideParams, useSetDecideParams } from '../data/params.ts'
import { RANGES, useDecideScope } from '../data/scope.ts'

/**
 * DORA — the four keys for the selected scope, computed from the platform's
 * own delivery record (Kargo promotions / Argo CD syncs, Tekton builds, Gitea
 * commits, Prometheus alerts). See `data/dora-model.ts` for the definitions and
 * the "How this is computed" panel at the bottom of the page for the sources
 * and their gaps.
 */

type MetricId = 'deploys' | 'lead' | 'cfr' | 'restore'
type GroupId = 'team' | 'project' | 'app'
type ListId = 'deploys' | 'changes' | 'restores' | 'open'

const METRICS: ReadonlyArray<{ id: MetricId; label: string }> = [
  { id: 'deploys', label: 'Deploy frequency' },
  { id: 'lead', label: 'Lead time' },
  { id: 'cfr', label: 'Change failure' },
  { id: 'restore', label: 'Time to restore' },
]

const asMetric = (v?: string): MetricId => (METRICS.some((m) => m.id === v) ? (v as MetricId) : 'deploys')
const asGroup = (v?: string): GroupId => (v === 'team' || v === 'app' ? v : 'project')
const asList = (v?: string): ListId => (v === 'changes' || v === 'restores' || v === 'open' ? v : 'deploys')

const bucketLabel = (ms: number) => (ms > 86_400_000 ? 'week' : 'day')
const fmtDate = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function DoraSummary() {
  const scope = useDecideScope()
  const params = useDecideParams()
  const set = useSetDecideParams()
  const toast = useToast()
  const data = useDora(scope, params.env)
  const metric = asMetric(params.metric)
  const group = asGroup(params.group)
  const list = asList(params.tab)
  const envs = useMemo(
    () => [...new Set(['prod', ...data.allDeploys.map((d) => d.env).filter(Boolean)])].sort((a, b) => envRank(a) - envRank(b)),
    [data.allDeploys],
  )

  const exportList = () => {
    const { header, rows, noun } = listCsv(list, data)
    if (!rows.length) {
      toast.info(`No ${noun} to export in this range`)
      return
    }
    downloadCsv(`dora-${noun}-${scope.project || scope.team || 'all'}-${scope.range.id}`, toCsv(header, rows))
    toast.success(`Exported ${rows.length} ${noun}`)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="DORA"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => copyLink(toast)}>Copy link</Button>
            <Button size="sm" variant="primary" onClick={exportList}>Export CSV</Button>
          </div>
        }
      />

      <ScopeRow scope={scope} ranges={RANGES} range={scope.range.id} onRange={(id) => set({ range: id })}>
        <Select
          aria-label="Environment"
          value={data.env}
          onChange={(e) => set({ env: e.target.value === 'prod' ? '' : e.target.value })}
          options={envs.map((e) => ({ value: e, label: e === 'prod' ? 'Production' : e }))}
          wrapperClassName="w-full sm:w-40"
          className="h-8 text-xs"
        />
      </ScopeRow>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-content-subtle">
          {scope.label} · {data.env === 'prod' ? 'production' : data.env} · last {scope.range.label} vs the {scope.range.label} before
        </p>
        <SourceChips sources={data.sources} />
      </div>

      {data.noSources
        ? (
          <SourceNote tone="warn">
            Neither Argo CD nor Kargo answered, so there is no deploy record to measure. DORA needs at least one of them — check the
            Argo CD proxy (<code>/api/svc/argocd</code>) and the Kargo CRDs through the cluster gateway.
          </SourceNote>
        )
        : null}

      <KeyCards data={data} metric={metric} onPick={(m) => set({ metric: m === 'deploys' ? '' : m })} />

      <Panel
        title={`${METRICS.find((m) => m.id === metric)!.label} over time`}
        sub={`Per ${bucketLabel(data.bucket)}. Dashed lines mark the DORA band boundaries.`}
        actions={<Segmented value={metric} options={METRICS} onChange={(m) => set({ metric: m === 'deploys' ? '' : m })} label="Metric" />}
      >
        <TrendChart data={data} metric={metric} />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Lead time distribution" sub="Commit → running in the environment, per shipped commit.">
          <DistBins hours={data.leads.filter((l) => l.deployedAt >= data.from).map((l) => l.hours)} unit="commits" />
        </Panel>
        <Panel title="Time to restore distribution" sub="Failure → restored, per incident (deploy and alert).">
          <DistBins hours={data.restores.filter((r) => r.end >= data.from).map((r) => r.hours)} unit="incidents" />
        </Panel>
      </div>

      <Panel
        title="Breakdown"
        sub="The four keys per group over the selected range. Click a project to scope the page to it."
        actions={
          <Segmented
            value={group}
            options={[{ id: 'team', label: 'Team' }, { id: 'project', label: 'Project' }, { id: 'app', label: 'App' }] as const}
            onChange={(g) => set({ group: g === 'project' ? '' : g })}
            label="Group by"
          />
        }
      >
        <Breakdown rows={group === 'team' ? data.byTeam : group === 'app' ? data.byApp : data.byProject} group={group} loading={data.loading} onProject={(p) => set({ project: p })} />
      </Panel>

      <Panel
        title="Underlying records"
        sub="Every number above comes from these rows. Export CSV downloads the open list."
        actions={
          <Segmented
            value={list}
            options={[
              { id: 'deploys', label: `Deploys` },
              { id: 'changes', label: `Changes` },
              { id: 'restores', label: `Restores` },
              { id: 'open', label: `Open (${data.openIncidents.length})` },
            ] as const}
            onChange={(t) => set({ tab: t === 'deploys' ? '' : t })}
            label="Records"
          />
        }
      >
        <Records data={data} list={list} />
      </Panel>

      <Methodology data={data} />
    </div>
  )
}

/* ─────────── key cards ─────────── */

function KeyCards({ data, metric, onPick }: { data: DoraDataset; metric: MetricId; onPick(m: MetricId): void }) {
  const c = data.current
  const p = data.previous
  const color = useSeriesColor()(0)
  if (data.loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={150} className="rounded-xl" />)}
      </div>
    )
  }
  const cards: Array<{ id: MetricId; value: string; band: KeyMetrics['deployBand']; sub: string; delta: ReactNode; bench: Record<string, string>; spark: Array<[number, number]> }> = [
    {
      id: 'deploys',
      value: c.deploys ? formatPerDay(c.perDay) : '0',
      band: c.deployBand,
      sub: `${c.deploys - c.failed} successful deploys`,
      delta: <Delta current={c.deploys ? c.perDay : null} previous={p.deploys ? p.perDay : null} goodWhenUp />,
      bench: BENCHMARKS.deployFrequency,
      spark: data.series.deploys,
    },
    {
      id: 'lead',
      value: formatHours(c.leadP50),
      band: c.leadBand,
      sub: c.leadSamples ? `median of ${c.leadSamples} commits · p90 ${formatHours(c.leadP90)}` : 'no commit could be traced to a deploy',
      delta: <Delta current={c.leadP50} previous={p.leadP50} goodWhenUp={false} />,
      bench: BENCHMARKS.leadTime,
      spark: data.series.leadTime,
    },
    {
      id: 'cfr',
      value: formatRate(c.changeFailureRate),
      band: c.changeFailureBand,
      sub: c.deploys ? `${c.failed} of ${c.deploys} deploys failed or rolled back` : 'no deploys in range',
      delta: <Delta current={c.changeFailureRate} previous={p.changeFailureRate} goodWhenUp={false} format={(d) => `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)} pts`} />,
      bench: BENCHMARKS.changeFailure,
      spark: data.series.changeFailure,
    },
    {
      id: 'restore',
      value: formatHours(c.restoreP50),
      band: c.restoreBand,
      sub: c.restoreSamples ? `median of ${c.restoreSamples} restores` : 'no failure was restored in range',
      delta: <Delta current={c.restoreP50} previous={p.restoreP50} goodWhenUp={false} />,
      bench: BENCHMARKS.restore,
      spark: data.series.restore,
    },
  ]
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((k) => (
        <button
          key={k.id}
          type="button"
          onClick={() => onPick(k.id)}
          aria-pressed={metric === k.id}
          className={`min-w-0 rounded-xl border bg-surface-raised p-4 text-left transition-colors hover:border-edge-strong ${metric === k.id ? 'border-brand-500 ring-1 ring-brand-500/40' : 'border-edge-default'}`}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs font-medium text-content-muted">{METRICS.find((m) => m.id === k.id)!.label}</span>
            <BandBadge band={k.band} />
          </div>
          <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-content">{k.value}</div>
          <div className="mt-0.5 text-[11px] text-content-subtle">{k.sub}</div>
          <div className="mt-2">{k.spark.length > 1 ? <Spark points={k.spark} color={color} /> : <div className="h-7" />}</div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            {k.delta}
            <span className="text-[10px] text-content-subtle">Elite {k.bench.elite}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

/* ─────────── trend ─────────── */

function TrendChart({ data, metric }: { data: DoraDataset; metric: MetricId }) {
  const color = useSeriesColor()
  const domain: [number, number] = [data.from, data.to - data.bucket]
  if (metric === 'deploys') {
    return (
      <ColumnChart
        height={200}
        series={[
          { name: 'Successful', points: data.series.deploys, color: color(0) },
          { name: 'Failed / rolled back', points: data.series.failures, color: STATUS_COLOR.bad },
        ]}
        emptyLabel="No deploys to this environment in range."
      />
    )
  }
  if (metric === 'lead') {
    return (
      <LineChart
        height={200}
        domain={domain}
        series={[{ name: 'Median lead time', points: data.series.leadTime, color: color(0) }]}
        formatY={(v) => (v === 0 ? '0' : formatHours(v))}
        refLines={[{ value: 24, label: 'Elite < 1 day' }, ...(max(data.series.leadTime) > 48 ? [{ value: 168, label: 'High < 1 week' }] : [])]}
        emptyLabel="No commit could be traced to a deploy in range — see How this is computed."
      />
    )
  }
  if (metric === 'cfr') {
    return (
      <LineChart
        height={200}
        domain={domain}
        series={[{ name: 'Change failure rate', points: data.series.changeFailure, color: color(0) }]}
        formatY={(v) => `${Math.round(v)}%`}
        yMax={Math.max(20, Math.ceil(max(data.series.changeFailure) / 10) * 10)}
        refLines={[{ value: 5, label: 'Elite ≤ 5%' }, { value: 15, label: 'Medium ≤ 15%' }]}
        emptyLabel="No deploys in range."
      />
    )
  }
  return (
    <LineChart
      height={200}
      domain={domain}
      series={[{ name: 'Median time to restore', points: data.series.restore, color: color(0) }]}
      formatY={(v) => (v === 0 ? '0' : formatHours(v))}
      refLines={[{ value: 1, label: 'Elite < 1 h' }, ...(max(data.series.restore) > 12 ? [{ value: 24, label: 'High < 1 day' }] : [])]}
      emptyLabel="Nothing failed and recovered in range."
    />
  )
}

function max(points: Array<[number, number]>): number {
  return Math.max(0, ...points.map((p) => p[1]))
}

function DistBins({ hours, unit }: { hours: number[]; unit: string }) {
  const color = useSeriesColor()(0)
  return <BinChart bins={histogram(hours, LEAD_BINS)} color={color} unit={unit} />
}

/* ─────────── breakdown ─────────── */

function Breakdown({ rows, group, loading, onProject }: { rows: BreakdownRow[]; group: GroupId; loading: boolean; onProject(p: string): void }) {
  const columns: Column<BreakdownRow>[] = [
    {
      key: 'key',
      header: group === 'team' ? 'Team' : group === 'app' ? 'App' : 'Project',
      pinned: true,
      value: (r) => r.key,
      cell: (r) =>
        group === 'project' && !r.key.startsWith('(')
          ? (
            <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => onProject(r.key)}>
              {r.key}
            </button>
          )
          : <span className="font-medium text-content">{r.key}</span>,
    },
    { key: 'deploys', header: 'Deploys', numeric: true, value: (r) => r.deploys, cell: (r) => r.deploys },
    { key: 'freq', header: 'Frequency', align: 'right', value: (r) => r.perDay, cell: (r) => (r.deploys ? formatPerDay(r.perDay) : '—') },
    { key: 'lead', header: 'Lead time p50', align: 'right', value: (r) => r.leadP50 ?? -1, cell: (r) => formatHours(r.leadP50) },
    { key: 'cfr', header: 'Change failure', align: 'right', value: (r) => r.changeFailureRate ?? -1, cell: (r) => formatRate(r.changeFailureRate) },
    { key: 'restore', header: 'Restore p50', align: 'right', value: (r) => r.restoreP50 ?? -1, cell: (r) => formatHours(r.restoreP50) },
    { key: 'band', header: 'Overall', value: (r) => r.overall ?? '', cell: (r) => <BandBadge band={r.overall} /> },
  ]
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      loading={loading}
      dense
      empty={<p className="py-6 text-center text-xs text-content-subtle">No deploys, changes or restores in scope for this range.</p>}
    />
  )
}

/* ─────────── records ─────────── */

function outcomeText(d: DeployEvent) {
  if (d.outcome === 'failed') return <StatusText tone="bad">Failed</StatusText>
  if (d.outcome === 'rolled-back') return <StatusText tone="warn">Rolled back</StatusText>
  return <StatusText tone="good">{d.rollback ? 'Rollback deploy' : 'Succeeded'}</StatusText>
}

function Records({ data, list }: { data: DoraDataset; list: ListId }) {
  const inRange = <T,>(xs: T[], at: (x: T) => number) => xs.filter((x) => at(x) >= data.from).sort((a, b) => at(b) - at(a))
  if (list === 'deploys') {
    const rows = inRange(data.envDeploys, (d) => d.at)
    const cols: Column<DeployEvent>[] = [
      { key: 'at', header: 'Finished', value: (d) => d.at, cell: (d) => <span className="whitespace-nowrap" title={new Date(d.at).toISOString()}>{fmtDate(d.at)}</span> },
      { key: 'app', header: 'App', pinned: true, value: (d) => d.app, cell: (d) => <span className="font-medium text-content">{d.app || '—'}</span> },
      { key: 'project', header: 'Project', value: (d) => d.project, cell: (d) => d.project || '—' },
      { key: 'outcome', header: 'Outcome', value: (d) => d.outcome, cell: outcomeText },
      {
        key: 'source',
        header: 'Record',
        value: (d) => d.name,
        cell: (d) => (
          <DLink
            href={d.source === 'kargo' ? phaseHref('deliver', 'stages', { project: d.project }) : phaseHref('deliver', 'apps')}
            className="text-brand-700 hover:underline dark:text-brand-300"
          >
            {d.source === 'kargo' ? 'Kargo' : 'Argo CD'} · {d.name}
          </DLink>
        ),
      },
      { key: 'actor', header: 'By', value: (d) => d.actor ?? '', cell: (d) => d.actor ?? '—', defaultHidden: true },
      { key: 'msg', header: 'Message', value: (d) => d.message ?? '', cell: (d) => <span className="line-clamp-1 text-content-muted">{d.message ?? ''}</span>, defaultHidden: true },
    ]
    return <DataTable columns={cols} rows={rows} rowKey={(d) => d.id} dense features={{ search: true, columns: true }} empty={<Empty>No deploys to this environment in range.</Empty>} />
  }
  if (list === 'changes') {
    const rows = inRange(data.leads, (l) => l.deployedAt)
    const cols: Column<LeadTimeSample>[] = [
      { key: 'sha', header: 'Commit', pinned: true, value: (l) => l.sha, cell: (l) => <span className="font-mono text-xs">{l.sha.slice(0, 8)}</span> },
      { key: 'repo', header: 'Repository', value: (l) => l.repo, cell: (l) => l.repo },
      { key: 'app', header: 'App', value: (l) => l.app, cell: (l) => l.app },
      { key: 'committed', header: 'Committed', value: (l) => l.committedAt, cell: (l) => <span className="whitespace-nowrap">{fmtDate(l.committedAt)}</span> },
      { key: 'deployed', header: 'Deployed', value: (l) => l.deployedAt, cell: (l) => <span className="whitespace-nowrap">{fmtDate(l.deployedAt)}</span> },
      { key: 'lead', header: 'Lead time', align: 'right', value: (l) => l.hours, cell: (l) => formatHours(l.hours) },
      { key: 'via', header: 'Traced via', value: (l) => l.via, cell: (l) => VIA_LABEL[l.via] },
    ]
    return <DataTable columns={cols} rows={rows} rowKey={(l) => `${l.repo}@${l.sha}`} dense features={{ search: true }} empty={<Empty>No shipped commit could be traced in range.</Empty>} />
  }
  if (list === 'restores') {
    const rows = inRange(data.restores, (r) => r.end)
    const cols: Column<RestoreSample>[] = [
      { key: 'label', header: 'Incident', pinned: true, value: (r) => r.label, cell: (r) => <span className="text-content">{r.label}</span> },
      { key: 'source', header: 'Source', value: (r) => r.source, cell: (r) => (r.source === 'alert' ? 'Alert' : 'Deploy') },
      { key: 'project', header: 'Project', value: (r) => r.project, cell: (r) => r.project || '—' },
      { key: 'start', header: 'Started', value: (r) => r.start, cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.start)}</span> },
      { key: 'end', header: 'Restored', value: (r) => r.end, cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.end)}</span> },
      { key: 'hours', header: 'Time to restore', align: 'right', value: (r) => r.hours, cell: (r) => formatHours(r.hours) },
    ]
    return <DataTable columns={cols} rows={rows} rowKey={(r) => `${r.source}:${r.label}:${r.start}`} dense features={{ search: true }} empty={<Empty>Nothing failed and recovered in range.</Empty>} />
  }
  const rows = [...data.openIncidents].sort((a, b) => a.since - b.since)
  if (!rows.length) return <Empty>No open failures: every failed deploy has been followed by a good one, and no critical alert is firing.</Empty>
  return (
    <ul className="divide-y divide-edge-default">
      {rows.map((o) => (
        <li key={`${o.source}:${o.label}:${o.since}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <span className="min-w-0">
            <StatusText tone="bad">Open</StatusText> <span className="ml-1 text-content">{o.label}</span>
            {o.project ? <span className="ml-1 text-xs text-content-subtle">· {o.project}</span> : null}
          </span>
          <span className="text-xs text-content-muted">since {formatRelative(new Date(o.since).toISOString())}</span>
        </li>
      ))}
    </ul>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-content-subtle">{children}</p>
}

const VIA_LABEL: Record<LeadTimeSample['via'], string> = {
  'freight-commit': 'Kargo freight commit',
  'image-tag': 'Image tag → Tekton build',
  'argo-revision': 'Argo CD revision',
  'build-start': 'Build start (no commit time)',
}

function listCsv(list: ListId, d: DoraDataset): { header: string[]; rows: Array<Array<string | number | undefined>>; noun: string } {
  const inRange = <T,>(xs: T[], at: (x: T) => number) => xs.filter((x) => at(x) >= d.from)
  if (list === 'changes') {
    return {
      noun: 'changes',
      header: ['commit', 'repository', 'project', 'app', 'committed_at', 'deployed_at', 'lead_time_hours', 'traced_via'],
      rows: inRange(d.leads, (l) => l.deployedAt).map((l) => [l.sha, l.repo, l.project, l.app, isoTime(l.committedAt), isoTime(l.deployedAt), l.hours, l.via]),
    }
  }
  if (list === 'restores') {
    return {
      noun: 'restores',
      header: ['incident', 'source', 'project', 'app', 'env', 'started_at', 'restored_at', 'hours'],
      rows: inRange(d.restores, (r) => r.end).map((r) => [r.label, r.source, r.project, r.app, r.env, isoTime(r.start), isoTime(r.end), r.hours]),
    }
  }
  if (list === 'open') {
    return {
      noun: 'open-incidents',
      header: ['incident', 'source', 'project', 'since'],
      rows: d.openIncidents.map((o) => [o.label, o.source, o.project, isoTime(o.since)]),
    }
  }
  return {
    noun: 'deploys',
    header: ['finished_at', 'started_at', 'project', 'app', 'env', 'outcome', 'rollback', 'source', 'record', 'freight', 'revision', 'actor'],
    rows: inRange(d.envDeploys, (e) => e.at).map((e) => [
      isoTime(e.at),
      isoTime(e.startedAt),
      e.project,
      e.app,
      e.env,
      e.outcome,
      e.rollback ? 'yes' : '',
      e.source,
      e.name,
      e.freight,
      e.revision,
      e.actor,
    ]),
  }
}

/* ─────────── methodology & data quality ─────────── */

function Methodology({ data }: { data: DoraDataset }) {
  const q = data.quality
  const pct = q.deploys ? Math.round((q.resolved / q.deploys) * 100) : null
  const src = (id: string) => data.sources.find((s) => s.id === id)
  const gaps: string[] = []
  for (const s of data.sources) if (s.state === 'missing' || s.state === 'error') gaps.push(s.detail)
  if (q.unresolved) gaps.push(`${q.unresolved} of ${q.deploys} successful deploys could not be traced to a source commit, so they add nothing to lead time.`)
  if (q.via['build-start']) gaps.push(`${q.via['build-start']} deploys fall back to their build's start time (Gitea did not return the commit) — those lead times are under-estimates.`)
  if (q.reposFailed) gaps.push(`${q.reposFailed} repositories could not be read from Gitea.`)
  if (q.deploySource.argocd) gaps.push('Argo CD keeps the last 10 syncs per application (revisionHistoryLimit), so long ranges undercount apps deployed outside Kargo.')
  return (
    <Panel title="How this is computed" sub="Definitions, sources and what is missing for the current scope.">
      <div className="grid gap-4 text-xs leading-relaxed text-content-muted md:grid-cols-2">
        <Def title="Deployment frequency" bench={BENCHMARKS.deployFrequency}>
          Successful deploys to the environment per day. A deploy is a Kargo promotion that Succeeded; for an app with no Kargo
          promotions, an Argo CD sync from the application's history. Kargo wins when both exist so one release is never counted twice.
          {` (${q.deploySource.kargo} from Kargo, ${q.deploySource.argocd} from Argo CD in range.)`}
        </Def>
        <Def title="Lead time for changes" bench={BENCHMARKS.leadTime}>
          For every commit a successful deploy shipped (from its head back to the previous deploy's head), the time from the commit
          being authored in Gitea to the deploy finishing. The head commit is read from the promotion's freight (git commit), else
          from an image tag matched to the Tekton build that produced it, else from the Argo CD revision of a code repository.
          {pct != null ? ` ${pct}% of deploys in range were traced.` : ''}
        </Def>
        <Def title="Change failure rate" bench={BENCHMARKS.changeFailure}>
          Deploys that failed (Kargo promotion Failed/Errored, Argo CD sync Failed) or were rolled back (Argo CD redeployed an earlier
          revision) ÷ all deploys to the environment.
        </Def>
        <Def title="Time to restore" bench={BENCHMARKS.restore}>
          Median of two kinds of incident: a failed or rolled-back deploy until the next successful deploy of the same app, and a
          critical alert in the environment's namespace from firing to resolved (Prometheus <code>ALERTS</code>, 5-minute resolution
          or coarser on long ranges). Incidents still open are listed but not counted.
        </Def>
      </div>
      <div className="mt-4 border-t border-edge-default pt-3">
        <h4 className="mb-2 text-xs font-semibold text-content">Data quality</h4>
        <ul className="space-y-1 text-xs text-content-muted">
          {data.sources.map((s) => (
            <li key={s.id}>
              <StatusText tone={s.state === 'ok' ? 'good' : s.state === 'missing' || s.state === 'empty' ? 'warn' : s.state === 'loading' ? 'neutral' : 'bad'}>
                {s.label}
              </StatusText>{' '}
              — {s.detail}
            </li>
          ))}
          {gaps.length
            ? gaps.filter((g) => !data.sources.some((s) => s.detail === g)).map((g) => <li key={g}>· {g}</li>)
            : <li>· Every deploy in range was traced to its commits.</li>}
          {src('prometheus')?.state !== 'ok' ? <li>· Without Prometheus, time to restore uses deploy recovery only.</li> : null}
        </ul>
        <p className="mt-3 text-xs text-content-subtle">
          Builds and pipelines: <DLink href={phaseHref('develop', 'builds')} className="text-brand-700 hover:underline dark:text-brand-300">Develop → Builds</DLink>
          <span aria-hidden> · </span>Promotions: <DLink href={phaseHref('deliver', 'stages')} className="text-brand-700 hover:underline dark:text-brand-300">Deliver → Kargo Stages</DLink>
          <span aria-hidden> · </span>Alerts: <DLink href={phaseHref('discover', 'alerts')} className="text-brand-700 hover:underline dark:text-brand-300">Discover → Alerts</DLink>
          <span aria-hidden> · </span><DLink href={decideHref('dashboard')} className="text-brand-700 hover:underline dark:text-brand-300">Decide overview</DLink>
        </p>
      </div>
    </Panel>
  )
}

function Def({ title, bench, children }: { title: string; bench: Record<string, string>; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold text-content">{title}</h4>
      <p>{children}</p>
      <p className="mt-1 text-[11px] text-content-subtle">
        Elite {bench.elite} · High {bench.high} · Medium {bench.medium} · Low {bench.low}
      </p>
    </div>
  )
}
