/**
 * Which sidebar row owns a destination.
 *
 * One URL must highlight exactly one row. "CI Pipelines" (Develop) and "CI / CD"
 * (Platform) both pointed at /platform?section=ci, so both lit up and the sidebar's
 * auto-expansion followed whichever it found first: opening one flipped the other
 * group open under the click.
 *
 * Ownership cannot be inferred from two identical destinations — it has to be
 * declared. A row that borrows another group's page sets `crossLink: true` and never
 * claims the highlight.
 *
 * This module is deliberately free of JSX so it can be unit-tested: the repo's Deno
 * test runner has no React in its import map, which is why the rule lives here
 * rather than inside nav-item.tsx.
 */

/** The subset of a nav item this rule needs. */
export interface NavOwnership {
  id: string
  to?: string
  search?: string
  crossLink?: boolean
  /** Holds the highlight for this `to` when the URL's section matches no row. */
  sectionDefault?: boolean
  children?: NavOwnership[]
}

/** The destination key two rows would collide on. */
export function destinationKey(item: NavOwnership): string | undefined {
  if (!item.to) return undefined
  return `${item.to}?${item.search ?? ''}`
}

/** A row owns its destination unless it is declared a cross-link. */
export function ownsDestination(item: NavOwnership): boolean {
  return !!item.to && !item.crossLink
}

/**
 * Every `?section=` value some row claims at this destination.
 *
 * A module's own section list is routinely longer than the sidebar's: the
 * workspace module has 31 sections and the sidebar curates 14 of them into
 * rows. Anything outside that 14 — and the bare URL, which the module coerces
 * to its default — matched no row at all, so the sidebar showed no selection
 * on pages reached straight from it. This set is what lets the row marked
 * `sectionDefault` recognise "a section, but not one of ours" and hold the
 * highlight, without it having to enumerate its siblings.
 */
export function claimedSections(items: NavOwnership[], to: string): Set<string> {
  const out = new Set<string>()
  for (const item of flattenNav(items)) {
    if (!ownsDestination(item) || item.to !== to || !item.search) continue
    out.add(item.search)
  }
  return out
}

export function flattenNav(items: NavOwnership[]): NavOwnership[] {
  return items.flatMap((i) => [i, ...flattenNav(i.children ?? [])])
}

function isAncestorOf(parent: NavOwnership, id: string): boolean {
  return flattenNav(parent.children ?? []).some((c) => c.id === id)
}

/**
 * Destinations claimed by two INDEPENDENT rows, i.e. genuine conflicts.
 *
 * A parent that shares its first child's destination is excluded: that pair is
 * resolved in nav-item.tsx, which gives the child the solid highlight and the parent
 * the subtle "has active descendant" style.
 */
export function conflictingDestinations(
  items: NavOwnership[],
): { destination: string; rows: string[] }[] {
  const owners = new Map<string, NavOwnership[]>()
  for (const item of flattenNav(items)) {
    if (!ownsDestination(item)) continue
    const key = destinationKey(item)!
    owners.set(key, [...(owners.get(key) ?? []), item])
  }

  const out: { destination: string; rows: string[] }[] = []
  for (const [destination, rows] of owners) {
    if (rows.length < 2) continue
    const parentChild =
      rows.length === 2 &&
      (isAncestorOf(rows[0], rows[1].id) || isAncestorOf(rows[1], rows[0].id))
    if (parentChild) continue
    out.push({ destination, rows: rows.map((r) => r.id) })
  }
  return out
}
