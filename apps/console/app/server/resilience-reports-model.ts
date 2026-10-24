/**
 * Chaos Engineering run reports — the pure half of `resilience-reports.ts`.
 *
 * The resilience runner keeps ONE record per application in
 * `adhar-system/adhar-resilience-results`: each run overwrites the last. That
 * is the right shape for a scorecard and the wrong one for "what did the chaos
 * suite say about the build we are about to promote?". So the console keeps
 * the history itself: every time a record's `testedAt` moves, the recorder
 * freezes that run into a report and stores it, tagged with the commit that
 * was actually running.
 *
 * The commit comes from the record's `image` — the runner reads it from the
 * target workload's pod template when the run starts, so it is the build that
 * was under test, not whatever is deployed by the time anyone looks:
 *
 *   • `…/app:<40-hex>`            CI tags every signed image with the full
 *                                 commit SHA → that is the commit.
 *   • `…/app@sha256:<digest>`     promotions pin the digest (what cosign
 *                                 signed) → the Kargo Freight carrying that
 *                                 digest names the tag, i.e. the commit.
 *   • anything else               the commit is recorded as unknown, with why.
 *     It is never guessed.
 *
 * Who started the run is read off the runner Jobs whose lifetime covers the
 * record's `testedAt`: a gate Job labelled `adhar.io/triggered-by=console` is a
 * click on the Chaos page, any other gate Job is a Kargo promotion's
 * verification, and a Job owned by the runner CronJob is the hourly schedule.
 */

import {
  captureWindow,
  closePhases,
  compactPoints,
  deltaFromFirst,
  type MetricQuery,
  type MetricSeries,
  METRIC_DEFS,
  metricDef,
  missingReason,
  type MissingMetric,
  type PhaseWindow,
  pointsFromMatrix,
  probeSeries,
  rateFor,
  type RunMetrics,
  type RunnerTimeline,
  runMetricQueries,
  stepFor,
  podRegexForApp,
  WINDOW_PAD_MS,
} from '@adhar/utils'

export const REPORT_KIND = 'resilience.report'
/**
 * Reports describe the cluster, not a tenant, so they live in the platform's
 * shared space — the same one platform events and Alertmanager use.
 */
export const REPORTS_TENANT = 'default'
/** Reports kept per application (all its environments together). */
export const MAX_REPORTS_PER_APP = 50
export const RECORDER_USER = 'system:resilience-recorder'

export const RUNNER_CRONJOB = 'adhar-resilience-runner'
export const GATE_LABEL = 'adhar.io/resilience-gate'
export const NAMESPACE_LABEL = 'adhar.io/resilience-namespace'
export const TRIGGER_LABEL = 'adhar.io/triggered-by'
export const TRIGGER_USER_ANNOTATION = 'adhar.io/triggered-by-user'

/** The workload-design checks a chaos report shows next to its experiments. */
export const DESIGN_SIGNALS = [
  'replicas_ha',
  'pod_disruption_budget',
  'autoscaling',
  'spread_across_nodes',
  'graceful_shutdown',
  'restart_stability',
  'progressive_delivery',
  'recovery_time',
] as const

/* ─────────────────────────── wire types ─────────────────────────── */

export type ReportTrigger = 'promotion' | 'console' | 'schedule' | 'unknown'
export type CommitSource = 'image-tag' | 'kargo-freight' | 'unknown'

export interface ExperimentRecord {
  name: string
  /** passed | failed | error | unavailable | opted-out | unknown */
  status: string
  verdict?: string
  probeSuccessPercentage?: number
  recoverySeconds?: number
  durationSeconds?: number
  replicas?: number
  hypothesis?: string
  detail?: string
}

export interface PerformanceRecord {
  status: string
  p95Ms?: number
  p99Ms?: number
  errorRate?: number
  rps?: number
  thresholdP95Ms?: number
  thresholdErrorRate?: number
  detail?: string
}

export interface DesignCheck {
  name: string
  applicable: boolean
  /** 0–1, as the scorer records it. */
  score: number
  detail?: string
}

export interface ChaosRunReport {
  id: string
  app: string
  namespace: string
  environment: string
  project?: string
  /** The image the runner tested (the workload's pod template at run start). */
  image?: string
  /** Full 40-hex commit SHA, only when resolved. */
  commit?: string
  commitSource: CommitSource
  /** Why the commit is unknown, or how it was resolved. */
  commitNote?: string
  digest?: string
  freight?: { name: string; alias?: string; project?: string }
  /** The application's source repository (adhar-controlplane URL), for the commit link. */
  repoUrl?: string
  trigger: ReportTrigger
  triggeredByUser?: string
  /** The runner Job that ran it. */
  runId?: string
  startedAt?: string
  finishedAt: string
  /** What the load test and probe hit. */
  target?: string
  experiments: ExperimentRecord[]
  performance?: PerformanceRecord
  gate?: { verdict: string; reasons: string[]; at?: string }
  checks?: DesignCheck[]
  /** The environment the scorer graded the checks on. */
  checksEnvironment?: string
  /**
   * The run's phases on the wall clock (load test, each fault, recovery), read
   * from the runner Job's timestamped log. Absent on reports recorded before
   * phases were kept, or when the Job's pod was already gone.
   */
  phases?: PhaseWindow[]
  /** Target metrics over the run window, captured from Prometheus after the run. */
  metrics?: RunMetrics
  /** Why `metrics` is absent: Prometheus unreachable, nothing scraped, … */
  metricsNote?: string
  recordedAt: string
  [k: string]: unknown
}

/* ─────────────────────────── helpers ─────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export const FULL_SHA = /^[0-9a-f]{40}$/

/** Drop undefined fields so a stored document carries only what was known. */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/* ─────────────────────────── image → commit ─────────────────────────── */

export interface ImageRef {
  /** Registry + path, without tag or digest. */
  repo: string
  tag?: string
  /** `sha256:<hex>` */
  digest?: string
}

/** `host:5000/org/app:tag@sha256:…` → its parts. The tag is only a tag after the last `/`. */
export function parseImage(image: string): ImageRef | undefined {
  const s = image.trim()
  if (!s) return undefined
  let rest = s
  let digest: string | undefined
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1) || undefined
    rest = rest.slice(0, at)
  }
  const slash = rest.lastIndexOf('/')
  const colon = rest.lastIndexOf(':')
  let tag: string | undefined
  if (colon > slash) {
    tag = rest.slice(colon + 1) || undefined
    rest = rest.slice(0, colon)
  }
  return compact({ repo: rest, tag, digest })
}

/** `https://harbor.x/org/app` and `harbor.x/org/app` are the same repository. */
function sameRepo(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '').toLowerCase()
  return n(a) === n(b)
}

/** The slice of a Kargo Freight this module reads. */
export interface FreightLike {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  alias?: string
  origin?: { kind?: string; name?: string }
  images?: Array<{ repoURL?: string; tag?: string; digest?: string }>
  commits?: Array<{ repoURL?: string; id?: string }>
}

export interface CommitResolution {
  commit?: string
  source: CommitSource
  note?: string
  digest?: string
  freight?: { name: string; alias?: string; project?: string }
  repoUrl?: string
}

/**
 * The commit a tested image was built from. A 40-hex tag is the commit (CI's
 * tagging rule); a digest is looked up in Kargo's Freight. Anything else is
 * unknown — and says why — rather than a guess.
 */
export function resolveCommit(image: string | undefined, app: string, freights: FreightLike[]): CommitResolution {
  if (!image) return { source: 'unknown', note: 'The runner did not record which image it tested.' }
  const ref = parseImage(image)
  if (!ref) return { source: 'unknown', note: 'The recorded image could not be parsed.' }
  const tag = ref.tag?.toLowerCase()
  if (tag && FULL_SHA.test(tag)) return compact({ commit: tag, source: 'image-tag' as const, digest: ref.digest })
  if (ref.digest) {
    const matches = freights.filter((f) =>
      (f.images ?? []).some((i) => i.digest === ref.digest && (!i.repoURL || sameRepo(i.repoURL, ref.repo)))
    )
    // A digest can sit in several freights (one per project that subscribes
    // to the image); prefer the application's own warehouse.
    const f = matches.find((x) => x.origin?.name === app) ?? matches[0]
    if (f) {
      const img = (f.images ?? []).find((i) => i.digest === ref.digest)
      const fromTag = img?.tag?.toLowerCase()
      const fromCommit = (f.commits ?? []).map((c) => c.id?.toLowerCase()).find((id) => !!id && FULL_SHA.test(id))
      const commit = fromTag && FULL_SHA.test(fromTag) ? fromTag : fromCommit
      const freight = compact({
        name: f.metadata?.name ?? '',
        alias: f.alias ?? f.metadata?.labels?.['kargo.akuity.io/alias'],
        project: f.metadata?.namespace,
      })
      const repoUrl = str((f.commits ?? []).find((c) => c.repoURL)?.repoURL)
      if (commit) return compact({ commit, source: 'kargo-freight' as const, digest: ref.digest, freight, repoUrl })
      return compact({
        source: 'unknown' as const,
        digest: ref.digest,
        freight,
        note: `Kargo freight ${freight.alias ?? freight.name} carries this digest, but neither its image tag nor its commits name a full commit SHA.`,
      })
    }
    return { source: 'unknown', digest: ref.digest, note: 'The image is pinned by digest and no Kargo freight carries that digest.' }
  }
  return { source: 'unknown', note: ref.tag ? `The image tag "${ref.tag}" is not a commit SHA.` : 'The image has neither a commit-SHA tag nor a digest.' }
}

/* ─────────────────────────── job → trigger ─────────────────────────── */

export interface JobLike {
  metadata?: {
    name?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    creationTimestamp?: string
    ownerReferences?: Array<{ kind?: string; name?: string }>
  }
  spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> } } }
  status?: {
    startTime?: string
    completionTime?: string
    conditions?: Array<{ type?: string; status?: string; lastTransitionTime?: string }>
  }
}

export interface TriggerResolution {
  trigger: ReportTrigger
  runId?: string
  triggeredByUser?: string
  startedAt?: string
}

/** A finished run's record is written within seconds of its Job ending. */
const END_SLACK_MS = 2 * 60_000

function jobWindow(j: JobLike, now: number): { start: number; end: number } | undefined {
  const start = Date.parse(j.status?.startTime ?? j.metadata?.creationTimestamp ?? '')
  if (!Number.isFinite(start)) return undefined
  const ended = j.status?.completionTime ??
    j.status?.conditions?.find((c) => (c.type === 'Failed' || c.type === 'Complete') && c.status === 'True')?.lastTransitionTime
  const end = ended ? Date.parse(ended) : now
  return { start, end: Number.isFinite(end) ? end : now }
}

/** Which runner Job produced the record tested at `testedAt` for `app` in `namespace`. */
export function resolveTrigger(app: string, namespace: string, testedAt: string, jobs: JobLike[], now = Date.now()): TriggerResolution {
  const t = Date.parse(testedAt)
  if (!Number.isFinite(t)) return { trigger: 'unknown' }
  const covering = (j: JobLike) => {
    const w = jobWindow(j, now)
    return !!w && w.start <= t && t <= w.end + END_SLACK_MS
  }
  const startOf = (j: JobLike) => j.status?.startTime ?? j.metadata?.creationTimestamp
  const latestFirst = (a: JobLike, b: JobLike) => (startOf(b) ?? '').localeCompare(startOf(a) ?? '')

  const gate = jobs
    .filter((j) => {
      const l = j.metadata?.labels ?? {}
      if (l[GATE_LABEL] !== app) return false
      const env = j.spec?.template?.spec?.containers?.[0]?.env ?? []
      const ns = l[NAMESPACE_LABEL] ?? env.find((e) => e.name === 'VERIFY_NAMESPACE')?.value
      return ns === namespace && covering(j)
    })
    .sort(latestFirst)[0]
  if (gate) {
    const byConsole = gate.metadata?.labels?.[TRIGGER_LABEL] === 'console'
    return compact({
      trigger: byConsole ? 'console' as const : 'promotion' as const,
      runId: gate.metadata?.name,
      triggeredByUser: byConsole ? gate.metadata?.annotations?.[TRIGGER_USER_ANNOTATION] : undefined,
      startedAt: startOf(gate),
    })
  }
  const scheduled = jobs
    .filter((j) =>
      !j.metadata?.labels?.[GATE_LABEL] &&
      (j.metadata?.ownerReferences ?? []).some((o) => o.kind === 'CronJob' && o.name === RUNNER_CRONJOB) &&
      covering(j)
    )
    .sort(latestFirst)[0]
  if (scheduled) return compact({ trigger: 'schedule' as const, runId: scheduled.metadata?.name, startedAt: startOf(scheduled) })
  return { trigger: 'unknown' }
}

/* ─────────────────────────── Argo CD + scorer ─────────────────────────── */

export interface ArgoAppLike {
  metadata?: { name?: string; labels?: Record<string, string> }
  spec?: { source?: { repoURL?: string }; sources?: Array<{ repoURL?: string }>; destination?: { namespace?: string } }
}

export interface Placement {
  environment?: string
  project?: string
  repoUrl?: string
}

/** The Argo CD Application that deploys `app` into `namespace`: its environment, project and source repo. */
export function placementOf(app: string, namespace: string, apps: ArgoAppLike[]): Placement {
  const a = apps.find((x) => x.metadata?.labels?.['adhar.io/application'] === app && x.spec?.destination?.namespace === namespace)
  if (!a) return {}
  const labels = a.metadata?.labels ?? {}
  const env = labels['adhar.io/environment']
  // `<project>-<app>-<env>` is the composed name; the label wins when present.
  const name = a.metadata?.name ?? ''
  const suffix = `-${app}-${env ?? ''}`
  const fromName = env && name.endsWith(suffix) ? name.slice(0, -suffix.length) : undefined
  const repo = str(a.spec?.source?.repoURL) ?? str(a.spec?.sources?.find((s) => s.repoURL)?.repoURL)
  return compact({ environment: env, project: labels['adhar.io/project'] ?? fromName, repoUrl: repo })
}

/** The scorer's workload-design checks for `app`, from `summary.json`'s services. */
export function designChecks(app: string, services: unknown[]): { checks: DesignCheck[]; environment?: string } {
  const svc = services.find((s) => isObj(s) && s.name === app && (s.kind === 'application' || s.kind === undefined))
  if (!isObj(svc) || !Array.isArray(svc.signals)) return { checks: [] }
  const wanted = new Set<string>(DESIGN_SIGNALS)
  const checks: DesignCheck[] = []
  for (const s of svc.signals) {
    if (!isObj(s) || typeof s.name !== 'string' || !wanted.has(s.name)) continue
    checks.push(compact({ name: s.name, applicable: s.applicable !== false, score: num(s.score) ?? 0, detail: str(s.detail) }))
  }
  return compact({ checks, environment: str(svc.environment) })
}

/* ─────────────────────────── record → report ─────────────────────────── */

const DNS = /[^a-z0-9-]/g

/** `<app>.<namespace>.<epoch-ms>` — stable for one record, so re-observing it is a no-op. */
export function reportId(app: string, namespace: string, testedAt: string): string {
  const t = Date.parse(testedAt)
  return `${app.toLowerCase().replace(DNS, '-')}.${namespace.toLowerCase().replace(DNS, '-')}.${Number.isFinite(t) ? t : 0}`.slice(0, 128)
}

function experimentOf(name: string, v: Record<string, unknown>): ExperimentRecord {
  return compact({
    name,
    status: str(v.status) ?? 'unknown',
    verdict: str(v.verdict),
    probeSuccessPercentage: num(v.probeSuccessPercentage),
    recoverySeconds: num(v.recoverySeconds),
    durationSeconds: num(v.durationSeconds),
    replicas: num(v.replicas),
    hypothesis: str(v.hypothesis),
    detail: str(v.detail),
  })
}

function performanceOf(v: unknown): PerformanceRecord | undefined {
  if (!isObj(v)) return undefined
  return compact({
    status: str(v.status) ?? 'unknown',
    p95Ms: num(v.p95Ms),
    p99Ms: num(v.p99Ms),
    errorRate: num(v.errorRate),
    rps: num(v.rps),
    thresholdP95Ms: num(v.thresholdP95Ms),
    thresholdErrorRate: num(v.thresholdErrorRate),
    detail: str(v.detail),
  })
}

export interface BuildInput {
  app: string
  /** The app's raw record from `results.json`. */
  record: unknown
  jobs: JobLike[]
  freights: FreightLike[]
  argoApps: ArgoAppLike[]
  /** `summary.json`'s `services`, when the scorer is installed. */
  scorerServices?: unknown[]
  /** The run's phases, parsed from the runner Job's log (`parseRunnerTimeline`). */
  timeline?: RunnerTimeline
  now?: number
}

/**
 * Freeze one runner record into a report. Undefined when the record is not a
 * finished test (queued, never tested, or missing its namespace/time).
 */
export function buildReport(input: BuildInput): ChaosRunReport | undefined {
  const { app, record } = input
  if (!isObj(record)) return undefined
  const namespace = str(record.namespace)
  const testedAt = str(record.testedAt)
  if (!namespace || !testedAt || !Number.isFinite(Date.parse(testedAt))) return undefined

  const experiments: ExperimentRecord[] = []
  if (isObj(record.chaosSuite)) {
    for (const [name, v] of Object.entries(record.chaosSuite)) if (isObj(v)) experiments.push(experimentOf(name, v))
  }
  // Records written before the suite existed carry only the pod-delete result.
  if (!experiments.length && isObj(record.chaos)) {
    experiments.push(experimentOf(str(record.chaos.experiment) ?? 'pod-delete', record.chaos))
  }

  const image = str(record.image)
  const commit = resolveCommit(image, app, input.freights)
  const trigger = resolveTrigger(app, namespace, testedAt, input.jobs, input.now)
  const place = placementOf(app, namespace, input.argoApps)
  const design = input.scorerServices ? designChecks(app, input.scorerServices) : { checks: [] }
  const phases = phasesForRun(input.timeline, testedAt)

  // The gate verdict belongs to this run only when it judged this image, at
  // the time of this test (the runner writes both in the same pass).
  let gate: ChaosRunReport['gate']
  const g = isObj(record.gates) ? record.gates[namespace] : undefined
  if (isObj(g)) {
    const at = str(g.at)
    const near = at ? Math.abs(Date.parse(at) - Date.parse(testedAt)) <= 10 * 60_000 : false
    if (near && (!image || !str(g.image) || str(g.image) === image)) {
      const reasons = [
        ...(Array.isArray(g.reasons) ? g.reasons.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : []),
        ...(str(g.reason) ? [str(g.reason)!] : []),
      ]
      gate = compact({ verdict: str(g.verdict) ?? 'unknown', reasons, at })
    }
  }

  return compact({
    id: reportId(app, namespace, testedAt),
    app,
    namespace,
    environment: place.environment ?? str(record.environment) ?? namespace,
    project: place.project,
    image,
    commit: commit.commit,
    commitSource: commit.source,
    commitNote: commit.note,
    digest: commit.digest,
    freight: commit.freight,
    repoUrl: commit.repoUrl ?? place.repoUrl,
    trigger: trigger.trigger,
    triggeredByUser: trigger.triggeredByUser,
    runId: trigger.runId,
    startedAt: trigger.startedAt ?? (phases.length ? new Date(Math.min(...phases.map((p) => p.start))).toISOString() : undefined),
    finishedAt: testedAt,
    target: str(record.target),
    experiments,
    performance: performanceOf(record.performance),
    gate,
    checks: design.checks.length ? design.checks : undefined,
    checksEnvironment: design.checks.length ? design.environment : undefined,
    phases: phases.length ? phases : undefined,
    recordedAt: new Date(input.now ?? Date.now()).toISOString(),
  })
}

/* ─────────────────────────── phases ─────────────────────────── */

/**
 * The phases of THIS run: the hourly pass logs several applications and a
 * Job's log can hold more than one run of one, so only phases from the run's
 * own load test (the latest before the record's `testedAt`, within the hour)
 * up to `testedAt` are kept, closed at `testedAt` if the log ended mid-phase.
 */
export function phasesForRun(timeline: RunnerTimeline | undefined, testedAt: string): PhaseWindow[] {
  const end = Date.parse(testedAt)
  if (!timeline || !Number.isFinite(end)) return []
  const slack = 60_000
  // Every run of an application starts with its load test: the latest one
  // before the record is where this run began.
  const loads = timeline.phases.filter((p) => p.kind === 'load' && p.start <= end).map((p) => p.start)
  const from = loads.length ? Math.max(...loads) : end - 3600_000
  const kept = timeline.phases.filter((p) => p.start <= end + slack && p.start >= Math.max(from, end - 3600_000))
  return closePhases(kept, end).map((p) => ({ ...p, end: Math.min(p.end ?? end, end + slack) }))
}

/* ─────────────────────────── metrics ─────────────────────────── */

/** Reports older than this are not enriched any more: the series may be gone. */
export const METRICS_MAX_AGE_MS = 6 * 3600_000

/**
 * True when a report should have its metrics captured now: it has none yet,
 * its padded window has closed (with a scrape interval of slack), and it is
 * recent enough that Prometheus still holds the samples.
 */
export function metricsDue(r: Pick<ChaosRunReport, 'finishedAt' | 'metrics' | 'metricsNote'>, now = Date.now()): boolean {
  if (r.metrics || r.metricsNote) return false
  const end = Date.parse(r.finishedAt)
  if (!Number.isFinite(end)) return false
  return now >= end + WINDOW_PAD_MS + 30_000 && now - end <= METRICS_MAX_AGE_MS
}

export interface MetricsPlan {
  window: { start: number; end: number; stepSeconds: number }
  selector: string
  queries: MetricQuery[]
}

/** What to ask Prometheus for one report: the padded window, a bounded step, the target's queries. */
export function metricsPlan(r: Pick<ChaosRunReport, 'app' | 'namespace' | 'startedAt' | 'finishedAt' | 'phases'>): MetricsPlan | undefined {
  const w = captureWindow({ startedAt: r.startedAt, finishedAt: r.finishedAt, phases: r.phases })
  if (!w) return undefined
  // A runaway start (a Job that lived for days) must not blow the budget.
  const start = Math.max(w.start, w.end - 3 * 3600_000)
  const step = stepFor(start, w.end)
  const podRegex = podRegexForApp(r.app)
  return {
    window: { start, end: w.end, stepSeconds: step },
    selector: `namespace="${r.namespace}",pod=~"${podRegex}"`,
    queries: runMetricQueries({ namespace: r.namespace, podRegex, rate: rateFor(step) }),
  }
}

/** One query's answer: Prometheus matrix results, or why it failed. */
export type QueryAnswer = Array<{ values?: Array<[number, string]> }> | { error: string }

/**
 * The stored metrics block from the plan and Prometheus's answers: each series
 * compacted (≤ MAX_POINTS samples, 4 significant figures), restarts turned
 * into "since the window opened", the probe series derived from the faults,
 * and every empty or failed query listed as missing with its reason.
 */
export function assembleMetrics(plan: MetricsPlan, answers: Record<string, QueryAnswer>, phases: PhaseWindow[] = [], now = Date.now()): RunMetrics {
  const series: MetricSeries[] = []
  const missing: MissingMetric[] = []
  for (const def of METRIC_DEFS) {
    if (def.id === 'probe') {
      const pts = probeSeries(phases)
      if (pts.length) series.push({ id: 'probe', label: def.label, unit: def.unit, points: compactPoints(pts) })
      else missing.push({ id: 'probe', label: def.label, reason: missingReason('probe') })
      continue
    }
    const a = answers[def.id]
    if (!a) continue
    if (!Array.isArray(a)) {
      missing.push({ id: def.id, label: def.label, reason: `Prometheus query failed: ${a.error}` })
      continue
    }
    let pts = pointsFromMatrix(a[0]?.values)
    if (def.id === 'restarts') pts = deltaFromFirst(pts)
    if (pts.length < 2) {
      missing.push({ id: def.id, label: def.label, reason: missingReason(def.id) })
      continue
    }
    series.push({ id: def.id, label: def.label, unit: def.unit, points: compactPoints(pts) })
  }
  return {
    window: plan.window,
    series,
    ...(missing.length ? { missing } : {}),
    selector: plan.selector,
    capturedAt: new Date(now).toISOString(),
    source: 'prometheus',
  }
}

/** True when nothing at all came back — the note is then the honest result. */
export function metricsEmpty(m: RunMetrics): boolean {
  return !m.series.some((s) => s.id !== 'probe')
}

export const metricLabel = (id: string): string => metricDef(id)?.label ?? id

/* ─────────────────────────── reading ─────────────────────────── */

/** A pasted SHA (full or short, any case, surrounding junk trimmed) → lowercase hex, or undefined. */
export function shaQuery(q: string | null | undefined): string | undefined {
  const s = (q ?? '').trim().toLowerCase()
  return /^[0-9a-f]{4,40}$/.test(s) ? s : undefined
}

/** Ids beyond the newest `max`, given reports sorted newest first. */
export function overflowIds(newestFirst: Array<{ id: string }>, max = MAX_REPORTS_PER_APP): string[] {
  return newestFirst.slice(max).map((r) => r.id)
}
