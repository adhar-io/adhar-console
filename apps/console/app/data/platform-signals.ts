import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { k8s } from '@adhar/api-clients'
import { useAppConfig, useWatchSignal } from '@adhar/shell-ui'
import { combineIntervals, useK8sList } from './live-k8s.ts'
import { useArgoApplications } from './argo-apps.ts'

/**
 * Platform-signal hooks for the Overview page — REAL data, no stubs / no
 * fabricated numbers.
 *
 * Kubernetes-backed panels read the cluster's apiserver through the console's
 * authenticated gateway (`k8s.K8sClient.auto()` → `/api/k8s`), the same client
 * `cluster-signals.ts` uses. CRD-backed panels use `listGeneric(gvr)`; when a
 * CRD isn't installed the apiserver 404s and the query surfaces an error so the
 * panel can render a graceful "requires <operator>" empty state rather than
 * invent data.
 *
 * Tool-backed panels (DORA, budget, tool health) go through the BFF proxies
 * (`/api/svc/<tool>/…`, `/api/config`) exactly like `cross-module-signals.ts`.
 */

const client = k8s.K8sClient.auto()

/** Timer for sources with nothing to watch (metrics APIs, tool REST). */
const POLL_MS = 60_000
const REFRESH_MS = POLL_MS

/* ─────────── GVR definitions for CRD-backed sources ─────────── */

const GVR = {
  nodeMetrics: { group: 'metrics.k8s.io', version: 'v1beta1', resource: 'nodes', namespaced: false },
  cnpgClusters: { group: 'postgresql.cnpg.io', version: 'v1', resource: 'clusters', namespaced: true },
  cnpgScheduledBackups: { group: 'postgresql.cnpg.io', version: 'v1', resource: 'scheduledbackups', namespaced: true },
  cnpgBackups: { group: 'postgresql.cnpg.io', version: 'v1', resource: 'backups', namespaced: true },
  veleroBackups: { group: 'velero.io', version: 'v1', resource: 'backups', namespaced: true },
  // Strimzi 1.0 serves only `v1`; older operators only `v1beta2`. The hooks
  // try v1 first and fall back (see useGenericAnyVersion).
  kafkas: { group: 'kafka.strimzi.io', version: 'v1', resource: 'kafkas', namespaced: true },
  kafkaTopics: { group: 'kafka.strimzi.io', version: 'v1', resource: 'kafkatopics', namespaced: true },
  workflows: { group: 'argoproj.io', version: 'v1alpha1', resource: 'workflows', namespaced: true },
  ciliumPolicies: { group: 'cilium.io', version: 'v2', resource: 'ciliumnetworkpolicies', namespaced: true },
  ciliumClusterPolicies: { group: 'cilium.io', version: 'v2', resource: 'ciliumclusterwidenetworkpolicies', namespaced: false },
  // The platform mesh is Cilium: encryption state lives on CiliumNodes.
  ciliumNodes: { group: 'cilium.io', version: 'v2', resource: 'ciliumnodes', namespaced: false },
  kafkaNodePools: { group: 'kafka.strimzi.io', version: 'v1', resource: 'kafkanodepools', namespaced: true },
  // CI is Tekton (pipelines + triggers); ingress is Gateway API on Cilium.
  pipelineRuns: { group: 'tekton.dev', version: 'v1', resource: 'pipelineruns', namespaced: true },
  eventListeners: { group: 'triggers.tekton.dev', version: 'v1beta1', resource: 'eventlisteners', namespaced: true },
  httpRoutes: { group: 'gateway.networking.k8s.io', version: 'v1', resource: 'httproutes', namespaced: true },
  gateways: { group: 'gateway.networking.k8s.io', version: 'v1', resource: 'gateways', namespaced: true },
  resourceQuotas: { group: '', version: 'v1', resource: 'resourcequotas', namespaced: true },
  endpoints: { group: '', version: 'v1', resource: 'endpoints', namespaced: true },
  certificates: { group: 'cert-manager.io', version: 'v1', resource: 'certificates', namespaced: true },
  // Core resources the typed client methods below read. Declared here too so
  // each one can name the apiserver resource it should be watching.
  nodes: { group: '', version: 'v1', resource: 'nodes', namespaced: false },
  pods: { group: '', version: 'v1', resource: 'pods', namespaced: true },
  pvcs: { group: '', version: 'v1', resource: 'persistentvolumeclaims', namespaced: true },
  pvs: { group: '', version: 'v1', resource: 'persistentvolumes', namespaced: false },
  events: { group: '', version: 'v1', resource: 'events', namespaced: true },
  services: { group: '', version: 'v1', resource: 'services', namespaced: true },
  ingresses: { group: 'networking.k8s.io', version: 'v1', resource: 'ingresses', namespaced: true },
  namespaces: { group: '', version: 'v1', resource: 'namespaces', namespaced: false },
  argoApps: { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications', namespaced: true },
} as const

type Gvr = (typeof GVR)[keyof typeof GVR]

/**
 * Every hook in this file is push-driven: the apiserver watch for its resource
 * invalidates the query the moment something changes, and the interval is only
 * a fallback for when the live socket is down. `metrics.k8s.io` is the one
 * exception — it is a metrics API, not a watchable resource, so it keeps its
 * timer.
 */
/**
 * `useGeneric` for a CRD whose served version moved between operator releases:
 * list at each version in turn and keep the first the API server answers.
 * Only if every version fails is the panel's error the first one's.
 */
function useGenericAnyVersion(key: string, gvr: Gvr, versions: string[]) {
  const queryKey = ['ov', 'k8s', key]
  // Watch both candidate versions: the one not served is refused once, the
  // served one drives the refetch (change-filtered, throttled).
  const [v1, v2] = versions
  const refetchInterval = combineIntervals(
    useWatchSignal({ group: gvr.group, version: v1, resource: gvr.resource }, [queryKey]),
    useWatchSignal(v2 ? { group: gvr.group, version: v2, resource: gvr.resource } : null, [queryKey], { enabled: Boolean(v2) }),
  )
  return useQuery({
    queryKey,
    queryFn: async () => {
      let first: unknown
      for (const version of versions) {
        try {
          return await client.listGeneric(undefined, { ...gvr, version })
        } catch (e) {
          first ??= e
        }
      }
      throw first
    },
    refetchInterval,
    retry: false,
  })
}

function useGeneric(key: string, gvr: Gvr, refetch = REFRESH_MS, watchable = true) {
  const queryKey = ['ov', 'k8s', key]
  // A watchable resource is a canonical live list (see live-k8s.ts); only the
  // metrics API, which cannot be watched, is a keyed query on a timer.
  const live = useK8sList(gvr, { enabled: watchable })
  const polled = useQuery({
    queryKey,
    queryFn: () => client.listGeneric(undefined, gvr),
    refetchInterval: refetch,
    retry: false,
    enabled: !watchable,
  })
  return watchable ? live : polled
}

/* ─────────── core k8s resources ─────────── */

type ItemOf<F extends (...a: never[]) => Promise<unknown[]>> = Awaited<ReturnType<F>>[number]

export function useNodes() {
  return useK8sList<ItemOf<typeof client.listNodes>>(GVR.nodes)
}

export function useAllPods() {
  return useK8sList<ItemOf<typeof client.listPods>>(GVR.pods)
}

/** `metrics.k8s.io` serves point-in-time samples and cannot be watched. */
export function useNodeMetrics() {
  return useGeneric('node-metrics', GVR.nodeMetrics, POLL_MS, false)
}

export function usePvcs() {
  return useK8sList<ItemOf<typeof client.listPersistentVolumeClaims>>(GVR.pvcs)
}

export function usePvs() {
  return useK8sList<ItemOf<typeof client.listPersistentVolumes>>(GVR.pvs)
}

export function useClusterEvents() {
  return useK8sList<ItemOf<typeof client.listEvents>>(GVR.events)
}

export function useServices() {
  return useK8sList<ItemOf<typeof client.listServices>>(GVR.services)
}

export function useEndpoints() {
  return useGeneric('endpoints', GVR.endpoints)
}

export function useIngresses() {
  return useK8sList<ItemOf<typeof client.listIngresses>>(GVR.ingresses)
}

export function useResourceQuotas() {
  return useGeneric('resourcequotas', GVR.resourceQuotas)
}

/** Cluster namespaces — used to map tenants (adhar.io/org label) to namespaces. */
export function useNamespaces() {
  return useK8sList<ItemOf<typeof client.listNamespaces>>(GVR.namespaces)
}

/* ─────────── CRD-backed sources ─────────── */

export function useCnpgClusters() {
  return useGeneric('cnpg-clusters', GVR.cnpgClusters)
}

export function useVeleroBackups() {
  return useGeneric('velero-backups', GVR.veleroBackups)
}

export function useCnpgScheduledBackups() {
  return useGeneric('cnpg-scheduledbackups', GVR.cnpgScheduledBackups)
}

export function useCnpgBackups() {
  return useGeneric('cnpg-backups', GVR.cnpgBackups)
}

export function useKafkas() {
  return useGenericAnyVersion('kafkas', GVR.kafkas, ['v1', 'v1beta2'])
}

export function useKafkaTopics() {
  return useGenericAnyVersion('kafka-topics', GVR.kafkaTopics, ['v1', 'v1beta2'])
}

export function useWorkflows() {
  return useGeneric('workflows', GVR.workflows)
}

export function useCiliumPolicies() {
  return useGeneric('cilium-policies', GVR.ciliumPolicies)
}

export function useCiliumClusterPolicies() {
  return useGeneric('cilium-cluster-policies', GVR.ciliumClusterPolicies)
}

export function useCiliumNodes() {
  return useGeneric('cilium-nodes', GVR.ciliumNodes)
}

export function useKafkaNodePools() {
  return useGenericAnyVersion('kafka-node-pools', GVR.kafkaNodePools, ['v1', 'v1beta2'])
}

export function usePipelineRuns() {
  return useGeneric('tekton-pipelineruns', GVR.pipelineRuns)
}

export function useEventListeners() {
  return useGeneric('tekton-eventlisteners', GVR.eventListeners)
}

export function useHttpRoutes() {
  return useGeneric('gateway-httproutes', GVR.httpRoutes)
}

export function useGateways() {
  return useGeneric('gateway-gateways', GVR.gateways)
}

export function useCertificates() {
  return useGeneric('certificates', GVR.certificates)
}

/* ─────────── tool-backed sources (BFF proxies) ─────────── */

export interface ToolConfig {
  configured: boolean
  url: string
}

export interface AppConfig {
  tools: Record<string, ToolConfig>
  version?: string
}

/**
 * `/api/config`, through the shell's shared query — one request for the whole
 * console (the shell reads the same document for tool URLs and org names).
 */
export function useToolsConfig(): UseQueryResult<AppConfig> {
  return useAppConfig() as unknown as UseQueryResult<AppConfig>
}

/**
 * Argo CD applications as the DORA panels read them.
 *
 * This must match what `listApplications()` actually RETURNS — a normalized
 * `Application`, not the raw CRD. It previously did not: it declared
 * `status.resources` as an array of resources when the normalizer makes it a
 * `{ total, outOfSync, unhealthy }` count summary, so iterating it threw
 * "object is not iterable", and it declared a `status.history` the normalized
 * shape did not carry at all, so deploy frequency and lead time silently read
 * nothing. The client now exposes `resourceList` and `history`; this mirrors
 * them.
 */
export interface DoraApp {
  metadata?: { name?: string }
  spec?: {
    project?: string
    destination?: { namespace?: string }
    source?: { repoURL?: string }
    sources?: Array<{ repoURL?: string }>
  }
  status?: {
    history?: Array<{
      deployedAt?: string
      revision?: string
      revisions?: string[]
      source?: { repoURL?: string }
      sources?: Array<{ repoURL?: string }>
    }>
    operationState?: { phase?: string }
    /** Per-resource list (names included) — NOT the `resources` count summary. */
    resourceList?: Array<{ kind?: string; name?: string; namespace?: string }>
  }
}

/** Resource kinds that can be the subject of a workload alert. */
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Rollout'])

export function appWorkloads(app: DoraApp): string[] {
  const list = app.status?.resourceList
  // Defensive as well as correctly typed: this field comes through a cast at
  // the fetch boundary, and a shape drift here used to crash the whole
  // Overview rather than degrade one tile.
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const r of list) {
    if (r?.kind && WORKLOAD_KINDS.has(r.kind) && r.name) out.push(r.name)
  }
  return out
}

/**
 * Argo CD Applications through the Argo CD API, kept current by the apiserver
 * watch on the CRs (see argo-apps.ts). Same cache entry as the catalog's.
 */
export function useDoraApps(): UseQueryResult<DoraApp[]> {
  return useArgoApplications() as unknown as UseQueryResult<DoraApp[]>
}

/* ── OpenCost (Budget) ── */

interface OcAllocation {
  name?: string
  cpuCost?: number
  gpuCost?: number
  ramCost?: number
  pvCost?: number
  networkCost?: number
  loadBalancerCost?: number
  totalCost?: number
  properties?: { namespace?: string }
}

interface OcResponse {
  code?: number
  data?: Array<Record<string, OcAllocation> | null>
}

export interface BudgetNamespace {
  namespace: string
  actual: number
  prior: number
  share: number
}

export interface BudgetData {
  namespaces: BudgetNamespace[]
  monthlyTotal: number
  /** Configured monthly budget in USD, or null when unset. */
  budget: number | null
}

const PSEUDO = new Set(['__idle__', '__unallocated__', '__unmounted__'])
function isPseudo(k: string): boolean {
  return PSEUDO.has(k) || (k.startsWith('__') && k.endsWith('__'))
}

function totalOf(a: OcAllocation): number {
  const t = a.totalCost
  if (typeof t === 'number' && t > 0) return t
  return (
    (a.cpuCost ?? 0) +
    (a.gpuCost ?? 0) +
    (a.ramCost ?? 0) +
    (a.pvCost ?? 0) +
    (a.networkCost ?? 0) +
    (a.loadBalancerCost ?? 0)
  )
}

function configuredBudget(): number | null {
  try {
    const raw = (import.meta as { env?: Record<string, string | undefined> }).env
      ?.VITE_OPENCOST_MONTHLY_BUDGET
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

async function ocGet(path: string): Promise<OcResponse> {
  const res = await fetch(`/api/svc/opencost${path}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`OpenCost request failed (${res.status})`)
  return (await res.json()) as OcResponse
}

export function useBudget() {
  return useQuery({
    queryKey: ['ov', 'opencost', 'budget'],
    queryFn: async (): Promise<BudgetData> => {
      const [current, trendResp] = await Promise.all([
        ocGet('/allocation/compute?window=30d&aggregate=namespace&accumulate=true'),
        ocGet('/allocation/compute?window=60d&aggregate=namespace&accumulate=false&step=30d'),
      ])
      const currentMap = current.data?.[0] ?? {}
      const steps = (trendResp.data ?? []).map((m) => m ?? {})
      const priorMap = steps.length >= 2 ? steps[steps.length - 2] : {}

      const namespaces: BudgetNamespace[] = Object.entries(currentMap)
        .filter(([k]) => !isPseudo(k))
        .map(([key, a]) => {
          const namespace = a.properties?.namespace ?? a.name ?? key
          const prior = priorMap[namespace] ? totalOf(priorMap[namespace]) : 0
          return { namespace, actual: totalOf(a), prior, share: 0 }
        })
        .filter((n) => n.actual > 0)
        .sort((x, y) => y.actual - x.actual)

      const monthlyTotal = namespaces.reduce((s, n) => s + n.actual, 0)
      for (const n of namespaces) {
        n.share = monthlyTotal > 0 ? n.actual / monthlyTotal : 0
      }
      return { namespaces, monthlyTotal, budget: configuredBudget() }
    },
    // 30-day cost windows: OpenCost's own aggregation moves hourly at best.
    staleTime: 15 * 60_000,
    retry: false,
  })
}

/* ── OpenCost daily spend trend ── */

export interface CostTrendData {
  /** Daily total spend (USD), oldest → newest. */
  series: number[]
  total: number
  compute: number
  storage: number
  network: number
}

/**
 * 30-day daily cloud spend from OpenCost (`window=30d&step=1d`). Each step is a
 * map of namespace → allocation; we sum totalCost per day for the trend and
 * accumulate cost categories across the window. Errors (OpenCost absent) surface
 * so the panel can show an honest empty state instead of fabricating a series.
 */
export function useCostTrend() {
  return useQuery({
    queryKey: ['ov', 'opencost', 'trend'],
    queryFn: async (): Promise<CostTrendData> => {
      const resp = await ocGet(
        '/allocation/compute?window=30d&aggregate=namespace&accumulate=false&step=1d',
      )
      const steps = (resp.data ?? []).map((m) => m ?? {})
      const series = steps.map((step) =>
        Object.entries(step)
          .filter(([k]) => !isPseudo(k))
          .reduce((s, [, a]) => s + totalOf(a), 0),
      )
      let compute = 0
      let storage = 0
      let network = 0
      for (const step of steps) {
        for (const [k, a] of Object.entries(step)) {
          if (isPseudo(k)) continue
          compute += (a.cpuCost ?? 0) + (a.gpuCost ?? 0) + (a.ramCost ?? 0)
          storage += a.pvCost ?? 0
          network += (a.networkCost ?? 0) + (a.loadBalancerCost ?? 0)
        }
      }
      const total = series.reduce((s, v) => s + v, 0)
      return { series, total, compute, storage, network }
    },
    staleTime: 15 * 60_000,
    retry: false,
  })
}

/* ─────────── quantity parsing helpers ─────────── */

/** Parse a Kubernetes CPU quantity to cores. */
export function parseCpu(q?: string): number {
  if (!q) return 0
  if (q.endsWith('n')) return parseInt(q, 10) / 1e9
  if (q.endsWith('u')) return parseInt(q, 10) / 1e6
  if (q.endsWith('m')) return parseInt(q, 10) / 1e3
  const n = parseFloat(q)
  return Number.isFinite(n) ? n : 0
}

const MEM_UNITS: Record<string, number> = {
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
}

/** Parse a Kubernetes memory/storage quantity to bytes. */
export function parseBytes(q?: string): number {
  if (!q) return 0
  const m = /^([0-9.]+)\s*([A-Za-z]*)$/.exec(q.trim())
  if (!m) return 0
  const n = parseFloat(m[1])
  const unit = MEM_UNITS[m[2]] ?? 1
  return Number.isFinite(n) ? n * unit : 0
}
