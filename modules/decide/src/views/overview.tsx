import { useMemo } from 'react'
import { Button, PageHeader, Skeleton, useToast } from '@adhar/shell-ui'
import type { metabase } from '@adhar/api-clients'
import { formatRelative } from '@adhar/utils'
import { ColumnChart, RankBars, Spark, useSeriesColor } from '../components/viz.tsx'
import { BandBadge, copyLink, Delta, DLink, Panel, ScopeRow, SectionHeader, SourceNote, StatusText, Tile, type Tone } from '../components/ui.tsx'
import { useBiHighlights, useOrgRepos, useWorkspaceTeams } from '../data/adoption.ts'
import { buildSeries, buildStats, formatSeconds } from '../data/builds-model.ts'
import { evaluateBudget, forecastMonth, formatDeltaPct, formatUsd, monthStart, prevSamePeriod, regroup, scaleForecast } from '../data/cost-model.ts'
import { PLATFORM, projectOfNamespace, scopeDays, useAllocation, useBudgets, useDailySpend } from '../data/cost.ts'
import { envRank, formatHours, formatPerDay, formatRate, overallBand } from '../data/dora-model.ts'
import { useArgoApps, useDora, useStages } from '../data/dora.ts'
import { argoProjectOf } from '../data/dora-sources.ts'
import { decideHref, phaseHref, useSetDecideParams } from '../data/params.ts'
import { useFiringAlerts, useSlos } from '../data/reliability.ts'
import { RANGES, useDecideScope } from '../data/scope.ts'

/**
 * Decide overview — the engineering-leader dashboard for the selected scope:
 * the four DORA keys, delivery throughput per environment, build health,
 * reliability (SLO budgets, firing alerts), cost, platform adoption and a few
 * BI highlights. Every tile links to the page that explains it, carrying the
 * range and project in the URL.
 */
export function Overview() {
  const scope = useDecideScope()
  const set = useSetDecideParams()
  const toast = useToast()
  const dora = useDora(scope)
  const ctx = { range: scope.range.id === '30d' ? undefined : scope.range.id, project: scope.project || undefined }
  const doraHref = (metric?: string) => decideHref('dora', { ...ctx, metric })

  const c = dora.current
  const p = dora.previous
  const overall = overallBand([c.deployBand, c.leadBand, c.changeFailureBand, c.restoreBand])
  const color = useSeriesColor()

  return (
    <div className="space-y-8">
      <PageHeader title="Decide" actions={<Button size="sm" onClick={() => copyLink(toast)}>Copy link</Button>} />

      <ScopeRow scope={scope} ranges={RANGES} range={scope.range.id} onRange={(id) => set({ range: id === '30d' ? '' : id })} />

      <section>
        <SectionHeader title="Software delivery performance" href={doraHref()} linkLabel="DORA details">
          {overall ? <span className="flex items-center gap-1.5 text-xs text-content-muted">Overall <BandBadge band={overall} /></span> : null}
        </SectionHeader>
        {dora.noSources
          ? <SourceNote tone="warn">No deploy record: neither Argo CD nor Kargo answered, so the four keys cannot be computed.</SourceNote>
          : dora.loading
          ? <TileSkeletons n={4} />
          : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Tile
                label="Deployment frequency"
                href={doraHref()}
                value={c.deploys ? formatPerDay(c.perDay) : '0'}
                sub={`${c.deploys - c.failed} production deploys`}
                badge={<BandBadge band={c.deployBand} />}
                spark={<Spark points={dora.series.deploys} color={color(0)} />}
                footer={<Delta current={c.deploys ? c.perDay : null} previous={p.deploys ? p.perDay : null} goodWhenUp />}
              />
              <Tile
                label="Lead time for changes"
                href={doraHref('lead')}
                value={formatHours(c.leadP50)}
                sub={c.leadSamples ? `median · ${c.leadSamples} commits` : 'no commit traced to a deploy'}
                badge={<BandBadge band={c.leadBand} />}
                spark={<Spark points={dora.series.leadTime} color={color(0)} />}
                footer={<Delta current={c.leadP50} previous={p.leadP50} goodWhenUp={false} />}
              />
              <Tile
                label="Change failure rate"
                href={doraHref('cfr')}
                value={formatRate(c.changeFailureRate)}
                sub={c.deploys ? `${c.failed} failed or rolled back` : 'no deploys in range'}
                badge={<BandBadge band={c.changeFailureBand} />}
                spark={<Spark points={dora.series.changeFailure} color={color(0)} />}
                footer={<Delta current={c.changeFailureRate} previous={p.changeFailureRate} goodWhenUp={false} format={(d) => `${d > 0 ? '+' : '−'}${Math.abs(d * 100).toFixed(1)} pts`} />}
              />
              <Tile
                label="Time to restore"
                href={doraHref('restore')}
                value={formatHours(c.restoreP50)}
                sub={c.restoreSamples ? `median · ${c.restoreSamples} restores` : dora.openIncidents.length ? `${dora.openIncidents.length} still open` : 'nothing failed and recovered'}
                badge={<BandBadge band={c.restoreBand} />}
                spark={<Spark points={dora.series.restore} color={color(0)} />}
                footer={<Delta current={c.restoreP50} previous={p.restoreP50} goodWhenUp={false} />}
              />
            </div>
          )}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Throughput dora={dora} />
        <BuildHealth dora={dora} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Reliability dora={dora} scopeMatches={scope.matches} scoped={!!scope.inScope} />
        <Cost scope={scope} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Adoption scope={scope} />
        <BiHighlights />
      </div>
    </div>
  )
}

function TileSkeletons({ n }: { n: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: n }, (_, i) => <Skeleton key={i} height={140} className="rounded-xl" />)}
    </div>
  )
}

function Mini({ label, value, sub, href }: { label: string; value: string; sub?: string; href?: string }) {
  const body = (
    <>
      <div className="text-[11px] text-content-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-content">{value}</div>
      {sub ? <div className="text-[11px] text-content-subtle">{sub}</div> : null}
    </>
  )
  return href
    ? <DLink href={href} className="block min-w-0 rounded-lg bg-surface-sunken/60 px-3 py-2 hover:bg-surface-sunken">{body}</DLink>
    : <div className="min-w-0 rounded-lg bg-surface-sunken/60 px-3 py-2">{body}</div>
}

/* ─────────── delivery throughput ─────────── */

function Throughput({ dora }: { dora: ReturnType<typeof useDora> }) {
  const color = useSeriesColor()
  const inRange = dora.allDeploys.filter((d) => d.at >= dora.from && d.outcome === 'succeeded')
  const envs = [...new Set(inRange.map((d) => d.env || '(unknown)'))].sort((a, b) => envRank(a) - envRank(b))
  const shown = envs.slice(0, 3)
  const other = envs.slice(3)
  const series = useMemo(() => {
    const starts: number[] = []
    for (let t = dora.from; t < dora.to; t += dora.bucket) starts.push(t)
    const count = (match: (env: string) => boolean) =>
      starts.map((s) => [s, inRange.filter((d) => d.at >= s && d.at < s + dora.bucket && match(d.env || '(unknown)')).length] as [number, number])
    return [
      ...shown.map((e, i) => ({ name: e, points: count((x) => x === e), color: color(i) })),
      ...(other.length ? [{ name: 'other', points: count((x) => other.includes(x)), color: color(4) }] : []),
    ]
  }, [dora.allDeploys, dora.from, dora.to, dora.bucket, envs.join(','), color])
  const promotions = dora.allDeploys.filter((d) => d.at >= dora.from && d.source === 'kargo')
  const promoFailed = promotions.filter((d) => d.outcome !== 'succeeded').length
  const kargoState = dora.sources.find((s) => s.id === 'kargo')?.state
  const kargoDown = kargoState === 'error' || kargoState === 'missing'
  return (
    <Panel
      title="Delivery throughput"
      sub={`Successful deploys per environment, per ${dora.bucket > 86_400_000 ? 'week' : 'day'}. Projects share dev → test → prod with one Kargo chain each.`}
      actions={<DLink href={phaseHref('deliver', 'environments')} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">Environments →</DLink>}
    >
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {envs.slice(0, 3).map((e) => (
          <Mini key={e} label={e} value={String(inRange.filter((d) => (d.env || '(unknown)') === e).length)} sub="deploys" />
        ))}
        <Mini
          label="Kargo promotions"
          value={kargoDown ? '—' : String(promotions.length)}
          sub={kargoDown ? 'Kargo unreachable' : promotions.length ? `${promoFailed} failed` : 'none in range'}
          href={phaseHref('deliver', 'stages')}
        />
      </div>
      {dora.loading ? <Skeleton height={170} /> : <ColumnChart height={170} series={series} emptyLabel="No deploys in range." />}
    </Panel>
  )
}

/* ─────────── build health ─────────── */

function BuildHealth({ dora }: { dora: ReturnType<typeof useDora> }) {
  const color = useSeriesColor()
  const tekton = dora.sources.find((s) => s.id === 'tekton')
  const stats = useMemo(() => buildStats(dora.runs, dora.from, dora.to), [dora.runs, dora.from, dora.to])
  const series = useMemo(() => buildSeries(dora.runs, dora.from, dora.to, dora.bucket), [dora.runs, dora.from, dora.to, dora.bucket])
  const tone: Tone = stats.successRate == null ? 'neutral' : stats.successRate >= 0.9 ? 'good' : stats.successRate >= 0.75 ? 'warn' : 'bad'
  return (
    <Panel
      title="Build health"
      sub="Tekton PipelineRuns in scope. Cancelled runs are left out of the success rate."
      actions={<DLink href={phaseHref('develop', 'builds')} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">Builds →</DLink>}
    >
      {tekton?.state === 'missing' || tekton?.state === 'error'
        ? <SourceNote tone="warn">{tekton.detail} Build health reads <code>tekton.dev/v1 PipelineRuns</code> through the cluster gateway.</SourceNote>
        : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="min-w-0 rounded-lg bg-surface-sunken/60 px-3 py-2">
                <div className="text-[11px] text-content-muted">Success rate</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-content">{formatRate(stats.successRate)}</div>
                <StatusText tone={tone}>{stats.succeeded} ok · {stats.failed} failed</StatusText>
              </div>
              <Mini label="Duration p50" value={formatSeconds(stats.durationP50)} sub={`p95 ${formatSeconds(stats.durationP95)}`} />
              <Mini label="Queue p50" value={formatSeconds(stats.queueP50)} sub={`p95 ${formatSeconds(stats.queueP95)}`} />
              <Mini label="Runs" value={String(stats.total)} sub={stats.running ? `${stats.running} in progress` : 'in range'} />
            </div>
            <ColumnChart
              height={120}
              series={[{ name: 'Succeeded', points: series.ok, color: color(0) }, { name: 'Failed', points: series.bad, color: 'var(--color-rose-500, #f43f5e)' }]}
              emptyLabel={dora.loading ? 'Loading…' : 'No pipeline runs in range.'}
            />
            {stats.recentFailures.length
              ? (
                <ul className="mt-3 space-y-1 text-xs">
                  {stats.recentFailures.slice(0, 3).map((r) => (
                    <li key={`${r.namespace}/${r.name}`} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate"><StatusText tone="bad">Failed</StatusText> <span className="ml-1 text-content">{r.repo ?? r.pipeline}</span> <span className="text-content-subtle">{r.name}</span></span>
                      <span className="shrink-0 text-content-subtle">{formatRelative(new Date(r.createdAt).toISOString())}</span>
                    </li>
                  ))}
                </ul>
              )
              : null}
          </>
        )}
    </Panel>
  )
}

/* ─────────── reliability ─────────── */

function Reliability({ dora, scopeMatches, scoped }: { dora: ReturnType<typeof useDora>; scopeMatches(p: string): boolean; scoped: boolean }) {
  const slos = useSlos()
  const alerts = useFiringAlerts()
  const inScope = (alerts.data ?? []).filter((a) => {
    const p = projectOfNamespace(a.namespace)
    return !scoped || (p !== PLATFORM && scopeMatches(p))
  })
  const crit = inScope.filter((a) => /critical|page/.test(a.severity)).length
  const warn = inScope.filter((a) => a.severity === 'warning').length
  const sloList = [...(slos.data ?? [])].sort((a, b) => (a.budgetLeft ?? 9) - (b.budgetLeft ?? 9))
  const breached = sloList.filter((s) => s.status === 'breached').length
  const atRisk = sloList.filter((s) => s.status === 'at-risk').length
  return (
    <Panel
      title="Reliability"
      sub="SLO error budgets (Discover SLOs, evaluated on Prometheus) and alerts firing now."
      actions={<DLink href={phaseHref('discover', 'slos')} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">SLOs →</DLink>}
    >
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Mini label="SLOs" value={slos.data ? String(sloList.length) : '—'} sub={slos.data ? `${breached} breached · ${atRisk} at risk` : slos.error ? 'not available' : 'loading…'} href={phaseHref('discover', 'slos')} />
        <Mini label="Critical alerts" value={alerts.data ? String(crit) : '—'} sub={alerts.data ? 'firing now' : alerts.error ? 'Prometheus unreachable' : 'loading…'} href={phaseHref('discover', 'alerts')} />
        <Mini label="Warnings" value={alerts.data ? String(warn) : '—'} sub={alerts.data ? 'firing now' : alerts.error ? 'Prometheus unreachable' : 'loading…'} href={phaseHref('discover', 'alerts')} />
        <Mini
          label="Open failures"
          value={dora.loading || dora.noSources ? '—' : String(dora.openIncidents.length)}
          sub={dora.noSources ? 'no deploy record' : 'deploys / alerts'}
          href={decideHref('dora', { tab: 'open' })}
        />
      </div>
      {slos.error && !slos.data
        ? <SourceNote>SLO definitions live in the console document store (<code>discover.slo</code>), which did not answer.</SourceNote>
        : sloList.length
        ? (
          <ul className="space-y-2">
            {sloList.slice(0, 5).map((s) => (
              <li key={s.def.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="block truncate text-content">{s.def.name}</span>
                  <span className="text-[11px] text-content-subtle">{s.def.service} · {s.def.objective}% over {s.def.windowDays}d</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-xs tabular-nums text-content">
                    {s.budgetLeft == null
                      ? '—'
                      : s.budgetLeft < 0
                      ? `budget overspent ${(1 - s.budgetLeft).toFixed(1)}×`
                      : `${Math.round(s.budgetLeft * 100)}% budget left`}
                  </span>
                  <StatusText tone={s.status === 'breached' ? 'bad' : s.status === 'at-risk' ? 'warn' : s.status === 'healthy' ? 'good' : 'neutral'}>
                    {s.status === 'breached' ? 'Breached' : s.status === 'at-risk' ? 'At risk' : s.status === 'healthy' ? 'Healthy' : 'No data'}
                  </StatusText>
                </span>
              </li>
            ))}
          </ul>
        )
        : slos.isLoading
        ? <Skeleton height={80} />
        : <p className="py-3 text-center text-xs text-content-subtle">No SLOs defined yet — define them in Discover → SLOs to track error budgets here.</p>}
    </Panel>
  )
}

/* ─────────── cost ─────────── */

function Cost({ scope }: { scope: ReturnType<typeof useDecideScope> }) {
  const color = useSeriesColor()
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000
  const ms = monthStart(now)
  const prevStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1)
  const daily = useDailySpend(prevStart, now)
  const mtd = useAllocation('namespace', ms, now)
  const budgets = useBudgets()
  const keep = scope.inScope ? (ns: string) => {
    const p = projectOfNamespace(ns)
    return p !== PLATFORM && scope.matches(p)
  } : null
  const days = useMemo(() => scopeDays(daily.data ?? [], keep), [daily.data, scope])
  const forecast = forecastMonth(days, now)
  const clusterForecast = forecastMonth(daily.data ?? [], now)
  const prev = prevSamePeriod(days, now)
  const nsRows = (mtd.data?.rows ?? []).filter((r) => !keep || keep(r.key))
  const byProject = regroup(nsRows, (r) => [projectOfNamespace(r.key)]).slice(0, 5)
  const total = nsRows.reduce((s, r) => s + r.total, 0)
  const idle = scope.inScope ? null : mtd.data?.idle ?? null
  const overBudgets = (budgets.data ?? []).filter((b) => {
    const rows = mtd.data?.rows ?? []
    const spent = b.scope === 'total'
      ? clusterForecast?.mtd ?? null
      : rows.filter((r) => (b.scope === 'namespace' ? r.key === b.target : b.scope === 'project' ? projectOfNamespace(r.key) === b.target : scope.teamsOf(projectOfNamespace(r.key)).includes(b.target)))
        .reduce((s, r) => s + r.total, 0)
    const fc = b.scope === 'total' ? clusterForecast?.forecast ?? null : spent == null ? null : scaleForecast(spent, clusterForecast)
    const st = evaluateBudget(b, mtd.data ? spent : null, fc).status
    return st === 'over' || st === 'forecast-over'
  })
  const spendHref = decideHref('spend', { project: scope.project || undefined })
  const mtdVal = forecast?.mtd ?? (days.length ? days.filter((d) => d.day >= ms).reduce((s, d) => s + d.total, 0) : null)
  const delta = mtdVal != null && prev.covered && prev.total > 0 ? (mtdVal - prev.total) / prev.total : null
  return (
    <Panel
      title="Cost"
      sub="OpenCost allocation, this calendar month."
      actions={<DLink href={spendHref} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">Spend →</DLink>}
    >
      {daily.error && !daily.data
        ? <SourceNote tone="warn">OpenCost is not reachable through <code>/api/svc/opencost</code> ({(daily.error as Error).message}). No spend is shown until it answers.</SourceNote>
        : daily.isLoading
        ? <Skeleton height={180} />
        : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Mini label="Month to date" value={formatUsd(mtdVal)} sub={delta == null ? 'no prior month data' : `${formatDeltaPct(delta)} vs same days`} href={spendHref} />
              <Mini label="Forecast" value={formatUsd(forecast?.forecast)} sub={forecast ? `${formatUsd(forecast.runRate, { precise: true })}/day run-rate` : 'after one full day'} href={spendHref} />
              <Mini label="Last month" value={prev.covered ? formatUsd(prev.full) : '—'} sub="full month" />
              <Mini
                label={idle == null ? 'Budgets over' : 'Idle'}
                value={idle == null ? String(overBudgets.length) : `${total + idle > 0 ? Math.round((idle / (total + idle)) * 100) : 0}%`}
                sub={idle == null ? 'or forecast over' : `${formatUsd(idle)} unrequested`}
                href={decideHref('spend', { project: scope.project || undefined })}
              />
            </div>
            {overBudgets.length && idle != null
              ? (
                <div className="mb-3">
                  <StatusText tone="bad">{overBudgets.length} {overBudgets.length === 1 ? 'budget' : 'budgets'} over or forecast over</StatusText>
                  <span className="ml-2 text-xs text-content-muted">{overBudgets.map((b) => b.name).join(', ')}</span>
                </div>
              )
              : null}
            <div className="mb-1 text-[11px] font-medium text-content-muted">Top cost drivers this month</div>
            <RankBars
              rows={byProject.map((r) => ({
                key: r.key,
                label: r.key,
                value: r.total,
                sub: total ? `${((r.total / total) * 100).toFixed(0)}% · efficiency ${r.efficiency == null ? '—' : `${Math.round(r.efficiency * 100)}%`}` : undefined,
                href: r.key === PLATFORM ? decideHref('spend', { dim: 'namespace' }) : decideHref('spend', { project: r.key }),
              }))}
              format={(v) => formatUsd(v, { precise: true })}
              color={color(0)}
              empty="No allocation this month."
            />
          </>
        )}
    </Panel>
  )
}

/* ─────────── adoption ─────────── */

function Adoption({ scope }: { scope: ReturnType<typeof useDecideScope> }) {
  const teams = useWorkspaceTeams()
  const repos = useOrgRepos()
  const apps = useArgoApps()
  const stages = useStages()
  const appCount = useMemo(() => {
    const names = new Set<string>()
    for (const a of apps.data ?? []) {
      const project = argoProjectOf(a, scope.refs)
      if (scope.inScope && !(project && scope.matches(project))) continue
      names.add(`${project}/${a.metadata.labels?.['adhar.io/application'] ?? a.metadata.name}`)
    }
    return names.size
  }, [apps.data, scope])
  const chains = new Set((stages.data ?? []).map((s) => s.project).filter((p) => p && scope.matches(p))).size
  const live = (repos.data ?? []).filter((r) => !r.archived && !r.mirror)
  const golden = live.filter((r) => (r.topics ?? []).includes('golden-path')).length
  const recent = live.filter((r) => Date.now() - Date.parse(r.updated_at) < 30 * 86_400_000).length
  return (
    <Panel title="Platform adoption" sub="What the organization runs on the platform today.">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Mini label="Projects" value={scope.ready ? String(scope.projects.length) : '—'} sub={scope.filtering ? `of ${scope.total} in the org` : 'in the organization'} href={phaseHref('define', 'projects')} />
        <Mini label="Teams" value={teams.data ? String(teams.data.length) : '—'} sub={teams.error ? 'workspace unavailable' : 'in the organization'} />
        <Mini label="Applications" value={apps.data ? String(appCount) : '—'} sub={apps.error ? 'Argo CD unreachable' : 'deployed via Argo CD'} href={phaseHref('deliver', 'apps')} />
        <Mini label="Repositories" value={repos.data ? String(live.length) : '—'} sub={repos.error ? 'Gitea unreachable' : `${recent} active in 30d`} href={phaseHref('develop', 'repos')} />
        <Mini
          label="Golden-path repos"
          value={repos.data ? String(golden) : '—'}
          sub={repos.data && live.length ? `${Math.round((golden / live.length) * 100)}% of repos` : 'topic golden-path'}
        />
        <Mini
          label="Kargo pipelines"
          value={stages.data ? String(chains) : '—'}
          sub={stages.error ? 'Kargo not reachable' : 'projects with a promotion chain'}
          href={phaseHref('deliver', 'stages')}
        />
      </div>
    </Panel>
  )
}

/* ─────────── BI ─────────── */

function BiHighlights() {
  const bi = useBiHighlights()
  return (
    <Panel
      title="Business intelligence"
      sub="Most-viewed Metabase dashboards and headline numbers."
      actions={<DLink href={decideHref('dashboards')} className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">BI dashboards →</DLink>}
    >
      {bi.error && !bi.data
        ? <SourceNote>Metabase is not connected (<code>/api/svc/metabase</code>), so there is nothing to highlight.</SourceNote>
        : bi.isLoading
        ? <Skeleton height={140} />
        : !bi.data?.totalDashboards && !bi.data?.scalars.length
        ? <p className="py-3 text-center text-xs text-content-subtle">Metabase is connected but has no dashboards yet.</p>
        : (
          <div className="space-y-3">
            {bi.data!.scalars.length
              ? (
                <div className="grid grid-cols-2 gap-2">
                  {bi.data!.scalars.map((q) => <Scalar key={q.id} q={q} />)}
                </div>
              )
              : null}
            <ul className="divide-y divide-edge-default">
              {bi.data!.dashboards.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <DLink href={decideHref('dashboards')} className="min-w-0 truncate text-content hover:underline">{d.name}</DLink>
                  <span className="shrink-0 text-xs text-content-subtle">{d.view_count ?? 0} views</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-content-subtle">{bi.data!.totalDashboards} dashboards · {bi.data!.totalQuestions ?? '—'} saved questions</p>
          </div>
        )}
    </Panel>
  )
}

function Scalar({ q }: { q: metabase.Question }) {
  const v = q.scalar ?? 0
  const unit = q.scalar_unit
  const text = unit === 'USD' ? formatUsd(v) : unit === '%' ? `${(v * 100).toFixed(1)}%` : `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}${unit ? ` ${unit}` : ''}`
  return (
    <DLink href={decideHref('questions')} className="block min-w-0 rounded-lg bg-surface-sunken/60 px-3 py-2 hover:bg-surface-sunken">
      <div className="truncate text-[11px] text-content-muted">{q.name}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-content">{text}</div>
      {q.scalar_delta != null ? <div className="text-[11px] text-content-subtle">{formatDeltaPct(q.scalar_delta)} vs prior</div> : null}
    </DLink>
  )
}
