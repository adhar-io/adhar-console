import { useMemo, useState } from 'react'
import {
  type Column,
  DataTable,
  EmptyState,
  type Facet,
  type FacetValues,
  FilterBar,
  matchesFacets,
  matchesQuery,
  optionsFromItems,
  StatusBadge,
} from '@adhar/shell-ui'
import { batchRef } from '../data/batch-model.ts'
import { useBatchHistory } from '../data/batch-history.ts'
import { durationWords, type HistoryRead, type HistoryRow, historyRows, historySearchText } from '../data/batch-history-model.ts'
import { ExitCode, When } from '../components/batch/bits.tsx'
import { Note } from './function-bits.tsx'

/**
 * Develop → Batch → History (design 0025 §7.2, D12): what happened to the jobs
 * beyond the runs the cluster still holds.
 *
 * A run Job is deleted by its TTL (seven days by default); the batch observer
 * published each of its transitions onto `adhar.batch`, which keeps 90 days.
 * The console reads that stream and `/api/batch/history` hands back the events
 * of the namespaces this person may list BatchJobs in.
 *
 * The bus is opt-in, so "there is no bus" is a state with its own words here,
 * and never an empty table: an empty history would say nothing ran.
 *
 * Past the stream, the run-summary archive (design 0025 Phase 4): the batch
 * observer keeps every finished run's final event in the object store, and for
 * an open job the BFF adds the ones the stream no longer holds — marked
 * "archived", because they are the end of each run and nothing before it.
 */

const SINCE = [{ id: '24h', label: 'Last 24 hours' }, { id: '7d', label: 'Last 7 days' }, { id: '30d', label: 'Last 30 days' }, {
  id: '90d',
  label: 'Everything kept (90 days)',
}, { id: '365d', label: 'Last 12 months (archive)' }] as const
type Since = (typeof SINCE)[number]['id']
const LIMIT = 2_000

const FACETS = ['event', 'job', 'environment', 'trigger'] as const
type HistoryFacet = (typeof FACETS)[number]
const FACET_LABEL: Record<HistoryFacet, string> = { event: 'Event', job: 'Job', environment: 'Environment', trigger: 'Trigger' }

/** What the stream being unreadable means, by the reason the BFF gives. */
export function HistoryUnavailable({ read }: { read: Extract<HistoryRead, { state: 'unavailable' }> }) {
  if (read.reason === 'no-bus') {
    return (
      <EmptyState
        title='This cluster keeps no batch history'
        description={
          <>
            History comes from the platform event bus, which is not enabled here (it is opt-in: the <span className='font-mono'>kafka-operator</span>{' '}
            package). Runs the cluster still holds are under Runs, until their TTL passes.
          </>
        }
      />
    )
  }
  return (
    <EmptyState
      tone='error'
      title='The batch history could not be read'
      description={
        <>
          {read.detail} This is not “nothing ran”: the events are on the <span className='font-mono'>adhar.batch</span>{' '}
          topic, and the console could not reach it.
        </>
      }
    />
  )
}

export function BatchHistory({
  envByNamespace,
  heldRuns,
  jobKeys,
  job,
  onOpenJob,
  onOpenRun,
}: {
  envByNamespace?: ReadonlyMap<string, string>
  /** `<namespace>/<name>` of the runs the cluster still holds: only those open a run drawer. */
  heldRuns?: ReadonlySet<string>
  /** `<namespace>/<name>` of the BatchJobs on the page: only those open a job drawer. */
  jobKeys?: ReadonlySet<string>
  /** Narrow to one job (`<namespace>/<name>`). */
  job?: { namespace: string; name: string }
  onOpenJob?(namespace: string, name: string): void
  onOpenRun?(namespace: string, name: string): void
}) {
  const [since, setSince] = useState<Since>('7d')
  const q = useBatchHistory({ since, limit: LIMIT, ...(job ? { namespace: job.namespace, job: job.name } : {}) })
  return (
    <HistoryTable
      read={q.data}
      loading={q.isLoading}
      refreshing={q.isFetching && !q.isLoading}
      error={q.error}
      onRetry={() => q.refetch()}
      since={since}
      onSince={setSince}
      envByNamespace={envByNamespace}
      heldRuns={heldRuns}
      jobKeys={jobKeys}
      onOpenJob={onOpenJob}
      onOpenRun={onOpenRun}
    />
  )
}

/** The table, from a read: separate from the hook so every state renders from data. */
export function HistoryTable({
  read,
  loading,
  refreshing = false,
  error,
  onRetry,
  since,
  onSince,
  envByNamespace,
  heldRuns,
  jobKeys,
  onOpenJob,
  onOpenRun,
}: {
  read: HistoryRead | undefined
  loading: boolean
  refreshing?: boolean
  error?: unknown
  onRetry?(): void
  since: Since
  onSince(s: Since): void
  envByNamespace?: ReadonlyMap<string, string>
  heldRuns?: ReadonlySet<string>
  jobKeys?: ReadonlySet<string>
  onOpenJob?(namespace: string, name: string): void
  onOpenRun?(namespace: string, name: string): void
}) {
  const [query, setQuery] = useState('')
  const [values, setValues] = useState<FacetValues>({})
  const rows = useMemo(() => (read?.state === 'read' ? historyRows(read.events) : []), [read])
  const envOf = (r: HistoryRow) => envByNamespace?.get(r.namespace) ?? r.namespace
  const facetOf = (r: HistoryRow, id: HistoryFacet): string[] => {
    const v = id === 'event' ? r.label : id === 'job' ? r.job : id === 'environment' ? envOf(r) : r.trigger
    return v ? [v] : []
  }
  const facets = useMemo(
    (): Facet[] =>
      FACETS.map((id) => ({ id, label: FACET_LABEL[id], kind: 'multi' as const, options: optionsFromItems(rows, (r) => facetOf(r, id)) })).filter((f) =>
        f.options.length > 0
      ),
    [rows, envByNamespace],
  )
  const accessors = useMemo(() => Object.fromEntries(FACETS.map((id) => [id, (r: HistoryRow) => facetOf(r, id)])), [envByNamespace])
  const filtered = useMemo(() => rows.filter((r) => matchesQuery(query, historySearchText(r)) && matchesFacets(r, values, accessors)), [
    rows,
    query,
    values,
    accessors,
  ])

  const columns = useMemo((): Column<HistoryRow>[] => [
    {
      key: 'when',
      header: 'When',
      pinned: true,
      value: (r) => r.at ?? 0,
      cell: (r) => (r.time ? <When at={r.time} /> : <span className='text-content-subtle'>unknown</span>),
    },
    {
      key: 'event',
      header: 'Event',
      value: (r) => r.label,
      cell: (r) => (
        <span title={r.event} className='inline-flex items-center gap-1.5'>
          <StatusBadge kind={r.tone}>{r.label}</StatusBadge>
          {r.archived
            ? (
              <span
                className='rounded border border-edge-default px-1 text-[10px] uppercase tracking-wide text-content-subtle'
                title='From the run-summary archive: the stream no longer holds this run'
              >
                archived
              </span>
            )
            : null}
        </span>
      ),
    },
    {
      key: 'job',
      header: 'Job',
      value: (r) => r.job,
      cell: (r) => (
        <div className='min-w-0'>
          {onOpenJob && jobKeys?.has(batchRef(r.namespace, r.job))
            ? (
              <button type='button' className='truncate text-left font-medium text-content hover:underline' onClick={() => onOpenJob(r.namespace, r.job)}>
                {r.job}
              </button>
            )
            : <div className='truncate font-medium text-content'>{r.job}</div>}
          <div className='truncate text-[11px] capitalize text-content-subtle'>{envOf(r)}</div>
        </div>
      ),
    },
    {
      key: 'run',
      header: 'Run',
      value: (r) => r.run ?? '',
      cell: (r) =>
        !r.run ? <span className='text-content-subtle'>—</span> : onOpenRun && heldRuns?.has(batchRef(r.namespace, r.run))
          ? (
            <button
              type='button'
              className='font-mono text-[12px] text-brand-700 hover:underline dark:text-brand-300'
              onClick={() => onOpenRun(r.namespace, r.run as string)}
            >
              {r.run}
            </button>
          )
          : <span className='font-mono text-[12px]' title='This run is no longer in the cluster'>{r.run}</span>,
    },
    {
      key: 'date',
      header: 'Business date',
      value: (r) => r.businessDate ?? '',
      cell: (r) => (r.businessDate ? <span className='font-mono text-[12px]'>{r.businessDate}</span> : <span className='text-content-subtle'>—</span>),
    },
    { key: 'trigger', header: 'Trigger', value: (r) => r.trigger ?? '', cell: (r) => r.trigger ?? <span className='text-content-subtle'>—</span> },
    {
      key: 'actor',
      header: 'Actor',
      value: (r) => r.actor ?? '',
      cell: (r) => (r.actor ? <span className='font-mono text-[11px]'>{r.actor}</span> : <span className='text-content-subtle'>—</span>),
    },
    {
      key: 'took',
      header: 'Took',
      value: (r) => r.durationMs ?? -1,
      cell: (r) => durationWords(r.durationMs) ?? <span className='text-content-subtle'>—</span>,
    },
    { key: 'exit', header: 'Exit', value: (r) => r.exitCode ?? -1, filter: false, cell: (r) => <ExitCode code={r.exitCode} /> },
    {
      key: 'detail',
      header: 'Detail',
      value: (r) => r.detail,
      cell: (r) => <span className='text-content-muted [overflow-wrap:anywhere]'>{r.detail || '—'}</span>,
    },
  ], [envByNamespace, heldRuns, jobKeys, onOpenJob, onOpenRun])

  if (read?.state === 'unavailable') return <HistoryUnavailable read={read} />
  if (error && !read) {
    return (
      <EmptyState
        tone='error'
        title='The batch history could not be read'
        description={error instanceof Error ? error.message : String(error)}
        action={onRetry
          ? (
            <button
              type='button'
              onClick={onRetry}
              className='inline-flex h-8 items-center rounded-md border border-edge-default bg-surface-raised px-3 text-[12px] font-medium text-content shadow-sm hover:border-edge-strong'
            >
              Retry
            </button>
          )
          : undefined}
      />
    )
  }
  const filtering = Boolean(query) || Object.values(values).some((v) => v.length)
  const shownOf = read?.state === 'read' && read.total > rows.length ? read.total : undefined
  return (
    <>
      <FilterBar
        search={{ value: query, onChange: setQuery, placeholder: 'Search jobs, runs, actors, business dates…', label: 'Search batch history' }}
        facets={facets}
        values={values}
        onValuesChange={setValues}
        loading={loading}
        refreshing={refreshing}
        summary={
          <span className='inline-flex items-center gap-2'>
            <label className='inline-flex items-center gap-1.5 text-[12px] text-content-subtle'>
              <span className='sr-only'>Period</span>
              <select
                value={since}
                onChange={(e) => onSince(e.target.value as Since)}
                className='h-7 rounded-md border border-edge-default bg-surface-raised px-1.5 text-[12px] text-content'
              >
                {SINCE.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <span aria-live='polite'>
              {filtered.length} {filtered.length === 1 ? 'event' : 'events'}
              {filtered.length !== rows.length ? ` of ${rows.length}` : ''}
            </span>
          </span>
        }
      />
      {shownOf ? <Note>Showing the newest {rows.length} of {shownOf} events in this period. Narrow the period, or open a job, to see the rest.</Note> : null}
      {read?.state === 'read' && read.truncated
        ? (
          <Note tone='warn'>
            The stream is larger than the console reads in one pass, so the oldest events are not here. <span className='font-mono'>adhar batch history</span>
            {' '}
            reads all of it.
          </Note>
        )
        : null}
      {read?.state === 'read' && read.behind
        ? (
          <Note tone='warn'>
            The console ran out of time before it reached the end of the stream, so the most recent events are not here. That is not the same as nothing having
            run since. <span className='font-mono'>adhar batch history</span> reads all of it.
          </Note>
        )
        : null}
      {read?.state === 'read' && read.stream
        ? (
          <Note tone='warn'>
            The event stream could not be read ({read.stream.detail}), so this is the run-summary archive alone: how each finished run ended, and nothing
            before it.
          </Note>
        )
        : null}
      {read?.state === 'read' && read.archive?.state === 'unreachable'
        ? <Note tone='warn'>The run-summary archive could not be read, so runs older than the event stream are not here. {read.archive.detail}</Note>
        : null}
      {read?.state === 'read' && read.archive?.state === 'skipped' && (since === '90d' || since === '365d')
        ? <Note>Runs older than the event stream are kept in the run-summary archive. Open a job to include them.</Note>
        : null}
      {read?.state === 'read' && read.degraded
        ? (
          <Note tone='warn'>
            Access to some namespaces could not be checked, so their events are left out. That is not the same as nothing having happened there.
          </Note>
        )
        : null}
      <DataTable
        tableId='develop.batch.history'
        columns={columns}
        rows={filtered}
        rowKey={(r) => r.key}
        loading={loading}
        dense
        empty={filtering
          ? <EmptyState compact title='No events match' description='Nothing matches the search and filters. Clear them to see every event.' />
          : (
            <EmptyState
              compact
              title='No batch events in this period'
              description='The batch observer publishes an event each time a run is requested, starts, ends or is lost, and when a schedule is held or misses a slot. Nothing in the namespaces you can see did, in this period.'
            />
          )}
      />
    </>
  )
}
