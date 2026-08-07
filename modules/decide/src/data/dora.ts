import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { argocd } from '@adhar-console/api-clients'

/**
 * DORA metrics — REAL, derived from ArgoCD Application deploy history.
 *
 * Source: `/api/svc/argocd/api/v1/applications` (through the console BFF proxy,
 * service-authenticated by the server). Each Application carries:
 *   • `status.history[]`      — real deployment events { id, revision, deployedAt }
 *   • `status.operationState` — the latest sync operation { phase, … }
 *   • `status.health.status`  — current health (Healthy / Degraded / …)
 *
 * What ArgoCD can and cannot tell us (NO fabricated numbers):
 *   • Deploy frequency   → FULLY DERIVED by bucketing `history[].deployedAt`.
 *   • Change-failure rate→ DERIVED (coarse) from the latest `operationState`
 *                          phase per app (`Failed` ⇒ a failed deploy).
 *   • Lead time          → NOT DERIVABLE — ArgoCD records deploy time, not the
 *                          source-commit time. Reported as `null` ("needs a
 *                          commit source / Four Keys") rather than invented.
 *   • MTTR               → NOT DERIVABLE from a point-in-time snapshot (no
 *                          degraded→healthy transition log). Reported as
 *                          `null` ("requires an incident source").
 *
 * Tier classification uses the standard DORA "four keys" benchmarks, applied to
 * the REAL computed values. Real `useQuery`: loading + error surfaced.
 */

export type DoraTier = 'Elite' | 'High' | 'Medium' | 'Low'

export type DoraWindow = 30 | 90

export interface ServiceDora {
  /** ArgoCD Application name. */
  service: string
  /** ArgoCD project. */
  project: string
  /** Deploys per week (derived from the daily deploy series). */
  deployFrequency: number
  /** Total deploys across the window. */
  deploysWindow: number
  /** Change-failure rate as a fraction 0–1, or null if no operations seen. */
  changeFailureRate: number | null
  /** Lead time for changes — null: not derivable from ArgoCD. */
  leadTimeHours: number | null
  /** Mean time to restore — null: not derivable from ArgoCD. */
  mttrHours: number | null
  tier: DoraTier
  /** Per-metric tiers; null where the metric can't be derived. */
  tiers: {
    deployFrequency: DoraTier
    changeFailureRate: DoraTier | null
    leadTime: DoraTier | null
    mttr: DoraTier | null
  }
  /** Daily deploy counts over the window (oldest → newest). */
  deployTrend: number[]
}

export interface DoraMetrics {
  services: ServiceDora[]
  /** Aggregate "All services" summary row. */
  aggregate: ServiceDora
  windowDays: DoraWindow
  /** Metrics that ArgoCD cannot supply — surfaced so the UI can label them. */
  unavailable: { leadTime: string; mttr: string }
}

/* ── ArgoCD wire types (superset of the typed client, incl. history) ──── */

interface ArgoHistory {
  id?: number
  revision?: string
  deployedAt?: string
}

interface ArgoApp {
  metadata?: { name?: string; namespace?: string }
  spec?: { project?: string }
  status?: {
    history?: ArgoHistory[]
    operationState?: { phase?: string; finishedAt?: string }
    health?: { status?: string }
    sync?: { status?: string; revision?: string }
  }
}

const argoClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

async function listApps(): Promise<ArgoApp[]> {
  // The typed client returns the raw `items` untouched (no zod strip), so
  // `status.history` is present at runtime; widen the type to read it.
  const apps = (await argoClient.listApplications()) as unknown as ArgoApp[]
  return apps ?? []
}

/* ── DORA tier thresholds (Four Keys benchmark) ───────────────────────── */

const HOURS_PER_DAY = 24
const HOURS_PER_WEEK = 24 * 7
const HOURS_PER_MONTH = 24 * 30

const TIER_SCORE: Record<DoraTier, number> = { Elite: 4, High: 3, Medium: 2, Low: 1 }
const SCORE_TIER: DoraTier[] = ['Low', 'Low', 'Medium', 'High', 'Elite']

/** Deploy frequency in deploys/day → tier. */
export function tierForDeployFrequency(perDay: number): DoraTier {
  if (perDay >= 1) return 'Elite' // on-demand, multiple per day
  if (perDay >= 1 / 7) return 'High' // ≥ weekly
  if (perDay >= 1 / 30) return 'Medium' // ≥ monthly
  return 'Low'
}

/** Lead time for changes in hours → tier. */
export function tierForLeadTime(hours: number): DoraTier {
  if (hours < HOURS_PER_DAY) return 'Elite' // < 1 day
  if (hours < HOURS_PER_WEEK) return 'High' // < 1 week
  if (hours < HOURS_PER_MONTH) return 'Medium' // < 1 month
  return 'Low'
}

/** Change-failure rate as a fraction → tier. */
export function tierForChangeFailureRate(cfr: number): DoraTier {
  if (cfr <= 0.05) return 'Elite'
  if (cfr <= 0.1) return 'High'
  if (cfr <= 0.15) return 'Medium'
  return 'Low'
}

/** Mean time to restore in hours → tier. */
export function tierForMttr(hours: number): DoraTier {
  if (hours < 1) return 'Elite' // < 1 hour
  if (hours < HOURS_PER_DAY) return 'High' // < 1 day
  if (hours < HOURS_PER_WEEK) return 'Medium' // < 1 week
  return 'Low'
}

/** Overall tier from the derivable metrics only (null tiers are ignored). */
function overallTier(tiers: ServiceDora['tiers']): DoraTier {
  const present = [tiers.deployFrequency, tiers.changeFailureRate, tiers.leadTime, tiers.mttr].filter(
    (t): t is DoraTier => t != null,
  )
  if (present.length === 0) return 'Medium'
  const avg = present.reduce((a, t) => a + TIER_SCORE[t], 0) / present.length
  return SCORE_TIER[Math.round(avg)] ?? 'Medium'
}

/* ── builders (from real ArgoCD data) ─────────────────────────────────── */

/** Bucket real deploy events into `windowDays` daily counts (oldest → newest). */
function deployBuckets(history: ArgoHistory[], windowDays: number, now: number): number[] {
  const buckets = new Array(windowDays).fill(0)
  const dayMs = 24 * 60 * 60 * 1000
  for (const h of history) {
    if (!h.deployedAt) continue
    const t = new Date(h.deployedAt).getTime()
    if (!Number.isFinite(t)) continue
    const ageDays = Math.floor((now - t) / dayMs)
    if (ageDays < 0 || ageDays >= windowDays) continue
    // index 0 = oldest day in the window, windowDays-1 = today
    buckets[windowDays - 1 - ageDays] += 1
  }
  return buckets
}

function buildService(app: ArgoApp, windowDays: DoraWindow, now: number): ServiceDora {
  const history = app.status?.history ?? []
  const deployTrend = deployBuckets(history, windowDays, now)
  const deploysWindow = deployTrend.reduce((a, v) => a + v, 0)
  const deployFrequency = Number(((deploysWindow / windowDays) * 7).toFixed(1))

  // Change-failure rate: real, from the latest sync operation phase. One
  // observed operation per app ⇒ 0 or 1; aggregated across apps this yields a
  // real failure proportion.
  const phase = app.status?.operationState?.phase
  const changeFailureRate = phase ? (phase === 'Failed' ? 1 : 0) : null

  const tiers = {
    deployFrequency: tierForDeployFrequency(deploysWindow / windowDays),
    changeFailureRate: changeFailureRate == null ? null : tierForChangeFailureRate(changeFailureRate),
    leadTime: null,
    mttr: null,
  }

  return {
    service: app.metadata?.name ?? 'unknown',
    project: app.spec?.project ?? '—',
    deployFrequency,
    deploysWindow,
    changeFailureRate,
    leadTimeHours: null,
    mttrHours: null,
    tier: overallTier(tiers),
    tiers,
    deployTrend,
  }
}

function buildAggregate(
  services: ServiceDora[],
  apps: ArgoApp[],
  windowDays: DoraWindow,
): ServiceDora {
  const deployTrend = new Array(windowDays).fill(0)
  for (const s of services) {
    for (let i = 0; i < windowDays; i++) deployTrend[i] += s.deployTrend[i] ?? 0
  }
  const deploysWindow = deployTrend.reduce((a, v) => a + v, 0)
  const deployFrequency = Number(((deploysWindow / windowDays) * 7).toFixed(1))

  // Aggregate CFR: failed operations / total observed operations (real).
  const withOps = apps.filter((a) => a.status?.operationState?.phase)
  const failed = withOps.filter((a) => a.status?.operationState?.phase === 'Failed').length
  const changeFailureRate = withOps.length
    ? Number((failed / withOps.length).toFixed(4))
    : null

  const tiers = {
    deployFrequency: tierForDeployFrequency(deploysWindow / windowDays),
    changeFailureRate: changeFailureRate == null ? null : tierForChangeFailureRate(changeFailureRate),
    leadTime: null,
    mttr: null,
  }

  return {
    service: 'All services',
    project: 'Platform-wide',
    deployFrequency,
    deploysWindow,
    changeFailureRate,
    leadTimeHours: null,
    mttrHours: null,
    tier: overallTier(tiers),
    tiers,
    deployTrend,
  }
}

function buildDoraMetrics(apps: ArgoApp[], windowDays: DoraWindow): DoraMetrics {
  const now = Date.now()
  const services = apps
    .map((a) => buildService(a, windowDays, now))
    .sort((a, b) => b.deploysWindow - a.deploysWindow)
  return {
    services,
    aggregate: buildAggregate(services, apps, windowDays),
    windowDays,
    unavailable: {
      leadTime: 'needs a commit source (Four Keys)',
      mttr: 'requires an incident source',
    },
  }
}

/**
 * Per-service DORA metrics + a platform-wide aggregate over a 30- or 90-day
 * window, derived from real ArgoCD deploy history. Real `useQuery`: loading and
 * error are surfaced. Lead time & MTTR are reported as `null` (not derivable
 * from ArgoCD) rather than fabricated.
 */
export function useDoraMetrics(windowDays: DoraWindow = 30): UseQueryResult<DoraMetrics> {
  return useQuery({
    queryKey: ['argocd', 'dora', windowDays],
    queryFn: async () => buildDoraMetrics(await listApps(), windowDays),
    staleTime: 30_000,
    retry: false,
  })
}

/* ── formatting helpers ───────────────────────────────────────────────── */

export function formatLeadTime(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 24) {
    const h = Math.floor(hours)
    const m = Math.round((hours - h) * 60)
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const days = Math.floor(hours / 24)
  const h = Math.round(hours - days * 24)
  return h ? `${days}d ${h}h` : `${days}d`
}

export function formatMttr(hours: number): string {
  return formatLeadTime(hours)
}

export function formatDeployFreq(perWeek: number): string {
  if (perWeek >= 7) return `${(perWeek / 7).toFixed(1)}/day`
  if (perWeek >= 1) return `${perWeek.toFixed(1)}/wk`
  return `${(perWeek * 4.3).toFixed(1)}/mo`
}
