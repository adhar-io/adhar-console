import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Field,
  Input,
  LogConsole,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatusBadge,
  useCan,
  useLogStream,
  useOverlayDismiss,
  useToast,
  type Column,
  type StatusKind,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import { CrdMissing } from '../components/crd-missing.tsx'
import { PerfSuite } from './perf-suite.tsx'
import { PerfReport } from './perf-report.tsx'
import { LiveCharts, StageRail } from './perf-run-live.tsx'
import { PerfOverview } from './perf-overview.tsx'
import { PerfDashboard } from './perf-dashboard.tsx'
import { QuickTestModal } from './perf-quick.tsx'
import { useDevelopParams, useSetDevelopParams } from '../data/nav.ts'
import { ResultsView } from './perf-results.tsx'
import { SchedulesView } from './perf-schedules.tsx'
import { harvestedRuns, useHarvester, usePerfInsights } from '../data/perf-automation.ts'
import { DEFAULT_CONFIG, LABEL_COMMIT, LABEL_TEST } from '../data/perf-format.ts'
import { usePerfTest, useSuiteRepo } from '../data/perf-suite.ts'
import {
  createTestRun,
  deleteTestRun,
  durationSecs,
  finishedAt,
  fmtDuration,
  HEADLINE_METRICS,
  isCrdMissing,
  isPaused,
  isRunning,
  parseK6Summary,
  rerunTestRun,
  setTestRunPaused,
  STAGE_ORDER,
  useScriptConfigMaps,
  useTestRun,
  useTestRunPods,
  useTestRuns,
  type K6Summary,
  type PodRef,
  type TestRun,
  type TestRunStage,
} from '../data/k6.ts'

/**
 * Performance Center — k6 load and API performance testing.
 *
 * The organising idea is that a load test has two separate verdicts and the
 * page must never conflate them:
 *
 *   • **Did it run?** — `status.stage`, owned by the operator. A test that
 *     never started is an infrastructure problem.
 *   • **Did it pass?** — the thresholds in the script, owned by whoever wrote
 *     it. A test can run perfectly and still fail, and that failure is the
 *     one people actually care about.
 *
 * The second verdict exists only in the runner's stdout, so the drawer parses
 * it out of the logs. When there is no summary yet the page says so rather
 * than rendering empty tables that look like a test with no results.
 */
type PerfTab = 'overview' | 'tests' | 'runs' | 'results' | 'schedules'

const PERF_TABS: Array<[PerfTab, string]> = [
  ['overview', 'Overview'],
  ['tests', 'Tests'],
  ['runs', 'Runs'],
  ['results', 'Results'],
  ['schedules', 'Schedules'],
]

export function Performance() {
  /*
   * "Overview" is the health of every test at a glance. "Tests" is the
   * authoring side — scripts, configuration and gates, in git. "Runs" is
   * what is happening on the cluster right now. "Results" is the kept
   * history every trend, baseline and verdict is computed from, and
   * "Schedules" is what runs unattended. The tab, the open test (`?suite=`)
   * and the open run (`?run=ns/name`) are in the URL, so every one of them
   * can be linked to.
   */
  const params = useDevelopParams()
  const setParams = useSetDevelopParams()
  const tab = (PERF_TABS.some(([id]) => id === params.view) ? params.view : 'overview') as PerfTab
  const setTab = (t: PerfTab) => setParams({ view: t === 'overview' ? undefined : t })
  const runs = useTestRuns()
  const insights = usePerfInsights()
  const selected = useMemo(() => {
    const i = params.run?.indexOf('/') ?? -1
    return params.run && i > 0 ? { namespace: params.run.slice(0, i), name: params.run.slice(i + 1) } : null
  }, [params.run])
  const openRun = (namespace: string, name: string) => setParams({ view: 'runs', run: `${namespace}/${name}` })
  const [creating, setCreating] = useState(false)
  const [quick, setQuick] = useState(false)
  const [newTestToken, setNewTestToken] = useState(0)
  const [resultsFor, setResultsFor] = useState<string | undefined>(undefined)
  const [scheduleFor, setScheduleFor] = useState<string | undefined>(undefined)
  const canCreate = useCan('develop')
  const crdMissing = runs.isError && isCrdMissing(runs.error)

  // Keep the result of every run the console started, as soon as it finishes.
  useHarvester(!crdMissing)

  const items = runs.data ?? []
  const inFlight = items.filter(isRunning).length

  const tabs = (
    <div className="flex flex-wrap items-center gap-2 border-b border-edge-default">
      <div className="-mb-px flex gap-1" role="tablist" aria-label="Performance Center">
        {PERF_TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id)
              if (id !== 'results') setResultsFor(undefined)
              if (id !== 'schedules') setScheduleFor(undefined)
            }}
            className={cn(
              'border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
              tab === id ? 'border-brand-600 text-content' : 'border-transparent text-content-muted hover:text-content',
            )}
          >
            {label}
            {id === 'runs' && inFlight ? <span className="ml-1.5 rounded-full bg-brand-600 px-1.5 text-[10px] tabular-nums text-white">{inFlight}</span> : null}
            {id === 'schedules' && insights.schedules.length
              ? <span className="ml-1.5 tabular-nums opacity-70">{insights.schedules.length}</span>
              : null}
          </button>
        ))}
      </div>
      {tab === 'runs' && canCreate && !crdMissing
        ? (
          <div className="ml-auto flex items-center gap-1.5 pb-1">
            <ClearFinished runs={items} />
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>Run a ConfigMap script</Button>
          </div>
        )
        : null}
    </div>
  )

  const drawer = selected
    ? <RunDrawer namespace={selected.namespace} name={selected.name} onClose={() => setParams({ run: undefined })} />
    : null

  return (
    <div className="space-y-4">
      <PageHeader
        title="Performance Center"
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => { runs.refetch() }} aria-label="Refresh" title="Refresh">↻</Button>
            {canCreate ? <Button size="sm" variant="secondary" onClick={() => { setTab('tests'); setNewTestToken((n) => n + 1) }}>New test</Button> : null}
            {canCreate ? <Button variant="primary" size="sm" onClick={() => setQuick(true)}>Quick test</Button> : null}
          </>
        }
      />
      <PerfOverview insights={insights} runs={items} />
      {tabs}

      {tab === 'overview'
        ? (
          <PerfDashboard
            insights={insights}
            runs={items}
            onOpenTest={(t) => setParams({ view: 'tests', suite: t })}
            onOpenRun={openRun}
            onOpenResults={(t) => {
              setResultsFor(t)
              setTab('results')
            }}
            onQuickTest={() => setQuick(true)}
          />
        )
        : tab === 'tests'
        ? (
          <PerfSuite
            selected={params.suite}
            onSelect={(t) => setParams({ suite: t })}
            createToken={newTestToken}
            onOpenRun={openRun}
            onOpenResults={(test) => {
              setResultsFor(test)
              setTab('results')
            }}
            onSchedule={(test) => {
              setScheduleFor(test)
              setTab('schedules')
            }}
          />
        )
        : tab === 'results'
        ? <ResultsView key={resultsFor ?? 'all'} insights={insights} initialTest={resultsFor} />
        : tab === 'schedules'
        ? <SchedulesView key={scheduleFor ?? 'list'} insights={insights} presetTest={scheduleFor} />
        : crdMissing
        ? (
          <CrdMissing
            tool="k6"
            href="https://grafana.com/docs/k6/latest/set-up/set-up-distributed-k6/"
            action={
              <span className="text-[12px] text-content-subtle">
                The platform ships k6 as an optional application — enable it in the stack to run load tests here.
              </span>
            }
          />
        )
        : (
          <div className="space-y-2">
            <div className="text-[12px] text-content-muted">
              Every k6 TestRun on the cluster. Click one for stages, runner pods and the end-of-test summary. Finished runs
              started from the console are kept under Results automatically.
            </div>
            <RunTable runs={items} loading={runs.isLoading} onSelect={(r) => openRun(r.namespace, r.name)} />
          </div>
        )}

      {drawer}
      {creating ? <NewRunDialog onClose={() => setCreating(false)} /> : null}
      <QuickTestModal
        open={quick}
        onClose={() => setQuick(false)}
        onSaved={(t) => {
          setQuick(false)
          setParams({ view: 'tests', suite: t })
        }}
        onStarted={(ns, run, t) => {
          setQuick(false)
          setParams({ view: 'runs', run: `${ns}/${run}`, suite: t })
        }}
      />
    </div>
  )
}

/**
 * Delete every finished TestRun whose result is already kept. Console runs
 * no longer clean themselves up (that would delete them before their result
 * could be harvested), so this is the tidy-up.
 */
function ClearFinished({ runs }: { runs: TestRun[] }) {
  const toast = useToast()
  const qc = useQueryClient()
  const done = harvestedRuns(runs)
  const [armed, setArmed] = useState(false)
  const clear = useMutation({
    mutationFn: async () => {
      for (const r of done) await deleteTestRun(r.metadata.namespace ?? '', r.metadata.name)
      return done.length
    },
    onSuccess: (n) => {
      toast.success(`Cleared ${n} finished run${n === 1 ? '' : 's'}`, { description: 'Their results stay under Results.' })
      void qc.invalidateQueries({ queryKey: ['k6'] })
    },
    onError: (e: Error) => toast.error('Could not clear finished runs', { description: e.message }),
    onSettled: () => setArmed(false),
  })
  if (!done.length) return null
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={clear.isPending}
      onBlur={() => setArmed(false)}
      onClick={() => (armed ? clear.mutate() : setArmed(true))}
    >
      {clear.isPending ? 'Clearing…' : armed ? `Delete ${done.length} TestRun${done.length === 1 ? '' : 's'}?` : `Clear finished (${done.length})`}
    </Button>
  )
}

/* ─────────────────────────── the table ─────────────────────────── */

const STAGE_KIND: Record<TestRunStage, StatusKind> = {
  initialization: 'progressing',
  initialized: 'progressing',
  created: 'progressing',
  started: 'progressing',
  stopped: 'paused',
  finished: 'healthy',
  error: 'failed',
}

function stageOf(run: TestRun): TestRunStage {
  return run.status?.stage ?? 'initialization'
}

function RunTable({
  runs,
  loading,
  onSelect,
}: {
  runs: TestRun[]
  loading: boolean
  onSelect(sel: { namespace: string; name: string }): void
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const canManage = useCan('develop')
  const [busy, setBusy] = useState<string | null>(null)

  // Acting on a run meant opening it first. Re-running the same test after a
  // change, or clearing out a failed one, is the commonest thing to do from a
  // list of runs and it took two extra clicks and a drawer.
  const act = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await fn()
      toast.success(label)
      void qc.invalidateQueries({ queryKey: ['k6'] })
    } catch (e) {
      toast.error(label, { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const columns: Column<TestRun>[] = [
    {
      key: 'name',
      header: 'Test',
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-content">{r.metadata.name}</div>
          <div className="truncate text-[11px] text-content-subtle">{r.metadata.namespace}</div>
        </div>
      ),
    },
    {
      key: 'stage',
      header: 'Stage',
      value: (r) => stageOf(r),
      cell: (r) => {
        const stage = stageOf(r)
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadge kind={STAGE_KIND[stage]} pulse={isRunning(r)}>
              {stage}
            </StatusBadge>
            {isPaused(r) ? <Badge>paused</Badge> : null}
          </div>
        )
      },
    },
    {
      key: 'test',
      header: 'From test',
      value: (r) => r.metadata.labels?.[LABEL_TEST] ?? '',
      cell: (r) => {
        const test = r.metadata.labels?.[LABEL_TEST]
        const commit = r.metadata.labels?.[LABEL_COMMIT]
        if (!test) return <span className="text-content-subtle">—</span>
        return (
          <div className="min-w-0">
            <div className="truncate font-mono text-[11px] text-content">{test}</div>
            {commit ? <div className="truncate font-mono text-[10px] text-content-subtle">{commit.slice(0, 7)}</div> : null}
          </div>
        )
      },
    },
    {
      key: 'parallelism',
      header: 'Runners',
      numeric: true,
      value: (r) => r.spec?.parallelism ?? 1,
      cell: (r) => <span className="tabular-nums">{r.spec?.parallelism ?? 1}</span>,
    },
    {
      key: 'script',
      header: 'Script',
      cell: (r) => {
        const cm = r.spec?.script?.configMap
        if (!cm) return <span className="text-content-subtle">—</span>
        return (
          <code className="text-[11px] text-content-muted">
            {cm.name}
            {cm.file ? `/${cm.file}` : ''}
          </code>
        )
      },
    },
    {
      key: 'started',
      header: 'Started',
      value: (r) => r.metadata.creationTimestamp ?? '',
      cell: (r) =>
        r.metadata.creationTimestamp ? (
          <span title={formatAbsolute(r.metadata.creationTimestamp)} className="text-[12px] text-content-muted">
            {formatRelative(r.metadata.creationTimestamp)}
          </span>
        ) : (
          <span className="text-content-subtle">—</span>
        ),
    },
    {
      key: 'duration',
      header: 'Duration',
      numeric: true,
      value: (r) => durationSecs(r.metadata.creationTimestamp, finishedAt(r)) ?? -1,
      cell: (r) => (
        <span className="tabular-nums text-[12px] text-content-muted">
          {fmtDuration(durationSecs(r.metadata.creationTimestamp, finishedAt(r)))}
        </span>
      ),
    },
  ]

  if (canManage) {
    columns.push({
      key: 'actions',
      header: '',
      sortable: false,
      cell: (r) => {
        const key = `${r.metadata.namespace}/${r.metadata.name}`
        const running = isRunning(r)
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {running
              ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy === key}
                  onClick={() =>
                    act(key, isPaused(r) ? `Resumed ${r.metadata.name}` : `Paused ${r.metadata.name}`, () =>
                      setTestRunPaused(r.metadata.namespace ?? '', r.metadata.name, !isPaused(r)))}
                >
                  {isPaused(r) ? 'Resume' : 'Pause'}
                </Button>
              )
              : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy === key}
                  onClick={() => act(key, `Started a rerun of ${r.metadata.name}`, () => rerunTestRun(r))}
                >
                  Run again
                </Button>
              )}
            <Button
              size="xs"
              variant="ghost"
              disabled={busy === key}
              className="text-rose-700 dark:text-rose-300"
              onClick={() => act(key, `Deleted ${r.metadata.name}`, () => deleteTestRun(r.metadata.namespace ?? '', r.metadata.name))}
            >
              Delete
            </Button>
          </div>
        )
      },
    })
  }

  return (
    <DataTable
      columns={columns}
      rows={runs}
      rowKey={(r) => `${r.metadata.namespace}/${r.metadata.name}`}
      onRowClick={(r) => onSelect({ namespace: r.metadata.namespace ?? '', name: r.metadata.name })}
      loading={loading}
      tableId="k6-testruns"
      features={{ search: true, filters: true, columns: true, density: true, export: true }}
      defaultSort={{ key: 'started', dir: 'desc' }}
      searchPlaceholder="Search test runs…"
      empty={
        <EmptyState
          title="No load tests yet"
          description="A k6 TestRun points at a script in a ConfigMap and fans it out across runner pods. Create one to see it here."
        />
      }
    />
  )
}

/* ─────────────────────────── the drawer ─────────────────────────── */

function RunDrawer({
  namespace,
  name,
  onClose,
}: {
  namespace: string
  name: string
  onClose(): void
}) {
  const run = useTestRun(namespace, name)
  const pods = useTestRunPods(run.data)
  const [tab, setTab] = useState<'live' | 'summary' | 'report' | 'logs' | 'spec'>('live')
  const [stage, setStage] = useState<TestRunStage | null>(null)
  const [pod, setPod] = useState<string | null>(null)
  useOverlayDismiss(true, onClose)

  const podList = pods.data ?? []
  // Default to the first runner: the initializer only prints the plan, the
  // starter prints nothing at all, and the summary lives on a runner.
  const defaultPod = podList.find((p) => p.role === 'runner')?.name ?? podList[0]?.name ?? null
  useEffect(() => {
    setPod((current) => current ?? defaultPod)
  }, [defaultPod])

  const body = (
    <div className="fixed inset-0 z-50 flex justify-end bg-scrim/60 backdrop-blur-[1px]">
      <button type="button" aria-label="Close" className="flex-1 cursor-default" onClick={onClose} />
      <div className="flex h-full w-full max-w-3xl flex-col bg-surface-raised shadow-2xl sm:border-l sm:border-edge-default">
        <DrawerHeader run={run.data} loading={run.isLoading} onClose={onClose} />

        {/* shrink-0: the scrolling body is flex-1, and without this the header
            and tabs are squeezed below their content height — the subtitle
            ends up drawn on top of the tab row. */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-edge-default px-4 [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none] sm:[mask-image:none] [&::-webkit-scrollbar]:hidden">
          {(['live', 'summary', 'report', 'logs', 'spec'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'border-b-2 px-3 py-2 text-[12px] font-medium capitalize transition-colors',
                tab === t
                  ? 'border-brand-600 text-content'
                  : 'border-transparent text-content-muted hover:text-content',
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {run.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : !run.data ? (
            <EmptyState title="Test run not found" description="It may have been deleted while this drawer was open." />
          ) : tab === 'live' ? (
            <LiveTab run={run.data} pods={podList} podName={pod} stage={stage} onStage={setStage} />
          ) : tab === 'summary' ? (
            <SummaryTab run={run.data} pods={podList} podName={pod} />
          ) : tab === 'report' ? (
            <ReportTab run={run.data} podName={pod} />
          ) : tab === 'logs' ? (
            <LogsTab run={run.data} pods={podList} podName={pod} onPod={setPod} />
          ) : (
            <SpecTab run={run.data} />
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(body, document.body)
}

function DrawerHeader({
  run,
  loading,
  onClose,
}: {
  run: TestRun | undefined
  loading: boolean
  onClose(): void
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const canManage = useCan('develop')

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['k6'] })
  }

  const pause = useMutation({
    mutationFn: (paused: boolean) => setTestRunPaused(run!.metadata.namespace!, run!.metadata.name, paused),
    onSuccess: (_d, paused) => {
      toast.success(paused ? 'Test paused' : 'Test resumed')
      invalidate()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const rerun = useMutation({
    mutationFn: () => rerunTestRun(run!),
    onSuccess: (created) => {
      toast.success(`Started ${created.metadata.name}`)
      invalidate()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: () => deleteTestRun(run!.metadata.namespace!, run!.metadata.name),
    onSuccess: () => {
      toast.success('Test run deleted')
      invalidate()
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const busy = pause.isPending || rerun.isPending || remove.isPending

  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-edge-default px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {run ? <StatusBadge kind={STAGE_KIND[stageOf(run)]} pulse={isRunning(run)}>{stageOf(run)}</StatusBadge> : null}
          <span className="truncate font-semibold text-content">{run?.metadata.name ?? (loading ? 'Loading…' : '—')}</span>
        </div>
        {run ? (
          <div className="mt-0.5 text-[11px] text-content-subtle">
            {run.metadata.namespace} · {run.spec?.parallelism ?? 1} runner{(run.spec?.parallelism ?? 1) === 1 ? '' : 's'} ·{' '}
            {fmtDuration(durationSecs(run.metadata.creationTimestamp, finishedAt(run)))}
          </div>
        ) : null}
      </div>

      {run && canManage ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {isRunning(run) ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => pause.mutate(!isPaused(run))}>
              {isPaused(run) ? 'Resume' : 'Pause'}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => rerun.mutate()}>
              Run again
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove.mutate()}>
            Delete
          </Button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="shrink-0 rounded-md px-2 py-1 text-content-muted hover:bg-surface-sunken hover:text-content"
      >
        ✕
      </button>
    </div>
  )
}

/* ─────────────────────────── live tab ─────────────────────────── */

/**
 * The run as it happens: CI-style stages with real durations, and k6's own
 * counters charted from the progress lines it prints every second.
 *
 * The drawer used to open on Summary, which is empty until the end-of-test
 * summary is printed — so a twenty-minute run showed nothing for twenty
 * minutes. This is what the drawer opens on now.
 */
function LiveTab({
  run,
  pods,
  podName,
  stage,
  onStage,
}: {
  run: TestRun
  pods: PodRef[]
  podName: string | null
  stage: TestRunStage | null
  onStage(s: TestRunStage | null): void
}) {
  const running = isRunning(run)
  // Follow only while it is running: a finished run's output is fixed, and a
  // socket held open on it is a socket held open for nothing.
  const stream = useLogStream({
    namespace: run.metadata.namespace,
    sources: podName ? [{ pod: podName, label: podName }] : [],
    follow: running,
    tailLines: 8000,
    enabled: Boolean(podName),
  })
  const lines = useMemo(() => stream.lines.map((l) => l.text), [stream.lines])

  return (
    <div className="space-y-3">
      <StageRail run={run} selected={stage} onSelect={onStage} />
      <LiveCharts lines={lines} running={running} />
      <Conditions run={run} />
      <PodStrip pods={pods} />
    </div>
  )
}

/* ─────────────────────────── summary tab ─────────────────────────── */

function SummaryTab({ run, pods, podName }: { run: TestRun; pods: PodRef[]; podName: string | null }) {
  // One-shot tail of the chosen runner: the summary is printed once, at the
  // end, so following the stream adds nothing but keeps a socket open.
  const stream = useLogStream({
    namespace: run.metadata.namespace,
    sources: podName ? [{ pod: podName, label: podName }] : [],
    follow: false,
    tailLines: 4000,
    enabled: Boolean(podName),
  })

  const text = useMemo(() => stream.lines.map((l) => l.text).join('\n'), [stream.lines])
  const summary = useMemo(() => parseK6Summary(text), [text])

  return (
    <div className="space-y-4">
      <StageTimeline run={run} />
      <Conditions run={run} />

      {!podName ? (
        <EmptyState
          title="No runner pods"
          description={
            run.spec?.cleanup === 'post' && !isRunning(run)
              ? 'The operator cleaned up this run’s pods after it finished, so the logs and summary are gone. Run it again to capture them.'
              : 'The operator has not created the runner pods yet.'
          }
        />
      ) : !summary.complete ? (
        <EmptyState
          title={isRunning(run) ? 'Test still running' : 'No summary in the logs'}
          description={
            isRunning(run)
              ? 'k6 prints its summary once, at the end of the test. This fills in when the run completes.'
              : 'The runner produced no end-of-test summary — check the Logs tab for what it did print.'
          }
        />
      ) : (
        <>
          <Thresholds summary={summary} />
          <Metrics summary={summary} />
        </>
      )}

      <PodStrip pods={pods} />
    </div>
  )
}

function StageTimeline({ run }: { run: TestRun }) {
  const current = stageOf(run)
  const failed = current === 'error'
  const stopped = current === 'stopped'
  const reachedIndex = STAGE_ORDER.indexOf(current)

  return (
    <Card>
      <CardHeader>
        <div className="text-[12px] font-semibold text-content">Stages</div>
      </CardHeader>
      <CardBody>
        <div className="flex flex-wrap items-center gap-1.5">
          {STAGE_ORDER.map((stage, i) => {
            // A terminal failure stops the walk: stages after the point of
            // failure were never reached, and drawing them as pending would
            // imply the run is still on its way to them.
            const done = !failed && !stopped && reachedIndex >= 0 && i < reachedIndex
            const active = !failed && !stopped && i === reachedIndex
            return (
              <div key={stage} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[11px] font-medium',
                    done && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
                    active && 'bg-brand-600 text-white',
                    !done && !active && 'bg-surface-sunken text-content-subtle',
                  )}
                >
                  {stage}
                </span>
                {i < STAGE_ORDER.length - 1 ? <span className="text-content-subtle">→</span> : null}
              </div>
            )
          })}
          {failed ? (
            <>
              <span className="text-content-subtle">→</span>
              <span className="rounded-full bg-rose-600 px-2.5 py-1 text-[11px] font-medium text-white">error</span>
            </>
          ) : null}
          {stopped ? (
            <>
              <span className="text-content-subtle">→</span>
              <span className="rounded-full bg-amber-500 px-2.5 py-1 text-[11px] font-medium text-white">stopped</span>
            </>
          ) : null}
        </div>
      </CardBody>
    </Card>
  )
}

function Conditions({ run }: { run: TestRun }) {
  const conditions = run.status?.conditions ?? []
  if (!conditions.length) return null
  return (
    <Card>
      <CardHeader>
        <div className="text-[12px] font-semibold text-content">Conditions</div>
      </CardHeader>
      <CardBody className="space-y-1.5">
        {conditions.map((c) => (
          <div key={c.type} className="flex flex-wrap items-baseline gap-2 text-[12px]">
            <StatusBadge kind={c.status === 'True' ? 'healthy' : c.status === 'False' ? 'unknown' : 'paused'}>
              {c.type}
            </StatusBadge>
            <span className="text-content-muted">{c.reason}</span>
            {c.message && c.message !== c.reason ? (
              <span className="text-content-subtle">{c.message}</span>
            ) : null}
            <span className="ml-auto text-[11px] text-content-subtle" title={formatAbsolute(c.lastTransitionTime)}>
              {formatRelative(c.lastTransitionTime)}
            </span>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

function Thresholds({ summary }: { summary: K6Summary }) {
  if (!summary.thresholds.length) {
    return (
      <Card>
        <CardHeader>
          <div className="text-[12px] font-semibold text-content">Thresholds</div>
        </CardHeader>
        <CardBody>
          <p className="text-[12px] text-content-muted">
            This script declares no thresholds, so k6 had no pass/fail criteria to check. Adding a{' '}
            <code className="text-[11px]">thresholds</code> block to the script turns this run into a gate rather than
            a measurement.
          </p>
        </CardBody>
      </Card>
    )
  }

  const failed = summary.thresholds.filter((t) => !t.passed).length

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="text-[12px] font-semibold text-content">Thresholds</div>
          <StatusBadge kind={failed ? 'failed' : 'healthy'}>
            {failed ? `${failed} failed` : 'all passed'}
          </StatusBadge>
        </div>
      </CardHeader>
      <CardBody className="space-y-1">
        {summary.thresholds.map((t) => (
          <div key={`${t.metric}:${t.expression}`} className="flex items-center gap-2 text-[12px]">
            <span className={cn('font-mono', t.passed ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
              {t.passed ? '✓' : '✗'}
            </span>
            <span className="font-medium text-content">{t.metric}</span>
            <code className="text-[11px] text-content-muted">{t.expression}</code>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

/**
 * The one number to print large for a headline metric.
 *
 * Trend metrics (`http_req_duration`) lead with their average. Counters and
 * rates (`http_reqs: 1482  49.06/s`, `data_received: 12 MB  397 kB/s`) have no
 * `avg=` at all — their value is the leading bare token, and for those the
 * SECOND token is either the unit or the rate, never a `k=v` pair. Taking only
 * the first token turned "12 MB" into "12", which reads as twelve of nothing.
 */
function headlineValue(m: { raw: string; values: Record<string, string> }): string {
  const trend = m.values['avg'] ?? m.values['p(95)'] ?? m.values['rate']
  if (trend) return trend
  const [first, second] = m.raw.split(/\s+/)
  if (!first) return m.raw
  // Append the second token only when it is a unit or a rate (`MB`, `49.06/s`).
  // It is not, for `50 min=50 max=50` (a breakdown) or for
  // `1.00% ✓ 15 ✗ 1467` (pass/fail counts) — appending those reads as noise.
  return second && /^[\w%./]+$/.test(second) ? `${first} ${second}` : first
}

function Metrics({ summary }: { summary: K6Summary }) {
  const headline = HEADLINE_METRICS.map((n) => summary.metrics.find((m) => m.name === n)).filter(
    (m): m is NonNullable<typeof m> => Boolean(m),
  )
  const rest = summary.metrics.filter((m) => !HEADLINE_METRICS.includes(m.name as typeof HEADLINE_METRICS[number]))

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="text-[12px] font-semibold text-content">Results</div>
          {summary.checks ? (
            <StatusBadge kind={summary.checks.failed ? 'degraded' : 'healthy'}>
              {summary.checks.passed} checks passed
              {summary.checks.failed ? `, ${summary.checks.failed} failed` : ''}
            </StatusBadge>
          ) : null}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        {headline.length ? (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {headline.map((m) => (
              <div key={m.name} className="rounded-lg border border-edge-default px-3 py-2">
                <div className="text-[11px] text-content-subtle">{m.name}</div>
                <div className="truncate font-mono text-[12px] text-content" title={m.raw}>
                  {headlineValue(m)}
                </div>
                {m.values['p(95)'] && m.values['avg'] ? (
                  <div className="text-[10px] text-content-subtle">p95 {m.values['p(95)']}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {rest.length ? (
          <details className="text-[12px]">
            <summary className="cursor-pointer text-content-muted">All {summary.metrics.length} metrics</summary>
            <div className="mt-2 space-y-0.5 font-mono text-[11px]">
              {rest.map((m) => (
                <div key={m.name} className="flex gap-2">
                  <span className="w-48 shrink-0 truncate text-content-muted">{m.name}</span>
                  <span className="min-w-0 flex-1 truncate text-content">{m.raw}</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </CardBody>
    </Card>
  )
}

function PodStrip({ pods }: { pods: PodRef[] }) {
  if (!pods.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {pods.map((p) => (
        <span
          key={p.name}
          className="rounded-md border border-edge-default px-2 py-1 font-mono text-[11px] text-content-muted"
          title={`${p.role} · ${p.phase ?? 'unknown'}`}
        >
          {p.name}
        </span>
      ))}
    </div>
  )
}

/* ─────────────────────────── report tab ─────────────────────────── */

/**
 * Bridge a TestRun to the report.
 *
 * The run knows three things the report needs and nothing else does: the
 * window it occupied, which pods generated the load, and — through the labels
 * the console stamped at launch — which committed test it came from. The
 * test's own configuration supplies the target selector, so a run started
 * from the workbench charts the system under test, and one started by hand
 * charts what it can and says what it cannot.
 */
function ReportTab({ run, podName }: { run: TestRun; podName: string | null }) {
  const testName = run.metadata.labels?.[LABEL_TEST]
  const commit = run.metadata.labels?.[LABEL_COMMIT]
  const suite = useSuiteRepo()
  const test = usePerfTest(suite.data, testName ?? null)

  // One-shot read of the runner's stdout for the end-of-test summary.
  const stream = useLogStream({
    namespace: run.metadata.namespace,
    sources: podName ? [{ pod: podName, label: podName }] : [],
    follow: false,
    tailLines: 4000,
    enabled: Boolean(podName),
  })
  const summary = useMemo(() => {
    const text = stream.lines.map((l) => l.text).join('\n')
    const parsed = parseK6Summary(text)
    return parsed.complete ? parsed : null
  }, [stream.lines])

  const window = useMemo(() => {
    const startMs = run.metadata.creationTimestamp ? new Date(run.metadata.creationTimestamp).getTime() : NaN
    if (!Number.isFinite(startMs)) return null
    const finished = finishedAt(run)
    // A run still going is charted up to now, so the picture fills in live.
    const endMs = finished ? new Date(finished).getTime() : Date.now()
    return { startMs, endMs: Math.max(endMs, startMs + 60_000) }
  }, [run])

  return (
    <PerfReport
      testName={testName ?? run.metadata.name}
      config={test.data?.config ?? DEFAULT_CONFIG}
      summary={summary}
      window={window}
      // The operator names every pod for a TestRun after the run itself.
      runnerSelector={`${run.metadata.name}.*`}
      runnerNamespace={run.metadata.namespace ?? 'default'}
      commit={commit}
    />
  )
}

/* ─────────────────────────── logs tab ─────────────────────────── */

function LogsTab({
  run,
  pods,
  podName,
  onPod,
}: {
  run: TestRun
  pods: PodRef[]
  podName: string | null
  onPod(name: string): void
}) {
  const running = isRunning(run)
  const stream = useLogStream({
    namespace: run.metadata.namespace,
    sources: podName ? [{ pod: podName, label: podName }] : [],
    follow: running,
    tailLines: 8000,
    enabled: Boolean(podName),
  })

  if (!pods.length) {
    return (
      <EmptyState
        title="No pods to read"
        description="The operator has not created pods for this run, or it already cleaned them up."
      />
    )
  }

  return (
    <div className="space-y-2">
      <Select
        value={podName ?? ''}
        onChange={(e) => onPod(e.target.value)}
        options={pods.map((p) => ({ value: p.name, label: `${p.name} · ${p.role}` }))}
      />
      <LogConsole lines={stream.lines} status={stream.status} />
    </div>
  )
}

/* ─────────────────────────── spec tab ─────────────────────────── */

function SpecTab({ run }: { run: TestRun }) {
  const rows: Array<[string, ReactNode]> = [
    ['Namespace', run.metadata.namespace ?? '—'],
    ['Parallelism', String(run.spec?.parallelism ?? 1)],
    ['Script', run.spec?.script?.configMap
      ? `${run.spec.script.configMap.name}${run.spec.script.configMap.file ? `/${run.spec.script.configMap.file}` : ''}`
      : run.spec?.script?.localFile ?? '—'],
    ['Arguments', run.spec?.arguments || '—'],
    ['Cleanup', run.spec?.cleanup || 'none'],
    ['Separate runners', run.spec?.separate ? 'yes' : 'no'],
    ['Test run id', run.status?.testRunId ?? run.spec?.testRunId ?? '—'],
    ['Created', run.metadata.creationTimestamp ? formatAbsolute(run.metadata.creationTimestamp) : '—'],
  ]
  return (
    <Card>
      <CardBody className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3 text-[12px]">
            <span className="w-36 shrink-0 text-content-subtle">{k}</span>
            <span className="min-w-0 flex-1 break-words font-mono text-content">{v}</span>
          </div>
        ))}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── create dialog ─────────────────────────── */

function NewRunDialog({ onClose }: { onClose(): void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [namespace, setNamespace] = useState('')
  const [name, setName] = useState('')
  const [configMap, setConfigMap] = useState('')
  const [file, setFile] = useState('')
  const [parallelism, setParallelism] = useState(1)
  const [args, setArgs] = useState('')

  // Scripts are looked up across all namespaces until one is chosen, so the
  // dialog can answer "what can I run" before "where should it run".
  const scripts = useScriptConfigMaps(namespace || undefined)
  const options = scripts.data ?? []
  const chosen = options.find((o) => o.name === configMap)

  useEffect(() => {
    if (chosen && !chosen.files.includes(file)) setFile(chosen.files[0] ?? '')
  }, [chosen, file])

  useEffect(() => {
    if (chosen?.namespace && !namespace) setNamespace(chosen.namespace)
  }, [chosen, namespace])

  const create = useMutation({
    mutationFn: () =>
      createTestRun({
        name,
        namespace: namespace || chosen?.namespace || 'default',
        configMap,
        file,
        parallelism,
        arguments: args || undefined,
      }),
    onSuccess: (run) => {
      toast.success(`Created ${run.metadata.name}`)
      void qc.invalidateQueries({ queryKey: ['k6'] })
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const ready = name.trim() && configMap && file && parallelism >= 1

  return (
    <Modal
      open
      onClose={onClose}
      branded
      title="New test run"
      description="Fan a k6 script out across runner pods on the cluster."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Run test'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" hint="Must be a valid Kubernetes name — lowercase, dashes.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout-load" />
        </Field>

        <Field
          label="Script"
          hint={
            scripts.isLoading
              ? 'Looking for ConfigMaps with a .js or .ts key…'
              : options.length
              ? 'Any ConfigMap holding a .js or .ts file can be run.'
              : 'No script ConfigMaps found. Create one holding your k6 script first.'
          }
        >
          <Select
            value={configMap}
            onChange={(e) => setConfigMap(e.target.value)}
            options={[
              { value: '', label: options.length ? 'Choose a ConfigMap…' : 'None available' },
              ...options.map((o) => ({ value: o.name, label: `${o.name} (${o.namespace})` })),
            ]}
          />
        </Field>

        {chosen && chosen.files.length > 1 ? (
          <Field label="File">
            <Select
              value={file}
              onChange={(e) => setFile(e.target.value)}
              options={chosen.files.map((f) => ({ value: f, label: f }))}
            />
          </Field>
        ) : null}

        <Field label="Parallelism" hint="How many runner pods split the load. Each runs a slice of the VUs.">
          <Input
            type="number"
            min={1}
            max={100}
            value={String(parallelism)}
            onChange={(e) => setParallelism(Math.max(1, Number(e.target.value) || 1))}
          />
        </Field>

        <Field label="Arguments" hint="Passed to k6, e.g. --vus 50 --duration 30s. Optional.">
          <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="--vus 50 --duration 30s" />
        </Field>
      </div>
    </Modal>
  )
}
