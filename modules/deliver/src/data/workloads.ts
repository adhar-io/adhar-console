/**
 * The workloads an environment namespace runs, whatever kind delivers them.
 *
 * Every application template ships an Argo Rollout (canary), not a
 * Deployment, so a roll-up that listed Deployments alone showed a backend only
 * through the cache or broker Deployments composed beside it, and a frontend —
 * a Rollout and nothing else — not at all (GCP, 2026-10-21).
 *
 * Pure: no React, no network.
 */

export interface WorkloadRow {
  kind: 'Deployment' | 'Rollout' | 'StatefulSet'
  name: string
  ready: number
  want: number
  /** Argo Rollouts' own phase (Healthy, Progressing, Paused, Degraded). */
  phase?: string
}

interface ScaledObject {
  metadata?: { name?: string }
  spec?: { replicas?: number }
  status?: { readyReplicas?: number; phase?: string }
}

function row(kind: WorkloadRow['kind'], o: ScaledObject): WorkloadRow | null {
  const name = o.metadata?.name
  if (!name) return null
  return {
    kind,
    name,
    ready: o.status?.readyReplicas ?? 0,
    want: o.spec?.replicas ?? 0,
    ...(kind === 'Rollout' && o.status?.phase ? { phase: o.status.phase } : {}),
  }
}

/**
 * Rollouts first (they are the applications), then everything else, each
 * group by name. A Rollout's pods are owned by ReplicaSets, never by a
 * Deployment, so nothing is listed twice.
 */
export function workloadRows(input: {
  rollouts?: readonly ScaledObject[]
  deployments?: readonly ScaledObject[]
  statefulSets?: readonly ScaledObject[]
}): WorkloadRow[] {
  const rows = [
    ...(input.rollouts ?? []).map((o) => row('Rollout', o)),
    ...(input.deployments ?? []).map((o) => row('Deployment', o)),
    ...(input.statefulSets ?? []).map((o) => row('StatefulSet', o)),
  ].filter((r): r is WorkloadRow => r !== null)
  const rank = { Rollout: 0, Deployment: 1, StatefulSet: 2 }
  return rows.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name))
}

/** Healthy when everything wanted is ready — and a Rollout says so too. */
export function workloadOk(r: WorkloadRow): boolean {
  if (r.want <= 0) return false
  if (r.ready < r.want) return false
  return r.kind !== 'Rollout' || !r.phase || r.phase === 'Healthy'
}
