import { useQuery } from '@tanstack/react-query'
import type { k8s } from '@adhar-console/api-clients'
import { client, useActiveCluster, useActiveNamespace, useNamespaceScope } from './client.ts'
import { useLiveList } from './live.ts'
import { GVRS } from './gvr.ts'

export const AUTO_REFRESH_MS = 10_000

/**
 * Resolve the namespace a namespaced query should target: an explicit argument
 * wins, otherwise fall back to the shared active-namespace selection (the
 * top-bar Namespace picker). Returning `undefined` means "all namespaces".
 */
function useScopedNamespace(explicit?: string): string | undefined {
  const { namespace } = useActiveNamespace()
  return explicit ?? namespace
}

/**
 * Every hook here is scoped to the **active cluster** (see the store in
 * `client.ts`). The cluster name is appended as the *last* query-key segment
 * so prefix-based invalidation (`['k8s', 'jobs']`, …) keeps working, and with
 * the single default cluster the segment is the stable `'local'` constant —
 * no refetch churn. `useLiveList`-backed hooks pick the cluster up inside
 * `live.ts` instead.
 */

/** Cast a live (generic) list to a concrete resource type for the views. */
function asLive<T>(live: ReturnType<typeof useLiveList>) {
  return { ...live, data: live.data as unknown as T[] }
}

export function useConnection() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'version', cluster],
    queryFn: () => client.getVersion(cluster),
    retry: false,
    staleTime: 60_000,
  })
}

export function useApiSurface() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'api-surface', cluster],
    queryFn: () => client.getApiSurface(cluster),
    staleTime: 60_000,
  })
}

/**
 * Namespace list — restricted to the active organization's namespaces when an
 * org scope is set (see the shared selection store). The default / no-org case
 * passes no selector and lists every namespace (RBAC still applies upstream).
 */
export function useNamespaces() {
  const { cluster } = useActiveCluster()
  const scope = useNamespaceScope()
  return useQuery({
    queryKey: ['k8s', 'namespaces', scope, cluster],
    queryFn: () => client.listNamespaces(cluster, scope || undefined),
    staleTime: 30_000,
  })
}

/** Clusters configured on the gateway — deliberately *not* cluster-scoped. */
export function useClusters() {
  return useQuery({
    queryKey: ['k8s', 'clusters'],
    queryFn: () => client.listClusters(),
    staleTime: 60_000,
  })
}

export function useNodes() {
  return asLive<k8s.Node>(useLiveList(GVRS.nodes))
}

export function usePods(namespace?: string) {
  return asLive<k8s.Pod>(useLiveList(GVRS.pods, { namespace }))
}

export function useDeployments(namespace?: string) {
  return asLive<k8s.Deployment>(useLiveList(GVRS.deployments, { namespace }))
}

export function useStatefulSets(namespace?: string) {
  return asLive<k8s.Generic>(useLiveList(GVRS.statefulsets, { namespace }))
}

export function useDaemonSets(namespace?: string) {
  return asLive<k8s.Generic>(useLiveList(GVRS.daemonsets, { namespace }))
}

export function useJobs(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'jobs', ns ?? '*', cluster],
    queryFn: () => client.listJobs(cluster, ns),
  })
}

export function useCronJobs(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'cronjobs', ns ?? '*', cluster],
    queryFn: () => client.listCronJobs(cluster, ns),
  })
}

export function useServices(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'services', ns ?? '*', cluster],
    queryFn: () => client.listServices(cluster, ns),
  })
}

export function useIngresses(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'ingresses', ns ?? '*', cluster],
    queryFn: () => client.listIngresses(cluster, ns),
  })
}

export function useConfigMaps(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'configmaps', ns ?? '*', cluster],
    queryFn: () => client.listConfigMaps(cluster, ns),
  })
}

export function useSecrets(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'secrets', ns ?? '*', cluster],
    queryFn: () => client.listSecrets(cluster, ns),
  })
}

export function usePersistentVolumes() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'pv', cluster],
    queryFn: () => client.listPersistentVolumes(cluster),
  })
}

export function usePersistentVolumeClaims(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'pvc', ns ?? '*', cluster],
    queryFn: () => client.listPersistentVolumeClaims(cluster, ns),
  })
}

export function useStorageClasses() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'sc', cluster],
    queryFn: () => client.listStorageClasses(cluster),
  })
}

export function useServiceAccounts(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'sa', ns ?? '*', cluster],
    queryFn: () => client.listServiceAccounts(cluster, ns),
  })
}

export function useRoles(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'roles', ns ?? '*', cluster],
    queryFn: () => client.listRoles(cluster, ns),
  })
}

export function useRoleBindings(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'rolebindings', ns ?? '*', cluster],
    queryFn: () => client.listRoleBindings(cluster, ns),
  })
}

export function useClusterRoles() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'clusterroles', cluster],
    queryFn: () => client.listClusterRoles(cluster),
  })
}

export function useClusterRoleBindings() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'clusterrolebindings', cluster],
    queryFn: () => client.listClusterRoleBindings(cluster),
  })
}

export function useEvents(namespace?: string) {
  return asLive<k8s.Event>(useLiveList(GVRS.events, { namespace }))
}

/**
 * Live CPU + memory usage per node from the metrics-server aggregator. Returns
 * an empty array gracefully when metrics-server isn't installed — the cluster
 * view falls back to "capacity only" tiles in that case.
 */
export function useNodeMetrics() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'node-metrics', cluster],
    queryFn: () =>
      client
        .listGeneric(cluster, {
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
  const { cluster } = useActiveCluster()
  // Cluster-scoped GVRs ignore the active namespace; namespaced ones fall back
  // to the shared active-namespace selection.
  const active = useScopedNamespace(namespace)
  const ns = gvr.namespaced === false ? namespace : active
  return useQuery({
    queryKey: ['k8s', 'generic', gvr.group, gvr.version, gvr.resource, ns ?? '*', cluster],
    queryFn: () => client.listGeneric(cluster, gvr, ns),
  })
}

/* ─── Workload extras ──────────────────────────────────────────────── */

export function useReplicaSets(namespace?: string) {
  return asLive<k8s.Generic>(useLiveList(GVRS.replicasets, { namespace }))
}

export function useHorizontalPodAutoscalers(namespace?: string) {
  return asLive<k8s.Generic>(useLiveList(GVRS.hpa, { namespace }))
}

/* ─── Networking extras ────────────────────────────────────────────── */

export function useEndpoints(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'endpoints', ns ?? '*', cluster],
    queryFn: () =>
      client.listGeneric(
        cluster,
        { group: '', version: 'v1', resource: 'endpoints', namespaced: true },
        ns,
      ),
  })
}

export function useNetworkPolicies(namespace?: string) {
  const { cluster } = useActiveCluster()
  const ns = useScopedNamespace(namespace)
  return useQuery({
    queryKey: ['k8s', 'networkpolicies', ns ?? '*', cluster],
    queryFn: () =>
      client.listGeneric(
        cluster,
        { group: 'networking.k8s.io', version: 'v1', resource: 'networkpolicies', namespaced: true },
        ns,
      ),
  })
}

export function useIngressClasses() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'ingressclasses', cluster],
    queryFn: () =>
      client.listGeneric(cluster, {
        group: 'networking.k8s.io',
        version: 'v1',
        resource: 'ingressclasses',
        namespaced: false,
      }),
  })
}

/* ─── Pod metrics (for top consumers) ──────────────────────────────── */

export function usePodMetrics() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'pod-metrics', cluster],
    queryFn: () =>
      client
        .listGeneric(cluster, {
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
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'logs', namespace, name, params?.container ?? 'default', params?.tailLines ?? 500, cluster],
    queryFn: () =>
      client.podLogs(cluster, namespace, name, {
        tailLines: params?.tailLines ?? 500,
        timestamps: true,
        container: params?.container,
      }),
    enabled: Boolean(namespace && name),
  })
}
