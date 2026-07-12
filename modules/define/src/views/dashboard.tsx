import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
  StatusBadge,
} from '@adhar-console/shell-ui'
import { formatRelative } from '@adhar-console/utils'
import {
  memberDisplayName,
  memberInitials,
  useMembers,
  useProjects,
} from '../data/plane.ts'
import { ProjectMark } from '../components/project-picker.tsx'

/**
 * Workspace-level Define dashboard. Aggregates the cheap-to-fetch lists
 * (projects, members) into hero counters + recent-activity feeds. We avoid
 * fanning out N queries (one per project) here — per-project drilldown
 * lives in the per-project ProjectDetail drawer.
 */
export function Dashboard({
  onOpenProject,
  onPickProject,
}: {
  onOpenProject(id: string): void
  onPickProject(id: string): void
}) {
  const projectsQ = useProjects()
  const membersQ = useMembers()

  if (projectsQ.isLoading || membersQ.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-white p-6 text-sm text-content-muted shadow-sm">
        <Spinner size={14} /> Loading workspace…
      </div>
    )
  }
  if (projectsQ.isError) {
    return (
      <EmptyState
        title="Couldn't reach Plane"
        description={
          projectsQ.error instanceof Error ? projectsQ.error.message : 'Unknown error.'
        }
      />
    )
  }

  const projects = projectsQ.data ?? []
  const members = membersQ.data ?? []
  const totalCycles = projects.reduce((acc, p) => acc + (p.total_cycles ?? 0), 0)
  const totalModules = projects.reduce((acc, p) => acc + (p.total_modules ?? 0), 0)
  const totalProjectMembers = projects.reduce((acc, p) => acc + (p.total_members ?? 0), 0)
  const admins = members.filter((m) => m.role === 5).length

  // Top by raw activity = sum of cycles + modules; recency drives "recent".
  const top = projects
    .slice()
    .sort(
      (a, b) =>
        (b.total_cycles ?? 0) +
        (b.total_modules ?? 0) -
        ((a.total_cycles ?? 0) + (a.total_modules ?? 0)),
    )
    .slice(0, 5)
  const recent = projects
    .slice()
    .sort(
      (a, b) =>
        new Date(b.updated_at ?? b.created_at ?? 0).getTime() -
        new Date(a.updated_at ?? a.created_at ?? 0).getTime(),
    )
    .slice(0, 6)

  return (
    <div className="space-y-6">
      {/* hero stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HeroStat
          label="Projects"
          value={projects.length}
          tone="brand"
          icon={<IconFolder />}
          hint={`${totalProjectMembers} project memberships`}
        />
        <HeroStat
          label="Cycles"
          value={totalCycles}
          tone="amber"
          icon={<IconCircle />}
          hint="across all projects"
        />
        <HeroStat
          label="Modules"
          value={totalModules}
          tone="emerald"
          icon={<IconCheck />}
          hint="epic-shaped groupings"
        />
        <HeroStat
          label="Members"
          value={members.length}
          tone="violet"
          icon={<IconUsers />}
          hint={`${admins} admin${admins === 1 ? '' : 's'}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* top projects */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Top projects</div>
                <div className="text-[11px] text-content-subtle">By total issue volume</div>
              </div>
              <StatusBadge kind="info">{top.length}</StatusBadge>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            {top.length === 0 ? (
              <EmptyState compact title="No projects yet" />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {top.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onPickProject(p.id)
                        onOpenProject(p.id)
                      }}
                      className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-brand-50/40"
                    >
                      <ProjectMark project={p} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-content">
                            {p.name}
                          </span>
                          <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] font-semibold text-content-muted">
                            {p.identifier}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-content-subtle">
                          {p.total_cycles ?? 0} cycle{p.total_cycles === 1 ? '' : 's'} ·{' '}
                          {p.total_modules ?? 0} module{p.total_modules === 1 ? '' : 's'} ·{' '}
                          {p.total_members ?? 0} member{p.total_members === 1 ? '' : 's'}
                        </div>
                      </div>
                      <span className="hidden text-[11px] text-content-subtle sm:inline">
                        Open →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* recent activity */}
        <Card>
          <CardHeader>
            <div className="text-sm font-semibold text-content">Recent updates</div>
            <div className="text-[11px] text-content-subtle">Most recently touched projects</div>
          </CardHeader>
          <CardBody className="p-0">
            {recent.length === 0 ? (
              <EmptyState compact title="No activity" />
            ) : (
              <ul className="divide-y divide-edge-subtle">
                {recent.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onPickProject(p.id)
                        onOpenProject(p.id)
                      }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-brand-50/40"
                    >
                      <ProjectMark project={p} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-content">{p.name}</div>
                        <div className="text-[11px] text-content-subtle">
                          {formatRelative(p.updated_at ?? p.created_at ?? new Date().toISOString())}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* admins / leads strip */}
      {members.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-content">Workspace admins</div>
                <div className="text-[11px] text-content-subtle">
                  Role 5 · can manage every project
                </div>
              </div>
              <StatusBadge kind="info">{admins}</StatusBadge>
            </div>
          </CardHeader>
          <CardBody>
            <div className="flex flex-wrap gap-3">
              {members
                .filter((m) => m.role === 5)
                .map((m) => (
                  <span
                    key={m.id}
                    className="inline-flex items-center gap-2 rounded-full border border-edge-subtle bg-surface-sunken/60 px-2.5 py-1"
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
                      {memberInitials(m)}
                    </span>
                    <span className="text-xs font-medium text-content">
                      {memberDisplayName(m)}
                    </span>
                  </span>
                ))}
              {admins === 0 ? (
                <span className="text-xs text-content-subtle">No admins assigned.</span>
              ) : null}
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  )
}

function HeroStat({
  label,
  value,
  tone,
  icon,
  hint,
}: {
  label: string
  value: number
  tone: 'brand' | 'amber' | 'emerald' | 'violet'
  icon: React.ReactNode
  hint?: string
}) {
  const toneClass = {
    brand: 'from-brand-50 to-white text-brand-700',
    amber: 'from-amber-50 to-white text-amber-700',
    emerald: 'from-emerald-50 to-white text-emerald-700',
    violet: 'from-violet-50 to-white text-violet-700',
  }[tone]
  return (
    <Card className={`relative overflow-hidden bg-linear-to-br ${toneClass} ring-1 ring-inset ring-edge-subtle`}>
      <CardBody className="space-y-1 p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/80 shadow-sm">
            {icon}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-content-subtle">
            {label}
          </span>
        </div>
        <div className="text-3xl font-semibold tabular-nums tracking-tight text-content">
          {value}
        </div>
        {hint ? <div className="text-[11px] text-content-muted">{hint}</div> : null}
      </CardBody>
    </Card>
  )
}

function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}
function IconCircle() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}
function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
function IconUsers() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}
