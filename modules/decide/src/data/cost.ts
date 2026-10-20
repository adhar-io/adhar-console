import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore } from '@adhar/shell-ui'
import {
  blendedRates,
  type Budget,
  type CostRow,
  type DayCost,
  dailyOf,
  IDLE_KEY,
  isPseudo,
  type OcAllocation,
  type OcResponse,
  rowsOf,
  type Rates,
  type UsageRow,
} from './cost-model.ts'
import { envFromNamespace, projectFromNamespace } from './dora-model.ts'
import { num, promInstant } from './prom.ts'

/**
 * Spend data hooks. Every number comes from OpenCost's allocation API through
 * the console BFF (`/api/svc/opencost/allocation/compute`), usage for
 * rightsizing from Prometheus (`/api/svc/prometheus`), and budgets / saved
 * views from the tenant document store (`decide.budget`, `decide.spend-view`).
 * No fallback numbers: an unreachable source surfaces as an error.
 */

const OPENCOST = '/api/svc/opencost'

async function ocGet(params: Record<string, string>): Promise<OcResponse> {
  const res = await fetch(`${OPENCOST}/allocation/compute?${new URLSearchParams(params)}`, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw Object.assign(new Error(`OpenCost request failed (${res.status})`), { status: res.status })
  const body = (await res.json()) as OcResponse
  if (body.code && body.code >= 400) throw new Error(body.message ?? `OpenCost error ${body.code}`)
  return body
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const hourFloor = (ms: number) => Math.floor(ms / 3_600_000) * 3_600_000

export { SPEND_RANGES, type SpendRangeId, spendWindow } from './cost-model.ts'

/* ─────────── dimensions ─────────── */

export const DIMENSIONS = [
  { id: 'namespace', label: 'Namespace', aggregate: 'namespace' },
  { id: 'project', label: 'Project', aggregate: 'namespace' },
  { id: 'team', label: 'Team', aggregate: 'namespace' },
  { id: 'env', label: 'Environment', aggregate: 'namespace' },
  { id: 'workload', label: 'App / workload', aggregate: 'namespace,controller' },
  { id: 'label', label: 'Label', aggregate: 'label' },
] as const

export type DimensionId = (typeof DIMENSIONS)[number]['id']

export function dimensionOf(id: string | undefined) {
  return DIMENSIONS.find((d) => d.id === id) ?? DIMENSIONS[1]
}

/** OpenCost's aggregate parameter for a dimension. */
export function aggregateParam(dim: DimensionId, label: string): string {
  if (dim === 'label') return `label:${label || 'app.kubernetes.io/name'}`
  return dimensionOf(dim).aggregate
}

/** Platform namespaces have no project; they are the platform's own cost. */
export const PLATFORM = '(platform)'

export function projectOfNamespace(ns: string | undefined): string {
  return projectFromNamespace(ns) || PLATFORM
}

export function envOfNamespace(ns: string | undefined): string {
  return envFromNamespace(ns, projectFromNamespace(ns)) || '(none)'
}

/* ─────────── hooks ─────────── */

export interface Allocation {
  rows: CostRow[]
  idle: number
  allocated: number
  rates: Rates
}

function toAllocation(resp: OcResponse): Allocation {
  const m = resp.data?.[0] ?? {}
  const real = Object.entries(m).filter(([k]) => !isPseudo(k)).map(([, a]) => a as OcAllocation)
  return { ...rowsOf(resp), rates: blendedRates(real) }
}

/** Accumulated allocation for one window and aggregate. */
export function useAllocation(aggregate: string, start: number, end: number, enabled = true) {
  return useQuery({
    queryKey: ['decide', 'opencost', 'alloc', aggregate, start, end],
    queryFn: async () =>
      toAllocation(await ocGet({ window: `${iso(start)},${iso(end)}`, aggregate, accumulate: 'true', includeIdle: 'true' })),
    enabled: enabled && end > start,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    retry: false,
  })
}

/** Daily namespace spend from `start` to now (step 1d). */
export function useDailySpend(start: number, now: number) {
  const end = hourFloor(now)
  return useQuery({
    queryKey: ['decide', 'opencost', 'daily', start, end],
    queryFn: async (): Promise<DayCost[]> =>
      dailyOf(await ocGet({ window: `${iso(start)},${iso(end)}`, aggregate: 'namespace', step: '1d', accumulate: 'false', includeIdle: 'true' })),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    retry: false,
  })
}

/** A day's spend restricted to namespaces that pass `keep` (idle only when everything is kept). */
export function scopeDays(days: DayCost[], keep: ((ns: string) => boolean) | null): DayCost[] {
  if (!keep) return days
  return days.map((d) => {
    const byKey: Record<string, number> = {}
    let total = 0
    for (const [k, v] of Object.entries(d.byKey)) {
      if (k === IDLE_KEY || !keep(k)) continue
      byKey[k] = v
      total += v
    }
    return { day: d.day, total, idle: 0, byKey }
  })
}

/* ─────────── rightsizing usage (Prometheus) ─────────── */

const C = 'container!="", container!="POD"'
export const RIGHTSIZE_QUERIES = {
  cpuP95: `quantile_over_time(0.95, (avg by (namespace, container) (rate(container_cpu_usage_seconds_total{${C}}[5m])))[7d:15m])`,
  memMax: `max_over_time((avg by (namespace, container) (container_memory_working_set_bytes{${C}}))[7d:15m])`,
  cpuReq: 'avg by (namespace, container) (kube_pod_container_resource_requests{resource="cpu"})',
  memReq: 'avg by (namespace, container) (kube_pod_container_resource_requests{resource="memory"})',
  replicas: 'count by (namespace, container) (kube_pod_container_resource_requests{resource="cpu"})',
}

export function useRightsizeUsage(enabled: boolean) {
  return useQuery({
    queryKey: ['decide', 'prom', 'rightsize'],
    queryFn: async (): Promise<UsageRow[]> => {
      const [cpuP95, memMax, cpuReq, memReq, replicas] = await Promise.all([
        promInstant(RIGHTSIZE_QUERIES.cpuP95),
        promInstant(RIGHTSIZE_QUERIES.memMax),
        promInstant(RIGHTSIZE_QUERIES.cpuReq),
        promInstant(RIGHTSIZE_QUERIES.memReq),
        promInstant(RIGHTSIZE_QUERIES.replicas),
      ])
      const key = (m: Record<string, string>) => `${m.namespace}/${m.container}`
      const idx = (r: typeof cpuP95) => new Map(r.map((s) => [key(s.metric), num(s.value[1])]))
      const p95 = idx(cpuP95)
      const mx = idx(memMax)
      const mr = idx(memReq)
      const rp = idx(replicas)
      return cpuReq
        .filter((s) => s.metric.namespace && s.metric.container)
        .map((s) => {
          const k = key(s.metric)
          return {
            namespace: s.metric.namespace,
            container: s.metric.container,
            cpuReq: num(s.value[1]) ?? 0,
            cpuP95: p95.get(k) ?? null,
            memReq: mr.get(k) ?? 0,
            memMax: mx.get(k) ?? null,
            replicas: rp.get(k) ?? 1,
          }
        })
    },
    enabled,
    staleTime: 15 * 60_000,
    retry: false,
  })
}

/* ─────────── budgets & saved views (doc store) ─────────── */

export const BUDGET_KIND = 'decide.budget'
export const VIEW_KIND = 'decide.spend-view'

export function useBudgets() {
  return useQuery({
    queryKey: ['decide', 'budgets'],
    queryFn: async () => (await docStore.list<Budget>(BUDGET_KIND)).map((d) => ({ ...d.data, id: d.id })),
    staleTime: 60_000,
    retry: false,
  })
}

export function useSaveBudget() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...rest }: Budget) =>
      id ? docStore.put<Omit<Budget, 'id'>>(BUDGET_KIND, id, rest) : docStore.create<Omit<Budget, 'id'>>(BUDGET_KIND, rest),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['decide', 'budgets'] }),
  })
}

export function useDeleteBudget() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => docStore.remove(BUDGET_KIND, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['decide', 'budgets'] }),
  })
}

export interface SpendView {
  id: string
  name: string
  /** The page's search params, minus `section`. */
  params: Record<string, string>
}

export function useSpendViews() {
  return useQuery({
    queryKey: ['decide', 'spend-views'],
    queryFn: async () => (await docStore.list<SpendView>(VIEW_KIND)).map((d) => ({ ...d.data, id: d.id })),
    staleTime: 60_000,
    retry: false,
  })
}

export function useSaveSpendView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: Omit<SpendView, 'id'>) => docStore.create<Omit<SpendView, 'id'>>(VIEW_KIND, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['decide', 'spend-views'] }),
  })
}

export function useDeleteSpendView() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => docStore.remove(VIEW_KIND, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['decide', 'spend-views'] }),
  })
}
