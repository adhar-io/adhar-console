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

/** Gitea "top language" values that a front-end repository can have. */
const UI_LANGUAGES = new Set(['typescript', 'javascript', 'html', 'css', 'scss', 'vue', 'svelte', 'mdx', 'astro'])

/**
 * Is this repository a UI application the Visual Designer can open?
 *
 * Decided as cheaply as possible, most authoritative first:
 *  - mirrors and archived repositories can't take a change → not a UI target;
 *  - a platform Application says its type: `web` is UI, `service` / `worker` /
 *    `data` / `ai` are not;
 *  - Gitea's top language rules out back-end repos (Go, Java, Python, …);
 *  - anything left is `check`: its package.json (or, without one, an
 *    `angular.json` / `index.html`) decides — React (Vite, Next.js, Remix),
 *    Angular, Vue / Nuxt, Svelte / SvelteKit, Solid and static HTML are editable.
 */
export type UiVerdict = 'ui' | 'not-ui' | 'check'
export function uiVerdict(
  repo: { language?: string | null; mirror?: boolean; archived?: boolean; empty?: boolean },
  apps: Pick<CatalogApp, 'type'>[],
): UiVerdict {
  if (repo.mirror || repo.archived || repo.empty) return 'not-ui'
  const types = apps.map((a) => (a.type ?? '').toLowerCase()).filter(Boolean)
  if (types.includes('web')) return 'ui'
  if (types.length) return 'not-ui'
  const lang = (repo.language ?? '').trim().toLowerCase()
  if (lang && !UI_LANGUAGES.has(lang)) return 'not-ui'
  return 'check'
}
