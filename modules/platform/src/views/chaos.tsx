import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Badge,
  Button,
  canResource,
  DataTable,
  EmptyState,
  LitmusIcon,
  StatusBadge,
  Tabs,
  useCan,
  useToast,
  type Column,
  type StatusKind,
} from '@adhar/shell-ui'
import { formatAbsolute, formatRelative } from '@adhar/utils'
import {
  CHAOS_NAMESPACE,
  durationOf,
  ENGINES_GVR,
  errorReason,
  FAMILY_LABEL,
  faultById,
  faultOf,
  isLive,
  isOver,
  measuredProbe,
  phaseOf,
  resultNameFor,
  targetSummary,
  type ChaosEngine,
  type ChaosPhase,
  type ChaosResult,
} from '../data/chaos-kinds.ts'
import { ChaosGameDays, GameDayBuilder, GameDayDrawer } from './chaos-gameday.tsx'
import { ApplicationSuites, RunLog } from './chaos-suites.tsx'
import { ChaosDrawer } from './chaos-run-canvas.tsx'
import { ChaosReports, CompareDrawer, ReportDrawer } from './chaos-reports.tsx'
import { ChaosHome } from './chaos-home.tsx'
import { ChaosLibrary } from './chaos-library.tsx'
import { LaunchWizard } from './chaos-launch.tsx'
import { ExperimentRunDrawer, SuiteRunDrawer } from './chaos-run-canvas.tsx'
import type { ChaosTab } from './chaos-actions.ts'
import { readChaosParams, useChaosReports, writeChaosParams, type ChaosParams } from '../data/chaos-report-hooks.ts'
import { useApplicationSuites, useResilienceRuns } from '../data/chaos-suite-hooks.ts'
import { useScorerResilience } from '../data/chaos-live-hooks.ts'
import { rerunManifest, rerunName } from '../data/chaos-live.ts'
import {
  applyChaosEngine,
  deleteChaosEngine,
  stopChaosEngine,
  useChaosCluster,
  useChaosEngines,
  useChaosResults,
  useChaosWorkflows,
  useInstalledFaults,
  WORKFLOWS_GVR,
} from '../data/chaos.ts'

/**
 * Chaos Engineering — LitmusChaos, with the blast radius always on screen.
 *
 * A chaos console has one job that no other list view has: it must never let
 * someone be wrong about whether a fault is currently applied to a running
 * system. Three decisions follow from that and are worth stating, because they
 * each cost something:
 *
 *   • "Live" is computed from what the RUNNER reports, not from what was
 *     asked for. A run that has been told to stop but whose runner still says
 *     the fault is applied reads as `recovering`, not `stopped`.
 *   • Stopping is `engineState: stop` (or Argo's graceful `shutdown: Stop` for
 *     a game day), never a delete. Litmus unwinds the fault on the way out;
 *     deleting a live engine can strand it.
 *   • Launching states the blast radius in words — "all pods in payments" —
 *     platform namespaces cannot be targeted, durations are capped, and
 *     high-blast faults require typing the name to confirm. Slower on purpose.
 *
 * Every run opens a live canvas (lifecycle, steps, target pods, probe,
 * metrics) and every suite run is recorded as a report with its metrics.
 * Deep links: `?tab=` · `?run=<engine>` · `?gameday=<workflow>` ·
 * `?job=<suite run>` · `?report=<id>` · `?compare=<id>~<id>` ·
 * `?commit=&app=` (reports filter).
 */
const CHAOS_TABS: ChaosTab[] = ['overview', 'experiments', 'suites', 'gamedays', 'reports', 'library']

export function ChaosView({ namespace }: { namespace?: string }) {
  const [params, setParams] = useState<ChaosParams>(() => readChaosParams())
  const patch = (p: ChaosParams) => {
    setParams((prev) => {
      const next = { ...prev, ...p }
      for (const k of Object.keys(next) as Array<keyof ChaosParams>) if (!next[k]) delete next[k]
      return next
    })
    writeChaosParams(p)
  }
  const tab: ChaosTab = params.tab && CHAOS_TABS.includes(params.tab as ChaosTab) ? params.tab as ChaosTab : 'overview'
  const setTab = (t: ChaosTab) => patch({ tab: t === 'overview' ? undefined : t, ...(t === 'reports' ? {} : { commit: undefined, app: undefined }) })

  const { cluster: activeCluster } = useChaosCluster()
  const { engines, all: allEngines, installed, isLoading, error } = useChaosEngines(namespace)
  const live = engines.filter(isLive)
  const faults = useInstalledFaults()
  const results = useChaosResults(engines.some((e) => isLive(e) || phaseOf(e) === 'injecting'))
  const workflows = useChaosWorkflows(namespace)
  const runs = useResilienceRuns()
  const reports = useChaosReports()
  const suites = useApplicationSuites(namespace)
  const scorer = useScorerResilience()
  const canLaunch = useCan(canResource(ENGINES_GVR, 'create', { namespace: CHAOS_NAMESPACE }))
  const canGameDay = useCan(canResource(WORKFLOWS_GVR, 'create', { namespace: CHAOS_NAMESPACE }))

  const [launching, setLaunching] = useState<{ fault?: string } | null>(null)
  const [building, setBuilding] = useState<{ scenarios?: string[] } | null>(null)
  const [logJob, setLogJob] = useState<string | null>(null)

  const reportItems = useMemo(() => (reports.data?.items ?? []).filter((r) => !namespace || r.namespace === namespace), [reports.data, namespace])
  const suiteRun = params.job ? runs.data?.runs.find((r) => r.job === params.job) : undefined
  const suiteFaults = useMemo(() => {
    if (!suiteRun) return []
    const row = suites.apps.find((a) => a.app === suiteRun.app)?.environments.find((e) => e.namespace === suiteRun.namespace)
    return (row?.faults ?? []).filter((f) => f.inSuite).map((f) => ({ name: f.name, ...(f.hypothesis ? { hypothesis: f.hypothesis } : {}) }))
  }, [suiteRun, suites.apps])
  const [cmpA, cmpB] = (params.compare ?? '').split('~')

  const openReport = (id: string) => patch({ report: id, compare: undefined })
  const openCompare = (a: string, b: string) => patch({ compare: `${a}~${b}`, report: undefined })

  // No page-wide "New experiment": experiments start where the context is —
  // the overview's quick actions, a fault's Run in the library, or the empty
  // Experiments tab. Game days are created from their own tab.
  const actions = tab === 'gamedays' && canGameDay && !workflows.notInstalled
    ? <Button size="sm" variant="primary" onClick={() => setBuilding({})}>New game day</Button>
    : null

  const remote = activeCluster !== undefined
  const tabs = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'experiments' as const, label: 'Experiments', badge: live.length ? { kind: 'failed' as StatusKind, value: live.length } : undefined },
    { id: 'suites' as const, label: 'Application suites' },
    { id: 'gamedays' as const, label: 'Game days' },
    { id: 'reports' as const, label: 'Run reports' },
    { id: 'library' as const, label: 'Library' },
  ]

  return (
    <div className="space-y-4">
      {/* Actions sit right of the tabs on a wide screen and above them on a
          phone, where the tab strip needs the whole row to scroll. */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1"><Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Chaos Engineering" /></div>
        {actions ? <div className="flex justify-end">{actions}</div> : null}
      </div>

      {/* The overview's "Running now" already leads with them. */}
      {live.length > 0 && tab !== 'overview' ? <LiveBanner engines={live} onOpen={(n) => patch({ run: n })} /> : null}

      {!isLoading && !installed && (tab === 'overview' || tab === 'experiments' || tab === 'library') ? (
        <EmptyState
          title="LitmusChaos is not installed"
          description={
            <>
              The Litmus CRDs are not registered on this cluster, so there are no experiments to run or show. LitmusChaos ships with the Adhar platform as the chaos engine (the <code>litmus</code> package) — enable it in the stack and this page populates on its own. Application suites and run reports still work: the runner reports each fault as unavailable.{' '}
              <a className="text-brand-700 underline dark:text-brand-300" href="https://docs.litmuschaos.io/docs/getting-started/installation" target="_blank" rel="noreferrer">Litmus docs ↗</a>
            </>
          }
          action={<Button variant="primary" onClick={() => setTab('suites')}>Go to application suites</Button>}
        />
      ) : null}

      {remote && (tab === 'suites' || tab === 'reports' || tab === 'overview') ? (
        <div className="rounded-lg border border-edge-default bg-surface-sunken px-3 py-2 text-[12px] text-content-muted">
          Application suites, suite runs and run reports come from the platform&apos;s control-plane cluster (the resilience runner lives there); experiments and game days below are the selected cluster&apos;s.
        </div>
      ) : null}

      {error ? (
        <EmptyState compact title="Chaos runs could not be read" description={(error as Error).message} />
      ) : null}

      {tab === 'overview' ? (
        <ChaosHome
          engines={installed ? engines : []}
          results={results}
          namespace={namespace}
          enginesLoading={isLoading}
          workflows={workflows.data ?? []}
          runs={runs.data?.runs.filter((r) => !namespace || r.namespace === namespace) ?? []}
          reports={reportItems}
          reportsLoading={reports.isLoading}
          reportsConfigured={reports.data?.configured !== false}
          scorer={scorer.data}
          canLaunch={canLaunch && installed}
          canGameDay={canGameDay}
          onNewExperiment={() => setLaunching({})}
          onNewGameDay={() => setBuilding({})}
          onTab={setTab}
          onOpenRun={(n) => patch({ run: n })}
          onOpenGameDay={(n) => patch({ gameday: n })}
          onOpenSuiteRun={(j) => patch({ job: j })}
          onOpenReport={openReport}
          onCompare={openCompare}
        />
      ) : tab === 'experiments' && installed ? (
        <ExperimentsTab engines={engines} results={results} loading={isLoading} canLaunch={canLaunch} faultCount={faults.installed.length} definitions={faults.definitions} onOpen={(n) => patch({ run: n })} onNew={() => setLaunching({})} allNames={allEngines.map((e) => e.metadata.name)} />
      ) : tab === 'suites' ? (
        <ApplicationSuites namespace={namespace} onWatch={(j) => patch({ job: j })} />
      ) : tab === 'gamedays' ? (
        <ChaosGameDays namespace={namespace} onNew={() => setBuilding({})} onOpen={(o) => patch({ gameday: o.name })} />
      ) : tab === 'reports' ? (
        <ChaosReports namespace={namespace} commit={params.commit ?? ''} app={params.app ?? ''} onFilter={(f) => patch(f)} onRunSuites={() => setTab('suites')} onOpen={openReport} onCompare={openCompare} />
      ) : tab === 'library' && installed ? (
        <ChaosLibrary installed={faults.installed} canLaunch={canLaunch} canGameDay={canGameDay && !workflows.notInstalled} gameDaysMissing={workflows.notInstalled} onRunFault={(id) => setLaunching({ fault: id })} onGameDay={(s) => setBuilding({ scenarios: s })} />
      ) : null}

      {launching && canLaunch ? (
        <LaunchWizard
          installed={faults.installed}
          initialFault={launching.fault}
          taken={allEngines.map((e) => e.metadata.name)}
          onClose={() => setLaunching(null)}
          onLaunched={(n) => {
            setLaunching(null)
            patch({ run: n })
          }}
        />
      ) : null}
      {building && canGameDay ? (
        <GameDayBuilder initialScenarios={building.scenarios} taken={(workflows.data ?? []).map((w) => w.metadata.name)} onClose={() => setBuilding(null)} onCreated={(o) => patch({ gameday: o.name, tab: tab === 'overview' ? undefined : 'gamedays' })} />
      ) : null}

      {/* Keyed by the run: a re-run opens in place, and what the canvas
          observed of the previous run (its recovery, its probe strip) must
          not carry over to the new one. */}
      {params.run ? <ExperimentRunDrawer key={params.run} name={params.run} onClose={() => patch({ run: undefined })} onOpenRun={(n) => patch({ run: n })} /> : null}
      {params.gameday ? (
        <GameDayDrawer key={params.gameday} namespace={CHAOS_NAMESPACE} name={params.gameday} notInstalled={workflows.notInstalled} taken={(workflows.data ?? []).map((w) => w.metadata.name)} onClose={() => patch({ gameday: undefined })} onOpen={(o) => patch({ gameday: o.name })} />
      ) : null}
      {params.job && suiteRun ? (
        <SuiteRunDrawer key={suiteRun.job} run={suiteRun} faults={suiteFaults} onClose={() => patch({ job: undefined })} onViewLog={() => setLogJob(suiteRun.job)} />
      ) : params.job ? (
        // A run just started may not be listed yet (the watch brings it in a
        // moment later); a link to a run whose Job was cleaned up must still
        // say so rather than open nothing.
        <ChaosDrawer widthKey="platform.chaos-suite-run" eyebrow="Resilience suite" title={params.job} onClose={() => patch({ job: undefined })}>
          <div className="p-5">
            {runs.isLoading || runs.isFetching ? (
              <EmptyState compact title="Reading the suite run…" description="Waiting for the runner's Job to be listed." />
            ) : (
              <EmptyState
                title="This suite run is not on the cluster any more"
                description={runs.error ? (runs.error as Error).message : 'Its Job was cleaned up (the runner keeps only recent ones). Its result lives on in Run reports.'}
                action={<Button variant="primary" onClick={() => patch({ job: undefined, tab: 'reports' })}>Go to run reports</Button>}
              />
            )}
          </div>
        </ChaosDrawer>
      ) : null}
      {params.report ? <ReportDrawer key={params.report} id={params.report} onClose={() => patch({ report: undefined })} onCompare={openCompare} /> : null}
      {cmpA && cmpB ? <CompareDrawer a={cmpA} b={cmpB} onClose={() => patch({ compare: undefined })} onPick={openCompare} /> : null}
      {logJob ? <RunLog job={logJob} live={!!suiteRun && !suiteRun.completionTime} onClose={() => setLogJob(null)} /> : null}
    </div>
  )
}

/* ─────────────────────────── live banner ─────────────────────────── */

/**
 * The one thing that must be impossible to miss.
 *
 * Someone arriving at this page mid-incident needs to know in the first
 * second whether the thing they are debugging is a fault somebody injected.
 */
function LiveBanner({ engines, onOpen }: { engines: ChaosEngine[]; onOpen(name: string): void }) {
  return (
    <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 dark:border-rose-500/40 dark:bg-rose-500/10">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500" />
        </span>
        <span className="text-sm font-semibold text-rose-800 dark:text-rose-200">
          {engines.length} chaos experiment{engines.length === 1 ? '' : 's'} currently injecting faults
        </span>
      </div>
      <div className="mt-1.5 space-y-0.5">
        {engines.map((e) => (
          <button key={`${e.metadata.namespace}/${e.metadata.name}`} type="button" onClick={() => onOpen(e.metadata.name)} className="block text-left text-[12px] text-rose-700 hover:underline dark:text-rose-300">
            <span className="font-medium">{e.metadata.name}</span> — {faultOf(e)} on {targetSummary(e)}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────── experiments ─────────────────────────── */

const PHASE_KIND: Record<ChaosPhase, StatusKind> = {
  injected: 'failed',
  injecting: 'progressing',
  recovering: 'degraded',
  stopped: 'paused',
  passed: 'healthy',
  failed: 'failed',
  error: 'degraded',
  unknown: 'unknown',
}

const PHASE_LABEL: Record<ChaosPhase, string> = {
  injected: 'injecting',
  injecting: 'starting',
  recovering: 'recovering',
  stopped: 'stopped',
  passed: 'passed',
  failed: 'failed',
  error: 'no verdict',
  unknown: 'unknown',
}

function ExperimentsTab({ engines, results, loading, canLaunch, faultCount, definitions, onOpen, onNew, allNames }: {
  engines: ChaosEngine[]
  results: Map<string, ChaosResult>
  loading: boolean
  canLaunch: boolean
  faultCount: number
  definitions: number
  onOpen(name: string): void
  onNew(): void
  allNames: string[]
}) {
  const resultOf = (e: ChaosEngine) => {
    const n = resultNameFor(e)
    return n ? results.get(n) : undefined
  }

  const columns: Column<ChaosEngine>[] = [
    {
      key: 'name',
      header: 'Run',
      pinned: true,
      width: 220,
      cell: (e) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-content">{e.metadata.name}</div>
          <div className="truncate text-[11px] text-content-subtle">
            {e.metadata.labels?.['adhar.io/chaos-gameday'] ? `game day ${e.metadata.labels['adhar.io/chaos-gameday']}` : e.metadata.labels?.['adhar.io/resilience-test'] ? 'resilience suite' : e.metadata.namespace}
          </div>
        </div>
      ),
    },
    {
      key: 'fault',
      header: 'Fault',
      value: (e) => faultOf(e),
      cell: (e) => {
        const fault = faultById(faultOf(e))
        return (
          <div className="flex flex-col items-start gap-0.5 whitespace-nowrap">
            <Badge>{fault ? FAMILY_LABEL[fault.family] : 'fault'}</Badge>
            <span className="font-mono text-[11px] text-content-muted">{faultOf(e)}</span>
          </div>
        )
      },
    },
    {
      key: 'phase',
      header: 'State',
      value: (e) => PHASE_LABEL[phaseOf(e)],
      cell: (e) => {
        const phase = phaseOf(e)
        const r = resultOf(e)
        // Only a Pass or Fail carries a probe measurement: Litmus writes
        // "Awaited" until the end, and 0 on a run that errored before probing.
        const probe = measuredProbe(r)
        const why = phase === 'error' ? errorReason(r) : undefined
        return (
          // The reason sits under the badge, capped: a long Litmus message
          // must not widen the column until the row actions scroll away.
          <div className="flex min-w-0 max-w-[13rem] flex-col items-start gap-0.5">
            <span className="flex items-center gap-1.5">
              <StatusBadge kind={PHASE_KIND[phase]} pulse={isLive(e)}>{PHASE_LABEL[phase]}</StatusBadge>
              {probe !== undefined && phase !== 'failed' ? <span className="text-[11px] tabular-nums text-content-subtle">probes {Number(probe.toFixed(1))}%</span> : null}
            </span>
            {phase === 'failed' && r?.status?.experimentStatus?.failStep ? (
              <span className="block w-full truncate text-[11px] text-rose-700 dark:text-rose-400" title={r.status.experimentStatus.failStep}>{r.status.experimentStatus.failStep}</span>
            ) : why ? (
              <span className="block w-full truncate text-[11px] text-amber-700 dark:text-amber-400" title={why}>{why}</span>
            ) : null}
          </div>
        )
      },
    },
    {
      key: 'target',
      header: 'Blast radius',
      // The whole point of the page — never truncated away behind a tooltip.
      // The fault's length rides along: a separate column pushed the row's
      // Stop / Re-run / Delete off the side of a laptop screen.
      value: (e) => targetSummary(e),
      cell: (e) => {
        const d = durationOf(e)
        return (
          <div className="text-[12px] text-content-muted">
            <div>{targetSummary(e)}</div>
            {d !== undefined ? <div className="text-[11px] text-content-subtle">for {d}s</div> : null}
          </div>
        )
      },
    },
    {
      key: 'created',
      header: 'Started',
      value: (e) => e.metadata.creationTimestamp ?? '',
      cell: (e) => e.metadata.creationTimestamp
        ? <span title={formatAbsolute(e.metadata.creationTimestamp)} className="text-[12px] text-content-muted">{formatRelative(e.metadata.creationTimestamp)}</span>
        : <span className="text-content-subtle">—</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      sortable: false,
      // Stop / Re-run / Delete are asked per run (RowActions renders nothing it may not do).
      cell: (e) => <RowActions engine={e} allNames={allNames} onOpen={onOpen} />,
    },
  ]

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-content"><LitmusIcon size={16} /> Experiments</h2>
          <p className="text-[12px] text-content-muted">
            Every ChaosEngine on this cluster — click one to watch it live. {faultCount} of {definitions || faultCount} installed fault definitions are catalogued here.
          </p>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
        <DataTable
          columns={columns}
          rows={engines}
          rowKey={(e) => `${e.metadata.namespace}/${e.metadata.name}`}
          onRowClick={(e) => onOpen(e.metadata.name)}
          loading={loading}
          tableId="chaos-experiments"
          features={{ search: true, filters: true, columns: true, density: true, export: true }}
          defaultSort={{ key: 'created', dir: 'desc' }}
          searchPlaceholder="Search runs…"
          empty={
            <EmptyState
              title="No chaos experiments"
              description={canLaunch
                ? 'Nothing is being broken on purpose right now. Start with pod-delete on a non-critical workload — it is the experiment real clusters survive.'
                : 'Nothing is being broken on purpose right now. Ask a platform admin to run an experiment, or for permission to create ChaosEngines.'}
              action={canLaunch ? <Button variant="primary" onClick={onNew}>New experiment</Button> : undefined}
            />
          }
        />
      </div>
    </section>
  )
}

function RowActions({ engine, allNames, onOpen }: { engine: ChaosEngine; allNames: string[]; onOpen(name: string): void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const { cluster } = useChaosCluster()
  const live = isLive(engine)
  const phase = phaseOf(engine)
  const ns = engine.metadata.namespace ?? CHAOS_NAMESPACE
  const canStop = useCan(canResource(ENGINES_GVR, 'patch', { namespace: ns, name: engine.metadata.name }))
  const canDelete = useCan(canResource(ENGINES_GVR, 'delete', { namespace: ns, name: engine.metadata.name }))
  const canCreate = useCan(canResource(ENGINES_GVR, 'create', { namespace: ns }))
  const [busy, setBusy] = useState(false)
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await f()
      toast.success(ok)
      void qc.invalidateQueries({ queryKey: ['chaos'] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const over = isOver(engine)
  return (
    <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      {/* A finished run has already recovered; there is nothing to stop. */}
      {!over && canStop ? (
        <Button variant="ghost" size="xs" disabled={busy || phase === 'recovering'} onClick={() => void run(() => stopChaosEngine(ns, engine.metadata.name, cluster), 'Stopping — Litmus is recovering the fault')}>Stop</Button>
      ) : null}
      {over && canCreate ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          title="Run the same fault against the same target again"
          onClick={() => {
            const next = rerunName(engine.metadata.name, allNames)
            void run(async () => {
              await applyChaosEngine(rerunManifest(engine, next), cluster)
              onOpen(next)
            }, `${next} launched`)
          }}
        >
          Re-run
        </Button>
      ) : null}
      {/* Deleting a live run can strand the injected fault with nothing left
          to recover it, so the only route to delete is: stop, then go. */}
      {canDelete ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={live || busy}
          title={live ? 'Stop the run first — deleting it now could leave the fault applied' : undefined}
          onClick={() => void run(() => deleteChaosEngine(engine, cluster), 'Run deleted')}
        >
          Delete
        </Button>
      ) : null}
    </div>
  )
}
