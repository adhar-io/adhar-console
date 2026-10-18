/**
 * The composition graph behind a catalog entity — pure model, no React.
 *
 * A catalog entity on Adhar is backed by platform objects: a Crossplane
 * composite (the `platform.adhar.io` Application XR for a service, Team /
 * Organisation / Project XRs for tenancy), whatever that composite composed
 * (nested XRs, provider-kubernetes `Object`s, Argo CD Applications, Kargo
 * stages…), and the Argo CD Applications that deploy it, each with its own
 * live resource tree. This module turns those objects into one graph:
 *
 *   root (XR / claim / Argo app)
 *     → composed resources  (`spec.crossplane.resourceRefs`, v1 `spec.resourceRefs`,
 *                             claim `spec.resourceRef`, `status.resourceRefs`)
 *       → nested composed resources (recursively)
 *       → Argo CD managed resources (`resource-tree`, else `status.resources`)
 *         → their children (ReplicaSet → Pod, via Argo's parentRefs)
 *
 * Each node carries a live status derived from what the object itself says:
 * Crossplane Synced/Ready conditions, Argo sync/health, workload readiness.
 *
 * The walk takes an injected fetcher so the tests can drive it with fixtures.
 */

/* ───────────────────────── types ───────────────────────── */

export interface ObjRef {
  apiVersion?: string
  group?: string
  version?: string
  kind: string
  name: string
  namespace?: string
}

export interface KMeta {
  name: string
  namespace?: string
  uid?: string
  resourceVersion?: string
  generation?: number
  creationTimestamp?: string
  deletionTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid: string; controller?: boolean }>
  managedFields?: unknown[]
}

export interface KObj {
  apiVersion?: string
  kind?: string
  metadata: KMeta
  spec?: Record<string, unknown>
  status?: Record<string, unknown>
  [k: string]: unknown
}

export interface Condition {
  type: string
  status: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

/** One node of Argo CD's `resource-tree` response (fields we read). */
export interface ArgoTreeNode {
  group?: string
  version?: string
  kind: string
  name: string
  namespace?: string
  uid?: string
  createdAt?: string
  health?: { status?: string; message?: string }
  info?: Array<{ name?: string; value?: string }>
  parentRefs?: Array<{ group?: string; kind?: string; name?: string; namespace?: string; uid?: string }>
  /** Container images, for workloads and Pods. */
  images?: string[]
  /** Routing facts Argo derives: hostnames, target Services, target pod labels. */
  networkingInfo?: ArgoNetworkingInfo
}

export interface ArgoNetworkingInfo {
  ingress?: Array<{ hostname?: string; ip?: string }>
  externalURLs?: string[]
  targetLabels?: Record<string, string>
  targetRefs?: Array<{ group?: string; kind?: string; name?: string; namespace?: string }>
  labels?: Record<string, string>
}

export type HealthLevel = 'healthy' | 'progressing' | 'degraded' | 'suspended' | 'missing' | 'unknown' | 'none'

export interface NodeStatus {
  level: HealthLevel
  /** One or two words for the badge. */
  label: string
  reason?: string
  message?: string
  /** Argo CD sync status, when Argo manages the resource. */
  sync?: string
  /** Argo CD health status, verbatim. */
  health?: string
  /** Argo would prune it on the next sync (no longer in Git). */
  prune?: boolean
}

export type NodeSource = 'composite' | 'claim' | 'composed' | 'argo-app' | 'argo-resource' | 'manifest'

export interface FetchError {
  status: number
  message: string
}

export interface CompNode {
  id: string
  group: string
  version?: string
  kind: string
  name: string
  namespace?: string
  source: NodeSource
  status: NodeStatus
  conditions: Condition[]
  createdAt?: string
  uid?: string
  composition?: string
  compositionRevision?: string
  /** Argo CD Application that manages this resource. */
  argoApp?: { name: string; namespace?: string }
  info?: Array<{ name: string; value: string }>
  images?: string[]
  networking?: ArgoNetworkingInfo
  /** A display-only node standing for many same-kind siblings (see `stackSiblings`). */
  stack?: { kind: string; parent: string; members: string[]; byLevel: Partial<Record<HealthLevel, number>> }
  children: string[]
  parents: string[]
  error?: FetchError
  /** The live object, when the walk fetched it. */
  object?: KObj
}

export interface CompositionGraph {
  nodes: Record<string, CompNode>
  roots: string[]
  /** The walk stopped at the node or depth cap. */
  truncated: boolean
}

export interface CompositionFetcher {
  get(ref: ObjRef): Promise<KObj>
  /** Argo CD's live resource tree for one app. Optional; `status.resources` is the fallback. */
  argoTree?(app: { name: string; namespace?: string }): Promise<ArgoTreeNode[]>
  /**
   * Canonicalise a ref before it is identified — the real fetcher drops the
   * namespace a ref inherited when discovery says the kind is cluster-scoped
   * (a Namespace wrapped by a namespaced provider-kubernetes Object).
   */
  normalize?(ref: ObjRef): ObjRef
}

/* ───────────────────────── identity ───────────────────────── */

export function splitApiVersion(apiVersion: string | undefined): { group: string; version: string } {
  if (!apiVersion) return { group: '', version: '' }
  const i = apiVersion.lastIndexOf('/')
  return i < 0 ? { group: '', version: apiVersion } : { group: apiVersion.slice(0, i), version: apiVersion.slice(i + 1) }
}

export function refGroup(ref: ObjRef): string {
  return ref.group ?? splitApiVersion(ref.apiVersion).group
}

export function refVersion(ref: ObjRef): string | undefined {
  return ref.version ?? (splitApiVersion(ref.apiVersion).version || undefined)
}

export function nodeId(ref: { group?: string; apiVersion?: string; kind: string; namespace?: string; name: string }): string {
  const group = ref.group ?? splitApiVersion(ref.apiVersion).group
  return `${group || 'core'}/${ref.kind}/${ref.namespace ?? ''}/${ref.name}`
}

export function apiVersionOf(n: { group: string; version?: string }): string | undefined {
  if (!n.version) return undefined
  return n.group ? `${n.group}/${n.version}` : n.version
}

/* ───────────────────────── reading objects ───────────────────────── */

export function conditionsOf(obj: KObj | undefined): Condition[] {
  const c = obj?.status?.conditions
  return Array.isArray(c) ? c.filter((x): x is Condition => Boolean(x) && typeof x === 'object' && typeof (x as Condition).type === 'string') : []
}

function cond(list: readonly Condition[], type: string): Condition | undefined {
  return list.find((c) => c.type === type)
}

/** Composed resources, wherever this Crossplane version recorded them. */
export function composedRefs(obj: KObj): ObjRef[] {
  const spec = obj.spec ?? {}
  const cp = spec.crossplane as { resourceRefs?: unknown } | undefined
  for (const candidate of [cp?.resourceRefs, spec.resourceRefs, obj.status?.resourceRefs]) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate.filter((r): r is ObjRef =>
        Boolean(r) && typeof r === 'object' && typeof (r as ObjRef).kind === 'string' && typeof (r as ObjRef).name === 'string'
      ).map((r) => ({
        ...r,
        // A v2 namespaced XR's composed resources default to its namespace.
        namespace: r.namespace ?? (isNamespacedComposite(obj) ? obj.metadata.namespace : undefined),
      }))
    }
  }
  return []
}

/** A Crossplane v2 namespaced XR keeps its machinery under `spec.crossplane`. */
function isNamespacedComposite(obj: KObj): boolean {
  return Boolean(obj.metadata.namespace && obj.spec && typeof obj.spec.crossplane === 'object')
}

/** A claim points at its composite through `spec.resourceRef`. */
export function claimTarget(obj: KObj): ObjRef | undefined {
  const r = obj.spec?.resourceRef as ObjRef | undefined
  return r && typeof r.kind === 'string' && typeof r.name === 'string' ? r : undefined
}

export function compositionOf(obj: KObj): { composition?: string; revision?: string } {
  const spec = obj.spec ?? {}
  const cp = (spec.crossplane ?? {}) as Record<string, unknown>
  const name = (o: unknown) => (o && typeof o === 'object' ? (o as { name?: string }).name : undefined)
  return {
    composition: name(cp.compositionRef) ?? name(spec.compositionRef),
    revision: name(cp.compositionRevisionRef) ?? name(spec.compositionRevisionRef),
  }
}

export function isComposite(obj: KObj): boolean {
  const spec = obj.spec ?? {}
  return Boolean(spec.crossplane || spec.compositionRef || spec.compositionSelector || spec.resourceRefs || spec.compositionRevisionRef)
}

export function isClaim(obj: KObj): boolean {
  return Boolean(claimTarget(obj)) && !isComposite(obj)
}

export function isArgoApplication(ref: { group?: string; apiVersion?: string; kind: string }): boolean {
  return (ref.group ?? splitApiVersion(ref.apiVersion).group) === 'argoproj.io' && ref.kind === 'Application'
}

/** provider-kubernetes `Object` (cluster-scoped v1 or namespaced `.m.` v2). */
export function isProviderKubernetesObject(ref: { group?: string; apiVersion?: string; kind: string }): boolean {
  const g = ref.group ?? splitApiVersion(ref.apiVersion).group
  return ref.kind === 'Object' && /^kubernetes\.(m\.)?crossplane\.io$/.test(g)
}

/** The manifest a provider-kubernetes Object wraps. */
export function wrappedManifest(obj: KObj): ObjRef | undefined {
  const fp = (obj.spec?.forProvider ?? {}) as { manifest?: KObj }
  const m = fp.manifest
  if (!m || typeof m !== 'object' || typeof m.kind !== 'string' || !m.metadata?.name) return undefined
  return { apiVersion: m.apiVersion, kind: m.kind, name: m.metadata.name, namespace: m.metadata.namespace ?? obj.metadata.namespace }
}

/* ───────────────────────── status ───────────────────────── */

export const LEVEL_SEVERITY: Record<HealthLevel, number> = {
  degraded: 6,
  missing: 5,
  progressing: 4,
  suspended: 3,
  unknown: 2,
  healthy: 1,
  none: 0,
}

export function worse(a: HealthLevel, b: HealthLevel): HealthLevel {
  return LEVEL_SEVERITY[a] >= LEVEL_SEVERITY[b] ? a : b
}

export function isUnhealthy(level: HealthLevel): boolean {
  return level === 'degraded' || level === 'missing' || level === 'progressing' || level === 'suspended'
}

export function argoHealthLevel(status: string | undefined): HealthLevel {
  switch (status) {
    case 'Healthy':
      return 'healthy'
    case 'Progressing':
      return 'progressing'
    case 'Degraded':
      return 'degraded'
    case 'Suspended':
      return 'suspended'
    case 'Missing':
      return 'missing'
    case 'Unknown':
      return 'unknown'
    default:
      return 'none'
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Where an object stands, from what it says about itself. Most specific
 * evidence first: being deleted; Crossplane conditions; workload readiness;
 * Pod phase; an Argo CD Application's own health; otherwise "exists".
 */
export function deriveStatus(obj: KObj): NodeStatus {
  const conditions = conditionsOf(obj)
  const { group } = splitApiVersion(obj.apiVersion)
  const kind = obj.kind ?? ''

  if (obj.metadata.deletionTimestamp) return { level: 'progressing', label: 'Deleting' }

  if (group === 'argoproj.io' && kind === 'Application') {
    const st = obj.status ?? {}
    const health = (st.health as { status?: string; message?: string } | undefined) ?? {}
    const sync = (st.sync as { status?: string } | undefined)?.status
    const op = st.operationState as { phase?: string; message?: string } | undefined
    const level = argoHealthLevel(health.status)
    const opFailed = op?.phase === 'Failed' || op?.phase === 'Error'
    return {
      level: opFailed ? worse(level, 'degraded') : level === 'none' ? 'unknown' : level,
      label: health.status ?? 'Unknown',
      sync,
      health: health.status,
      reason: opFailed ? `Sync ${op?.phase}` : undefined,
      message: (opFailed ? op?.message : undefined) ?? health.message,
    }
  }

  if (kind === 'Pod' && group === '') return podStatus(obj)
  if ((kind === 'Deployment' || kind === 'StatefulSet' || kind === 'ReplicaSet' || kind === 'DaemonSet') && (group === 'apps' || group === '')) {
    return workloadStatus(obj, conditions)
  }

  const ready = cond(conditions, 'Ready')
  const synced = cond(conditions, 'Synced')
  if (ready || synced) {
    if (obj.metadata.annotations?.['crossplane.io/paused'] === 'true') {
      return { level: 'suspended', label: 'Paused', reason: 'Paused', message: 'Reconciliation is paused (crossplane.io/paused).' }
    }
    if (synced?.status === 'False') {
      return { level: 'degraded', label: 'Sync failed', reason: synced.reason, message: synced.message }
    }
    if (ready?.status === 'True') return { level: 'healthy', label: 'Ready', reason: ready.reason, message: ready.message }
    if (ready?.status === 'False') {
      const failing = /error|fail|unavailable|invalid/i.test(`${ready.reason ?? ''}`)
      return { level: failing ? 'degraded' : 'progressing', label: failing ? 'Not ready' : (ready.reason || 'Creating'), reason: ready.reason, message: ready.message }
    }
    if (!ready && synced?.status === 'True') return { level: 'healthy', label: 'Synced', reason: synced.reason, message: synced.message }
    return { level: 'unknown', label: 'Unknown', reason: ready?.reason ?? synced?.reason, message: ready?.message ?? synced?.message }
  }

  // Generic conditions: Available / Established / anything False with a reason.
  const available = cond(conditions, 'Available') ?? cond(conditions, 'Established') ?? cond(conditions, 'Healthy')
  if (available) {
    return available.status === 'True'
      ? { level: 'healthy', label: available.type, reason: available.reason, message: available.message }
      : { level: 'degraded', label: `Not ${available.type.toLowerCase()}`, reason: available.reason, message: available.message }
  }
  const phase = obj.status?.phase
  if (typeof phase === 'string') {
    if (/^(Bound|Active|Running|Succeeded|Ready|Available|Healthy|Established)$/i.test(phase)) return { level: 'healthy', label: phase }
    if (/^(Pending|Progressing|Creating|Provisioning|Terminating)$/i.test(phase)) return { level: 'progressing', label: phase }
    if (/^(Failed|Error|Lost|Degraded)$/i.test(phase)) return { level: 'degraded', label: phase }
    return { level: 'unknown', label: phase }
  }
  return { level: 'none', label: 'Live' }
}

function workloadStatus(obj: KObj, conditions: readonly Condition[]): NodeStatus {
  const spec = obj.spec ?? {}
  const st = obj.status ?? {}
  const kind = obj.kind
  const want = kind === 'DaemonSet' ? num(st.desiredNumberScheduled) : spec.replicas === undefined ? 1 : num(spec.replicas)
  const ready = kind === 'DaemonSet' ? num(st.numberReady) : kind === 'Deployment' ? num(st.availableReplicas) : num(st.readyReplicas)
  const stalled = conditions.find((c) => c.type === 'Progressing' && c.reason === 'ProgressDeadlineExceeded')
  const failure = conditions.find((c) => c.type === 'ReplicaFailure' && c.status === 'True')
  const label = `${ready}/${want} ready`
  if (stalled) return { level: 'degraded', label, reason: stalled.reason, message: stalled.message }
  if (failure) return { level: 'degraded', label, reason: failure.reason, message: failure.message }
  if (want === 0) return { level: 'suspended', label: 'Scaled to 0' }
  if (ready >= want) return { level: 'healthy', label }
  return { level: 'progressing', label }
}

function podStatus(obj: KObj): NodeStatus {
  const st = obj.status ?? {}
  const phase = typeof st.phase === 'string' ? st.phase : 'Unknown'
  const statuses = (Array.isArray(st.containerStatuses) ? st.containerStatuses : []) as Array<{
    ready?: boolean
    restartCount?: number
    state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string; message?: string; exitCode?: number } }
  }>
  const waiting = statuses.map((c) => c.state?.waiting).find((w) => w?.reason)
  const restarts = statuses.reduce((n, c) => n + num(c.restartCount), 0)
  if (waiting && /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|InvalidImageName/.test(waiting.reason ?? '')) {
    return { level: 'degraded', label: waiting.reason!, reason: waiting.reason, message: waiting.message ?? (restarts ? `${restarts} restarts` : undefined) }
  }
  if (phase === 'Succeeded') return { level: 'healthy', label: 'Completed' }
  if (phase === 'Failed') return { level: 'degraded', label: 'Failed', reason: st.reason as string | undefined, message: st.message as string | undefined }
  if (phase === 'Running') {
    const all = statuses.length > 0 && statuses.every((c) => c.ready)
    return all
      ? { level: 'healthy', label: 'Running', message: restarts ? `${restarts} restarts` : undefined }
      : { level: 'progressing', label: 'Starting', reason: waiting?.reason, message: waiting?.message }
  }
  if (phase === 'Pending') return { level: 'progressing', label: waiting?.reason ?? 'Pending', message: waiting?.message }
  return { level: 'unknown', label: phase }
}

/** Status for a ref the walk could not read. */
export function errorStatus(err: FetchError): NodeStatus {
  if (err.status === 404) return { level: 'missing', label: 'Missing', reason: 'NotFound', message: err.message }
  if (err.status === 403) return { level: 'unknown', label: 'No access', reason: 'Forbidden', message: err.message }
  return { level: 'unknown', label: 'Unreadable', reason: err.status ? `HTTP ${err.status}` : 'Error', message: err.message }
}

export function toFetchError(e: unknown): FetchError {
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 0
  const message = e instanceof Error ? e.message : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : String(e)
  return { status, message }
}

/* ───────────────────────── the walk ───────────────────────── */

export interface WalkOptions {
  maxDepth?: number
  maxNodes?: number
}

export interface RootInput {
  ref: ObjRef
  /** Already-fetched object (the resolver read it), to skip a second GET. */
  object?: KObj
}

interface QueueItem {
  ref: ObjRef
  parent?: string
  depth: number
  source: NodeSource
  object?: KObj
  argoApp?: { name: string; namespace?: string }
  extraParents?: string[]
}

function sourceFor(obj: KObj | undefined, fallback: NodeSource): NodeSource {
  if (!obj) return fallback
  if (isArgoApplication({ apiVersion: obj.apiVersion, kind: obj.kind ?? '' })) return 'argo-app'
  if (isComposite(obj)) return 'composite'
  if (isClaim(obj)) return 'claim'
  return fallback
}

function link(nodes: Record<string, CompNode>, parent: string | undefined, child: string): void {
  if (!parent || parent === child) return
  const p = nodes[parent]
  const c = nodes[child]
  if (!p || !c) return
  if (!p.children.includes(child)) p.children.push(child)
  if (!c.parents.includes(parent)) c.parents.push(parent)
}

/** Would linking parent → child close a cycle? */
function isAncestor(nodes: Record<string, CompNode>, candidate: string, of: string): boolean {
  const seen = new Set<string>()
  const stack = [of]
  while (stack.length) {
    const id = stack.pop()!
    if (id === candidate) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const p of nodes[id]?.parents ?? []) stack.push(p)
  }
  return false
}

/**
 * Walk from the roots, level by level (each level's reads run concurrently),
 * following composed refs, claim → composite, Object → wrapped manifest and
 * Argo CD app → managed resources. Every object is read once however many
 * parents point at it; unreadable refs become nodes that say why.
 */
export async function buildCompositionGraph(
  roots: readonly RootInput[],
  fetcher: CompositionFetcher,
  opts: WalkOptions = {},
): Promise<CompositionGraph> {
  const maxDepth = opts.maxDepth ?? 8
  const maxNodes = opts.maxNodes ?? 400
  const nodes: Record<string, CompNode> = {}
  const rootIds: string[] = []
  let truncated = false
  let level: QueueItem[] = roots.map((r) => ({ ref: r.ref, depth: 0, source: 'composed' as NodeSource, object: r.object }))

  while (level.length) {
    const next: QueueItem[] = []
    // Collapse duplicates within the level before reading anything.
    const fresh = new Map<string, QueueItem>()
    for (const raw of level) {
      const item = fetcher.normalize ? { ...raw, ref: fetcher.normalize(raw.ref) } : raw
      const id = nodeId({ group: refGroup(item.ref), kind: item.ref.kind, namespace: item.ref.namespace, name: item.ref.name })
      if (item.depth === 0 && !rootIds.includes(id)) rootIds.push(id)
      if (nodes[id]) {
        if (item.parent && !isAncestor(nodes, id, item.parent)) link(nodes, item.parent, id)
        continue
      }
      if (fresh.has(id)) {
        const first = fresh.get(id)!
        if (item.parent) first.extraParents = [...(first.extraParents ?? []), item.parent]
        continue
      }
      if (Object.keys(nodes).length + fresh.size >= maxNodes) {
        truncated = true
        continue
      }
      fresh.set(id, item)
    }

    const results = await Promise.all(
      [...fresh.entries()].map(async ([id, item]) => {
        if (item.object) return { id, item, obj: item.object as KObj | undefined, err: undefined as FetchError | undefined }
        try {
          return { id, item, obj: await fetcher.get(item.ref), err: undefined }
        } catch (e) {
          return { id, item, obj: undefined, err: toFetchError(e) }
        }
      }),
    )

    const argoExpansions: Array<{ id: string; item: QueueItem; obj: KObj }> = []
    for (const { id, item, obj, err } of results) {
      const group = obj ? splitApiVersion(obj.apiVersion).group : refGroup(item.ref)
      const comp = obj ? compositionOf(obj) : {}
      const node: CompNode = {
        id,
        group,
        version: obj ? splitApiVersion(obj.apiVersion).version : refVersion(item.ref),
        kind: obj?.kind ?? item.ref.kind,
        name: item.ref.name,
        namespace: obj?.metadata.namespace ?? item.ref.namespace,
        source: sourceFor(obj, item.source),
        status: obj ? deriveStatus(obj) : errorStatus(err!),
        conditions: conditionsOf(obj),
        createdAt: obj?.metadata.creationTimestamp,
        uid: obj?.metadata.uid,
        composition: comp.composition,
        compositionRevision: comp.revision,
        argoApp: item.argoApp,
        children: [],
        parents: [],
        error: err,
        object: obj,
      }
      nodes[id] = node
      link(nodes, item.parent, id)
      for (const extra of item.extraParents ?? []) link(nodes, extra, id)
      if (!obj) continue

      if (item.depth >= maxDepth) {
        if (composedRefs(obj).length || claimTarget(obj)) truncated = true
        continue
      }
      for (const ref of composedRefs(obj)) next.push({ ref, parent: id, depth: item.depth + 1, source: 'composed' })
      const claimRef = claimTarget(obj)
      if (claimRef && !isComposite(obj)) next.push({ ref: claimRef, parent: id, depth: item.depth + 1, source: 'composite' })
      if (isProviderKubernetesObject({ apiVersion: obj.apiVersion, kind: obj.kind ?? '' })) {
        const m = wrappedManifest(obj)
        if (m) next.push({ ref: m, parent: id, depth: item.depth + 1, source: 'manifest' })
      }
      if (node.source === 'argo-app') argoExpansions.push({ id, item, obj })
    }

    // Argo CD apps: their managed resources come from Argo itself (one call per
    // app), not from N apiserver reads. Resources that are themselves platform
    // composites are queued so the walk continues into what THEY composed.
    for (const { id, item, obj } of argoExpansions) {
      const app = { name: obj.metadata.name, namespace: obj.metadata.namespace }
      let tree: ArgoTreeNode[] | undefined
      if (fetcher.argoTree) {
        try {
          tree = await fetcher.argoTree(app)
        } catch {
          tree = undefined
        }
      }
      const added = addArgoResources(nodes, id, obj, tree, app, maxNodes)
      if (added.truncated) truncated = true
      if (item.depth + 2 > maxDepth) continue
      // Platform composites Argo deploys: read them so the walk continues into
      // what THEY composed. The node keeps Argo's sync/health beside its own.
      await Promise.all(added.expand.map(async (childId) => {
        const existing = nodes[childId]
        try {
          const live = await fetcher.get({ group: existing.group, version: existing.version, kind: existing.kind, name: existing.name, namespace: existing.namespace })
          const s = deriveStatus(live)
          existing.status = { ...s, sync: existing.status.sync, health: existing.status.health }
          existing.conditions = conditionsOf(live)
          existing.object = live
          existing.uid = live.metadata.uid ?? existing.uid
          existing.createdAt = live.metadata.creationTimestamp ?? existing.createdAt
          const comp = compositionOf(live)
          existing.composition = comp.composition
          existing.compositionRevision = comp.revision
          existing.source = sourceFor(live, existing.source)
          for (const ref of composedRefs(live)) next.push({ ref, parent: childId, depth: item.depth + 2, source: 'composed' })
          const claimRef = claimTarget(live)
          if (claimRef && !isComposite(live)) next.push({ ref: claimRef, parent: childId, depth: item.depth + 2, source: 'composite' })
        } catch {
          // Argo's own view of it stands.
        }
      }))
    }
    level = next.filter((q) => q.depth <= maxDepth)
  }

  return { nodes, roots: rootIds.filter((id) => nodes[id]), truncated }
}

/**
 * Add an Argo CD app's managed resources under its node. The live tree is
 * preferred (it has children like Pods and per-resource health); without it,
 * the app's own `status.resources` gives the top level with sync + health.
 * Returns the ids of resources worth expanding as composites.
 */
export function addArgoResources(
  nodes: Record<string, CompNode>,
  appId: string,
  app: KObj,
  tree: readonly ArgoTreeNode[] | undefined,
  appRef: { name: string; namespace?: string },
  maxNodes = 400,
): { expand: string[]; truncated: boolean } {
  const expand: string[] = []
  let truncated = false
  const statusResources = (Array.isArray(app.status?.resources) ? app.status!.resources : []) as Array<{
    group?: string
    version?: string
    kind: string
    name: string
    namespace?: string
    status?: string
    health?: { status?: string; message?: string }
    requiresPruning?: boolean
  }>
  const syncById = new Map<string, string | undefined>()
  const pruneById = new Set<string>()
  for (const r of statusResources) {
    syncById.set(nodeId(r), r.status)
    if (r.requiresPruning) pruneById.add(nodeId(r))
  }

  const make = (r: { group?: string; version?: string; kind: string; name: string; namespace?: string; uid?: string; createdAt?: string; health?: { status?: string; message?: string }; info?: ArgoTreeNode['info']; images?: string[]; networkingInfo?: ArgoNetworkingInfo }): string | undefined => {
    const id = nodeId(r)
    if (id === appId) return undefined
    const sync = syncById.get(id)
    const h = r.health?.status
    const level = argoHealthLevel(h)
    const status: NodeStatus = {
      level: level === 'none' ? (sync === 'OutOfSync' ? 'progressing' : 'none') : level,
      label: h ?? (sync === 'OutOfSync' ? 'OutOfSync' : sync ?? 'Live'),
      sync,
      health: h,
      message: r.health?.message,
      prune: pruneById.has(id) || undefined,
    }
    const existing = nodes[id]
    if (existing) {
      // Already known from the XR walk: add Argo's view without losing ours.
      existing.status = { ...existing.status, sync: sync ?? existing.status.sync, health: h ?? existing.status.health }
      existing.argoApp ??= appRef
      return id
    }
    if (Object.keys(nodes).length >= maxNodes) {
      truncated = true
      return undefined
    }
    nodes[id] = {
      id,
      group: r.group ?? '',
      version: r.version,
      kind: r.kind,
      name: r.name,
      namespace: r.namespace,
      source: 'argo-resource',
      status,
      conditions: [],
      createdAt: r.createdAt,
      uid: r.uid,
      argoApp: appRef,
      info: (r.info ?? []).filter((i): i is { name: string; value: string } => Boolean(i?.name) && i?.value !== undefined).map((i) => ({ name: i.name, value: String(i.value) })),
      images: r.images?.length ? [...r.images] : undefined,
      networking: r.networkingInfo,
      children: [],
      parents: [],
    }
    if (/(^|\.)adhar\.io$|crossplane\.io$/.test(r.group ?? '')) expand.push(id)
    return id
  }

  if (tree && tree.length) {
    const byUid = new Map<string, string>()
    const ids: Array<[ArgoTreeNode, string]> = []
    for (const n of tree) {
      const id = make(n)
      if (!id) continue
      ids.push([n, id])
      if (n.uid) byUid.set(n.uid, id)
    }
    for (const [n, id] of ids) {
      const parents = (n.parentRefs ?? [])
        .map((p) => (p.uid && byUid.get(p.uid)) || (p.kind && p.name ? nodeId({ group: p.group ?? '', kind: p.kind, namespace: p.namespace, name: p.name }) : undefined))
        .filter((p): p is string => Boolean(p && nodes[p] && p !== id))
      if (parents.length === 0) link(nodes, appId, id)
      else for (const p of parents) if (!isAncestor(nodes, id, p)) link(nodes, p, id)
    }
  } else {
    for (const r of statusResources) {
      const id = make(r)
      if (id) link(nodes, appId, id)
    }
  }
  return { expand, truncated }
}

/* ───────────────────────── summaries & views ───────────────────────── */

export interface GraphSummary {
  total: number
  byLevel: Record<HealthLevel, number>
  outOfSync: number
  worst: HealthLevel
}

export function summarize(graph: CompositionGraph): GraphSummary {
  const byLevel: Record<HealthLevel, number> = { healthy: 0, progressing: 0, degraded: 0, suspended: 0, missing: 0, unknown: 0, none: 0 }
  let outOfSync = 0
  let worst: HealthLevel = 'none'
  for (const n of Object.values(graph.nodes)) {
    byLevel[n.status.level]++
    if (n.status.sync === 'OutOfSync') outOfSync++
    worst = worse(worst, n.status.level)
  }
  return { total: Object.keys(graph.nodes).length, byLevel, outOfSync, worst }
}

/** Worst status anywhere under (and including) a node — for collapsed subtrees. */
export function rollup(graph: CompositionGraph, id: string): HealthLevel {
  let worst: HealthLevel = 'none'
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    const n = graph.nodes[cur]
    if (!n) continue
    worst = worse(worst, n.status.level)
    stack.push(...n.children)
  }
  return worst
}

export interface GraphFilter {
  search?: string
  kind?: string
  unhealthyOnly?: boolean
}

export function hasFilter(f: GraphFilter): boolean {
  return Boolean(f.search?.trim() || f.kind || f.unhealthyOnly)
}

/**
 * Which nodes to show: those that match, plus every ancestor of a match so a
 * hit deep in the tree keeps its path to the root. `undefined` = show all.
 */
export function visibleNodes(graph: CompositionGraph, f: GraphFilter): Set<string> | undefined {
  if (!hasFilter(f)) return undefined
  const needle = (f.search ?? '').trim().toLowerCase()
  return visibleWhere(graph, (n) => {
    if (f.kind && n.kind !== f.kind) return false
    if (f.unhealthyOnly && !(isUnhealthy(n.status.level) || n.status.sync === 'OutOfSync')) return false
    if (needle && !matchesText(n, needle)) return false
    return true
  })
}

export function matchesText(n: CompNode, needle: string): boolean {
  return `${n.kind} ${n.name} ${n.namespace ?? ''} ${n.status.label} ${n.status.reason ?? ''}`.toLowerCase().includes(needle)
}

/** Nodes matching `pred`, plus every ancestor of a match (a hit keeps its path to the root). */
export function visibleWhere(graph: CompositionGraph, pred: (n: CompNode) => boolean): Set<string> {
  const out = new Set<string>()
  for (const n of Object.values(graph.nodes)) {
    if (!pred(n)) continue
    const stack = [n.id]
    while (stack.length) {
      const id = stack.pop()!
      if (out.has(id)) continue
      out.add(id)
      stack.push(...(graph.nodes[id]?.parents ?? []))
    }
  }
  return out
}

export function kindsOf(graph: CompositionGraph): string[] {
  return [...new Set(Object.values(graph.nodes).map((n) => n.kind))].sort((a, b) => a.localeCompare(b))
}

export interface FlatRow {
  node: CompNode
  depth: number
  /** Ids from the root down to (excluding) this row — for indentation guides. */
  hasChildren: boolean
}

/** Depth-first rows for the list view; a node reachable twice is listed once (first path). */
export function flatten(
  graph: CompositionGraph,
  visible?: Set<string>,
  collapsed: ReadonlySet<string> = new Set(),
): FlatRow[] {
  const rows: FlatRow[] = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return
    const n = graph.nodes[id]
    if (!n || (visible && !visible.has(id))) return
    seen.add(id)
    const kids = sortedChildren(graph, n).filter((c) => !visible || visible.has(c))
    rows.push({ node: n, depth, hasChildren: kids.length > 0 })
    if (collapsed.has(id)) return
    for (const c of kids) walk(c, depth + 1)
  }
  for (const r of graph.roots) walk(r, 0)
  return rows
}

const KIND_ORDER = ['Application', 'Composite', 'Namespace', 'ServiceAccount', 'ConfigMap', 'Secret', 'Service', 'Deployment', 'StatefulSet', 'ReplicaSet', 'Pod']

function sortedChildren(graph: CompositionGraph, n: CompNode): string[] {
  return [...n.children].sort((a, b) => {
    const na = graph.nodes[a]
    const nb = graph.nodes[b]
    if (!na || !nb) return 0
    const ka = KIND_ORDER.indexOf(na.kind)
    const kb = KIND_ORDER.indexOf(nb.kind)
    if (ka !== kb) return (ka < 0 ? 99 : ka) - (kb < 0 ? 99 : kb)
    if (na.kind !== nb.kind) return na.kind.localeCompare(nb.kind)
    return na.name.localeCompare(nb.name)
  })
}

export interface LayoutNode {
  id: string
  col: number
  row: number
}

export interface LayoutEdge {
  from: string
  to: string
  /** A second (non-tree) parent — drawn dashed. */
  extra: boolean
}

export interface TreeLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  cols: number
  rows: number
}

/**
 * A layered left-to-right tree layout, the shape of Argo CD's app view: one
 * column per depth, leaves stacked top to bottom, each parent centred on its
 * children. A node with several parents sits under the first; the others get
 * a dashed edge.
 */
export function layoutTree(
  graph: CompositionGraph,
  visible?: Set<string>,
  collapsed: ReadonlySet<string> = new Set(),
): TreeLayout {
  const placed = new Map<string, LayoutNode>()
  const edges: LayoutEdge[] = []
  let nextRow = 0
  let maxCol = 0

  const place = (id: string, col: number): number | undefined => {
    if (placed.has(id)) return undefined
    const n = graph.nodes[id]
    if (!n || (visible && !visible.has(id))) return undefined
    const ln: LayoutNode = { id, col, row: 0 }
    placed.set(id, ln)
    maxCol = Math.max(maxCol, col)
    const kidRows: number[] = []
    if (!collapsed.has(id)) {
      for (const c of sortedChildren(graph, n)) {
        const r = place(c, col + 1)
        if (r !== undefined) {
          kidRows.push(r)
          edges.push({ from: id, to: c, extra: false })
        }
      }
    }
    ln.row = kidRows.length ? (kidRows[0] + kidRows[kidRows.length - 1]) / 2 : nextRow++
    return ln.row
  }
  for (const r of graph.roots) place(r, 0)

  // Secondary parents.
  for (const ln of placed.values()) {
    const n = graph.nodes[ln.id]
    if (collapsed.has(ln.id)) continue
    for (const c of n.children) {
      if (placed.has(c) && !edges.some((e) => e.from === ln.id && e.to === c)) edges.push({ from: ln.id, to: c, extra: true })
    }
  }
  return { nodes: [...placed.values()], edges, cols: maxCol + 1, rows: nextRow }
}

/* ───────────────────────── entity → roots ───────────────────────── */

/**
 * `adhar.io/xr` / `adhar.io/composite` annotation, kubectl-style:
 * `<kind>[.<group>]/<name>` or `<kind>[.<group>]/<namespace>/<name>`,
 * optionally prefixed with a version: `<kind>.<version>.<group>/…` is not
 * supported — the served version is discovered.
 */
export function parseXrAnnotation(value: string | undefined): { kind: string; group?: string; namespace?: string; name: string } | undefined {
  const v = (value ?? '').trim()
  if (!v) return undefined
  const parts = v.split('/').filter(Boolean)
  if (parts.length < 2 || parts.length > 3) return undefined
  const [kg, a, b] = parts
  const dot = kg.indexOf('.')
  const kind = dot < 0 ? kg : kg.slice(0, dot)
  const group = dot < 0 ? undefined : kg.slice(dot + 1)
  if (!kind) return undefined
  return parts.length === 3 ? { kind, group, namespace: a, name: b } : { kind, group, name: a }
}

export interface RootCandidate {
  kind: string
  group: string
  namespace?: string
  name?: string
  labelSelector?: string
  /** Why this candidate was tried — shown as provenance in the tab. */
  via: string
}

export const PLATFORM_GROUP = 'platform.adhar.io'
export const PLATFORM_NAMESPACE = 'adhar-system'

/**
 * Where an entity's backing composite might be, most explicit first. Name and
 * label matches are scoped to the platform's own API group and namespace, so
 * an entity never borrows some other object that happens to share its name.
 */
export function rootCandidates(entity: {
  kind: string
  metadata: { name: string; annotations?: Record<string, string> }
}): RootCandidate[] {
  const ann = entity.metadata.annotations ?? {}
  const out: RootCandidate[] = []
  for (const key of ['adhar.io/xr', 'adhar.io/composite', 'crossplane.io/composite']) {
    const p = parseXrAnnotation(ann[key])
    if (p) out.push({ kind: p.kind, group: p.group ?? PLATFORM_GROUP, namespace: p.namespace, name: p.name, via: `annotation ${key}` })
  }
  const claimName = ann['crossplane.io/claim-name']
  const claimKind = ann['adhar.io/claim-kind']
  if (claimName && claimKind) {
    const p = parseXrAnnotation(`${claimKind}/${ann['crossplane.io/claim-namespace'] ?? PLATFORM_NAMESPACE}/${claimName}`)
    if (p) out.push({ kind: p.kind, group: p.group ?? PLATFORM_GROUP, namespace: p.namespace, name: p.name, via: 'annotation crossplane.io/claim-name' })
  }
  if (out.length) return out

  const name = (ann['adhar.io/application'] ?? entity.metadata.name).trim()
  switch (entity.kind) {
    case 'Component':
    case 'Resource':
    case 'API':
      out.push({ kind: 'Application', group: PLATFORM_GROUP, namespace: PLATFORM_NAMESPACE, name, via: 'Application XR named like the entity' })
      break
    case 'Group':
      out.push({ kind: 'Team', group: PLATFORM_GROUP, namespace: PLATFORM_NAMESPACE, labelSelector: `adhar.io/team=${name}`, via: 'Team XR labelled adhar.io/team' })
      out.push({ kind: 'Organisation', group: PLATFORM_GROUP, namespace: PLATFORM_NAMESPACE, name, via: 'Organisation XR named like the entity' })
      break
    case 'System':
      out.push({ kind: 'Project', group: PLATFORM_GROUP, namespace: PLATFORM_NAMESPACE, name, via: 'Project XR named like the entity' })
      break
    case 'Domain':
      out.push({ kind: 'Organisation', group: PLATFORM_GROUP, namespace: PLATFORM_NAMESPACE, name, via: 'Organisation XR named like the entity' })
      break
  }
  return out
}

/* ───────────────────────── formatting ───────────────────────── */

export function age(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  return d < 365 ? `${d}d` : `${Math.floor(d / 365)}y`
}

const KIND_ABBR: Record<string, string> = {
  Application: 'app',
  Deployment: 'deploy',
  StatefulSet: 'sts',
  DaemonSet: 'ds',
  ReplicaSet: 'rs',
  Pod: 'pod',
  Service: 'svc',
  Ingress: 'ing',
  HTTPRoute: 'route',
  ConfigMap: 'cm',
  Secret: 'secret',
  ServiceAccount: 'sa',
  Namespace: 'ns',
  PersistentVolumeClaim: 'pvc',
  Job: 'job',
  CronJob: 'cron',
  Role: 'role',
  RoleBinding: 'rb',
  ClusterRole: 'crole',
  ClusterRoleBinding: 'crb',
  Endpoints: 'ep',
  EndpointSlice: 'eps',
  HorizontalPodAutoscaler: 'hpa',
  NetworkPolicy: 'netpol',
  Object: 'obj',
  Warehouse: 'wh',
  Stage: 'stage',
  Rollout: 'ro',
  Certificate: 'cert',
}

export function kindAbbr(kind: string): string {
  if (KIND_ABBR[kind]) return KIND_ABBR[kind]
  const caps = kind.replace(/[^A-Z]/g, '').toLowerCase()
  return caps.length >= 2 ? caps.slice(0, 4) : kind.slice(0, 4).toLowerCase()
}

export type KindFamily = 'gitops' | 'composite' | 'workload' | 'network' | 'config' | 'storage' | 'rbac' | 'other'

export function kindFamily(n: { group: string; kind: string; source?: NodeSource }): KindFamily {
  if (n.group === 'argoproj.io' || n.group === 'kargo.akuity.io') return 'gitops'
  if (n.source === 'composite' || n.source === 'claim' || n.group.endsWith('adhar.io') || n.group.endsWith('crossplane.io')) return 'composite'
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Pod', 'Job', 'CronJob', 'Rollout', 'HorizontalPodAutoscaler'].includes(n.kind)) return 'workload'
  if (['Service', 'Ingress', 'HTTPRoute', 'Gateway', 'Endpoints', 'EndpointSlice', 'NetworkPolicy', 'CiliumNetworkPolicy', 'Certificate'].includes(n.kind)) return 'network'
  if (['ConfigMap', 'Secret', 'ExternalSecret', 'SealedSecret'].includes(n.kind)) return 'config'
  if (['PersistentVolumeClaim', 'PersistentVolume', 'StorageClass', 'Bucket'].includes(n.kind)) return 'storage'
  if (['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'ServiceAccount'].includes(n.kind)) return 'rbac'
  return 'other'
}

/* ───────────────────────── display helpers ───────────────────────── */

export function stackId(parent: string, kind: string): string {
  return `stack:${parent}:${kind}`
}

const PLURAL: Record<string, string> = { Endpoints: 'Endpoints', Ingress: 'Ingresses', Policy: 'Policies', NetworkPolicy: 'NetworkPolicies' }
export function pluralKind(kind: string, n: number): string {
  if (n === 1) return kind
  if (PLURAL[kind]) return PLURAL[kind]
  return /(s|x|ch|sh)$/.test(kind) ? `${kind}es` : /[^aeiou]y$/.test(kind) ? `${kind.slice(0, -1)}ies` : `${kind}s`
}

/**
 * Fold runs of same-kind siblings into one stack node ("12 Pods") the way
 * Argo CD groups them, so a wide fan-out stays readable. A stack is opened by
 * putting its id in `expanded`. Returns a display graph; the input is not
 * mutated. Members' own subtrees are hidden with them.
 */
export function stackSiblings(
  graph: CompositionGraph,
  visible: Set<string> | undefined,
  opts: { threshold?: number; expanded?: ReadonlySet<string> } = {},
): { graph: CompositionGraph; visible?: Set<string> } {
  const threshold = opts.threshold ?? 6
  const expanded = opts.expanded ?? new Set<string>()
  const nodes: Record<string, CompNode> = {}
  for (const [id, n] of Object.entries(graph.nodes)) nodes[id] = { ...n, children: [...n.children] }
  const vis = visible ? new Set(visible) : undefined
  for (const parent of Object.values(graph.nodes)) {
    if (vis && !vis.has(parent.id)) continue
    const kids = parent.children.filter((c) => graph.nodes[c] && (!vis || vis.has(c)))
    const byKind = new Map<string, string[]>()
    for (const c of kids) {
      const k = graph.nodes[c].kind
      byKind.set(k, [...(byKind.get(k) ?? []), c])
    }
    for (const [kind, members] of byKind) {
      const sid = stackId(parent.id, kind)
      if (members.length < threshold || expanded.has(sid)) continue
      const byLevel: Partial<Record<HealthLevel, number>> = {}
      let worst: HealthLevel = 'none'
      for (const m of members) {
        const l = graph.nodes[m].status.level
        byLevel[l] = (byLevel[l] ?? 0) + 1
        worst = worse(worst, rollup(graph, m))
      }
      const bad = members.filter((m) => isUnhealthy(graph.nodes[m].status.level)).length
      const namespaces = new Set(members.map((m) => graph.nodes[m].namespace ?? ''))
      const first = graph.nodes[members[0]]
      nodes[sid] = {
        id: sid,
        group: first.group,
        kind,
        name: `${members.length} ${pluralKind(kind, members.length)}`,
        namespace: namespaces.size === 1 ? first.namespace : undefined,
        source: first.source,
        status: { level: worst, label: bad ? `${bad} need attention` : 'All healthy' },
        conditions: [],
        createdAt: members.map((m) => graph.nodes[m].createdAt).filter(Boolean).sort()[0],
        children: [],
        parents: [parent.id],
        stack: { kind, parent: parent.id, members, byLevel },
      }
      const pc = nodes[parent.id].children
      const at = pc.indexOf(members[0])
      nodes[parent.id].children = pc.filter((c) => !members.includes(c))
      nodes[parent.id].children.splice(Math.max(0, Math.min(at, nodes[parent.id].children.length)), 0, sid)
      if (vis) {
        vis.add(sid)
        for (const m of members) vis.delete(m)
      }
    }
  }
  return { graph: { ...graph, nodes }, visible: vis }
}

/** The node and every ancestor up to the roots. */
export function pathToRoot(graph: CompositionGraph, id: string): Set<string> {
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    if (out.has(cur)) continue
    out.add(cur)
    stack.push(...(graph.nodes[cur]?.parents ?? []))
  }
  return out
}

export type SortKey = 'name' | 'kind' | 'status' | 'sync' | 'age'

/** Compare siblings for the tree-table's sortable columns. */
export function compareNodes(key: SortKey, dir: 1 | -1): (a: CompNode, b: CompNode) => number {
  const sev = (n: CompNode) => LEVEL_SEVERITY[n.status.level]
  const ts = (n: CompNode) => (n.createdAt ? Date.parse(n.createdAt) : 0)
  return (a, b) => {
    let d = 0
    if (key === 'name') d = a.name.localeCompare(b.name)
    else if (key === 'kind') d = a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    else if (key === 'status') d = sev(b) - sev(a) || a.name.localeCompare(b.name)
    else if (key === 'sync') d = (a.status.sync ?? '~').localeCompare(b.status.sync ?? '~') || a.name.localeCompare(b.name)
    else d = ts(b) - ts(a)
    return d * dir
  }
}

export interface TreeRow {
  node: CompNode
  depth: number
  hasChildren: boolean
  /** For each ancestor level, whether a guide line continues below (ancestor has later siblings). */
  guides: boolean[]
  last: boolean
}

/** Depth-first rows with guide-line info, siblings ordered by `cmp`. */
export function treeRows(
  graph: CompositionGraph,
  visible: Set<string> | undefined,
  collapsed: ReadonlySet<string>,
  cmp?: (a: CompNode, b: CompNode) => number,
): TreeRow[] {
  const rows: TreeRow[] = []
  const seen = new Set<string>()
  const kidsOf = (n: CompNode) => {
    const ids = n.children.filter((c) => graph.nodes[c] && (!visible || visible.has(c)) && !seen.has(c))
    const list = ids.map((c) => graph.nodes[c])
    if (cmp) list.sort(cmp)
    return list
  }
  const walk = (n: CompNode, depth: number, guides: boolean[], last: boolean) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    const kids = kidsOf(n)
    rows.push({ node: n, depth, hasChildren: kids.length > 0, guides, last })
    if (collapsed.has(n.id)) return
    kids.forEach((k, i) => walk(k, depth + 1, [...guides, !last], i === kids.length - 1))
  }
  const roots = graph.roots.map((r) => graph.nodes[r]).filter((n): n is CompNode => Boolean(n) && (!visible || visible.has(n.id)))
  roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1))
  return rows
}
