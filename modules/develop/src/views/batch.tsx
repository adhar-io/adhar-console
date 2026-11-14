import { useMemo, useState } from 'react'
import {
  type Column,
  CONSOLE_PERMISSIONS,
  DataTable,
  EmptyState,
  type Facet,
  type FacetValues,
  FilterBar,
  matchesFacets,
  matchesQuery,
  optionsFromItems,
  PageHeader,
  StatusBadge,
  type TabDef,
  Tabs,
  useAccessReview,
  useActiveNamespace,
} from '@adhar/shell-ui'
import { cn } from '@adhar/utils'
import { useDevelopParams, useSetDevelopParams } from '../data/nav.ts'
import { StatTile } from '../components/list-kit.tsx'
import { useApplications, useProjects } from '../data/functions.ts'
import { PLATFORM_ENVIRONMENTS } from '../data/functions-model.ts'
import { useBatchJobList, useBatchRuns, useNamespaceWatches, useNextSchedules, useRunRows } from '../data/batch.ts'
import {
  batchRef,
  groupByApplication,
  isActivePhase,
  JOB_STATUS_BADGE,
  JOB_STATUS_LABEL,
  type JobRow,
  jobRows,
  jobSearchText,
  type JobStatus,
  pageStateOf,
  parseBatchRef,
  pendingApplications,
  PHASE_LABEL,
  runPhaseOf,
  type RunRow,
  runSearchText,
} from '../data/batch-model.ts'
import { Note } from './function-bits.tsx'
import {
  BatchEmpty,
  BatchForbidden,
  BatchLoadError,
  BatchNotInstalled,
  DurationText,
  ExitCode,
  NEW_JOB_HREF,
  RunBadge,
  SlaBadge,
  TABLE,
  TD,
  TH,
  Until,
  useNow,
  When,
} from '../components/batch/bits.tsx'
import { JobDrawer, type JobTab } from '../components/batch/job-drawer.tsx'
import { RunDrawer, type RunTab } from '../components/batch/run-drawer.tsx'
import { useVolcanoInstalled } from '../data/batch-queues.ts'
import { BatchQueues } from './batch-queues.tsx'

/**
 * Develop → Batch (design 0025 §7): every BatchJob the signed-in user can see,
 * and every run of them.
 *
 * Read as the user through the Kubernetes gateway and kept live by apiserver
 * watches. There is no BFF endpoint and no console permission: every action is a
 * Kubernetes verb on a namespaced object, gated with `useAccessReview` on the
 * request it will make, and hidden when the answer is no (§7.4).
 *
 * Four page states are told apart on purpose (`pageStateOf`): the API not
 * installed, the caller not allowed, nothing there yet, and the request failing.
 * Each has its own words, and none of them is an empty table.
 */

type View = 'jobs' | 'runs' | 'queues'

const VIEWS: TabDef<View>[] = [{ id: 'jobs', label: 'Jobs' }, { id: 'runs', label: 'Runs' }]
/** Volcano's queues (Phase 2): a tab only where discovery says Volcano is installed. */
const VIEWS_WITH_QUEUES: TabDef<View>[] = [...VIEWS, { id: 'queues', label: 'Queues' }]

const BUTTON_PRIMARY =
  'inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 hover:text-white visited:text-white'

export function Batch() {
  const params = useDevelopParams()
  const setParams = useSetDevelopParams()
  const { namespace: shellNamespace } = useActiveNamespace()
  const projects = useProjects()
  const apps = useApplications()
  const candidates = useMemo(
    () => [...projects.envNamespaces, ...PLATFORM_ENVIRONMENTS, ...(shellNamespace ? [shellNamespace] : [])],
    [projects.envNamespaces, shellNamespace],
  )
  const listQ = useBatchJobList(candidates)
  const list = listQ.data
  const runsQ = useBatchRuns(list)
  const anyActive = useMemo(() => (runsQ.data?.runs ?? []).some((r) => isActivePhase(runPhaseOf(r))), [runsQ.data])
  const now = useNow(anyActive)
  const runs = useRunRows(runsQ.data, now)

  const scheduledNamespaces = useMemo(
    () => [...new Set((list?.items ?? []).filter((j) => j.spec?.parameters?.schedule?.cron).map((j) => j.metadata.namespace ?? ''))].filter(Boolean),
    [list?.items],
  )
  const nextByCronJob = useNextSchedules(scheduledNamespaces)
  const rows = useMemo(
    () => jobRows(list?.items ?? [], runs, { envByNamespace: projects.envByNamespace, nextByCronJob, now }),
    [list?.items, runs, projects.envByNamespace, nextByCronJob, now],
  )
  const pending = useMemo(() => pendingApplications(apps.data, rows), [apps.data, rows])

  const state = pageStateOf({ list, isLoading: listQ.isLoading, isError: listQ.isError }, pending.length)
  const volcanoQ = useVolcanoInstalled()
  const queuesServed = Boolean(volcanoQ.data?.queues)
  const view: View = params.view === 'runs' ? 'runs' : params.view === 'queues' && queuesServed ? 'queues' : 'jobs'

  const createAccess = useAccessReview(CONSOLE_PERMISSIONS.applicationsCreate)
  const newJob = createAccess.allowed ? <a href={NEW_JOB_HREF} className={BUTTON_PRIMARY}>New batch job</a> : null

  // The open drawers: `?job=<namespace>/<name>`, `?run=<namespace>/<name>`.
  const openJobRef = parseBatchRef(params.job)
  const openJob = openJobRef ? rows.find((r) => r.key === batchRef(openJobRef.namespace, openJobRef.name)) : undefined
  const openRunRef = parseBatchRef(params.run)
  const openRun = openRunRef ? runs.find((r) => r.key === batchRef(openRunRef.namespace, openRunRef.name)) : undefined
  const jobOfRun = openRunRef && openRun?.batchJob ? rows.find((r) => r.key === batchRef(openRunRef.namespace, openRun.batchJob as string)) : undefined
  const namesForRestart = useMemo(
    () => (openRunRef && openRun?.batchJob ? runs.filter((r) => r.namespace === openRunRef.namespace && r.batchJob === openRun.batchJob).map((r) => r.name) : []),
    [runs, openRun?.batchJob, openRunRef?.namespace],
  )

  const openRunIn = (namespace: string, name: string) => setParams({ run: batchRef(namespace, name), runTab: '' })
  const empty = state === 'empty'

  return (
    <div className='space-y-4'>
      <PageHeader title='Batch' actions={empty || state === 'not-installed' || state === 'forbidden' ? undefined : newJob} />
      {list?.scope === 'namespaces' ? <LiveWatches list={list} volcano={Boolean(runsQ.data?.volcano)} /> : null}

      {state === 'not-installed'
        ? <BatchNotInstalled />
        : state === 'forbidden'
        ? <BatchForbidden denied={list?.denied ?? []} />
        : state === 'error'
        ? <BatchLoadError error={listQ.error} onRetry={() => listQ.refetch()} />
        : state === 'empty'
        ? <BatchEmpty action={newJob} />
        : (
          <>
            {list?.scope === 'namespaces' && list.denied.length
              ? (
                <p className='text-[11px] text-content-subtle'>
                  Showing the namespaces you can read. Not visible to you: <span className='font-mono'>{list.denied.join(', ')}</span>.
                </p>
              )
              : null}
            <Tabs<View> ariaLabel='Batch' value={view} onChange={(v) => setParams({ view: v })} tabs={queuesServed ? VIEWS_WITH_QUEUES : VIEWS}>
              {(t) => (
                <div className='space-y-4 pt-4'>
                  {t === 'jobs'
                    ? (
                      <JobsView
                        rows={rows}
                        pending={pending.map((a) => a.metadata.labels?.['adhar.io/application'] || a.metadata.name)}
                        loading={state === 'loading'}
                        refreshing={listQ.isFetching && state !== 'loading'}
                        runsLoading={runsQ.isLoading}
                        now={now}
                        initialQuery={params.app}
                        onOpen={(r) => setParams({ job: r.key, tab: '' })}
                      />
                    )
                    : t === 'queues'
                    ? <BatchQueues list={list} projects={projects.items} onOpenRun={openRunIn} />
                    : (
                      <RunsView
                        rows={runs}
                        loading={runsQ.isLoading || state === 'loading'}
                        refreshing={runsQ.isFetching && !runsQ.isLoading}
                        error={runsQ.error}
                        forbidden={Boolean(runsQ.data?.forbidden)}
                        partial={Boolean(runsQ.data?.partial)}
                        podsUnknown={Boolean(runsQ.data?.podsUnknown)}
                        onRetry={() => runsQ.refetch()}
                        onOpen={(r) => openRunIn(r.namespace, r.name)}
                      />
                    )}
                </div>
              )}
            </Tabs>
          </>
        )}

      {openJob
        ? (
          <JobDrawer
            key={openJob.key}
            row={openJob}
            applications={apps.data}
            now={now}
            tab={params.tab}
            onTab={(t: JobTab) => setParams({ tab: t })}
            onClose={() => setParams({ job: '', tab: '' })}
            onOpenRun={(name) => openRunIn(openJob.namespace, name)}
          />
        )
        : null}
      {openRunRef
        ? (
          <RunDrawer
            key={`${openRunRef.namespace}/${openRunRef.name}`}
            namespace={openRunRef.namespace}
            name={openRunRef.name}
            kind={openRun?.kind}
            job={jobOfRun?.job ?? (openJob?.namespace === openRunRef.namespace ? openJob.job : undefined)}
            existingNames={namesForRestart}
            tab={params.runTab}
            onTab={(t: RunTab) => setParams({ runTab: t })}
            onClose={() => setParams({ run: '', runTab: '' })}
            onOpenRun={(name) => openRunIn(openRunRef.namespace, name)}
          />
        )
        : null}
    </div>
  )
}

/** The change signal for a caller who cannot watch cluster-wide. Renders nothing. */
function LiveWatches({ list, volcano }: { list: { namespaces: string[]; denied: string[] }; volcano: boolean }) {
  const readable = list.namespaces.filter((n) => !list.denied.includes(n))
  return <>{readable.map((ns) => <NamespaceWatch key={ns} namespace={ns} volcano={volcano} />)}</>
}

function NamespaceWatch({ namespace, volcano }: { namespace: string; volcano: boolean }) {
  useNamespaceWatches(namespace, volcano)
  return null
}

/* ─────────────────────────── Jobs ─────────────────────────── */

const JOB_FACETS = ['status', 'environment', 'project', 'team'] as const
type JobFacet = (typeof JOB_FACETS)[number]
const JOB_FACET_LABEL: Record<JobFacet, string> = { status: 'Status', environment: 'Environment', project: 'Project', team: 'Team' }

const jobFacetOf = (r: JobRow, id: JobFacet): string[] => {
  if (id === 'status') return [r.status, ...(r.held ? ['held'] : [])]
  const v = r[id]
  return v ? [v] : []
}

const statusLabel = (v: string) => (v === 'held' ? 'Held' : JOB_STATUS_LABEL[v as JobStatus] ?? v)

function JobsView({
  rows,
  pending,
  loading,
  refreshing,
  runsLoading,
  now,
  initialQuery,
  onOpen,
}: {
  rows: readonly JobRow[]
  pending: readonly string[]
  loading: boolean
  refreshing: boolean
  runsLoading: boolean
  now: number
  /** `?app=` (the Create New success link) starts the search on that application. */
  initialQuery?: string
  onOpen(r: JobRow): void
}) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [values, setValues] = useState<FacetValues>({})

  const facets = useMemo((): Facet[] =>
    JOB_FACETS.map((id) => ({
      id,
      label: JOB_FACET_LABEL[id],
      kind: 'multi' as const,
      options: optionsFromItems(rows as JobRow[], (r) => jobFacetOf(r, id), id === 'status' ? { label: statusLabel } : {}),
    })).filter((f) => f.options.length > 0), [rows])

  const accessors = useMemo(() => Object.fromEntries(JOB_FACETS.map((id) => [id, (r: JobRow) => jobFacetOf(r, id)])), [])
  const filtered = useMemo(
    () => rows.filter((r) => matchesQuery(query, jobSearchText(r)) && matchesFacets(r, values, accessors)),
    [rows, query, values, accessors],
  )
  const groups = useMemo(() => groupByApplication(filtered), [filtered])
  const count = {
    running: rows.filter((r) => r.status === 'running').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    held: rows.filter((r) => r.held).length,
    breached: rows.filter((r) => r.sla.level === 'breached').length,
  }
  const toggle = (id: string, v: string) => {
    const cur = values[id] ?? []
    setValues({ ...values, [id]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] })
  }
  const filtering = Boolean(query) || Object.values(values).some((v) => v.length)
  const scheduled = rows.filter((r) => r.schedule.cron).length

  return (
    <>
      <div className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
        <StatTile label='Jobs' value={loading ? '…' : rows.length} hint={loading ? undefined : `${scheduled} scheduled`} />
        <StatTile label='Running' value={loading || runsLoading ? '…' : count.running} tone='info' on={(values.status ?? []).includes('running')} onClick={() => toggle('status', 'running')} />
        <StatTile label='Last run failed' value={loading || runsLoading ? '…' : count.failed} tone='amber' on={(values.status ?? []).includes('failed')} onClick={() => toggle('status', 'failed')} />
        <StatTile label='Held' value={loading ? '…' : count.held} tone='violet' hint='schedule suspended' on={(values.status ?? []).includes('held')} onClick={() => toggle('status', 'held')} />
        <StatTile label='SLA breached' value={loading || runsLoading ? '…' : count.breached} tone='amber' />
      </div>

      <FilterBar
        search={{ value: query, onChange: setQuery, placeholder: 'Search jobs, applications, namespaces…', label: 'Search batch jobs' }}
        facets={facets}
        values={values}
        onValuesChange={setValues}
        loading={loading}
        refreshing={refreshing}
        summary={<span aria-live='polite'>{filtered.length} {filtered.length === 1 ? 'job' : 'jobs'}{filtered.length !== rows.length ? ` of ${rows.length}` : ''}</span>}
      />

      {!loading && !groups.length && !pending.length
        ? filtering
          ? <EmptyState compact title='No jobs match' description='Nothing matches the search and filters. Clear them to see every job.' />
          : <BatchEmpty compact />
        : (
          <div className='overflow-x-auto rounded-xl border border-edge-default bg-surface-raised'>
            <table className={TABLE}>
              <thead className='bg-surface-muted'>
                <tr>
                  <th className={TH}>Job</th>
                  <th className={TH}>Environment</th>
                  <th className={TH}>Schedule</th>
                  <th className={TH}>Next run</th>
                  <th className={TH}>Last run</th>
                  <th className={TH}>Last success</th>
                  <th className={TH}>SLA</th>
                </tr>
              </thead>
              {loading
                ? (
                  <tbody>
                    {[0, 1, 2].map((i) => (
                      <tr key={i}><td colSpan={7} className={TD}><div className='h-5 animate-pulse rounded bg-surface-sunken' /></td></tr>
                    ))}
                  </tbody>
                )
                : null}
              {groups.map((g) => (
                <tbody key={g.application} className='divide-y divide-edge-subtle border-t border-edge-default'>
                  <tr>
                    <th colSpan={7} scope='rowgroup' className='bg-surface-sunken px-3 py-1.5 text-left text-[11px] font-semibold text-content-muted'>
                      {g.application}
                      {g.rows[0].project ? <span className='font-normal text-content-subtle'> · project {g.rows[0].project}</span> : null}
                    </th>
                  </tr>
                  {g.rows.map((r) => <JobRowView key={r.key} row={r} now={now} runsLoading={runsLoading} onOpen={() => onOpen(r)} />)}
                </tbody>
              ))}
              {pending.length && !filtering
                ? (
                  <tbody className='divide-y divide-edge-subtle border-t border-edge-default'>
                    {pending.map((app) => (
                      <tr key={app}>
                        <td className={cn(TD, 'font-medium')}>{app}</td>
                        <td colSpan={6} className={cn(TD, 'text-content-subtle')}>
                          <StatusBadge kind='info'>not deployed yet</StatusBadge>{' '}
                          Its first build has to pass its gates and be promoted before a BatchJob exists.{' '}
                          <a href={`/catalog?entity=${encodeURIComponent(`component:${app}`)}&tab=deploy`} className='text-brand-700 hover:underline dark:text-brand-300'>Deploy status</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                )
                : null}
            </table>
          </div>
        )}
    </>
  )
}

function JobRowView({ row, now, runsLoading, onOpen }: { row: JobRow; now: number; runsLoading: boolean; onOpen(): void }) {
  const last = row.lastRun
  return (
    <tr className='cursor-pointer hover:bg-surface-sunken' onClick={onOpen}>
      <td className={TD}>
        <div className='flex flex-wrap items-center gap-1.5'>
          <button
            type='button'
            className='text-left font-medium text-content hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40'
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
          >
            {row.displayName}
          </button>
          {row.held ? <span title={row.held.reason}><StatusBadge kind='paused'>Held</StatusBadge></span> : null}
          {row.status === 'not-ready' ? <span title={row.problem}><StatusBadge kind={JOB_STATUS_BADGE['not-ready']}>Not ready</StatusBadge></span> : null}
        </div>
        <div className='text-[11px] text-content-subtle'>{[row.displayName !== row.name ? row.name : null, row.job.spec?.parameters?.job, row.queue ? `queue ${row.queue}` : null].filter(Boolean).join(' · ')}</div>
      </td>
      <td className={cn(TD, 'capitalize')}>{row.environment ?? <span className='font-mono normal-case text-content-subtle'>{row.namespace}</span>}</td>
      <td className={TD}>
        <div title={row.schedule.cron}>{row.schedule.label}</div>
        {row.schedule.cron ? <div className='text-[11px] text-content-subtle'>{row.schedule.timeZone}</div> : null}
      </td>
      <td className={TD}>
        {row.held
          ? <span className='text-content-subtle'>held</span>
          : row.schedule.suspended
          ? <span className='text-content-subtle'>suspended</span>
          : <Until at={row.nextRunMs} timeZone={row.schedule.timeZone} now={now} />}
      </td>
      <td className={TD}>
        {last
          ? (
            <div className='space-y-0.5'>
              <RunBadge row={last} />
              <div className='text-[11px] text-content-subtle'>
                <DurationText ms={last.durationMs} running={isActivePhase(last.phase)} /> · <When at={last.startedAt ?? last.created} />
              </div>
            </div>
          )
          : runsLoading
          ? <span className='text-content-subtle'>…</span>
          : <span className='text-content-subtle'>No runs yet</span>}
      </td>
      <td className={cn(TD, 'text-content-muted')}><When at={row.lastSuccess} /></td>
      <td className={TD}><SlaBadge sla={row.sla} /></td>
    </tr>
  )
}

/* ─────────────────────────── Runs ─────────────────────────── */

const RUN_FACETS = ['status', 'trigger', 'environment', 'job'] as const
type RunFacet = (typeof RUN_FACETS)[number]
const RUN_FACET_LABEL: Record<RunFacet, string> = { status: 'Status', trigger: 'Trigger', environment: 'Environment', job: 'Job' }

const runFacetOf = (r: RunRow, id: RunFacet): string[] => {
  const v = id === 'status' ? r.phase : id === 'trigger' ? r.trigger : id === 'environment' ? r.environment : r.batchJob
  return v ? [v] : []
}

function RunsView({
  rows,
  loading,
  refreshing,
  error,
  forbidden,
  partial,
  podsUnknown,
  onRetry,
  onOpen,
}: {
  rows: readonly RunRow[]
  loading: boolean
  refreshing: boolean
  error: unknown
  forbidden: boolean
  partial: boolean
  podsUnknown: boolean
  onRetry(): void
  onOpen(r: RunRow): void
}) {
  const [query, setQuery] = useState('')
  const [values, setValues] = useState<FacetValues>({})
  const facets = useMemo((): Facet[] =>
    RUN_FACETS.map((id) => ({
      id,
      label: RUN_FACET_LABEL[id],
      kind: 'multi' as const,
      options: optionsFromItems(rows as RunRow[], (r) => runFacetOf(r, id), id === 'status' ? { label: (v: string) => PHASE_LABEL[v as RunRow['phase']] ?? v } : {}),
    })).filter((f) => f.options.length > 0), [rows])
  const accessors = useMemo(() => Object.fromEntries(RUN_FACETS.map((id) => [id, (r: RunRow) => runFacetOf(r, id)])), [])
  const filtered = useMemo(
    () => rows.filter((r) => matchesQuery(query, runSearchText(r)) && matchesFacets(r, values, accessors)),
    [rows, query, values, accessors],
  )
  const columns = useMemo((): Column<RunRow>[] => [
    {
      key: 'run',
      header: 'Run',
      pinned: true,
      value: (r) => r.name,
      cell: (r) => (
        <div className='min-w-0'>
          <div className='truncate font-mono text-[12px] text-content'>{r.name}</div>
          <div className='truncate text-[11px] text-content-subtle'>{[r.batchJob, r.environment ?? r.namespace].filter(Boolean).join(' · ')}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', value: (r) => r.phase, cell: (r) => <RunBadge row={r} /> },
    { key: 'trigger', header: 'Trigger', value: (r) => r.trigger ?? '', cell: (r) => r.trigger ?? <span className='text-content-subtle'>—</span> },
    { key: 'actor', header: 'Actor', value: (r) => r.actor ?? '', cell: (r) => (r.actor ? <span className='font-mono text-[11px]'>{r.actor}</span> : <span className='text-content-subtle'>—</span>) },
    { key: 'date', header: 'Business date', value: (r) => r.businessDate ?? '', cell: (r) => (r.businessDate ? <span className='font-mono text-[12px]'>{r.businessDate}</span> : <span className='text-content-subtle'>—</span>) },
    { key: 'attempts', header: 'Attempts', numeric: true, value: (r) => r.attempts, cell: (r) => r.attempts },
    { key: 'duration', header: 'Took', value: (r) => r.durationMs ?? -1, cell: (r) => <DurationText ms={r.durationMs} running={isActivePhase(r.phase)} /> },
    { key: 'exit', header: 'Exit', value: (r) => r.exitCode ?? -1, filter: false, cell: (r) => <ExitCode code={r.exitCode} /> },
    { key: 'started', header: 'Started', value: (r) => r.startedAt ?? r.created ?? '', cell: (r) => <When at={r.startedAt ?? r.created} /> },
  ], [])
  const filtering = Boolean(query) || Object.values(values).some((v) => v.length)

  if (forbidden) {
    return <EmptyState title='You may not list runs here' description={<>Runs are <span className='font-mono'>jobs.batch</span> labelled for a batch job. Your account may not list them in the namespaces it was checked against.</>} />
  }
  if (error && !rows.length) {
    return (
      <EmptyState
        tone='error'
        title='Could not load runs'
        description={error instanceof Error ? error.message : String(error)}
        action={
          <button type='button' onClick={onRetry} className='inline-flex h-8 items-center rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong'>
            Retry
          </button>
        }
      />
    )
  }
  return (
    <>
      <FilterBar
        search={{ value: query, onChange: setQuery, placeholder: 'Search runs, jobs, actors, business dates…', label: 'Search runs' }}
        facets={facets}
        values={values}
        onValuesChange={setValues}
        loading={loading}
        refreshing={refreshing}
        summary={<span aria-live='polite'>{filtered.length} {filtered.length === 1 ? 'run' : 'runs'}{filtered.length !== rows.length ? ` of ${rows.length}` : ''}</span>}
      />
      {partial ? <Note>Some namespaces refused the list, so this is not every run.</Note> : null}
      {podsUnknown ? <Note tone='warn'>Pods could not be read, so exit codes and summaries are unknown, not absent.</Note> : null}
      <DataTable
        tableId='develop.batch.runs'
        columns={columns}
        rows={filtered}
        rowKey={(r) => r.key}
        onRowClick={onOpen}
        loading={loading}
        dense
        empty={
          filtering
            ? <EmptyState compact title='No runs match' description='Nothing matches the search and filters. Clear them to see every run.' />
            : <EmptyState compact title='No runs yet' description='A run appears when a schedule fires or someone starts one from a job. Finished runs stay here until their TTL passes (seven days by default).' />
        }
      />
    </>
  )
}
