/**
 * The logic behind the console's filter bar, kept free of React so it can be
 * tested directly.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Every list page in the console grew its own toolbar. Nine views had defined
 * their own `SearchInput` — near-identical copies that had already drifted on
 * widths, focus-ring colour, and whether there was a magnifier icon at all —
 * and the filter controls beside them ranged from "nothing" to six `<select>`
 * dropdowns fighting for room on one row.
 *
 * The Service Catalog's toolbar is the shape worth keeping: one wide search
 * box, a single Filters button that opens a popover, and a row of chips
 * showing what is actually applied so the state is never hidden behind a
 * closed menu. This module is that toolbar's model.
 *
 * ---------------------------------------------------------------------------
 * THE VALUE SHAPE
 * ---------------------------------------------------------------------------
 * Every facet's selection is `string[]`, whatever the facet's kind:
 *
 *   multi  → any number of entries
 *   single → zero or one entry
 *
 * A single shape means counting, clearing, chip-rendering and URL encoding are
 * each written once rather than per kind. It is also why there is no separate
 * tristate: "has an owner / does not / don't care" is a `single` facet with two
 * options and nothing selected as the third state.
 *
 * An absent key and an empty array both mean "not filtering on this", and the
 * helpers normalise to the absent form so `{}` is the one canonical "no
 * filters" value — two equivalent states that compare unequal is exactly how a
 * "Clear all" button ends up leaving a stuck chip behind.
 */

/** One selectable value within a facet. */
export interface FacetOption {
  value: string
  /** Shown instead of `value`; `value` is what goes in the URL. */
  label?: string
  /** Matching item count, rendered beside the option when present. */
  count?: number
  /** Disables the option without hiding it, so the list does not reflow. */
  disabled?: boolean
}

export interface Facet {
  /** Stable key — used in `FacetValues` and in the URL, so don't rename it casually. */
  id: string
  label: string
  /** `multi` accumulates selections; `single` replaces (and re-clicking clears). */
  kind: 'multi' | 'single'
  options: FacetOption[]
  /** Renders the group collapsed until opened. For long option lists (tags). */
  collapsible?: boolean
}

export type FacetValues = Record<string, string[]>

/* ─────────────────────────── reading ─────────────────────────── */

/** The values selected for one facet — always an array, never undefined. */
export function facetValue(values: FacetValues, facetId: string): string[] {
  return values[facetId] ?? []
}

export function isFacetSelected(values: FacetValues, facetId: string, value: string): boolean {
  return facetValue(values, facetId).includes(value)
}

/**
 * How many individual selections are active, which is what the badge on the
 * Filters button shows. Counting selections rather than facets is deliberate:
 * "3" next to the button should mean three things are narrowing the list, not
 * three groups of unknown size.
 */
export function countActiveFilters(values: FacetValues): number {
  let n = 0
  for (const v of Object.values(values)) n += v.length
  return n
}

export function hasActiveFilters(values: FacetValues): boolean {
  return countActiveFilters(values) > 0
}

/* ─────────────────────────── writing ─────────────────────────── */

/** Drop empty arrays so "no filters" has exactly one representation. */
function prune(values: FacetValues): FacetValues {
  const out: FacetValues = {}
  for (const [k, v] of Object.entries(values)) {
    if (v.length > 0) out[k] = v
  }
  return out
}

/**
 * Toggle one value. `multi` adds/removes within the set; `single` replaces the
 * selection, and selecting the value that is already selected clears it — so
 * the same click both applies and undoes a filter, with no separate "any"
 * option to maintain in every facet's option list.
 */
export function toggleFacetValue(
  values: FacetValues,
  facet: Pick<Facet, 'id' | 'kind'>,
  value: string,
): FacetValues {
  const current = facetValue(values, facet.id)
  if (facet.kind === 'single') {
    const next = current[0] === value ? [] : [value]
    return prune({ ...values, [facet.id]: next })
  }
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value]
  return prune({ ...values, [facet.id]: next })
}

/** Replace a facet's selection outright (for a `<select>`-style control). */
export function setFacetValue(
  values: FacetValues,
  facetId: string,
  next: string[],
): FacetValues {
  return prune({ ...values, [facetId]: next })
}

export function clearFacet(values: FacetValues, facetId: string): FacetValues {
  const { [facetId]: _dropped, ...rest } = values
  return prune(rest)
}

export const NO_FILTERS: FacetValues = {}

/* ─────────────────────────── chips ─────────────────────────── */

export interface FilterChip {
  facetId: string
  facetLabel: string
  value: string
  /** The option's label if the facet still offers it, else the raw value. */
  label: string
}

/**
 * The applied filters, flattened for the chip row.
 *
 * A selected value whose option has since disappeared (a tag nothing carries
 * any more, a namespace that was deleted) still produces a chip, labelled with
 * the raw value. Silently dropping it would leave the list filtered by
 * something the user can no longer see or remove.
 */
export function filterChips(facets: Facet[], values: FacetValues): FilterChip[] {
  const chips: FilterChip[] = []
  for (const facet of facets) {
    for (const value of facetValue(values, facet.id)) {
      const option = facet.options.find((o) => o.value === value)
      chips.push({
        facetId: facet.id,
        facetLabel: facet.label,
        value,
        label: option?.label ?? value,
      })
    }
  }
  return chips
}

/* ─────────────────────────── URL round trip ─────────────────────────── */

/**
 * Encode for a query string: `{ kind: ['API', 'Component'] }` → `API,Component`.
 *
 * Each value is percent-encoded before joining, because facet values are real
 * data — a Kubernetes label selector or a tag can contain a comma, and joining
 * raw would split one value into two on the way back.
 */
export function encodeFacetValues(values: FacetValues): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(prune(values))) {
    out[k] = v.map(encodeURIComponent).join(',')
  }
  return out
}

/**
 * Decode a query string back into values.
 *
 * When `facets` is supplied, unknown keys are ignored — the search params of a
 * list page carry `q`, `view`, `sort` and anything else the route defines, and
 * treating those as facets would show chips for "sort: name".
 */
export function decodeFacetValues(
  raw: Record<string, string | undefined>,
  facets?: Facet[],
): FacetValues {
  const known = facets ? new Set(facets.map((f) => f.id)) : null
  const out: FacetValues = {}
  for (const [k, v] of Object.entries(raw)) {
    if (known && !known.has(k)) continue
    if (!v) continue
    const parts = v
      .split(',')
      .map((p) => {
        try {
          return decodeURIComponent(p)
        } catch {
          // A malformed escape is data we can still show verbatim; throwing
          // here would blank the page on a hand-edited URL.
          return p
        }
      })
      .filter((p) => p !== '')
    if (parts.length) out[k] = parts
  }
  return out
}

/* ─────────────────────────── matching ─────────────────────────── */

/**
 * Whether a free-text query matches any of an item's searchable fields.
 *
 * Terms are split on whitespace and ALL must match (each against any one
 * field), so "payments prod" finds the payments service in production rather
 * than nothing at all — the single-substring matching most views had meant a
 * query only worked if you typed it in the order the field happened to store.
 *
 * `undefined`/`null` fields are skipped rather than coerced, so a missing
 * description can't make "undefined" a matchable term.
 */
export function matchesQuery(
  query: string,
  fields: Array<string | null | undefined>,
): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = fields.filter((f): f is string => typeof f === 'string' && f !== '')
    .map((f) => f.toLowerCase())
  if (hay.length === 0) return false
  return terms.every((t) => hay.some((h) => h.includes(t)))
}

/** How an item exposes its value(s) for a facet. */
export type FacetAccessors<T> = Record<
  string,
  (item: T) => string | string[] | null | undefined
>

/**
 * Whether an item satisfies the active facet selections.
 *
 * OR within a facet, AND across facets — picking `API` and `Component` widens
 * the list, while also picking `owner: platform` narrows it. That is what
 * every faceted browser does and what users expect; the reverse (AND within a
 * facet) makes multi-select useless, since nothing is two kinds at once.
 *
 * A facet with no accessor is ignored rather than treated as non-matching, so
 * adding a facet to the UI before wiring its accessor shows everything instead
 * of silently emptying the page.
 */
export function matchesFacets<T>(
  item: T,
  values: FacetValues,
  accessors: FacetAccessors<T>,
): boolean {
  for (const [facetId, selected] of Object.entries(values)) {
    if (selected.length === 0) continue
    const accessor = accessors[facetId]
    if (!accessor) continue
    const raw = accessor(item)
    if (raw === null || raw === undefined) return false
    const owned = Array.isArray(raw) ? raw : [raw]
    if (!owned.some((v) => selected.includes(v))) return false
  }
  return true
}

/**
 * Build a facet's options from the items themselves, with counts, sorted by
 * count then name.
 *
 * Views were hand-rolling this (collect distinct namespaces, sort, count) and
 * getting the empty-string case wrong — a resource with no owner became an
 * option labelled "" that matched everything unlabelled.
 */
export function optionsFromItems<T>(
  items: T[],
  accessor: (item: T) => string | string[] | null | undefined,
  opts: { limit?: number; label?: (value: string) => string } = {},
): FacetOption[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const raw = accessor(item)
    if (raw === null || raw === undefined) continue
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (typeof v !== 'string' || v === '') continue
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
  }
  const out = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({
      value,
      count,
      ...(opts.label ? { label: opts.label(value) } : {}),
    }))
  return opts.limit ? out.slice(0, opts.limit) : out
}
