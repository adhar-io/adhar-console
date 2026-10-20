import { useQuery } from '@tanstack/react-query'
import { docStore } from '@adhar/shell-ui'
import { num, promInstant } from './prom.ts'

/**
 * Reliability signals for the Decide overview: the SLOs Discover stores in the
 * document store (`discover.slo`), evaluated over their own window against
 * Prometheus, and the alerts firing right now.
 *
 * The PromQL mirrors Discover's `slo.ts` (error events ÷ total events over the
 * SLO window) — duplicated deliberately, because a federated remote cannot
 * import another remote's source.
 */

export interface SloDef {
  id: string
  name: string
  service: string
  objective: number
  windowDays: number
  sli:
    | { kind: 'availability'; metric: string; selector: string; errorSelector: string }
    | { kind: 'latency'; metric: string; selector: string; threshold: string }
    | { kind: 'custom'; errorQuery: string; totalQuery: string }
}

function sel(...parts: string[]): string {
  return `{${parts.map((p) => p.trim().replace(/^\{|\}$/g, '').trim()).filter(Boolean).join(', ')}}`
}

export function errorRatioQuery(def: SloDef): string {
  const w = `${def.windowDays}d`
  const s = def.sli
  if (s.kind === 'availability') {
    return `sum(rate(${s.metric}${sel(s.selector, s.errorSelector)}[${w}])) / sum(rate(${s.metric}${sel(s.selector)}[${w}]))`
  }
  if (s.kind === 'latency') {
    const total = `sum(rate(${s.metric}_count${sel(s.selector)}[${w}]))`
    const good = `sum(rate(${s.metric}_bucket${sel(s.selector, `le="${s.threshold}"`)}[${w}]))`
    return `(${total} - ${good}) / ${total}`
  }
  return `(${s.errorQuery.replaceAll('$window', w)}) / (${s.totalQuery.replaceAll('$window', w)})`
}

export interface SloResult {
  def: SloDef
  /** SLI over the window, percent. */
  sli: number | null
  /** Fraction of error budget left (≤ 0 = spent). */
  budgetLeft: number | null
  status: 'breached' | 'at-risk' | 'healthy' | 'no-data'
}

/** Budget left: 1 − error ratio ÷ (1 − objective). Under 25 % left is at risk. */
export function sloStatus(errorRatio: number | null, objective: number): Omit<SloResult, 'def'> {
  if (errorRatio == null || !Number.isFinite(errorRatio)) return { sli: null, budgetLeft: null, status: 'no-data' }
  const budget = Math.max(1e-9, 1 - objective / 100)
  const left = 1 - errorRatio / budget
  return { sli: (1 - errorRatio) * 100, budgetLeft: left, status: left <= 0 ? 'breached' : left < 0.25 ? 'at-risk' : 'healthy' }
}

export function useSlos() {
  return useQuery({
    queryKey: ['decide', 'slo'],
    queryFn: async (): Promise<SloResult[]> => {
      const defs = (await docStore.list<SloDef>('discover.slo')).map((d) => ({ ...d.data, id: d.id }))
      return Promise.all(
        defs.map(async (def) => {
          try {
            const r = await promInstant(errorRatioQuery(def))
            return { def, ...sloStatus(num(r[0]?.value[1]), def.objective) }
          } catch {
            return { def, sli: null, budgetLeft: null, status: 'no-data' as const }
          }
        }),
      )
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  })
}

export interface FiringAlert {
  alertname: string
  severity: string
  namespace: string
}

export function useFiringAlerts() {
  return useQuery({
    queryKey: ['decide', 'prom', 'firing'],
    queryFn: async (): Promise<FiringAlert[]> =>
      (await promInstant('ALERTS{alertstate="firing"}')).map((s) => ({
        alertname: s.metric.alertname ?? '',
        severity: s.metric.severity ?? 'none',
        namespace: s.metric.namespace ?? '',
      })).filter((a) => a.alertname !== 'Watchdog' && a.alertname !== 'InfoInhibitor'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  })
}
