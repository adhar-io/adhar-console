import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { airbyte } from '@adhar-console/api-clients'
import {
  useConnections,
  useDestinations,
  useJobs,
  useSources,
  useToggleConnection,
  useTriggerSync,
} from '../data/airbyte.ts'

const JOB_TONE: Record<airbyte.JobStatus, StatusKind> = {
  pending: 'info',
  running: 'progressing',
  incomplete: 'progressing',
  failed: 'failed',
  succeeded: 'healthy',
  cancelled: 'unknown',
}

/**
 * Data pipelines (Airbyte) — three tabs:
 *
 *   1. Connections — source × destination pairs with sync schedule, last
 *      sync stats, trigger / toggle actions, and a detail drawer with
 *      job history.
 *   2. Sources — registered Airbyte sources.
 *   3. Destinations — registered destinations (warehouses, lakes).
 */
export function Pipelines() {
  const [tab, setTab] = useState<'connections' | 'sources' | 'destinations'>('connections')

  const conns = useConnections()
  const sources = useSources()
  const dests = useDestinations()

  if (conns.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading pipelines…
      </div>
    )
  }

  const list = conns.data ?? []
  const totals = sumLastSync(list)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Connections" value={list.length} hint={`${list.filter((c) => c.status === 'active').length} active`} />
        <Tile label="Records · 24h" value={fmtNum(totals.records)} accent="brand" />
        <Tile label="Bytes · 24h" value={fmtBytes(totals.bytes)} accent="emerald" />
        <Tile
          label="Failed syncs"
          value={list.filter((c) => c.last_sync_status === 'failed').length}
          accent={list.some((c) => c.last_sync_status === 'failed') ? 'rose' : 'slate'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-edge-default bg-white p-1 shadow-sm">
        <Tab on={tab === 'connections'} onClick={() => setTab('connections')}>
          Connections <Count>{list.length}</Count>
        </Tab>
        <Tab on={tab === 'sources'} onClick={() => setTab('sources')}>
          Sources <Count>{sources.data?.length ?? 0}</Count>
        </Tab>
        <Tab on={tab === 'destinations'} onClick={() => setTab('destinations')}>
          Destinations <Count>{dests.data?.length ?? 0}</Count>
        </Tab>
      </div>

      {tab === 'connections' ? (
        <Connections list={list} />
      ) : tab === 'sources' ? (
        <SourceList list={sources.data ?? []} />
      ) : (
        <DestinationList list={dests.data ?? []} />
      )}
    </div>
  )
}

function Tab({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        on
          ? 'rounded-md bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700'
          : 'rounded-md px-2.5 py-1 text-[12px] text-content-muted hover:bg-surface-sunken'
      }
    >
      {children}
    </button>
  )
}
function Count({ children }: { children: React.ReactNode }) {
  return <span className="ml-1 font-mono text-[10px] tabular-nums opacity-60">{children}</span>
}

/* ─────────── connections ─────────── */

function Connections({ list }: { list: airbyte.Connection[] }) {
  const trigger = useTriggerSync()
  const toggle = useToggleConnection()
  const [openId, setOpenId] = useState<string | null>(null)
  const open = list.find((c) => c.connection_id === openId) ?? null

  if (list.length === 0) return <EmptyState title="No connections" />
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {list.map((c) => (
          <ConnectionCard
            key={c.connection_id}
            conn={c}
            onOpen={() => setOpenId(c.connection_id)}
            onTrigger={() => trigger.mutate(c.connection_id)}
            onToggle={() => toggle.mutate({ id: c.connection_id, active: c.status !== 'active' })}
            triggering={trigger.isPending && trigger.variables === c.connection_id}
          />
        ))}
      </div>
      {open ? <ConnectionDetail conn={open} onClose={() => setOpenId(null)} /> : null}
    </div>
  )
}

function ConnectionCard({
  conn: c,
  onOpen,
  onTrigger,
  onToggle,
  triggering,
}: {
  conn: airbyte.Connection
  onOpen(): void
  onTrigger(): void
  onToggle(): void
  triggering: boolean
}) {
  const last = c.last_sync_status
  const tone: StatusKind = last ? JOB_TONE[last] : 'unknown'
  const next = c.next_sync_at ? new Date(c.next_sync_at).getTime() - Date.now() : null

  return (
    <Card>
      <button type="button" onClick={onOpen} className="block w-full p-4 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-content">{c.name}</span>
              <StatusBadge kind={c.status === 'active' ? 'healthy' : 'unknown'}>
                {c.status}
              </StatusBadge>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-content-subtle">
              <ConnectorChip type="source" label={c.source_type} />
              <span aria-hidden>→</span>
              <ConnectorChip type="dest" label={c.destination_type} />
            </div>
          </div>
          {last ? <StatusBadge kind={tone}>{last}</StatusBadge> : null}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <Mini label="Streams" value={c.streams_count} />
          <Mini label="Records" value={fmtNum(c.last_sync_records ?? 0)} />
          <Mini label="Bytes" value={fmtBytes(c.last_sync_bytes ?? 0)} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-content-muted">
          <span>{describeSchedule(c)}</span>
          <span>· {c.sync_mode ?? '—'}</span>
          {c.last_sync_finished_at ? (
            <span>· last {formatRelative(c.last_sync_finished_at)}</span>
          ) : c.last_sync_started_at ? (
            <span>· started {formatRelative(c.last_sync_started_at)}</span>
          ) : null}
          {next != null ? (
            <span className="ml-auto font-mono">next in {fmtCountdown(next)}</span>
          ) : null}
        </div>
      </button>

      <div className="border-t border-edge-subtle bg-white/80 px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onTrigger()
            }}
            loading={triggering}
            disabled={c.status !== 'active' || c.last_sync_status === 'running'}
          >
            Sync now
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            {c.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
          <span className="ml-auto font-mono text-[10px] text-content-subtle">
            {c.connection_id}
          </span>
        </div>
      </div>
    </Card>
  )
}

function ConnectorChip({ type, label }: { type: 'source' | 'dest'; label: string }) {
  const cls = type === 'source' ? 'bg-brand-50 text-brand-700' : 'bg-emerald-50 text-emerald-700'
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {label}
    </span>
  )
}

function Mini({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-edge-subtle bg-surface-sunken/40 p-2">
      <div className="text-base font-semibold tabular-nums text-content">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

/* ─────────── connection detail drawer ─────────── */

function ConnectionDetail({ conn, onClose }: { conn: airbyte.Connection; onClose(): void }) {
  const jobs = useJobs({ connectionId: conn.connection_id, limit: 20 })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (typeof document === 'undefined') return null

  const list = jobs.data ?? []
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Pipeline
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold tracking-tight text-content">
              {conn.name}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-content-muted">
              <ConnectorChip type="source" label={conn.source_type} />
              <span aria-hidden>→</span>
              <ConnectorChip type="dest" label={conn.destination_type} />
              <span>· {describeSchedule(conn)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
          >
            <IconClose />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <Card>
            <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <DetailTile label="Status" value={conn.status} />
              <DetailTile label="Streams" value={conn.streams_count} />
              <DetailTile label="Mode" value={conn.sync_mode ?? '—'} />
              <DetailTile label="Last sync" value={conn.last_sync_finished_at ? formatRelative(conn.last_sync_finished_at) : '—'} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-700">
                Job history
              </div>
            </CardHeader>
            <CardBody className="p-0!">
              {jobs.isLoading ? (
                <div className="flex h-32 items-center justify-center"><Spinner size={12} /></div>
              ) : list.length === 0 ? (
                <EmptyState compact title="No jobs yet" />
              ) : (
                <ul className="divide-y divide-edge-subtle">
                  {list.map((j) => (
                    <JobRow key={j.job_id} job={j} />
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function JobRow({ job: j }: { job: airbyte.Job }) {
  return (
    <li className="px-5 py-3 transition-colors hover:bg-brand-50/40">
      <div className="flex items-center gap-2">
        <StatusBadge kind={JOB_TONE[j.status]}>{j.status}</StatusBadge>
        <code className="font-mono text-[10px] text-content-muted">{j.job_id}</code>
        <span className="ml-auto text-[11px] text-content-muted">
          {formatRelative(j.created_at)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-content-muted">
        {j.duration_s ? <span>{fmtDuration(j.duration_s)}</span> : <span>running…</span>}
        {j.records_emitted ? <span>· {fmtNum(j.records_emitted)} records</span> : null}
        {j.bytes_emitted ? <span>· {fmtBytes(j.bytes_emitted)}</span> : null}
      </div>
      {j.failure_message ? (
        <div className="mt-1 rounded-md border border-rose-200 bg-rose-50/60 px-2 py-1.5 text-[11px] text-rose-800">
          {j.failure_message}
        </div>
      ) : null}
    </li>
  )
}

/* ─────────── sources / destinations ─────────── */

function SourceList({ list }: { list: airbyte.Source[] }) {
  if (list.length === 0) return <EmptyState title="No sources" />
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {list.map((s) => (
        <Card key={s.source_id}>
          <CardBody className="space-y-2 p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-lg ring-1 ring-inset ring-brand-200">
                {s.icon ?? '🔌'}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-content">{s.name}</div>
                <div className="text-[11px] text-content-subtle">{s.source_type}</div>
              </div>
              <StatusBadge kind={s.connection_status === 'succeeded' ? 'healthy' : 'failed'}>
                {s.connection_status ?? 'unknown'}
              </StatusBadge>
            </div>
            <div className="text-[11px] text-content-muted">
              {s.connections ?? 0} connection{s.connections === 1 ? '' : 's'}
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  )
}

function DestinationList({ list }: { list: airbyte.Destination[] }) {
  if (list.length === 0) return <EmptyState title="No destinations" />
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {list.map((d) => (
        <Card key={d.destination_id}>
          <CardBody className="space-y-2 p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-lg ring-1 ring-inset ring-emerald-200">
                {d.icon ?? '🪣'}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-content">{d.name}</div>
                <div className="text-[11px] text-content-subtle">{d.destination_type}</div>
              </div>
              <StatusBadge kind={d.connection_status === 'succeeded' ? 'healthy' : 'failed'}>
                {d.connection_status ?? 'unknown'}
              </StatusBadge>
            </div>
            <div className="text-[11px] text-content-muted">
              {d.connections ?? 0} connection{d.connections === 1 ? '' : 's'}
            </div>
          </CardBody>
        </Card>
      ))}
    </div>
  )
}

/* ─────────── helpers ─────────── */

function Tile({
  label,
  value,
  hint,
  accent = 'slate',
}: {
  label: string
  value: number | string
  hint?: string
  accent?: 'slate' | 'brand' | 'emerald' | 'rose'
}) {
  const cls = {
    slate: 'from-slate-50 to-white text-content',
    brand: 'from-brand-50 to-white text-brand-700',
    emerald: 'from-emerald-50 to-white text-emerald-700',
    rose: 'from-rose-50 to-white text-rose-700',
  }[accent]
  return (
    <Card className={`bg-linear-to-br ${cls} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="space-y-1 p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
          {label}
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
          {value}
        </div>
        {hint ? <div className="text-[11px] text-content-muted">{hint}</div> : null}
      </CardBody>
    </Card>
  )
}

function DetailTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
      <div className="text-base font-semibold text-content">{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function describeSchedule(c: airbyte.Connection): string {
  if (c.schedule_type === 'cron') return `cron · ${c.schedule?.cron_expression ?? '—'}`
  if (c.schedule_type === 'manual') return 'manual'
  if (c.schedule?.units && c.schedule?.time_unit) {
    return `every ${c.schedule.units} ${c.schedule.time_unit}`
  }
  return c.schedule_type ?? 'manual'
}

function sumLastSync(list: airbyte.Connection[]) {
  return list.reduce(
    (acc, c) => ({
      records: acc.records + (c.last_sync_records ?? 0),
      bytes: acc.bytes + (c.last_sync_bytes ?? 0),
    }),
    { records: 0, bytes: 0 },
  )
}

function fmtNum(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`
}
function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
function fmtCountdown(ms: number): string {
  const abs = Math.abs(Math.round(ms / 1000))
  const prefix = ms < 0 ? '-' : ''
  if (abs < 60) return `${prefix}${abs}s`
  if (abs < 3600) return `${prefix}${Math.floor(abs / 60)}m`
  return `${prefix}${Math.floor(abs / 3600)}h`
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
