import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useOptionalUser } from '@adhar/shell-ui'
import { k8s } from '@adhar/api-clients'
import { kube } from '@adhar/api-clients/k8s'
import { finishedAt, isRunning, type TestRun, useTestRuns } from './k6.ts'
import { LABEL_APPLICATION, LABEL_COMMIT, LABEL_TEST, type PerfTestConfig } from './perf-format.ts'
import {
  baselineFromRecord,
  evaluateGate,
  type GateVerdict,
  overview,
  type Overview,
} from './perf-gate.ts'
import {
  ANN_HARVESTED,
  extractSummary,
  joinRunnerSummaries,
  LABEL_RESULT,
  LABEL_RUNNER,
  LABEL_SCHEDULE,
  LABEL_TRIGGER,
  recordFromConfigMap,
  resultConfigMap,
  type RunRecord,
  sortRecords,
  type Trigger,
} from './perf-results.ts'
import {
  artefactConfigMap,
  cronJobManifest,
  manualJobFromSchedule,
  type PerfSchedule,
  runnerRbac,
  scheduleFromCronJob,
  type ScheduleInput,
} from './perf-runner.ts'
import {
  fetchPerfTest,
  fetchPerfTestConfig,
  type PerfTest,
  type SuiteRepo,
  usePerfTests,
  useSavePerfTest,
  useSuiteRepo,
} from './perf-suite.ts'

/**
 * The automation layer: results history, schedules, baselines and the
 * harvester, all stored on the cluster or in git — never in the browser.
 *
 *   results    ConfigMaps `k6-result-<run>`        (cluster, per namespace)
 *   schedules  CronJobs labelled adhar.io/perf-schedule (cluster)
 *   gates      `gate` in tests/<name>/test.json      (git)
 *   baselines  `baseline` in tests/<name>/test.json  (git)
 *
 * Everyone looking at the console therefore sees the same history and the
 * same verdicts, and an unattended CronJob or CI step reads exactly what the
 * page shows.
 */

const client = k8s.K8sClient.auto()

const CONFIG_MAPS: k8s.GVR = { group: '', version: 'v1', resource: 'configmaps', namespaced: true }
const CRON_JOBS: k8s.GVR = { group: 'batch', version: 'v1', resource: 'cronjobs', namespaced: true }
const TEST_RUNS: k8s.GVR = { group: 'k6.io', version: 'v1alpha1', resource: 'testruns', namespaced: true }

/* ─────────────────────────── results ─────────────────────────── */

export function useRunRecords() {
  return useQuery<RunRecord[]>({
    queryKey: ['perf', 'results'],
    queryFn: async () => {
      const res = await kube.list<Parameters<typeof recordFromConfigMap>[0]>(CONFIG_MAPS, {
        labelSelector: `${LABEL_RESULT}=true`,
        limit: 2000,
      })
      return sortRecords((res.items ?? []).flatMap((cm) => {
        const r = recordFromConfigMap(cm)
        return r ? [r] : []
      }))
    },
    refetchInterval: 30_000,
    retry: false,
  })
}

export function deleteRunRecord(r: RunRecord): Promise<unknown> {
  return kube.delete(CONFIG_MAPS, r.namespace, r.resultName)
}

/** Every test's `test.json`, keyed by name — the gates and baselines verdicts need. */
export function usePerfTestConfigs(suite: SuiteRepo | undefined, names: string[]) {
  const results = useQueries({
    queries: names.map((name) => ({
      queryKey: ['perf', 'test-config', suite?.org, suite?.repo, name],
      queryFn: () => fetchPerfTestConfig(suite!, name),
      enabled: Boolean(suite?.exists),
      staleTime: 30_000,
      retry: false,
    })),
  })
  const key = results.map((r) => r.dataUpdatedAt).join(',')
  return useMemo(() => {
    const out = new Map<string, PerfTestConfig>()
    names.forEach((n, i) => {
      const c = results[i]?.data
      if (c) out.set(n, c)
    })
    return out
    // `results` is a new array every render; its timestamps say when it changed.
  }, [names, key])
}

export function verdictFor(r: RunRecord, config: PerfTestConfig | undefined): GateVerdict {
  return evaluateGate({
    metrics: r.metrics,
    stage: r.stage,
    exitCode: r.exitCode,
    gate: config?.gate,
    // A run is never a regression against itself.
    baseline: config?.baseline && config.baseline.run !== r.run ? config.baseline : undefined,
  })
}

export interface PerfInsights {
  suite?: SuiteRepo
  tests: string[]
  records: RunRecord[]
  configs: Map<string, PerfTestConfig>
  schedules: PerfSchedule[]
  verdictOf(r: RunRecord): GateVerdict
  overview: Overview
  loading: boolean
  /** Set when the result ConfigMaps could not be listed — figures from them are unknown, not zero. */
  recordsError?: unknown
  refetchRecords(): void
}

/** Everything the overview, results and trends views share, computed once. */
export function usePerfInsights(): PerfInsights {
  const suite = useSuiteRepo().data
  const testsQ = usePerfTests(suite)
  const recordsQ = useRunRecords()
  const schedulesQ = usePerfSchedules()
  const records = useMemo(() => recordsQ.data ?? [], [recordsQ.data])
  const names = useMemo(() => {
    const set = new Set(testsQ.data ?? [])
    for (const r of records) set.add(r.test)
    return [...set].sort()
  }, [testsQ.data, records])
  const configs = usePerfTestConfigs(suite, names)

  return useMemo(() => {
    const cache = new Map<string, GateVerdict>()
    const verdictOf = (r: RunRecord) => {
      const k = `${r.namespace}/${r.resultName}`
      let v = cache.get(k)
      if (!v) {
        v = verdictFor(r, configs.get(r.test))
        cache.set(k, v)
      }
      return v
    }
    return {
      suite,
      tests: testsQ.data ?? [],
      records,
      configs,
      schedules: schedulesQ.data ?? [],
      verdictOf,
      overview: overview(records, verdictOf, Date.now()),
      loading: recordsQ.isLoading,
      recordsError: recordsQ.error ?? undefined,
      refetchRecords: () => void recordsQ.refetch(),
    }
  }, [suite, testsQ.data, records, configs, schedulesQ.data, recordsQ.isLoading, recordsQ.error, recordsQ.refetch])
}

/* ─────────────────────────── the harvester ─────────────────────────── */

const TERMINAL = new Set(['finished', 'error', 'stopped'])

/**
 * Runs the console launched itself, finished, and not yet kept.
 *
 * Runs started by the in-cluster runner (schedules, CI) are labelled
 * `adhar.io/perf-runner=job` and harvested by that runner; the console
 * leaving them alone is what stops the two from racing.
 */
export function needsHarvest(run: TestRun): boolean {
  const labels = run.metadata.labels ?? {}
  if (!labels[LABEL_TEST] || labels[LABEL_RUNNER] === 'job') return false
  if (run.metadata.annotations?.[ANN_HARVESTED]) return false
  if (isRunning(run)) return false
  return TERMINAL.has(run.status?.stage ?? '')
}

export async function harvestRun(run: TestRun): Promise<string> {
  const ns = run.metadata.namespace ?? 'default'
  const name = run.metadata.name
  const labelled = await client.listPods(undefined, ns, `k6_cr=${name}`)
  const pods = (labelled.length ? labelled : (await client.listPods(undefined, ns)).filter((p) => p.metadata.name.startsWith(`${name}-`)))
    .filter((p) => !p.metadata.name.includes('-initializer') && !p.metadata.name.includes('-starter'))
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name, undefined, { numeric: true }))

  const parts: Array<{ pod: string; summary: string }> = []
  let exitCode = 0
  for (const p of pods) {
    const log = await kube.logStream(ns, p.metadata.name, { tailLines: 4000 }).catch(() => '')
    parts.push({ pod: p.metadata.name, summary: extractSummary(log) })
    const code = Number(
      (p.status.containerStatuses?.[0]?.state as { terminated?: { exitCode?: number } } | undefined)?.terminated?.exitCode,
    )
    if (code === 99) exitCode = 99
    else if (Number.isFinite(code) && code !== 0 && exitCode === 0) exitCode = code
  }

  const labels = run.metadata.labels ?? {}
  const cm = resultConfigMap({
    run: name,
    test: labels[LABEL_TEST],
    namespace: ns,
    summaryText: joinRunnerSummaries(parts),
    trigger: (labels[LABEL_TRIGGER] as Trigger) || 'console',
    commit: labels[LABEL_COMMIT],
    startedAt: run.metadata.creationTimestamp,
    finishedAt: finishedAt(run),
    stage: run.status?.stage,
    exitCode,
    parallelism: run.spec?.parallelism,
    application: labels[LABEL_APPLICATION],
  })
  await kube.apply(cm)
  await kube.patch(TEST_RUNS, ns, name, { metadata: { annotations: { [ANN_HARVESTED]: cm.metadata.name } } }, 'merge')
  return cm.metadata.name
}

/**
 * Keep the result of every console-launched run that finishes while the page
 * is open — and of any that finished while nobody was looking, as long as
 * their pods still exist (they do: console runs no longer use
 * `cleanup: post`).
 */
export function useHarvester(enabled = true) {
  const runs = useTestRuns(enabled)
  const qc = useQueryClient()
  const inFlight = useRef(new Set<string>())
  const candidates = useMemo(() => (runs.data ?? []).filter(needsHarvest), [runs.data])

  useEffect(() => {
    if (!enabled) return
    for (const run of candidates) {
      const key = `${run.metadata.namespace}/${run.metadata.name}`
      if (inFlight.current.has(key)) continue
      inFlight.current.add(key)
      harvestRun(run)
        .then(() => {
          void qc.invalidateQueries({ queryKey: ['perf', 'results'] })
          void qc.invalidateQueries({ queryKey: ['k6'] })
        })
        // A run whose pods are unreadable is retried on the next refresh.
        .catch(() => inFlight.current.delete(key))
    }
  }, [candidates, enabled, qc])
}

/** Finished runs whose result is already kept — safe to delete. */
export function harvestedRuns(runs: TestRun[]): TestRun[] {
  return runs.filter((r) => !isRunning(r) && Boolean(r.metadata.annotations?.[ANN_HARVESTED]))
}

/* ─────────────────────────── the artefact ─────────────────────────── */

/** Write `k6-<test>` — script, TestRun template, gate and runner — to the cluster. */
export function materialiseArtefact(test: { name: string; config: PerfTestConfig; script: string }, commit?: string) {
  return kube.apply(artefactConfigMap({ test: test.name, config: test.config, script: test.script, commit }))
}

/** ServiceAccount, Role and RoleBinding the runner uses, in the test namespace. */
export async function ensureRunner(namespace: string) {
  for (const obj of runnerRbac(namespace)) await kube.apply(obj as Parameters<typeof kube.apply>[0])
}

/** Make a test runnable unattended: RBAC plus a fresh artefact. */
export function useInstallRunner() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (test: PerfTest) => {
      await ensureRunner(test.config.namespace || 'default')
      await materialiseArtefact(test, test.scriptSha)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['perf', 'artefact'] }),
  })
}

/** Whether the runner can already run this test unattended, for the CI tab. */
export function useRunnerStatus(test: PerfTest | undefined) {
  const ns = test?.config.namespace || 'default'
  return useQuery({
    queryKey: ['perf', 'artefact', ns, test?.name],
    queryFn: async () => {
      const [cm, sa] = await Promise.all([
        kube.get<{ data?: Record<string, string> }>(CONFIG_MAPS, ns, `k6-${test!.name}`).catch(() => null),
        kube.get({ group: '', version: 'v1', resource: 'serviceaccounts', namespaced: true }, ns, 'adhar-perf-runner')
          .then(() => true)
          .catch(() => false),
      ])
      return { artefact: Boolean(cm?.data?.['run.sh']), serviceAccount: sa }
    },
    enabled: Boolean(test),
    retry: false,
  })
}

/* ─────────────────────────── baselines ─────────────────────────── */

/**
 * Pin a run as the test's baseline: a commit to test.json, so who moved the
 * baseline and when is in git, and the scheduled runner picks it up through
 * the refreshed artefact.
 */
export function usePinBaseline() {
  const suite = useSuiteRepo().data
  const save = useSavePerfTest(suite)
  const user = useOptionalUser()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: { record: RunRecord } | { test: string; unpin: true }) => {
      if (!suite?.exists) throw new Error('The performance suite repository does not exist yet.')
      const name = 'record' in input ? input.record.test : input.test
      const test = await fetchPerfTest(suite, name)
      const config: PerfTestConfig = { ...test.config }
      if ('record' in input) {
        if (!input.record.metrics) throw new Error('That run has no results to compare against.')
        config.baseline = baselineFromRecord(input.record, new Date().toISOString(), user?.email || user?.name)
      } else {
        delete config.baseline
      }
      const res = await save.mutateAsync({
        name,
        config,
        configSha: test.configSha,
        message: 'record' in input
          ? `perf: pin ${input.record.run} as the ${name} baseline`
          : `perf: unpin the ${name} baseline`,
      })
      // Best effort: the gate in git is already right; the cluster copy
      // catches up on the next run if this fails.
      await materialiseArtefact({ ...test, config }, test.scriptSha).catch(() => undefined)
      return res
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['perf'] }),
  })
}

/* ─────────────────────────── schedules ─────────────────────────── */

export function usePerfSchedules() {
  return useQuery<PerfSchedule[]>({
    queryKey: ['perf', 'schedules'],
    queryFn: async () => {
      const res = await kube.list<Parameters<typeof scheduleFromCronJob>[0]>(CRON_JOBS, {
        labelSelector: LABEL_SCHEDULE,
        limit: 500,
      })
      return (res.items ?? [])
        .flatMap((cj) => {
          const s = scheduleFromCronJob(cj)
          return s ? [s] : []
        })
        .sort((a, b) => a.test.localeCompare(b.test) || a.name.localeCompare(b.name))
    },
    refetchInterval: 30_000,
    retry: false,
  })
}

/**
 * Create or update a schedule: RBAC, a fresh artefact from the committed
 * test, then the CronJob — in that order, so the first fire never finds
 * something missing.
 */
export function useSaveSchedule() {
  const suite = useSuiteRepo().data
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: ScheduleInput) => {
      if (!suite?.exists) throw new Error('The performance suite repository does not exist yet.')
      const test = await fetchPerfTest(suite, input.test)
      if (!test.script) throw new Error(`tests/${input.test}/script.js is empty or missing.`)
      // The schedule runs in the test's namespace — the artefact lives there.
      const namespace = test.config.namespace || 'default'
      await ensureRunner(namespace)
      await materialiseArtefact(test, test.scriptSha)
      await kube.apply(cronJobManifest({ ...input, namespace }) as Parameters<typeof kube.apply>[0])
      return { ...input, namespace }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['perf'] }),
  })
}

export function useScheduleActions() {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['perf'] })
  const setSuspended = useMutation({
    mutationFn: (input: { schedule: PerfSchedule; suspend: boolean }) =>
      kube.patch(CRON_JOBS, input.schedule.namespace, input.schedule.name, { spec: { suspend: input.suspend } }, 'merge'),
    onSuccess: done,
  })
  const remove = useMutation({
    mutationFn: (s: PerfSchedule) => kube.delete(CRON_JOBS, s.namespace, s.name, { propagationPolicy: 'Background' }),
    onSuccess: done,
  })
  const runNow = useMutation({
    mutationFn: (s: PerfSchedule) => {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      const stamp = `${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
      return kube.apply(manualJobFromSchedule(s, stamp) as Parameters<typeof kube.apply>[0])
    },
    onSuccess: () => {
      void done()
      void qc.invalidateQueries({ queryKey: ['k6'] })
    },
  })
  return { setSuspended, remove, runNow }
}
