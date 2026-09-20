import { useMemo } from 'react'
import {
  AreaChart,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  GrafanaIcon,
  Spinner,
  StatusBadge,
  useToolPublicUrl,
} from '@adhar-console/shell-ui'
import { cn, formatAbsolute } from '@adhar-console/utils'
import { type PerfTestConfig } from '../data/perf-format.ts'
import { type PanelSpec, panelsFor, usePerfPanels, usePrometheusReachable } from '../data/perf-metrics.ts'
import { type K6Summary } from '../data/k6-summary.ts'

/**
 * The report: what k6 measured, beside what the cluster was doing.
 *
 * The pairing is the whole point. k6 tells you the p95 doubled; it cannot
 * tell you the pods hit their CPU limit at the same moment. Both are drawn
 * over the SAME window at the SAME width, because lining the two up is how
 * "the latency knee is the throttling knee" becomes visible rather than
 * inferred.
 *
 * Nothing here is ever synthesised. A missing exporter produces a panel that
 * says the exporter is missing — a performance report that invents a number
 * is worse than one that admits a gap, because someone sizes a cluster from
 * it.
 */

const GROUP_LABEL: Record<PanelSpec['group'], string> = {
  workload: 'System under test',
  runners: 'Load generators',
  infrastructure: 'Infrastructure',
  database: 'Database',
}

const GROUP_BLURB: Record<PanelSpec['group'], string> = {
  workload: 'The pods this test drives. Where a latency change is usually explained.',
  runners: 'k6 itself. If these saturate, the test measured the load generator.',
  infrastructure: 'The nodes underneath. A busy neighbour lands here first.',
  database: 'Contention and connection pressure behind the service.',
}

export interface ReportWindow {
  startMs: number
  endMs: number
}

export function PerfReport({
  testName,
  config,
  summary,
  window,
  runnerSelector,
  runnerNamespace,
  commit,
}: {
  testName: string
  config: PerfTestConfig
  /** Parsed from the runner's stdout; absent while the run is in flight. */
  summary: K6Summary | null
  window: ReportWindow | null
  /** Regex matching this run's runner pods. */
  runnerSelector: string
  runnerNamespace: string
  commit?: string
}) {
  const panels = useMemo(
    () => panelsFor({ runnerNamespace, runnerSelector, target: config.target }),
    [runnerNamespace, runnerSelector, config.target],
  )
  const results = usePerfPanels(panels, window)
  const prom = usePrometheusReachable()
  const grafana = useToolPublicUrl('grafana')

  const grouped = useMemo(() => {
    const out = new Map<PanelSpec['group'], typeof results>()
    for (const r of results) {
      const list = out.get(r.panel.group)
      if (list) list.push(r)
      else out.set(r.panel.group, [r])
    }
    return [...out.entries()]
  }, [results])

  return (
    <div className="space-y-4">
      <Verdict summary={summary} testName={testName} commit={commit} window={window} />

      {summary?.complete ? <Headline summary={summary} /> : null}

      {!window
        ? (
          <Card>
            <CardBody>
              <EmptyState
                compact
                title="No window to chart yet"
                description="Cluster metrics are drawn over the run's own time range, which is known once the run has started."
              />
            </CardBody>
          </Card>
        )
        : prom.data && !prom.data.ok
        ? (
          <Card>
            <CardBody>
              <EmptyState
                compact
                title="Prometheus is not available"
                description={`${prom.data.reason} Without it the report can still show what k6 measured, but not what the cluster was doing while it did.`}
              />
            </CardBody>
          </Card>
        )
        : (
          <>
            {!config.target?.selector
              ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                  This test does not say which pods it drives, so the report shows the load generators and the
                  infrastructure but not the system under test. Set a target selector in the test's configuration —
                  the console will not guess which workload you meant.
                </div>
              )
              : null}

            {grouped.map(([group, items]) => (
              <Card key={group}>
                <CardHeader>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <div className="text-sm font-semibold text-content">{GROUP_LABEL[group]}</div>
                    <div className="text-[11px] text-content-muted">{GROUP_BLURB[group]}</div>
                    {group === 'database' && items.every((i) => i.data?.empty)
                      ? <span className="ml-auto text-[11px] text-content-subtle">no database exporter found</span>
                      : null}
                  </div>
                </CardHeader>
                <CardBody className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {items.map((r) => <Panel key={r.panel.id} {...r} />)}
                </CardBody>
              </Card>
            ))}
          </>
        )}

      {grafana && window
        ? (
          <Card>
            <CardBody className="flex flex-wrap items-center gap-3">
              <GrafanaIcon size={18} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-content">Keep digging in Grafana</div>
                <div className="text-[11px] text-content-muted">
                  The same window, with every dashboard and every metric this report does not draw.
                </div>
              </div>
              <a
                href={`${grafana.replace(/\/$/, '')}/?from=${window.startMs}&to=${window.endMs}`}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300"
              >
                Open ↗
              </a>
            </CardBody>
          </Card>
        )
        : null}
    </div>
  )
}

/* ─────────────────────────── verdict ─────────────────────────── */

function Verdict({
  summary,
  testName,
  commit,
  window,
}: {
  summary: K6Summary | null
  testName: string
  commit?: string
  window: ReportWindow | null
}) {
  const failed = summary?.thresholds.filter((t) => !t.passed) ?? []
  const passed = summary?.thresholds.filter((t) => t.passed) ?? []
  const verdict = !summary?.complete
    ? 'pending'
    : summary.thresholds.length === 0
    ? 'unjudged'
    : failed.length
    ? 'failed'
    : 'passed'

  return (
    <Card>
      <CardBody className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-content">{testName}</span>
            {verdict === 'passed' ? <StatusBadge kind="healthy">thresholds passed</StatusBadge> : null}
            {verdict === 'failed' ? <StatusBadge kind="failed">{failed.length} threshold{failed.length === 1 ? '' : 's'} failed</StatusBadge> : null}
            {verdict === 'unjudged' ? <StatusBadge kind="unknown">no thresholds</StatusBadge> : null}
            {verdict === 'pending' ? <StatusBadge kind="progressing">no summary yet</StatusBadge> : null}
            {commit
              ? <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">{commit.slice(0, 7)}</code>
              : null}
          </div>
          <p className="mt-1 text-[12px] text-content-muted">
            {verdict === 'passed'
              ? `Every threshold held${passed.length ? ` (${passed.length})` : ''}. The run is a pass.`
              : verdict === 'failed'
              ? `${failed.map((t) => `${t.metric} ${t.expression}`).join(', ')} — the run completed, and failed.`
              : verdict === 'unjudged'
              ? 'The script declares no thresholds, so this run measured rather than judged. Add a thresholds block to turn it into a gate.'
              : 'k6 prints its summary once, at the end. This fills in when the run completes.'}
          </p>
          {window
            ? (
              <div className="mt-1 text-[11px] text-content-subtle">
                {formatAbsolute(new Date(window.startMs).toISOString())} → {formatAbsolute(new Date(window.endMs).toISOString())}
              </div>
            )
            : null}
        </div>
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── headline ─────────────────────────── */

/** The four numbers people actually quote from a load test. */
function Headline({ summary }: { summary: K6Summary }) {
  const get = (name: string) => summary.metrics.find((m) => m.name === name)
  const reqs = get('http_reqs')
  const dur = get('http_req_duration')
  const failedRate = get('http_req_failed')

  const tiles = [
    { label: 'Requests', value: reqs?.raw.split(/\s+/)[0] ?? '—', sub: reqs?.raw.split(/\s+/)[1] ?? '' },
    { label: 'p95 latency', value: dur?.values['p(95)'] ?? '—', sub: dur?.values['avg'] ? `avg ${dur.values['avg']}` : '' },
    { label: 'Max latency', value: dur?.values['max'] ?? '—', sub: dur?.values['med'] ? `median ${dur.values['med']}` : '' },
    {
      label: 'Failed',
      value: failedRate?.raw.split(/\s+/)[0] ?? '—',
      sub: summary.checks ? `${summary.checks.failed} checks failed` : '',
      alarm: Boolean(summary.checks?.failed) || (failedRate?.raw.startsWith('0.00%') === false),
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label}>
          <CardBody className="space-y-0.5">
            <div className="text-[11px] uppercase tracking-wide text-content-subtle">{t.label}</div>
            <div
              className={cn(
                'font-mono text-xl font-semibold tabular-nums',
                t.alarm ? 'text-rose-600 dark:text-rose-400' : 'text-content',
              )}
            >
              {t.value}
            </div>
            <div className="truncate text-[11px] text-content-subtle">{t.sub}</div>
          </CardBody>
        </Card>
      ))}
    </div>
  )
}

/* ─────────────────────────── one panel ─────────────────────────── */

function Panel({
  panel,
  data,
  loading,
  error,
}: {
  panel: PanelSpec
  data?: { series: Array<{ label: string; points: Array<{ t: number; v: number }> }>; empty: boolean }
  loading: boolean
  error?: string
}) {
  // One line per series would be unreadable at eight pods; chart the series
  // with the highest peak and say how many others there are.
  const primary = useMemo(() => {
    if (!data?.series.length) return null
    return [...data.series].sort((a, b) => peak(b.points) - peak(a.points))[0]
  }, [data])

  return (
    <div className="rounded-lg border border-edge-default p-3">
      <div className="flex items-baseline gap-2">
        <div className="text-[12px] font-medium text-content">{panel.title}</div>
        <div className="ml-auto text-[10px] text-content-subtle">{panel.unit}</div>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-content-muted">{panel.hint}</p>

      <div className="mt-2">
        {loading
          ? <div className="flex h-30 items-center justify-center"><Spinner size={12} /></div>
          : error
          ? <div className="py-6 text-[11px] text-rose-600 dark:text-rose-400">{error}</div>
          : !primary
          ? (
            <div className="py-6 text-[11px] text-content-subtle">
              No data for this window — the metric is not being collected on this cluster.
            </div>
          )
          : (
            <>
              {/*
                `height` is a viewBox coordinate, not pixels: the svg is
                `width:100%` with a viewBox, so its rendered height is
                width × (height/320) — at this column width that made a
                "120" chart 250px tall and the page enormous. Constraining
                the svg in CSS fixes the rendered size, and
                `preserveAspectRatio="none"` means the drawing simply
                stretches to fill it.

                The axis carries the unit too — a bare `1.4e8` on a memory
                chart is a number nobody can act on.
              */}
              <AreaChart
                className="[&>svg]:h-28"
                points={primary.points.map((p) => ({ v: p.v, t: p.t }))}
                formatY={(v) => format(v, panel.unit)}
              />
              <div className="mt-1 flex items-baseline gap-2 text-[10px] text-content-subtle">
                <span className="truncate font-mono">{primary.label}</span>
                <span className="ml-auto shrink-0 tabular-nums">
                  peak {format(peak(primary.points), panel.unit)}
                </span>
                {data && data.series.length > 1
                  ? <span className="shrink-0">+{data.series.length - 1} more</span>
                  : null}
              </div>
            </>
          )}
      </div>
    </div>
  )
}

function peak(points: Array<{ v: number }>): number {
  return points.reduce((m, p) => (p.v > m ? p.v : m), 0)
}

/** Render a value in the panel's own unit — a raw float means little. */
function format(v: number, unit: string): string {
  if (unit === 'bytes') return bytes(v)
  if (unit === 'bytes/s') return `${bytes(v)}/s`
  if (unit === 'ratio') return `${(v * 100).toFixed(1)}%`
  if (unit === 'cores') return v < 1 ? `${(v * 1000).toFixed(0)}m` : v.toFixed(2)
  if (v >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 })
  return v.toFixed(v < 10 ? 2 : 0)
}

function bytes(v: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let n = v
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}
