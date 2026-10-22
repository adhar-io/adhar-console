import { useMemo, useRef, useState } from 'react'
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatusBadge,
  type StatusKind,
  Tabs,
  useToast,
  useToolPublicUrl,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { airbyte } from '@adhar/api-clients'
import {
  useCancelJob,
  useCheckDestination,
  useCheckSource,
  useConnections,
  useDeleteConnection,
  useDestinations,
  useJobLogs,
  useJobs,
  useRenameConnection,
  useResetConnection,
  useSources,
  useToggleConnection,
  useTriggerSync,
  useUpdateSchedule,
} from '../data/airbyte.ts'
import { useDevelopParams, useSetDevelopParams } from '../data/nav.ts'
import { IconExternal, IconRefresh } from '../components/repo-bits.tsx'
import {
  CloseButton,
  Drawer,
  LoadingBlock,
  MenuItem,
  MoreMenu,
  SearchField,
  Segmented,
  type SortDef,
  SortMenu,
  StatTile,
} from '../components/list-kit.tsx'
import { useAct } from '../components/tracker-bits.tsx'
import { useSlashFocus } from '../components/repo-filter.tsx'

/**
 * Pipelines — Airbyte data movement, end to end.
 *
 *   · Connections: every source → destination pipeline with its schedule,
 *     last sync, volume, next run and recent job history; sync, pause,
 *     reschedule, reset, rename or delete from the row or the drawer.
 *   · Sync history: every job across the workspace, filterable, with
 *     cancel and per-job logs.
 *   · Sources / Destinations: the connectors, which pipelines use them, and
 *     a "Test connection" check.
 *
 * The open connection (`?conn=`) and the tab (`?view=`) are in the URL.
 */

type View = 'connections' | 'jobs' | 'sources' | 'destinations'
type ConnFilter = 'all' | 'active' | 'paused' | 'syncing' | 'failing'
type ConnSort = 'name' | 'last' | 'volume' | 'next'

const JOB_TONE: Record<airbyte.JobStatus, StatusKind> = {
  pending: 'info',
  running: 'progressing',
  incomplete: 'paused',
  failed: 'failed',
  succeeded: 'healthy',
  cancelled: 'unknown',
}
const JOB_DOT: Record<airbyte.JobStatus, string> = {
  pending: 'bg-sky-400',
  running: 'bg-indigo-500 animate-pulse',
  incomplete: 'bg-amber-500',
  failed: 'bg-rose-500',
  succeeded: 'bg-emerald-500',
  cancelled: 'bg-slate-400',
}

const SORTS: ReadonlyArray<SortDef<ConnSort>> = [
  { key: 'last', label: 'Last sync', defaultDir: 'desc' },
  { key: 'next', label: 'Next sync', defaultDir: 'asc' },
  { key: 'volume', label: 'Data volume', defaultDir: 'desc' },
  { key: 'name', label: 'Name', defaultDir: 'asc' },
]

export function Pipelines() {
  const params = useDevelopParams()
  const setParams = useSetDevelopParams()
  const view = (['connections', 'jobs', 'sources', 'destinations'].includes(params.view ?? '') ? params.view : 'connections') as View
  const airbyteUrl = useToolPublicUrl('airbyte')

  const conns = useConnections()
  const sources = useSources()
  const dests = useDestinations()
  const jobs = useJobs({ limit: 100 })

  const [filter, setFilter] = useState<ConnFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<{ kind: 'source' | 'dest'; id: string; name: string } | null>(null)

  const list = useMemo(() => conns.data ?? [], [conns.data])
  const stats = useMemo(() => {
    let records = 0, bytes = 0
    for (const c of list) {
      records += c.last_sync_records ?? 0
      bytes += c.last_sync_bytes ?? 0
    }
    return {
      total: list.length,
      active: list.filter((c) => c.status === 'active').length,
      paused: list.filter((c) => c.status !== 'active').length,
      syncing: list.filter((c) => c.last_sync_status === 'running' || c.last_sync_status === 'pending').length,
      failing: list.filter((c) => c.last_sync_status === 'failed' || c.last_sync_status === 'incomplete').length,
      records,
      bytes,
    }
  }, [list])
  const jobsByConn = useMemo(() => {
    const m = new Map<string, airbyte.Job[]>()
    for (const j of jobs.data ?? []) {
      const arr = m.get(j.connection_id) ?? []
      arr.push(j)
      m.set(j.connection_id, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => b.created_at.localeCompare(a.created_at))
    return m
  }, [jobs.data])
  const successRate = useMemo(() => {
    const done = (jobs.data ?? []).filter((j) => j.status === 'succeeded' || j.status === 'failed')
    return done.length ? Math.round((done.filter((j) => j.status === 'succeeded').length / done.length) * 100) : null
  }, [jobs.data])

  const openConn = list.find((c) => c.connection_id === params.conn)
  const pickFilter = (f: ConnFilter) => {
    setFilter((cur) => (cur === f ? 'all' : f))
    setParams({ view: undefined })
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pipelines"
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => { conns.refetch(); jobs.refetch(); sources.refetch(); dests.refetch() }} aria-label="Refresh" title="Refresh">
              <IconRefresh />
            </Button>
            {airbyteUrl ? (
              <a href={airbyteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md bg-brand-600 px-2.5 text-sm font-medium text-white hover:bg-brand-700">
                New connection in Airbyte <IconExternal />
              </a>
            ) : null}
          </>
        }
      />

      {conns.isLoading ? <LoadingBlock label="Loading pipelines…" /> : conns.isError ? (
        <EmptyState
          title="Couldn't reach Airbyte"
          description={conns.error instanceof Error ? conns.error.message : 'Airbyte did not answer.'}
          action={<Button size="sm" variant="secondary" onClick={() => conns.refetch()}>Retry</Button>}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
            <StatTile label="Connections" value={stats.total} hint={`${sources.data?.length ?? 0} sources · ${dests.data?.length ?? 0} dest.`} on={view === 'connections' && filter === 'all'} onClick={() => { setFilter('all'); setParams({ view: undefined }) }} />
            <StatTile label="Active" value={stats.active} tone="emerald" hint="on a schedule" on={filter === 'active'} onClick={() => pickFilter('active')} />
            <StatTile label="Paused" value={stats.paused} tone="slate" hint="not syncing" on={filter === 'paused'} onClick={() => pickFilter('paused')} />
            <StatTile label="Syncing now" value={stats.syncing} tone="brand" hint="running or queued" on={filter === 'syncing'} onClick={() => pickFilter('syncing')} />
            <StatTile label="Failing" value={stats.failing} tone={stats.failing ? 'amber' : 'emerald'} hint={stats.failing ? 'last sync failed' : 'all healthy'} on={filter === 'failing'} onClick={() => pickFilter('failing')} />
            <StatTile label="Success rate" value={successRate == null ? '—' : `${successRate}%`} tone={successRate != null && successRate < 90 ? 'amber' : 'emerald'} hint={`last ${jobs.data?.length ?? 0} jobs`} onClick={() => setParams({ view: 'jobs' })} on={view === 'jobs'} />
            <StatTile label="Last syncs moved" value={fmtBytes(stats.bytes)} tone="violet" hint={`${fmtNum(stats.records)} records`} />
          </div>

          <Tabs<View>
            ariaLabel="Pipelines"
            value={view}
            onChange={(v) => setParams({ view: v === 'connections' ? undefined : v })}
            tabs={[
              { id: 'connections', label: 'Connections', badge: { kind: 'unknown', value: list.length } },
              { id: 'jobs', label: 'Sync history', badge: stats.syncing ? { kind: 'progressing', value: stats.syncing } : undefined },
              { id: 'sources', label: 'Sources', badge: { kind: 'unknown', value: sources.data?.length ?? 0 } },
              { id: 'destinations', label: 'Destinations', badge: { kind: 'unknown', value: dests.data?.length ?? 0 } },
            ]}
          >
            {(active) => (
              <div className="pt-3">
                {active === 'connections' && (
                  <ConnectionList
                    list={list}
                    jobsByConn={jobsByConn}
                    filter={filter}
                    onFilter={setFilter}
                    connector={sourceFilter}
                    onClearConnector={() => setSourceFilter(null)}
                    onOpen={(id) => setParams({ conn: id })}
                  />
                )}
                {active === 'jobs' && <JobHistory jobs={jobs.data ?? []} loading={jobs.isLoading} connections={list} onOpenConn={(id) => setParams({ conn: id })} />}
                {active === 'sources' && (
                  <ConnectorGrid
                    kind="source"
                    loading={sources.isLoading}
                    items={(sources.data ?? []).map((s) => ({ id: s.source_id, name: s.name, type: s.source_type, icon: s.icon, status: s.connection_status }))}
                    connections={list}
                    onShow={(id, name) => { setSourceFilter({ kind: 'source', id, name }); setFilter('all'); setParams({ view: undefined }) }}
                  />
                )}
                {active === 'destinations' && (
                  <ConnectorGrid
                    kind="dest"
                    loading={dests.isLoading}
                    items={(dests.data ?? []).map((d) => ({ id: d.destination_id, name: d.name, type: d.destination_type, icon: d.icon, status: d.connection_status }))}
                    connections={list}
                    onShow={(id, name) => { setSourceFilter({ kind: 'dest', id, name }); setFilter('all'); setParams({ view: undefined }) }}
                  />
                )}
              </div>
            )}
          </Tabs>
        </>
      )}

      {params.conn ? (
        <ConnectionDrawer
          key={params.conn}
          conn={openConn}
          loading={conns.isLoading}
          jobs={jobsByConn.get(params.conn) ?? []}
          airbyteUrl={airbyteUrl}
          onClose={() => setParams({ conn: undefined })}
        />
      ) : null}
    </div>
  )
}

/* ─────────── connections ─────────── */

function ConnectionList({ list, jobsByConn, filter, onFilter, connector, onClearConnector, onOpen }: {
  list: airbyte.Connection[]
  jobsByConn: Map<string, airbyte.Job[]>
  filter: ConnFilter
  onFilter(f: ConnFilter): void
  connector: { kind: 'source' | 'dest'; id: string; name: string } | null
  onClearConnector(): void
  onOpen(id: string): void
}) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: ConnSort; dir: 'asc' | 'desc' }>({ key: 'last', dir: 'desc' })
  const searchRef = useRef<HTMLInputElement>(null)
  useSlashFocus(searchRef)

  const rows = useMemo(() => {
    const f = search.trim().toLowerCase()
    const out = list.filter((c) => {
      if (filter === 'active' && c.status !== 'active') return false
      if (filter === 'paused' && c.status === 'active') return false
      if (filter === 'syncing' && !(c.last_sync_status === 'running' || c.last_sync_status === 'pending')) return false
      if (filter === 'failing' && !(c.last_sync_status === 'failed' || c.last_sync_status === 'incomplete')) return false
      if (connector?.kind === 'source' && c.source_id !== connector.id) return false
      if (connector?.kind === 'dest' && c.destination_id !== connector.id) return false
      if (f && !`${c.name} ${c.source_name} ${c.source_type} ${c.destination_name} ${c.destination_type}`.toLowerCase().includes(f)) return false
      return true
    })
    const sign = sort.dir === 'asc' ? 1 : -1
    out.sort((a, b) => {
      switch (sort.key) {
        case 'name':
          return sign * a.name.localeCompare(b.name)
        case 'volume':
          return sign * ((a.last_sync_bytes ?? 0) - (b.last_sync_bytes ?? 0))
        case 'next':
          return sign * (a.next_sync_at ?? '9999').localeCompare(b.next_sync_at ?? '9999')
        default:
          return sign * (a.last_sync_started_at ?? '').localeCompare(b.last_sync_started_at ?? '')
      }
    })
    return out
  }, [list, search, filter, connector, sort])

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField ref={searchRef} value={search} onChange={setSearch} placeholder="Search connections, sources, destinations…" slashHint />
          <div className="min-w-[20rem]">
            <Segmented<ConnFilter> value={filter} onChange={onFilter} options={[['all', 'All'], ['active', 'Active'], ['paused', 'Paused'], ['syncing', 'Syncing'], ['failing', 'Failing']]} />
          </div>
          <SortMenu sorts={SORTS} sort={sort.key} dir={sort.dir} onSort={(key, dir) => setSort({ key, dir })} />
        </div>
        {connector ? (
          <div className="mt-2 flex items-center gap-1.5 px-0.5 text-[11px] text-content-subtle">
            Using {connector.kind === 'source' ? 'source' : 'destination'}
            <span className="inline-flex items-center gap-1 rounded-full border border-edge-default bg-surface-app py-0.5 pl-2 pr-1 font-medium text-content">
              {connector.name}
              <button type="button" onClick={onClearConnector} aria-label="Remove filter" className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-surface-sunken">×</button>
            </span>
          </div>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <EmptyState title={list.length ? 'No matches' : 'No connections yet'} description={list.length ? 'Try a different filter.' : 'Create a source, a destination and a connection between them in Airbyte.'} />
      ) : (
        <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
          {rows.map((c) => <ConnectionRow key={c.connection_id} conn={c} jobs={jobsByConn.get(c.connection_id) ?? []} onOpen={() => onOpen(c.connection_id)} />)}
        </ul>
      )}
    </div>
  )
}

function ConnectionRow({ conn: c, jobs, onOpen }: { conn: airbyte.Connection; jobs: airbyte.Job[]; onOpen(): void }) {
  const actions = useConnectionActions(c)
  const running = c.last_sync_status === 'running' || c.last_sync_status === 'pending'
  const next = c.status === 'active' && c.next_sync_at ? Date.parse(c.next_sync_at) - Date.now() : null
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
      className="group flex cursor-pointer flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-sunken/50 lg:flex-nowrap"
    >
      <div className="min-w-0 flex-1 basis-72">
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', c.status !== 'active' ? 'bg-slate-400' : c.last_sync_status ? JOB_DOT[c.last_sync_status] : 'bg-slate-300')} />
          <span className="truncate text-sm font-semibold text-content group-hover:text-brand-700 dark:group-hover:text-brand-300">{c.name}</span>
          {c.status !== 'active' ? <StatusBadge kind="unknown">paused</StatusBadge> : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-content-muted">
          <Connector kind="source" type={c.source_type} name={c.source_name} />
          <span aria-hidden className="text-content-subtle">→</span>
          <Connector kind="dest" type={c.destination_type} name={c.destination_name} />
        </div>
      </div>

      <div className="w-36 shrink-0 text-[11px]">
        <div className="font-medium text-content">{describeSchedule(c)}</div>
        <div className="text-content-subtle">{c.streams_count} stream{c.streams_count === 1 ? '' : 's'}{c.sync_mode ? ` · ${c.sync_mode}` : ''}</div>
      </div>

      <div className="w-40 shrink-0 text-[11px]">
        {c.last_sync_status ? <StatusBadge kind={JOB_TONE[c.last_sync_status]}>{c.last_sync_status}</StatusBadge> : <span className="text-content-subtle">never synced</span>}
        <div className="mt-0.5 text-content-subtle">
          {running && c.last_sync_started_at ? `started ${formatRelative(c.last_sync_started_at)}` : c.last_sync_finished_at ? `${formatRelative(c.last_sync_finished_at)}${c.last_sync_duration_s ? ` · ${fmtDuration(c.last_sync_duration_s)}` : ''}` : ''}
        </div>
      </div>

      <div className="hidden w-28 shrink-0 text-right text-[11px] md:block">
        <div className="font-semibold tabular-nums text-content">{fmtBytes(c.last_sync_bytes ?? 0)}</div>
        <div className="tabular-nums text-content-subtle">{fmtNum(c.last_sync_records ?? 0)} rec</div>
      </div>

      <div className="hidden w-28 shrink-0 xl:block">
        <JobStrip jobs={jobs} />
        <div className="mt-0.5 text-[10px] text-content-subtle">{next != null ? (next > 0 ? `next in ${fmtCountdown(next)}` : 'due now') : c.schedule_type === 'manual' ? 'manual only' : ''}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Button size="xs" variant="secondary" disabled={c.status !== 'active' || running} loading={actions.syncing} onClick={actions.sync}>
          {running ? 'Syncing…' : 'Sync now'}
        </Button>
        <ConnectionMenu conn={c} actions={actions} />
      </div>
      {actions.modals}
    </li>
  )
}

/** Last ten jobs, oldest → newest, as status ticks. */
function JobStrip({ jobs }: { jobs: airbyte.Job[] }) {
  const last = jobs.slice(0, 10).reverse()
  if (!last.length) return <div className="h-3 text-[10px] text-content-subtle">no jobs yet</div>
  return (
    <div className="flex h-3 items-end gap-0.5" aria-label="Recent jobs">
      {last.map((j) => <i key={j.job_id} title={`${j.status} · ${formatRelative(j.created_at)}`} className={cn('h-3 w-1.5 rounded-sm', JOB_DOT[j.status])} />)}
    </div>
  )
}

function Connector({ kind, type, name }: { kind: 'source' | 'dest'; type: string; name: string }) {
  return (
    <span className="inline-flex max-w-56 items-center gap-1 rounded-md border border-edge-subtle bg-surface-app px-1.5 py-0.5" title={`${kind === 'source' ? 'Source' : 'Destination'}: ${name} (${type})`}>
      <i className={cn('h-1.5 w-1.5 shrink-0 rounded-full', kind === 'source' ? 'bg-brand-500' : 'bg-emerald-500')} />
      <span className="shrink-0 font-semibold text-content">{type || '—'}</span>
      <span className="truncate text-content-subtle">{name}</span>
    </span>
  )
}

/* ─────────── per-connection actions (row + drawer share them) ─────────── */

function useConnectionActions(c: airbyte.Connection) {
  const trigger = useTriggerSync()
  const toggle = useToggleConnection()
  const reset = useResetConnection()
  const del = useDeleteConnection()
  const rename = useRenameConnection()
  const act = useAct()
  const [modal, setModal] = useState<null | 'schedule' | 'reset' | 'delete' | 'rename'>(null)
  const [name, setName] = useState(c.name)

  const modals = modal ? (
    <div onClick={(e) => e.stopPropagation()}>
      <ScheduleModal conn={c} open={modal === 'schedule'} onClose={() => setModal(null)} />
      <Modal
        open={modal === 'reset'}
        onClose={() => setModal(null)}
        title={`Reset ${c.name}?`}
        description={`This clears the data this connection wrote to ${c.destination_name} and re-syncs every stream from scratch. The next sync can take much longer than usual.`}
        width="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setModal(null)}>Cancel</Button>
            <Button size="sm" variant="danger" loading={reset.isPending} onClick={async () => { if (await act(`Reset started for ${c.name}`, () => reset.mutateAsync(c.connection_id))) setModal(null) }}>Reset data</Button>
          </div>
        }
      >
        <p className="text-[12px] text-content-muted">{c.streams_count} stream{c.streams_count === 1 ? '' : 's'} will be re-read from {c.source_name}.</p>
      </Modal>
      <Modal
        open={modal === 'delete'}
        onClose={() => setModal(null)}
        title={`Delete ${c.name}?`}
        description="The connection and its schedule are removed from Airbyte. The source, the destination and the data already synced are kept."
        width="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setModal(null)}>Cancel</Button>
            <Button size="sm" variant="danger" loading={del.isPending} onClick={async () => { if (await act(`Deleted ${c.name}`, () => del.mutateAsync(c.connection_id))) setModal(null) }}>Delete connection</Button>
          </div>
        }
      >
        <span />
      </Modal>
      <Modal
        open={modal === 'rename'}
        onClose={() => setModal(null)}
        title="Rename connection"
        width="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setModal(null)}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={!name.trim() || name.trim() === c.name} loading={rename.isPending} onClick={async () => { if (await act('Connection renamed', () => rename.mutateAsync({ id: c.connection_id, name: name.trim() }))) setModal(null) }}>Save</Button>
          </div>
        }
      >
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </Modal>
    </div>
  ) : null

  return {
    syncing: trigger.isPending,
    sync: () => act(`Sync started for ${c.name}`, () => trigger.mutateAsync(c.connection_id)),
    toggle: () => act(c.status === 'active' ? `Paused ${c.name}` : `Resumed ${c.name}`, () => toggle.mutateAsync({ id: c.connection_id, active: c.status !== 'active' })),
    schedule: () => setModal('schedule'),
    reset: () => setModal('reset'),
    remove: () => setModal('delete'),
    rename: () => { setName(c.name); setModal('rename') },
    modals,
  }
}

type ConnActions = ReturnType<typeof useConnectionActions>

function ConnectionMenu({ conn: c, actions }: { conn: airbyte.Connection; actions: ConnActions }) {
  const toast = useToast()
  return (
    <MoreMenu label={`Actions for ${c.name}`}>
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); actions.toggle() }}>{c.status === 'active' ? 'Pause schedule' : 'Resume schedule'}</MenuItem>
          <MenuItem onClick={() => { close(); actions.schedule() }}>Edit schedule…</MenuItem>
          <MenuItem onClick={() => { close(); actions.rename() }}>Rename…</MenuItem>
          <MenuItem onClick={() => { close(); navigator.clipboard?.writeText(c.connection_id).then(() => toast.success('Copied connection ID')) }}>Copy connection ID</MenuItem>
          <div className="my-1 border-t border-edge-subtle" />
          <MenuItem onClick={() => { close(); actions.reset() }}>Reset data…</MenuItem>
          <MenuItem danger onClick={() => { close(); actions.remove() }}>Delete…</MenuItem>
        </>
      )}
    </MoreMenu>
  )
}

const CRON_PRESETS: Array<[string, string]> = [
  ['*/15 * * * *', 'Every 15 minutes'],
  ['0 * * * *', 'Hourly'],
  ['0 */6 * * *', 'Every 6 hours'],
  ['0 2 * * *', 'Daily at 02:00'],
  ['0 6 * * 1', 'Mondays at 06:00'],
]

function ScheduleModal({ conn: c, open, onClose }: { conn: airbyte.Connection; open: boolean; onClose(): void }) {
  const update = useUpdateSchedule()
  const act = useAct()
  const [type, setType] = useState<'manual' | 'basic' | 'cron'>(c.schedule_type ?? (c.schedule?.cron_expression ? 'cron' : c.schedule?.units ? 'basic' : 'manual'))
  const [units, setUnits] = useState(c.schedule?.units ?? 24)
  const [unit, setUnit] = useState<'minutes' | 'hours' | 'days' | 'weeks' | 'months'>(c.schedule?.time_unit ?? 'hours')
  const [cron, setCron] = useState(c.schedule?.cron_expression ?? '0 2 * * *')
  const cronOk = cron.trim().split(/\s+/).length >= 5
  const valid = type === 'manual' || (type === 'basic' ? units > 0 : cronOk)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sync schedule"
      description={`When ${c.name} runs on its own.`}
      width="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary"
            size="sm"
            disabled={!valid}
            loading={update.isPending}
            onClick={async () => {
              const schedule: airbyte.ScheduleInput = type === 'manual' ? { type } : type === 'basic' ? { type, units, time_unit: unit } : { type, cron_expression: cron.trim() }
              if (await act('Schedule updated', () => update.mutateAsync({ id: c.connection_id, schedule }))) onClose()
            }}
          >
            Save schedule
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Segmented<'manual' | 'basic' | 'cron'> value={type} onChange={setType} options={[['manual', 'Manual'], ['basic', 'Every…'], ['cron', 'Cron']]} />
        {type === 'manual' ? <p className="text-[12px] text-content-muted">Runs only when someone presses Sync now (or an API call triggers it).</p> : null}
        {type === 'basic' ? (
          <div className="flex items-end gap-2">
            <Field label="Every" className="w-24"><Input type="number" min={1} value={units} onChange={(e) => setUnits(Math.max(1, Number(e.target.value) || 1))} /></Field>
            <Field label="Unit" className="flex-1">
              <Select value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} options={['minutes', 'hours', 'days', 'weeks', 'months'].map((u) => ({ value: u, label: u }))} />
            </Field>
          </div>
        ) : null}
        {type === 'cron' ? (
          <>
            <Field label="Cron expression" hint="minute hour day-of-month month day-of-week (UTC)" error={cronOk ? undefined : 'Five fields expected.'}>
              <Input value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" />
            </Field>
            <div className="flex flex-wrap gap-1">
              {CRON_PRESETS.map(([expr, label]) => (
                <button key={expr} type="button" onClick={() => setCron(expr)} className={cn('rounded-full border px-2 py-0.5 text-[11px]', cron === expr ? 'border-content bg-content text-surface-raised' : 'border-edge-default text-content-muted hover:text-content')}>
                  {label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  )
}

/* ─────────── connection drawer ─────────── */

function ConnectionDrawer({ conn: c, loading, jobs, airbyteUrl, onClose }: {
  conn?: airbyte.Connection
  loading: boolean
  jobs: airbyte.Job[]
  airbyteUrl?: string
  onClose(): void
}) {
  const [tab, setTab] = useState<'overview' | 'jobs' | 'streams'>('overview')
  if (!c) {
    return (
      <Drawer onClose={onClose} widthId="develop.connection" header={<div className="flex justify-between"><span className="text-sm text-content-muted">Connection</span><CloseButton onClick={onClose} /></div>}>
        {loading ? <div className="flex items-center gap-2 text-sm text-content-muted"><Spinner size={12} /> Loading…</div> : <EmptyState compact title="Connection not found" description="It may have been deleted." />}
      </Drawer>
    )
  }
  return <ConnectionDrawerBody conn={c} jobs={jobs} airbyteUrl={airbyteUrl} onClose={onClose} tab={tab} setTab={setTab} />
}

function ConnectionDrawerBody({ conn: c, jobs, airbyteUrl, onClose, tab, setTab }: {
  conn: airbyte.Connection
  jobs: airbyte.Job[]
  airbyteUrl?: string
  onClose(): void
  tab: 'overview' | 'jobs' | 'streams'
  setTab(t: 'overview' | 'jobs' | 'streams'): void
}) {
  const actions = useConnectionActions(c)
  const history = useJobs({ connectionId: c.connection_id, limit: 50 })
  const list = history.data ?? jobs
  const running = c.last_sync_status === 'running' || c.last_sync_status === 'pending'
  const done = list.filter((j) => j.status === 'succeeded' || j.status === 'failed')
  const rate = done.length ? Math.round((done.filter((j) => j.status === 'succeeded').length / done.length) * 100) : null
  const avg = done.filter((j) => j.duration_s).reduce((s, j, _, a) => s + (j.duration_s ?? 0) / a.length, 0)

  return (
    <Drawer
      onClose={onClose}
      widthId="develop.connection"
      header={
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Connection</div>
            <h2 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-content">{c.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              <Connector kind="source" type={c.source_type} name={c.source_name} />
              <span className="text-content-subtle">→</span>
              <Connector kind="dest" type={c.destination_type} name={c.destination_name} />
              {c.status !== 'active' ? <StatusBadge kind="unknown">paused</StatusBadge> : <StatusBadge kind="healthy">active</StatusBadge>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant='primary' size="sm" disabled={c.status !== 'active' || running} loading={actions.syncing} onClick={actions.sync}>{running ? 'Syncing…' : 'Sync now'}</Button>
            <Button size="sm" variant="secondary" onClick={actions.toggle}>{c.status === 'active' ? 'Pause' : 'Resume'}</Button>
            <ConnectionMenu conn={c} actions={actions} />
            <CloseButton onClick={onClose} />
          </div>
        </div>
      }
    >
      {actions.modals}
      <Tabs
        ariaLabel="Connection"
        value={tab}
        onChange={(t) => setTab(t as typeof tab)}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'jobs', label: 'Jobs', badge: { kind: 'unknown', value: list.length } },
          { id: 'streams', label: 'Streams', badge: { kind: 'unknown', value: c.streams_count } },
        ]}
        actions={airbyteUrl ? <a href={airbyteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-brand-700 hover:underline dark:text-brand-300">Airbyte <IconExternal /></a> : undefined}
      >
        {(active) => (
          <div className="pt-3">
            {active === 'overview' ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <StatTile label="Last sync" value={c.last_sync_status ?? '—'} tone={c.last_sync_status === 'failed' ? 'amber' : c.last_sync_status === 'succeeded' ? 'emerald' : 'slate'} hint={c.last_sync_finished_at ? formatRelative(c.last_sync_finished_at) : c.last_sync_started_at ? `started ${formatRelative(c.last_sync_started_at)}` : undefined} />
                  <StatTile label="Success rate" value={rate == null ? '—' : `${rate}%`} tone={rate != null && rate < 90 ? 'amber' : 'emerald'} hint={`${done.length} finished jobs`} />
                  <StatTile label="Avg duration" value={avg ? fmtDuration(avg) : '—'} hint="finished jobs" />
                  <StatTile label="Last volume" value={fmtBytes(c.last_sync_bytes ?? 0)} tone="violet" hint={`${fmtNum(c.last_sync_records ?? 0)} records`} />
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-edge-default bg-surface-raised p-4 text-[12px] sm:grid-cols-2">
                  <Def k="Schedule" v={<span className="flex items-center gap-2">{describeSchedule(c)} <button type="button" onClick={actions.schedule} className="font-medium text-brand-700 hover:underline dark:text-brand-300">Edit</button></span>} />
                  <Def k="Next sync" v={c.status === 'active' && c.next_sync_at ? `${new Date(c.next_sync_at).toLocaleString()} (${fmtCountdown(Date.parse(c.next_sync_at) - Date.now())})` : c.status === 'active' ? '—' : 'paused'} />
                  <Def k="Sync mode" v={c.sync_mode ?? '—'} />
                  <Def k="Streams" v={c.streams_count} />
                  <Def k="Source" v={`${c.source_name} (${c.source_type})`} />
                  <Def k="Destination" v={`${c.destination_name} (${c.destination_type})`} />
                  {c.namespace_definition ? <Def k="Namespace" v={c.namespace_definition} /> : null}
                  {c.prefix ? <Def k="Table prefix" v={<code className="font-mono">{c.prefix}</code>} /> : null}
                  <Def k="ID" v={<code className="font-mono text-[11px]">{c.connection_id}</code>} />
                </dl>
                <div>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">Recent jobs</h3>
                  <JobTable jobs={list.slice(0, 5)} hideConnection />
                </div>
              </div>
            ) : active === 'jobs' ? (
              history.isLoading ? <div className="flex items-center gap-2 text-sm text-content-muted"><Spinner size={12} /> Loading jobs…</div> : <JobTable jobs={list} hideConnection />
            ) : (
              <StreamTable conn={c} />
            )}
          </div>
        )}
      </Tabs>
    </Drawer>
  )
}

function Def({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <dt className="w-24 shrink-0 text-content-subtle">{k}</dt>
      <dd className="min-w-0 truncate text-content">{v}</dd>
    </div>
  )
}

function StreamTable({ conn: c }: { conn: airbyte.Connection }) {
  const [q, setQ] = useState('')
  if (!c.streams?.length) {
    return <EmptyState compact title={`${c.streams_count} stream${c.streams_count === 1 ? '' : 's'}`} description="Airbyte did not return the stream catalog for this connection. Open it in Airbyte to change which streams sync." />
  }
  const rows = c.streams.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="space-y-2">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter streams…" className="block h-8 w-64 rounded-md border border-edge-default bg-surface-app px-2 text-[12px] text-content focus:border-brand-400 focus:outline-none" />
      <div className="overflow-x-auto rounded-lg border border-edge-default">
        <table className="w-full text-left text-[12px]">
          <thead className="bg-surface-sunken/60 text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
            <tr><th className="px-3 py-2">Stream</th><th className="px-3 py-2">Namespace</th><th className="px-3 py-2">Read</th><th className="px-3 py-2">Write</th><th className="px-3 py-2">Synced</th></tr>
          </thead>
          <tbody className="divide-y divide-edge-subtle bg-surface-raised">
            {rows.map((s) => (
              <tr key={`${s.namespace}.${s.name}`}>
                <td className="px-3 py-1.5 font-mono text-content">{s.name}</td>
                <td className="px-3 py-1.5 text-content-muted">{s.namespace ?? '—'}</td>
                <td className="px-3 py-1.5 text-content-muted">{(s.sync_mode ?? '—').replace(/_/g, ' ')}</td>
                <td className="px-3 py-1.5 text-content-muted">{(s.destination_sync_mode ?? '—').replace(/_/g, ' ')}</td>
                <td className="px-3 py-1.5">{s.selected === false ? <span className="text-content-subtle">off</span> : <span className="text-emerald-700 dark:text-emerald-300">on</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────── jobs ─────────── */

function JobHistory({ jobs, loading, connections, onOpenConn }: { jobs: airbyte.Job[]; loading: boolean; connections: airbyte.Connection[]; onOpenConn(id: string): void }) {
  const [status, setStatus] = useState<'all' | airbyte.JobStatus>('all')
  const [conn, setConn] = useState('all')
  const rows = jobs.filter((j) => (status === 'all' || j.status === status) && (conn === 'all' || j.connection_id === conn))
  if (loading) return <LoadingBlock label="Loading sync history…" />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm">
        <div className="min-w-88">
          <Segmented<'all' | airbyte.JobStatus> value={status} onChange={setStatus} options={[['all', 'All'], ['running', 'Running'], ['succeeded', 'Succeeded'], ['failed', 'Failed'], ['cancelled', 'Cancelled']]} />
        </div>
        <div className="w-64">
          <Select aria-label="Connection" value={conn} onChange={(e) => setConn(e.target.value)} options={[{ value: 'all', label: 'All connections' }, ...connections.map((c) => ({ value: c.connection_id, label: c.name }))]} />
        </div>
        <span className="ml-auto px-1 text-[11px] text-content-subtle">{rows.length} job{rows.length === 1 ? '' : 's'}</span>
      </div>
      {rows.length === 0 ? <EmptyState compact title="No jobs" description="Nothing matches these filters." /> : <JobTable jobs={rows} onOpenConn={onOpenConn} />}
    </div>
  )
}

function JobTable({ jobs, hideConnection, onOpenConn }: { jobs: airbyte.Job[]; hideConnection?: boolean; onOpenConn?(id: string): void }) {
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const cancel = useCancelJob()
  const act = useAct()
  if (!jobs.length) return <EmptyState compact title="No jobs yet" />
  return (
    <ul className="divide-y divide-edge-subtle overflow-hidden rounded-lg border border-edge-default bg-surface-raised">
      {jobs.map((j) => {
        const live = j.status === 'running' || j.status === 'pending'
        return (
          <li key={j.job_id}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[12px]">
              <StatusBadge kind={JOB_TONE[j.status]}>{j.status}</StatusBadge>
              <div className="min-w-0 flex-1">
                {hideConnection ? null : (
                  <button type="button" onClick={() => onOpenConn?.(j.connection_id)} className="block max-w-full truncate font-medium text-content hover:text-brand-700 hover:underline dark:hover:text-brand-300">{j.connection_name}</button>
                )}
                <div className="text-[11px] text-content-subtle">
                  {j.job_type === 'reset_connection' ? 'reset · ' : ''}#{j.job_id} · {formatRelative(j.created_at)}{j.attempts && j.attempts > 1 ? ` · ${j.attempts} attempts` : ''}
                </div>
              </div>
              <span className="w-16 text-right tabular-nums text-content-muted">{j.duration_s != null ? fmtDuration(j.duration_s) : live ? '…' : '—'}</span>
              <span className="w-20 text-right tabular-nums text-content-muted">{fmtNum(j.records_emitted ?? 0)} rec</span>
              <span className="w-20 text-right tabular-nums text-content-muted">{fmtBytes(j.bytes_emitted ?? 0)}</span>
              <div className="flex gap-1">
                <Button size="xs" variant="ghost" onClick={() => setLogsFor(logsFor === j.job_id ? null : j.job_id)}>{logsFor === j.job_id ? 'Hide logs' : 'Logs'}</Button>
                {live ? <Button size="xs" variant="ghost" className="text-rose-700 dark:text-rose-300" loading={cancel.isPending && cancel.variables === j.job_id} onClick={() => act(`Cancelled job #${j.job_id}`, () => cancel.mutateAsync(j.job_id))}>Cancel</Button> : null}
              </div>
            </div>
            {j.failure_message ? <div className="mx-3 mb-2 rounded-md bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">{j.failure_message}</div> : null}
            {logsFor === j.job_id ? <JobLogs jobId={j.job_id} /> : null}
          </li>
        )
      })}
    </ul>
  )
}

function JobLogs({ jobId }: { jobId: string }) {
  const q = useJobLogs(jobId)
  return (
    <div className="mx-3 mb-2 max-h-72 overflow-auto rounded-md border border-edge-default bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed text-content">
      {q.isLoading ? 'Loading logs…' : q.isError ? `Couldn't load logs: ${q.error instanceof Error ? q.error.message : ''}` : q.data?.length ? q.data.map((l, i) => (
        <div key={i} className={cn('whitespace-pre-wrap', /\bERROR\b/.test(l) ? 'text-rose-700 dark:text-rose-300' : /\bWARN/.test(l) ? 'text-amber-700 dark:text-amber-300' : '')}>{l}</div>
      )) : 'No log lines for this job.'}
    </div>
  )
}

/* ─────────── connectors ─────────── */

function ConnectorGrid({ kind, items, loading, connections, onShow }: {
  kind: 'source' | 'dest'
  items: Array<{ id: string; name: string; type: string; icon?: string; status?: 'succeeded' | 'failed' }>
  loading: boolean
  connections: airbyte.Connection[]
  onShow(id: string, name: string): void
}) {
  const checkSrc = useCheckSource()
  const checkDst = useCheckDestination()
  const toast = useToast()
  const [checking, setChecking] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, airbyte.CheckResult>>({})
  if (loading) return <LoadingBlock label="Loading connectors…" />
  if (!items.length) return <EmptyState title={kind === 'source' ? 'No sources' : 'No destinations'} description="Add one in Airbyte." />

  const test = async (id: string, name: string) => {
    setChecking(id)
    try {
      const r = kind === 'source' ? await checkSrc.mutateAsync(id) : await checkDst.mutateAsync(id)
      setResults((m) => ({ ...m, [id]: r }))
      if (r.status === 'succeeded') toast.success(`${name} is reachable`)
      else toast.error(`${name} failed its check`, { description: r.message })
    } catch (e) {
      toast.error(`Couldn't test ${name}`, { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setChecking(null)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map((it) => {
        const used = connections.filter((c) => (kind === 'source' ? c.source_id : c.destination_id) === it.id)
        const failing = used.filter((c) => c.last_sync_status === 'failed').length
        const status = results[it.id]?.status ?? it.status
        return (
          <div key={it.id} className="flex flex-col rounded-xl border border-edge-default bg-surface-raised p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white', kind === 'source' ? 'bg-brand-500' : 'bg-emerald-500')}>
                {it.icon && it.icon.length <= 2 ? it.icon : it.type.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-content">{it.name}</div>
                <div className="text-[11px] text-content-muted">{it.type}</div>
              </div>
              {status ? <StatusBadge kind={status === 'succeeded' ? 'healthy' : 'failed'}>{status === 'succeeded' ? 'reachable' : 'failing'}</StatusBadge> : null}
            </div>
            {results[it.id]?.message ? <p className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-[11px] text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">{results[it.id].message}</p> : null}
            <div className="mt-3 text-[12px] text-content-muted">
              {used.length ? (
                <button type="button" onClick={() => onShow(it.id, it.name)} className="font-medium text-brand-700 hover:underline dark:text-brand-300">
                  Used by {used.length} connection{used.length === 1 ? '' : 's'}{failing ? ` · ${failing} failing` : ''}
                </button>
              ) : 'Not used by any connection'}
            </div>
            <div className="mt-auto flex justify-end pt-3">
              <Button size="xs" variant="secondary" loading={checking === it.id} onClick={() => test(it.id, it.name)}>Test connection</Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ─────────── formatting ─────────── */

function describeSchedule(c: airbyte.Connection): string {
  if (c.schedule_type === 'manual' || (!c.schedule_type && !c.schedule)) return 'Manual'
  if (c.schedule_type === 'cron' || c.schedule?.cron_expression) {
    const preset = CRON_PRESETS.find(([e]) => e === c.schedule?.cron_expression)
    return preset ? preset[1] : `cron ${c.schedule?.cron_expression ?? ''}`
  }
  const { units, time_unit } = c.schedule ?? {}
  if (!units || !time_unit) return 'Scheduled'
  return units === 1 ? `Every ${time_unit.replace(/s$/, '')}` : `Every ${units} ${time_unit}`
}

function fmtNum(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}
function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}
function fmtDuration(s: number): string {
  s = Math.round(s)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d`
}
