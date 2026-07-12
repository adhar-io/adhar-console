import { useQuery } from '@tanstack/react-query'
import type { k8s } from '@adhar-console/api-clients'
import { client, LOCAL_CLUSTER } from './client.ts'

export const AUTO_REFRESH_MS = 10_000

export function useConnection() {
  return useQuery({
    queryKey: ['k8s', 'version'],
    queryFn: () => client.getVersion(),
    retry: false,
    staleTime: 60_000,
  })
}

export function useApiSurface() {
  return useQuery({
    queryKey: ['k8s', 'api-surface'],
    queryFn: () => client.getApiSurface(),
    staleTime: 60_000,
  })
}

export function useNamespaces() {
  return useQuery({
    queryKey: ['k8s', 'namespaces'],
    queryFn: () => client.listNamespaces(),
    staleTime: 30_000,
  })
}

export function useClusters() {
  return useQuery({ queryKey: ['k8s', 'clusters'], queryFn: () => client.listClusters() })
}

export function useNodes() {
  return useQuery({
    queryKey: ['k8s', 'nodes'],
    queryFn: () => client.listNodes(),
    refetchInterval: AUTO_REFRESH_MS,
  })
}

export function usePods(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'pods', namespace ?? '*'],
    queryFn: () => client.listPods(LOCAL_CLUSTER, namespace),
    refetchInterval: AUTO_REFRESH_MS,
  })
}

export function useDeployments(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'deployments', namespace ?? '*'],
    queryFn: () => client.listDeployments(LOCAL_CLUSTER, namespace),
    refetchInterval: AUTO_REFRESH_MS,
  })
}

export function useStatefulSets(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'statefulsets', namespace ?? '*'],
    queryFn: () => client.listStatefulSets(LOCAL_CLUSTER, namespace),
    refetchInterval: AUTO_REFRESH_MS,
  })
}

export function useDaemonSets(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'daemonsets', namespace ?? '*'],
    queryFn: () => client.listDaemonSets(LOCAL_CLUSTER, namespace),
    refetchInterval: AUTO_REFRESH_MS,
  })
}

export function useJobs(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'jobs', namespace ?? '*'],
    queryFn: () => client.listJobs(LOCAL_CLUSTER, namespace),
  })
}

export function useCronJobs(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'cronjobs', namespace ?? '*'],
    queryFn: () => client.listCronJobs(LOCAL_CLUSTER, namespace),
  })
}

export function useServices(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'services', namespace ?? '*'],
    queryFn: () => client.listServices(LOCAL_CLUSTER, namespace),
  })
}

export function useIngresses(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'ingresses', namespace ?? '*'],
    queryFn: () => client.listIngresses(LOCAL_CLUSTER, namespace),
  })
}

export function useConfigMaps(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'configmaps', namespace ?? '*'],
    queryFn: () => client.listConfigMaps(LOCAL_CLUSTER, namespace),
  })
}

export function useSecrets(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'secrets', namespace ?? '*'],
    queryFn: () => client.listSecrets(LOCAL_CLUSTER, namespace),
  })
}

export function usePersistentVolumes() {
  return useQuery({ queryKey: ['k8s', 'pv'], queryFn: () => client.listPersistentVolumes() })
}

export function usePersistentVolumeClaims(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'pvc', namespace ?? '*'],
    queryFn: () => client.listPersistentVolumeClaims(LOCAL_CLUSTER, namespace),
  })
}

export function useStorageClasses() {
  return useQuery({ queryKey: ['k8s', 'sc'], queryFn: () => client.listStorageClasses() })
}

export function useServiceAccounts(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'sa', namespace ?? '*'],
    queryFn: () => client.listServiceAccounts(LOCAL_CLUSTER, namespace),
  })
}

export function useRoles(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'roles', namespace ?? '*'],
    queryFn: () => client.listRoles(LOCAL_CLUSTER, namespace),
  })
}

export function useRoleBindings(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'rolebindings', namespace ?? '*'],
    queryFn: () => client.listRoleBindings(LOCAL_CLUSTER, namespace),
  })
}

export function useClusterRoles() {
  return useQuery({
    queryKey: ['k8s', 'clusterroles'],
    queryFn: () => client.listClusterRoles(),
  })
}

export function useClusterRoleBindings() {
  return useQuery({
    queryKey: ['k8s', 'clusterrolebindings'],
    queryFn: () => client.listClusterRoleBindings(),
  })
}

export function useEvents(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'events', namespace ?? '*'],
    queryFn: () => client.listEvents(LOCAL_CLUSTER, namespace),
    refetchInterval: 5_000,
  })
}

/**
 * Live CPU + memory usage per node from the metrics-server aggregator. Returns
 * an empty array gracefully when metrics-server isn't installed — the cluster
 * view falls back to "capacity only" tiles in that case.
 */
export function useNodeMetrics() {
  return useQuery({
    queryKey: ['k8s', 'node-metrics'],
    queryFn: () =>
      client
        .listGeneric(LOCAL_CLUSTER, {
          group: 'metrics.k8s.io',
          version: 'v1beta1',
          resource: 'nodes',
          namespaced: false,
        })
        .catch((err) => {
          if ((err as { status?: number })?.status === 404) return []
          throw err
        }),
    refetchInterval: AUTO_REFRESH_MS,
    retry: false,
  })
}

export function useGeneric(gvr: k8s.GVR, namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'generic', gvr.group, gvr.version, gvr.resource, namespace ?? '*'],
    queryFn: () => client.listGeneric(LOCAL_CLUSTER, gvr, namespace),
  })
}

/* ─── Workload extras ──────────────────────────────────────────────── */

export function useReplicaSets(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'replicasets', namespace ?? '*'],
    queryFn: () =>
      client.listGeneric(
        LOCAL_CLUSTER,
        { group: 'apps', version: 'v1', resource: 'replicasets', namespaced: true },
        namespace,
      ),
    refetchInterval: AUTO_REFRESH_MS,
  })
}

export function useHorizontalPodAutoscalers(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'hpa', namespace ?? '*'],
    queryFn: () =>
      client.listGeneric(
        LOCAL_CLUSTER,
        { group: 'autoscaling', version: 'v2', resource: 'horizontalpodautoscalers', namespaced: true },
        namespace,
      ),
    refetchInterval: AUTO_REFRESH_MS,
  })
}

/* ─── Networking extras ────────────────────────────────────────────── */

export function useEndpoints(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'endpoints', namespace ?? '*'],
    queryFn: () =>
      client.listGeneric(
        LOCAL_CLUSTER,
        { group: '', version: 'v1', resource: 'endpoints', namespaced: true },
        namespace,
      ),
  })
}

export function useNetworkPolicies(namespace?: string) {
  return useQuery({
    queryKey: ['k8s', 'networkpolicies', namespace ?? '*'],
    queryFn: () =>
      client.listGeneric(
        LOCAL_CLUSTER,
        { group: 'networking.k8s.io', version: 'v1', resource: 'networkpolicies', namespaced: true },
        namespace,
      ),
  })
}

export function useIngressClasses() {
  return useQuery({
    queryKey: ['k8s', 'ingressclasses'],
    queryFn: () =>
      client.listGeneric(LOCAL_CLUSTER, {
        group: 'networking.k8s.io',
        version: 'v1',
        resource: 'ingressclasses',
        namespaced: false,
      }),
  })
}

/* ─── Pod metrics (for top consumers) ──────────────────────────────── */

export function usePodMetrics() {
  return useQuery({
    queryKey: ['k8s', 'pod-metrics'],
    queryFn: () =>
      client
        .listGeneric(LOCAL_CLUSTER, {
          group: 'metrics.k8s.io',
          version: 'v1beta1',
          resource: 'pods',
          namespaced: true,
        })
        .catch((err) => {
          if ((err as { status?: number })?.status === 404) return []
          throw err
        }),
    refetchInterval: AUTO_REFRESH_MS,
    retry: false,
  })
}

export function usePodLogs(namespace: string, name: string, params?: { container?: string; tailLines?: number }) {
  return useQuery({
    queryKey: ['k8s', 'logs', namespace, name, params?.container ?? 'default', params?.tailLines ?? 500],
    queryFn: () =>
      client.podLogs(LOCAL_CLUSTER, namespace, name, {
        tailLines: params?.tailLines ?? 500,
        timestamps: true,
        container: params?.container,
      }),
    enabled: Boolean(namespace && name),
  })
}
