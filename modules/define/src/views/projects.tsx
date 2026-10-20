import { useMemo, useState } from 'react'
import {
  Button,
  type Column,
  DataTable,
  EmptyState,
  SearchInput,
  Select,
  StatusBadge,
  TeamScopeBar,
  useTeamProjects,
} from '@adhar/shell-ui'
import { cn, formatRelative } from '@adhar/utils'
import type { plane } from '@adhar/api-clients'
import { useProjects } from '../data/plane.ts'
import { usePortfolio } from '../data/planning-plane.ts'
import { type ProjectMeta, useProjectMetas } from '../data/planning-store.ts'
import { daysLeft, deriveHealth, effectiveHealth, type Health, isBugLabel, isOpen, isOverdue, toMs } from '../data/planning-model.ts'
import { usePlanningParams, useSetPlanningParams } from '../data/planning-nav.ts'
import { ProjectMark } from '../components/project-picker.tsx'
import { CreateProjectModal } from '../components/create-forms.tsx'
import { ProjectDetail } from '../components/project-detail.tsx'
import { Avatar, HealthBadge, Loading, Meter, type Person, ProblemState, Segmented, usePeople } from '../components/planning-ui.tsx'

/**
 * Projects — the portfolio. Every Plane project with derived health (overdue
 * work, active-sprint pace; a manual override wins), lead, members, progress,
 * active sprint, open bugs and last activity, as cards or a table.
 *
 * Tenancy: a Plane project can be linked to an Adhar project (and through it
 * to teams) in its settings. When a team is active the list narrows to the
 * projects linked to it, and says so.
 */

interface Props {
  activeId?: string
  onPick(id: string): void
  onOpenDetails?(id: string): void
}

export interface PortfolioRow {
  project: plane.Project
  health: Health
  overridden: boolean
  reasons: string[]
  total: number
  done: number
  open: number
  overdue: number
  bugs: number
  activeSprint?: plane.Cycle
  lastActivity?: string
  loaded: boolean
}

export function Projects({ activeId, onPick }: Props) {
  const projects = useProjects()
  const metas = useProjectMetas()
  const params = usePlanningParams()
  const setParams = useSetPlanningParams()
  const team = useTeamProjects()
  const { people } = usePeople()
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const layout = params.layout === 'table' ? 'table' : 'cards'
  const healthFilter = (params.health ?? 'all') as Health | 'all'

  const all = useMemo(() => (projects.data ?? []).filter((p) => !p.archived_at), [projects.data])
  const metaById = useMemo(() => new Map((metas.data ?? []).map((d) => [d.id, d.data] as const)), [metas.data])

  // Team lens: projects linked to an Adhar project the active team owns, or to the team directly.
  const teamScoped = useMemo(() => {
    if (!team.filtering) return all
    const slugs = new Set(team.projects.map((p) => p.slug))
    return all.filter((p) => {
      const m = metaById.get(p.id)
      return (m?.adharProject && slugs.has(m.adharProject)) || (m?.teams ?? []).includes(team.team)
    })
  }, [all, team.filtering, team.projects, team.team, metaById])

  const ids = useMemo(() => teamScoped.map((p) => p.id), [teamScoped])
  const portfolio = usePortfolio(ids, { labels: true })

  const rows: PortfolioRow[] = useMemo(() => teamScoped.map((p) => buildRow(p, portfolio, metaById.get(p.id))), [teamScoped, portfolio, metaById])
  const f = search.trim().toLowerCase()
  const shown = rows.filter((r) =>
    (healthFilter === 'all' || r.health === healthFilter) &&
    (!f || r.project.name.toLowerCase().includes(f) || r.project.identifier.toLowerCase().includes(f))
  )
  const counts = { 'on-track': 0, 'at-risk': 0, 'off-track': 0 } as Record<Health, number>
  for (const r of rows) if (r.loaded) counts[r.health]++

  if (projects.isLoading) return <Loading label="Loading projects…" />
  if (projects.isError) return <ProblemState error={projects.error} onRetry={() => projects.refetch()} />

  const open = (id: string) => setParams({ pd: id, ptab: undefined }, { push: true })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <SearchInput value={search} onChange={setSearch} placeholder="Search projects…" block />
        </div>
        <Select
          aria-label="Health"
          value={healthFilter}
          onChange={(e) => setParams({ health: e.target.value === 'all' ? undefined : e.target.value })}
          options={[
            { value: 'all', label: 'All health' },
            { value: 'on-track', label: 'On track' },
            { value: 'at-risk', label: 'At risk' },
            { value: 'off-track', label: 'Off track' },
          ]}
        />
        <Segmented
          label="Layout"
          value={layout}
          onChange={(v) => setParams({ layout: v === 'cards' ? undefined : v })}
          options={[{ value: 'cards', label: 'Cards' }, { value: 'table', label: 'Table' }]}
        />
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>New project</Button>
      </div>

      <TeamScopeBar team={team.team} shown={teamScoped.length} total={all.length} noun="Plane projects" />

      {rows.length
        ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-content-muted">
            <span><b className="font-semibold tabular-nums text-content">{rows.length}</b> projects</span>
            {(['on-track', 'at-risk', 'off-track'] as const).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setParams({ health: healthFilter === h ? undefined : h })}
                className={cn('inline-flex items-center gap-1.5 rounded-md px-1 hover:text-content', healthFilter === h && 'text-content underline underline-offset-4')}
              >
                <span className={cn('h-2 w-2 rounded-full', h === 'on-track' ? 'bg-emerald-500' : h === 'at-risk' ? 'bg-amber-500' : 'bg-rose-500')} />
                <b className="font-semibold tabular-nums text-content">{counts[h]}</b> {h.replace('-', ' ')}
              </button>
            ))}
            <span><b className="font-semibold tabular-nums text-content">{rows.filter((r) => r.activeSprint).length}</b> with an active sprint</span>
            {portfolio.fetching ? <span className="text-content-subtle">refreshing…</span> : null}
          </div>
        )
        : null}

      {portfolio.error && !portfolio.loading ? <ProblemState compact error={portfolio.error} /> : null}

      {all.length === 0
        ? <EmptyState title="No projects yet" description="Create the first project to start planning work." action={<Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>New project</Button>} />
        : teamScoped.length === 0
        ? <EmptyState title={`No Plane projects linked to ${team.team}`} description="Link a Plane project to an Adhar project or team from its Settings tab, or show every project." />
        : shown.length === 0
        ? <EmptyState title="No matches" description="No project matches the search or health filter." />
        : layout === 'table'
        ? <PortfolioTable rows={shown} people={people} activeId={activeId} onOpen={open} />
        : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((r) => <ProjectCard key={r.project.id} row={r} lead={people.get(r.project.project_lead ?? '')} active={r.project.id === activeId} onOpen={() => open(r.project.id)} onPick={() => onPick(r.project.id)} />)}
          </div>
        )}

      <CreateProjectModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(p) => onPick(p.id)} />
      {params.pd
        ? (
          <ProjectDetail
            projectId={params.pd}
            onClose={() => setParams({ pd: undefined, ptab: undefined })}
            onSetActive={(id) => {
              onPick(id)
              setParams({ pd: undefined, ptab: undefined })
            }}
          />
        )
        : null}
    </div>
  )
}

export function buildRow(project: plane.Project, portfolio: ReturnType<typeof usePortfolio>, meta?: ProjectMeta | null, now = Date.now()): PortfolioRow {
  const issues = portfolio.issues.get(project.id)
  const cycles = portfolio.cycles.get(project.id) ?? []
  const labels = portfolio.labels.get(project.id) ?? []
  const bugLabels = new Set(labels.filter((l) => isBugLabel(l.name)).map((l) => l.id))
  const items = issues ?? []
  const live = items.filter((i) => i.state_group !== 'cancelled')
  const done = live.filter((i) => i.state_group === 'completed').length
  const openItems = live.filter((i) => isOpen(i))
  const activeSprint = cycles.find((c) => c.status === 'current')
  const derived = deriveHealth({
    items: live,
    activeSprint: activeSprint
      ? { start_date: activeSprint.start_date, end_date: activeSprint.end_date, total: (activeSprint.total_issues ?? 0) - (activeSprint.cancelled_issues ?? 0), done: activeSprint.completed_issues ?? 0 }
      : undefined,
    now,
  })
  const eff = effectiveHealth(derived, meta?.healthOverride, now)
  const last = items.reduce<number>((m, i) => Math.max(m, toMs(i.updated_at ?? i.created_at) ?? 0), 0)
  return {
    project,
    health: eff.health,
    overridden: eff.overridden,
    reasons: eff.reasons,
    total: live.length,
    done,
    open: openItems.length,
    overdue: openItems.filter((i) => isOverdue(i, now)).length,
    bugs: openItems.filter((i) => i.labels.some((l) => bugLabels.has(l))).length,
    activeSprint,
    lastActivity: last ? new Date(last).toISOString() : project.updated_at,
    loaded: !!issues,
  }
}

function ProjectCard({ row, lead, active, onOpen, onPick }: { row: PortfolioRow; lead?: Person; active: boolean; onOpen(): void; onPick(): void }) {
  const p = row.project
  const pct = row.total ? Math.round((row.done / row.total) * 100) : 0
  const left = row.activeSprint ? daysLeft(row.activeSprint.end_date) : undefined
  return (
    <div className={cn('group relative rounded-xl border bg-surface-raised p-4 transition-shadow hover:shadow-md', active ? 'border-brand-400/70' : 'border-edge-default')}>
      <button type="button" onClick={onOpen} className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40" aria-label={`Open ${p.name}`} />
      <div className="pointer-events-none relative z-10 space-y-3">
        <div className="flex items-start gap-3">
          <ProjectMark project={p} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold text-content">{p.name}</span>
              {row.loaded ? <HealthBadge health={row.health} overridden={row.overridden} title={row.reasons.join(' · ')} /> : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-content-subtle">
              <span className="font-mono">{p.identifier}</span>
              <span>· {p.total_members ?? '—'} members</span>
              {active ? <span>· active</span> : null}
            </div>
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-baseline justify-between text-[11px] text-content-muted">
            <span>{row.loaded ? `${row.done} of ${row.total} done` : 'Loading work items…'}</span>
            <span className="tabular-nums text-content">{row.loaded ? `${pct}%` : ''}</span>
          </div>
          <Meter value={pct} label="Progress" />
        </div>
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Mini label="Open" value={row.loaded ? row.open : '—'} />
          <Mini label="Overdue" value={row.loaded ? row.overdue : '—'} warn={row.overdue > 0} />
          <Mini label="Open bugs" value={row.loaded ? row.bugs : '—'} warn={row.bugs > 0} />
        </div>
        <div className="rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[11px] text-content-muted">
          {row.activeSprint
            ? (
              <span className="flex items-center justify-between gap-2">
                <span className="truncate"><span className="text-content">{row.activeSprint.name}</span> · {row.activeSprint.progress ?? 0}% done</span>
                <span className="shrink-0 tabular-nums">{left === 0 ? 'ends today' : `${left}d left`}</span>
              </span>
            )
            : 'No active sprint'}
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-content-muted">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {lead ? <Avatar person={lead} size={18} /> : null}
            <span className="truncate">{lead ? lead.name : 'No lead'}</span>
          </span>
          <span className="shrink-0 text-content-subtle">{row.lastActivity ? `active ${formatRelative(row.lastActivity)}` : ''}</span>
        </div>
      </div>
      {!active
        ? (
          <button
            type="button"
            onClick={onPick}
            className="absolute bottom-3 right-3 z-20 rounded-md border border-edge-default bg-surface-raised px-2 py-1 text-[11px] font-medium text-content opacity-0 shadow-sm transition-opacity hover:border-brand-400 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
          >
            Set active
          </button>
        )
        : null}
    </div>
  )
}

function Mini({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="rounded-md border border-edge-subtle px-2 py-1">
      <div className={cn('text-sm font-semibold tabular-nums', warn ? 'text-amber-700 dark:text-amber-300' : 'text-content')}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-content-subtle">{label}</div>
    </div>
  )
}

function PortfolioTable({ rows, people, activeId, onOpen }: { rows: PortfolioRow[]; people: Map<string, Person>; activeId?: string; onOpen(id: string): void }) {
  const HEALTH_ORDER: Record<Health, number> = { 'off-track': 0, 'at-risk': 1, 'on-track': 2 }
  const columns: Column<PortfolioRow>[] = [
    {
      key: 'name',
      header: 'Project',
      pinned: true,
      value: (r) => r.project.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-content">{r.project.name}</span>
          <span className="font-mono text-[10px] text-content-subtle">{r.project.identifier}</span>
          {r.project.id === activeId ? <StatusBadge kind="info">active</StatusBadge> : null}
        </span>
      ),
    },
    { key: 'health', header: 'Health', value: (r) => HEALTH_ORDER[r.health], cell: (r) => (r.loaded ? <HealthBadge health={r.health} overridden={r.overridden} title={r.reasons.join(' · ')} /> : '—') },
    {
      key: 'lead',
      header: 'Lead',
      value: (r) => people.get(r.project.project_lead ?? '')?.name ?? '',
      cell: (r) => {
        const l = people.get(r.project.project_lead ?? '')
        return l ? <span className="inline-flex items-center gap-1.5"><Avatar person={l} size={18} />{l.name}</span> : <span className="text-content-subtle">—</span>
      },
    },
    { key: 'members', header: 'Members', numeric: true, value: (r) => r.project.total_members ?? 0, cell: (r) => r.project.total_members ?? '—' },
    {
      key: 'progress',
      header: 'Progress',
      value: (r) => (r.total ? r.done / r.total : 0),
      cell: (r) => (
        <span className="flex items-center gap-2">
          <Meter value={r.total ? (r.done / r.total) * 100 : 0} className="w-20" label="Progress" />
          <span className="tabular-nums text-[11px] text-content-muted">{r.done}/{r.total}</span>
        </span>
      ),
    },
    { key: 'sprint', header: 'Active sprint', value: (r) => r.activeSprint?.name ?? '', cell: (r) => (r.activeSprint ? `${r.activeSprint.name} · ${r.activeSprint.progress ?? 0}%` : <span className="text-content-subtle">—</span>) },
    { key: 'open', header: 'Open', numeric: true, value: (r) => r.open, cell: (r) => r.open },
    { key: 'overdue', header: 'Overdue', numeric: true, value: (r) => r.overdue, cell: (r) => r.overdue },
    { key: 'bugs', header: 'Open bugs', numeric: true, value: (r) => r.bugs, cell: (r) => r.bugs },
    { key: 'activity', header: 'Last activity', value: (r) => r.lastActivity ?? '', cell: (r) => (r.lastActivity ? formatRelative(r.lastActivity) : '—') },
  ]
  return (
    <DataTable
      tableId="define-portfolio"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.project.id}
      onRowClick={(r) => onOpen(r.project.id)}
      features={{ columns: true, density: true, export: true }}
      defaultSort={{ key: 'health', dir: 'asc' }}
    />
  )
}
