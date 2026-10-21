/**
 * Where a performance test lives: in the application repository it measures.
 *
 * ---------------------------------------------------------------------------
 * ONE HOME PER TEST — THE APPLICATION'S OWN REPOSITORY
 * ---------------------------------------------------------------------------
 * Every service a template creates arrives with a k6 test in its own repo:
 *
 *   perf/load.js     — the k6 script
 *   perf/test.json   — everything that is not the script
 *
 * The Performance Center used to keep a second copy of that pair in a
 * separate `performance-tests` repository, which meant two places to edit,
 * a scaffolder step that could half-fail, and a test whose history said
 * nothing about the code it was measuring. The test now stays where the code
 * is: it is reviewed with the change that made the service slower, and the
 * commit a run is labelled with is a commit of the application itself.
 *
 * Naming keeps every result the old layout produced attributable:
 *
 *   perf/{load.js,test.json}          → `<repo>-load`   (what the scaffolder named it)
 *   perf/<test>/{load.js,test.json}   → `<repo>-<test>` (any further tests)
 *
 * The name labels the TestRun, the artefact ConfigMap (`k6-<name>`) and every
 * kept result, so it must not change for a test that already has history.
 *
 * Pure: no network, no React. Discovery takes the directory lister as an
 * argument so the mapping can be tested without Gitea.
 */

export const PERF_DIR = 'perf'
/** The script file in an application repo (the artefact ConfigMap key is still `script.js`). */
export const REPO_SCRIPT_FILE = 'load.js'
export const REPO_CONFIG_FILE = 'test.json'
/** Suffix of an app's default test — the one directly under `perf/`. */
export const DEFAULT_TEST = 'load'

/**
 * Org repositories that are platform infrastructure, not applications. The
 * same set as the console's `catalog-platform-repos.ts` (which this module
 * cannot import), plus `performance-tests`: the retired suite repository may
 * still exist in an org, and it is not an application with tests of its own.
 */
export const PLATFORM_REPOS = new Set([
  'packages',
  'environments',
  'templates',
  'adhar-templates',
  'adhar-ui',
  'adhar-kit',
  'adhar',
  'performance-tests',
])

export interface RepoLike {
  name: string
  default_branch?: string
  html_url?: string
  mirror?: boolean
  template?: boolean
  archived?: boolean
  empty?: boolean
}

/**
 * True for a repository that can hold an application's tests. Mirrors are
 * upstream code, templates are skeletons, archived repos cannot take a
 * commit and an empty repo has no branch to read.
 */
export function isApplicationRepo(repo: RepoLike): boolean {
  if (repo.mirror || repo.template || repo.archived || repo.empty) return false
  return !PLATFORM_REPOS.has(repo.name.toLowerCase())
}

/** `checkout` → `checkout-load`; `checkout`, `smoke` → `checkout-smoke`. */
export function perfTestName(repo: string, test?: string): string {
  return `${repo}-${test || DEFAULT_TEST}`.slice(0, 63).replace(/-+$/, '')
}

/** `perf` for the default test, `perf/<test>` for any other. */
export function perfTestDir(test?: string): string {
  return test && test !== DEFAULT_TEST ? `${PERF_DIR}/${test}` : PERF_DIR
}

export interface PerfTestLocation {
  /** The Performance Center name: `<repo>-load` or `<repo>-<test>`. */
  name: string
  org: string
  /** The application repository — also the application the test measures. */
  repo: string
  /** Its default branch, which is what the console reads and commits to. */
  branch: string
  /** `perf` or `perf/<test>`. */
  dir: string
  /** Repository web URL as Gitea reports it (callers make it public). */
  repoUrl?: string
}

export function locationOf(org: string, repo: RepoLike, test?: string): PerfTestLocation {
  return {
    name: perfTestName(repo.name, test),
    org,
    repo: repo.name,
    branch: repo.default_branch || 'main',
    dir: perfTestDir(test),
    repoUrl: repo.html_url,
  }
}

const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/

/**
 * The application a test measures: the repo it lives in, when that name can
 * be a label value (Gitea allows longer names than Kubernetes labels do).
 */
export function applicationOf(loc: Pick<PerfTestLocation, 'repo'> | undefined): string | undefined {
  return loc && LABEL_VALUE.test(loc.repo) ? loc.repo : undefined
}

export const scriptPathOf = (loc: Pick<PerfTestLocation, 'dir'>) => `${loc.dir}/${REPO_SCRIPT_FILE}`
export const configPathOf = (loc: Pick<PerfTestLocation, 'dir'>) => `${loc.dir}/${REPO_CONFIG_FILE}`

/** Where the test's files are in Gitea's web UI. */
export function filesUrlOf(loc: PerfTestLocation): string | undefined {
  if (!loc.repoUrl) return undefined
  return `${loc.repoUrl.replace(/\/+$/, '')}/src/branch/${encodeURIComponent(loc.branch)}/${loc.dir}`
}

/* ─────────────────────────── discovery ─────────────────────────── */

export interface DirEntry {
  path: string
  type: 'blob' | 'tree'
}

/** Lists a directory on a branch; null when it does not exist. */
export type ListDir = (repo: string, branch: string, path: string) => Promise<DirEntry[] | null>

const base = (path: string) => path.split('/').pop() ?? ''

/** A directory is a test when it holds the script or the config. */
function holdsTest(entries: DirEntry[]): boolean {
  return entries.some((e) => e.type === 'blob' && (base(e.path) === REPO_SCRIPT_FILE || base(e.path) === REPO_CONFIG_FILE))
}

/** A sub-directory name usable as a test suffix (it names Kubernetes objects). */
const TEST_SEGMENT = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * The tests in one application repo. No `perf/` is no tests, not an error;
 * a sub-directory without a script or config (shared helpers, fixtures) is
 * not a test either.
 */
export async function perfTestsInRepo(org: string, repo: RepoLike, list: ListDir): Promise<PerfTestLocation[]> {
  const branch = repo.default_branch || 'main'
  const top = await list(repo.name, branch, PERF_DIR)
  if (!top) return []
  const out: PerfTestLocation[] = []
  if (holdsTest(top)) out.push(locationOf(org, repo))
  const subs = top.filter((e) => e.type === 'tree' && TEST_SEGMENT.test(base(e.path)) && base(e.path) !== DEFAULT_TEST)
  const listed = await Promise.all(subs.map((s) => list(repo.name, branch, `${PERF_DIR}/${base(s.path)}`).catch(() => null)))
  subs.forEach((s, i) => {
    const entries = listed[i]
    if (entries && holdsTest(entries)) out.push(locationOf(org, repo, base(s.path)))
  })
  return out
}

/**
 * Every test in every application repo of the org, sorted by name. Repos are
 * read a few at a time; a repo that cannot be read is reported rather than
 * failing the whole list, because one broken repo must not hide every test.
 * Names are unique — the first location wins if two ever collide.
 */
export async function discoverPerfTests(
  org: string,
  repos: readonly RepoLike[],
  list: ListDir,
  concurrency = 6,
): Promise<{ tests: PerfTestLocation[]; unreadable: string[] }> {
  const apps = repos.filter(isApplicationRepo)
  const found: PerfTestLocation[][] = new Array(apps.length)
  const unreadable: string[] = []
  let next = 0
  const worker = async () => {
    while (next < apps.length) {
      const i = next++
      try {
        found[i] = await perfTestsInRepo(org, apps[i], list)
      } catch {
        found[i] = []
        unreadable.push(apps[i].name)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, apps.length) }, worker))
  const seen = new Set<string>()
  const tests = found.flat().filter((t) => !seen.has(t.name) && Boolean(seen.add(t.name)))
  return { tests: tests.sort((a, b) => a.name.localeCompare(b.name)), unreadable: unreadable.sort() }
}

/* ─────────────────────────── new tests ─────────────────────────── */

/**
 * Why a new test cannot go at `app` + `test`, or null when it can. An empty
 * `test` (or `load`) is the app's default test directly under `perf/`.
 */
export function newTestProblem(existing: readonly Pick<PerfTestLocation, 'name'>[], app: string, test: string): string | null {
  if (!app) return 'Choose the application the test belongs to.'
  const sub = test === DEFAULT_TEST ? '' : test
  if (sub && !TEST_SEGMENT.test(sub)) return 'Lowercase letters, numbers and dashes only — it also names the Kubernetes objects.'
  if (`${app}-${sub || DEFAULT_TEST}`.length > 63) return 'Too long: the application and test names together must fit in 63 characters.'
  const name = perfTestName(app, sub)
  if (existing.some((t) => t.name === name)) {
    return sub ? 'A test with that name already exists.' : `${app} already has its default test in ${PERF_DIR}/ — give this one a name.`
  }
  return null
}
