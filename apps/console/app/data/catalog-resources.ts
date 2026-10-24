import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { argocd, k8s } from '@adhar/api-clients'
import type { ArgoTreeNode, CompositionGraph, KObj } from './catalog-composition-model.ts'
import { useWatchInvalidate } from './live-k8s.ts'
import { buildAppGraph, indexLive, type ManagedResource, managedIndex, podUsage, type PodUsage, withLive } from './catalog-resources-model.ts'

/**
 * Live data for the catalog drawer's Resources tab — one Argo CD application
 * at a time, the way Argo CD's app details view reads it:
 *
 *   • the Application itself, raw, through the per-user Kubernetes gateway
 *     (`status.resources` carries per-resource sync and prune flags that the
 *     normalised Argo client drops);
 *   • Argo's live resource tree (`/api/v1/applications/<app>/resource-tree`
 *     via the BFF) — the parent/child edges, health, images, networking;
 *   • live objects in the app's namespaces (Pods, workloads, Services,
 *     routes) for replica counts, container states, nodes and selectors;
 *   • `metrics.k8s.io` pod usage when metrics-server is installed;
 *   • on demand, Argo's managed resources (desired vs live manifests).
 *
 * Every secondary read is optional: a list the user may not read, or a CRD
 * that is not installed, just means less detail — never an error state.
 */

const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

/** Minimum gap between two watch-driven re-reads of the tab. */
export const RESOURCES_REFRESH_MS = 10_000
/** Pod usage (metrics.k8s.io) has no watch; re-read this often while shown. */
const USAGE_REFRESH_MS = 120_000

const ARGO_APPS: k8s.GatewayGVR = { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications', namespaced: true }

const LIVE_KINDS: Array<{ gvr: k8s.GatewayGVR; kind: string; apiVersion: string }> = [
  { gvr: { group: '', version: 'v1', resource: 'pods', namespaced: true }, kind: 'Pod', apiVersion: 'v1' },
  { gvr: { group: 'apps', version: 'v1', resource: 'deployments', namespaced: true }, kind: 'Deployment', apiVersion: 'apps/v1' },
  { gvr: { group: 'apps', version: 'v1', resource: 'replicasets', namespaced: true }, kind: 'ReplicaSet', apiVersion: 'apps/v1' },
  { gvr: { group: 'apps', version: 'v1', resource: 'statefulsets', namespaced: true }, kind: 'StatefulSet', apiVersion: 'apps/v1' },
  { gvr: { group: 'apps', version: 'v1', resource: 'daemonsets', namespaced: true }, kind: 'DaemonSet', apiVersion: 'apps/v1' },
  { gvr: { group: '', version: 'v1', resource: 'services', namespaced: true }, kind: 'Service', apiVersion: 'v1' },
  { gvr: { group: 'networking.k8s.io', version: 'v1', resource: 'ingresses', namespaced: true }, kind: 'Ingress', apiVersion: 'networking.k8s.io/v1' },
  { gvr: { group: 'gateway.networking.k8s.io', version: 'v1', resource: 'httproutes', namespaced: true }, kind: 'HTTPRoute', apiVersion: 'gateway.networking.k8s.io/v1' },
]

/** Which live kinds are worth listing in a namespace: only those Argo says the app has there. */
function kindsIn(graph: CompositionGraph, ns: string): Set<string> {
  return new Set(Object.values(graph.nodes).filter((n) => n.id !== graph.roots[0] && (n.namespace ?? '') === ns).map((n) => n.kind))
}

export interface AppResources {
  app: KObj
  graph: CompositionGraph
  usage?: Map<string, PodUsage>
  /** Argo's resource tree could not be read — the graph is `status.resources` only. */
  treeUnavailable: boolean
}

export async function loadAppResources(ref: { name: string; namespace?: string }): Promise<AppResources> {
  const raw = await k8s.kube.get<KObj>(ARGO_APPS, ref.namespace, ref.name)
  const app: KObj = { ...raw, apiVersion: raw.apiVersion ?? 'argoproj.io/v1alpha1', kind: raw.kind ?? 'Application' }
  let tree: ArgoTreeNode[] | undefined
  try {
    tree = (await argocdClient.getResourceTree(ref.name, ref.namespace)) as ArgoTreeNode[]
  } catch {
    tree = undefined
  }
  const graph = buildAppGraph(app, tree)
  const namespaces = [...new Set(Object.values(graph.nodes).filter((n) => n.id !== graph.roots[0]).map((n) => n.namespace).filter((n): n is string => Boolean(n)))]
  const lists = await Promise.all(
    namespaces.flatMap((ns) => {
      const kinds = kindsIn(graph, ns)
      return LIVE_KINDS.filter((k) => kinds.has(k.kind)).map(async (k) => {
        try {
          const list = await k8s.kube.list<KObj>(k.gvr, { namespace: ns })
          return list.items.map((o) => ({ ...o, apiVersion: o.apiVersion ?? k.apiVersion, kind: o.kind ?? k.kind }))
        } catch {
          return [] as KObj[]
        }
      })
    }),
  )
  let usage: Map<string, PodUsage> | undefined
  const podNamespaces = namespaces.filter((ns) => kindsIn(graph, ns).has('Pod'))
  if (podNamespaces.length) {
    try {
      const all = await Promise.all(podNamespaces.map((ns) =>
        k8s.kube.list<KObj & { containers?: Array<{ usage?: { cpu?: string; memory?: string } }> }>(
          { group: 'metrics.k8s.io', version: 'v1beta1', resource: 'pods', namespaced: true },
          { namespace: ns },
        )
      ))
      usage = podUsage(all.flatMap((l) => l.items))
    } catch {
      usage = undefined
    }
  }
  return { app, graph: withLive(graph, indexLive(lists.flat())), usage, treeUnavailable: !tree }
}

export function useAppResources(ref: { name: string; namespace?: string } | undefined, opts: { paused: boolean }) {
  const queryKey = ['catalog', 'resources', ref?.namespace, ref?.name]
  const qc = useQueryClient()
  const prev = qc.getQueryData<AppResources>(queryKey)
  // What changes the picture: the Application (Argo CD rewrites its status on
  // every health/sync change) and the Pods in the app's namespaces. Their
  // watches trigger the re-read — at most one per 10s during a rollout,
  // nothing at all while the app is steady.
  const podNamespaces = prev
    ? [...new Set(Object.values(prev.graph.nodes).filter((n) => n.kind === 'Pod' && n.namespace).map((n) => n.namespace as string))].sort()
    : []
  const fallback = useWatchInvalidate(
    ref
      ? [
        { group: ARGO_APPS.group, version: ARGO_APPS.version, resource: ARGO_APPS.resource, ...(ref.namespace ? { namespace: ref.namespace } : {}), fieldSelector: `metadata.name=${ref.name}` },
        ...podNamespaces.map((namespace) => ({ group: '', version: 'v1', resource: 'pods', namespace })),
      ]
      : [],
    [queryKey],
    { enabled: !opts.paused, minGapMs: RESOURCES_REFRESH_MS },
  )
  return useQuery<AppResources>({
    queryKey,
    queryFn: () => loadAppResources(ref!),
    enabled: Boolean(ref),
    // Pod CPU/memory come from metrics.k8s.io, which cannot be watched: with
    // usage on screen, a slow timer keeps it honest.
    refetchInterval: opts.paused ? false : fallback || (prev?.usage ? USAGE_REFRESH_MS : false),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    retry: false,
  })
}

/** Argo's desired vs live manifests for every resource of the app (read on demand). */
export function useManagedResources(ref: { name: string; namespace?: string } | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['catalog', 'resources', 'managed', ref?.namespace, ref?.name],
    queryFn: async () => {
      const q = ref!.namespace ? `?appNamespace=${encodeURIComponent(ref!.namespace)}` : ''
      const res = await fetch(`/api/svc/argocd/api/v1/applications/${encodeURIComponent(ref!.name)}/managed-resources${q}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw Object.assign(new Error(`Argo CD answered ${res.status}`), { status: res.status })
      const body = (await res.json()) as { items?: ManagedResource[] }
      return managedIndex(body.items ?? [])
    },
    enabled: enabled && Boolean(ref),
    staleTime: 15_000,
    retry: false,
  })
}
