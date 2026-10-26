import { useEffect, useState } from 'react'
import { useTeamScope } from './selection-store.ts'
import { teamProjectLens } from './team-lens.ts'

/**
 * Applying the active team as a lens over what a view shows.
 *
 * **A default view, not a hard boundary.** The console narrows what it displays
 * to the team you are working in, and always offers a way to see everything.
 * It does not, and must not, decide what you are *allowed* to see: real
 * isolation is enforced by Kubernetes RBAC against the signed-in user (every
 * cluster read is impersonated) and by the Keycloak groups behind it. A console
 * filter that looked like an access boundary would be security theatre — it
 * would suggest a guarantee it cannot make, while hiding things people
 * legitimately need and have permission to see. So the filter never empties a
 * view: when the active team owns nothing there, the organization's items show
 * instead (see `team-lens.ts`).
 *
 * The chain it relies on already exists in the data model:
 *
 *     Team ──< Project (`ProjectDoc.teams`) ──< App (`spec.project` == `argoProject`)
 *
 * so an app belongs to a team transitively, through the project that owns it.
 */

export interface TeamProject {
  id: string
  slug: string
  name: string
  teams: string[]
  argoProject?: string
  giteaOrg?: string
  harborProject?: string
}

export interface TeamProjects {
  /** True when a team is selected and owns at least one project (else the org's show). */
  filtering: boolean
  team: string
  /** Projects owned by the active team (all projects when not filtering, or when it owns none). */
  projects: TeamProject[]
  /** Argo CD AppProject names for those projects — the link from team to app. */
  argoProjects: Set<string>
  /** Total projects in the organization, for "showing N of M" copy. */
  total: number
  ready: boolean
}

/**
 * Projects owned by the active team, and the Argo CD projects they map to.
 *
 * Fetched once per mount from the same endpoint Workspace uses; small enough
 * (a tenant's project list) that a shared cache would cost more than it saves.
 */
export function useTeamProjects(): TeamProjects {
  const { team, filtering } = useTeamScope()
  const [all, setAll] = useState<TeamProject[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/workspace/projects', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((body: { items?: TeamProject[] }) => {
        if (cancelled) return
        setAll(body.items ?? [])
        setReady(true)
      })
      .catch(() => {
        // No database, or not signed in. An unavailable project list must not
        // blank a view — it just means there is nothing to narrow by.
        if (!cancelled) setReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // A team that owns no projects would narrow every dependent view to nothing;
  // the organization's projects show instead (and `filtering` says so).
  const lens = teamProjectLens(all, team, filtering)
  const scoped = lens.projects
  return {
    filtering: lens.filtering,
    team,
    projects: scoped,
    argoProjects: new Set(scoped.map((p) => p.argoProject).filter((v): v is string => Boolean(v))),
    total: all.length,
    ready,
  }
}
