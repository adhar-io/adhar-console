/**
 * Request validators and pure helpers for `/api/workflows/*` (design 0026
 * §6.4). Nothing here does I/O: every value a client sends is checked here
 * before it reaches an SSAR, the API server or argo-server, and every body the
 * BFF sends upstream is BUILT here from validated fields — a client's object is
 * never forwarded, so a key the BFF does not know (`serviceAccount`,
 * `fieldSelector`, `namespace`) cannot ride along.
 */

/* ─────────────────────────── names ─────────────────────────── */

/** A namespace: a DNS-1123 label. */
export const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
/** A Workflow name: a DNS-1123 subdomain. */
export const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
/** An archived workflow's uid. */
export const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A node id (`<workflow>-<fnv32a>`, or the workflow name for the root). */
export const NODE_ID = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
/** An artifact name. No `/`, so it cannot climb out of `outputs/`. */
const ARTIFACT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}$/
/** A parameter name, as Argo accepts them. */
const PARAM_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
/** A label value (submitter slug, template name). */
const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/

export const PHASES = ['Pending', 'Running', 'Succeeded', 'Failed', 'Error'] as const
export type Phase = typeof PHASES[number]

export const CONTAINERS = ['main', 'wait', 'init'] as const

export type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string }
const bad = <T>(detail: string): Parsed<T> => ({ ok: false, detail })
const good = <T>(value: T): Parsed<T> => ({ ok: true, value })

export const isNamespace = (s: unknown): s is string => typeof s === 'string' && NAMESPACE.test(s)
export const isName = (s: unknown): s is string => typeof s === 'string' && NAME.test(s)
export const isUid = (s: unknown): s is string => typeof s === 'string' && UID.test(s)
export const isNodeId = (s: unknown): s is string => typeof s === 'string' && NODE_ID.test(s)
export const isArtifactName = (s: unknown): s is string => typeof s === 'string' && ARTIFACT.test(s) && s !== '.' && s !== '..'

/* ─────────────────────────── routes ─────────────────────────── */

/**
 * Every route this BFF serves, as a discriminated union. The route table in
 * `authz.ts` maps each `op` to exactly one authorization question.
 */
export type Route =
  | { op: 'capabilities' }
  | { op: 'run.get'; namespace: string; name: string }
  | { op: 'run.retry'; namespace: string; name: string }
  | { op: 'run.resubmit'; namespace: string; name: string }
  | { op: 'run.approve'; namespace: string; name: string }
  | { op: 'run.logs'; namespace: string; name: string }
  | { op: 'run.artifact'; namespace: string; name: string; nodeId: string; artifact: string }
  | { op: 'archive.list'; namespace: string }
  | { op: 'archive.get'; namespace: string; uid: string }
  | { op: 'archive.retry'; namespace: string; uid: string }
  | { op: 'archive.resubmit'; namespace: string; uid: string }
  | { op: 'archive.delete'; namespace: string; uid: string }
  | { op: 'lint' }
  | { op: 'engine.get' }
  | { op: 'engine.suspend-all' }

export type RouteOp = Route['op']

export type RouteMatch = { route: Route } | { error: 'not_found' | 'method_not_allowed' | 'invalid_path'; detail: string }

const seg = (s: string): string | null => {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/**
 * `subpath` is everything after `/api/workflows`. Unknown paths are 404; a
 * known path with the wrong method is 405; a malformed name is 400 before any
 * check is asked.
 */
export function matchRoute(method: string, subpath: string): RouteMatch {
  const m = method.toUpperCase()
  const raw = subpath.replace(/^\/+|\/+$/g, '').split('/').filter((p) => p.length > 0)
  const parts: string[] = []
  for (const p of raw) {
    const d = seg(p)
    if (d === null || d.includes('/')) return { error: 'invalid_path', detail: 'The path is not valid.' }
    parts.push(d)
  }
  const want = (ok: string, route: Route): RouteMatch =>
    m === ok ? { route } : { error: 'method_not_allowed', detail: `Use ${ok}.` }
  const ns = (s: string | undefined): s is string => isNamespace(s)
  const invalid = (what: string): RouteMatch => ({ error: 'invalid_path', detail: `${what} is not valid.` })

  const [a, b, c, d, e, f] = parts
  if (a === 'capabilities' && parts.length === 1) return want('GET', { op: 'capabilities' })
  if (a === 'lint' && parts.length === 1) return want('POST', { op: 'lint' })
  if (a === 'engine' && parts.length === 1) return want('GET', { op: 'engine.get' })
  if (a === 'engine' && b === 'schedules' && c === 'suspend-all' && parts.length === 3) return want('POST', { op: 'engine.suspend-all' })

  if (a === 'runs') {
    if (parts.length < 3) return { error: 'not_found', detail: 'Name a run: /runs/<namespace>/<name>.' }
    if (!ns(b)) return invalid('The namespace')
    if (!isName(c)) return invalid('The workflow name')
    const base = { namespace: b, name: c }
    if (parts.length === 3) return want('GET', { op: 'run.get', ...base })
    if (parts.length === 4 && d === 'retry') return want('POST', { op: 'run.retry', ...base })
    if (parts.length === 4 && d === 'resubmit') return want('POST', { op: 'run.resubmit', ...base })
    if (parts.length === 4 && d === 'approve') return want('POST', { op: 'run.approve', ...base })
    if (parts.length === 4 && d === 'logs') return want('GET', { op: 'run.logs', ...base })
    if (parts.length === 6 && d === 'artifacts') {
      if (!isNodeId(e)) return invalid('The node id')
      if (!isArtifactName(f)) return invalid('The artifact name')
      return want('GET', { op: 'run.artifact', ...base, nodeId: e, artifact: f })
    }
    return { error: 'not_found', detail: 'Unknown run action.' }
  }

  if (a === 'archive') {
    if (!ns(b)) return parts.length < 2 ? { error: 'not_found', detail: 'Name a namespace: /archive/<namespace>.' } : invalid('The namespace')
    if (parts.length === 2) return want('GET', { op: 'archive.list', namespace: b })
    if (!isUid(c)) return invalid('The archived workflow uid')
    if (parts.length === 3) {
      if (m === 'GET') return { route: { op: 'archive.get', namespace: b, uid: c } }
      if (m === 'DELETE') return { route: { op: 'archive.delete', namespace: b, uid: c } }
      return { error: 'method_not_allowed', detail: 'Use GET or DELETE.' }
    }
    if (parts.length === 4 && d === 'retry') return want('POST', { op: 'archive.retry', namespace: b, uid: c })
    if (parts.length === 4 && d === 'resubmit') return want('POST', { op: 'archive.resubmit', namespace: b, uid: c })
    return { error: 'not_found', detail: 'Unknown archive action.' }
  }
  return { error: 'not_found', detail: 'Unknown workflows endpoint.' }
}

/* ─────────────────────────── bodies ─────────────────────────── */

const obj = (b: unknown): Record<string, unknown> | null =>
  b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null

const MAX_PARAMS = 100
const MAX_PARAM_VALUE = 64 * 1024

/**
 * Argo's `parameters: ["name=value", …]`. Accepted as that list or as an
 * object `{name: value}`; normalised to the list.
 */
export function parseParameters(v: unknown): Parsed<string[] | undefined> {
  if (v === undefined || v === null) return good(undefined)
  const pairs: Array<[string, unknown]> = Array.isArray(v)
    ? v.map((s) => {
      if (typeof s !== 'string') return ['', s]
      const i = s.indexOf('=')
      return i <= 0 ? ['', s] : [s.slice(0, i), s.slice(i + 1)]
    })
    : obj(v)
    ? Object.entries(v as Record<string, unknown>)
    : [['', v]]
  if (pairs.length > MAX_PARAMS) return bad(`At most ${MAX_PARAMS} parameters.`)
  const out: string[] = []
  for (const [k, val] of pairs) {
    if (!PARAM_NAME.test(k)) return bad('parameters must be "name=value" with a valid parameter name.')
    if (typeof val !== 'string') return bad(`parameter ${k} must be a string.`)
    if (val.length > MAX_PARAM_VALUE) return bad(`parameter ${k} is too long.`)
    out.push(`${k}=${val}`)
  }
  return good(out)
}

const nodeSelector = (nodeId: string) => `id=${nodeId}`

export interface RetryBody {
  restartSuccessful: boolean
  nodeFieldSelector?: string
  parameters?: string[]
}

/**
 * `{restartSuccessful?, nodeId?, nodeFieldSelector?, parameters?}`. A node is
 * named by id only: `nodeFieldSelector` is accepted solely in the form
 * `id=<nodeId>`, because Argo's node selector reads any node field and a
 * wider one ("retry everything with templateName=x") is not what a button
 * means.
 */
export function parseRetry(body: unknown): Parsed<RetryBody> {
  const b = obj(body ?? {})
  if (!b) return bad('Expected a JSON object.')
  if (b.restartSuccessful !== undefined && typeof b.restartSuccessful !== 'boolean') return bad('restartSuccessful must be a boolean.')
  let nodeId: string | undefined
  if (b.nodeId !== undefined) {
    if (!isNodeId(b.nodeId)) return bad('nodeId is not valid.')
    nodeId = b.nodeId
  }
  if (b.nodeFieldSelector !== undefined) {
    const m = typeof b.nodeFieldSelector === 'string' ? /^id=(.+)$/.exec(b.nodeFieldSelector) : null
    if (!m || !isNodeId(m[1])) return bad('nodeFieldSelector must be "id=<nodeId>".')
    if (nodeId && nodeId !== m[1]) return bad('nodeId and nodeFieldSelector disagree.')
    nodeId = m[1]
  }
  const params = parseParameters(b.parameters)
  if (!params.ok) return params
  return good({
    restartSuccessful: b.restartSuccessful === true,
    ...(nodeId ? { nodeFieldSelector: nodeSelector(nodeId) } : {}),
    ...(params.value?.length ? { parameters: params.value } : {}),
  })
}

export interface ResubmitBody {
  memoized: boolean
  parameters?: string[]
}

export function parseResubmit(body: unknown): Parsed<ResubmitBody> {
  const b = obj(body ?? {})
  if (!b) return bad('Expected a JSON object.')
  if (b.memoized !== undefined && typeof b.memoized !== 'boolean') return bad('memoized must be a boolean.')
  const params = parseParameters(b.parameters)
  if (!params.ok) return params
  return good({ memoized: b.memoized === true, ...(params.value?.length ? { parameters: params.value } : {}) })
}

export type Decision = 'approve' | 'reject'
export interface ApproveBody {
  nodeId: string
  decision: Decision
  comment: string
}
const MAX_COMMENT = 2000

export function parseApprove(body: unknown): Parsed<ApproveBody> {
  const b = obj(body)
  if (!b) return bad('Expected a JSON object {nodeId, decision, comment?}.')
  if (!isNodeId(b.nodeId)) return bad('nodeId is missing or not valid.')
  if (b.decision !== 'approve' && b.decision !== 'reject') return bad('decision must be "approve" or "reject".')
  if (b.comment !== undefined && typeof b.comment !== 'string') return bad('comment must be a string.')
  const comment = ((b.comment as string | undefined) ?? '').trim()
  if (comment.length > MAX_COMMENT) return bad(`comment is longer than ${MAX_COMMENT} characters.`)
  return good({ nodeId: b.nodeId, decision: b.decision, comment })
}

/* ─────────────────────────── lint ─────────────────────────── */

export const LINT_KINDS = ['WorkflowTemplate', 'CronWorkflow', 'ClusterWorkflowTemplate', 'Workflow'] as const
export type LintKind = typeof LINT_KINDS[number]

export interface LintRequest {
  kind: LintKind
  /** Absent only for ClusterWorkflowTemplate. */
  namespace?: string
  /** The manifest, with `metadata.namespace` forced to `namespace` (or removed). */
  manifest: Record<string, unknown>
}

/** The argo-server lint call for a request: path and body. */
export function lintCall(r: LintRequest): { path: string; body: Record<string, unknown> } {
  const ns = r.namespace ? encodeURIComponent(r.namespace) : ''
  switch (r.kind) {
    case 'WorkflowTemplate':
      return { path: `/api/v1/workflow-templates/${ns}/lint`, body: { namespace: r.namespace, template: r.manifest } }
    case 'CronWorkflow':
      return { path: `/api/v1/cron-workflows/${ns}/lint`, body: { namespace: r.namespace, cronWorkflow: r.manifest } }
    case 'Workflow':
      return { path: `/api/v1/workflows/${ns}/lint`, body: { namespace: r.namespace, workflow: r.manifest } }
    case 'ClusterWorkflowTemplate':
      return { path: '/api/v1/cluster-workflow-templates/lint', body: { template: r.manifest } }
  }
}

export function parseLint(body: unknown): Parsed<LintRequest> {
  const b = obj(body)
  if (!b) return bad('Expected a JSON object {namespace, kind, manifest}.')
  if (!LINT_KINDS.includes(b.kind as LintKind)) return bad(`kind must be one of ${LINT_KINDS.join(', ')}.`)
  const kind = b.kind as LintKind
  const manifest = obj(b.manifest)
  if (!manifest) return bad('manifest must be an object (the parsed YAML).')
  if (manifest.kind !== undefined && manifest.kind !== kind) return bad(`manifest.kind is ${String(manifest.kind)}, not ${kind}.`)
  const meta = obj(manifest.metadata ?? {})
  if (!meta) return bad('manifest.metadata must be an object.')
  if (kind === 'ClusterWorkflowTemplate') {
    const { namespace: _drop, ...rest } = meta
    return good({ kind, manifest: { ...manifest, kind, metadata: rest } })
  }
  if (!isNamespace(b.namespace)) return bad('namespace is missing or not valid.')
  if (meta.namespace !== undefined && meta.namespace !== b.namespace) {
    return bad(`manifest.metadata.namespace (${String(meta.namespace)}) is not ${b.namespace}.`)
  }
  return good({ kind, namespace: b.namespace, manifest: { ...manifest, kind, metadata: { ...meta, namespace: b.namespace } } })
}

/** The Kubernetes resource a lint kind is about (its `create` is the check). */
export function lintResource(kind: LintKind): string {
  return {
    WorkflowTemplate: 'workflowtemplates',
    CronWorkflow: 'cronworkflows',
    ClusterWorkflowTemplate: 'clusterworkflowtemplates',
    Workflow: 'workflows',
  }[kind]
}

/* ─────────────────────────── archive list ─────────────────────────── */

export interface ArchiveFilters {
  limit: number
  continue?: string
  phase?: Phase
  template?: string
  submitter?: string
  namePrefix?: string
  /** Epoch ms; applied by the BFF to what comes back, never sent upstream. */
  sinceMs?: number
}

const MAX_ARCHIVE_LIMIT = 100

/**
 * The archive filters a caller may set, read from an allow-list. Anything else
 * in the query — above all `fieldSelector`, `listOptions.fieldSelector` and
 * `namespace` (GHSA-q65w-j2vp-47c4) — is never read, so it cannot reach
 * argo-server.
 */
export function parseArchiveFilters(q: URLSearchParams): Parsed<ArchiveFilters> {
  const lim = q.get('limit')
  let limit = 50
  if (lim !== null) {
    const n = Number(lim)
    if (!Number.isInteger(n) || n < 1) return bad('limit must be a positive integer.')
    limit = Math.min(n, MAX_ARCHIVE_LIMIT)
  }
  const out: ArchiveFilters = { limit }
  const cont = q.get('continue')
  if (cont) {
    if (cont.length > 2048 || !/^[A-Za-z0-9+/=_.:-]+$/.test(cont)) return bad('continue is not a valid continuation token.')
    out.continue = cont
  }
  const phase = q.get('phase')
  if (phase) {
    if (!PHASES.includes(phase as Phase)) return bad(`phase must be one of ${PHASES.join(', ')}.`)
    out.phase = phase as Phase
  }
  const template = q.get('template')
  if (template) {
    if (!LABEL_VALUE.test(template)) return bad('template is not a valid template name.')
    out.template = template
  }
  const submitter = q.get('submitter')
  if (submitter) {
    if (!LABEL_VALUE.test(submitter)) return bad('submitter must be a submitter slug (the adhar.io/submitter label).')
    out.submitter = submitter
  }
  const prefix = q.get('namePrefix') ?? q.get('q')
  if (prefix) {
    if (!/^[a-z0-9][-a-z0-9.]{0,62}$/.test(prefix)) return bad('namePrefix is not a valid name prefix.')
    out.namePrefix = prefix
  }
  const since = q.get('since')
  if (since) {
    const t = Date.parse(since)
    if (!Number.isFinite(t)) return bad('since must be an RFC 3339 time.')
    out.sinceMs = t
  }
  return good(out)
}

/** Argo's own labels (F-10) and ours (§4.7). */
export const LABEL = {
  phase: 'workflows.argoproj.io/phase',
  completed: 'workflows.argoproj.io/completed',
  template: 'workflows.argoproj.io/workflow-template',
  clusterTemplate: 'workflows.argoproj.io/cluster-workflow-template',
  cron: 'workflows.argoproj.io/cron-workflow',
  eventBinding: 'workflows.argoproj.io/workflow-event-binding',
  resubmittedFrom: 'workflows.argoproj.io/resubmitted-from-workflow',
  creatorUsername: 'workflows.argoproj.io/creator-preferred-username',
  creatorEmail: 'workflows.argoproj.io/creator-email',
  submitter: 'adhar.io/submitter',
  hasApprovals: 'adhar.io/has-approvals',
} as const
export const ANNOTATION = {
  submittedBy: 'adhar.io/submitted-by',
  podNameFormat: 'workflows.argoproj.io/pod-name-format',
} as const

/**
 * The argo-server query for one namespace's archive. `namespace` is the
 * caller's validated path namespace, always; the label selector is built here
 * from the allow-listed filters; there is no `fieldSelector` in any branch.
 */
export function archiveListQuery(namespace: string, f: ArchiveFilters): URLSearchParams {
  const q = new URLSearchParams()
  q.set('namespace', namespace)
  const labels: string[] = []
  if (f.phase) labels.push(`${LABEL.phase}=${f.phase}`)
  if (f.template) labels.push(`${LABEL.template}=${f.template}`)
  if (f.submitter) labels.push(`${LABEL.submitter}=${f.submitter}`)
  if (labels.length) q.set('listOptions.labelSelector', labels.join(','))
  q.set('listOptions.limit', String(f.limit))
  if (f.continue) q.set('listOptions.continue', f.continue)
  if (f.namePrefix) q.set('namePrefix', f.namePrefix)
  return q
}

/* ─────────────────────────── run shapes ─────────────────────────── */

export interface WfNode {
  id?: string
  name?: string
  displayName?: string
  type?: string
  phase?: string
  message?: string
  templateName?: string
  templateRef?: { name?: string; template?: string; clusterScope?: boolean }
  startedAt?: string
  finishedAt?: string
  inputs?: { parameters?: Array<{ name?: string; value?: string; default?: string }> }
  outputs?: { parameters?: Array<{ name?: string; value?: string; valueFrom?: { supplied?: unknown } }> }
}

export interface WfObject {
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    creationTimestamp?: string
  }
  spec?: Record<string, unknown>
  status?: {
    phase?: string
    startedAt?: string
    finishedAt?: string
    message?: string
    nodes?: Record<string, WfNode>
    compressedNodes?: string
    offloadNodeStatusVersion?: string
  }
}

export interface ArchivedSummary {
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

/** One archived item, reduced to what a history row shows. */
export function summarizeArchived(w: WfObject): ArchivedSummary | null {
  const md = w.metadata ?? {}
  if (!md.uid || !md.name || !md.namespace) return null
  const l = md.labels ?? {}
  const strip = <T extends Record<string, unknown>>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T
  return strip({
    uid: md.uid,
    name: md.name,
    namespace: md.namespace,
    phase: w.status?.phase ?? l[LABEL.phase] ?? 'Unknown',
    startedAt: w.status?.startedAt,
    finishedAt: w.status?.finishedAt,
    message: w.status?.message,
    template: l[LABEL.template],
    clusterTemplate: l[LABEL.clusterTemplate],
    cron: l[LABEL.cron],
    submittedBy: md.annotations?.[ANNOTATION.submittedBy],
    submitter: l[LABEL.submitter],
    resubmittedFrom: l[LABEL.resubmittedFrom],
  })
}

/* ─────────────────────────── compressed nodes ─────────────────────────── */

/**
 * `status.compressedNodes` → `status.nodes` (base64 of gzip of the JSON map,
 * Argo's default above its size threshold — F-8). Returns null when the value
 * is not that (another algorithm, or corrupt); callers then ask argo-server
 * for the hydrated workflow.
 */
export const MAX_INFLATED_NODES_BYTES = 64 * 1024 * 1024

export async function inflateNodes(compressed: string, maxBytes = MAX_INFLATED_NODES_BYTES): Promise<Record<string, WfNode> | null> {
  try {
    const bin = Uint8Array.from(atob(compressed.replace(/\s/g, '')), (c) => c.charCodeAt(0))
    const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))
    // Bounded: `status` has no subresource (F-8), so anyone who may update a
    // Workflow may write its compressedNodes — and a few kilobytes of gzip
    // inflate to gigabytes. The recorder inflates every approval-labelled run
    // in the cluster, so an unbounded inflate is one team's way to stop the
    // console. Argo compresses at about a megabyte; 64 MiB is generous.
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const all = new Uint8Array(size)
    let at = 0
    for (const c of chunks) {
      all.set(c, at)
      at += c.byteLength
    }
    const text = new TextDecoder().decode(all)
    const nodes = JSON.parse(text) as unknown
    return obj(nodes) ? (nodes as Record<string, WfNode>) : null
  } catch {
    return null
  }
}

/** The workflow's nodes, inflating them when compressed. `null`: offloaded or unreadable. */
export async function nodesOf(w: WfObject): Promise<Record<string, WfNode> | null> {
  if (w.status?.nodes) return w.status.nodes
  if (w.status?.compressedNodes) return await inflateNodes(w.status.compressedNodes)
  if (w.status?.offloadNodeStatusVersion) return null
  return {}
}

/* ─────────────────────────── pod names ─────────────────────────── */

/** FNV-1a, 32-bit — Go's `hash/fnv.New32a`, which Argo hashes node names with. */
export function fnv32a(s: string): number {
  let h = 0x811c9dc5
  for (const byte of new TextEncoder().encode(s)) {
    h ^= byte
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const MAX_POD_PREFIX = 253 - 10

/**
 * The pod a node ran in, as Argo v4 names it (`workflow/util/pod_name.go`
 * `GeneratePodName`): the node id for the v1 format; otherwise
 * `<workflow>-<template>-<fnv32a(nodeName)>`, the template omitted for inline
 * templates and the prefix cut to fit. Needed because Loki is keyed by pod
 * name and, after pod clean-up, there is no pod to ask.
 */
export function podNameFor(workflow: string, node: WfNode, format?: string): string | null {
  if (!node.id || !node.name) return null
  if (format === 'v1') return node.id
  if (node.name === workflow) return workflow
  const template = node.templateName || node.templateRef?.template || ''
  let prefix = node.name.includes('.inline') || !template ? workflow : `${workflow}-${template}`
  if (prefix.length > MAX_POD_PREFIX - 1) prefix = prefix.slice(0, MAX_POD_PREFIX - 1)
  return `${prefix}-${fnv32a(node.name)}`
}

/* ─────────────────────────── approvals ─────────────────────────── */

/** What a waiting suspend node asks: its question, who may answer, and how. */
export interface ApprovalAsk {
  nodeId: string
  question?: string
  /** Groups and users; empty = anyone allowed to update the workflow. */
  approvers: string[]
  forbidSelfApproval: boolean
  /** Supplied output parameters the node declares (decision, comment, approver …). */
  outputs: string[]
}

const param = (n: WfNode, name: string) => {
  const p = n.inputs?.parameters?.find((x) => x?.name === name)
  return p?.value ?? p?.default
}

type WfTemplateLike = { name?: string; suspend?: { duration?: unknown } }

/** The template a node ran: a templateRef among status.storedTemplates, else by name in the effective spec. */
function templateOfNode(w: WfObject, node: WfNode): WfTemplateLike | undefined {
  const status = (w.status ?? {}) as { storedTemplates?: Record<string, WfTemplateLike>; storedWorkflowTemplateSpec?: { templates?: WfTemplateLike[] } }
  const ref = node.templateRef
  if (ref?.name && ref.template) {
    const hit = Object.entries(status.storedTemplates ?? {}).sort(([a], [b]) => a.localeCompare(b)).find(([k]) => k.endsWith(`/${ref.name}/${ref.template}`))
    return hit?.[1]
  }
  const templates = status.storedWorkflowTemplateSpec?.templates ?? ((w.spec ?? {}) as { templates?: WfTemplateLike[] }).templates ?? []
  return templates.find((t) => t?.name === node.templateName)
}

/**
 * A timer: a suspend template with a duration that asks nothing — no
 * question/approvers/forbidSelfApproval input and no output waiting to be
 * supplied. It waits for the clock, not a person; "approve" would only cut it
 * short. The UI's isTimerNode (modules/platform/src/workflows/data/nodes.ts)
 * and the CLI's IsTimer (platform/workflows/nodes.go) read it the same way, so
 * no surface offers, accepts or announces a decision on one.
 */
export function isTimerNode(w: WfObject | undefined, node: WfNode): boolean {
  if (!w || node.type !== 'Suspend') return false
  const t = templateOfNode(w, node)
  const d = t?.suspend?.duration
  if (d === undefined || d === null || d === '') return false
  const asks = ['question', 'approvers', 'forbidSelfApproval'].some((k) => node.inputs?.parameters?.some((p) => p?.name === k))
  const supplied = (node.outputs?.parameters ?? []).some((p) => p?.valueFrom && 'supplied' in p.valueFrom)
  return !asks && !supplied
}

/**
 * The approval a node is waiting for, or null when it is not a waiting suspend
 * node. Pass the run so a timer (isTimerNode) is not taken for an approval.
 */
export function approvalOf(node: WfNode | undefined, run?: WfObject): ApprovalAsk | null {
  if (!node?.id || node.type !== 'Suspend' || node.phase !== 'Running') return null
  if (isTimerNode(run, node)) return null
  const approvers = (param(node, 'approvers') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const outputs = (node.outputs?.parameters ?? [])
    .filter((p) => p?.name && p.valueFrom && 'supplied' in p.valueFrom)
    .map((p) => p.name as string)
  return {
    nodeId: node.id,
    question: param(node, 'question'),
    approvers,
    forbidSelfApproval: (param(node, 'forbidSelfApproval') ?? '').toLowerCase() === 'true',
    outputs,
  }
}

/** Every waiting approval in a run (timers excluded when the run is given). */
export function pendingApprovals(nodes: Record<string, WfNode>, run?: WfObject): ApprovalAsk[] {
  return Object.values(nodes).map((n) => approvalOf(n, run)).filter((a): a is ApprovalAsk => a !== null)
}

export interface Approver {
  id: string
  username?: string
  email?: string
  groups?: string[]
}

const OIDC = /^oidc:/i
const norm = (s: string | undefined) => (s ?? '').replace(OIDC, '').trim().toLowerCase()

/** The Kubernetes name of the console's argo-server identity (design §4.4). */
export const CONSOLE_ARGO_USER = 'system:serviceaccount:adhar-system:adhar-console-argo'

/** `s` without the API server's user prefix (`oidc:` and the configured one), lower-cased. */
function normUser(s: string | undefined, prefix: string): string {
  let v = (s ?? '').trim()
  if (prefix && v.toLowerCase().startsWith(prefix.toLowerCase())) v = v.slice(prefix.length)
  return norm(v)
}

/** True when `who` is one of `approvers` by group, username or email. Empty list = anyone. */
export function isEligibleApprover(ask: ApprovalAsk, who: Approver): boolean {
  if (ask.approvers.length === 0) return true
  const names = new Set([norm(who.username), norm(who.email), norm(who.id)].filter(Boolean))
  // A Keycloak full-path group ("/ops") is the group "ops", as the UI reads it.
  const groups = new Set((who.groups ?? []).map((g) => norm(g.replace(/^\//, ''))).filter(Boolean))
  return ask.approvers.some((a) => {
    const n = norm(a.replace(/^(group|user):/i, '').replace(/^\//, ''))
    if (/^group:/i.test(a)) return groups.has(n)
    if (/^user:/i.test(a)) return names.has(n)
    return groups.has(n) || names.has(n)
  })
}

/**
 * Who submitted the run: `adhar.io/submitted-by` (Kyverno, from the API
 * server's view of the requester), else Argo's creator labels. Undefined when
 * neither is there.
 */
export function submitterOf(w: WfObject): string | undefined {
  const md = w.metadata ?? {}
  return md.annotations?.[ANNOTATION.submittedBy] || md.labels?.[LABEL.creatorUsername] || md.labels?.[LABEL.creatorEmail] || undefined
}

export type ApprovalVerdict =
  | { ok: true }
  | { ok: false; status: 403 | 409; error: string; detail: string }

/**
 * The approver policy (design 0026 §6.4): an eligible approver, and — when
 * the node forbids self-approval — not the submitter. A run whose submitter
 * cannot be read is refused rather than assumed to be someone else's.
 */
export function decideApproval(ask: ApprovalAsk, who: Approver, submitter: string | undefined, userPrefix = 'oidc:'): ApprovalVerdict {
  if (!isEligibleApprover(ask, who)) {
    return { ok: false, status: 403, error: 'not_an_approver', detail: `Only ${ask.approvers.join(', ')} may decide this approval.` }
  }
  if (ask.forbidSelfApproval) {
    // The console's own argo-server identity is not a person: a run that still
    // names it (its submitter restore failed) has an unknown submitter.
    if (!submitter || submitter.trim().toLowerCase() === CONSOLE_ARGO_USER) {
      return { ok: false, status: 409, error: 'submitter_unknown', detail: 'This approval forbids self-approval, and the run does not record who submitted it, so the console cannot tell you apart.' }
    }
    // The API server's user prefix is configurable (K8S_IMPERSONATE_USER_PREFIX,
    // --oidc-username-prefix); a prefix left on would make the submitter look
    // like someone else and let them approve their own run.
    const s = normUser(submitter, userPrefix)
    if ([who.username, who.email, who.id].some((x) => x && norm(x) === s)) {
      return { ok: false, status: 403, error: 'self_approval_forbidden', detail: 'You submitted this run, and its approval forbids self-approval. Ask another approver.' }
    }
  }
  return { ok: true }
}

/** The label a person is recorded under: their username, else email, else id. */
export function actorLabel(who: Approver): string {
  return who.username || who.email || who.id
}

/**
 * The argo-server `set` body for a decision. Only output parameters the node
 * declares as supplied are set (Argo refuses any other); a node with no
 * `decision` output cannot express "reject" as a value, so a reject there marks
 * the node Failed — the plain `suspend: {}` case.
 */
export function setBody(
  namespace: string,
  name: string,
  ask: ApprovalAsk,
  d: ApproveBody,
  approver: string,
): { body: Record<string, unknown>; resume: boolean } {
  const values: Record<string, string> = { decision: d.decision, comment: d.comment, approver }
  const outputs = Object.fromEntries(Object.entries(values).filter(([k]) => ask.outputs.includes(k)))
  const message = `${d.decision === 'approve' ? 'Approved' : 'Rejected'} by ${approver} via Adhar console${d.comment ? `: ${d.comment}` : ''}`
  const body: Record<string, unknown> = { name, namespace, nodeFieldSelector: nodeSelector(ask.nodeId), message }
  if (Object.keys(outputs).length) body.outputParameters = JSON.stringify(outputs)
  const canSayReject = ask.outputs.includes('decision')
  if (d.decision === 'reject' && !canSayReject) {
    body.phase = 'Failed'
    return { body, resume: false }
  }
  return { body, resume: true }
}

/* ─────────────────────────── misc ─────────────────────────── */

/**
 * The Kubernetes user name the API server gives a console user (the same
 * prefix the gateway impersonates with), which is what Kyverno records in
 * `adhar.io/submitted-by`.
 */
export function kubeUsername(who: Approver, prefix = 'oidc:', claim = 'preferred_username'): string {
  // The same choice as the gateway's impersonated user (k8s/gateway.ts
  // impersonatedUser): the restored submitter must be the name the API server
  // would have authenticated, or separation of duties compares two spellings.
  const c = claim.toLowerCase()
  const raw = c === 'sub' ? who.id : c === 'email' ? (who.email || who.id) : (who.username || who.email || who.id)
  return `${prefix}${raw}`
}

/**
 * The `adhar.io/submitter` label for a Kubernetes user name — the value
 * Kyverno's adhar-workflow-provenance computes:
 * `trim(truncate(trim(regex_replace_all('[^a-z0-9._-]+', to_lower(u), '-'), '-._'), 63), '-._')`.
 */
export function submitterSlug(user: string): string {
  const trimSet = (s: string) => s.replace(/^[-._]+|[-._]+$/g, '')
  return trimSet(trimSet(user.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')).slice(0, 63))
}

/** Drop any key a client might use to choose a run's identity. Defence in depth: bodies are built, not forwarded. */
export function stripIdentityKeys<T extends Record<string, unknown>>(body: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (k === 'serviceAccount' || k === 'serviceAccountName') continue
    if (k === 'submitOptions' && obj(v)) {
      out[k] = stripIdentityKeys(v as Record<string, unknown>)
      continue
    }
    out[k] = v
  }
  return out as T
}

/** Epoch ms of an RFC 3339 time, or undefined. */
export function ms(t: string | undefined): number | undefined {
  if (!t) return undefined
  const v = Date.parse(t)
  return Number.isFinite(v) ? v : undefined
}
