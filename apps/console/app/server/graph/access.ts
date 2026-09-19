import { apiServerFetch, type K8sIdentity } from '../k8s/gateway.ts'
import type { GraphNode } from './model.ts'

/**
 * Who may see which part of the graph.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * The graph is built by the console's own ServiceAccount, which can see the
 * whole cluster — that is the only way to keep a complete, live index without
 * rebuilding it per viewer. But the console's standing promise is that a
 * cluster read shows you exactly what your own RBAC allows, and Adhar AI
 * repeats that promise in every agent's system prompt.
 *
 * Handing the raw index to a user, or to an agent acting for one, would
 * quietly break that. So every read is filtered to the namespaces the asking
 * user can actually list pods in, and the check is done against the
 * apiserver, not inferred from a label or a session claim.
 *
 * ---------------------------------------------------------------------------
 * HOW THE CHECK IS MADE
 * ---------------------------------------------------------------------------
 * Two steps, cheapest first:
 *
 *   1. List namespaces as the user. A platform operator can, and the answer
 *      is the complete list in one call.
 *   2. If that is refused — the common case for an application developer,
 *      since `namespaces` is cluster-scoped — fall back to a
 *      SelfSubjectAccessReview per candidate namespace. That is the
 *      apiserver's own answer to "may I", bounded by the number of
 *      namespaces the graph knows about, and cached per user for a minute.
 *
 * Cluster-scoped nodes (nodes, orgs, images, repositories) are visible to
 * anyone who can see at least one namespace: they carry no tenant data, and
 * hiding the node a pod runs on from someone who can see the pod would make
 * the graph useless without protecting anything.
 */

const TTL_MS = 60_000
const MAX_REVIEWS = 200

interface Entry {
  namespaces: Set<string>
  /** True when the user could list namespaces outright. */
  clusterWide: boolean
  at: number
}

const cache = new Map<string, Entry>()

function cacheKey(identity: K8sIdentity | string): string {
  return typeof identity === 'string' ? identity.slice(0, 32) : identity.user?.id ?? 'anonymous'
}

/** Namespaces the user may list pods in. */
export async function visibleNamespaces(
  identity: K8sIdentity | string,
  candidates: string[],
): Promise<{ namespaces: Set<string>; clusterWide: boolean }> {
  const key = cacheKey(identity)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return { namespaces: hit.namespaces, clusterWide: hit.clusterWide }

  let namespaces = new Set<string>()
  let clusterWide = false

  try {
    const res = await apiServerFetch(identity, '/api/v1/namespaces', { search: '?limit=2000' })
    if (res.ok) {
      const body = (await res.json()) as { items?: Array<{ metadata?: { name?: string } }> }
      for (const ns of body.items ?? []) {
        if (ns.metadata?.name) namespaces.add(ns.metadata.name)
      }
      clusterWide = true
    } else {
      // Drain the body so the connection is not left half-read.
      await res.body?.cancel()
      namespaces = await reviewEach(identity, candidates)
    }
  } catch {
    // A failed check must deny, never allow: an error here would otherwise
    // widen access rather than narrow it.
    namespaces = new Set()
  }

  cache.set(key, { namespaces, clusterWide, at: Date.now() })
  return { namespaces, clusterWide }
}

/**
 * Ask the apiserver, per namespace, whether this user may list pods there.
 *
 * `SelfSubjectAccessReview` is evaluated as the caller, so this is the
 * apiserver's own verdict rather than our reading of their roles.
 */
async function reviewEach(identity: K8sIdentity | string, candidates: string[]): Promise<Set<string>> {
  const allowed = new Set<string>()
  // Bounded: a cluster with thousands of namespaces should not turn one agent
  // question into thousands of API calls. The cap degrades visibility, which
  // is the safe direction.
  const list = candidates.slice(0, MAX_REVIEWS)
  const results = await Promise.all(list.map(async (namespace) => {
    try {
      const res = await apiServerFetch(identity, '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
        method: 'POST',
        body: JSON.stringify({
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SelfSubjectAccessReview',
          spec: { resourceAttributes: { namespace, verb: 'list', resource: 'pods', version: 'v1' } },
        }),
        headers: { 'content-type': 'application/json' },
      })
      if (!res.ok) {
        await res.body?.cancel()
        return null
      }
      const body = (await res.json()) as { status?: { allowed?: boolean } }
      return body.status?.allowed ? namespace : null
    } catch {
      return null
    }
  }))
  for (const ns of results) if (ns) allowed.add(ns)
  return allowed
}

/** Node kinds that carry no tenant data and are safe cluster-wide. */
const CLUSTER_SCOPED = new Set(['node', 'image', 'repository', 'cluster'])

/**
 * Can this user see this node?
 *
 * Namespaced nodes need the namespace. Cluster-scoped nodes need only that
 * the user can see something — a user with no visibility at all gets an empty
 * graph rather than a floating set of nodes and images.
 *
 * `org` is deliberately NOT cluster-scoped: which tenants exist on the
 * platform is itself tenant information.
 */
export function canSee(node: GraphNode, visible: Set<string>): boolean {
  if (node.namespace) return visible.has(node.namespace)
  if (node.kind === 'namespace') return visible.has(node.name)
  if (node.kind === 'org') {
    // Visible when the user can see at least one namespace belonging to it.
    // The org node carries no members, so the test is on the namespaces.
    return visible.size > 0 && orgVisible(node.name, visible)
  }
  return CLUSTER_SCOPED.has(node.kind) && visible.size > 0
}

/**
 * Namespace→org, mirrored from the graph so `canSee` stays synchronous.
 * Populated by the filter entry point below.
 */
let nsToOrg = new Map<string, string>()

export function setNamespaceOrgs(map: Map<string, string>): void {
  nsToOrg = map
}

function orgVisible(org: string, visible: Set<string>): boolean {
  for (const ns of visible) {
    if (nsToOrg.get(ns) === org) return true
  }
  return false
}

/** Drop nodes the user may not see, and any edge that loses an endpoint. */
export function filterGraph<T extends { nodes: GraphNode[]; edges: Array<{ from: string; to: string }> }>(
  data: T,
  visible: Set<string>,
): T {
  const nodes = data.nodes.filter((n) => canSee(n, visible))
  const ids = new Set(nodes.map((n) => n.id))
  // An edge to a node they cannot see is itself a disclosure — it names the
  // thing. Dropping the edge is the only correct answer.
  const edges = data.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  return { ...data, nodes, edges }
}

/** Testing seam: forget cached verdicts. */
export function resetAccessCache(): void {
  cache.clear()
}
