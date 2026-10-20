import { useMutation, useQuery } from '@tanstack/react-query'
import { gitea } from '@adhar/api-clients'
import { useGiteaOrg } from '@adhar/shell-ui'

/**
 * Export Define pages to a project repository as a pull request, through the
 * console's `/api/svc/gitea` proxy (the user's own session decides access).
 * Adapted (copied) from Design's `gitea.ts` commit flow: one multi-file
 * commit on a new branch, then a PR into the base branch.
 */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

function b64(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

export function prBranchName(slug: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'docs'
  return `docs/${s}-${Date.now().toString(36)}`
}

export function useGiteaRepos(enabled: boolean) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['gitea', 'repos', org],
    queryFn: () => giteaClient.listRepos(org),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

export function useGiteaBranches(repo?: string) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['gitea', 'branches', org, repo],
    queryFn: () => giteaClient.listBranches(org, repo!),
    enabled: !!repo,
    staleTime: 60_000,
    retry: false,
  })
}

export function useExportPagesPr() {
  const org = useGiteaOrg()
  return useMutation({
    mutationFn: async (v: { repo: string; branch: string; files: Array<{ path: string; content: string }>; title: string; body: string }) => {
      if (!v.files.length) throw new Error('Nothing to export.')
      const shas = await Promise.all(v.files.map(async (f) => {
        try {
          return (await giteaClient.getFile(org, v.repo, v.branch, f.path)).sha
        } catch {
          return undefined
        }
      }))
      const head = prBranchName(v.title)
      await giteaClient.changeFiles(org, v.repo, v.branch, {
        message: v.title,
        files: v.files.map((f, i) => ({
          operation: shas[i] ? ('update' as const) : ('create' as const),
          path: f.path,
          content: b64(f.content),
          ...(shas[i] ? { sha: shas[i] } : {}),
        })),
        new_branch: head,
      })
      const pr = await giteaClient.createPullRequest(org, v.repo, { head, base: v.branch, title: v.title, body: v.body })
      return { number: pr.number, url: pr.html_url, branch: head }
    },
  })
}
