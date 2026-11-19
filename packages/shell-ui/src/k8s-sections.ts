/**
 * The Kubernetes pages, grouped into categories.
 *
 * One registry, read by both the sidebar (nav-tree.tsx — one row per
 * category) and the Platform module (one page per category, its pages as
 * tabs), so a tab and its nav row can never disagree. A page's `id` is its
 * `?section=` value, unchanged from when every page had its own row, so old
 * links still land on the right tab.
 *
 * Not here, deliberately: the Dashboard, Cloud Shell and Marketplace (each its
 * own sidebar row and page, set in nav-tree.tsx) and pages that belong to
 * another group's rail (Builds, Chaos Engineering).
 */

export type K8sCategoryId = 'cluster' | 'workloads' | 'networking' | 'storage' | 'config' | 'access' | 'observe'

export interface K8sPage {
  id: string
  label: string
  description: string
  /** Operator-only (as the old rows were annotated); kept for the nav rows. */
  ops?: boolean
  /**
   * Older `?section=` values that now open this page — kept so existing links
   * (and Adhar AI, which cites `?section=workloads`) still land somewhere.
   */
  aliases?: readonly string[]
}

export interface K8sCategory {
  id: K8sCategoryId
  label: string
  pages: K8sPage[]
}

export const K8S_CATEGORIES: K8sCategory[] = [
  {
    id: 'cluster',
    label: 'Cluster',
    pages: [
      { id: 'clusters', label: 'Clusters', description: 'Cluster capacity, version and API surface.' },
      { id: 'nodes', label: 'Nodes', description: 'Every worker — capacity, conditions, taints, drain.' },
      { id: 'namespaces', label: 'Namespaces', description: 'Namespaces with quota usage, limit ranges and labels.' },
      { id: 'quotas', label: 'Quota & Limits', description: 'ResourceQuotas and LimitRanges with live usage.' },
    ],
  },
  {
    id: 'workloads',
    label: 'Workloads',
    pages: [
      // One tab per kind — no second tab row inside a tab.
      { id: 'deployments', label: 'Deployments', description: 'Deployments with rollout status, scale and restart.', aliases: ['workloads'] },
      { id: 'statefulsets', label: 'StatefulSets', description: 'StatefulSets with ordered, stable-identity replicas.' },
      { id: 'daemonsets', label: 'DaemonSets', description: 'DaemonSets running one pod per node.' },
      { id: 'replicasets', label: 'ReplicaSets', description: 'ReplicaSets, most owned by a Deployment revision.' },
      { id: 'jobs', label: 'Jobs', description: 'Jobs — completions, duration and logs.' },
      { id: 'cronjobs', label: 'CronJobs', description: 'CronJobs — schedule, last run, trigger and suspend.' },
      { id: 'pods', label: 'Pods', description: 'Live pods with logs, shell, metrics and YAML edit.' },
      { id: 'autoscaling', label: 'Autoscaling', description: 'HorizontalPodAutoscalers — current vs target, min/max.' },
      { id: 'releases', label: 'Helm Releases', description: 'Installed Helm releases — revisions, status, values.' },
    ],
  },
  // Ids here avoid the Adhar Resources ones on the same URL — `services`
  // is the Services XR, hence `k8s-services`.
  {
    id: 'networking',
    label: 'Networking',
    pages: [
      { id: 'k8s-services', label: 'Services', description: 'Services with type, cluster IP and ports.', aliases: ['networking'] },
      { id: 'endpoints', label: 'Endpoints', description: 'Ready and not-ready addresses behind each Service.' },
      { id: 'ingresses', label: 'Ingresses', description: 'Ingresses with hosts, paths and TLS.' },
      { id: 'gateways', label: 'Gateways', description: 'Gateway API Gateways and their listeners.' },
      { id: 'gateway-routes', label: 'Routes', description: 'HTTPRoutes and other Gateway API routes.' },
      { id: 'gateway-classes', label: 'Gateway Classes', description: 'GatewayClasses and the controllers behind them.' },
      { id: 'network-policies', label: 'Network Policies', description: 'NetworkPolicies and the pods they select.' },
    ],
  },
  {
    id: 'storage',
    label: 'Storage',
    pages: [
      { id: 'pvcs', label: 'PersistentVolumeClaims', description: 'Claims with capacity, access modes and binding.', aliases: ['storage'] },
      { id: 'pvs', label: 'PersistentVolumes', description: 'Volumes with capacity, reclaim policy and claim.' },
      { id: 'storage-classes', label: 'StorageClasses', description: 'StorageClasses with provisioner and defaults.' },
    ],
  },
  {
    id: 'config',
    label: 'Config & Secrets',
    pages: [
      { id: 'configmaps', label: 'ConfigMaps', description: 'ConfigMaps with their keys and values.', ops: true, aliases: ['config'] },
      { id: 'secrets', label: 'Secrets', description: 'Secrets — values always redacted.', ops: true },
    ],
  },
  {
    id: 'access',
    label: 'Access & policy',
    pages: [
      // One tab per kind and per policy view — no second tab row.
      { id: 'service-accounts', label: 'ServiceAccounts', description: 'ServiceAccounts and the secrets they mount.', ops: true, aliases: ['rbac'] },
      { id: 'roles', label: 'Roles', description: 'Namespaced Roles and their rules.', ops: true },
      { id: 'role-bindings', label: 'RoleBindings', description: 'Who holds which Role, per namespace.', ops: true },
      { id: 'cluster-roles', label: 'ClusterRoles', description: 'Cluster-wide roles and their rules.', ops: true },
      { id: 'cluster-role-bindings', label: 'ClusterRoleBindings', description: 'Who holds which ClusterRole.', ops: true },
      { id: 'policies', label: 'Policies', description: 'Kyverno policies — enforce or audit, with pass/fail tallies.', ops: true, aliases: ['policy'] },
      { id: 'policy-violations', label: 'Violations', description: 'Resources failing a Kyverno policy.', ops: true },
      { id: 'policy-exceptions', label: 'Exceptions', description: 'Kyverno PolicyExceptions in force.', ops: true },
    ],
  },
  {
    id: 'observe',
    label: 'Observability',
    pages: [
      { id: 'events', label: 'Events', description: 'Warning and normal events, newest first.' },
      { id: 'logs', label: 'Logs', description: 'Live, streaming pod logs with follow, filter and download.' },
      { id: 'metrics', label: 'Metrics', description: 'Node capacity, usage and the heaviest pods.' },
      { id: 'graph', label: 'Knowledge Graph', description: 'What runs here and how it all connects.' },
      { id: 'explore', label: 'Explore', description: 'Browse every Kubernetes kind with a detail drawer and YAML edit.' },
      { id: 'crds', label: 'Custom Resources', description: 'CRDs from Argo, Kargo, Crossplane, Kyverno and more.' },
    ],
  },
]

/** The page a `?section=` value opens — by id, or by a retired id (alias). */
export function k8sPageOf(section: string | undefined): K8sPage | undefined {
  if (!section) return undefined
  for (const c of K8S_CATEGORIES) {
    const page = c.pages.find((p) => p.id === section || p.aliases?.includes(section))
    if (page) return page
  }
  return undefined
}

/** The category a `?section=` value belongs to, if it is a Kubernetes page. */
export function k8sCategoryOf(section: string | undefined): K8sCategory | undefined {
  const page = k8sPageOf(section)
  return page ? K8S_CATEGORIES.find((c) => c.pages.includes(page)) : undefined
}
