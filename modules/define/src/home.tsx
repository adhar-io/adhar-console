import { useEffect, useState } from 'react'
import { EmptyState, PageHeader, Spinner, StatusBadge, useIntegration } from '@adhar/shell-ui'
import { Dashboard } from './views/dashboard.tsx'
import { Projects } from './views/projects.tsx'
import { Issues } from './views/issues.tsx'
import { Intake } from './views/intake.tsx'
import { Cycles } from './views/cycles.tsx'
import { Okrs } from './views/okrs.tsx'
import { Modules } from './views/modules.tsx'
import { Pages } from './views/pages.tsx'
import { Views } from './views/views.tsx'
import { Board } from './views/board.tsx'
import { Backlog } from './views/backlog.tsx'
import { Roadmap } from './views/roadmap.tsx'
import { Members } from './views/members.tsx'
import { MyWork } from './views/my-work.tsx'
import { Reports } from './views/reports.tsx'
import { Releases } from './views/releases.tsx'
import { Automation } from './views/automation.tsx'
import { ProjectPicker } from './components/project-picker.tsx'
import { ProjectDetail } from './components/project-detail.tsx'
import {
  getStoredProjectId,
  setStoredProjectId,
  useProject,
  useProjects,
} from './data/plane.ts'
import type { SavedIssueQuery } from './data/view-query.ts'

type Section =
  | 'dashboard'
  | 'projects'
  | 'issues'
  | 'intake'
  | 'cycles'
  | 'modules'
  | 'pages'
  | 'views'
  | 'roadmap'
  | 'okrs'
  | 'members'
  | 'board'
  | 'backlog'
  | 'my-work'
  | 'reports'
  | 'releases'
  | 'automation'

const SECTIONS: Record<Section, { label: string; description: string }> = {
  dashboard: {
    label: 'Dashboard',
    description: 'Workspace-wide pulse — counts, recent activity, top projects.',
  },
  projects: {
    label: 'Projects',
    description: 'Portfolio — health, progress, active sprint, open bugs and leads for every project, scoped to your team.',
  },
  board: {
    label: 'Board',
    description: 'Kanban by workflow state — swimlanes, WIP limits, drag to change status or rank.',
  },
  backlog: {
    label: 'Backlog',
    description: 'Rank the backlog and plan sprints (Plane cycles) against capacity.',
  },
  issues: {
    label: 'Issues',
    description: 'Query work items with WQL, edit inline, bulk-update and export. Backed by Plane.',
  },
  intake: {
    label: 'Intake',
    description: 'Triage queue — accept, decline, snooze or merge incoming requests before they reach the backlog.',
  },
  cycles: {
    label: 'Sprints',
    description: 'Plane cycles as sprints — goals, capacity, burndown, start and complete with carry-over, velocity.',
  },
  modules: {
    label: 'Epics',
    description: 'Plane modules as epics — progress, target dates, leads, burnup, linked OKRs and releases.',
  },
  releases: {
    label: 'Releases',
    description: 'Versions that ship together — dates, progress, burndown and generated release notes.',
  },
  automation: {
    label: 'Automation',
    description: 'Console-side rules — when work moves or a pull request merges, update it.',
  },
  pages: {
    label: 'Pages',
    description: 'Workspace wiki — runbooks, ADRs, design notes, onboarding copy.',
  },
  views: {
    label: 'Saved Views',
    description: 'Per-project filter bookmarks shared across the team.',
  },
  roadmap: {
    label: 'Roadmap',
    description: 'Timeline of epics and work items across projects — drag to reschedule, dependencies, milestones.',
  },
  okrs: {
    label: 'OKRs',
    description: 'Objectives and their key results — progress rolls up per quarter with pace-aware status.',
  },
  members: {
    label: 'Members',
    description: 'Workload and capacity across projects, availability, the workspace directory and invitations.',
  },
  'my-work': {
    label: 'My Work',
    description: 'Your inbox — assigned, due this week, mentions, watching and recently viewed, across projects.',
  },
  reports: {
    label: 'Reports',
    description: 'Burndown, burnup, velocity, cumulative flow, control chart, created vs resolved and more.',
  },
}

const PROJECT_SCOPED: Set<Section> = new Set([
  'issues',
  'intake',
  'cycles',
  'modules',
  'pages',
  'views',
  'board',
  'backlog',
  'roadmap',
  'okrs',
  'reports',
  'releases',
  'automation',
])

export default function DefineHome({ section }: { section?: string } = {}) {
  const routeSection = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section

  const [activeProjectId, setActiveProjectIdState] = useState<string | undefined>(undefined)
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  // In-module navigation override — e.g. opening a Saved View jumps to Issues
  // with its filter set applied, without a URL round-trip.
  const [sectionOverride, setSectionOverride] = useState<Section | null>(null)
  const [appliedIssueQuery, setAppliedIssueQuery] = useState<SavedIssueQuery | undefined>(undefined)

  // A real navigation (URL `section` change) clears any local override.
  useEffect(() => {
    setSectionOverride(null)
  }, [section])

  const active = sectionOverride ?? routeSection
  const def = SECTIONS[active]
  const projects = useProjects()

  // First mount — restore from localStorage; fall back to first project once
  // the projects query lands.
  useEffect(() => {
    setActiveProjectIdState((cur) => cur ?? getStoredProjectId())
  }, [])
  useEffect(() => {
    if (!activeProjectId && projects.data?.length) {
      const stored = getStoredProjectId()
      const fallback =
        stored && projects.data.some((p) => p.id === stored) ? stored : projects.data[0].id
      setActiveProjectIdState(fallback)
    }
  }, [activeProjectId, projects.data])

  // Deep links (`?project=<id>`, e.g. a dashboard drill-down) pick the project.
  useEffect(() => {
    if (typeof location === 'undefined') return
    const wanted = new URLSearchParams(location.search).get('project')?.replace(/^"|"$/g, '')
    if (wanted && wanted !== activeProjectId && projects.data?.some((p) => p.id === wanted)) {
      setActiveProjectIdState(wanted)
      setStoredProjectId(wanted)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, projects.data])

  const setActiveProjectId = (id: string) => {
    setActiveProjectIdState(id)
    setStoredProjectId(id)
  }

  const project = useProject(activeProjectId)
  const projectScoped = PROJECT_SCOPED.has(active)
  const switching = projectScoped && project.isFetching && !project.data
  const connected = useIntegration('plane')

  if (connected === false) {
    return (
      <div className="space-y-6">
        <PageHeader title={def.label} />
        <EmptyState
          title="Plane isn't connected to this console"
          description="The console has no Plane API key. Plane's setup job writes one (PLANE_URL, PLANE_TOKEN, PLANE_WORKSPACE) into the plane-api-token Secret and restarts the console; re-sync the Plane application in Argo CD, or ask an operator to check that job's logs."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          projectScoped ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ProjectPicker value={activeProjectId} onChange={setActiveProjectId} align="left" />
              <span className="text-content-subtle" aria-hidden>
                /
              </span>
              <span>{def.label}</span>
              {switching ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-normal text-content-subtle">
                  <Spinner size={10} /> Loading…
                </span>
              ) : null}
            </span>
          ) : (
            def.label
          )
        }
        badge={
          active === 'members' && projects.data ? (
            <StatusBadge kind="info">{projects.data.length} workspace projects</StatusBadge>
          ) : null
        }
      />
      {active === 'dashboard' && (
        <Dashboard projectId={activeProjectId} onOpenProject={(id) => setOpenProjectId(id)} onPickProject={setActiveProjectId} />
      )}
      {active === 'my-work' && <MyWork />}
      {active === 'reports' && <Reports projectId={activeProjectId} />}
      {active === 'projects' && (
        <Projects
          activeId={activeProjectId}
          onPick={setActiveProjectId}
          onOpenDetails={(id) => setOpenProjectId(id)}
        />
      )}
      {active === 'issues' && (
        <Issues projectId={activeProjectId} appliedQuery={appliedIssueQuery} />
      )}
      {active === 'board' && <Board projectId={activeProjectId} />}
      {active === 'backlog' && <Backlog projectId={activeProjectId} />}
      {active === 'intake' && <Intake projectId={activeProjectId} />}
      {active === 'cycles' && <Cycles projectId={activeProjectId} />}
      {active === 'modules' && <Modules projectId={activeProjectId} />}
      {active === 'pages' && <Pages projectId={activeProjectId} />}
      {active === 'views' && (
        <Views
          projectId={activeProjectId}
          onApply={(query) => {
            setAppliedIssueQuery(query)
            setSectionOverride('issues')
          }}
        />
      )}
      {active === 'roadmap' && <Roadmap projectId={activeProjectId} />}
      {active === 'okrs' && <Okrs projectId={activeProjectId} />}
      {active === 'members' && <Members />}
      {active === 'releases' && <Releases projectId={activeProjectId} />}
      {active === 'automation' && <Automation projectId={activeProjectId} />}
      {openProjectId ? (
        <ProjectDetail
          projectId={openProjectId}
          onClose={() => setOpenProjectId(null)}
          onSetActive={(id) => {
            setActiveProjectId(id)
            setOpenProjectId(null)
          }}
        />
      ) : null}
    </div>
  )
}
