/**
 * Platform Applications ↔ Gitea repositories (pure, tested).
 *
 * An Application XR records its source as a repo URL. Matching is by the
 * repository's name (last path segment, `.git` stripped) and, when the URL
 * carries one, its owner.
 *
 * Also which of those repositories the Visual Designer offers to open: the UI
 * applications, never a repository a change can't land in.
 */
import { detectFramework, findAppPackageJson, type Framework, isEditable } from '@adhar/builder/code'
import { isPlatformRepo } from './platform-repos.ts'

export interface CatalogApp {
  name: string
  /** Application resource name (catalog entity name); display name is `name`. */
  id?: string
  description?: string
  /** `spec.parameters.type` — `service` (the XRD default), `web`, `worker`, `data` or `ai`. */
  type?: string
  /** `spec.parameters.dashboard.type`, when the Application names its dashboard template. */
  dashboard?: string
  /** The Application's labels (`adhar.io/dashboard-type`, `adhar.io/frontend`, …). */
  labels?: Record<string, string>
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

/* ───────────────────── what the Visual Designer offers ───────────────────── */

/** What the library knows about a repository before reading a file of it (Gitea's listing). */
export interface RepoFacts {
  name: string
  language?: string | null
  mirror?: boolean
  archived?: boolean
  empty?: boolean
}

/**
 * Why the Visual Designer must never offer a repository for editing — null
 * when it may. A change made there is refused, or silently undone:
 *  - a pull mirror takes no pushes (`adhar-templates` mirrors GitHub);
 *  - an archived repository is read-only, an empty one has no branch to open;
 *  - the platform's own repositories (`isPlatformRepo`): `packages` and
 *    `environments` are the GitOps repos Argo CD and Kargo deploy from, and
 *    `adhar-ui` / `adhar-kit` are copies force-pushed from GitHub on every
 *    adhar-libraries sync — not Gitea mirrors, so only their name says so.
 */
export function notEditableReason(repo: RepoFacts): string | null {
  if (repo.mirror) return 'It mirrors another repository, so it takes no pushes. Change it upstream.'
  if (repo.archived) return 'It is archived, so it is read-only.'
  if (repo.empty) return 'It has no commits yet. Push a first commit, then open it here.'
  if (isPlatformRepo({ name: repo.name })) {
    return 'It is one of the platform’s own repositories: the GitOps repositories belong to Argo CD and Kargo, and the shared libraries are copied over from GitHub on every sync, which would undo a change made here.'
  }
  return null
}

/** The per-application dashboard templates (apps.xrd.yaml `dashboard.type`): does that kind of app have a browser UI? */
const DASHBOARD_HAS_UI = new Map([['frontend', true], ['fullstack', true], ['backend-jvm', false], ['backend-generic', false]])
/** Application types with no page to design. Not `service`: that is the XRD's default, so it says nothing. */
const NON_UI_TYPES = new Set(['worker', 'data', 'ai'])

/**
 * Does a platform Application have a browser UI? `true` / `false` when the
 * Application says, `undefined` when it doesn't.
 *
 * Read the way the Application composition picks the app's dashboard template
 * (compositions/apps/argocd-multienv.yaml): the `dashboard.type` parameter,
 * else the `adhar.io/dashboard-type` label the scaffolder stamps from the
 * Software Template (`frontend` and `fullstack` have a UI; `backend-jvm` and
 * `backend-generic` — services and functions — don't), else a browser app:
 * `type: web` or the label `adhar.io/frontend: "true"` the SPA descriptors
 * carry. `worker` / `data` / `ai` have no pages. `type: service` alone decides
 * nothing: it is the default, and every app the console scaffolded carried it
 * until 2026-10-27 — the React SPA template's included.
 */
export function appHasUi(app: Pick<CatalogApp, 'type' | 'dashboard' | 'labels'>): boolean | undefined {
  for (const d of [app.dashboard, app.labels?.['adhar.io/dashboard-type']]) {
    const v = DASHBOARD_HAS_UI.get((d ?? '').trim().toLowerCase())
    if (v !== undefined) return v
  }
  const type = (app.type ?? '').trim().toLowerCase()
  if (type === 'web' || app.labels?.['adhar.io/frontend'] === 'true') return true
  return NON_UI_TYPES.has(type) ? false : undefined
}

/** Gitea "top language" values that a front-end repository can have. */
const UI_LANGUAGES = new Set(['typescript', 'javascript', 'html', 'css', 'scss', 'vue', 'svelte', 'mdx', 'astro'])

/**
 * Is this repository a UI application the Visual Designer can open?
 *
 * Decided as cheaply as possible, most authoritative first:
 *  - a repository the designer must not edit (`notEditableReason`) never is;
 *  - the platform Applications deployed from it say what they are
 *    (`appHasUi`): any one with a UI makes it a UI target (a repo can back
 *    several apps); when every one says "no UI" — a backend, a function, a
 *    worker — it isn't;
 *  - Gitea's top language rules out back-end repos (Go, Java, Python, …);
 *  - anything left is `check`: its files decide (`repoFramework`) — React
 *    (Vite, Next.js, Remix), Angular, Vue / Nuxt, Svelte / SvelteKit, Solid and
 *    static HTML are editable.
 */
export type UiVerdict = 'ui' | 'not-ui' | 'check'
export function uiVerdict(repo: RepoFacts, apps: Pick<CatalogApp, 'type' | 'dashboard' | 'labels'>[]): UiVerdict {
  if (notEditableReason(repo)) return 'not-ui'
  const says = apps.map(appHasUi)
  if (says.includes(true)) return 'ui'
  if (says.length && says.every((s) => s === false)) return 'not-ui'
  const lang = (repo.language ?? '').trim().toLowerCase()
  if (lang && !UI_LANGUAGES.has(lang)) return 'not-ui'
  return 'check'
}

/**
 * The library's rows: every repository the designer may offer (never one it
 * must not edit — not even under "Show all repositories"), with the platform
 * Applications deployed from it and its verdict.
 */
export function judgeRepos<R extends RepoFacts & { owner?: { login?: string } | null }>(
  repos: readonly R[],
  apps: CatalogApp[],
): Array<{ repo: R; apps: CatalogApp[]; verdict: UiVerdict }> {
  return repos.filter((r) => !notEditableReason(r)).map((r) => {
    const matched = matchApps(apps, { name: r.name, owner: r.owner?.login })
    return { repo: r, apps: matched, verdict: uiVerdict(r, matched) }
  })
}

/**
 * A row's verdict with `check` settled by the framework its files declare.
 * `undefined` = still being read: kept listed (its badge shows a skeleton).
 */
export function isUiRepo(verdict: UiVerdict, framework: Framework | null | undefined): boolean {
  if (verdict !== 'check') return verdict === 'ui'
  return framework === undefined ? true : !!framework && isEditable(framework)
}

/** A repository's files, as far as `repoFramework` needs them — the Gitea client, or a fixture. */
export interface RepoFiles {
  /** The file's text; null when it isn't there or can't be read. */
  read(path: string): Promise<string | null>
  /** Every path in the repository. Only asked for when its root has no package.json. */
  paths(): Promise<string[]>
}

/**
 * The web framework a repository declares — the library's badge, and what
 * settles a `check` verdict. A package.json at the root, else an Angular
 * workspace (`angular.json`) or a static site (`index.html`) there. With no
 * package.json at the root at all, the repository is looked into the way
 * opening it does (`findAppPackageJson`: apps/web, web, frontend, app, ui,
 * then the shallowest), so a monorepo the editor opens is listed too. A root
 * package.json that names no framework is what opening reads as well, so that
 * one stays out. Null when nothing web-like is found.
 */
export async function repoFramework(files: RepoFiles): Promise<Framework | null> {
  const pkg = await files.read('package.json')
  const fw = pkg !== null ? detectFramework(pkg, []) : null
  if (fw && fw.id !== 'unknown') return fw
  for (const marker of ['angular.json', 'index.html']) {
    if ((await files.read(marker)) !== null) return detectFramework(pkg, [marker])
  }
  if (pkg !== null) return fw
  const paths = (await files.paths()).filter((p) => !p.includes('node_modules/'))
  const nested = findAppPackageJson(paths)
  if (!nested) return null
  const text = await files.read(nested)
  return text === null ? null : detectFramework(text, paths, nested)
}
