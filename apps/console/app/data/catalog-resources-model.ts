/**
 * The Resources tab's model — an Argo CD application's live resources, the
 * way Argo CD's application details view shows them. Pure; no React.
 *
 * It builds on the composition model rather than beside it: the same node
 * type, status rules, Argo-tree conversion (`addArgoResources`) and layered
 * layout. What this adds is what an APP view needs and a composite view does
 * not: live objects joined onto Argo's nodes (replica counts, pod details),
 * old ReplicaSets folded away, a network view (route → Service → Pod), pods
 * grouped by node or owner, and Argo's desired-vs-live manifests as a diff.
 */

import {
  addArgoResources,
  type ArgoTreeNode,
  type CompNode,
  type CompositionGraph,
  deriveStatus,
  type HealthLevel,
  type KObj,
  matchesText,
  nodeId,
  splitApiVersion,
  visibleWhere,
} from './catalog-composition-model.ts'
import { LAST_APPLIED } from './k8s-yaml.ts'
import { envOrder } from './catalog-env-order.ts'

/* ───────────────────────── graph ───────────────────────── */

/** An app's graph: the Application at the root, Argo's resource tree below. */
export function buildAppGraph(app: KObj, tree: readonly ArgoTreeNode[] | undefined): CompositionGraph {
  const { group, version } = splitApiVersion(app.apiVersion ?? 'argoproj.io/v1alpha1')
  const id = nodeId({ group: group || 'argoproj.io', kind: 'Application', namespace: app.metadata.namespace, name: app.metadata.name })
  const root: CompNode = {
    id,
    group: group || 'argoproj.io',
    version: version || 'v1alpha1',
    kind: 'Application',
    name: app.metadata.name,
    namespace: app.metadata.namespace,
    source: 'argo-app',
    status: deriveStatus({ ...app, apiVersion: app.apiVersion ?? 'argoproj.io/v1alpha1', kind: 'Application' }),
    conditions: [],
    createdAt: app.metadata.creationTimestamp,
    uid: app.metadata.uid,
    children: [],
    parents: [],
    object: app,
  }
  const nodes: Record<string, CompNode> = { [id]: root }
  const { truncated } = addArgoResources(nodes, id, app, tree, { name: app.metadata.name, namespace: app.metadata.namespace }, 1000)
  return { nodes, roots: [id], truncated }
}

/** Key live objects by node id. */
export function indexLive(objs: readonly KObj[]): Map<string, KObj> {
  const m = new Map<string, KObj>()
  for (const o of objs) {
    if (!o?.metadata?.name || !o.kind) continue
    m.set(nodeId({ apiVersion: o.apiVersion, kind: o.kind, namespace: o.metadata.namespace, name: o.metadata.name }), o)
  }
  return m
}

/**
 * Join live objects onto Argo's nodes. Argo's health stays authoritative
 * where it gave one; a node Argo did not assess takes the object's own status.
 * Returns a new graph; the input is not mutated.
 */
export function withLive(graph: CompositionGraph, live: ReadonlyMap<string, KObj>): CompositionGraph {
  const nodes: Record<string, CompNode> = {}
  for (const [id, n] of Object.entries(graph.nodes)) {
    const obj = n.object ?? live.get(id)
    if (!obj || n.object) {
      nodes[id] = n
      continue
    }
    const own = deriveStatus(obj)
    nodes[id] = {
      ...n,
      object: obj,
      uid: n.uid ?? obj.metadata.uid,
      createdAt: n.createdAt ?? obj.metadata.creationTimestamp,
      status: n.status.level === 'none' && own.level !== 'none' ? { ...own, sync: n.status.sync, prune: n.status.prune } : n.status,
      conditions: n.conditions.length ? n.conditions : own && Array.isArray(obj.status?.conditions) ? (obj.status!.conditions as CompNode['conditions']) : [],
    }
  }
  return { ...graph, nodes }
}

/* ───────────────────────── workloads & pods ───────────────────────── */

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export interface Replicas {
  desired: number
  ready: number
  current: number
}

export function workloadReplicas(n: CompNode): Replicas | undefined {
  const o = n.object
  if (!o) return undefined
  const st = o.status ?? {}
  const spec = o.spec ?? {}
  switch (n.kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet':
    case 'Rollout':
      return { desired: num(spec.replicas) ?? 1, ready: num(st.readyReplicas) ?? 0, current: num(st.replicas) ?? 0 }
    case 'DaemonSet':
      return { desired: num(st.desiredNumberScheduled) ?? 0, ready: num(st.numberReady) ?? 0, current: num(st.currentNumberScheduled) ?? 0 }
  }
  return undefined
}

/**
 * ReplicaSets Argo CD folds away: scaled to zero (live), or — without a live
 * object — healthy with no Pods under them. These are the history a
 * Deployment keeps for rollback, not running things.
 */
export function oldReplicaSets(graph: CompositionGraph): Set<string> {
  const out = new Set<string>()
  for (const n of Object.values(graph.nodes)) {
    if (n.kind !== 'ReplicaSet') continue
    const desired = num(n.object?.spec?.replicas)
    const hasPods = n.children.some((c) => graph.nodes[c]?.kind === 'Pod')
    if (desired === 0 || (desired === undefined && !hasPods && (n.status.level === 'healthy' || n.status.level === 'none'))) out.add(n.id)
  }
  return out
}

export interface ContainerInfo {
  name: string
  image?: string
  ready: boolean
  restarts: number
  state: string
  init?: boolean
}

export interface PodInfo {
  phase: string
  ready: string
  restarts: number
  nodeName?: string
  podIP?: string
  containers: ContainerInfo[]
  reason?: string
}

export function podInfo(n: CompNode): PodInfo | undefined {
  if (n.kind !== 'Pod') return undefined
  const o = n.object
  const info = Object.fromEntries((n.info ?? []).map((i) => [i.name, i.value]))
  if (!o) {
    const restarts = Number(info['Restart Count'] ?? 0) || 0
    return {
      phase: info['Status Reason'] ?? n.status.label,
      ready: info['Containers'] ?? '—',
      restarts,
      nodeName: info['Node'],
      containers: (n.images ?? []).map((image, i) => ({ name: `container-${i + 1}`, image, ready: n.status.level === 'healthy', restarts: 0, state: '—' })),
      reason: info['Status Reason'],
    }
  }
  const spec = (o.spec ?? {}) as { containers?: Array<{ name: string; image?: string }>; initContainers?: Array<{ name: string; image?: string }>; nodeName?: string }
  const st = (o.status ?? {}) as {
    phase?: string
    podIP?: string
    reason?: string
    containerStatuses?: Array<{ name: string; ready?: boolean; restartCount?: number; image?: string; state?: Record<string, { reason?: string }> }>
    initContainerStatuses?: Array<{ name: string; ready?: boolean; restartCount?: number; image?: string; state?: Record<string, { reason?: string }> }>
  }
  const statusOf = (list: typeof st.containerStatuses, name: string) => list?.find((c) => c.name === name)
  const stateLabel = (s?: Record<string, { reason?: string }>) => {
    if (!s) return 'waiting'
    const [k, v] = Object.entries(s)[0] ?? []
    return k ? (v?.reason ? `${k}: ${v.reason}` : k) : 'unknown'
  }
  const containers: ContainerInfo[] = [
    ...(spec.initContainers ?? []).map((c) => {
      const cs = statusOf(st.initContainerStatuses, c.name)
      return { name: c.name, image: c.image ?? cs?.image, ready: Boolean(cs?.ready), restarts: cs?.restartCount ?? 0, state: stateLabel(cs?.state), init: true }
    }),
    ...(spec.containers ?? []).map((c) => {
      const cs = statusOf(st.containerStatuses, c.name)
      return { name: c.name, image: c.image ?? cs?.image, ready: Boolean(cs?.ready), restarts: cs?.restartCount ?? 0, state: stateLabel(cs?.state) }
    }),
  ]
  const main = containers.filter((c) => !c.init)
  const waiting = (st.containerStatuses ?? []).map((c) => c.state?.waiting?.reason).find(Boolean)
  return {
    phase: st.phase ?? 'Unknown',
    ready: `${main.filter((c) => c.ready).length}/${main.length}`,
    restarts: main.reduce((a, c) => a + c.restarts, 0),
    nodeName: spec.nodeName,
    podIP: st.podIP,
    containers,
    reason: waiting ?? st.reason,
  }
}

/** Image tags for a node — Argo's list, else the live spec's containers. */
export function imagesOf(n: CompNode): string[] {
  if (n.images?.length) return n.images
  const tpl = (n.object?.spec as { template?: { spec?: { containers?: Array<{ image?: string }> } }; containers?: Array<{ image?: string }> } | undefined)
  const list = tpl?.template?.spec?.containers ?? tpl?.containers ?? []
  return [...new Set(list.map((c) => c.image).filter((i): i is string => Boolean(i)))]
}

export function imageTag(image: string): string {
  const at = image.indexOf('@')
  if (at >= 0) return image.slice(at + 1, at + 20)
  const slash = image.lastIndexOf('/')
  const colon = image.lastIndexOf(':')
  return colon > slash ? image.slice(colon + 1) : 'latest'
}

/* ───────────────────────── metrics ───────────────────────── */

export interface PodUsage {
  cpuMilli: number
  memBytes: number
}

export function parseCpu(q: string | undefined): number {
  if (!q) return 0
  const m = /^([\d.]+)([numk]?)$/.exec(q.trim())
  if (!m) return 0
  const v = Number(m[1])
  switch (m[2]) {
    case 'n':
      return v / 1e6
    case 'u':
      return v / 1e3
    case 'm':
      return v
    case 'k':
      return v * 1e6
    default:
      return v * 1000
  }
}

export function parseMem(q: string | undefined): number {
  if (!q) return 0
  const m = /^([\d.]+)([KMGTE]i?|[kmgte])?$/.exec(q.trim())
  if (!m) return 0
  const v = Number(m[1])
  const unit = m[2] ?? ''
  const pow: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, m: 1e-3 }
  return v * (pow[unit] ?? 1)
}

/** `metrics.k8s.io` PodMetrics list → usage per pod (`namespace/name`). */
export function podUsage(items: ReadonlyArray<{ metadata: { name: string; namespace?: string }; containers?: Array<{ usage?: { cpu?: string; memory?: string } }> }>): Map<string, PodUsage> {
  const m = new Map<string, PodUsage>()
  for (const it of items) {
    let cpu = 0
    let mem = 0
    for (const c of it.containers ?? []) {
      cpu += parseCpu(c.usage?.cpu)
      mem += parseMem(c.usage?.memory)
    }
    m.set(`${it.metadata.namespace ?? ''}/${it.metadata.name}`, { cpuMilli: cpu, memBytes: mem })
  }
  return m
}

export function fmtCpu(milli: number): string {
  return milli >= 1000 ? `${(milli / 1000).toFixed(2)} cores` : `${Math.round(milli)}m`
}

export function fmtMem(bytes: number): string {
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GiB`
  if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20)} MiB`
  return `${Math.round(bytes / 2 ** 10)} KiB`
}

/* ───────────────────────── pods view ───────────────────────── */

export interface PodRow {
  node: CompNode
  info: PodInfo
  owner: string
  host: string
  usage?: PodUsage
}

/** The workload a Pod belongs to, named the way people say it: `Deployment/orders`. */
export function podOwner(graph: CompositionGraph, pod: CompNode): string {
  const parent = pod.parents.map((p) => graph.nodes[p]).find((p) => p && p.kind !== 'Application')
  if (parent) {
    const grand = parent.kind === 'ReplicaSet' ? parent.parents.map((p) => graph.nodes[p]).find((p) => p && p.kind !== 'Application') : undefined
    return grand ? `${grand.kind}/${grand.name}` : `${parent.kind}/${parent.name}`
  }
  const ref = pod.object?.metadata.ownerReferences?.find((o) => o.controller) ?? pod.object?.metadata.ownerReferences?.[0]
  return ref ? `${ref.kind}/${ref.name}` : '(no owner)'
}

export function podRows(graph: CompositionGraph, usage?: ReadonlyMap<string, PodUsage>): PodRow[] {
  return Object.values(graph.nodes)
    .filter((n) => n.kind === 'Pod')
    .map((n) => {
      const info = podInfo(n)!
      return { node: n, info, owner: podOwner(graph, n), host: info.nodeName ?? 'Unscheduled', usage: usage?.get(`${n.namespace ?? ''}/${n.name}`) }
    })
    .sort((a, b) => a.node.name.localeCompare(b.node.name))
}

export function groupPods(rows: readonly PodRow[], by: 'node' | 'owner'): Array<{ key: string; rows: PodRow[]; worst: HealthLevel }> {
  const groups = new Map<string, PodRow[]>()
  for (const r of rows) {
    const k = by === 'node' ? r.host : r.owner
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  const sev: Record<HealthLevel, number> = { degraded: 6, missing: 5, progressing: 4, suspended: 3, unknown: 2, healthy: 1, none: 0 }
  return [...groups.entries()]
    .map(([key, rs]) => ({ key, rows: rs, worst: rs.reduce<HealthLevel>((w, r) => (sev[r.node.status.level] > sev[w] ? r.node.status.level : w), 'none') }))
    .sort((a, b) => (a.key === 'Unscheduled' ? 1 : b.key === 'Unscheduled' ? -1 : a.key.localeCompare(b.key)))
}

/* ───────────────────────── network view ───────────────────────── */

const ENTRY_KINDS = new Set(['Gateway', 'HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute', 'Ingress'])

function selectorMatches(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector || !Object.keys(selector).length || !labels) return false
  return Object.entries(selector).every(([k, v]) => labels[k] === v)
}

/** Hostnames a route or Ingress answers on. */
export function hostnamesOf(n: CompNode): string[] {
  const out = new Set<string>()
  for (const i of n.networking?.ingress ?? []) if (i.hostname) out.add(i.hostname)
  for (const u of n.networking?.externalURLs ?? []) {
    try {
      out.add(new URL(u).host)
    } catch {
      out.add(u)
    }
  }
  const spec = n.object?.spec as { hostnames?: string[]; rules?: Array<{ host?: string }> } | undefined
  for (const h of spec?.hostnames ?? []) out.add(h)
  for (const r of spec?.rules ?? []) if (r.host) out.add(r.host)
  return [...out]
}

/** Services a route or Ingress sends traffic to. */
function backendServices(n: CompNode): Array<{ name: string; namespace?: string }> {
  const refs = (n.networking?.targetRefs ?? []).filter((r) => (r.kind ?? 'Service') === 'Service' && r.name)
  if (refs.length) return refs.map((r) => ({ name: r.name!, namespace: r.namespace ?? n.namespace }))
  const spec = (n.object?.spec ?? {}) as {
    rules?: Array<{ backendRefs?: Array<{ name?: string; namespace?: string; kind?: string }>; http?: { paths?: Array<{ backend?: { service?: { name?: string } } }> } }>
    defaultBackend?: { service?: { name?: string } }
  }
  const out: Array<{ name: string; namespace?: string }> = []
  for (const r of spec.rules ?? []) {
    for (const b of r.backendRefs ?? []) if (b.name && (b.kind ?? 'Service') === 'Service') out.push({ name: b.name, namespace: b.namespace ?? n.namespace })
    for (const p of r.http?.paths ?? []) if (p.backend?.service?.name) out.push({ name: p.backend.service.name, namespace: n.namespace })
  }
  if (spec.defaultBackend?.service?.name) out.push({ name: spec.defaultBackend.service.name, namespace: n.namespace })
  return out
}

function gatewayParents(n: CompNode): Array<{ name: string; namespace?: string }> {
  const refs = ((n.object?.spec as { parentRefs?: Array<{ name?: string; namespace?: string; kind?: string }> } | undefined)?.parentRefs ?? [])
  return refs.filter((r) => r.name && (r.kind ?? 'Gateway') === 'Gateway').map((r) => ({ name: r.name!, namespace: r.namespace ?? n.namespace }))
}

/**
 * Traffic's path through the app: Gateway → route/Ingress → Service → Pods.
 * Edges come from Argo's networking info where it has it (target Services,
 * target pod labels, pod labels) and from the live specs otherwise
 * (backendRefs, Ingress backends, Service selectors, pod labels).
 */
export function networkGraph(graph: CompositionGraph): CompositionGraph {
  const pick = (n: CompNode) => ENTRY_KINDS.has(n.kind) || n.kind === 'Service' || n.kind === 'Pod'
  const nodes: Record<string, CompNode> = {}
  for (const n of Object.values(graph.nodes)) if (pick(n)) nodes[n.id] = { ...n, children: [], parents: [] }
  const linkIds = (a: string, b: string) => {
    if (!nodes[a] || !nodes[b] || a === b) return
    if (!nodes[a].children.includes(b)) nodes[a].children.push(b)
    if (!nodes[b].parents.includes(a)) nodes[b].parents.push(a)
  }
  const list = Object.values(nodes)
  const svcId = (name: string, ns?: string) => nodeId({ group: '', kind: 'Service', namespace: ns, name })
  for (const n of list) {
    if (n.kind === 'Gateway' || !ENTRY_KINDS.has(n.kind)) continue
    for (const g of gatewayParents(n)) {
      const gid = list.find((x) => x.kind === 'Gateway' && x.name === g.name && (x.namespace ?? '') === (g.namespace ?? ''))?.id
      if (gid) linkIds(gid, n.id)
    }
    for (const s of backendServices(n)) linkIds(n.id, svcId(s.name, s.namespace))
  }
  for (const svc of list.filter((n) => n.kind === 'Service')) {
    const selector = svc.networking?.targetLabels ?? (svc.object?.spec as { selector?: Record<string, string> } | undefined)?.selector
    for (const pod of list.filter((n) => n.kind === 'Pod' && (n.namespace ?? '') === (svc.namespace ?? ''))) {
      const labels = pod.networking?.labels ?? pod.object?.metadata.labels
      if (selectorMatches(selector, labels)) linkIds(svc.id, pod.id)
    }
  }
  const order = (k: string) => (k === 'Gateway' ? 0 : ENTRY_KINDS.has(k) ? 1 : k === 'Service' ? 2 : 3)
  const roots = list
    .filter((n) => n.parents.length === 0 && n.kind !== 'Pod')
    .sort((a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name))
    .map((n) => n.id)
  // Pods no Service selects are not on a traffic path; keep them out.
  for (const n of list) if (n.kind === 'Pod' && n.parents.length === 0) delete nodes[n.id]
  return { nodes, roots, truncated: graph.truncated }
}

/* ───────────────────────── filters ───────────────────────── */

export interface ResourceFilter {
  search?: string
  kind?: string
  health?: HealthLevel | 'outofsync' | ''
  sync?: 'Synced' | 'OutOfSync' | ''
  /** Show ReplicaSets Argo folds away. */
  showOld?: boolean
}

/**
 * Visible ids for the tree/list: filter matches with their ancestors, minus
 * old ReplicaSets (and anything below them) unless asked for.
 */
export function resourceVisible(graph: CompositionGraph, f: ResourceFilter): Set<string> | undefined {
  const needle = (f.search ?? '').trim().toLowerCase()
  const filtering = Boolean(needle || f.kind || f.health || f.sync)
  const hidden = f.showOld ? new Set<string>() : hiddenUnder(graph, oldReplicaSets(graph))
  if (!filtering && hidden.size === 0) return undefined
  const vis = filtering
    ? visibleWhere(graph, (n) => {
      if (hidden.has(n.id)) return false
      if (f.kind && n.kind !== f.kind) return false
      if (f.health && n.status.level !== f.health) return false
      if (f.sync && n.status.sync !== f.sync) return false
      if (needle && !matchesText(n, needle)) return false
      return true
    })
    : new Set(Object.keys(graph.nodes))
  for (const h of hidden) vis.delete(h)
  return vis
}

function hiddenUnder(graph: CompositionGraph, roots: Set<string>): Set<string> {
  const out = new Set<string>()
  const stack = [...roots]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    stack.push(...(graph.nodes[id]?.children ?? []))
  }
  return out
}

/* ───────────────────────── desired vs live ───────────────────────── */

export interface ManagedResource {
  group?: string
  kind: string
  namespace?: string
  name: string
  targetState?: string
  liveState?: string
  normalizedLiveState?: string
  predictedLiveState?: string
}

const parse = (s: string | undefined): unknown => {
  if (!s || s === 'null') return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** Argo's managed-resources response → desired and live state per node id. */
export function managedIndex(items: readonly ManagedResource[]): Map<string, { desired?: unknown; live?: unknown }> {
  const m = new Map<string, { desired?: unknown; live?: unknown }>()
  for (const it of items) {
    const id = nodeId({ group: it.group ?? '', kind: it.kind, namespace: it.namespace || undefined, name: it.name })
    m.set(id, {
      desired: parse(it.predictedLiveState) ?? parse(it.targetState),
      live: parse(it.normalizedLiveState) ?? parse(it.liveState),
    })
  }
  return m
}

/** The parts of an object a diff should compare: no status, no server bookkeeping. */
export function comparable(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const { status: _s, ...rest } = obj as Record<string, unknown>
  const meta = rest.metadata as Record<string, unknown> | undefined
  if (meta) {
    const { managedFields: _m, resourceVersion: _r, uid: _u, generation: _g, creationTimestamp: _c, selfLink: _l, ...m } = meta
    const ann = m.annotations as Record<string, string> | undefined
    if (ann) {
      const { [LAST_APPLIED]: _la, ...a } = ann
      if (Object.keys(a).length) m.annotations = a
      else delete m.annotations
    }
    rest.metadata = m
  }
  return rest
}

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
  a?: number
  b?: number
}

/** Line diff (LCS). `a` is desired, `b` live: `del` = only in Git, `add` = only live. */
export function lineDiff(a: string, b: string, limit = 1500): DiffLine[] {
  const A = a.split('\n')
  const B = b.split('\n')
  if (A[A.length - 1] === '') A.pop()
  if (B[B.length - 1] === '') B.pop()
  // Trim the common head and tail; the table only covers the middle.
  let head = 0
  while (head < A.length && head < B.length && A[head] === B[head]) head++
  let tail = 0
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++
  const a2 = A.slice(head, A.length - tail)
  const b2 = B.slice(head, B.length - tail)
  const out: DiffLine[] = []
  for (let i = 0; i < head; i++) out.push({ type: 'same', text: A[i], a: i + 1, b: i + 1 })
  if (a2.length * b2.length > limit * limit) {
    a2.forEach((t, i) => out.push({ type: 'del', text: t, a: head + i + 1 }))
    b2.forEach((t, i) => out.push({ type: 'add', text: t, b: head + i + 1 }))
  } else {
    const n = a2.length
    const m = b2.length
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) {
        out.push({ type: 'same', text: a2[i], a: head + i + 1, b: head + j + 1 })
        i++
        j++
      } else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) {
        out.push({ type: 'add', text: b2[j], b: head + j + 1 })
        j++
      } else {
        out.push({ type: 'del', text: a2[i], a: head + i + 1 })
        i++
      }
    }
  }
  for (let k = 0; k < tail; k++) out.push({ type: 'same', text: A[A.length - tail + k], a: A.length - tail + k + 1, b: B.length - tail + k + 1 })
  return out
}

export type DiffChunk = { type: 'lines'; lines: DiffLine[] } | { type: 'skip'; count: number }

/** Collapse unchanged runs longer than 2×context into "N unchanged lines". */
export function diffChunks(lines: readonly DiffLine[], context = 3): DiffChunk[] {
  const out: DiffChunk[] = []
  let buf: DiffLine[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type !== 'same') {
      buf.push(lines[i++])
      continue
    }
    let j = i
    while (j < lines.length && lines[j].type === 'same') j++
    const run = lines.slice(i, j)
    const first = i === 0
    const last = j === lines.length
    const keepHead = first ? 0 : context
    const keepTail = last ? 0 : context
    if (run.length > keepHead + keepTail + 1) {
      buf.push(...run.slice(0, keepHead))
      if (buf.length) out.push({ type: 'lines', lines: buf })
      buf = []
      out.push({ type: 'skip', count: run.length - keepHead - keepTail })
      buf.push(...run.slice(run.length - keepTail))
    } else buf.push(...run)
    i = j
  }
  if (buf.length) out.push({ type: 'lines', lines: buf })
  return out
}

/* ───────────────────────── environments ───────────────────────── */

export interface EnvTab<A> {
  id: string
  label: string
  app: A
}

/**
 * One tab per app: the known environments in promotion order — dev → test →
 * prod first (the platform's chain), Kargo's stage order only to place custom
 * environment names, then the deployment data's own order — then apps with
 * no environment, labelled by name.
 */
export function envTabs<A extends { metadata: { name: string; namespace?: string } }>(
  environments: ReadonlyArray<{ key: string; label: string; app: A }>,
  unscoped: readonly A[],
  kargoOrder?: readonly string[],
): EnvTab<A>[] {
  const idx = (k: string) => {
    const i = kargoOrder?.findIndex((s) => s.toLowerCase() === k.toLowerCase()) ?? -1
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  const envs = environments
    .map((e, i) => ({ e, i }))
    .sort((x, y) => envOrder(x.e.key) - envOrder(y.e.key) || idx(x.e.key) - idx(y.e.key) || x.i - y.i)
    .map(({ e }) => ({ id: `${e.app.metadata.namespace ?? ''}/${e.app.metadata.name}`, label: e.label, app: e.app }))
  const seen = new Set(envs.map((t) => t.id))
  for (const a of unscoped) {
    const id = `${a.metadata.namespace ?? ''}/${a.metadata.name}`
    if (!seen.has(id)) {
      seen.add(id)
      envs.push({ id, label: a.metadata.name, app: a })
    }
  }
  return envs
}

/* ───────────────────────── drawer tab ids ───────────────────────── */

/**
 * The drawer's Resources tab keeps the id `composition` (its first name);
 * `resources` — the id the separate Argo CD view had — is an alias, so old
 * links and bookmarks land on it. Other ids pass through.
 */
export function drawerTabAlias<T extends string>(tab: T | undefined): T | 'composition' | undefined {
  if (!tab) return undefined
  return (tab as string) === 'resources' ? 'composition' : tab
}

/* ───────────────────────── unified tab views ───────────────────────── */

export type ResourcesView = 'composition' | 'tree' | 'network' | 'pods' | 'list'

/**
 * The Resources tab's views: Composition when there is a composite (or the
 * lookup is pending / failed, to say why), the four Argo CD views when an app
 * deploys the entity. It opens on the first.
 */
export function resourceViews(opts: { composition: boolean; apps: number }): { views: ResourcesView[]; initial: ResourcesView } {
  const views: ResourcesView[] = []
  if (opts.composition) views.push('composition')
  if (opts.apps > 0) views.push('tree', 'network', 'pods', 'list')
  return { views, initial: views[0] ?? 'composition' }
}

