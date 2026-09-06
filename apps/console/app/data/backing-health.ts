import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { k8s } from '@adhar-console/api-clients'
import type { ServiceHealth } from '@adhar-console/platform-info'

/**
 * Live health for the platform's backing open-source components.
 *
 * The Platform status page used to show a static `health: 'operational'` for
 * every component. This derives real health from the cluster: we list the
 * platform's Deployments / StatefulSets / DaemonSets and match each component to
 * its workload(s) by name, then fold their readiness into a single status —
 * operational (all replicas ready), degraded (some ready), outage (none ready),
 * or unknown (no workload found). Refetched on an interval so the page is live.
 */

const client = k8s.K8sClient.auto()
const REFRESH_MS = 15_000

const DEPLOY_GVR = { group: 'apps', version: 'v1', resource: 'deployments', namespaced: true } as const
const STS_GVR = { group: 'apps', version: 'v1', resource: 'statefulsets', namespaced: true } as const
const DS_GVR = { group: 'apps', version: 'v1', resource: 'daemonsets', namespaced: true } as const

/** Per-component name matchers (include keywords, optional excludes). */
const MATCHERS: Record<string, { include: string[]; exclude?: string[] }> = {
  gitea: { include: ['gitea'] },
  argocd: { include: ['argo-cd', 'argocd'] },
  kargo: { include: ['kargo'] },
  'argo-rollouts': { include: ['argo-rollout'] },
  'argo-workflows': { include: ['argo-workflow', 'workflow-controller'] },
  // "plane" collides with "crossplane"/"control-plane" — exclude them.
  crossplane: { include: ['crossplane'] },
  keycloak: { include: ['keycloak'] },
  harbor: { include: ['harbor'] },
  kyverno: { include: ['kyverno'] },
  plane: { include: ['plane'], exclude: ['crossplane', 'control-plane'] },
  grafana: { include: ['grafana'] },
  loki: { include: ['loki'] },
  mimir: { include: ['mimir'] },
  tempo: { include: ['tempo'] },
  prometheus: { include: ['prometheus', 'kube-prometheus'] },
  opentelemetry: { include: ['opentelemetry', 'otel', 'alloy'] },
  beyla: { include: ['beyla'] },
}

interface Workload {
  name: string
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet'
  ready: number
  desired: number
}

export interface ToolHealth {
  health: ServiceHealth
  ready: number
  desired: number
  workloads: Workload[]
}

function toWorkloads(items: unknown[], kind: Workload['kind']): Workload[] {
  return (items as Array<{
    metadata?: { name?: string }
    spec?: { replicas?: number }
    status?: {
      readyReplicas?: number
      numberReady?: number
      desiredNumberScheduled?: number
      currentNumberScheduled?: number
    }
  }>).map((o) => {
    const name = o.metadata?.name ?? ''
    if (kind === 'DaemonSet') {
      return {
        name,
        kind,
        ready: o.status?.numberReady ?? 0,
        desired: o.status?.desiredNumberScheduled ?? o.status?.currentNumberScheduled ?? 0,
      }
    }
    return {
      name,
      kind,
      ready: o.status?.readyReplicas ?? 0,
      desired: o.spec?.replicas ?? 0,
    }
  })
}

function matchWorkloads(all: Workload[], id: string): Workload[] {
  const m = MATCHERS[id]
  if (!m) return []
  return all.filter((w) => {
    const n = w.name.toLowerCase()
    if (m.exclude?.some((e) => n.includes(e))) return false
    return m.include.some((k) => n.includes(k))
  })
}

function foldHealth(workloads: Workload[]): { health: ServiceHealth; ready: number; desired: number } {
  if (workloads.length === 0) return { health: 'unknown', ready: 0, desired: 0 }
  const ready = workloads.reduce((s, w) => s + Math.min(w.ready, w.desired || w.ready), 0)
  const desired = workloads.reduce((s, w) => s + (w.desired || 0), 0)
  const allReady = workloads.every((w) => (w.desired ? w.ready >= w.desired : w.ready > 0))
  const noneReady = workloads.every((w) => w.ready === 0)
  const health: ServiceHealth = allReady ? 'operational' : noneReady ? 'outage' : 'degraded'
  return { health, ready, desired }
}

export interface BackingHealth {
  byId: Record<string, ToolHealth>
  isLoading: boolean
  isError: boolean
  /** Whether the cluster was reachable (any list resolved). */
  live: boolean
  updatedAt: number | undefined
}

export function useBackingHealth(): BackingHealth {
  const q = useQuery({
    queryKey: ['status', 'backing-health'],
    queryFn: async () => {
      const [dep, sts, ds] = await Promise.all([
        client.listGeneric(undefined, DEPLOY_GVR).catch(() => []),
        client.listGeneric(undefined, STS_GVR).catch(() => []),
        client.listGeneric(undefined, DS_GVR).catch(() => []),
      ])
      return [
        ...toWorkloads(dep as unknown[], 'Deployment'),
        ...toWorkloads(sts as unknown[], 'StatefulSet'),
        ...toWorkloads(ds as unknown[], 'DaemonSet'),
      ]
    },
    refetchInterval: REFRESH_MS,
    retry: false,
  })

  const byId = useMemo(() => {
    const all = q.data ?? []
    const out: Record<string, ToolHealth> = {}
    for (const id of Object.keys(MATCHERS)) {
      const workloads = matchWorkloads(all, id)
      const { health, ready, desired } = foldHealth(workloads)
      out[id] = { health, ready, desired, workloads }
    }
    return out
  }, [q.data])

  return {
    byId,
    isLoading: q.isLoading,
    isError: q.isError,
    live: !q.isError && Array.isArray(q.data) && q.data.length > 0,
    updatedAt: q.dataUpdatedAt || undefined,
  }
}

/** Roll every component up into one overall platform status. */
export function overallHealth(byId: Record<string, ToolHealth>): {
  kind: 'healthy' | 'degraded' | 'failed' | 'unknown'
  healthy: number
  degraded: number
  down: number
  unknown: number
  total: number
} {
  const vals = Object.values(byId)
  let healthy = 0
  let degraded = 0
  let down = 0
  let unknown = 0
  for (const v of vals) {
    if (v.health === 'operational') healthy++
    else if (v.health === 'degraded' || v.health === 'partial-outage') degraded++
    else if (v.health === 'outage') down++
    else unknown++
  }
  const kind = down > 0 ? 'failed' : degraded > 0 ? 'degraded' : healthy > 0 ? 'healthy' : 'unknown'
  return { kind, healthy, degraded, down, unknown, total: vals.length }
}
