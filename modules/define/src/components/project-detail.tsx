import { useMemo, useState } from 'react'
import { Button, EmptyState, StatusBadge, Tabs } from '@adhar/shell-ui'
import { formatRelative } from '@adhar/utils'
import { useCycles, useLabels, useModules, useProject, useProjectSummary } from '../data/plane.ts'
import { usePlanIssues } from '../data/planning-plane.ts'
import { useProjectMeta } from '../data/planning-store.ts'
import { daysLeft, deriveHealth, effectiveHealth, isBugLabel, isOpen, isOverdue, toMs } from '../data/planning-model.ts'
import { usePlanningParams, useSetPlanningParams } from '../data/planning-nav.ts'
import { LabelsTab, ProjectArchive, ProjectFeatures, ProjectMembersTab, WorkflowTab } from './project-admin.tsx'
import { EstimatesTab, HealthOverrideForm, NotificationsTab, ProjectDetailsForm, TenancyLink } from './project-settings.tsx'
import { AutomationEditor } from './automation-editor.tsx'
import { ProjectMark } from './project-picker.tsx'
import { IssueDrawer } from './issue-drawer.tsx'
import { AvatarStack, HealthBadge, Loading, Meter, ProblemState, SectionTitle, SidePanel, Stat, usePeople } from './planning-ui.tsx'

/**
 * Project drawer — overview (health, progress, sprint, epics, bugs, recent
 * activity) and every project setting: members, workflow (states +
 * transition rules), labels, estimates, automation, notifications, details,
 * tenancy link, features and archive.
 */

type Tab = 'overview' | 'members' | 'workflow' | 'labels' | 'estimates' | 'automation' | 'notifications' | 'settings'
const TABS: Tab[] = ['overview', 'members', 'workflow', 'labels', 'estimates', 'automation', 'notifications', 'settings']

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
  const summary = useProjectSummary(projectId)
  const params = usePlanningParams()
  const setParams = useSetPlanningParams()
  const [localTab, setLocalTab] = useState<Tab>(() => (TABS.includes(params.ptab as Tab) ? params.ptab as Tab : 'overview'))
  const linked = params.pd === projectId
  const tab = linked && TABS.includes(params.ptab as Tab) ? params.ptab as Tab : localTab
  const setTab = (t: Tab) => {
    setLocalTab(t)
    if (linked) setParams({ ptab: t === 'overview' ? undefined : t })
  }
  const p = project.data

  return (
    <SidePanel
      onClose={onClose}
      eyebrow={
        <>
          Project
          {p ? <span className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-muted">{p.identifier}</span> : null}
          {p?.archived_at ? <StatusBadge kind="paused">archived</StatusBadge> : null}
        </>
      }
      title={<span className="inline-flex items-center gap-2">{p ? <ProjectMark project={p} /> : null}{p?.name ?? 'Project'}</span>}
      meta={p?.description || undefined}
      actions={<Button size="sm" onClick={() => onSetActive(projectId)}>Set as active</Button>}
    >
      {project.isLoading ? <Loading label="Loading project…" /> : project.isError ? <ProblemState error={project.error} onRetry={() => project.refetch()} /> : !p ? null : (
        <Tabs
          ariaLabel="Project"
          value={tab}
          onChange={(t) => setTab(t as Tab)}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'members', label: 'Members', badge: summary.data?.counts.members ? { kind: 'unknown', value: summary.data.counts.members } : undefined },
            { id: 'workflow', label: 'Workflow' },
            { id: 'labels', label: 'Labels' },
            { id: 'estimates', label: 'Estimates' },
            { id: 'automation', label: 'Automation' },
            { id: 'notifications', label: 'Notifications' },
            { id: 'settings', label: 'Settings' },
          ]}
        >
          {(active) => (
            <div className="pt-4">
              {active === 'members'
                ? <ProjectMembersTab projectId={projectId} />
                : active === 'workflow'
                ? <WorkflowTab projectId={projectId} />
                : active === 'labels'
                ? <LabelsTab projectId={projectId} />
                : active === 'estimates'
                ? <EstimatesTab projectId={projectId} />
                : active === 'automation'
                ? <AutomationEditor projectId={projectId} />
                : active === 'notifications'
                ? <NotificationsTab projectId={projectId} />
                : active === 'settings'
                ? (
                  <div className="space-y-8">
                    <ProjectDetailsForm project={p} />
                    <TenancyLink project={p} />
                    <HealthOverrideForm projectId={projectId} />
                    <section className="space-y-1">
                      <h3 className="text-[14px] font-semibold text-content">Work item types and templates</h3>
                      <p className="text-[12px] text-content-muted">Templates for new work items (bug, story, task) are managed from the Issues page's new-item dialog.</p>
                    </section>
                    <ProjectFeatures project={p} />
                    <ProjectArchive project={p} onArchived={onClose} />
                  </div>
                )
                : <Overview projectId={projectId} />}
            </div>
          )}
        </Tabs>
      )}
    </SidePanel>
  )
}

function Overview({ projectId }: { projectId: string }) {
  const issues = usePlanIssues(projectId)
  const cycles = useCycles(projectId)
  const modules = useModules(projectId)
  const labels = useLabels(projectId)
  const meta = useProjectMeta(projectId)
  const { people } = usePeople()
  const [openIssue, setOpenIssue] = useState<string | null>(null)

  const data = useMemo(() => {
    const list = (issues.data ?? []).filter((i) => i.state_group !== 'cancelled')
    const done = list.filter((i) => i.state_group === 'completed').length
    const open = list.filter(isOpen)
    const bugIds = new Set((labels.data ?? []).filter((l) => isBugLabel(l.name)).map((l) => l.id))
    const active = (cycles.data ?? []).find((c) => c.status === 'current')
    const derived = deriveHealth({
      items: list,
      activeSprint: active ? { start_date: active.start_date, end_date: active.end_date, total: (active.total_issues ?? 0) - (active.cancelled_issues ?? 0), done: active.completed_issues ?? 0 } : undefined,
    })
    const recent = [...(issues.data ?? [])].sort((a, b) => (toMs(b.updated_at ?? b.created_at) ?? 0) - (toMs(a.updated_at ?? a.created_at) ?? 0)).slice(0, 8)
    return {
      total: list.length,
      done,
      open: open.length,
      overdue: open.filter((i) => isOverdue(i)).length,
      bugs: open.filter((i) => i.labels.some((l) => bugIds.has(l))).length,
      inProgress: open.filter((i) => i.state_group === 'started').length,
      active,
      derived,
      recent,
    }
  }, [issues.data, cycles.data, labels.data])

  if (issues.isLoading) return <Loading label="Loading work items…" />
  if (issues.isError) return <ProblemState error={issues.error} onRetry={() => issues.refetch()} />
  const eff = effectiveHealth(data.derived, meta.data?.healthOverride)
  const epics = (modules.data ?? []).filter((m) => m.status === 'in-progress' || m.status === 'planned')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <HealthBadge health={eff.health} overridden={eff.overridden} />
        <span className="text-[12px] text-content-muted">{eff.reasons.join(' · ')}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Work items" value={data.total} />
        <Stat label="Done" value={data.done} hint={data.total ? `${Math.round((data.done / data.total) * 100)}%` : undefined} />
        <Stat label="In progress" value={data.inProgress} />
        <Stat label="Open" value={data.open} />
        <Stat label="Overdue" value={data.overdue} tone={data.overdue ? 'warn' : undefined} />
        <Stat label="Open bugs" value={data.bugs} tone={data.bugs ? 'warn' : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle>Active sprint</SectionTitle>
          {data.active
            ? (
              <div className="space-y-2 rounded-xl border border-edge-default bg-surface-raised p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-semibold text-content">{data.active.name}</span>
                  <span className="text-[12px] tabular-nums text-content-muted">{daysLeft(data.active.end_date) ?? '—'}d left</span>
                </div>
                <Meter value={data.active.progress ?? 0} label="Sprint progress" />
                <div className="text-[12px] text-content-muted">{data.active.completed_issues ?? 0} of {(data.active.total_issues ?? 0) - (data.active.cancelled_issues ?? 0)} done</div>
              </div>
            )
            : <p className="text-[12px] text-content-subtle">No sprint is running.</p>}
        </section>
        <section>
          <SectionTitle>Epics in flight · {epics.length}</SectionTitle>
          {epics.length
            ? (
              <ul className="space-y-2">
                {epics.slice(0, 5).map((m) => {
                  const total = (m.total_issues ?? 0) - (m.cancelled_issues ?? 0)
                  const pct = total ? Math.round(((m.completed_issues ?? 0) / total) * 100) : 0
                  return (
                    <li key={m.id} className="rounded-lg border border-edge-subtle px-3 py-2">
                      <div className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="truncate font-medium text-content">{m.name}</span>
                        <span className="tabular-nums text-content-muted">{pct}%</span>
                      </div>
                      <Meter value={pct} className="mt-1" label={`${m.name} progress`} />
                    </li>
                  )
                })}
              </ul>
            )
            : <p className="text-[12px] text-content-subtle">No epics planned or in progress.</p>}
        </section>
      </div>

      <section>
        <SectionTitle>Recently updated</SectionTitle>
        {data.recent.length
          ? (
            <ul className="divide-y divide-edge-subtle overflow-hidden rounded-xl border border-edge-default bg-surface-raised">
              {data.recent.map((i) => (
                <li key={i.id}>
                  <button type="button" onClick={() => setOpenIssue(i.id)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-sunken/60">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: i.state_color ?? 'var(--color-edge-strong)' }} title={i.state_name} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-content">{i.name}</span>
                    <AvatarStack ids={i.assignees} people={people} max={2} size={18} />
                    <span className="hidden shrink-0 text-[11px] text-content-subtle sm:inline">{formatRelative(i.updated_at ?? i.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
          : <EmptyState compact title="No work items yet" />}
      </section>
      {openIssue ? <IssueDrawer projectId={projectId} issueId={openIssue} onClose={() => setOpenIssue(null)} onPick={setOpenIssue} /> : null}
    </div>
  )
}
