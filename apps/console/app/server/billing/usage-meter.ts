import { env } from '@adhar-console/utils'
import { apiServerFetch } from '../k8s/gateway.ts'

/**
 * Usage metering — REAL sources only, never fabricated:
 *
 *   - seats        → count of `workspace.member` docs for the tenant (Postgres)
 *   - namespaces / pods / nodes → live kube-apiserver counts via the caller's
 *     token (their RBAC applies). Namespaces are tenant-scoped when possible:
 *     `adhar.io/tenant=<tenant>` label first, then `<tenant>-` prefix, falling
 *     back to the whole cluster (single-tenant installs).
 *   - cpuCoreHours / memGbHours / cost ($) → OpenCost allocation API
 *     (`OPENCOST_URL`, optional `OPENCOST_TOKEN`), aggregated by namespace for
 *     the period and filtered to the tenant's namespaces when scoped.
 *
 * When a source is unconfigured or unreachable the corresponding fields are
 * `null` with an explicit `*Source: 'unavailable'` flag — the UI shows "not
 * connected", never a fake number.
 */

export interface NamespaceUsage {
  namespace: string
  cost: number | null
  cpuCoreHours: number | null
  memGbHours: number | null
  pods: number | null
}

export interface UsageReport {
  /** Billing period `YYYY-MM`. */
  period: string
  windowStart: string
  windowEnd: string
  /** Seats in use (tenant members). Null when no database is configured. */
  seats: number | null
  seatsSource: 'workspace.member' | 'unavailable'
  namespaces: number | null
  pods: number | null
  nodes: number | null
  clusterSource: 'kubernetes' | 'unavailable'
  /** How the namespace set was scoped to the tenant. */
  clusterScope: 'tenant-label' | 'tenant-prefix' | 'cluster' | null
  cpuCoreHours: number | null
  memGbHours: number | null
  /** Total $ for the period. Null unless OpenCost answered. */
  cost: number | null
  costSource: 'opencost' | 'unavailable'
  breakdownByNamespace: NamespaceUsage[]
}

/** Minimal doc-store surface the meter needs (satisfied by `@adhar-console/db`). */
export interface MeterDb {
  conn: unknown
  listDocuments(conn: unknown, tenant: string, kind: string): Promise<unknown[]>
}

export interface MeterInput {
  tenant: string
  /** `YYYY-MM`; defaults to the current UTC month. */
  period?: string
  /** Caller's Keycloak access token for apiserver counts. Null ⇒ cluster unavailable. */
  token: string | null
  /** Postgres access for seat counting. Null ⇒ seats unavailable. */
  db: MeterDb | null
}

/** Resolve `YYYY-MM` → [start, end) clamped to now. */
export function periodWindow(period?: string): { period: string; start: Date; end: Date } {
  const now = new Date()
  const m = /^(\d{4})-(\d{2})$/.exec(period ?? '')
  const year = m ? Number(m[1]) : now.getUTCFullYear()
  const month = m ? Number(m[2]) - 1 : now.getUTCMonth()
  const start = new Date(Date.UTC(year, month, 1))
  const boundary = new Date(Date.UTC(year, month + 1, 1))
  const end = boundary.getTime() > now.getTime() ? now : boundary
  const label = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`
  return { period: label, start, end }
}

const K8S_TIMEOUT_MS = 10_000
const OPENCOST_TIMEOUT_MS = 15_000
/** When tenant-scoped, count pods per namespace for at most this many namespaces. */
const MAX_SCOPED_NAMESPACES = 40

/* ─────────────────── kube-apiserver counts ─────────────────── */

interface K8sList {
  items?: { metadata?: { name?: string; labels?: Record<string, string> } }[]
  metadata?: { remainingItemCount?: number; continue?: string }
}

async function k8sJson(token: string, path: string, search?: string): Promise<K8sList | null> {
  try {
    const res = await apiServerFetch(token, path, {
      search,
      signal: AbortSignal.timeout(K8S_TIMEOUT_MS),
    })
    if (!res.ok) {
      // Drain so the connection is released.
      await res.body?.cancel()
      return null
    }
    return (await res.json()) as K8sList
  } catch {
    return null
  }
}

/** Count a collection via `limit=1` + `remainingItemCount` (no full download). */
async function k8sCount(token: string, path: string): Promise<number | null> {
  const body = await k8sJson(token, path, '?limit=1')
  if (!body) return null
  const items = body.items?.length ?? 0
  return items + (body.metadata?.remainingItemCount ?? 0)
}

interface ClusterCounts {
  namespaces: number | null
  namespaceNames: string[] | null
  scope: 'tenant-label' | 'tenant-prefix' | 'cluster' | null
  pods: number | null
  podsByNamespace: Map<string, number>
  nodes: number | null
  available: boolean
}

async function clusterCounts(token: string | null, tenant: string): Promise<ClusterCounts> {
  const empty: ClusterCounts = {
    namespaces: null,
    namespaceNames: null,
    scope: null,
    pods: null,
    podsByNamespace: new Map(),
    nodes: null,
    available: false,
  }
  if (!token) return empty

  const nsList = await k8sJson(token, '/api/v1/namespaces')
  if (!nsList?.items) return empty

  const all = nsList.items
    .map((i) => ({ name: i.metadata?.name ?? '', labels: i.metadata?.labels ?? {} }))
    .filter((i) => i.name)

  const labeled = all.filter((i) => i.labels['adhar.io/tenant'] === tenant)
  const prefixed = all.filter((i) => i.name === tenant || i.name.startsWith(`${tenant}-`))
  const scoped = labeled.length > 0 ? labeled : prefixed
  const scope: ClusterCounts['scope'] =
    labeled.length > 0 ? 'tenant-label' : prefixed.length > 0 ? 'tenant-prefix' : 'cluster'
  const names = (scope === 'cluster' ? all : scoped).map((i) => i.name)

  const nodes = await k8sCount(token, '/api/v1/nodes')

  let pods: number | null = null
  const podsByNamespace = new Map<string, number>()
  if (scope === 'cluster' || names.length > MAX_SCOPED_NAMESPACES) {
    pods = await k8sCount(token, '/api/v1/pods')
  } else {
    const counts = await Promise.all(
      names.map((ns) => k8sCount(token, `/api/v1/namespaces/${encodeURIComponent(ns)}/pods`)),
    )
    pods = 0
    counts.forEach((c, i) => {
      if (c !== null) {
        pods! += c
        podsByNamespace.set(names[i], c)
      }
    })
  }

  return {
    namespaces: names.length,
    namespaceNames: scope === 'cluster' ? null : names,
    scope,
    pods,
    podsByNamespace,
    nodes,
    available: true,
  }
}

/* ─────────────────── OpenCost allocation ─────────────────── */

interface OpenCostAlloc {
  cpuCoreHours?: number
  ramByteHours?: number
  totalCost?: number
}

export interface AllocationEntry {
  key: string
  cpuCoreHours: number
  memGbHours: number
  cost: number
}

/**
 * Query the OpenCost allocation API for a window, aggregated by `aggregate`
 * (namespace, controller, service, node, cluster, …). Returns null when
 * OpenCost is unconfigured or unreachable — callers must surface that, not
 * substitute numbers.
 */
export async function openCostAllocation(
  start: Date,
  end: Date,
  aggregate: string,
): Promise<AllocationEntry[] | null> {
  const base = (env('OPENCOST_URL') ?? '').replace(/\/$/, '')
  if (!base) return null
  const window = `${start.toISOString()},${end.toISOString()}`
  const url = `${base}/allocation?window=${encodeURIComponent(window)}&aggregate=${encodeURIComponent(aggregate)}&accumulate=true`
  const token = env('OPENCOST_TOKEN')
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(OPENCOST_TIMEOUT_MS),
    })
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    const body = (await res.json()) as { data?: Record<string, OpenCostAlloc>[] }
    if (!Array.isArray(body.data)) return null
    const merged = new Map<string, AllocationEntry>()
    for (const set of body.data) {
      for (const [key, a] of Object.entries(set ?? {})) {
        const prev = merged.get(key) ?? { key, cpuCoreHours: 0, memGbHours: 0, cost: 0 }
        prev.cpuCoreHours += a.cpuCoreHours ?? 0
        prev.memGbHours += (a.ramByteHours ?? 0) / 1024 ** 3
        prev.cost += a.totalCost ?? 0
        merged.set(key, prev)
      }
    }
    return [...merged.values()]
  } catch (e) {
    console.error('[billing] opencost unreachable:', e instanceof Error ? e.message : e)
    return null
  }
}

/* ─────────────────── the meter ─────────────────── */

const round2 = (n: number) => Math.round(n * 100) / 100
const round1 = (n: number) => Math.round(n * 10) / 10

/** Small TTL cache so budgets/invoices/usage pages don't re-meter per request. */
const cache = new Map<string, { at: number; report: UsageReport }>()
const CACHE_TTL_MS = 60_000

export async function meterUsage(input: MeterInput): Promise<UsageReport> {
  const { period, start, end } = periodWindow(input.period)
  const key = `${input.tenant}:${period}:${input.token ? 'k8s' : 'nok8s'}:${input.db ? 'db' : 'nodb'}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.report

  // Seats — tenant member documents. The authenticated caller is themselves a
  // real seat, so an empty member collection still counts 1 (no fabrication:
  // the requesting user demonstrably exists).
  let seats: number | null = null
  let seatsSource: UsageReport['seatsSource'] = 'unavailable'
  if (input.db) {
    try {
      const members = await input.db.listDocuments(input.db.conn, input.tenant, 'workspace.member')
      seats = Math.max(members.length, 1)
      seatsSource = 'workspace.member'
    } catch (e) {
      console.error('[billing] seat count failed:', e instanceof Error ? e.message : e)
    }
  }

  const cluster = await clusterCounts(input.token, input.tenant)

  const alloc = await openCostAllocation(start, end, 'namespace')
  let cost: number | null = null
  let cpuCoreHours: number | null = null
  let memGbHours: number | null = null
  let costRows: AllocationEntry[] = []
  if (alloc) {
    costRows =
      cluster.namespaceNames !== null
        ? alloc.filter((a) => cluster.namespaceNames!.includes(a.key))
        : alloc
    cost = round2(costRows.reduce((s, a) => s + a.cost, 0))
    cpuCoreHours = round1(costRows.reduce((s, a) => s + a.cpuCoreHours, 0))
    memGbHours = round1(costRows.reduce((s, a) => s + a.memGbHours, 0))
  }

  // Breakdown rows: union of namespaces we know about (cost rows + live pods).
  const nsNames = new Set<string>([
    ...costRows.map((r) => r.key),
    ...(cluster.namespaceNames ?? []),
  ])
  const costByNs = new Map(costRows.map((r) => [r.key, r]))
  const breakdownByNamespace: NamespaceUsage[] = [...nsNames]
    .sort((a, b) => (costByNs.get(b)?.cost ?? 0) - (costByNs.get(a)?.cost ?? 0))
    .map((ns) => {
      const c = costByNs.get(ns)
      return {
        namespace: ns,
        cost: alloc ? round2(c?.cost ?? 0) : null,
        cpuCoreHours: alloc ? round1(c?.cpuCoreHours ?? 0) : null,
        memGbHours: alloc ? round1(c?.memGbHours ?? 0) : null,
        pods: cluster.podsByNamespace.has(ns) ? cluster.podsByNamespace.get(ns)! : null,
      }
    })

  const report: UsageReport = {
    period,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    seats,
    seatsSource,
    namespaces: cluster.namespaces,
    pods: cluster.pods,
    nodes: cluster.nodes,
    clusterSource: cluster.available ? 'kubernetes' : 'unavailable',
    clusterScope: cluster.scope,
    cpuCoreHours,
    memGbHours,
    cost,
    costSource: alloc ? 'opencost' : 'unavailable',
    breakdownByNamespace,
  }
  cache.set(key, { at: Date.now(), report })
  return report
}

/**
 * Total metered cost for an arbitrary window scoped to a namespace set
 * (used for budget / cost-center spend). Null when OpenCost is unavailable.
 */
export async function costForWindow(
  start: Date,
  end: Date,
  namespaces: string[] | null,
): Promise<number | null> {
  const alloc = await openCostAllocation(start, end, 'namespace')
  if (!alloc) return null
  const rows = namespaces === null ? alloc : alloc.filter((a) => namespaces.includes(a.key))
  return round2(rows.reduce((s, a) => s + a.cost, 0))
}
