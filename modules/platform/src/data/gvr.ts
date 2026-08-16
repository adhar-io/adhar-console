import type { GatewayGVR as GVR } from '@adhar-console/api-clients/k8s'

/**
 * Group/Version/Resource constants for the built-in resources the platform
 * module renders. CRDs are discovered dynamically at runtime via
 * `kube.discovery()` — this map is only the well-known core set.
 */
export const GVRS = {
  namespaces: { group: '', version: 'v1', resource: 'namespaces', namespaced: false },
  nodes: { group: '', version: 'v1', resource: 'nodes', namespaced: false },
  pods: { group: '', version: 'v1', resource: 'pods', namespaced: true },
  services: { group: '', version: 'v1', resource: 'services', namespaced: true },
  endpoints: { group: '', version: 'v1', resource: 'endpoints', namespaced: true },
  configmaps: { group: '', version: 'v1', resource: 'configmaps', namespaced: true },
  secrets: { group: '', version: 'v1', resource: 'secrets', namespaced: true },
  events: { group: '', version: 'v1', resource: 'events', namespaced: true },
  serviceaccounts: { group: '', version: 'v1', resource: 'serviceaccounts', namespaced: true },
  persistentvolumes: { group: '', version: 'v1', resource: 'persistentvolumes', namespaced: false },
  persistentvolumeclaims: { group: '', version: 'v1', resource: 'persistentvolumeclaims', namespaced: true },
  resourcequotas: { group: '', version: 'v1', resource: 'resourcequotas', namespaced: true },
  limitranges: { group: '', version: 'v1', resource: 'limitranges', namespaced: true },

  deployments: { group: 'apps', version: 'v1', resource: 'deployments', namespaced: true },
  statefulsets: { group: 'apps', version: 'v1', resource: 'statefulsets', namespaced: true },
  daemonsets: { group: 'apps', version: 'v1', resource: 'daemonsets', namespaced: true },
  replicasets: { group: 'apps', version: 'v1', resource: 'replicasets', namespaced: true },

  jobs: { group: 'batch', version: 'v1', resource: 'jobs', namespaced: true },
  cronjobs: { group: 'batch', version: 'v1', resource: 'cronjobs', namespaced: true },

  ingresses: { group: 'networking.k8s.io', version: 'v1', resource: 'ingresses', namespaced: true },
  ingressclasses: { group: 'networking.k8s.io', version: 'v1', resource: 'ingressclasses', namespaced: false },
  networkpolicies: { group: 'networking.k8s.io', version: 'v1', resource: 'networkpolicies', namespaced: true },

  storageclasses: { group: 'storage.k8s.io', version: 'v1', resource: 'storageclasses', namespaced: false },

  roles: { group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'roles', namespaced: true },
  rolebindings: { group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'rolebindings', namespaced: true },
  clusterroles: { group: 'rbac.authorization.k8s.io', version: 'v1', resource: 'clusterroles', namespaced: false },
  clusterrolebindings: {
    group: 'rbac.authorization.k8s.io',
    version: 'v1',
    resource: 'clusterrolebindings',
    namespaced: false,
  },

  hpa: { group: 'autoscaling', version: 'v2', resource: 'horizontalpodautoscalers', namespaced: true },

  nodeMetrics: { group: 'metrics.k8s.io', version: 'v1beta1', resource: 'nodes', namespaced: false },
  podMetrics: { group: 'metrics.k8s.io', version: 'v1beta1', resource: 'pods', namespaced: true },
} satisfies Record<string, GVR>

export type GvrKey = keyof typeof GVRS
