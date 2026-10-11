/**
 * Day-2 operations for Adhar Resources (Crossplane claims / XRs) — the pure
 * half, shared by every resource page's list, bulk bar and drawer.
 *
 * Conventions, all standard or explicit:
 *   • `crossplane.io/paused: "true"` — Crossplane stops reconciling the
 *     resource (and, for an XR, its composed resources) until it is removed;
 *   • `adhar.io/deletion-protection: "true"` — the console refuses to delete
 *     it, single or bulk, until protection is lifted (a Kyverno policy can
 *     enforce the same rule cluster-side);
 *   • `adhar.io/reconcile-requested-at: <iso>` — any metadata change wakes
 *     the claim's controller, so stamping this asks for a reconcile now;
 *   • ownership labels — team, owner, environment, cost centre — read from
 *     the common keys, written to the `adhar.io/*` ones.
 */

import { toYaml } from './manifest-yaml.ts'

export const PAUSED_ANNOTATION = 'crossplane.io/paused'
export const PROTECTED_ANNOTATION = 'adhar.io/deletion-protection'
export const RECONCILE_ANNOTATION = 'adhar.io/reconcile-requested-at'

/** How long a resource may stay not-Ready before it counts as stuck. */
export const STUCK_AFTER_MS = 15 * 60_000

interface Condition {
  type: string
  status: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

export interface XrLike {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    creationTimestamp?: string
    deletionTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    managedFields?: Array<{ manager?: string; operation?: string; time?: string; subresource?: string; apiVersion?: string }>
    [k: string]: unknown
  }
  spec?: Record<string, unknown>
  status?: { conditions?: Condition[]; [k: string]: unknown }
}

/* ───── ownership ───── */

export const OWNERSHIP = [
  { key: 'team', label: 'Team', write: 'adhar.io/team', read: ['adhar.io/team', 'team', 'app.kubernetes.io/part-of'] },
  { key: 'owner', label: 'Owner', write: 'adhar.io/owner', read: ['adhar.io/owner', 'owner'] },
  { key: 'environment', label: 'Environment', write: 'adhar.io/environment', read: ['adhar.io/environment', 'environment', 'env'] },
  { key: 'costCenter', label: 'Cost centre', write: 'adhar.io/cost-center', read: ['adhar.io/cost-center', 'cost-center', 'costcenter'] },
] as const

export type OwnershipKey = (typeof OWNERSHIP)[number]['key']

export function ownership(xr: XrLike): Record<OwnershipKey, string | undefined> {
  const labels = xr.metadata.labels ?? {}
  const out = {} as Record<OwnershipKey, string | undefined>
  for (const o of OWNERSHIP) out[o.key] = o.read.map((k) => labels[k]).find(Boolean)
  return out
}

/* ───── state ───── */

export const isPaused = (xr: XrLike) => xr.metadata.annotations?.[PAUSED_ANNOTATION] === 'true'
export const isProtected = (xr: XrLike) => xr.metadata.annotations?.[PROTECTED_ANNOTATION] === 'true'

export function condition(xr: XrLike, type: string): Condition | undefined {
  return xr.status?.conditions?.find((c) => c.type === type)
}

export type XrState = 'deleting' | 'paused' | 'failing' | 'stuck' | 'progressing' | 'ready'

/**
 * One word for where a resource stands, most urgent first: being deleted,
 * paused on purpose, failing to sync, not Ready for too long, still coming
 * up, or Ready.
 */
export function xrState(xr: XrLike, now = Date.now()): XrState {
  if (xr.metadata.deletionTimestamp) return 'deleting'
  if (isPaused(xr)) return 'paused'
  const ready = condition(xr, 'Ready')
  if (ready?.status === 'True') return 'ready'
  if (condition(xr, 'Synced')?.status === 'False') return 'failing'
  const since = Date.parse(ready?.lastTransitionTime ?? xr.metadata.creationTimestamp ?? '')
  if (Number.isFinite(since) && now - since > STUCK_AFTER_MS) return 'stuck'
  return 'progressing'
}

export interface AttentionItem {
  xr: XrLike
  state: Extract<XrState, 'failing' | 'stuck'>
  /** The controller's own words, most specific condition first. */
  reason: string
  /** Since when it has been in this state (ISO). */
  since?: string
}

/** Resources a person should look at, the longest-broken first. */
export function attentionItems(rows: readonly XrLike[], now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = []
  for (const xr of rows) {
    const state = xrState(xr, now)
    if (state !== 'failing' && state !== 'stuck') continue
    const synced = condition(xr, 'Synced')
    const ready = condition(xr, 'Ready')
    const c = state === 'failing' ? synced : ready
    const reason = [c?.reason, c?.message].filter(Boolean).join(': ') ||
      (state === 'stuck' ? 'Not Ready and no condition explains why' : 'Sync failed')
    out.push({ xr, state, reason, since: c?.lastTransitionTime ?? xr.metadata.creationTimestamp })
  }
  return out.sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''))
}

/* ───── filtering and grouping ───── */

export interface XrFilter {
  search?: string
  namespace?: string
  composition?: string
  team?: string
  states?: ReadonlySet<XrState>
}

export function compositionOf(xr: XrLike): string {
  const ref = (xr.spec?.compositionRef as { name?: string } | undefined)?.name
  if (ref) return ref
  const sel = (xr.spec?.compositionSelector as { matchLabels?: Record<string, string> } | undefined)?.matchLabels
  return sel && Object.keys(sel).length ? Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(',') : ''
}

export function filterXrs<T extends XrLike>(rows: readonly T[], f: XrFilter, now = Date.now()): T[] {
  const needle = (f.search ?? '').trim().toLowerCase()
  return rows.filter((xr) => {
    if (f.namespace && (xr.metadata.namespace ?? '') !== f.namespace) return false
    if (f.composition && compositionOf(xr) !== f.composition) return false
    if (f.team && ownership(xr).team !== f.team) return false
    if (f.states?.size && !f.states.has(xrState(xr, now))) return false
    if (!needle) return true
    const own = ownership(xr)
    return [xr.metadata.name, xr.metadata.namespace ?? '', compositionOf(xr), own.team ?? '', own.owner ?? '', ...Object.values(xr.metadata.labels ?? {})]
      .some((v) => v.toLowerCase().includes(needle))
  })
}

export type GroupKey = 'none' | 'namespace' | 'composition' | 'team' | 'state'

export function groupXrs<T extends XrLike>(rows: readonly T[], by: GroupKey, now = Date.now()): Array<{ key: string; rows: T[] }> {
  if (by === 'none') return [{ key: '', rows: [...rows] }]
  const keyOf = (xr: T): string =>
    by === 'namespace' ? xr.metadata.namespace || 'cluster-scoped'
    : by === 'composition' ? compositionOf(xr) || 'default composition'
    : by === 'team' ? ownership(xr).team || 'no team'
    : xrState(xr, now)
  const map = new Map<string, T[]>()
  for (const r of rows) map.set(keyOf(r), [...(map.get(keyOf(r)) ?? []), r])
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => ({ key, rows }))
}

/** Distinct, sorted values for a filter menu. */
export function facet(rows: readonly XrLike[], pick: (xr: XrLike) => string | undefined): string[] {
  return [...new Set(rows.map(pick).filter((v): v is string => Boolean(v)))].sort()
}

/* ───── patches ───── */

/** Merge patch setting (or, with null, removing) annotations. */
export function annotationPatch(changes: Record<string, string | null>) {
  return { metadata: { annotations: changes } }
}

/** Merge patch setting (or, with null, removing) labels. */
export function labelPatch(changes: Record<string, string | null>) {
  return { metadata: { labels: changes } }
}

export const pausePatch = (paused: boolean) => annotationPatch({ [PAUSED_ANNOTATION]: paused ? 'true' : null })
export const protectPatch = (on: boolean) => annotationPatch({ [PROTECTED_ANNOTATION]: on ? 'true' : null })
export const reconcilePatch = (now = new Date()) => annotationPatch({ [RECONCILE_ANNOTATION]: now.toISOString() })

/** Ownership edits as a label patch: blank values remove the label. */
export function ownershipPatch(values: Partial<Record<OwnershipKey, string>>) {
  const changes: Record<string, string | null> = {}
  for (const o of OWNERSHIP) {
    if (!(o.key in values)) continue
    const v = (values[o.key] ?? '').trim()
    changes[o.write] = v ? v : null
  }
  return labelPatch(changes)
}

/** A Kubernetes label value: ≤63 chars, alphanumeric at both ends, `-_.` inside. */
export function validLabelValue(v: string): boolean {
  return v === '' || (/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(v) && v.length <= 63)
}

/* ───── export ───── */

const SERVER_FIELDS = ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields', 'selfLink', 'deletionTimestamp', 'deletionGracePeriodSeconds', 'ownerReferences', 'finalizers']

/** The manifest as a person would commit it: no status, no server bookkeeping. */
export function cleanManifest(xr: XrLike): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...xr.metadata }
  for (const f of SERVER_FIELDS) delete metadata[f]
  const annotations = { ...(xr.metadata.annotations ?? {}) }
  delete annotations['kubectl.kubernetes.io/last-applied-configuration']
  delete annotations[RECONCILE_ANNOTATION]
  if (Object.keys(annotations).length) metadata.annotations = annotations
  else delete metadata.annotations
  const spec = { ...(xr.spec ?? {}) }
  // Bindings Crossplane fills in; committing them pins the copy to this instance.
  for (const k of ['resourceRef', 'resourceRefs', 'claimRef', 'compositionRevisionRef']) delete spec[k]
  return { apiVersion: xr.apiVersion, kind: xr.kind, metadata, spec }
}

export function toYamlBundle(rows: readonly XrLike[]): string {
  return rows.map((r) => toYaml(cleanManifest(r))).join('---\n')
}

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: readonly XrLike[], now = Date.now()): string {
  const head = ['name', 'namespace', 'kind', 'state', 'ready', 'synced', 'composition', 'team', 'owner', 'environment', 'cost_center', 'paused', 'protected', 'created']
  const lines = rows.map((r) => {
    const own = ownership(r)
    return [
      r.metadata.name, r.metadata.namespace ?? '', r.kind ?? '', xrState(r, now),
      condition(r, 'Ready')?.status ?? '', condition(r, 'Synced')?.status ?? '', compositionOf(r),
      own.team, own.owner, own.environment, own.costCenter, isPaused(r), isProtected(r), r.metadata.creationTimestamp ?? '',
    ].map(csvCell).join(',')
  })
  return [head.join(','), ...lines].join('\n') + '\n'
}

/* ───── clone ───── */

/**
 * A copy of a claim to provision under a new name: same spec and labels, no
 * server state, no Crossplane bindings, and its own connection secret so the
 * two never share credentials.
 */
export function cloneManifest<T extends XrLike>(xr: T, name: string): T {
  const clean = cleanManifest(xr) as unknown as T
  const annotations = { ...(clean.metadata.annotations ?? {}) }
  delete annotations[PROTECTED_ANNOTATION]
  delete annotations[PAUSED_ANNOTATION]
  const spec = { ...(clean.spec ?? {}) }
  const secret = spec.writeConnectionSecretToRef as { name?: string; namespace?: string } | undefined
  if (secret?.name) spec.writeConnectionSecretToRef = { ...secret, name: `${name}-conn` }
  return {
    ...clean,
    metadata: { ...clean.metadata, name, annotations: Object.keys(annotations).length ? annotations : undefined },
    spec,
  }
}

/** `orders-db` → `orders-db-copy`, `orders-db-copy` → `orders-db-copy-2`. */
export function cloneName(name: string, taken: ReadonlySet<string>): string {
  const base = `${name}-copy`.slice(0, 63)
  if (!taken.has(base)) return base
  for (let i = 2; i < 100; i++) {
    const n = `${base}-${i}`.slice(0, 63)
    if (!taken.has(n)) return n
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 63)
}

/* ───── change log ───── */

export interface ChangeEntry {
  /** Who wrote: a person's client, the console, Argo CD, a controller. */
  manager: string
  operation: string
  time?: string
  /** `status` writes are the controller reporting, not a change to intent. */
  subresource?: string
  kindOfWriter: 'console' | 'gitops' | 'controller' | 'person' | 'other'
}

export function writerKind(manager: string): ChangeEntry['kindOfWriter'] {
  const m = manager.toLowerCase()
  if (m.includes('adhar-console')) return 'console'
  if (m.includes('argocd') || m.includes('argo-cd') || m.includes('flux')) return 'gitops'
  if (m.includes('crossplane') || m.includes('controller') || m.includes('provider') || m.includes('apiextensions')) return 'controller'
  if (m.includes('kubectl') || m.includes('helm') || m.includes('k9s') || m.includes('lens')) return 'person'
  return 'other'
}

/** Field managers newest first — the closest thing Kubernetes keeps to an edit history. */
export function changeLog(xr: XrLike): ChangeEntry[] {
  return (xr.metadata.managedFields ?? [])
    .map((f) => ({
      manager: f.manager ?? 'unknown',
      operation: f.operation ?? '',
      time: f.time,
      subresource: f.subresource,
      kindOfWriter: writerKind(f.manager ?? ''),
    }))
    .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))
}
