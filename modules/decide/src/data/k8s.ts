import { k8s } from '@adhar-console/api-clients'
import { useQuery } from '@tanstack/react-query'
import { useLiveRefetch } from '@adhar-console/shell-ui'

export const client = k8s.K8sClient.auto()

const REFRESH_MS = 15_000

const GVR = {
  nodes: { group: '', version: 'v1', resource: 'nodes', namespaced: false },
  deployments: { group: 'apps', version: 'v1', resource: 'deployments', namespaced: true },
  pods: { group: '', version: 'v1', resource: 'pods', namespaced: true },
  argoApps: { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications', namespaced: true },
  rollouts: { group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts', namespaced: true },
  policyReports: { group: 'wgpolicyk8s.io', version: 'v1alpha2', resource: 'clusterpolicyreports', namespaced: false },
} as const

/**
 * Decide's KPI inputs. Every one is watch-driven, so the tiles move with the
 * cluster rather than on a 15-second cadence; the interval only applies while
 * the live socket is down.
 */
export function useDecideSignals() {
  const nodesKey = ['decide', 'nodes']
  const nodes = useQuery({
    queryKey: nodesKey,
    queryFn: () => client.listNodes(),
    refetchInterval: useLiveRefetch(GVR.nodes, [nodesKey], REFRESH_MS),
    retry: false,
  })
  const deploymentsKey = ['decide', 'deployments']
  const deployments = useQuery({
    queryKey: deploymentsKey,
    queryFn: () => client.listDeployments(),
    refetchInterval: useLiveRefetch(GVR.deployments, [deploymentsKey], REFRESH_MS),
    retry: false,
  })
  const podsKey = ['decide', 'pods']
  const pods = useQuery({
    queryKey: podsKey,
    queryFn: () => client.listPods(),
    refetchInterval: useLiveRefetch(GVR.pods, [podsKey], REFRESH_MS),
    retry: false,
  })
  const argoAppsKey = ['decide', 'argo-apps']
  const argoApps = useQuery({
    queryKey: argoAppsKey,
    queryFn: () => client.listGeneric(undefined, GVR.argoApps),
    refetchInterval: useLiveRefetch(GVR.argoApps, [argoAppsKey], REFRESH_MS),
    retry: false,
  })
  const rolloutsKey = ['decide', 'rollouts']
  const rollouts = useQuery({
    queryKey: rolloutsKey,
    queryFn: () => client.listGeneric(undefined, GVR.rollouts),
    refetchInterval: useLiveRefetch(GVR.rollouts, [rolloutsKey], REFRESH_MS),
    retry: false,
  })
  const policyReportsKey = ['decide', 'policy-reports']
  const policyReports = useQuery({
    queryKey: policyReportsKey,
    queryFn: () => client.listGeneric(undefined, GVR.policyReports),
    refetchInterval: useLiveRefetch(GVR.policyReports, [policyReportsKey], REFRESH_MS),
    retry: false,
  })

  return { nodes, deployments, pods, argoApps, rollouts, policyReports }
}

export interface DecideStats {
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

/**
 * Aggregate live cluster data into decision-ready signals. "Installed" flags
 * let the UI tell the operator a tool isn't present vs. just has zero items.
 */
export function summarize(
  data: ReturnType<typeof useDecideSignals>,
): DecideStats {
  const deployments = (data.deployments.data ?? []) as Array<{
    spec?: { replicas?: number }
    status?: { readyReplicas?: number; conditions?: Array<{ type: string; status: string }> }
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
    deployFrequencyPerWeek: recent,
    activeDeployments: healthyDeps,
    totalDeployments: deployments.length,
    healthyDeploymentsPct: deployments.length
      ? Math.round((healthyDeps / deployments.length) * 100)
      : 100,
    nodes: { ready, total: nodes.length },
    pods: { running, failing, total: pods.length },
    argo: {
      installed: argoInstalled,
      synced,
      total: argoApps.length,
      healthy: healthyArgo,
    },
    rollouts: { installed: rolloutsInstalled, healthy: healthyRollouts, total: rollouts.length },
    policy: { installed: policyInstalled, pass, fail, warn },
  }
}

function isNotFound(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  return status === 404
}
