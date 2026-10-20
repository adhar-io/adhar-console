import { inScope as inTeamScope } from './scope.ts'
import type { ScopeTag } from './types.ts'

/**
 * Pure scope matcher (tested): workspace-wide artifacts always match; with a
 * project chosen only that project's (and shared) ones; otherwise the team
 * lens rule from `scope.ts`.
 */
export function scopeMatcher(
  project: string,
  lens: { filtering: boolean; team: string; projects: ReadonlyArray<{ slug: string; teams?: string[] }> },
) {
  return (tag: ScopeTag | undefined): boolean => {
    const t = tag ?? {}
    if (!t.project && !t.team) return true
    if (project) return t.project === project || (!t.project && !!t.team && lens.projects.some((p) => p.slug === project && (p.teams ?? []).includes(t.team!)))
    return inTeamScope(t, lens)
  }
}
