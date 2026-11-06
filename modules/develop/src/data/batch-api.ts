import { kube } from '@adhar/api-clients/k8s'
import {
  BATCHJOBS_GVR,
  type BatchJobList,
  type BatchJobXR,
  buildRun,
  CONFIGMAPS_GVR,
  type ConfigMapLike,
  type Gvr,
  gvrOfRun,
  holdPatch,
  JOBS_GVR,
  parseRunTemplate,
  PODS_GVR,
  type PromSample,
  resumeRequest,
  RUN_SELECTOR,
  type RunObject,
  type RunPod,
  type RunRequest,
  type RunRow,
  type RunTemplate,
  stopRequest,
  VOLCANO_JOBS_GVR,
} from './batch-model.ts'
import { runName } from './batch-naming.ts'

/**
 * Develop → Batch, the requests. No React here, so each one is tested against a
 * fake gateway (`batch-api_test.ts`). Everything goes through the console's
 * Kubernetes gateway AS THE SIGNED-IN USER: there is no BFF endpoint (§7.4), and
 * every operation is an API call under the caller's own RBAC (INV-6), with
 * Kyverno stamping the actor on what they create.
 */

/** The HTTP status behind a gateway error (`K8sError.status`). */
export const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status

/** Every BatchJob the caller may see: cluster-wide first, each candidate namespace when RBAC refuses that. */
export async function listBatchJobs(candidates: readonly string[]): Promise<BatchJobList> {
  const sorted = [...new Set(candidates.filter(Boolean))].sort()
  try {
    const items = (await kube.list<BatchJobXR>(BATCHJOBS_GVR)).items
    return { items, scope: 'cluster', namespaces: [...new Set(items.map((j) => j.metadata.namespace ?? ''))].filter(Boolean), denied: [], installed: true }
  } catch (e) {
    if (statusOf(e) === 404) return { items: [], scope: 'cluster', namespaces: [], denied: [], installed: false }
    if (statusOf(e) !== 403) throw e
  }
  const settled = await Promise.allSettled(sorted.map((namespace) => kube.list<BatchJobXR>(BATCHJOBS_GVR, { namespace })))
  const items: BatchJobXR[] = []
  const denied: string[] = []
  let installed = true
  let failure: unknown
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value.items)
    else if (statusOf(r.reason) === 403) denied.push(sorted[i])
    else if (statusOf(r.reason) === 404) installed = false
    else failure ??= r.reason
  })
  if (failure && !items.length) throw failure
  return { items, scope: 'namespaces', namespaces: sorted, denied, installed }
}

/** One kind across the scope; a namespace the caller cannot read is left out, not fatal. */
async function listAcross<T>(gvr: Gvr, scope: BatchJobList['scope'], namespaces: readonly string[], labelSelector: string): Promise<{ items: T[]; denied: boolean }> {
  if (scope === 'cluster') {
    try {
      return { items: (await kube.list<T>(gvr, { labelSelector })).items, denied: false }
    } catch (e) {
      if (statusOf(e) !== 403) throw e
    }
  }
  const settled = await Promise.allSettled(namespaces.map((namespace) => kube.list<T>(gvr, { namespace, labelSelector })))
  const failed = settled.filter((r) => r.status === 'rejected')
  const hard = failed.find((r) => statusOf((r as PromiseRejectedResult).reason) !== 403 && statusOf((r as PromiseRejectedResult).reason) !== 404)
  if (hard && failed.length === settled.length) throw (hard as PromiseRejectedResult).reason
  return {
    items: settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : [])),
    denied: failed.some((r) => statusOf((r as PromiseRejectedResult).reason) === 403),
  }
}

export interface RunList {
  runs: RunObject[]
  pods: RunPod[]
  /** Some namespace refused the runs; the list is partial. */
  partial: boolean
  /** The caller could read no runs at all. */
  forbidden: boolean
  /** Volcano's API is served; only then is its watch worth opening. */
  volcano: boolean
  /** Reading pods failed: exit codes and summaries are unknown, not absent. */
  podsUnknown: boolean
}

/** Every run in scope, with its pods (they carry the summaries and the exit codes). */
export async function listRuns(scope: BatchJobList['scope'], namespaces: readonly string[]): Promise<RunList> {
  let jobs: { items: RunObject[]; denied: boolean }
  try {
    jobs = await listAcross<RunObject>(JOBS_GVR, scope, namespaces, RUN_SELECTOR)
  } catch (e) {
    if (statusOf(e) === 403) jobs = { items: [], denied: true }
    else throw e
  }
  // Volcano arrives with Phase 2 and is optional: its absence is a fact, not a failure.
  let volcano = true
  let vc: RunObject[] = []
  try {
    vc = (await listAcross<RunObject>(VOLCANO_JOBS_GVR, scope, namespaces, RUN_SELECTOR)).items
    if (!vc.length) volcano = await served(VOLCANO_JOBS_GVR, scope, namespaces)
  } catch {
    volcano = false
  }
  let pods: RunPod[] = []
  let podsUnknown = false
  try {
    const p = await listAcross<RunPod>(PODS_GVR, scope, namespaces, RUN_SELECTOR)
    pods = p.items
    podsUnknown = p.denied
  } catch {
    podsUnknown = true
  }
  const runs = [
    ...jobs.items.map((j) => ({ ...j, apiVersion: 'batch/v1', kind: 'Job' })),
    ...vc.map((j) => ({ ...j, apiVersion: 'batch.volcano.sh/v1alpha1', kind: 'Job' })),
  ]
  return { runs, pods, partial: jobs.denied && runs.length > 0, forbidden: jobs.denied && runs.length === 0, volcano, podsUnknown }
}

/** Whether an optional API is served at all. `listAcross` swallows 404 per namespace, so ask once. */
async function served(gvr: Gvr, scope: BatchJobList['scope'], namespaces: readonly string[]): Promise<boolean> {
  const namespace = scope === 'namespaces' ? namespaces[0] : undefined
  try {
    await kube.list(gvr, { limit: 1, ...(namespace ? { namespace } : {}) })
    return true
  } catch (e) {
    return statusOf(e) !== 404
  }
}

export type TemplateRead =
  | { state: 'ok'; template: RunTemplate }
  | { state: 'missing' | 'forbidden' | 'invalid'; message: string }

/** `ConfigMap <name>-run`, read and checked. Never throws for a state the dialog has words for. */
export async function readRunTemplate(namespace: string, batchJob: string, templateName = `${batchJob}-run`): Promise<TemplateRead> {
  let cm: ConfigMapLike
  try {
    cm = await kube.get<ConfigMapLike>(CONFIGMAPS_GVR, namespace, templateName)
  } catch (e) {
    if (statusOf(e) === 404) {
      return { state: 'missing', message: `The run template ${namespace}/${templateName} does not exist yet. The control plane creates it when it reconciles this BatchJob.` }
    }
    if (statusOf(e) === 403) return { state: 'forbidden', message: `Reading the run template needs get configmaps in ${namespace}.` }
    throw e
  }
  const parsed = parseRunTemplate(cm)
  return parsed.template ? { state: 'ok', template: parsed.template } : { state: 'invalid', message: parsed.error ?? 'The run template cannot be read.' }
}

export type RunOutcome =
  | { created: true; run: RunObject }
  /** A run with this identity exists: §3.4 says show it, and never start another. */
  | { created: false; existing: string }

async function createRun(gvr: Gvr, namespace: string, manifest: Record<string, unknown>, name: string): Promise<RunOutcome> {
  try {
    return { created: true, run: await kube.create<RunObject>(gvr, namespace, manifest) }
  } catch (e) {
    if (statusOf(e) === 409) return { created: false, existing: name }
    throw e
  }
}

/** Run now: `POST` the run named for its identifying parameters. */
export function runNow(
  input: { namespace: string; batchJob: string; template: RunTemplate; params: Record<string, string>; identifying: Record<string, string> },
): Promise<RunOutcome> {
  const name = runName(input.batchJob, input.identifying)
  const manifest = buildRun(input.template, { name, namespace: input.namespace, trigger: 'manual', params: input.params })
  return createRun(gvrOfRun(manifest), input.namespace, manifest, name)
}

/** Restart: `POST <name>-<hash8>-r<n>`, the same parameters, naming the run it continues. */
export function restartRun(input: { namespace: string; name: string; template: RunTemplate; params: Record<string, string>; restartOf: string }): Promise<RunOutcome> {
  const manifest = buildRun(input.template, { name: input.name, namespace: input.namespace, trigger: 'restart', params: input.params, restartOf: input.restartOf })
  return createRun(gvrOfRun(manifest), input.namespace, manifest, input.name)
}

async function perform(r: RunRequest): Promise<void> {
  if (r.verb === 'patch') await kube.patch(r.gvr, r.namespace, r.name, r.body, 'merge')
  else await kube.create(r.gvr, r.namespace, r.body)
}

export const stopRun = (run: RunObject) => perform(stopRequest(run))
export const resumeRun = (run: RunObject) => perform(resumeRequest(run))

/** Hold or release: the annotation the composition turns into a suspended schedule. */
export async function setHold(namespace: string, name: string, reason: string | null): Promise<void> {
  await kube.patch(BATCHJOBS_GVR, namespace, name, holdPatch(reason), 'merge')
}

/** Every run name in a namespace that belongs to the same job: the input to the next `-r<n>`. */
export function runNamesOf(runs: readonly Pick<RunRow, 'namespace' | 'batchJob' | 'name'>[], namespace: string, batchJob: string): string[] {
  return runs.filter((r) => r.namespace === namespace && r.batchJob === batchJob).map((r) => r.name)
}

/* ─────────────────────────── Prometheus, through /api/prom/batch ─────────────────────────── */

interface PromVector {
  status?: string
  data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string]; values?: Array<[number, string]> }> }
  error?: string
}

async function promBatch(items: unknown[]): Promise<Array<{ status: number; body: unknown }>> {
  const res = await fetch('/api/prom/batch', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ items }),
  })
  if (!res.ok) throw new Error(res.status === 503 ? 'Prometheus is not configured for this install.' : `Prometheus returned HTTP ${res.status}.`)
  return ((await res.json()) as { results?: Array<{ status: number; body: unknown }> }).results ?? []
}

function vectorOf(r: { status: number; body: unknown } | undefined): PromVector {
  if (!r || r.status !== 200) throw new Error(r?.status === 503 ? 'Prometheus is not configured for this install.' : `Prometheus returned HTTP ${r?.status ?? '?'}.`)
  const body = r.body as PromVector
  if (body.status === 'error') throw new Error(body.error ?? 'Prometheus rejected the query.')
  return body
}

/** An instant query. An empty vector is a legitimate answer: the caller says "no data". */
export async function promInstant(query: string): Promise<PromSample[]> {
  const [r] = await promBatch([{ kind: 'instant', query }])
  return (vectorOf(r).data?.result ?? [])
    .map((x) => ({ labels: x.metric ?? {}, value: Number(x.value?.[1]) }))
    .filter((s) => Number.isFinite(s.value))
}

/** A range query, reduced to one series of `[ms, value]`. */
export async function promRange(query: string, startMs: number, endMs: number, points = 120): Promise<Array<[number, number]>> {
  const start = Math.floor(startMs / 1_000)
  const end = Math.max(start + 1, Math.ceil(endMs / 1_000))
  const step = Math.max(15, Math.floor((end - start) / points))
  const [r] = await promBatch([{ kind: 'range', query, start, end, step }])
  return (vectorOf(r).data?.result ?? [])
    .flatMap((x) => (x.values ?? []).map(([t, v]): [number, number] => [t * 1_000, Number(v)]))
    .filter(([, v]) => Number.isFinite(v))
}
