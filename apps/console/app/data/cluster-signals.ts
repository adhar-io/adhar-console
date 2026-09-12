import { k8s } from '@adhar-console/api-clients'
import { useQuery } from '@tanstack/react-query'
import { useLiveRefetch } from '@adhar-console/shell-ui'

/**
 * Shared Overview cluster summary. Deliberately host-local — the Decide module
 * has its own copy tailored to its KPI tiles; the Overview only needs the
 * coarse-grained aggregates below.
 *
 * Each query is driven by the apiserver watch on its resource, so the Overview
 * reflects a pod crashing or a sync completing as it happens. The interval is
 * the fallback for a dropped socket, not the primary mechanism.
 */
// `auto()` → the console's authenticated `/api/k8s` gateway (per-user token
// impersonation), in dev and prod alike. No local proxy involved.
const client = k8s.K8sClient.auto()
const REFRESH_MS = 15_000

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
  const nodesKey = ['overview', 'nodes']
  const nodes = useQuery({
    queryKey: nodesKey,
    queryFn: () => client.listNodes(),
    refetchInterval: useLiveRefetch(GVR.nodes, [nodesKey], REFRESH_MS),
    retry: false,
  })
  const deploymentsKey = ['overview', 'deployments']
  const deployments = useQuery({
    queryKey: deploymentsKey,
    queryFn: () => client.listDeployments(),
    refetchInterval: useLiveRefetch(GVR.deployments, [deploymentsKey], REFRESH_MS),
    retry: false,
  })
  const podsKey = ['overview', 'pods']
  const pods = useQuery({
    queryKey: podsKey,
    queryFn: () => client.listPods(),
    refetchInterval: useLiveRefetch(GVR.pods, [podsKey], REFRESH_MS),
    retry: false,
  })
  const argoAppsKey = ['overview', 'argo-apps']
  const argoApps = useQuery({
    queryKey: argoAppsKey,
    queryFn: () => client.listGeneric(undefined, GVR.argoApps),
    refetchInterval: useLiveRefetch(GVR.argoApps, [argoAppsKey], REFRESH_MS),
    retry: false,
  })
  const rolloutsKey = ['overview', 'rollouts']
  const rollouts = useQuery({
    queryKey: rolloutsKey,
    queryFn: () => client.listGeneric(undefined, GVR.rollouts),
    refetchInterval: useLiveRefetch(GVR.rollouts, [rolloutsKey], REFRESH_MS),
    retry: false,
  })
  // Kyverno records most results in *namespaced* PolicyReports (one per workload),
  // not the cluster-scoped ClusterPolicyReports (whose summaries are usually
  // empty). Read both and aggregate so the Security sub-score reflects the whole
  // policy surface, not just the handful of cluster-wide rules.
  const policyReportsKey = ['overview', 'policy-reports']
  const policyReports = useQuery({
    queryKey: policyReportsKey,
    queryFn: () => client.listGeneric(undefined, GVR.policyReports),
    refetchInterval: useLiveRefetch(GVR.policyReports, [policyReportsKey], REFRESH_MS),
    retry: false,
  })
  const clusterPolicyReportsKey = ['overview', 'cluster-policy-reports']
  const clusterPolicyReports = useQuery({
    queryKey: clusterPolicyReportsKey,
    queryFn: () => client.listGeneric(undefined, GVR.clusterPolicyReports),
    refetchInterval: useLiveRefetch(GVR.clusterPolicyReports, [clusterPolicyReportsKey], REFRESH_MS),
    retry: false,
  })
  return { nodes, deployments, pods, argoApps, rollouts, policyReports, clusterPolicyReports }
}

export interface ClusterSummary {
  connected: boolean
  connecting: boolean
  deployFrequencyPerWeek: number
  activeDeployments: number
  totalDeployments: number
  healthyDeploymentsPct: number
  nodes: { ready: number; total: number }
  pods: { running: number; failing: number; total: number }
  argo: { installed: boolean; synced: number; total: number; healthy: number }
  rollouts: { installed: boolean; healthy: number; total: number }
  policy: { installed: boolean; pass: number; fail: number; warn: number }
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

  const argoInstalled = !isNotFound(data.argoApps.error)
  const argoApps = (data.argoApps.data ?? []) as Array<{
    status?: { sync?: { status?: string }; health?: { status?: string } }
  }>
  const synced = argoApps.filter((a) => a.status?.sync?.status === 'Synced').length
  const healthyArgo = argoApps.filter((a) => a.status?.health?.status === 'Healthy').length

  const rolloutsInstalled = !isNotFound(data.rollouts.error)
  const rollouts = (data.rollouts.data ?? []) as Array<{ status?: { phase?: string } }>
  const healthyRollouts = rollouts.filter((r) => r.status?.phase === 'Healthy').length

  const policyInstalled =
    !isNotFound(data.policyReports.error) || !isNotFound(data.clusterPolicyReports.error)
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
    deployFrequencyPerWeek: recent,
    activeDeployments: healthyDeps,
    totalDeployments: deployments.length,
    healthyDeploymentsPct: deployments.length
      ? Math.round((healthyDeps / deployments.length) * 100)
      : 100,
    nodes: { ready, total: nodes.length },
    pods: { running, failing, total: pods.length },
    argo: { installed: argoInstalled, synced, total: argoApps.length, healthy: healthyArgo },
    rollouts: { installed: rolloutsInstalled, healthy: healthyRollouts, total: rollouts.length },
    policy: { installed: policyInstalled, pass, fail, warn },
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 404
}
