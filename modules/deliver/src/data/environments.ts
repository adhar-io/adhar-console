import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { k8s } from '@adhar-console/api-clients'
import type { argocd } from '@adhar-console/api-clients'
import { usePollingInterval } from '@adhar-console/shell-ui'

/**
 * Data layer for **Environments**.
 *
 * An environment is a real deployment target: a `(cluster, namespace)` pair that
 * Argo CD actually deploys into. That definition matters, because the previous
 * version of this page grouped only by namespace and inferred a *health tone*
 * from the namespace's name — so two different clusters both deploying into
 * `adhar-system` collapsed into indistinguishable cards, and anything whose
 * name didn't look like dev/staging was labelled "prod". None of that was real.
 *
 * Two sources, and the page is explicit about which is which:
 *
 *  **Argo CD** (`/api/svc/argocd/api/v1/clusters`) is the registry of clusters.
 *  It works for *every* registered cluster — in-cluster, another cloud, or an
 *  on-prem box — because Argo CD holds the credentials and reports what it can
 *  see: connection state, Kubernetes version, cached resource/API counts, and
 *  how many Applications target it. This is the only source available for a
 *  remote cluster the console has no kubeconfig for.
 *
 *  **The Kubernetes gateway** (`/api/k8s`) adds live infrastructure — nodes,
 *  capacity, provider, region, namespaces, workloads. It can only reach the
 *  clusters in `K8S_CLUSTERS` (by default just the console's own), so this
 *  detail is attached where it exists and simply absent elsewhere. Nothing is
 *  extrapolated from one cluster onto another.
 */

export const client = k8s.K8sClient.auto()

const REFRESH_MS = 20_000
const SLOW_MS = 60_000

/* ─────────── Argo CD cluster registry ─────────── */

/** The fields we read from Argo CD's cluster list. */
export interface ArgoCluster {
  name: string
  server: string
  project?: string
  connectionState: {
    status: 'Successful' | 'Failed' | 'Unknown' | string
    message?: string
    attemptedAt?: string
  }
  serverVersion?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  info?: {
    connectionState?: { status?: string; message?: string; attemptedAt?: string }
    serverVersion?: string
    cacheInfo?: { resourcesCount?: number; apisCount?: number; lastCacheSyncTime?: string }
    applicationsCount?: number
    apiVersions?: string[]
  }
}

/**
 * Clusters registered in Argo CD.
 *
 * `in-cluster` is always present even when it has never been explicitly added,
 * and its server is the in-cluster DNS name rather than a routable address —
 * the view resolves that to the console's own cluster rather than showing
 * `kubernetes.default.svc` as if it were an endpoint someone could reach.
 */
export function useArgoClusters() {
  return useQuery({
    queryKey: ['deliver', 'argocd', 'clusters'],
    queryFn: async (): Promise<ArgoCluster[]> => {
      const res = await fetch('/api/svc/argocd/api/v1/clusters', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(
          `ArgoCD ${res.status} ${res.statusText} at /api/v1/clusters${body ? ` — ${body.slice(0, 200)}` : ''}`,
        )
      }
      const json = (await res.json()) as { items?: ArgoCluster[] }
      return json.items ?? []
    },
    refetchInterval: usePollingInterval(SLOW_MS),
    retry: false,
  })
}

/** Argo CD's own name for the console's cluster. */
export const IN_CLUSTER_SERVER = 'https://kubernetes.default.svc'

/* ─────────── where a cluster runs ─────────── */

export type ProviderId =
  | 'digitalocean'
  | 'aws'
  | 'gcp'
  | 'azure'
  | 'linode'
  | 'oracle'
  | 'ibm'
  | 'openstack'
  | 'vsphere'
  | 'kind'
  | 'k3s'
  | 'self-managed'

export interface Provider {
  id: ProviderId
  label: string
  /** Where the evidence came from, so the UI never implies more than it knows. */
  source: 'node providerID' | 'endpoint' | 'label' | 'unknown'
}

const SELF_MANAGED: Provider = { id: 'self-managed', label: 'Self-managed', source: 'unknown' }

const PROVIDER_LABEL: Record<ProviderId, string> = {
  digitalocean: 'DigitalOcean',
  aws: 'AWS',
  gcp: 'Google Cloud',
  azure: 'Azure',
  linode: 'Akamai / Linode',
  oracle: 'Oracle Cloud',
  ibm: 'IBM Cloud',
  openstack: 'OpenStack',
  vsphere: 'VMware vSphere',
  kind: 'kind (local)',
  k3s: 'k3s',
  'self-managed': 'Self-managed',
}

/**
 * A node's `spec.providerID` is the authoritative answer — the cloud-controller
 * manager writes it, so it is not a guess. Everything else is a fallback.
 */
export function providerFromProviderID(providerID?: string): Provider | null {
  if (!providerID) return null
  const scheme = providerID.split('://')[0]?.toLowerCase()
  const map: Record<string, ProviderId> = {
    digitalocean: 'digitalocean',
    aws: 'aws',
    gce: 'gcp',
    azure: 'azure',
    linode: 'linode',
    oci: 'oracle',
    ibm: 'ibm',
    openstack: 'openstack',
    vsphere: 'vsphere',
    kind: 'kind',
    k3s: 'k3s',
  }
  const id = map[scheme ?? '']
  return id ? { id, label: PROVIDER_LABEL[id], source: 'node providerID' } : null
}

/**
 * Managed control planes have recognisable API hostnames. A bare IP tells us
 * nothing, so it stays "Self-managed" rather than being attributed to whichever
 * cloud happens to own that address range.
 */
export function providerFromEndpoint(server?: string): Provider {
  const host = hostOf(server)
  if (!host) return SELF_MANAGED
  const patterns: Array<[RegExp, ProviderId]> = [
    [/\.k8s\.ondigitalocean\.com$/i, 'digitalocean'],
    [/\.eks\.amazonaws\.com$/i, 'aws'],
    [/\.gke\.goog$|\.container\.googleapis\.com$/i, 'gcp'],
    [/\.azmk8s\.io$|\.azure\.com$/i, 'azure'],
    [/\.linodelke\.net$/i, 'linode'],
    [/\.oraclecloud\.com$/i, 'oracle'],
    [/\.containers\.cloud\.ibm\.com$/i, 'ibm'],
  ]
  for (const [re, id] of patterns) {
    if (re.test(host)) return { id, label: PROVIDER_LABEL[id], source: 'endpoint' }
  }
  return SELF_MANAGED
}

/** Hostname of an API server URL, or '' when it isn't parseable. */
export function hostOf(server?: string): string {
  if (!server) return ''
  try {
    return new URL(server).hostname
  } catch {
    return server.replace(/^https?:\/\//, '').split(/[:/]/)[0] ?? ''
  }
}

/** Endpoint as shown to a human: host[:port], without the scheme. */
export function endpointOf(server?: string): string {
  if (!server) return ''
  return server.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/* ─────────── live infrastructure (clusters the gateway can reach) ─────────── */

/**
 * Nodes of the console's own cluster. This is what turns "a cluster is
 * registered" into "here is the hardware it runs on" — provider, region,
 * instance type, capacity and readiness.
 */
export function useLocalNodes() {
  return useQuery({
    queryKey: ['deliver', 'env', 'nodes'],
    queryFn: () => client.listNodes(),
    refetchInterval: usePollingInterval(SLOW_MS),
    retry: false,
  })
}

export function useLocalNamespaces() {
  return useQuery({
    queryKey: ['deliver', 'env', 'namespaces'],
    queryFn: () => client.listNamespaces(),
    refetchInterval: usePollingInterval(SLOW_MS),
    retry: false,
  })
}

/** Deployments in one namespace — the workload roll-up in the drawer. */
export function useNamespaceDeployments(namespace?: string, enabled = true) {
  return useQuery({
    queryKey: ['deliver', 'env', 'deployments', namespace ?? '*'],
    queryFn: () => client.listDeployments(undefined, namespace),
    enabled: enabled && !!namespace,
    refetchInterval: usePollingInterval(REFRESH_MS),
    retry: false,
  })
}

/** Pods in one namespace — phase counts and restart totals. */
export function useNamespacePods(namespace?: string, enabled = true) {
  return useQuery({
    queryKey: ['deliver', 'env', 'pods', namespace ?? '*'],
    queryFn: () => client.listPods(undefined, namespace),
    enabled: enabled && !!namespace,
    refetchInterval: usePollingInterval(REFRESH_MS),
    retry: false,
  })
}

/* ─────────── capacity maths ─────────── */

/** Kubernetes quantity → number of CPUs (handles the `m` milli-suffix). */
export function parseCpu(q?: string): number {
  if (!q) return 0
  if (q.endsWith('m')) return Number(q.slice(0, -1)) / 1000
  const n = Number(q)
  return Number.isFinite(n) ? n : 0
}

const MEM_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
}

/** Kubernetes quantity → bytes. */
export function parseMemory(q?: string): number {
  if (!q) return 0
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(q.trim())
  if (!m) return 0
  const value = Number(m[1])
  const unit = m[2]
  if (!unit) return value
  return value * (MEM_UNITS[unit] ?? 1)
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Roll-up of a cluster's node fleet. */
export interface FleetSummary {
  nodes: number
  ready: number
  cpu: number
  memory: number
  pods: number
  provider: Provider
  region: string
  instanceTypes: string[]
  kubeletVersions: string[]
  os: string[]
}

export function summarizeFleet(nodes: k8s.Node[] | undefined, server?: string): FleetSummary | null {
  if (!nodes?.length) return null
  let cpu = 0
  let memory = 0
  let pods = 0
  let ready = 0
  const regions = new Set<string>()
  const instanceTypes = new Set<string>()
  const kubelets = new Set<string>()
  const os = new Set<string>()
  let provider: Provider | null = null

  for (const n of nodes) {
    cpu += parseCpu(n.status.capacity?.cpu)
    memory += parseMemory(n.status.capacity?.memory)
    pods += Number(n.status.capacity?.pods ?? 0) || 0
    if (n.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')) ready++
    provider ??= providerFromProviderID(n.spec.providerID)
    const labels = n.metadata.labels ?? {}
    const region = labels['topology.kubernetes.io/region'] ?? labels['failure-domain.beta.kubernetes.io/region']
    if (region) regions.add(region)
    const instance = labels['node.kubernetes.io/instance-type'] ?? labels['beta.kubernetes.io/instance-type']
    if (instance) instanceTypes.add(instance)
    if (n.status.nodeInfo?.kubeletVersion) kubelets.add(n.status.nodeInfo.kubeletVersion)
    if (n.status.nodeInfo?.osImage) os.add(n.status.nodeInfo.osImage)
  }

  return {
    nodes: nodes.length,
    ready,
    cpu,
    memory,
    pods,
    provider: provider ?? providerFromEndpoint(server),
    region: [...regions].sort().join(', '),
    instanceTypes: [...instanceTypes].sort(),
    kubeletVersions: [...kubelets].sort(),
    os: [...os].sort(),
  }
}

/* ─────────── joining Applications into environments ─────────── */

export type EnvHealth = 'healthy' | 'degraded' | 'progressing' | 'drift' | 'unknown'

export interface EnvironmentRow {
  /** Stable identity: cluster server + namespace. */
  key: string
  clusterKey: string
  namespace: string
  apps: argocd.Application[]
  synced: number
  outOfSync: number
  healthy: number
  degraded: number
  progressing: number
  missing: number
  suspended: number
  health: EnvHealth
  /** Newest sync across the environment's apps, for "last deployed". */
  lastSyncAt?: string
}

export interface ClusterRow {
  key: string
  /** Argo CD's name for it, or the endpoint when it has none. */
  name: string
  server: string
  /** True for the console's own cluster. */
  local: boolean
  connected: boolean
  connectionStatus: string
  connectionMessage?: string
  attemptedAt?: string
  version?: string
  resourcesCount?: number
  apisCount?: number
  lastCacheSync?: string
  appsCount: number
  provider: Provider
  fleet: FleetSummary | null
  environments: EnvironmentRow[]
  /** Registered in Argo CD but targeted by no Application. */
  idle: boolean
}

/** Destination server for an Application, resolving Argo CD's `name` form. */
function destServer(app: argocd.Application, byName: Map<string, string>): string {
  const dest = app.spec.destination as { server?: string; name?: string; namespace: string }
  if (dest.server) return dest.server
  if (dest.name) return byName.get(dest.name) ?? dest.name
  return ''
}

function rollUp(apps: argocd.Application[]): Omit<EnvironmentRow, 'key' | 'clusterKey' | 'namespace' | 'apps'> {
  let synced = 0
  let outOfSync = 0
  let healthy = 0
  let degraded = 0
  let progressing = 0
  let missing = 0
  let suspended = 0
  let lastSyncAt: string | undefined

  for (const a of apps) {
    const sync = a.status?.sync?.status
    const health = a.status?.health?.status
    if (sync === 'Synced') synced++
    else if (sync === 'OutOfSync') outOfSync++
    if (health === 'Healthy') healthy++
    else if (health === 'Degraded') degraded++
    else if (health === 'Progressing') progressing++
    else if (health === 'Missing') missing++
    else if (health === 'Suspended') suspended++

    const at = (a.status as { operationState?: { finishedAt?: string } } | undefined)?.operationState
      ?.finishedAt
    if (at && (!lastSyncAt || at > lastSyncAt)) lastSyncAt = at
  }

  // Health precedence is worst-first, and drift is reported separately from
  // runtime health: an environment can be perfectly healthy *and* have drifted
  // from git, and collapsing those two into one pill hides a real problem.
  const health: EnvHealth = degraded > 0 || missing > 0
    ? 'degraded'
    : progressing > 0
      ? 'progressing'
      : outOfSync > 0
        ? 'drift'
        : healthy > 0
          ? 'healthy'
          : 'unknown'

  return { synced, outOfSync, healthy, degraded, progressing, missing, suspended, health, lastSyncAt }
}

/**
 * Join the Argo CD cluster registry with the Applications that target it.
 *
 * Clusters come first and always appear, even with no Applications — a
 * registered cluster nobody deploys to is a real (and interesting) state, not
 * something to hide. Applications pointing at a server Argo CD doesn't list are
 * still shown, under that endpoint, rather than dropped.
 */
export function useEnvironmentModel(
  clusters: ArgoCluster[] | undefined,
  apps: argocd.Application[] | undefined,
  localNodes: k8s.Node[] | undefined,
): ClusterRow[] {
  return useMemo(() => {
    const list = clusters ?? []
    const byName = new Map(list.map((c) => [c.name, c.server]))

    const rows = new Map<string, ClusterRow>()
    const ensure = (server: string, seed?: ArgoCluster): ClusterRow => {
      const key = server
      const existing = rows.get(key)
      if (existing) return existing
      const local = server === IN_CLUSTER_SERVER
      const info = seed?.info
      const state = seed?.connectionState ?? info?.connectionState
      const row: ClusterRow = {
        key,
        name: seed?.name || endpointOf(server) || 'unknown',
        server,
        local,
        connected: (state?.status ?? '') === 'Successful',
        connectionStatus: state?.status ?? 'Unknown',
        connectionMessage: state?.message || undefined,
        attemptedAt: state?.attemptedAt,
        version: seed?.serverVersion ?? info?.serverVersion,
        resourcesCount: info?.cacheInfo?.resourcesCount,
        apisCount: info?.cacheInfo?.apisCount,
        lastCacheSync: info?.cacheInfo?.lastCacheSyncTime,
        appsCount: info?.applicationsCount ?? 0,
        // The local cluster's provider comes from its nodes (authoritative);
        // a remote one can only be read off its endpoint.
        provider: local
          ? (summarizeFleet(localNodes, server)?.provider ?? providerFromEndpoint(server))
          : providerFromEndpoint(server),
        fleet: local ? summarizeFleet(localNodes, server) : null,
        environments: [],
        idle: true,
      }
      rows.set(key, row)
      return row
    }

    for (const c of list) ensure(c.server, c)

    // Bucket applications by (cluster, namespace).
    const buckets = new Map<string, { clusterKey: string; namespace: string; apps: argocd.Application[] }>()
    for (const a of apps ?? []) {
      const server = destServer(a, byName)
      if (!server) continue
      const namespace = a.spec.destination.namespace ?? ''
      const key = `${server}::${namespace}`
      let b = buckets.get(key)
      if (!b) {
        b = { clusterKey: server, namespace, apps: [] }
        buckets.set(key, b)
      }
      b.apps.push(a)
    }

    for (const [key, b] of buckets) {
      const cluster = ensure(b.clusterKey)
      cluster.idle = false
      cluster.environments.push({
        key,
        clusterKey: b.clusterKey,
        namespace: b.namespace,
        apps: b.apps.slice().sort((x, y) => x.metadata.name.localeCompare(y.metadata.name)),
        ...rollUp(b.apps),
      })
    }

    for (const row of rows.values()) {
      row.environments.sort((a, b) => a.namespace.localeCompare(b.namespace))
      // Argo CD's own applicationsCount can lag its cache; the join is live, so
      // prefer the counted total whenever we have applications in hand.
      const counted = row.environments.reduce((n, e) => n + e.apps.length, 0)
      if (counted) row.appsCount = counted
    }

    // Local cluster first, then connected before unreachable, then by name.
    return [...rows.values()].sort((a, b) => {
      if (a.local !== b.local) return a.local ? -1 : 1
      if (a.connected !== b.connected) return a.connected ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [clusters, apps, localNodes])
}

/* ─────────── Kargo stage matching ─────────── */

/**
 * Match a Kargo stage to an environment.
 *
 * Kargo stages are named for a promotion step (`dev`, `uat`, `prod`), which may
 * or may not equal a namespace. We only claim a match on an exact name, or when
 * the namespace ends in `-<stage>` — a substring match would happily pair
 * `prod` with `reproducible-builds`.
 */
export function matchStage<T extends { name: string }>(
  namespace: string,
  stages: T[] | undefined,
): T | undefined {
  if (!stages?.length) return undefined
  const ns = namespace.toLowerCase()
  return stages.find((s) => {
    const n = s.name.toLowerCase()
    return ns === n || ns.endsWith(`-${n}`) || ns.startsWith(`${n}-`)
  })
}
