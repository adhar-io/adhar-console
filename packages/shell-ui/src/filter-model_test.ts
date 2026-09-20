import { assertEquals } from 'jsr:@std/assert'
import {
  countActiveFilters,
  decodeFacetValues,
  type Facet,
  encodeFacetValues,
  facetValue,
  filterChips,
  hasActiveFilters,
  matchesFacets,
  matchesQuery,
  optionsFromItems,
  setFacetValue,
  toggleFacetValue,
} from './filter-model.ts'

/**
 * The filter bar is shared by every list page, so a bug here is a bug
 * everywhere at once. These tests mostly pin the things that were already
 * wrong in the hand-rolled toolbars this replaces: values that contain the
 * separator, selections that outlive their options, and multi-select that
 * ANDed itself into an empty list.
 */

const KIND: Facet = {
  id: 'kind',
  label: 'Kind',
  kind: 'multi',
  options: [{ value: 'API' }, { value: 'Component' }, { value: 'Resource' }],
}
const OWNER: Facet = {
  id: 'owner',
  label: 'Owner',
  kind: 'single',
  options: [{ value: 'platform', label: 'Platform team' }, { value: 'payments' }],
}

/* ─────────── selection ─────────── */

Deno.test('a multi facet accumulates selections', () => {
  let v = toggleFacetValue({}, KIND, 'API')
  v = toggleFacetValue(v, KIND, 'Component')
  assertEquals(facetValue(v, 'kind'), ['API', 'Component'])
})

Deno.test('toggling a selected multi value removes just that one', () => {
  let v = toggleFacetValue({}, KIND, 'API')
  v = toggleFacetValue(v, KIND, 'Component')
  v = toggleFacetValue(v, KIND, 'API')
  assertEquals(facetValue(v, 'kind'), ['Component'])
})

Deno.test('a single facet replaces rather than accumulates', () => {
  let v = toggleFacetValue({}, OWNER, 'platform')
  v = toggleFacetValue(v, OWNER, 'payments')
  assertEquals(facetValue(v, 'owner'), ['payments'])
})

Deno.test('re-picking a single facet value clears it', () => {
  // This is what removes the need for an "Any" option in every facet.
  let v = toggleFacetValue({}, OWNER, 'platform')
  v = toggleFacetValue(v, OWNER, 'platform')
  assertEquals(v, {})
})

Deno.test('emptying a facet removes the key, so "no filters" is always {}', () => {
  // An empty array left behind compares unequal to {} and would keep a
  // "filters are active" badge lit with nothing to clear.
  const v = setFacetValue({ kind: ['API'] }, 'kind', [])
  assertEquals(v, {})
  assertEquals(hasActiveFilters(v), false)
})

Deno.test('the badge counts selections, not facets', () => {
  const v = { kind: ['API', 'Component'], owner: ['platform'] }
  assertEquals(countActiveFilters(v), 3)
})

/* ─────────── chips ─────────── */

Deno.test('chips use the option label but carry the raw value', () => {
  const chips = filterChips([OWNER], { owner: ['platform'] })
  assertEquals(chips.length, 1)
  assertEquals(chips[0].label, 'Platform team')
  assertEquals(chips[0].value, 'platform')
  assertEquals(chips[0].facetLabel, 'Owner')
})

Deno.test('a selection whose option has disappeared still gets a chip', () => {
  // Otherwise the list stays filtered by a tag nothing carries any more and
  // there is no control anywhere on screen to remove it.
  const chips = filterChips([KIND], { kind: ['Retired'] })
  assertEquals(chips.map((c) => c.label), ['Retired'])
})

Deno.test('chips ignore values for facets that are not shown', () => {
  assertEquals(filterChips([KIND], { owner: ['platform'] }), [])
})

/* ─────────── URL round trip ─────────── */

Deno.test('values survive a round trip through the query string', () => {
  const v = { kind: ['API', 'Component'], owner: ['platform'] }
  assertEquals(decodeFacetValues(encodeFacetValues(v), [KIND, OWNER]), v)
})

Deno.test('a value containing the separator is not split in two', () => {
  // Labels and tags legitimately contain commas; joining raw turned one
  // selection into two bogus ones on the way back.
  const v = { tag: ['team=a,b'] }
  const encoded = encodeFacetValues(v)
  assertEquals(encoded.tag.includes('%2C'), true)
  assertEquals(decodeFacetValues(encoded), v)
})

Deno.test('spaces and slashes survive too', () => {
  const v = { owner: ['group:default/platform team'] }
  assertEquals(decodeFacetValues(encodeFacetValues(v)), v)
})

Deno.test('empty facets are left out of the query string entirely', () => {
  assertEquals(encodeFacetValues({ kind: [], owner: ['platform'] }), { owner: 'platform' })
})

Deno.test('unrelated search params are not mistaken for facets', () => {
  // A list route's search carries q/view/sort; without the facet list those
  // would render as chips reading "sort: name".
  const decoded = decodeFacetValues(
    { kind: 'API', sort: 'name', view: 'grid', q: 'payments' },
    [KIND, OWNER],
  )
  assertEquals(decoded, { kind: ['API'] })
})

Deno.test('a malformed escape is kept verbatim rather than throwing', () => {
  // decodeURIComponent('%E0%A4%A') throws; a hand-edited URL must not blank
  // the page.
  assertEquals(decodeFacetValues({ kind: '%E0%A4%A' }), { kind: ['%E0%A4%A'] })
})

Deno.test('empty segments are dropped', () => {
  assertEquals(decodeFacetValues({ kind: 'API,,Component' }), { kind: ['API', 'Component'] })
  assertEquals(decodeFacetValues({ kind: '' }), {})
})

/* ─────────── text matching ─────────── */

Deno.test('an empty query matches everything', () => {
  assertEquals(matchesQuery('', ['anything']), true)
  assertEquals(matchesQuery('   ', ['anything']), true)
})

Deno.test('every term must match, but each may match a different field', () => {
  // The whole point of splitting: "payments prod" should find the payments
  // service whose lifecycle is production.
  assertEquals(matchesQuery('payments prod', ['payments-api', 'production']), true)
  assertEquals(matchesQuery('payments staging', ['payments-api', 'production']), false)
})

Deno.test('matching is case-insensitive', () => {
  assertEquals(matchesQuery('PAYMENTS', ['payments-api']), true)
})

Deno.test('absent fields are skipped, not stringified', () => {
  // `String(undefined)` would make "undefined" a matchable term.
  assertEquals(matchesQuery('undefined', ['payments-api', undefined, null]), false)
  assertEquals(matchesQuery('payments', ['payments-api', undefined]), true)
})

Deno.test('an item with nothing searchable matches only an empty query', () => {
  assertEquals(matchesQuery('x', [undefined, null, '']), false)
  assertEquals(matchesQuery('', [undefined]), true)
})

/* ─────────── facet matching ─────────── */

interface Svc {
  name: string
  kind: string
  tags: string[]
  owner?: string
}
const svc = (name: string, kind: string, tags: string[], owner?: string): Svc => ({
  name,
  kind,
  tags,
  owner,
})
const ACCESSORS = {
  kind: (s: Svc) => s.kind,
  tags: (s: Svc) => s.tags,
  owner: (s: Svc) => s.owner,
}

Deno.test('no filters matches everything', () => {
  assertEquals(matchesFacets(svc('a', 'API', []), {}, ACCESSORS), true)
})

Deno.test('selecting two values in one facet WIDENS the result', () => {
  // ANDing within a facet makes multi-select useless — nothing is two kinds
  // at once — and was how one hand-rolled toolbar emptied its own list.
  const values = { kind: ['API', 'Component'] }
  assertEquals(matchesFacets(svc('a', 'API', []), values, ACCESSORS), true)
  assertEquals(matchesFacets(svc('b', 'Component', []), values, ACCESSORS), true)
  assertEquals(matchesFacets(svc('c', 'Resource', []), values, ACCESSORS), false)
})

Deno.test('selecting across facets NARROWS the result', () => {
  const values = { kind: ['API'], owner: ['platform'] }
  assertEquals(matchesFacets(svc('a', 'API', [], 'platform'), values, ACCESSORS), true)
  assertEquals(matchesFacets(svc('b', 'API', [], 'payments'), values, ACCESSORS), false)
})

Deno.test('an array-valued facet matches on any one entry', () => {
  const values = { tags: ['tier1'] }
  assertEquals(matchesFacets(svc('a', 'API', ['tier1', 'go']), values, ACCESSORS), true)
  assertEquals(matchesFacets(svc('b', 'API', ['go']), values, ACCESSORS), false)
})

Deno.test('an item missing the facet value is filtered out', () => {
  assertEquals(matchesFacets(svc('a', 'API', []), { owner: ['platform'] }, ACCESSORS), false)
})

Deno.test('a facet with no accessor shows everything rather than nothing', () => {
  // Adding a facet to the UI before wiring its accessor should degrade to
  // "no effect", not to a blank page with no explanation.
  assertEquals(matchesFacets(svc('a', 'API', []), { region: ['eu'] }, ACCESSORS), true)
})

/* ─────────── derived options ─────────── */

Deno.test('options are derived with counts, most common first', () => {
  const items = [svc('a', 'API', []), svc('b', 'Component', []), svc('c', 'API', [])]
  assertEquals(optionsFromItems(items, (s) => s.kind), [
    { value: 'API', count: 2 },
    { value: 'Component', count: 1 },
  ])
})

Deno.test('ties break alphabetically so the list does not reshuffle', () => {
  const items = [svc('a', 'Zebra', []), svc('b', 'Alpha', [])]
  assertEquals(optionsFromItems(items, (s) => s.kind).map((o) => o.value), ['Alpha', 'Zebra'])
})

Deno.test('blank and absent values never become an option', () => {
  // A resource with no owner used to produce an option labelled "".
  const items = [svc('a', 'API', [], ''), svc('b', 'API', [], undefined), svc('c', 'API', [], 'x')]
  assertEquals(optionsFromItems(items, (s) => s.owner), [{ value: 'x', count: 1 }])
})

Deno.test('array values are counted per entry', () => {
  const items = [svc('a', 'API', ['go', 'tier1']), svc('b', 'API', ['go'])]
  assertEquals(optionsFromItems(items, (s) => s.tags), [
    { value: 'go', count: 2 },
    { value: 'tier1', count: 1 },
  ])
})

Deno.test('limit keeps the most common, which is what a tag list needs', () => {
  const items = [
    svc('a', 'API', ['go', 'go2']),
    svc('b', 'API', ['go']),
    svc('c', 'API', ['go2']),
    svc('d', 'API', ['rare']),
  ]
  assertEquals(optionsFromItems(items, (s) => s.tags, { limit: 2 }).map((o) => o.value), [
    'go',
    'go2',
  ])
})
