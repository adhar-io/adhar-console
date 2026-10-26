/**
 * The team lens as pure functions (tested in `team-lens_test.ts`).
 *
 * The console used to say what the active-team lens hid with a banner
 * ("Showing 3 of 9 projects — scoped to platform. Show all"). That banner is
 * gone, so the lens has to be safe on its own: a narrowing that would leave a
 * view empty is not a lens, it is a blank page that looks like missing data.
 * The rule everywhere is therefore the same — narrow to the team's items, and
 * when the team owns none of them, show the organization's instead.
 */

/**
 * `items` narrowed by `keep` while `active`; every item when the narrowing
 * would hide all of them.
 */
export function lensOrAll<T>(items: readonly T[], keep: (item: T) => boolean, active = true): T[] {
  if (!active) return [...items]
  const mine = items.filter(keep)
  return mine.length || !items.length ? mine : [...items]
}

/**
 * Projects the active team owns, or every project when it owns none.
 *
 * `filtering` in the result is what views should act on: it is false when the
 * lens fell back to the organization, so dependent filters (apps by project,
 * costs by project, …) do not then narrow to an empty set themselves.
 */
export function teamProjectLens<P extends { teams?: string[] }>(
  all: readonly P[],
  team: string,
  filtering: boolean,
): { filtering: boolean; projects: P[] } {
  if (!filtering || !team) return { filtering: false, projects: [...all] }
  const mine = all.filter((p) => (p.teams ?? []).includes(team))
  return mine.length ? { filtering: true, projects: mine } : { filtering: false, projects: [...all] }
}
