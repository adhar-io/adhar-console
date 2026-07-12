import { useEffect, useState } from 'react'
import { PageHeader, Spinner, StatusBadge } from '@adhar-console/shell-ui'
import { Dashboard } from './views/dashboard.tsx'
import { Projects } from './views/projects.tsx'
import { Issues } from './views/issues.tsx'
import { Cycles } from './views/cycles.tsx'
import { Modules } from './views/modules.tsx'
import { Pages } from './views/pages.tsx'
import { Views } from './views/views.tsx'
import { Roadmap } from './views/roadmap.tsx'
import { Members } from './views/members.tsx'
import { ProjectPicker } from './components/project-picker.tsx'
import { ProjectDetail } from './components/project-detail.tsx'
import {
  getStoredProjectId,
  setStoredProjectId,
  useProject,
  useProjects,
} from './data/plane.ts'

type Section =
  | 'dashboard'
  | 'projects'
  | 'issues'
  | 'cycles'
  | 'modules'
  | 'pages'
  | 'views'
  | 'roadmap'
  | 'members'

const SECTIONS: Record<Section, { label: string; description: string }> = {
  dashboard: {
    label: 'Dashboard',
    description: 'Workspace-wide pulse — counts, recent activity, top projects.',
  },
  projects: {
    label: 'Projects',
    description: 'Every project in the workspace — open issue counts, leads, recent activity.',
  },
  issues: {
    label: 'Issues',
    description: 'Kanban + list view with priority and label filters. Backed by Plane.so.',
  },
  cycles: {
    label: 'Cycles',
    description: 'Sprint-shaped time-boxed iterations with progress + countdown.',
  },
  modules: {
    label: 'Modules',
    description: 'Plane modules — epic-shaped groupings with leads, members, and progress.',
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
    description: 'Issues with target dates grouped by quarter — overdue items pinned to the top.',
  },
  members: {
    label: 'Members',
    description: 'Workspace-wide membership and Plane RBAC role assignment.',
  },
}

const PROJECT_SCOPED: Set<Section> = new Set([
  'issues',
  'cycles',
  'modules',
  'pages',
  'views',
  'roadmap',
])

export default function DefineHome({ section }: { section?: string } = {}) {
  const active = (SECTIONS[section as Section] ? (section as Section) : 'dashboard') as Section
  const def = SECTIONS[active]
  const projects = useProjects()

  const [activeProjectId, setActiveProjectIdState] = useState<string | undefined>(undefined)
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)

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

  const setActiveProjectId = (id: string) => {
    setActiveProjectIdState(id)
    setStoredProjectId(id)
  }

  const project = useProject(activeProjectId)
  const projectScoped = PROJECT_SCOPED.has(active)
  const switching = projectScoped && project.isFetching && !project.data

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
        description={def.description}
        badge={
          active === 'members' && projects.data ? (
            <StatusBadge kind="info">{projects.data.length} workspace projects</StatusBadge>
          ) : null
        }
      />
      {active === 'dashboard' && (
        <Dashboard onOpenProject={(id) => setOpenProjectId(id)} onPickProject={setActiveProjectId} />
      )}
      {active === 'projects' && (
        <Projects
          activeId={activeProjectId}
          onPick={setActiveProjectId}
          onOpenDetails={(id) => setOpenProjectId(id)}
        />
      )}
      {active === 'issues' && <Issues projectId={activeProjectId} />}
      {active === 'cycles' && <Cycles projectId={activeProjectId} />}
      {active === 'modules' && <Modules projectId={activeProjectId} />}
      {active === 'pages' && <Pages projectId={activeProjectId} />}
      {active === 'views' && <Views projectId={activeProjectId} />}
      {active === 'roadmap' && <Roadmap projectId={activeProjectId} />}
      {active === 'members' && <Members />}
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
