import { useQuery } from '@tanstack/react-query'
import { argocd, gitea } from '@adhar/api-clients'
import { useGiteaOrg } from '@adhar/shell-ui'
import { mentionsKey, repoFromUrl } from './work-dev-match.ts'

/**
 * Jira-style "Development" panel for a work item: Gitea pull requests,
 * branches and commits whose title / name / message carries the item's key
 * (`CON-42`), and — for merged PRs — which Argo CD applications already run
 * the merge commit.
 *
 * Costs (Gitea is not behind Plane's shared rate limit, but stays polite):
 *   • PRs: ONE `GET /repos/issues/search?type=pulls&q=<KEY>` over the org;
 *   • branches + commits: only on request ("Scan repositories"), over the
 *     eight most recently updated repos plus every repo a PR was found in;
 *   • deployments: ONE Argo CD app list, then one Gitea compare per
 *     (merged PR × app that deploys that repo).
 * An Argo app whose source is a separate GitOps repo cannot be tied to an
 * application commit from here — the panel says so and links to Deliver.
 */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })
const argoClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

export { mentionsKey, repoFromUrl } from './work-dev-match.ts'

export interface DevPr {
  repo: string
  number: number
  title: string
  state: 'open' | 'closed'
  merged: boolean
  mergedAt?: string | null
  url: string
  author?: string
  updatedAt?: string
}

export interface DevBranch {
  repo: string
  name: string
  sha: string
  updatedAt?: string
}

export interface DevCommit {
  repo: string
  sha: string
  message: string
  author?: string
  created?: string
}

interface RawSearchIssue {
  number: number
  title: string
  body?: string
  state: 'open' | 'closed'
  html_url: string
  updated_at?: string
  user?: { login?: string }
  repository?: { name?: string; owner?: string; full_name?: string }
  pull_request?: { merged?: boolean; merged_at?: string | null; html_url?: string } | null
}

async function giteaGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/svc/gitea${path}`, { credentials: 'include', headers: { accept: 'application/json' } })
  if (!res.ok) {
    let detail = ''
    try {
      const b = (await res.json()) as { error?: string; message?: string }
      detail = b.error === 'tool_not_configured' ? 'Gitea is not connected to this console.' : b.message ?? b.error ?? ''
    } catch { /* not JSON */ }
    throw Object.assign(new Error(detail || `Gitea answered ${res.status}`), { status: res.status })
  }
  return (await res.json()) as T
}

/** Pull requests in the org that mention the key. */
export function usePullRequestsFor(key: string | undefined) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['define-dev', 'prs', org, key],
    enabled: !!key && !!org,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<DevPr[]> => {
      const qs = new URLSearchParams({ q: key!, type: 'pulls', state: 'all', owner: org, limit: '30' })
      const rows = await giteaGet<RawSearchIssue[]>(`/api/v1/repos/issues/search?${qs}`)
      return rows
        .filter((r) => mentionsKey(`${r.title}\n${r.body ?? ''}`, key!))
        .map((r) => ({
          repo: r.repository?.name ?? '',
          number: r.number,
          title: r.title,
          state: r.state,
          merged: !!r.pull_request?.merged,
          mergedAt: r.pull_request?.merged_at ?? null,
          url: r.pull_request?.html_url ?? r.html_url,
          author: r.user?.login,
          updatedAt: r.updated_at,
        }))
    },
  })
}

/** Branches and commits mentioning the key, across recent repos (on demand). */
export function useBranchesAndCommitsFor(key: string | undefined, extraRepos: string[], enabled: boolean) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['define-dev', 'scan', org, key, [...extraRepos].sort().join(',')],
    enabled: enabled && !!key && !!org,
    staleTime: 120_000,
    retry: false,
    queryFn: async () => {
      const repos = await giteaClient.listRepos(org)
      const recent = [...repos].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')).slice(0, 8).map((r) => r.name)
      const scan = [...new Set([...extraRepos.filter(Boolean), ...recent])]
      const branches: DevBranch[] = []
      const commits: DevCommit[] = []
      await Promise.all(scan.map(async (repo) => {
        const [bs, cs] = await Promise.all([
          giteaClient.listBranches(org, repo).catch(() => []),
          giteaClient.listCommits(org, repo, '', 40).catch(() => []),
        ])
        for (const b of bs) if (mentionsKey(b.name, key!)) branches.push({ repo, name: b.name, sha: b.commit.id, updatedAt: b.commit.timestamp })
        for (const c of cs) if (mentionsKey(c.message, key!)) commits.push({ repo, sha: c.sha, message: c.message.split('\n')[0], author: c.author?.login, created: c.created })
      }))
      commits.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))
      return { branches, commits, scanned: scan }
    },
  })
}

export interface DevDeployment {
  pr: number
  repo: string
  app: string
  namespace: string
  cluster: string
  health: string
  sync: string
  /** true = the app's deployed revision contains the merge commit. */
  deployed: boolean | 'unknown'
}

/**
 * For merged PRs: which Argo CD apps deploy that repo and whether their synced
 * revision contains the PR's merge commit. Apps sourced from another repo
 * (GitOps) are reported in `indirect` — the console can't tie them to the PR.
 */
export function useDeploymentsFor(prs: DevPr[] | undefined) {
  const org = useGiteaOrg()
  const merged = (prs ?? []).filter((p) => p.merged)
  return useQuery({
    queryKey: ['define-dev', 'deploy', org, merged.map((p) => `${p.repo}#${p.number}`).join(',')],
    enabled: merged.length > 0,
    staleTime: 120_000,
    retry: false,
    queryFn: async () => {
      const apps = await argoClient.listApplications()
      const out: DevDeployment[] = []
      let indirect = 0
      for (const pr of merged) {
        const detail = await giteaGet<{ merge_commit_sha?: string | null }>(`/api/v1/repos/${encodeURIComponent(org)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`).catch(() => ({ merge_commit_sha: null }))
        const sha = detail.merge_commit_sha
        const deploying = apps.filter((a) =>
          [a.spec.source, ...(a.spec.sources ?? [])].some((s) => {
            const r = repoFromUrl(s?.repoURL)
            return r && r.repo === pr.repo.toLowerCase() && r.owner === org.toLowerCase()
          })
        )
        if (!deploying.length) indirect++
        for (const a of deploying) {
          let deployed: boolean | 'unknown' = 'unknown'
          const rev = a.status.sync.revision
          if (sha && rev) {
            if (rev === sha) deployed = true
            else {
              // What the merge commit has that the deployed revision lacks — nothing means it's in.
              const cmp = await giteaClient.compare(org, pr.repo, rev, sha).catch(() => undefined)
              deployed = cmp ? cmp.total_commits === 0 : 'unknown'
            }
          }
          out.push({
            pr: pr.number,
            repo: pr.repo,
            app: a.metadata.name,
            namespace: a.spec.destination.namespace,
            cluster: a.spec.destination.name ?? a.spec.destination.server,
            health: a.status.health.status,
            sync: a.status.sync.status,
            deployed,
          })
        }
      }
      return { deployments: out, prsWithoutDirectApp: indirect }
    },
  })
}

/** Console link to a PR in Develop. */
export const prHref = (repo: string, n: number) => `/develop?section=prs&pr=${encodeURIComponent(`${repo}/${n}`)}`
/** Console link to a commit in Develop. */
export const commitHref = (repo: string, sha: string) => `/develop?section=commits&repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}`
/** Console link to a branch's history in Develop. */
export const branchHref = (repo: string, branch: string) => `/develop?section=commits&repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`
