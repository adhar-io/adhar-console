import type { K8sIdentity } from '../k8s/gateway.ts'
import { ANNOTATION, CONTAINERS, isNodeId, isUid, ms, nodesOf, podNameFor, type WfNode, type WfObject } from './model.ts'

/**
 * Step logs for `GET /api/workflows/runs/:ns/:name/logs` (design 0026 §4.4,
 * §6.4; W1 acceptance 3).
 *
 * `archiveLogs` is off (D-12), so a step's log lives in exactly two places:
 * the pod, while it exists, and Loki (Alloy ships every pod's stdout there)
 * once pod GC has removed it. This reads the pod first — AS THE USER, through
 * the gateway, so their `pods/log` RBAC is the API server's to enforce — and
 * falls back to Loki over the node's own time window, as the console (Loki
 * has no per-user identity; the handler asked `get pods/log` in the namespace
 * as the user before calling this, and the query is pinned to that namespace
 * and the run's pod). The response always says which one answered:
 * `source: 'live' | 'loki'`, plus an `x-adhar-log-source` header on a stream.
 */

export interface LogDeps {
  /** A call to the API server AS THE USER (the gateway). */
  k8s(id: K8sIdentity, path: string, init?: { search?: string }): Promise<Response>
  /** The archived run with this uid, only if it is in `namespace`; else null. */
  archived(id: K8sIdentity, namespace: string, uid: string): Promise<WfObject | null>
  /** The hydrated run from argo-server (offloaded node status), or null. */
  hydrated(id: K8sIdentity, namespace: string, name: string): Promise<WfObject | null>
  /** Loki `query_range`, newest first; `[nsTimestamp, line]`. Throws when Loki cannot be read. */
  loki(query: string, startMs: number, endMs: number, limit: number): Promise<Array<[string, string]>>
  now(): number
}

export interface LogQuery {
  nodeId: string
  container: typeof CONTAINERS[number]
  tail: number
  follow: boolean
  uid?: string
}

const MAX_TAIL = 5000
/** Loki is read over the node's window, widened by this on each side for clock skew and shipping lag. */
export const LOKI_MARGIN_MS = 60_000

export function parseLogQuery(q: URLSearchParams): { ok: true; value: LogQuery } | { ok: false; detail: string } {
  const nodeId = q.get('node') ?? q.get('nodeId')
  if (!isNodeId(nodeId)) return { ok: false, detail: 'node is missing or not a valid node id.' }
  const container = (q.get('container') ?? 'main') as LogQuery['container']
  if (!CONTAINERS.includes(container)) return { ok: false, detail: `container must be one of ${CONTAINERS.join(', ')}.` }
  let tail = 1000
  const t = q.get('tail')
  if (t !== null) {
    const n = Number(t)
    if (!Number.isInteger(n) || n < 1) return { ok: false, detail: 'tail must be a positive integer.' }
    tail = Math.min(n, MAX_TAIL)
  }
  const f = q.get('follow')
  const uid = q.get('uid') ?? undefined
  if (uid !== undefined && !isUid(uid)) return { ok: false, detail: 'uid is not a valid archived workflow uid.' }
  return { ok: true, value: { nodeId, container, tail, follow: f === '1' || f === 'true', ...(uid ? { uid } : {}) } }
}

/** The LogQL selector for one pod's container — namespace pinned to the authorised one. */
export function lokiSelector(namespace: string, pod: string, container: string): string {
  const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `{namespace="${q(namespace)}", pod="${q(pod)}", container="${q(container)}"}`
}

/** The window Loki is read over: the node's start and end, widened; an unfinished node ends now. */
export function lokiWindow(node: WfNode, now: number): { startMs: number; endMs: number } {
  const start = ms(node.startedAt) ?? now - 60 * 60_000
  const end = ms(node.finishedAt) ?? now
  return { startMs: start - LOKI_MARGIN_MS, endMs: Math.min(end + LOKI_MARGIN_MS, now) }
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const err = (status: number, error: string, detail: string, extra: Record<string, unknown> = {}) => json({ error, detail, ...extra }, status)

async function loadRun(deps: LogDeps, id: K8sIdentity, namespace: string, name: string, uid?: string): Promise<WfObject | Response> {
  const res = await deps.k8s(id, `/apis/argoproj.io/v1alpha1/namespaces/${namespace}/workflows/${encodeURIComponent(name)}`)
  if (res.ok) return (await res.json()) as WfObject
  await res.body?.cancel()
  if (res.status === 404) {
    if (uid) {
      const archived = await deps.archived(id, namespace, uid)
      if (archived && archived.metadata?.name === name) return archived
    }
    return err(404, 'not_found', `No run ${namespace}/${name}${uid ? ' (live or archived)' : ''}.`)
  }
  if (res.status === 401 || res.status === 403) return err(403, 'forbidden', `Reading ${namespace}/${name} needs get workflows.argoproj.io in namespace ${namespace}.`)
  return err(502, 'upstream_error', `The API server answered HTTP ${res.status}.`)
}

/** The pod that ran `nodeId`, found by its node-id annotation (a pod name format we did not predict). */
async function findPodByNode(deps: LogDeps, id: K8sIdentity, namespace: string, workflow: string, nodeId: string): Promise<string | null> {
  const sel = new URLSearchParams({ labelSelector: `workflows.argoproj.io/workflow=${workflow}`, limit: '500' })
  const res = await deps.k8s(id, `/api/v1/namespaces/${namespace}/pods`, { search: `?${sel}` }).catch(() => null)
  if (!res?.ok) {
    await res?.body?.cancel()
    return null
  }
  const body = (await res.json().catch(() => ({}))) as { items?: Array<{ metadata?: { name?: string; annotations?: Record<string, string> } }> }
  return body.items?.find((p) => p.metadata?.annotations?.['workflows.argoproj.io/node-id'] === nodeId)?.metadata?.name ?? null
}

export async function runLogs(deps: LogDeps, id: K8sIdentity, namespace: string, name: string, q: LogQuery): Promise<Response> {
  const run = await loadRun(deps, id, namespace, name, q.uid)
  if (run instanceof Response) return run
  let nodes = await nodesOf(run)
  if (nodes === null) nodes = (await nodesOf((await deps.hydrated(id, namespace, name)) ?? {})) ?? {}
  const node = nodes[q.nodeId]
  if (!node) return err(404, 'node_not_found', `Run ${namespace}/${name} has no node ${q.nodeId}.`)
  if (node.type !== 'Pod') return err(400, 'not_a_pod_node', `Node ${q.nodeId} is a ${node.type ?? 'non-pod'} node; only pod steps have logs.`)
  const predicted = podNameFor(name, node, run.metadata?.annotations?.[ANNOTATION.podNameFormat])
  if (!predicted) return err(404, 'node_not_found', `Node ${q.nodeId} has no pod.`)

  // 1. The pod, as the user.
  const live = async (pod: string) => {
    const s = new URLSearchParams({ container: q.container, tailLines: String(q.tail) })
    if (q.follow) s.set('follow', 'true')
    return await deps.k8s(id, `/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(pod)}/log`, { search: `?${s}` })
  }
  let pod = predicted
  let res = await live(pod)
  if (res.status === 404) {
    await res.body?.cancel()
    const found = await findPodByNode(deps, id, namespace, name, q.nodeId)
    if (found && found !== pod) {
      pod = found
      res = await live(pod)
    }
  }
  if (res.ok) {
    if (q.follow && res.body) {
      return new Response(res.body, {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-adhar-log-source': 'live', 'x-adhar-log-pod': pod },
      })
    }
    const text = await res.text()
    return json({ source: 'live', pod, container: q.container, lines: text === '' ? [] : text.replace(/\n$/, '').split('\n') })
  }
  const detail = await res.text().catch(() => '')
  if (res.status === 400 && /waiting to start|ContainerCreating|PodInitializing/i.test(detail)) {
    return json({ source: 'live', pod, container: q.container, lines: [], waiting: true })
  }
  if (res.status === 401 || res.status === 403) {
    return err(403, 'forbidden', `Reading this step's log needs get pods/log in namespace ${namespace}.`)
  }
  if (res.status !== 404 && res.status !== 400) return err(502, 'upstream_error', `The API server answered HTTP ${res.status} for the pod log.`)

  // 2. The pod is gone (pod GC): Loki, over the node's window. `pod` is the
  // name we predicted (or found while it existed) — Loki keeps the name.
  const { startMs, endMs } = lokiWindow(node, deps.now())
  const query = lokiSelector(namespace, predicted, q.container)
  try {
    const values = await deps.loki(query, startMs, endMs, q.tail)
    const sorted = [...values].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return json({
      source: 'loki',
      pod: predicted,
      container: q.container,
      lines: sorted.map(([, l]) => l),
      window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
      truncated: values.length >= q.tail,
      note: 'The step\'s pod has been cleaned up; these lines are from Loki.',
    })
  } catch (e) {
    return err(503, 'logs_unavailable', `The step's pod has been cleaned up and Loki could not be read (${e instanceof Error ? e.message : String(e)}).`, { source: 'loki', pod: predicted })
  }
}
