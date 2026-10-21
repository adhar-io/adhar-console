/**
 * Application resilience suites — what each application says it survives, and
 * what the platform last proved.
 *
 * Every application ships its OWN suite, deployed with it: a ConfigMap
 * `<app>-resilience` (label `adhar.io/resilience-suite`) in each environment
 * namespace, whose `suite.json` names the faults to run in order, the
 * hypothesis each one tests, the steady-state probe and the load test's
 * thresholds. Because it rides with the build, every environment carries the
 * suite of the build running there — so suites are per app AND per namespace,
 * and two environments of one app can legitimately disagree.
 *
 * The platform's resilience runner (`adhar-resilience-runner`, scorecards
 * package) executes them and writes ONE ConfigMap, `adhar-resilience-results`
 * in `adhar-system`, keyed by application. That record holds the LAST test of
 * the application (whichever environment it was) plus a promotion-gate verdict
 * per namespace. The join below is therefore asymmetric on purpose: a suite's
 * fault results come from the record only when the record describes that
 * namespace; the gate verdict comes from `gates[<namespace>]` regardless.
 *
 * Everything here is pure — the view and its hooks do the I/O — so the rules a
 * person reads off the page are pinned by `chaos-suites_test.ts`.
 */

export const SUITE_LABEL = 'adhar.io/resilience-suite'
export const APP_LABEL = 'adhar.io/application'
export const ENV_LABEL = 'adhar.io/environment'
export const RESULTS_NAMESPACE = 'adhar-system'
export const RESULTS_CONFIGMAP = 'adhar-resilience-results'
export const RUNNER_CRONJOB = 'adhar-resilience-runner'

/* ─────────────────────────── suite definitions ─────────────────────────── */

/** One entry of the suite's catalogue: a fault the app knows how to describe. */
export interface SuiteExperiment {
  name: string
  hypothesis?: string
  /** Tuning passed to the fault (`CHAOS_INTERVAL`, `TOTAL_CHAOS_DURATION`, …). */
  env: Record<string, string>
}

/** One fault that RUNS, in run order. */
export interface SuiteStep extends SuiteExperiment {
  /**
   * False when `selected` names a fault the catalogue does not describe. The
   * runner still runs it (with no tuning and no stated hypothesis), so the page
   * shows it — hiding it would misstate what the suite does.
   */
  catalogued: boolean
}

export interface SuitePerf {
  /** Load-test path; empty means the readiness (probe) path. */
  path: string
  p95Ms?: number
  errorRate?: number
}

export interface SuiteDefinition {
  app: string
  namespace: string
  /** ConfigMap name, for the "where is this defined" hint. */
  configMap: string
  /** The faults that run, in order. */
  steps: SuiteStep[]
  catalogue: SuiteExperiment[]
  probePath?: string
  perf: SuitePerf
  /** `gate.enabled: false` makes the promotion gate record `skipped`. */
  gateEnabled: boolean
  /** Set when `suite.json` is missing or not JSON; the rest is then empty. */
  error?: string
}

/** The slice of a ConfigMap this module reads. */
export interface ConfigMapLike {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> }
  data?: Record<string, string>
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObj(v)) return out
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === undefined) continue
    out[k] = typeof val === 'string' ? val : String(val)
  }
  return out
}

/** `"a, b,,c"` or `["a","b"]` → `['a','b','c']`, first occurrence wins. */
export function parseSelected(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : typeof v === 'string' ? v.split(',') : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of raw) {
    const name = r.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * The faults that run, in order: `selected` picks and orders them from the
 * catalogue; an empty `selected` runs the whole catalogue in its own order.
 */
export function orderedSteps(selected: string[], catalogue: SuiteExperiment[]): SuiteStep[] {
  if (selected.length === 0) return catalogue.map((e) => ({ ...e, catalogued: true }))
  const byName = new Map(catalogue.map((e) => [e.name, e]))
  return selected.map((name) => {
    const e = byName.get(name)
    return e ? { ...e, catalogued: true } : { name, env: {}, catalogued: false }
  })
}

/** Parse one suite ConfigMap. Never throws: a broken suite is a row with an error. */
export function parseSuite(cm: ConfigMapLike): SuiteDefinition {
  const app = cm.metadata.labels?.[APP_LABEL] || cm.metadata.name.replace(/-resilience$/, '')
  const base: SuiteDefinition = {
    app,
    namespace: cm.metadata.namespace ?? '',
    configMap: cm.metadata.name,
    steps: [],
    catalogue: [],
    perf: { path: '' },
    gateEnabled: true,
  }
  const raw = cm.data?.['suite.json']
  if (raw === undefined || raw.trim() === '') return { ...base, error: 'The ConfigMap has no suite.json key.' }

  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    return { ...base, error: `suite.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!isObj(doc)) return { ...base, error: 'suite.json is not a JSON object.' }

  const catalogue: SuiteExperiment[] = []
  const seen = new Set<string>()
  for (const e of Array.isArray(doc.experiments) ? doc.experiments : []) {
    if (!isObj(e)) continue
    const name = str(e.name)
    if (!name || seen.has(name)) continue
    seen.add(name)
    catalogue.push({ name, ...(str(e.hypothesis) ? { hypothesis: str(e.hypothesis) } : {}), env: stringMap(e.env) })
  }

  const perf = isObj(doc.perf) ? doc.perf : {}
  const gate = isObj(doc.gate) ? doc.gate : {}
  return {
    ...base,
    catalogue,
    steps: orderedSteps(parseSelected(doc.selected), catalogue),
    ...(str(doc.probePath) ? { probePath: str(doc.probePath) } : {}),
    perf: {
      path: str(perf.path) ?? '',
      ...(num(perf.p95Ms) !== undefined ? { p95Ms: num(perf.p95Ms) } : {}),
      ...(num(perf.errorRate) !== undefined ? { errorRate: num(perf.errorRate) } : {}),
    },
    // Only an explicit false disables it — the runner reads it the same way.
    gateEnabled: !(gate.enabled === false || gate.enabled === 'false'),
  }
}

/* ─────────────────────────── results ─────────────────────────── */

export type FaultStatus = 'passed' | 'failed' | 'error' | 'unavailable' | 'opted-out' | 'unknown'

export interface FaultResult {
  status: FaultStatus
  verdict?: string
  probeSuccessPercentage?: number
  recoverySeconds?: number
  hypothesis?: string
  detail?: string
}

export interface PerfResult {
  status: 'passed' | 'failed' | 'error' | 'unknown'
  p95Ms?: number
  errorRate?: number
  rps?: number
  thresholdP95Ms?: number
  detail?: string
}

export type GateVerdictKind = 'pass' | 'fail' | 'skipped' | 'unknown'

export interface GateVerdict {
  namespace: string
  verdict: GateVerdictKind
  /** Why it failed (or why it was skipped), in the runner's words. */
  reasons: string[]
  environment?: string
  image?: string
  at?: string
}

export interface AppResult {
  app: string
  environment?: string
  namespace?: string
  image?: string
  testedAt?: string
  target?: string
  performance?: PerfResult
  chaosSuite: Record<string, FaultResult>
  gates: Record<string, GateVerdict>
  /** Set by the runner while the app is queued but not yet tested. */
  pending?: string
}

const FAULT_STATUSES: FaultStatus[] = ['passed', 'failed', 'error', 'unavailable', 'opted-out']

function faultResult(v: unknown): FaultResult | undefined {
  if (!isObj(v)) return undefined
  const s = str(v.status)
  return {
    status: s && (FAULT_STATUSES as string[]).includes(s) ? (s as FaultStatus) : 'unknown',
    ...(str(v.verdict) ? { verdict: str(v.verdict) } : {}),
    ...(num(v.probeSuccessPercentage) !== undefined ? { probeSuccessPercentage: num(v.probeSuccessPercentage) } : {}),
    ...(num(v.recoverySeconds) !== undefined ? { recoverySeconds: num(v.recoverySeconds) } : {}),
    ...(str(v.hypothesis) ? { hypothesis: str(v.hypothesis) } : {}),
    ...(str(v.detail) ? { detail: str(v.detail) } : {}),
  }
}

function perfResult(v: unknown): PerfResult | undefined {
  if (!isObj(v)) return undefined
  const s = str(v.status)
  return {
    status: s === 'passed' || s === 'failed' || s === 'error' ? s : 'unknown',
    ...(num(v.p95Ms) !== undefined ? { p95Ms: num(v.p95Ms) } : {}),
    ...(num(v.errorRate) !== undefined ? { errorRate: num(v.errorRate) } : {}),
    ...(num(v.rps) !== undefined ? { rps: num(v.rps) } : {}),
    ...(num(v.thresholdP95Ms) !== undefined ? { thresholdP95Ms: num(v.thresholdP95Ms) } : {}),
    ...(str(v.detail) ? { detail: str(v.detail) } : {}),
  }
}

/**
 * One gate verdict. The runner writes `reasons: [...]` for a tested build and
 * `reason: "..."` (singular) when the suite disables the gate or the app never
 * became ready — both are read so a skip says why.
 */
export function gateVerdict(namespace: string, v: unknown): GateVerdict | undefined {
  if (!isObj(v)) return undefined
  const s = str(v.verdict)?.toLowerCase()
  const reasons = [
    ...(Array.isArray(v.reasons) ? v.reasons.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : []),
    ...(str(v.reason) ? [str(v.reason)!] : []),
  ]
  return {
    namespace,
    verdict: s === 'pass' || s === 'fail' || s === 'skipped' ? s : 'unknown',
    reasons,
    ...(str(v.environment) ? { environment: str(v.environment) } : {}),
    ...(str(v.image) ? { image: str(v.image) } : {}),
    ...(str(v.at) ? { at: str(v.at) } : {}),
  }
}

/** Every gate verdict of an application, newest first. */
export function gateVerdicts(r: AppResult | undefined): GateVerdict[] {
  if (!r) return []
  return Object.values(r.gates).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.namespace.localeCompare(b.namespace))
}

export interface ParsedResults {
  results: Map<string, AppResult>
  /** Set when the ConfigMap exists but `results.json` cannot be read. */
  error?: string
}

/** Parse `results.json`. Missing → empty; unreadable → empty plus an error. */
export function parseResults(raw: string | undefined): ParsedResults {
  const results = new Map<string, AppResult>()
  if (raw === undefined || raw.trim() === '') return { results }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    return { results, error: `results.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!isObj(doc)) return { results, error: 'results.json is not a JSON object.' }
  for (const [app, v] of Object.entries(doc)) {
    if (!isObj(v)) continue
    const chaosSuite: Record<string, FaultResult> = {}
    if (isObj(v.chaosSuite)) {
      for (const [fault, fr] of Object.entries(v.chaosSuite)) {
        const parsed = faultResult(fr)
        if (parsed) chaosSuite[fault] = parsed
      }
    }
    const gates: Record<string, GateVerdict> = {}
    if (isObj(v.gates)) {
      for (const [ns, g] of Object.entries(v.gates)) {
        const parsed = gateVerdict(ns, g)
        if (parsed) gates[ns] = parsed
      }
    }
    const perf = perfResult(v.performance)
    results.set(app, {
      app,
      ...(str(v.environment) ? { environment: str(v.environment) } : {}),
      ...(str(v.namespace) ? { namespace: str(v.namespace) } : {}),
      ...(str(v.image) ? { image: str(v.image) } : {}),
      ...(str(v.testedAt) ? { testedAt: str(v.testedAt) } : {}),
      ...(str(v.target) ? { target: str(v.target) } : {}),
      ...(perf ? { performance: perf } : {}),
      chaosSuite,
      gates,
      ...(str(v.pending) ? { pending: str(v.pending) } : {}),
    })
  }
  return { results }
}

/* ─────────────────────────── environments ─────────────────────────── */

/** The slice of an Argo CD Application used to name an environment. */
export interface ArgoAppLike {
  metadata: { labels?: Record<string, string> }
  spec?: { destination?: { namespace?: string } }
}

/** namespace → environment name, from the Argo CD Applications that deploy apps. */
export function environmentNames(apps: ArgoAppLike[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const a of apps) {
    const ns = a.spec?.destination?.namespace
    const env = a.metadata.labels?.[ENV_LABEL]
    if (ns && env && !out.has(ns)) out.set(ns, env)
  }
  return out
}

/* ─────────────────────────── the join ─────────────────────────── */

export interface SuiteFaultRow {
  name: string
  /** The hypothesis from the suite; the result's own when the suite has none. */
  hypothesis?: string
  env: Record<string, string>
  catalogued: boolean
  /** False for a fault the last run recorded that this suite no longer selects. */
  inSuite: boolean
  result?: FaultResult
}

export interface SuiteEnvironmentRow {
  suite: SuiteDefinition
  namespace: string
  /** Display name: Argo CD's environment label, the runner's, else the namespace. */
  environment: string
  /** The last run's record — present only when it tested THIS namespace. */
  result?: AppResult
  gate?: GateVerdict
  faults: SuiteFaultRow[]
}

export interface ApplicationSuites {
  app: string
  environments: SuiteEnvironmentRow[]
  /** The application's last test, whichever environment it was. */
  last?: AppResult
  /** Gate verdicts for namespaces that have no suite here (a removed env, say). */
  orphanGates: GateVerdict[]
}

/**
 * Join suites to results: one entry per application, one row per environment
 * namespace that carries a suite. Applications sort by name; environments in
 * a stable order (by environment name).
 */
export function joinSuites(
  suites: SuiteDefinition[],
  results: Map<string, AppResult>,
  envNames: Map<string, string> = new Map(),
): ApplicationSuites[] {
  const byApp = new Map<string, SuiteDefinition[]>()
  for (const s of suites) {
    const list = byApp.get(s.app) ?? []
    list.push(s)
    byApp.set(s.app, list)
  }

  const out: ApplicationSuites[] = []
  for (const [app, list] of byApp) {
    const last = results.get(app)
    const rows = list.map((suite): SuiteEnvironmentRow => {
      const ns = suite.namespace
      const result = last && last.namespace === ns ? last : undefined
      const gate = last?.gates[ns]
      const environment = envNames.get(ns) ?? gate?.environment ?? result?.environment ?? ns
      const faults: SuiteFaultRow[] = suite.steps.map((step) => {
        const r = result?.chaosSuite[step.name]
        const hypothesis = step.hypothesis ?? r?.hypothesis
        return { ...step, ...(hypothesis ? { hypothesis } : {}), inSuite: true, ...(r ? { result: r } : {}) }
      })
      // A fault the last run recorded that the suite no longer selects is
      // still evidence about this build — listed after, marked as such.
      if (result) {
        const selected = new Set(suite.steps.map((s) => s.name))
        for (const [name, r] of Object.entries(result.chaosSuite)) {
          if (selected.has(name)) continue
          faults.push({ name, ...(r.hypothesis ? { hypothesis: r.hypothesis } : {}), env: {}, catalogued: false, inSuite: false, result: r })
        }
      }
      return { suite, namespace: ns, environment, ...(result ? { result } : {}), ...(gate ? { gate } : {}), faults }
    })
    rows.sort((a, b) => a.environment.localeCompare(b.environment) || a.namespace.localeCompare(b.namespace))
    const covered = new Set(rows.map((r) => r.namespace))
    out.push({
      app,
      environments: rows,
      ...(last ? { last } : {}),
      orphanGates: gateVerdicts(last).filter((g) => !covered.has(g.namespace)),
    })
  }
  return out.sort((a, b) => a.app.localeCompare(b.app))
}

/* ─────────────────────────── on-demand runs ─────────────────────────── */

export type RunPhase = 'pending' | 'running' | 'succeeded' | 'failed'

/** The slice of a Job's status the console reads. */
export interface JobStatusLike {
  active?: number
  succeeded?: number
  failed?: number
  startTime?: string
  completionTime?: string
  conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
}

/**
 * A Job's phase from its status. Conditions are authoritative (a Job with
 * `backoffLimit` retries keeps `failed > 0` while it is still trying);
 * counters are the fallback for an apiserver that has not set them yet.
 */
export function runPhase(status: JobStatusLike | undefined): RunPhase {
  const cond = (t: string) => status?.conditions?.some((c) => c.type === t && c.status === 'True')
  if (cond('Complete') || cond('SuccessCriteriaMet')) return 'succeeded'
  if (cond('Failed') || cond('FailureTarget')) return 'failed'
  if ((status?.active ?? 0) > 0) return 'running'
  if ((status?.succeeded ?? 0) > 0) return 'succeeded'
  return 'pending'
}

export type RunOutcome =
  /** Still going. */
  | 'running'
  /** Tested now: the record for this namespace has a newer `testedAt`. */
  | 'tested'
  /** Finished without testing: this image had already passed here. */
  | 'already-passed'
  /** The suite disables the gate; the runner recorded `skipped`. */
  | 'skipped'
  /** The runner exited non-zero: the gate failed (or the run errored). */
  | 'failed'
  /** Finished, but the record does not show a new test — read the log. */
  | 'no-change'

/**
 * What a finished run did, for the sentence under the Run button.
 *
 * The runner does not retest an image that already passed the gate in that
 * namespace: it logs "already passed" and exits 0 without touching
 * `testedAt`. So "succeeded and testedAt unchanged and the gate says pass"
 * is that case, and the page says so rather than implying a fresh test.
 */
export function runOutcome(input: {
  phase: RunPhase
  namespace: string
  /** `testedAt` of the app's record when the run was started (known for a click in this tab). */
  testedAtBefore?: string
  /**
   * When the Job started. Used when `testedAtBefore` is unknown (a run started
   * elsewhere, or before a reload): a record written after the start is this run's.
   */
  startedAt?: string
  /** The app's record now. */
  after?: AppResult
  /** Tail of the runner's log, when read. */
  log?: string
}): RunOutcome {
  const { phase, namespace, testedAtBefore, startedAt, after, log } = input
  if (phase === 'pending' || phase === 'running') return 'running'
  if (phase === 'failed') return 'failed'
  const gate = after?.gates[namespace]
  const testedAt = after?.namespace === namespace ? after.testedAt : undefined
  const retested = !!testedAt && (
    testedAtBefore !== undefined || !startedAt
      ? testedAt !== testedAtBefore
      : Date.parse(testedAt) >= Date.parse(startedAt)
  )
  if (retested) return 'tested'
  if (gate?.verdict === 'skipped') return 'skipped'
  if ((log && /already passed the gate/i.test(log)) || gate?.verdict === 'pass') return 'already-passed'
  return 'no-change'
}

/** One sentence per outcome — one place, so every caller agrees. */
export function runOutcomeMessage(o: RunOutcome): string {
  switch (o) {
    case 'running':
      return 'Running — the load test and the faults take several minutes.'
    case 'tested':
      return 'Finished — the results below are from this run.'
    case 'already-passed':
      return 'Finished without retesting: this image had already passed the gate here, so the runner kept the earlier result.'
    case 'skipped':
      return 'Finished — the suite disables the promotion gate, so the verdict is recorded as skipped.'
    case 'failed':
      return 'The run failed — the gate did not pass, or the runner could not test the application. Read the log.'
    case 'no-change':
      return 'Finished, but the results do not show a new test of this environment. Read the log.'
  }
}

/* ─────────────────────────── display helpers ─────────────────────────── */

/** `0.01` → `1%`, `0.0025` → `0.25%`. */
export function formatRate(rate: number | undefined): string {
  if (rate === undefined) return '—'
  const pct = rate * 100
  return `${Number(pct.toFixed(pct < 1 ? 2 : 1))}%`
}

/** `9.2` → `9.2 ms`, `1234` → `1.23 s`. */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(2))} s` : `${Number(ms.toFixed(1))} ms`
}
