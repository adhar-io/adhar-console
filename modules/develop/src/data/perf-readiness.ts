/**
 * Production-readiness reports: performance and resilience, per application.
 *
 * ---------------------------------------------------------------------------
 * ONE SOURCE OF TRUTH, READ FROM THE SCORER
 * ---------------------------------------------------------------------------
 * The platform's adhar-controlplane scorer (the adhar-scorecards package) already
 * joins every piece of evidence an application has:
 *
 *   - the resilience runner's AUTOMATED k6 load test and chaos suite
 *     (pod-delete, network latency, CPU saturation), run hourly against the
 *     test environment, never prod;
 *   - the live 24-hour SLO from Prometheus (p95 latency, 5xx error budget);
 *   - the team's OWN Performance Center runs — every result whose test
 *     targets the application carries `adhar.io/application`, so the latest
 *     gate verdict (budgets + baseline regression) counts;
 *   - game days run from the console or ChaosCenter against its workload;
 *   - how the workload is built to survive failure (replicas, PDB, HPA,
 *     spread, graceful shutdown, restarts, progressive delivery).
 *
 * This module turns one scorer record into a report. It never re-judges a
 * number the scorer or the Performance Center already judged, and it never
 * fills a gap: a measurement that does not exist is reported as missing.
 *
 * Pure: no React, no network.
 */

export type ReadinessCategory = 'performance' | 'resilience'

export interface ReadinessSignal {
  name: string
  category: string
  applicable: boolean
  score: number
  detail?: string
}

export interface ChaosRun {
  experiment?: string
  status?: string
  verdict?: string
  probeSuccessPercentage?: number | string | null
  recoverySeconds?: number | null
  replicas?: number
  durationSeconds?: number
  detail?: string
}

/** The subset of the scorer's `summary.json` service record this report reads. */
export interface ScorerApplication {
  kind?: string
  name: string
  namespace?: string
  environment?: string
  environments?: Array<{ name: string; namespace?: string; health?: string; sync?: string }>
  score: number
  grade: string
  health?: string
  categories?: Record<string, number | null>
  signals?: ReadinessSignal[]
  evidence?: {
    environment?: string
    image?: string
    testedAt?: string
    target?: string
    pending?: string
    performance?: {
      status?: string
      p95Ms?: number
      p99Ms?: number
      avgMs?: number
      maxMs?: number
      errorRate?: number
      rps?: number
      vus?: number
      requests?: number
      thresholdP95Ms?: number
      thresholdErrorRate?: number
      detail?: string
    }
    chaos?: ChaosRun
    chaosSuite?: Record<string, ChaosRun>
    slo?: {
      environment?: string
      requests?: number
      p95Ms?: number | null
      errorRatio?: number | null
      targetAvailability?: number
    } | null
  }
  perfCenter?: {
    count: number
    tests: string[]
    /**
     * The newest JUDGED run — null when every result was recorded without a
     * verdict (console-launched runs, until 2026-10-22). The scorer counts
     * those as not tested, and so must this page: reading `latest.verdict`
     * unguarded crashed the Performance Center the moment one appeared.
     */
    latest: { test: string; trigger?: string; verdict?: string; reasons?: string; at?: string; namespace?: string } | null
    unjudged?: number
  } | null
  gameDays?: {
    count: number
    experiments: string[]
    latest: { experiment: string; verdict?: string; probe?: string; at?: string } | null
  } | null
}

export type Tone = 'good' | 'bad' | 'warn' | 'none'

export interface Gauge {
  label: string
  value?: number
  target?: number
  unit: 'ms' | '%' | '/s'
  /** Lower is better (latency, errors) or higher is better (throughput). */
  lowerIsBetter: boolean
  tone: Tone
  /** 0–1 fill for a bar: value against target, capped at 1.5x the target. */
  fill: number
  note?: string
}

export interface ChaosRow {
  experiment: string
  title: string
  status: string
  tone: Tone
  probePct?: number
  recoverySeconds?: number
  detail: string
}

export interface ReadinessReport {
  app: string
  grade: string
  score: number
  /** The environment the workload signals were measured on. */
  gradedOn?: string
  /** The environment the automated tests ran in. */
  testedIn?: string
  testedAt?: string
  image?: string
  target?: string
  pending?: string
  performanceScore: number | null
  resilienceScore: number | null
  /** Plain-English summary of what holds the grade back, most important first. */
  verdict: string
  load: Gauge[]
  loadStatus: string
  loadTone: Tone
  slo: Gauge[]
  sloEnvironment?: string
  chaos: ChaosRow[]
  perfCenter?: { verdict: string; tone: Tone; test: string; trigger?: string; at?: string; reasons?: string; count: number; tests: string[] }
  gameDay?: { verdict: string; tone: Tone; experiment: string; at?: string; probe?: string; count: number; experiments: string[] }
  signals: Array<ReadinessSignal & { label: string; passed: boolean }>
}

const CHAOS_TITLE: Record<string, string> = {
  'pod-delete': 'A pod is killed',
  'pod-network-latency': 'The network slows down',
  'pod-cpu-hog': 'The CPU saturates',
  'pod-memory-hog': 'Memory runs short',
  'container-kill': 'A container is killed',
  'pod-network-loss': 'Packets are dropped',
  'node-drain': 'A node is drained',
}

export const READINESS_SIGNAL_LABEL: Record<string, string> = {
  load_test: 'Automated load test meets its targets',
  latency_slo: 'Live p95 latency within target (24 h)',
  error_budget: 'Live 5xx ratio within the error budget (24 h)',
  perf_center_gate: 'Latest Performance Center gate passed',
  chaos_pod_delete: 'Keeps serving while a pod is killed',
  chaos_network_latency: 'Keeps serving on a slow network',
  chaos_cpu_stress: 'Keeps serving with its CPU saturated',
  chaos_gameday: 'Latest game day passed',
  recovery_time: 'Recovers quickly after chaos',
  replicas_ha: 'At least two replicas',
  pod_disruption_budget: 'PodDisruptionBudget',
  autoscaling: 'HorizontalPodAutoscaler',
  spread_across_nodes: 'Replicas spread across nodes',
  graceful_shutdown: 'Graceful shutdown (preStop drain)',
  restart_stability: 'No crash-looping containers',
  progressive_delivery: 'Progressive delivery (canary / blue-green)',
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function gauge(
  label: string,
  value: number | undefined,
  target: number | undefined,
  unit: Gauge['unit'],
  lowerIsBetter: boolean,
  note?: string,
): Gauge {
  let tone: Tone = 'none'
  let fill = 0
  if (value !== undefined && target !== undefined && target > 0) {
    const ok = lowerIsBetter ? value <= target : value >= target
    tone = ok ? 'good' : 'bad'
    fill = Math.min(value / target, 1.5) / 1.5
  } else if (value !== undefined) {
    fill = 0.5
  }
  return { label, value, target, unit, lowerIsBetter, tone, fill, ...(note ? { note } : {}) }
}

function statusTone(status: string | undefined): Tone {
  if (status === 'passed' || status === 'pass' || status === 'Pass') return 'good'
  if (status === 'failed' || status === 'fail' || status === 'Fail') return 'bad'
  if (status === 'opted-out' || status === 'error') return 'warn'
  return 'none'
}

/** Build the report for one application. */
export function readinessReport(app: ScorerApplication): ReadinessReport {
  const ev = app.evidence ?? {}
  const perf = ev.performance ?? {}
  const slo = ev.slo ?? undefined
  const errPct = num(perf.errorRate) !== undefined ? num(perf.errorRate)! * 100 : undefined
  const errTargetPct = num(perf.thresholdErrorRate) !== undefined ? num(perf.thresholdErrorRate)! * 100 : undefined
  const latencyTarget = num(perf.thresholdP95Ms)

  const load: Gauge[] = [
    gauge('p95 latency', num(perf.p95Ms), latencyTarget, 'ms', true),
    gauge('p99 latency', num(perf.p99Ms), undefined, 'ms', true),
    gauge('Average latency', num(perf.avgMs), undefined, 'ms', true),
    gauge('Error rate', errPct, errTargetPct, '%', true),
    gauge('Throughput', num(perf.rps), undefined, '/s', false, perf.vus ? `${perf.vus} virtual users` : undefined),
  ]

  const budgetPct = slo?.targetAvailability !== undefined ? 100 - slo.targetAvailability : undefined
  const sloGauges: Gauge[] = slo
    ? [
      gauge('p95 latency · 24 h', num(slo.p95Ms ?? undefined), latencyTarget, 'ms', true),
      gauge(
        '5xx ratio · 24 h',
        num(slo.errorRatio ?? undefined) !== undefined ? num(slo.errorRatio)! * 100 : undefined,
        budgetPct,
        '%',
        true,
        slo.targetAvailability !== undefined ? `budget for ${slo.targetAvailability}% availability` : undefined,
      ),
    ]
    : []

  const suite: Record<string, ChaosRun> = { ...(ev.chaosSuite ?? {}) }
  if (!suite['pod-delete'] && ev.chaos) suite['pod-delete'] = ev.chaos
  const chaos: ChaosRow[] = Object.entries(suite).map(([experiment, r]) => ({
    experiment,
    title: CHAOS_TITLE[experiment] ?? experiment,
    status: r.status ?? 'unknown',
    tone: statusTone(r.status),
    probePct: num(r.probeSuccessPercentage),
    recoverySeconds: num(r.recoverySeconds),
    detail: r.detail ?? '',
  }))

  const signals = (app.signals ?? [])
    .filter((s) => s.category === 'performance' || s.category === 'resilience')
    .map((s) => ({
      ...s,
      label: READINESS_SIGNAL_LABEL[s.name] ?? s.name.replace(/[_-]+/g, ' '),
      passed: s.applicable && s.score >= 1,
    }))

  const failing = signals.filter((s) => s.applicable && !s.passed)
  const verdict = failing.length === 0
    ? signals.some((s) => s.applicable)
      ? 'Every applicable performance and resilience check passes.'
      : 'No performance or resilience evidence has been produced yet.'
    : `${failing.length} check${failing.length === 1 ? '' : 's'} hold${failing.length === 1 ? 's' : ''} the grade back: ` +
      failing.slice(0, 4).map((s) => s.label.toLowerCase()).join('; ') +
      (failing.length > 4 ? `; and ${failing.length - 4} more` : '') + '.'

  const pc = app.perfCenter ?? undefined
  const gd = app.gameDays ?? undefined
  return {
    app: app.name,
    grade: app.grade,
    score: app.score,
    gradedOn: app.environment,
    testedIn: ev.environment,
    testedAt: ev.testedAt,
    image: ev.image,
    target: ev.target,
    pending: ev.pending,
    performanceScore: app.categories?.performance ?? null,
    resilienceScore: app.categories?.resilience ?? null,
    verdict,
    load,
    loadStatus: perf.status ?? (ev.pending ? 'pending' : 'not run'),
    loadTone: statusTone(perf.status),
    slo: sloGauges,
    sloEnvironment: slo?.environment,
    chaos,
    ...(pc
      ? {
        perfCenter: {
          verdict: pc.latest?.verdict || 'no verdict',
          tone: statusTone(pc.latest?.verdict),
          test: pc.latest?.test ?? pc.tests?.[0] ?? '',
          trigger: pc.latest?.trigger,
          at: pc.latest?.at,
          reasons: pc.latest?.reasons ||
            (pc.latest ? undefined : `${pc.count} result(s) recorded without a verdict — run the test again to judge it`),
          count: pc.count,
          tests: pc.tests,
        },
      }
      : {}),
    ...(gd
      ? {
        gameDay: {
          verdict: gd.latest?.verdict || 'no verdict',
          tone: statusTone(gd.latest?.verdict),
          experiment: gd.latest?.experiment ?? gd.experiments?.[0] ?? '',
          at: gd.latest?.at,
          probe: gd.latest?.probe,
          count: gd.count,
          experiments: gd.experiments,
        },
      }
      : {}),
    signals,
  }
}

/** Only delivered applications are graded on performance and resilience. */
export function readinessApplications(services: ScorerApplication[]): ScorerApplication[] {
  return services
    .filter((s) => s.kind === 'application')
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function fmtGauge(g: Pick<Gauge, 'value' | 'unit'>): string {
  if (g.value === undefined) return '—'
  if (g.unit === 'ms') return g.value >= 1000 ? `${(g.value / 1000).toFixed(2)} s` : `${Math.round(g.value)} ms`
  if (g.unit === '%') return `${g.value < 0.1 && g.value > 0 ? g.value.toFixed(3) : g.value.toFixed(2)}%`
  return `${Math.round(g.value)}/s`
}

/** The report as a document someone can keep: what was measured, and when. */
export function reportJson(report: ReadinessReport, generatedAt: string): string {
  return JSON.stringify({ kind: 'adhar.io/readiness-report', version: 1, generatedAt, ...report }, null, 2)
}
