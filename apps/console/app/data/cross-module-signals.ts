import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  airbyte,
  gitea,
  lgtm,
  metabase,
  plane,
  posthog,
  trivy,
} from '@adhar/api-clients'
import { docStore, useArgocdProject, useGiteaOrg, usePlaneWorkspace } from '@adhar/shell-ui'
import { promRange } from './prom-instant.ts'
import { useArgoApplications } from './argo-apps.ts'

/**
 * Cross-module signal hooks for the Overview page.
 *
 * Each module owns its own data layer (under `modules/<x>/src/data/<x>.ts`)
 * but those are sealed inside Module Federation bundles — the host can't
 * import them. We instead instantiate the same clients here (same `tool`
 * names, so they hit the same BFF proxies) and read them via TanStack Query.
 * Same real data, no MF hop — no stubs.
 */

/* ─────────── client singletons (real, via the BFF tool proxies) ─────────── */

const planeClient = plane.PlaneClient.auto({ tool: 'plane' })
const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })
const trivyClient = trivy.TrivyClient.auto({ tool: 'trivy' })
const lgtmClient = lgtm.LgtmClient.auto({ tool: 'lgtm' })
const phClient = posthog.PostHogClient.auto({ tool: 'posthog' })
const metabaseClient = metabase.MetabaseClient.auto({ tool: 'metabase' })
const airbyteClient = airbyte.AirbyteClient.auto({ tool: 'airbyte' })

/** Metrics and tool REST with no push source: the poll floor. */
const REFRESH_MS = 60_000
/** Sources that change on a schedule of their own (scans, syncs). */
const SLOW_MS = 5 * 60_000

/* ─────────── Define · Plane ─────────── */

export function useDefineSignals() {
  // Plane workspace slug comes from `/api/config.planeWorkspace` — never a
  // hardcoded company.
  const PROJECT = usePlaneWorkspace()
  const projects = useQuery({
    queryKey: ['ov', 'plane', 'projects', PROJECT],
    queryFn: () => planeClient.listProjects(PROJECT),
    staleTime: REFRESH_MS,
  })
  const issues = useQuery({
    queryKey: ['ov', 'plane', 'issues', projects.data?.[0]?.id],
    queryFn: () => planeClient.listIssues(PROJECT, projects.data![0].id),
    enabled: !!projects.data?.[0]?.id,
    staleTime: REFRESH_MS,
  })
  const cycles = useQuery({
    queryKey: ['ov', 'plane', 'cycles', projects.data?.[0]?.id],
    queryFn: () => planeClient.listCycles(PROJECT, projects.data![0].id),
    enabled: !!projects.data?.[0]?.id,
    staleTime: REFRESH_MS,
  })
  return { projects, issues, cycles }
}

/* ─────────── Develop · Gitea + Airbyte ─────────── */

/**
 * Whether a repository takes pull requests. Gitea answers 404 for the PR list
 * of a mirror or a repo with pull requests turned off — the platform's own
 * `adhar` mirror is one — and a single 404 used to fail the whole Develop
 * widget as "Gitea unreachable".
 */
export function takesPullRequests(r: Pick<gitea.Repo, 'mirror' | 'archived' | 'empty' | 'has_pull_requests'>): boolean {
  return !r.mirror && !r.archived && !r.empty && r.has_pull_requests !== false
}

const PR_SCAN_CONCURRENCY = 8

export function useDevelopPRs() {
  const ORG = useGiteaOrg()
  // Same key as useDevelopRepos, so the widget reads the repo list once.
  const repos = useQuery({
    queryKey: ['ov', 'gitea', 'repos-summary', ORG],
    queryFn: () => giteaClient.listRepos(ORG),
    staleTime: REFRESH_MS,
  })
  const targets = (repos.data ?? []).filter(takesPullRequests)
  return useQuery({
    queryKey: ['ov', 'gitea', 'prs', ORG, targets.map((r) => r.name).join(',')],
    queryFn: async () => {
      const out: Array<gitea.PullRequest & { repo: string }> = []
      const failures: unknown[] = []
      // In parallel (capped), and one unreadable repo does not sink the rest.
      for (let i = 0; i < targets.length; i += PR_SCAN_CONCURRENCY) {
        const batch = await Promise.all(
          targets.slice(i, i + PR_SCAN_CONCURRENCY).map((r) =>
            giteaClient.listPullRequests(ORG, r.name, 'open').then(
              (list) => list.map((p) => ({ ...p, repo: r.name })),
              (err) => {
                failures.push(err)
                return []
              },
            )
          ),
        )
        for (const b of batch) out.push(...b)
      }
      // Every repo failing means Gitea itself is the problem.
      if (targets.length > 0 && failures.length === targets.length) {
        throw failures[0] instanceof Error ? failures[0] : new Error('Gitea unreachable')
      }
      return out
    },
    enabled: repos.isSuccess,
    staleTime: REFRESH_MS,
  })
}

/**
 * Delivery flow from Gitea: pull requests closed and commits made across the
 * org's repositories within `days`. Feeds PR throughput, engineering velocity
 * and team activity — real merge times and authors, not estimates.
 *
 * Gitea has no org-wide PR or commit feed, so this is one request per repo
 * (in parallel, capped) for the newest closed PRs and the newest commits on
 * each default branch. Very busy repos may have older activity beyond that
 * page; the panels describe a recent window, so that is the right trade.
 */
export interface GiteaFlow {
  merged: Array<gitea.PullRequest & { repo: string }>
  closedUnmerged: number
  commits: Array<gitea.Commit & { repo: string }>
  repos: number
  /** Repos whose PRs or commits could not be read — the totals exclude them. */
  unreadableRepos: number
  windowStartMs: number
}

const FLOW_REPO_CAP = 40

export function useGiteaFlow(days = 30) {
  const ORG = useGiteaOrg()
  // The repo list is read inside the same query (not a separate, gating
  // `enabled` query): a disabled query has no error state, so an unreachable
  // Gitea used to surface as "no activity in the last 30 days".
  return useQuery({
    queryKey: ['ov', 'gitea', 'flow', ORG, days],
    queryFn: async (): Promise<GiteaFlow> => {
      const windowStartMs = Date.now() - days * 86_400_000
      const repos = await giteaClient.listRepos(ORG)
      const list = repos.filter((r) => !r.archived && !r.empty).slice(0, FLOW_REPO_CAP)
      // A repo whose reads fail is counted, not silently treated as "no
      // activity". If every repo fails, Gitea itself is the problem — throw so
      // the panels show "Gitea unreachable" instead of an empty week.
      const failures: unknown[] = []
      const per = await Promise.all(
        list.map(async (r) => {
          const [prs, commits] = await Promise.all([
            takesPullRequests(r)
              ? giteaClient.listPullRequests(ORG, r.name, 'closed').catch((err) => {
                failures.push(err)
                return null
              })
              : Promise.resolve([]),
            giteaClient.listCommits(ORG, r.name, '', 50).catch((err) => {
              failures.push(err)
              return null
            }),
          ])
          return { repo: r.name, prs: prs ?? [], commits: commits ?? [], failed: prs === null || commits === null }
        }),
      )
      const unreadableRepos = per.filter((x) => x.failed).length
      if (list.length > 0 && unreadableRepos === list.length) {
        throw failures[0] instanceof Error ? failures[0] : new Error('Gitea unreachable')
      }
      const inWindow = (iso?: string | null) => !!iso && Date.parse(iso) >= windowStartMs
      return {
        merged: per.flatMap((x) =>
          x.prs.filter((p) => p.merged && inWindow(p.merged_at)).map((p) => ({ ...p, repo: x.repo })),
        ),
        closedUnmerged: per.reduce(
          (n, x) => n + x.prs.filter((p) => !p.merged && inWindow(p.closed_at)).length,
          0,
        ),
        commits: per.flatMap((x) => x.commits.filter((c) => inWindow(c.created)).map((c) => ({ ...c, repo: x.repo }))),
        repos: list.length,
        unreadableRepos,
        windowStartMs,
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useDevelopRepos() {
  const ORG = useGiteaOrg()
  return useQuery({
    queryKey: ['ov', 'gitea', 'repos-summary', ORG],
    queryFn: () => giteaClient.listRepos(ORG),
    staleTime: REFRESH_MS,
  })
}

export function useAirbyteConnections() {
  // Connection config and sync schedules (hourly at best): no timer faster
  // than the syncs themselves.
  return useQuery({
    queryKey: ['ov', 'airbyte', 'connections'],
    queryFn: () => airbyteClient.listConnections(),
    staleTime: 2 * 60_000,
    refetchInterval: SLOW_MS,
  })
}

/* ─────────── Deliver · ArgoCD + Trivy ─────────── */

/**
 * The project's Argo CD applications: the one shared, watch-driven app list
 * (argo-apps.ts) filtered here — not a second, per-project list on a timer.
 */
export function useDeliverApplications() {
  const project = useArgocdProject()
  const q = useArgoApplications()
  const data = useMemo(
    () => (project && q.data ? q.data.filter((a) => a.spec.project === project) : q.data),
    [q.data, project],
  )
  return { ...q, data }
}

/**
 * Trivy reports are CRs, but large ones (a vulnerability list per image) and
 * they only change when a scan finishes — a watch would stream every report
 * body to the browser. A slow timer is the cheaper honest option.
 */
export function useTrivyReports() {
  return useQuery({
    queryKey: ['ov', 'trivy', 'reports'],
    queryFn: () => trivyClient.listReports(),
    staleTime: 2 * 60_000,
    refetchInterval: SLOW_MS,
  })
}

/* ─────────── Discover · LGTM + PostHog ─────────── */

/**
 * Firing alerts. Prometheus re-evaluates every rule (and so changes each
 * alert's `value`) on every cycle, so server-side change detection would fire
 * every time — a plain poll at the floor is the cheapest honest refresh.
 */
export function useDiscoverAlerts() {
  return useQuery({
    queryKey: ['ov', 'lgtm', 'alerts'],
    queryFn: () => lgtmClient.listAlerts(),
    staleTime: 30_000,
    refetchInterval: REFRESH_MS,
  })
}

/**
 * SLO definitions as Discover stores them: documents of kind `discover.slo`
 * in the console document store (see modules/discover/src/data/slo-api.ts).
 * `lgtmClient.listSlos()` is hardwired to `[]` (no Pyrra/Sloth proxy), so it
 * would claim "no SLOs" on a workspace that has some.
 *
 * Only the definitions are read here — burn rates and budgets are evaluated
 * live in Discover → SLOs from the PromQL each definition generates, and the
 * Overview does not re-derive (or guess) them.
 */
export const SLO_COLLECTION = 'discover.slo'

export interface OverviewSloDef {
  id: string
  name: string
  service: string
  /** Percent, e.g. 99.9 */
  objective: number
  windowDays: number
}

export function useDiscoverSlos() {
  return useQuery({
    queryKey: ['ov', 'slo', 'defs'],
    queryFn: async (): Promise<OverviewSloDef[]> =>
      (await docStore.list<Partial<OverviewSloDef>>(SLO_COLLECTION)).map((d) => ({
        id: d.id,
        name: d.data.name ?? d.id,
        service: d.data.service ?? '',
        objective: Number(d.data.objective),
        windowDays: Number(d.data.windowDays),
      })),
    staleTime: 60_000,
    retry: false,
  })
}

/**
 * Mesh-wide golden signals from Cilium Hubble's L7 metrics — the platform's
 * service mesh is Cilium, so request rate, 5xx share and p95 come from the
 * Envoy-observed HTTP flows Hubble exports to Prometheus.
 *
 * `rps` / `errors` / `p95` are cluster totals (one series each).
 * `errorsByWorkload` breaks the 5xx share down by destination workload; Hubble
 * only carries those labels when its `httpV2` metric is configured with
 * `labelsContext=destination_namespace,destination_workload`, and without them
 * that query returns a single unlabelled series.
 */
const HUBBLE_BY = 'destination_namespace, destination_workload'
export const GOLDEN_QUERIES = {
  rps: 'sum(rate(hubble_http_requests_total[5m]))',
  errors:
    '100 * sum(rate(hubble_http_responses_total{status=~"5.."}[5m])) / sum(rate(hubble_http_responses_total[5m]))',
  p95: '1000 * histogram_quantile(0.95, sum by (le) (rate(hubble_http_request_duration_seconds_bucket[5m])))',
  errorsByWorkload:
    `100 * sum by (${HUBBLE_BY}) (rate(hubble_http_responses_total{status=~"5.."}[5m]))` +
    ` / sum by (${HUBBLE_BY}) (rate(hubble_http_responses_total[5m]))`,
} as const

export function useGoldenSignals() {
  const range = (q: string) => () => promRange(q, 3_600_000, 60)
  const queries = useQueries({
    queries: (['rps', 'errors', 'p95', 'errorsByWorkload'] as const).map((k) => ({
      queryKey: ['ov', 'hubble', 'golden', k],
      queryFn: range(GOLDEN_QUERIES[k]),
      // 1h window at 60s steps: a new point exists once a minute.
      staleTime: 30_000,
      refetchInterval: REFRESH_MS,
      retry: false,
    })),
  })
  return {
    rps: queries[0],
    errors: queries[1],
    p95: queries[2],
    errorsByWorkload: queries[3],
  }
}

export function usePostHogActivity() {
  return useQuery({
    queryKey: ['ov', 'posthog', 'events-24h'],
    queryFn: () => phClient.listEvents({ sinceMs: 24 * 3600_000 }),
    staleTime: 60_000,
  })
}

// Runtime security on the Overview reads Falco's Prometheus metrics
// (`useFalcoMetrics` in overview-metrics.ts). There is deliberately no
// `/api/v1/falco/events` hook here: the BFF only proxies that path when
// FALCO_URL is set, so it read as "no events" on every default install.

/* ─────────── Decide · Metabase ─────────── */

export function useBusinessKpis() {
  return useQuery({
    queryKey: ['ov', 'metabase', 'questions'],
    queryFn: () => metabaseClient.listQuestions(),
    staleTime: 60_000,
  })
}

export function useBiDashboards() {
  return useQuery({
    queryKey: ['ov', 'metabase', 'dashboards'],
    queryFn: () => metabaseClient.listDashboards(),
    staleTime: 60_000,
  })
}
