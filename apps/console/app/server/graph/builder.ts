import { env } from '@adhar-console/utils'
import { getK8sServiceToken } from '../tool-registry.ts'
import { type KubeObject, objectKey, runWatch, type WatchSpec } from '../k8s/sa-watch.ts'
import { GraphIndex } from './index-store.ts'
import {
  type Contribution,

  fromApplication,
  fromIngress,
  fromNamespace,
  fromNode,
  fromPipelineRun,
  fromPod,
  fromService,
  fromWorkload,
  type GraphEdge,
  nodeId,
  type Obj,
  selectorMatches,
} from './model.ts'

/**
 * Keeps the knowledge graph current from the apiserver.
 *
 * One watch per kind, running as the console's ServiceAccount, feeding the
 * index. The watch machinery itself lives in `k8s/sa-watch.ts` — shared with
 * the notification watcher, because the subtle parts (relist without
 * swallowing changes, prune what vanished while disconnected, disable a kind
 * that is not installed) should exist once.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RELATIONSHIP THAT NEEDS CORRELATION
 * ---------------------------------------------------------------------------
 * Every other edge is derivable from a single object: a pod states its node,
 * a workload states its images, an Argo CD Application states what it
 * manages. `Service → Pod` is not — it is a label selector that has to be
 * evaluated against every pod in the namespace, and neither object knows the
 * answer alone.
 *
 * So the builder keeps a small side index of pod labels and service selectors
 * per namespace, and recomputes the affected side when either changes. The
 * service owns those edges, so a pod appearing re-applies the services that
 * now match it rather than having the pod contribute an edge the service
 * would not know to withdraw.
 */

const SOURCE_PREFIXES = {
  namespace: 'ns|',
  node: 'node|',
  workload: 'wl|',
  pod: 'pod|',
  service: 'svc|',
  ingress: 'ing|',
  application: 'app|',
  pipelinerun: 'plr|',
} as const

interface Source {
  key: keyof typeof SOURCE_PREFIXES
  spec: WatchSpec
  contribute(obj: Obj): Contribution
}

/**
 * Watched kinds, most structural first so the graph fills out in an order
 * that makes sense if you are watching it boot.
 */
const SOURCES: Source[] = [
  { key: 'namespace', spec: { id: 'namespaces', group: '', version: 'v1', resource: 'namespaces' }, contribute: fromNamespace },
  { key: 'node', spec: { id: 'nodes', group: '', version: 'v1', resource: 'nodes' }, contribute: fromNode },
  { key: 'workload', spec: { id: 'deployments', group: 'apps', version: 'v1', resource: 'deployments' }, contribute: fromWorkload },
  { key: 'workload', spec: { id: 'statefulsets', group: 'apps', version: 'v1', resource: 'statefulsets' }, contribute: fromWorkload },
  { key: 'workload', spec: { id: 'daemonsets', group: 'apps', version: 'v1', resource: 'daemonsets' }, contribute: fromWorkload },
  { key: 'workload', spec: { id: 'cronjobs', group: 'batch', version: 'v1', resource: 'cronjobs' }, contribute: fromWorkload },
  { key: 'pod', spec: { id: 'pods', group: '', version: 'v1', resource: 'pods', limit: 5000 }, contribute: fromPod },
  { key: 'service', spec: { id: 'services', group: '', version: 'v1', resource: 'services' }, contribute: fromService },
  { key: 'ingress', spec: { id: 'ingresses', group: 'networking.k8s.io', version: 'v1', resource: 'ingresses' }, contribute: fromIngress },
  { key: 'application', spec: { id: 'applications', group: 'argoproj.io', version: 'v1alpha1', resource: 'applications' }, contribute: fromApplication },
  { key: 'pipelinerun', spec: { id: 'pipelineruns', group: 'tekton.dev', version: 'v1', resource: 'pipelineruns' }, contribute: fromPipelineRun },
]

/* ─────────────────────────── the graph ─────────────────────────── */

export const graph = new GraphIndex()

/** Pod labels and service selectors, per namespace, for `selects` edges. */
const podLabels = new Map<string, { ns: string; name: string; labels: Record<string, string> }>()
const serviceSelectors = new Map<string, { ns: string; name: string; selector: Record<string, string>; obj: Obj }>()

let running = false
/** True once every source that is going to start has primed. */
let bootComplete = false

function sourceKeyFor(prefix: string, obj: KubeObject): string {
  return `${prefix}${objectKey(obj)}`
}

/** Services in a namespace whose selector matches these labels. */
function servicesMatching(ns: string, labels: Record<string, string>): string[] {
  const out: string[] = []
  for (const [id, svc] of serviceSelectors) {
    if (svc.ns !== ns) continue
    if (selectorMatches(svc.selector, labels)) out.push(id)
  }
  return out
}

/** The `selects` edges one service currently has, given the pods we know. */
function selectsEdges(svc: { ns: string; name: string; selector: Record<string, string> }): GraphEdge[] {
  const from = nodeId('service', svc.name, svc.ns)
  const edges: GraphEdge[] = []
  for (const pod of podLabels.values()) {
    if (pod.ns !== svc.ns) continue
    if (!selectorMatches(svc.selector, pod.labels)) continue
    edges.push({ from, to: nodeId('pod', pod.name, pod.ns), kind: 'selects' })
  }
  return edges
}

/** Re-apply one service so its `selects` edges match the pods we now know. */
function reapplyService(id: string): void {
  const svc = serviceSelectors.get(id)
  if (!svc) return
  const base = fromService(svc.obj)
  graph.apply(id, { nodes: base.nodes, edges: [...base.edges, ...selectsEdges(svc)] })
}

function applyPod(obj: Obj, key: string): void {
  graph.apply(key, fromPod(obj))
  const ns = obj.metadata?.namespace ?? ''
  const name = obj.metadata?.name ?? ''
  const labels = obj.metadata?.labels ?? {}
  const before = podLabels.get(key)
  podLabels.set(key, { ns, name, labels })

  // Only touch services when the labels actually changed — a pod's status
  // updates constantly and re-walking every service each time would make the
  // graph the busiest thing on the server.
  if (before && sameLabels(before.labels, labels)) return
  const affected = new Set([
    ...servicesMatching(ns, labels),
    ...(before ? servicesMatching(before.ns, before.labels) : []),
  ])
  for (const id of affected) reapplyService(id)
}

function removePod(key: string): void {
  const pod = podLabels.get(key)
  graph.remove(key)
  podLabels.delete(key)
  if (!pod) return
  for (const id of servicesMatching(pod.ns, pod.labels)) reapplyService(id)
}

function applyService(obj: Obj, key: string): void {
  const selector = (obj.spec?.selector as Record<string, string> | undefined) ?? {}
  serviceSelectors.set(key, {
    ns: obj.metadata?.namespace ?? '',
    name: obj.metadata?.name ?? '',
    selector,
    obj,
  })
  reapplyService(key)
}

function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every((k) => a[k] === b[k])
}

/* ─────────────────────────── lifecycle ─────────────────────────── */

export interface GraphStatus {
  running: boolean
  ready: boolean
  reason?: string
}

let status: GraphStatus = { running: false, ready: false, reason: 'not started' }

export function graphStatus(): GraphStatus {
  return { ...status, ready: bootComplete }
}

/**
 * Start watching. Safe to call once at boot; a second call is a no-op.
 *
 * Off when there is no ServiceAccount token, loudly and once — a console with
 * no cluster behind it should present an empty graph, not a page of errors.
 */
export function startGraph(): () => void {
  if (running) return () => {}
  if (env('ADHAR_GRAPH_DISABLED') === 'true') {
    status = { running: false, ready: false, reason: 'disabled by ADHAR_GRAPH_DISABLED' }
    console.log('[graph] disabled by ADHAR_GRAPH_DISABLED')
    return () => {}
  }
  const token = getK8sServiceToken()
  if (!token) {
    status = { running: false, ready: false, reason: 'no ServiceAccount token' }
    console.log('[graph] no ServiceAccount token — the knowledge graph is off (set K8S_SA_TOKEN or run in-cluster)')
    return () => {}
  }

  running = true
  status = { running: true, ready: false }
  let stopped = false
  const isStopped = () => stopped

  let pending = SOURCES.length
  const primed = () => {
    if (--pending <= 0) {
      bootComplete = true
      const s = graph.stats()
      console.log(`[graph] ready — ${s.nodes} nodes, ${s.edges} edges`)
    }
  }

  for (const source of SOURCES) {
    const prefix = SOURCE_PREFIXES[source.key]
    // Keys this SPEC has contributed. Several specs share a prefix — all four
    // workload kinds use `wl|` — so a resync sweep must be scoped per spec, or
    // the Deployment relist would delete every StatefulSet in the graph.
    const owned = new Set<string>()
    ownedKeys.set(source.spec.id, owned)

    const add = (obj: KubeObject): string => {
      const key = sourceKeyFor(prefix, obj)
      const typed = obj as Obj
      if (source.key === 'pod') applyPod(typed, key)
      else if (source.key === 'service') applyService(typed, key)
      else graph.apply(key, source.contribute(typed))
      owned.add(key)
      return key
    }
    const drop = (key: string): void => {
      if (source.key === 'pod') removePod(key)
      else {
        if (source.key === 'service') serviceSelectors.delete(key)
        graph.remove(key)
      }
      owned.delete(key)
    }

    void runWatch(
      source.spec,
      token,
      {
        upsert(obj) {
          add(obj)
        },
        remove(obj) {
          drop(sourceKeyFor(prefix, obj))
        },
        resynced(seen) {
          // Anything this spec owned that the fresh list no longer returns was
          // deleted while the watch was down — no DELETED frame ever arrived.
          const stillThere = new Set([...seen].map((k) => `${prefix}${k}`))
          for (const key of [...owned]) {
            if (!stillThere.has(key)) drop(key)
          }
        },
        ready() {
          graph.markReady(source.spec.id)
          primed()
        },
      },
      isStopped,
      (m) => console.log(m),
    ).catch((e) => {
      console.warn(`[graph] ${source.spec.id}: watcher exited:`, e)
      primed()
    })
  }

  console.log(`[graph] building the platform knowledge graph (${SOURCES.length} sources)`)

  return () => {
    stopped = true
    running = false
    status = { running: false, ready: false, reason: 'stopped' }
  }
}

/** Keys each watch spec has contributed, so a resync sweep stays scoped. */
const ownedKeys = new Map<string, Set<string>>()
