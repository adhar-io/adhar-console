/**
 * Kubernetes namespaces that hold platform/system workloads, not user apps.
 * The Service Catalog is a developer view of *their* software, so these are
 * filtered out — only user namespaces (and `default`) surface. Covers the
 * well-known cluster namespaces plus the Adhar platform's own (everything the
 * platform installs lives in `adhar-system`).
 */
const SYSTEM_NAMESPACES = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'adhar-system',
  'local-path-storage',
  'metallb-system',
  'ingress-nginx',
  'cert-manager',
  'argocd',
  'argo',
  'crossplane-system',
  'external-secrets',
  'cnpg-system',
  'kyverno',
  'tekton-pipelines',
  'flux-system',
  'monitoring',
  'observability',

  // Cloud storage/network drivers installed by `adhar up`'s cloud-integration
  // step, NOT by anybody using the platform. None of these matches `kube-*` or
  // `*-system`, so each one surfaced as a catalog service: a GCP cluster listed
  // `csi-gce-pd-controller` beside the team's apps. One entry per provider, from
  // platform/providers/<cloud>/cloud_integration.go; DigitalOcean and Civo
  // install into `kube-system`, which was already covered.
  'gce-pd-csi-driver',
  'aws-ebs-csi-driver',
  'aws-cloud-controller-manager',
  'azuredisk-csi-driver',

  // Kargo's own namespaces. Its chart creates three beside the release, and
  // `kargo-system-resources` ends in `-resources` rather than `-system`, so the
  // suffix rule below catches none of them.
  'kargo-cluster-secrets',
  'kargo-shared-resources',
  'kargo-system-resources',

  // The Kargo Project namespace bootstrap creates for promotion stages. A
  // Project is release plumbing, not somebody's service.
  'adhar-environments',
])

/**
 * True for a platform/system namespace that should be hidden from the catalog.
 *
 * Kept React-free for the test: this one predicate is what stands between the catalog
 * and a page of cluster infrastructure, and the list above has already been
 * caught missing a whole class of it.
 */
export function isSystemNamespace(ns: string | undefined): boolean {
  const n = (ns ?? 'default').toLowerCase()
  if (SYSTEM_NAMESPACES.has(n)) return true
  // Conventional system namespaces: the `kube-` prefix and any `*-system`.
  if (n.startsWith('kube-') || n.endsWith('-system')) return true
  // Cloud addons by CONVENTION rather than by name, so adding a provider later
  // cannot reintroduce the bug: every CSI driver the platform installs is
  // `<cloud>-…-csi-driver`, and an external cloud-controller-manager carries
  // that phrase. A name that merely contains "csi" (`my-csi-app`) is not matched.
  if (n.endsWith('-csi-driver') || n.includes('cloud-controller')) return true
  // Data-plane vclusters are registered clusters, not services inside this one.
  return n.startsWith('dp-')
}
