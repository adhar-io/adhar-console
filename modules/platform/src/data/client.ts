import { kube } from '@adhar-console/api-clients/k8s'
import type {
  ApiSurface,
  Cluster,
  Deployment,
  Event,
  Generic,
  GVR,
  Ingress,
  K8sClient,
  LogsParams,
  Namespace,
  Node,
  Pod,
  PodMetrics,
  Service,
  VersionInfo,
} from '@adhar-console/api-clients/k8s'
import {
  getActiveCluster,
  getActiveNamespace,
  getNamespaceScope,
  LOCAL_CLUSTER,
  setActiveCluster,
  subscribeSelection,
  useActiveCluster,
  useActiveNamespace,
  useNamespaceScope,
} from '@adhar-console/shell-ui'
import { GVRS } from './gvr.ts'

/* ─────────── shared cluster + namespace selection ─────────── */

/**
 * The active cluster **and** the active namespace now live in the shell's
 * shared selection store (`@adhar-console/shell-ui`), so the top-bar pickers
 * (rendered by the host) and this data layer (in the platform remote) stay in
 * sync across the Module-Federation boundary via `localStorage` + a `window`
 * event — shell-ui is not a shared singleton, so a plain variable would not.
 *
 * We re-export the same names the platform module always imported from here, so
 * every existing caller (`useActiveCluster`, `clusterParam`, `LOCAL_CLUSTER`, …)
 * keeps working unchanged. Every data hook folds the cluster **and** namespace
 * into its query key, so switching either re-scopes every view automatically.
 */
export {
  getActiveCluster,
  getActiveNamespace,
  getNamespaceScope,
  LOCAL_CLUSTER,
  setActiveCluster,
  useActiveCluster,
  useActiveNamespace,
  useNamespaceScope,
}

/** Back-compat alias — the old cluster-only subscribe name. */
export const subscribeActiveCluster = subscribeSelection

/**
 * Gateway `?cluster=` value for a UI selection. `local` / `default` / empty
 * mean "the gateway's default cluster" and return `undefined` so those
 * requests stay byte-identical to single-cluster operation.
 */
export function clusterParam(cluster?: string): string | undefined {
  return !cluster || cluster === LOCAL_CLUSTER || cluster === 'default' ? undefined : cluster
}

/** A gateway-configured cluster, annotated with its default flag. */
export type GatewayCluster = Cluster & { isDefault: boolean }

/**
 * The platform module talks to the cluster through the console's **Kubernetes
 * gateway** (`/api/k8s/*`) — a discovery-driven, streaming reverse proxy
 * authenticated as the signed-in user (per-user RBAC via their Keycloak token
 * with the `adhar-cli` audience). This adapter implements the legacy
 * `K8sClient` surface on top of the gateway so every existing view keeps
 * working while gaining per-user identity; new code should prefer `kube`
 * (live watch, apply, access-review) directly.
 */

async function raw<T>(path: string, cluster?: string): Promise<T> {
  const c = clusterParam(cluster)
  const q = c ? `${path.includes('?') ? '&' : '?'}cluster=${encodeURIComponent(c)}` : ''
  const res = await fetch(`/api/k8s${path}${q}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

const items = <T>(gvr: GVR, ns?: string, cluster?: string) =>
  kube.list<T>(gvr, { namespace: ns, cluster: clusterParam(cluster) }).then((l) => l.items)

const gatewayClient: K8sClient = {
  getVersion: (c) => raw<VersionInfo>('/version', c),
  getApiSurface: async (c) => {
    const [core, apis] = await Promise.all([
      raw<{ versions: string[] }>('/api', c),
      raw<{
        groups: Array<{
          name: string
          versions: Array<{ version: string }>
          preferredVersion: { version: string }
        }>
      }>('/apis', c),
    ])
    return {
      coreVersions: core.versions,
      apiGroups: apis.groups.map((g) => ({
        name: g.name,
        versions: g.versions.map((v) => v.version),
        preferredVersion: g.preferredVersion.version,
      })),
    } satisfies ApiSurface
  },

  /**
   * Clusters configured on the gateway (`K8S_CLUSTERS`), each probed with the
   * cheap `/version` check plus a node count. Falls back to a single default
   * entry when the gateway predates the `/-/clusters` meta endpoint. An
   * unreachable cluster is still listed — `healthy: false` — so the picker can
   * show it instead of silently hiding it.
   */
  listClusters: async () => {
    let configured: Array<{ name: string; default: boolean }> = []
    try {
      configured = (await kube.clusters()).clusters
    } catch {
      /* older gateway without /-/clusters — probe the default cluster only */
    }
    if (configured.length === 0) configured = [{ name: LOCAL_CLUSTER, default: true }]
    const server = (typeof window !== 'undefined' && window.location.origin) || ''
    return Promise.all(
      configured.map(async (c): Promise<GatewayCluster> => {
        const cluster = c.default ? undefined : c.name
        try {
          const [version, nodes] = await Promise.all([
            kube.serverVersion({ cluster }),
            kube
              .list<unknown>(GVRS.nodes, { cluster })
              .then((l) => l.items)
              .catch(() => []),
          ])
          return {
            name: c.name,
            server,
            version: version.gitVersion ?? '',
            platform: version.platform ?? '',
            nodeCount: nodes.length,
            healthy: true,
            source: 'kubeconfig',
            isDefault: c.default,
          }
        } catch {
          return {
            name: c.name,
            server,
            version: '',
            platform: '',
            nodeCount: 0,
            healthy: false,
            source: 'kubeconfig',
            isDefault: c.default,
          }
        }
      }),
    )
  },

  listNamespaces: (c, selector) =>
    kube
      .list<Namespace>(GVRS.namespaces, { labelSelector: selector, cluster: clusterParam(c) })
      .then((l) => l.items),
  listNodes: (c) => items<Node>(GVRS.nodes, undefined, c),
  listPods: (c, ns, selector) =>
    kube
      .list<Pod>(GVRS.pods, { namespace: ns, labelSelector: selector, cluster: clusterParam(c) })
      .then((l) => l.items),
  getPod: (c, ns, name) => kube.get<Pod>(GVRS.pods, ns, name, { cluster: clusterParam(c) }),
  deletePod: async (c, ns, name) => {
    await kube.delete(GVRS.pods, ns, name, { cluster: clusterParam(c) })
  },
  podLogs: (c, ns, name, params: LogsParams = {}) =>
    kube.logStream(ns, name, {
      container: params.container,
      tailLines: params.tailLines,
      timestamps: params.timestamps,
      sinceSeconds: params.sinceSeconds,
      previous: params.previous,
      follow: false,
      cluster: clusterParam(c),
    }),
  podMetrics: async (c, ns, name) => {
    try {
      return await kube.get<PodMetrics>(GVRS.podMetrics, ns, name, { cluster: clusterParam(c) })
    } catch (e) {
      if ((e as { status?: number })?.status === 404) return undefined
      throw e
    }
  },

  listDeployments: (c, ns) => items<Deployment>(GVRS.deployments, ns, c),
  listStatefulSets: (c, ns) => items<Generic>(GVRS.statefulsets, ns, c),
  listDaemonSets: (c, ns) => items<Generic>(GVRS.daemonsets, ns, c),
  listJobs: (c, ns) => items<Generic>(GVRS.jobs, ns, c),
  listCronJobs: (c, ns) => items<Generic>(GVRS.cronjobs, ns, c),
  scaleDeployment: async (c, ns, name, replicas) => {
    await kube.patch(GVRS.deployments, ns, name, { spec: { replicas } }, 'merge', {
      cluster: clusterParam(c),
    })
  },

  listServices: (c, ns) => items<Service>(GVRS.services, ns, c),
  listIngresses: (c, ns) => items<Ingress>(GVRS.ingresses, ns, c),
  listConfigMaps: (c, ns) => items<Generic>(GVRS.configmaps, ns, c),
  listSecrets: (c, ns) => items<Generic>(GVRS.secrets, ns, c),
  listPersistentVolumes: (c) => items<Generic>(GVRS.persistentvolumes, undefined, c),
  listPersistentVolumeClaims: (c, ns) => items<Generic>(GVRS.persistentvolumeclaims, ns, c),
  listStorageClasses: (c) => items<Generic>(GVRS.storageclasses, undefined, c),
  listServiceAccounts: (c, ns) => items<Generic>(GVRS.serviceaccounts, ns, c),
  listRoles: (c, ns) => items<Generic>(GVRS.roles, ns, c),
  listRoleBindings: (c, ns) => items<Generic>(GVRS.rolebindings, ns, c),
  listClusterRoles: (c) => items<Generic>(GVRS.clusterroles, undefined, c),
  listClusterRoleBindings: (c) => items<Generic>(GVRS.clusterrolebindings, undefined, c),
  listEvents: (c, ns) => items<Event>(GVRS.events, ns, c),

  listGeneric: (c, gvr: GVR, ns) => items<Generic>(gvr, ns, c),
  getGeneric: (c, gvr: GVR, ns, name) => kube.get<Generic>(gvr, ns, name, { cluster: clusterParam(c) }),
  replaceGeneric: (c, _gvr, _ns, _name, obj) =>
    kube.apply<Generic>(obj as Parameters<typeof kube.apply>[0], {
      force: true,
      cluster: clusterParam(c),
    }),
}

export const client: K8sClient = gatewayClient
