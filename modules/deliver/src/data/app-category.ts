import type { argocd } from '@adhar-console/api-clients'

/**
 * Telling platform packages apart from the applications a team builds.
 *
 * The Applications page was narrowed by the team lens: it filtered on
 * `spec.project` being an Argo CD project owned by the active team. Every
 * Application on this platform is in the `default` Argo project, and no
 * workspace project claims it, so the lens matched nothing and the page read
 * "Showing 0 of 75 applications — scoped to platform". A filter that hides
 * everything is not a lens, it is a blank page.
 *
 * The platform already labels what it installs. Every package carries
 * `adhar.io/category` — `application`, `data`, `security`, `observability`,
 * `core`, `ai`, `infrastructure` — and `adhar.io/package-name`. An Application
 * without those labels was not installed by the platform: it is something a
 * team deployed, which is the distinction people actually want to filter on.
 *
 * Deliberately a label check and nothing cleverer. Guessing from the
 * repository URL or the namespace would misfile the first workload that
 * happens to live in the platform's git org.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export const CATEGORY_LABEL = 'adhar.io/category'
export const PACKAGE_LABEL = 'adhar.io/package-name'

/** `custom` is not a platform category; it is the absence of one. */
export const CUSTOM = 'custom'

/**
 * Display order. Platform categories first in rough dependency order, with
 * whatever the platform invents next appended rather than dropped.
 */
const ORDER = [
  CUSTOM,
  'application',
  'data',
  'ai',
  'security',
  'observability',
  'infrastructure',
  'core',
]

export const CATEGORY_TITLE: Record<string, string> = {
  [CUSTOM]: 'Custom apps',
  application: 'Applications',
  data: 'Data',
  ai: 'AI',
  security: 'Security',
  observability: 'Observability',
  infrastructure: 'Infrastructure',
  core: 'Core',
}

export function categoryTitle(category: string): string {
  if (CATEGORY_TITLE[category]) return CATEGORY_TITLE[category]
  // A category this console has not seen still names itself, capitalised.
  return category.charAt(0).toUpperCase() + category.slice(1)
}

function labels(app: argocd.Application): Record<string, string> {
  return (app.metadata as { labels?: Record<string, string> }).labels ?? {}
}

/** The platform category of an Application, or `custom` when it has none. */
export function appCategory(app: argocd.Application): string {
  const value = labels(app)[CATEGORY_LABEL]?.trim()
  return value ? value : CUSTOM
}

/** Installed by the platform, as opposed to deployed by a team. */
export function isPlatformApp(app: argocd.Application): boolean {
  return appCategory(app) !== CUSTOM
}

export function isCustomApp(app: argocd.Application): boolean {
  return !isPlatformApp(app)
}

/** The platform package an Application came from, when it is one. */
export function packageName(app: argocd.Application): string | undefined {
  return labels(app)[PACKAGE_LABEL]?.trim() || undefined
}

export interface CategoryTally {
  id: string
  title: string
  count: number
  /** `custom` is the absence of a platform category, not one of them. */
  platform: boolean
}

/**
 * Categories present, in display order, with counts.
 *
 * Only categories that exist in the data are returned — offering a filter that
 * can only ever produce an empty list is how the page got into this state.
 */
export function categoryTally(apps: argocd.Application[]): CategoryTally[] {
  const counts = new Map<string, number>()
  for (const a of apps) {
    const c = appCategory(a)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  const known = ORDER.filter((c) => counts.has(c))
  const extra = [...counts.keys()].filter((c) => !ORDER.includes(c)).sort()
  return [...known, ...extra].map((id) => ({
    id,
    title: categoryTitle(id),
    count: counts.get(id) ?? 0,
    platform: id !== CUSTOM,
  }))
}

export interface CategoryFilter {
  /** Empty means every category. */
  categories?: string[]
  /** `platform`, `custom`, or neither for both. */
  kind?: 'platform' | 'custom'
}

export function matchesCategory(app: argocd.Application, f: CategoryFilter): boolean {
  if (f.kind === 'platform' && !isPlatformApp(app)) return false
  if (f.kind === 'custom' && !isCustomApp(app)) return false
  if (f.categories?.length && !f.categories.includes(appCategory(app))) return false
  return true
}
