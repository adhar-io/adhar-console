import { useQuery } from '@tanstack/react-query'
import { kube } from '@adhar-console/api-clients/k8s'
import { useLiveK8sList } from '@adhar-console/shell-ui'
import type { GatewayGVR as GVR, KubeObject } from '@adhar-console/api-clients/k8s'
import { clusterParam, useActiveCluster, useActiveNamespace } from './client.ts'

/**
 * Live, watch-backed Kubernetes lists. Instead of polling, `useLiveList` does
 * one initial list to seed state + capture `resourceVersion`, then holds an
 * apiserver **watch** open and merges ADDED/MODIFIED/DELETED deltas into a
 * keyed map. It transparently reconnects (resumes from the last
 * resourceVersion; relists from scratch on `410 Gone`), with backoff.
 *
 * The return shape mirrors TanStack Query (`data` / `isLoading` / `error`) so
 * existing views can swap polling → live with no other changes, plus a `status`
 * field for a "● live" indicator.
 */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'error'

export interface LiveList<T> {
  data: T[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  status: LiveStatus
  /** Force a fresh relist + rewatch. */
  refetch: () => void
}


export function useLiveList<T extends KubeObject = KubeObject>(
  gvr: GVR,
  opts: {
    namespace?: string
    labelSelector?: string
    fieldSelector?: string
    enabled?: boolean
    /** Explicit cluster override — defaults to the active-cluster selection. */
    cluster?: string
  } = {},
): LiveList<T> {
  const { namespace: explicitNamespace, labelSelector, fieldSelector, enabled = true } = opts
  const { cluster: activeCluster } = useActiveCluster()
  const { namespace: activeNamespace } = useActiveNamespace()
  // Namespaced resources fall back to the shared active-namespace selection
  // (the top-bar Namespace picker) when no explicit namespace is given;
  // cluster-scoped resources (nodes, namespaces, PVs, …) stay cluster-wide.
  const namespace = gvr.namespaced ? (explicitNamespace ?? activeNamespace) : explicitNamespace
  const cluster = clusterParam(opts.cluster ?? activeCluster)
  // All watches ride the single `/api/live` WebSocket (server-side list +
  // watch with the user's token) instead of one HTTP stream per list.
  const live = useLiveK8sList<T>(
    { group: gvr.group, version: gvr.version, resource: gvr.resource },
    { namespace, labelSelector, fieldSelector, cluster, enabled },
  )
  return live
}

/* ─────────── discovery + access review ─────────── */

export function useDiscovery() {
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'discovery', cluster],
    queryFn: () => kube.discovery({ cluster: clusterParam(cluster) }).then((r) => r.resources),
    staleTime: 5 * 60_000,
  })
}

/** Reactive SelfSubjectAccessReview — gate action buttons on it. */
export function useAccess(attrs: {
  verb: string
  group?: string
  resource: string
  namespace?: string
  name?: string
  subresource?: string
  enabled?: boolean
}) {
  const { enabled = true, ...rest } = attrs
  const { cluster } = useActiveCluster()
  return useQuery({
    queryKey: ['k8s', 'access', rest.verb, rest.group ?? '', rest.resource, rest.namespace ?? '', rest.name ?? '', cluster],
    queryFn: () => kube.access(rest, { cluster: clusterParam(cluster) }).then((r) => r.allowed),
    enabled,
    staleTime: 60_000,
  })
}
