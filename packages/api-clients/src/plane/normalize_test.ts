import { assertEquals } from 'jsr:@std/assert@1'
import {
  cycleProgress,
  cycleStatus,
  filterIssues,
  membershipIndex,
  nextCursor,
  normalizeMember,
  PLANE_ROLE,
  stripHtml,
  unwrapList,
} from './normalize.ts'

const NOW = Date.parse('2026-10-11T12:00:00Z')

Deno.test('cycleStatus buckets cycles the way Plane does', () => {
  assertEquals(cycleStatus({ start_date: null, end_date: null }, NOW), 'draft')
  assertEquals(cycleStatus({ start_date: '2026-10-01', end_date: '2026-10-14' }, NOW), 'current')
  assertEquals(cycleStatus({ start_date: '2026-10-20', end_date: '2026-11-01' }, NOW), 'upcoming')
  assertEquals(cycleStatus({ start_date: '2026-09-01', end_date: '2026-09-14' }, NOW), 'completed')
  // A date-only end counts through that whole day.
  assertEquals(cycleStatus({ start_date: '2026-10-01', end_date: '2026-10-11' }, NOW), 'current')
  // Full timestamps are compared exactly.
  assertEquals(cycleStatus({ start_date: '2026-10-01T00:00:00Z', end_date: '2026-10-11T11:00:00Z' }, NOW), 'completed')
})

Deno.test('cycleProgress excludes cancelled work and guards empty cycles', () => {
  assertEquals(cycleProgress({ total_issues: 10, completed_issues: 4, cancelled_issues: 2 }), 50)
  assertEquals(cycleProgress({ total_issues: 0 }), 0)
  assertEquals(cycleProgress({ total_issues: 3, cancelled_issues: 3 }), 0)
})

Deno.test('lists unwrap bare arrays and paginated envelopes, and follow only real cursors', () => {
  assertEquals(unwrapList([1, 2]), [1, 2])
  assertEquals(unwrapList({ results: [3], next_cursor: '100:1:0', next_page_results: true }), [3])
  assertEquals(unwrapList({ detail: 'nope' }), [])
  assertEquals(nextCursor({ next_cursor: '100:1:0', next_page_results: true }), '100:1:0')
  assertEquals(nextCursor({ next_cursor: '100:1:0', next_page_results: false }), undefined)
  assertEquals(nextCursor([1]), undefined)
})

Deno.test('normalizeMember turns Plane 1.x flat users into the nested member shape', () => {
  const m = normalizeMember(
    { id: 'u1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@x.io', display_name: 'ada', avatar: null, role: PLANE_ROLE.ADMIN },
    'acme',
  )
  assertEquals(m.id, 'u1')
  assertEquals(m.member.id, 'u1')
  assertEquals(m.member.display_name, 'ada')
  assertEquals(m.role, 20)
  const noName = normalizeMember({ id: 'u2', email: 'bo@x.io', role: PLANE_ROLE.GUEST })
  assertEquals(noName.member.display_name, 'bo')
  // Older nested responses still work.
  const nested = normalizeMember({ id: 'wm1', role: 15, member: { id: 'u3', email: 'c@x.io', display_name: 'cee' } })
  assertEquals(nested.id, 'u3')
})

Deno.test('filterIssues applies the filters Plane ignores', () => {
  const rows = [
    { id: 'a', state: 's1', priority: 'high', assignees: ['u1'], target_date: '2026-11-01', cycle: 'c1', module: null },
    { id: 'b', state: 's2', priority: 'low', assignees: [], target_date: null, cycle: null, module: 'm1' },
  ]
  assertEquals(filterIssues(rows, { state: 's1' }).map((r) => r.id), ['a'])
  assertEquals(filterIssues(rows, { priority: 'low' }).map((r) => r.id), ['b'])
  assertEquals(filterIssues(rows, { assignees: ['u1'] }).map((r) => r.id), ['a'])
  assertEquals(filterIssues(rows, { has_target_date: true }).map((r) => r.id), ['a'])
  assertEquals(filterIssues(rows, { module: 'm1' }).map((r) => r.id), ['b'])
  assertEquals(filterIssues(rows, undefined).length, 2)
})

Deno.test('membershipIndex keeps the first container an issue appears in', () => {
  const idx = membershipIndex([
    { id: 'm1', issueIds: ['a', 'b'] },
    { id: 'm2', issueIds: ['b', 'c'] },
  ])
  assertEquals(idx.get('a'), 'm1')
  assertEquals(idx.get('b'), 'm1')
  assertEquals(idx.get('c'), 'm2')
})

Deno.test('stripHtml produces readable text from Plane descriptions', () => {
  assertEquals(stripHtml('<p>Hello&nbsp;<b>world</b></p><p>Line 2 &amp; more</p>'), 'Hello world\nLine 2 & more')
  assertEquals(stripHtml(null), '')
})
