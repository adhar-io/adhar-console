/**
 * The Kubernetes pages, grouped into categories.
 *
 * One registry, read by both the sidebar (nav-tree.tsx — one row per
 * category) and the Platform module (one page per category, its pages as
 * tabs), so a tab and its nav row can never disagree. A page's `id` is its
 * `?section=` value, unchanged from when every page had its own row, so old
 * links still land on the right tab.
 *
 * Not here, deliberately: the Dashboard (the Kubernetes landing page, its own
 * sidebar row and page) and pages that belong to another group's rail (Builds,
 * Chaos Engineering) — each keeps a page of its own.
 */

export type K8sCategoryId = 'cluster' | 'workloads' | 'network' | 'access' | 'observe' | 'tools'

export interface K8sPage {
  id: string
  label: string
  description: string
  /** Operator-only (as the old rows were annotated); kept for the nav rows. */
  ops?: boolean
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
      { id: 'workloads', label: 'Deployments & Jobs', description: 'Deployments, StatefulSets, DaemonSets, Jobs and CronJobs.' },
      { id: 'pods', label: 'Pods', description: 'Live pods with logs, shell, metrics and YAML edit.' },
      { id: 'autoscaling', label: 'Autoscaling', description: 'HorizontalPodAutoscalers — current vs target, min/max.' },
      { id: 'releases', label: 'Helm Releases', description: 'Installed Helm releases — revisions, status, values.' },
    ],
  },
  {
    id: 'network',
    label: 'Network & storage',
    pages: [
      { id: 'networking', label: 'Networking', description: 'Services, Ingresses and Gateways.' },
      { id: 'storage', label: 'Storage', description: 'PersistentVolumeClaims, PersistentVolumes and StorageClasses.' },
      { id: 'config', label: 'Config & Secrets', description: 'ConfigMaps and Secrets — values always redacted.', ops: true },
    ],
  },
  {
    id: 'access',
    label: 'Access & policy',
    pages: [
      { id: 'rbac', label: 'RBAC', description: 'ServiceAccounts, Roles and their bindings.', ops: true },
      { id: 'policy', label: 'Policy', description: 'Kyverno policies, violations and exceptions.', ops: true },
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
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    pages: [
      { id: 'explore', label: 'Explore', description: 'Browse every Kubernetes kind with a detail drawer and YAML edit.' },
      { id: 'crds', label: 'Custom Resources', description: 'CRDs from Argo, Kargo, Crossplane, Kyverno and more.' },
      { id: 'shell', label: 'Cloud Shell', description: 'An in-browser terminal into any pod, as you.', ops: true },
      { id: 'marketplace', label: 'Marketplace', description: 'Curated Helm charts, installed with platform integration.', ops: true },
    ],
  },
]

/** The category a `?section=` value belongs to, if it is a Kubernetes page. */
export function k8sCategoryOf(section: string | undefined): K8sCategory | undefined {
  if (!section) return undefined
  return K8S_CATEGORIES.find((c) => c.pages.some((p) => p.id === section))
}
