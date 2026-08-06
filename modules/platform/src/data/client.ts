import { k8s } from '@adhar-console/api-clients'
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
import { GVRS } from './gvr.ts'

export const LOCAL_CLUSTER = 'local'

/**
 * The platform module talks to the cluster through the console's **Kubernetes
 * gateway** (`/api/k8s/*`) — a discovery-driven, streaming reverse proxy
 * authenticated as the signed-in user (per-user RBAC via their Keycloak token
 * with the `adhar-cli` audience). This adapter implements the legacy
 * `K8sClient` surface on top of the gateway so every existing view keeps
 * working while gaining per-user identity; new code should prefer `kube`
 * (live watch, apply, access-review) directly.
 */

async function raw<T>(path: string): Promise<T> {
  const res = await fetch(`/api/k8s${path}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

const items = <T>(gvr: GVR, ns?: string) =>
  kube.list<T>(gvr, { namespace: ns }).then((l) => l.items)

/** Dev (pure SPA, no gateway) → stub fixtures; prod → the per-user gateway. */
export const isDevK8s = (() => {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
  } catch {
    return false
  }
})()

const gatewayClient: K8sClient = {
  getVersion: () => raw<VersionInfo>('/version'),
  getApiSurface: async () => {
    const [core, apis] = await Promise.all([
      raw<{ versions: string[] }>('/api'),
      raw<{
        groups: Array<{
          name: string
          versions: Array<{ version: string }>
          preferredVersion: { version: string }
        }>
      }>('/apis'),
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

  listClusters: async () => {
    try {
      const version = await raw<VersionInfo>('/version')
      const nodes = await items<unknown>(GVRS.nodes)
      return [
        {
          name: LOCAL_CLUSTER,
          server: (typeof window !== 'undefined' && window.location.origin) || '',
          version: version.gitVersion,
          platform: version.platform,
          nodeCount: nodes.length,
          healthy: true,
          source: 'kubeconfig',
        } satisfies Cluster,
      ]
    } catch {
      return []
    }
  },

  listNamespaces: () => items<Namespace>(GVRS.namespaces),
  listNodes: () => items<Node>(GVRS.nodes),
  listPods: (_c, ns, selector) =>
    kube.list<Pod>(GVRS.pods, { namespace: ns, labelSelector: selector }).then((l) => l.items),
  getPod: (_c, ns, name) => kube.get<Pod>(GVRS.pods, ns, name),
  deletePod: async (_c, ns, name) => {
    await kube.delete(GVRS.pods, ns, name)
  },
  podLogs: (_c, ns, name, params: LogsParams = {}) =>
    kube.logStream(ns, name, {
      container: params.container,
      tailLines: params.tailLines,
      timestamps: params.timestamps,
      sinceSeconds: params.sinceSeconds,
      previous: params.previous,
      follow: false,
    }),
  podMetrics: async (_c, ns, name) => {
    try {
      return await kube.get<PodMetrics>(GVRS.podMetrics, ns, name)
    } catch (e) {
      if ((e as { status?: number })?.status === 404) return undefined
      throw e
    }
  },

  listDeployments: (_c, ns) => items<Deployment>(GVRS.deployments, ns),
  listStatefulSets: (_c, ns) => items<Generic>(GVRS.statefulsets, ns),
  listDaemonSets: (_c, ns) => items<Generic>(GVRS.daemonsets, ns),
  listJobs: (_c, ns) => items<Generic>(GVRS.jobs, ns),
  listCronJobs: (_c, ns) => items<Generic>(GVRS.cronjobs, ns),
  scaleDeployment: async (_c, ns, name, replicas) => {
    await kube.patch(GVRS.deployments, ns, name, { spec: { replicas } }, 'merge')
  },

  listServices: (_c, ns) => items<Service>(GVRS.services, ns),
  listIngresses: (_c, ns) => items<Ingress>(GVRS.ingresses, ns),
  listConfigMaps: (_c, ns) => items<Generic>(GVRS.configmaps, ns),
  listSecrets: (_c, ns) => items<Generic>(GVRS.secrets, ns),
  listPersistentVolumes: () => items<Generic>(GVRS.persistentvolumes),
  listPersistentVolumeClaims: (_c, ns) => items<Generic>(GVRS.persistentvolumeclaims, ns),
  listStorageClasses: () => items<Generic>(GVRS.storageclasses),
  listServiceAccounts: (_c, ns) => items<Generic>(GVRS.serviceaccounts, ns),
  listRoles: (_c, ns) => items<Generic>(GVRS.roles, ns),
  listRoleBindings: (_c, ns) => items<Generic>(GVRS.rolebindings, ns),
  listClusterRoles: () => items<Generic>(GVRS.clusterroles),
  listClusterRoleBindings: () => items<Generic>(GVRS.clusterrolebindings),
  listEvents: (_c, ns) => items<Event>(GVRS.events, ns),

  listGeneric: (_c, gvr: GVR, ns) => items<Generic>(gvr, ns),
  getGeneric: (_c, gvr: GVR, ns, name) => kube.get<Generic>(gvr, ns, name),
  replaceGeneric: (_c, _gvr, _ns, _name, obj) =>
    kube.apply<Generic>(obj as Parameters<typeof kube.apply>[0], { force: true }),
}

export const client: K8sClient = isDevK8s ? k8s.K8sClient.stub() : gatewayClient
