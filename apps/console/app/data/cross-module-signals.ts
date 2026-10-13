import { useQueries, useQuery } from '@tanstack/react-query'
import {
  airbyte,
  argocd,
  falco,
  gitea,
  lgtm,
  metabase,
  plane,
  posthog,
  trivy,
} from '@adhar/api-clients'
import { useArgocdProject, useGiteaOrg, usePlaneWorkspace } from '@adhar/shell-ui'
import { promRange } from './prom-instant.ts'

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
const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })
const trivyClient = trivy.TrivyClient.auto({ tool: 'trivy' })
const lgtmClient = lgtm.LgtmClient.auto({ tool: 'lgtm' })
const phClient = posthog.PostHogClient.auto({ tool: 'posthog' })
const metabaseClient = metabase.MetabaseClient.auto({ tool: 'metabase' })
const airbyteClient = airbyte.AirbyteClient.auto({ tool: 'airbyte' })
const falcoClient = falco.FalcoClient.auto({ tool: 'falco' })

const REFRESH_MS = 30_000

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

export function useDevelopPRs() {
  const ORG = useGiteaOrg()
  const repos = useQuery({
    queryKey: ['ov', 'gitea', 'repos', ORG],
    queryFn: () => giteaClient.listRepos(ORG),
    staleTime: REFRESH_MS,
  })
  return useQuery({
    queryKey: ['ov', 'gitea', 'prs', ORG, repos.data?.length ?? 0],
    queryFn: async () => {
      if (!repos.data) return []
      const out: Array<gitea.PullRequest & { repo: string }> = []
      for (const r of repos.data) {
        const list = await giteaClient.listPullRequests(ORG, r.name, 'open')
        out.push(...list.map((p) => ({ ...p, repo: r.name })))
      }
      return out
    },
    enabled: !!repos.data?.length,
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
  windowStartMs: number
}

const FLOW_REPO_CAP = 40

export function useGiteaFlow(days = 30) {
  const ORG = useGiteaOrg()
  const repos = useQuery({
    queryKey: ['ov', 'gitea', 'repos', ORG],
    queryFn: () => giteaClient.listRepos(ORG),
    staleTime: REFRESH_MS,
  })
  return useQuery({
    queryKey: ['ov', 'gitea', 'flow', ORG, days, repos.data?.length ?? 0],
    queryFn: async (): Promise<GiteaFlow> => {
      const windowStartMs = Date.now() - days * 86_400_000
      const list = (repos.data ?? []).filter((r) => !r.archived && !r.empty).slice(0, FLOW_REPO_CAP)
      const per = await Promise.all(
        list.map(async (r) => {
          const [prs, commits] = await Promise.all([
            giteaClient.listPullRequests(ORG, r.name, 'closed').catch(() => [] as gitea.PullRequest[]),
            giteaClient.listCommits(ORG, r.name, '', 50).catch(() => [] as gitea.Commit[]),
          ])
          return { repo: r.name, prs, commits }
        }),
      )
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
        windowStartMs,
      }
    },
    enabled: !!repos.data,
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
  return useQuery({
    queryKey: ['ov', 'airbyte', 'connections'],
    queryFn: () => airbyteClient.listConnections(),
    refetchInterval: REFRESH_MS,
  })
}

/* ─────────── Deliver · ArgoCD + Trivy ─────────── */

export function useDeliverApplications() {
  const project = useArgocdProject()
  return useQuery({
    queryKey: ['ov', 'argocd', 'apps', project],
    queryFn: () => argocdClient.listApplications(project),
    refetchInterval: REFRESH_MS,
  })
}

export function useTrivyReports() {
  return useQuery({
    queryKey: ['ov', 'trivy', 'reports'],
    queryFn: () => trivyClient.listReports(),
    refetchInterval: 60_000,
  })
}

/* ─────────── Discover · LGTM + PostHog ─────────── */

export function useDiscoverAlerts() {
  return useQuery({
    queryKey: ['ov', 'lgtm', 'alerts'],
    queryFn: () => lgtmClient.listAlerts(),
    refetchInterval: REFRESH_MS,
  })
}

export function useDiscoverSlos() {
  return useQuery({
    queryKey: ['ov', 'lgtm', 'slos'],
    queryFn: () => lgtmClient.listSlos(),
    refetchInterval: 60_000,
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

export function useFalcoEvents() {
  return useQuery({
    queryKey: ['ov', 'falco', 'events-6h'],
    queryFn: () => falcoClient.listEvents({ sinceMs: 6 * 3600_000 }),
    refetchInterval: REFRESH_MS,
  })
}

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
