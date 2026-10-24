import type { k8s } from '@adhar/api-clients'
import { useK8sList } from './live-k8s.ts'

/**
 * Shared Overview cluster summary. Deliberately host-local — the Decide module
 * has its own copy tailored to its KPI tiles; the Overview only needs the
 * coarse-grained aggregates below.
 *
 * Each list is loaded once and then kept current by the apiserver watch on its
 * resource (deltas folded into the cache — no re-list per change), so the
 * Overview reflects a pod crashing or a sync completing as it happens. The
 * lists use the canonical `k8sListKey`, so `platform-signals.ts` and the
 * catalog read the very same cache entries.
 */

const GVR = {
  nodes: { group: '', version: 'v1', resource: 'nodes', namespaced: false },
  deployments: { group: 'apps', version: 'v1', resource: 'deployments', namespaced: true },
  pods: { group: '', version: 'v1', resource: 'pods', namespaced: true },
  argoApps: { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications', namespaced: true },
  rollouts: { group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts', namespaced: true },
  policyReports: { group: 'wgpolicyk8s.io', version: 'v1alpha2', resource: 'policyreports', namespaced: true },
  clusterPolicyReports: { group: 'wgpolicyk8s.io', version: 'v1alpha2', resource: 'clusterpolicyreports', namespaced: false },
} as const

export function useClusterSignals() {
  const nodes = useK8sList<k8s.Node>(GVR.nodes)
  const deployments = useK8sList<k8s.Deployment>(GVR.deployments)
  const pods = useK8sList<k8s.Pod>(GVR.pods)
  const argoApps = useK8sList(GVR.argoApps)
  const rollouts = useK8sList(GVR.rollouts)
  // Kyverno records most results in *namespaced* PolicyReports (one per workload),
  // not the cluster-scoped ClusterPolicyReports (whose summaries are usually
  // empty). Read both and aggregate so the Security sub-score reflects the whole
  // policy surface, not just the handful of cluster-wide rules.
  const policyReports = useK8sList(GVR.policyReports)
  const clusterPolicyReports = useK8sList(GVR.clusterPolicyReports)
  return { nodes, deployments, pods, argoApps, rollouts, policyReports, clusterPolicyReports }
}

/**
 * Where an optional CRD-backed source stands. `installed` on each block below
 * is only true when the list actually came back (`ready`) — a loading query or
 * a 403/500 must never read as "installed with 0 items".
 */
export type SourceState = 'loading' | 'ready' | 'absent' | 'error'

export interface ClusterSummary {
  connected: boolean
  connecting: boolean
  /** Deployments whose creationTimestamp is within the last 7 days (not a deploy-event count). */
  newDeployments7d: number
  /** @deprecated alias of `newDeployments7d` — kept for older callers. */
  deployFrequencyPerWeek: number
  activeDeployments: number
  totalDeployments: number
  /** null when there are no deployments (or the list hasn't loaded) — never a default 100. */
  healthyDeploymentsPct: number | null
  nodes: { ready: number; total: number }
  pods: { running: number; failing: number; total: number }
  argo: { state: SourceState; installed: boolean; synced: number; total: number; healthy: number }
  rollouts: { state: SourceState; installed: boolean; healthy: number; total: number }
  policy: {
    state: SourceState
    installed: boolean
    pass: number
    fail: number
    warn: number
    /** pass + fail + warn — 0 means no policy results yet. */
    evaluated: number
  }
}

type QueryLike = { isLoading?: boolean; isError?: boolean; error?: unknown; data?: unknown }

/** Classify a CRD list query: 404 ⇒ CRD absent; any other error ⇒ error; no data yet ⇒ loading. */
export function sourceState(q: QueryLike): SourceState {
  if (q.isError || q.error) return isNotFound(q.error) ? 'absent' : 'error'
  if (q.isLoading || q.data === undefined) return 'loading'
  return 'ready'
}

/** Combine the two policy report lists — ready if either answered, absent if both 404. */
function combinePolicy(a: SourceState, b: SourceState): SourceState {
  if (a === 'ready' || b === 'ready') return 'ready'
  if (a === 'loading' || b === 'loading') return 'loading'
  if (a === 'absent' && b === 'absent') return 'absent'
  return 'error'
}

export function summarizeCluster(
  data: ReturnType<typeof useClusterSignals>,
): ClusterSummary {
  const deployments = (data.deployments.data ?? []) as Array<{
    spec?: { replicas?: number }
    status?: { readyReplicas?: number }
    metadata?: { creationTimestamp?: string }
  }>
  const healthyDeps = deployments.filter((d) => {
    const replicas = d.spec?.replicas ?? 0
    return (d.status?.readyReplicas ?? 0) >= replicas && replicas > 0
  }).length
  const recent = deployments.filter((d) => {
    const ts = d.metadata?.creationTimestamp
    if (!ts) return false
    return Date.now() - new Date(ts).getTime() < 7 * 24 * 60 * 60 * 1000
  }).length

  const pods = (data.pods.data ?? []) as Array<{ status?: { phase?: string } }>
  const running = pods.filter((p) => p.status?.phase === 'Running').length
  const failing = pods.filter((p) => p.status?.phase === 'Failed').length

  const nodes = (data.nodes.data ?? []) as Array<{
    status?: { conditions?: Array<{ type: string; status: string }> }
  }>
  const ready = nodes.filter((n) =>
    (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
  ).length

  const argoState = sourceState(data.argoApps)
  const argoApps = (data.argoApps.data ?? []) as Array<{
    status?: { sync?: { status?: string }; health?: { status?: string } }
  }>
  const synced = argoApps.filter((a) => a.status?.sync?.status === 'Synced').length
  const healthyArgo = argoApps.filter((a) => a.status?.health?.status === 'Healthy').length

  const rolloutsState = sourceState(data.rollouts)
  const rollouts = (data.rollouts.data ?? []) as Array<{ status?: { phase?: string } }>
  const healthyRollouts = rollouts.filter((r) => r.status?.phase === 'Healthy').length

  const policyState = combinePolicy(
    sourceState(data.policyReports),
    sourceState(data.clusterPolicyReports),
  )
  const reports = [
    ...((data.policyReports.data ?? []) as Array<{
      summary?: { pass?: number; fail?: number; warn?: number }
    }>),
    ...((data.clusterPolicyReports.data ?? []) as Array<{
      summary?: { pass?: number; fail?: number; warn?: number }
    }>),
  ]
  const pass = reports.reduce((a, r) => a + (r.summary?.pass ?? 0), 0)
  const fail = reports.reduce((a, r) => a + (r.summary?.fail ?? 0), 0)
  const warn = reports.reduce((a, r) => a + (r.summary?.warn ?? 0), 0)

  return {
    connected: !data.nodes.isError,
    connecting: data.nodes.isLoading,
    newDeployments7d: recent,
    deployFrequencyPerWeek: recent,
    activeDeployments: healthyDeps,
    totalDeployments: deployments.length,
    healthyDeploymentsPct: deployments.length
      ? Math.round((healthyDeps / deployments.length) * 100)
      : null,
    nodes: { ready, total: nodes.length },
    pods: { running, failing, total: pods.length },
    argo: {
      state: argoState,
      installed: argoState === 'ready',
      synced,
      total: argoApps.length,
      healthy: healthyArgo,
    },
    rollouts: {
      state: rolloutsState,
      installed: rolloutsState === 'ready',
      healthy: healthyRollouts,
      total: rollouts.length,
    },
    policy: {
      state: policyState,
      installed: policyState === 'ready',
      pass,
      fail,
      warn,
      evaluated: pass + fail + warn,
    },
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 404
}
