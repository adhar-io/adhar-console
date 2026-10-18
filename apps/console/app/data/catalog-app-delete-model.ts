import type { k8s } from '@adhar/api-clients'
import type { Entity } from './catalog.ts'

/**
 * Pure helpers behind application deletion and catalog cleanliness — no React,
 * no clients, so they test without the UI packages.
 */

/** Console personas allowed to delete an application. Mirrors the server's gate (which is the real one). */
export const APP_DELETE_ROLES = ['super-admin', 'platform-admin', 'platform-engineer', 'application-admin'] as const

export function roleCanDeleteApplications(role: string | null | undefined): boolean {
  return (APP_DELETE_ROLES as readonly string[]).includes(role ?? '')
}

/** When the XR is being deleted (Crossplane still finalising), else undefined. */
export function deletionTimestampOf(obj: { metadata?: unknown } | undefined): string | undefined {
  const ts = (obj?.metadata as { deletionTimestamp?: unknown } | undefined)?.deletionTimestamp
  return typeof ts === 'string' && ts ? ts : undefined
}

/**
 * Split Application XRs into the live ones and the names of those already
 * being deleted. A deleting XR is not an application any more: the catalog
 * hides it, and hides the workloads it still owns while Crossplane and Argo CD
 * prune them, rather than letting them resurface as stray entries.
 */
export function splitApplications<T extends { metadata?: unknown }>(apps: readonly T[]): { active: T[]; deleting: Set<string> } {
  const active: T[] = []
  const deleting = new Set<string>()
  for (const a of apps) {
    const name = (a.metadata as { name?: string } | undefined)?.name
    if (deletionTimestampOf(a)) {
      if (name) deleting.add(name.toLowerCase())
    } else active.push(a)
  }
  return { active, deleting }
}

/** True for a workload that belongs to an application whose XR is being deleted. */
export function belongsToDeletingApp(
  obj: { metadata?: { name?: string; labels?: Record<string, string> } },
  deleting: ReadonlySet<string>,
): boolean {
  if (!deleting.size) return false
  const label = (obj.metadata?.labels?.['adhar.io/application'] ?? '').toLowerCase()
  const name = (obj.metadata?.name ?? '').toLowerCase()
  return deleting.has(label || name)
}

/** Composed resources Crossplane recorded on the XR (v1 `spec.resourceRefs`, v2 `spec.crossplane.resourceRefs`). */
export function composedRefs(xr: k8s.Generic | undefined): Array<{ kind: string; name: string }> {
  const spec = (xr?.spec ?? {}) as { resourceRefs?: unknown; crossplane?: { resourceRefs?: unknown } }
  const raw = Array.isArray(spec.resourceRefs) ? spec.resourceRefs : Array.isArray(spec.crossplane?.resourceRefs) ? spec.crossplane!.resourceRefs as unknown[] : []
  const out: Array<{ kind: string; name: string }> = []
  for (const r of raw) {
    const ref = r as { kind?: unknown; name?: unknown }
    if (typeof ref.kind === 'string' && typeof ref.name === 'string') out.push({ kind: ref.kind, name: ref.name })
  }
  return out
}

/** How long a scaffolded entry may wait for its live counterpart before it counts as stale. */
const SCAFFOLD_GRACE_MS = 15 * 60_000

/**
 * Drop scaffolder-registered entries whose application no longer exists.
 *
 * Create New registers the new service in this browser's store so it shows at
 * once, and registered entries take precedence over live ones. That store is
 * never told when the application is deleted (from the catalog in another
 * browser, with kubectl, in Gitea), so the entry used to stay forever — a
 * stray card for an app that is gone. A scaffolded entry (it carries the
 * scaffolder's `adhar.io/git-repo` annotation) is therefore dropped once it is
 * older than the grace period AND every live source answered AND none of them
 * lists it. Hand-registered entries are never touched. Pure, for the test.
 */
export function pruneStaleScaffolded(
  registered: readonly Entity[],
  live: readonly Entity[],
  sourcesHealthy: boolean,
  now: number = Date.now(),
): Entity[] {
  if (!sourcesHealthy) return [...registered]
  const liveKeys = new Set(live.map((e) => `${e.kind}|${e.metadata.name.toLowerCase()}`))
  return registered.filter((e) => {
    if (!e.metadata.annotations?.['adhar.io/git-repo']) return true
    if (liveKeys.has(`${e.kind}|${e.metadata.name.toLowerCase()}`)) return true
    const created = Date.parse(e.metadata.createdAt ?? '')
    return !Number.isFinite(created) || now - created < SCAFFOLD_GRACE_MS
  })
}

