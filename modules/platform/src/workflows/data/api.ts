import { kube, type KubeObject } from '@adhar/api-clients/k8s'
import type { CatalogEntry, TemplateObject } from './catalog.ts'
import { buildResubmit } from './catalog.ts'
import { CLUSTER_WORKFLOW_TEMPLATES, CRON_WORKFLOWS, LIST_LIMIT, WORKFLOW_TEMPLATES, WORKFLOWS } from './gvr.ts'
import type { Workflow } from './nodes.ts'

/**
 * Workflows, the requests (design 0026 §4.4, §6.3, §6.4). No React here, so
 * each request is tested against a fake gateway (`api_test.ts`).
 *
 * Two paths, chosen per operation, never mixed (INV-9):
 *   • Kubernetes objects through the console's gateway AS THE USER: list,
 *     get, submit, stop, terminate, suspend, resume, delete, plain resubmit.
 *   • argo-server, only through the BFF (`/api/workflows/*`), only for what
 *     argo-server alone serves: retry, memoized resubmit, approvals, logs
 *     after clean-up, artifacts, the archive, the engine. The BFF asks the
 *     authorization question as the user and pins the namespace.
 */

export const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status

type Gvr = { group: string; version: string; resource: string; namespaced?: boolean }

/* ─────────────────────────── listing across a scope ─────────────────────────── */

export type ScopeMode = 'cluster' | 'namespaces'

export interface Listed<T> {
  items: T[]
  /** The cluster-wide list was refused; these came namespace by namespace. */
  mode: ScopeMode
  /** Namespaces that refused the list (403): the list is partial. */
  denied: string[]
  /** The kind is not served at all (404): Argo Workflows is not installed. */
  missing: boolean
}

/**
 * Every object of a kind the caller may see: cluster-wide first (platform
 * staff), else each candidate namespace (a team member), leaving out the ones
 * RBAC refuses rather than failing the page.
 */
export async function listAcross<T>(
  gvr: Gvr,
  opts: { namespaces: readonly string[]; labelSelector?: string; cluster?: string; only?: string },
): Promise<Listed<T>> {
  const { labelSelector, cluster } = opts
  if (opts.only) {
    try {
      const items = (await kube.list<T>(gvr, { namespace: opts.only, labelSelector, limit: LIST_LIMIT, cluster })).items ?? []
      return { items, mode: 'namespaces', denied: [], missing: false }
    } catch (e) {
      if (statusOf(e) === 404) return { items: [], mode: 'namespaces', denied: [], missing: true }
      if (statusOf(e) === 403) return { items: [], mode: 'namespaces', denied: [opts.only], missing: false }
      throw e
    }
  }
  try {
    const items = (await kube.list<T>(gvr, { labelSelector, limit: LIST_LIMIT, cluster })).items ?? []
    return { items, mode: 'cluster', denied: [], missing: false }
  } catch (e) {
    if (statusOf(e) === 404) return { items: [], mode: 'cluster', denied: [], missing: true }
    if (statusOf(e) !== 403) throw e
  }
  const namespaces = [...new Set(opts.namespaces.filter(Boolean))].sort()
  const settled = await Promise.allSettled(namespaces.map((namespace) => kube.list<T>(gvr, { namespace, labelSelector, limit: LIST_LIMIT, cluster })))
  const items: T[] = []
  const denied: string[] = []
  let missing = false
  let failure: unknown
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...(r.value.items ?? []))
    else if (statusOf(r.reason) === 403) denied.push(namespaces[i])
    else if (statusOf(r.reason) === 404) missing = true
    else failure ??= r.reason
  })
  if (failure && !items.length) throw failure
  return { items, mode: 'namespaces', denied, missing }
}

const byNewest = (a: { metadata: { creationTimestamp?: string } }, b: { metadata: { creationTimestamp?: string } }) =>
  (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? '')

export async function listRuns(opts: { namespaces: readonly string[]; labelSelector?: string; cluster?: string; only?: string }): Promise<Listed<Workflow>> {
  const r = await listAcross<Workflow>(WORKFLOWS, opts)
  return { ...r, items: r.items.sort(byNewest) }
}

export interface TemplateLists {
  wts: Listed<TemplateObject>
  cwts: Listed<TemplateObject>
  crons: Listed<TemplateObject>
}

/** WorkflowTemplates and CronWorkflows in scope, and the cluster's ClusterWorkflowTemplates. */
export async function listTemplates(opts: { namespaces: readonly string[]; cluster?: string; only?: string }): Promise<TemplateLists> {
  const [wts, crons, cwts] = await Promise.all([
    listAcross<TemplateObject>(WORKFLOW_TEMPLATES, opts),
    listAcross<TemplateObject>(CRON_WORKFLOWS, opts),
    // Cluster-scoped; readable by every signed-in user (adhar-workflow-catalog-reader, §5.6).
    kube.list<TemplateObject>(CLUSTER_WORKFLOW_TEMPLATES, { limit: LIST_LIMIT, cluster: opts.cluster })
      .then((r): Listed<TemplateObject> => ({ items: r.items ?? [], mode: 'cluster', denied: [], missing: false }))
      .catch((e): Listed<TemplateObject> => {
        if (statusOf(e) === 403 || statusOf(e) === 404) return { items: [], mode: 'cluster', denied: statusOf(e) === 403 ? ['*'] : [], missing: statusOf(e) === 404 }
        throw e
      }),
  ])
  return { wts, cwts, crons }
}

/** One run as the apiserver has it, or null once it is gone (TTL, deleted). */
export async function getRun(namespace: string, name: string, cluster?: string): Promise<Workflow | null> {
  try {
    return await kube.get<Workflow>(WORKFLOWS, namespace, name, { cluster })
  } catch (e) {
    if (statusOf(e) === 404) return null
    throw e
  }
}

/** The template an entry names, fresh (the run view compares versions against it). */
export async function getTemplate(kind: CatalogEntry['kind'], namespace: string | undefined, name: string, cluster?: string): Promise<TemplateObject | null> {
  const gvr = kind === 'ClusterWorkflowTemplate' ? CLUSTER_WORKFLOW_TEMPLATES : kind === 'CronWorkflow' ? CRON_WORKFLOWS : WORKFLOW_TEMPLATES
  try {
    return await kube.get<TemplateObject>(gvr, kind === 'ClusterWorkflowTemplate' ? undefined : namespace, name, { cluster })
  } catch (e) {
    if (statusOf(e) === 404 || statusOf(e) === 403) return null
    throw e
  }
}

/* ─────────────────────────── gateway writes, as the user ─────────────────────────── */

/** Create a run (`generateName`); a dry run applies under a concrete name and creates nothing. */
export function submitRun(manifest: Workflow, opts: { dryRun?: boolean; cluster?: string } = {}): Promise<Workflow> {
  const ns = manifest.metadata.namespace
  if (!ns) return Promise.reject(new Error('A run needs a namespace.'))
  if (opts.dryRun) {
    const name = `${manifest.metadata.generateName ?? 'run-'}dryrun${Math.random().toString(36).slice(2, 7)}`
    const { generateName: _g, ...metadata } = manifest.metadata
    return kube.apply<Workflow>({ ...manifest, metadata: { ...metadata, name } } as unknown as KubeObject, { dryRun: true, cluster: opts.cluster })
  }
  const { name: _n, ...metadata } = manifest.metadata
  return kube.create<Workflow>(WORKFLOWS, ns, { ...manifest, metadata }, { cluster: opts.cluster })
}

/**
 * Stop: no new step starts and exit handlers still run. Terminate: everything
 * stops at once and exit handlers do NOT run [S23] — the UI offers it only
 * behind a typed confirmation, and never for a game day.
 */
export function shutdownRun(namespace: string, name: string, how: 'Stop' | 'Terminate', cluster?: string): Promise<unknown> {
  return kube.patch(WORKFLOWS, namespace, name, { spec: { shutdown: how } }, 'merge', { cluster })
}

/** Workflow-level suspend / resume (`spec.suspend`). Approvals are resumed through the BFF instead. */
export function setSuspended(namespace: string, name: string, suspended: boolean, cluster?: string): Promise<unknown> {
  return kube.patch(WORKFLOWS, namespace, name, { spec: { suspend: suspended ? true : null } }, 'merge', { cluster })
}

export function deleteRun(namespace: string, name: string, cluster?: string): Promise<unknown> {
  return kube.delete(WORKFLOWS, namespace, name, { cluster })
}

/** A new run from the same template and arguments, through the gateway. */
export function resubmitRun(w: Workflow, opts: { parameters?: Record<string, string>; cluster?: string } = {}): Promise<Workflow> {
  return submitRun(buildResubmit(w, opts.parameters), { cluster: opts.cluster })
}

/* ─────────────────────────── the BFF (argo-server through the console) ─────────────────────────── */

export class WorkflowsApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'WorkflowsApiError'
  }
}

const enc = encodeURIComponent

function withCluster(path: string, cluster?: string, query?: URLSearchParams): string {
  const q = new URLSearchParams(query)
  if (cluster) q.set('cluster', cluster)
  const s = q.toString()
  return `/api/workflows${path}${s ? `?${s}` : ''}`
}

async function bff<T>(method: string, path: string, opts: { body?: unknown; cluster?: string; query?: URLSearchParams } = {}): Promise<T> {
  const res = await fetch(withCluster(path, opts.cluster, opts.query), {
    method,
    credentials: 'include',
    headers: { accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  if (!res.ok) {
    const b = (body && typeof body === 'object' ? body : {}) as { error?: string; detail?: string; message?: string }
    throw new WorkflowsApiError(res.status, b.error ?? String(res.status), b.detail ?? b.message ?? (typeof body === 'string' && body ? body : `${res.status} ${res.statusText}`))
  }
  return body as T
}

const runPath = (namespace: string, name: string) => `/runs/${enc(namespace)}/${enc(name)}`

/** The capability probe (§6.3): the only thing the module asks before rendering. */
export interface Capabilities {
  installed: boolean
  version?: string
  argoServer: { reachable: boolean; identity: 'user' | 'service' | 'none' }
  archive: boolean
  artifactNamespaces: string[]
  triggers: { bindings: boolean; platformEvents: boolean }
  gamedays: boolean
  volcano: boolean
  batch: boolean
}

export const NO_CAPABILITIES: Capabilities = {
  installed: false,
  argoServer: { reachable: false, identity: 'none' },
  archive: false,
  artifactNamespaces: [],
  triggers: { bindings: false, platformEvents: false },
  gamedays: false,
  volcano: false,
  batch: false,
}

/** Whatever the BFF answers, read into the full shape (a missing field is "no"). */
export function readCapabilities(raw: unknown): Capabilities {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Capabilities> & Record<string, unknown>
  const srv = (r.argoServer && typeof r.argoServer === 'object' ? r.argoServer : {}) as Partial<Capabilities['argoServer']>
  const trg = (r.triggers && typeof r.triggers === 'object' ? r.triggers : {}) as Partial<Capabilities['triggers']>
  return {
    installed: r.installed === true,
    version: typeof r.version === 'string' ? r.version : undefined,
    argoServer: { reachable: srv.reachable === true, identity: srv.identity === 'user' || srv.identity === 'service' ? srv.identity : 'none' },
    archive: r.archive === true,
    artifactNamespaces: Array.isArray(r.artifactNamespaces) ? r.artifactNamespaces.filter((s): s is string => typeof s === 'string') : [],
    triggers: { bindings: trg.bindings === true, platformEvents: trg.platformEvents === true },
    gamedays: r.gamedays === true,
    volcano: r.volcano === true,
    batch: r.batch === true,
  }
}

export async function getCapabilities(cluster?: string): Promise<Capabilities> {
  return readCapabilities(await bff<unknown>('GET', '/capabilities', { cluster }))
}

/**
 * Without the BFF (an older console server, or a 5xx): ask discovery the one
 * question that matters — is the Workflow kind served? — so the page still
 * renders runs through the gateway, with the argo-server features off.
 */
export async function probeInstalled(cluster?: string): Promise<boolean> {
  try {
    await kube.list(WORKFLOWS, { limit: 1, cluster })
    return true
  } catch (e) {
    return statusOf(e) === 403
  }
}

/** The run as argo-server hydrates it — only when the browser cannot read `status.nodes` itself. */
export function getHydratedRun(namespace: string, name: string, cluster?: string): Promise<Workflow> {
  return bff<Workflow>('GET', runPath(namespace, name), { cluster })
}

/** What the BFF answers a retry or resubmit with: the run it now refers to (argo-server's), and any caveat. */
export interface ActionResult {
  ok?: boolean
  workflow?: { name?: string; namespace?: string; uid?: string; phase?: string }
  warning?: string
}

export function retryRun(namespace: string, name: string, body: { restartSuccessful?: boolean; nodeId?: string; parameters?: string[] }, cluster?: string): Promise<ActionResult> {
  return bff<ActionResult>('POST', `${runPath(namespace, name)}/retry`, { body, cluster })
}

export function resubmitMemoized(namespace: string, name: string, body: { parameters?: string[] } = {}, cluster?: string): Promise<ActionResult> {
  return bff<ActionResult>('POST', `${runPath(namespace, name)}/resubmit`, { body: { memoized: true, ...body }, cluster })
}

export function decideApproval(namespace: string, name: string, body: { nodeId: string; decision: 'approve' | 'reject'; comment?: string }, cluster?: string): Promise<unknown> {
  return bff('POST', `${runPath(namespace, name)}/approve`, { body, cluster })
}

export interface RunLogs {
  source: 'live' | 'loki'
  pod?: string
  container?: string
  lines: string[]
  /** The pod exists but has not started its container yet. */
  waiting?: boolean
  note?: string
}

export async function getRunLogs(namespace: string, name: string, opts: { node: string; container?: 'main' | 'wait' | 'init'; tail?: number }, cluster?: string): Promise<RunLogs> {
  const query = new URLSearchParams({ node: opts.node, container: opts.container ?? 'main' })
  if (opts.tail) query.set('tail', String(opts.tail))
  const r = await bff<Partial<RunLogs>>('GET', `${runPath(namespace, name)}/logs`, { query, cluster })
  return {
    source: r.source === 'loki' ? 'loki' : 'live',
    pod: r.pod,
    container: r.container,
    lines: Array.isArray(r.lines) ? r.lines.map(String) : [],
    waiting: r.waiting === true,
    note: r.note,
  }
}

/** Where an artifact downloads from (streamed by the BFF, always as a sandboxed `attachment` with argo-server's file name). */
export function artifactUrl(namespace: string, name: string, nodeId: string, artifact: string, cluster?: string): string {
  return withCluster(`${runPath(namespace, name)}/artifacts/${enc(nodeId)}/${enc(artifact)}`, cluster)
}

/* ─────────────────────────── the archive ─────────────────────────── */

export interface ArchivedRun {
  uid: string
  name: string
  namespace: string
  phase: string
  startedAt?: string
  finishedAt?: string
  message?: string
  template?: string
  clusterTemplate?: string
  cron?: string
  submittedBy?: string
  submitter?: string
  resubmittedFrom?: string
}

export interface ArchiveFilters {
  phase?: string
  template?: string
  submitter?: string
  namePrefix?: string
  since?: string
  limit?: number
  continue?: string
}

/**
 * The query an archive page sends. Built from an allow-list of filters: the
 * console never sends a `fieldSelector` or a `namespace` parameter — the
 * namespace is the path segment, and the BFF pins it (GHSA-q65w).
 */
export function archiveQuery(f: ArchiveFilters): URLSearchParams {
  const q = new URLSearchParams()
  if (f.limit) q.set('limit', String(Math.min(100, Math.max(1, Math.floor(f.limit)))))
  if (f.continue) q.set('continue', f.continue)
  if (f.phase) q.set('phase', f.phase)
  if (f.template) q.set('template', f.template)
  if (f.submitter) q.set('submitter', f.submitter)
  if (f.namePrefix) q.set('namePrefix', f.namePrefix)
  if (f.since) q.set('since', f.since)
  return q
}

/** Archived summaries as the BFF returns them, or raw archived workflows reduced the same way. */
export function readArchived(raw: unknown): ArchivedRun | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown> & Partial<Workflow>
  if (typeof r.uid === 'string' && typeof r.name === 'string') return r as unknown as ArchivedRun
  const md = r.metadata
  if (!md?.uid || !md.name || !md.namespace) return null
  const l = md.labels ?? {}
  return {
    uid: md.uid,
    name: md.name,
    namespace: md.namespace,
    phase: r.status?.phase ?? l['workflows.argoproj.io/phase'] ?? 'Unknown',
    startedAt: r.status?.startedAt,
    finishedAt: r.status?.finishedAt,
    message: r.status?.message,
    template: l['workflows.argoproj.io/workflow-template'],
    clusterTemplate: l['workflows.argoproj.io/cluster-workflow-template'],
    cron: l['workflows.argoproj.io/cron-workflow'],
    submittedBy: md.annotations?.['adhar.io/submitted-by'],
    submitter: l['adhar.io/submitter'],
    resubmittedFrom: l['workflows.argoproj.io/resubmitted-from-workflow'],
  }
}

export async function listArchive(namespace: string, f: ArchiveFilters, cluster?: string): Promise<{ items: ArchivedRun[]; continue?: string }> {
  const r = await bff<{ items?: unknown[]; continue?: string; metadata?: { continue?: string } }>('GET', `/archive/${enc(namespace)}`, { query: archiveQuery(f), cluster })
  return {
    items: (r.items ?? []).map(readArchived).filter((x): x is ArchivedRun => x !== null),
    continue: r.continue || r.metadata?.continue || undefined,
  }
}

export function getArchived(namespace: string, uid: string, cluster?: string): Promise<Workflow> {
  return bff<Workflow>('GET', `/archive/${enc(namespace)}/${enc(uid)}`, { cluster })
}

export function retryArchived(namespace: string, uid: string, body: { restartSuccessful?: boolean; parameters?: string[] } = {}, cluster?: string): Promise<ActionResult> {
  return bff<ActionResult>('POST', `/archive/${enc(namespace)}/${enc(uid)}/retry`, { body, cluster })
}

export function resubmitArchived(namespace: string, uid: string, body: { memoized?: boolean; parameters?: string[] } = {}, cluster?: string): Promise<ActionResult> {
  return bff<ActionResult>('POST', `/archive/${enc(namespace)}/${enc(uid)}/resubmit`, { body, cluster })
}

export function deleteArchived(namespace: string, uid: string, cluster?: string): Promise<unknown> {
  return bff('DELETE', `/archive/${enc(namespace)}/${enc(uid)}`, { cluster })
}

/* ─────────────────────────── the engine (platform staff) ─────────────────────────── */

/**
 * `GET /api/workflows/engine`: controller metrics from Prometheus (each null
 * when the series is absent), the controller's limits, per-namespace
 * parallelism overrides, and the problems met reading them — a gap is said,
 * never shown as a zero.
 */
export interface EngineState {
  controller: {
    /** 1 while a controller holds the leader lease. */
    leader: number | null
    queueDepth: number | null
    errors15m: number | null
    pendingPods: number | null
    runningPods: number | null
    archiveDatabaseBytes: number | null
  }
  limits: { parallelism?: number; namespaceParallelism?: number }
  namespaces: Array<{ name: string; parallelismLimit: number | null }>
  problems: string[]
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function readEngine(raw: unknown): EngineState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const c = (r.controller && typeof r.controller === 'object' ? r.controller : {}) as Record<string, unknown>
  const l = (r.limits && typeof r.limits === 'object' ? r.limits : {}) as Record<string, unknown>
  return {
    controller: {
      leader: numOrNull(c.leader),
      queueDepth: numOrNull(c.queueDepth),
      errors15m: numOrNull(c.errors15m),
      pendingPods: numOrNull(c.pendingPods),
      runningPods: numOrNull(c.runningPods),
      archiveDatabaseBytes: numOrNull(c.archiveDatabaseBytes),
    },
    limits: { parallelism: numOrNull(l.parallelism) ?? undefined, namespaceParallelism: numOrNull(l.namespaceParallelism) ?? undefined },
    namespaces: Array.isArray(r.namespaces)
      ? (r.namespaces as Array<Record<string, unknown>>).filter((n) => typeof n?.name === 'string').map((n) => ({ name: n.name as string, parallelismLimit: numOrNull(n.parallelismLimit) }))
      : [],
    problems: Array.isArray(r.problems) ? r.problems.filter((p): p is string => typeof p === 'string') : [],
  }
}

export async function getEngine(cluster?: string): Promise<EngineState> {
  return readEngine(await bff<unknown>('GET', '/engine', { cluster }))
}

export interface SuspendAllResult {
  suspended: string[]
  failed: Array<{ schedule: string; status: number }>
  alreadySuspended: number
}

export async function suspendAllSchedules(body: { reason: string; namespaces?: string[] }, cluster?: string): Promise<SuspendAllResult> {
  const r = await bff<Partial<SuspendAllResult>>('POST', '/engine/schedules/suspend-all', { body, cluster })
  return { suspended: Array.isArray(r.suspended) ? r.suspended : [], failed: Array.isArray(r.failed) ? r.failed : [], alreadySuspended: typeof r.alreadySuspended === 'number' ? r.alreadySuspended : 0 }
}
