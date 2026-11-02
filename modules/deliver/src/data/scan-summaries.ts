import { useQuery } from '@tanstack/react-query'
import { useWatchSignal } from './live.ts'

/**
 * Per-image CVE counts for the Deliver dashboard, read as a Kubernetes **Table**
 * (`Accept: application/json;as=Table`) instead of the full report list.
 *
 * Every VulnerabilityReport carries its whole vulnerability list; a modest
 * cluster's list is tens of megabytes (68 MB / 11 s measured) and the
 * dashboard only needs the five counts trivy-operator already publishes as
 * printer columns (Critical / High / Medium / Low / Unknown). The Table form of
 * the same list is ~1% of the size and answers in well under a second.
 */

export interface ScanSummaryRow {
  namespace: string
  name: string
  summary: { critical: number; high: number; medium: number; low: number; unknown: number }
}

interface K8sTable {
  kind?: string
  columnDefinitions?: Array<{ name: string }>
  rows?: Array<{ cells?: unknown[]; object?: { metadata?: { name?: string; namespace?: string } } }>
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Pure: a `meta.k8s.io/v1 Table` of VulnerabilityReports → summary rows. */
export function parseScanTable(table: K8sTable): ScanSummaryRow[] {
  const cols = (table.columnDefinitions ?? []).map((c) => c.name.toLowerCase())
  const at = Object.fromEntries(SEVERITIES.map((s) => [s, cols.indexOf(s)])) as Record<(typeof SEVERITIES)[number], number>
  return (table.rows ?? []).map((r) => {
    const cells = r.cells ?? []
    const pick = (s: (typeof SEVERITIES)[number]) => (at[s] >= 0 ? num(cells[at[s]]) : 0)
    return {
      namespace: r.object?.metadata?.namespace ?? '',
      name: r.object?.metadata?.name ?? String(cells[0] ?? ''),
      summary: { critical: pick('critical'), high: pick('high'), medium: pick('medium'), low: pick('low'), unknown: pick('unknown') },
    }
  })
}

const GROUP = 'aquasecurity.github.io'
const PATH = `/api/k8s/apis/${GROUP}/v1alpha1/vulnerabilityreports`
const TABLE_ACCEPT = 'application/json;as=Table;g=meta.k8s.io;v=v1,application/json'

async function fetchScanSummaries(): Promise<ScanSummaryRow[]> {
  const res = await fetch(PATH, { credentials: 'include', headers: { accept: TABLE_ACCEPT } })
  // Not installed / not allowed read as "no reports", as the full list did.
  if (res.status === 404 || res.status === 403) return []
  if (!res.ok) {
    const err = new Error(`Kubernetes ${res.status} ${res.statusText} listing VulnerabilityReports`) as Error & { status: number }
    err.status = res.status
    throw err
  }
  const body = (await res.json()) as K8sTable & { items?: Array<{ metadata?: { name?: string; namespace?: string }; report?: { summary?: Record<string, number> } }> }
  // A gateway that ignored the Table Accept answers with the plain list.
  if (body.kind !== 'Table' && Array.isArray(body.items)) {
    return body.items.map((i) => ({
      namespace: i.metadata?.namespace ?? '',
      name: i.metadata?.name ?? '',
      summary: {
        critical: num(i.report?.summary?.criticalCount),
        high: num(i.report?.summary?.highCount),
        medium: num(i.report?.summary?.mediumCount),
        low: num(i.report?.summary?.lowCount),
        unknown: num(i.report?.summary?.unknownCount),
      },
    }))
  }
  return parseScanTable(body)
}

export function useScanSummaries() {
  const queryKey = ['trivy', 'summaries', 'vulnerabilityreports']
  return useQuery({
    queryKey,
    queryFn: fetchScanSummaries,
    // Same cluster-wide watch as the full report list; a scan wave re-reads at most every 30s.
    refetchInterval: useWatchSignal(
      { group: GROUP, version: 'v1alpha1', resource: 'vulnerabilityreports' },
      [queryKey],
      { throttleMs: 30_000 },
    ),
  })
}
