/**
 * The platform knowledge graph: what exists, and how it is connected.
 *
 * ---------------------------------------------------------------------------
 * WHY A GRAPH AND NOT MORE LISTS
 * ---------------------------------------------------------------------------
 * The console can already list anything. What it could not do is answer a
 * question that crosses kinds — "what does this Argo CD application actually
 * run, on which nodes, from which images, built by which pipeline, owned by
 * which team" — because every one of those hops lives in a different API and
 * a different page. A person can do that traversal by hand in ten minutes; an
 * agent asked for "deep insight" cannot do it at all from list tools, because
 * each list it fetches costs context and it has no way to know which of 400
 * pods matters before it reads them.
 *
 * So the relationships are computed once, server-side, and kept current. An
 * agent then asks for a node and its neighbourhood — a few hundred tokens —
 * instead of paging through kinds and guessing.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS PURE
 * ---------------------------------------------------------------------------
 * Nothing here talks to the apiserver. It defines the node and edge
 * vocabulary and the functions that turn one Kubernetes object into nodes and
 * edges. That makes the interesting part — what relates to what, and how a
 * relationship is inferred when Kubernetes does not state it outright —
 * testable without a cluster, which matters because those inferences are
 * where a knowledge graph quietly becomes wrong.
 */

export type NodeKind =
  | 'cluster'
  | 'node'
  | 'namespace'
  | 'org'
  | 'workload'
  | 'pod'
  | 'container'
  | 'image'
  | 'service'
  | 'ingress'
  | 'route'
  | 'config'
  | 'secret'
  | 'volume'
  | 'application'
  | 'pipelinerun'
  | 'workflow'
  | 'repository'

/**
 * Edges are directed and named from the SOURCE's point of view: `a -runs-on->
 * b` reads "a runs on b". Traversal is bidirectional (see `neighbours`), so
 * direction is about meaning, not reachability.
 */
export type EdgeKind =
  | 'contains' // namespace contains workload; cluster contains node
  | 'owns' // Deployment owns Pod (through ReplicaSet, flattened)
  | 'runs-on' // Pod runs on Node
  | 'uses-image' // container uses image
  | 'selects' // Service selects Pods
  | 'routes-to' // Ingress/HTTPRoute routes to Service
  | 'mounts' // Pod mounts ConfigMap / Secret / PVC
  | 'manages' // Argo CD Application manages a workload
  | 'builds' // PipelineRun builds an image
  | 'belongs-to' // namespace belongs to org
  | 'sources-from' // Application sources from a repository

export interface GraphNode {
  /** Stable, human-readable and globally unique: `kind:namespace/name`. */
  id: string
  kind: NodeKind
  name: string
  namespace?: string
  /**
   * Health as a person would read it. `unknown` is honest and common —
   * plenty of node kinds have no health of their own.
   */
  status?: 'healthy' | 'degraded' | 'progressing' | 'failed' | 'unknown'
  /**
   * Kind-specific detail. Deliberately small: the graph answers "what and how
   * is it connected", and anything that needs the full object should go and
   * fetch the full object. A graph that carries every field is a cache, and
   * a stale cache is worse than a pointer.
   */
  props?: Record<string, string | number | boolean>
  /** Source object's apiVersion/kind, so a caller can fetch the real thing. */
  gvk?: { group: string; version: string; kind: string }
  updatedAt?: string
}

export interface GraphEdge {
  from: string
  to: string
  kind: EdgeKind
}

/** What one Kubernetes object contributes to the graph. */
export interface Contribution {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export const EMPTY: Contribution = { nodes: [], edges: [] }

/* ─────────────────────────── ids ─────────────────────────── */

export function nodeId(kind: NodeKind, name: string, namespace?: string): string {
  return namespace ? `${kind}:${namespace}/${name}` : `${kind}:${name}`
}

/**
 * The id for an image reference.
 *
 * Normalised so the same image pulled by ten workloads is ONE node — that is
 * the entire value of having image nodes, because "what else runs this image"
 * is the question you ask when one of them turns out to be vulnerable. A
 * digest, when present, wins over the tag: two pods on `:latest` may be
 * running different code, and merging them would state something false.
 */
export function imageId(ref: string): string {
  const at = ref.indexOf('@')
  if (at > 0) return nodeId('image', ref)
  return nodeId('image', ref.includes(':') ? ref : `${ref}:latest`)
}

/** Split an image reference into registry / repository / tag for display. */
export function parseImage(ref: string): { registry?: string; repository: string; tag?: string; digest?: string } {
  const at = ref.indexOf('@')
  const digest = at > 0 ? ref.slice(at + 1) : undefined
  const withoutDigest = at > 0 ? ref.slice(0, at) : ref
  const slash = withoutDigest.indexOf('/')
  const first = slash > 0 ? withoutDigest.slice(0, slash) : ''
  // A registry host has a dot, a colon, or is literally localhost. Without
  // that test `library/nginx` would report `library` as a registry.
  const hasRegistry = first.includes('.') || first.includes(':') || first === 'localhost'
  const registry = hasRegistry ? first : undefined
  const rest = hasRegistry ? withoutDigest.slice(slash + 1) : withoutDigest
  const colon = rest.lastIndexOf(':')
  // A colon inside a path segment is part of the repository, not a tag.
  const isTag = colon > 0 && !rest.slice(colon).includes('/')
  return {
    registry,
    repository: isTag ? rest.slice(0, colon) : rest,
    tag: isTag ? rest.slice(colon + 1) : digest ? undefined : 'latest',
    digest,
  }
}

/* ─────────────────────────── shapes ─────────────────────────── */

export interface Meta {
  uid?: string
  name?: string
  namespace?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  creationTimestamp?: string
  ownerReferences?: Array<{ kind?: string; name?: string; uid?: string; controller?: boolean }>
}

export interface Obj {
  apiVersion?: string
  kind?: string
  metadata?: Meta
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
  [k: string]: unknown
}

function get<T>(obj: unknown, path: string): T | undefined {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur as T | undefined
}

const name = (o: Obj) => o.metadata?.name ?? ''
const ns = (o: Obj) => o.metadata?.namespace ?? ''
const ts = (o: Obj) => o.metadata?.creationTimestamp

/* ─────────────────────────── selectors ─────────────────────────── */

/**
 * Does a pod's labels satisfy a service's selector?
 *
 * Kubernetes resolves this itself through Endpoints, but Endpoints only exist
 * for pods that are READY — so an "empty" service and a service whose pods are
 * all crashing look identical through them. Matching labels directly means the
 * graph shows a service connected to its broken pods, which is exactly the
 * picture someone debugging needs.
 */
export function selectorMatches(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector || Object.keys(selector).length === 0) return false
  const l = labels ?? {}
  for (const [k, v] of Object.entries(selector)) {
    if (l[k] !== v) return false
  }
  return true
}

/* ─────────────────────────── contributions ─────────────────────────── */

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet'])

/** `adhar.io/org` — how the provisioner marks a namespace as a tenant's. */
export const ORG_LABEL = 'adhar.io/org'

export function fromNamespace(o: Obj): Contribution {
  const id = nodeId('namespace', name(o))
  const org = o.metadata?.labels?.[ORG_LABEL]
  const nodes: GraphNode[] = [{
    id,
    kind: 'namespace',
    name: name(o),
    status: get<string>(o, 'status.phase') === 'Active' ? 'healthy' : 'unknown',
    props: { phase: get<string>(o, 'status.phase') ?? 'Unknown', ...(org ? { org } : {}) },
    gvk: { group: '', version: 'v1', kind: 'Namespace' },
    updatedAt: ts(o),
  }]
  const edges: GraphEdge[] = []
  if (org) {
    nodes.push({ id: nodeId('org', org), kind: 'org', name: org })
    edges.push({ from: id, to: nodeId('org', org), kind: 'belongs-to' })
  }
  return { nodes, edges }
}

export function fromNode(o: Obj): Contribution {
  const conditions = get<Array<{ type?: string; status?: string }>>(o, 'status.conditions') ?? []
  const ready = conditions.find((c) => c.type === 'Ready')?.status
  const info = get<Record<string, string>>(o, 'status.nodeInfo') ?? {}
  const cap = get<Record<string, string>>(o, 'status.capacity') ?? {}
  return {
    nodes: [{
      id: nodeId('node', name(o)),
      kind: 'node',
      name: name(o),
      status: ready === 'True' ? 'healthy' : ready === 'False' ? 'failed' : 'unknown',
      props: {
        kubelet: info.kubeletVersion ?? '',
        os: info.osImage ?? '',
        cpu: cap.cpu ?? '',
        memory: cap.memory ?? '',
        // The label that tells you whether losing this node is a control-plane
        // event or just capacity.
        role: o.metadata?.labels?.['node-role.kubernetes.io/control-plane'] !== undefined ? 'control-plane' : 'worker',
      },
      gvk: { group: '', version: 'v1', kind: 'Node' },
      updatedAt: ts(o),
    }],
    edges: [],
  }
}

export function fromWorkload(o: Obj): Contribution {
  if (!WORKLOAD_KINDS.has(o.kind ?? '')) return EMPTY
  // ReplicaSets exist to be owned by Deployments. Surfacing them would double
  // every workload in the graph and add a hop nobody thinks in.
  if (o.kind === 'ReplicaSet') return EMPTY

  const id = nodeId('workload', name(o), ns(o))
  const desired = get<number>(o, 'spec.replicas')
  const ready = get<number>(o, 'status.readyReplicas') ?? get<number>(o, 'status.numberReady')
  const nodes: GraphNode[] = [{
    id,
    kind: 'workload',
    name: name(o),
    namespace: ns(o),
    status: workloadStatus(o),
    props: {
      type: o.kind ?? 'Workload',
      ...(desired !== undefined ? { desired } : {}),
      ...(ready !== undefined ? { ready } : {}),
      ...(get<string>(o, 'spec.schedule') ? { schedule: get<string>(o, 'spec.schedule')! } : {}),
    },
    gvk: { group: 'apps', version: 'v1', kind: o.kind ?? 'Deployment' },
    updatedAt: ts(o),
  }]
  const edges: GraphEdge[] = [
    { from: nodeId('namespace', ns(o)), to: id, kind: 'contains' },
  ]

  // Images from the pod template: a workload's images are known without any
  // pod existing, which matters for a scaled-to-zero or failing workload.
  for (const ref of templateImages(o)) {
    nodes.push(imageNode(ref))
    edges.push({ from: id, to: imageId(ref), kind: 'uses-image' })
  }

  return { nodes, edges }
}

function workloadStatus(o: Obj): GraphNode['status'] {
  if (o.kind === 'CronJob') return 'unknown'
  const desired = get<number>(o, 'spec.replicas') ?? get<number>(o, 'status.desiredNumberScheduled')
  const ready = get<number>(o, 'status.readyReplicas') ?? get<number>(o, 'status.numberReady') ?? 0
  if (desired === undefined) return 'unknown'
  if (desired === 0) return 'unknown'
  if (ready === 0) return 'failed'
  return ready < desired ? 'progressing' : 'healthy'
}

/** Container images declared on a pod template, init containers included. */
function templateImages(o: Obj): string[] {
  const paths = [
    'spec.template.spec.containers',
    'spec.template.spec.initContainers',
    // CronJob nests one level deeper.
    'spec.jobTemplate.spec.template.spec.containers',
    'spec.jobTemplate.spec.template.spec.initContainers',
  ]
  const out: string[] = []
  for (const p of paths) {
    for (const c of get<Array<{ image?: string }>>(o, p) ?? []) {
      if (c.image) out.push(c.image)
    }
  }
  return [...new Set(out)]
}

function imageNode(ref: string): GraphNode {
  const parsed = parseImage(ref)
  return {
    id: imageId(ref),
    kind: 'image',
    name: parsed.repository,
    props: {
      ref,
      ...(parsed.registry ? { registry: parsed.registry } : {}),
      ...(parsed.tag ? { tag: parsed.tag } : {}),
      ...(parsed.digest ? { digest: parsed.digest.slice(0, 19) } : {}),
      // A mutable tag is the thing that makes "which code is running"
      // unanswerable, so it is worth flagging on the node itself.
      ...(parsed.tag === 'latest' && !parsed.digest ? { mutableTag: true } : {}),
    },
  }
}

export function fromPod(o: Obj): Contribution {
  const id = nodeId('pod', name(o), ns(o))
  const phase = get<string>(o, 'status.phase') ?? 'Unknown'
  const statuses = get<Array<{ name?: string; ready?: boolean; restartCount?: number; state?: Record<string, unknown> }>>(o, 'status.containerStatuses') ?? []
  const restarts = statuses.reduce((n, c) => n + (c.restartCount ?? 0), 0)

  const nodes: GraphNode[] = [{
    id,
    kind: 'pod',
    name: name(o),
    namespace: ns(o),
    status: podStatus(phase, statuses),
    props: {
      phase,
      restarts,
      ...(get<string>(o, 'spec.nodeName') ? { node: get<string>(o, 'spec.nodeName')! } : {}),
      ...(get<string>(o, 'status.podIP') ? { ip: get<string>(o, 'status.podIP')! } : {}),
    },
    gvk: { group: '', version: 'v1', kind: 'Pod' },
    updatedAt: ts(o),
  }]
  const edges: GraphEdge[] = [{ from: nodeId('namespace', ns(o)), to: id, kind: 'contains' }]

  const nodeName = get<string>(o, 'spec.nodeName')
  if (nodeName) edges.push({ from: id, to: nodeId('node', nodeName), kind: 'runs-on' })

  // Owner: flatten ReplicaSet → Deployment. A pod's controller chain is an
  // implementation detail; "which Deployment is this pod part of" is the
  // question, and the ReplicaSet name carries the Deployment name as a prefix.
  const owner = (o.metadata?.ownerReferences ?? []).find((r) => r.controller) ?? o.metadata?.ownerReferences?.[0]
  if (owner?.name && owner.kind) {
    const workloadName = owner.kind === 'ReplicaSet'
      ? stripReplicaSetSuffix(owner.name, o.metadata?.labels?.['pod-template-hash'])
      : owner.name
    edges.push({ from: nodeId('workload', workloadName, ns(o)), to: id, kind: 'owns' })
  }

  for (const c of get<Array<{ image?: string }>>(o, 'spec.containers') ?? []) {
    if (!c.image) continue
    nodes.push(imageNode(c.image))
    edges.push({ from: id, to: imageId(c.image), kind: 'uses-image' })
  }

  for (const v of get<Array<Record<string, unknown>>>(o, 'spec.volumes') ?? []) {
    const cm = get<string>(v, 'configMap.name')
    const sec = get<string>(v, 'secret.secretName')
    const pvc = get<string>(v, 'persistentVolumeClaim.claimName')
    if (cm) {
      nodes.push({ id: nodeId('config', cm, ns(o)), kind: 'config', name: cm, namespace: ns(o) })
      edges.push({ from: id, to: nodeId('config', cm, ns(o)), kind: 'mounts' })
    }
    if (sec) {
      // Name only, never contents — the graph must never become a way to read
      // a Secret that the apiserver would have refused.
      nodes.push({ id: nodeId('secret', sec, ns(o)), kind: 'secret', name: sec, namespace: ns(o) })
      edges.push({ from: id, to: nodeId('secret', sec, ns(o)), kind: 'mounts' })
    }
    if (pvc) {
      nodes.push({ id: nodeId('volume', pvc, ns(o)), kind: 'volume', name: pvc, namespace: ns(o) })
      edges.push({ from: id, to: nodeId('volume', pvc, ns(o)), kind: 'mounts' })
    }
  }

  return { nodes, edges }
}

/**
 * A ReplicaSet's name is `<deployment>-<pod-template-hash>`; recover the
 * deployment. `api-7d9f8b6c4` → `api`.
 *
 * Prefer the `pod-template-hash` LABEL when the pod carries one — that is
 * Kubernetes stating the answer rather than us guessing it, and it is present
 * on every Deployment-managed pod.
 *
 * The fallback matters anyway (bare ReplicaSets, odd controllers), and the
 * obvious version of it is wrong: `/^[a-z0-9]{5,10}$/` matches "controller",
 * so `api-gateway-controller` would be truncated to `api-gateway` and every
 * one of its pods linked to a workload that does not exist. Kubernetes
 * generates these hashes with `rand.SafeEncodeString`, whose alphabet is
 * consonants and digits only — deliberately vowel-free so a hash can never
 * come out as a word. Testing for that alphabet is the difference between a
 * heuristic and a rule.
 */
const HASH_ALPHABET = /^[bcdfghjklmnpqrstvwxz2456789]{5,10}$/

export function stripReplicaSetSuffix(rsName: string, podTemplateHash?: string): string {
  if (podTemplateHash && rsName.endsWith(`-${podTemplateHash}`)) {
    return rsName.slice(0, -(podTemplateHash.length + 1))
  }
  const dash = rsName.lastIndexOf('-')
  if (dash <= 0) return rsName
  return HASH_ALPHABET.test(rsName.slice(dash + 1)) ? rsName.slice(0, dash) : rsName
}

function podStatus(phase: string, statuses: Array<{ ready?: boolean; state?: Record<string, unknown> }>): GraphNode['status'] {
  if (phase === 'Succeeded') return 'healthy'
  if (phase === 'Failed') return 'failed'
  if (phase === 'Pending') return 'progressing'
  const waiting = statuses.some((c) => Boolean(c.state?.waiting))
  if (waiting) return 'degraded'
  return statuses.length && statuses.every((c) => c.ready) ? 'healthy' : 'degraded'
}

export function fromService(o: Obj): Contribution {
  const id = nodeId('service', name(o), ns(o))
  const selector = get<Record<string, string>>(o, 'spec.selector')
  return {
    nodes: [{
      id,
      kind: 'service',
      name: name(o),
      namespace: ns(o),
      props: {
        type: get<string>(o, 'spec.type') ?? 'ClusterIP',
        ...(get<string>(o, 'spec.clusterIP') ? { clusterIP: get<string>(o, 'spec.clusterIP')! } : {}),
        ...(selector ? { selector: Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',') } : {}),
      },
      gvk: { group: '', version: 'v1', kind: 'Service' },
      updatedAt: ts(o),
    }],
    edges: [{ from: nodeId('namespace', ns(o)), to: id, kind: 'contains' }],
  }
}

export function fromIngress(o: Obj): Contribution {
  const id = nodeId('ingress', name(o), ns(o))
  const rules = get<Array<Record<string, unknown>>>(o, 'spec.rules') ?? []
  const hosts = rules.map((r) => get<string>(r, 'host')).filter(Boolean) as string[]
  const edges: GraphEdge[] = [{ from: nodeId('namespace', ns(o)), to: id, kind: 'contains' }]

  for (const rule of rules) {
    for (const p of get<Array<Record<string, unknown>>>(rule, 'http.paths') ?? []) {
      const svc = get<string>(p, 'backend.service.name')
      if (svc) edges.push({ from: id, to: nodeId('service', svc, ns(o)), kind: 'routes-to' })
    }
  }

  return {
    nodes: [{
      id,
      kind: 'ingress',
      name: name(o),
      namespace: ns(o),
      props: { ...(hosts.length ? { hosts: hosts.join(', ') } : {}) },
      gvk: { group: 'networking.k8s.io', version: 'v1', kind: 'Ingress' },
      updatedAt: ts(o),
    }],
    edges,
  }
}

export function fromApplication(o: Obj): Contribution {
  const id = nodeId('application', name(o))
  const health = get<string>(o, 'status.health.status') ?? 'Unknown'
  const sync = get<string>(o, 'status.sync.status') ?? 'Unknown'
  const repoURL = get<string>(o, 'spec.source.repoURL')
  const path = get<string>(o, 'spec.source.path')

  const nodes: GraphNode[] = [{
    id,
    kind: 'application',
    name: name(o),
    namespace: ns(o),
    status: health === 'Healthy' ? (sync === 'Synced' ? 'healthy' : 'degraded')
      : health === 'Degraded' || health === 'Missing' ? 'failed'
      : health === 'Progressing' ? 'progressing'
      : 'unknown',
    props: {
      health,
      sync,
      ...(get<string>(o, 'spec.destination.namespace') ? { destination: get<string>(o, 'spec.destination.namespace')! } : {}),
      ...(get<string>(o, 'status.sync.revision') ? { revision: get<string>(o, 'status.sync.revision')!.slice(0, 7) } : {}),
    },
    gvk: { group: 'argoproj.io', version: 'v1alpha1', kind: 'Application' },
    updatedAt: ts(o),
  }]
  const edges: GraphEdge[] = []

  if (repoURL) {
    const repoName = repoURL.replace(/\.git$/, '').split('/').slice(-2).join('/')
    nodes.push({
      id: nodeId('repository', repoName),
      kind: 'repository',
      name: repoName,
      props: { url: repoURL, ...(path ? { path } : {}) },
    })
    edges.push({ from: id, to: nodeId('repository', repoName), kind: 'sources-from' })
  }

  // `status.resources` is Argo CD telling us exactly what it manages — the
  // only place this mapping exists without re-rendering the manifests.
  for (const r of get<Array<{ kind?: string; name?: string; namespace?: string }>>(o, 'status.resources') ?? []) {
    if (!r.name) continue
    const target = WORKLOAD_KINDS.has(r.kind ?? '') && r.kind !== 'ReplicaSet'
      ? nodeId('workload', r.name, r.namespace ?? '')
      : r.kind === 'Service'
      ? nodeId('service', r.name, r.namespace ?? '')
      : null
    if (target) edges.push({ from: id, to: target, kind: 'manages' })
  }

  const destNs = get<string>(o, 'spec.destination.namespace')
  if (destNs) edges.push({ from: id, to: nodeId('namespace', destNs), kind: 'manages' })

  return { nodes, edges }
}

export function fromPipelineRun(o: Obj): Contribution {
  const id = nodeId('pipelinerun', name(o), ns(o))
  const cond = (get<Array<{ type?: string; status?: string; reason?: string }>>(o, 'status.conditions') ?? [])
    .find((c) => c.type === 'Succeeded')
  return {
    nodes: [{
      id,
      kind: 'pipelinerun',
      name: name(o),
      namespace: ns(o),
      status: cond?.status === 'True' ? 'healthy' : cond?.status === 'False' ? 'failed' : 'progressing',
      props: {
        ...(cond?.reason ? { reason: cond.reason } : {}),
        ...(get<string>(o, 'status.completionTime') ? { completed: get<string>(o, 'status.completionTime')! } : {}),
      },
      gvk: { group: 'tekton.dev', version: 'v1', kind: 'PipelineRun' },
      updatedAt: ts(o),
    }],
    edges: [{ from: nodeId('namespace', ns(o)), to: id, kind: 'contains' }],
  }
}
