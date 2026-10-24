import { env, parseRunnerTimeline, type RunnerTimeline } from '@adhar/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { apiServerFetch, canI, type K8sIdentity, resolveIdentity } from './k8s/gateway.ts'
import { getK8sServiceToken, getTool } from './tool-registry.ts'
import { openStore, type Store } from './workspace/store.ts'
import {
  type ArgoAppLike,
  assembleMetrics,
  buildReport,
  metricsDue,
  metricsEmpty,
  metricsPlan,
  type QueryAnswer,
  type ChaosRunReport,
  type FreightLike,
  type JobLike,
  MAX_REPORTS_PER_APP,
  overflowIds,
  RECORDER_USER,
  REPORT_KIND,
  reportId,
  REPORTS_TENANT,
  shaQuery,
} from './resilience-reports-model.ts'

/**
 * `/api/resilience/reports` — the Chaos Engineering report of every resilience
 * run, kept per application and findable by the commit that was tested.
 *
 *   GET /api/resilience/reports[?app=&namespace=&commit=&limit=]
 *     → { configured, recorder, items: ChaosRunReport[] }   newest first
 *
 * THE RECORDER. The runner overwrites its one record per application on every
 * run, so history has to be captured as it happens. A timer on the server —
 * not a browser tab — reads `adhar-resilience-results` every minute as the
 * console's own ServiceAccount (cluster-wide read), and when an application's
 * `testedAt` has moved it freezes that run into a report: the experiments, the
 * load test, the gate verdict, the scorer's workload-design checks, the runner
 * Job that ran it and the commit of the image under test (see
 * `resilience-reports-model.ts`). Reports go to the console database in the
 * platform's shared space, at most `MAX_REPORTS_PER_APP` per application.
 *
 * Two more things are captured per run, both real and both optional:
 *
 *   • PHASES — the runner Job's log, read with timestamps, gives the wall-clock
 *     window of the load test and of each fault and its recovery
 *     (`parseRunnerTimeline`). Read at record time, while the Job's pod exists.
 *   • METRICS — once the run's padded window has closed, the target's request
 *     rate, error rate, p95, ready pods, restarts, CPU and memory are
 *     range-queried from Prometheus (the console's `prometheus` tool) and
 *     stored, compacted and bounded, in the report (`assembleMetrics`). An
 *     application that exports no HTTP metrics gets the series it has and a
 *     note for the rest; no Prometheus at all leaves the report without them.
 *
 * What it cannot see it does not invent: a run that started and finished
 * between two ticks while the console was down is lost (the runner keeps only
 * the latest), and a commit that cannot be resolved is stored as unknown.
 *
 * READING. The reports say what the results ConfigMap says, so reading them
 * needs what reading that ConfigMap needs: the caller's own RBAC is asked
 * (SelfSubjectAccessReview) and the console adds no privilege.
 */

const RESULTS_NAMESPACE = 'adhar-system'
const RESULTS_CONFIGMAP = 'adhar-resilience-results'
const SCORER_CONFIGMAP = env('ADHAR_SCORECARDS_CONFIGMAP') || 'adhar-scorecards'
const TICK_MS = 60_000
/** A read triggers a tick when the last one is older than this (dev, or a slow timer). */
const READ_TICK_MS = 15_000

/* ─────────────────────────── recorder ─────────────────────────── */

/** Report ids known to be stored — the DB is asked once per id per process. */
const stored = new Set<string>()
let lastTick = 0
let inflight: Promise<void> | undefined
let lastError: string | undefined

async function getJson<T>(id: K8sIdentity | string, path: string, search?: string): Promise<T | undefined> {
  const r = await apiServerFetch(id, path, search ? { search } : {})
  if (!r.ok) {
    await r.body?.cancel()
    return undefined
  }
  return (await r.json()) as T
}

async function readResults(id: K8sIdentity | string): Promise<Record<string, unknown> | undefined> {
  const cm = await getJson<{ data?: Record<string, string> }>(id, `/api/v1/namespaces/${RESULTS_NAMESPACE}/configmaps/${RESULTS_CONFIGMAP}`)
  const raw = cm?.data?.['results.json']
  if (!raw) return undefined
  try {
    const doc = JSON.parse(raw) as unknown
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * The runner Job's log with timestamps → this app's phases. Best effort: a
 * Job whose pod was garbage-collected simply has no phases.
 */
async function readTimeline(id: K8sIdentity | string, job: string | undefined, app: string): Promise<RunnerTimeline | undefined> {
  if (!job || !/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(job)) return undefined
  const pods = await getJson<{ items?: Array<{ metadata?: { name?: string; creationTimestamp?: string } }> }>(
    id,
    `/api/v1/namespaces/${RESULTS_NAMESPACE}/pods`,
    `?labelSelector=${encodeURIComponent(`job-name=${job}`)}`,
  )
  const pod = (pods?.items ?? []).filter((p) => p.metadata?.name)
    .sort((a, b) => (b.metadata?.creationTimestamp ?? '').localeCompare(a.metadata?.creationTimestamp ?? ''))[0]
  if (!pod) return undefined
  const r = await apiServerFetch(id, `/api/v1/namespaces/${RESULTS_NAMESPACE}/pods/${encodeURIComponent(pod.metadata!.name!)}/log`, {
    search: '?timestamps=true&tailLines=5000&limitBytes=2000000',
  })
  if (!r.ok) {
    await r.body?.cancel()
    return undefined
  }
  const t = parseRunnerTimeline(await r.text(), app)
  return t.phases.length ? t : undefined
}

/* ─────────────────────────── metrics ─────────────────────────── */

/** Range-query the console's Prometheus (or Mimir) tool. */
async function promRange(query: string, w: { start: number; end: number; stepSeconds: number }): Promise<QueryAnswer> {
  const t = getTool('prometheus')
  if (!t?.baseUrl) return { error: 'not configured' }
  const qs = new URLSearchParams({ query, start: String(w.start / 1000), end: String(w.end / 1000), step: String(w.stepSeconds) })
  try {
    const res = await fetch(`${t.baseUrl.replace(/\/$/, '')}/api/v1/query_range?${qs}`, {
      headers: {
        accept: 'application/json',
        ...(t.headers ?? {}),
        ...(t.authMode === 'service' && t.serviceToken ? { authorization: `Bearer ${t.serviceToken}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 160)
      return { error: `HTTP ${res.status}${body ? ` ${body}` : ''}` }
    }
    const body = (await res.json()) as { status?: string; error?: string; data?: { result?: Array<{ values?: Array<[number, string]> }> } }
    if (body.status !== 'success') return { error: body.error ?? 'query failed' }
    return body.data?.result ?? []
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Reports whose metrics are still to be captured (ids), filled at record time and by the first scan. */
const metricsPending = new Set<string>()
let metricsScanned = false

/**
 * Capture metrics for every report whose window has closed. Runs inside the
 * recorder tick; a report is attempted once — a failure is recorded as its
 * note rather than retried every minute.
 */
async function enrichMetrics(store: Store, now = Date.now()): Promise<void> {
  if (!getTool('prometheus')?.baseUrl) {
    // Nothing to capture with; a report recorded now simply has no metrics.
    metricsScanned = true
    metricsPending.clear()
    return
  }
  if (!metricsScanned) {
    metricsScanned = true
    const recent = await store.query<ChaosRunReport>(REPORT_KIND, { sort: { path: 'finishedAt', direction: 'desc' }, limit: 100, offset: 0 })
    for (const d of recent.items) if (metricsDue(d.data, now + 3600_000)) metricsPending.add(d.data.id)
  }
  for (const rid of [...metricsPending]) {
    const doc = await store.get<ChaosRunReport>(REPORT_KIND, rid)
    if (!doc) {
      metricsPending.delete(rid)
      continue
    }
    const r = doc.data
    if (r.metrics || r.metricsNote) {
      metricsPending.delete(rid)
      continue
    }
    if (!metricsDue(r, now)) {
      // Not closed yet (keep waiting) or too old (give up quietly).
      if (now - Date.parse(r.finishedAt) > 6 * 3600_000) metricsPending.delete(rid)
      continue
    }
    metricsPending.delete(rid)
    const plan = metricsPlan(r)
    if (!plan) continue
    const answers: Record<string, QueryAnswer> = {}
    await Promise.all(plan.queries.map(async (q) => {
      answers[q.id] = await promRange(q.query, plan.window)
    }))
    const metrics = assembleMetrics(plan, answers, r.phases ?? [], now)
    const failed = Object.values(answers).every((a) => !Array.isArray(a))
    const next: ChaosRunReport = failed
      ? { ...r, metricsNote: `Prometheus could not be queried when the run was recorded (${(Object.values(answers)[0] as { error: string }).error}).` }
      : metricsEmpty(metrics)
      ? { ...r, metrics, metricsNote: `Prometheus holds no samples for the pods of ${r.app} in ${r.namespace} over the run window.` }
      : { ...r, metrics }
    await store.put(REPORT_KIND, rid, next, RECORDER_USER)
    try {
      console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'resilience.report.metrics', id: rid, series: metrics.series.length, missing: metrics.missing?.length ?? 0 }))
    } catch { /* never let logging break the recorder */ }
  }
}

/** The context a report needs beyond the record — read once per tick, only when something is new. */
async function readContext(id: K8sIdentity | string) {
  const [jobs, freights, apps, scorer] = await Promise.all([
    getJson<{ items?: JobLike[] }>(id, `/apis/batch/v1/namespaces/${RESULTS_NAMESPACE}/jobs`),
    // Every project's freight: a digest is matched wherever it was discovered.
    getJson<{ items?: FreightLike[] }>(id, '/apis/kargo.akuity.io/v1alpha1/freights'),
    getJson<{ items?: ArgoAppLike[] }>(id, '/apis/argoproj.io/v1alpha1/applications', `?labelSelector=${encodeURIComponent('adhar.io/application')}`),
    getJson<{ data?: Record<string, string> }>(id, `/api/v1/namespaces/${RESULTS_NAMESPACE}/configmaps/${SCORER_CONFIGMAP}`),
  ])
  let services: unknown[] | undefined
  try {
    const summary = JSON.parse(scorer?.data?.['summary.json'] ?? 'null') as { services?: unknown[] } | null
    services = Array.isArray(summary?.services) ? summary.services : undefined
  } catch { /* the scorer is optional */ }
  return { jobs: jobs?.items ?? [], freights: freights?.items ?? [], argoApps: apps?.items ?? [], scorerServices: services }
}

async function prune(store: Store, app: string): Promise<void> {
  const page = await store.query<ChaosRunReport>(REPORT_KIND, {
    equals: [{ path: 'app', value: app }],
    sort: { path: 'finishedAt', direction: 'desc' },
    limit: MAX_REPORTS_PER_APP + 200,
    offset: 0,
  })
  for (const id of overflowIds(page.items, MAX_REPORTS_PER_APP)) {
    await store.remove(REPORT_KIND, id)
    stored.delete(id)
  }
}

async function tick(id: K8sIdentity | string): Promise<void> {
  lastTick = Date.now()
  const results = await readResults(id)
  const fresh = Object.entries(results ?? {}).filter(([app, rec]) => {
    const r = rec as { namespace?: unknown; testedAt?: unknown } | null
    return typeof r?.namespace === 'string' && typeof r?.testedAt === 'string' && !stored.has(reportId(app, r.namespace, r.testedAt))
  })
  if (!fresh.length && (metricsScanned && !metricsPending.size)) return
  const store = await openStore(REPORTS_TENANT)
  if (!store) return // no database: reports are durable or not kept at all
  try {
    await recordFresh(id, store, fresh)
  } finally {
    await enrichMetrics(store).catch((e) => console.warn('[resilience-reports] metrics:', e instanceof Error ? e.message : e))
  }
}

async function recordFresh(id: K8sIdentity | string, store: Store, fresh: Array<[string, unknown]>): Promise<void> {
  let ctx: Awaited<ReturnType<typeof readContext>> | undefined
  for (const [app, record] of fresh) {
    const r = record as { namespace: string; testedAt: string }
    const rid = reportId(app, r.namespace, r.testedAt)
    if (await store.get(REPORT_KIND, rid)) {
      stored.add(rid)
      continue
    }
    ctx ??= await readContext(id)
    const draft = buildReport({ app, record, ...ctx })
    if (!draft) continue
    const timeline = await readTimeline(id, draft.runId, app).catch(() => undefined)
    const report = timeline ? buildReport({ app, record, ...ctx, timeline }) ?? draft : draft
    await store.put(REPORT_KIND, report.id, report, RECORDER_USER)
    stored.add(report.id)
    metricsPending.add(report.id)
    await prune(store, app).catch((e) => console.warn(`[resilience-reports] prune ${app}:`, e))
    try {
      console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'resilience.report', id: report.id, app, commit: report.commit ?? null, trigger: report.trigger }))
    } catch { /* never let logging break the recorder */ }
  }
}

function runTick(id: K8sIdentity | string): Promise<void> {
  inflight ??= tick(id)
    .then(() => {
      lastError = undefined
    })
    .catch((e) => {
      lastError = e instanceof Error ? e.message : String(e)
      console.warn('[resilience-reports] tick failed:', lastError)
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

let running = false

/**
 * Start recording. Called once at boot; with no ServiceAccount token (a laptop)
 * it stays off and reads fall back to recording as the reader.
 */
export function startResilienceReports(): () => void {
  if (running) return () => {}
  if (env('ADHAR_RESILIENCE_REPORTS_DISABLED') === 'true') {
    console.log('[resilience-reports] disabled by ADHAR_RESILIENCE_REPORTS_DISABLED')
    return () => {}
  }
  const token = getK8sServiceToken()
  if (!token) {
    console.log('[resilience-reports] no ServiceAccount token — chaos run reports are recorded only while someone reads them')
    return () => {}
  }
  running = true
  const first = setTimeout(() => void runTick(token), 10_000)
  const timer = setInterval(() => void runTick(token), TICK_MS)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
    running = false
  }
}

/* ─────────────────────────── handler ─────────────────────────── */

function json(body: unknown, status = 200, cookie?: string): Response {
  const res = Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

const readable = new Map<string, { at: number; allowed: boolean }>()

/** May this user read the runner's results? Their RBAC answers, cached for a minute. */
async function mayRead(id: K8sIdentity): Promise<boolean> {
  const hit = readable.get(id.user.id)
  if (hit && Date.now() - hit.at < 60_000) return hit.allowed
  const { allowed } = await canI(id, { verb: 'get', resource: 'configmaps', namespace: RESULTS_NAMESPACE, name: RESULTS_CONFIGMAP })
  if (readable.size > 500) readable.clear()
  readable.set(id.user.id, { at: Date.now(), allowed })
  return allowed
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

export async function handleResilienceReports(req: Request, subpath: string): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const cookie = auth.refreshedCookie
  if (req.method.toUpperCase() !== 'GET') return new Response('Method Not Allowed', { status: 405 })
  if (subpath !== '' && subpath !== '/') return json({ error: 'not_found' }, 404, cookie)

  const id = await resolveIdentity(req)
  if (!id) return json({ error: 'no_identity', detail: 'The console has no Kubernetes identity for this session.' }, 503, cookie)
  if (!(await mayRead(id))) {
    return json({ error: 'forbidden', detail: `Reading chaos reports needs read access to ${RESULTS_NAMESPACE}/${RESULTS_CONFIGMAP}.` }, 403, cookie)
  }

  const store = await openStore(REPORTS_TENANT)
  if (!store) return json({ configured: false, items: [], detail: 'The console database is not configured, so run reports are not kept.' }, 200, cookie)

  // Catch up before answering when the timer is not running (no SA) or is
  // behind — a run that just finished should be in the list the user opens.
  const sa = getK8sServiceToken()
  if (Date.now() - lastTick > READ_TICK_MS) await runTick(sa ?? id)

  const q = new URL(req.url).searchParams
  const app = q.get('app') ?? ''
  const namespace = q.get('namespace') ?? ''
  const rawCommit = q.get('commit')
  const commit = shaQuery(rawCommit)
  if (rawCommit && !commit) return json({ error: 'invalid_request', detail: 'commit must be 4–40 hexadecimal characters.' }, 400, cookie)
  if (app && !DNS_LABEL.test(app)) return json({ error: 'invalid_request', detail: 'app must be a DNS-1123 label.' }, 400, cookie)
  if (namespace && !DNS_LABEL.test(namespace)) return json({ error: 'invalid_request', detail: 'namespace must be a DNS-1123 label.' }, 400, cookie)
  const limit = Math.min(Math.max(Number(q.get('limit')) || 500, 1), 2000)

  const page = await store.query<ChaosRunReport>(REPORT_KIND, {
    equals: [
      ...(app ? [{ path: 'app', value: app }] : []),
      ...(namespace ? [{ path: 'namespace', value: namespace }] : []),
    ],
    ...(commit ? { startsWith: [{ path: 'commit', value: commit }] } : {}),
    sort: { path: 'finishedAt', direction: 'desc' },
    limit,
    offset: 0,
  })
  return json({
    configured: true,
    recorder: { running, ...(lastError ? { error: lastError } : {}) },
    total: page.total,
    items: page.items.map((d) => d.data),
  }, 200, cookie)
}
