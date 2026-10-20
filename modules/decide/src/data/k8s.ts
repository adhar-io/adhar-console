import { k8s } from '@adhar/api-clients'

/** The console's k8s gateway client (`/api/k8s`, impersonating the signed-in user). */
export const client = k8s.K8sClient.auto()

export const GVR = {
  pipelineRuns: { group: 'tekton.dev', version: 'v1', resource: 'pipelineruns', namespaced: true },
  promotions: { group: 'kargo.akuity.io', version: 'v1alpha1', resource: 'promotions', namespaced: true },
  stages: { group: 'kargo.akuity.io', version: 'v1alpha1', resource: 'stages', namespaced: true },
} as const satisfies Record<string, k8s.GVR>

/** An apiserver 404 on a list: the CRD (so the tool) is not installed. */
export function isNotInstalled(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 404
}
