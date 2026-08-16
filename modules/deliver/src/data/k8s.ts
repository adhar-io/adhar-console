import { k8s } from '@adhar-console/api-clients'
import { useQuery } from '@tanstack/react-query'

/**
 * K8s client for the Deliver module.
 *
 * Every capability surfaced under Deliver (ArgoCD Apps, Kargo Stages, Argo
 * Rollouts, Kyverno PolicyReports) is stored in Kubernetes as a CRD — we
 * don't need each operator's REST API, the kube-apiserver is enough.
 *
 * Reaches the cluster through the console's authenticated BFF gateway
 * (`/api/k8s`), which forwards the signed-in user's token for per-user RBAC —
 * in dev and prod alike. No local proxy to run.
 */
export const client = k8s.K8sClient.auto()

const REFRESH_MS = 10_000

type GVR = k8s.GVR

export function useCRD(gvr: GVR, namespace?: string, enabled = true) {
  return useQuery({
    queryKey: ['deliver', gvr.group, gvr.version, gvr.resource, namespace ?? '*'],
    queryFn: () => client.listGeneric(undefined, gvr, namespace),
    enabled,
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

export const GVRS = {
  argoApps: {
    group: 'argoproj.io',
    version: 'v1alpha1',
    resource: 'applications',
    namespaced: true,
  },
  kargoStages: {
    group: 'kargo.akuity.io',
    version: 'v1alpha1',
    resource: 'stages',
    namespaced: true,
  },
  kargoFreights: {
    group: 'kargo.akuity.io',
    version: 'v1alpha1',
    resource: 'freights',
    namespaced: true,
  },
  rollouts: {
    group: 'argoproj.io',
    version: 'v1alpha1',
    resource: 'rollouts',
    namespaced: true,
  },
  policyReports: {
    group: 'wgpolicyk8s.io',
    version: 'v1alpha2',
    resource: 'clusterpolicyreports',
    namespaced: false,
  },
} as const
