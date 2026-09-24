import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useGiteaOrg } from '@adhar-console/shell-ui'
import { kube } from '@adhar-console/api-clients/k8s'
import { giteaClient } from './git.ts'
import {
  CONFIG_FILE,
  configPath,
  DEFAULT_CONFIG,
  LABEL_COMMIT,
  LABEL_MANAGED,
  LABEL_TEST,
  parseConfig,
  type PerfTestConfig,
  SCRIPT_FILE,
  scriptPath,
  serialiseConfig,
  type Starter,
  suiteReadme,
  TESTS_DIR,
} from './perf-format.ts'

/**
 * The performance suite: k6 tests stored in their own Gitea repository.
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
 * So the repository holds the truth and the ConfigMap is generated at launch,
 * stamped with the commit it came from. The TestRun carries the same stamp,
 * which is what makes a result traceable to an exact script.
 *
 * The repository is created on demand, because a suite that requires someone
 * to go and make a repo first is a suite nobody starts.
 */

/** Default repository name; the org comes from `/api/config`. */
const SUITE_REPO = 'performance-tests'
const BRANCH = 'main'

export interface PerfTest {
  name: string
  config: PerfTestConfig
  /** Raw `test.json`, so the editor can show exactly what is committed. */
  configRaw: string
  script: string
  /** Blob sha of each file — Gitea needs it to accept an update. */
  scriptSha?: string
  configSha?: string
}

export interface SuiteRepo {
  org: string
  repo: string
  exists: boolean
  htmlUrl?: string
  defaultBranch: string
}

function notFound(e: unknown): boolean {
  return (e as { status?: number } | null)?.status === 404
}

/* ─────────────────────────── the repository ─────────────────────────── */

export function useSuiteRepo() {
  const org = useGiteaOrg()
  return useQuery<SuiteRepo>({
    queryKey: ['perf', 'suite-repo', org],
    queryFn: async () => {
      try {
        const repo = await giteaClient.getRepo(org, SUITE_REPO)
        return {
          org,
          repo: SUITE_REPO,
          exists: true,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch || BRANCH,
        }
      } catch (e) {
        if (notFound(e)) return { org, repo: SUITE_REPO, exists: false, defaultBranch: BRANCH }
        throw e
      }
    },
    enabled: Boolean(org),
    retry: false,
  })
}

/**
 * Create the suite repository and seed it with a README.
 *
 * Seeding matters: Gitea creates an EMPTY repo with no default branch, and
 * every subsequent write to `main` fails until something has been committed.
 * `auto_init` makes the first commit for us.
 */
export function useCreateSuiteRepo() {
  const qc = useQueryClient()
  const org = useGiteaOrg()
  return useMutation({
    mutationFn: async () => {
      const repo = await giteaClient.createRepo(org, {
        name: SUITE_REPO,
        description: 'k6 performance tests, run by the Adhar platform',
        private: false,
        auto_init: true,
        default_branch: BRANCH,
      })
      // Replace the generated README with one that explains the layout.
      try {
        const existing = await giteaClient.getFile(org, SUITE_REPO, BRANCH, 'README.md')
        await giteaClient.saveFile(org, SUITE_REPO, BRANCH, 'README.md', {
          content: b64(suiteReadme(org, SUITE_REPO)),
          message: 'docs: describe the performance suite layout',
          sha: existing.sha,
        })
      } catch {
        // A README is a courtesy; the suite works without it.
      }
      return repo
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['perf'] }),
  })
}

/* ─────────────────────────── tests ─────────────────────────── */

/** Every test directory under `tests/`. */
export function usePerfTests(suite: SuiteRepo | undefined) {
  const enabled = Boolean(suite?.exists)
  return useQuery<string[]>({
    queryKey: ['perf', 'tests', suite?.org, suite?.repo],
    queryFn: async () => {
      try {
        const entries = await giteaClient.listTree(suite!.org, suite!.repo, suite!.defaultBranch, TESTS_DIR)
        return entries
          .filter((e) => e.type === 'tree')
          .map((e) => e.path.split('/').pop() ?? '')
          .filter(Boolean)
          .sort()
      } catch (e) {
        // No `tests/` directory yet is an empty suite, not an error.
        if (notFound(e)) return []
        throw e
      }
    },
    enabled,
    retry: false,
  })
}

export function usePerfTest(suite: SuiteRepo | undefined, name: string | null) {
  const enabled = Boolean(suite?.exists && name)
  return useQuery<PerfTest>({
    queryKey: ['perf', 'test', suite?.org, suite?.repo, name],
    queryFn: async () => {
      const [script, config] = await Promise.all([
        readFile(suite!, scriptPath(name!)),
        readFile(suite!, configPath(name!)),
      ])
      const configRaw = config?.text ?? ''
      return {
        name: name!,
        script: script?.text ?? '',
        scriptSha: script?.sha,
        configSha: config?.sha,
        configRaw,
        config: parseConfig(configRaw, name!),
      }
    },
    enabled,
    retry: false,
  })
}

async function readFile(
  suite: SuiteRepo,
  path: string,
): Promise<{ text: string; sha?: string } | null> {
  try {
    const f = await giteaClient.getFile(suite.org, suite.repo, suite.defaultBranch, path)
    return { text: decode(f.content, f.encoding), sha: f.sha }
  } catch (e) {
    if (notFound(e)) return null
    throw e
  }
}

export interface SaveTestInput {
  name: string
  script?: string
  config?: PerfTestConfig
  /** Shas of the versions being replaced; omit for a new file. */
  scriptSha?: string
  configSha?: string
  message?: string
}

/**
 * Commit a test.
 *
 * Script and config are written as separate commits because Gitea's contents
 * API writes one file per call. They are sequenced rather than parallel so a
 * failure leaves the repository in the more useful half-state: the script
 * saved, the config not, rather than a config describing a script that was
 * never written.
 */
export function useSavePerfTest(suite: SuiteRepo | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: SaveTestInput) => {
      if (!suite?.exists) throw new Error('The performance suite repository does not exist yet.')
      const message = input.message ?? `perf: update ${input.name}`
      let commit: string | undefined

      if (input.script !== undefined) {
        const res = await giteaClient.saveFile(suite.org, suite.repo, suite.defaultBranch, scriptPath(input.name), {
          content: b64(input.script),
          message: `${message} (${SCRIPT_FILE})`,
          sha: input.scriptSha,
        })
        commit = res.commit?.sha
      }
      if (input.config !== undefined) {
        const res = await giteaClient.saveFile(suite.org, suite.repo, suite.defaultBranch, configPath(input.name), {
          content: b64(serialiseConfig(input.config)),
          message: `${message} (${CONFIG_FILE})`,
          sha: input.configSha,
        })
        commit = res.commit?.sha ?? commit
      }
      return { commit }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['perf'] }),
  })
}

export function useCreatePerfTest(suite: SuiteRepo | undefined) {
  const save = useSavePerfTest(suite)
  return useMutation({
    mutationFn: async (input: { name: string; starter: Starter; namespace: string }) => {
      const config: PerfTestConfig = {
        ...DEFAULT_CONFIG,
        ...input.starter.config(input.name),
        title: input.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
        namespace: input.namespace,
      }
      await save.mutateAsync({
        name: input.name,
        script: input.starter.script(input.name),
        config,
        message: `perf: add ${input.name} from the ${input.starter.label.toLowerCase()} starter`,
      })
      return input.name
    },
  })
}

/** Delete both files. Gitea has no directory delete; the dir goes when empty. */
export function useDeletePerfTest(suite: SuiteRepo | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (name: string) => {
      if (!suite?.exists) return
      for (const path of [scriptPath(name), configPath(name)]) {
        try {
          const f = await giteaClient.getFile(suite.org, suite.repo, suite.defaultBranch, path)
          await giteaClient.deleteFile(suite.org, suite.repo, suite.defaultBranch, path, {
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

/** Commits touching one test — the provenance behind every result. */
export function usePerfTestHistory(suite: SuiteRepo | undefined, name: string | null) {
  const enabled = Boolean(suite?.exists && name)
  return useQuery({
    queryKey: ['perf', 'history', suite?.org, suite?.repo, name],
    queryFn: async () => {
      const commits = await giteaClient.listCommits(suite!.org, suite!.repo, suite!.defaultBranch, 30)
      // Gitea's commit list cannot be filtered by path through this client, so
      // match on the message the console writes. A hand-made commit simply
      // does not appear here; it still shows in Gitea.
      return commits.filter((c) => (c.commit?.message ?? '').includes(name!))
    },
    enabled,
    retry: false,
  })
}

/* ─────────────────────────── launching ─────────────────────────── */

const CONFIG_MAPS = { group: '', version: 'v1', resource: 'configmaps', namespaced: true }
const TEST_RUNS = { group: 'k6.io', version: 'v1alpha1', resource: 'testruns', namespaced: true }

/** `checkout-load` → `k6-checkout-load`, the generated ConfigMap. */
export const scriptConfigMapName = (test: string) => `k6-${test}`.slice(0, 253)

/**
 * Run a committed test.
 *
 * Two objects, in order:
 *   1. a ConfigMap holding the script exactly as committed, and
 *   2. a TestRun pointing at it.
 *
 * Both carry the test name and the commit sha as labels. That is the whole
 * point of routing through git: a month later, a result still says which
 * script produced it, and the script is still there to read.
 */
export function useRunPerfTest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { test: PerfTest; commit?: string; runName?: string }) => {
      const { test } = input
      const ns = test.config.namespace || 'default'
      const commit = (input.commit ?? '').slice(0, 40)
      const cmName = scriptConfigMapName(test.name)

      await kube.apply({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: cmName,
          namespace: ns,
          labels: {
            [LABEL_MANAGED]: 'adhar-console',
            [LABEL_TEST]: test.name,
            ...(commit ? { [LABEL_COMMIT]: commit.slice(0, 63) } : {}),
          },
        },
        data: { [SCRIPT_FILE]: test.script },
      })

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
            ...(commit ? { [LABEL_COMMIT]: commit.slice(0, 63) } : {}),
          },
        },
        spec: {
          parallelism: test.config.parallelism,
          script: { configMap: { name: cmName, file: SCRIPT_FILE } },
          // The CRD defaults `paused` to the STRING "true", so a TestRun
          // created without it never leaves `initialization` — "Run test"
          // produced a run that sat there forever with no explanation. Say
          // "false" explicitly; pausing stays a deliberate act in the drawer.
          paused: 'false',
          ...(test.config.arguments ? { arguments: test.config.arguments } : {}),
          cleanup: 'post',
          ...(Object.keys(test.config.env).length
            ? {
              runner: {
                env: Object.entries(test.config.env).map(([name, value]) => ({ name, value })),
              },
            }
            : {}),
        },
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
