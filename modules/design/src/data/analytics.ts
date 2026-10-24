import { useQuery } from '@tanstack/react-query'
import type { AnalyticsEvidence, Journey } from './types.ts'

/**
 * Product-analytics evidence for personas and journeys — PostHog through the
 * console BFF tool proxy (`/api/svc/posthog/…`, the server injects the key),
 * the same endpoints Discover uses:
 *
 *   • GET  /api/projects/@current/cohorts/            cohort list + size
 *   • GET  /api/projects/@current/cohorts/<id>/persons/  a sample, for AI grounding
 *   • GET  /api/projects/@current/event_definitions/  event pickers
 *   • POST /api/projects/@current/query/              FunnelsQuery for a journey
 *
 * Nothing is ever estimated: a missing count stays missing, a PostHog that is
 * not configured (or still starting) is reported as such.
 */

const BASE = '/api/svc/posthog/api/projects/@current'

export class AnalyticsError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'AnalyticsError'
  }
}

async function ph<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      headers: { accept: 'application/json', ...(init?.json !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    })
  } catch (e) {
    throw new AnalyticsError(0, `PostHog is unreachable: ${(e as Error).message}`)
  }
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  if (!res.ok) {
    const detail = (body as { detail?: string; error?: string } | undefined)?.detail ?? (body as { error?: string } | undefined)?.error ?? ''
    throw new AnalyticsError(res.status, `PostHog HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
  if (typeof body === 'string' && /^\s*</.test(body)) {
    throw new AnalyticsError(401, 'PostHog answered with an HTML page instead of JSON — is POSTHOG_TOKEN set?')
  }
  return body as T
}

/** A human sentence for why analytics are unavailable. */
export function analyticsProblem(e: unknown): string {
  const s = (e as { status?: number } | null)?.status ?? 0
  if (s === 0) return 'PostHog is not reachable from the console.'
  if (s === 401 || s === 403) return 'PostHog is not configured for the console (no API key).'
  if (s === 404) return 'PostHog is not installed on this platform.'
  if (s >= 502 && s <= 504) return 'PostHog is starting up — try again shortly.'
  return (e as Error)?.message ?? 'PostHog request failed.'
}

const noRetry4xx = (n: number, e: unknown) => {
  const s = (e as { status?: number }).status ?? 0
  return !(s >= 400 && s < 500) && s !== 0 && n < 1
}

/* ─────────── cohorts ─────────── */

export interface Cohort {
  id: number | string
  name: string
  description?: string
  count?: number | null
  is_calculating?: boolean
  is_static?: boolean
  last_calculation?: string | null
}

export function useCohorts(enabled = true) {
  return useQuery({
    queryKey: ['design', 'ph', 'cohorts'],
    queryFn: async () => (await ph<{ results?: Cohort[] }>('/cohorts/?limit=200')).results?.filter((c) => !(c as { deleted?: boolean }).deleted) ?? [],
    enabled,
    staleTime: 60_000,
    retry: noRetry4xx,
    refetchInterval: (q) => ((q.state.data as Cohort[] | undefined)?.some((c) => c.is_calculating) ? 60_000 : false),
  })
}

export interface CohortPerson {
  distinct_ids?: string[]
  properties?: Record<string, unknown>
  created_at?: string
}

export function fetchCohortPersons(id: number | string, limit = 50): Promise<CohortPerson[]> {
  return ph<{ results?: CohortPerson[] }>(`/cohorts/${id}/persons/?limit=${limit}`).then((r) => r.results ?? [])
}

/** Person properties worth grounding a persona on, in display order. */
export const PERSONA_PROPS: Array<{ key: string; label: string }> = [
  { key: '$geoip_country_name', label: 'Country' },
  { key: '$geoip_city_name', label: 'City' },
  { key: '$os', label: 'OS' },
  { key: '$browser', label: 'Browser' },
  { key: '$device_type', label: 'Device' },
  { key: '$initial_referring_domain', label: 'Came from' },
  { key: 'role', label: 'Role' },
  { key: 'plan', label: 'Plan' },
  { key: 'company', label: 'Company' },
]

export interface PropertySummary {
  label: string
  key: string
  /** Top values with how many sampled persons had them. */
  top: Array<{ value: string; n: number }>
}

/** Most common values of well-known person properties across a sample (pure). */
export function summarizePersons(persons: CohortPerson[], topN = 3): { sampled: number; props: PropertySummary[] } {
  const props: PropertySummary[] = []
  for (const { key, label } of PERSONA_PROPS) {
    const counts = new Map<string, number>()
    for (const p of persons) {
      const v = p.properties?.[key]
      if (v === undefined || v === null || v === '') continue
      const s = String(v).slice(0, 80)
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    if (!counts.size) continue
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN).map(([value, n]) => ({ value, n }))
    props.push({ key, label, top })
  }
  return { sampled: persons.length, props }
}

/* ─────────── events ─────────── */

export function useEventNames(enabled = true) {
  return useQuery({
    queryKey: ['design', 'ph', 'event-definitions'],
    queryFn: async () => {
      const r = await ph<{ results?: Array<{ name: string; last_seen_at?: string | null }> }>('/event_definitions/?limit=500&ordering=-last_seen_at')
      return (r.results ?? []).map((e) => e.name).filter(Boolean)
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: noRetry4xx,
  })
}

/* ─────────── journey funnel ─────────── */

export interface StageStep {
  stageId: string
  stageName: string
  event: string
}

/** The funnel a journey implies: one step per stage that names an event, in stage order (pure). */
export function journeySteps(j: Pick<Journey, 'stages'>): StageStep[] {
  const out: StageStep[] = []
  for (const s of j.stages) {
    const ev = (s.events ?? []).map((e) => e.trim()).find(Boolean)
    if (ev) out.push({ stageId: s.id, stageName: s.name, event: ev })
  }
  return out
}

export const FUNNEL_RANGES = [
  { id: '-7d', label: '7 days' },
  { id: '-30d', label: '30 days' },
  { id: '-90d', label: '90 days' },
] as const

/** PostHog FunnelsQuery for a journey's steps (pure). */
export function buildJourneyFunnel(steps: StageStep[], ev: AnalyticsEvidence | undefined): Record<string, unknown> {
  const q: Record<string, unknown> = {
    kind: 'FunnelsQuery',
    series: steps.map((s) => ({ kind: 'EventsNode', event: s.event, name: s.event, custom_name: s.stageName })),
    dateRange: { date_from: ev?.range ?? '-30d' },
    funnelsFilter: {
      funnelWindowInterval: ev?.windowDays ?? 14,
      funnelWindowIntervalUnit: 'day',
      funnelVizType: 'steps',
      funnelOrderType: 'ordered',
    },
  }
  if (ev?.cohortId != null && ev.cohortId !== '') q.properties = [{ type: 'cohort', key: 'id', value: Number(ev.cohortId) }]
  return q
}

export interface StageConversion {
  stageId: string
  stageName: string
  event: string
  count: number
  /** Share of the first step that reached this stage (0..1). */
  fromStart: number
  /** Share of the previous step that reached this stage (0..1); 1 on the first step. */
  fromPrevious: number
}

/** PostHog funnel results → per-stage conversion (pure). Results must be one ordered group. */
export function stageConversion(steps: StageStep[], results: unknown): StageConversion[] {
  if (!Array.isArray(results) || !results.length) return []
  const raw = (Array.isArray(results[0]) ? results[0] : results) as Array<{ order?: number; count?: number }>
  const sorted = [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  if (sorted.length !== steps.length) return []
  const top = Number(sorted[0]?.count ?? 0)
  return steps.map((s, i) => {
    const count = Number(sorted[i]?.count ?? 0)
    const prev = i === 0 ? count : Number(sorted[i - 1]?.count ?? 0)
    return {
      ...s,
      count,
      fromStart: top > 0 ? count / top : 0,
      fromPrevious: i === 0 ? 1 : prev > 0 ? count / prev : 0,
    }
  })
}

export function useJourneyFunnel(j: Pick<Journey, 'id' | 'stages' | 'evidence'>, enabled = true) {
  const steps = journeySteps(j)
  const query = steps.length >= 2 ? buildJourneyFunnel(steps, j.evidence) : null
  return useQuery({
    queryKey: ['design', 'ph', 'funnel', j.id, query],
    queryFn: async () => {
      const r = await ph<{ results?: unknown; result?: unknown }>('/query/', { method: 'POST', json: { query } })
      return stageConversion(steps, r.results ?? r.result ?? [])
    },
    enabled: enabled && !!query,
    staleTime: 5 * 60_000,
    retry: noRetry4xx,
  })
}

export function pct(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const v = n * 100
  return `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%`
}
