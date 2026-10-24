/**
 * Run metrics — the shape of "what the target did while we broke it".
 *
 * A chaos run is a window of time with phases inside it (a load test, then
 * each fault, then recovery). The evidence that the system survived is a set
 * of time series for the TARGET application over that window — request rate,
 * error rate, p95 latency, ready pods, restarts, CPU, memory — read with the
 * fault windows shaded on top, so a dip lines up with the fault that caused it.
 *
 * This module is shared by three consumers, which is why it lives here and is
 * pure (no React, no DOM, no fetch):
 *
 *   • the console's report recorder (BFF), which range-queries Prometheus when
 *     it freezes a run and stores compact, bounded series in the report;
 *   • the live run canvas in the Chaos page, which draws the same queries for
 *     a run in progress;
 *   • the HTML and PDF reports, which draw the stored series.
 *
 * Every query here may legitimately return nothing — an application that
 * exports no HTTP metrics, a cluster without kube-state-metrics. Callers say
 * so ("missing", with the reason) rather than drawing a zero.
 */

/** `[epoch ms, value]` */
export type MetricPoint = [number, number]

export type MetricUnit = 'rps' | 'percent' | 'ms' | 'count' | 'cores' | 'bytes'

export type MetricId = 'rps' | 'errors' | 'p95' | 'ready' | 'restarts' | 'cpu' | 'memory' | 'probe'

export interface MetricSeries {
  id: MetricId | string
  label: string
  unit: MetricUnit
  points: MetricPoint[]
}

export interface MissingMetric {
  id: MetricId | string
  label: string
  reason: string
}

export type PhaseKind = 'prepare' | 'load' | 'fault' | 'recovery' | 'pause' | 'revert'

/** One phase of a run on the wall clock. `end` is absent while it is still running. */
export interface PhaseWindow {
  kind: PhaseKind
  /** A fault id (`pod-delete`), `load-test`, or a step name. */
  name: string
  start: number
  end?: number
  /** passed | failed | error | running | … — the phase's own outcome when known. */
  status?: string
  probeSuccessPercentage?: number
  recoverySeconds?: number
  /** How long the fault was set to inject (the runner logs it as it starts). */
  plannedSeconds?: number
}

/** What the recorder stores with a report: bounded, compact, self-describing. */
export interface RunMetrics {
  /** Epoch ms of the queried range and its step in seconds. */
  window: { start: number; end: number; stepSeconds: number }
  series: MetricSeries[]
  missing?: MissingMetric[]
  /** The PromQL pod selector the series were read with, for the "how" note. */
  selector?: string
  capturedAt: string
  source: 'prometheus'
}

/** Max samples kept per stored series. 160 × 8 series is a few KB of JSON. */
export const MAX_POINTS = 160

/** Time added either side of a run when its metrics are captured. */
export const WINDOW_PAD_MS = 2 * 60_000

/* ─────────────────────────── catalogue ─────────────────────────── */

export interface MetricDef {
  id: MetricId
  label: string
  unit: MetricUnit
  /** Hex for reports (HTML/PDF); the live view maps ids to theme tokens. */
  color: string
  /** One line on what to look for in it during chaos. */
  hint: string
}

export const METRIC_DEFS: MetricDef[] = [
  { id: 'rps', label: 'Request rate', unit: 'rps', color: '#4f46e5', hint: 'Traffic the application served — a drop to zero is an outage.' },
  { id: 'errors', label: 'Error rate (5xx)', unit: 'percent', color: '#e11d48', hint: 'Share of responses that were server errors.' },
  { id: 'p95', label: 'p95 latency', unit: 'ms', color: '#d97706', hint: 'Slowest 5% of requests — where a degraded dependency shows first.' },
  { id: 'probe', label: 'Steady-state probe', unit: 'percent', color: '#0d9488', hint: 'Share of the steady-state probe’s polls that succeeded, per fault.' },
  { id: 'ready', label: 'Ready pods', unit: 'count', color: '#059669', hint: 'Pods passing readiness — recovery is this climbing back.' },
  { id: 'restarts', label: 'Container restarts', unit: 'count', color: '#ea580c', hint: 'Restarts since the window opened.' },
  { id: 'cpu', label: 'CPU', unit: 'cores', color: '#0284c7', hint: 'CPU used by the target pods, in cores.' },
  { id: 'memory', label: 'Memory', unit: 'bytes', color: '#7c3aed', hint: 'Working-set memory of the target pods.' },
]

export function metricDef(id: string): MetricDef | undefined {
  return METRIC_DEFS.find((d) => d.id === id)
}

/** Shading for a phase on a chart (hex, used at low opacity). */
export const PHASE_COLOR: Record<PhaseKind, string> = {
  prepare: '#94a3b8',
  load: '#6366f1',
  fault: '#e11d48',
  recovery: '#d97706',
  pause: '#94a3b8',
  revert: '#64748b',
}

/* ─────────────────────────── PromQL ─────────────────────────── */

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const labelValue = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * The pods of an application named `app`: `<app>-<hash>-<suffix>`, the shape a
 * Deployment's or Rollout's pods take — the same selector the resilience
 * runner itself measures SLOs with, so the report and the runner agree.
 */
export function podRegexForApp(app: string): string {
  return `${reEscape(app)}-[a-z0-9]+-[a-z0-9]+`
}

/**
 * A pod regex from pod names seen on the cluster: each pod's controller
 * prefix (name minus its pod-template-hash and random suffix, or minus the
 * ordinal) so replacements a fault causes are still matched.
 */
export function podRegexFromPods(pods: Array<{ name: string; templateHash?: string }>): string | undefined {
  const prefixes = new Set<string>()
  for (const p of pods) {
    if (!p.name) continue
    if (p.templateHash && p.name.includes(`-${p.templateHash}-`)) {
      prefixes.add(`${reEscape(p.name.slice(0, p.name.indexOf(`-${p.templateHash}-`)))}-[a-z0-9]+-[a-z0-9]+`)
    } else {
      const cut = p.name.lastIndexOf('-')
      prefixes.add(cut > 0 ? `${reEscape(p.name.slice(0, cut))}-[a-z0-9]+` : reEscape(p.name))
    }
  }
  if (!prefixes.size) return undefined
  const list = [...prefixes].sort()
  return list.length === 1 ? list[0] : `(${list.join('|')})`
}

export interface MetricQuery {
  id: MetricId
  query: string
}

const HTTP_COUNT = 'http_server_requests_seconds_count|http_requests_total'
const HTTP_BUCKET = 'http_server_requests_seconds_bucket|http_request_duration_seconds_bucket'

/**
 * The range queries for one target. `rate` is the rate window — at least four
 * scrape intervals and a little over the step, so a short fault is not
 * averaged away.
 */
export function runMetricQueries(input: { namespace: string; podRegex: string; rate?: string }): MetricQuery[] {
  const sel = `namespace="${labelValue(input.namespace)}",pod=~"${labelValue(input.podRegex)}"`
  const cs = `${sel},container!="",container!="POD"`
  const r = input.rate ?? '1m'
  const total = `sum(rate({__name__=~"${HTTP_COUNT}",${sel}}[${r}]))`
  const errors5xx = `(sum(rate(http_server_requests_seconds_count{${sel},status=~"5.."}[${r}])) or sum(rate(http_requests_total{${sel},code=~"5.."}[${r}])) or ${total} * 0)`
  return [
    { id: 'rps', query: total },
    { id: 'errors', query: `100 * ${errors5xx} / ${total}` },
    { id: 'p95', query: `1000 * histogram_quantile(0.95, sum by (le) (rate({__name__=~"${HTTP_BUCKET}",${sel}}[${r}])))` },
    { id: 'ready', query: `sum(kube_pod_status_ready{${sel},condition="true"})` },
    { id: 'restarts', query: `sum(kube_pod_container_status_restarts_total{${sel}})` },
    { id: 'cpu', query: `sum(rate(container_cpu_usage_seconds_total{${cs}}[${r}]))` },
    { id: 'memory', query: `sum(container_memory_working_set_bytes{${cs}})` },
  ]
}

/** Why a metric came back empty, in words an operator can act on. */
export function missingReason(id: string): string {
  switch (id) {
    case 'rps':
    case 'errors':
    case 'p95':
      return 'The application exports no HTTP request metrics (http_server_requests_seconds or http_requests_total) that Prometheus scrapes.'
    case 'ready':
    case 'restarts':
      return 'kube-state-metrics series for these pods were not found in Prometheus.'
    case 'cpu':
    case 'memory':
      return 'cAdvisor container metrics for these pods were not found in Prometheus.'
    case 'probe':
      return 'No fault recorded a steady-state probe result.'
    default:
      return 'Prometheus returned no samples.'
  }
}

/* ─────────────────────────── window + step ─────────────────────────── */

/**
 * The range to capture for a run: its start (or its earliest phase) to its
 * finish, padded either side so the steady state before and the recovery
 * after are on the chart. Undefined when the finish is not a time.
 */
export function captureWindow(input: { startedAt?: string; finishedAt: string; phases?: PhaseWindow[] }, pad = WINDOW_PAD_MS): { start: number; end: number } | undefined {
  const end = Date.parse(input.finishedAt)
  if (!Number.isFinite(end)) return undefined
  const starts = [Date.parse(input.startedAt ?? ''), ...(input.phases ?? []).map((p) => p.start)].filter((t) => Number.isFinite(t) && t <= end)
  // No start recorded: a suite run is minutes long; show the quarter hour before.
  const start = starts.length ? Math.min(...starts) : end - 15 * 60_000
  return { start: start - pad, end: end + pad }
}

/** A query step (s) giving at most `maxPoints` samples, never under `min`, in 5 s units. */
export function stepFor(startMs: number, endMs: number, maxPoints = MAX_POINTS - 10, min = 15): number {
  const span = Math.max(0, endMs - startMs) / 1000
  const raw = Math.ceil(span / Math.max(1, maxPoints))
  return Math.max(min, Math.ceil(raw / 5) * 5)
}

/** A rate window for a step: four steps, at least a minute. */
export function rateFor(stepSeconds: number): string {
  return `${Math.max(60, stepSeconds * 4)}s`
}

/* ─────────────────────────── shaping ─────────────────────────── */

/** Prometheus `matrix` values (`[sec, "str"]`) → finite, sorted `[ms, n]`. */
export function pointsFromMatrix(values: Array<[number, string]> | undefined): MetricPoint[] {
  const out: MetricPoint[] = []
  for (const [t, v] of values ?? []) {
    const n = Number(v)
    const ms = Number(t) * 1000
    if (Number.isFinite(n) && Number.isFinite(ms)) out.push([ms, n])
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** `v` to `digits` significant figures (keeps stored JSON short). */
export function roundSig(v: number, digits = 4): number {
  if (!Number.isFinite(v) || v === 0) return v === 0 ? 0 : v
  const p = Math.pow(10, digits - Math.ceil(Math.log10(Math.abs(v))))
  return Math.round(v * p) / p
}

/**
 * Largest-Triangle-Three-Buckets downsampling: keeps the shape (peaks and
 * troughs — the dip during a fault) where plain averaging would flatten it.
 */
export function downsample(points: MetricPoint[], max = MAX_POINTS): MetricPoint[] {
  if (max < 3 || points.length <= max) return points.slice()
  const out: MetricPoint[] = [points[0]]
  const every = (points.length - 2) / (max - 2)
  let a = 0
  for (let i = 0; i < max - 2; i++) {
    const s = Math.floor((i + 1) * every) + 1
    const e = Math.min(points.length, Math.floor((i + 2) * every) + 1)
    let ax = 0
    let ay = 0
    const n = Math.max(1, e - s)
    for (let j = s; j < e; j++) {
      ax += points[j][0]
      ay += points[j][1]
    }
    ax /= n
    ay /= n
    const rs = Math.floor(i * every) + 1
    const re = Math.floor((i + 1) * every) + 1
    let best = rs
    let area = -1
    for (let j = rs; j < re && j < points.length; j++) {
      const ar = Math.abs((points[a][0] - ax) * (points[j][1] - points[a][1]) - (points[a][0] - points[j][0]) * (ay - points[a][1]))
      if (ar > area) {
        area = ar
        best = j
      }
    }
    out.push(points[best])
    a = best
  }
  out.push(points[points.length - 1])
  return out
}

/** Sort, drop non-finite, downsample and round — the form a series is stored in. */
export function compactPoints(points: MetricPoint[], max = MAX_POINTS): MetricPoint[] {
  const clean = points.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)).sort((a, b) => a[0] - b[0])
  return downsample(clean, max).map(([t, v]) => [Math.round(t), roundSig(v)] as MetricPoint)
}

/** A cumulative counter as its increase since the first sample (restarts during the window). */
export function deltaFromFirst(points: MetricPoint[]): MetricPoint[] {
  if (!points.length) return []
  const base = points[0][1]
  // A counter that resets (a pod replaced) would go negative; clamp at zero.
  return points.map(([t, v]) => [t, Math.max(0, v - base)] as MetricPoint)
}

/**
 * The steady-state probe as a series: each fault's probe success % held over
 * its window — what Litmus records per fault, laid on the same time axis.
 */
export function probeSeries(phases: PhaseWindow[]): MetricPoint[] {
  const out: MetricPoint[] = []
  for (const p of phases) {
    if (p.kind !== 'fault' || p.probeSuccessPercentage === undefined || p.end === undefined) continue
    out.push([p.start, p.probeSuccessPercentage], [p.end, p.probeSuccessPercentage])
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** Min / max / last of a series, for chart captions. */
export function seriesStats(points: MetricPoint[]): { min: number; max: number; last: number } | undefined {
  if (!points.length) return undefined
  let min = Infinity
  let max = -Infinity
  for (const [, v] of points) {
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max, last: points[points.length - 1][1] }
}

/**
 * The worst value of a series inside the fault windows vs the median before
 * the first fault — "error rate peaked at 12% during faults (baseline 0.1%)".
 */
export function faultImpact(points: MetricPoint[], phases: PhaseWindow[], worst: 'max' | 'min'): { baseline?: number; during?: number } {
  const faults = phases.filter((p) => p.kind === 'fault' || p.kind === 'recovery')
  if (!points.length || !faults.length) return {}
  const first = Math.min(...faults.map((f) => f.start))
  const inFault = (t: number) => faults.some((f) => t >= f.start && t <= (f.end ?? Infinity))
  const before = points.filter(([t]) => t < first).map(([, v]) => v).sort((a, b) => a - b)
  const during = points.filter(([t]) => inFault(t)).map(([, v]) => v)
  return {
    ...(before.length ? { baseline: before[Math.floor(before.length / 2)] } : {}),
    ...(during.length ? { during: worst === 'max' ? Math.max(...during) : Math.min(...during) } : {}),
  }
}

/* ─────────────────────────── the runner's log ─────────────────────────── */

export interface RunnerTimeline {
  phases: PhaseWindow[]
  /** `ADHAR_GATE_VERDICT {...}` when the run is a gate. */
  gate?: { verdict: string; reasons: string[] }
  /** The image already passed here, so nothing was retested. */
  alreadyPassed?: boolean
  /** Newest line time — how fresh the log is. */
  lastAt?: number
}

const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})\s(.*)$/

function lineTime(date: string, frac: string | undefined, zone: string): number {
  // RFC3339Nano → ms: Date.parse is only specified for 3 fractional digits.
  const ms = frac ? `.${frac.slice(1, 4).padEnd(3, '0')}` : ''
  return Date.parse(`${date}${ms}${zone}`)
}

function tryJson(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const numOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * The phases of one application's resilience run, from the runner Job's log
 * read with `timestamps=true`. The runner logs one line when each phase
 * starts and one with its result when it ends:
 *
 *   <ts> adhar-resilience: cart: load test against http://… (p95 < 500 ms, …)
 *   <ts> adhar-resilience: cart: performance {"status":"passed",…}
 *   <ts> adhar-resilience: cart: pod-delete chaos for 30s with a continuous probe on …
 *   <ts> adhar-resilience: cart: pod-delete {"status":"passed","recoverySeconds":12,…}
 *
 * A fault's result line is written after recovery was measured, so its
 * window splits into the fault (start → end − recovery) and the recovery.
 * Lines for other applications (the hourly pass tests several) are ignored.
 */
export function parseRunnerTimeline(log: string, app: string): RunnerTimeline {
  const phases: PhaseWindow[] = []
  const prefix = `adhar-resilience: ${app}: `
  const open = new Map<string, PhaseWindow>()
  let gate: RunnerTimeline['gate']
  let alreadyPassed = false
  let lastAt: number | undefined
  for (const raw of log.split('\n')) {
    const m = TS.exec(raw.trimEnd())
    if (!m) continue
    const t = lineTime(m[1], m[2], m[3])
    if (!Number.isFinite(t)) continue
    lastAt = t
    const body = m[4]
    if (body.startsWith('ADHAR_GATE_VERDICT ')) {
      const j = tryJson(body.slice('ADHAR_GATE_VERDICT '.length))
      if (j) gate = { verdict: String(j.verdict ?? 'unknown'), reasons: Array.isArray(j.reasons) ? j.reasons.map(String) : [] }
      continue
    }
    if (!body.startsWith(prefix)) continue
    const rest = body.slice(prefix.length)
    if (/already passed the gate/.test(rest)) {
      alreadyPassed = true
      continue
    }
    if (rest.startsWith('load test against ')) {
      const p: PhaseWindow = { kind: 'load', name: 'load-test', start: t, status: 'running' }
      open.set('load-test', p)
      phases.push(p)
      continue
    }
    if (rest.startsWith('performance {')) {
      const p = open.get('load-test')
      const j = tryJson(rest.slice('performance '.length))
      if (p) {
        p.end = t
        p.status = typeof j?.status === 'string' ? j.status : 'unknown'
        open.delete('load-test')
      }
      continue
    }
    const start = /^([a-z0-9-]+) chaos for (\d+)s/.exec(rest)
    if (start) {
      // A retry (the first attempt produced no verdict) continues the same phase.
      if (!open.has(start[1])) {
        const p: PhaseWindow = { kind: 'fault', name: start[1], start: t, status: 'running', plannedSeconds: Number(start[2]) }
        open.set(start[1], p)
        phases.push(p)
      }
      continue
    }
    const end = /^([a-z0-9-]+) (\{.*\})$/.exec(rest)
    if (end) {
      const p = open.get(end[1])
      const j = tryJson(end[2])
      if (!p || !j) continue
      open.delete(end[1])
      const rec = numOf(j.recoverySeconds)
      const probe = numOf(j.probeSuccessPercentage)
      const status = typeof j.status === 'string' ? j.status : 'unknown'
      const recStart = rec !== undefined ? Math.max(p.start, t - rec * 1000) : t
      p.end = recStart
      p.status = status
      if (probe !== undefined) p.probeSuccessPercentage = probe
      if (rec !== undefined) p.recoverySeconds = rec
      if (rec !== undefined && rec > 0) phases.push({ kind: 'recovery', name: end[1], start: recStart, end: t, status })
    }
  }
  return { phases: phases.sort((a, b) => a.start - b.start), ...(gate ? { gate } : {}), ...(alreadyPassed ? { alreadyPassed } : {}), ...(lastAt !== undefined ? { lastAt } : {}) }
}

/** Phases as stored (ISO-free, compact): drop running state for a finished run. */
export function closePhases(phases: PhaseWindow[], at: number): PhaseWindow[] {
  return phases.map((p) => (p.end === undefined ? { ...p, end: Math.max(p.start, at), status: p.status === 'running' ? 'unknown' : p.status } : p))
}

/* ─────────────────────────── chart geometry ─────────────────────────── */

export interface ChartBand {
  start: number
  end: number
  kind: PhaseKind
  label?: string
}

export interface ChartFrame {
  width: number
  height: number
  pad: { l: number; r: number; t: number; b: number }
}

export interface ChartScale {
  t0: number
  t1: number
  top: number
  x(t: number): number
  y(v: number): number
  yTicks: number[]
  xTicks: number[]
}

/** 1, 2, 2.5, 5 × 10ⁿ at or above `v`. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * mag) return m * mag
  return 10 * mag
}

/**
 * Scales for one chart: time on x (the domain, or the data's extent), value on
 * y from zero to a nice ceiling. Shared by the live canvas, the HTML report's
 * SVG and the PDF so the three draw the same picture.
 */
export function chartScale(series: MetricPoint[][], frame: ChartFrame, opts: { domain?: [number, number]; yMax?: number; xTicks?: number } = {}): ChartScale | undefined {
  const all = series.flat()
  const t0 = opts.domain?.[0] ?? Math.min(...all.map((p) => p[0]))
  const t1 = opts.domain?.[1] ?? Math.max(...all.map((p) => p[0]))
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return undefined
  const peak = all.length ? Math.max(...all.map((p) => p[1])) : 0
  const top = opts.yMax ?? niceCeil(peak > 0 ? peak * 1.08 : 1)
  const { l, r, t, b } = frame.pad
  const pw = frame.width - l - r
  const ph = frame.height - t - b
  const n = opts.xTicks ?? 4
  return {
    t0,
    t1,
    top,
    x: (tt) => l + ((tt - t0) / (t1 - t0)) * pw,
    y: (v) => t + ph - (Math.max(0, Math.min(v, top)) / top) * ph,
    yTicks: [0, 0.5, 1].map((f) => f * top),
    xTicks: Array.from({ length: n + 1 }, (_, i) => t0 + ((t1 - t0) * i) / n),
  }
}

/**
 * Polylines for a series, broken where samples are missing (a gap longer
 * than 2.5 steps) so an outage in collection is not drawn as a flat line.
 */
export function segments(points: MetricPoint[], gapMs?: number): MetricPoint[][] {
  if (!points.length) return []
  const steps = points.slice(1).map((p, i) => p[0] - points[i][0]).sort((a, b) => a - b)
  const gap = gapMs ?? (steps.length ? steps[Math.floor(steps.length / 2)] * 2.5 : Infinity)
  const out: MetricPoint[][] = [[points[0]]]
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] - points[i - 1][0] > gap) out.push([])
    out[out.length - 1].push(points[i])
  }
  return out
}

/**
 * The drawable pieces of a series: the probe series is one flat segment per
 * fault (never joined across the pause between faults — nothing was measured
 * there); every other series breaks at collection gaps.
 */
export function segmentsFor(id: string, points: MetricPoint[]): MetricPoint[][] {
  if (id !== 'probe') return segments(points)
  const out: MetricPoint[][] = []
  for (let i = 0; i + 1 < points.length; i += 2) out.push([points[i], points[i + 1]])
  return out
}

/**
 * A y-axis ceiling that reads well for the unit: a percentage of polls is out
 * of 100; a count (pods, restarts) gets an even whole number so its midline
 * tick is whole too. Undefined lets the chart pick a nice ceiling.
 */
export function yMaxFor(id: string, unit: MetricUnit, points: MetricPoint[]): number | undefined {
  if (id === 'probe') return 100
  if (unit !== 'count') return undefined
  const peak = points.reduce((m, [, v]) => Math.max(m, v), 0)
  return Math.max(2, Math.ceil((peak * 1.1) / 2) * 2)
}

/** Bands from phases (faults and recovery, by default) clipped to a domain. */
export function bandsFrom(phases: PhaseWindow[] | undefined, domain: [number, number], kinds: PhaseKind[] = ['fault', 'recovery', 'load']): ChartBand[] {
  return (phases ?? [])
    .filter((p) => kinds.includes(p.kind))
    .map((p) => ({ start: Math.max(domain[0], p.start), end: Math.min(domain[1], p.end ?? domain[1]), kind: p.kind, label: p.name }))
    .filter((b) => b.end > b.start)
}

/* ─────────────────────────── formatting ─────────────────────────── */

export function formatMetric(v: number | undefined, unit: MetricUnit): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  switch (unit) {
    case 'rps':
      return v >= 100 ? `${Math.round(v)}/s` : `${Number(v.toFixed(v >= 10 ? 1 : 2))}/s`
    case 'percent':
      return `${Number(v.toFixed(v >= 10 ? 0 : v >= 1 ? 1 : 2))}%`
    case 'ms':
      return v >= 1000 ? `${Number((v / 1000).toFixed(2))} s` : `${Math.round(v)} ms`
    case 'count':
      return String(Number(v.toFixed(v % 1 === 0 ? 0 : 1)))
    case 'cores':
      return v === 0 ? '0' : v >= 1 ? `${Number(v.toFixed(2))}` : `${Math.round(v * 1000)}m`
    case 'bytes': {
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let n = v
      let i = 0
      while (n >= 1024 && i < units.length - 1) {
        n /= 1024
        i++
      }
      return `${Number(n.toFixed(n >= 100 ? 0 : 1))} ${units[i]}`
    }
  }
}

/** `HH:MM` in UTC (reports) — the live view formats in local time itself. */
export function clockUtc(t: number): string {
  return new Date(t).toISOString().slice(11, 16)
}

/** The serialised size of a metrics block, to keep stored reports bounded. */
export function metricsBytes(m: RunMetrics | undefined): number {
  return m ? JSON.stringify(m).length : 0
}
