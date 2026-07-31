import { HttpClient, HttpError, isProdBuild, type HttpClientOptions } from '../base/index.ts'
import type {
  Cluster,
  Deployment,
  Event,
  Generic,
  GVR,
  Ingress,
  LogsParams,
  Namespace,
  Node,
  Pod,
  Service,
} from './types.ts'
import {
  STUB_CLUSTERS,
  STUB_DEPLOYMENTS,
  STUB_EVENTS,
  STUB_INGRESSES,
  STUB_NAMESPACES,
  STUB_NODES,
  STUB_PODS,
  STUB_SERVICES,
  STUB_CRD_OBJECTS,
} from './stub.ts'

/**
 * Local cluster identifier — the K8s client is single-cluster (talks to whatever
 * `kubectl` context the user has active, via `kubectl proxy`). The `cluster`
 * arg on every method is vestigial to keep the stub + real impls interchangeable
 * for views that already pass a string through.
 */
export const LOCAL_CLUSTER = 'local'

export interface VersionInfo {
  major: string
  minor: string
  gitVersion: string
  platform: string
  buildDate?: string
  goVersion?: string
}

export interface ApiSurface {
  coreVersions: string[]
  apiGroups: Array<{ name: string; versions: string[]; preferredVersion: string }>
}

export interface K8sClient {
  /** `/version` — cluster server version. */
  getVersion(): Promise<VersionInfo>
  /** `/api` + `/apis` surface — used for connection checks and CRD discovery. */
  getApiSurface(): Promise<ApiSurface>

  listClusters(): Promise<Cluster[]>
  listNamespaces(cluster?: string): Promise<Namespace[]>
  listNodes(cluster?: string): Promise<Node[]>

  listPods(cluster?: string, namespace?: string, labelSelector?: string): Promise<Pod[]>
  getPod(cluster: string | undefined, namespace: string, name: string): Promise<Pod>
  deletePod(cluster: string | undefined, namespace: string, name: string): Promise<void>
  podLogs(
    cluster: string | undefined,
    namespace: string,
    name: string,
    params?: LogsParams,
  ): Promise<string>
  /**
   * Metrics for a single pod from `metrics.k8s.io`. Returns undefined when the
   * metrics-server isn't installed (404) so callers can gracefully degrade.
   */
  podMetrics(
    cluster: string | undefined,
    namespace: string,
    name: string,
  ): Promise<PodMetrics | undefined>

  listDeployments(cluster?: string, namespace?: string): Promise<Deployment[]>
  listStatefulSets(cluster?: string, namespace?: string): Promise<Generic[]>
  listDaemonSets(cluster?: string, namespace?: string): Promise<Generic[]>
  listJobs(cluster?: string, namespace?: string): Promise<Generic[]>
  listCronJobs(cluster?: string, namespace?: string): Promise<Generic[]>
  scaleDeployment(
    cluster: string | undefined,
    namespace: string,
    name: string,
    replicas: number,
  ): Promise<void>

  listServices(cluster?: string, namespace?: string): Promise<Service[]>
  listIngresses(cluster?: string, namespace?: string): Promise<Ingress[]>

  listConfigMaps(cluster?: string, namespace?: string): Promise<Generic[]>
  listSecrets(cluster?: string, namespace?: string): Promise<Generic[]>

  listPersistentVolumes(cluster?: string): Promise<Generic[]>
  listPersistentVolumeClaims(cluster?: string, namespace?: string): Promise<Generic[]>
  listStorageClasses(cluster?: string): Promise<Generic[]>

  listServiceAccounts(cluster?: string, namespace?: string): Promise<Generic[]>
  listRoles(cluster?: string, namespace?: string): Promise<Generic[]>
  listRoleBindings(cluster?: string, namespace?: string): Promise<Generic[]>
  listClusterRoles(cluster?: string): Promise<Generic[]>
  listClusterRoleBindings(cluster?: string): Promise<Generic[]>

  listEvents(cluster?: string, namespace?: string): Promise<Event[]>

  /** Generic list for any GVR — used by CRD views. */
  listGeneric(cluster: string | undefined, gvr: GVR, namespace?: string): Promise<Generic[]>
  getGeneric(
    cluster: string | undefined,
    gvr: GVR,
    namespace: string | undefined,
    name: string,
  ): Promise<Generic>
  /** PUT a full object — used by YAML-edit save flow. Requires resourceVersion. */
  replaceGeneric(
    cluster: string | undefined,
    gvr: GVR,
    namespace: string | undefined,
    name: string,
    obj: unknown,
  ): Promise<Generic>
}

export interface PodMetrics {
  metadata: { name: string; namespace?: string; timestamp?: string; window?: string }
  containers: Array<{
    name: string
    usage: { cpu?: string; memory?: string }
  }>
}

function apiPath(gvr: GVR, namespace?: string): string {
  const root = gvr.group === '' ? `/api/${gvr.version}` : `/apis/${gvr.group}/${gvr.version}`
  const ns = gvr.namespaced && namespace ? `/namespaces/${namespace}` : ''
  return `${root}${ns}/${gvr.resource}`
}

function itemsOf<T>(r: unknown): T[] {
  return (r as { items?: T[] }).items ?? []
}

/**
 * Real client — talks to `kubectl proxy` (via Vite dev-server proxy at
 * `/kube-api` in dev, or a same-origin BFF in prod).
 *
 * Every `cluster` arg is ignored — reserved for the future multi-cluster BFF.
 */
function build(http: HttpClient): K8sClient {
  const list = <T>(path: string): Promise<T[]> =>
    http.get<{ items?: T[] }>(path).then(itemsOf)

  return {
    getVersion: () => http.get<VersionInfo>('/version'),
    getApiSurface: async () => {
      const [core, apis] = await Promise.all([
        http.get<{ versions: string[] }>('/api'),
        http.get<{
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
      }
    },

    listClusters: async () => {
      try {
        const [version, nodes] = await Promise.all([
          http.get<VersionInfo>('/version'),
          http.get<{ items: unknown[] }>('/api/v1/nodes'),
        ])
        return [
          {
            name: LOCAL_CLUSTER,
            server: (typeof window !== 'undefined' && window.location.origin) || '',
            version: version.gitVersion,
            platform: version.platform,
            nodeCount: nodes.items.length,
            healthy: true,
            source: 'kubeconfig' as const,
          },
        ]
      } catch {
        return []
      }
    },

    listNamespaces: async () => list<Namespace>('/api/v1/namespaces'),
    listNodes: async () => list<Node>('/api/v1/nodes'),

    listPods: async (_c, ns, selector) => {
      const path = ns
        ? `/api/v1/namespaces/${encodeURIComponent(ns)}/pods`
        : '/api/v1/pods'
      const q = selector ? `?labelSelector=${encodeURIComponent(selector)}` : ''
      return list<Pod>(path + q)
    },
    getPod: (_c, ns, name) =>
      http.get<Pod>(
        `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`,
      ),
    deletePod: async (_c, ns, name) => {
      await http.delete<void>(
        `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`,
      )
    },
    podLogs: async (_c, ns, name, params = {}) => {
      const qs = new URLSearchParams()
      if (params.container) qs.set('container', params.container)
      if (params.tailLines) qs.set('tailLines', String(params.tailLines))
      if (params.sinceSeconds) qs.set('sinceSeconds', String(params.sinceSeconds))
      if (params.timestamps) qs.set('timestamps', 'true')
      if (params.follow) qs.set('follow', 'true')
      const url = `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}/log${
        qs.toString() ? `?${qs}` : ''
      }`
      // Logs endpoint returns text/plain — use response:'text' to force that
      // path instead of relying on content-type sniffing.
      return await http.get<string>(url, { response: 'text' })
    },
    podMetrics: async (_c, ns, name) => {
      try {
        return await http.get<PodMetrics>(
          `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(
            ns,
          )}/pods/${encodeURIComponent(name)}`,
        )
      } catch (err) {
        // metrics-server not installed — return undefined so UI can fall back.
        if ((err as { status?: number })?.status === 404) return undefined
        throw err
      }
    },

    listDeployments: async (_c, ns) =>
      list<Deployment>(
        ns
          ? `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments`
          : '/apis/apps/v1/deployments',
      ),
    listStatefulSets: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/statefulsets`
          : '/apis/apps/v1/statefulsets',
      ),
    listDaemonSets: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/daemonsets`
          : '/apis/apps/v1/daemonsets',
      ),
    listJobs: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs`
          : '/apis/batch/v1/jobs',
      ),
    listCronJobs: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/cronjobs`
          : '/apis/batch/v1/cronjobs',
      ),
    scaleDeployment: async (_c, ns, name, replicas) => {
      await http.patch<void>(
        `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}/deployments/${encodeURIComponent(name)}/scale`,
        { spec: { replicas } },
      )
    },

    listServices: async (_c, ns) =>
      list<Service>(
        ns
          ? `/api/v1/namespaces/${encodeURIComponent(ns)}/services`
          : '/api/v1/services',
      ),
    listIngresses: async (_c, ns) =>
      list<Ingress>(
        ns
          ? `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/ingresses`
          : '/apis/networking.k8s.io/v1/ingresses',
      ),

    listConfigMaps: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/api/v1/namespaces/${encodeURIComponent(ns)}/configmaps`
          : '/api/v1/configmaps',
      ),
    listSecrets: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/api/v1/namespaces/${encodeURIComponent(ns)}/secrets`
          : '/api/v1/secrets',
      ),

    listPersistentVolumes: async () => list<Generic>('/api/v1/persistentvolumes'),
    listPersistentVolumeClaims: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/api/v1/namespaces/${encodeURIComponent(ns)}/persistentvolumeclaims`
          : '/api/v1/persistentvolumeclaims',
      ),
    listStorageClasses: async () => list<Generic>('/apis/storage.k8s.io/v1/storageclasses'),

    listServiceAccounts: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/api/v1/namespaces/${encodeURIComponent(ns)}/serviceaccounts`
          : '/api/v1/serviceaccounts',
      ),
    listRoles: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/roles`
          : '/apis/rbac.authorization.k8s.io/v1/roles',
      ),
    listRoleBindings: async (_c, ns) =>
      list<Generic>(
        ns
          ? `/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/rolebindings`
          : '/apis/rbac.authorization.k8s.io/v1/rolebindings',
      ),
    listClusterRoles: async () =>
      list<Generic>('/apis/rbac.authorization.k8s.io/v1/clusterroles'),
    listClusterRoleBindings: async () =>
      list<Generic>('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),

    listEvents: async (_c, ns) =>
      list<Event>(
        ns
          ? `/api/v1/namespaces/${encodeURIComponent(ns)}/events`
          : '/api/v1/events',
      ),

    listGeneric: async (_c, gvr, ns) => list<Generic>(apiPath(gvr, ns)),
    getGeneric: (_c, gvr, ns, name) =>
      http.get<Generic>(`${apiPath(gvr, ns)}/${encodeURIComponent(name)}`),
    replaceGeneric: (_c, gvr, ns, name, obj) =>
      http.put<Generic>(`${apiPath(gvr, ns)}/${encodeURIComponent(name)}`, obj),
  }
}

/**
 * Build a believable rolling log stream for the stub backend. Lines are
 * generated deterministically from the pod identity so each demo refresh
 * still feels alive but doesn't churn out wildly different text.
 */
function buildStubLogs(ns: string, name: string, params: LogsParams): string {
  const tail = params.tailLines ?? 200
  const sinceMs = params.sinceSeconds ? params.sinceSeconds * 1000 : 24 * 60 * 60 * 1000
  const now = Date.now()
  const start = now - sinceMs
  // Simple LCG for deterministic-ish jitter from the pod name.
  let seed = 0
  for (const ch of name + ns) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const samples = [
    `INFO  http listening on :8080`,
    `INFO  ready (took ${Math.floor(next() * 800 + 80)}ms)`,
    `INFO  GET /healthz 200 ${Math.floor(next() * 6 + 2)}ms`,
    `INFO  GET /api/v1/items?limit=20 200 ${Math.floor(next() * 35 + 8)}ms`,
    `INFO  POST /api/v1/items 201 ${Math.floor(next() * 90 + 12)}ms user=u_${Math.floor(next() * 9000 + 1000)}`,
    `DEBUG cache hit ratio=0.${Math.floor(next() * 90 + 8)}`,
    `INFO  reconciled ${Math.floor(next() * 12 + 1)} items in ${Math.floor(next() * 200 + 30)}ms`,
    `WARN  slow query db.users.findOne took ${Math.floor(next() * 900 + 200)}ms`,
    `INFO  GET /api/v1/orders?status=open 200 ${Math.floor(next() * 60 + 10)}ms`,
    `INFO  metrics scrape served 142 series`,
    `WARN  retrying upstream call attempt=2`,
    `ERROR upstream timeout after 3s endpoint=billing.svc.cluster.local`,
    `INFO  upstream recovered`,
    `INFO  flushed write-ahead log offset=${Math.floor(next() * 100000)}`,
    `DEBUG goroutines=${Math.floor(next() * 80 + 20)} heap_inuse=${Math.floor(next() * 40 + 18)}MiB`,
  ]
  const out: string[] = []
  for (let i = 0; i < tail; i++) {
    const ts = new Date(start + (i / Math.max(1, tail - 1)) * sinceMs).toISOString()
    const sample = samples[Math.floor(next() * samples.length)]
    out.push(params.timestamps ? `${ts} ${sample}` : sample)
  }
  return out.join('\n') + '\n'
}

function stub(): K8sClient {
  const stubVersion: VersionInfo = {
    major: '1',
    minor: '31',
    gitVersion: 'v1.31.2',
    platform: 'linux/amd64',
  }
  return {
    getVersion: async () => stubVersion,
    getApiSurface: async () => ({
      coreVersions: ['v1'],
      apiGroups: [{ name: 'apps', versions: ['v1'], preferredVersion: 'v1' }],
    }),
    listClusters: async () => STUB_CLUSTERS,
    listNamespaces: async () => STUB_NAMESPACES,
    listNodes: async () => STUB_NODES,
    listPods: async (_c, ns) =>
      ns ? STUB_PODS.filter((p) => p.metadata.namespace === ns) : STUB_PODS,
    getPod: async (_c, ns, name) => {
      const p = STUB_PODS.find((x) => x.metadata.namespace === ns && x.metadata.name === name)
      if (!p) throw new Error(`Stub: pod ${ns}/${name} not found`)
      return p
    },
    deletePod: async () => {},
    podLogs: async (_c, ns, name, params = {}) => buildStubLogs(ns, name, params),
    podMetrics: async () => undefined,
    listDeployments: async (_c, ns) =>
      ns ? STUB_DEPLOYMENTS.filter((d) => d.metadata.namespace === ns) : STUB_DEPLOYMENTS,
    listStatefulSets: async () => [],
    listDaemonSets: async () => [],
    listJobs: async () => [],
    listCronJobs: async () => [],
    scaleDeployment: async () => {},
    listServices: async (_c, ns) =>
      ns ? STUB_SERVICES.filter((s) => s.metadata.namespace === ns) : STUB_SERVICES,
    listIngresses: async (_c, ns) =>
      ns ? STUB_INGRESSES.filter((i) => i.metadata.namespace === ns) : STUB_INGRESSES,
    listConfigMaps: async () => [],
    listSecrets: async () => [],
    listPersistentVolumes: async () => [],
    listPersistentVolumeClaims: async () => [],
    listStorageClasses: async () => [],
    listServiceAccounts: async () => [],
    listRoles: async () => [],
    listRoleBindings: async () => [],
    listClusterRoles: async () => [],
    listClusterRoleBindings: async () => [],
    listEvents: async (_c, ns) =>
      ns ? STUB_EVENTS.filter((e) => e.metadata.namespace === ns) : STUB_EVENTS,
    listGeneric: async (_c, gvr) =>
      STUB_CRD_OBJECTS[`${gvr.group}/${gvr.version}/${gvr.resource}`] ?? [],
    getGeneric: async (_c, gvr, _ns, name) => {
      const items = STUB_CRD_OBJECTS[`${gvr.group}/${gvr.version}/${gvr.resource}`] ?? []
      const found = items.find((i) => i.metadata.name === name)
      if (!found) throw new Error(`Stub: ${gvr.resource}/${name} not found`)
      return found
    },
    replaceGeneric: async (_c, _gvr, _ns, _name, obj) => obj as Generic,
  }
}

export const K8sClient = {
  /**
   * Build a client against `kubectl proxy` (default `/kube-api` in dev, which
   * Vite forwards to `http://127.0.0.1:8001`). In production point at a
   * same-origin BFF path that forwards after auth.
   */
  create(opts: Partial<HttpClientOptions> = {}): K8sClient {
    return build(
      new HttpClient({
        baseUrl: opts.baseUrl ?? '/kube-api',
        token: opts.token,
        headers: opts.headers,
        fetchImpl: opts.fetchImpl,
        credentials: opts.credentials,
      }),
    )
  },
  /**
   * Environment-aware client.
   *   - Production build → the kube-apiserver through the console's **Kubernetes
   *     gateway** at `/api/k8s` (cookie-authenticated; forwards the signed-in
   *     user's token for per-user RBAC).
   *   - Dev (or `mode: 'stub'`) → in-memory **stub fixtures**, so the UI runs
   *     with no cluster and no `kubectl proxy` (that flood of ECONNREFUSED
   *     proxy errors is gone). Force live dev with `mode: 'real'`.
   */
  auto(opts: { mode?: 'real' | 'stub' } & Partial<HttpClientOptions> = {}): K8sClient {
    const real = opts.mode ? opts.mode === 'real' : isProdBuild()
    if (!real) return stub()
    return build(
      new HttpClient({
        baseUrl: opts.baseUrl ?? '/api/k8s',
        token: opts.token,
        headers: opts.headers,
        fetchImpl: opts.fetchImpl,
        credentials: opts.credentials ?? 'include',
      }),
    )
  },
  stub,
  /** Re-export so callers can `catch (e) { if (e instanceof K8sClient.HttpError) … }`. */
  HttpError,
}
