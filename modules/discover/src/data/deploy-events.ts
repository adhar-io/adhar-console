
/**
 * Pure half of `deploys.ts` — no client construction and no package imports,
 * so it unit-tests without env access. `AppLike` is the structural subset of
 * `argocd.Application` this reads.
 */

export interface AppLike {
  metadata: { name: string }
  spec: { destination: { namespace?: string } }
  status: {
    health: { status: string }
    sync: { status: string }
    history?: Array<{ revision?: string; revisions?: string[]; deployedAt?: string }>
    operationState?: { phase: string; startedAt?: string; finishedAt?: string; revision?: string }
  }
}

export interface DeployEvent {
  /** epoch ms */
  t: number
  app: string
  namespace: string
  revision?: string
  phase: 'Succeeded' | 'Running' | 'Failed' | 'Error' | string
  health: string
  sync: string
}

/** Flatten applications into deploy events, newest first. Pure (tested). */
export function deployEvents(apps: AppLike[], sinceMs: number, namespace?: string | null): DeployEvent[] {
  const out: DeployEvent[] = []
  for (const a of apps) {
    const ns = a.spec.destination.namespace ?? ''
    if (namespace && ns !== namespace) continue
    const base = { app: a.metadata.name, namespace: ns, health: a.status.health.status, sync: a.status.sync.status }
    const seen = new Set<number>()
    for (const h of a.status.history ?? []) {
      const t = h.deployedAt ? Date.parse(h.deployedAt) : NaN
      if (!Number.isFinite(t) || t < sinceMs) continue
      seen.add(t)
      out.push({ ...base, t, revision: h.revision ?? h.revisions?.[0], phase: 'Succeeded' })
    }
    const op = a.status.operationState
    if (op && op.phase !== 'Succeeded') {
      const t = Date.parse(op.finishedAt ?? op.startedAt ?? '')
      if (Number.isFinite(t) && t >= sinceMs && !seen.has(t)) out.push({ ...base, t, revision: op.revision, phase: op.phase })
    }
  }
  return out.sort((a, b) => b.t - a.t)
}

export function shortRev(rev?: string): string {
  if (!rev) return ''
  return /^[0-9a-f]{12,}$/i.test(rev) ? rev.slice(0, 7) : rev
}
