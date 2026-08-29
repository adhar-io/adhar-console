import { useQuery } from '@tanstack/react-query'
import { argocd, k8s } from '@adhar-console/api-clients'

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
const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

const REFRESH_MS = 30_000
const FAST_REFRESH_MS = 15_000

/* ─────────── GVR definitions for CRD-backed sources ─────────── */

const GVR = {
  nodeMetrics: { group: 'metrics.k8s.io', version: 'v1beta1', resource: 'nodes', namespaced: false },
  cnpgClusters: { group: 'postgresql.cnpg.io', version: 'v1', resource: 'clusters', namespaced: true },
  cnpgScheduledBackups: { group: 'postgresql.cnpg.io', version: 'v1', resource: 'scheduledbackups', namespaced: true },
  cnpgBackups: { group: 'postgresql.cnpg.io', version: 'v1', resource: 'backups', namespaced: true },
  veleroBackups: { group: 'velero.io', version: 'v1', resource: 'backups', namespaced: true },
  kafkas: { group: 'kafka.strimzi.io', version: 'v1beta2', resource: 'kafkas', namespaced: true },
  kafkaTopics: { group: 'kafka.strimzi.io', version: 'v1beta2', resource: 'kafkatopics', namespaced: true },
  workflows: { group: 'argoproj.io', version: 'v1alpha1', resource: 'workflows', namespaced: true },
  ciliumPolicies: { group: 'cilium.io', version: 'v2', resource: 'ciliumnetworkpolicies', namespaced: true },
  ciliumClusterPolicies: { group: 'cilium.io', version: 'v2', resource: 'ciliumclusterwidenetworkpolicies', namespaced: false },
  istioPeerAuth: { group: 'security.istio.io', version: 'v1beta1', resource: 'peerauthentications', namespaced: true },
  resourceQuotas: { group: '', version: 'v1', resource: 'resourcequotas', namespaced: true },
  endpoints: { group: '', version: 'v1', resource: 'endpoints', namespaced: true },
  certificates: { group: 'cert-manager.io', version: 'v1', resource: 'certificates', namespaced: true },
} as const

function useGeneric(key: string, gvr: (typeof GVR)[keyof typeof GVR], refetch = REFRESH_MS) {
  return useQuery({
    queryKey: ['ov', 'k8s', key],
    queryFn: () => client.listGeneric(undefined, gvr),
    refetchInterval: refetch,
    retry: false,
  })
}

/* ─────────── core k8s resources ─────────── */

export function useNodes() {
  return useQuery({
    queryKey: ['ov', 'k8s', 'nodes'],
    queryFn: () => client.listNodes(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

export function useAllPods() {
  return useQuery({
    queryKey: ['ov', 'k8s', 'pods'],
    queryFn: () => client.listPods(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

export function useNodeMetrics() {
  return useGeneric('node-metrics', GVR.nodeMetrics)
}

export function usePvcs() {
  return useQuery({
    queryKey: ['ov', 'k8s', 'pvcs'],
    queryFn: () => client.listPersistentVolumeClaims(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

export function usePvs() {
  return useQuery({
    queryKey: ['ov', 'k8s', 'pvs'],
    queryFn: () => client.listPersistentVolumes(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

export function useClusterEvents() {
  return useQuery({
    queryKey: ['ov', 'k8s', 'events'],
    queryFn: () => client.listEvents(),
    refetchInterval: FAST_REFRESH_MS,
    retry: false,
  })
}

export function useServices() {
  return useQuery({
    queryKey: ['ov', 'k8s', 'services'],
    queryFn: () => client.listServices(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

export function useEndpoints() {
  return useGeneric('endpoints', GVR.endpoints)
}

export function useIngresses() {
  return useQuery({
    queryKey: ['ov', 'k8s', 'ingresses'],
    queryFn: () => client.listIngresses(),
    refetchInterval: REFRESH_MS,
    retry: false,
  })
}

export function useResourceQuotas() {
  return useGeneric('resourcequotas', GVR.resourceQuotas)
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
  return useGeneric('kafkas', GVR.kafkas)
}

export function useKafkaTopics() {
  return useGeneric('kafka-topics', GVR.kafkaTopics)
}

export function useWorkflows() {
  return useGeneric('workflows', GVR.workflows, FAST_REFRESH_MS)
}

export function useCiliumPolicies() {
  return useGeneric('cilium-policies', GVR.ciliumPolicies)
}

export function useCiliumClusterPolicies() {
  return useGeneric('cilium-cluster-policies', GVR.ciliumClusterPolicies)
}

export function useIstioPeerAuth() {
  return useGeneric('istio-peerauth', GVR.istioPeerAuth)
}

/** cert-manager Certificates — real TLS certs with `status.notAfter` expiry. */
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

export function useToolsConfig() {
  return useQuery({
    queryKey: ['ov', 'config'],
    queryFn: async (): Promise<AppConfig> => {
      const res = await fetch('/api/config', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`config request failed (${res.status})`)
      return (await res.json()) as AppConfig
    },
    staleTime: 60_000,
    retry: false,
  })
}

/** Raw ArgoCD applications (with `status.history`) for DORA derivation. */
export interface DoraApp {
  metadata?: { name?: string }
  spec?: { project?: string }
  status?: {
    history?: Array<{ deployedAt?: string }>
    operationState?: { phase?: string }
  }
}

export function useDoraApps() {
  return useQuery({
    queryKey: ['ov', 'argocd', 'dora-apps'],
    queryFn: async () => (await argocdClient.listApplications()) as unknown as DoraApp[],
    refetchInterval: REFRESH_MS,
    retry: false,
  })
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
    staleTime: 60_000,
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
    staleTime: 60_000,
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
