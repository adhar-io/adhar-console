import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  DataTable,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  useAccessReview,
  useToast,
  type Column,
  type StatusKind,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import { CrdMissing } from '../components/crd-missing.tsx'
import { PerfSuite } from './perf-suite.tsx'
import { RunDrawer } from './perf-run-drawer.tsx'
import { PerfOverview } from './perf-overview.tsx'
import { PerfDashboard } from './perf-dashboard.tsx'
import { QuickTestModal } from './perf-quick.tsx'
import { TriggerBadge } from './perf-bits.tsx'
import { useDevelopParams, useSetDevelopParams } from '../data/nav.ts'
import { ResultsView } from './perf-results.tsx'
import { PerfReadiness } from './perf-readiness.tsx'
import { SchedulesView } from './perf-schedules.tsx'
import { harvestedRuns, type PerfInsights, useHarvester, usePerfInsights } from '../data/perf-automation.ts'
import { runPerfTestChecks, startTestRunChecks, testRunCheck, useAllowedNamespaces } from '../data/access.ts'
import { LABEL_APPLICATION, LABEL_COMMIT, LABEL_TEST } from '../data/perf-format.ts'
import { ANN_HARVESTED, fmtMetric, LABEL_SCHEDULE, LABEL_TRIGGER, type RunRecord, type Trigger } from '../data/perf-results.ts'
import {
  createTestRun,
  deleteTestRun,
  durationSecs,
  finishedAt,
  fmtDuration,
  isCrdMissing,
  isPaused,
  isRunning,
  rerunTestRun,
  setTestRunPaused,
  useScriptConfigMaps,
  useTestRuns,
  type TestRun,
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
type PerfTab = 'overview' | 'tests' | 'runs' | 'results' | 'schedules' | 'readiness'

const PERF_TABS: Array<[PerfTab, string]> = [
  ['overview', 'Overview'],
  ['tests', 'Tests'],
  ['runs', 'Runs'],
  ['results', 'Results'],
  ['schedules', 'Schedules'],
  // Per-application reports: automated load + chaos, live SLOs, team gates
  // and game days, as the scorecard grades them.
  ['readiness', 'Readiness'],
]

/**
 * Namespaces performance tests run in: those of existing runs, of every
 * committed test's config, and the default the dialogs start from.
 */
function perfNamespaces(runs: TestRun[], insights: ReturnType<typeof usePerfInsights>): string[] {
  const set = new Set<string>(['default'])
  for (const r of runs) if (r.metadata.namespace) set.add(r.metadata.namespace)
  for (const c of insights.configs.values()) if (c.namespace) set.add(c.namespace)
  return [...set].sort()
}

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
  // Opening a run keeps the page where it is — the drawer sits over any tab,
  // and `?run=` deep-links it from anywhere.
  const openRun = (namespace: string, name: string) => setParams({ run: `${namespace}/${name}` })
  const [creating, setCreating] = useState<false | Partial<NewRunInit>>(false)
  const [quick, setQuick] = useState(false)
  const [newTestToken, setNewTestToken] = useState(0)
  const [resultsFor, setResultsFor] = useState<string | undefined>(undefined)
  const [scheduleFor, setScheduleFor] = useState<string | undefined>(undefined)
  const crdMissing = runs.isError && isCrdMissing(runs.error)

  // Keep the result of every run the console started, as soon as it finishes.
  useHarvester(!crdMissing)

  const items = runs.data ?? []
  // RBAC (docs/rbac.md): starting runs is a cluster write, so the entry points
  // show only when the user may create TestRuns (and, for a committed test,
  // its artefact ConfigMap) in at least one namespace tests run in. The
  // dialogs re-check the namespace actually chosen.
  const perfNs = perfNamespaces(items, insights)
  const canStartScript = useAllowedNamespaces(perfNs, startTestRunChecks).size > 0
  const canQuick = useAllowedNamespaces(perfNs, runPerfTestChecks).size > 0
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
            tabIndex={tab === id ? 0 : -1}
            onKeyDown={(e) => {
              // Arrow keys move between tabs (WAI-ARIA tabs pattern).
              const i = PERF_TABS.findIndex(([t]) => t === id)
              const n = PERF_TABS.length
              const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : -1
              if (next < 0) return
              e.preventDefault()
              setTab(PERF_TABS[next][0])
              const sib = (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)
              sib?.focus()
            }}
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
      {tab === 'runs' && !crdMissing
        ? (
          <div className="ml-auto flex items-center gap-1.5 pb-1">
            <ClearFinished runs={items} />
            {canStartScript ? <Button size="sm" variant="secondary" onClick={() => setCreating({})}>Run a ConfigMap script</Button> : null}
          </div>
        )
        : null}
    </div>
  )

  // Kept results by run, so the drawer and the table can show a run's
  // combined summary and gate verdict without reading it again.
  const recordsByRun = useMemo(() => {
    const m = new Map<string, RunRecord>()
    for (const r of insights.records) if (!m.has(`${r.namespace}/${r.run}`)) m.set(`${r.namespace}/${r.run}`, r)
    return m
  }, [insights.records])
  const selectedRecord = selected ? recordsByRun.get(`${selected.namespace}/${selected.name}`) : undefined

  const drawer = selected
    ? (
      <RunDrawer
        // Keyed by run: switching runs must reset every piece of drawer state.
        key={`${selected.namespace}/${selected.name}`}
        namespace={selected.namespace}
        name={selected.name}
        record={selectedRecord}
        verdict={selectedRecord ? insights.verdictOf(selectedRecord) : undefined}
        onClose={() => setParams({ run: undefined })}
        onOpenRun={openRun}
        onOpenTest={(t) => setParams({ view: 'tests', suite: t, run: undefined })}
        onDuplicate={(r) =>
          setCreating({
            namespace: r.metadata.namespace,
            name: `${r.metadata.name.replace(/-r\d+$/, '').slice(0, 50)}-copy`,
            configMap: r.spec?.script?.configMap?.name,
            file: r.spec?.script?.configMap?.file,
            parallelism: r.spec?.parallelism,
            arguments: r.spec?.arguments,
          })}
      />
    )
    : null

  return (
    <div className="space-y-4">
      <PageHeader
        title="Performance Center"
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => { runs.refetch() }} aria-label="Refresh" title="Refresh">↻</Button>
            {/* A new test is a commit to the app repository — Gitea authorises it. */}
            <Button size="sm" variant="secondary" onClick={() => { setTab('tests'); setNewTestToken((n) => n + 1) }}>New test</Button>
            {canQuick ? <Button variant="primary" size="sm" onClick={() => setQuick(true)}>Quick test</Button> : null}
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
            onQuickTest={canQuick ? () => setQuick(true) : undefined}
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
        : tab === 'readiness'
        ? <PerfReadiness />
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
            <RunTable
              runs={items}
              loading={runs.isLoading}
              records={recordsByRun}
              verdictOf={insights.verdictOf}
              onSelect={(r) => openRun(r.namespace, r.name)}
            />
          </div>
        )}

      {drawer}
      {creating
        ? (
          <NewRunDialog
            initial={creating}
            onClose={() => setCreating(false)}
            onCreated={(r) => {
              setCreating(false)
              openRun(r.metadata.namespace ?? '', r.metadata.name)
            }}
          />
        )
        : null}
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
  const harvested = harvestedRuns(runs)
  // Only the runs in namespaces where the user may delete TestRuns.
  const deletable = useAllowedNamespaces(harvested.map((r) => r.metadata.namespace), (ns) => [testRunCheck('delete', ns)])
  const done = harvested.filter((r) => deletable.has(r.metadata.namespace ?? ''))
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

/** The status a person reads: running, or the outcome — never the bare operator stage. */
function runStatus(run: TestRun, record: RunRecord | undefined, verdictOf: PerfInsights['verdictOf']): { kind: StatusKind; label: string; sort: string } {
  const stage = run.status?.stage ?? 'initialization'
  if (isRunning(run)) {
    if (isPaused(run) && stage !== 'started') return { kind: 'paused', label: 'paused', sort: '0-paused' }
    return { kind: 'progressing', label: stage === 'started' ? 'running' : 'starting', sort: '0-running' }
  }
  if (stage === 'error') return { kind: 'failed', label: 'error', sort: '3-error' }
  if (stage === 'stopped') return { kind: 'paused', label: 'stopped', sort: '2-stopped' }
  if (record) {
    const v = verdictOf(record)
    if (v.status === 'pass') return { kind: 'healthy', label: 'passed', sort: '1-passed' }
    if (v.status === 'fail') return { kind: 'degraded', label: 'failed gate', sort: '2-failed' }
  }
  return { kind: 'unknown', label: 'finished', sort: '1-finished' }
}

/** Elapsed for a running run, total for a finished one — ticking once a second while any run is live. */
function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }, 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function RunTable({
  runs,
  loading,
  records,
  verdictOf,
  onSelect,
}: {
  runs: TestRun[]
  loading: boolean
  records: Map<string, RunRecord>
  verdictOf: PerfInsights['verdictOf']
  onSelect(sel: { namespace: string; name: string }): void
}) {
  const toast = useToast()
  const qc = useQueryClient()
  // Per-namespace RBAC for the row actions: resume patches the TestRun,
  // "Run again" creates one, Stop / Delete delete it.
  const runNamespaces = runs.map((r) => r.metadata.namespace)
  const patchNs = useAllowedNamespaces(runNamespaces, (ns) => [testRunCheck('patch', ns)])
  const startNs = useAllowedNamespaces(runNamespaces, startTestRunChecks)
  const deleteNs = useAllowedNamespaces(runNamespaces, (ns) => [testRunCheck('delete', ns)])
  const canManage = patchNs.size > 0 || startNs.size > 0 || deleteNs.size > 0
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<TestRun | null>(null)
  const now = useTick(runs.some(isRunning))
  const recordOf = (r: TestRun) => records.get(`${r.metadata.namespace}/${r.metadata.name}`)

  const act = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await fn()
      toast.success(label)
      void qc.invalidateQueries({ queryKey: ['k6'] })
    } catch (e) {
      toast.error(`Could not ${label.charAt(0).toLowerCase()}${label.slice(1)}`, { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const metric = (key: 'p95Ms' | 'rps' | 'errorRatePct', header: string, hidden = false): Column<TestRun> => ({
    key,
    header,
    numeric: true,
    defaultHidden: hidden,
    value: (r) => recordOf(r)?.metrics?.[key] ?? -1,
    cell: (r) => {
      const v = recordOf(r)?.metrics?.[key]
      return <span className="tabular-nums text-[12px] text-content-muted">{v === undefined ? '—' : fmtMetric(key, v)}</span>
    },
  })

  const columns: Column<TestRun>[] = [
    {
      key: 'name',
      header: 'Run',
      pinned: true,
      value: (r) => r.metadata.name,
      cell: (r) => {
        const test = r.metadata.labels?.[LABEL_TEST]
        return (
          <div className="min-w-0">
            <div className="truncate font-medium text-content">{test ?? r.metadata.name}</div>
            <div className="truncate font-mono text-[10px] text-content-subtle">{test ? r.metadata.name : r.metadata.namespace}</div>
          </div>
        )
      },
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => runStatus(r, recordOf(r), verdictOf).label,
      cell: (r) => {
        const s = runStatus(r, recordOf(r), verdictOf)
        const running = isRunning(r)
        return <StatusBadge kind={s.kind} pulse={running && s.kind === 'progressing'}>{s.label}</StatusBadge>
      },
    },
    {
      key: 'test',
      header: 'Test',
      defaultHidden: true,
      value: (r) => r.metadata.labels?.[LABEL_TEST] ?? '',
      cell: (r) => {
        const commit = r.metadata.labels?.[LABEL_COMMIT]
        return (
          <div className="min-w-0 font-mono text-[11px]">
            <div className="truncate text-content">{r.metadata.labels?.[LABEL_TEST] ?? '—'}</div>
            {commit ? <div className="truncate text-[10px] text-content-subtle">{commit.slice(0, 7)}</div> : null}
          </div>
        )
      },
    },
    {
      key: 'application',
      header: 'Application',
      value: (r) => r.metadata.labels?.[LABEL_APPLICATION] ?? '',
      cell: (r) => <span className="text-[12px] text-content-muted">{r.metadata.labels?.[LABEL_APPLICATION] ?? '—'}</span>,
    },
    {
      key: 'trigger',
      header: 'Trigger',
      value: (r) => r.metadata.labels?.[LABEL_TRIGGER] ?? 'manual',
      cell: (r) => {
        const t = r.metadata.labels?.[LABEL_TRIGGER] as Trigger | undefined
        return t ? <TriggerBadge trigger={t} schedule={r.metadata.labels?.[LABEL_SCHEDULE]} /> : <span className="text-[11px] text-content-subtle">by hand</span>
      },
    },
    { key: 'namespace', header: 'Namespace', defaultHidden: true, value: (r) => r.metadata.namespace ?? '', cell: (r) => <span className="text-[12px] text-content-muted">{r.metadata.namespace}</span> },
    {
      key: 'parallelism',
      header: 'Runners',
      numeric: true,
      value: (r) => r.spec?.parallelism ?? 1,
      cell: (r) => <span className="tabular-nums">{r.spec?.parallelism ?? 1}</span>,
    },
    metric('p95Ms', 'p95'),
    metric('rps', 'Req/s'),
    metric('errorRatePct', 'Errors', true),
    {
      key: 'started',
      header: 'Started',
      value: (r) => r.metadata.creationTimestamp ?? '',
      cell: (r) =>
        r.metadata.creationTimestamp
          ? <span title={formatAbsolute(r.metadata.creationTimestamp)} className="text-[12px] text-content-muted">{formatRelative(r.metadata.creationTimestamp)}</span>
          : <span className="text-content-subtle">—</span>,
    },
    {
      key: 'duration',
      header: 'Duration',
      numeric: true,
      value: (r) => durationSecs(r.metadata.creationTimestamp, finishedAt(r)) ?? -1,
      cell: (r) => {
        const end = finishedAt(r)
        const secs = isRunning(r) && r.metadata.creationTimestamp ? (now - Date.parse(r.metadata.creationTimestamp)) / 1000 : durationSecs(r.metadata.creationTimestamp, end)
        return <span className={cn('tabular-nums text-[12px]', isRunning(r) ? 'text-content' : 'text-content-muted')}>{fmtDuration(secs)}</span>
      },
    },
  ]

  if (canManage) {
    columns.push({
      key: 'actions',
      header: '',
      sortable: false,
      filter: false,
      cell: (r) => {
        const key = `${r.metadata.namespace}/${r.metadata.name}`
        const running = isRunning(r)
        const ns = r.metadata.namespace ?? ''
        const held = running && isPaused(r) && r.status?.stage !== 'started'
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {held && patchNs.has(ns)
              ? (
                <Button size="xs" variant="secondary" disabled={busy === key} onClick={() => act(key, `Resumed ${r.metadata.name}`, () => setTestRunPaused(ns, r.metadata.name, false))}>
                  Resume
                </Button>
              )
              : null}
            {!running && startNs.has(ns)
              ? (
                <Button size="xs" variant="ghost" disabled={busy === key} onClick={() => act(key, `Started a rerun of ${r.metadata.name}`, () => rerunTestRun(r))}>
                  Run again
                </Button>
              )
              : null}
            {deleteNs.has(ns)
              ? (
                <Button size="xs" variant="ghost" disabled={busy === key} className="text-rose-700 dark:text-rose-300" onClick={() => setConfirm(r)}>
                  {running ? 'Stop' : 'Delete'}
                </Button>
              )
              : null}
          </div>
        )
      },
    })
  }

  const confirmRunning = confirm ? isRunning(confirm) : false
  const confirmKept = confirm ? Boolean(confirm.metadata.annotations?.[ANN_HARVESTED]) : false

  return (
    <>
      <DataTable
        columns={columns}
        rows={runs}
        rowKey={(r) => `${r.metadata.namespace}/${r.metadata.name}`}
        onRowClick={(r) => onSelect({ namespace: r.metadata.namespace ?? '', name: r.metadata.name })}
        loading={loading}
        tableId="k6-testruns-v2"
        features={{ search: true, filters: true, columns: true, density: true, export: true }}
        defaultSort={{ key: 'started', dir: 'desc' }}
        searchPlaceholder="Search test runs…"
        empty={
          <EmptyState
            title="No load tests yet"
            description="A k6 TestRun points at a script and fans it out across runner pods. Start one with Quick test, from a test in the Tests tab, or from a ConfigMap script."
          />
        }
      />
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirmRunning ? 'Stop this run?' : 'Delete this run?'}
        description={confirmRunning
          ? 'Stopping deletes the TestRun and its runner pods, which ends the load at once. A stopped run prints no summary. Open the run first to download its logs.'
          : confirmKept
          ? 'Its kept result stays under Results; the TestRun and its pods are removed.'
          : 'Its result has not been kept yet — deleting it now loses the summary.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={confirm ? busy === `${confirm.metadata.namespace}/${confirm.metadata.name}` : false}
              onClick={() => {
                const r = confirm!
                void act(`${r.metadata.namespace}/${r.metadata.name}`, confirmRunning ? `Stopped ${r.metadata.name}` : `Deleted ${r.metadata.name}`, () => deleteTestRun(r.metadata.namespace ?? '', r.metadata.name))
                  .then(() => setConfirm(null))
              }}
            >
              {confirmRunning ? 'Stop run' : 'Delete run'}
            </Button>
          </>
        }
      >
        <p className="font-mono text-[12px] text-content">{confirm?.metadata.namespace}/{confirm?.metadata.name}</p>
      </Modal>
    </>
  )
}

/* ─────────────────────────── create dialog ─────────────────────────── */

interface NewRunInit {
  namespace?: string
  name?: string
  configMap?: string
  file?: string
  parallelism?: number
  arguments?: string
}

/** Start a TestRun from a ConfigMap script — blank, or pre-filled to duplicate a run. */
function NewRunDialog({ initial = {}, onClose, onCreated }: { initial?: NewRunInit; onClose(): void; onCreated(run: TestRun): void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [namespace, setNamespace] = useState(initial.namespace ?? '')
  const [name, setName] = useState(initial.name ?? '')
  const [configMap, setConfigMap] = useState(initial.configMap ?? '')
  const [file, setFile] = useState(initial.file ?? '')
  const [parallelism, setParallelism] = useState(initial.parallelism ?? 1)
  const [args, setArgs] = useState(initial.arguments ?? '')

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
      toast.success(`Started ${run.metadata.name}`)
      void qc.invalidateQueries({ queryKey: ['k6'] })
      onCreated(run)
    },
    onError: (e: Error) => toast.error('Could not start the run', { description: e.message }),
  })

  const ready = name.trim() && configMap && file && parallelism >= 1
  // The run is created in the chosen namespace — ask there, not page-wide.
  const targetNs = namespace || chosen?.namespace || 'default'
  const access = useAccessReview(startTestRunChecks(targetNs))

  return (
    <Modal
      open
      onClose={onClose}
      branded
      title={initial.configMap ? 'Duplicate run' : 'New test run'}
      description={initial.configMap ? 'Same script and settings — change what you need, then start it.' : 'Fan a k6 script out across runner pods on the cluster.'}
      footer={
        <>
          {!access.allowed && !access.loading
            ? <span className="mr-auto self-center text-[12px] text-content-muted">Your access does not allow starting TestRuns in {targetNs}.</span>
            : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {access.allowed
            ? (
              <Button variant="primary" disabled={!ready} loading={create.isPending} onClick={() => create.mutate()}>
                Run test
              </Button>
            )
            : null}
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
