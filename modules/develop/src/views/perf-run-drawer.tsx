import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  DrawerWidenButton,
  EmptyState,
  LogConsole,
  type LogLine,
  Modal,
  Skeleton,
  StatusBadge,
  type StatusKind,
  TimeSeriesChart,
  useCan,
  useDrawerWidth,
  useLogStream,
  useOverlayDismiss,
  useToast,
  useToolPublicUrl,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import {
  deleteTestRun,
  isNotFound,
  isPaused,
  isRunning,
  parseK6Summary,
  rerunTestRun,
  setTestRunPaused,
  type K6Summary,
  type TestRun,
  useTestRun,
} from '../data/k6.ts'
import { startTestRunChecks, testRunCheck } from '../data/access.ts'
import { DEFAULT_CONFIG, LABEL_APPLICATION, LABEL_COMMIT, LABEL_TEST } from '../data/perf-format.ts'
import { usePerfSuite, usePerfTest } from '../data/perf-suite.ts'
import { usePrometheusReachable } from '../data/perf-metrics.ts'
import { ANN_HARVESTED, extractSummary, fmtMs, metricsFromSummary, type RunMetrics, type RunRecord } from '../data/perf-results.ts'
import type { GateVerdict } from '../data/perf-gate.ts'
import { parseProgress } from '../data/perf-progress.ts'
import { type LoadPlan, parsePlan, plannedVuCurve, planSegments } from '../data/perf-plan.ts'
import {
  exitMeaning,
  fmtSecs,
  type Lifecycle,
  type Phase,
  type PodDetail,
  primaryRunner,
  runLifecycle,
  runProgress,
} from '../data/perf-run-model.ts'
import {
  evalThreshold,
  fmtBytes,
  fmtCount,
  k6LogLevel,
  k6RemoteQueries,
  lastValue,
  liveWindow,
  logActivity,
  type LogActivity,
  type LogGroup,
  runnerResourceQueries,
} from '../data/perf-live.ts'
import { fetchAllLogs, type LiveSeries, useLiveSeries, useRunPods, useRunScript } from '../data/perf-run.ts'
import { runReportHtml } from '../data/perf-run-report.ts'
import { PerfReport } from './perf-report.tsx'
import { Snippet, VerdictBadge } from './perf-bits.tsx'

/**
 * The run drawer: one k6 TestRun, from "the operator has the object" to "here
 * is what it measured".
 *
 * Stability rules this file is built around (each one fixed a real bug in the
 * drawer it replaces):
 *
 *   • The drawer is keyed by run (see performance.tsx), so switching runs
 *     resets every piece of state — the old one kept the previous run's pod
 *     selected and streamed a pod that belonged to another run.
 *   • ONE log stream per pod, owned here and shared by every tab. Each tab
 *     used to open its own, so flipping between tabs re-downloaded the same
 *     8 000 lines, and a stream whose `follow` flipped when the run ended
 *     appended the whole tail a second time.
 *   • Parsing the stream (progress, failures, summary) is throttled to once
 *     every two seconds; at hundreds of failure lines a second it re-ran on
 *     every chunk.
 *   • Polling stops by itself when the run ends, and pauses while the browser
 *     tab is hidden.
 *   • Errors are toasts; a run deleted underneath the drawer says so once.
 */

export type RunTab = 'overview' | 'metrics' | 'summary' | 'logs' | 'report' | 'spec'

const TABS: Array<[RunTab, string]> = [
  ['overview', 'Overview'],
  ['metrics', 'Metrics'],
  ['summary', 'Summary'],
  ['logs', 'Logs'],
  ['report', 'Report'],
  ['spec', 'Spec'],
]

/* ─────────────────────────── small hooks ─────────────────────────── */

/** A clock that ticks once a second while `active` and the page is visible. */
function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') setNow(Date.now())
    }, ms)
    return () => clearInterval(id)
  }, [active, ms])
  return now
}

/** `value`, updated at most once per `ms` (trailing edge, so the last update lands). */
function useThrottled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - Date.now())
    const t = setTimeout(() => {
      last.current = Date.now()
      setV(value)
    }, wait)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/**
 * The width of an element that may mount later (after a skeleton), via a
 * callback ref — a ref object read once in an effect misses a late mount.
 */
function useMeasuredWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0)
  const ro = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect()
    ro.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    setWidth(el.getBoundingClientRect().width)
    ro.current = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setWidth(w)
    })
    ro.current.observe(el)
  }, [])
  useEffect(() => () => ro.current?.disconnect(), [])
  return [ref, width]
}

function download(filename: string, text: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** The deep link to this run (`?view=runs&run=ns/name`). */
function runLink(namespace: string, name: string): string {
  const u = new URL(globalThis.location?.href ?? 'http://localhost/')
  u.searchParams.set('view', 'runs')
  u.searchParams.set('run', `${namespace}/${name}`)
  return u.toString()
}

/** A Grafana dashboard built for k6 results, when the install has one. */
function useK6Dashboard(enabled: boolean) {
  return useQuery({
    queryKey: ['perf', 'grafana-k6-dashboard'],
    queryFn: async (): Promise<{ url: string; title: string } | null> => {
      const res = await fetch('/api/svc/grafana/api/search?type=dash-db&query=k6', { credentials: 'include' })
      if (!res.ok) return null
      const hits = (await res.json()) as Array<{ title?: string; url?: string }>
      // The operator's own dashboard charts the controller, not a test.
      const hit = hits.find((h) => h.url && /k6/i.test(h.title ?? '') && !/operator/i.test(h.title ?? ''))
      return hit?.url ? { url: hit.url, title: hit.title ?? 'k6' } : null
    },
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  })
}

/* ─────────────────────────── the drawer ─────────────────────────── */

export interface RunDrawerProps {
  namespace: string
  name: string
  onClose(): void
  /** The kept result for this run, when it has been harvested. */
  record?: RunRecord
  /** Its gate verdict. */
  verdict?: GateVerdict
  onOpenTest?(test: string): void
  /** Open another run (the rerun just started). */
  onOpenRun?(namespace: string, name: string): void
  /** Open the "new run" dialog pre-filled from this run. */
  onDuplicate?(run: TestRun): void
}

export function RunDrawer({ namespace, name, onClose, record, verdict, onOpenTest, onOpenRun, onDuplicate }: RunDrawerProps) {
  const runQ = useTestRun(namespace, name)
  const run = runQ.data
  const gone = runQ.isError && isNotFound(runQ.error)
  const running = run ? isRunning(run) : false
  const podsQ = useRunPods(gone ? undefined : run)
  const pods = useMemo(() => podsQ.data ?? [], [podsQ.data])
  const now = useNow(running)
  const scriptQ = useRunScript(run)

  const [tab, setTab] = useState<RunTab>('overview')
  const [logPod, setLogPod] = useState<string>('primary')
  const [logSearch, setLogSearch] = useState('')
  const [logLevel, setLogLevel] = useState<LevelFilter>('all')
  const width = useDrawerWidth('develop.perf-run', { base: 'max-w-4xl' })
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlayDismiss(true, onClose, { focusRef: panelRef })

  const lc = useMemo(() => (run ? runLifecycle(run, pods, now, record?.exitCode) : undefined), [run, pods, now, record?.exitCode])
  const plan = useMemo(
    () => (run && !scriptQ.isLoading ? parsePlan(scriptQ.data ?? undefined, run.spec?.arguments) : undefined),
    [run, scriptQ.isLoading, scriptQ.data],
  )

  // The primary runner's output feeds the live view, the summary and the
  // default Logs pane — one stream, shared. `follow` never flips: a stream on
  // a container that has stopped ends by itself, keeping its lines.
  const primary = primaryRunner(pods)
  const readable = primary && primary.state !== 'pending' && primary.state !== 'waiting'
  const stream = useLogStream({
    namespace,
    sources: readable ? [{ pod: primary.name, label: `runner ${primary.index ?? 1}` }] : [],
    follow: true,
    tailLines: 10_000,
    maxLines: 20_000,
    enabled: Boolean(readable),
  })
  const snap = useThrottled(stream.lines, running ? 2_000 : 250)
  const progress = useMemo(() => parseProgress(snap.map((l) => l.text)), [snap])
  // ~30 buckets: per-second counts of a quiet failure stream read as a comb.
  const activity = useMemo(() => logActivity(snap, { targetPoints: 30 }), [snap])
  const primaryDone = primary?.state === 'succeeded' || primary?.state === 'failed'
  const logSummary = useMemo(() => {
    if (!primaryDone && running) return undefined
    const s = parseK6Summary(extractSummary(snap.map((l) => l.text).join('\n')))
    return s.complete ? s : undefined
  }, [snap, primaryDone, running])
  // The kept result is aggregated across every runner, so it wins; the
  // primary's own summary is the fallback before the harvest.
  const summary: K6Summary | undefined = record?.summary ?? logSummary
  const metrics: RunMetrics | undefined = record?.metrics ?? (logSummary ? metricsFromSummary(logSummary) : undefined)
  const summarySource: SummarySource = record?.summary
    ? { kind: 'kept', runners: record.runners }
    : logSummary
    ? { kind: 'runner', of: run?.spec?.parallelism ?? 1 }
    : { kind: 'none' }

  // Live series from Prometheus — k6's own (when it remote-writes) and the
  // runner pods' resources (always scraped).
  const prom = usePrometheusReachable()
  const promOk = prom.data?.ok === true
  const window = useMemo(
    () => (lc ? liveWindow(lc.loadStartMs ?? lc.createdMs, running ? undefined : (lc.loadEndMs ?? lc.endMs ?? now) + 15_000, now) : null),
    [lc, running, now],
  )
  const k6Queries = useMemo(() => k6RemoteQueries(name), [name])
  const probeQueries = useMemo(() => k6Queries.filter((q) => q.series === 'VUs'), [k6Queries])
  const probe = useLiveSeries(probeQueries, window, running, promOk && !gone)
  const remote = useLiveSeries(k6Queries, window, running, promOk && probe.any && !gone)
  const resQueries = useMemo(() => runnerResourceQueries(name, namespace), [name, namespace])
  const resources = useLiveSeries(resQueries, window, running, promOk && !gone)

  const live: LiveData = { remote: probe.any ? remote.byChart : new Map(), resources: resources.byChart, progress, activity, promOk, promReason: prom.data?.reason }

  const openLogs = (opts: { search?: string; level?: LevelFilter } = {}) => {
    setLogPod('primary')
    if (opts.search !== undefined) setLogSearch(opts.search)
    if (opts.level) setLogLevel(opts.level)
    setTab('logs')
  }

  const body = (
    <div className="fixed inset-0 z-[60] flex justify-end bg-scrim/60 backdrop-blur-[1px]" role="dialog" aria-modal="true" aria-label={`Test run ${name}`}>
      {/* Pointer-only scrim: out of the tab order, so Tab starts inside the panel. */}
      <div aria-hidden className="flex-1 cursor-default" onClick={onClose} />
      <div
        ref={panelRef}
        className={cn('flex h-full w-full flex-col bg-surface-raised shadow-2xl sm:border-l sm:border-edge-default', width.className)}
      >
        <DrawerHeader
          run={run}
          name={name}
          namespace={namespace}
          loading={runQ.isLoading}
          lc={lc}
          plan={plan}
          now={now}
          pods={pods}
          summary={summary}
          metrics={metrics}
          activity={activity}
          window={window}
          onClose={onClose}
          width={width}
          onOpenTest={onOpenTest}
          onOpenRun={onOpenRun}
          onDuplicate={onDuplicate}
          harvested={Boolean(record || run?.metadata.annotations?.[ANN_HARVESTED])}
        />

        <TabBar tab={tab} onTab={setTab} running={running} errors={activity.totals.error + activity.totals.warning} />

        <div className="min-h-0 flex-1 overflow-y-auto p-4" role="tabpanel" aria-label={TABS.find(([t]) => t === tab)?.[1]}>
          {gone
            ? (
              <EmptyState
                title="This run no longer exists"
                description="The TestRun was deleted — by someone else, by the operator's cleanup, or from this drawer. Its kept result, if it was harvested, is still under Results."
                action={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}
              />
            )
            : runQ.isLoading || !run || !lc
            ? <DrawerSkeleton />
            : tab === 'overview'
            ? (
              <OverviewTab
                run={run}
                lc={lc}
                plan={plan}
                planLoading={scriptQ.isLoading}
                now={now}
                pods={pods}
                podsLoading={podsQ.isLoading}
                summary={summary}
                metrics={metrics}
                live={live}
                verdict={verdict}
                onLogs={openLogs}
              />
            )
            : tab === 'metrics'
            ? <MetricsTab run={run} lc={lc} plan={plan} live={live} summary={summary} metrics={metrics} loading={probe.loading || resources.loading} />
            : tab === 'summary'
            ? <SummaryTab run={run} lc={lc} summary={summary} metrics={metrics} source={summarySource} plan={plan} />
            : tab === 'logs'
            ? (
              <LogsTab
                run={run}
                pods={pods}
                primary={primary?.name}
                primaryStream={stream}
                sel={logPod}
                onSel={setLogPod}
                search={logSearch}
                onSearch={setLogSearch}
                level={logLevel}
                onLevel={setLogLevel}
              />
            )
            : tab === 'report'
            ? <ReportTab run={run} lc={lc} summary={summary} window={window} />
            : <SpecTab run={run} script={scriptQ.data ?? undefined} scriptLoading={scriptQ.isLoading} plan={plan} />}
        </div>
      </div>
    </div>
  )

  return createPortal(body, document.body)
}

interface LiveData {
  /** k6 remote-write series by chart id, empty when the run does not export them. */
  remote: Map<string, LiveSeries[]>
  /** cAdvisor series for the runner pods. */
  resources: Map<string, LiveSeries[]>
  progress: ReturnType<typeof parseProgress>
  activity: LogActivity
  promOk: boolean
  promReason?: string
}

/** No live sources — the Summary tab renders final numbers only. */
const NO_LIVE: LiveData = { remote: new Map(), resources: new Map(), progress: parseProgress([]), activity: logActivity([]), promOk: false }

type SummarySource = { kind: 'kept'; runners: number } | { kind: 'runner'; of: number } | { kind: 'none' }

/* ─────────────────────────── tabs ─────────────────────────── */

function TabBar({ tab, onTab, running, errors }: { tab: RunTab; onTab(t: RunTab): void; running: boolean; errors: number }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const n = TABS.length
    const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (next < 0) return
    e.preventDefault()
    onTab(TABS[next][0])
    refs.current[next]?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label="Run details"
      // shrink-0: the scrolling body is flex-1; without it the header and
      // tabs get squeezed and the subtitle draws over the tab row.
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-edge-default px-4 [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none] sm:[mask-image:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map(([id, label], i) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="tab"
          aria-selected={tab === id}
          tabIndex={tab === id ? 0 : -1}
          onKeyDown={(e) => onKey(e, i)}
          onClick={() => onTab(id)}
          className={cn(
            'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50',
            tab === id ? 'border-brand-600 text-content' : 'border-transparent text-content-muted hover:text-content',
          )}
        >
          {label}
          {id === 'overview' && running ? <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" /> : null}
          {id === 'logs' && errors ? <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] tabular-nums text-amber-700 dark:text-amber-300">{fmtCount(errors)}</span> : null}
        </button>
      ))}
    </div>
  )
}

function DrawerSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="block h-24 w-full rounded-xl" />
      <Skeleton className="block h-36 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="block h-16 rounded-xl" />)}
      </div>
      <Skeleton className="block h-28 w-full rounded-xl" />
    </div>
  )
}

/* ─────────────────────────── header & controls ─────────────────────────── */

const OUTCOME_BADGE: Record<Lifecycle['outcome'], { kind: StatusKind; label: string }> = {
  'in-progress': { kind: 'progressing', label: 'running' },
  passed: { kind: 'healthy', label: 'passed' },
  'thresholds-failed': { kind: 'degraded', label: 'thresholds failed' },
  failed: { kind: 'failed', label: 'failed' },
  aborted: { kind: 'paused', label: 'aborted' },
  unknown: { kind: 'unknown', label: 'finished' },
}

function DrawerHeader({
  run,
  name,
  namespace,
  loading,
  lc,
  plan,
  now,
  pods,
  summary,
  metrics,
  activity,
  window,
  onClose,
  width,
  onOpenTest,
  onOpenRun,
  onDuplicate,
  harvested,
}: {
  run: TestRun | undefined
  name: string
  namespace: string
  loading: boolean
  lc: Lifecycle | undefined
  plan: LoadPlan | undefined
  now: number
  pods: PodDetail[]
  summary?: K6Summary
  metrics?: RunMetrics
  activity: LogActivity
  window: { startMs: number; endMs: number } | null
  onClose(): void
  width: ReturnType<typeof useDrawerWidth>
  onOpenTest?(test: string): void
  onOpenRun?(namespace: string, name: string): void
  onDuplicate?(run: TestRun): void
  harvested: boolean
}) {
  const toast = useToast()
  const qc = useQueryClient()
  const exists = Boolean(run)
  const canPatch = useCan(testRunCheck('patch', namespace, name), { enabled: exists })
  const canRerun = useCan(startTestRunChecks(namespace), { enabled: exists })
  const canDelete = useCan(testRunCheck('delete', namespace, name), { enabled: exists })
  const grafana = useToolPublicUrl('grafana')
  const k6Board = useK6Dashboard(Boolean(grafana))
  const [confirm, setConfirm] = useState<null | 'stop' | 'delete'>(null)
  const [saveLogs, setSaveLogs] = useState(true)
  const [menu, setMenu] = useState(false)

  const running = run ? isRunning(run) : false
  const test = run?.metadata.labels?.[LABEL_TEST]
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['k6'] })

  const resume = useMutation({
    mutationFn: () => setTestRunPaused(namespace, name, false),
    onSuccess: () => {
      toast.success('Run released', { description: 'The runners start generating load once they are all up.' })
      invalidate()
    },
    onError: (e: Error) => toast.error('Could not resume the run', { description: e.message }),
  })
  const rerun = useMutation({
    mutationFn: () => rerunTestRun(run!),
    onSuccess: (created) => {
      toast.success(`Started ${created.metadata.name}`, { description: 'Same script, same arguments, same runners.' })
      invalidate()
      onOpenRun?.(created.metadata.namespace ?? namespace, created.metadata.name)
    },
    onError: (e: Error) => toast.error('Could not start a rerun', { description: e.message }),
  })
  const remove = useMutation({
    mutationFn: async (opts: { saveLogs: boolean }) => {
      if (opts.saveLogs && pods.length) download(`${name}-logs.txt`, await fetchAllLogs(namespace, pods))
      await deleteTestRun(namespace, name)
    },
    onSuccess: (_d, _v) => {
      toast.success(confirm === 'stop' ? 'Run stopped' : 'Test run deleted', {
        description: confirm === 'stop' ? 'The TestRun and its runner pods were deleted, which ends the load immediately.' : undefined,
      })
      setConfirm(null)
      invalidate()
      onClose()
    },
    onError: (e: Error) => toast.error(confirm === 'stop' ? 'Could not stop the run' : 'Could not delete the run', { description: e.message }),
  })
  const bundle = useMutation({
    mutationFn: async () => download(`${name}-logs.txt`, await fetchAllLogs(namespace, pods)),
    onSuccess: () => toast.success('Logs downloaded', { description: `${pods.length} pod${pods.length === 1 ? '' : 's'}` }),
    onError: (e: Error) => toast.error('Could not download the logs', { description: e.message }),
  })

  const copy = (text: string, what: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`Copied ${what}`),
      (e: Error) => toast.error('Could not copy', { description: e.message }),
    )

  const report = () => {
    if (!run || !lc) return ''
    return runReportHtml({
      name,
      namespace,
      test,
      commit: run.metadata.labels?.[LABEL_COMMIT],
      application: run.metadata.labels?.[LABEL_APPLICATION],
      stage: run.status?.stage ?? 'initialization',
      parallelism: run.spec?.parallelism ?? 1,
      lifecycle: lc,
      plan,
      summary,
      metrics,
      pods,
      logGroups: activity.groups,
      link: runLink(namespace, name),
      generatedAt: new Date(),
    })
  }
  const printReport = () => {
    const w = globalThis.open('', '_blank')
    if (!w) {
      toast.error('The browser blocked the report window', { description: 'Allow pop-ups for the console, or download the HTML report instead.' })
      return
    }
    w.document.write(report())
    w.document.close()
    w.focus()
    setTimeout(() => w.print(), 300)
  }

  const grafanaHref = grafana && window
    ? `${grafana.replace(/\/$/, '')}${k6Board.data?.url ?? '/'}?from=${window.startMs}&to=${window.endMs}${k6Board.data ? `&var-testid=${encodeURIComponent(name)}` : ''}`
    : undefined

  const busy = resume.isPending || rerun.isPending || remove.isPending
  const progress = lc ? runProgress(lc, plan, now) : undefined
  const outcome = lc ? OUTCOME_BADGE[lc.outcome] : undefined
  const loadStarted = lc?.loadStartMs !== undefined

  // The one action that matters right now, as the primary button.
  let primaryAction: ReactNode = null
  if (run && running && isPaused(run) && !loadStarted && canPatch) {
    primaryAction = <Button size="sm" variant="primary" loading={resume.isPending} disabled={busy} onClick={() => resume.mutate()}>Resume</Button>
  } else if (run && running && canDelete) {
    primaryAction = <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirm('stop')}>Stop</Button>
  } else if (run && !running && canRerun) {
    primaryAction = <Button size="sm" variant="primary" loading={rerun.isPending} disabled={busy} onClick={() => rerun.mutate()}>Run again</Button>
  }

  const items: MenuItem[] = [
    { label: 'Copy link', onSelect: () => copy(runLink(namespace, name), 'the link to this run') },
    { label: 'Copy run name', onSelect: () => copy(`${namespace}/${name}`, 'the run name') },
    ...(test && onOpenTest ? [{ label: 'Open the test', onSelect: () => onOpenTest(test) }] : []),
    ...(run && canRerun && running ? [{ label: 'Run again', onSelect: () => rerun.mutate() }] : []),
    ...(run && canRerun && onDuplicate ? [{ label: 'Duplicate with changes…', onSelect: () => onDuplicate(run) }] : []),
    ...(grafanaHref ? [{ label: k6Board.data ? `Open "${k6Board.data.title}" in Grafana` : 'Open this window in Grafana', href: grafanaHref }] : []),
    { divider: true, label: '' },
    ...(pods.length ? [{ label: bundle.isPending ? 'Downloading logs…' : 'Download all logs', onSelect: () => bundle.mutate(), disabled: bundle.isPending }] : []),
    ...(lc ? [{ label: 'Download report (HTML)', onSelect: () => download(`${name}-report.html`, report(), 'text/html;charset=utf-8') }] : []),
    ...(lc ? [{ label: 'Print report / save as PDF', onSelect: printReport }] : []),
    ...(run && canDelete && !running ? [{ divider: true, label: '' }, { label: 'Delete run…', danger: true, onSelect: () => setConfirm('delete') }] : []),
  ]

  const parallelism = run?.spec?.parallelism ?? 1
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-edge-default px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {outcome ? <StatusBadge kind={outcome.kind} pulse={running}>{lc?.heldPaused ? 'paused' : outcome.label}</StatusBadge> : null}
          <span className="min-w-0 truncate font-semibold text-content" title={name}>{test ?? name}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-[11px] text-content-subtle">
          {test ? <span className="truncate font-mono" title={name}>{name}</span> : null}
          <span>{namespace}</span>
          {run ? <span>{parallelism} runner{parallelism === 1 ? '' : 's'}</span> : null}
          {progress?.elapsedSecs !== undefined
            ? <span className="tabular-nums">{fmtSecs(progress.elapsedSecs)}{progress.plannedSecs ? ` of ${progress.plannedIsUpperBound ? '≤' : ''}${fmtSecs(progress.plannedSecs)}` : ''}</span>
            : null}
          {run?.metadata.creationTimestamp
            ? <span title={formatAbsolute(run.metadata.creationTimestamp)}>{formatRelative(run.metadata.creationTimestamp)}</span>
            : loading
            ? <span>loading…</span>
            : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {primaryAction}
        <OverflowMenu items={items} open={menu} onOpen={setMenu} />
        <DrawerWidenButton wide={width.wide} onToggle={width.toggle} />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-md px-2 py-1 text-content-muted hover:bg-surface-sunken hover:text-content"
        >
          ✕
        </button>
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => (remove.isPending ? undefined : setConfirm(null))}
        title={confirm === 'stop' ? 'Stop this run?' : 'Delete this run?'}
        description={confirm === 'stop'
          ? 'k6 has no graceful stop through the operator: stopping deletes the TestRun and its runner pods, which ends the load at once. k6 prints no end-of-test summary for a stopped run, and the pods’ logs go with them.'
          : harvested
          ? 'Its kept result stays under Results; the TestRun and its pods are removed from the cluster.'
          : 'This run’s result has not been kept yet — deleting it now loses its summary for good.'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={remove.isPending}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate({ saveLogs: saveLogs && pods.length > 0 })}>
              {confirm === 'stop' ? 'Stop run' : 'Delete run'}
            </Button>
          </>
        }
      >
        {pods.length
          ? (
            <Checkbox
              checked={saveLogs}
              onChange={(e) => setSaveLogs(e.currentTarget.checked)}
              label={`Download every pod’s logs first (${pods.length} pod${pods.length === 1 ? '' : 's'})`}
              description="One text file, each pod’s output under its own heading."
            />
          )
          : <p className="text-[13px] text-content-muted">There are no pods left to keep logs from.</p>}
      </Modal>
    </div>
  )
}

interface MenuItem {
  label: string
  onSelect?(): void
  href?: string
  danger?: boolean
  disabled?: boolean
  divider?: boolean
}

/** A small "⋯" menu. Esc closes the menu first (overlay stack), not the drawer. */
function OverflowMenu({ items, open, onOpen }: { items: MenuItem[]; open: boolean; onOpen(open: boolean): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useOverlayDismiss(open, () => onOpen(false), { lockScroll: false })
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    // Focus the first item, so the menu is usable from the keyboard.
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, onOpen])
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])]
    const i = els.indexOf(document.activeElement as HTMLElement)
    els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus()
  }
  const cls = (it: MenuItem) =>
    cn(
      'block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] focus:outline-none focus-visible:bg-surface-sunken',
      it.disabled ? 'cursor-default text-content-subtle' : it.danger ? 'text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10' : 'text-content hover:bg-surface-sunken',
    )
  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="secondary" aria-haspopup="menu" aria-expanded={open} aria-label="More actions" title="More actions" onClick={() => onOpen(!open)}>
        ⋯
      </Button>
      {open
        ? (
          <div role="menu" onKeyDown={onKey} className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg border border-edge-default bg-surface-raised p-1 shadow-xl">
            {items.map((it, i) =>
              it.divider
                ? <div key={`d${i}`} role="separator" className="my-1 h-px bg-edge-subtle" />
                : it.href
                ? (
                  <a key={it.label} role="menuitem" href={it.href} target="_blank" rel="noreferrer" className={cls(it)} onClick={() => onOpen(false)}>
                    {it.label} ↗
                  </a>
                )
                : (
                  <button
                    key={it.label}
                    type="button"
                    role="menuitem"
                    aria-disabled={it.disabled || undefined}
                    className={cls(it)}
                    onClick={() => {
                      if (it.disabled) return
                      onOpen(false)
                      it.onSelect?.()
                    }}
                  >
                    {it.label}
                  </button>
                )
            )}
          </div>
        )
        : null}
    </div>
  )
}

/* ─────────────────────────── overview ─────────────────────────── */

function OverviewTab({
  run,
  lc,
  plan,
  planLoading,
  now,
  pods,
  podsLoading,
  summary,
  metrics,
  live,
  verdict,
  onLogs,
}: {
  run: TestRun
  lc: Lifecycle
  plan?: LoadPlan
  planLoading: boolean
  now: number
  pods: PodDetail[]
  podsLoading: boolean
  summary?: K6Summary
  metrics?: RunMetrics
  live: LiveData
  verdict?: GateVerdict
  onLogs(o?: { search?: string; level?: LevelFilter }): void
}) {
  return (
    <div className="space-y-4">
      <ProgressCanvas run={run} lc={lc} plan={plan} planLoading={planLoading} now={now} live={live} verdict={verdict} />
      <KpiTiles lc={lc} plan={plan} now={now} metrics={metrics} live={live} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ThresholdsCard plan={plan} summary={summary} live={live} running={lc.running} />
        <PodsCard run={run} pods={pods} loading={podsLoading} />
      </div>
      <ErrorsCard activity={live.activity} running={lc.running} onLogs={onLogs} />
      <ConditionsDetails run={run} />
    </div>
  )
}

const PHASE_DOT: Record<Phase['state'], string> = {
  done: 'bg-emerald-500 text-white',
  active: 'bg-brand-600 text-white',
  failed: 'bg-rose-600 text-white',
  pending: 'border border-dashed border-edge-strong bg-surface-raised text-content-subtle',
  skipped: 'bg-surface-sunken text-content-subtle',
}

/**
 * The run at a glance: where it is in its lifecycle, how far through its
 * plan, and the plan itself drawn as a VU profile with the elapsed part
 * filled — the ramp-up, the steady state and the ramp-down are visible as
 * shapes rather than read from a script.
 */
function ProgressCanvas({ run, lc, plan, planLoading, now, live, verdict }: {
  run: TestRun
  lc: Lifecycle
  plan?: LoadPlan
  planLoading: boolean
  now: number
  live: LiveData
  verdict?: GateVerdict
}) {
  const k6Line = live.progress.last
    ? { elapsedSecs: live.progress.last.elapsedSecs, plannedSecs: live.progress.plannedSecs, percent: lc.running ? live.progress.percent : undefined }
    : undefined
  const prog = runProgress(lc, plan, now, k6Line)
  const pct = prog.pct
  const tone = lc.outcome === 'passed'
    ? 'bg-emerald-500'
    : lc.outcome === 'in-progress'
    ? 'bg-brand-500'
    : lc.outcome === 'unknown'
    ? 'bg-slate-400'
    : lc.outcome === 'aborted'
    ? 'bg-amber-500'
    : 'bg-rose-500'

  const headline = lc.running
    ? lc.heldPaused
      ? 'Paused before the start'
      : lc.current === 'initializing'
      ? 'Preparing the script'
      : lc.current === 'starting'
      ? 'Starting the runners'
      : lc.current === 'finishing'
      ? 'Wrapping up'
      : prog.segment === 'ramp-up'
      ? 'Ramping up'
      : prog.segment === 'ramp-down'
      ? 'Ramping down'
      : prog.segment === 'steady'
      ? 'Holding steady load'
      : 'Generating load'
    : lc.outcome === 'passed'
    ? 'Ran to the end — every threshold held'
    : lc.outcome === 'thresholds-failed'
    ? 'Ran to the end — thresholds crossed'
    : lc.outcome === 'failed'
    ? 'The test could not run'
    : lc.outcome === 'aborted'
    ? 'Stopped before the end'
    : 'Finished'

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-content">{headline}</div>
            <div className="mt-0.5 text-[12px] text-content-muted">
              {lc.outcomeDetail ?? lc.phases.find((p) => p.id === lc.current)?.detail ?? (lc.running ? 'Waiting for the operator.' : '')}
            </div>
          </div>
          {verdict && !lc.running
            ? (
              <div className="text-right">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Gate</div>
                <VerdictBadge verdict={verdict} compact />
              </div>
            )
            : null}
        </div>

        {prog.elapsedSecs === undefined && !lc.running ? null : (
        <div>
          <div className="flex items-baseline justify-between gap-2 text-[11px] text-content-subtle">
            <span className="tabular-nums">
              {prog.elapsedSecs !== undefined ? fmtSecs(prog.elapsedSecs) : lc.running ? 'not started' : '—'}
              {prog.plannedSecs ? <> of {prog.plannedIsUpperBound ? 'at most ' : ''}{fmtSecs(prog.plannedSecs)}</> : null}
              {lc.running && prog.remainingSecs !== undefined && prog.remainingSecs > 0 && !prog.plannedIsUpperBound
                ? <> · about {fmtSecs(prog.remainingSecs)} left</>
                : null}
              {prog.overrun && lc.running ? ' · past the plan (graceful stop)' : null}
            </span>
            <span className="font-mono tabular-nums text-content">{pct !== undefined ? `${Math.round(pct)}%` : ''}</span>
          </div>
          <div
            className="mt-1 h-2 overflow-hidden rounded-full bg-surface-sunken"
            role="progressbar"
            aria-label="Run progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct !== undefined ? Math.round(pct) : undefined}
          >
            <div
              className={cn('h-full rounded-full transition-[width] duration-700', tone, pct === undefined && lc.running && 'w-1/3 animate-pulse')}
              style={pct !== undefined ? { width: `${Math.max(1.5, pct)}%` } : !lc.running ? { width: '100%' } : undefined}
            />
          </div>
        </div>
        )}

        <PlanProfile plan={plan} planLoading={planLoading} lc={lc} elapsed={prog.elapsedSecs} live={live} />

        <PhaseRail lc={lc} now={now} />
        {run.spec?.parallelism && run.spec.parallelism > 1 ? <RunnerStrip lc={lc} parallelism={run.spec.parallelism} /> : null}
      </CardBody>
    </Card>
  )
}

const SEGMENT_TONE: Record<string, string> = {
  'ramp-up': 'text-brand-700 dark:text-brand-300',
  steady: 'text-emerald-700 dark:text-emerald-300',
  'ramp-down': 'text-amber-700 dark:text-amber-300',
}

/**
 * The planned VU profile as an area, the elapsed part shaded, a "now" line,
 * and — when the run reports them — the VUs actually reached drawn on top.
 */
function PlanProfile({ plan, planLoading, lc, elapsed, live }: { plan?: LoadPlan; planLoading: boolean; lc: Lifecycle; elapsed?: number; live: LiveData }) {
  const [hover, setHover] = useState<number | null>(null)
  // Drawn at its real width so the axis text stays legible on a phone.
  const [boxRef, measured] = useMeasuredWidth()
  const curve = plan ? plannedVuCurve(plan) : []
  const segments = plan ? planSegments(plan) : []
  // Actual VUs, in seconds since load start: k6's own remote series, else its
  // progress lines.
  const actual: Array<[number, number]> = useMemo(() => {
    const remote = live.remote.get('vus')?.find((s) => s.name === 'VUs')?.points
    if (remote?.length && lc.loadStartMs !== undefined) return remote.map(([t, v]) => [(t - lc.loadStartMs!) / 1000, v] as [number, number]).filter(([t]) => t >= 0)
    return live.progress.points.map((p) => [p.elapsedSecs, p.vus] as [number, number])
  }, [live.remote, live.progress.points, lc.loadStartMs])

  if (planLoading) return <Skeleton className="block h-28 w-full rounded-lg" />
  if (!curve.length) {
    return (
      <div className="rounded-lg border border-dashed border-edge-default px-3 py-2.5 text-[11px] text-content-muted">
        {plan?.scenarios.length
          ? `The plan has no VU profile to draw (${plan.scenarios.map((s) => s.executor).join(', ')})${plan.totalSecs ? ` — it runs for ${plan.totalIsUpperBound ? 'at most ' : ''}${fmtSecs(plan.totalSecs)}` : ''}.`
          : plan?.note ?? 'The script’s load plan could not be read, so progress is shown as elapsed time only.'}
      </div>
    )
  }

  const W = measured > 0 ? Math.round(measured) : 640
  const H = 112
  const PAD = { l: 30, r: 8, t: 8, b: 20 }
  const pw = W - PAD.l - PAD.r
  const ph = H - PAD.t - PAD.b
  const span = Math.max(curve[curve.length - 1][0], elapsed ?? 0, ...actual.map(([t]) => t), 1)
  const peak = Math.max(1, ...curve.map(([, v]) => v), ...actual.map(([, v]) => v))
  const x = (t: number) => PAD.l + (Math.min(t, span) / span) * pw
  const y = (v: number) => PAD.t + ph - (v / peak) * ph
  const area = `M${x(0)},${y(0)} ${curve.map(([t, v]) => `L${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} L${x(curve[curve.length - 1][0])},${y(0)} Z`
  const line = curve.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const actualLine = actual.length > 1 ? actual.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ') : ''
  const clipId = `elapsed-${lc.createdMs ?? 0}`
  const plannedAt = (t: number) => {
    for (let i = 1; i < curve.length; i++) {
      const [t0, v0] = curve[i - 1]
      const [t1, v1] = curve[i]
      if (t <= t1) return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1
    }
    return 0
  }
  const nearestActual = (t: number) => actual.reduce<[number, number] | undefined>((b, p) => (!b || Math.abs(p[0] - t) < Math.abs(b[0] - t) ? p : b), undefined)
  const hoverT = hover === null ? null : ((hover - PAD.l) / pw) * span

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-content-subtle">
        <span className="font-semibold uppercase tracking-wider">Load plan</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-brand-500/25 ring-1 ring-brand-500/60" /> planned VUs{plan?.source === 'arguments' ? ' (from the run’s arguments)' : ''}</span>
        {actualLine ? <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-emerald-500" /> actual VUs</span> : null}
        <span className="ml-auto tabular-nums">peak {Math.round(plan?.maxVus ?? peak)} VUs</span>
      </div>
      <div ref={boxRef} className="relative">
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block"
          role="img"
          aria-label={`Planned load: ${segments.map((s) => `${s.kind} ${fmtSecs(s.endSecs - s.startSecs)} to ${Math.round(s.toVus)} VUs`).join(', ')}`}
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
            const px = ((e.clientX - r.left) / r.width) * W
            setHover(px < PAD.l || px > W - PAD.r ? null : px)
          }}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.l} y={0} width={Math.max(0, x(elapsed ?? 0) - PAD.l)} height={H} />
            </clipPath>
          </defs>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(peak * f)} y2={y(peak * f)} stroke="var(--color-edge-default)" strokeDasharray={f ? '3 4' : undefined} />
              <text x={PAD.l - 5} y={y(peak * f) + 3} textAnchor="end" fontSize="9" fill="var(--color-content-subtle)" fontFamily="var(--font-mono)">{Math.round(peak * f)}</text>
            </g>
          ))}
          {segments.map((s) => (
            <g key={s.startSecs}>
              <line x1={x(s.startSecs)} x2={x(s.startSecs)} y1={PAD.t} y2={PAD.t + ph} stroke="var(--color-edge-subtle)" />
              <text x={(x(s.startSecs) + x(s.endSecs)) / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--color-content-subtle)">
                {x(s.endSecs) - x(s.startSecs) > 70 ? `${s.kind} · ${fmtSecs(s.endSecs - s.startSecs)}` : x(s.endSecs) - x(s.startSecs) > 34 ? fmtSecs(s.endSecs - s.startSecs) : ''}
              </text>
            </g>
          ))}
          <path d={area} fill="var(--color-brand-500)" fillOpacity="0.1" />
          <path d={area} fill="var(--color-brand-500)" fillOpacity="0.32" clipPath={`url(#${clipId})`} />
          <path d={line} fill="none" stroke="var(--color-brand-500)" strokeWidth="1.5" strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />
          {actualLine ? <path d={actualLine} fill="none" stroke="var(--color-emerald-500)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null}
          {elapsed !== undefined && lc.running
            ? <line x1={x(elapsed)} x2={x(elapsed)} y1={PAD.t - 2} y2={PAD.t + ph} stroke="var(--color-brand-600)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            : null}
          {hoverT !== null ? <line x1={hover!} x2={hover!} y1={PAD.t} y2={PAD.t + ph} stroke="var(--color-content-subtle)" strokeDasharray="2 3" /> : null}
        </svg>
        {hoverT !== null
          ? (
            <div
              className="pointer-events-none absolute top-0 z-10 rounded-md border border-edge-default bg-surface-raised/95 px-2 py-1 font-mono text-[10px] text-content shadow-md"
              style={{ left: `${Math.min(88, Math.max(10, (hover! / W) * 100))}%`, transform: 'translateX(-50%)' }}
            >
              <div className="text-content-subtle">+{fmtSecs(hoverT)}</div>
              <div>planned {Math.round(plannedAt(hoverT))} VUs</div>
              {actual.length ? <div>actual {Math.round(nearestActual(hoverT)?.[1] ?? 0)} VUs</div> : null}
            </div>
          )
          : null}
      </div>
      {segments.length
        ? (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
            {segments.map((s) => (
              <span key={s.startSecs} className={SEGMENT_TONE[s.kind]}>
                {s.kind} {fmtSecs(s.endSecs - s.startSecs)} → {Math.round(s.toVus)} VUs
              </span>
            ))}
          </div>
        )
        : null}
    </div>
  )
}

/** The lifecycle as CI stages: a node per phase, with its duration. */
function PhaseRail({ lc, now }: { lc: Lifecycle; now: number }) {
  return (
    <ol className="grid grid-cols-1 gap-1 sm:grid-cols-6 sm:gap-0" aria-label="Lifecycle">
      {lc.phases.map((p, i) => {
        const end = p.endMs ?? (p.state === 'active' ? now : undefined)
        const secs = p.startMs !== undefined && end !== undefined ? (end - p.startMs) / 1000 : undefined
        return (
          <li key={p.id} className="flex min-w-0 items-center gap-2 sm:flex-col sm:items-stretch sm:gap-1" title={p.detail}>
            <div className="flex items-center gap-1.5">
              <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold', PHASE_DOT[p.state])} aria-hidden>
                {p.state === 'done' ? '✓' : p.state === 'failed' ? '!' : p.state === 'active' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> : p.state === 'skipped' ? '–' : ''}
              </span>
              {i < lc.phases.length - 1
                ? <span aria-hidden className={cn('hidden h-0.5 flex-1 rounded sm:block', p.state === 'done' ? 'bg-emerald-400/70' : p.state === 'failed' ? 'bg-rose-400/60' : 'bg-edge-default')} />
                : null}
            </div>
            <div className="min-w-0 sm:pr-2">
              <div className={cn('truncate text-[11px] font-medium', p.state === 'active' ? 'text-content' : p.state === 'failed' ? 'text-rose-700 dark:text-rose-300' : 'text-content-muted')}>
                {p.label}
                <span className="sr-only"> — {p.state}</span>
              </div>
              <div className="truncate font-mono text-[10px] tabular-nums text-content-subtle">
                {p.state === 'pending' ? 'pending' : p.state === 'skipped' ? 'not reached' : p.id === 'complete' ? (p.startMs ? new Date(p.startMs).toLocaleTimeString() : '—') : secs !== undefined ? fmtSecs(secs) : '—'}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** One cell per runner: whether it is up, generating load, done or failed. */
function RunnerStrip({ lc, parallelism }: { lc: Lifecycle; parallelism: number }) {
  const slots = Array.from({ length: parallelism }, (_, i) => lc.runners.find((r) => r.index === i + 1))
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Runners</div>
      <div className="flex flex-wrap gap-1">
        {slots.map((r, i) => (
          <span
            key={i}
            title={r ? `runner ${i + 1} · ${r.state}${r.exitCode !== undefined ? ` · ${exitMeaning(r.exitCode)}` : ''}${r.node ? ` · ${r.node}` : ''}` : `runner ${i + 1} · not created yet`}
            className={cn(
              'flex h-6 min-w-6 items-center justify-center rounded px-1 font-mono text-[10px] tabular-nums',
              !r
                ? 'border border-dashed border-edge-strong text-content-subtle'
                : r.state === 'running'
                ? 'bg-brand-600 text-white'
                : r.state === 'succeeded'
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : r.state === 'failed'
                ? r.exitCode === 99 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                : 'bg-surface-sunken text-content-muted',
            )}
          >
            {i + 1}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────── KPIs ─────────────────────────── */

interface Kpi {
  label: string
  value: string
  hint?: string
  tone?: 'good' | 'bad'
}

/**
 * Headline numbers from the best source that has them, each saying where it
 * came from: the end-of-test summary once the run is over, k6's remote-write
 * series while it runs, else its progress lines, else the logs.
 */
function KpiTiles({ lc, plan, now, metrics, live }: { lc: Lifecycle; plan?: LoadPlan; now: number; metrics?: RunMetrics; live: LiveData }) {
  const r = live.remote
  const remoteLast = (chart: string, series: string) => lastValue(r.get(chart)?.find((s) => s.name === series)?.points.map(([t, v]) => ({ t, v })))
  const prog = runProgress(lc, plan, now)
  const lastProgress = live.progress.last
  const tiles: Kpi[] = []
  // A run that never generated load has no numbers to show — saying "—" six
  // times reads as a broken page rather than a test that did not start.
  if (!lc.running && !metrics && lc.loadStartMs === undefined) return null

  if (metrics && !lc.running) {
    tiles.push(
      { label: 'Throughput', value: metrics.rps !== undefined ? `${fmtCount(metrics.rps)}/s` : '—', hint: metrics.requests !== undefined ? `${fmtCount(metrics.requests)} requests` : 'no HTTP requests' },
      { label: 'p95 latency', value: metrics.p95Ms !== undefined ? fmtMs(metrics.p95Ms) : '—', hint: metrics.p99Ms !== undefined ? `p99 ${fmtMs(metrics.p99Ms)}` : metrics.medMs !== undefined ? `median ${fmtMs(metrics.medMs)}` : undefined },
      {
        label: 'Failed requests',
        value: metrics.errorRatePct !== undefined ? `${metrics.errorRatePct.toFixed(metrics.errorRatePct < 1 ? 2 : 1)}%` : '—',
        tone: metrics.errorRatePct === undefined ? undefined : metrics.errorRatePct >= 1 ? 'bad' : 'good',
        hint: 'http_req_failed',
      },
      {
        label: 'Checks',
        value: metrics.checksPct !== undefined ? `${metrics.checksPct.toFixed(metrics.checksPct > 99 && metrics.checksPct < 100 ? 2 : 0)}%` : '—',
        tone: metrics.checksPct === undefined ? undefined : metrics.checksPct >= 99 ? 'good' : 'bad',
        hint: metrics.checksPct !== undefined ? 'passed' : 'no checks in the script',
      },
      { label: 'Peak VUs', value: metrics.vusMax !== undefined ? String(metrics.vusMax) : '—', hint: plan?.maxVus !== undefined ? `planned ${plan.maxVus}` : undefined },
      { label: 'Iterations', value: fmtCount(metrics.iterations), hint: 'completed' },
    )
  } else {
    const vus = remoteLast('vus', 'VUs') ?? lastProgress?.vus
    tiles.push({
      label: 'Virtual users',
      value: vus !== undefined ? String(Math.round(vus)) : prog.targetVus !== undefined ? `~${prog.targetVus}` : '—',
      hint: vus !== undefined
        ? prog.targetVus !== undefined ? `target ${prog.targetVus}` : plan?.maxVus ? `of ${plan.maxVus}` : 'active'
        : prog.targetVus !== undefined ? 'planned right now' : lc.running ? 'once load starts' : undefined,
    })
    const rps = remoteLast('rps', 'requests/s')
    const itRate = live.progress.rate.at(-1)?.perSec
    tiles.push({
      label: 'Throughput',
      value: rps !== undefined ? `${fmtCount(rps)}/s` : itRate !== undefined ? `${fmtCount(itRate)} it/s` : '—',
      hint: rps !== undefined ? 'requests, last 30s' : itRate !== undefined ? 'iterations, last interval' : 'needs k6’s Prometheus output',
    })
    const p95 = remoteLast('latency', 'p95')
    tiles.push({ label: 'p95 latency', value: p95 !== undefined ? fmtMs(p95) : '—', hint: p95 !== undefined ? 'so far' : 'in the summary at the end' })
    const err = remoteLast('errors', 'failed requests')
    const logged = live.activity.totals.warning + live.activity.totals.error
    tiles.push({
      label: 'Failures',
      value: err !== undefined ? `${err.toFixed(err < 1 ? 2 : 1)}%` : logged ? fmtCount(logged) : '0',
      tone: err !== undefined ? (err >= 1 ? 'bad' : 'good') : logged ? 'bad' : undefined,
      hint: err !== undefined ? 'failed requests so far' : logged ? 'warnings & errors logged' : 'none logged so far',
    })
    const sent = remoteLast('data', 'sent') ?? lastValue(live.resources.get('data')?.find((s) => s.name === 'sent')?.points.map(([t, v]) => ({ t, v })))
    tiles.push({ label: 'Data out', value: sent !== undefined ? `${fmtBytes(sent)}/s` : '—', hint: r.get('data') ? 'k6, last 30s' : sent !== undefined ? 'runner network (cAdvisor)' : 'not measured yet' })
    const itRemote = remoteLast('iterations', 'iterations/s')
    tiles.push(
      lastProgress
        ? { label: 'Iterations', value: fmtCount(lastProgress.complete), hint: `${lastProgress.interrupted} interrupted` }
        : itRemote !== undefined
        ? { label: 'Iterations', value: `${fmtCount(itRemote)}/s`, hint: 'last 30s' }
        : { label: 'Iterations', value: '—', hint: 'counted in the summary' },
    )
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className="min-w-0 rounded-xl border border-edge-default bg-surface-raised px-3 py-2.5">
          <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{t.label}</div>
          <div
            className={cn(
              'mt-1 truncate font-mono text-[17px] font-semibold tabular-nums leading-none',
              t.tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : t.tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : 'text-content',
            )}
          >
            {t.value}
          </div>
          {t.hint ? <div className="mt-1 truncate text-[10px] text-content-subtle" title={t.hint}>{t.hint}</div> : null}
        </div>
      ))}
    </div>
  )
}

/* ─────────────────────────── thresholds ─────────────────────────── */

/** Threshold aggregations a remote-write series answers live. */
function liveThresholdValues(metric: string, live: LiveData): Partial<Record<string, number>> {
  const last = (chart: string, series: string) => lastValue(live.remote.get(chart)?.find((s) => s.name === series)?.points.map(([t, v]) => ({ t, v })))
  const base = metric.replace(/\{.*\}$/, '')
  if (base === 'http_req_duration') {
    return { avg: last('latency', 'avg'), med: last('latency', 'p50'), 'p(90)': last('latency', 'p90'), 'p(95)': last('latency', 'p95'), 'p(99)': last('latency', 'p99') }
  }
  if (base === 'http_req_failed') {
    const v = last('errors', 'failed requests')
    return { rate: v === undefined ? undefined : v / 100 }
  }
  if (base === 'checks') {
    const v = last('checks', 'checks passed')
    return { rate: v === undefined ? undefined : v / 100 }
  }
  return {}
}

function ThresholdsCard({ plan, summary, live, running }: { plan?: LoadPlan; summary?: K6Summary; live: LiveData; running: boolean }) {
  const final = summary?.thresholds ?? []
  const declared = plan?.thresholds ?? []
  // Final results win; declared-but-unevaluated ones are listed as pending (or
  // evaluated live when k6 remote-writes the aggregation they name).
  const rows = final.length
    ? final.map((t) => ({ metric: t.metric, expression: t.expression, state: t.passed ? 'pass' as const : 'fail' as const, actual: t.actual, live: false }))
    : declared.map((t) => {
      const v = evalThreshold(t.expression, liveThresholdValues(t.metric, live))
      return { metric: t.metric, expression: t.expression, state: v === undefined ? 'pending' as const : v ? 'pass' as const : 'fail' as const, actual: undefined, live: v !== undefined }
    })
  const failed = rows.filter((r) => r.state === 'fail').length
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="text-[12px] font-semibold text-content">Thresholds</div>
          {rows.length
            ? (
              <StatusBadge kind={failed ? 'degraded' : rows.every((r) => r.state === 'pass') ? 'healthy' : 'unknown'}>
                {failed ? `${failed} failing` : rows.every((r) => r.state === 'pass') ? 'all passing' : running ? 'evaluated at the end' : 'not evaluated'}
              </StatusBadge>
            )
            : null}
        </div>
      </CardHeader>
      <CardBody>
        {!rows.length
          ? (
            <p className="text-[12px] text-content-muted">
              {plan && plan.source !== 'none'
                ? 'The script declares no thresholds, so k6 has no pass/fail criteria. Add a thresholds block to turn this run into a gate.'
                : 'Thresholds appear here from the script, and their results once k6 prints its summary.'}
            </p>
          )
          : (
            <ul className="space-y-1.5">
              {rows.map((t) => (
                <li key={`${t.metric}:${t.expression}`} className="flex min-w-0 items-center gap-2 text-[12px]">
                  <span
                    aria-label={t.state}
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                      t.state === 'pass' ? 'bg-emerald-500 text-white' : t.state === 'fail' ? 'bg-rose-600 text-white' : 'border border-dashed border-edge-strong',
                    )}
                  >
                    {t.state === 'pass' ? '✓' : t.state === 'fail' ? '✗' : ''}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-content">{t.metric}</span>
                  <code className="shrink-0 text-[11px] text-content-muted">{t.expression}</code>
                  <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-content-subtle">
                    {t.actual ?? (t.live ? 'live' : t.state === 'pending' ? 'pending' : '')}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── pods ─────────────────────────── */

const POD_TONE: Record<PodDetail['state'], StatusKind> = {
  pending: 'paused',
  waiting: 'paused',
  running: 'progressing',
  succeeded: 'healthy',
  failed: 'failed',
  unknown: 'unknown',
}

function PodsCard({ run, pods, loading }: { run: TestRun; pods: PodDetail[]; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="text-[12px] font-semibold text-content">Pods</div>
          <span className="text-[11px] text-content-subtle">initializer · {run.spec?.parallelism ?? 1} runner{(run.spec?.parallelism ?? 1) === 1 ? '' : 's'} · starter</span>
        </div>
      </CardHeader>
      <CardBody>
        {loading
          ? <div className="space-y-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="block h-5 w-full" />)}</div>
          : !pods.length
          ? (
            <p className="text-[12px] text-content-muted">
              {isRunning(run)
                ? 'The operator has not created any pods yet.'
                : run.spec?.cleanup === 'post'
                ? 'The operator removed this run’s pods when it finished (cleanup: post), and their logs with them.'
                : 'This run’s pods are gone.'}
            </p>
          )
          : (
            <ul className="space-y-1.5">
              {pods.map((p) => {
                const dur = p.startedAt ? ((p.finishedAt ? Date.parse(p.finishedAt) : Date.now()) - Date.parse(p.startedAt)) / 1000 : undefined
                return (
                  <li key={p.name} className="flex min-w-0 items-center gap-2 text-[12px]">
                    <StatusBadge kind={p.state === 'failed' && p.exitCode === 99 ? 'degraded' : POD_TONE[p.state]} pulse={p.state === 'running'}>
                      {p.role === 'runner' ? `runner ${p.index ?? ''}`.trim() : p.role}
                    </StatusBadge>
                    <span className="min-w-0 truncate font-mono text-[10px] text-content-subtle" title={p.name}>{p.name}</span>
                    <span className="ml-auto shrink-0 text-right text-[11px] text-content-muted">
                      {p.exitCode !== undefined && p.exitCode !== 0 ? exitMeaning(p.exitCode) : p.state === 'waiting' || p.state === 'pending' ? p.reason ?? p.state : p.state}
                      {dur !== undefined ? <span className="ml-1.5 font-mono tabular-nums text-content-subtle">{fmtSecs(dur)}</span> : null}
                      {p.restarts ? <span className="ml-1.5 text-amber-700 dark:text-amber-300">{p.restarts}↻</span> : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
      </CardBody>
    </Card>
  )
}

/* ─────────────────────────── errors ─────────────────────────── */

function ErrorsCard({ activity, running, onLogs }: { activity: LogActivity; running: boolean; onLogs(o?: { search?: string; level?: LevelFilter }): void }) {
  const { groups, totals } = activity
  if (!groups.length) return null
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[12px] font-semibold text-content">What went wrong</div>
          <span className="text-[11px] text-content-subtle">
            {totals.error ? `${fmtCount(totals.error)} error${totals.error === 1 ? '' : 's'}` : ''}
            {totals.error && totals.warning ? ' · ' : ''}
            {totals.warning ? `${fmtCount(totals.warning)} warning${totals.warning === 1 ? '' : 's'}` : ''} logged by runner 1{running ? ' so far' : ''}
          </span>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onLogs({ level: 'problems', search: '' })}>View in logs</Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-1">
        {groups.map((g) => <ErrorRow key={g.key} g={g} max={groups[0].count} onLogs={onLogs} />)}
      </CardBody>
    </Card>
  )
}

function ErrorRow({ g, max, onLogs }: { g: LogGroup; max: number; onLogs(o?: { search?: string; level?: LevelFilter }): void }) {
  return (
    <button
      type="button"
      onClick={() => onLogs({ search: g.msg, level: g.level === 'error' ? 'errors' : 'problems' })}
      title={g.sample}
      className="group relative block w-full overflow-hidden rounded-md px-2 py-1.5 text-left hover:bg-surface-sunken"
    >
      <span
        aria-hidden
        className={cn('absolute inset-y-0 left-0 rounded-md', g.level === 'error' ? 'bg-rose-500/15' : 'bg-amber-500/15')}
        style={{ width: `${Math.max(2, (g.count / max) * 100)}%` }}
      />
      <span className="relative flex min-w-0 items-baseline gap-2 text-[12px]">
        <span className="w-12 shrink-0 text-right font-mono tabular-nums text-content">{fmtCount(g.count)}×</span>
        <span className={cn('shrink-0 text-[10px] font-semibold uppercase', g.level === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300')}>{g.level}</span>
        <span className="shrink-0 font-medium text-content">{g.msg}</span>
        {g.detail && g.detail !== g.msg ? <span className="min-w-0 truncate font-mono text-[11px] text-content-muted">{g.detail}</span> : null}
      </span>
    </button>
  )
}

function ConditionsDetails({ run }: { run: TestRun }) {
  const conds = run.status?.conditions ?? []
  if (!conds.length) return null
  return (
    <details className="rounded-xl border border-edge-default bg-surface-raised px-3 py-2 text-[12px]">
      <summary className="cursor-pointer text-content-muted">Operator conditions ({conds.length})</summary>
      <ul className="mt-2 space-y-1">
        {conds.map((c) => (
          <li key={c.type} className="flex flex-wrap items-baseline gap-2">
            <span className={cn('font-mono text-[11px]', c.status === 'True' ? 'text-content' : 'text-content-subtle')}>{c.type}</span>
            <span className="text-[11px] text-content-muted">{c.reason}</span>
            {c.message && c.message !== c.reason ? <span className="text-[11px] text-content-subtle">{c.message}</span> : null}
            <span className="ml-auto text-[10px] text-content-subtle" title={formatAbsolute(c.lastTransitionTime)}>{formatRelative(c.lastTransitionTime)}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

/* ─────────────────────────── metrics ─────────────────────────── */

const SERIES_COLORS = ['var(--color-brand-500)', 'var(--color-accent-500)', 'var(--color-amber-500)', 'var(--color-rose-500)', 'var(--color-slate-400)']

const RW_SNIPPET = `# In the test's arguments (or the TestRun's spec.arguments):
--out experimental-prometheus-rw

# And in its environment (spec.runner.env):
K6_PROMETHEUS_RW_SERVER_URL=http://<prometheus>:9090/api/v1/write
K6_PROMETHEUS_RW_TREND_STATS=p(50),p(90),p(95),p(99),avg,max

# Prometheus must accept remote writes (enableRemoteWriteReceiver: true).
# The k6 operator tags every sample with testrun_name, which this drawer
# selects on — nothing else to configure.`

function MetricsTab({ run, lc, plan, live, summary, metrics, loading }: {
  run: TestRun
  lc: Lifecycle
  plan?: LoadPlan
  live: LiveData
  summary?: K6Summary
  metrics?: RunMetrics
  loading: boolean
}) {
  const remote = live.remote
  const hasRemote = remote.size > 0
  const fmtT = (t: number) => (lc.loadStartMs !== undefined ? `+${fmtSecs(Math.max(0, (t - lc.loadStartMs) / 1000))}` : new Date(t).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }))
  const color = (list: LiveSeries[]) => list.map((s, i) => ({ name: s.name, points: s.points, color: SERIES_COLORS[i % SERIES_COLORS.length] }))
  const sinceStart = (secs: number) => (lc.loadStartMs ?? 0) + secs * 1000

  // VUs: k6 remote, else progress lines; the plan as a dashed reference.
  const plannedVus = plan && lc.loadStartMs !== undefined ? plannedVuCurve(plan).map(([t, v]) => [sinceStart(t), v] as [number, number]) : []
  const vuSeries = remote.get('vus')?.filter((s) => s.name === 'VUs') ??
    (live.progress.points.length && lc.loadStartMs !== undefined ? [{ name: 'VUs', points: live.progress.points.map((p) => [sinceStart(p.elapsedSecs), p.vus] as [number, number]) }] : [])
  const iterSeries = remote.get('iterations') ??
    (live.progress.rate.length && lc.loadStartMs !== undefined ? [{ name: 'iterations/s', points: live.progress.rate.map((r) => [sinceStart(r.elapsedSecs), r.perSec] as [number, number]) }] : [])
  const logFailures = live.activity.buckets.length > 1
    ? [{ name: `logged failures / ${live.activity.bucketSecs}s`, points: live.activity.buckets.map((b) => [b.t, b.warning + b.error] as [number, number]) }]
    : []
  const data = remote.get('data') ?? live.resources.get('data') ?? []
  const cpu = live.resources.get('cpu') ?? []

  const live$ = lc.running ? 'live' : 'recorded'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
        <span className="font-semibold text-content">Sources</span>
        <SourcePill on={hasRemote} label="k6 Prometheus output" />
        <SourcePill on={live.progress.points.length > 0} label="k6 progress lines" />
        <SourcePill on={live.resources.size > 0} label="runner pods (cAdvisor)" />
        <SourcePill on={live.activity.buckets.length > 0} label="runner logs" />
        <SourcePill on={Boolean(summary)} label="end-of-test summary" />
        {loading ? <span className="text-content-subtle">loading…</span> : null}
      </div>

      {!live.promOk
        ? (
          <EmptyState
            compact
            title="Prometheus is not reachable"
            description={`${live.promReason ?? 'The console could not query Prometheus.'} The charts below that come from the runner’s own output still work.`}
          />
        )
        : null}

      {!hasRemote
        ? (
          <details className="rounded-xl border border-edge-default bg-surface-raised px-3 py-2">
            <summary className="cursor-pointer text-[12px] text-content-muted">
              This run does not export k6’s own metrics, so request rate and latency over time are not available. <span className="font-medium text-brand-700 dark:text-brand-300">How to enable them</span>
            </summary>
            <div className="mt-2">
              <Snippet title="Enable k6’s Prometheus output" hint="Request rate, latency percentiles, error rate and data — live, per run." code={RW_SNIPPET} />
            </div>
          </details>
        )
        : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Virtual users" source={remote.get('vus') ? 'k6' : vuSeries.length ? 'k6 progress' : plannedVus.length > 1 ? 'plan only' : undefined} live={vuSeries.length ? live$ : 'from the script'}>
          <TimeSeriesChart
            series={[...color(vuSeries), ...(plannedVus.length > 1 ? [{ name: 'planned', points: plannedVus, color: 'var(--color-slate-400)', dashed: true }] : [])]}
            height={150}
            formatTime={fmtT}
            formatY={(v) => String(Math.round(v))}
            emptyLabel={lc.running ? 'VUs appear once the runners start' : 'This run reported no VU samples'}
          />
        </ChartCard>

        <ChartCard title="Request rate" source={remote.get('rps') ? 'k6' : undefined} live={live$}>
          {remote.get('rps')
            ? <TimeSeriesChart series={color(remote.get('rps')!)} height={150} formatTime={fmtT} formatY={(v) => `${fmtCount(v)}/s`} />
            : <ChartGap text={metrics?.rps !== undefined ? `Averaged over the run: ${fmtCount(metrics.rps)} requests/s (${fmtCount(metrics.requests)} in total). Per-second rate needs k6’s Prometheus output.` : 'Needs k6’s Prometheus output. The run’s average appears here once it finishes.'} />}
        </ChartCard>

        <ChartCard title="Latency" source={remote.get('latency') ? 'k6' : summary ? 'summary' : undefined} live={remote.get('latency') ? live$ : 'final'}>
          {remote.get('latency')
            ? <TimeSeriesChart series={color(remote.get('latency')!)} height={150} formatTime={fmtT} formatY={(v) => fmtMs(v)} />
            : metrics && [metrics.medMs, metrics.p90Ms, metrics.p95Ms].some((v) => v !== undefined)
            ? <LatencyBars metrics={metrics} />
            : <ChartGap text={lc.running ? 'k6 computes percentiles at the end of the test unless it remote-writes them. They appear here when the run finishes.' : 'This run produced no HTTP latency.'} />}
        </ChartCard>

        <ChartCard title={remote.get('errors') ? 'Errors & checks' : 'Failures'} source={remote.get('errors') ? 'k6' : logFailures.length ? 'runner logs' : undefined} live={live$}>
          {remote.get('errors')
            ? <TimeSeriesChart series={color([...remote.get('errors')!, ...(remote.get('checks') ?? [])])} height={150} formatTime={fmtT} formatY={(v) => `${v.toFixed(1)}%`} yMax={100} />
            : logFailures.length
            ? <TimeSeriesChart series={[{ ...logFailures[0], color: 'var(--color-rose-500)' }]} height={150} formatTime={fmtT} formatY={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))} />
            : <ChartGap text={metrics?.errorRatePct !== undefined ? `${metrics.errorRatePct.toFixed(2)}% of requests failed over the run.` : lc.running ? 'No failures logged so far.' : 'No failures were logged.'} />}
        </ChartCard>

        <ChartCard title="Data transferred" source={remote.get('data') ? 'k6' : data.length ? 'runner network' : undefined} live={live$}>
          <TimeSeriesChart series={color(data)} height={150} formatTime={fmtT} formatY={(v) => `${fmtBytes(v)}/s`} emptyLabel={live.promOk ? 'No network samples for the runners yet' : 'Needs Prometheus'} />
        </ChartCard>

        <ChartCard title={iterSeries.length ? 'Iterations per second' : 'Runner CPU'} source={iterSeries.length ? (remote.get('iterations') ? 'k6' : 'k6 progress') : cpu.length ? 'cAdvisor' : undefined} live={live$}>
          {iterSeries.length
            ? <TimeSeriesChart series={color(iterSeries)} height={150} formatTime={fmtT} formatY={(v) => `${fmtCount(v)}/s`} />
            : <TimeSeriesChart series={color(cpu)} height={150} formatTime={fmtT} formatY={(v) => `${v.toFixed(2)} cores`} emptyLabel={live.promOk ? 'No CPU samples for the runners yet' : 'Needs Prometheus'} />}
        </ChartCard>
      </div>

      {run.spec?.parallelism && run.spec.parallelism > 1 && !hasRemote
        ? <p className="text-[11px] text-content-subtle">Runner-log charts read runner 1 of {run.spec.parallelism}; the runner network and CPU charts sum every runner.</p>
        : null}
    </div>
  )
}

function SourcePill({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]', on ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-surface-sunken text-content-subtle')}>
      <span aria-hidden>{on ? '●' : '○'}</span>
      {label}
      <span className="sr-only">{on ? ' — available' : ' — not available'}</span>
    </span>
  )
}

function ChartCard({ title, source, live, children }: { title: string; source?: string; live: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="text-[12px] font-semibold text-content">{title}</div>
          {source ? <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-subtle">{source} · {live}</span> : null}
        </div>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  )
}

function ChartGap({ text }: { text: string }) {
  return (
    <div className="flex h-[150px] items-center justify-center rounded-lg border border-dashed border-edge-default px-4 text-center text-[11px] leading-relaxed text-content-subtle">
      {text}
    </div>
  )
}

function LatencyBars({ metrics }: { metrics: RunMetrics }) {
  const all: Array<[string, number | undefined]> = [['median', metrics.medMs], ['avg', metrics.avgMs], ['p90', metrics.p90Ms], ['p95', metrics.p95Ms], ['p99', metrics.p99Ms], ['max', metrics.maxMs]]
  const bars = all.flatMap(([label, value]) => (value === undefined ? [] : [{ label, value }]))
  return (
    <div>
      <BarChart bars={bars} height={112} formatY={(v) => fmtMs(v)} />
      <p className="mt-1 text-[10px] text-content-subtle">Distribution over the whole run, from k6’s end-of-test summary.</p>
    </div>
  )
}

/* ─────────────────────────── summary ─────────────────────────── */

function SummaryTab({ run, lc, summary, metrics, source, plan }: {
  run: TestRun
  lc: Lifecycle
  summary?: K6Summary
  metrics?: RunMetrics
  source: SummarySource
  plan?: LoadPlan
}) {
  if (!summary) {
    return (
      <EmptyState
        title={lc.running ? 'k6 prints its summary at the end' : 'No end-of-test summary'}
        description={lc.running
          ? 'The totals, percentiles and threshold results appear here the moment the runners finish. The Overview and Metrics tabs show the run while it happens.'
          : run.spec?.cleanup === 'post'
          ? 'The operator cleaned up this run’s pods before its result was kept, so the summary is gone. Run it again to capture one.'
          : lc.outcome === 'failed'
          ? 'k6 could not run the test, so there is no summary — the Logs tab shows what it printed instead.'
          : 'The runner printed no summary — check the Logs tab for what it did print.'}
      />
    )
  }
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-content-subtle">
        {source.kind === 'kept'
          ? `From the kept result${source.runners > 1 ? `, combined across ${source.runners} runners (throughput adds up; percentiles are the worst runner’s)` : ''}.`
          : source.kind === 'runner' && source.of > 1
          ? `From runner 1 of ${source.of}. The combined result appears once the run is kept under Results.`
          : 'From the runner’s end-of-test summary.'}
      </p>
      <ThresholdsCard plan={plan} summary={summary} live={NO_LIVE} running={false} />
      {metrics ? <KpiTiles lc={lc} plan={plan} now={Date.now()} metrics={metrics} live={NO_LIVE} /> : null}
      {metrics ? <Card><CardHeader><div className="text-[12px] font-semibold text-content">Latency distribution</div></CardHeader><CardBody><LatencyBars metrics={metrics} /></CardBody></Card> : null}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-semibold text-content">All metrics</div>
            {summary.checks
              ? <StatusBadge kind={summary.checks.failed ? 'degraded' : 'healthy'}>{summary.checks.passed} checks passed{summary.checks.failed ? `, ${summary.checks.failed} failed` : ''}</StatusBadge>
              : null}
          </div>
        </CardHeader>
        <CardBody>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[11px]">
              <tbody className="divide-y divide-edge-subtle">
                {summary.metrics.map((m) => (
                  <tr key={m.name}>
                    <td className="whitespace-nowrap py-1 pr-3 text-content-muted">{m.name}</td>
                    <td className="py-1 text-content">{m.raw}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

/* ─────────────────────────── logs ─────────────────────────── */

type LevelFilter = 'all' | 'problems' | 'errors'
const LOG_WINDOW = 2_000

function LogsTab({ run, pods, primary, primaryStream, sel, onSel, search, onSearch, level, onLevel }: {
  run: TestRun
  pods: PodDetail[]
  primary?: string
  primaryStream: ReturnType<typeof useLogStream>
  sel: string
  onSel(s: string): void
  search: string
  onSearch(s: string): void
  level: LevelFilter
  onLevel(l: LevelFilter): void
}) {
  // The selected pod; falls back to the primary when it disappears (cleanup,
  // a retried Job) instead of streaming a pod that is gone.
  const runners = pods.filter((p) => p.role === 'runner')
  const chosen = sel === 'primary' || sel === primary ? undefined : sel === 'all-runners' ? 'all-runners' : pods.find((p) => p.name === sel)?.name
  const sources = chosen === 'all-runners'
    ? runners.filter((p) => p.state !== 'pending' && p.state !== 'waiting').map((p) => ({ pod: p.name, label: `runner ${p.index ?? ''}`.trim() }))
    : chosen
    ? [{ pod: chosen, label: chosen }]
    : []
  const other = useLogStream({ namespace: run.metadata.namespace, sources, follow: true, tailLines: 10_000, maxLines: 20_000, enabled: sources.length > 0 })
  const stream = chosen ? other : primaryStream
  const [windowSize, setWindowSize] = useState(LOG_WINDOW)
  useEffect(() => setWindowSize(LOG_WINDOW), [sel, level])

  const filtered = useMemo<LogLine[]>(() => {
    if (level === 'all') return stream.lines
    return stream.lines.filter((l) => {
      const lv = k6LogLevel(l.text)
      if (level === 'errors') return lv === 'error' || l.severity === 'error'
      return lv === 'error' || lv === 'warning' || l.severity === 'error' || l.severity === 'warn'
    })
  }, [stream.lines, level])
  // Render a window of the newest lines: a 20 000-row table freezes the tab.
  const shown = filtered.length > windowSize ? filtered.slice(filtered.length - windowSize) : filtered
  const hidden = filtered.length - shown.length

  if (!pods.length) {
    return (
      <EmptyState
        title="No pods to read"
        description={isRunning(run) ? 'The operator has not created pods for this run yet.' : 'The operator already removed this run’s pods, and their logs with them.'}
      />
    )
  }

  const options: Array<{ value: string; label: string }> = [
    ...(primary ? [{ value: 'primary', label: `runner ${pods.find((p) => p.name === primary)?.index ?? 1}` }] : []),
    ...(runners.length > 1 ? [{ value: 'all-runners', label: 'all runners' }] : []),
    ...pods.filter((p) => p.name !== primary).map((p) => ({ value: p.name, label: p.role === 'runner' ? `runner ${p.index ?? ''}${p.state === 'failed' && p.exitCode !== 99 ? ' (failed)' : ''}` : p.role })),
  ]
  const active = chosen ?? 'primary'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Pod" className="flex flex-wrap gap-1">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active === o.value}
              onClick={() => onSel(o.value)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                active === o.value ? 'border-brand-500 bg-brand-500/10 text-content' : 'border-edge-default text-content-muted hover:text-content',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label="Level" className="ml-auto flex overflow-hidden rounded-md border border-edge-default text-[11px]">
          {([['all', 'All'], ['problems', 'Warnings+'], ['errors', 'Errors']] as const).map(([v, l]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={level === v}
              onClick={() => onLevel(v)}
              className={cn('px-2 py-0.5', level === v ? 'bg-surface-sunken font-medium text-content' : 'text-content-muted hover:text-content')}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      {hidden > 0
        ? (
          <div className="flex items-center justify-between rounded-md bg-surface-sunken px-3 py-1.5 text-[11px] text-content-muted">
            <span>Showing the newest {shown.length.toLocaleString()} of {filtered.length.toLocaleString()} lines.</span>
            <Button size="xs" variant="ghost" onClick={() => setWindowSize((n) => n + LOG_WINDOW * 2)}>Load {Math.min(hidden, LOG_WINDOW * 2).toLocaleString()} earlier</Button>
          </div>
        )
        : null}
      <LogConsole
        lines={shown}
        status={stream.status}
        error={stream.error}
        reconnect={stream.reconnect}
        live={isRunning(run) && stream.status === 'streaming'}
        label={options.find((o) => o.value === active)?.label}
        filename={`${run.metadata.name}-${active === 'primary' ? 'runner' : active}`}
        search={search}
        onSearchChange={onSearch}
        emptyMessage={level !== 'all' ? 'No warnings or errors in this output.' : run.spec?.quiet === 'true' ? 'k6 runs with --quiet here, so a healthy run prints nothing until its summary.' : undefined}
      />
    </div>
  )
}

/* ─────────────────────────── report ─────────────────────────── */

function ReportTab({ run, lc, summary, window }: { run: TestRun; lc: Lifecycle; summary?: K6Summary; window: { startMs: number; endMs: number } | null }) {
  const testName = run.metadata.labels?.[LABEL_TEST]
  const suite = usePerfSuite()
  const test = usePerfTest(suite.data, testName ?? null)
  // The report charts the run's own window, frozen once it ends (liveWindow
  // quantises a live one so the panels do not refetch on every poll).
  const reportWindow = window ?? (lc.createdMs ? { startMs: lc.createdMs, endMs: lc.createdMs + 60_000 } : null)
  return (
    <PerfReport
      testName={testName ?? run.metadata.name}
      config={test.data?.config ?? DEFAULT_CONFIG}
      summary={summary ?? null}
      window={reportWindow}
      // Runner pods only (`<run>-<n>-<hash>`): `<run>.*` also matched the
      // initializer, the starter and any `<run>-r2` rerun.
      runnerSelector={`${run.metadata.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9]+-.*`}
      runnerNamespace={run.metadata.namespace ?? 'default'}
      commit={run.metadata.labels?.[LABEL_COMMIT]}
    />
  )
}

/* ─────────────────────────── spec ─────────────────────────── */

function SpecTab({ run, script, scriptLoading, plan }: { run: TestRun; script?: string; scriptLoading: boolean; plan?: LoadPlan }) {
  const env = ((run.spec?.runner as { env?: Array<{ name: string; value?: string; valueFrom?: unknown }> } | undefined)?.env ?? [])
  const image = (run.spec?.runner as { image?: string } | undefined)?.image
  const cm = run.spec?.script?.configMap
  const rows: Array<[string, ReactNode]> = [
    ['Namespace', run.metadata.namespace ?? '—'],
    ['Parallelism', String(run.spec?.parallelism ?? 1)],
    ['Script', cm ? `${cm.name}${cm.file ? ` / ${cm.file}` : ''}` : run.spec?.script?.localFile ?? '—'],
    ['Arguments', run.spec?.arguments || '—'],
    ['Runner image', image ?? 'operator default'],
    ['Paused at start', isPaused(run) ? 'yes' : 'no'],
    ['Quiet output', run.spec?.quiet === 'true' ? 'yes (no progress lines)' : 'no'],
    ['Cleanup', run.spec?.cleanup || 'none (pods are kept)'],
    ['Separate nodes', run.spec?.separate ? 'yes' : 'no'],
    ['Plan', plan ? planText(plan) : scriptLoading ? 'reading the script…' : '—'],
    ['Created', run.metadata.creationTimestamp ? formatAbsolute(run.metadata.creationTimestamp) : '—'],
  ]
  const labels = Object.entries(run.metadata.labels ?? {})
  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5 text-[12px] sm:flex-row sm:gap-3">
              <span className="w-36 shrink-0 text-content-subtle">{k}</span>
              <span className="min-w-0 flex-1 break-words font-mono text-content">{v}</span>
            </div>
          ))}
        </CardBody>
      </Card>
      {env.length
        ? (
          <Card>
            <CardHeader><div className="text-[12px] font-semibold text-content">Runner environment</div></CardHeader>
            <CardBody className="space-y-1 font-mono text-[11px]">
              {env.map((e) => (
                <div key={e.name} className="flex min-w-0 gap-2">
                  <span className="shrink-0 text-content-muted">{e.name}</span>
                  <span className="min-w-0 truncate text-content" title={e.value}>{e.valueFrom ? '(from a reference)' : e.value ?? ''}</span>
                </div>
              ))}
            </CardBody>
          </Card>
        )
        : null}
      {labels.length
        ? (
          <div className="flex flex-wrap gap-1">
            {labels.map(([k, v]) => <span key={k} className="rounded-md bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-content-muted">{k}={v}</span>)}
          </div>
        )
        : null}
      <Card>
        <CardHeader><div className="text-[12px] font-semibold text-content">Script</div></CardHeader>
        <CardBody>
          {scriptLoading
            ? <Skeleton className="block h-40 w-full" />
            : script
            ? <pre className="max-h-[28rem] overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-[11px] leading-relaxed text-code-fg">{script}</pre>
            : <p className="text-[12px] text-content-muted">The script ConfigMap could not be read — it was deleted, or your access does not include it.</p>}
        </CardBody>
      </Card>
    </div>
  )
}

function planText(plan: LoadPlan): string {
  if (plan.source === 'none') return plan.note ?? 'unknown'
  const parts = [
    plan.totalSecs !== undefined ? `${plan.totalIsUpperBound ? 'up to ' : ''}${fmtSecs(plan.totalSecs)}` : undefined,
    plan.maxVus !== undefined ? `peak ${plan.maxVus} VUs` : undefined,
    plan.scenarios.length > 1 ? `${plan.scenarios.length} scenarios` : plan.scenarios[0]?.executor,
    plan.source === 'arguments' ? 'from the arguments' : plan.source === 'default' ? 'k6 defaults' : 'from the script',
  ]
  return parts.filter(Boolean).join(' · ')
}
