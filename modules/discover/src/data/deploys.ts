import { useQuery } from '@tanstack/react-query'
import { argocd } from '@adhar/api-clients'

/**
 * Recent deploys from Argo CD — the platform's CD tool — used as chart
 * annotations and the "Recent deploys" widget.
 *
 * A deploy is one entry of an Application's `.status.history` (each successful
 * sync records `deployedAt` + revision), plus the current operation when it is
 * still running or failed (those never reach history). Nothing is inferred
 * from metrics.
 */

const argoClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

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
export function deployEvents(apps: argocd.Application[], sinceMs: number, namespace?: string | null): DeployEvent[] {
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

export function useArgoApps(refreshMs: number | false = 60_000) {
  return useQuery({
    queryKey: ['discover', 'argocd', 'apps'],
    queryFn: () => argoClient.listApplications(),
    staleTime: 30_000,
    refetchInterval: refreshMs,
    retry: false,
  })
}

export function shortRev(rev?: string): string {
  if (!rev) return ''
  return /^[0-9a-f]{12,}$/i.test(rev) ? rev.slice(0, 7) : rev
}
