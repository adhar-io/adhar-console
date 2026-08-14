import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
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
  useCycles,
  useIssues,
  useMembers,
  useModules,
  useProject,
  useStates,
} from '../data/plane.ts'
import { ProjectMark } from './project-picker.tsx'
import { IssueDrawer } from './issue-drawer.tsx'

/**
 * Sliding per-project overview. Aggregates the project's issues, cycles,
 * modules and members into a single dashboard so the operator can see the
 * health of one project without bouncing between sub-tabs.
 *
 * Keeps the issue work list in-line and lets clicks open the IssueDrawer —
 * portal stacking ensures the issue drawer layers above this drawer.
 */
export function ProjectDetail({
  projectId,
  onClose,
  onSetActive,
}: {
  projectId: string
  onClose(): void
  onSetActive(id: string): void
}) {
  const project = useProject(projectId)
  const issues = useIssues(projectId)
  const cycles = useCycles(projectId)
  const modules = useModules(projectId)
  const states = useStates(projectId)
  const members = useMembers()
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
  const memberMap = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.member?.id ?? m.id, m])),
    [members.data],
  )

  const p = project.data
  const list = issues.data ?? []
  const open = list.filter((i) => !i.completed_at).length
  const done = list.filter((i) => !!i.completed_at).length
  const total = list.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const recent = list
    .slice()
    .sort(
      (a, b) =>
        new Date(b.updated_at ?? b.created_at).getTime() -
        new Date(a.updated_at ?? a.created_at).getTime(),
    )
    .slice(0, 8)
  const activeCycle = (cycles.data ?? []).find((c) => c.status === 'current')
  const activeModules = (modules.data ?? []).filter(
    (m) => m.status === 'in-progress' || m.status === 'planned',
  )
  const lead = p?.project_lead ? memberMap.get(p.project_lead) : undefined

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
          <div className="flex min-w-0 items-start gap-3">
            {p ? <ProjectMark project={p} /> : null}
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                Project
                {p ? (
                  <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
                    {p.identifier}
                  </span>
                ) : null}
              </div>
              <h2 className="mt-0.5 truncate text-lg font-semibold tracking-tight text-content">
                {p?.name ?? 'Project'}
              </h2>
              {p?.description ? (
                <p className="mt-1 max-w-2xl text-xs text-content-muted">{p.description}</p>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => onSetActive(projectId)}>
              Set as active
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
          {project.isLoading ? (
            <div className="flex items-center gap-2 rounded-xl border border-edge-default bg-surface-raised p-6 text-sm text-content-muted shadow-sm">
              <Spinner size={14} /> Loading project…
            </div>
          ) : project.isError ? (
            <EmptyState
              title="Couldn't load project"
              description={
                project.error instanceof Error ? project.error.message : 'Unknown error.'
              }
            />
          ) : (
            <>
              {/* hero stats */}
              <Card>
                <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <HeroStat label="Total" value={total} />
                  <HeroStat label="Open" value={open} tone="amber" />
                  <HeroStat label="Done" value={done} tone="emerald" />
                  <HeroStat label="% done" value={`${pct}%`} tone="brand" />
                </CardBody>
              </Card>

              {/* progress + people */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <CardHeader>
                    <div className="text-sm font-semibold text-content">Issue progress</div>
                    <div className="text-[11px] text-content-subtle">
                      Done / open distribution across this project
                    </div>
                  </CardHeader>
                  <CardBody>
                    <div className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-edge-subtle">
                      <div
                        className="h-full bg-linear-to-r from-brand-500 to-brand-400"
                        style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
                      />
                      <div
                        className="h-full bg-linear-to-r from-amber-400 to-amber-300"
                        style={{ width: `${total > 0 ? (open / total) * 100 : 0}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-content-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                        Done · {done}
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                        Open · {open}
                      </span>
                    </div>
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader>
                    <div className="text-sm font-semibold text-content">Team</div>
                    <div className="text-[11px] text-content-subtle">
                      {p?.total_members ?? 0} members
                    </div>
                  </CardHeader>
                  <CardBody className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-content-muted">
                      {lead ? (
                        <>
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-700 ring-1 ring-inset ring-brand-200">
                            {memberInitials(lead)}
                          </span>
                          <span>Lead · {memberDisplayName(lead)}</span>
                        </>
                      ) : (
                        <span>No lead assigned</span>
                      )}
                    </div>
                    <div className="text-[11px] text-content-subtle">
                      {p?.created_at ? `Created ${formatRelative(p.created_at)}` : null}
                    </div>
                  </CardBody>
                </Card>
              </div>

              {/* active cycle */}
              {activeCycle ? (
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold text-content">Active cycle</div>
                        <div className="text-[11px] text-content-subtle">
                          {activeCycle.name}
                        </div>
                      </div>
                      <StatusBadge kind="progressing">in progress</StatusBadge>
                    </div>
                  </CardHeader>
                  <CardBody>
                    <CycleProgressRow cycle={activeCycle} />
                  </CardBody>
                </Card>
              ) : null}

              {/* active modules */}
              {activeModules.length > 0 ? (
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold text-content">Active modules</div>
                      <StatusBadge kind="info">{activeModules.length}</StatusBadge>
                    </div>
                  </CardHeader>
                  <CardBody className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {activeModules.slice(0, 6).map((m) => (
                      <ModuleSnippet key={m.id} mod={m} />
                    ))}
                  </CardBody>
                </Card>
              ) : null}

              {/* recent issues */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-content">
                      Recent issues ({list.length})
                    </div>
                    {issues.isFetching ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-content-subtle">
                        <Spinner size={10} /> updating
                      </span>
                    ) : null}
                  </div>
                </CardHeader>
                <CardBody className="p-0">
                  {recent.length === 0 ? (
                    <EmptyState compact title="No issues in this project yet" />
                  ) : (
                    <ul className="divide-y divide-edge-subtle">
                      {recent.map((iss) => {
                        const st = stateMap.get(iss.state)
                        return (
                          <li key={iss.id}>
                            <button
                              type="button"
                              onClick={() => setOpenIssue(iss.id)}
                              className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-brand-50/40"
                            >
                              <code className="font-mono text-[11px] text-content-muted">
                                #{iss.sequence_id ?? '—'}
                              </code>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-content">
                                  {iss.name}
                                </div>
                                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-content-muted">
                                  {st ? (
                                    <span className="inline-flex items-center gap-1">
                                      <span
                                        className="h-1.5 w-1.5 rounded-full"
                                        style={{ backgroundColor: st.color }}
                                      />
                                      {st.name}
                                    </span>
                                  ) : null}
                                  <span>· {formatRelative(iss.updated_at ?? iss.created_at)}</span>
                                </div>
                              </div>
                              <StatusBadge kind={priorityKind(iss.priority)} dot={false}>
                                {iss.priority}
                              </StatusBadge>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </CardBody>
              </Card>
            </>
          )}
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

function HeroStat({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: number | string
  tone?: 'slate' | 'amber' | 'emerald' | 'brand'
}) {
  const text =
    tone === 'amber'
      ? 'text-amber-700'
      : tone === 'emerald'
        ? 'text-emerald-700'
        : tone === 'brand'
          ? 'text-brand-700'
          : 'text-content'
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
      <div className={`text-2xl font-semibold tabular-nums ${text}`}>{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">
        {label}
      </div>
    </div>
  )
}

function CycleProgressRow({ cycle }: { cycle: plane.Cycle }) {
  const total = cycle.total_issues ?? 0
  const done = cycle.completed_issues ?? 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-content">
          {done} / {total} issues complete
        </span>
        <span className="text-base font-semibold tabular-nums text-content">{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full bg-linear-to-r from-brand-500 to-brand-400 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[11px] text-content-subtle">
        {cycle.start_date && cycle.end_date
          ? `${new Date(cycle.start_date).toLocaleDateString()} → ${new Date(cycle.end_date).toLocaleDateString()}`
          : '—'}
      </div>
    </div>
  )
}

function ModuleSnippet({ mod }: { mod: plane.Module }) {
  const total = mod.total_issues ?? 0
  const done = mod.completed_issues ?? 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="rounded-lg border border-edge-subtle bg-surface-sunken/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-content">{mod.name}</span>
        <span className="text-[11px] tabular-nums text-content-muted">{pct}%</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className="h-full bg-linear-to-r from-brand-500 to-brand-400 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
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
