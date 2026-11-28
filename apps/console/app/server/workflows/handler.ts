import type { AccessCheck } from '@adhar/auth/server'
import { authorize, permissionDenied } from '../k8s/access.ts'
import { apiServerFetch, audit, type K8sIdentity, resolveClusterBase, resolveIdentity } from '../k8s/gateway.ts'
import { getRequestUser } from '../request-user.ts'
import { getTool } from '../tool-registry.ts'
import { openStore, writeAudit } from '../workspace/store.ts'
import { argoClient, ArgoUnavailable, argoErrorText, argoPath, type ArgoMode } from './argo-server.ts'
import { AUDIT_ACTION, checkFor } from './authz.ts'
import { DRAFT_FIELD_MANAGER, DRAFT_LABEL, draftExpiry, parseTestRun, stampDraft, testRunManifest } from './drafts.ts'
import { type LogDeps, parseLogQuery, runLogs } from './logs.ts'
import {
  actorLabel,
  ANNOTATION,
  approvalOf,
  type Approver,
  archiveListQuery,
  decideApproval,
  isNamespace,
  kubeUsername,
  LABEL,
  lintCall,
  type LintRequest,
  matchRoute,
  nodesOf,
  parseApprove,
  parseArchiveFilters,
  parseLint,
  parseResubmit,
  parseRetry,
  type Route,
  setBody,
  stripIdentityKeys,
  submitterOf,
  submitterSlug,
  summarizeArchived,
  type WfObject,
} from './model.ts'

/**
 * `/api/workflows/*` — the console's BFF for Argo Workflows (design 0026
 * §6.4; W1-C3).
 *
 *   GET    /capabilities                         what the cluster has (signed in)
 *   GET    /runs/:ns/:name                       hydrated run (argo-server)       get workflows
 *   POST   /runs/:ns/:name/retry                 {restartSuccessful?, nodeId?, parameters?}  update workflows
 *   POST   /runs/:ns/:name/resubmit              {memoized?, parameters?}         create workflows
 *   POST   /runs/:ns/:name/approve               {nodeId, decision, comment?}     update workflows + approver policy
 *   GET    /runs/:ns/:name/logs                  ?node=&container=&tail=&follow=&uid=   get pods/log
 *   GET    /runs/:ns/:name/artifacts/:node/:art  streamed                         get workflows (artifact namespaces only)
 *   GET    /archive/:ns                          ?limit&continue&phase&template&submitter&namePrefix&since   list workflows
 *   GET    /archive/:ns/:uid                                                      get workflows (404 unless in :ns)
 *   POST   /archive/:ns/:uid/{retry,resubmit}                                     create workflows
 *   DELETE /archive/:ns/:uid                                                      workflowsAdmin
 *   POST   /lint                                 {namespace, kind, manifest}      create <kind> in namespace
 *   POST   /drafts/:ns/test-run                  {yaml, parameters?, dryRun?}     create workflowtemplates (+ the user's own create workflows); dev tier only
 *   GET    /engine                                                                workflowsAdmin
 *   POST   /engine/schedules/suspend-all         {namespaces?, reason}            workflowsAdmin (+ the user's own patch rights)
 *
 * Order in every route: path validated (`model.ts matchRoute`) → signed in →
 * ONE SSAR as the user (`authz.ts`) → upstream. Kubernetes objects go through
 * the gateway as the user; argo-server through `argo-server.ts`, with the
 * namespace in every path being the one that was authorised and no query
 * value taken from the request except the allow-listed archive filters.
 * Mutations are recorded with `writeAudit` and the structured `audit()` line.
 */

/* ─────────────────────────── dependencies ─────────────────────────── */

export interface PromSample {
  metric?: Record<string, string>
  value?: [number, string]
}

export interface WorkflowsDeps {
  identity(req: Request): Promise<K8sIdentity | null>
  /** The tenant the caller's console data (the audit trail) lives in. */
  tenant(req: Request): Promise<string | null>
  authorize(req: Request, check: AccessCheck, id: K8sIdentity, cluster?: string): Promise<{ allowed: boolean; degraded: boolean }>
  /** The API server AS THE USER (the gateway). */
  k8s(id: K8sIdentity, path: string, init?: { method?: string; body?: string; headers?: Record<string, string>; search?: string; cluster?: string }): Promise<Response>
  argo(id: K8sIdentity, path: string, init?: { method?: string; query?: URLSearchParams; body?: unknown; accept?: string; stream?: boolean }): Promise<{ res: Response; mode: ArgoMode }>
  argoConfigured(): boolean
  /** A merge patch on a Workflow as the console's argo ServiceAccount (service-mode provenance only). */
  patchAsArgo(namespace: string, name: string, patch: unknown): Promise<boolean>
  /** Does `cluster` name a configured cluster? */
  clusterKnown(cluster?: string): boolean
  loki: LogDeps['loki']
  prom(expr: string): Promise<PromSample[]>
  /** Namespaces argo-server keeps artifacts for (D-12: adhar-system until W5). */
  artifactNamespaces(): string[]
  record(tenant: string, actor: { id: string; name: string }, action: string, target: { type: string; id: string; label: string }, req: Request, meta: Record<string, unknown>, outcome: 'success' | 'failure'): Promise<void>
  log(entry: Record<string, unknown>): void
  now(): number
}

const qs = (o: Record<string, string>) => `?${new URLSearchParams(o)}`
/** The API server's user prefix, as the gateway impersonates with. */
const userPrefix = () => Deno.env.get('K8S_IMPERSONATE_USER_PREFIX') ?? 'oidc:'

function lokiTool(): { baseUrl: string; headers: Record<string, string> } | null {
  const t = getTool('loki')
  if (!t?.baseUrl) return null
  return {
    baseUrl: t.baseUrl,
    headers: { accept: 'application/json', ...(t.headers ?? {}), ...(t.authMode === 'service' && t.serviceToken ? { authorization: `Bearer ${t.serviceToken}` } : {}) },
  }
}

function promTool(): { baseUrl: string; headers: Record<string, string> } | null {
  const t = getTool('prometheus')
  if (!t?.baseUrl) return null
  return {
    baseUrl: t.baseUrl,
    headers: { accept: 'application/json', ...(t.headers ?? {}), ...(t.authMode === 'service' && t.serviceToken ? { authorization: `Bearer ${t.serviceToken}` } : {}) },
  }
}

const realDeps: WorkflowsDeps = {
  identity: resolveIdentity,
  tenant: async (req) => (await getRequestUser(req))?.activeTenant ?? null,
  authorize: async (req, check, id, cluster) => {
    const d = await authorize(req, check, { id, cluster })
    return { allowed: d.allowed, degraded: d.allowed ? false : d.degraded }
  },
  k8s: (id, path, init) => apiServerFetch(id, path, init),
  argo: (id, path, init) => argoClient().fetch(id, path, init),
  argoConfigured: () => argoClient().configured,
  patchAsArgo: async (namespace, name, patch) => {
    const tok = await argoClient().serviceToken()
    if (!tok) return false
    const res = await apiServerFetch(tok, `/apis/argoproj.io/v1alpha1/namespaces/${namespace}/workflows/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify(patch),
    }).catch(() => null)
    await res?.body?.cancel()
    return Boolean(res?.ok)
  },
  clusterKnown: (cluster) => resolveClusterBase(cluster) !== null,
  loki: async (query, startMs, endMs, limit) => {
    const t = lokiTool()
    if (!t) throw new Error('Loki is not configured (LOKI_URL)')
    const q = new URLSearchParams({ query, start: `${startMs}000000`, end: `${endMs}000000`, limit: String(limit), direction: 'backward' })
    const res = await fetch(`${t.baseUrl}/loki/api/v1/query_range?${q}`, { headers: t.headers, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`Loki HTTP ${res.status}`)
    }
    const body = (await res.json()) as { data?: { result?: Array<{ values?: Array<[string, string]> }> } }
    return (body.data?.result ?? []).flatMap((s) => s.values ?? [])
  },
  prom: async (expr) => {
    const t = promTool()
    if (!t) throw new Error('Prometheus is not configured (PROMETHEUS_URL or MIMIR_URL)')
    const res = await fetch(`${t.baseUrl}/api/v1/query${qs({ query: expr })}`, { headers: t.headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`Prometheus HTTP ${res.status}`)
    }
    const body = (await res.json()) as { data?: { result?: PromSample[] } }
    return body.data?.result ?? []
  },
  artifactNamespaces: () =>
    (Deno.env.get('ARGO_ARTIFACT_NAMESPACES') ?? 'adhar-system').split(',').map((s) => s.trim()).filter(isNamespace),
  record: async (tenant, actor, action, target, req, meta, outcome) => {
    const store = await openStore(tenant).catch(() => null)
    if (store) await writeAudit(store, actor, action, target, req, meta, outcome)
  },
  log: audit,
  now: Date.now,
}

/* ─────────────────────────── responses ─────────────────────────── */

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const fail = (status: number, error: string, detail: string, extra: Record<string, unknown> = {}) => json({ error, detail, ...extra }, status)

/** An argo-server refusal as the console's `{error, detail}`. */
async function fromArgo(res: Response, mode: ArgoMode, what: string): Promise<Response> {
  const message = await argoErrorText(res)
  switch (res.status) {
    case 400:
    case 422:
      return fail(400, 'invalid', message || `${what} was refused as invalid.`)
    case 401:
    case 403:
      // As the service identity a refusal is the platform's missing grant,
      // not the user's: the user's SSAR already said yes.
      return mode === 'service'
        ? fail(502, 'argo_service_forbidden', `argo-server refused the console's ServiceAccount (adhar-system/adhar-console-argo) for ${what}: ${message}`)
        : fail(403, 'forbidden', message || `Not permitted: ${what}.`)
    case 404:
      return fail(404, 'not_found', message || `${what}: not found.`)
    case 409:
      return fail(409, 'conflict', message || `${what}: conflict.`)
    default:
      return fail(502, 'upstream_error', `argo-server answered HTTP ${res.status} for ${what}${message ? `: ${message}` : ''}.`)
  }
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text()
  if (!text.trim()) return {}
  return JSON.parse(text)
}

/* ─────────────────────────── capabilities ─────────────────────────── */

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

const CAPS_TTL_MS = 60_000
const capsCache = new Map<string, { at: number; caps: Capabilities }>()

async function resourcesOf(deps: WorkflowsDeps, id: K8sIdentity, groupVersion: string, cluster?: string): Promise<Set<string>> {
  const res = await deps.k8s(id, `/apis/${groupVersion}`, { cluster }).catch(() => null)
  if (!res?.ok) {
    await res?.body?.cancel()
    return new Set()
  }
  const body = (await res.json().catch(() => ({}))) as { resources?: Array<{ name?: string }> }
  return new Set((body.resources ?? []).map((r) => r.name ?? '').filter((n) => n && !n.includes('/')))
}

async function capabilities(deps: WorkflowsDeps, id: K8sIdentity, cluster: string | undefined): Promise<Capabilities> {
  const key = cluster ?? ''
  const hit = capsCache.get(key)
  if (hit && deps.now() - hit.at < CAPS_TTL_MS) return hit.caps
  const [argo, platform, litmus, volcano] = await Promise.all([
    resourcesOf(deps, id, 'argoproj.io/v1alpha1', cluster),
    resourcesOf(deps, id, 'platform.adhar.io/v1alpha1', cluster),
    resourcesOf(deps, id, 'litmuschaos.io/v1alpha1', cluster),
    resourcesOf(deps, id, 'scheduling.volcano.sh/v1beta1', cluster),
  ])
  const installed = argo.has('workflows')
  let version: string | undefined
  let reachable = false
  let identity: Capabilities['argoServer']['identity'] = 'none'
  // argo-server is the default cluster's: another cluster's runs are read
  // through the gateway only.
  const isDefault = !cluster || ['default', 'local'].includes(cluster)
  if (installed && isDefault && deps.argoConfigured()) {
    try {
      const { res, mode } = await deps.argo(id, argoPath.version())
      if (res.ok) {
        const v = (await res.json().catch(() => ({}))) as { version?: string }
        version = v.version
        reachable = true
        identity = mode
      } else {
        await res.body?.cancel()
      }
    } catch {
      // unreachable or no identity: reported as such below
    }
  }
  const caps: Capabilities = {
    installed,
    ...(version ? { version } : {}),
    argoServer: { reachable, identity },
    // The platform always runs the archive (D-9); it is usable when argo-server is.
    archive: reachable,
    artifactNamespaces: reachable ? deps.artifactNamespaces() : [],
    triggers: { bindings: argo.has('workfloweventbindings'), platformEvents: false },
    gamedays: platform.has('gamedays') && litmus.has('chaosengines'),
    volcano: volcano.has('queues'),
    batch: platform.has('batchjobs'),
  }
  capsCache.set(key, { at: deps.now(), caps })
  return caps
}

/** Test seam. */
export function resetCapabilitiesCache(): void {
  capsCache.clear()
}

/* ─────────────────────────── the handler ─────────────────────────── */

export function handleWorkflows(req: Request, subpath: string, deps: WorkflowsDeps = realDeps): Promise<Response> {
  return handle(req, subpath, deps).catch((e) => {
    if (e instanceof ArgoUnavailable) {
      return fail(503, e.code === 'not_configured' ? 'argo_not_configured' : 'argo_unavailable', e.message)
    }
    if (e instanceof SyntaxError) return fail(400, 'invalid_json', 'The request body is not valid JSON.')
    throw e
  })
}

interface Ctx {
  req: Request
  url: URL
  id: K8sIdentity
  deps: WorkflowsDeps
  who: Approver
}

async function handle(req: Request, subpath: string, deps: WorkflowsDeps): Promise<Response> {
  const url = new URL(req.url)
  const m = matchRoute(req.method, subpath)
  if ('error' in m) {
    const status = m.error === 'not_found' ? 404 : m.error === 'method_not_allowed' ? 405 : 400
    return fail(status, m.error, m.detail)
  }
  const route = m.route
  const id = await deps.identity(req)
  if (!id) return fail(401, 'unauthenticated', 'Sign in to continue.')
  const who: Approver = { id: id.user.id, username: id.user.username, email: id.user.email, groups: id.user.groups }
  const ctx: Ctx = { req, url, id, deps, who }

  if (route.op === 'capabilities') {
    const cluster = url.searchParams.get('cluster') ?? undefined
    if (cluster !== undefined && !deps.clusterKnown(cluster)) return fail(400, 'unknown_cluster', `No cluster named ${cluster}.`)
    return json(await capabilities(deps, id, cluster))
  }

  // Lint chooses its check from the body, so the body is read first.
  let lint: ReturnType<typeof parseLint> | undefined
  if (route.op === 'lint') {
    lint = parseLint(await readJson(req))
    if (!lint.ok) return fail(400, 'invalid', lint.detail)
  }

  const check = checkFor(route, lint?.ok ? lint.value : undefined)
  if (check) {
    const d = await deps.authorize(req, check, id)
    if (!d.allowed) {
      deps.log({ user: actorLabel(who), op: route.op, ...('namespace' in route ? { namespace: route.namespace } : {}), outcome: 'denied' })
      return permissionDenied(check, d.degraded)
    }
  }

  switch (route.op) {
    case 'run.get':
      return await runGet(ctx, route)
    case 'run.retry':
      return await runRetry(ctx, route)
    case 'run.resubmit':
      return await runResubmit(ctx, route)
    case 'run.approve':
      return await runApprove(ctx, route)
    case 'run.logs':
      return await runLogsRoute(ctx, route)
    case 'run.artifact':
      return await runArtifact(ctx, route)
    case 'archive.list':
      return await archiveList(ctx, route)
    case 'archive.get':
      return await archiveGet(ctx, route)
    case 'archive.retry':
    case 'archive.resubmit':
      return await archiveAction(ctx, route)
    case 'archive.delete':
      return await archiveDelete(ctx, route)
    case 'lint':
      if (!lint?.ok) return fail(400, 'invalid', 'lint needs a body.')
      return await lintRoute(ctx, lint.value)
    case 'drafts.test-run':
      return await draftTestRun(ctx, route)
    case 'engine.get':
      return await engineGet(ctx)
    case 'engine.suspend-all':
      return await suspendAll(ctx)
  }
  return fail(404, 'not_found', 'Unknown workflows endpoint.')
}

/* ─────────────────────────── audit ─────────────────────────── */

async function record(ctx: Ctx, action: string, target: { id: string; label: string }, meta: Record<string, unknown>, outcome: 'success' | 'failure') {
  ctx.deps.log({ user: actorLabel(ctx.who), action, target: target.id, outcome, ...meta })
  const tenant = await ctx.deps.tenant(ctx.req).catch(() => null)
  if (!tenant) return
  await ctx.deps.record(tenant, { id: ctx.who.id, name: actorLabel(ctx.who) }, action, { type: 'workflow', ...target }, ctx.req, meta, outcome).catch(() => {})
}

const runTarget = (ns: string, name: string) => ({ id: `${ns}/${name}`, label: `${ns}/${name}` })

/* ─────────────────────────── runs ─────────────────────────── */

type R<O extends Route['op']> = Extract<Route, { op: O }>

async function runGet(ctx: Ctx, r: R<'run.get'>): Promise<Response> {
  const { res, mode } = await ctx.deps.argo(ctx.id, argoPath.workflow(r.namespace, r.name))
  if (!res.ok) return await fromArgo(res, mode, `run ${r.namespace}/${r.name}`)
  const wf = (await res.json()) as WfObject
  // Belt and braces: what argo-server returned must be what was authorised.
  if (wf.metadata?.namespace && wf.metadata.namespace !== r.namespace) return fail(404, 'not_found', `No run ${r.namespace}/${r.name}.`)
  return json(wf)
}

const workflowRef = (w: WfObject) => ({
  name: w.metadata?.name,
  namespace: w.metadata?.namespace,
  uid: w.metadata?.uid,
  phase: w.status?.phase ?? w.metadata?.labels?.['workflows.argoproj.io/phase'],
})

async function runRetry(ctx: Ctx, r: R<'run.retry'>): Promise<Response> {
  const p = parseRetry(await readJson(ctx.req))
  if (!p.ok) return fail(400, 'invalid', p.detail)
  const body = stripIdentityKeys({ name: r.name, namespace: r.namespace, ...p.value })
  const action = AUDIT_ACTION['run.retry'] as string
  const { res, mode } = await ctx.deps.argo(ctx.id, argoPath.workflowAction(r.namespace, r.name, 'retry'), { method: 'PUT', body })
  if (!res.ok) {
    const out = await fromArgo(res, mode, `retrying ${r.namespace}/${r.name}`)
    await record(ctx, action, runTarget(r.namespace, r.name), { restartSuccessful: p.value.restartSuccessful, node: p.value.nodeFieldSelector, status: out.status }, 'failure')
    return out
  }
  const wf = (await res.json().catch(() => ({}))) as WfObject
  await record(ctx, action, runTarget(r.namespace, r.name), { restartSuccessful: p.value.restartSuccessful, node: p.value.nodeFieldSelector, identity: mode }, 'success')
  return json({ ok: true, workflow: workflowRef(wf) })
}

/**
 * In service mode argo-server creates the new run as `adhar-console-argo`, so
 * Kyverno records the ServiceAccount as its submitter. The BFF puts the real
 * person back — the same value Kyverno would have written for them.
 */
async function restoreSubmitter(ctx: Ctx, mode: ArgoMode, wf: WfObject): Promise<boolean | undefined> {
  if (mode !== 'service' || !wf.metadata?.name || !wf.metadata.namespace) return undefined
  const user = kubeUsername(ctx.who, userPrefix(), Deno.env.get('K8S_IMPERSONATE_USERNAME_CLAIM') ?? 'preferred_username')
  // Both halves Kyverno writes: argo-server's resubmit copies the ORIGINAL
  // run's labels, so the "My runs" label would otherwise still name whoever
  // started the first run.
  return await ctx.deps.patchAsArgo(wf.metadata.namespace, wf.metadata.name, {
    metadata: { annotations: { [ANNOTATION.submittedBy]: user }, labels: { [LABEL.submitter]: submitterSlug(user) } },
  }).catch(() => false)
}

async function runResubmit(ctx: Ctx, r: R<'run.resubmit'>): Promise<Response> {
  const p = parseResubmit(await readJson(ctx.req))
  if (!p.ok) return fail(400, 'invalid', p.detail)
  const body = stripIdentityKeys({ name: r.name, namespace: r.namespace, ...p.value })
  const action = AUDIT_ACTION['run.resubmit'] as string
  const { res, mode } = await ctx.deps.argo(ctx.id, argoPath.workflowAction(r.namespace, r.name, 'resubmit'), { method: 'PUT', body })
  if (!res.ok) {
    const out = await fromArgo(res, mode, `resubmitting ${r.namespace}/${r.name}`)
    await record(ctx, action, runTarget(r.namespace, r.name), { memoized: p.value.memoized, status: out.status }, 'failure')
    return out
  }
  const wf = (await res.json().catch(() => ({}))) as WfObject
  const provenance = await restoreSubmitter(ctx, mode, wf)
  await record(ctx, action, runTarget(r.namespace, r.name), { memoized: p.value.memoized, created: wf.metadata?.name, identity: mode }, 'success')
  return json({
    ok: true,
    workflow: workflowRef(wf),
    ...(provenance === false ? { warning: 'The run was resubmitted, but recording you as its submitter failed; it shows the console ServiceAccount.' } : {}),
  })
}

async function loadRunAsUser(ctx: Ctx, ns: string, name: string): Promise<WfObject | Response> {
  const res = await ctx.deps.k8s(ctx.id, `/apis/argoproj.io/v1alpha1/namespaces/${ns}/workflows/${encodeURIComponent(name)}`)
  if (res.ok) return (await res.json()) as WfObject
  await res.body?.cancel()
  if (res.status === 404) return fail(404, 'not_found', `No run ${ns}/${name}.`)
  if (res.status === 401 || res.status === 403) return fail(403, 'forbidden', `Reading ${ns}/${name} needs get workflows.argoproj.io in namespace ${ns}.`)
  return fail(502, 'upstream_error', `The API server answered HTTP ${res.status}.`)
}

async function runApprove(ctx: Ctx, r: R<'run.approve'>): Promise<Response> {
  const p = parseApprove(await readJson(ctx.req))
  if (!p.ok) return fail(400, 'invalid', p.detail)
  const run = await loadRunAsUser(ctx, r.namespace, r.name)
  if (run instanceof Response) return run
  let nodes = await nodesOf(run)
  if (nodes === null) {
    const { res } = await ctx.deps.argo(ctx.id, argoPath.workflow(r.namespace, r.name))
    nodes = res.ok ? ((await nodesOf((await res.json()) as WfObject)) ?? {}) : {}
    if (!res.ok) await res.body?.cancel()
  }
  const ask = approvalOf(nodes[p.value.nodeId], run)
  // The node's own id becomes argo-server's nodeFieldSelector: it must be the
  // validated id that was asked for, not whatever the stored object says (a
  // field selector like "id=x,phase=Running" matches more than one node).
  if (!ask || ask.nodeId !== p.value.nodeId) return fail(409, 'not_waiting', `Node ${p.value.nodeId} is not waiting for a decision (it is not a running suspend node).`)
  const verdict = decideApproval(ask, ctx.who, submitterOf(run), userPrefix())
  const action = p.value.decision === 'approve' ? 'workflow.approve' : 'workflow.reject'
  const target = runTarget(r.namespace, r.name)
  if (!verdict.ok) {
    await record(ctx, action, target, { node: ask.nodeId, refused: verdict.error }, 'failure')
    return fail(verdict.status, verdict.error, verdict.detail)
  }
  const approver = actorLabel(ctx.who)
  const { body, resume } = setBody(r.namespace, r.name, ask, p.value, approver)
  const set = await ctx.deps.argo(ctx.id, argoPath.workflowAction(r.namespace, r.name, 'set'), { method: 'PUT', body })
  if (!set.res.ok) {
    const out = await fromArgo(set.res, set.mode, `recording the decision on ${r.namespace}/${r.name}`)
    await record(ctx, action, target, { node: ask.nodeId, step: 'set', status: out.status }, 'failure')
    return out
  }
  await set.res.body?.cancel()
  if (resume) {
    const res = await ctx.deps.argo(ctx.id, argoPath.workflowAction(r.namespace, r.name, 'resume'), {
      method: 'PUT',
      body: { name: r.name, namespace: r.namespace, nodeFieldSelector: body.nodeFieldSelector },
    })
    if (!res.res.ok) {
      const out = await fromArgo(res.res, res.mode, `resuming ${r.namespace}/${r.name}`)
      await record(ctx, action, target, { node: ask.nodeId, step: 'resume', status: out.status }, 'failure')
      return out
    }
    await res.res.body?.cancel()
  }
  await record(ctx, action, target, { node: ask.nodeId, decision: p.value.decision, comment: p.value.comment || undefined, identity: set.mode }, 'success')
  return json({ ok: true, decision: p.value.decision, approver, nodeId: ask.nodeId, message: body.message })
}

function logDeps(ctx: Ctx): LogDeps {
  return {
    k8s: (id, path, init) => ctx.deps.k8s(id, path, init),
    archived: async (id, ns, uid) => {
      if (!ctx.deps.argoConfigured()) return null
      const q = new URLSearchParams({ namespace: ns })
      const { res } = await ctx.deps.argo(id, argoPath.archivedOne(uid), { query: q }).catch(() => ({ res: null as Response | null }))
      if (!res?.ok) {
        await res?.body?.cancel()
        return null
      }
      const wf = (await res.json()) as WfObject
      return wf.metadata?.namespace === ns ? wf : null
    },
    hydrated: async (id, ns, name) => {
      if (!ctx.deps.argoConfigured()) return null
      const { res } = await ctx.deps.argo(id, argoPath.workflow(ns, name)).catch(() => ({ res: null as Response | null }))
      if (!res?.ok) {
        await res?.body?.cancel()
        return null
      }
      const wf = (await res.json()) as WfObject
      return wf.metadata?.namespace === ns ? wf : null
    },
    loki: ctx.deps.loki,
    now: ctx.deps.now,
  }
}

async function runLogsRoute(ctx: Ctx, r: R<'run.logs'>): Promise<Response> {
  const q = parseLogQuery(ctx.url.searchParams)
  if (!q.ok) return fail(400, 'invalid', q.detail)
  return await runLogs(logDeps(ctx), ctx.id, r.namespace, r.name, q.value)
}

const PASS_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag']

/**
 * The download name from argo-server's `Content-Disposition` — v4 sends
 * `filename="<key basename>"` with NO disposition type — else the artifact
 * name. Reduced to a safe token so it cannot break out of the quoted value.
 */
export function artifactFilename(upstream: string | null, artifact: string): string {
  const m = upstream ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(upstream) : null
  let name = artifact
  if (m) {
    try {
      name = decodeURIComponent(m[1])
    } catch {
      name = m[1]
    }
  }
  const safe = name.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 200)
  return safe || artifact
}

async function runArtifact(ctx: Ctx, r: R<'run.artifact'>): Promise<Response> {
  if (!ctx.deps.artifactNamespaces().includes(r.namespace)) {
    return fail(404, 'artifacts_unavailable', `Artifacts are not kept for namespace ${r.namespace}; step logs come from Loki and outputs from the run's parameters.`)
  }
  const { res, mode } = await ctx.deps.argo(ctx.id, argoPath.artifact(r.namespace, r.name, r.nodeId, r.artifact), { accept: '*/*', stream: true })
  if (!res.ok) return await fromArgo(res, mode, `artifact ${r.artifact} of ${r.namespace}/${r.name}`)
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // Whatever the step wrote (HTML, SVG …) must never run as the console.
    'content-security-policy': "sandbox; default-src 'none'",
  })
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h)
    if (v) headers.set(h, v)
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
  // An artifact is the user's data, never markup the console serves as
  // itself: ALWAYS a download. argo-server's own header is not passed through —
  // it carries no disposition type at all, and an `inline` would render an
  // HTML artifact on the console's origin.
  headers.set('content-disposition', `attachment; filename="${artifactFilename(res.headers.get('content-disposition'), r.artifact)}"`)
  return new Response(res.body, { status: 200, headers })
}

/* ─────────────────────────── archive ─────────────────────────── */

/** The archived run, only when it is in `ns`. Anything else is the same 404 — existence is not leaked. */
async function archivedIn(ctx: Ctx, ns: string, uid: string): Promise<WfObject | Response> {
  const { res, mode } = await ctx.deps.argo(ctx.id, argoPath.archivedOne(uid), { query: new URLSearchParams({ namespace: ns }) })
  const notFound = () => fail(404, 'not_found', `No archived run ${uid} in namespace ${ns}.`)
  if (!res.ok) {
    if (res.status === 404) {
      await res.body?.cancel()
      return notFound()
    }
    return await fromArgo(res, mode, `archived run ${uid}`)
  }
  const wf = (await res.json()) as WfObject
  if (wf.metadata?.namespace !== ns) return notFound()
  return wf
}

async function archiveList(ctx: Ctx, r: R<'archive.list'>): Promise<Response> {
  const f = parseArchiveFilters(ctx.url.searchParams)
  if (!f.ok) return fail(400, 'invalid', f.detail)
  const { res, mode } = await ctx.deps.argo(ctx.id, argoPath.archived(), { query: archiveListQuery(r.namespace, f.value) })
  if (!res.ok) return await fromArgo(res, mode, `the archive of ${r.namespace}`)
  const body = (await res.json().catch(() => ({}))) as { items?: WfObject[] | null; metadata?: { continue?: string } }
  const items = (body.items ?? [])
    // Never trust the pin alone: an item from another namespace is dropped.
    .filter((w) => w.metadata?.namespace === r.namespace)
    .map(summarizeArchived)
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .filter((s) => f.value.sinceMs === undefined || (Date.parse(s.startedAt ?? s.finishedAt ?? '') || 0) >= f.value.sinceMs)
  return json({ namespace: r.namespace, items, ...(body.metadata?.continue ? { continue: body.metadata.continue } : {}) })
}

async function archiveGet(ctx: Ctx, r: R<'archive.get'>): Promise<Response> {
  const wf = await archivedIn(ctx, r.namespace, r.uid)
  return wf instanceof Response ? wf : json(wf)
}

async function archiveAction(ctx: Ctx, r: R<'archive.retry' | 'archive.resubmit'>): Promise<Response> {
  const verb = r.op === 'archive.retry' ? 'retry' : 'resubmit'
  const parsed = verb === 'retry' ? parseRetry(await readJson(ctx.req)) : parseResubmit(await readJson(ctx.req))
  if (!parsed.ok) return fail(400, 'invalid', parsed.detail)
  const wf = await archivedIn(ctx, r.namespace, r.uid)
  if (wf instanceof Response) return wf
  const name = wf.metadata?.name ?? ''
  const action = AUDIT_ACTION[r.op] as string
  const target = { id: `${r.namespace}/${name}`, label: `${r.namespace}/${name} (archived ${r.uid})` }
  const body = stripIdentityKeys({ uid: r.uid, name, namespace: r.namespace, ...parsed.value })
  const { res, mode } = await ctx.deps.argo(ctx.id, argoPath.archivedAction(r.uid, verb), { method: 'PUT', body })
  if (!res.ok) {
    const out = await fromArgo(res, mode, `${verb} of archived run ${r.uid}`)
    await record(ctx, action, target, { uid: r.uid, status: out.status }, 'failure')
    return out
  }
  const created = (await res.json().catch(() => ({}))) as WfObject
  const provenance = await restoreSubmitter(ctx, mode, created)
  await record(ctx, action, target, { uid: r.uid, created: created.metadata?.name, identity: mode }, 'success')
  return json({
    ok: true,
    workflow: workflowRef(created),
    ...(provenance === false ? { warning: 'The run was started, but recording you as its submitter failed; it shows the console ServiceAccount.' } : {}),
  })
}

async function archiveDelete(ctx: Ctx, r: R<'archive.delete'>): Promise<Response> {
  const wf = await archivedIn(ctx, r.namespace, r.uid)
  if (wf instanceof Response) return wf
  const name = wf.metadata?.name ?? ''
  const target = { id: `${r.namespace}/${name}`, label: `${r.namespace}/${name} (archived ${r.uid})` }
  const { res, mode } = await ctx.deps.argo(ctx.id, argoPath.archivedOne(r.uid), { method: 'DELETE', query: new URLSearchParams({ namespace: r.namespace }) })
  if (!res.ok) {
    const out = await fromArgo(res, mode, `deleting archived run ${r.uid}`)
    await record(ctx, 'workflow.delete', target, { uid: r.uid, archived: true, status: out.status }, 'failure')
    return out
  }
  await res.body?.cancel()
  await record(ctx, 'workflow.delete', target, { uid: r.uid, archived: true }, 'success')
  return json({ ok: true, deleted: r.uid })
}

/* ─────────────────────────── lint ─────────────────────────── */

async function lintRoute(ctx: Ctx, l: LintRequest): Promise<Response> {
  const call = lintCall(l)
  const { res, mode } = await ctx.deps.argo(ctx.id, call.path, { method: 'POST', body: call.body })
  if (res.ok) {
    await res.body?.cancel()
    return json({ valid: true })
  }
  if (res.status === 400 || res.status === 422 || res.status === 409) {
    return json({ valid: false, message: await argoErrorText(res) })
  }
  return await fromArgo(res, mode, `linting a ${l.kind}`)
}

/* ─────────────────────────── drafts ─────────────────────────── */

/** The API server's own words for a refusal (a Status object's `message`): Kyverno and RBAC speak here. */
async function k8sMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const b = JSON.parse(text) as { message?: string }
    return typeof b?.message === 'string' ? b.message : text.slice(0, 2000)
  } catch {
    return text.slice(0, 2000)
  }
}

async function fromK8s(res: Response, what: string, extra: Record<string, unknown> = {}): Promise<Response> {
  const message = await k8sMessage(res)
  switch (res.status) {
    case 400:
    case 422:
      return fail(400, 'invalid', message || `${what} was refused as invalid.`, extra)
    case 401:
    case 403:
      return fail(403, 'forbidden', message || `Not permitted: ${what}.`, extra)
    case 404:
      return fail(404, 'not_found', message || `${what}: not found.`, extra)
    case 409:
      return fail(409, 'conflict', message || `${what}: conflict.`, extra)
    default:
      return fail(502, 'upstream_error', `The API server answered HTTP ${res.status} for ${what}${message ? `: ${message}` : ''}.`, extra)
  }
}

const TIER_LABEL = 'adhar.io/tier'

/**
 * The designer's test run (design 0026 §6.4, §6.9; W2-C3): save the template
 * as this user's DRAFT in a dev namespace, then start a run of it. Both writes
 * are the user's own, through the gateway — the console adds no privilege, and
 * Kyverno #7 (drafts only in `adhar.io/tier: dev`, expiring within 7 days)
 * judges the same request it would judge from kubectl.
 *
 * The BFF checks the tier itself as well: #7 is `failurePolicy: Ignore`, and
 * "a draft landed in prod while Kyverno was down" is not a risk to leave to
 * a webhook. What it cannot confirm it refuses.
 *
 * `dryRun` is validation level B (§6.7): the same apply with `dryRun=All` —
 * RBAC, the CRD and admission answer, nothing is stored, nothing runs.
 */
async function draftTestRun(ctx: Ctx, r: R<'drafts.test-run'>): Promise<Response> {
  const p = parseTestRun(await readJson(ctx.req))
  if (!p.ok) return fail(400, 'invalid', p.detail)
  const ns = r.namespace
  const action = AUDIT_ACTION['drafts.test-run'] as string

  const nsRes = await ctx.deps.k8s(ctx.id, `/api/v1/namespaces/${ns}`).catch(() => null)
  if (!nsRes?.ok) {
    await nsRes?.body?.cancel()
    if (nsRes?.status === 404) return fail(404, 'not_found', `No namespace ${ns}.`)
    return fail(403, 'tier_unknown', `The console could not confirm that ${ns} is a dev namespace (reading it answered ${nsRes ? `HTTP ${nsRes.status}` : 'nothing'}). Drafts and test runs are for dev namespaces only.`)
  }
  const tier = ((await nsRes.json().catch(() => ({}))) as { metadata?: { labels?: Record<string, string> } }).metadata?.labels?.[TIER_LABEL]
  if (tier !== 'dev') {
    return fail(403, 'not_dev', `Namespace ${ns} is ${tier ? `tier ${tier}` : 'not a dev namespace'}: drafts and test runs are for dev namespaces only (${TIER_LABEL}: dev). Publish the template to run it elsewhere.`)
  }

  const kubeUser = kubeUsername(ctx.who, userPrefix(), Deno.env.get('K8S_IMPERSONATE_USERNAME_CLAIM') ?? 'preferred_username')
  const stamped = stampDraft(p.value.yaml, { namespace: ns, kubeUser, expires: draftExpiry(ctx.deps.now()) })
  if (!stamped.ok) return fail(400, 'invalid', stamped.detail)
  const draft = { name: stamped.value.name, namespace: ns, expires: stamped.value.expires }
  const target = { id: `${ns}/${draft.name}`, label: `${ns}/${draft.name} (draft of ${stamped.value.base})` }
  const path = `/apis/argoproj.io/v1alpha1/namespaces/${ns}/workflowtemplates/${encodeURIComponent(draft.name)}`

  // Never write over something that is not a draft, whatever its name.
  const existing = await ctx.deps.k8s(ctx.id, path).catch(() => null)
  if (existing?.ok) {
    const cur = (await existing.json().catch(() => ({}))) as WfObject
    if (cur.metadata?.labels?.[DRAFT_LABEL] !== 'true') {
      return fail(409, 'not_a_draft', `${ns}/${draft.name} exists and is not a draft; the console will not overwrite it. Rename the template.`)
    }
  } else {
    await existing?.body?.cancel()
    if (existing?.status !== 404) {
      if (existing?.status === 401 || existing?.status === 403) return fail(403, 'forbidden', `Saving a draft needs get and patch workflowtemplates.argoproj.io in namespace ${ns}.`)
      return fail(502, 'upstream_error', `The API server answered ${existing ? `HTTP ${existing.status}` : 'nothing'} reading ${ns}/${draft.name}.`)
    }
  }

  const applied = await ctx.deps.k8s(ctx.id, path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/apply-patch+yaml' },
    search: qs({ fieldManager: DRAFT_FIELD_MANAGER, force: 'true', ...(p.value.dryRun ? { dryRun: 'All' } : {}) }),
    body: stamped.value.yaml,
  })
  if (!applied.ok) {
    const out = await fromK8s(applied, `saving the draft ${ns}/${draft.name}`)
    if (!p.value.dryRun) await record(ctx, action, target, { step: 'apply', status: out.status }, 'failure')
    return out
  }
  await applied.body?.cancel()
  if (p.value.dryRun) return json({ ok: true, dryRun: true, draft })

  const run = await ctx.deps.k8s(ctx.id, `/apis/argoproj.io/v1alpha1/namespaces/${ns}/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(testRunManifest(ns, draft.name, p.value.parameters)),
  })
  if (!run.ok) {
    // The draft IS saved: say so, so the designer can keep it and show why the run was refused.
    const out = await fromK8s(run, `starting a run of ${ns}/${draft.name}`, { draft })
    await record(ctx, action, target, { step: 'submit', status: out.status }, 'failure')
    return out
  }
  const wf = (await run.json().catch(() => ({}))) as WfObject
  await record(ctx, action, target, { run: wf.metadata?.name, parameters: p.value.parameters.map((x) => x.name), expires: draft.expires }, 'success')
  return json({ ok: true, draft, workflow: workflowRef(wf) })
}

/* ─────────────────────────── engine ─────────────────────────── */

const ENGINE_QUERIES: Record<string, string> = {
  leader: 'max(argo_workflows_is_leader{job="workflow-controller"})',
  queueDepth: 'max(argo_workflows_queue_depth_gauge{job="workflow-controller", queue_name="workflow_queue"})',
  errors15m: 'sum(increase(argo_workflows_error_count{job="workflow-controller"}[15m]))',
  pendingPods: 'sum(argo_workflows_pods_gauge{job="workflow-controller", phase="Pending"})',
  runningPods: 'sum(argo_workflows_pods_gauge{job="workflow-controller", phase="Running"})',
  archiveDatabaseBytes: 'sum(cnpg_pg_database_size_bytes{namespace="adhar-system", pod=~"argo-workflows-db-[0-9]+"})',
}

export { ENGINE_QUERIES }

async function engineGet(ctx: Ctx): Promise<Response> {
  const problems: string[] = []
  const metrics: Record<string, number | null> = {}
  await Promise.all(Object.entries(ENGINE_QUERIES).map(async ([k, expr]) => {
    try {
      const r = await ctx.deps.prom(expr)
      const v = Number(r[0]?.value?.[1])
      metrics[k] = r.length && Number.isFinite(v) ? v : null
    } catch (e) {
      metrics[k] = null
      if (!problems.some((p) => p.startsWith('Prometheus'))) problems.push(`Prometheus: ${e instanceof Error ? e.message : String(e)}`)
    }
  }))
  // As the user: platform staff hold these reads; a gap is reported, not hidden.
  let limits: { parallelism?: number; namespaceParallelism?: number } = {}
  const cm = await ctx.deps.k8s(ctx.id, '/api/v1/namespaces/adhar-system/configmaps/workflow-controller-configmap').catch(() => null)
  if (cm?.ok) {
    const d = ((await cm.json()) as { data?: Record<string, string> }).data ?? {}
    const n = (s?: string) => (s && Number.isFinite(Number(s)) ? Number(s) : undefined)
    limits = { parallelism: n(d.parallelism), namespaceParallelism: n(d.namespaceParallelism) }
  } else {
    await cm?.body?.cancel()
    problems.push(`The controller configuration could not be read (${cm ? `HTTP ${cm.status}` : 'no answer'}).`)
  }
  const nsRes = await ctx.deps.k8s(ctx.id, '/api/v1/namespaces', { search: qs({ labelSelector: 'workflows.argoproj.io/parallelism-limit' }) }).catch(() => null)
  let namespaces: Array<{ name: string; parallelismLimit: number | null }> = []
  if (nsRes?.ok) {
    const items = ((await nsRes.json()) as { items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> } }> }).items ?? []
    namespaces = items.map((n) => {
      const v = Number(n.metadata?.labels?.['workflows.argoproj.io/parallelism-limit'])
      return { name: n.metadata?.name ?? '', parallelismLimit: Number.isFinite(v) ? v : null }
    }).filter((n) => n.name)
  } else {
    await nsRes?.body?.cancel()
    problems.push('Namespace parallelism limits could not be listed.')
  }
  return json({ controller: metrics, limits, namespaces, problems })
}

/** Page size when listing schedules, and the most pages read per list (20 000 schedules). */
const MAX_SUSPEND = 500
const MAX_SUSPEND_PAGES = 40

async function suspendAll(ctx: Ctx): Promise<Response> {
  const b = (await readJson(ctx.req)) as { namespaces?: unknown; reason?: unknown }
  const reason = typeof b?.reason === 'string' ? b.reason.trim() : ''
  if (!reason || reason.length > 500) return fail(400, 'invalid', 'reason is required (at most 500 characters): it is recorded on every schedule and in the audit trail.')
  let namespaces: string[] | undefined
  if (b.namespaces !== undefined) {
    if (!Array.isArray(b.namespaces) || !b.namespaces.every(isNamespace) || b.namespaces.length > 200) return fail(400, 'invalid', 'namespaces must be a list of namespace names.')
    namespaces = [...new Set(b.namespaces as string[])]
  }
  const lists = namespaces
    ? namespaces.map((ns) => `/apis/argoproj.io/v1alpha1/namespaces/${ns}/cronworkflows`)
    : ['/apis/argoproj.io/v1alpha1/cronworkflows']
  const crons: Array<{ ns: string; name: string; suspended: boolean }> = []
  for (const path of lists) {
    // Every page: an incident switch that silently skips the schedules past
    // the first page is worse than none.
    let cont: string | undefined
    let pages = 0
    do {
      const res = await ctx.deps.k8s(ctx.id, path, { search: qs({ limit: String(MAX_SUSPEND), ...(cont ? { continue: cont } : {}) }) })
      if (!res.ok) {
        await res.body?.cancel()
        if (res.status === 401 || res.status === 403) return fail(403, 'forbidden', `Listing schedules needs list cronworkflows.argoproj.io (${path}).`)
        return fail(502, 'upstream_error', `Listing schedules answered HTTP ${res.status}.`)
      }
      const page = (await res.json()) as { items?: Array<{ metadata?: { name?: string; namespace?: string }; spec?: { suspend?: boolean } }>; metadata?: { continue?: string } }
      for (const c of page.items ?? []) if (c.metadata?.name && c.metadata.namespace) crons.push({ ns: c.metadata.namespace, name: c.metadata.name, suspended: c.spec?.suspend === true })
      cont = page.metadata?.continue || undefined
    } while (cont && ++pages < MAX_SUSPEND_PAGES)
  }
  const suspended: string[] = []
  const failed: Array<{ schedule: string; status: number }> = []
  for (const c of crons.filter((x) => !x.suspended)) {
    const res = await ctx.deps.k8s(ctx.id, `/apis/argoproj.io/v1alpha1/namespaces/${c.ns}/cronworkflows/${encodeURIComponent(c.name)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ spec: { suspend: true }, metadata: { annotations: { 'adhar.io/suspended-reason': reason, 'adhar.io/suspended-by': actorLabel(ctx.who) } } }),
    }).catch(() => null)
    await res?.body?.cancel()
    if (res?.ok) suspended.push(`${c.ns}/${c.name}`)
    else failed.push({ schedule: `${c.ns}/${c.name}`, status: res?.status ?? 0 })
  }
  const already = crons.filter((x) => x.suspended).length
  await record(ctx, AUDIT_ACTION['engine.suspend-all'] as string, { id: namespaces?.join(',') || 'all', label: namespaces ? `schedules in ${namespaces.join(', ')}` : 'all schedules' }, {
    reason,
    suspended: suspended.length,
    failed: failed.length,
    alreadySuspended: already,
  }, failed.length && !suspended.length ? 'failure' : 'success')
  return json({ suspended, failed, alreadySuspended: already })
}
