/**
 * The FINAL REPORT of one k6 run — the single model behind the drawer's
 * Report tab, the downloadable HTML and the PDF (perf-run-report-pdf.ts), so
 * the three can never disagree with each other or with the Results table.
 *
 * Built from whatever exists for the run:
 *
 *   • the kept result (RunRecord) — every finished run has one: the console
 *     harvests its own runs, the runner script harvests scheduled / CI runs;
 *   • the TestRun and its pods, while they still exist (lifecycle, plan,
 *     logs) — a scheduled run's TestRun is deleted once harvested, so the
 *     report never depends on it;
 *   • the gate verdict and baseline from test.json (git), computed by the same
 *     `evaluateGate` the Results table and the runner script use;
 *   • Prometheus series over the run window (perf-report-charts.ts).
 *
 * Every number is formatted by the same helpers the tables use (`fmtMetric`),
 * and a value that was never measured says so — an unrecorded p99 reads "not
 * recorded" with the reason, never a blank or a zero.
 *
 * Pure: model in, HTML string out. Every interpolated value is escaped.
 */

import { chartScale, clockUtc, escapeHtml, formatMetric, type MetricPoint, type MetricUnit, PHASE_COLOR, REPORT_CSS, REPORT_TONE_COLOR, reportPill, type ReportTone, segments } from '@adhar/utils'
import type { K6Metric, K6Summary } from './k6-summary.ts'
import type { LoadPlan } from './perf-plan.ts'
import { fmtMetric, fmtMs, missingNote, type MetricKey, P99_MISSING_NOTE, type RunMetrics, type RunRecord, type Trigger } from './perf-results.ts'
import { type BaselineMetrics, compareToBaseline, type GateVerdict, type MetricDelta, type Tolerance } from './perf-gate.ts'
import { fmtSecs, type Lifecycle, type PodDetail } from './perf-run-model.ts'
import type { LogGroup } from './perf-live.ts'

export { escapeHtml }

/* ─────────────────────────── charts (data) ─────────────────────────── */

export interface ReportChartSeries {
  label: string
  /** Hex — the report is a document, not a themed page. */
  color: string
  points: MetricPoint[]
  dashed?: boolean
}

export interface ReportChart {
  id: string
  title: string
  unit: MetricUnit
  /** Where the samples came from: `k6`, `target pods`, `load generators`. */
  source: string
  series: ReportChartSeries[]
  yMax?: number
}

export interface ReportCharts {
  /** Shared time axis, so the charts of one run line up. */
  domain: [number, number]
  /** The load window, shaded on every chart. */
  load?: { start: number; end: number }
  charts: ReportChart[]
  /** What could not be charted, and why. */
  missing: Array<{ label: string; reason: string }>
}

/* ─────────────────────────── input ─────────────────────────── */

export interface RunReportInput {
  run: string
  namespace: string
  test?: string
  application?: string
  commit?: string
  trigger?: Trigger
  schedule?: string
  resultName?: string
  startedAt?: string
  finishedAt?: string
  /** Final operator stage (`finished`, `error`, `stopped`, `timeout`, or a live one). */
  stage?: string
  exitCode?: number
  parallelism?: number
  /** Runner summaries the metrics were combined from. */
  runners?: number
  /** The TestRun's lifecycle, while it exists. */
  lifecycle?: Lifecycle
  plan?: LoadPlan
  summary?: K6Summary
  metrics?: RunMetrics
  /** The gate verdict — the one the Results table shows for this run. */
  verdict?: GateVerdict
  recordedVerdict?: 'pass' | 'fail'
  recordedReasons?: string
  baseline?: { run: string; metrics: BaselineMetrics; pinnedAt?: string }
  /** The kept run of the same test before this one. */
  previous?: { run: string; startedAt?: string; metrics?: RunMetrics }
  tolerance?: Tolerance
  config?: {
    arguments?: string
    env?: Array<{ name: string; value?: string; ref?: boolean }>
    image?: string
    script?: string
    target?: string
    quiet?: boolean
  }
  pods?: PodDetail[]
  logGroups?: LogGroup[]
  logExcerpt?: string[]
  charts?: ReportCharts
  link?: string
  generatedAt: Date
  generatedBy?: string
}

/* ─────────────────────────── model ─────────────────────────── */

export interface ReportKpi {
  label: string
  value: string
  note?: string
  tone?: ReportTone
}

export interface ReportLatency {
  label: string
  key: 'medMs' | 'p90Ms' | 'p95Ms' | 'p99Ms' | 'avgMs' | 'maxMs'
  value?: number
  text: string
  /** Why it is missing, when it is. */
  note?: string
}

export interface ReportComparisonRow {
  key: MetricKey
  label: string
  before: string
  now: string
  change?: string
  status: 'regressed' | 'improved' | 'within' | 'n/a'
}

export interface ReportComparison {
  title: string
  against: string
  when?: string
  rows: ReportComparisonRow[]
  regressed: number
}

export interface RunReport {
  title: string
  run: string
  namespace: string
  test?: string
  application?: string
  commit?: string
  trigger?: Trigger
  schedule?: string
  startedAt?: string
  finishedAt?: string
  durationSecs?: number
  verdict: { tone: ReportTone; label: string; headline: string; reasons: string[]; note?: string }
  kpis: ReportKpi[]
  latency: ReportLatency[]
  gate: Array<{ label: string; passed: boolean; detail: string }>
  thresholds: Array<{ metric: string; expression: string; state: 'pass' | 'fail' | 'pending'; actual?: string }>
  comparisons: ReportComparison[]
  timeline: Array<{ label: string; startMs?: number; endMs?: number; state: string; detail?: string }>
  config: Array<{ label: string; value: string; mono?: boolean }>
  environment: Array<{ name: string; value: string }>
  checks?: { passed: number; failed: number }
  metrics: K6Metric[]
  charts?: ReportCharts
  logs: Array<{ count?: number; level?: string; text: string }>
  notes: string[]
  hasResult: boolean
  link?: string
  generatedAt: Date
  generatedBy?: string
}

const LATENCY: Array<[ReportLatency['key'], string]> = [
  ['medMs', 'p50 (median)'],
  ['p90Ms', 'p90'],
  ['p95Ms', 'p95'],
  ['p99Ms', 'p99'],
  ['avgMs', 'Average'],
  ['maxMs', 'Max'],
]

const OUTCOME_VERDICT: Record<Lifecycle['outcome'], { tone: ReportTone; label: string }> = {
  'in-progress': { tone: 'none', label: 'In progress' },
  passed: { tone: 'good', label: 'Passed' },
  'thresholds-failed': { tone: 'bad', label: 'Thresholds failed' },
  failed: { tone: 'bad', label: 'Failed' },
  aborted: { tone: 'warn', label: 'Aborted' },
  unknown: { tone: 'none', label: 'Finished' },
}

const TERMINAL_BAD = new Set(['error', 'stopped', 'timeout'])

/** Env values that look like credentials are masked in a report people forward. */
const SECRETISH = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH)/i

const ms = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : undefined
}

export const fmtUtc = (t: number | string | undefined): string => {
  const v = typeof t === 'string' ? ms(t) : t
  return v === undefined ? '—' : new Date(v).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

const fmtCount = (n: number | undefined) => (n === undefined ? '—' : n >= 10_000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100))

function comparison(title: string, against: string, when: string | undefined, current: RunMetrics | undefined, before: BaselineMetrics | RunMetrics | undefined, tolerance?: Tolerance): ReportComparison {
  const deltas: MetricDelta[] = compareToBaseline(current, before as BaselineMetrics, tolerance)
  const rows = deltas.map((d): ReportComparisonRow => ({
    key: d.key,
    label: d.label,
    before: before ? fmtMetricOfAny(d.key, before) : '—',
    now: fmtMetricOfAny(d.key, current),
    change: d.deltaPct !== undefined ? `${d.deltaPct > 0 ? '+' : ''}${d.deltaPct.toFixed(Math.abs(d.deltaPct) < 10 ? 1 : 0)}%` : d.delta !== undefined && d.key === 'errorRatePct' ? `${d.delta > 0 ? '+' : ''}${d.delta.toFixed(2)} pts` : undefined,
    status: d.current === undefined || d.baseline === undefined ? 'n/a' : d.regressed ? 'regressed' : d.improved ? 'improved' : 'within',
  }))
  return { title, against, when, rows, regressed: rows.filter((r) => r.status === 'regressed').length }
}

function fmtMetricOfAny(key: MetricKey, m: Partial<Record<MetricKey, number>> | undefined): string {
  return missingNote(key, m) ? 'not recorded' : fmtMetric(key, m?.[key])
}

/** The report model. Pure; every view and both downloads render this. */
export function buildRunReport(i: RunReportInput): RunReport {
  const m = i.metrics
  const lc = i.lifecycle
  const startMs = lc?.loadStartMs ?? lc?.createdMs ?? ms(i.startedAt)
  const endMs = lc?.loadEndMs ?? lc?.endMs ?? ms(i.finishedAt)
  const durationSecs = startMs !== undefined && endMs !== undefined && endMs >= startMs ? Math.round((endMs - startMs) / 1000) : undefined
  const running = lc?.running ?? false

  // ── verdict ──
  let tone: ReportTone
  let label: string
  const reasons: string[] = []
  if (running) {
    tone = 'none'
    label = 'In progress'
  } else if (i.verdict && i.verdict.status !== 'no-data') {
    const regressed = i.verdict.regressions.length
    tone = i.verdict.status === 'pass' ? (regressed ? 'warn' : 'good') : 'bad'
    label = i.verdict.status === 'pass' ? (regressed ? 'Passed · regressed' : 'Passed') : 'Failed'
    for (const f of i.verdict.failures) reasons.push(`${f.label}: ${f.detail}`)
    if (i.verdict.status === 'pass') for (const d of i.verdict.regressions) reasons.push(`${d.label} regressed: ${fmtMetric(d.key, d.current)} vs baseline ${fmtMetric(d.key, d.baseline)} (not gating)`)
  } else if (i.stage && TERMINAL_BAD.has(i.stage)) {
    tone = 'bad'
    label = i.stage === 'stopped' ? 'Stopped' : i.stage === 'timeout' ? 'Timed out' : 'Failed'
    reasons.push(lc?.outcomeDetail ?? `the run ended in stage “${i.stage}” without an end-of-test summary`)
  } else if (lc) {
    ;({ tone, label } = OUTCOME_VERDICT[lc.outcome])
    if (lc.outcomeDetail) reasons.push(lc.outcomeDetail)
  } else {
    tone = 'none'
    label = m ? 'Finished' : 'No result'
  }
  if (!m && !running && !reasons.length) reasons.push('k6 printed no end-of-test summary, so there is nothing to judge.')

  const bits = [
    m?.p95Ms !== undefined ? `p95 ${fmtMetric('p95Ms', m.p95Ms)}` : undefined,
    m ? (m.p99Ms !== undefined ? `p99 ${fmtMetric('p99Ms', m.p99Ms)}` : missingNote('p99Ms', m) ? 'p99 not recorded' : undefined) : undefined,
    m?.errorRatePct !== undefined ? `${fmtMetric('errorRatePct', m.errorRatePct)} failed requests` : undefined,
    m?.rps !== undefined ? `${fmtMetric('rps', m.rps)}` : undefined,
  ].filter(Boolean)
  const span = [durationSecs !== undefined ? `over ${fmtSecs(durationSecs)}` : undefined, m?.vusMax !== undefined ? `with up to ${m.vusMax} VUs` : undefined].filter(Boolean).join(' ')
  const headline = running
    ? 'The run is still generating load; the final numbers arrive with k6’s end-of-test summary.'
    : m
    ? `${label}. ${bits.join(', ')}${span ? ` ${span}` : ''}.`
    : `${label}. ${reasons[0] ?? ''}`.trim()
  const note = i.recordedVerdict && i.verdict && i.verdict.status !== 'no-data' && i.recordedVerdict !== i.verdict.status
    ? `The runner recorded “${i.recordedVerdict}” against the gate as it was when the run finished${i.recordedReasons ? ` (${i.recordedReasons})` : ''}; this report judges it against the gate in git now.`
    : undefined

  // ── KPIs ──
  const kpis: ReportKpi[] = m
    ? [
      { label: 'Throughput', value: fmtMetric('rps', m.rps), note: m.requests !== undefined ? `${fmtCount(m.requests)} requests` : 'no HTTP requests' },
      { label: 'p95 latency', value: fmtMetric('p95Ms', m.p95Ms), note: m.medMs !== undefined ? `median ${fmtMs(m.medMs)}` : undefined },
      { label: 'p99 latency', value: fmtMetricOfAny('p99Ms', m), note: missingNote('p99Ms', m) ? 'k6 was not asked for it' : m.maxMs !== undefined ? `max ${fmtMs(m.maxMs)}` : undefined, tone: missingNote('p99Ms', m) ? 'none' : undefined },
      { label: 'Failed requests', value: fmtMetric('errorRatePct', m.errorRatePct), tone: m.errorRatePct === undefined ? undefined : m.errorRatePct >= 1 ? 'bad' : 'good', note: 'http_req_failed' },
      { label: 'Checks passed', value: fmtMetric('checksPct', m.checksPct), tone: m.checksPct === undefined ? undefined : m.checksPct >= 99 ? 'good' : 'bad', note: i.summary?.checks ? `${fmtCount(i.summary.checks.passed)} of ${fmtCount(i.summary.checks.passed + i.summary.checks.failed)}` : 'no checks in the script' },
      { label: 'Peak VUs', value: m.vusMax !== undefined ? String(m.vusMax) : '—', note: i.plan?.maxVus !== undefined ? `planned ${i.plan.maxVus}` : undefined },
      { label: 'Iterations', value: fmtCount(m.iterations), note: 'completed' },
      { label: 'Duration', value: durationSecs !== undefined ? fmtSecs(durationSecs) : '—', note: i.plan?.totalSecs !== undefined ? `planned ${i.plan.totalIsUpperBound ? '≤ ' : ''}${fmtSecs(i.plan.totalSecs)}` : undefined },
    ]
    : []

  const latency: ReportLatency[] = m
    ? LATENCY.map(([key, label]) => {
      const note = key === 'p99Ms' ? missingNote('p99Ms', m) : undefined
      return { key, label, value: m[key], text: m[key] !== undefined ? fmtMs(m[key]!) : note ? 'not recorded' : '—', note }
    })
    : []

  // ── thresholds: final results win, declared ones are pending ──
  const final = i.summary?.thresholds ?? []
  const thresholds = final.length
    ? final.map((t) => ({ metric: t.metric, expression: t.expression, state: t.passed ? 'pass' as const : 'fail' as const, actual: t.actual }))
    : (i.plan?.thresholds ?? []).map((t) => ({ metric: t.metric, expression: t.expression, state: 'pending' as const }))

  // ── comparisons ──
  const comparisons: ReportComparison[] = []
  if (m && i.baseline && i.baseline.run !== i.run) {
    comparisons.push(comparison('Against the baseline', i.baseline.run, i.baseline.pinnedAt ? `pinned ${fmtUtc(i.baseline.pinnedAt)}` : undefined, m, i.baseline.metrics, i.tolerance))
  }
  if (m && i.previous?.metrics && i.previous.run !== i.baseline?.run) {
    comparisons.push(comparison('Against the previous run', i.previous.run, i.previous.startedAt ? fmtUtc(i.previous.startedAt) : undefined, m, i.previous.metrics, i.tolerance))
  }

  // ── timeline ──
  const timeline = lc?.phases.length
    ? lc.phases.map((p) => ({ label: p.label, startMs: p.startMs, endMs: p.endMs, state: p.state, detail: p.detail }))
    : startMs !== undefined
    ? [{ label: 'Run', startMs, endMs, state: tone === 'bad' ? 'failed' : 'done', detail: i.stage ? `ended in stage ${i.stage}` : undefined }]
    : []

  // ── configuration & environment ──
  const c = i.config ?? {}
  const config: RunReport['config'] = [
    { label: 'Test', value: i.test ?? '—' },
    { label: 'Run', value: `${i.namespace}/${i.run}`, mono: true },
    ...(i.application ? [{ label: 'Application', value: i.application }] : []),
    ...(c.target ? [{ label: 'Target', value: c.target, mono: true }] : []),
    { label: 'Trigger', value: i.trigger ? `${i.trigger === 'ci' ? 'CI' : i.trigger}${i.schedule ? ` (${i.schedule})` : ''}` : '—' },
    { label: 'Commit', value: i.commit ? i.commit.slice(0, 12) : '—', mono: Boolean(i.commit) },
    { label: 'Started', value: fmtUtc(i.startedAt ?? startMs) },
    { label: 'Finished', value: running ? 'still running' : fmtUtc(i.finishedAt ?? endMs) },
    { label: 'Runners', value: String(i.parallelism ?? i.runners ?? 1) },
    { label: 'Planned load', value: planText(i.plan) },
    ...(c.script ? [{ label: 'Script', value: c.script, mono: true }] : []),
    { label: 'Arguments', value: c.arguments || 'none', mono: Boolean(c.arguments) },
    ...(c.image ? [{ label: 'k6 image', value: c.image, mono: true }] : []),
    { label: 'Final stage', value: i.stage ?? '—' },
    { label: 'Runner exit code', value: i.exitCode === undefined ? '—' : `${i.exitCode}${i.exitCode === 99 ? ' (thresholds crossed)' : ''}` },
    ...(i.resultName ? [{ label: 'Kept result', value: `${i.namespace}/${i.resultName}`, mono: true }] : []),
  ]
  const environment = (c.env ?? []).map((e) => ({ name: e.name, value: e.ref ? '(from a reference)' : SECRETISH.test(e.name) ? '••••••' : e.value ?? '' }))

  // ── logs: counted groups from the live stream, else the kept error lines ──
  const failedRun = tone === 'bad' || tone === 'warn'
  const logs = i.logGroups?.length
    ? i.logGroups.slice(0, 10).map((g) => ({ count: g.count, level: g.level, text: g.detail && g.detail !== g.msg ? `${g.msg} — ${g.detail}` : g.msg }))
    : failedRun || !m
    ? (i.logExcerpt ?? []).map((text) => ({ level: 'error', text }))
    : []

  const notes: string[] = []
  if ((i.runners ?? 1) > 1) notes.push(`Combined from ${i.runners} runners: throughput and counts are summed, the error rate is weighted by requests, and each percentile is the worst runner’s.`)
  if (m && missingNote('p99Ms', m)) notes.push(`p99 not recorded: ${P99_MISSING_NOTE}`)

  return {
    title: i.test ?? i.run,
    run: i.run,
    namespace: i.namespace,
    test: i.test,
    application: i.application,
    commit: i.commit,
    trigger: i.trigger,
    schedule: i.schedule,
    startedAt: i.startedAt ?? (startMs !== undefined ? new Date(startMs).toISOString() : undefined),
    finishedAt: running ? undefined : i.finishedAt ?? (endMs !== undefined ? new Date(endMs).toISOString() : undefined),
    durationSecs,
    verdict: { tone, label, headline, reasons, note },
    kpis,
    latency,
    gate: (i.verdict?.checks ?? []).map((g) => ({ label: g.label, passed: g.passed, detail: g.detail })),
    thresholds,
    comparisons,
    timeline,
    config,
    environment,
    checks: i.summary?.checks,
    metrics: i.summary?.metrics ?? [],
    charts: i.charts,
    logs,
    notes,
    hasResult: Boolean(m),
    link: i.link,
    generatedAt: i.generatedAt,
    generatedBy: i.generatedBy,
  }
}

function planText(plan: LoadPlan | undefined): string {
  if (!plan || plan.source === 'none') return plan?.note ?? 'unknown'
  return [
    plan.totalSecs !== undefined ? `${plan.totalIsUpperBound ? 'up to ' : ''}${fmtSecs(plan.totalSecs)}` : undefined,
    plan.maxVus !== undefined ? `peak ${plan.maxVus} VUs` : undefined,
    plan.scenarios.length > 1 ? `${plan.scenarios.length} scenarios` : plan.scenarios[0]?.executor,
  ].filter(Boolean).join(' · ') || 'unknown'
}

/** The input a kept result alone gives — what a scheduled run whose TestRun is gone has. */
export function inputFromRecord(r: RunRecord): Omit<RunReportInput, 'generatedAt'> {
  return {
    run: r.run,
    namespace: r.namespace,
    test: r.test,
    application: r.application,
    commit: r.commit,
    trigger: r.trigger,
    schedule: r.schedule,
    resultName: r.resultName,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    stage: r.stage,
    exitCode: r.exitCode,
    parallelism: r.parallelism,
    runners: r.runners,
    summary: r.summary,
    metrics: r.metrics,
    recordedVerdict: r.recordedVerdict,
    recordedReasons: r.recordedReasons,
    logExcerpt: r.logExcerpt,
  }
}

/** The kept run of the same test that started before `r` — the "previous run" comparison. */
export function previousRecord(r: { run: string; test?: string; namespace: string; startedAt?: string }, records: RunRecord[]): RunRecord | undefined {
  return records
    .filter((x) => x.test === r.test && x.namespace === r.namespace && x.run !== r.run && x.metrics && (x.startedAt ?? '') < (r.startedAt ?? '￿'))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0]
}

export const reportFileName = (r: Pick<RunReport, 'run'>, ext: 'html' | 'pdf') => `${r.run}-report.${ext}`

/* ─────────────────────────── charts (SVG) ─────────────────────────── */

/**
 * One chart as inline SVG: the load window shaded, gridlines labelled in the
 * chart's unit, one polyline per series, broken where samples are missing.
 * Uses the shared `chartScale`, so the PDF draws the same picture.
 */
export function chartSvg(c: ReportChart, domain: [number, number], load?: { start: number; end: number }): string {
  const W = 440
  const H = 160
  const frame = { width: W, height: H, pad: { l: 50, r: 10, t: 8, b: 20 } }
  const all = c.series.map((s) => s.points.filter(([t, v]) => t >= domain[0] && t <= domain[1] && Number.isFinite(v)))
  const sc = all.some((p) => p.length > 1) ? chartScale(all, frame, { domain, yMax: c.yMax }) : undefined
  if (!sc) return '<div class="none">No samples in the run window.</div>'
  const e = escapeHtml
  const band = load
    ? `<rect x="${sc.x(Math.max(load.start, domain[0])).toFixed(1)}" y="${frame.pad.t}" width="${Math.max(0.5, sc.x(Math.min(load.end, domain[1])) - sc.x(Math.max(load.start, domain[0]))).toFixed(1)}" height="${H - frame.pad.t - frame.pad.b}" fill="${PHASE_COLOR.load}" fill-opacity=".08"/>`
    : ''
  const grid = sc.yTicks.map((v, i) => `<line x1="${frame.pad.l}" x2="${W - frame.pad.r}" y1="${sc.y(v).toFixed(1)}" y2="${sc.y(v).toFixed(1)}" stroke="#e2e8f0" ${i ? 'stroke-dasharray="3 4"' : ''}/><text x="${frame.pad.l - 6}" y="${(sc.y(v) + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#94a3b8">${e(formatMetric(v, c.unit))}</text>`).join('')
  const xt = sc.xTicks.map((t, i) => `<text x="${sc.x(t).toFixed(1)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === sc.xTicks.length - 1 ? 'end' : 'middle'}" font-size="9.5" fill="#94a3b8">${clockUtc(t)}</text>`).join('')
  const lines = c.series.map((s, k) =>
    segments(all[k]).filter((g) => g.length > 1).map((g) =>
      `<path d="${g.map(([t, v], j) => `${j ? 'L' : 'M'}${sc.x(t).toFixed(1)},${sc.y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="4 3"' : ''}/>`
    ).join('')
  ).join('')
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${e(c.title)} over the run">${band}${grid}${lines}${xt}</svg>`
}

/** Peak (and last) of a chart's first series, for its caption. */
export function chartCaption(c: ReportChart): string {
  const parts = c.series.map((s) => {
    const vs = s.points.map((p) => p[1])
    if (!vs.length) return undefined
    return `${s.label} peak ${formatMetric(Math.max(...vs), c.unit)}`
  }).filter(Boolean)
  return parts.slice(0, 3).join(' · ')
}

/* ─────────────────────────── HTML ─────────────────────────── */

const STATE_TONE: Record<string, ReportTone> = { pass: 'good', fail: 'bad', pending: 'none' }

const EXTRA_CSS = `.cover .verdict{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:20px}
.cover .badge{display:inline-block;padding:5px 14px;border-radius:99px;font-weight:700;font-size:14px;color:#fff}
.cover .headline{font-size:14px;opacity:.95;max-width:720px}
.kpis.eight{grid-template-columns:repeat(4,minmax(0,1fr))}
.kpi .note{display:block;font-size:11px;color:var(--subtle);margin-top:2px}
.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.chart{border:1px solid var(--line);border-radius:12px;padding:10px 12px;break-inside:avoid}
.chart h4{margin:0;font-size:13px}.chart .cap{font-size:11px;color:var(--subtle);margin:1px 0 6px}
.chart svg{width:100%;height:auto;display:block}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--muted);margin-top:4px}.legend i{display:inline-block;width:10px;height:6px;border-radius:2px;margin-right:4px;vertical-align:middle}
.none{font-size:12px;color:var(--subtle);padding:24px 0;text-align:center}
.nr{color:var(--subtle);border-bottom:1px dotted var(--subtle);cursor:help}
ul.reasons{margin:8px 0 0;padding-left:18px;color:#334155;font-size:13px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
@media (max-width:720px){.kpis.eight{grid-template-columns:repeat(2,1fr)}.charts{grid-template-columns:1fr}}`

/** The final report as a standalone HTML document (light, printable, A4). */
export function runReportHtml(r: RunReport): string {
  const e = escapeHtml
  const color = REPORT_TONE_COLOR[r.verdict.tone]
  const nr = (text: string, note?: string) => (note ? `<span class="nr" title="${e(note)}">${e(text)}</span>` : e(text))
  const sec = (title: string, body: string) => `<section><h2>${e(title)}</h2>${body}</section>`
  const meta = [
    `run <code>${e(r.namespace)}/${e(r.run)}</code>`,
    r.application ? `application ${e(r.application)}` : '',
    r.commit ? `commit <code>${e(r.commit.slice(0, 12))}</code>` : '',
    r.trigger ? `${e(r.trigger === 'ci' ? 'CI' : r.trigger)}${r.schedule ? ` · ${e(r.schedule)}` : ''}` : '',
    r.startedAt ? e(fmtUtc(r.startedAt)) : '',
  ].filter(Boolean).join(' · ')

  const kpis = r.kpis.length
    ? `<div class="kpis eight">${r.kpis.map((k) => `<div class="kpi"><span>${e(k.label)}</span><b style="${k.tone && k.tone !== 'none' ? `color:${REPORT_TONE_COLOR[k.tone]}` : ''}">${k.value === 'not recorded' ? nr(k.value, P99_MISSING_NOTE) : e(k.value)}</b>${k.note ? `<span class="note">${e(k.note)}</span>` : ''}</div>`).join('')}</div>`
    : '<p class="note">No end-of-test summary was kept for this run, so there are no measurements.</p>'

  const latency = r.latency.length
    ? `<table><thead><tr>${r.latency.map((l) => `<th>${e(l.label)}</th>`).join('')}</tr></thead><tbody><tr>${r.latency.map((l) => `<td class="num">${nr(l.text, l.note)}</td>`).join('')}</tr></tbody></table>`
    : ''

  const gate = r.gate.length
    ? `<table><thead><tr><th>Check</th><th>Measured</th><th>Result</th></tr></thead><tbody>${r.gate.map((g) => `<tr><td>${e(g.label)}</td><td class="num">${e(g.detail)}</td><td>${reportPill(g.passed ? 'good' : 'bad', g.passed ? 'Pass' : 'Fail')}</td></tr>`).join('')}</tbody></table>`
    : ''
  const thresholds = r.thresholds.length
    ? `<h3>Script thresholds</h3><table><thead><tr><th>Metric</th><th>Rule</th><th>Measured</th><th>Result</th></tr></thead><tbody>${r.thresholds.map((t) => `<tr><td class="mono">${e(t.metric)}</td><td class="num">${e(t.expression)}</td><td class="num">${e(t.actual ?? '—')}</td><td>${reportPill(STATE_TONE[t.state], t.state === 'pass' ? 'Pass' : t.state === 'fail' ? 'Fail' : 'Not evaluated')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="note">The script declares no thresholds.</p>'

  const comparisons = r.comparisons.map((c) =>
    `<h3>${e(c.title)} <span class="muted">${e(c.against)}${c.when ? ` · ${e(c.when)}` : ''}</span></h3><table><thead><tr><th>Metric</th><th>Then</th><th>Now</th><th>Change</th><th>Status</th></tr></thead><tbody>${
      c.rows.map((x) => `<tr><td>${e(x.label)}</td><td class="num">${e(x.before)}</td><td class="num">${e(x.now)}</td><td class="num">${e(x.change ?? '—')}</td><td>${x.status === 'n/a' ? '<span class="muted">not comparable</span>' : reportPill(x.status === 'regressed' ? 'bad' : x.status === 'improved' ? 'good' : 'none', x.status === 'within' ? 'Within tolerance' : x.status === 'regressed' ? 'Regressed' : 'Improved')}</td></tr>`).join('')
    }</tbody></table>`
  ).join('')

  const charts = r.charts
    ? `${r.charts.charts.length ? `<div class="charts">${r.charts.charts.map((c) => `<div class="chart"><h4>${e(c.title)}</h4><div class="cap">${e(c.source)}${chartCaption(c) ? ` · ${e(chartCaption(c))}` : ''}</div>${chartSvg(c, r.charts!.domain, r.charts!.load)}${c.series.length > 1 ? `<div class="legend">${c.series.map((s) => `<span><i style="background:${s.color}"></i>${e(s.label)}</span>`).join('')}</div>` : ''}</div>`).join('')}</div>` : ''}${
      r.charts.missing.length ? `<p class="note">Not charted: ${r.charts.missing.map((x) => `${e(x.label)} — ${e(x.reason)}`).join('; ')}</p>` : ''
    }${r.charts.load ? `<p class="note">The shaded band is the load window. Times are UTC.</p>` : ''}`
    : ''

  const timeline = r.timeline.length
    ? `<table><thead><tr><th>Phase</th><th>Started</th><th>Took</th><th>Detail</th></tr></thead><tbody>${r.timeline.map((p) => `<tr><td>${e(p.label)}</td><td class="num">${e(fmtUtc(p.startMs))}</td><td class="num">${p.startMs !== undefined && p.endMs !== undefined ? e(fmtSecs((p.endMs - p.startMs) / 1000)) : '—'}</td><td>${e(p.detail ?? '')}</td></tr>`).join('')}</tbody></table>`
    : ''

  const config = `<table><tbody>${r.config.map((c) => `<tr><th style="width:30%">${e(c.label)}</th><td class="${c.mono ? 'mono' : ''}">${e(c.value)}</td></tr>`).join('')}</tbody></table>${
    r.environment.length ? `<h3>Runner environment</h3><table><tbody>${r.environment.map((v) => `<tr><th style="width:30%" class="mono">${e(v.name)}</th><td class="mono">${e(v.value)}</td></tr>`).join('')}</tbody></table>` : ''
  }`

  const logs = r.logs.length
    ? `<table><tbody>${r.logs.map((l) => `<tr><td class="num" style="width:90px">${l.count !== undefined ? `${e(l.count)} × ` : ''}${e(l.level ?? '')}</td><td class="mono">${e(l.text)}</td></tr>`).join('')}</tbody></table>`
    : ''

  const all = r.metrics.length
    ? `<table><tbody>${r.metrics.map((x) => `<tr><td class="mono" style="width:30%">${e(x.name)}</td><td class="mono">${e(x.raw)}</td></tr>`).join('')}</tbody></table>`
    : ''

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(r.title)} — performance run report</title>
<style>${REPORT_CSS}
${EXTRA_CSS}</style></head><body><div class="page">
<div class="cover"><div class="eyebrow">Adhar · Performance run report</div><h1>${e(r.title)}</h1><div class="meta">${meta}</div>
<div class="verdict"><span class="badge" style="background:${color}">${e(r.verdict.label)}</span><span class="headline">${e(r.verdict.headline)}</span></div></div>
<main>
${sec('Summary', `${kpis}${r.verdict.reasons.length ? `<ul class="reasons">${r.verdict.reasons.map((x) => `<li>${e(x)}</li>`).join('')}</ul>` : ''}${r.verdict.note ? `<p class="note">${e(r.verdict.note)}</p>` : ''}`)}
${r.latency.length ? sec('Latency percentiles', `${latency}<p class="note">http_req_duration over the whole run, from k6’s end-of-test summary.</p>`) : ''}
${sec('Gate and thresholds', `${gate || '<p class="note">No gate was evaluated for this run.</p>'}${thresholds}`)}
${r.comparisons.length ? sec('Comparison', comparisons) : ''}
${r.charts ? sec('During the run', charts) : ''}
${timeline ? sec('Timeline', timeline) : ''}
${sec('Environment and test configuration', config)}
${logs ? sec(r.logs[0]?.count !== undefined ? 'Most frequent warnings and errors' : 'Errors logged', logs) : ''}
${all ? sec('All k6 metrics', all) : ''}
${r.notes.length ? sec('Notes', r.notes.map((n) => `<p class="note">${e(n)}</p>`).join('')) : ''}
</main>
<footer><span>Generated ${e(fmtUtc(r.generatedAt.getTime()))}${r.generatedBy ? ` by ${e(r.generatedBy)}` : ''} · Adhar Performance Center</span>${r.link ? `<a href="${e(r.link)}">Open the run in the console</a>` : ''}</footer>
</div></body></html>`
}
