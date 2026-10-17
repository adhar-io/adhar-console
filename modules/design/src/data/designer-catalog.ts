/**
 * Platform Applications ↔ Gitea repositories (pure, tested).
 *
 * An Application XR records its source as a repo URL. Matching is by the
 * repository's name (last path segment, `.git` stripped) and, when the URL
 * carries one, its owner.
 */

export interface CatalogApp {
  name: string
  project?: string
  team?: string
  repoUrl: string
}

export function repoFromUrl(url: string): { owner?: string; name: string } | null {
  const clean = url.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const m = clean.match(/(?:[:/])([^/:]+)\/([^/]+)$/)
  if (m) return { owner: m[1], name: m[2] }
  const last = clean.split('/').pop()
  return last ? { name: last } : null
}

/** Apps for a repository (an app repo can back several apps). */
export function matchApps(apps: CatalogApp[], repo: { name: string; owner?: string }): CatalogApp[] {
  return apps.filter((a) => {
    const r = repoFromUrl(a.repoUrl)
    if (!r || r.name.toLowerCase() !== repo.name.toLowerCase()) return false
    return !r.owner || !repo.owner || r.owner.toLowerCase() === repo.owner.toLowerCase()
  })
}
