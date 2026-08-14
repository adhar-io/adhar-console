import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  DataTable,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { cn, formatRelative } from '@adhar-console/utils'
import { plane } from '@adhar-console/api-clients'
import {
  memberDisplayName,
  memberInitials,
  priorityKind,
  useCreateIssue,
  useIssues,
  useLabels,
  useMembers,
  useStates,
  useUpdateIssue,
} from '../data/plane.ts'
import { IssueDrawer } from '../components/issue-drawer.tsx'
import { NewIssueModal } from '../components/new-issue-modal.tsx'
import { CreateViewModal } from '../components/create-forms.tsx'
import type { SavedIssueQuery } from '../data/view-query.ts'

/**
 * Issues — Plane parity:
 *   • Board (Kanban grouped by state, priority, assignee, label, cycle, module).
 *   • List (compact table with same group-by support).
 *   • Filters (priority, label, assignee).
 *   • Inline add issue per Kanban column + global "New issue" modal.
 *   • Click any issue → IssueDrawer with full edit + comments + activity.
 */

type ViewMode = 'kanban' | 'list' | 'calendar'
type GroupBy = 'state' | 'priority' | 'assignee' | 'label' | 'cycle' | 'module'
type SortBy = 'updated' | 'created' | 'priority' | 'target' | 'estimate'

interface Props {
  projectId?: string
  /** A Saved View's filter set to hydrate the board with on mount. */
  appliedQuery?: SavedIssueQuery
}

const PRIORITIES: plane.Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

export function Issues({ projectId, appliedQuery }: Props) {
  const [mode, setMode] = useState<ViewMode>('kanban')
  const [groupBy, setGroupBy] = useState<GroupBy>(appliedQuery?.group_by ?? 'state')
  const [sortBy, setSortBy] = useState<SortBy>(appliedQuery?.sort_by ?? 'updated')
  const [search, setSearch] = useState('')
  const [priority, setPriority] = useState<plane.Priority | 'all'>(appliedQuery?.priority ?? 'all')
  const [stateFilter, setStateFilter] = useState<string | 'all'>(appliedQuery?.state ?? 'all')
  const [labelFilter, setLabelFilter] = useState<string | 'all'>(appliedQuery?.label ?? 'all')
  const [assigneeFilter, setAssigneeFilter] = useState<string | 'all'>(
    appliedQuery?.assignee ?? 'all',
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  // Re-hydrate when a different Saved View is applied while mounted.
  const appliedKey = appliedQuery ? JSON.stringify(appliedQuery) : ''
  useEffect(() => {
    if (!appliedQuery) return
    setGroupBy(appliedQuery.group_by ?? 'state')
    setSortBy(appliedQuery.sort_by ?? 'updated')
    setPriority(appliedQuery.priority ?? 'all')
    setStateFilter(appliedQuery.state ?? 'all')
    setLabelFilter(appliedQuery.label ?? 'all')
    setAssigneeFilter(appliedQuery.assignee ?? 'all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKey])

  const issues = useIssues(projectId)
  const states = useStates(projectId)
  const labels = useLabels(projectId)
  const members = useMembers()
  const update = useUpdateIssue(projectId)

  if (!projectId) {
    return (
      <EmptyState
        title="Pick a project"
        description="Choose one from the project picker above to see its issues."
      />
    )
  }
  if (issues.isError) {
    return (
      <EmptyState
        title="Couldn't reach Plane"
        description={issues.error instanceof Error ? issues.error.message : 'Unknown error.'}
      />
    )
  }

  const all = issues.data ?? []
  const filtered = all
    .filter((i) => {
      if (priority !== 'all' && i.priority !== priority) return false
      if (stateFilter !== 'all' && i.state !== stateFilter) return false
      if (labelFilter !== 'all' && !i.labels.includes(labelFilter)) return false
      if (assigneeFilter !== 'all' && !i.assignees.includes(assigneeFilter)) return false
      if (search && !i.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
    .slice()
    .sort(sorter(sortBy))

  const stateMap = new Map((states.data ?? []).map((s) => [s.id, s]))
  const labelMap = new Map((labels.data ?? []).map((l) => [l.id, l]))
  const memberMap = new Map((members.data ?? []).map((m) => [m.member?.id ?? m.id, m]))

  const activeFilters =
    (priority !== 'all' ? 1 : 0) +
    (stateFilter !== 'all' ? 1 : 0) +
    (labelFilter !== 'all' ? 1 : 0) +
    (assigneeFilter !== 'all' ? 1 : 0)

  const currentQuery: SavedIssueQuery = {
    priority: priority !== 'all' ? priority : undefined,
    state: stateFilter !== 'all' ? stateFilter : undefined,
    label: labelFilter !== 'all' ? labelFilter : undefined,
    assignee: assigneeFilter !== 'all' ? assigneeFilter : undefined,
    group_by: groupBy,
    sort_by: sortBy,
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-2 shadow-sm">
        <div className="inline-flex items-center gap-1 rounded-lg bg-surface-sunken p-0.5">
          <ModeTab active={mode === 'kanban'} onClick={() => setMode('kanban')}>
            <IconKanban /> Board
          </ModeTab>
          <ModeTab active={mode === 'list'} onClick={() => setMode('list')}>
            <IconList /> List
          </ModeTab>
          <ModeTab active={mode === 'calendar'} onClick={() => setMode('calendar')}>
            <IconCalendarTab /> Calendar
          </ModeTab>
        </div>

        <ToolbarSelect label="Group" value={groupBy} onChange={(v) => setGroupBy(v as GroupBy)}>
          <option value="state">State</option>
          <option value="priority">Priority</option>
          <option value="assignee">Assignee</option>
          <option value="label">Label</option>
          <option value="cycle">Cycle</option>
          <option value="module">Module</option>
        </ToolbarSelect>

        <ToolbarSelect label="Sort" value={sortBy} onChange={(v) => setSortBy(v as SortBy)}>
          <option value="updated">Recently updated</option>
          <option value="created">Recently created</option>
          <option value="priority">Priority</option>
          <option value="target">Target date</option>
          <option value="estimate">Estimate</option>
        </ToolbarSelect>

        <div className="relative">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search issues…"
            className="h-8 w-56 rounded-md border border-edge-default bg-surface-raised pl-7 pr-2 text-xs"
          />
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-subtle">
            <IconSearch />
          </span>
        </div>

        <ToolbarSelect
          label="Priority"
          value={priority}
          onChange={(v) => setPriority(v as plane.Priority | 'all')}
        >
          <option value="all">All</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </ToolbarSelect>
        <ToolbarSelect label="State" value={stateFilter} onChange={setStateFilter}>
          <option value="all">All</option>
          {(states.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </ToolbarSelect>
        <ToolbarSelect label="Label" value={labelFilter} onChange={setLabelFilter}>
          <option value="all">All</option>
          {(labels.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </ToolbarSelect>
        <ToolbarSelect label="Assignee" value={assigneeFilter} onChange={setAssigneeFilter}>
          <option value="all">Everyone</option>
          {(members.data ?? []).map((m) => (
            <option key={m.id} value={m.member?.id ?? m.id}>
              {memberDisplayName(m)}
            </option>
          ))}
        </ToolbarSelect>

        {activeFilters > 0 ? (
          <button
            type="button"
            onClick={() => {
              setPriority('all')
              setStateFilter('all')
              setLabelFilter('all')
              setAssigneeFilter('all')
            }}
            className="text-[11px] font-medium text-brand-700 hover:text-brand-800"
          >
            Reset {activeFilters}
          </button>
        ) : null}

        <span className="ml-auto flex items-center gap-2 text-[11px] text-content-subtle">
          {issues.isFetching ? <Spinner size={10} /> : null}
          {filtered.length} of {all.length}
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setSaveOpen(true)}
          leading={<IconBookmark />}
        >
          Save view
        </Button>
        <Button size="sm" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>
          New issue
        </Button>
      </div>

      {mode === 'kanban' ? (
        <KanbanBoard
          projectId={projectId}
          issues={filtered}
          groupBy={groupBy}
          states={states.data ?? []}
          labels={labels.data ?? []}
          members={members.data ?? []}
          stateMap={stateMap}
          labelMap={labelMap}
          memberMap={memberMap}
          onOpen={setOpenId}
          onDropIssue={(issueId, key) => {
            const patch: Partial<plane.Issue> = {}
            switch (groupBy) {
              case 'state':
                patch.state = key
                break
              case 'priority':
                patch.priority = key as plane.Priority
                break
              case 'assignee': {
                const issue = all.find((i) => i.id === issueId)
                if (!issue) return
                const filtered = issue.assignees.filter((id) =>
                  buildGroups(groupBy, {
                    issues: all,
                    states: states.data ?? [],
                    labels: labels.data ?? [],
                    members: members.data ?? [],
                  })
                    .map((g) => g.id)
                    .filter((id) => id !== '_none')
                    .includes(id),
                )
                patch.assignees = key === '_none' ? [] : [...new Set([...filtered, key])]
                break
              }
              case 'label': {
                const issue = all.find((i) => i.id === issueId)
                if (!issue) return
                patch.labels = key === '_none' ? [] : [...new Set([...issue.labels, key])]
                break
              }
              case 'cycle':
                patch.cycle = key === '_none' ? null : key
                break
              case 'module':
                patch.module = key === '_none' ? null : key
                break
            }
            update.mutate({ id: issueId, patch })
          }}
          loading={issues.isLoading || states.isLoading}
        />
      ) : mode === 'calendar' ? (
        <CalendarView
          issues={filtered}
          stateMap={stateMap}
          onOpen={setOpenId}
          loading={issues.isLoading}
        />
      ) : (
        <IssueList
          issues={filtered}
          stateMap={stateMap}
          labelMap={labelMap}
          memberMap={memberMap}
          onOpen={setOpenId}
          loading={issues.isLoading || states.isLoading}
        />
      )}

      {createOpen ? (
        <NewIssueModal
          projectId={projectId}
          onClose={() => setCreateOpen(false)}
          onCreated={(issue) => setOpenId(issue.id)}
        />
      ) : null}

      {saveOpen ? (
        <CreateViewModal
          projectId={projectId}
          open
          onClose={() => setSaveOpen(false)}
          initialQuery={currentQuery}
        />
      ) : null}

      {openId ? (
        <IssueDrawer
          projectId={projectId}
          issueId={openId}
          onClose={() => setOpenId(null)}
          onPick={setOpenId}
        />
      ) : null}
    </div>
  )
}

function ToolbarSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string
  onChange(v: string): void
  children: React.ReactNode
}) {
  return (
    <label className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge-default bg-surface-raised pl-2 pr-1 text-[11px] font-medium text-content-muted">
      <span className="uppercase tracking-wider text-content-subtle">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-full bg-transparent pr-1 text-xs text-content focus:outline-none"
      >
        {children}
      </select>
    </label>
  )
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors',
        active ? 'bg-surface-raised text-content shadow-sm' : 'text-content-muted hover:text-content',
      )}
    >
      {children}
    </button>
  )
}

/* ───── kanban ───── */

interface GroupKey {
  id: string
  label: string
  color?: string
}

function KanbanBoard({
  projectId,
  issues,
  groupBy,
  states,
  labels,
  members,
  stateMap,
  labelMap,
  memberMap,
  onOpen,
  onDropIssue,
  loading,
}: {
  projectId: string
  issues: plane.Issue[]
  groupBy: GroupBy
  states: plane.State[]
  labels: plane.Label[]
  members: plane.Member[]
  stateMap: Map<string, plane.State>
  labelMap: Map<string, plane.Label>
  memberMap: Map<string, plane.Member>
  onOpen(id: string): void
  onDropIssue(issueId: string, groupKey: string): void
  loading: boolean
}) {
  const groups = buildGroups(groupBy, { issues, states, labels, members })
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-72 animate-pulse rounded-xl border border-edge-subtle bg-surface-sunken/60"
          />
        ))}
      </div>
    )
  }
  if (!groups.length) {
    return <EmptyState title="Nothing to show" description="Adjust the filters above." />
  }
  return (
    <div className="-mx-2 overflow-x-auto px-2 pb-2">
      <div className="flex gap-3" style={{ minWidth: groups.length * 290 }}>
        {groups.map((g) => {
          const cards = filterByGroup(issues, groupBy, g.id)
          return (
            <KanbanColumn
              key={g.id}
              group={g}
              issues={cards}
              groupBy={groupBy}
              labelMap={labelMap}
              memberMap={memberMap}
              stateMap={stateMap}
              onOpen={onOpen}
              onDropIssue={onDropIssue}
              projectId={projectId}
              states={states}
            />
          )
        })}
      </div>
    </div>
  )
}

function KanbanColumn({
  group,
  issues,
  groupBy,
  stateMap,
  labelMap,
  memberMap,
  onOpen,
  onDropIssue,
  projectId,
  states,
}: {
  group: GroupKey
  issues: plane.Issue[]
  groupBy: GroupBy
  stateMap: Map<string, plane.State>
  labelMap: Map<string, plane.Label>
  memberMap: Map<string, plane.Member>
  onOpen(id: string): void
  onDropIssue(issueId: string, groupKey: string): void
  projectId: string
  states: plane.State[]
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      }}
      onDragLeave={(e) => {
        // Only un-highlight when leaving the column itself, not child elements.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const id = e.dataTransfer.getData('text/x-issue-id')
        if (id) onDropIssue(id, group.id)
      }}
      className={cn(
        'flex min-w-[270px] flex-1 flex-col rounded-xl border bg-surface-sunken/40 p-2 shadow-sm transition-colors',
        over ? 'border-brand-400 bg-brand-50/40' : 'border-edge-default',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-2 pt-1">
        <div className="flex items-center gap-2">
          {group.color ? (
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: group.color }}
            />
          ) : null}
          <span className="text-xs font-semibold uppercase tracking-[0.06em] text-content">
            {group.label}
          </span>
        </div>
        <span className="rounded-full bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-content-muted ring-1 ring-inset ring-edge-default">
          {issues.length}
        </span>
      </div>
      <ul className="space-y-2">
        {issues.length === 0 ? (
          <li className="rounded-lg border border-dashed border-edge-default bg-surface-raised/50 p-4 text-center text-[11px] text-content-subtle">
            Nothing here
          </li>
        ) : (
          issues.map((iss) => (
            <KanbanCard
              key={iss.id}
              issue={iss}
              labels={iss.labels.map((id) => labelMap.get(id)).filter(Boolean) as plane.Label[]}
              members={
                iss.assignees.map((id) => memberMap.get(id)).filter(Boolean) as plane.Member[]
              }
              stateColor={stateMap.get(iss.state)?.color}
              onClick={() => onOpen(iss.id)}
            />
          ))
        )}
      </ul>
      <InlineAddIssue
        projectId={projectId}
        defaultState={
          groupBy === 'state' && states.find((s) => s.id === group.id) ? group.id : states[0]?.id
        }
        defaultPriority={groupBy === 'priority' ? (group.id as plane.Priority) : 'none'}
        defaultCycle={groupBy === 'cycle' && group.id !== '_none' ? group.id : null}
        defaultModule={groupBy === 'module' && group.id !== '_none' ? group.id : null}
        defaultAssignees={groupBy === 'assignee' && group.id !== '_none' ? [group.id] : []}
        defaultLabels={groupBy === 'label' && group.id !== '_none' ? [group.id] : []}
      />
    </div>
  )
}

function KanbanCard({
  issue,
  labels,
  members,
  stateColor,
  onClick,
}: {
  issue: plane.Issue
  labels: plane.Label[]
  members: plane.Member[]
  stateColor?: string
  onClick(): void
}) {
  return (
    <li>
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/x-issue-id', issue.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onClick={onClick}
        className="block w-full cursor-grab rounded-lg border border-edge-subtle bg-surface-raised p-3 text-left shadow-sm transition-all duration-150 ease-smooth hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-md active:cursor-grabbing"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-content-subtle">
            #{issue.sequence_id ?? '—'}
          </span>
          <StatusBadge kind={priorityKind(issue.priority)} dot={false}>
            {issue.priority}
          </StatusBadge>
        </div>
        <div className="mt-1.5 line-clamp-2 text-sm font-medium leading-snug text-content">
          {issue.name}
        </div>
        {labels.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {labels.slice(0, 4).map((l) => (
              <span
                key={l.id}
                className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] text-content-muted"
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: l.color }} />
                {l.name}
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between text-[11px] text-content-subtle">
          <div className="flex items-center gap-2">
            {stateColor ? (
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: stateColor }}
              />
            ) : null}
            {issue.target_date ? (
              <span title={issue.target_date} className="inline-flex items-center gap-1">
                <IconCalendar />
                {dateLabel(issue.target_date)}
              </span>
            ) : null}
            {issue.estimate_point ? (
              <span className="inline-flex items-center gap-1">
                <IconHash />
                {issue.estimate_point}
              </span>
            ) : null}
            {issue.sub_issues_count ? (
              <span className="inline-flex items-center gap-1">
                <IconBranch />
                {issue.sub_issues_count}
              </span>
            ) : null}
          </div>
          {members.length ? (
            <AvatarStack members={members.slice(0, 3)} extra={members.length - 3} />
          ) : null}
        </div>
      </button>
    </li>
  )
}

/* ───── inline add ───── */

function InlineAddIssue({
  projectId,
  defaultState,
  defaultPriority = 'none',
  defaultCycle = null,
  defaultModule = null,
  defaultAssignees = [],
  defaultLabels = [],
}: {
  projectId: string
  defaultState?: string
  defaultPriority?: plane.Priority
  defaultCycle?: string | null
  defaultModule?: string | null
  defaultAssignees?: string[]
  defaultLabels?: string[]
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const create = useCreateIssue(projectId)
  if (!defaultState) return null
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-dashed border-edge-default bg-transparent px-2 py-1.5 text-[11px] font-medium text-content-subtle transition-colors hover:border-edge-strong hover:text-content"
      >
        <IconPlus /> Add issue
      </button>
    )
  }
  const submit = () => {
    const name = draft.trim()
    if (!name) return
    create.mutate(
      {
        name,
        state: defaultState,
        priority: defaultPriority,
        cycle: defaultCycle,
        module: defaultModule,
        assignees: defaultAssignees,
        labels: defaultLabels,
      } as Partial<plane.Issue>,
      {
        onSuccess: () => {
          setDraft('')
          setOpen(false)
        },
      },
    )
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="mt-2 rounded-md border border-edge-default bg-surface-raised p-2 shadow-sm"
    >
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Issue title…"
        rows={2}
        className="block w-full resize-none border-0 bg-transparent p-0 text-xs focus:outline-none"
      />
      <div className="mt-1 flex items-center justify-end gap-1">
        <Button size="xs" variant="ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="xs" type="submit" loading={create.isPending} disabled={!draft.trim()}>
          Add
        </Button>
      </div>
    </form>
  )
}

/* CalendarView — month grid showing issues by target_date. */
function CalendarView({
  issues,
  stateMap,
  onOpen,
  loading,
}: {
  issues: plane.Issue[]
  stateMap: Map<string, plane.State>
  onOpen(id: string): void
  loading: boolean
}) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const days = useMemo(() => buildMonthGrid(cursor), [cursor])
  if (loading) {
    return (
      <div className="grid grid-cols-7 gap-2">
        {Array.from({ length: 35 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border border-edge-subtle bg-surface-sunken/60" />
        ))}
      </div>
    )
  }
  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const byDay = new Map<string, plane.Issue[]>()
  for (const i of issues) {
    if (!i.target_date) continue
    const k = i.target_date.slice(0, 10)
    const list = byDay.get(k) ?? []
    list.push(i)
    byDay.set(k, list)
  }
  return (
    <div className="rounded-xl border border-edge-default bg-surface-raised p-3 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-content">{monthLabel}</div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
            className="flex h-7 w-7 items-center justify-center rounded-md text-content-muted hover:bg-surface-sunken"
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setCursor(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-content-muted hover:bg-surface-sunken"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
            className="flex h-7 w-7 items-center justify-center rounded-md text-content-muted hover:bg-surface-sunken"
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg bg-edge-subtle">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div
            key={d}
            className="bg-surface-sunken/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-content-subtle"
          >
            {d}
          </div>
        ))}
        {days.map((day) => {
          const k = day.date.toISOString().slice(0, 10)
          const list = byDay.get(k) ?? []
          const isToday =
            day.date.toDateString() === new Date().toDateString()
          return (
            <div
              key={k}
              className={cn(
                'min-h-24 bg-surface-raised p-1.5 text-[11px]',
                !day.inMonth && 'bg-surface-sunken/40 text-content-subtle',
              )}
            >
              <div
                className={cn(
                  'mb-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-medium tabular-nums',
                  isToday ? 'bg-brand-600 text-white' : 'text-content-muted',
                )}
              >
                {day.date.getDate()}
              </div>
              <div className="space-y-1">
                {list.slice(0, 3).map((iss) => {
                  const st = stateMap.get(iss.state)
                  return (
                    <button
                      key={iss.id}
                      type="button"
                      onClick={() => onOpen(iss.id)}
                      className="flex w-full items-center gap-1 truncate rounded bg-surface-sunken px-1.5 py-0.5 text-left text-[10px] text-content hover:bg-brand-50"
                    >
                      {st ? (
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: st.color }}
                        />
                      ) : null}
                      <span className="truncate">{iss.name}</span>
                    </button>
                  )
                })}
                {list.length > 3 ? (
                  <div className="text-[10px] text-content-subtle">
                    +{list.length - 3} more
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function buildMonthGrid(first: Date): Array<{ date: Date; inMonth: boolean }> {
  const start = new Date(first)
  start.setDate(1)
  const startWeekday = start.getDay()
  start.setDate(start.getDate() - startWeekday) // back to Sunday
  const cells: Array<{ date: Date; inMonth: boolean }> = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    cells.push({ date: d, inMonth: d.getMonth() === first.getMonth() })
  }
  // Trim trailing fully-empty week if month fits in 5 rows.
  if (cells.slice(35).every((c) => !c.inMonth)) cells.length = 35
  return cells
}

function sorter(by: SortBy) {
  return (a: plane.Issue, b: plane.Issue) => {
    switch (by) {
      case 'updated':
        return time(b.updated_at ?? b.created_at) - time(a.updated_at ?? a.created_at)
      case 'created':
        return time(b.created_at) - time(a.created_at)
      case 'priority':
        return priorityRank(a.priority) - priorityRank(b.priority)
      case 'target':
        // null target dates sink to bottom.
        return time(a.target_date ?? '9999-01-01') - time(b.target_date ?? '9999-01-01')
      case 'estimate':
        return (b.estimate_point ?? 0) - (a.estimate_point ?? 0)
    }
  }
}
function time(s?: string | null) {
  return s ? new Date(s).getTime() : 0
}
function priorityRank(p: plane.Priority): number {
  return { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }[p]
}

function IconCalendarTab() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 11h18" />
    </svg>
  )
}

/* ───── list ───── */

function IssueList({
  issues,
  stateMap,
  labelMap,
  memberMap,
  onOpen,
  loading,
}: {
  issues: plane.Issue[]
  stateMap: Map<string, plane.State>
  labelMap: Map<string, plane.Label>
  memberMap: Map<string, plane.Member>
  onOpen(id: string): void
  loading: boolean
}) {
  return (
    <DataTable
      loading={loading}
      onRowClick={(i) => onOpen(i.id)}
      columns={[
        {
          key: 'id',
          header: 'ID',
          width: 80,
          cell: (i) => (
            <code className="font-mono text-[11px] text-content-muted">#{i.sequence_id ?? '—'}</code>
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
              <div className="min-w-0">
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
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: st.color }} />
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
          key: 'estimate',
          header: 'Est',
          numeric: true,
          cell: (i) => i.estimate_point ?? '—',
        },
        {
          key: 'assignees',
          header: 'Assignees',
          cell: (i) => {
            const ms = i.assignees
              .map((id) => memberMap.get(id))
              .filter(Boolean) as plane.Member[]
            return ms.length ? (
              <AvatarStack members={ms.slice(0, 3)} extra={ms.length - 3} />
            ) : (
              <span className="text-content-subtle">—</span>
            )
          },
        },
        {
          key: 'target',
          header: 'Target',
          cell: (i) =>
            i.target_date ? (
              <span className="text-xs text-content-muted">{dateLabel(i.target_date)}</span>
            ) : (
              <span className="text-content-subtle">—</span>
            ),
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
      rows={issues}
      rowKey={(i) => i.id}
      empty={<EmptyState title="No matching issues" description="Adjust the filters above." />}
    />
  )
}

/* ───── grouping ───── */

function buildGroups(
  by: GroupBy,
  data: {
    issues: plane.Issue[]
    states: plane.State[]
    labels: plane.Label[]
    members: plane.Member[]
  },
): GroupKey[] {
  switch (by) {
    case 'state':
      return [...data.states]
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map((s) => ({ id: s.id, label: s.name, color: s.color }))
    case 'priority':
      return PRIORITIES.map((p) => ({
        id: p,
        label: p[0].toUpperCase() + p.slice(1),
        color: priorityColor(p),
      }))
    case 'assignee': {
      const ids = new Set<string>(['_none'])
      for (const i of data.issues) i.assignees.forEach((a) => ids.add(a))
      return [...ids].map((id) => ({
        id,
        label:
          id === '_none'
            ? 'Unassigned'
            : memberDisplayName(data.members.find((m) => (m.member?.id ?? m.id) === id)),
      }))
    }
    case 'label': {
      const ids = new Set<string>(['_none'])
      for (const i of data.issues) i.labels.forEach((l) => ids.add(l))
      return [...ids].map((id) => {
        const l = data.labels.find((x) => x.id === id)
        return {
          id,
          label: id === '_none' ? 'No label' : l?.name ?? '—',
          color: l?.color,
        }
      })
    }
    case 'cycle': {
      const ids = new Set<string>(['_none'])
      for (const i of data.issues) if (i.cycle) ids.add(i.cycle)
      return [...ids].map((id) => ({ id, label: id === '_none' ? 'No cycle' : id.slice(0, 8) }))
    }
    case 'module': {
      const ids = new Set<string>(['_none'])
      for (const i of data.issues) if (i.module) ids.add(i.module)
      return [...ids].map((id) => ({
        id,
        label: id === '_none' ? 'No module' : id.slice(0, 8),
      }))
    }
  }
}

function filterByGroup(issues: plane.Issue[], by: GroupBy, key: string): plane.Issue[] {
  switch (by) {
    case 'state':
      return issues.filter((i) => i.state === key)
    case 'priority':
      return issues.filter((i) => i.priority === key)
    case 'assignee':
      return issues.filter((i) =>
        key === '_none' ? i.assignees.length === 0 : i.assignees.includes(key),
      )
    case 'label':
      return issues.filter((i) =>
        key === '_none' ? i.labels.length === 0 : i.labels.includes(key),
      )
    case 'cycle':
      return issues.filter((i) => (key === '_none' ? !i.cycle : i.cycle === key))
    case 'module':
      return issues.filter((i) => (key === '_none' ? !i.module : i.module === key))
  }
}

function priorityColor(p: plane.Priority): string {
  switch (p) {
    case 'urgent':
      return '#dc2626'
    case 'high':
      return '#f43f5e'
    case 'medium':
      return '#f59e0b'
    case 'low':
      return '#0ea5e9'
    default:
      return 'var(--color-edge-strong)'
  }
}

/* ───── atoms ───── */

function AvatarStack({
  members,
  extra,
}: {
  members: plane.Member[]
  extra?: number
}) {
  return (
    <div className="flex items-center -space-x-1.5">
      {members.map((m) => (
        <span
          key={m.id}
          title={memberDisplayName(m)}
          className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-2 ring-surface-raised"
        >
          {memberInitials(m)}
        </span>
      ))}
      {extra && extra > 0 ? (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-sunken text-[10px] font-semibold text-content-muted ring-2 ring-surface-raised">
          +{extra}
        </span>
      ) : null}
    </div>
  )
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function IconKanban() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="6" height="14" rx="1.5" />
      <rect x="11" y="3" width="6" height="9" rx="1.5" />
      <rect x="19" y="3" width="2" height="6" rx="1" />
    </svg>
  )
}
function IconList() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  )
}
function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}
function IconCalendar() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 11h18" />
    </svg>
  )
}
function IconHash() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9h16M4 15h16M9 4l-2 16M17 4l-2 16" />
    </svg>
  )
}
function IconBranch() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M8 6h6a4 4 0 0 1 4 4v0M8 18h6a4 4 0 0 0 4-4v0" />
    </svg>
  )
}
function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconBookmark() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}
