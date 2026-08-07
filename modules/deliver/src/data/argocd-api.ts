/**
 * Module-scoped, real ArgoCD detail calls for the Deliver drawer.
 *
 * The shared `@adhar-console/api-clients` ArgoCD client only models the
 * Application summary (list / get / sync). The detail drawer additionally needs
 * the managed-resource tree, deployment history, an options-aware sync, and a
 * rollback — so we call the ArgoCD REST API directly through the console BFF
 * proxy (`/api/svc/argocd/…`, cookie-auth; the server injects the upstream
 * token). Kept here (module-scoped) rather than expanding the shared client.
 *
 * Errors are thrown, never swallowed, so react-query surfaces them to the view.
 */

const ARGOCD_BASE = '/api/svc/argocd'

/* ─────────── view-facing shapes (consumed by argo-apps.tsx) ─────────── */

export type ArgoSyncState = 'Synced' | 'OutOfSync' | 'Unknown'
export type ArgoHealthState =
  | 'Healthy'
  | 'Progressing'
  | 'Degraded'
  | 'Suspended'
  | 'Missing'
  | 'Unknown'

/** A node in the managed-resource tree (children = owned resources). */
export interface ResourceNode {
  uid: string
  group?: string
  version: string
  kind: string
  name: string
  namespace: string
  /** Sync status is absent for runtime-only resources (e.g. Pods). */
  syncStatus?: ArgoSyncState
  health: ArgoHealthState
  message?: string
  children?: ResourceNode[]
}

export interface RevisionHistoryEntry {
  id: number
  revision: string
  deployedAt: string
  author: string
  message: string
  /** True for the revision currently running. */
  current?: boolean
}

/** Sync options mirroring the ArgoCD `sync` dialog. */
export interface SyncOptions {
  prune: boolean
  dryRun: boolean
  force: boolean
}

/* ─────────── raw ArgoCD API shapes (only the fields we read) ─────────── */

interface ArgoHealth {
  status?: string
  message?: string
}

interface ArgoParentRef {
  uid?: string
  group?: string
  kind?: string
  name?: string
  namespace?: string
}

interface ArgoTreeNode {
  uid?: string
  group?: string
  version?: string
  kind: string
  name: string
  namespace?: string
  health?: ArgoHealth
  parentRefs?: ArgoParentRef[]
}

interface ArgoResourceStatus {
  group?: string
  version?: string
  kind: string
  namespace?: string
  name: string
  /** Sync status of the managed resource: 'Synced' | 'OutOfSync' | … */
  status?: string
  health?: ArgoHealth
}

interface ArgoRevisionHistory {
  id: number
  revision: string
  deployedAt?: string
  deployStartedAt?: string
  initiatedBy?: { username?: string; automated?: boolean }
}

interface ArgoApplication {
  status?: {
    sync?: { status?: string; revision?: string }
    resources?: ArgoResourceStatus[]
    history?: ArgoRevisionHistory[]
  }
}

/* ─────────── low-level fetch (BFF proxy, cookie-auth) ─────────── */

async function argoGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ARGOCD_BASE}${path}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw await argoError(res, path)
  return (await res.json()) as T
}

async function argoPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ARGOCD_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw await argoError(res, path)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

async function argoError(res: Response, path: string): Promise<Error> {
  const text = await res.text().catch(() => '')
  let detail = text
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string }
    detail = parsed.message ?? parsed.error ?? text
  } catch {
    /* non-JSON body — keep raw text */
  }
  return new Error(
    `ArgoCD ${res.status} ${res.statusText} at ${path}${detail ? ` — ${detail}` : ''}`,
  )
}

/* ─────────── normalisation helpers ─────────── */

const HEALTH_STATES: readonly string[] = [
  'Healthy',
  'Progressing',
  'Degraded',
  'Suspended',
  'Missing',
  'Unknown',
]
const SYNC_STATES: readonly string[] = ['Synced', 'OutOfSync', 'Unknown']

function normalizeHealth(status?: string): ArgoHealthState {
  return HEALTH_STATES.includes(status ?? '') ? (status as ArgoHealthState) : 'Unknown'
}

function normalizeSync(status?: string): ArgoSyncState | undefined {
  if (!status) return undefined
  return SYNC_STATES.includes(status) ? (status as ArgoSyncState) : 'Unknown'
}

/** Identity key used to line resource-tree nodes up with `.status.resources`. */
function resourceKey(r: { group?: string; kind: string; namespace?: string; name: string }): string {
  return `${r.group ?? ''}/${r.kind}/${r.namespace ?? ''}/${r.name}`
}

/* ─────────── public API used by the delivery hooks ─────────── */

/**
 * Managed-resource tree. We fetch the resource-tree (structure + per-node
 * health, linked via `parentRefs`) and the Application (per-managed-resource
 * sync status lives on `.status.resources`, not on the tree) and merge them.
 * Roots are nodes with no in-tree parent; children hang off `parentRefs.uid`.
 */
export async function fetchManagedResources(name: string): Promise<ResourceNode[]> {
  const app = encodeURIComponent(name)
  const [tree, application] = await Promise.all([
    argoGet<{ nodes?: ArgoTreeNode[] }>(`/api/v1/applications/${app}/resource-tree`),
    argoGet<ArgoApplication>(`/api/v1/applications/${app}`),
  ])

  const syncByKey = new Map<string, ArgoSyncState>()
  for (const r of application.status?.resources ?? []) {
    const s = normalizeSync(r.status)
    if (s) syncByKey.set(resourceKey(r), s)
  }

  const nodes = tree.nodes ?? []
  const byUid = new Map<string, ResourceNode>()

  const uidOf = (n: ArgoTreeNode): string => n.uid ?? resourceKey(n)

  for (const n of nodes) {
    byUid.set(uidOf(n), {
      uid: uidOf(n),
      group: n.group || undefined,
      version: n.version ?? '',
      kind: n.kind,
      name: n.name,
      namespace: n.namespace ?? '',
      syncStatus: syncByKey.get(resourceKey(n)),
      health: normalizeHealth(n.health?.status),
      message: n.health?.message || undefined,
    })
  }

  const roots: ResourceNode[] = []
  for (const n of nodes) {
    const node = byUid.get(uidOf(n))!
    const parentUid = n.parentRefs?.map((p) => p.uid).find((uid) => uid && byUid.has(uid))
    if (parentUid) {
      const parent = byUid.get(parentUid)!
      ;(parent.children ??= []).push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

/** Deployment history from `.status.history`, newest first. */
export async function fetchRevisionHistory(name: string): Promise<RevisionHistoryEntry[]> {
  const application = await argoGet<ArgoApplication>(
    `/api/v1/applications/${encodeURIComponent(name)}`,
  )
  const history = application.status?.history ?? []
  const currentRevision = application.status?.sync?.revision
  const maxId = history.reduce((m, h) => Math.max(m, h.id), Number.NEGATIVE_INFINITY)

  return history
    .map((h) => ({
      id: h.id,
      revision: h.revision,
      deployedAt: h.deployedAt ?? h.deployStartedAt ?? '',
      author: h.initiatedBy?.username || (h.initiatedBy?.automated ? 'automation' : ''),
      message: '',
      current: currentRevision ? h.revision === currentRevision : h.id === maxId,
    }))
    .sort((a, b) => b.id - a.id)
}

/**
 * Options-aware sync. `force` maps to ArgoCD's `apply --force` strategy
 * (`strategy.apply.force`); `prune` / `dryRun` map to the request body fields.
 */
export async function syncApplication(name: string, options?: SyncOptions): Promise<void> {
  const body: { prune: boolean; dryRun: boolean; strategy?: { apply: { force: boolean } } } = {
    prune: options?.prune ?? false,
    dryRun: options?.dryRun ?? false,
  }
  if (options?.force) body.strategy = { apply: { force: true } }
  await argoPost<void>(`/api/v1/applications/${encodeURIComponent(name)}/sync`, body)
}

/** Roll the Application back to a revision history entry by its `id`. */
export async function rollbackApplication(name: string, id: number): Promise<void> {
  await argoPost<void>(`/api/v1/applications/${encodeURIComponent(name)}/rollback`, { id })
}
