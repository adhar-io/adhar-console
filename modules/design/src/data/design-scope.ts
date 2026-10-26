import { useCallback, useMemo } from 'react'
import { lensOrAll, type TeamProject, useTeamProjects } from '@adhar/shell-ui'
import { useDesignParams, useSetDesignParams } from './nav.ts'
import { scopeMatcher } from './scope-match.ts'
import type { ScopeTag } from './types.ts'

export { scopeMatcher }

/**
 * The tenancy scope the UX Design pages read — Org → Team → Project.
 *
 * The console's team lens (shell-ui `useTeamProjects`: a filter, never an
 * access boundary; same rule as `scope.ts`) narrowed further by an optional
 * `?project=<slug>`. Artifacts carry a `ScopeTag` stamped at creation; one
 * without a project or team is workspace-wide and shows in every scope,
 * labelled as such, because it is shared.
 */

const LAST_PROJECT_KEY = 'adhar.design.project'

function rememberProject(slug: string | undefined) {
  try {
    if (slug) localStorage.setItem(LAST_PROJECT_KEY, slug)
    else localStorage.removeItem(LAST_PROJECT_KEY)
  } catch { /* private mode — the URL still carries it */ }
}

/** The project remembered from the last visit (used when the URL has none). */
export function lastProject(): string | undefined {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export interface DesignScope {
  team: string
  /** True when the team lens is narrowing what is shown. */
  filtering: boolean
  /** Projects visible in the lens (every project when not filtering). */
  projects: TeamProject[]
  total: number
  ready: boolean
  /** Active project slug, or '' for "all projects in the lens". */
  project: string
  activeProject: TeamProject | undefined
  /** Project slugs in scope; null = everything. */
  inScope: Set<string> | null
  /** Is an artifact with this tag visible in the current scope? */
  matches(tag: ScopeTag | undefined): boolean
  /**
   * The items in scope. With only the team lens narrowing (no project picked),
   * a lens that would hide every item shows them all instead — there is no
   * banner to explain an empty list. A picked project stays strict: the
   * project picker on the page already says what is shown.
   */
  pick<T extends ScopeTag>(items: readonly T[]): T[]
  /** The tag a new artifact should carry. */
  tag(): ScopeTag
  setProject(slug: string | undefined): void
  /** Human label: "project Payments", "team core", "all projects". */
  label: string
}

export function useDesignScope(): DesignScope {
  const tp = useTeamProjects()
  const params = useDesignParams()
  const setParams = useSetDesignParams()
  const wanted = params.project ?? ''

  const setProject = useCallback((slug: string | undefined) => {
    rememberProject(slug)
    setParams({ project: slug || undefined })
  }, [setParams])

  // useTeamProjects returns fresh arrays each render; memo on content.
  const key = `${tp.ready}|${tp.filtering}|${tp.team}|${tp.total}|${tp.projects.map((p) => `${p.slug}:${p.argoProject ?? ''}:${(p.teams ?? []).join('+')}`).join(',')}`
  return useMemo(() => {
    // A project outside the lens (or that no longer exists) is ignored once the list is known.
    const project = wanted && (!tp.ready || tp.projects.some((p) => p.slug === wanted)) ? wanted : ''
    const activeProject = tp.projects.find((p) => p.slug === project)
    const inScope = project ? new Set([project]) : tp.filtering ? new Set(tp.projects.map((p) => p.slug)) : null
    const matches = scopeMatcher(project, { filtering: tp.filtering, team: tp.team, projects: tp.projects })
    const label = project ? `project ${activeProject?.name ?? project}` : tp.filtering ? `team ${tp.team}` : 'all projects'
    return {
      team: tp.team,
      filtering: tp.filtering,
      projects: tp.projects,
      total: tp.total,
      ready: tp.ready,
      project,
      activeProject,
      inScope,
      matches,
      pick: <T extends ScopeTag>(items: readonly T[]) => (project ? items.filter(matches) : lensOrAll(items, matches, tp.filtering)),
      tag: () => ({ ...(project ? { project } : {}), ...(tp.team ? { team: tp.team } : {}) }),
      setProject,
      label,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wanted, setProject])
}
