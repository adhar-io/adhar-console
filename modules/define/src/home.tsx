import { lazy, Suspense, useEffect, useState } from 'react'
import { EmptyIcon } from './components/empty-icon.tsx'
import { Button, EmptyState, PageHeader, Spinner, useIntegration } from '@adhar/shell-ui'
import { ProjectPicker } from './components/project-picker.tsx'
import {
  getStoredProjectId,
  planeError,
  setStoredProjectId,
  useProject,
  useProjects,
} from './data/plane.ts'
import type { SavedIssueQuery } from './data/view-query.ts'

// One chunk per section so the remote's entry no longer ships every view
// (~1.1 MB) to render the one the URL asked for.
const Dashboard = lazy(() => import('./views/dashboard.tsx').then((m) => ({ default: m.Dashboard })))
const Projects = lazy(() => import('./views/projects.tsx').then((m) => ({ default: m.Projects })))
const Issues = lazy(() => import('./views/issues.tsx').then((m) => ({ default: m.Issues })))
const Intake = lazy(() => import('./views/intake.tsx').then((m) => ({ default: m.Intake })))
const Cycles = lazy(() => import('./views/cycles.tsx').then((m) => ({ default: m.Cycles })))
const Okrs = lazy(() => import('./views/okrs.tsx').then((m) => ({ default: m.Okrs })))
const Modules = lazy(() => import('./views/modules.tsx').then((m) => ({ default: m.Modules })))
const Pages = lazy(() => import('./views/pages.tsx').then((m) => ({ default: m.Pages })))
const Views = lazy(() => import('./views/views.tsx').then((m) => ({ default: m.Views })))
const Board = lazy(() => import('./views/board.tsx').then((m) => ({ default: m.Board })))
const Backlog = lazy(() => import('./views/backlog.tsx').then((m) => ({ default: m.Backlog })))
const Roadmap = lazy(() => import('./views/roadmap.tsx').then((m) => ({ default: m.Roadmap })))
const MyWork = lazy(() => import('./views/my-work.tsx').then((m) => ({ default: m.MyWork })))
const Reports = lazy(() => import('./views/reports.tsx').then((m) => ({ default: m.Reports })))
const Releases = lazy(() => import('./views/releases.tsx').then((m) => ({ default: m.Releases })))
const ProjectDetail = lazy(() => import('./components/project-detail.tsx').then((m) => ({ default: m.ProjectDetail })))
const Automation = lazy(() => import('./views/automation.tsx').then((m) => ({ default: m.Automation })))

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
    description: 'Portfolio — health, progress, active sprint, open bugs and leads for every Plane project.',
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
        <EmptyState icon={<EmptyIcon name="plug" />}
          title="Plane isn't connected to this console"
          description="The console has no Plane API key. Plane's setup job writes one (PLANE_URL, PLANE_TOKEN, PLANE_WORKSPACE) into the plane-api-token Secret and restarts the console; re-sync the Plane application in Argo CD, or ask an operator to check that job's logs."
        />
      </div>
    )
  }

  // Every Define page starts from Plane's project list. When Plane refuses or
  // can't be reached, say so — instead of an endless "Loading projects…" on
  // the dashboard or a misleading "Pick a project" everywhere else.
  if (projects.error && !projects.data) {
    const status = (projects.error as { status?: number }).status
    return (
      <div className="space-y-6">
        <PageHeader title={def.label} />
        <EmptyState
          icon={<EmptyIcon name="plug" />}
          title={status === 429 ? 'Plane is busy right now' : status === 401 || status === 403 ? 'Plane refused the console' : "Couldn't load Plane projects"}
          description={planeError(projects.error, "The console couldn't read the project list from Plane.")}
          action={
            <Button size="sm" variant="primary" disabled={projects.isFetching} onClick={() => void projects.refetch()}>
              {projects.isFetching ? 'Retrying…' : 'Try again'}
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* The dashboard draws its own header: its project picker and Customize live in the actions. */}
      {active === 'dashboard' ? null : <PageHeader
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
      />}
      <Suspense fallback={<div className="flex justify-center py-16 text-content-subtle" aria-busy="true"><Spinner size={16} /></div>}>
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
        {active === 'releases' && <Releases projectId={activeProjectId} />}
        {active === 'automation' && <Automation projectId={activeProjectId} />}
      </Suspense>
      <Suspense fallback={null}>
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
      </Suspense>
    </div>
  )
}
