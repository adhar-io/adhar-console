import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useGiteaOrg } from '@adhar/shell-ui'
import { kube } from '@adhar/api-clients/k8s'
import type { gitea } from '@adhar/api-clients'
import { giteaClient } from './git.ts'
import { artefactConfigMap, artefactName } from './perf-runner.ts'
import { withPinnedImages } from './k6-images.ts'
import { LABEL_TRIGGER } from './perf-results.ts'
import {
  DEFAULT_CONFIG,
  LABEL_APPLICATION,
  LABEL_COMMIT,
  LABEL_MANAGED,
  LABEL_TEST,
  parseConfig,
  type PerfTestConfig,
  SCRIPT_FILE,
  serialiseConfig,
  type Starter,
} from './perf-format.ts'
import {
  applicationOf,
  configPathOf,
  discoverPerfTests,
  isApplicationRepo,
  locationOf,
  type PerfTestLocation,
  REPO_CONFIG_FILE,
  REPO_SCRIPT_FILE,
  scriptPathOf,
} from './perf-location.ts'

export type { PerfTestLocation } from './perf-location.ts'

/**
 * The performance suite: the k6 tests every application keeps in its own
 * repository, under `perf/` (see perf-location.ts for the layout and names).
 *
 * ---------------------------------------------------------------------------
 * GIT IS THE SOURCE, THE CONFIGMAP IS THE ARTEFACT
 * ---------------------------------------------------------------------------
 * The k6 operator can only read a script from a ConfigMap or a volume — it
 * cannot clone. Storing scripts *as* ConfigMaps is what the console did
 * before, and it costs you everything git gives: no author, no history, no
 * diff, no review, and therefore no way to answer "what changed between the
 * run that was fast and the run that was slow".
 *
 * So the application repository holds the truth and the ConfigMap is
 * generated at launch, stamped with the app commit it came from. The TestRun
 * carries the same stamp and the application's name, which is what makes a
 * result traceable to an exact script and countable on that app's scorecard.
 *
 * There is no suite repository to create: a template ships its service with a
 * test, and a test for anything else is created inside the app's repo.
 */

export interface PerfTest {
  name: string
  config: PerfTestConfig
  /** Raw `test.json`, so the editor can show exactly what is committed. */
  configRaw: string
  script: string
  /** Blob sha of each file — Gitea needs it to accept an update. */
  scriptSha?: string
  configSha?: string
  /** Where it lives. Absent only for a test built in memory and not yet read back. */
  location?: PerfTestLocation
  /** Newest app commit that touched the test's files — what a run is labelled with. */
  commit?: string
}

/** An application repository the console may read tests from and commit tests to. */
export interface AppRepo {
  name: string
  branch: string
  repoUrl?: string
  /**
   * Gitea's own answer to "may this user push here" (`permissions.push` on the
   * repository). Tests are commits, so Gitea — not Kubernetes RBAC — decides
   * who may author them; undefined when Gitea did not say.
   */
  canPush?: boolean
}

export interface PerfSuite {
  org: string
  apps: AppRepo[]
  tests: PerfTestLocation[]
  /** Application repos whose `perf/` could not be read — their tests are missing from `tests`. */
  unreadable: string[]
}

function notFound(e: unknown): boolean {
  return (e as { status?: number } | null)?.status === 404
}

/** May the user commit to the repository holding `name` (or, with no name, to any app repo)? */
export function canAuthorPerf(suite: PerfSuite | undefined, name?: string | null): boolean {
  if (!suite) return false
  if (!name) return suite.apps.some((a) => a.canPush !== false)
  const loc = findTest(suite, name)
  return suite.apps.find((a) => a.name === loc?.repo)?.canPush !== false
}

/** The test called `name`, if some application repo has it. */
export function findTest(suite: PerfSuite | undefined, name: string | null | undefined): PerfTestLocation | undefined {
  return name ? suite?.tests.find((t) => t.name === name) : undefined
}

/** Where a new test would go: `perf/` for the app's default test, `perf/<test>/` otherwise. */
export function newTestLocation(suite: PerfSuite, app: string, test?: string): PerfTestLocation {
  const repo = suite.apps.find((a) => a.name === app)
  if (!repo) throw new Error(`${app} is not an application repository in ${suite.org}.`)
  return locationOf(suite.org, { name: repo.name, default_branch: repo.branch, html_url: repo.repoUrl }, test)
}

/* ─────────────────────────── discovery ─────────────────────────── */

/**
 * Every application repo in the org and the tests in their `perf/` folders.
 * Repos are listed once; each app costs one directory read (plus one per
 * sub-test), so the result is cached briefly rather than refetched per view.
 */
export function usePerfSuite() {
  const org = useGiteaOrg()
  return useQuery<PerfSuite>({
    queryKey: ['perf', 'suite', org],
    queryFn: async () => {
      const repos: gitea.Repo[] = await giteaClient.listRepos(org)
      const apps = repos.filter(isApplicationRepo)
      const { tests, unreadable } = await discoverPerfTests(org, apps, async (repo, branch, path) => {
        try {
          return await giteaClient.listTree(org, repo, branch, path)
        } catch (e) {
          if (notFound(e)) return null
          throw e
        }
      })
      return {
        org,
        apps: apps
          .map((r) => ({ name: r.name, branch: r.default_branch || 'main', repoUrl: r.html_url, canPush: r.permissions?.push }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        tests,
        unreadable,
      }
    },
    enabled: Boolean(org),
    staleTime: 30_000,
    retry: false,
  })
}

/* ─────────────────────────── tests ─────────────────────────── */

export function usePerfTest(suite: PerfSuite | undefined, name: string | null) {
  const loc = findTest(suite, name)
  return useQuery<PerfTest>({
    queryKey: ['perf', 'test', loc?.org, loc?.repo, loc?.dir, name],
    queryFn: () => fetchPerfTest(suite!, name!),
    enabled: Boolean(loc),
    retry: false,
  })
}

/** Read one test fresh from git — script, config, the shas an update needs and its latest commit. */
export async function fetchPerfTest(suite: PerfSuite, name: string): Promise<PerfTest> {
  const loc = findTest(suite, name)
  if (!loc) throw new Error(`No application repository has a performance test called ${name}.`)
  const [script, config, commits] = await Promise.all([
    readFile(loc, scriptPathOf(loc)),
    readFile(loc, configPathOf(loc)),
    testCommits(loc, 1).catch(() => []),
  ])
  const configRaw = config?.text ?? ''
  return {
    name,
    script: script?.text ?? '',
    scriptSha: script?.sha,
    configSha: config?.sha,
    configRaw,
    config: parseConfig(configRaw, name),
    location: loc,
    commit: commits[0]?.sha,
  }
}

/**
 * Just `test.json`, for views that need many tests' gates at once. A name no
 * app repo has any more (a result of a deleted test) reads as the defaults.
 */
export async function fetchPerfTestConfig(suite: PerfSuite, name: string): Promise<PerfTestConfig> {
  const loc = findTest(suite, name)
  const config = loc ? await readFile(loc, configPathOf(loc)) : null
  return parseConfig(config?.text ?? '', name)
}

async function readFile(
  loc: PerfTestLocation,
  path: string,
): Promise<{ text: string; sha?: string } | null> {
  try {
    const f = await giteaClient.getFile(loc.org, loc.repo, loc.branch, path)
    return { text: decode(f.content, f.encoding), sha: f.sha }
  } catch (e) {
    if (notFound(e)) return null
    throw e
  }
}

/**
 * Commits that touched the test's two files, newest first. Per file rather
 * than per directory: the default test's directory is `perf/` itself, and
 * a commit to `perf/smoke/` did not change it.
 */
async function testCommits(loc: PerfTestLocation, limit: number): Promise<gitea.Commit[]> {
  const lists = await Promise.all(
    [scriptPathOf(loc), configPathOf(loc)].map((path) =>
      giteaClient.listCommits(loc.org, loc.repo, loc.branch, limit, { path }).catch((e) => {
        if (notFound(e)) return [] as gitea.Commit[]
        throw e
      })
    ),
  )
  const bySha = new Map<string, gitea.Commit>()
  for (const c of lists.flat()) if (c.sha && !bySha.has(c.sha)) bySha.set(c.sha, c)
  return [...bySha.values()].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '')).slice(0, limit)
}

export interface SaveTestInput {
  name: string
  /** Where to commit. Required for a new test; an existing one is found by name. */
  location?: PerfTestLocation
  script?: string
  config?: PerfTestConfig
  /** Shas of the versions being replaced; omit for a new file. */
  scriptSha?: string
  configSha?: string
  message?: string
}

/**
 * Commit a test to its application repository's default branch.
 *
 * Script and config are written as separate commits because Gitea's contents
 * API writes one file per call. They are sequenced rather than parallel so a
 * failure leaves the repository in the more useful half-state: the script
 * saved, the config not, rather than a config describing a script that was
 * never written.
 */
export function useSavePerfTest(suite: PerfSuite | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveTestInput) => {
      const loc = input.location ?? findTest(suite, input.name)
      if (!loc) throw new Error(`No application repository has a performance test called ${input.name}.`)
      const message = input.message ?? `perf: update ${input.name}`
      let commit: string | undefined

      if (input.script !== undefined) {
        const res = await giteaClient.saveFile(loc.org, loc.repo, loc.branch, scriptPathOf(loc), {
          content: b64(input.script),
          message: `${message} (${REPO_SCRIPT_FILE})`,
          sha: input.scriptSha,
        })
        commit = res.commit?.sha
      }
      if (input.config !== undefined) {
        const res = await giteaClient.saveFile(loc.org, loc.repo, loc.branch, configPathOf(loc), {
          content: b64(serialiseConfig(input.config)),
          message: `${message} (${REPO_CONFIG_FILE})`,
          sha: input.configSha,
        })
        commit = res.commit?.sha ?? commit
      }
      return { commit, location: loc }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['perf'] }),
  })
}

/**
 * Create a test in an application repository: its default test under `perf/`
 * when `test` is omitted, otherwise `perf/<test>/`. The name follows from
 * where it lives (`<app>-load`, `<app>-<test>`).
 */
export function useCreatePerfTest(suite: PerfSuite | undefined) {
  const save = useSavePerfTest(suite)
  return useMutation({
    mutationFn: async (input: { app: string; test?: string; starter: Starter; namespace: string }) => {
      if (!suite) throw new Error('The application repositories have not been read yet.')
      const location = newTestLocation(suite, input.app, input.test)
      if (findTest(suite, location.name)) throw new Error(`${location.name} already exists in ${location.repo}.`)
      const name = location.name
      const config: PerfTestConfig = {
        ...DEFAULT_CONFIG,
        ...input.starter.config(name),
        title: name.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
        namespace: input.namespace,
      }
      await save.mutateAsync({
        name,
        location,
        script: input.starter.script(name),
        config,
        message: `perf: add ${name} from the ${input.starter.label.toLowerCase()} starter`,
      })
      return name
    },
  })
}

/** Delete both files. Gitea has no directory delete; the dir goes when empty. */
export function useDeletePerfTest(suite: PerfSuite | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => {
      const loc = findTest(suite, name)
      if (!loc) return
      for (const path of [scriptPathOf(loc), configPathOf(loc)]) {
        try {
          const f = await giteaClient.getFile(loc.org, loc.repo, loc.branch, path)
          await giteaClient.deleteFile(loc.org, loc.repo, loc.branch, path, {
            message: `perf: remove ${name}`,
            sha: f.sha,
          })
        } catch (e) {
          if (!notFound(e)) throw e
        }
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['perf'] }),
  })
}

/* ─────────────────────────── history ─────────────────────────── */

/** Commits touching one test's files in its app repo — the provenance behind every result. */
export function usePerfTestHistory(suite: PerfSuite | undefined, name: string | null) {
  const loc = findTest(suite, name)
  return useQuery({
    queryKey: ['perf', 'history', loc?.org, loc?.repo, loc?.dir, name],
    // Every commit that touched the test's files — hand-made ones too.
    queryFn: () => testCommits(loc!, 30),
    enabled: Boolean(loc),
    retry: false,
  })
}

/* ─────────────────────────── launching ─────────────────────────── */

const CONFIG_MAPS = { group: '', version: 'v1', resource: 'configmaps', namespaced: true }
const TEST_RUNS = { group: 'k6.io', version: 'v1alpha1', resource: 'testruns', namespaced: true }

/** `checkout-load` → `k6-checkout-load`, the generated ConfigMap. */
export const scriptConfigMapName = artefactName

/**
 * Run a committed test.
 *
 * Two objects, in order:
 *   1. the artefact ConfigMap: the script exactly as committed, plus the
 *      runner, TestRun template and gate that schedules and CI reuse, and
 *   2. a TestRun pointing at it.
 *
 * Both carry the test name and the application commit as labels, and the
 * TestRun names the application (the repo the test lives in). That is the
 * whole point of routing through git: a month later, a result still says
 * which script produced it, and the script is still there to read.
 */
export function useRunPerfTest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { test: PerfTest; commit?: string; runName?: string }) => {
      const { test } = input
      const ns = test.config.namespace || 'default'
      const commit = (input.commit ?? test.commit ?? '').slice(0, 40)
      const cmName = scriptConfigMapName(test.name)
      const application = applicationOf(test.location)

      // The artefact: the script exactly as committed, plus the TestRun
      // template, gate and runner script that schedules and CI reuse.
      await kube.apply(
        artefactConfigMap({ test: test.name, config: { ...test.config, namespace: ns }, script: test.script, commit, application }),
      )

      const runName = input.runName ?? `${test.name}-${stamp()}`
      const run = await kube.apply<{ metadata: { name: string; namespace?: string } }>({
        apiVersion: 'k6.io/v1alpha1',
        kind: 'TestRun',
        metadata: {
          name: runName,
          namespace: ns,
          labels: {
            [LABEL_MANAGED]: 'adhar-console',
            [LABEL_TEST]: test.name,
            [LABEL_TRIGGER]: 'console',
            ...(commit ? { [LABEL_COMMIT]: commit.slice(0, 63) } : {}),
            // The app the test lives with — what the harvester copies onto the
            // result and the scorecard joins on.
            ...(application ? { [LABEL_APPLICATION]: application } : {}),
          },
        },
        spec: withPinnedImages({
          parallelism: test.config.parallelism,
          script: { configMap: { name: cmName, file: SCRIPT_FILE } },
          // The CRD defaults `paused` to the STRING "true", so a TestRun
          // created without it never leaves `initialization` — "Run test"
          // produced a run that sat there forever with no explanation. Say
          // "false" explicitly; pausing stays a deliberate act in the drawer.
          paused: 'false',
          ...(test.config.arguments ? { arguments: test.config.arguments } : {}),
          // No `cleanup: 'post'`: with it the operator deletes the TestRun —
          // and with it the runner pods — the moment the run finishes, before
          // the console can harvest the summary into a durable result. The
          // harvester stamps the run once its result is kept, and the Runs
          // tab clears harvested runs in one action.
          ...(Object.keys(test.config.env).length
            ? {
              runner: {
                env: Object.entries(test.config.env).map(([name, value]) => ({ name, value })),
              },
            }
            : {}),
        }),
      })
      return run
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['k6'] })
      void qc.invalidateQueries({ queryKey: ['perf'] })
    },
  })
}

/** `20260920-1431` — sortable, readable, and a valid name segment. */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/* ─────────────────────────── encoding ─────────────────────────── */

/** UTF-8 safe base64 — scripts contain non-ASCII (comments, test data). */
function b64(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

function decode(content: string | undefined, encoding: string | undefined): string {
  if (!content) return ''
  if (encoding && encoding !== 'base64') return content
  try {
    const bin = atob(content.replace(/\s/g, ''))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return content
  }
}

export { TEST_RUNS as PERF_TEST_RUNS_GVR, CONFIG_MAPS as PERF_CONFIG_MAPS_GVR }
