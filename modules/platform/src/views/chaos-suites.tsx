import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  consoleCheck,
  CONSOLE_PERMISSIONS,
  EmptyState,
  Modal,
  Spinner,
  StatusBadge,
  useCan,
  useToast,
  type StatusKind,
} from '@adhar/shell-ui'
import { cn, formatAbsolute, formatRelative } from '@adhar/utils'
import { FAMILY_LABEL, faultById } from '../data/chaos-kinds.ts'
import {
  formatMs,
  formatRate,
  RUNNER_CRONJOB,
  runOutcome,
  runOutcomeMessage,
  runPhase,
  type ApplicationSuites as AppSuites,
  type AppResult,
  type FaultStatus,
  type GateVerdict,
  type GateVerdictKind,
  type PerfResult,
  type RunOutcome,
  type SuiteEnvironmentRow,
} from '../data/chaos-suites.ts'
import {
  startResilienceRun,
  useApplicationSuites,
  useResilienceRunLog,
  useResilienceRuns,
  type ResilienceRun,
  type ResilienceRunsState,
} from '../data/chaos-suite-hooks.ts'

/**
 * Application suites — the resilience each application says it has, and what
 * the platform last proved about it.
 *
 * The experiments tab is runs people start by hand. This is the other half:
 * every application ships its own suite (`deploy/base/resilience.yaml` in a
 * templated service), the platform's runner executes it every hour and as the
 * promotion gate, and the verdict decides whether a build reaches prod. So the
 * page leads with the gate verdict per environment, then the faults in the
 * order they run, each with the hypothesis it tests and how the last run went.
 *
 * "Run suite" starts the runner's own gate mode for one app+environment, so a
 * click tests exactly what a promotion would — including NOT retesting an image
 * that already passed there, which the page says rather than implying a fresh
 * result.
 */
export function ApplicationSuites({ namespace, onWatch }: { namespace?: string; onWatch(job: string): void }) {
  const { apps, results, isLoading, suitesError, resultsError } = useApplicationSuites(namespace)
  const runs = useResilienceRuns()

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-content">Application suites</h2>
        <p className="text-[12px] text-content-muted">
          Each application&apos;s own resilience suite — the faults it must survive, in order, and the load it must
          carry. The platform runs them hourly and as the promotion gate before prod.
        </p>
        <RunnerNotice state={runs.data} error={runs.error as Error | null} />
      </div>
        {suitesError ? (
          <div className="text-[12px] text-rose-600 dark:text-rose-400">
            Suites could not be read: {suitesError.message}.
          </div>
        ) : null}
        {resultsError ? (
          <div className="text-[12px] text-amber-700 dark:text-amber-400">
            The runner&apos;s results could not be read ({resultsError}) — suites are shown without their last results.
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-content-muted">
            <Spinner /> Reading suites…
          </div>
        ) : apps.length === 0 && !suitesError ? (
          <EmptyState
            title={namespace ? `No application suites in ${namespace}` : 'No application suites yet'}
            description={
              <>
                Services created from a template ship their suite in <code>deploy/base/resilience.yaml</code> — a
                ConfigMap <code>&lt;app&gt;-resilience</code> labelled <code>adhar.io/resilience-suite: &quot;true&quot;</code>{' '}
                that names the faults to run, their hypotheses and the load-test thresholds. Add one to any other
                service and it appears here once deployed.
                {results.size > 0
                  ? ` The runner has results for ${results.size} application${results.size === 1 ? '' : 's'} tested with the platform default suite.`
                  : ''}
              </>
            }
          />
        ) : (
          apps.map((a) => <ApplicationCard key={a.app} entry={a} runs={runs.data} onWatch={onWatch} />)
        )}
    </section>
  )
}

/* ─────────────────────────── runner state ─────────────────────────── */

function RunnerNotice({ state, error }: { state?: ResilienceRunsState; error: Error | null }) {
  if (error) {
    return <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">Run status unavailable: {error.message}</div>
  }
  if (!state || state.installed) return null
  return (
    <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
      {state.detail
        ? `The resilience runner could not be read: ${state.detail}. Runs cannot be started from here.`
        : `The resilience runner (CronJob ${RUNNER_CRONJOB}) is not installed — enable the adhar-scorecards package to run suites. The definitions below are still what each application declares.`}
    </div>
  )
}

/* ─────────────────────────── one application ─────────────────────────── */

const GATE_KIND: Record<GateVerdictKind, StatusKind> = {
  pass: 'healthy',
  fail: 'failed',
  skipped: 'paused',
  unknown: 'unknown',
}

const GATE_LABEL: Record<GateVerdictKind, string> = {
  pass: 'gate passed',
  fail: 'gate failed',
  skipped: 'gate skipped',
  unknown: 'gate unknown',
}

function ApplicationCard({ entry, runs, onWatch }: { entry: AppSuites; runs?: ResilienceRunsState; onWatch(job: string): void }) {
  // Open on the environment the runner last tested, so the results are visible
  // without a click; otherwise the first. Derived on every render until the
  // person picks one: the suites often load before the runner's results, and
  // a choice frozen at first render stuck on the first environment — "No
  // results for this environment" — while the tested one sat a tab away.
  const initial = entry.environments.find((r) => r.namespace === entry.last?.namespace)?.namespace ??
    entry.environments[0]?.namespace
  const [picked, setSelected] = useState<string | undefined>(undefined)
  const selected = picked ?? initial
  const row = entry.environments.find((r) => r.namespace === selected) ?? entry.environments[0]
  const last = entry.last

  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge-default px-3 py-2">
        <span className="text-[13px] font-semibold text-content">{entry.app}</span>
        {entry.environments.map((r) => (
          <button
            key={r.namespace}
            type="button"
            onClick={() => setSelected(r.namespace)}
            title={r.namespace !== r.environment ? `namespace ${r.namespace}` : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
              r.namespace === row?.namespace
                ? 'bg-brand-600 text-white'
                : 'text-content-muted hover:bg-surface-sunken hover:text-content',
            )}
          >
            <GateDot verdict={r.gate?.verdict} />
            {r.environment}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-content-subtle">
          {last?.testedAt ? (
            <span title={formatAbsolute(last.testedAt)}>
              last tested {formatRelative(last.testedAt)} in {last.environment ?? last.namespace}
            </span>
          ) : last?.pending ? (
            `queued: ${last.pending}`
          ) : (
            'not tested yet'
          )}
        </span>
      </div>
      {row ? <EnvironmentDetail app={entry.app} row={row} last={last} runs={runs} onWatch={onWatch} /> : null}
      {entry.orphanGates.length > 0 ? (
        <div className="border-t border-edge-default px-3 py-2 text-[11px] text-content-subtle">
          Gate verdicts for namespaces without a suite here:{' '}
          {entry.orphanGates.map((g) => `${g.namespace} (${g.verdict})`).join(', ')}
        </div>
      ) : null}
    </div>
  )
}

function GateDot({ verdict }: { verdict?: GateVerdictKind }) {
  const tone = verdict === 'pass'
    ? 'bg-emerald-500'
    : verdict === 'fail'
    ? 'bg-rose-500'
    : verdict === 'skipped'
    ? 'bg-slate-400'
    : 'bg-transparent ring-1 ring-inset ring-current opacity-50'
  return <span className={cn('inline-block h-1.5 w-1.5 rounded-full', tone)} aria-hidden />
}

/* ─────────────────────────── one environment ─────────────────────────── */

function EnvironmentDetail(
  { app, row, last, runs, onWatch }: { app: string; row: SuiteEnvironmentRow; last?: AppResult; runs?: ResilienceRunsState; onWatch(job: string): void },
) {
  const { suite, result, gate } = row
  const perf = suite.perf
  return (
    <div className="space-y-3 px-3 py-3">
      {suite.error ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
          <span className="font-medium">{suite.configMap}</span> in {suite.namespace} cannot be read: {suite.error} The
          runner falls back to the service&apos;s annotations or the platform default until it is fixed.
        </div>
      ) : null}

      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <GateSummary gate={gate} enabled={suite.gateEnabled} />
        <Fact label="Steady-state probe">
          <code className="text-[11px]">{suite.probePath ?? 'readiness probe'}</code>
        </Fact>
        <Fact label="Load test">
          <span>
            <code className="text-[11px]">{perf.path || suite.probePath || 'readiness path'}</code>
            {` · p95 < ${perf.p95Ms !== undefined ? formatMs(perf.p95Ms) : 'default'}`}
            {` · errors < ${perf.errorRate !== undefined ? formatRate(perf.errorRate) : 'default'}`}
          </span>
        </Fact>
        <div className="ml-auto">
          <RunControl app={app} row={row} last={last} runs={runs} onWatch={onWatch} />
        </div>
      </div>

      {result ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px] text-content-muted">
          <PerfLine perf={result.performance} />
          {result.image ? (
            <span className="min-w-0 max-w-full truncate" title={result.image}>
              image <code className="text-[11px]">{result.image}</code>
            </span>
          ) : null}
          {result.testedAt ? (
            <span title={formatAbsolute(result.testedAt)}>tested {formatRelative(result.testedAt)}</span>
          ) : null}
        </div>
      ) : (
        <div className="text-[12px] text-content-subtle">
          {last?.namespace
            ? `No fault or load-test results for this environment — the runner keeps only an application's latest test, and that was in ${last.environment ?? last.namespace}.`
            : 'Not tested yet — the runner reaches every application within a few hourly passes, or run the suite now.'}
        </div>
      )}

      <FaultTable row={row} />
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-content-subtle">{label}</div>
      <div className="text-[12px] text-content-muted">{children}</div>
    </div>
  )
}

function GateSummary({ gate, enabled }: { gate?: GateVerdict; enabled: boolean }) {
  return (
    <div className="min-w-0 max-w-md">
      <div className="text-[10px] font-medium uppercase tracking-wide text-content-subtle">Promotion gate</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {gate ? (
          <StatusBadge kind={GATE_KIND[gate.verdict]}>{GATE_LABEL[gate.verdict]}</StatusBadge>
        ) : (
          <span className="text-[12px] text-content-subtle">no verdict yet</span>
        )}
        {!enabled ? <Badge tone="amber">disabled by the suite</Badge> : null}
        {gate?.at ? (
          <span className="text-[11px] text-content-subtle" title={formatAbsolute(gate.at)}>
            {formatRelative(gate.at)}
          </span>
        ) : null}
      </div>
      {gate && gate.verdict !== 'pass' && gate.reasons.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-rose-700 dark:text-rose-400">
          {gate.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      ) : null}
      {gate?.image ? (
        <div className="truncate text-[11px] text-content-subtle" title={gate.image}>
          for <code>{gate.image}</code>
        </div>
      ) : null}
    </div>
  )
}

const PERF_KIND: Record<PerfResult['status'], StatusKind> = {
  passed: 'healthy',
  failed: 'failed',
  error: 'degraded',
  unknown: 'unknown',
}

function PerfLine({ perf }: { perf?: PerfResult }) {
  if (!perf) return <span>no load-test result</span>
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" title={perf.detail}>
      <StatusBadge kind={PERF_KIND[perf.status]}>load {perf.status}</StatusBadge>
      <span className="tabular-nums">
        p95 {formatMs(perf.p95Ms)}
        {perf.thresholdP95Ms !== undefined ? ` / ${formatMs(perf.thresholdP95Ms)}` : ''} · errors {formatRate(perf.errorRate)}
        {perf.rps !== undefined ? ` · ${Number(perf.rps.toFixed(1))} rps` : ''}
      </span>
    </span>
  )
}

/* ─────────────────────────── faults ─────────────────────────── */

const FAULT_KIND: Record<FaultStatus, StatusKind> = {
  passed: 'healthy',
  failed: 'failed',
  error: 'degraded',
  unavailable: 'paused',
  'opted-out': 'info',
  unknown: 'unknown',
}

function FaultTable({ row }: { row: SuiteEnvironmentRow }) {
  if (row.faults.length === 0) {
    return (
      <div className="text-[12px] text-content-subtle">
        {row.suite.error ? 'No faults could be read.' : 'The suite selects no faults — only the load test runs.'}
      </div>
    )
  }
  return (
    <div className="overflow-x-auto rounded-md border border-edge-default">
      <table className="w-full text-left text-[12px]">
        <thead className="bg-surface-sunken text-[10px] uppercase tracking-wide text-content-subtle">
          <tr>
            <th className="px-2 py-1.5 font-medium">#</th>
            <th className="px-2 py-1.5 font-medium">Fault</th>
            <th className="px-2 py-1.5 font-medium">Hypothesis</th>
            <th className="px-2 py-1.5 font-medium">Last result</th>
            <th className="px-2 py-1.5 text-right font-medium">Probe success</th>
            <th className="px-2 py-1.5 text-right font-medium">Recovery</th>
          </tr>
        </thead>
        <tbody>
          {row.faults.map((f, i) => {
            const known = faultById(f.name)
            const r = f.result
            return (
              <tr key={f.name} className={cn('border-t border-edge-default align-top', !f.inSuite && 'opacity-60')}>
                <td className="px-2 py-1.5 tabular-nums text-content-subtle">{f.inSuite ? i + 1 : '—'}</td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {known ? <Badge>{FAMILY_LABEL[known.family]}</Badge> : null}
                    <code className="text-[11px] text-content">{f.name}</code>
                  </div>
                  {!f.inSuite ? (
                    <div className="text-[10px] text-content-subtle">recorded by the last run, no longer selected</div>
                  ) : !f.catalogued ? (
                    <div className="text-[10px] text-amber-700 dark:text-amber-400">selected but not in the catalogue</div>
                  ) : Object.keys(f.env).length > 0 ? (
                    <div className="text-[10px] text-content-subtle">
                      {Object.entries(f.env).map(([k, v]) => `${k}=${v}`).join(' · ')}
                    </div>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 text-content-muted">
                  {f.hypothesis ?? <span className="text-content-subtle">none stated</span>}
                </td>
                <td className="px-2 py-1.5">
                  {r ? (
                    <div className="space-y-0.5">
                      <StatusBadge kind={FAULT_KIND[r.status]}>{r.status}</StatusBadge>
                      {r.detail && r.status !== 'passed' ? (
                        <div className="max-w-xs text-[10px] text-content-subtle" title={r.detail}>
                          {r.status === 'unavailable' ? `Litmus cannot run it here: ${r.detail}` : r.detail}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-content-subtle">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-content-muted">
                  {r?.probeSuccessPercentage !== undefined ? `${r.probeSuccessPercentage}%` : '—'}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-content-muted">
                  {r?.recoverySeconds !== undefined ? `${r.recoverySeconds}s` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ─────────────────────────── run on demand ─────────────────────────── */

const OUTCOME_KIND: Record<RunOutcome, StatusKind> = {
  running: 'progressing',
  tested: 'healthy',
  'already-passed': 'healthy',
  skipped: 'paused',
  failed: 'failed',
  'no-change': 'unknown',
}

const OUTCOME_LABEL: Record<RunOutcome, string> = {
  running: 'running',
  tested: 'finished',
  'already-passed': 'already passed',
  skipped: 'gate skipped',
  failed: 'failed',
  'no-change': 'finished',
}

function RunControl(
  { app, row, last, runs, onWatch }: { app: string; row: SuiteEnvironmentRow; last?: AppResult; runs?: ResilienceRunsState; onWatch(job: string): void },
) {
  const toast = useToast()
  const qc = useQueryClient()
  const [starting, setStarting] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  // `testedAt` when THIS tab started a run, per job — what "already passed" is
  // judged against. Absent for runs started elsewhere; the Job's start time
  // stands in then.
  const before = useRef(new Map<string, string | undefined>())
  // POST /api/resilience/runs is authorized in the environment's namespace, so
  // a team that is admin of its own namespace may run suites there only.
  const canRun = useCan(consoleCheck(CONSOLE_PERMISSIONS.resilienceRun, row.namespace))

  const run: ResilienceRun | undefined = useMemo(
    () => runs?.runs.find((r) => r.app === app && r.namespace === row.namespace),
    [runs, app, row.namespace],
  )
  const phase = run ? runPhase(run.status) : undefined
  const active = phase === 'running' || phase === 'pending'

  // When a run finishes, the runner has rewritten the results ConfigMap: read
  // it now instead of at the next 30 s poll.
  const lastPhase = useRef(phase)
  useEffect(() => {
    if ((lastPhase.current === 'running' || lastPhase.current === 'pending') && (phase === 'succeeded' || phase === 'failed')) {
      void qc.invalidateQueries({ queryKey: ['chaos', 'suite-results'] })
    }
    lastPhase.current = phase
  }, [phase, qc])

  const log = useResilienceRunLog(run && !active && phase ? run.job : null, false)
  const outcome = run && phase
    ? runOutcome({
      phase,
      namespace: row.namespace,
      ...(before.current.has(run.job) ? { testedAtBefore: before.current.get(run.job) } : {}),
      ...(run.startTime ? { startedAt: run.startTime } : {}),
      after: last,
      log: log.data?.log,
    })
    : undefined

  const disabledReason = !runs
    ? 'Reading the runner…'
    : !runs.installed
    ? runs.detail
      ? `The resilience runner could not be read: ${runs.detail}`
      : `The resilience runner (${RUNNER_CRONJOB}) is not installed — enable the adhar-scorecards package.`
    : active
    ? 'A run for this environment is in progress.'
    : undefined

  const start = async () => {
    setStarting(true)
    const testedAt = last?.namespace === row.namespace ? last.testedAt : undefined
    const res = await startResilienceRun({ app, namespace: row.namespace, environment: row.environment })
    setStarting(false)
    if (res.started && res.job) {
      before.current.set(res.job, testedAt)
      toast.success(`Suite started for ${app} in ${row.environment}`)
      // Straight to the live canvas: the run is what the person wants to see.
      onWatch(res.job)
    } else if (res.error === 'already_running') {
      toast.info(`A run is already in progress for ${app} in ${row.environment}`)
    } else {
      toast.error(res.detail || res.error || 'The suite could not be started.')
    }
    void qc.invalidateQueries({ queryKey: ['chaos', 'resilience-runs'] })
  }

  return (
    <div className="flex max-w-xs flex-col items-end gap-1 text-right">
      {canRun ? (
        <Button size="sm" variant="primary" disabled={!!disabledReason || starting} title={disabledReason} onClick={() => void start()}>
          {starting ? 'Starting…' : active ? 'Running…' : 'Run suite'}
        </Button>
      ) : null}
      {run && outcome ? (
        <>
          <div className="flex items-center gap-1.5">
            <StatusBadge kind={OUTCOME_KIND[outcome]} pulse={outcome === 'running'}>{OUTCOME_LABEL[outcome]}</StatusBadge>
            {run.startTime ? (
              <span className="text-[11px] text-content-subtle" title={`${run.job} · ${formatAbsolute(run.startTime)}`}>
                {run.triggeredBy === 'console' ? 'started' : 'gate run'} {formatRelative(run.startTime)}
              </span>
            ) : null}
          </div>
          <div className="text-[11px] text-content-muted">{runOutcomeMessage(outcome)}</div>
          <div className="flex gap-2">
            <Button variant="link" size="xs" onClick={() => onWatch(run.job)}>
              {active ? 'Watch live' : 'Open run'}
            </Button>
            <Button variant="link" size="xs" onClick={() => setViewing(run.job)}>
              {active ? 'Follow log' : 'View log'}
            </Button>
          </div>
        </>
      ) : null}
      {viewing ? <RunLog job={viewing} live={active} onClose={() => setViewing(null)} /> : null}
    </div>
  )
}

export function RunLog({ job, live, onClose }: { job: string; live: boolean; onClose(): void }) {
  const log = useResilienceRunLog(job, live)
  return (
    <Modal
      open
      onClose={onClose}
      width="xl"
      title="Resilience run log"
      description={`${job}${log.data?.pod ? ` · pod ${log.data.pod}` : ''} — the last 300 lines${live ? ', followed while it runs' : ''}.`}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {log.isLoading ? (
        <div className="flex items-center gap-2 text-[12px] text-content-muted">
          <Spinner /> Reading the log…
        </div>
      ) : log.error ? (
        <div className="text-[12px] text-rose-600 dark:text-rose-400">{(log.error as Error).message}</div>
      ) : (
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-surface-sunken p-3 text-left font-mono text-[11px] text-content">
          {log.data?.log || (log.data?.pod ? (log.data.detail ?? 'No output yet.') : 'The run has no pod yet.')}
        </pre>
      )}
    </Modal>
  )
}
