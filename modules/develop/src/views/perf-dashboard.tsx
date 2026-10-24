import { useMemo, useState } from 'react'
import { Button, EmptyState, StatusBadge, useToast } from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import { isRunning, type TestRun } from '../data/k6.ts'
import { nextRuns } from '../data/perf-cron.ts'
import type { PerfInsights } from '../data/perf-automation.ts'
import { compareToBaseline, DEFAULT_TOLERANCE, trendPoints } from '../data/perf-gate.ts'
import { fmtMetric, type MetricKey, type RunRecord, sortRecords } from '../data/perf-results.ts'
import { LABEL_TEST } from '../data/perf-format.ts'
import { fetchPerfTest, findTest, useRunPerfTest } from '../data/perf-suite.ts'
import { RegressionBadge, TriggerBadge, VerdictBadge } from './perf-bits.tsx'
import { TrendsSection } from './perf-trends.tsx'
import { runPerfTestChecks, useAllowedNamespaces } from '../data/access.ts'

/**
 * The Performance Center's landing page: one row per test with its latest
 * verdict, the headline numbers against its baseline and a p95 trend, plus
 * what is running now, the latest results and what regressed. Every row is
 * a door — to the test, its results, a run, or straight into a new run.
 */
export function PerfDashboard({ insights, runs, onOpenTest, onOpenRun, onOpenResults, onQuickTest }: {
  insights: PerfInsights
  runs: TestRun[]
  onOpenTest(test: string): void
  onOpenRun(namespace: string, name: string): void
  onOpenResults(test?: string): void
  /** Absent when the user may not start runs anywhere — Quick test is hidden. */
  onQuickTest?: () => void
}) {
  const { records, tests, configs, schedules, verdictOf, loading } = insights
  const [nowMs] = useState(() => Date.now())
  // RBAC: "Run" applies the test's artefact ConfigMap and a TestRun in its namespace.
  const runnable = useAllowedNamespaces([...configs.values()].map((c) => c.namespace || 'default'), runPerfTestChecks)
  const byTest = useMemo(() => {
    const m = new Map<string, RunRecord[]>()
    for (const r of sortRecords(records)) {
      const arr = m.get(r.test) ?? []
      arr.push(r)
      m.set(r.test, arr)
    }
    return m
  }, [records])
  const nextByTest = useMemo(() => {
    const now = Date.now()
    const m = new Map<string, number>()
    for (const s of schedules) {
      if (s.suspend) continue
      const at = nextRuns(s.cron, now, 1, s.timeZone)[0]
      if (at !== undefined && (m.get(s.test) ?? Infinity) > at) m.set(s.test, at)
    }
    return m
  }, [schedules])
  const live = runs.filter(isRunning)
  const names = [...new Set([...tests, ...byTest.keys()])].sort()
  const recent = sortRecords(records).slice(0, 8)

  if (insights.recordsError != null && !records.length) {
    return (
      <EmptyState
        title="Couldn't read performance results"
        description={`Kept results live in ConfigMaps on the cluster, and listing them failed: ${
          insights.recordsError instanceof Error ? insights.recordsError.message : String(insights.recordsError)
        }`}
        action={<Button size="sm" variant="secondary" onClick={insights.refetchRecords}>Retry</Button>}
      />
    )
  }

  if (!names.length && !loading) {
    return (
      <EmptyState
        title="No performance tests yet"
        description={onQuickTest
          ? 'Build an HTTP load test in a minute with Quick test, or write a k6 script from a template in the Tests tab. Results, trends, gates and schedules appear here once tests run.'
          : 'Write a k6 script from a template in the Tests tab. Results, trends, gates and schedules appear here once tests run.'}
        action={onQuickTest ? <Button variant="primary" onClick={onQuickTest}>Quick test</Button> : undefined}
      />
    )
  }

  return (
    <div className="space-y-5">
      {live.length ? (
        <section className="rounded-xl border border-brand-300/60 bg-brand-50/40 p-3 dark:border-brand-500/30 dark:bg-brand-500/5">
          <h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-content">
            <span className="h-2 w-2 animate-pulse rounded-full bg-brand-500" /> Running now · {live.length}
          </h3>
          <div className="flex flex-wrap gap-2">
            {live.map((r) => (
              <button
                key={`${r.metadata.namespace}/${r.metadata.name}`}
                type="button"
                onClick={() => onOpenRun(r.metadata.namespace ?? '', r.metadata.name)}
                className="flex items-center gap-2 rounded-lg border border-edge-default bg-surface-raised px-3 py-1.5 text-left text-[12px] hover:border-brand-400"
              >
                <span className="font-medium text-content">{r.metadata.labels?.[LABEL_TEST] ?? r.metadata.name}</span>
                <StatusBadge kind="progressing">{r.status?.stage ?? 'starting'}</StatusBadge>
                <span className="text-content-subtle">{r.metadata.creationTimestamp ? formatRelative(r.metadata.creationTimestamp) : ''}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[12px] font-semibold text-content">Test health</h3>
          <span className="text-[11px] text-content-subtle">Latest run per test, against its pinned baseline · p95 trend over the kept runs</span>
        </div>
        <div className="overflow-x-auto rounded-xl border border-edge-default bg-surface-raised">
          <table className="w-full min-w-[56rem] text-left text-[12px]">
            <thead className="bg-surface-sunken/60 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
              <tr>
                <th className="px-3 py-2">Test</th>
                <th className="px-3 py-2">Latest verdict</th>
                <th className="px-3 py-2 text-right">p95</th>
                <th className="px-3 py-2 text-right">Errors</th>
                <th className="px-3 py-2 text-right">Throughput</th>
                <th className="px-3 py-2">vs baseline</th>
                <th className="px-3 py-2">p95 trend</th>
                <th className="px-3 py-2">Last run · next</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge-subtle">
              {names.map((t) => (
                <HealthRow
                  key={t}
                  test={t}
                  title={configs.get(t)?.title}
                  history={byTest.get(t) ?? []}
                  verdictOf={verdictOf}
                  baseline={configs.get(t)?.baseline}
                  tolerance={configs.get(t)?.gate?.tolerance}
                  next={nextByTest.get(t)}
                  running={live.some((r) => r.metadata.labels?.[LABEL_TEST] === t)}
                  inSuite={tests.includes(t)}
                  suite={insights.suite}
                  canRun={runnable.has(configs.get(t)?.namespace || 'default')}
                  onOpen={() => onOpenTest(t)}
                  onResults={() => onOpenResults(t)}
                  onStarted={onOpenRun}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <TrendsSection records={records} verdictOf={verdictOf} nowMs={nowMs} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[12px] font-semibold text-content">Latest results</h3>
            <button type="button" onClick={() => onOpenResults()} className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">All results →</button>
          </div>
          {recent.length ? (
            <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
              {recent.map((r) => (
                <li key={`${r.namespace}/${r.resultName}`}>
                  <button type="button" onClick={() => onOpenResults(r.test)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-[12px] hover:bg-surface-sunken/50">
                    <VerdictBadge verdict={verdictOf(r)} compact />
                    <span className="min-w-0 flex-1 truncate font-medium text-content">{r.test}</span>
                    <TriggerBadge trigger={r.trigger} schedule={r.schedule} />
                    <span className="w-16 text-right tabular-nums text-content-muted">{fmtMetric('p95Ms', r.metrics?.p95Ms)}</span>
                    <span className="w-20 text-right text-content-subtle" title={r.startedAt ? formatAbsolute(r.startedAt) : undefined}>{r.startedAt ? formatRelative(r.startedAt) : '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <EmptyState compact title="No results kept yet" description="Finished runs are kept automatically." />}
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-semibold text-content">Regressions</h3>
          {insights.overview.regressedTests.length ? (
            <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-rose-300/60 bg-surface-raised dark:border-rose-500/30">
              {insights.overview.regressedTests.map((t) => {
                const latest = byTest.get(t)?.[0]
                return (
                  <li key={t}>
                    <button type="button" onClick={() => onOpenResults(t)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-[12px] hover:bg-surface-sunken/50">
                      <span className="min-w-0 flex-1 truncate font-medium text-content">{t}</span>
                      {latest ? <RegressionBadge deltas={verdictOf(latest).regressions} /> : null}
                      <span className="text-content-subtle">{latest?.startedAt ? formatRelative(latest.startedAt) : ''}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="rounded-xl border border-edge-default bg-surface-raised px-4 py-6 text-center text-[12px] text-content-muted">
              No test's latest run is worse than its baseline.
              <div className="mt-1 text-[11px] text-content-subtle">Pin a baseline on a good run (Results) to start catching regressions.</div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function HealthRow({ test, title, history, verdictOf, baseline, tolerance, next, running, inSuite, suite, canRun, onOpen, onResults, onStarted }: {
  test: string
  title?: string
  history: RunRecord[]
  verdictOf: PerfInsights['verdictOf']
  baseline?: { metrics: Parameters<typeof compareToBaseline>[1]; run: string }
  tolerance?: Parameters<typeof compareToBaseline>[2]
  next?: number
  running: boolean
  inSuite: boolean
  suite: PerfInsights['suite']
  canRun: boolean
  onOpen(): void
  onResults(): void
  onStarted(namespace: string, name: string): void
}) {
  const latest = history[0]
  const verdict = latest ? verdictOf(latest) : undefined
  const deltas = latest && baseline ? compareToBaseline(latest.metrics, baseline.metrics, tolerance ?? DEFAULT_TOLERANCE) : []
  const regressed = deltas.filter((d) => d.regressed)
  const delta = (k: MetricKey) => deltas.find((d) => d.key === k)
  const runTest = useRunNow(suite)
  const where = findTest(suite, test)
  return (
    <tr className="align-middle hover:bg-surface-sunken/40">
      <td className="px-3 py-2">
        <button type="button" onClick={onOpen} disabled={!inSuite} className="text-left disabled:cursor-default">
          <div className="font-semibold text-content hover:text-brand-700 dark:hover:text-brand-300">{test}</div>
          {title && title.toLowerCase() !== test.replace(/-/g, ' ') ? <div className="text-[11px] text-content-subtle">{title}</div> : null}
          {where ? <div className="font-mono text-[10px] text-content-subtle">{where.repo}/{where.dir}</div> : null}
          {!inSuite ? <div className="text-[10px] text-amber-700 dark:text-amber-300">no longer in an application repo</div> : null}
        </button>
      </td>
      <td className="px-3 py-2">{running ? <StatusBadge kind="progressing">running</StatusBadge> : verdict ? <VerdictBadge verdict={verdict} compact /> : <span className="text-content-subtle">never run</span>}</td>
      <MetricCell k="p95Ms" v={latest?.metrics?.p95Ms} d={delta('p95Ms')?.deltaPct} />
      <MetricCell k="errorRatePct" v={latest?.metrics?.errorRatePct} />
      <MetricCell k="rps" v={latest?.metrics?.rps} d={delta('rps')?.deltaPct} higherIsBetter />
      <td className="px-3 py-2">{latest && baseline ? <RegressionBadge deltas={regressed} isBaseline={baseline.run === latest.run} /> : <span className="text-[11px] text-content-subtle">{latest ? 'no baseline' : '—'}</span>}</td>
      <td className="px-3 py-2"><Sparkline points={trendPoints(history, 'p95Ms').slice(-20)} baseline={baseline?.metrics?.p95Ms} /></td>
      <td className="px-3 py-2 text-[11px] text-content-muted">
        <div>{latest?.startedAt ? formatRelative(latest.startedAt) : '—'}</div>
        <div className="text-content-subtle">{next ? `next ${formatRelative(new Date(next).toISOString())}` : 'not scheduled'}</div>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex justify-end gap-1">
          <Button size="xs" variant="ghost" onClick={onResults} disabled={!history.length}>Results</Button>
          {canRun ? <Button size="xs" variant="secondary" disabled={!inSuite || running} loading={runTest.pending === test} onClick={() => runTest.run(test, onStarted)}>Run</Button> : null}
        </div>
      </td>
    </tr>
  )
}

function MetricCell({ k, v, d, higherIsBetter = false }: { k: MetricKey; v?: number; d?: number; higherIsBetter?: boolean }) {
  const worse = d !== undefined && (higherIsBetter ? d < -1 : d > 1)
  const better = d !== undefined && (higherIsBetter ? d > 1 : d < -1)
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      <div className="text-content">{v === undefined ? '—' : fmtMetric(k, v)}</div>
      {d !== undefined ? <div className={cn('text-[10px]', worse ? 'text-rose-600 dark:text-rose-400' : better ? 'text-emerald-600 dark:text-emerald-400' : 'text-content-subtle')}>{d > 0 ? '+' : ''}{d.toFixed(0)}%</div> : null}
    </td>
  )
}

/**
 * p95 over the kept runs — a single series, 2px line, latest point marked,
 * baseline as a dashed reference. Each point is a hover target.
 */
function Sparkline({ points, baseline }: { points: Array<[number, number]>; baseline?: number }) {
  const [hover, setHover] = useState<number | null>(null)
  if (points.length < 2) return <span className="text-[11px] text-content-subtle">{points.length ? '1 run' : '—'}</span>
  const W = 120, H = 30, pad = 4
  const vals = points.map((p) => p[1])
  const lo = Math.min(...vals, baseline ?? Infinity)
  const hi = Math.max(...vals, baseline ?? -Infinity)
  const span = hi - lo || 1
  const x = (i: number) => pad + (i / (points.length - 1)) * (W - pad * 2)
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  const hp = hover != null ? points[hover] : null
  return (
    <span className="relative inline-block">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`p95 trend: ${vals.map((v) => Math.round(v)).join(', ')} ms`} onMouseLeave={() => setHover(null)}>
        {baseline !== undefined ? <line x1={pad} x2={W - pad} y1={y(baseline)} y2={y(baseline)} className="stroke-content-subtle" strokeDasharray="2 3" strokeWidth={1} /> : null}
        <path d={d} fill="none" className="stroke-brand-600 dark:stroke-brand-400" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(points.length - 1)} cy={y(last[1])} r={3} className="fill-brand-600 stroke-surface-raised dark:fill-brand-400" strokeWidth={1.5} />
        {hp ? <circle cx={x(hover!)} cy={y(hp[1])} r={3} className="fill-surface-raised stroke-brand-600" strokeWidth={2} /> : null}
        {points.map((_, i) => (
          <rect key={i} x={x(i) - (W / points.length) / 2} y={0} width={W / points.length} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hp ? (
        <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-edge-default bg-surface-raised px-2 py-0.5 text-[10px] shadow-md">
          <b className="text-content">{fmtMetric('p95Ms', hp[1])}</b> <span className="text-content-subtle">{formatRelative(new Date(hp[0]).toISOString())}</span>
        </span>
      ) : null}
    </span>
  )
}

/** Run a test from its app repo's latest commit, without opening the editor. */
function useRunNow(suite: PerfInsights['suite']) {
  const run = useRunPerfTest()
  const toast = useToast()
  const [pending, setPending] = useState<string | null>(null)
  return {
    pending,
    run: async (name: string, onStarted: (ns: string, run: string) => void) => {
      if (!suite) return
      setPending(name)
      try {
        // The read carries the newest commit that touched the test's files.
        const test = await fetchPerfTest(suite, name)
        const created = await run.mutateAsync({ test })
        toast.success(`Started ${created.metadata.name}`)
        onStarted(created.metadata.namespace ?? test.config.namespace, created.metadata.name)
      } catch (e) {
        toast.error(`Could not start ${name}`, { description: e instanceof Error ? e.message : String(e) })
      } finally {
        setPending(null)
      }
    },
  }
}
