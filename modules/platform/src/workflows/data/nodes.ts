import type { StatusKind } from '@adhar/shell-ui'
import { ANNOTATION, LABEL } from './gvr.ts'

/**
 * A Workflow's run, read for the console (design 0026 §6.3): node status
 * inflated from `status.compressedNodes` in the browser (F-8), phases mapped to
 * the console's `StatusKind`, and the run graph — one node per task of the
 * entry template, with retries and fan-outs folded into the task they belong
 * to. Pure: no React, no network; `nodes_test.ts` holds it.
 */

/* ─────────────────────────── shapes ─────────────────────────── */

export interface WfParam {
  name: string
  value?: string
  default?: string
  enum?: string[]
  description?: string
  valueFrom?: Record<string, unknown>
}

export interface WfArtifact {
  name: string
  path?: string
  s3?: unknown
  [k: string]: unknown
}

export interface WfNode {
  id: string
  name: string
  displayName?: string
  type?: string
  templateName?: string
  templateRef?: { name?: string; template?: string; clusterScope?: boolean }
  phase?: string
  boundaryID?: string
  message?: string
  startedAt?: string
  finishedAt?: string
  progress?: string
  children?: string[]
  outboundNodes?: string[]
  hostNodeName?: string
  inputs?: { parameters?: WfParam[]; artifacts?: WfArtifact[] }
  outputs?: { parameters?: Array<WfParam & { valueFrom?: { supplied?: unknown } & Record<string, unknown> }>; artifacts?: WfArtifact[]; exitCode?: string; result?: string }
  resourcesDuration?: Record<string, number>
}

export interface WfTask {
  name: string
  template?: string
  templateRef?: { name?: string; template?: string; clusterScope?: boolean }
  depends?: string
  dependencies?: string[]
  when?: string
  withItems?: unknown[]
  withParam?: string
  withSequence?: unknown
  hooks?: Record<string, unknown>
  continueOn?: unknown
  arguments?: unknown
}

export interface WfTemplate {
  name: string
  dag?: { tasks?: WfTask[] }
  steps?: Array<Array<WfTask>>
  container?: { image?: string; [k: string]: unknown }
  script?: { image?: string; [k: string]: unknown }
  resource?: { action?: string; [k: string]: unknown }
  http?: { url?: string; method?: string; [k: string]: unknown }
  suspend?: { duration?: string }
  inputs?: { parameters?: WfParam[] }
  [k: string]: unknown
}

export interface WfSpec {
  entrypoint?: string
  templates?: WfTemplate[]
  arguments?: { parameters?: WfParam[]; artifacts?: unknown[] }
  workflowTemplateRef?: { name: string; clusterScope?: boolean }
  onExit?: string
  shutdown?: 'Stop' | 'Terminate'
  suspend?: boolean
  serviceAccountName?: string
  priority?: number
  [k: string]: unknown
}

export interface Workflow {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    generateName?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    resourceVersion?: string
  }
  spec?: WfSpec
  status?: {
    phase?: string
    message?: string
    startedAt?: string
    finishedAt?: string
    progress?: string
    nodes?: Record<string, WfNode>
    compressedNodes?: string
    offloadNodeStatusVersion?: string
    storedWorkflowTemplateSpec?: WfSpec
    storedTemplates?: Record<string, WfTemplate>
    conditions?: Array<{ type?: string; status?: string; message?: string }>
    estimatedDuration?: number
  }
}

/* ─────────────────────────── compressed nodes (F-8) ─────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * The most a run's node map may inflate to in the browser (the BFF's own cap,
 * `MAX_INFLATED_NODES_BYTES`). The Workflow CRD has no status subresource, so
 * anyone who may `update` a Workflow can write its `compressedNodes` — and a
 * few kilobytes of gzip inflate to gigabytes. The overview inflates every
 * unfinished run in scope to find approvals, so an unbounded inflate would let
 * one person freeze the tab of everyone who looks at their namespace.
 */
export const MAX_INFLATED_NODES_BYTES = 64 * 1024 * 1024

/**
 * `status.compressedNodes` → the node map. Argo v4.1 stores base64 of the gzip
 * of the JSON map when the status is large. Returns null for anything else
 * (another algorithm, corrupt, or larger than `maxBytes` once inflated): the
 * caller then asks the BFF for the run as argo-server hydrates it.
 */
export async function inflateNodes(compressed: string, maxBytes = MAX_INFLATED_NODES_BYTES): Promise<Record<string, WfNode> | null> {
  try {
    const bin = Uint8Array.from(atob(compressed.replace(/\s/g, '')), (c) => c.charCodeAt(0))
    const reader = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip')).getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    const all = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      all.set(c, at)
      at += c.byteLength
    }
    const parsed = JSON.parse(new TextDecoder().decode(all)) as unknown
    return isObj(parsed) ? (parsed as Record<string, WfNode>) : null
  } catch {
    return null
  }
}

export type NodesState =
  | { state: 'ready'; nodes: Record<string, WfNode> }
  /** Offloaded to the archive DB, or compressed in a form the browser cannot read. */
  | { state: 'hydrate' }

/** The run's nodes as the browser can read them, or a request to hydrate through the BFF. */
export async function readNodes(w: Workflow): Promise<NodesState> {
  const st = w.status
  if (st?.nodes) return { state: 'ready', nodes: st.nodes }
  if (st?.compressedNodes) {
    const nodes = await inflateNodes(st.compressedNodes)
    return nodes ? { state: 'ready', nodes } : { state: 'hydrate' }
  }
  if (st?.offloadNodeStatusVersion) return { state: 'hydrate' }
  return { state: 'ready', nodes: {} }
}

/* ─────────────────────────── phases ─────────────────────────── */

/**
 * Phase → StatusKind (§6.3): Pending and Running are progressing (Pending is
 * drawn dimmed), Succeeded healthy, Failed and Error failed, Skipped and
 * Omitted unknown, a suspend node that is waiting paused.
 */
export function nodeStatus(phase: string | undefined, type?: string): StatusKind {
  if (type === 'Suspend' && phase === 'Running') return 'paused'
  switch (phase) {
    case 'Pending':
    case 'Running':
      return 'progressing'
    case 'Succeeded':
      return 'healthy'
    case 'Failed':
    case 'Error':
      return 'failed'
    default:
      return 'unknown'
  }
}

/** A whole run's StatusKind: a workflow-level suspend reads paused while it runs. */
export function runStatus(w: Workflow): StatusKind {
  const phase = runPhase(w)
  if ((phase === 'Running' || phase === 'Pending') && w.spec?.suspend) return 'paused'
  return nodeStatus(phase)
}

/** The run's phase; a Workflow the controller has not reconciled yet has none, and reads Pending. */
export function runPhase(w: Workflow): string {
  return w.status?.phase || w.metadata.labels?.[LABEL.phase] || 'Pending'
}

export const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Error'])

export function isFinished(w: Workflow): boolean {
  return TERMINAL_PHASES.has(runPhase(w)) || w.metadata.labels?.[LABEL.completed] === 'true'
}

export function phaseLabel(w: Workflow): string {
  const phase = runPhase(w)
  if (!isFinished(w) && w.spec?.suspend) return 'Suspended'
  if (!isFinished(w) && w.spec?.shutdown) return `${w.spec.shutdown === 'Stop' ? 'Stopping' : 'Terminating'}`
  return phase
}

/* ─────────────────────────── durations ─────────────────────────── */

export function msOf(t: string | undefined): number | undefined {
  if (!t) return undefined
  const v = Date.parse(t)
  return Number.isFinite(v) ? v : undefined
}

/** Elapsed time of a node or run: start → finish, or start → now while running. */
export function elapsedMs(startedAt: string | undefined, finishedAt: string | undefined, now: number): number | undefined {
  const s = msOf(startedAt)
  if (s === undefined) return undefined
  const f = msOf(finishedAt) ?? now
  return Math.max(0, f - s)
}

/** `Xh Ym`, `Ym Zs`, `Zs`: the run-card footer and tables. */
export function shortDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** `status.progress` (`"3/7"`) as numbers; undefined when absent or malformed. */
export function progressOf(p: string | undefined): { done: number; total: number } | undefined {
  const m = p ? /^(\d+)\/(\d+)$/.exec(p) : null
  return m ? { done: Number(m[1]), total: Number(m[2]) } : undefined
}

/* ─────────────────────────── run metadata ─────────────────────────── */

export type Trigger = 'manual' | 'cron' | 'event' | 'resubmit'

/** How a run was started, from Argo's own labels (F-10). */
export function triggerOf(w: Workflow): { kind: Trigger; detail?: string } {
  const l = w.metadata.labels ?? {}
  if (l[LABEL.cron]) return { kind: 'cron', detail: l[LABEL.cron] }
  if (l[LABEL.eventBinding]) return { kind: 'event', detail: l[LABEL.eventBinding] }
  if (l[LABEL.resubmittedFrom]) return { kind: 'resubmit', detail: l[LABEL.resubmittedFrom] }
  return { kind: 'manual' }
}

/** The template a run came from: `{kind, name}` or undefined for an inline run. */
export function templateOf(w: Workflow): { cluster: boolean; name: string } | undefined {
  const ref = w.spec?.workflowTemplateRef
  if (ref?.name) return { cluster: Boolean(ref.clusterScope), name: ref.name }
  const l = w.metadata.labels ?? {}
  if (l[LABEL.template]) return { cluster: false, name: l[LABEL.template] }
  if (l[LABEL.clusterTemplate]) return { cluster: true, name: l[LABEL.clusterTemplate] }
  return undefined
}

/**
 * The `adhar.io/submitter` label for a Kubernetes user name, exactly as
 * Kyverno's adhar-workflow-provenance computes it from
 * `request.userInfo.username` — which carries the API server's `oidc:` prefix —
 * and as the BFF restores it (server/workflows/model.ts submitterSlug):
 * `trim(truncate(trim(regex_replace_all('[^a-z0-9._-]+', to_lower(u), '-'), '-._'), 63), '-._')`.
 */
export function submitterSlug(user: string): string {
  const trimSet = (s: string) => s.replace(/^[-._]+|[-._]+$/g, '')
  return trimSet(trimSet(user.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')).slice(0, 63))
}

/** Who submitted the run: Kyverno's `adhar.io/submitted-by`, else Argo's creator labels. */
export function submitterOf(w: Workflow): string | undefined {
  const md = w.metadata
  return md.annotations?.[ANNOTATION.submittedBy] || md.labels?.[LABEL.creatorUsername] || md.labels?.[LABEL.creatorEmail] || undefined
}

/**
 * Is `w` the run at `namespace/name`? The run view keeps the previous answer
 * on screen only while it is the SAME run being re-read: across runs a kept
 * answer would put run A's header, graph and — worst — its Stop and Delete
 * buttons under run B's title until B loads.
 */
export function isRun(w: Workflow | null | undefined, namespace: string | undefined, name: string | undefined): w is Workflow {
  return Boolean(w && namespace && name && w.metadata.namespace === namespace && w.metadata.name === name)
}

/** The spec the run executes: the template it references, as the controller stored it, else its own. */
export function effectiveSpec(w: Workflow): WfSpec {
  const stored = w.status?.storedWorkflowTemplateSpec
  const own = w.spec ?? {}
  if (!stored) return own
  return { ...stored, ...Object.fromEntries(Object.entries(own).filter(([k]) => k !== 'workflowTemplateRef')), templates: stored.templates ?? own.templates }
}

/** A template by name, in the spec or among the templates the controller stored for refs. */
export function findTemplate(w: Workflow, name: string | undefined, ref?: WfTask['templateRef']): WfTemplate | undefined {
  const spec = effectiveSpec(w)
  if (ref?.name && ref.template) {
    const stored = w.status?.storedTemplates ?? {}
    const hit = Object.entries(stored).find(([k]) => k.endsWith(`/${ref.name}/${ref.template}`))
    return hit?.[1]
  }
  return spec.templates?.find((t) => t.name === name)
}

/* ─────────────────────────── depends ─────────────────────────── */

export type EdgeCondition = 'Succeeded' | 'Failed' | 'Errored' | 'Skipped' | 'Omitted' | 'Daemoned' | 'AnySucceeded' | 'AllFailed' | 'Expression'

const CONDITIONS = new Set(['Succeeded', 'Failed', 'Errored', 'Skipped', 'Omitted', 'Daemoned', 'AnySucceeded', 'AllFailed'])

/**
 * The edges into one task: `depends` read as Argo writes it. A pure `&&` of
 * single terms gives one edge per term with its condition (a bare name is
 * Succeeded); anything else — `||`, `!`, parentheses — gives an Expression
 * edge to every task it names. Legacy `dependencies` are Succeeded edges.
 */
export function dependsEdges(task: WfTask, taskNames: ReadonlySet<string>): Array<{ source: string; condition: EdgeCondition }> {
  if (task.depends?.trim()) {
    const expr = task.depends.trim()
    const pure = !/\|\||!|\(|\)/.test(expr)
    const out: Array<{ source: string; condition: EdgeCondition }> = []
    const seen = new Set<string>()
    for (const m of expr.matchAll(/([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\.([A-Za-z]+))?/g)) {
      const name = m[1]
      if (!taskNames.has(name) || seen.has(name)) continue
      seen.add(name)
      const cond = m[2] && CONDITIONS.has(m[2]) ? (m[2] as EdgeCondition) : 'Succeeded'
      out.push({ source: name, condition: pure ? cond : 'Expression' })
    }
    return out
  }
  return (task.dependencies ?? []).filter((d) => taskNames.has(d)).map((source) => ({ source, condition: 'Succeeded' as const }))
}

/* ─────────────────────────── run graph ─────────────────────────── */

export type RunNodeKind = 'container' | 'script' | 'resource' | 'http' | 'suspend' | 'approval' | 'template' | 'group' | 'step' | 'exit'

export interface RunGraphNode {
  /** The task (or step) name; unique within the graph. */
  id: string
  label: string
  /** The status node this task resolved to (absent until the controller reaches it). */
  nodeId?: string
  kind: RunNodeKind
  subtitle?: string
  phase?: string
  status: StatusKind
  /** Not started yet (Pending or not in status): drawn dimmed. */
  dim: boolean
  message?: string
  startedAt?: string
  finishedAt?: string
  attempts?: number
  fanOut?: { total: number; succeeded: number; failed: number; running: number }
  /** A nested DAG or steps template: how many child nodes it has run. */
  children?: number
  when?: string
  awaitingApproval: boolean
  lane: 'main' | 'exit'
}

export type EdgeState = 'done' | 'active' | 'ahead' | 'broken'

export interface RunGraphEdge {
  id: string
  source: string
  target: string
  condition: EdgeCondition
  state: EdgeState
}

export interface RunGraph {
  nodes: RunGraphNode[]
  edges: RunGraphEdge[]
  /** The graph came from the template (`spec`) or, without one, from status alone. */
  source: 'template' | 'status' | 'empty'
  /** Steps templates draw columns (one per parallel group); DAGs draw layers. */
  shape: 'dag' | 'steps' | 'flat'
}

function kindOfTemplate(t: WfTemplate | undefined, task: WfTask): RunNodeKind {
  if (task.templateRef) return task.templateRef.template === 'approval' ? 'approval' : 'template'
  if (!t) return 'template'
  if (t.container) return 'container'
  if (t.script) return 'script'
  if (t.resource) return 'resource'
  if (t.http) return 'http'
  if (t.suspend) return 'suspend'
  if (t.dag || t.steps) return 'group'
  return 'template'
}

function subtitleOf(t: WfTemplate | undefined, task: WfTask): string | undefined {
  if (task.templateRef?.name) return `${task.templateRef.name}/${task.templateRef.template ?? ''}`
  const img = t?.container?.image ?? t?.script?.image
  if (typeof img === 'string') return img.split('/').pop()
  if (t?.resource?.action) return `resource: ${t.resource.action}`
  if (t?.http?.url) return `${t.http.method ?? 'GET'} ${t.http.url}`
  if (t?.suspend) return t.suspend.duration ? `wait ${t.suspend.duration}` : 'suspend'
  return task.template
}

/**
 * A waiting TIMER (§6.6: `suspend: {duration}`) is a Suspend node too, but it
 * resumes on its own and nobody is asked anything: one with no question, no
 * approvers and no supplied outputs is not an approval (it would otherwise sit
 * in everyone's "Approvals for me", and "Approve" would only cut the wait
 * short). A hand-written `suspend: {}` with no duration still is one.
 */
export function isTimerNode(w: Workflow, n: WfNode): boolean {
  if (n.type !== 'Suspend') return false
  const t = findTemplate(w, n.templateName, n.templateRef)
  if (!t?.suspend?.duration) return false
  const asks = ['question', 'approvers', 'forbidSelfApproval'].some((k) => n.inputs?.parameters?.some((p) => p?.name === k))
  const supplied = (n.outputs?.parameters ?? []).some((p) => p?.valueFrom && 'supplied' in p.valueFrom)
  return !asks && !supplied
}

/** Is this node a waiting approval (a running suspend node that is not a timer)? */
export function isAwaitingInput(n: WfNode | undefined, w?: Workflow): boolean {
  return Boolean(n && n.type === 'Suspend' && n.phase === 'Running' && !(w && isTimerNode(w, n)))
}

/** Every node id under `rootId` (the root included). */
export function subtree(nodes: Record<string, WfNode>, rootId: string): Set<string> {
  const out = new Set<string>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id) || !nodes[id]) continue
    out.add(id)
    stack.push(...(nodes[id].children ?? []))
  }
  return out
}

function summarize(w: Workflow, id: string, task: WfTask, status: WfNode | undefined, nodes: Record<string, WfNode>, template: WfTemplate | undefined, lane: 'main' | 'exit'): RunGraphNode {
  const phase = status?.phase
  const kind = kindOfTemplate(template, task)
  const node: RunGraphNode = {
    id,
    label: task.name,
    nodeId: status?.id,
    kind,
    subtitle: subtitleOf(template, task),
    phase,
    status: status ? nodeStatus(phase, status.type) : 'unknown',
    dim: !status || phase === 'Pending',
    message: status?.message,
    startedAt: status?.startedAt,
    finishedAt: status?.finishedAt,
    when: task.when,
    awaitingApproval: isAwaitingInput(status, w),
    lane,
  }
  if (!status) return node
  const kids = (status.children ?? []).map((c) => nodes[c]).filter(Boolean)
  if (status.type === 'Retry') {
    node.attempts = kids.length
    // A retried suspend is still a suspend: look through to the attempt.
    node.awaitingApproval = kids.some((k) => isAwaitingInput(k, w))
    if (node.awaitingApproval) node.status = 'paused'
  } else if (status.type === 'TaskGroup' || task.withItems || task.withParam || task.withSequence) {
    const items = status.type === 'TaskGroup' ? kids : []
    node.fanOut = {
      total: items.length,
      succeeded: items.filter((k) => k.phase === 'Succeeded').length,
      failed: items.filter((k) => k.phase === 'Failed' || k.phase === 'Error').length,
      running: items.filter((k) => k.phase === 'Running' || k.phase === 'Pending').length,
    }
  } else if (status.type === 'DAG' || status.type === 'Steps') {
    node.kind = 'group'
    node.children = subtree(nodes, status.id).size - 1
    node.awaitingApproval = [...subtree(nodes, status.id)].some((k) => isAwaitingInput(nodes[k], w))
    if (node.awaitingApproval && node.status === 'progressing') node.status = 'paused'
  }
  return node
}

function edgeState(source: RunGraphNode | undefined, target: RunGraphNode | undefined, condition: EdgeCondition): EdgeState {
  if (!source || !target) return 'ahead'
  if (source.status === 'failed' && (condition === 'Succeeded' || condition === 'AnySucceeded')) return 'broken'
  if (!target.dim && (target.status === 'progressing' || target.status === 'paused')) return 'active'
  if (!target.dim) return target.status === 'failed' && condition === 'Expression' ? 'broken' : 'done'
  return 'ahead'
}

/**
 * The run graph of a Workflow and its (inflated) nodes.
 *
 * Tasks come from the entry template — the run's own spec or the template it
 * references as the controller stored it — and each is matched to its status
 * node by display name inside the entry node's boundary. Retries become one
 * node with an attempt count; `withItems`/`withParam` fan-outs one node "×N";
 * a nested DAG a collapsed group. `onExit` is a separate lane. Without a spec,
 * the graph is built from status alone (each top-level node, children edges).
 */
export function runGraph(w: Workflow, nodes: Record<string, WfNode>): RunGraph {
  const spec = effectiveSpec(w)
  const entryName = spec.entrypoint
  const entry = spec.templates?.find((t) => t.name === entryName)
  const root = nodes[w.metadata.name] ?? Object.values(nodes).find((n) => n.name === w.metadata.name)
  const byTask = (boundary: string | undefined, name: string): WfNode | undefined =>
    Object.values(nodes).find((n) => n.displayName === name && (boundary === undefined || n.boundaryID === boundary) && n.type !== 'StepGroup')

  const out: RunGraph = { nodes: [], edges: [], source: 'template', shape: 'dag' }
  if (entry?.dag?.tasks?.length) {
    const tasks = entry.dag.tasks
    const names = new Set(tasks.map((t) => t.name))
    for (const t of tasks) {
      out.nodes.push(summarize(w, t.name, t, byTask(root?.id, t.name), nodes, findTemplate(w, t.template, t.templateRef), 'main'))
    }
    const byId = new Map(out.nodes.map((n) => [n.id, n]))
    for (const t of tasks) {
      for (const d of dependsEdges(t, names)) {
        out.edges.push({ id: `${d.source}->${t.name}`, source: d.source, target: t.name, condition: d.condition, state: edgeState(byId.get(d.source), byId.get(t.name), d.condition) })
      }
    }
  } else if (entry?.steps?.length) {
    out.shape = 'steps'
    let prev: string[] = []
    entry.steps.forEach((group, gi) => {
      const ids: string[] = []
      for (const s of group ?? []) {
        const id = out.nodes.some((n) => n.id === s.name) ? `${s.name}#${gi}` : s.name
        out.nodes.push(summarize(w, id, s, byTask(undefined, s.name), nodes, findTemplate(w, s.template, s.templateRef), 'main'))
        ids.push(id)
      }
      const byId = new Map(out.nodes.map((n) => [n.id, n]))
      for (const a of prev) for (const b of ids) out.edges.push({ id: `${a}->${b}`, source: a, target: b, condition: 'Succeeded', state: edgeState(byId.get(a), byId.get(b), 'Succeeded') })
      prev = ids
    })
  } else if (root || Object.keys(nodes).length) {
    // No template to read (a run whose spec is gone, or a leaf entry): what status says.
    out.source = Object.keys(nodes).length ? 'status' : 'empty'
    out.shape = 'flat'
    const top = Object.values(nodes).filter((n) => n.id !== root?.id && (root ? n.boundaryID === root.id : true) && n.type !== 'StepGroup' && !n.name.endsWith('.onExit') && !/\(\d+(:.*)?\)$/.test(n.displayName ?? ''))
    if (!top.length && root) top.push(root)
    const ids = new Set(top.map((n) => n.id))
    // Graph ids must be unique (React Flow keys cards by them): two status
    // nodes with one display name — a step name reused across groups — get
    // the status node id as a suffix rather than collapsing into one card.
    const label = new Map<string, string>()
    const used = new Set<string>()
    for (const n of top) {
      const base = n.displayName ?? n.id
      const gid = used.has(base) ? `${base}#${n.id}` : base
      used.add(gid)
      label.set(n.id, gid)
      out.nodes.push(summarize(w, gid, { name: n.displayName ?? n.name, template: n.templateName, templateRef: n.templateRef }, n, nodes, findTemplate(w, n.templateName, n.templateRef), 'main'))
    }
    const byId = new Map(out.nodes.map((n) => [n.id, n]))
    for (const n of top) {
      // Through retry attempts and fan-out items to the next visible node.
      const next = new Set<string>()
      const stack = [...(n.children ?? [])]
      const seen = new Set<string>()
      while (stack.length) {
        const c = stack.pop()!
        if (seen.has(c)) continue
        seen.add(c)
        if (ids.has(c)) next.add(c)
        else stack.push(...(nodes[c]?.children ?? []))
      }
      for (const c of next) {
        const s = label.get(n.id)!, t = label.get(c)!
        if (s !== t) out.edges.push({ id: `${s}->${t}`, source: s, target: t, condition: 'Succeeded', state: edgeState(byId.get(s), byId.get(t), 'Succeeded') })
      }
    }
  } else {
    out.source = 'empty'
    out.shape = 'flat'
  }

  // The exit handler: one node in its own lane.
  const exitNode = Object.values(nodes).find((n) => n.name === `${w.metadata.name}.onExit`)
  if (spec.onExit || exitNode) {
    const t: WfTask = { name: 'onExit', template: spec.onExit ?? exitNode?.templateName }
    const n = summarize(w, 'onExit', t, exitNode, nodes, findTemplate(w, t.template), 'exit')
    n.kind = 'exit'
    n.label = 'Exit handler'
    n.subtitle = t.template
    out.nodes.push(n)
  }
  return out
}

/* ─────────────────────────── node lookups for the run view ─────────────────────────── */

/**
 * The step whose logs the Logs tab shows: the one the person picked while it
 * still exists, else the one the graph has selected (or the first pod under
 * it), else the newest pod. Derived on every render rather than fixed when the
 * tab opens, because a run's pods appear after the tab may already be open —
 * a deep link to `tab=logs` renders before compressed nodes are inflated, and
 * a run that has not started a pod yet has none.
 */
export function logNodeFor(nodes: Record<string, WfNode>, picked: string | undefined, selectedNode: string | undefined): string | undefined {
  const pods = podNodes(nodes)
  if (picked && pods.some((p) => p.id === picked)) return picked
  if (selectedNode) {
    if (pods.some((p) => p.id === selectedNode)) return selectedNode
    const under = nodesUnder(nodes, selectedNode).find((n) => n.type === 'Pod' || n.type === 'Container')
    if (under) return under.id
  }
  return pods[0]?.id
}

/** Pod-running nodes of a run (what has logs), newest first. */
export function podNodes(nodes: Record<string, WfNode>): WfNode[] {
  return Object.values(nodes)
    .filter((n) => n.type === 'Pod' || n.type === 'Container')
    .sort((a, b) => (msOf(b.startedAt) ?? 0) - (msOf(a.startedAt) ?? 0))
}

/** The status nodes a run-graph node stands for (the task node, its attempts and items). */
export function nodesUnder(nodes: Record<string, WfNode>, nodeId: string | undefined): WfNode[] {
  if (!nodeId) return []
  return [...subtree(nodes, nodeId)].map((id) => nodes[id]).filter(Boolean)
}

/** Gantt rows: every pod / suspend node with a start, grouped by task display name. */
export function timelineRows(nodes: Record<string, WfNode>): Array<{ id: string; label: string; phase?: string; start: number; end?: number; type?: string }> {
  return Object.values(nodes)
    .filter((n) => (n.type === 'Pod' || n.type === 'Suspend' || n.type === 'Container' || n.type === 'HTTP' || n.type === 'Plugin') && msOf(n.startedAt) !== undefined)
    .map((n) => ({ id: n.id, label: n.displayName ?? n.name, phase: n.phase, start: msOf(n.startedAt)!, end: msOf(n.finishedAt), type: n.type }))
    .sort((a, b) => a.start - b.start || a.label.localeCompare(b.label))
}
