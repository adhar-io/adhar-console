import { useState } from 'react'
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { cn } from '@adhar-console/utils'
import type { plane } from '@adhar-console/api-clients'
import { useCycles } from '../data/plane.ts'
import { CycleDetail } from '../components/cycle-detail.tsx'
import { CreateCycleModal } from '../components/create-forms.tsx'
import { ListToolbar } from '../components/list-toolbar.tsx'

/**
 * Cycles (sprint-like). Active cycle promoted into a hero card with
 * progress + breakdown bar + days-remaining countdown; everything else
 * grouped by `upcoming / completed / draft`.
 */

const STATUS_KIND: Record<plane.Cycle['status'], StatusKind> = {
  current: 'progressing',
  upcoming: 'info',
  completed: 'healthy',
  draft: 'unknown',
}

export function Cycles({ projectId }: { projectId?: string }) {
  const q = useCycles(projectId)
  const [open, setOpen] = useState<plane.Cycle | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  if (!projectId) return <EmptyState title="Pick a project" />
  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading cycles…
      </div>
    )
  }
  if (q.isError) {
    return (
      <EmptyState
        title="Couldn't reach Plane"
        description={q.error instanceof Error ? q.error.message : 'Unknown error.'}
      />
    )
  }
  const all = q.data ?? []
  const f = search.trim().toLowerCase()
  const cycles = f
    ? all.filter(
        (c) =>
          c.name.toLowerCase().includes(f) || (c.description ?? '').toLowerCase().includes(f),
      )
    : all
  const current = cycles.find((c) => c.status === 'current')
  const upcoming = cycles.filter((c) => c.status === 'upcoming')
  const completed = cycles.filter((c) => c.status === 'completed')
  const draft = cycles.filter((c) => c.status === 'draft')
  return (
    <div className="space-y-6">
      <ListToolbar
        count={all.length}
        noun="cycle"
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search cycles…"
        onNew={() => setCreateOpen(true)}
        newLabel="New cycle"
        disabled={createOpen || open !== null}
      />
      {all.length === 0 ? (
        <EmptyState
          title="No cycles yet"
          description="Cycles are sprint-shaped time-boxes — click New cycle to plan one."
        />
      ) : cycles.length === 0 ? (
        <EmptyState
          title="No matches"
          description={`No cycles match "${search}". Try a different keyword.`}
        />
      ) : (
        <>
          {current ? <ActiveCycleHero cycle={current} onOpen={() => setOpen(current)} /> : null}
          {upcoming.length ? (
            <CycleSection title="Upcoming" cycles={upcoming} onOpen={setOpen} />
          ) : null}
          {completed.length ? (
            <CycleSection title="Completed" cycles={completed} onOpen={setOpen} />
          ) : null}
          {draft.length ? <CycleSection title="Draft" cycles={draft} onOpen={setOpen} /> : null}
        </>
      )}
      {open ? (
        <CycleDetail projectId={projectId} cycle={open} onClose={() => setOpen(null)} />
      ) : null}
      <CreateCycleModal
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(c) => setOpen(c)}
      />
    </div>
  )
}

function ActiveCycleHero({
  cycle,
  onOpen,
}: {
  cycle: plane.Cycle
  onOpen(): void
}) {
  const days = daysRemaining(cycle.end_date)
  return (
    <Card interactive className="relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${cycle.name}`}
        className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25"
      />
      <CardBody className="relative z-0 space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <StatusBadge kind={STATUS_KIND[cycle.status]}>active sprint</StatusBadge>
              <span className="text-xs text-content-subtle">
                {fmtRange(cycle.start_date, cycle.end_date)}
              </span>
            </div>
            <h3 className="mt-2 text-xl font-semibold tracking-tight text-content">
              {cycle.name}
            </h3>
            {cycle.description ? (
              <p className="mt-1 max-w-2xl text-sm text-content-muted">{cycle.description}</p>
            ) : null}
          </div>
          <div className="text-right">
            <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
              {cycle.progress ?? 0}
              <span className="text-base font-normal text-content-muted">%</span>
            </div>
            <div className="text-[11px] uppercase tracking-wider text-content-subtle">
              progress
            </div>
            {days != null ? (
              <div
                className={cn(
                  'mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                  days <= 1
                    ? 'bg-rose-50 text-rose-700'
                    : days <= 4
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-brand-50 text-brand-700',
                )}
              >
                {days <= 0 ? 'ends today' : `${days}d remaining`}
              </div>
            ) : null}
          </div>
        </div>

        <CycleBreakdownBar cycle={cycle} />
        <CycleStatsRow cycle={cycle} />
      </CardBody>
    </Card>
  )
}

function CycleSection({
  title,
  cycles,
  onOpen,
}: {
  title: string
  cycles: plane.Cycle[]
  onOpen(c: plane.Cycle): void
}) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.06em] text-content-subtle">
        {title} · {cycles.length}
      </h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cycles.map((c) => (
          <Card key={c.id} interactive className="relative">
            <button
              type="button"
              onClick={() => onOpen(c)}
              aria-label={`Open ${c.name}`}
              className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25"
            />
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-content">{c.name}</div>
                  <div className="text-[11px] text-content-subtle">
                    {fmtRange(c.start_date, c.end_date)}
                  </div>
                </div>
                <StatusBadge kind={STATUS_KIND[c.status]}>{c.status}</StatusBadge>
              </div>
            </CardHeader>
            <CardBody className="space-y-3">
              <CycleBreakdownBar cycle={c} compact />
              <CycleStatsRow cycle={c} compact />
            </CardBody>
          </Card>
        ))}
      </div>
    </section>
  )
}

function CycleBreakdownBar({ cycle, compact = false }: { cycle: plane.Cycle; compact?: boolean }) {
  const total = cycle.total_issues ?? 0
  const segments = [
    {
      value: cycle.completed_issues ?? 0,
      color: 'var(--color-brand-500)',
      label: 'Done',
    },
    {
      value: cycle.started_issues ?? 0,
      color: 'var(--color-accent-500)',
      label: 'Started',
    },
    {
      value: cycle.unstarted_issues ?? 0,
      color: '#f59e0b',
      label: 'Unstarted',
    },
    {
      value: cycle.backlog_issues ?? 0,
      color: 'var(--color-edge-strong)',
      label: 'Backlog',
    },
    {
      value: cycle.cancelled_issues ?? 0,
      color: '#f43f5e',
      label: 'Cancelled',
    },
  ].filter((s) => s.value > 0)

  if (total === 0) {
    return (
      <div className={cn('flex items-center justify-center rounded-full bg-surface-sunken text-[11px] text-content-subtle', compact ? 'h-3' : 'h-5')}>
        No issues yet
      </div>
    )
  }
  return (
    <div>
      <div
        className={cn(
          'flex w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle',
          compact ? 'h-3' : 'h-5',
        )}
      >
        {segments.map((s, i) => (
          <div
            key={i}
            className="h-full transition-[width] duration-500 ease-smooth"
            style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
      </div>
      {!compact ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-content-muted">
          {segments.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}: <span className="text-content">{s.value}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function CycleStatsRow({ cycle, compact = false }: { cycle: plane.Cycle; compact?: boolean }) {
  return (
    <div className={cn('grid grid-cols-3 gap-2 text-center', compact ? 'text-xs' : '')}>
      <Stat label="Total" value={cycle.total_issues ?? 0} />
      <Stat label="Done" value={cycle.completed_issues ?? 0} accent="emerald" />
      <Stat
        label="Days left"
        value={daysRemaining(cycle.end_date) ?? '—'}
        accent="amber"
      />
    </div>
  )
}

function Stat({
  label,
  value,
  accent = 'slate',
}: {
  label: string
  value: number | string
  accent?: 'slate' | 'emerald' | 'amber'
}) {
  const tone =
    accent === 'emerald'
      ? 'text-emerald-700'
      : accent === 'amber'
        ? 'text-amber-700'
        : 'text-content'
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-2">
      <div className={cn('text-base font-semibold tabular-nums', tone)}>{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function daysRemaining(end?: string | null): number | undefined {
  if (!end) return undefined
  const ms = new Date(end).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

function fmtRange(start?: string | null, end?: string | null): string {
  if (!start || !end) return '—'
  const opt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  return `${new Date(start).toLocaleDateString(undefined, opt)} → ${new Date(end).toLocaleDateString(undefined, opt)}`
}
