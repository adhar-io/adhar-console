import { useQueries } from '@tanstack/react-query'
import { useGiteaOrg } from '@adhar/shell-ui'
import { decode, giteaClient } from './designer-repos.ts'
import { countJsxUsage, isComponentFile, parseComponentExports } from './repo-components.ts'

/** Repository scans for the Component Catalog (see `repo-components.ts` for the parsing). */

export interface RepoComponent {
  name: string
  repo: string
  path: string
  branch: string
}

export interface RepoScan {
  repo: string
  branch: string
  components: RepoComponent[]
  filesScanned: number
  filesFound: number
  truncated: boolean
  /** `<Name` usages of shell-ui components across the scanned files. */
  shellUsage: Record<string, number>
}

const MAX_FILES = 60

async function scanRepo(owner: string, repo: string, branch: string, shellNames: string[]): Promise<RepoScan> {
  const tree = await giteaClient.getTreeRecursive(owner, repo, branch)
  const files = tree.entries.map((e) => e.path).filter(isComponentFile).sort()
  const picked = files.slice(0, MAX_FILES)
  const components: RepoComponent[] = []
  const usage = new Map<string, number>()
  // Small batches — this is a background scan, not a burst.
  for (let i = 0; i < picked.length; i += 6) {
    const batch = picked.slice(i, i + 6)
    const texts = await Promise.all(batch.map(async (p) => {
      try {
        const f = await giteaClient.getFile(owner, repo, branch, p)
        return decode(f.content, f.encoding)
      } catch {
        return ''
      }
    }))
    batch.forEach((p, j) => {
      for (const name of parseComponentExports(texts[j], p)) components.push({ name, repo: `${owner}/${repo}`, path: p, branch })
      for (const [n, c] of countJsxUsage(texts[j], shellNames)) usage.set(n, (usage.get(n) ?? 0) + c)
    })
  }
  return {
    repo: `${owner}/${repo}`,
    branch,
    components,
    filesScanned: picked.length,
    filesFound: files.length,
    truncated: tree.truncated || files.length > picked.length,
    shellUsage: Object.fromEntries(usage),
  }
}

/** Scan each repo (`owner/name@branch`) — cached for 15 minutes per repo + branch. */
export function useRepoComponentScans(repos: Array<{ fullName: string; branch: string }>, shellNames: string[], enabled = true) {
  const org = useGiteaOrg()
  return useQueries({
    queries: repos.map((r) => {
      const [owner, name] = r.fullName.includes('/') ? r.fullName.split('/', 2) : [org, r.fullName]
      return {
        queryKey: ['design', 'repo-components', owner, name, r.branch],
        queryFn: () => scanRepo(owner, name, r.branch, shellNames),
        enabled,
        staleTime: 15 * 60_000,
        gcTime: 60 * 60_000,
        retry: false,
      }
    }),
  })
}
