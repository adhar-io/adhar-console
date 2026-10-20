/**
 * Tenancy scope for design artifacts — Organisation → Team → Project.
 *
 * ADRs, diagrams, boards and API specs may name the workspace project they
 * belong to and the team that owns them. The console's team selector is a
 * LENS, not an access boundary (see shell-ui `team-scope.tsx`): with a team
 * active, a list shows that team's artifacts — those tagged with the team or
 * with one of its projects — plus workspace-wide ones that name neither, and
 * says how many it is hiding. Pure; tested in `scope_test.ts`.
 */

export interface Scoped {
  project?: string
  team?: string
}

export interface ScopeProject {
  slug: string
  name?: string
  teams?: string[]
}

export interface ScopeLens {
  filtering: boolean
  team: string
  /** Every project in the organisation (to resolve a project's owning teams). */
  projects: readonly ScopeProject[]
}

/** The team that owns an artifact: its own tag, else its project's first team. */
export function ownerTeam(item: Scoped, projects: readonly ScopeProject[]): string | undefined {
  if (item.team) return item.team
  if (!item.project) return undefined
  return projects.find((p) => p.slug === item.project)?.teams?.[0]
}

export function inScope(item: Scoped, lens: ScopeLens): boolean {
  if (!lens.filtering || !lens.team) return true
  if (!item.team && !item.project) return true
  if (item.team === lens.team) return true
  const p = item.project ? lens.projects.find((x) => x.slug === item.project) : undefined
  return !!p && (p.teams ?? []).includes(lens.team)
}

export function scopeFilter<T extends Scoped>(items: readonly T[], lens: ScopeLens): { shown: T[]; total: number } {
  const shown = items.filter((i) => inScope(i, lens))
  return { shown, total: items.length }
}

/** Default scope for something new: the active team, and its only project when it has exactly one. */
export function defaultScope(lens: ScopeLens): Scoped {
  if (!lens.team) return {}
  const mine = lens.projects.filter((p) => (p.teams ?? []).includes(lens.team))
  return { team: lens.team, ...(mine.length === 1 ? { project: mine[0].slug } : {}) }
}
