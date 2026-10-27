/**
 * Health of an arbitrary custom resource, read the way its operator reports
 * it — Argo CD's `status.health`, Crossplane/controller-runtime conditions, a
 * `status.phase`. The reader itself (`crStatus`) lives in `@adhar/utils` so
 * other remotes (Develop → Functions) read health the same way; it is
 * re-exported here so this module's views and `crd-status_test.ts` keep
 * importing it from where they always have.
 */
import type { CrHealth } from '@adhar/utils'

export { crStatus, type CrHealth, type CrStatus } from '@adhar/utils'

export const HEALTH_BADGE: Record<CrHealth, 'healthy' | 'progressing' | 'failed' | 'unknown'> = {
  healthy: 'healthy',
  progressing: 'progressing',
  degraded: 'failed',
  unknown: 'unknown',
}

/** Friendly name for an API group (`postgresql.cnpg.io` → "CloudNativePG"). */
export function groupLabel(group: string): string {
  const known: Array<[RegExp, string]> = [
    [/(^|\.)argoproj\.io$/, 'Argo'],
    [/kargo\.akuity\.io$/, 'Kargo'],
    [/crossplane\.io$/, 'Crossplane'],
    [/upbound\.io$/, 'Crossplane providers'],
    [/kyverno\.io$/, 'Kyverno'],
    [/wgpolicyk8s\.io$/, 'Policy reports'],
    [/tekton\.dev$/, 'Tekton'],
    [/cilium\.io$/, 'Cilium'],
    [/cnpg\.io$/, 'CloudNativePG'],
    [/velero\.io$/, 'Velero'],
    [/cert-manager\.io$/, 'cert-manager'],
    [/external-secrets\.io$/, 'External Secrets'],
    [/keda\.sh$/, 'KEDA'],
    [/platform\.adhar\.io$/, 'Adhar'],
    [/monitoring\.coreos\.com$/, 'Prometheus'],
    [/gateway\.networking(\.x)?-?k8s\.io$/, 'Gateway API'],
    [/strimzi\.io$/, 'Strimzi'],
    [/opensearch\.org$/, 'OpenSearch'],
    [/kpack\.io$/, 'kpack'],
    [/dapr\.io$/, 'Dapr'],
    [/litmuschaos\.io$/, 'Litmus'],
    [/k8sgpt\.ai$/, 'K8sGPT'],
    [/altinity\.com$/, 'ClickHouse'],
    [/snapshot\.storage\.k8s\.io$/, 'Volume snapshots'],
    [/agentgateway\.dev$/, 'agentgateway'],
  ]
  for (const [re, name] of known) if (re.test(group)) return name
  return group
}
