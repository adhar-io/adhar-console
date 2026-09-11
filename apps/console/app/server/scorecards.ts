import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'

/**
 * `GET /api/scorecards` — the platform's **authoritative** production-readiness
 * scores, read straight out of the cluster.
 *
 * The Adhar platform ships an `application/scorecards` package: a read-only
 * CronJob (`adhar-scorecard-scorer`, every 30 min) that grades every ArgoCD
 * Application 0–100 (A–F) from signals only an in-cluster job can see —
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
  /** Per-category score, 0–100. */
  categories: Record<PlatformCategory, number>
  signals: PlatformSignal[]
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
    })
  }
  return out
}

function coerceCategories(v: unknown): Record<PlatformCategory, number> {
  const src = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out = {} as Record<PlatformCategory, number>
  for (const cat of PLATFORM_CATEGORIES) out[cat] = clamp(Math.round(num(src[cat], 0)), 0, 100)
  return out
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
        // No breakdown in index.json — report zeroes, never invented numbers.
        categories: coerceCategories(undefined),
        signals: [],
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
