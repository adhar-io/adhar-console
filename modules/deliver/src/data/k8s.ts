import { k8s } from '@adhar/api-clients'
import { useQuery } from '@tanstack/react-query'
import { useWatchSignal } from './live.ts'

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

type GVR = k8s.GVR

/**
 * A CRD list kept current by the apiserver watch on that resource. The
 * `refetchInterval` is the (one-minute) fallback for a dropped socket or a
 * refused watch; while the socket is up the list refetches on a real change
 * (throttled to one per 5s), which is what makes a PipelineRun or a Rollout
 * appear to move in real time.
 */
export function useCRD(gvr: GVR, namespace?: string, enabled = true) {
  const queryKey = ['deliver', gvr.group, gvr.version, gvr.resource, namespace ?? '*']
  return useQuery({
    queryKey,
    queryFn: () => client.listGeneric(undefined, gvr, namespace),
    enabled,
    refetchInterval: useWatchSignal(
      { group: gvr.group, version: gvr.version, resource: gvr.resource, namespace },
      [queryKey],
      { enabled },
    ),
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
