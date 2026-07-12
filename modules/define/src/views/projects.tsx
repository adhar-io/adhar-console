import { useState } from 'react'
import {
  Button,
  Card,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  memberDisplayName,
  useDeleteProject,
  useIssues,
  useMembers,
  useProjects,
} from '../data/plane.ts'
import { ProjectMark } from '../components/project-picker.tsx'
import { CreateProjectModal } from '../components/create-forms.tsx'

/**
 * Projects landing — every Plane workspace project gets a card with live
 * issue counts, recent-activity sparkline (synthesised from creation rhythm),
 * lead avatar, and quick-stats. Click → switches the active project (handled
 * upstream by `home.tsx`).
 */

interface Props {
  activeId?: string
  onPick(id: string): void
  onOpenDetails?(id: string): void
}

export function Projects({ activeId, onPick, onOpenDetails }: Props) {
  const projects = useProjects()
  const members = useMembers()
  const remove = useDeleteProject()
  const [createOpen, setCreateOpen] = useState(false)

  if (projects.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading projects…
      </div>
    )
  }
  if (projects.isError) {
    return (
      <EmptyState
        title="Couldn't reach Plane"
        description={projects.error instanceof Error ? projects.error.message : 'Unknown error.'}
      />
    )
  }
  const rows = projects.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-content-muted">
          {rows.length} project{rows.length === 1 ? '' : 's'} in this workspace
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)} leading={<IconPlus />}>
          New project
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Click New project to scaffold the first one."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              active={p.id === activeId}
              onPick={() => onPick(p.id)}
              onOpenDetails={() => onOpenDetails?.(p.id)}
              memberLookup={(id) => members.data?.find((m) => m.member?.id === id)}
              onDelete={() => {
                if (
                  !confirm(
                    `Delete "${p.name}"? Issues, cycles, modules, and pages will be archived.`,
                  )
                )
                  return
                remove.mutate(p.id)
              }}
            />
          ))}
        </div>
      )}

      <CreateProjectModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(p) => onPick(p.id)}
      />
    </div>
  )
}

function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function ProjectCard({
  project,
  active,
  onPick,
  onOpenDetails,
  memberLookup,
  onDelete,
}: {
  project: ReturnType<typeof useProjects>['data'] extends (infer T)[] | undefined ? T : never
  active: boolean
  onPick(): void
  onOpenDetails(): void
  memberLookup(
    id: string | null | undefined,
  ): ReturnType<typeof useMembers>['data'] extends (infer T)[] | undefined ? T | undefined : undefined
  onDelete(): void
}) {
  const issues = useIssues(project.id)
  const list = issues.data ?? []
  const open = list.filter((i) => !i.completed_at).length
  const done = list.filter((i) => !!i.completed_at).length
  const total = list.length
  const closedPct = total > 0 ? Math.round((done / total) * 100) : 0

  // 14-day "issues created" histogram drives the activity bar chart.
  const series = (() => {
    const now = Date.now()
    const buckets = new Array(14).fill(0)
    for (const i of list) {
      const t = new Date(i.created_at).getTime()
      const idx = 13 - Math.floor((now - t) / 86_400_000)
      if (idx >= 0 && idx < 14) buckets[idx] += 1
    }
    return buckets
  })()

  const lead = memberLookup(project.project_lead)
  return (
    <Card
      interactive
      className={cardClass(active)}
    >
      <button
        type="button"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('[data-card-action]')) return
          onOpenDetails()
        }}
        className="block w-full p-5 text-left"
        aria-pressed={active}
      >
        {/* hero header */}
        <div className="flex items-start gap-3">
          <ProjectMark project={project} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold text-content">{project.name}</span>
              {active ? <StatusBadge kind="healthy">active</StatusBadge> : null}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-mono font-semibold uppercase tracking-wider text-content-subtle">
              <span className="rounded-md bg-surface-sunken px-1.5 py-0.5">
                {project.identifier}
              </span>
              <span>·</span>
              <span>{project.total_members ?? 0} members</span>
            </div>
            {project.description ? (
              <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-content-muted">
                {project.description}
              </p>
            ) : null}
          </div>
        </div>

        {/* progress hero — ring + breakdown bar */}
        <div className="mt-4 flex items-center gap-4 rounded-xl border border-edge-subtle bg-gradient-to-br from-brand-50/50 via-white to-white p-4">
          <ProgressRing pct={closedPct} loading={issues.isLoading} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-2xl font-semibold tabular-nums text-content">{done}</span>
              <span className="text-xs text-content-muted">
                of {total} {total === 1 ? 'issue' : 'issues'} closed
              </span>
            </div>
            <BreakdownBar done={done} open={open} />
            <div className="mt-1.5 flex items-center gap-3 text-[11px] text-content-muted">
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                {done} done
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                {open} open
              </span>
            </div>
          </div>
        </div>

        {/* activity bar chart */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-content-subtle">
              Activity · last 14 days
            </span>
            <span className="text-[11px] tabular-nums text-content-muted">
              {series.reduce((a, b) => a + b, 0)} created
            </span>
          </div>
          <ActivityBars points={series} />
        </div>

        {/* footer */}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-edge-subtle pt-3 text-[11px] text-content-muted">
          {lead ? (
            <span className="inline-flex items-center gap-2 truncate">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
                {memberDisplayName(lead).slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate">Lead · {memberDisplayName(lead)}</span>
            </span>
          ) : (
            <span>No lead assigned</span>
          )}
          <span className="shrink-0 text-content-subtle">
            {project.created_at ? formatRelative(project.created_at) : null}
          </span>
        </div>
      </button>
      <div className="absolute right-3 top-3 flex items-center gap-1">
        {!active ? (
          <button
            type="button"
            data-card-action
            onClick={(e) => {
              e.stopPropagation()
              onPick()
            }}
            aria-label={`Set ${project.name} as active`}
            className="rounded-md border border-edge-default bg-white/90 px-2 py-1 text-[11px] font-medium text-content opacity-0 shadow-sm transition-all hover:border-brand-400 hover:text-brand-700 group-hover:opacity-100 focus-visible:opacity-100"
          >
            Set active
          </button>
        ) : null}
        <ProjectCardDeleteButton onDelete={onDelete} projectName={project.name} />
      </div>
    </Card>
  )
}

function ProjectCardDeleteButton({
  onDelete,
  projectName,
}: {
  onDelete(): void
  projectName: string
}) {
  return (
    <button
      type="button"
      data-card-action
      onClick={(e) => {
        e.stopPropagation()
        onDelete()
      }}
      aria-label={`Delete ${projectName}`}
      className="flex h-7 w-7 items-center justify-center rounded-md text-content-subtle opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 focus-visible:opacity-100"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      </svg>
    </button>
  )
}

function cardClass(active: boolean) {
  return [
    'group relative overflow-hidden transition-all duration-200',
    active
      ? 'ring-2 ring-brand-400/50 ring-offset-2 ring-offset-surface-app'
      : 'hover:-translate-y-0.5 hover:shadow-md',
  ].join(' ')
}

/**
 * Conic-gradient progress ring with the % rendered in the donut hole. No
 * SVG path math, no chart lib — just a CSS gradient under a centered chip.
 */
function ProgressRing({ pct, loading }: { pct: number; loading: boolean }) {
  const angle = Math.min(360, Math.max(0, pct * 3.6))
  return (
    <div
      className="relative h-16 w-16 shrink-0 rounded-full"
      style={{
        backgroundImage: loading
          ? 'conic-gradient(var(--color-edge-subtle) 0deg, var(--color-surface-sunken) 360deg)'
          : `conic-gradient(var(--color-brand-500) 0deg, var(--color-brand-400) ${angle}deg, var(--color-surface-sunken) ${angle}deg, var(--color-surface-sunken) 360deg)`,
      }}
      aria-label={loading ? 'Loading progress' : `${pct}% complete`}
    >
      <div className="absolute inset-1.5 flex items-center justify-center rounded-full bg-white shadow-inner">
        {loading ? (
          <Spinner size={12} />
        ) : (
          <div className="text-center leading-none">
            <div className="text-sm font-semibold tabular-nums text-content">{pct}%</div>
            <div className="mt-0.5 text-[8px] font-semibold uppercase tracking-wider text-content-subtle">
              done
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function BreakdownBar({ done, open }: { done: number; open: number }) {
  const total = done + open
  if (total === 0) {
    return (
      <div className="mt-2 flex h-2 items-center justify-center rounded-full bg-surface-sunken text-[10px] text-content-subtle" />
    )
  }
  const donePct = (done / total) * 100
  const openPct = 100 - donePct
  return (
    <div
      className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle"
      role="progressbar"
      aria-valuenow={donePct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-gradient-to-r from-brand-500 to-brand-400 transition-[width] duration-500"
        style={{ width: `${donePct}%` }}
      />
      <div
        className="h-full bg-gradient-to-r from-amber-400 to-amber-300 transition-[width] duration-500"
        style={{ width: `${openPct}%` }}
      />
    </div>
  )
}

/**
 * 14-bar histogram of recent issue creation. Empty days drop to a thin
 * baseline so the chart still reads as a row even with sparse data.
 */
function ActivityBars({ points }: { points: number[] }) {
  const max = Math.max(1, ...points)
  return (
    <div className="flex h-10 items-end gap-[3px]">
      {points.map((p, i) => {
        const h = max > 0 ? (p / max) * 100 : 0
        const empty = p === 0
        return (
          <div
            key={i}
            className="group/bar relative flex-1"
            style={{ height: '100%' }}
            title={`${i === 13 ? 'today' : `${13 - i}d ago`}: ${p} created`}
          >
            <div
              className={
                empty
                  ? 'absolute bottom-0 left-0 right-0 h-[3px] rounded-full bg-edge-subtle'
                  : 'absolute bottom-0 left-0 right-0 rounded-md bg-gradient-to-t from-brand-500 to-brand-300 shadow-[0_1px_0_rgba(255,255,255,0.4)_inset] transition-all group-hover/bar:from-brand-600 group-hover/bar:to-brand-400'
              }
              style={empty ? undefined : { height: `${Math.max(8, h)}%` }}
            />
          </div>
        )
      })}
    </div>
  )
}
