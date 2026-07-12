import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
  type StatusKind,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import type { plane } from '@adhar-console/api-clients'
import {
  memberDisplayName,
  memberInitials,
  priorityKind,
  useDeleteModule,
  useIssues,
  useLabels,
  useMembers,
  useModules,
  useStates,
} from '../data/plane.ts'
import { IssueDrawer } from '../components/issue-drawer.tsx'
import { CreateModuleModal } from '../components/create-forms.tsx'
import { ListToolbar } from '../components/list-toolbar.tsx'

const STATUS_KIND: Record<plane.Module['status'], StatusKind> = {
  planned: 'info',
  'in-progress': 'progressing',
  paused: 'paused',
  completed: 'healthy',
  cancelled: 'failed',
}

/**
 * Modules — Plane's epic-shaped grouping. Each card shows progress, lead +
 * member avatars, target date, and a stacked breakdown bar (done / started /
 * unstarted / backlog / cancelled).
 */
export function Modules({ projectId }: { projectId?: string }) {
  const q = useModules(projectId)
  const members = useMembers()
  const [openModule, setOpenModule] = useState<plane.Module | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  if (!projectId) return <EmptyState title="Pick a project" />
  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading modules…
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
  const rows = f
    ? all.filter(
        (m) =>
          m.name.toLowerCase().includes(f) || (m.description ?? '').toLowerCase().includes(f),
      )
    : all
  const memberMap = new Map((members.data ?? []).map((m) => [m.member?.id ?? m.id, m]))
  return (
    <div className="space-y-4">
      <ListToolbar
        count={all.length}
        noun="module"
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search modules…"
        onNew={() => setCreateOpen(true)}
        newLabel="New module"
        disabled={createOpen || openModule !== null}
      />
      {all.length === 0 ? (
        <EmptyState
          title="No modules yet"
          description="Modules group issues into shippable units — click New module to plan one."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No matches"
          description={`No modules match "${search}". Try a different keyword.`}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {rows.map((m) => (
            <ModuleCard
              key={m.id}
              module={m}
              memberMap={memberMap}
              onOpen={() => setOpenModule(m)}
            />
          ))}
        </div>
      )}
      {openModule ? (
        <ModuleDetail
          projectId={projectId}
          module={openModule}
          onClose={() => setOpenModule(null)}
        />
      ) : null}
      <CreateModuleModal
        projectId={projectId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(m) => setOpenModule(m)}
      />
    </div>
  )
}

function ModuleCard({
  module: m,
  memberMap,
  onOpen,
}: {
  module: plane.Module
  memberMap: Map<string, plane.Member>
  onOpen(): void
}) {
  const total = m.total_issues ?? 0
  const done = m.completed_issues ?? 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const lead = m.lead ? memberMap.get(m.lead) : undefined
  const members = m.members.map((id) => memberMap.get(id)).filter(Boolean) as plane.Member[]

  return (
    <Card interactive className="relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${m.name}`}
        className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/25"
      />
      <CardHeader className="relative z-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-content">{m.name}</span>
              <StatusBadge kind={STATUS_KIND[m.status]}>{m.status}</StatusBadge>
            </div>
            {m.description ? (
              <p className="mt-1 line-clamp-2 text-xs text-content-muted">{m.description}</p>
            ) : null}
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums text-content">
              {pct}
              <span className="text-sm font-normal text-content-muted">%</span>
            </div>
            <div className="text-[10px] uppercase tracking-wider text-content-subtle">
              complete
            </div>
          </div>
        </div>
      </CardHeader>
      <CardBody className="relative z-0 space-y-4">
        <BreakdownBar mod={m} />

        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          <Pill label="Done" value={m.completed_issues ?? 0} color="var(--color-brand-500)" />
          <Pill label="Active" value={m.started_issues ?? 0} color="var(--color-accent-500)" />
          <Pill label="Unstarted" value={m.unstarted_issues ?? 0} color="#f59e0b" />
          <Pill label="Backlog" value={m.backlog_issues ?? 0} color="var(--color-edge-strong)" />
        </div>

        <div className="flex items-center justify-between gap-2 text-xs text-content-muted">
          <div className="flex items-center gap-2">
            {lead ? (
              <>
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
                  {memberInitials(lead)}
                </span>
                <span>Lead {memberDisplayName(lead)}</span>
              </>
            ) : (
              <span>No lead</span>
            )}
            {members.length ? (
              <div className="ml-2 flex items-center -space-x-1.5">
                {members.slice(0, 4).map((mem) => (
                  <span
                    key={mem.id}
                    title={memberDisplayName(mem)}
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-semibold text-content-muted ring-2 ring-white"
                  >
                    {memberInitials(mem)}
                  </span>
                ))}
                {members.length > 4 ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-semibold text-content-muted ring-2 ring-white">
                    +{members.length - 4}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div>{fmtTarget(m.start_date, m.target_date)}</div>
        </div>
      </CardBody>
    </Card>
  )
}

function BreakdownBar({ mod }: { mod: plane.Module }) {
  const total = mod.total_issues ?? 0
  if (total === 0) {
    return (
      <div className="flex h-3 items-center justify-center rounded-full bg-surface-sunken text-[10px] text-content-subtle">
        no issues
      </div>
    )
  }
  const segs = [
    { value: mod.completed_issues ?? 0, color: 'var(--color-brand-500)' },
    { value: mod.started_issues ?? 0, color: 'var(--color-accent-500)' },
    { value: mod.unstarted_issues ?? 0, color: '#f59e0b' },
    { value: mod.backlog_issues ?? 0, color: 'var(--color-edge-strong)' },
    { value: mod.cancelled_issues ?? 0, color: '#f43f5e' },
  ]
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
      {segs.map((s, i) =>
        s.value > 0 ? (
          <div
            key={i}
            className="h-full transition-[width] duration-500 ease-smooth"
            style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
          />
        ) : null,
      )}
    </div>
  )
}

function Pill({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color: string
}) {
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/60 p-2">
      <div className="flex items-center justify-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-base font-semibold tabular-nums text-content">{value}</span>
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function fmtTarget(start?: string | null, end?: string | null): string {
  const opt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (!end) return start ? `started ${new Date(start).toLocaleDateString(undefined, opt)}` : '—'
  const left = Math.ceil((new Date(end).getTime() - Date.now()) / 86_400_000)
  if (left < 0) return `due ${new Date(end).toLocaleDateString(undefined, opt)}`
  return `${left}d to target`
}

/* ───── module detail drawer ───── */

function ModuleDetail({
  projectId,
  module: m,
  onClose,
}: {
  projectId: string
  module: plane.Module
  onClose(): void
}) {
  const issues = useIssues(projectId, { module: m.id })
  const states = useStates(projectId)
  const labels = useLabels(projectId)
  const members = useMembers()
  const remove = useDeleteModule(projectId)
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
    () => new Map((members.data ?? []).map((mm) => [mm.member?.id ?? mm.id, mm])),
    [members.data],
  )

  const total = m.total_issues ?? 0
  const done = m.completed_issues ?? 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

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
        <header className="flex items-start justify-between gap-4 border-b border-edge-default bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Module
              <StatusBadge kind={STATUS_KIND[m.status]}>{m.status}</StatusBadge>
            </div>
            <h2 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-content">
              {m.name}
            </h2>
            {m.description ? (
              <p className="mt-1 max-w-2xl text-xs text-content-muted">{m.description}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (!confirm(`Delete "${m.name}"? This can't be undone.`)) return
                remove.mutate(m.id, { onSuccess: onClose })
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Card>
            <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Progress" value={`${pct}%`} />
              <Stat label="Total" value={total} />
              <Stat label="Done" value={done} />
              <Stat label="In progress" value={m.started_issues ?? 0} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-content">
                  Issues in this module ({issues.data?.length ?? 0})
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
                          {ms.slice(0, 3).map((mem) => (
                            <span
                              key={mem.id}
                              title={memberDisplayName(mem)}
                              className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-2 ring-white"
                            >
                              {memberInitials(mem)}
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
                empty={<EmptyState compact title="No issues in this module yet" />}
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
