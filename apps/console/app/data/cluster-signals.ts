import { k8s } from '@adhar-console/api-clients'
import { useQuery } from '@tanstack/react-query'

/**
 * Shared Overview cluster summary. Deliberately host-local — the Decide module
 * has its own copy tailored to its KPI tiles; the Overview only needs the
 * coarse-grained aggregates below.
 */
const client = k8s.K8sClient.create({ baseUrl: '/kube-api' })
const REFRESH_MS = 15_000

export function useClusterSignals() {
  const nodes = useQuery({
    queryKey: ['overview', 'nodes'],
    queryFn: () => client.listNodes(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  const deployments = useQuery({
    queryKey: ['overview', 'deployments'],
    queryFn: () => client.listDeployments(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  const pods = useQuery({
    queryKey: ['overview', 'pods'],
    queryFn: () => client.listPods(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  const argoApps = useQuery({
    queryKey: ['overview', 'argo-apps'],
    queryFn: () =>
      client.listGeneric(undefined, {
        group: 'argoproj.io',
        version: 'v1alpha1',
        resource: 'applications',
        namespaced: true,
      }),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  const rollouts = useQuery({
    queryKey: ['overview', 'rollouts'],
    queryFn: () =>
      client.listGeneric(undefined, {
        group: 'argoproj.io',
        version: 'v1alpha1',
        resource: 'rollouts',
        namespaced: true,
      }),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  const policyReports = useQuery({
    queryKey: ['overview', 'policy-reports'],
    queryFn: () =>
      client.listGeneric(undefined, {
        group: 'wgpolicyk8s.io',
        version: 'v1alpha2',
        resource: 'clusterpolicyreports',
        namespaced: false,
      }),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
  return { nodes, deployments, pods, argoApps, rollouts, policyReports }
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

  const policyInstalled = !isNotFound(data.policyReports.error)
  const reports = (data.policyReports.data ?? []) as Array<{
    summary?: { pass?: number; fail?: number; warn?: number }
  }>
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
