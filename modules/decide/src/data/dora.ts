import { useMemo } from 'react'
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { argocd, gitea, kargo } from '@adhar/api-clients'
import { useGiteaOrg } from '@adhar/shell-ui'
import { type BuildRun, type RawRun, toBuildRun } from './builds-model.ts'
import {
  breakdown,
  type BreakdownRow,
  bucketMs,
  computeKeys,
  type DeployEvent,
  deployRestores,
  envFromNamespace,
  firingIntervals,
  isProd,
  type KeyMetrics,
  type KeySeries,
  keySeries,
  type LeadTimeSample,
  mergeDeploys,
  normalizeEnv,
  projectFromNamespace,
  type RepoCommit,
  type RestoreSample,
} from './dora-model.ts'
import {
  argoEvents,
  type ArgoAppLike,
  changeRefFor,
  type ChangeRef,
  type FreightLike,
  kargoEvents,
  type PromotionLike,
  resolveLeads,
  type StageLike,
} from './dora-sources.ts'
import { client, GVR, isNotInstalled } from './k8s.ts'
import { promRange } from './prom.ts'
import type { DecideScope } from './scope.ts'

/**
 * DORA data hooks — every source the four keys need, read live:
 *
 *   Argo CD    `/api/svc/argocd/api/v1/applications`        sync history
 *   Kargo      `/api/k8s/apis/kargo.akuity.io/v1alpha1/…`    promotions, stages, freight
 *   Tekton     `/api/k8s/apis/tekton.dev/v1/pipelineruns`    builds (commit ↔ image)
 *   Gitea      `/api/svc/gitea/api/v1/repos/<o>/<r>/commits` commit times
 *   Prometheus `/api/svc/prometheus` `ALERTS`                incidents for restore time
 *
 * Each source fails on its own; the page names what is missing rather than
 * filling the gap.
 */

const argoClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })
const kargoClient = kargo.KargoClient.auto({ tool: 'kargo' })
const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

/**
 * DORA and adoption are 7–90-day trends: a deploy landing while the page is
 * open moves them by a rounding error. So these raw sources are read on open
 * and held for five minutes — no timers, and no apiserver watches (Argo
 * rewrites every Application's status on each reconcile, and PipelineRuns
 * update continuously while running; a watch would re-list far more often
 * than the numbers can change).
 */
const STALE = 5 * 60_000
const DAY = 86_400_000

export type SourceState = 'ok' | 'empty' | 'missing' | 'error' | 'loading'

export interface SourceStatus {
  id: string
  label: string
  state: SourceState
  detail: string
}

function status(id: string, label: string, q: UseQueryResult<unknown[]>, what: string): SourceStatus {
  if (q.isLoading) return { id, label, state: 'loading', detail: 'Loading…' }
  if (q.error && !q.data) {
    if (isNotInstalled(q.error)) return { id, label, state: 'missing', detail: `${label} is not installed on this cluster.` }
    return { id, label, state: 'error', detail: `${label} unreachable — ${(q.error as Error).message}` }
  }
  const n = q.data?.length ?? 0
  return n ? { id, label, state: 'ok', detail: `${n} ${what}` } : { id, label, state: 'empty', detail: `No ${what} yet.` }
}

/* ─────────── raw sources (shared cache across pages) ─────────── */

export function useArgoApps() {
  return useQuery({
    queryKey: ['decide', 'argocd', 'apps'],
    queryFn: async () => (await argoClient.listApplications()) as unknown as Array<ArgoAppLike & argocd.Application>,
    staleTime: STALE,
    retry: false,
  })
}

export function usePromotions() {
  return useQuery({
    queryKey: ['decide', 'kargo', 'promotions'],
    queryFn: async () =>
      (await client.listGeneric(undefined, GVR.promotions)).map((p) => kargo.toPromotion(p as unknown as kargo.RawPromotion)) as PromotionLike[],
    staleTime: STALE,
    retry: false,
  })
}

export function useStages() {
  return useQuery({
    queryKey: ['decide', 'kargo', 'stages'],
    queryFn: async () =>
      (await client.listGeneric(undefined, GVR.stages)).map((s): StageLike => ({
        name: s.metadata.name,
        project: s.metadata.namespace ?? '',
        labels: s.metadata.labels,
      })),
    staleTime: STALE,
    retry: false,
  })
}

export function useFreight() {
  return useQuery({
    queryKey: ['decide', 'kargo', 'freight'],
    queryFn: async () => (await kargoClient.listFreight('')) as FreightLike[],
    staleTime: STALE,
    retry: false,
  })
}

export function useBuildRuns() {
  return useQuery({
    queryKey: ['decide', 'tekton', 'pipelineruns'],
    queryFn: async () => (await client.listGeneric(undefined, GVR.pipelineRuns)).map((r) => toBuildRun(r as unknown as RawRun)),
    staleTime: STALE,
    retry: false,
  })
}

/** Newest-first commits for each `org/repo`, two pages (≤100). */
function useRepoCommits(repos: string[]) {
  const qs = useQueries({
    queries: repos.map((repo) => ({
      queryKey: ['decide', 'gitea', 'commits', repo],
      queryFn: async (): Promise<RepoCommit[]> => {
        const [org, name] = repo.split('/')
        const first = await giteaClient.listCommits(org, name, '', 50)
        const second = first.length === 50 ? await giteaClient.listCommits(org, name, '', 50, { page: 2 }).catch(() => []) : []
        return [...first, ...second]
          .map((c) => ({ sha: c.sha.toLowerCase(), at: Date.parse(c.created) }))
          .filter((c) => Number.isFinite(c.at))
      },
      staleTime: 5 * 60_000,
      retry: false,
    })),
  })
  const key = qs.map((q) => q.dataUpdatedAt).join(',')
  return useMemo(() => {
    const map = new Map<string, RepoCommit[]>()
    let failed = 0
    qs.forEach((q, i) => {
      if (q.data) map.set(repos[i], q.data)
      else if (q.error) failed++
    })
    return { map, failed, loading: qs.some((q) => q.isLoading) }
  }, [key, repos.join(',')])
}

/** Critical alert firing intervals over [from, to). */
function useAlertIntervals(from: number, to: number) {
  return useQuery({
    queryKey: ['decide', 'prom', 'alerts', Math.floor(from / 600_000), Math.floor(to / 600_000)],
    queryFn: async () => {
      const step = 300
      const res = await promRange(
        'max by (alertname, namespace, severity) (ALERTS{alertstate="firing", severity=~"critical|page|error"})',
        from,
        to,
        step,
      )
      const realStep = Math.max(step, Math.ceil((to - from) / 1000 / 10_000)) * 1000
      return res.flatMap((s) =>
        firingIntervals(s.values.map(([t, v]) => [t * 1000, Number(v)]), realStep, to).map((iv) => ({ ...iv, metric: s.metric }))
      )
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/* ─────────── the assembled dataset ─────────── */

export interface DoraDataset {
  now: number
  from: number
  to: number
  prevFrom: number
  env: string
  current: KeyMetrics
  previous: KeyMetrics
  series: KeySeries
  bucket: number
  /** In-scope deploys (every env) — throughput views. */
  allDeploys: DeployEvent[]
  /** In-scope deploys to the measured env over the whole fetched span. */
  envDeploys: DeployEvent[]
  leads: LeadTimeSample[]
  restores: RestoreSample[]
  openIncidents: Array<{ app: string; project: string; since: number; label: string; source: 'deploy' | 'alert' }>
  byTeam: BreakdownRow[]
  byProject: BreakdownRow[]
  byApp: BreakdownRow[]
  sources: SourceStatus[]
  quality: {
    deploys: number
    resolved: number
    via: Record<LeadTimeSample['via'], number>
    unresolved: number
    reposFailed: number
    deploySource: { kargo: number; argocd: number }
  }
  runs: BuildRun[]
  loading: boolean
  /** No deploy source answered at all. */
  noSources: boolean
}

export function useDora(scope: DecideScope, envParam?: string): DoraDataset {
  const org = useGiteaOrg()
  const env = normalizeEnv(envParam) || 'prod'
  const days = scope.range.days
  // A minute-stable clock keeps memoised windows from shifting every render.
  const now = Math.floor(Date.now() / 60_000) * 60_000
  const to = now
  const from = now - days * DAY
  const prevFrom = from - days * DAY

  const apps = useArgoApps()
  const promotions = usePromotions()
  const stages = useStages()
  const freight = useFreight()
  const runs = useBuildRuns()
  const alerts = useAlertIntervals(prevFrom, to)

  const base = useMemo(() => {
    const argo = argoEvents(apps.data ?? [], scope.refs)
    const kg = kargoEvents(promotions.data ?? [], stages.data ?? [], freight.data ?? [])
    const merged = mergeDeploys(argo, kg)
    // repo/app name → project, so builds without a project label can be scoped.
    const appProject = new Map<string, string>()
    for (const e of merged) if (e.app && e.project && !appProject.has(e.app)) appProject.set(e.app, e.project)
    const all = merged.filter((e) => scope.matches(e.project) && e.at >= prevFrom)
    const freightById = new Map((freight.data ?? []).map((f) => [f.id, f]))
    const argoRepo = new Map((apps.data ?? []).map((a) => [a.metadata.name, a.spec.source?.repoURL ?? a.spec.sources?.[0]?.repoURL]))
    const envDeploys = all.filter((e) => (env === 'prod' ? isProd(e.env) : e.env === env))
    const refs = new Map<string, ChangeRef>()
    for (const d of envDeploys) {
      const r = changeRefFor(d, { freightById, runs: runs.data ?? [], org, argoRepo: argoRepo.get(d.name) })
      if (r) refs.set(d.id, r)
    }
    const scopedRuns = (runs.data ?? []).filter((r) => {
      if (!scope.inScope) return true
      const p = r.project ?? (r.repo ? appProject.get(r.repo) : undefined)
      return !!p && scope.matches(p)
    })
    return { all, envDeploys, refs, scopedRuns }
  }, [apps.data, promotions.data, stages.data, freight.data, runs.data, scope, env, prevFrom, org])

  const repos = useMemo(() => [...new Set([...base.refs.values()].map((r) => r.repo))].sort().slice(0, 30), [base.refs])
  const commits = useRepoCommits(repos)

  return useMemo((): DoraDataset => {
    const { all, envDeploys, refs } = base
    const leads = resolveLeads(envDeploys, refs, commits.map)
    const fromDeploys = deployRestores(envDeploys)
    const alertRestores: RestoreSample[] = []
    const openAlerts: DoraDataset['openIncidents'] = []
    for (const iv of alerts.data ?? []) {
      const ns = iv.metric.namespace ?? ''
      const project = projectFromNamespace(ns)
      const aEnv = envFromNamespace(ns, project)
      // Restores are about the measured environment; an alert with no project
      // (platform namespaces) only counts in the unscoped view.
      if (project ? !scope.matches(project) || (env === 'prod' ? !isProd(aEnv) : aEnv !== env) : !!scope.inScope) continue
      const label = `${iv.metric.alertname ?? 'alert'}${ns ? ` · ${ns}` : ''}`
      if (iv.open) {
        openAlerts.push({ app: iv.metric.alertname ?? '', project, since: iv.start, label, source: 'alert' })
        continue
      }
      alertRestores.push({
        app: iv.metric.alertname ?? 'alert',
        project,
        env: aEnv,
        start: iv.start,
        end: iv.end,
        hours: (iv.end - iv.start) / 3_600_000,
        source: 'alert',
        label,
      })
    }
    const restores = [...fromDeploys.restores, ...alertRestores].sort((a, b) => b.end - a.end)
    const input = { deploys: envDeploys, leads, restores }
    const bucket = bucketMs(days)
    const teamsOf = (x: { project: string }) => {
      const t = scope.teamsOf(x.project)
      return t.length ? t : ['(no team)']
    }
    const inWin = envDeploys.filter((d) => d.at >= from)
    const via = { 'freight-commit': 0, 'image-tag': 0, 'argo-revision': 0, 'build-start': 0 } as Record<LeadTimeSample['via'], number>
    const okDeploys = inWin.filter((d) => d.outcome === 'succeeded' && !d.rollback)
    for (const d of okDeploys) {
      const r = refs.get(d.id)
      if (r) via[r.via]++
    }
    const resolved = okDeploys.filter((d) => refs.has(d.id)).length
    const sources: SourceStatus[] = [
      status('argocd', 'Argo CD', apps as UseQueryResult<unknown[]>, 'applications'),
      status('kargo', 'Kargo', promotions as UseQueryResult<unknown[]>, 'promotions'),
      status('tekton', 'Tekton', runs as UseQueryResult<unknown[]>, 'pipeline runs'),
      repos.length
        ? {
          id: 'gitea',
          label: 'Gitea',
          state: commits.loading ? 'loading' : commits.failed === repos.length ? 'error' : 'ok',
          detail: commits.failed
            ? `${repos.length - commits.failed} of ${repos.length} repositories readable`
            : `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`,
        }
        : { id: 'gitea', label: 'Gitea', state: 'empty', detail: 'No deploy could be traced to a source repository.' },
      status('prometheus', 'Prometheus alerts', alerts as UseQueryResult<unknown[]>, 'firing intervals'),
    ]
    return {
      now,
      from,
      to,
      prevFrom,
      env,
      current: computeKeys(input, from, to),
      previous: computeKeys(input, prevFrom, from),
      series: keySeries(input, from, to, bucket),
      bucket,
      allDeploys: all,
      envDeploys,
      leads,
      restores,
      openIncidents: [
        ...fromDeploys.open.map((d) => ({ app: d.app, project: d.project, since: d.at, label: `${d.name} ${d.outcome === 'rolled-back' ? 'rolled back' : 'failed'}`, source: 'deploy' as const })),
        ...openAlerts,
      ],
      byTeam: breakdown(input, from, to, teamsOf),
      byProject: breakdown(input, from, to, (x) => [x.project || '(unassigned)']),
      byApp: breakdown(input, from, to, (x) => [`${x.project ? `${x.project}/` : ''}${x.app || '(unknown)'}`]),
      sources,
      quality: {
        deploys: okDeploys.length,
        resolved,
        via,
        unresolved: okDeploys.length - resolved,
        reposFailed: commits.failed,
        deploySource: { kargo: inWin.filter((d) => d.source === 'kargo').length, argocd: inWin.filter((d) => d.source === 'argocd').length },
      },
      runs: base.scopedRuns,
      loading: apps.isLoading || promotions.isLoading,
      noSources: !!apps.error && !!promotions.error && !apps.data && !promotions.data,
    }
  }, [base, commits, alerts.data, alerts.status, apps.status, promotions.status, runs.status, from, days])
}
