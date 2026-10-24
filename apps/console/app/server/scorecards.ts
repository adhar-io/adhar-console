import { env } from '@adhar/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'
import { requirePermission } from './k8s/access.ts'
import { CONSOLE_PERMISSIONS } from '@adhar/auth/server'

/**
 * `GET /api/scorecards` — the platform's **authoritative** production-readiness
 * scores, read straight out of the cluster.
 *
 * The Adhar platform ships an `application/scorecards` package: a read-only
 * CronJob (`adhar-scorecard-scorer`, every 30 min) that grades every ArgoCD
 * Application 0–100 (A–F) from signals only an adhar-controlplane job can see —
 * ArgoCD health/sync, container probes + requests/limits, image not `:latest`,
 * Kyverno PolicyReport pass rate, HTTPRoute exposure, and backup coverage
 * (Velero Schedule / CNPG `.spec.backup`) for stateful services. It publishes
 * the result to the ConfigMap `adhar-system/adhar-scorecards`:
 *
 *   summary.json  { generatedAt, weights{reliability,security,observability,
 *                   operations}, gradeThresholds{A,B,C,D}, serviceCount,
 *                   averageScore, services: [ { name, namespace, stateful,
 *                   score, grade, health, sync, categories{…0-100},
 *                   signals: [ { name, category, applicable, score(0–1) } ] } ] }
 *   index.json    { generatedAt, services: { "<name>": { score, grade } } }
 *
 * That ConfigMap is runtime-generated and deliberately NOT in Git (ArgoCD
 * selfHeal would revert the scorer's writes), so it simply does not exist when
 * the package is disabled — which is exactly what `configured: false` reports.
 * **Nothing here synthesises a score**: if the scorer has not run, the console
 * falls back to its own catalog-derived grading and says so in the UI.
 *
 * Identity: the caller's own session, through the same per-user k8s gateway the
 * rest of the console uses (`resolveIdentity` + `apiServerFetch`), so the
 * apiserver enforces the signed-in user's RBAC — the console adds no privilege.
 *
 * Environment (optional):
 *   - `ADHAR_SCORECARDS_NAMESPACE` — default `adhar-system`.
 *   - `ADHAR_SCORECARDS_CONFIGMAP` — default `adhar-scorecards`.
 *   - `ADHAR_SCORECARDS_CRD` — set to `false` to skip the (optional)
 *     `Scorecard` custom-resource read. The reference package does not ship a
 *     Scorecard CRD today, so a `404`/`NotFound` there is normal and silent.
 */

/* ─────────── wire types (shared with ~/data/scorecard.ts) ─────────── */

export const PLATFORM_CATEGORIES = [
  'reliability',
  'security',
  'observability',
  'operations',
  // Measured on applications only (the resilience runner's automated k6 load
  // test and Litmus pod-delete experiment, live SLOs, and how the workload is
  // built to survive failure). `null` on a platform package: nothing was tested.
  'performance',
  'resilience',
  // Measured where there is something to measure, otherwise `null` (no free
  // 100%): the images an application runs (pinned, from the platform
  // registry, no critical CVEs) and how well its requests match real usage.
  'supply_chain',
  'efficiency',
] as const

export type PlatformCategory = (typeof PLATFORM_CATEGORIES)[number]

export type PlatformGrade = 'A' | 'B' | 'C' | 'D' | 'F'

/** One scored signal from the scorer's ledger. `score` is a 0–1 fraction. */
export interface PlatformSignal {
  name: string
  category: PlatformCategory
  /** False when the signal could not be evaluated — dropped from the denominator. */
  applicable: boolean
  score: number
  /** Why it scored what it did, in the scorer's words (e.g. "p95 120 ms (target < 500 ms)…"). */
  detail?: string
}

/** One environment of an application, as Argo CD reports it. */
export interface PlatformEnvironment {
  name: string
  namespace: string
  health: string
  sync: string
  argocdApp: string
}

/** What the resilience runner proved about an application (its raw record). */
export interface PlatformEvidence {
  environment?: string
  image?: string
  testedAt?: string
  target?: string
  pending?: string
  performance?: Record<string, unknown>
  chaos?: Record<string, unknown>
  /** Every fault of the automated chaos suite, by experiment name. */
  chaosSuite?: Record<string, Record<string, unknown>>
  slo?: Record<string, unknown> | null
}

export interface PlatformService {
  /** Scorer key — the ArgoCD Application name. */
  name: string
  namespace: string
  stateful: boolean
  /** 0–100. */
  score: number
  grade: PlatformGrade
  /** ArgoCD `status.health.status` at scoring time. */
  health: string
  /** ArgoCD `status.sync.status` at scoring time. */
  sync: string
  /** Per-category score, 0–100; `null` when no signal in it applies. */
  categories: Record<PlatformCategory, number | null>
  signals: PlatformSignal[]
  /**
   * `application` — one record per delivered application (named after it, so it
   * joins the catalog entity), graded on its most-promoted environment.
   * `package` — a platform package, one per Argo CD Application.
   */
  kind: 'application' | 'package'
  /** The environment an application was graded on. */
  environment?: string
  environments?: PlatformEnvironment[]
  evidence?: PlatformEvidence
  /** The team's own Performance Center results targeting this application. */
  perfCenter?: Record<string, unknown>
  /** Game days (console / ChaosCenter) that targeted its workload. */
  gameDays?: Record<string, unknown>
}

export interface PlatformScorecards {
  /** True only when the results ConfigMap actually exists and parsed. */
  configured: boolean
  source: 'platform-scorer'
  namespace: string
  configMap: string
  /** `summary.json.generatedAt`, else the ConfigMap's generated-at annotation. */
  lastRun?: string
  weights?: Record<PlatformCategory, number>
  gradeThresholds?: Record<Exclude<PlatformGrade, 'F'>, number>
  serviceCount: number
  averageScore?: number
  services: PlatformService[]
  /** Machine code: `not_installed` | `forbidden` | `unreadable` | `apiserver_error`. */
  error?: string
  detail?: string
}

/* ─────────── helpers ─────────── */

const DEFAULT_NAMESPACE = 'adhar-system'
const DEFAULT_CONFIGMAP = 'adhar-scorecards'
const GRADES = new Set<PlatformGrade>(['A', 'B', 'C', 'D', 'F'])

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function empty(namespace: string, configMap: string, error?: string, detail?: string): PlatformScorecards {
  return {
    configured: false,
    source: 'platform-scorer',
    namespace,
    configMap,
    serviceCount: 0,
    services: [],
    ...(error ? { error } : {}),
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/** Letter grade from the scorer's own thresholds — never re-derived locally. */
function coerceGrade(v: unknown): PlatformGrade | undefined {
  const s = str(v)?.toUpperCase()
  return s && GRADES.has(s as PlatformGrade) ? (s as PlatformGrade) : undefined
}

function coerceCategory(v: unknown): PlatformCategory | undefined {
  const s = str(v)
  return s && (PLATFORM_CATEGORIES as readonly string[]).includes(s) ? (s as PlatformCategory) : undefined
}

function coerceSignals(v: unknown): PlatformSignal[] {
  if (!Array.isArray(v)) return []
  const out: PlatformSignal[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = str(r.name)
    const category = coerceCategory(r.category)
    if (!name || !category) continue
    out.push({
      name,
      category,
      applicable: r.applicable !== false,
      score: clamp(num(r.score, 0), 0, 1),
      ...(str(r.detail) ? { detail: str(r.detail)!.slice(0, 400) } : {}),
    })
  }
  return out
}

function coerceCategories(v: unknown): Record<PlatformCategory, number | null> {
  const src = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out = {} as Record<PlatformCategory, number | null>
  for (const cat of PLATFORM_CATEGORIES) {
    const n = num(src[cat], Number.NaN)
    // Absent or null means "nothing in this category applies" — a scorer that
    // predates a category reports it as missing, and neither is a zero.
    out[cat] = Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : null
  }
  return out
}

function coerceEnvironments(v: unknown): PlatformEnvironment[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: PlatformEnvironment[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = str(r.name)
    if (!name) continue
    out.push({
      name,
      namespace: str(r.namespace) ?? name,
      health: str(r.health) ?? 'Unknown',
      sync: str(r.sync) ?? 'Unknown',
      argocdApp: str(r.argocdApp) ?? '',
    })
  }
  return out
}

function coerceEvidence(v: unknown): PlatformEvidence | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const r = v as Record<string, unknown>
  const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined)
  const out: PlatformEvidence = {
    ...(str(r.environment) ? { environment: str(r.environment) } : {}),
    ...(str(r.image) ? { image: str(r.image) } : {}),
    ...(str(r.testedAt) ? { testedAt: str(r.testedAt) } : {}),
    ...(str(r.target) ? { target: str(r.target) } : {}),
    ...(str(r.pending) ? { pending: str(r.pending) } : {}),
    ...(obj(r.performance) ? { performance: obj(r.performance) } : {}),
    ...(obj(r.chaos) ? { chaos: obj(r.chaos) } : {}),
    ...(obj(r.slo) ? { slo: obj(r.slo) } : {}),
    ...(obj(r.chaosSuite) ? { chaosSuite: obj(r.chaosSuite) as Record<string, Record<string, unknown>> } : {}),
  }
  return Object.keys(out).length ? out : undefined
}

function coerceWeights(v: unknown): Record<PlatformCategory, number> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const src = v as Record<string, unknown>
  const out = {} as Record<PlatformCategory, number>
  let any = false
  for (const cat of PLATFORM_CATEGORIES) {
    const n = num(src[cat], Number.NaN)
    if (Number.isFinite(n)) any = true
    out[cat] = Number.isFinite(n) ? n : 0
  }
  return any ? out : undefined
}

function coerceThresholds(v: unknown): Record<'A' | 'B' | 'C' | 'D', number> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const src = v as Record<string, unknown>
  const keys = ['A', 'B', 'C', 'D'] as const
  const out = {} as Record<'A' | 'B' | 'C' | 'D', number>
  let any = false
  for (const k of keys) {
    const n = num(src[k], Number.NaN)
    if (Number.isFinite(n)) any = true
    out[k] = Number.isFinite(n) ? n : 0
  }
  return any ? out : undefined
}

function coerceService(raw: unknown): PlatformService | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = str(r.name)
  if (!name) return null
  const score = clamp(Math.round(num(r.score, 0)), 0, 100)
  return {
    name,
    namespace: str(r.namespace) ?? '',
    stateful: r.stateful === true,
    score,
    // The scorer's grade is authoritative (its thresholds are operator-tunable);
    // fall back only when the record genuinely carries none.
    grade: coerceGrade(r.grade) ?? gradeFrom(score),
    health: str(r.health) ?? 'Unknown',
    sync: str(r.sync) ?? 'Unknown',
    categories: coerceCategories(r.categories),
    signals: coerceSignals(r.signals),
    kind: r.kind === 'application' ? 'application' : 'package',
    ...(str(r.environment) ? { environment: str(r.environment) } : {}),
    ...(coerceEnvironments(r.environments) ? { environments: coerceEnvironments(r.environments) } : {}),
    ...(coerceEvidence(r.evidence) ? { evidence: coerceEvidence(r.evidence) } : {}),
    ...(r.perfCenter && typeof r.perfCenter === 'object' && !Array.isArray(r.perfCenter)
      ? { perfCenter: r.perfCenter as Record<string, unknown> }
      : {}),
    ...(r.gameDays && typeof r.gameDays === 'object' && !Array.isArray(r.gameDays)
      ? { gameDays: r.gameDays as Record<string, unknown> }
      : {}),
  }
}

function gradeFrom(score: number, thresholds?: Record<'A' | 'B' | 'C' | 'D', number>): PlatformGrade {
  const t = thresholds ?? { A: 90, B: 80, C: 70, D: 60 }
  if (score >= t.A) return 'A'
  if (score >= t.B) return 'B'
  if (score >= t.C) return 'C'
  if (score >= t.D) return 'D'
  return 'F'
}

/**
 * Normalise the scorer's `summary.json`. `index.json` (name → {score, grade})
 * is only a compact lookup of the same data, so it is used as a fallback when
 * the full summary is missing or unparseable — a grade with no breakdown is
 * still an honest grade.
 */
export function normaliseScorerConfigMap(
  data: Record<string, unknown>,
  namespace: string,
  configMap: string,
  annotatedAt?: string,
): PlatformScorecards {
  const parse = (key: string): Record<string, unknown> | null => {
    const raw = data[key]
    if (typeof raw !== 'string' || !raw.trim()) return null
    try {
      const doc = JSON.parse(raw) as unknown
      return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  const summary = parse('summary.json')
  const index = parse('index.json')

  if (summary && Array.isArray(summary.services)) {
    const services = summary.services
      .map(coerceService)
      .filter((s): s is PlatformService => s !== null)
    const thresholds = coerceThresholds(summary.gradeThresholds)
    const averageScore = Number.isFinite(num(summary.averageScore, Number.NaN))
      ? clamp(Math.round(num(summary.averageScore, 0)), 0, 100)
      : services.length
        ? Math.round(services.reduce((sum, s) => sum + s.score, 0) / services.length)
        : undefined
    return {
      configured: true,
      source: 'platform-scorer',
      namespace,
      configMap,
      lastRun: str(summary.generatedAt) ?? annotatedAt,
      weights: coerceWeights(summary.weights),
      gradeThresholds: thresholds,
      serviceCount: services.length,
      averageScore,
      services,
    }
  }

  if (index && index.services && typeof index.services === 'object') {
    const src = index.services as Record<string, unknown>
    const services: PlatformService[] = []
    for (const [name, v] of Object.entries(src)) {
      if (!v || typeof v !== 'object') continue
      const r = v as Record<string, unknown>
      const score = clamp(Math.round(num(r.score, 0)), 0, 100)
      services.push({
        name,
        namespace: '',
        stateful: false,
        score,
        grade: coerceGrade(r.grade) ?? gradeFrom(score),
        health: 'Unknown',
        sync: 'Unknown',
        // No breakdown in index.json — no category numbers, never invented ones.
        categories: coerceCategories(undefined),
        signals: [],
        kind: r.kind === 'application' ? 'application' : 'package',
      })
    }
    return {
      configured: true,
      source: 'platform-scorer',
      namespace,
      configMap,
      lastRun: str(index.generatedAt) ?? annotatedAt,
      serviceCount: services.length,
      averageScore: services.length
        ? Math.round(services.reduce((sum, s) => sum + s.score, 0) / services.length)
        : undefined,
      services,
    }
  }

  return empty(namespace, configMap, 'unreadable', 'ConfigMap present but summary.json/index.json could not be parsed')
}

/**
 * Optional `Scorecard` custom resources. The reference `scorecards` package
 * publishes the ConfigMap only, so this is a pure enrichment: any CR found
 * (`scorecards.platform.adhar.io`) overrides/adds the matching service. A
 * missing CRD is the normal case and is swallowed.
 */
function mergeScorecardCrs(base: PlatformScorecards, items: unknown[]): PlatformScorecards {
  if (!items.length) return base
  const byName = new Map(base.services.map((s) => [s.name, s]))
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as { metadata?: Record<string, unknown>; spec?: unknown; status?: unknown }
    const meta = obj.metadata ?? {}
    const name = str(meta.name)
    if (!name) continue
    const body = (obj.status && typeof obj.status === 'object' ? obj.status : obj.spec) as unknown
    const rec = coerceService({ name, namespace: str(meta.namespace), ...(body as object) })
    if (rec) byName.set(name, rec)
  }
  const services = Array.from(byName.values()).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return {
    ...base,
    configured: true,
    serviceCount: services.length,
    averageScore: services.length
      ? Math.round(services.reduce((sum, s) => sum + s.score, 0) / services.length)
      : undefined,
    services,
  }
}

/* ─────────── handler ─────────── */

export async function handleScorecards(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  const namespace = env('ADHAR_SCORECARDS_NAMESPACE') || DEFAULT_NAMESPACE
  const configMap = env('ADHAR_SCORECARDS_CONFIGMAP') || DEFAULT_CONFIGMAP

  const id = await resolveIdentity(req)
  if (!id) return withCookie(unauthorized('session_expired'), auth.refreshedCookie)

  let res: Response
  try {
    res = await apiServerFetch(
      id,
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(configMap)}`,
    )
  } catch (e) {
    return withCookie(
      Response.json(
        empty(namespace, configMap, 'apiserver_error', e instanceof Error ? e.message : String(e)),
        { status: 502 },
      ),
      auth.refreshedCookie,
    )
  }

  if (res.status === 404) {
    await res.body?.cancel()
    // The scorecards package is not installed (or has never run). Honest empty.
    return withCookie(
      Response.json(
        empty(
          namespace,
          configMap,
          'not_installed',
          `ConfigMap ${namespace}/${configMap} not found — enable the "scorecards" package`,
        ),
      ),
      auth.refreshedCookie,
    )
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const code = res.status === 401 || res.status === 403 ? 'forbidden' : 'apiserver_error'
    return withCookie(
      Response.json(empty(namespace, configMap, code, detail), { status: res.status === 403 ? 403 : 502 }),
      auth.refreshedCookie,
    )
  }

  let cm: { data?: Record<string, unknown>; metadata?: { annotations?: Record<string, string> } }
  try {
    cm = (await res.json()) as typeof cm
  } catch (e) {
    return withCookie(
      Response.json(empty(namespace, configMap, 'unreadable', e instanceof Error ? e.message : String(e)), {
        status: 502,
      }),
      auth.refreshedCookie,
    )
  }

  const annotatedAt = cm.metadata?.annotations?.['adhar.io/scorecard-generated-at']
  let payload = normaliseScorerConfigMap(cm.data ?? {}, namespace, configMap, annotatedAt)

  if ((env('ADHAR_SCORECARDS_CRD') ?? 'true') !== 'false') {
    payload = mergeScorecardCrs(payload, await readScorecardCrs(id))
  }

  return withCookie(Response.json(payload), auth.refreshedCookie)
}

/** Best-effort read of `Scorecard` CRs; a missing CRD yields an empty list. */
async function readScorecardCrs(id: Parameters<typeof apiServerFetch>[0]): Promise<unknown[]> {
  try {
    const res = await apiServerFetch(id, '/apis/platform.adhar.io/v1alpha1/scorecards', {
      search: '?limit=500',
    })
    if (!res.ok) {
      await res.body?.cancel()
      return []
    }
    const body = (await res.json()) as { items?: unknown[] }
    return Array.isArray(body.items) ? body.items : []
  } catch {
    return []
  }
}

/* ─────────── history + re-evaluate ─────────── */

/**
 * One past run, as the scorer records it in `<configmap>-history`.
 *
 * Compact on purpose: the scorer keeps the full per-signal ledger for the
 * CURRENT run only. Twenty-four of those would push the ConfigMap past etcd's
 * 1 MiB object limit on a platform this size, and a write that fails takes the
 * live results down with the history — so a run's history entry carries the
 * totals, the grade distribution and a per-service score, which is what a trend
 * is made of.
 */
export interface ScorecardHistoryEntry {
  at: string
  serviceCount: number
  averageScore?: number
  grades: Partial<Record<PlatformGrade, number>>
  services: Record<string, { score: number; grade: PlatformGrade }>
}

export interface ScorecardHistory {
  configured: boolean
  namespace: string
  configMap: string
  entries: ScorecardHistoryEntry[]
  error?: string
  detail?: string
}

const DEFAULT_CRONJOB = 'adhar-scorecard-scorer'

function historyEntry(v: unknown): ScorecardHistoryEntry | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const at = str(o.at)
  if (!at) return undefined
  const services: ScorecardHistoryEntry['services'] = {}
  if (o.services && typeof o.services === 'object') {
    for (const [k, raw] of Object.entries(o.services as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const grade = coerceGrade(r.grade)
      if (!grade) continue
      services[k] = { score: clamp(num(r.score, 0), 0, 100), grade }
    }
  }
  const grades: ScorecardHistoryEntry['grades'] = {}
  if (o.grades && typeof o.grades === 'object') {
    for (const [k, raw] of Object.entries(o.grades as Record<string, unknown>)) {
      const g = coerceGrade(k)
      if (g) grades[g] = num(raw, 0)
    }
  }
  return {
    at,
    serviceCount: num(o.serviceCount, Object.keys(services).length),
    ...(typeof o.averageScore === 'number' ? { averageScore: clamp(o.averageScore, 0, 100) } : {}),
    grades,
    services,
  }
}

/**
 * `GET /api/scorecards/history` — the scorer's rolling series.
 *
 * A missing ConfigMap is not an error: a platform that has only ever run the
 * scorer once has no history yet, and an empty series with `configured: false`
 * says exactly that. The page then shows the current score without a trend
 * rather than an error banner about a file nobody asked for.
 */
export async function handleScorecardHistory(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'GET') return new Response('Method Not Allowed', { status: 405 })
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  const namespace = env('ADHAR_SCORECARDS_NAMESPACE') || DEFAULT_NAMESPACE
  const configMap = `${env('ADHAR_SCORECARDS_CONFIGMAP') || DEFAULT_CONFIGMAP}-history`
  const base: ScorecardHistory = { configured: false, namespace, configMap, entries: [] }

  const id = await resolveIdentity(req)
  if (!id) return withCookie(unauthorized('session_expired'), auth.refreshedCookie)

  try {
    const res = await apiServerFetch(
      id,
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(configMap)}`,
    )
    if (res.status === 404) {
      await res.body?.cancel()
      return withCookie(Response.json({ ...base, error: 'not_installed' }), auth.refreshedCookie)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const code = res.status === 401 || res.status === 403 ? 'forbidden' : 'apiserver_error'
      return withCookie(
        Response.json({ ...base, error: code, detail: detail.slice(0, 500) }, { status: res.status === 403 ? 403 : 502 }),
        auth.refreshedCookie,
      )
    }
    const cm = (await res.json()) as { data?: Record<string, string> }
    const raw = cm.data?.['history.json']
    if (!raw) return withCookie(Response.json({ ...base, error: 'unreadable' }), auth.refreshedCookie)
    const parsed = JSON.parse(raw) as unknown
    const entries = (Array.isArray(parsed) ? parsed : [])
      .map(historyEntry)
      .filter((e): e is ScorecardHistoryEntry => !!e)
      .sort((a, b) => a.at.localeCompare(b.at))
    return withCookie(
      Response.json({ ...base, configured: entries.length > 0, entries }),
      auth.refreshedCookie,
    )
  } catch (e) {
    return withCookie(
      Response.json({ ...base, error: 'apiserver_error', detail: e instanceof Error ? e.message : String(e) }, { status: 502 }),
      auth.refreshedCookie,
    )
  }
}

/**
 * `POST /api/scorecards/rerun` — score the platform now instead of waiting for
 * the next half-hour tick.
 *
 * It does NOT re-implement scoring. It creates a Job from the scorer CronJob's
 * own `jobTemplate`, which is how `kubectl create job --from=cronjob/…` works
 * and is the only way to be sure a manual run and a scheduled run produce the
 * same numbers. The scorer's `concurrencyPolicy: Forbid` applies to the
 * schedule, not to this, so the handler refuses while one of its own runs is
 * still active — two scorers racing on the same results ConfigMap is a
 * last-writer-wins corruption of the very thing being read.
 *
 * Identity is the caller's: creating a Job requires `create jobs` in the
 * namespace, so a viewer gets a 403 from the apiserver rather than from a rule
 * invented here.
 *
 * Optional body `{ service }` — the per-service "Re-evaluate" in the drawer.
 * The scorer grades the whole platform in one pass and has no single-service
 * mode, so the run is the same full run; the service is recorded on the Job
 * (`adhar.io/scorecard-focus`) for whoever reads the namespace, and echoed back
 * as `focus` so the caller knows which service it is waiting on. A body-less
 * POST behaves exactly as before.
 */
export function rerunFocus(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const s = (body as Record<string, unknown>).service
  return typeof s === 'string' && /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(s.trim()) ? s.trim() : undefined
}

export async function handleScorecardRerun(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const focus = rerunFocus(await req.json().catch(() => null))

  const namespace = env('ADHAR_SCORECARDS_NAMESPACE') || DEFAULT_NAMESPACE
  const cronName = env('ADHAR_SCORECARDS_CRONJOB') || DEFAULT_CRONJOB
  const id = await resolveIdentity(req)
  if (!id) return withCookie(unauthorized('session_expired'), auth.refreshedCookie)
  // Re-evaluating is a console action (`update scorecards.console.adhar.io`)
  // on top of the Job create below, which the apiserver checks as the user.
  const denied = await requirePermission(req, CONSOLE_PERMISSIONS.scorecardsRun, { id })
  if (denied) return withCookie(denied, auth.refreshedCookie)

  const fail = (status: number, error: string, detail?: string) =>
    withCookie(Response.json({ started: false, error, ...(detail ? { detail: detail.slice(0, 500) } : {}) }, { status }), auth.refreshedCookie)

  try {
    const cronRes = await apiServerFetch(
      id,
      `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/cronjobs/${encodeURIComponent(cronName)}`,
    )
    if (cronRes.status === 404) {
      await cronRes.body?.cancel()
      return fail(404, 'not_installed', `CronJob ${namespace}/${cronName} not found — enable the "adhar-scorecards" package`)
    }
    if (!cronRes.ok) {
      const detail = await cronRes.text().catch(() => '')
      return fail(cronRes.status === 403 ? 403 : 502, cronRes.status === 403 ? 'forbidden' : 'apiserver_error', detail)
    }
    const cron = (await cronRes.json()) as {
      metadata?: { uid?: string; name?: string }
      spec?: { jobTemplate?: { metadata?: Record<string, unknown>; spec?: Record<string, unknown> } }
    }
    const template = cron.spec?.jobTemplate
    if (!template?.spec) return fail(502, 'unreadable', 'CronJob has no jobTemplate.spec')

    // An already-running manual job means the previous click is still working.
    const active = await apiServerFetch(
      id,
      `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`,
      { search: `?labelSelector=${encodeURIComponent('adhar.io/scorecard-run=manual')}` },
    )
    if (active.ok) {
      const list = (await active.json()) as { items?: Array<{ metadata?: { name?: string }; status?: { active?: number } }> }
      const running = (list.items ?? []).find((j) => (j.status?.active ?? 0) > 0)
      if (running) {
        return withCookie(
          Response.json({ started: false, error: 'already_running', job: running.metadata?.name, ...(focus ? { focus } : {}) }, { status: 409 }),
          auth.refreshedCookie,
        )
      }
    } else {
      await active.body?.cancel()
    }

    const name = `${cronName}-manual-${Date.now().toString(36)}`
    const tplMeta = (template.metadata ?? {}) as { labels?: Record<string, string>; annotations?: Record<string, string> }
    const body = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name,
        namespace,
        labels: {
          ...(tplMeta.labels ?? {}),
          'adhar.io/component': 'scorecards',
          // Both the "is one running?" check above and any operator looking at
          // the namespace need to tell a click apart from the schedule.
          'adhar.io/scorecard-run': 'manual',
        },
        annotations: {
          ...(tplMeta.annotations ?? {}),
          'adhar.io/triggered-by': auth.user?.email || auth.user?.name || 'console',
          'cronjob.kubernetes.io/instantiate': 'manual',
          ...(focus ? { 'adhar.io/scorecard-focus': focus } : {}),
        },
        // Owned by the CronJob, exactly as `kubectl create job --from` does, so
        // deleting the package cleans the manual runs up too.
        ...(cron.metadata?.uid
          ? {
            ownerReferences: [{
              apiVersion: 'batch/v1',
              kind: 'CronJob',
              name: cron.metadata.name ?? cronName,
              uid: cron.metadata.uid,
              controller: false,
              blockOwnerDeletion: false,
            }],
          }
          : {}),
      },
      spec: template.spec,
    }

    const created = await apiServerFetch(
      id,
      `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`,
      { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    )
    if (!created.ok) {
      const detail = await created.text().catch(() => '')
      return fail(created.status === 403 ? 403 : 502, created.status === 403 ? 'forbidden' : 'apiserver_error', detail)
    }
    await created.body?.cancel()
    return withCookie(Response.json({ started: true, job: name, namespace, ...(focus ? { focus } : {}) }), auth.refreshedCookie)
  } catch (e) {
    return fail(502, 'apiserver_error', e instanceof Error ? e.message : String(e))
  }
}
