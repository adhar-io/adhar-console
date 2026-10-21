import { normaliseToken } from './role-tokens.ts'
import { getRequestUser, unauthorized } from './request-user.ts'
import { apiServerFetch, originOk, resolveIdentity, type K8sIdentity } from './k8s/gateway.ts'
import { getK8sServiceToken } from './tool-registry.ts'

/**
 * `/api/resilience/runs` — run an application's resilience suite now, from the
 * Chaos page, instead of waiting for the runner's hourly pass or a promotion.
 *
 *   GET  /api/resilience/runs          → { installed, allowed, runs: ResilienceRun[] }
 *   POST /api/resilience/runs          { app, namespace, environment } → { started, job }
 *   GET  /api/resilience/runs/log?job= → { job, pod, log }
 *
 * A run is the runner's own GATE mode: a Job made from CronJob
 * `adhar-system/adhar-resilience-runner`'s `jobTemplate.spec` with
 * `VERIFY_APP`/`VERIFY_NAMESPACE`/`VERIFY_ENVIRONMENT` added — exactly what a
 * project's Kargo verification starts after a promotion. So a click and a
 * promotion cannot test differently, and the verdict lands in the same place
 * (`adhar-resilience-results`, `.gates[<namespace>]`).
 *
 * Identity: the console's OWN ServiceAccount, not the caller's. The platform
 * binds the narrow `adhar-resilience-gate` Role to it (get that one CronJob,
 * create/get/list Jobs, get pods and pods/log in adhar-system) — the same
 * rights a project's gate has, and nothing a person would otherwise hold in
 * adhar-system. Because the SA acts for whoever clicks, the role check below
 * is the gate for starting a run; reading status and logs is limited to Jobs
 * that carry the gate label, so this cannot become a log reader for anything
 * else in the namespace.
 */

export const RUNNER_NAMESPACE = 'adhar-system'
export const RUNNER_CRONJOB = 'adhar-resilience-runner'
export const GATE_LABEL = 'adhar.io/resilience-gate'
export const NAMESPACE_LABEL = 'adhar.io/resilience-namespace'
export const ENVIRONMENT_LABEL = 'adhar.io/resilience-environment'
export const TRIGGER_LABEL = 'adhar.io/triggered-by'

/** Console roles allowed to start a suite. The server is the gate; the UI mirrors it. */
const ALLOWED_TOKENS = new Set([
  'admin', 'super-admin', 'superadmin',
  'platform-admin', 'platform-admins',
  'platform-engineer', 'platform-engineers', 'platform-eng',
  'application-admin', 'application-admins', 'app-admin', 'tenant-admin',
])

/** True when the user may start a resilience run (it load-tests and breaks pods). */
export function canRunSuites(user: { roles?: readonly string[]; groups?: readonly string[] } | null | undefined): boolean {
  if (!user) return false
  for (const raw of [...(user.roles ?? []), ...(user.groups ?? [])]) {
    if (typeof raw === 'string' && ALLOWED_TOKENS.has(normaliseToken(raw))) return true
  }
  return false
}

/* ─────────────────────────── pure: request + manifest ─────────────────────────── */

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

export interface RunRequest {
  app: string
  namespace: string
  environment: string
}

export type RunValidation = ({ ok: true } & RunRequest) | { ok: false; detail: string }

/** Validate the POST body. Every value ends up in a label or an env var. */
export function validateRunRequest(body: unknown): RunValidation {
  if (!body || typeof body !== 'object') return { ok: false, detail: 'Expected a JSON object.' }
  const { app, namespace, environment } = body as Record<string, unknown>
  if (typeof app !== 'string' || !DNS_LABEL.test(app)) return { ok: false, detail: 'app must be a DNS-1123 label.' }
  if (typeof namespace !== 'string' || !DNS_LABEL.test(namespace)) return { ok: false, detail: 'namespace must be a DNS-1123 label.' }
  const env = typeof environment === 'string' && environment.trim() ? environment.trim() : namespace
  if (!DNS_LABEL.test(env)) return { ok: false, detail: 'environment must be a DNS-1123 label.' }
  return { ok: true, app, namespace, environment: env }
}

/** Lowercase, `[a-z0-9-]` only, single dashes, no dash at either end. */
export function dnsSafe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * `adhar-gate-<app>-<env>-<suffix>`, at most 63 characters and DNS-safe. The
 * app/env part is what gets shortened — the prefix says what the Job is and
 * the suffix keeps two clicks apart, so neither may be cut.
 */
export function gateJobName(app: string, environment: string, suffix: string): string {
  const prefix = 'adhar-gate'
  const tail = dnsSafe(suffix).slice(0, 8) || 'run'
  const room = 63 - prefix.length - tail.length - 2
  const middle = dnsSafe(`${app}-${environment}`).slice(0, room).replace(/-+$/, '')
  return middle ? `${prefix}-${middle}-${tail}` : `${prefix}-${tail}`
}

/** A short random suffix, base36. */
export function runSuffix(): string {
  return Math.random().toString(36).slice(2, 7).padEnd(5, '0')
}

interface EnvVar {
  name: string
  value?: string
  valueFrom?: unknown
}

export interface CronJobLike {
  metadata?: { name?: string; uid?: string }
  spec?: { jobTemplate?: { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: Record<string, unknown> } }
}

export interface GateJob {
  apiVersion: 'batch/v1'
  kind: 'Job'
  metadata: {
    name: string
    namespace: string
    labels: Record<string, string>
    annotations: Record<string, string>
    ownerReferences?: Array<Record<string, unknown>>
  }
  spec: Record<string, unknown>
}

/**
 * The Job for one gate run, from the CronJob's own template.
 *
 * The template is deep-copied (the CronJob object is never mutated) and any
 * `VERIFY_*` the template already carries is replaced rather than duplicated —
 * with two entries of one name the kubelet keeps the LAST, and which one that
 * is should not depend on the template's order.
 */
export function buildGateJob(
  cron: CronJobLike,
  req: RunRequest,
  opts: { suffix: string; triggeredBy?: string },
): GateJob {
  const template = cron.spec?.jobTemplate
  if (!template?.spec) throw new Error('CronJob has no jobTemplate.spec')
  const spec = structuredClone(template.spec) as {
    template?: { spec?: { containers?: Array<{ env?: EnvVar[] }> } }
  }
  const container = spec.template?.spec?.containers?.[0]
  if (!container) throw new Error('CronJob jobTemplate has no container')

  const verify: EnvVar[] = [
    { name: 'VERIFY_APP', value: req.app },
    { name: 'VERIFY_NAMESPACE', value: req.namespace },
    { name: 'VERIFY_ENVIRONMENT', value: req.environment },
  ]
  const replaced = new Set(verify.map((v) => v.name))
  container.env = [...(container.env ?? []).filter((e) => !replaced.has(e.name)), ...verify]

  const tplMeta = template.metadata ?? {}
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: gateJobName(req.app, req.environment, opts.suffix),
      namespace: RUNNER_NAMESPACE,
      labels: {
        ...(tplMeta.labels ?? {}),
        'adhar.io/component': 'scorecards',
        [GATE_LABEL]: req.app,
        [NAMESPACE_LABEL]: req.namespace,
        [ENVIRONMENT_LABEL]: req.environment,
        [TRIGGER_LABEL]: 'console',
      },
      annotations: {
        ...(tplMeta.annotations ?? {}),
        'cronjob.kubernetes.io/instantiate': 'manual',
        // Who clicked — the SA created it, so this is the only record of the person.
        ...(opts.triggeredBy ? { 'adhar.io/triggered-by-user': opts.triggeredBy } : {}),
      },
      // Owned by the CronJob, as `kubectl create job --from` does, so removing
      // the scorecards package removes the manual runs too.
      ...(cron.metadata?.uid
        ? {
          ownerReferences: [{
            apiVersion: 'batch/v1',
            kind: 'CronJob',
            name: cron.metadata.name ?? RUNNER_CRONJOB,
            uid: cron.metadata.uid,
            controller: false,
            blockOwnerDeletion: false,
          }],
        }
        : {}),
    },
    spec: spec as Record<string, unknown>,
  }
}

/* ─────────────────────────── wire types ─────────────────────────── */

export interface ResilienceRun {
  job: string
  app: string
  namespace: string
  environment: string
  /** `console` for a click; absent for a Kargo-started gate. */
  triggeredBy?: string
  startTime?: string
  completionTime?: string
  status: {
    active?: number
    succeeded?: number
    failed?: number
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
  }
}

interface JobObj {
  metadata?: { name?: string; labels?: Record<string, string>; creationTimestamp?: string }
  spec?: { template?: { spec?: { containers?: Array<{ env?: EnvVar[] }> } } }
  status?: ResilienceRun['status'] & { startTime?: string; completionTime?: string }
}

/**
 * A gate Job as the page reads it. Kargo-started gates carry the gate label
 * but not the namespace label, so the namespace falls back to the Job's
 * `VERIFY_NAMESPACE` env.
 */
export function runFromJob(j: JobObj): ResilienceRun | undefined {
  const labels = j.metadata?.labels ?? {}
  const app = labels[GATE_LABEL]
  if (!j.metadata?.name || !app) return undefined
  const env = j.spec?.template?.spec?.containers?.[0]?.env ?? []
  const envOf = (n: string) => env.find((e) => e.name === n)?.value
  const namespace = labels[NAMESPACE_LABEL] ?? envOf('VERIFY_NAMESPACE') ?? ''
  const status = j.status ?? {}
  return {
    job: j.metadata.name,
    app,
    namespace,
    environment: labels[ENVIRONMENT_LABEL] ?? envOf('VERIFY_ENVIRONMENT') ?? namespace,
    ...(labels[TRIGGER_LABEL] ? { triggeredBy: labels[TRIGGER_LABEL] } : {}),
    startTime: status.startTime ?? j.metadata.creationTimestamp,
    ...(status.completionTime ? { completionTime: status.completionTime } : {}),
    status: { active: status.active, succeeded: status.succeeded, failed: status.failed, conditions: status.conditions },
  }
}

/* ─────────────────────────── handler ─────────────────────────── */

function json(body: unknown, status = 200, cookie?: string): Response {
  const res = Response.json(body, { status })
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

async function readErr(r: Response): Promise<string> {
  const t = await r.text().catch(() => '')
  try {
    const j = JSON.parse(t) as { message?: string }
    if (j.message) return j.message.slice(0, 400)
  } catch { /* plain text */ }
  return t.slice(0, 400)
}

/**
 * The identity runs are made with. In-cluster that is the console SA; on a
 * laptop with no SA token, the dev identity (which is itself the SA token
 * when `ADHAR_DEV_CLUSTER_AUTH` is on).
 */
async function runnerIdentity(req: Request): Promise<K8sIdentity | string | null> {
  return getK8sServiceToken() ?? (await resolveIdentity(req))
}

const JOBS = `/apis/batch/v1/namespaces/${RUNNER_NAMESPACE}/jobs`
const CRON = `/apis/batch/v1/namespaces/${RUNNER_NAMESPACE}/cronjobs/${RUNNER_CRONJOB}`

export async function handleResilienceRuns(req: Request, subpath: string): Promise<Response> {
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const cookie = auth.refreshedCookie
  const method = req.method.toUpperCase()
  const id = await runnerIdentity(req)
  if (!id) return json({ error: 'no_identity', detail: 'The console has no Kubernetes identity to start runs with.' }, 503, cookie)

  try {
    if (subpath === '/log' && method === 'GET') return await readLog(req, id, cookie)
    if (subpath !== '' && subpath !== '/') return json({ error: 'not_found' }, 404, cookie)

    if (method === 'GET') {
      const cronRes = await apiServerFetch(id, CRON)
      const installed = cronRes.ok
      await cronRes.body?.cancel()
      const allowed = canRunSuites(auth.user)
      let runs: ResilienceRun[] = []
      if (installed) {
        const list = await apiServerFetch(id, JOBS, { search: `?labelSelector=${encodeURIComponent(GATE_LABEL)}` })
        if (list.ok) {
          const body = (await list.json()) as { items?: JobObj[] }
          runs = (body.items ?? []).map(runFromJob).filter((r): r is ResilienceRun => !!r)
            .sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''))
        } else {
          await list.body?.cancel()
        }
      }
      return json({
        installed,
        // 404 is "the scorecards package is not installed"; anything else
        // (403: the console's RoleBinding is missing) is said as itself.
        ...(installed || cronRes.status === 404 ? {} : { detail: `reading ${RUNNER_CRONJOB} returned ${cronRes.status}` }),
        allowed,
        runs,
      }, 200, cookie)
    }

    if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
    if (!originOk(req)) return json({ error: 'origin_not_allowed' }, 403, cookie)
    if (!canRunSuites(auth.user)) {
      return json({ error: 'forbidden', detail: 'Running a resilience suite needs the platform-admin, platform-engineer or application-admin role.' }, 403, cookie)
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid_json', detail: 'The request body is not JSON.' }, 400, cookie)
    }
    const v = validateRunRequest(body)
    if (!v.ok) return json({ error: 'invalid_request', detail: v.detail }, 400, cookie)

    const cronRes = await apiServerFetch(id, CRON)
    if (cronRes.status === 404) {
      await cronRes.body?.cancel()
      return json({ error: 'not_installed', detail: `CronJob ${RUNNER_NAMESPACE}/${RUNNER_CRONJOB} not found — enable the adhar-scorecards package.` }, 404, cookie)
    }
    if (!cronRes.ok) {
      return json({ error: cronRes.status === 403 ? 'forbidden' : 'apiserver_error', detail: await readErr(cronRes) }, cronRes.status === 403 ? 403 : 502, cookie)
    }
    const cron = (await cronRes.json()) as CronJobLike

    // One run per app+namespace at a time: two runners racing on the results
    // ConfigMap is last-writer-wins on the very thing the page reads.
    const sel = `${GATE_LABEL}=${v.app},${NAMESPACE_LABEL}=${v.namespace}`
    const active = await apiServerFetch(id, JOBS, { search: `?labelSelector=${encodeURIComponent(sel)}` })
    if (active.ok) {
      const list = (await active.json()) as { items?: JobObj[] }
      const running = (list.items ?? []).find((j) => (j.status?.active ?? 0) > 0)
      if (running) return json({ started: false, error: 'already_running', job: running.metadata?.name }, 409, cookie)
    } else {
      await active.body?.cancel()
    }

    let manifest: GateJob
    try {
      manifest = buildGateJob(cron, v, {
        suffix: runSuffix(),
        triggeredBy: auth.user.email || auth.user.username || auth.user.name || auth.user.id,
      })
    } catch (e) {
      return json({ error: 'unreadable', detail: e instanceof Error ? e.message : String(e) }, 502, cookie)
    }
    const created = await apiServerFetch(id, JOBS, {
      method: 'POST',
      body: JSON.stringify(manifest),
      headers: { 'content-type': 'application/json' },
    })
    if (!created.ok) {
      return json({ error: created.status === 403 ? 'forbidden' : 'apiserver_error', detail: await readErr(created) }, created.status === 403 ? 403 : 502, cookie)
    }
    await created.body?.cancel()
    try {
      console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'resilience.run', job: manifest.metadata.name, app: v.app, namespace: v.namespace, by: auth.user.username ?? auth.user.email ?? auth.user.id }))
    } catch { /* never let logging break a request */ }
    return json({ started: true, job: manifest.metadata.name }, 200, cookie)
  } catch (e) {
    return json({ error: 'apiserver_error', detail: e instanceof Error ? e.message : String(e) }, 502, cookie)
  }
}

/** The tail of a gate Job's newest pod. Refuses any Job that is not a gate run. */
async function readLog(req: Request, id: K8sIdentity | string, cookie?: string): Promise<Response> {
  const job = new URL(req.url).searchParams.get('job') ?? ''
  if (!DNS_LABEL.test(job)) return json({ error: 'invalid_request', detail: 'job must be a Job name.' }, 400, cookie)

  const jr = await apiServerFetch(id, `${JOBS}/${encodeURIComponent(job)}`)
  if (!jr.ok) return json({ error: jr.status === 404 ? 'not_found' : 'apiserver_error', detail: await readErr(jr) }, jr.status === 404 ? 404 : 502, cookie)
  const obj = (await jr.json()) as JobObj
  if (!obj.metadata?.labels?.[GATE_LABEL]) return json({ error: 'forbidden', detail: 'Not a resilience gate run.' }, 403, cookie)

  const pods = await apiServerFetch(id, `/api/v1/namespaces/${RUNNER_NAMESPACE}/pods`, {
    search: `?labelSelector=${encodeURIComponent(`job-name=${job}`)}`,
  })
  if (!pods.ok) return json({ error: 'apiserver_error', detail: await readErr(pods) }, 502, cookie)
  const list = (await pods.json()) as { items?: Array<{ metadata?: { name?: string; creationTimestamp?: string } }> }
  const pod = (list.items ?? [])
    .filter((p) => p.metadata?.name)
    .sort((a, b) => (b.metadata?.creationTimestamp ?? '').localeCompare(a.metadata?.creationTimestamp ?? ''))[0]
  if (!pod) return json({ job, pod: null, log: '' }, 200, cookie)

  const name = pod.metadata!.name!
  const lr = await apiServerFetch(id, `/api/v1/namespaces/${RUNNER_NAMESPACE}/pods/${encodeURIComponent(name)}/log`, { search: '?tailLines=300' })
  // A pod still pulling its image has no log yet; that is not an error.
  if (!lr.ok) {
    const detail = await readErr(lr)
    return json({ job, pod: name, log: '', detail }, 200, cookie)
  }
  return json({ job, pod: name, log: await lr.text() }, 200, cookie)
}
