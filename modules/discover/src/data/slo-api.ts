import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore } from '@adhar/shell-ui'
import type { lgtm } from '@adhar/api-clients'
import { promInstant, promRange, sampleNum } from './backends.ts'
import { BURN_WINDOWS, burnDown, errorRatioExpr, evaluate, eventsExpr, SLO_COLLECTION, type SloDefinition, type SloEval, windowsQuery } from './slo.ts'

/**
 * SLO hooks: definitions persist in the console document store
 * (`discover.slo`, tenant-scoped Postgres); every number is computed live from
 * Prometheus with the PromQL the definition generates. Nothing is cached
 * server-side or invented — no traffic means "no data".
 */

export function useSloDefs() {
  return useQuery({
    queryKey: ['slo', 'defs'],
    queryFn: async () => (await docStore.list<SloDefinition>(SLO_COLLECTION)).map((d) => ({ ...d.data, id: d.id, updatedAt: d.updatedAt, createdAt: d.createdAt })),
    staleTime: 30_000,
    retry: false,
  })
}

export function useSaveSlo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (def: SloDefinition) => docStore.put<SloDefinition>(SLO_COLLECTION, def.id, def),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['slo'] }),
  })
}

export function useDeleteSlo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => docStore.remove(SLO_COLLECTION, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['slo'] }),
  })
}

async function evalDef(def: SloDefinition): Promise<SloEval> {
  const res = await promInstant(windowsQuery(def))
  const ratios: Record<string, number | null> = {}
  for (const w of [...BURN_WINDOWS, `${def.windowDays}d`]) ratios[w] = null
  for (const s of res) {
    const w = s.metric.w
    if (w) ratios[w] = sampleNum(s.value[1])
  }
  return evaluate(def, ratios)
}

export function useSloEval(def: SloDefinition | null | undefined) {
  return useQuery({
    queryKey: ['slo', 'eval', def ? JSON.stringify([def.sli, def.objective, def.windowDays]) : ''],
    queryFn: () => evalDef(def!),
    enabled: !!def,
    refetchInterval: 60_000,
    retry: false,
  })
}

/** Budget burn-down over the whole SLO window (~120 points). */
export function useSloBurnDown(def: SloDefinition | null | undefined) {
  return useQuery({
    queryKey: ['slo', 'burndown', def ? JSON.stringify([def.sli, def.objective, def.windowDays]) : ''],
    queryFn: async () => {
      const d = def!
      const end = new Date()
      const start = new Date(end.getTime() - d.windowDays * 86400e3)
      const step = Math.max(300, Math.round((d.windowDays * 86400) / 120))
      const w = `${step}s`
      const [bad, total] = await Promise.all([
        promRange(eventsExpr(d, 'error', w, 'increase'), start, end, step),
        promRange(eventsExpr(d, 'total', w, 'increase'), start, end, step),
      ])
      const pts = (s: typeof bad) => (s[0]?.values ?? []).map(([t, v]) => [Number(t) * 1000, sampleNum(v) ?? NaN] as [number, number])
      const b = pts(bad)
      const t = pts(total)
      const firstData = t.find(([, v]) => Number.isFinite(v) && v > 0)?.[0] ?? null
      return { points: burnDown(b, t, d.objective), start: start.getTime(), end: end.getTime(), firstData }
    },
    enabled: !!def,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Error ratio (%) over the last `rangeMs`, on a 1h rolling window (SLI = 100 − this). */
export function useSliSeries(def: SloDefinition | null | undefined, rangeMs: number) {
  return useQuery({
    queryKey: ['slo', 'sli-series', def ? JSON.stringify([def.sli]) : '', rangeMs],
    queryFn: async () => {
      const end = new Date()
      const start = new Date(end.getTime() - rangeMs)
      const step = Math.max(60, Math.round(rangeMs / 1000 / 160))
      const r = await promRange(`100 * (${errorRatioExpr(def!, '1h')})`, start, end, step)
      return (r[0]?.values ?? []).map(([t, v]) => [Number(t) * 1000, sampleNum(v) ?? NaN] as [number, number]).filter(([, v]) => Number.isFinite(v))
    },
    enabled: !!def,
    staleTime: 60_000,
    retry: false,
  })
}

/** Dry-run a draft definition: current events/s and 1h error ratio. */
export async function testSlo(def: SloDefinition): Promise<{ totalRate: number | null; errorRatio1h: number | null }> {
  const [t, r] = await Promise.all([promInstant(eventsExpr(def, 'total', '5m')), promInstant(errorRatioExpr(def, '1h'))])
  return { totalRate: sampleNum(t[0]?.value[1]), errorRatio1h: sampleNum(r[0]?.value[1]) }
}

/** `le` buckets available on a histogram (for the latency threshold picker). */
export function useLeBuckets(metric: string, selector: string, enabled: boolean) {
  return useQuery({
    queryKey: ['slo', 'le', metric, selector],
    queryFn: async () => {
      const sel = selector.trim().replace(/^\{|\}$/g, '')
      const r = await promInstant(`count by (le) (${metric}_bucket{${sel}})`)
      return r.map((s) => s.metric.le).filter((le) => le && le !== '+Inf').sort((a, b) => Number(a) - Number(b))
    },
    enabled: enabled && /^[a-zA-Z_:][\w:]*$/.test(metric),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/* ─────────── Sloth (detected, read-only) ─────────── */

export interface SlothSlo {
  service: string
  slo: string
  objective: number | null
  remaining: number | null
  burn: number | null
}

export function useSlothSlos() {
  return useQuery({
    queryKey: ['slo', 'sloth'],
    queryFn: slothSlos,
    staleTime: 60_000,
    retry: false,
  })
}

async function slothSlos(): Promise<SlothSlo[]> {
  const [obj, rem, burn] = await Promise.all([
    promInstant('slo:objective:ratio'),
    promInstant('slo:period_error_budget_remaining:ratio').catch(() => []),
    promInstant('slo:current_burn_rate:ratio').catch(() => []),
  ])
  const key = (m: Record<string, string>) => `${m.sloth_service ?? ''}/${m.sloth_slo ?? ''}`
  const remBy = new Map(rem.map((s) => [key(s.metric), sampleNum(s.value[1])]))
  const burnBy = new Map(burn.map((s) => [key(s.metric), sampleNum(s.value[1])]))
  return obj
    .filter((s) => s.metric.sloth_slo)
    .map((s) => ({
      service: s.metric.sloth_service ?? '',
      slo: s.metric.sloth_slo ?? '',
      objective: sampleNum(s.value[1]),
      remaining: remBy.get(key(s.metric)) ?? null,
      burn: burnBy.get(key(s.metric)) ?? null,
    }))
}

/* ─────────── summary feed (Discover dashboard SLO widget) ─────────── */

/**
 * Every SLO with live numbers, in the `lgtm.Slo` shape the dashboard widget
 * reads: console-defined SLOs (doc store, evaluated now) plus Sloth SLOs found
 * in Prometheus. SLOs without data in their window are left out rather than
 * reported as "on track"; a burn window with no traffic counts as 0× (no
 * errors were spent), which is what Prometheus means by an empty rate.
 */
export async function listSloSummaries(): Promise<lgtm.Slo[]> {
  const out: lgtm.Slo[] = []
  const [defs, sloth] = await Promise.allSettled([docStore.list<SloDefinition>(SLO_COLLECTION), slothSlos()])
  if (defs.status === 'fulfilled') {
    const evals = await Promise.allSettled(defs.value.map((d) => evalDef({ ...d.data, id: d.id })))
    defs.value.forEach((d, i) => {
      const r = evals[i]
      if (r.status !== 'fulfilled' || r.value.remaining == null || r.value.sli == null) return
      const def = d.data
      out.push({
        name: def.name,
        service: def.service,
        indicator: def.sli.kind === 'availability' ? `${def.sli.metric} non-error ratio` : def.sli.kind === 'latency' ? `${def.sli.metric} ≤ ${def.sli.threshold}s` : 'custom PromQL',
        objective: def.objective,
        window: def.windowDays,
        current: r.value.sli,
        errorBudgetRemaining: r.value.remaining,
        burnRate1h: r.value.burn['1h'] ?? 0,
        burnRate6h: r.value.burn['6h'] ?? 0,
        history: [],
      })
    })
  }
  if (sloth.status === 'fulfilled') {
    for (const s of sloth.value) {
      if (s.remaining == null || s.objective == null) continue
      out.push({
        name: `${s.service} / ${s.slo}`,
        service: s.service,
        indicator: 'Sloth SLO',
        objective: s.objective * 100,
        window: 30,
        current: NaN,
        errorBudgetRemaining: s.remaining,
        burnRate1h: s.burn ?? 0,
        burnRate6h: s.burn ?? 0,
        history: [],
      })
    }
  }
  if (!out.length && defs.status === 'rejected' && sloth.status === 'rejected') throw defs.reason
  return out
}
