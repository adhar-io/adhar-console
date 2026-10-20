/**
 * Platform Applications ↔ Gitea repositories (pure, tested).
 *
 * An Application XR records its source as a repo URL. Matching is by the
 * repository's name (last path segment, `.git` stripped) and, when the URL
 * carries one, its owner.
 */

export interface CatalogApp {
  name: string
  /** Application resource name (catalog entity name); display name is `name`. */
  id?: string
  description?: string
  type?: string
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

/**
 * The catalog applications in a Design scope: an app is in scope when its
 * project is (by Adhar project slug or its Argo CD project), or — with no
 * project scope — always. Apps without a project only show unscoped.
 */
export function scopedApps(
  apps: CatalogApp[],
  inScope: Set<string> | null,
  projects: Array<{ slug: string; argoProject?: string }>,
): CatalogApp[] {
  if (!inScope) return apps
  const argo = new Map(projects.map((p) => [p.argoProject ?? '', p.slug]))
  return apps.filter((a) => {
    if (!a.project) return false
    return inScope.has(a.project) || inScope.has(argo.get(a.project) ?? '')
  })
}

/** The Adhar project slug an app belongs to (resolving an Argo CD project name). */
export function appProjectSlug(app: CatalogApp, projects: Array<{ slug: string; argoProject?: string }>): string | undefined {
  if (!app.project) return undefined
  if (projects.some((p) => p.slug === app.project)) return app.project
  return projects.find((p) => p.argoProject === app.project)?.slug ?? app.project
}

/** `owner/name` of an app's Gitea repository (default org when the URL has no owner). */
export function appRepo(app: CatalogApp, org: string): string | undefined {
  const r = repoFromUrl(app.repoUrl)
  return r ? `${r.owner ?? org}/${r.name}` : undefined
}
