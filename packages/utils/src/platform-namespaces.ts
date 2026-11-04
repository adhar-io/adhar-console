/**
 * The platform's own namespaces: the cluster's (`kube-*`), the Adhar control
 * plane, and the platform tools it runs. One list for the whole console.
 * Chaos refuses to target them; the Service map leaves them out of its
 * default "Applications" view, so a team's traffic is not buried under
 * hundreds of platform services.
 */
export const PLATFORM_NAMESPACES: readonly string[] = [
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'adhar-system',
  'argocd',
  'litmus',
  'cert-manager',
  'keycloak',
  'cilium',
  'monitoring',
  'kyverno',
  'kargo',
  'gitea',
  'harbor',
  'tekton-pipelines',
  'argo',
  'argo-rollouts',
  'external-secrets',
  'crossplane-system',
]

/** True for a platform namespace: the list above, `kube-*`, `openshift-*` or any `*-system`. */
export function isPlatformNamespace(ns: string): boolean {
  return PLATFORM_NAMESPACES.includes(ns) || ns.startsWith('kube-') || ns.startsWith('openshift-') || ns.endsWith('-system')
}
