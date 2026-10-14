/**
 * Explore — pure helpers behind the discovery-driven resource browser
 * (`views/resource-browser.tsx`). No I/O and no React here, so the kind picker's
 * ranking, the grouping, the generic status derivation and the apiserver
 * Table → column mapping are unit-tested on their own (`explore_test.ts`).
 */

/* ─── kinds ─────────────────────────────────────────────────────────────── */

/** The subset of a discovered API resource the browser needs (structural). */
export interface ExploreKind {
  group: string
  version: string
  kind: string
  /** Plural resource name — `deployments`. */
  name: string
  singularName?: string
  namespaced: boolean
  verbs: string[]
  shortNames?: string[]
  categories?: string[]
  subresource?: boolean
}

/** Version-free identity — stable across API upgrades, so pins survive them. */
export const kindKey = (k: { group: string; name: string }) => `${k.group}/${k.name}`

/** kubectl's fully-qualified resource name: `pods`, `deployments.apps`. */
export const kindParam = (k: { group: string; name: string }) => (k.group ? `${k.name}.${k.group}` : k.name)

/** `apps/v1` or `v1` — the apiVersion objects of this kind carry. */
export const apiVersionOf = (k: { group: string; version: string }) => (k.group ? `${k.group}/${k.version}` : k.version)

/**
 * Listable, top-level kinds only, deduped by group + resource. Discovery lists
 * a resource once per served version; the first entry (the preferred version,
 * in the order the apiserver reports groups) wins.
 */
export function browsableKinds<T extends ExploreKind>(resources: readonly T[] | undefined): T[] {
  const seen = new Map<string, T>()
  for (const r of resources ?? []) {
    if (r.subresource || r.name.includes('/') || !r.verbs.includes('list')) continue
    const key = kindKey(r)
    if (!seen.has(key)) seen.set(key, r)
  }
  return [...seen.values()]
}

/**
 * Resolve a `?kind=` value back to a discovered kind. Accepts what a person
 * would type into kubectl: `deployments.apps`, `deployments`, `deploy`,
 * `Deployment`. Exact qualified names win, then core-group matches (so `events`
 * means core Events, not `events.k8s.io`), then the first match anywhere.
 */
export function resolveKind<T extends ExploreKind>(kinds: readonly T[], param: string | null | undefined): T | undefined {
  if (!param) return undefined
  const p = param.trim().toLowerCase()
  if (!p) return undefined
  const exact = kinds.find((k) => kindParam(k).toLowerCase() === p || kindKey(k).toLowerCase() === p)
  if (exact) return exact
  const names = (k: T) => [k.name, k.kind.toLowerCase(), k.singularName?.toLowerCase(), ...(k.shortNames ?? [])]
  const hits = kinds.filter((k) => names(k).includes(p))
  return hits.find((k) => k.group === '') ?? hits.find((k) => isBuiltinGroup(k.group)) ?? hits[0]
}

/** Find the discovered kind an `ownerReference` / `apiVersion + kind` points at. */
export function kindForObject<T extends ExploreKind>(
  kinds: readonly T[],
  apiVersion: string | undefined,
  kind: string | undefined,
): T | undefined {
  if (!kind) return undefined
  const group = apiVersion?.includes('/') ? apiVersion.split('/')[0] : ''
  return kinds.find((k) => k.group === group && k.kind === kind) ?? kinds.find((k) => k.kind === kind)
}

/* ─── groups ────────────────────────────────────────────────────────────── */

const GROUP_LABELS: Record<string, string> = {
  '': 'Core',
  apps: 'Apps',
  batch: 'Batch',
  autoscaling: 'Autoscaling',
  policy: 'Policy',
  'networking.k8s.io': 'Networking',
  'gateway.networking.k8s.io': 'Gateway API',
  'rbac.authorization.k8s.io': 'RBAC',
  'storage.k8s.io': 'Storage',
  'apiextensions.k8s.io': 'API extensions',
  'apiregistration.k8s.io': 'API registration',
  'admissionregistration.k8s.io': 'Admission',
  'coordination.k8s.io': 'Coordination',
  'discovery.k8s.io': 'Service discovery',
  'events.k8s.io': 'Events',
  'certificates.k8s.io': 'Certificates',
  'scheduling.k8s.io': 'Scheduling',
  'node.k8s.io': 'Node runtime',
  'flowcontrol.apiserver.k8s.io': 'API priority & fairness',
  'resource.k8s.io': 'Dynamic resources',
  'snapshot.storage.k8s.io': 'Volume snapshots',
  'metrics.k8s.io': 'Metrics',
  'argoproj.io': 'Argo',
  'kargo.akuity.io': 'Kargo',
  'tekton.dev': 'Tekton',
  'triggers.tekton.dev': 'Tekton triggers',
  'kyverno.io': 'Kyverno',
  'wgpolicyk8s.io': 'Policy reports',
  'cert-manager.io': 'cert-manager',
  'acme.cert-manager.io': 'cert-manager ACME',
  'monitoring.coreos.com': 'Prometheus',
  'litmuschaos.io': 'Litmus chaos',
  'external-secrets.io': 'External Secrets',
  'generators.external-secrets.io': 'External Secrets generators',
  'keda.sh': 'KEDA',
  'cilium.io': 'Cilium',
  'velero.io': 'Velero',
  'postgresql.cnpg.io': 'CloudNativePG',
  'k8s.keycloak.org': 'Keycloak',
}

/** Built-in Kubernetes API groups (core, the unqualified ones, `*.k8s.io`). */
export function isBuiltinGroup(group: string): boolean {
  return group === '' || !group.includes('.') || group.endsWith('.k8s.io')
}

/** Friendly heading for an API group — falls back to the group itself. */
export function groupLabel(group: string): string {
  if (group in GROUP_LABELS) return GROUP_LABELS[group]
  if (group.endsWith('.crossplane.io') || group === 'crossplane.io') return 'Crossplane'
  if (group.endsWith('.adhar.io') || group === 'adhar.io') return 'Adhar Platform'
  if (group.endsWith('.tekton.dev')) return 'Tekton'
  if (group.endsWith('.argoproj.io')) return 'Argo'
  if (group.endsWith('.istio.io')) return 'Istio'
  if (group.endsWith('.knative.dev')) return 'Knative'
  return group
}

export interface KindGroup<T extends ExploreKind> {
  /** Friendly label — also the grouping key, so `*.crossplane.io` merge into one. */
  label: string
  /** Raw API groups folded into this section. */
  groups: string[]
  builtin: boolean
  items: T[]
}

/**
 * Sections for the picker: Core first, then the other built-in groups, then
 * extensions (CRDs) — each alphabetical, items sorted by Kind.
 */
export function groupKinds<T extends ExploreKind>(kinds: readonly T[]): KindGroup<T>[] {
  const byLabel = new Map<string, KindGroup<T>>()
  for (const k of kinds) {
    const label = groupLabel(k.group)
    const g = byLabel.get(label) ?? { label, groups: [], builtin: isBuiltinGroup(k.group), items: [] }
    if (!g.groups.includes(k.group)) g.groups.push(k.group)
    g.items.push(k)
    byLabel.set(label, g)
  }
  const rank = (g: KindGroup<T>) => (g.groups.includes('') ? 0 : g.builtin ? 1 : 2)
  return [...byLabel.values()]
    .map((g) => ({ ...g, items: g.items.sort((a, b) => a.kind.localeCompare(b.kind) || a.group.localeCompare(b.group)) }))
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
}

/* ─── fuzzy search ──────────────────────────────────────────────────────── */

/** Characters of `needle` appear in `hay` in order — `dpl` ⊂ `deployment`. */
function subsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true
  return needle.length === 0
}

/** Lower-cased word starts of a CamelCase kind — `StatefulSet` → `stateful`, `set`. */
function camelWords(kind: string): string[] {
  return kind.split(/(?=[A-Z][a-z])/).map((w) => w.toLowerCase())
}

function tokenScore(k: ExploreKind, t: string): number {
  const kind = k.kind.toLowerCase()
  const plural = k.name.toLowerCase()
  const singular = (k.singularName || kind).toLowerCase()
  if ((k.shortNames ?? []).some((s) => s.toLowerCase() === t)) return 1000
  if (kind === t || plural === t || singular === t) return 950
  if (kindParam(k).toLowerCase() === t) return 940
  if (kind.startsWith(t) || plural.startsWith(t)) return 800 - Math.min(100, kind.length - t.length)
  if (camelWords(k.kind).some((w) => w.startsWith(t))) return 600
  if (kind.includes(t) || plural.includes(t)) return 450
  if ((k.categories ?? []).includes(t)) return 300
  if (k.group.toLowerCase().includes(t) || groupLabel(k.group).toLowerCase().includes(t)) return 200
  if (t.length >= 2 && subsequence(t, kind)) return 100 + Math.round((t.length / kind.length) * 50)
  return 0
}

/**
 * Rank a kind against a picker query. Every whitespace-separated token must
 * match somewhere (`argo app` → Argo CD Applications); 0 means "hide it".
 * Short names (`svc`, `cm`, `deploy`) and exact names rank above prefixes,
 * prefixes above substrings, substrings above group matches and subsequences.
 */
export function scoreKind(k: ExploreKind, query: string): number {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return 1
  let total = 0
  for (const t of tokens) {
    const s = tokenScore(k, t)
    if (!s) return 0
    total += s
  }
  return total
}

/** Kinds matching `query`, best first; built-ins break ties, then Kind A→Z. */
export function searchKinds<T extends ExploreKind>(kinds: readonly T[], query: string): T[] {
  return kinds
    .map((k) => ({ k, s: scoreKind(k, query) }))
    .filter((x) => x.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        Number(isBuiltinGroup(b.k.group)) - Number(isBuiltinGroup(a.k.group)) ||
        a.k.kind.localeCompare(b.k.kind),
    )
    .map((x) => x.k)
}

/* ─── pins + recents ────────────────────────────────────────────────────── */

/** Move `key` to the front of a most-recent-first list, capped at `max`. */
export function pushRecent(list: readonly string[], key: string, max = 6): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, max)
}

/** Add or remove `key`, keeping insertion order. */
export function togglePin(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
}

/* ─── status ────────────────────────────────────────────────────────────── */

/** Mirrors shell-ui's `StatusKind` (kept local so this module has no deps). */
export type Tone = 'healthy' | 'degraded' | 'progressing' | 'paused' | 'failed' | 'unknown' | 'info'

export interface DerivedStatus {
  text: string
  tone: Tone
  /** The condition / container message that explains it, when there is one. */
  detail?: string
}

interface Cond {
  type: string
  status: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

interface ObjLike {
  kind?: string
  metadata?: { deletionTimestamp?: string }
  spec?: unknown
  status?: unknown
}

const HEALTHY_PHASES = new Set([
  'Running', 'Active', 'Succeeded', 'Bound', 'Available', 'Ready', 'Healthy', 'Complete', 'Completed',
  'Established', 'Synced', 'Deployed', 'Succeeding',
])
const PROGRESSING_PHASES = new Set([
  'Pending', 'Progressing', 'Provisioning', 'Terminating', 'Creating', 'Updating', 'Installing',
  'Initializing', 'Waiting', 'Promoting', 'Verifying', 'Scheduled', 'ContainerCreating',
])
const FAILED_PHASES = new Set(['Failed', 'Error', 'Lost', 'CrashLoopBackOff', 'Unhealthy', 'Errored'])
const DEGRADED_PHASES = new Set(['Degraded', 'Missing', 'Unknown', 'OutOfSync', 'Released'])
const PAUSED_PHASES = new Set(['Suspended', 'Paused', 'Stopped', 'Inactive'])

/** Tone for a free-form phase / health string. */
export function phaseTone(phase: string): Tone {
  if (HEALTHY_PHASES.has(phase)) return 'healthy'
  if (PROGRESSING_PHASES.has(phase)) return 'progressing'
  if (FAILED_PHASES.has(phase)) return 'failed'
  if (DEGRADED_PHASES.has(phase)) return 'degraded'
  if (PAUSED_PHASES.has(phase)) return 'paused'
  return 'info'
}

/** Container waiting / terminated reasons that mean the pod is broken. */
const BAD_CONTAINER_REASONS = new Set([
  'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError',
  'InvalidImageName', 'RunContainerError', 'OOMKilled', 'Error', 'ContainerCannotRun',
])

/** Condition types where `True` is the bad state. */
const NEGATIVE_CONDITIONS: Record<string, Tone> = {
  Failed: 'failed',
  Stalled: 'failed',
  ReplicaFailure: 'failed',
  Degraded: 'degraded',
  MemoryPressure: 'degraded',
  DiskPressure: 'degraded',
  PIDPressure: 'degraded',
  NetworkUnavailable: 'degraded',
}

/** Positive condition types, in the order that best summarises an object. */
const PRIMARY_CONDITIONS = [
  'Ready', 'Available', 'Healthy', 'Complete', 'Succeeded', 'Established', 'Programmed', 'Accepted',
  'Synced', 'Reconciled', 'Initialized',
]

const ERRORISH = /fail|error|backoff|invalid|denied|forbidden|notfound|not ?found|unavailable|exceeded|crash|refused|timeout/i

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export function conditionsOf(obj: ObjLike): Cond[] {
  const conds = (obj.status as { conditions?: unknown } | undefined)?.conditions
  if (!Array.isArray(conds)) return []
  return conds.filter((c): c is Cond => !!c && typeof c === 'object' && typeof (c as Cond).type === 'string')
}

/** Is a condition in its good state? (`False` is good for negative types.) */
export function conditionTone(c: Cond): Tone {
  if (c.status === 'Unknown') return 'progressing'
  const negative = NEGATIVE_CONDITIONS[c.type]
  if (negative) return c.status === 'True' ? negative : 'healthy'
  if (c.status === 'True') return 'healthy'
  return ERRORISH.test(`${c.reason ?? ''}`) ? 'failed' : 'degraded'
}

function podStatus(st: Record<string, unknown>): DerivedStatus | null {
  const all = [
    ...((st.initContainerStatuses as unknown[]) ?? []),
    ...((st.containerStatuses as unknown[]) ?? []),
  ] as Array<{ ready?: boolean; state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string; message?: string; exitCode?: number } } }>
  for (const c of all) {
    const w = c.state?.waiting
    if (w?.reason && BAD_CONTAINER_REASONS.has(w.reason)) return { text: w.reason, tone: 'failed', detail: w.message }
  }
  const phase = typeof st.phase === 'string' ? st.phase : undefined
  if (phase !== 'Succeeded') {
    for (const c of all) {
      const t = c.state?.terminated
      if (t?.reason && t.exitCode !== 0 && BAD_CONTAINER_REASONS.has(t.reason)) return { text: t.reason, tone: 'failed', detail: t.message }
    }
  }
  if (!phase) return null
  const main = ((st.containerStatuses as unknown[]) ?? []) as Array<{ ready?: boolean }>
  if (phase === 'Running' && main.length) {
    const ready = main.filter((c) => c.ready).length
    if (ready < main.length) return { text: 'Not ready', tone: 'progressing', detail: `${ready} of ${main.length} containers ready.` }
  }
  const waiting = all.find((c) => c.state?.waiting?.reason)?.state?.waiting
  if (phase === 'Pending' && waiting?.reason) return { text: waiting.reason, tone: 'progressing', detail: waiting.message }
  return { text: phase, tone: phaseTone(phase), detail: typeof st.message === 'string' ? st.message : undefined }
}

/**
 * Best-effort status for any Kubernetes object, from the shapes that recur
 * across built-ins and CRDs: deletion, Argo-style `status.health`, pod
 * container states, `status.phase`, replica counts, negative conditions
 * (Stalled / Failed / *Pressure), then the most telling positive condition
 * (Ready → Available → … → Synced). `null` when the object has no status at
 * all (ConfigMaps, Roles, …) so the column can be dropped.
 */
export function deriveStatus(obj: ObjLike): DerivedStatus | null {
  if (obj.metadata?.deletionTimestamp) return { text: 'Terminating', tone: 'progressing' }
  const st = obj.status as Record<string, unknown> | undefined
  if (!st || typeof st !== 'object' || Object.keys(st).length === 0) return null

  // Argo CD Applications (and anything else reporting `health.status`).
  const health = (st.health as { status?: unknown; message?: unknown } | undefined)?.status
  if (typeof health === 'string') {
    const sync = (st.sync as { status?: unknown } | undefined)?.status
    const outOfSync = sync === 'OutOfSync'
    const tone = phaseTone(health)
    return {
      text: outOfSync ? `${health} · OutOfSync` : health,
      tone: outOfSync && tone === 'healthy' ? 'degraded' : tone,
      detail: typeof (st.health as { message?: unknown }).message === 'string' ? (st.health as { message: string }).message : undefined,
    }
  }

  if (obj.kind === 'Pod' || Array.isArray(st.containerStatuses)) {
    const p = podStatus(st)
    if (p) return p
  }

  const conds = conditionsOf(obj)

  // A negative condition firing outranks everything below it.
  for (const c of conds) {
    const tone = NEGATIVE_CONDITIONS[c.type]
    if (tone && c.status === 'True') return { text: c.reason || c.type, tone, detail: c.message }
  }
  const progressing = conds.find((c) => c.type === 'Progressing')
  if (progressing?.status === 'False' && ERRORISH.test(progressing.reason ?? '')) {
    return { text: progressing.reason || 'Not progressing', tone: 'failed', detail: progressing.message }
  }

  if (typeof st.phase === 'string' && st.phase) {
    return { text: st.phase, tone: phaseTone(st.phase), detail: typeof st.message === 'string' ? st.message : undefined }
  }

  // Replica-style controllers (Deployment, StatefulSet, ReplicaSet, DaemonSet, …).
  const spec = (obj.spec ?? {}) as Record<string, unknown>
  const desired = num(st.desiredNumberScheduled) ?? num(spec.replicas) ?? num(st.replicas)
  const ready = num(st.numberReady) ?? num(st.readyReplicas)
  // The apiserver omits zero counts, so `spec.replicas` alone marks a scalable
  // controller (a scaled-to-zero Deployment reports no replica fields at all).
  if (desired !== undefined && (num(spec.replicas) !== undefined || ready !== undefined || num(st.replicas) !== undefined)) {
    if (desired === 0) return { text: 'Scaled to 0', tone: 'paused' }
    // Words, not counts — the printer columns already show READY n/m.
    const r = ready ?? 0
    return r >= desired
      ? { text: 'Ready', tone: 'healthy' }
      : { text: 'Progressing', tone: 'progressing', detail: `${r} of ${desired} replicas ready.` }
  }

  // Batch-style objects with no conditions yet.
  if (!conds.length && (num(st.active) ?? 0) > 0) return { text: 'Running', tone: 'progressing' }

  for (const type of PRIMARY_CONDITIONS) {
    const c = conds.find((x) => x.type === type)
    if (!c) continue
    const tone = conditionTone(c)
    // Crossplane-style: Ready but the last reconcile failed to sync.
    const synced = conds.find((x) => x.type === 'Synced')
    if (tone === 'healthy' && synced && synced.status === 'False' && type !== 'Synced') {
      return { text: 'Ready · sync failed', tone: 'degraded', detail: synced.message }
    }
    const text = tone === 'healthy' ? type : c.reason || (c.status === 'Unknown' ? 'Pending' : `Not ${type.toLowerCase()}`)
    return { text, tone, detail: c.message }
  }

  if (conds.length) {
    const latest = [...conds].sort((a, b) => (b.lastTransitionTime ?? '').localeCompare(a.lastTransitionTime ?? ''))[0]
    return { text: latest.reason || latest.type, tone: latest.status === 'True' ? 'info' : 'unknown', detail: latest.message }
  }
  return null
}

/** Conditions newest first, each with its tone — for the drawer timeline. */
export function conditionTimeline(obj: ObjLike): Array<Cond & { tone: Tone }> {
  return conditionsOf(obj)
    .map((c) => ({ ...c, tone: conditionTone(c) }))
    .sort((a, b) => (b.lastTransitionTime ?? '').localeCompare(a.lastTransitionTime ?? ''))
}

/** Roll a row set up into tone counts — the summary pills above the table. */
export function toneCounts(statuses: Array<DerivedStatus | null>): Partial<Record<Tone, number>> {
  const out: Partial<Record<Tone, number>> = {}
  for (const s of statuses) if (s) out[s.tone] = (out[s.tone] ?? 0) + 1
  return out
}

/* ─── apiserver Table → printer columns ─────────────────────────────────── */

/**
 * The apiserver renders kubectl's columns for every kind — built-ins and the
 * CRDs' `additionalPrinterColumns` alike — when asked for `as=Table`. These
 * are the shapes we read back (meta.k8s.io/v1 Table).
 */
export interface TableColumnDefinition {
  name: string
  type: string
  format?: string
  description?: string
  priority?: number
}
export interface TableRow {
  cells: unknown[]
  object?: { metadata?: { uid?: string; name?: string; namespace?: string } }
}
export interface KubeTable {
  kind?: string
  columnDefinitions?: TableColumnDefinition[]
  rows?: TableRow[]
}

export interface PrinterColumn {
  /** Index into each row's `cells`. */
  index: number
  name: string
  type: string
  format?: string
  description?: string
  /** priority > 0 is kubectl's `-o wide` — start those hidden. */
  wide: boolean
}

/** Columns the browser renders itself (identity + a live-ticking age). */
const OWN_COLUMNS = new Set(['name', 'namespace', 'age', 'created at'])

export function printerColumns(table: KubeTable | null | undefined): PrinterColumn[] {
  return (table?.columnDefinitions ?? [])
    .map((c, index) => ({
      index,
      name: c.name,
      type: c.type,
      format: c.format,
      description: c.description,
      wide: (c.priority ?? 0) > 0,
    }))
    .filter((c) => !OWN_COLUMNS.has(c.name.toLowerCase()) && c.format !== 'name')
}

const rowKeyOf = (ns: string | undefined, name: string | undefined) => `${ns ?? ''}/${name ?? ''}`

/** Index table rows by uid and by namespace/name so live objects can find their cells. */
export function indexTableRows(table: KubeTable | null | undefined): Map<string, unknown[]> {
  const map = new Map<string, unknown[]>()
  for (const r of table?.rows ?? []) {
    const m = r.object?.metadata
    if (!m) continue
    if (m.uid) map.set(m.uid, r.cells)
    map.set(rowKeyOf(m.namespace, m.name), r.cells)
  }
  return map
}

export function cellsFor(
  index: Map<string, unknown[]>,
  meta: { uid?: string; name: string; namespace?: string },
): unknown[] | undefined {
  return (meta.uid ? index.get(meta.uid) : undefined) ?? index.get(rowKeyOf(meta.namespace, meta.name))
}

/** Plain-text rendering of one printer cell (dates are handled by the view). */
export function cellText(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  if (Array.isArray(v)) return v.map(cellText).filter(Boolean).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/* ─── commands + permissions ────────────────────────────────────────────── */

/** `kubectl get deployments.apps web -n shop -o yaml` for the copy button. */
export function kubectlGet(k: { group: string; name: string; namespaced: boolean }, obj: { name: string; namespace?: string }): string {
  const ns = k.namespaced && obj.namespace ? ` -n ${obj.namespace}` : ''
  return `kubectl get ${kindParam(k)} ${obj.name}${ns} -o yaml`
}

/** Console permission the YAML panel gates Apply on (apiserver RBAC still decides). */
export function writePermFor(k: { group: string; name: string }):
  | 'pods.write'
  | 'workloads.write'
  | 'configmaps.write'
  | 'secrets.write'
  | 'rbac.write'
  | 'crds.write' {
  if (k.group === '' && k.name === 'pods') return 'pods.write'
  if (k.group === '' && k.name === 'configmaps') return 'configmaps.write'
  if (k.group === '' && k.name === 'secrets') return 'secrets.write'
  if (k.group === 'rbac.authorization.k8s.io') return 'rbac.write'
  if (isBuiltinGroup(k.group)) return 'workloads.write'
  return 'crds.write'
}
