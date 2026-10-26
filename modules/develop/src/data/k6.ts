import { useQuery } from '@tanstack/react-query'
import { useLiveRefetch, useWatchSignal } from '@adhar/shell-ui'
import { k8s } from '@adhar/api-clients'
import { kube } from '@adhar/api-clients/k8s'
import { rerunName } from './k6-summary.ts'
import { LABEL_TEST } from './perf-format.ts'
import { LABEL_RUNNER, LABEL_SCHEDULE, LABEL_TRIGGER } from './perf-results.ts'
import { withPinnedImages } from './k6-images.ts'
import { withTrendStats } from './k6-trend-stats.ts'

// The pure half — parser, naming, formatting — lives next door so it can be
// tested without React. Re-exported here so views have one import.
export {
  durationSecs,
  fmtDuration,
  HEADLINE_METRICS,
  type K6Metric,
  type K6Summary,
  type K6Threshold,
  parseK6Summary,
  rerunName,
} from './k6-summary.ts'

/**
 * k6 — the platform's load and API performance testing.
 *
 * The k6 operator turns a `TestRun` into a fan-out of Kubernetes Jobs: one
 * initializer that parses the script and splits the work, then `parallelism`
 * runner pods that execute their slice, then a starter that releases them all
 * at once so the load actually arrives together. That shape is why this view
 * is built around the runner pods and not just the CR: the CR tells you which
 * stage the test is in, and the pods are where the numbers are.
 *
 * Reads go through `K8sClient`; writes — create, pause, resume, delete — go
 * through the `kube` gateway, the same path the other cluster views use.
 *
 * There is no results database. k6 prints its end-of-test summary to the
 * runner's stdout, and unless the test is configured to remote-write to
 * Prometheus that summary IS the result. So the summary is parsed out of the
 * logs rather than invented or approximated — see `parseK6Summary`.
 */

const client = k8s.K8sClient.auto()

export const TEST_RUNS_GVR: k8s.GVR = {
  group: 'k6.io',
  version: 'v1alpha1',
  resource: 'testruns',
  namespaced: true,
}

export const PRIVATE_LOAD_ZONES_GVR: k8s.GVR = {
  group: 'k6.io',
  version: 'v1alpha1',
  resource: 'privateloadzones',
  namespaced: true,
}

const CONFIG_MAPS_GVR: k8s.GVR = { group: '', version: 'v1', resource: 'configmaps', namespaced: true }

/* ─────────── types ─────────── */

export interface ObjMeta {
  name: string
  namespace?: string
  uid?: string
  creationTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
}

/**
 * `status.stage` from the CRD, in the order the operator moves through them.
 * `stopped` is a test that was asked to stop; `error` is the operator failing
 * to run it at all, which is NOT the same as a test whose thresholds failed —
 * a test can finish perfectly well and still be a failure to the people who
 * wrote the thresholds. That distinction is the whole reason `outcome` below
 * exists separately from `stage`.
 */
export type TestRunStage =
  | 'initialization'
  | 'initialized'
  | 'created'
  | 'started'
  | 'stopped'
  | 'finished'
  | 'error'

export const STAGE_ORDER: TestRunStage[] = [
  'initialization',
  'initialized',
  'created',
  'started',
  'finished',
]

export interface TestRunCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason: string
  message: string
  lastTransitionTime: string
}

export interface TestRun {
  apiVersion?: string
  kind?: string
  metadata: ObjMeta
  spec?: {
    parallelism?: number
    paused?: string | boolean
    arguments?: string
    cleanup?: string
    separate?: boolean
    quiet?: string
    testRunId?: string
    script?: {
      configMap?: { name: string; file?: string }
      volumeClaim?: { name: string; file?: string; readOnly?: boolean }
      localFile?: string
    }
    runner?: Record<string, unknown>
  }
  status?: {
    stage?: TestRunStage
    testRunId?: string
    aggregationVars?: string
    conditions?: TestRunCondition[]
  }
}

export interface PodRef {
  name: string
  phase?: string
  role: 'initializer' | 'starter' | 'runner'
  startedAt?: string
}

/* ─────────── errors ─────────── */

export function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404
}

/** A 404 listing a CRD path means the k6 operator isn't installed. */
export const isCrdMissing = isNotFound

/* ─────────── reads ─────────── */

export function useTestRuns(enabled = true) {
  const queryKey = ['k6', 'testruns', 'all']
  return useQuery({
    queryKey,
    queryFn: async () => (await client.listGeneric(undefined, TEST_RUNS_GVR)) as unknown as TestRun[],
    // A load test's interesting window is minutes, and the stage transitions
    // are what people watch — the apiserver watch pushes them as they happen.
    refetchInterval: useLiveRefetch(TEST_RUNS_GVR, [queryKey], 60_000, enabled),
    enabled,
    retry: false,
  })
}

export function useTestRun(namespace: string | undefined, name: string | undefined) {
  const enabled = Boolean(namespace && name)
  const queryKey = ['k6', 'testrun', namespace, name]
  return useQuery({
    queryKey,
    queryFn: async () =>
      (await client.getGeneric(undefined, TEST_RUNS_GVR, namespace, name!)) as unknown as TestRun,
    // Same watch params as `useTestRuns`, so the list and the drawer share one
    // upstream apiserver watch; a short throttle so stage changes of the run
    // being watched land within a couple of seconds.
    refetchInterval: useWatchSignal(TEST_RUNS_GVR, [queryKey], { enabled, fallbackMs: 60_000, throttleMs: 1_500 }),
    enabled,
    retry: false,
  })
}

export function usePrivateLoadZones(enabled = true) {
  const queryKey = ['k6', 'privateloadzones', 'all']
  return useQuery({
    queryKey,
    queryFn: async () =>
      (await client.listGeneric(undefined, PRIVATE_LOAD_ZONES_GVR)) as unknown as Array<{ metadata: ObjMeta; spec?: Record<string, unknown> }>,
    refetchInterval: useLiveRefetch(PRIVATE_LOAD_ZONES_GVR, [queryKey], 60_000, enabled),
    enabled,
    retry: false,
  })
}

/**
 * The pods the operator created for one test run.
 *
 * `k6_cr=<name>` is the label the operator stamps on every Job it creates for
 * a TestRun. The name-prefix fallback exists because that label is the
 * operator's private contract, not an API guarantee: if a future version
 * renames it the view degrades to matching `<run>-initializer` / `<run>-N`
 * rather than showing an empty pod list and looking broken.
 */
export function useTestRunPods(run: TestRun | undefined) {
  const namespace = run?.metadata.namespace
  const name = run?.metadata.name
  const enabled = Boolean(namespace && name)
  const queryKey = ['k6', 'testrun-pods', namespace, name]
  return useQuery({
    queryKey,
    queryFn: async (): Promise<PodRef[]> => {
      const labelled = await client.listPods(undefined, namespace, `k6_cr=${name}`)
      const pods = labelled.length
        ? labelled
        : (await client.listPods(undefined, namespace)).filter((p) =>
          p.metadata.name.startsWith(`${name}-`)
        )
      return pods
        .map((p): PodRef => ({
          name: p.metadata.name,
          phase: p.status.phase,
          role: p.metadata.name.includes('-initializer')
            ? 'initializer'
            : p.metadata.name.includes('-starter')
            ? 'starter'
            : 'runner',
          startedAt: p.metadata.creationTimestamp,
        }))
        .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name, undefined, { numeric: true }))
    },
    refetchInterval: useLiveRefetch(
      enabled ? { group: '', version: 'v1', resource: 'pods', namespace, labelSelector: `k6_cr=${name}` } : null,
      [queryKey],
      60_000,
      enabled,
    ),
    enabled,
    retry: false,
  })
}

const ROLE_ORDER: Record<PodRef['role'], number> = { initializer: 0, starter: 1, runner: 2 }

/**
 * ConfigMaps that could hold a k6 script.
 *
 * A TestRun points at a ConfigMap key, so "which scripts can I run" is
 * answerable from the cluster without a registry: any ConfigMap with a `.js`
 * or `.ts` key is a candidate. Filtering on the key rather than on a naming
 * convention means a script someone created by hand shows up too.
 *
 * Goes through `kube.list` rather than `client.listConfigMaps`, because the
 * latter returns the narrowed `Generic` shape and `data` — the only field
 * that matters here — is not on it.
 */
export function useScriptConfigMaps(namespace: string | undefined, enabled = true) {
  const queryKey = ['k6', 'script-configmaps', namespace]
  return useQuery({
    queryKey,
    queryFn: async () => {
      const res = await kube.list<{ metadata: ObjMeta; data?: Record<string, string> }>(
        CONFIG_MAPS_GVR,
        { namespace, limit: 500 },
      )
      return (res.items ?? [])
        .map((m) => ({
          name: m.metadata.name,
          namespace: m.metadata.namespace,
          files: Object.keys(m.data ?? {}).filter((k) => k.endsWith('.js') || k.endsWith('.ts')),
        }))
        .filter((m) => m.files.length > 0)
    },
    refetchInterval: false,
    enabled,
    retry: false,
  })
}

/* ─────────── writes ─────────── */

export interface NewTestRun {
  name: string
  namespace: string
  configMap: string
  file: string
  parallelism: number
  arguments?: string
  /** Start paused so the run can be released deliberately. */
  paused?: boolean
}

/**
 * The k6 source a run points at, best effort — `withTrendStats` reads it to
 * leave a script that sets its own `summaryTrendStats` alone.
 */
async function scriptSource(namespace: string | undefined, cm: { name: string; file?: string } | undefined): Promise<string | undefined> {
  if (!namespace || !cm?.name) return undefined
  const obj = await kube.get<{ data?: Record<string, string> }>(CONFIG_MAPS_GVR, namespace, cm.name).catch(() => null)
  return cm.file ? obj?.data?.[cm.file] : undefined
}

export async function createTestRun(input: NewTestRun): Promise<TestRun> {
  const script = await scriptSource(input.namespace, { name: input.configMap, file: input.file })
  return kube.apply<TestRun>({
    apiVersion: 'k6.io/v1alpha1',
    kind: 'TestRun',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'adhar-console',
        // A ConfigMap script has no test.json, so its history is grouped by
        // the script: without a test label the harvester never kept the
        // result and the run had no report once its pods were gone.
        [LABEL_TEST]: scriptTestName(input.configMap),
        [LABEL_TRIGGER]: 'console',
      },
    },
    spec: withTrendStats(withPinnedImages({
      parallelism: input.parallelism,
      script: { configMap: { name: input.configMap, file: input.file } },
      ...(input.arguments ? { arguments: input.arguments } : {}),
      // The CRD types `paused` as a string, not a boolean, AND defaults it to
      // "true" — so leaving it out does not mean "start now", it means the run
      // never leaves `initialization`. Always state it.
      paused: input.paused ? 'true' : 'false',
      // No `cleanup: 'post'`: the operator would delete the TestRun and its
      // runner pods the moment the run finished — before the harvester could
      // keep its summary. Harvested runs are cleared from the Runs tab.
    }), { script }),
  })
}

/**
 * A rerun's labels: the original's, but started from the console — so the
 * console harvests it (a rerun of a scheduled run copied `perf-runner=job`
 * and nobody kept its result) — and grouped under a test even when the
 * original predates ConfigMap runs being labelled.
 */
function rerunLabels(run: TestRun): Record<string, string> {
  const labels: Record<string, string> = { ...(run.metadata.labels ?? {}) }
  delete labels[LABEL_RUNNER]
  delete labels[LABEL_SCHEDULE]
  labels[LABEL_TRIGGER] = 'console'
  const cm = run.spec?.script?.configMap?.name
  if (!labels[LABEL_TEST] && cm) labels[LABEL_TEST] = scriptTestName(cm)
  labels['adhar.io/rerun-of'] = run.metadata.name
  return labels
}

/**
 * A rerun's spec: the original's, minus `cleanup: post` — runs created before
 * the console stopped asking for it were deleted with their pods the moment
 * they finished, so their result was never kept.
 */
function rerunSpec(spec: TestRun['spec']): Record<string, unknown> {
  const { cleanup, ...rest } = spec ?? {}
  return cleanup && cleanup !== 'post' ? { ...rest, cleanup } : rest
}

/** `k6-checkout-load` → `checkout-load`: the test a ConfigMap script's results are kept under. */
export function scriptTestName(configMap: string): string {
  return configMap.replace(/^k6-/, '').slice(0, 63).replace(/[^a-z0-9A-Z._-]/g, '-').replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '') || 'script'
}

export function setTestRunPaused(namespace: string, name: string, paused: boolean): Promise<unknown> {
  return kube.patch(TEST_RUNS_GVR, namespace, name, { spec: { paused: paused ? 'true' : 'false' } }, 'merge')
}

export function deleteTestRun(namespace: string, name: string): Promise<unknown> {
  return kube.delete(TEST_RUNS_GVR, namespace, name)
}

/**
 * Re-run: a TestRun is immutable once the operator has claimed it, so "run it
 * again" means a new object with the same spec and a fresh name.
 */
export async function rerunTestRun(run: TestRun): Promise<TestRun> {
  const script = await scriptSource(run.metadata.namespace, run.spec?.script?.configMap)
  return kube.apply<TestRun>({
    apiVersion: 'k6.io/v1alpha1',
    kind: 'TestRun',
    metadata: {
      name: rerunName(run.metadata.name),
      namespace: run.metadata.namespace,
      labels: rerunLabels(run),
    },
    // "Run again" means run it, so a rerun of a paused run starts. Copying
    // the spec verbatim reproduced the pause along with everything else.
    // Re-pinned, so a rerun of a run created before images were pinned does
    // not repeat its `:latest` denial (k6-images.ts).
    // And asked for p(99) (k6-trend-stats.ts), so a rerun of an old run
    // records the percentile its original did not.
    spec: withTrendStats(withPinnedImages({ ...rerunSpec(run.spec), paused: 'false' }), { script }),
  })
}
/* ─────────── derivations ─────────── */

export function isRunning(run: TestRun): boolean {
  const stage = run.status?.stage
  return stage === 'initialization' || stage === 'initialized' || stage === 'created' || stage === 'started'
}

export function isPaused(run: TestRun): boolean {
  return String(run.spec?.paused ?? '') === 'true'
}

/** When the run reached its current stage, for a duration that means something. */
export function finishedAt(run: TestRun): string | undefined {
  if (isRunning(run)) return undefined
  const times = (run.status?.conditions ?? []).map((c) => c.lastTransitionTime).filter(Boolean)
  if (!times.length) return undefined
  return times.sort().at(-1)
}
