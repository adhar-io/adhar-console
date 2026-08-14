import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AreaChart,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { plane } from '@adhar-console/api-clients'
import {
  memberDisplayName,
  memberInitials,
  priorityKind,
  useDeleteCycle,
  useIssues,
  useLabels,
  useMembers,
  useStates,
} from '../data/plane.ts'
import { IssueDrawer } from './issue-drawer.tsx'

/**
 * Sliding cycle detail with burndown chart + issue table grouped by state.
 *
 * Burndown is computed client-side from `created_at` (added to scope) +
 * `completed_at` (removed from remaining) over the cycle's date range.
 */
export function CycleDetail({
  projectId,
  cycle,
  onClose,
}: {
  projectId: string
  cycle: plane.Cycle
  onClose(): void
}) {
  const issues = useIssues(projectId, { cycle: cycle.id })
  const states = useStates(projectId)
  const labels = useLabels(projectId)
  const members = useMembers()
  const remove = useDeleteCycle(projectId)
  const [openIssue, setOpenIssue] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stateMap = useMemo(
    () => new Map((states.data ?? []).map((s) => [s.id, s])),
    [states.data],
  )
  const labelMap = useMemo(
    () => new Map((labels.data ?? []).map((l) => [l.id, l])),
    [labels.data],
  )
  const memberMap = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.member?.id ?? m.id, m])),
    [members.data],
  )

  const burndown = useMemo(
    () => buildBurndown(cycle, issues.data ?? []),
    [cycle, issues.data],
  )

  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-slate-900/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-5xl flex-col overflow-hidden border-l border-edge-default bg-surface-app shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-surface-raised px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Cycle
              <StatusBadge
                kind={
                  cycle.status === 'current'
                    ? 'progressing'
                    : cycle.status === 'completed'
                      ? 'healthy'
                      : cycle.status === 'upcoming'
                        ? 'info'
                        : 'unknown'
                }
              >
                {cycle.status}
              </StatusBadge>
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-content">
              {cycle.name}
            </h2>
            <div className="mt-1 text-[11px] text-content-muted">
              {fmtRange(cycle.start_date, cycle.end_date)}
              {cycle.description ? <span className="ml-2">· {cycle.description}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (!confirm(`Delete "${cycle.name}"? This can't be undone.`)) return
                remove.mutate(cycle.id, { onSuccess: onClose })
              }}
            >
              Delete
            </Button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-md text-content-subtle hover:bg-surface-sunken hover:text-content"
            >
              <IconClose />
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-content">Burndown</div>
                <div className="text-[11px] text-content-subtle">
                  ideal vs remaining · client-derived
                </div>
              </div>
            </CardHeader>
            <CardBody className="space-y-3">
              <BurndownChart data={burndown} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Total" value={cycle.total_issues ?? 0} />
                <Stat label="Done" value={cycle.completed_issues ?? 0} />
                <Stat label="Started" value={cycle.started_issues ?? 0} />
                <Stat
                  label="Days left"
                  value={daysRemaining(cycle.end_date) ?? '—'}
                />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-content">
                  Issues in this cycle ({issues.data?.length ?? 0})
                </div>
                {issues.isFetching ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-content-subtle">
                    <Spinner size={10} /> updating
                  </span>
                ) : null}
              </div>
            </CardHeader>
            <CardBody className="p-0">
              <DataTable
                loading={issues.isLoading}
                onRowClick={(i) => setOpenIssue(i.id)}
                columns={[
                  {
                    key: 'id',
                    header: 'ID',
                    width: 70,
                    cell: (i) => (
                      <code className="font-mono text-[11px] text-content-muted">
                        #{i.sequence_id ?? '—'}
                      </code>
                    ),
                  },
                  {
                    key: 'name',
                    header: 'Issue',
                    cell: (i) => {
                      const ls = i.labels
                        .map((id) => labelMap.get(id))
                        .filter(Boolean) as plane.Label[]
                      return (
                        <div>
                          <div className="truncate font-medium text-content">{i.name}</div>
                          {ls.length ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {ls.slice(0, 4).map((l) => (
                                <span
                                  key={l.id}
                                  className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted"
                                >
                                  <span
                                    className="h-1.5 w-1.5 rounded-full"
                                    style={{ backgroundColor: l.color }}
                                  />
                                  {l.name}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      )
                    },
                  },
                  {
                    key: 'state',
                    header: 'State',
                    cell: (i) => {
                      const st = stateMap.get(i.state)
                      if (!st) return <span className="text-content-subtle">—</span>
                      return (
                        <span className="inline-flex items-center gap-1.5 text-xs text-content">
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: st.color }}
                          />
                          {st.name}
                        </span>
                      )
                    },
                  },
                  {
                    key: 'priority',
                    header: 'Priority',
                    cell: (i) => (
                      <StatusBadge kind={priorityKind(i.priority)} dot={false}>
                        {i.priority}
                      </StatusBadge>
                    ),
                  },
                  {
                    key: 'assignees',
                    header: 'Assignees',
                    cell: (i) => {
                      const ms = i.assignees
                        .map((id) => memberMap.get(id))
                        .filter(Boolean) as plane.Member[]
                      return ms.length ? (
                        <div className="flex items-center -space-x-1.5">
                          {ms.slice(0, 3).map((m) => (
                            <span
                              key={m.id}
                              title={memberDisplayName(m)}
                              className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-2 ring-surface-raised"
                            >
                              {memberInitials(m)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-content-subtle">—</span>
                      )
                    },
                  },
                  {
                    key: 'updated',
                    header: 'Updated',
                    cell: (i) => (
                      <span className="text-[11px] text-content-muted">
                        {formatRelative(i.updated_at ?? i.created_at)}
                      </span>
                    ),
                  },
                ]}
                rows={issues.data ?? []}
                rowKey={(i) => i.id}
                empty={<EmptyState compact title="No issues in this cycle yet" />}
              />
            </CardBody>
          </Card>
        </div>

        {openIssue ? (
          <IssueDrawer
            projectId={projectId}
            issueId={openIssue}
            onClose={() => setOpenIssue(null)}
            onPick={setOpenIssue}
          />
        ) : null}
      </aside>
    </div>,
    document.body,
  )
}

/* ───── burndown ───── */

function buildBurndown(
  cycle: plane.Cycle,
  issues: plane.Issue[],
): { ideal: number[]; remaining: number[]; days: number } {
  if (!cycle.start_date || !cycle.end_date) {
    return { ideal: [], remaining: [], days: 0 }
  }
  const start = new Date(cycle.start_date).getTime()
  const end = new Date(cycle.end_date).getTime()
  const dayMs = 86_400_000
  const days = Math.max(2, Math.ceil((end - start) / dayMs))
  const total = issues.length || 1
  const ideal: number[] = []
  const remaining: number[] = []
  for (let d = 0; d <= days; d++) {
    const tCutoff = start + d * dayMs
    let added = 0
    let done = 0
    for (const iss of issues) {
      const created = new Date(iss.created_at).getTime()
      if (created <= tCutoff) added += 1
      const completed = iss.completed_at ? new Date(iss.completed_at).getTime() : Infinity
      if (completed <= tCutoff) done += 1
    }
    remaining.push(Math.max(0, added - done))
    ideal.push(Math.max(0, total - (total / days) * d))
  }
  return { ideal, remaining, days }
}

function BurndownChart({
  data,
}: {
  data: { ideal: number[]; remaining: number[]; days: number }
}) {
  if (data.days === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-edge-default text-xs text-content-subtle">
        Cycle has no start/end date
      </div>
    )
  }
  // Render two AreaCharts overlaid via grid for an "ideal vs actual" effect.
  return (
    <div className="relative">
      <AreaChart
        points={data.remaining}
        color="var(--color-brand-500)"
        height={160}
        showAxis={false}
        emptyLabel="Awaiting samples…"
      />
      <div className="pointer-events-none absolute inset-0 opacity-40">
        <Sparkline points={data.ideal} />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-content-subtle">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-brand-500" /> Remaining
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1 w-3 rounded-full bg-content-subtle/60" /> Ideal pace
        </span>
        <span className="tabular-nums">{data.days}d cycle</span>
      </div>
    </div>
  )
}

/**
 * Tiny dashed-line ideal track. A second SVG layered behind the AreaChart's
 * gradient fill gives a quick "are we on pace?" read without pulling in a
 * fancy charting lib.
 */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null
  const W = 320
  const H = 160
  const max = Math.max(...points, 1)
  const step = W / (points.length - 1)
  const ys = points.map((p) => H - (p / max) * (H - 6) - 3)
  const path = ys
    .map((y, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y.toFixed(2)}`)
    .join(' ')
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path
        d={path}
        fill="none"
        stroke="var(--color-content-subtle)"
        strokeWidth="1.5"
        strokeDasharray="3 4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-edge-subtle bg-surface-sunken/60 p-3">
      <div className="text-lg font-semibold tabular-nums text-content">{value}</div>
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

function IconClose() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

