import { accessCheckKey, type AccessCheck } from '@adhar/auth'

/**
 * RBAC for navigation — which rows (and ⌘K commands) a person is shown.
 *
 * Navigation is not an action, so the rule is gentler than `<Can>`'s:
 *
 *   • `read`   — a destination the person may only reach if they can READ what
 *                it shows (Billing needs `get billing`). Hidden only on a
 *                DEFINITE no; shown while the answer loads and when the cluster
 *                could not be asked. A sidebar that grew rows after load would
 *                read as broken, and an admin area you may read but not change
 *                still belongs in your nav.
 *   • `action` — an entry that IS a write ("Create New" scaffolds an app). Like
 *                any action it is hidden until the answer is a definite yes, so
 *                it never flashes in and vanishes.
 *
 * Rows without `access` are always shown; the older persona `roles` field is
 * separate and still filtered by `filterNavByRole` where hosts use it.
 *
 * Pure (no React) so the rule is unit-tested; the hook is in nav-access-hook.tsx.
 */

export interface NavAccess {
  /** One check, or several that must ALL hold. */
  check: AccessCheck | readonly AccessCheck[]
  /** `read` (default): hide only on a definite no. `action`: show only on a definite yes. */
  mode?: 'read' | 'action'
}

/** The subset of a nav row (or command) this rule needs. */
export interface AccessGated {
  access?: NavAccess
  children?: AccessGated[]
}

function checksOf(access: NavAccess): AccessCheck[] {
  return Array.isArray(access.check) ? [...access.check] : [access.check as AccessCheck]
}

/** Every distinct check a tree asks, in first-seen order — one batch for the whole nav. */
export function collectNavChecks(items: readonly AccessGated[]): AccessCheck[] {
  const seen = new Map<string, AccessCheck>()
  const walk = (list: readonly AccessGated[]) => {
    for (const item of list) {
      if (item.access) for (const c of checksOf(item.access)) seen.set(accessCheckKey(c), c)
      if (item.children?.length) walk(item.children)
    }
  }
  walk(items)
  return [...seen.values()]
}

/** Answer per check key: true, false, or undefined while unknown. */
export type AccessAnswers = ReadonlyMap<string, boolean | undefined>

/** Is this row shown, given the answers so far? */
export function navItemAllowed(item: AccessGated, answers: AccessAnswers): boolean {
  if (!item.access) return true
  const results = checksOf(item.access).map((c) => answers.get(accessCheckKey(c)))
  return item.access.mode === 'action'
    ? results.length > 0 && results.every((r) => r === true)
    : !results.some((r) => r === false)
}

/**
 * The tree without the rows the person may not see. A group whose own route
 * is gated takes its children with it; a pure group (no route) left empty is
 * dropped. Never mutates the input; returns the SAME array when nothing is
 * hidden, so memoised consumers do not re-render for nothing.
 */
export function filterByAccess<T extends AccessGated & { to?: string }>(items: readonly T[], answers: AccessAnswers): T[] {
  let changed = false
  const out: T[] = []
  for (const item of items) {
    if (!navItemAllowed(item, answers)) {
      changed = true
      continue
    }
    if (item.children?.length) {
      const kids = filterByAccess(item.children as T[], answers)
      if (kids !== item.children) {
        changed = true
        if (!kids.length && !item.to) continue
        out.push({ ...item, children: kids })
        continue
      }
    }
    out.push(item)
  }
  return changed ? out : (items as T[])
}

/** `filterByAccess` over sections; a section left with no rows is dropped. */
export function filterSectionsByAccess<S extends { items: readonly (AccessGated & { to?: string })[] }>(
  sections: readonly S[],
  answers: AccessAnswers,
): S[] {
  let changed = false
  const out: S[] = []
  for (const section of sections) {
    const items = filterByAccess(section.items, answers)
    if (items === section.items) {
      out.push(section)
      continue
    }
    changed = true
    if (items.length) out.push({ ...section, items })
  }
  return changed ? out : (sections as S[])
}
