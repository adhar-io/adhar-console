import { useMemo } from 'react'
import { type TeamProject, useTeamProjects } from '@adhar/shell-ui'
import type { ProjectRef } from './dora-sources.ts'
import { useDecideParams } from './params.ts'

/**
 * The scope every Decide page reads: the console's team lens (a filter, not a
 * boundary — see shell-ui `team-scope.tsx`) narrowed further by an optional
 * `?project=` and a `?range=`.
 */

export const RANGES = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
] as const

export type RangeId = (typeof RANGES)[number]['id']

export function rangeOf(id: string | undefined): (typeof RANGES)[number] {
  return RANGES.find((r) => r.id === id) ?? RANGES[1]
}

export interface DecideScope {
  team: string
  filtering: boolean
  /** Projects visible in the lens (all projects when not filtering). */
  projects: TeamProject[]
  total: number
  ready: boolean
  /** `?project=` when it is one of `projects`. */
  project: string
  /** Project slugs in scope, or null for "everything" (no team lens, no project). */
  inScope: Set<string> | null
  refs: ProjectRef[]
  teamsOf(project: string): string[]
  matches(project: string): boolean
  range: (typeof RANGES)[number]
  label: string
}

export function useDecideScope(): DecideScope {
  const tp = useTeamProjects()
  const params = useDecideParams()
  const range = rangeOf(params.range)
  // useTeamProjects returns fresh arrays every render; key the memo on content.
  const key = `${tp.ready}|${tp.filtering}|${tp.team}|${tp.total}|${
    tp.projects.map((p) => `${p.slug}:${p.argoProject ?? ''}:${(p.teams ?? []).join('+')}`).join(',')
  }`
  return useMemo(() => {
    const project = params.project && (!tp.ready || tp.projects.some((p) => p.slug === params.project)) ? params.project : ''
    const inScope = project ? new Set([project]) : tp.filtering ? new Set(tp.projects.map((p) => p.slug)) : null
    const refs: ProjectRef[] = tp.projects.map((p) => ({ slug: p.slug, argoProject: p.argoProject, teams: p.teams ?? [] }))
    const teams = new Map(refs.map((r) => [r.slug, r.teams]))
    const label = project ? `project ${project}` : tp.filtering ? `team ${tp.team}` : 'all projects'
    return {
      team: tp.team,
      filtering: tp.filtering,
      projects: tp.projects,
      total: tp.total,
      ready: tp.ready,
      project,
      inScope,
      refs,
      teamsOf: (p: string) => teams.get(p) ?? [],
      matches: (p: string) => !inScope || inScope.has(p),
      range,
      label,
    }
  }, [key, params.project, range])
}
