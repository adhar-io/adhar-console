import { useQuery } from '@tanstack/react-query'
import { gitea, k8s } from '@adhar/api-clients'
import { useGiteaOrg } from '@adhar/shell-ui'
import { detectFramework, type RepoApi } from '@adhar/builder/code'
import { appProjectSlug, appRepo, matchApps, scopedApps, type CatalogApp } from './designer-catalog.ts'

/**
 * Data for the repo-first Visual Designer: the org's repositories (Gitea, via
 * the console's `/api/svc/gitea` proxy), the platform's Applications (the
 * `Application` XR — Org → Teams → Projects → Apps — with their repo URL), and
 * per-repo framework / last-commit details, read lazily per card.
 *
 * Query keys follow Develop's git hooks (`['gitea', part, org, repo]`), so a
 * commit from the designer refreshes Develop's views and vice versa.
 */

export const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })
const k8sClient = k8s.K8sClient.auto()
const STALE = 30_000

const APPLICATIONS: k8s.GVR = { group: 'platform.adhar.io', version: 'v1alpha1', resource: 'applications', namespaced: true }
const TENANCY_NAMESPACE = 'adhar-system'

export function useDesignerRepos() {
  const org = useGiteaOrg()
  return useQuery({ queryKey: ['gitea', 'repos', org], queryFn: () => giteaClient.listRepos(org), staleTime: STALE })
}

/** Platform Applications with their repositories. Empty (never an error) when the CRD isn't there. */
export function useCatalogApps() {
  return useQuery({
    queryKey: ['designer', 'catalog-apps'],
    queryFn: async (): Promise<CatalogApp[]> => {
      try {
        const items = await k8sClient.listGeneric(undefined, APPLICATIONS, TENANCY_NAMESPACE)
        return items.map((x) => {
          const p = (x.spec?.parameters ?? {}) as { displayName?: string; description?: string; type?: string; project?: string; source?: { repoURL?: string } }
          const labels = x.metadata.labels ?? {}
          return {
            name: p.displayName || x.metadata.name,
            id: x.metadata.name,
            description: p.description,
            type: p.type,
            project: p.project ?? labels['adhar.io/project'],
            team: labels['adhar.io/team'],
            repoUrl: p.source?.repoURL ?? '',
          }
        }).filter((a) => a.repoUrl)
      } catch {
        return []
      }
    },
    staleTime: 60_000,
    retry: false,
  })
}

export { appProjectSlug, appRepo, matchApps, scopedApps }

/** The framework a repo's root package.json declares (card badge; a full detection runs on open). */
export function useRepoFramework(repo: string, ref?: string) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['designer', 'framework', org, repo, ref],
    queryFn: async () => {
      try {
        const f = await giteaClient.getFile(org, repo, ref!, 'package.json')
        return detectFramework(decode(f.content, f.encoding), [])
      } catch {
        return null
      }
    },
    enabled: !!ref,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useLastCommit(repo: string, ref?: string) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['gitea', 'commits', org, repo, ref, 'last'],
    queryFn: async () => (await giteaClient.listCommits(org, repo, ref, 1))[0] ?? null,
    enabled: !!ref,
    staleTime: STALE,
    retry: false,
  })
}

export function useRepoBranches(repo?: string) {
  const org = useGiteaOrg()
  return useQuery({
    queryKey: ['gitea', 'branches', org, repo],
    queryFn: () => giteaClient.listBranches(org, repo!),
    enabled: !!repo,
    staleTime: STALE,
  })
}

/** UTF-8 safe base64 helpers (Gitea's contents API speaks base64). */
export function decode(content: string, encoding?: string): string {
  if (encoding !== 'base64') return content
  const bin = atob(content.replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export function encode(text: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

/** The designer's view of one repository through the Gitea client. */
export function repoApi(owner: string, repo: string, headSha?: string): RepoApi {
  return {
    // By commit when known: branch names with "/" are fragile in a path segment.
    tree: (ref) => giteaClient.getTreeRecursive(owner, repo, headSha ?? ref),
    read: async (path, ref) => {
      const f = await giteaClient.getFile(owner, repo, ref, path)
      return { content: decode(f.content, f.encoding), sha: f.sha }
    },
  }
}
