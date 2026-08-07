import { useQuery, type UseQueryResult } from '@tanstack/react-query'

/**
 * Cloud-cost breakdown — REAL, backed by OpenCost / Kubecost allocation data.
 *
 * Data is fetched live through the console BFF proxy at `/api/svc/opencost/…`
 * (service-authenticated by the server; no client token). There is NO stub /
 * synthesized fallback: if OpenCost is unreachable or not configured the proxy
 * errors and this query surfaces the error so the view can render an
 * error/empty state (never fake numbers).
 *
 * OpenCost REST allocation API (https://www.opencost.io/docs/integrations/api):
 *   GET /allocation/compute?window=…&aggregate=…&accumulate=…&step=…
 *   → { code, data: [ { "<key>": { name, cpuCost, ramCost, pvCost,
 *        networkCost, gpuCost, totalCost, properties? } , … } , … ] }
 * With `accumulate=true` `data` has a single roll-up map; with
 * `accumulate=false&step=30d` it is one map per time step.
 */

export interface CostComponents {
  /** vCPU / compute cost (cpuCost + gpuCost). */
  compute: number
  /** RAM cost (ramCost). */
  memory: number
  /** Persistent-volume cost (pvCost). */
  storage: number
  /** Egress / load-balancer cost (networkCost). */
  network: number
}

export interface NamespaceCost {
  namespace: string
  total: number
  components: CostComponents
  /** Month-over-month change as a fraction (e.g. 0.064 = +6.4%). */
  momPct: number
  /** Share of the monthly total, 0–100. */
  share: number
  /** Trailing 6-month monthly totals (oldest → newest). */
  trend: number[]
}

export interface WorkloadCost {
  workload: string
  namespace: string
  /** Controller kind reported by OpenCost (Deployment, StatefulSet, …). */
  kind: string
  total: number
  components: CostComponents
}

export interface CostBreakdown {
  monthlyTotal: number
  prevMonthTotal: number
  /** Month-over-month change as a fraction. */
  momPct: number
  /** Aggregate cost components across every namespace. */
  components: CostComponents
  namespaces: NamespaceCost[]
  workloads: WorkloadCost[]
  /** Trailing 6-month monthly totals (oldest → newest). */
  trend: number[]
  /**
   * Monthly budget threshold in USD, or `null` when none is configured. Driven
   * by the `VITE_OPENCOST_MONTHLY_BUDGET` build-time env — never fabricated.
   */
  budget: number | null
}

/* ── OpenCost wire types ──────────────────────────────────────────────── */

interface OcAllocation {
  name?: string
  cpuCost?: number
  gpuCost?: number
  ramCost?: number
  pvCost?: number
  networkCost?: number
  loadBalancerCost?: number
  totalCost?: number
  properties?: {
    namespace?: string
    controller?: string
    controllerKind?: string
  }
}

interface OcResponse {
  code?: number
  data?: Array<Record<string, OcAllocation> | null>
}

/** OpenCost pseudo-allocations that aren't real namespaces/workloads. */
const PSEUDO = new Set(['__idle__', '__unallocated__', '__unmounted__'])

function isPseudo(key: string): boolean {
  return PSEUDO.has(key) || (key.startsWith('__') && key.endsWith('__'))
}

function componentsOf(a: OcAllocation): CostComponents {
  return {
    compute: (a.cpuCost ?? 0) + (a.gpuCost ?? 0),
    memory: a.ramCost ?? 0,
    storage: a.pvCost ?? 0,
    network: (a.networkCost ?? 0) + (a.loadBalancerCost ?? 0),
  }
}

function addComponents(x: CostComponents, y: CostComponents): CostComponents {
  return {
    compute: x.compute + y.compute,
    memory: x.memory + y.memory,
    storage: x.storage + y.storage,
    network: x.network + y.network,
  }
}

function totalOf(a: OcAllocation): number {
  const t = a.totalCost
  if (typeof t === 'number' && t > 0) return t
  const c = componentsOf(a)
  return c.compute + c.memory + c.storage + c.network
}

/* ── OpenCost fetch (through the BFF proxy) ───────────────────────────── */

const OPENCOST_BASE = '/api/svc/opencost'

async function ocGet(path: string): Promise<OcResponse> {
  const res = await fetch(`${OPENCOST_BASE}${path}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`OpenCost request failed (${res.status} ${res.statusText})`)
  }
  return (await res.json()) as OcResponse
}

/** First (or only) allocation map in an OpenCost response. */
function firstMap(r: OcResponse): Record<string, OcAllocation> {
  const m = r.data?.[0]
  return m ?? {}
}

/** All per-step allocation maps (accumulate=false responses). */
function stepMaps(r: OcResponse): Array<Record<string, OcAllocation>> {
  return (r.data ?? []).map((m) => m ?? {})
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

/* ── mapping OpenCost → CostBreakdown ─────────────────────────────────── */

function buildBreakdown(
  current: OcResponse,
  trendResp: OcResponse,
  workloadsResp: OcResponse,
): CostBreakdown {
  // Current-month namespaces (30d, accumulated).
  const currentMap = firstMap(current)

  // Trailing 6 steps (each 30d), per namespace.
  const steps = stepMaps(trendResp)
  const stepTotals = steps.map((m) =>
    Object.entries(m).reduce((sum, [k, a]) => (isPseudo(k) ? sum : sum + totalOf(a)), 0),
  )
  const nsTrend = (ns: string): number[] => steps.map((m) => (m[ns] ? totalOf(m[ns]) : 0))

  const namespaces: NamespaceCost[] = Object.entries(currentMap)
    .filter(([k]) => !isPseudo(k))
    .map(([key, a]) => {
      const namespace = a.properties?.namespace ?? a.name ?? key
      const total = totalOf(a)
      const t = nsTrend(namespace)
      const prev = t.length >= 2 ? t[t.length - 2] : 0
      const last = t.length >= 1 ? t[t.length - 1] : total
      const momPct = prev > 0 ? Number(((last - prev) / prev).toFixed(4)) : 0
      return {
        namespace,
        total,
        components: componentsOf(a),
        momPct,
        share: 0, // filled once the grand total is known
        trend: t.length ? t : [total],
      }
    })
    .sort((x, y) => y.total - x.total)

  const monthlyTotal = namespaces.reduce((s, n) => s + n.total, 0)
  for (const n of namespaces) {
    n.share = monthlyTotal > 0 ? Math.round((n.total / monthlyTotal) * 1000) / 10 : 0
  }

  const components = namespaces.reduce<CostComponents>(
    (acc, n) => addComponents(acc, n.components),
    { compute: 0, memory: 0, storage: 0, network: 0 },
  )

  // Aggregate 6-month trend from the step totals; pin the newest point to the
  // authoritative current-month total so the hero + trend agree.
  const trend = stepTotals.length ? [...stepTotals] : [monthlyTotal]
  trend[trend.length - 1] = monthlyTotal
  const prevMonthTotal = trend.length >= 2 ? trend[trend.length - 2] : monthlyTotal
  const momPct = prevMonthTotal > 0
    ? Number(((monthlyTotal - prevMonthTotal) / prevMonthTotal).toFixed(4))
    : 0

  // Workloads (30d, aggregated by controller).
  const workloadMap = firstMap(workloadsResp)
  const workloads: WorkloadCost[] = Object.entries(workloadMap)
    .filter(([k]) => !isPseudo(k))
    .map(([key, a]) => ({
      workload: a.properties?.controller ?? a.name ?? key,
      namespace: a.properties?.namespace ?? '—',
      kind: a.properties?.controllerKind ?? 'Workload',
      total: totalOf(a),
      components: componentsOf(a),
    }))
    .filter((w) => w.total > 0)
    .sort((x, y) => y.total - x.total)

  return {
    monthlyTotal,
    prevMonthTotal,
    momPct,
    components,
    namespaces,
    workloads,
    trend,
    budget: configuredBudget(),
  }
}

async function fetchCostBreakdown(): Promise<CostBreakdown> {
  const [current, trendResp, workloadsResp] = await Promise.all([
    ocGet('/allocation/compute?window=30d&aggregate=namespace&accumulate=true'),
    ocGet('/allocation/compute?window=180d&aggregate=namespace&accumulate=false&step=30d'),
    ocGet('/allocation/compute?window=30d&aggregate=controller&accumulate=true'),
  ])
  return buildBreakdown(current, trendResp, workloadsResp)
}

/**
 * Live namespace + workload cost breakdown from OpenCost — monthly totals,
 * OpenCost cost components (compute / memory / storage / network), MoM deltas
 * from consecutive monthly steps, share, a trailing 6-month trend, and an
 * optional configured budget. Real `useQuery`: loading + error are surfaced,
 * never faked.
 */
export function useCostBreakdown(): UseQueryResult<CostBreakdown> {
  return useQuery({
    queryKey: ['opencost', 'allocation', 'breakdown'],
    queryFn: fetchCostBreakdown,
    staleTime: 60_000,
    retry: false,
  })
}

/* ── formatting helpers ───────────────────────────────────────────────── */

export function formatUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 10_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${Math.round(v).toLocaleString('en-US')}`
}

export function formatPct(fraction: number): string {
  const sign = fraction > 0 ? '+' : ''
  return `${sign}${(fraction * 100).toFixed(1)}%`
}
