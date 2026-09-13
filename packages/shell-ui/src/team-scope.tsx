import { useEffect, useState } from 'react'
import { cn } from '@adhar-console/utils'
import { useTeamScope } from './selection-store.ts'

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
 * legitimately need and have permission to see. So the filter is honest about
 * being a filter: it says what it is hiding, and how to stop.
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
  /** True when a team is selected and the user has not asked to see everything. */
  filtering: boolean
  team: string
  /** Projects owned by the active team (all projects when not filtering). */
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

  const scoped = filtering ? all.filter((p) => (p.teams ?? []).includes(team)) : all
  return {
    filtering,
    team,
    projects: scoped,
    argoProjects: new Set(scoped.map((p) => p.argoProject).filter((v): v is string => Boolean(v))),
    total: all.length,
    ready,
  }
}

/**
 * The banner that makes the lens visible.
 *
 * A view that silently shows a subset is worse than one that shows everything:
 * the missing rows look like missing data. This states the scope, the counts,
 * and the way out — and renders nothing at all when no filtering is happening,
 * so an unscoped view keeps its full height.
 */
export function TeamScopeBar({
  team,
  shown,
  total,
  noun = 'items',
  className,
}: {
  /** Active team slug; the bar hides itself when empty. */
  team: string
  shown: number
  total: number
  /** Plural noun for the copy — "projects", "applications". */
  noun?: string
  className?: string
}) {
  const { showAll, setShowAll } = useTeamScope()
  if (!team) return null
  // Nothing is being hidden — saying so would be noise.
  if (!showAll && shown === total) return null

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-edge-default bg-surface-sunken px-3 py-2 text-[11px] text-content-muted',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', showAll ? 'bg-edge-strong' : 'bg-brand-500')}
      />
      {showAll
        ? (
          <>
            <span>
              Showing all {total.toLocaleString()} {noun} in the organization.
            </span>
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300"
            >
              Scope to {team}
            </button>
          </>
        )
        : (
          <>
            <span>
              Showing {shown.toLocaleString()} of {total.toLocaleString()} {noun} — scoped to{' '}
              <strong className="font-medium text-content">{team}</strong>.
            </span>
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300"
            >
              Show all
            </button>
          </>
        )}
    </div>
  )
}
