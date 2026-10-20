/**
 * DORA four keys — the pure model. No React, no fetch: the data hooks in
 * `dora.ts` turn Argo CD / Kargo / Tekton / Gitea / Prometheus objects into the
 * event shapes below, and everything that is a *number on screen* is computed
 * here, so it is unit-tested once (`dora-model_test.ts`).
 *
 *   Deployment frequency  successful production deploys per day.
 *   Lead time for changes commit authored → that commit running in production,
 *                         per commit (every commit a deploy carried, not just
 *                         its head).
 *   Change failure rate   production deploys that failed or were rolled back
 *                         ÷ production deploys.
 *   Time to restore       a failure's start → the service being restored: a
 *                         failed/rolled-back deploy → the next good deploy of
 *                         the same app+env, and a critical alert firing →
 *                         resolving.
 *
 * Benchmarks are the DORA 2023 State of DevOps performance clusters.
 */

export type Band = 'elite' | 'high' | 'medium' | 'low'

export const BAND_LABEL: Record<Band, string> = { elite: 'Elite', high: 'High', medium: 'Medium', low: 'Low' }
const BAND_SCORE: Record<Band, number> = { elite: 4, high: 3, medium: 2, low: 1 }
const SCORE_BAND: Band[] = ['low', 'low', 'medium', 'high', 'elite']

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Deploys per day → band (elite: on demand, ≥1/day; high: ≥1/week; medium: ≥1/month). */
export function bandDeployFrequency(perDay: number): Band {
  if (perDay >= 1) return 'elite'
  if (perDay >= 1 / 7) return 'high'
  if (perDay >= 1 / 30) return 'medium'
  return 'low'
}

/** Lead time in hours → band (elite < 1 day, high < 1 week, medium < 1 month). */
export function bandLeadTime(hours: number): Band {
  if (hours < 24) return 'elite'
  if (hours < 24 * 7) return 'high'
  if (hours < 24 * 30) return 'medium'
  return 'low'
}

/** Change failure rate (0–1) → band (≤5 %, ≤10 %, ≤15 %). */
export function bandChangeFailure(rate: number): Band {
  if (rate <= 0.05) return 'elite'
  if (rate <= 0.1) return 'high'
  if (rate <= 0.15) return 'medium'
  return 'low'
}

/** Time to restore in hours → band (elite < 1 h, high < 1 day, medium < 1 week). */
export function bandRestore(hours: number): Band {
  if (hours < 1) return 'elite'
  if (hours < 24) return 'high'
  if (hours < 24 * 7) return 'medium'
  return 'low'
}

/** Thresholds as shown in the "how it is computed" copy and chart reference lines. */
export const BENCHMARKS = {
  deployFrequency: { elite: '≥ 1 / day', high: '≥ 1 / week', medium: '≥ 1 / month', low: '< 1 / month' },
  leadTime: { elite: '< 1 day', high: '< 1 week', medium: '< 1 month', low: '≥ 1 month' },
  changeFailure: { elite: '≤ 5 %', high: '≤ 10 %', medium: '≤ 15 %', low: '> 15 %' },
  restore: { elite: '< 1 hour', high: '< 1 day', medium: '< 1 week', low: '≥ 1 week' },
} as const

/** Mean of the present bands, rounded; null when none is present. */
export function overallBand(bands: Array<Band | null | undefined>): Band | null {
  const present = bands.filter((b): b is Band => !!b)
  if (!present.length) return null
  const avg = present.reduce((a, b) => a + BAND_SCORE[b], 0) / present.length
  return SCORE_BAND[Math.round(avg)] ?? 'medium'
}

/* ─────────── environments ─────────── */

const ENV_KEYS = ['dev', 'development', 'sandbox', 'preview', 'qa', 'test', 'uat', 'staging', 'stage', 'stg', 'canary', 'prod', 'production']

/** Canonical env key: `production` → `prod`, `development` → `dev`, `staging`/`stg` → `staging`. */
export function normalizeEnv(env: string | undefined): string {
  const e = (env ?? '').toLowerCase().trim()
  if (!e) return ''
  if (e.startsWith('prod')) return 'prod'
  if (e === 'development') return 'dev'
  if (e === 'stg' || e === 'stage' || e.startsWith('staging')) return 'staging'
  return e
}

export function isProd(env: string | undefined): boolean {
  return normalizeEnv(env) === 'prod'
}

/**
 * The environment a namespace belongs to. Projects run in `<project>-<env>`;
 * without a known project the last dash segment is used when it is a known
 * environment key (so `adhar-system` is no environment at all).
 */
export function envFromNamespace(ns: string | undefined, project?: string): string {
  const n = (ns ?? '').toLowerCase()
  if (!n) return ''
  if (project && n.startsWith(`${project.toLowerCase()}-`)) return normalizeEnv(n.slice(project.length + 1))
  const last = n.split('-').pop() ?? ''
  return ENV_KEYS.includes(last) ? normalizeEnv(last) : ''
}

/** The project of a `<project>-<env>` namespace, when the suffix is a known env key. */
export function projectFromNamespace(ns: string | undefined): string {
  const n = (ns ?? '').toLowerCase()
  const i = n.lastIndexOf('-')
  if (i <= 0) return ''
  return ENV_KEYS.includes(n.slice(i + 1)) ? n.slice(0, i) : ''
}

/** dev → test → prod order (unknown between pre-prod and prod). */
export function envRank(env: string): number {
  const k = normalizeEnv(env)
  if (k === 'dev') return 0
  if (k === 'sandbox' || k === 'preview') return 1
  if (k === 'qa' || k === 'test') return 2
  if (k === 'uat') return 3
  if (k === 'staging') return 4
  if (k === 'canary') return 5
  if (k === 'prod') return 7
  return 6
}

/* ─────────── events ─────────── */

export type DeployOutcome = 'succeeded' | 'failed' | 'rolled-back'

export interface DeployEvent {
  /** Stable id (`<source>:<name>[:<n>]`). */
  id: string
  /** Promotion name or Argo CD app name — what a person would look up. */
  name: string
  app: string
  /** Project slug; '' when it cannot be told. */
  project: string
  /** Normalised environment key; '' when unknown. */
  env: string
  /** When the deploy finished (ms). */
  at: number
  startedAt?: number
  outcome: DeployOutcome
  /** A deploy that put back an earlier revision. */
  rollback?: boolean
  source: 'kargo' | 'argocd'
  /** Revision / commit the deploy carried, when recorded. */
  revision?: string
  freight?: string
  actor?: string
  message?: string
}

export interface LeadTimeSample {
  sha: string
  repo: string
  app: string
  project: string
  committedAt: number
  deployedAt: number
  hours: number
  /** How the commit was tied to the deploy — shown in the data-quality panel. */
  via: 'freight-commit' | 'image-tag' | 'argo-revision' | 'build-start'
  deployId: string
}

export interface RestoreSample {
  app: string
  project: string
  env: string
  start: number
  end: number
  hours: number
  source: 'deploy' | 'alert'
  label: string
}

/* ─────────── statistics ─────────── */

/** Linear-interpolated percentile (p in 0..1); null for an empty set. */
export function percentile(values: number[], p: number): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  if (v.length === 1) return v[0]
  const idx = Math.min(1, Math.max(0, p)) * (v.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return v[lo] + (v[hi] - v[lo]) * (idx - lo)
}

export function median(values: number[]): number | null {
  return percentile(values, 0.5)
}

/* ─────────── deploy history → events ─────────── */

export interface HistoryEntry {
  id: number
  revision?: string
  deployedAt?: string
  deployStartedAt?: string
  initiatedBy?: { username?: string; automated?: boolean }
}

/**
 * Argo CD sync history (one app) → deploy events. A history entry that puts
 * back a revision deployed before its predecessor is a **rollback**: the
 * predecessor is marked `rolled-back` (that change failed in production) and
 * the rollback itself is a deploy flagged `rollback`.
 */
export function historyToDeploys(
  history: HistoryEntry[],
  base: { name: string; app: string; project: string; env: string },
): DeployEvent[] {
  const sorted = [...history].filter((h) => h.deployedAt && Number.isFinite(Date.parse(h.deployedAt))).sort((a, b) => a.id - b.id)
  const out: DeployEvent[] = sorted.map((h) => ({
    id: `argocd:${base.name}:${h.id}`,
    name: base.name,
    app: base.app,
    project: base.project,
    env: base.env,
    at: Date.parse(h.deployedAt!),
    startedAt: h.deployStartedAt ? Date.parse(h.deployStartedAt) : undefined,
    outcome: 'succeeded',
    source: 'argocd',
    revision: h.revision,
    actor: h.initiatedBy?.automated ? 'automated' : h.initiatedBy?.username,
  }))
  for (let i = 2; i < out.length; i++) {
    const rev = out[i].revision
    if (!rev || rev === out[i - 1].revision) continue
    const earlier = out.slice(0, i - 1).some((e) => e.revision === rev)
    if (earlier) {
      out[i].rollback = true
      if (out[i - 1].outcome === 'succeeded') out[i - 1].outcome = 'rolled-back'
    }
  }
  return out
}

/**
 * Kargo is the promotion path for every project chain, and each promotion
 * drives an Argo CD sync of the same app+env — counting both would double
 * every deploy. So for an (project, env, app) that has Kargo promotions,
 * Kargo is the record; Argo CD history counts only where Kargo is absent.
 */
export function mergeDeploys(argo: DeployEvent[], kargo: DeployEvent[]): DeployEvent[] {
  const key = (e: DeployEvent) => `${e.project}|${e.env}|${e.app}`
  const viaKargo = new Set(kargo.map(key))
  return [...kargo, ...argo.filter((e) => !viaKargo.has(key(e)))].sort((a, b) => a.at - b.at)
}

/**
 * Restores from the deploy record: the first failed / rolled-back deploy of an
 * app+env opens an incident; the next successful deploy closes it. An incident
 * still open at the end is not a restore (it is reported as open).
 */
export function deployRestores(deploys: DeployEvent[]): { restores: RestoreSample[]; open: DeployEvent[] } {
  const groups = new Map<string, DeployEvent[]>()
  for (const d of deploys) {
    const k = `${d.project}|${d.env}|${d.app}`
    const list = groups.get(k) ?? []
    list.push(d)
    groups.set(k, list)
  }
  const restores: RestoreSample[] = []
  const open: DeployEvent[] = []
  for (const list of groups.values()) {
    list.sort((a, b) => a.at - b.at)
    let failure: DeployEvent | null = null
    for (const d of list) {
      if (d.outcome !== 'succeeded') {
        failure ??= d
        continue
      }
      if (failure) {
        restores.push({
          app: d.app,
          project: d.project,
          env: d.env,
          start: failure.at,
          end: d.at,
          hours: Math.max(0, d.at - failure.at) / HOUR,
          source: 'deploy',
          label: `${failure.name} ${failure.outcome === 'rolled-back' ? 'rolled back' : 'failed'} → ${d.name}`,
        })
        failure = null
      }
    }
    if (failure) open.push(failure)
  }
  return { restores, open }
}

/**
 * Prometheus `ALERTS` samples (one series) → firing intervals. Samples closer
 * than 1.5 steps belong to one interval; it ends one step after the last
 * sample. An interval whose last sample is the range end is still firing.
 */
export function firingIntervals(
  values: Array<[number, number]>,
  stepMs: number,
  rangeEnd: number,
): Array<{ start: number; end: number; open: boolean }> {
  const ts = values.filter(([, v]) => Number.isFinite(v) && v > 0).map(([t]) => t).sort((a, b) => a - b)
  const out: Array<{ start: number; end: number; open: boolean }> = []
  let start: number | null = null
  let prev = 0
  for (const t of ts) {
    if (start === null) {
      start = t
    } else if (t - prev > stepMs * 1.5) {
      out.push({ start, end: prev + stepMs, open: false })
      start = t
    }
    prev = t
  }
  if (start !== null) out.push({ start, end: prev + stepMs, open: rangeEnd - prev <= stepMs * 1.5 })
  return out
}

/* ─────────── lead time ─────────── */

export interface RepoCommit {
  sha: string
  at: number
}

/** Short-or-long sha equality. */
export function shaMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x))
}

/**
 * The commits a deploy shipped: from its head commit back to (not including)
 * the previous production deploy's head, in a newest-first commit list. When
 * the previous head is not in the list only the head is counted — a guess at
 * the range would invent lead times. Capped at `max`.
 */
export function shippedCommits(
  commits: RepoCommit[],
  head: string,
  prevHead: string | undefined,
  max = 100,
): RepoCommit[] {
  const i = commits.findIndex((c) => shaMatch(c.sha, head))
  if (i < 0) return []
  if (!prevHead) return [commits[i]]
  const j = commits.findIndex((c, k) => k > i && shaMatch(c.sha, prevHead))
  if (j < 0) return [commits[i]]
  return commits.slice(i, Math.min(j, i + max))
}

/* ─────────── aggregation ─────────── */

export interface KeyMetrics {
  deploys: number
  failed: number
  perDay: number
  deployBand: Band | null
  changeFailureRate: number | null
  changeFailureBand: Band | null
  leadP50: number | null
  leadP90: number | null
  leadSamples: number
  leadBand: Band | null
  restoreP50: number | null
  restoreSamples: number
  restoreBand: Band | null
  overall: Band | null
}

export interface KeyInput {
  deploys: DeployEvent[]
  leads: LeadTimeSample[]
  restores: RestoreSample[]
}

const inWindow = (t: number, from: number, to: number) => t >= from && t < to

/** The four keys over [from, to). `deploys` should already be production-only. */
export function computeKeys(input: KeyInput, from: number, to: number): KeyMetrics {
  const days = Math.max(1, (to - from) / DAY)
  const d = input.deploys.filter((e) => inWindow(e.at, from, to))
  const deploys = d.length
  const failed = d.filter((e) => e.outcome !== 'succeeded').length
  const good = deploys - failed
  const perDay = good / days
  const leadHours = input.leads.filter((l) => inWindow(l.deployedAt, from, to)).map((l) => l.hours)
  const restoreHours = input.restores.filter((r) => inWindow(r.end, from, to)).map((r) => r.hours)
  const leadP50 = median(leadHours)
  const restoreP50 = median(restoreHours)
  const cfr = deploys ? failed / deploys : null
  // With no deploy in the window the frequency is a real "0 / day", but the
  // band would be a verdict on a period with nothing to judge — leave it out.
  const deployBand = deploys ? bandDeployFrequency(perDay) : null
  const changeFailureBand = cfr == null ? null : bandChangeFailure(cfr)
  const leadBand = leadP50 == null ? null : bandLeadTime(leadP50)
  const restoreBand = restoreP50 == null ? null : bandRestore(restoreP50)
  return {
    deploys,
    failed,
    perDay,
    deployBand,
    changeFailureRate: cfr,
    changeFailureBand,
    leadP50,
    leadP90: percentile(leadHours, 0.9),
    leadSamples: leadHours.length,
    leadBand,
    restoreP50,
    restoreSamples: restoreHours.length,
    restoreBand,
    overall: overallBand([deployBand, changeFailureBand, leadBand, restoreBand]),
  }
}

/** Bucket width for a range: daily up to 31 days, weekly beyond. */
export function bucketMs(rangeDays: number): number {
  return rangeDays > 31 ? 7 * DAY : DAY
}

/** Bucket starts covering [from, to), aligned to `from`. */
export function buckets(from: number, to: number, width: number): number[] {
  const out: number[] = []
  for (let t = from; t < to; t += width) out.push(t)
  return out
}

export interface KeySeries {
  /** Successful deploys per bucket. */
  deploys: Array<[number, number]>
  /** Failed deploys per bucket. */
  failures: Array<[number, number]>
  /** CFR % per bucket — only buckets with deploys. */
  changeFailure: Array<[number, number]>
  /** Median lead time hours per bucket — only buckets with samples. */
  leadTime: Array<[number, number]>
  /** Median restore hours per bucket — only buckets with samples. */
  restore: Array<[number, number]>
}

export function keySeries(input: KeyInput, from: number, to: number, width: number): KeySeries {
  const starts = buckets(from, to, width)
  const out: KeySeries = { deploys: [], failures: [], changeFailure: [], leadTime: [], restore: [] }
  for (const s of starts) {
    const e = s + width
    const d = input.deploys.filter((x) => inWindow(x.at, s, e))
    const failed = d.filter((x) => x.outcome !== 'succeeded').length
    out.deploys.push([s, d.length - failed])
    out.failures.push([s, failed])
    if (d.length) out.changeFailure.push([s, (failed / d.length) * 100])
    const lt = median(input.leads.filter((l) => inWindow(l.deployedAt, s, e)).map((l) => l.hours))
    if (lt != null) out.leadTime.push([s, lt])
    const rs = median(input.restores.filter((r) => inWindow(r.end, s, e)).map((r) => r.hours))
    if (rs != null) out.restore.push([s, rs])
  }
  return out
}

export interface BreakdownRow extends KeyMetrics {
  key: string
}

/** Four keys per group (team / project / app). A sample with several keys counts in each. */
export function breakdown(
  input: KeyInput,
  from: number,
  to: number,
  keysOf: (x: { app: string; project: string }) => string[],
): BreakdownRow[] {
  const groups = new Map<string, KeyInput>()
  const add = <K extends keyof KeyInput>(kind: K, item: KeyInput[K][number]) => {
    for (const k of keysOf(item)) {
      const g = groups.get(k) ?? { deploys: [], leads: [], restores: [] }
      ;(g[kind] as Array<typeof item>).push(item)
      groups.set(k, g)
    }
  }
  for (const d of input.deploys) add('deploys', d)
  for (const l of input.leads) add('leads', l)
  for (const r of input.restores) add('restores', r)
  return [...groups.entries()]
    .map(([key, g]) => ({ key, ...computeKeys(g, from, to) }))
    .filter((r) => r.deploys || r.leadSamples || r.restoreSamples)
    .sort((a, b) => b.deploys - a.deploys || a.key.localeCompare(b.key))
}

/** Lead-time histogram buckets (hours) for the distribution chart. */
export const LEAD_BINS: Array<{ label: string; max: number }> = [
  { label: '< 1 h', max: 1 },
  { label: '1–6 h', max: 6 },
  { label: '6–24 h', max: 24 },
  { label: '1–3 d', max: 72 },
  { label: '3–7 d', max: 168 },
  { label: '1–4 wk', max: 720 },
  { label: '> 1 mo', max: Infinity },
]

export function histogram(hours: number[], bins = LEAD_BINS): Array<{ label: string; count: number }> {
  const out = bins.map((b) => ({ label: b.label, count: 0 }))
  for (const h of hours) {
    if (!Number.isFinite(h)) continue
    const i = bins.findIndex((b) => h < b.max)
    out[i < 0 ? bins.length - 1 : i].count++
  }
  return out
}

/* ─────────── formatting ─────────── */

export function formatHours(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '—'
  if (hours < 1 / 60) return '< 1 min'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 24) {
    const h = Math.floor(hours)
    const m = Math.round((hours - h) * 60)
    return m && h < 10 ? `${h}h ${m}m` : `${Math.round(hours)}h`
  }
  const d = hours / 24
  return d < 10 ? `${d.toFixed(1)} d` : `${Math.round(d)} d`
}

export function formatPerDay(perDay: number): string {
  if (perDay >= 1) return `${perDay.toFixed(perDay >= 10 ? 0 : 1)} / day`
  if (perDay * 7 >= 1) return `${(perDay * 7).toFixed(1)} / week`
  if (perDay > 0) return `${(perDay * 30).toFixed(1)} / month`
  return '0'
}

export function formatRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(rate < 0.1 && rate > 0 ? 1 : 0)} %`
}
