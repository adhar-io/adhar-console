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
} from '@adhar-console/api-clients'

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

const PROJECT = 'acme'
const ORG = 'acme'
const REFRESH_MS = 30_000

/* ─────────── Define · Plane ─────────── */

export function useDefineSignals() {
  const projects = useQuery({
    queryKey: ['ov', 'plane', 'projects'],
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
  const repos = useQuery({
    queryKey: ['ov', 'gitea', 'repos'],
    queryFn: () => giteaClient.listRepos(ORG),
    staleTime: REFRESH_MS,
  })
  return useQuery({
    queryKey: ['ov', 'gitea', 'prs', repos.data?.length ?? 0],
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

export function useDevelopRepos() {
  return useQuery({
    queryKey: ['ov', 'gitea', 'repos-summary'],
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
  return useQuery({
    queryKey: ['ov', 'argocd', 'apps'],
    queryFn: () => argocdClient.listApplications(PROJECT),
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

export function useGoldenSignals() {
  const queries = useQueries({
    queries: [
      {
        queryKey: ['ov', 'lgtm', 'metric', 'rps'],
        queryFn: () => lgtmClient.queryMetrics('http_requests_per_second', new Date(Date.now() - 3600_000), new Date(), '1m'),
        refetchInterval: REFRESH_MS,
      },
      {
        queryKey: ['ov', 'lgtm', 'metric', 'errors'],
        queryFn: () => lgtmClient.queryMetrics('http_5xx_rate', new Date(Date.now() - 3600_000), new Date(), '1m'),
        refetchInterval: REFRESH_MS,
      },
      {
        queryKey: ['ov', 'lgtm', 'metric', 'p95'],
        queryFn: () => lgtmClient.queryMetrics('http_request_duration_p95_ms', new Date(Date.now() - 3600_000), new Date(), '1m'),
        refetchInterval: REFRESH_MS,
      },
    ],
  })
  return {
    rps: queries[0],
    errors: queries[1],
    p95: queries[2],
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
