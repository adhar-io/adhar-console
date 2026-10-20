import { assertEquals } from 'jsr:@std/assert@1'
import {
  boardColumns,
  byRank,
  coverFromHtml,
  estimateTotal,
  groupBands,
  isOverdue,
  laneOf,
  planRank,
  rankBetween,
  RANK_STEP,
  subtaskProgress,
  swimlanes,
  targetState,
  wipStatus,
} from './work-board.ts'

const STATES = [
  { id: 'done', name: 'Done', color: '#0f0', group: 'completed', sequence: 5, project: 'p1' },
  { id: 'todo', name: 'Todo', color: '#999', group: 'unstarted', sequence: 2, project: 'p1' },
  { id: 'review', name: 'Review', color: '#f90', group: 'started', sequence: 4, project: 'p1' },
  { id: 'prog', name: 'In Progress', color: '#fa0', group: 'started', sequence: 3, project: 'p1' },
  { id: 'back', name: 'Backlog', color: '#ccc', group: 'backlog', sequence: 1, project: 'p1' },
  { id: 'p2-todo', name: 'Open', color: '#999', group: 'unstarted', sequence: 1, project: 'p2' },
]

Deno.test('columns follow state group order then sequence; bands span groups', () => {
  const cols = boardColumns(STATES.filter((s) => s.project === 'p1'))
  assertEquals(cols.map((c) => c.id), ['back', 'todo', 'prog', 'review', 'done'])
  assertEquals(groupBands(cols).map((b) => [b.group, b.span]), [['backlog', 1], ['unstarted', 1], ['started', 2], ['completed', 1]])
})

Deno.test('cross-project boards use one column per group and drop into the project\'s own state', () => {
  const cols = boardColumns(STATES, true)
  assertEquals(cols.map((c) => c.id), ['group:backlog', 'group:unstarted', 'group:started', 'group:completed'])
  const todo = cols[1]
  assertEquals(todo.stateIds.sort(), ['p2-todo', 'todo'])
  assertEquals(targetState(todo, STATES, 'p2'), 'p2-todo')
  assertEquals(targetState(cols[2], STATES, 'p1'), 'prog')
  assertEquals(targetState(boardColumns(STATES)[0], STATES, 'p1'), 'back')
})

Deno.test('WIP status', () => {
  assertEquals(wipStatus(3, undefined), 'none')
  assertEquals(wipStatus(3, 0), 'none')
  assertEquals(wipStatus(2, 3), 'under')
  assertEquals(wipStatus(3, 3), 'at')
  assertEquals(wipStatus(4, 3), 'over')
})

Deno.test('swimlanes: first assignee, epic, priority; none last', () => {
  const issues = [
    { id: 'a', assignees: ['u2', 'u1'], module: 'm1', priority: 'low' },
    { id: 'b', assignees: [], module: null, priority: 'urgent' },
    { id: 'c', assignees: ['u1'], module: 'm1', priority: 'low' },
  ]
  assertEquals(laneOf(issues[0], 'assignee'), 'u2')
  const names = { member: (id: string) => ({ u1: 'Ada', u2: 'Bob' } as Record<string, string>)[id] }
  assertEquals(swimlanes(issues, 'assignee', names).map((l) => l.label), ['Ada', 'Bob', 'Unassigned'])
  assertEquals(swimlanes(issues, 'priority').map((l) => l.id), ['urgent', 'low'])
  assertEquals(swimlanes(issues, 'epic', { epic: () => 'Auth' }).map((l) => l.label), ['Auth', 'No epic'])
  assertEquals(swimlanes(issues, 'none').length, 1)
})

Deno.test('rankBetween: midpoints, ends and exhaustion', () => {
  assertEquals(rankBetween(), 65_535)
  assertEquals(rankBetween(100, 200), 150)
  assertEquals(rankBetween(undefined, 100), 100 - RANK_STEP)
  assertEquals(rankBetween(100), 100 + RANK_STEP)
  assertEquals(rankBetween(100, 100), undefined)
})

Deno.test('planRank moves one item with one patch', () => {
  const list = [{ id: 'a', sort_order: 100 }, { id: 'b', sort_order: 200 }, { id: 'c', sort_order: 300 }]
  assertEquals(planRank(list, 'c', 0), [{ id: 'c', sort_order: 100 - RANK_STEP }])
  assertEquals(planRank(list, 'a', 1), [{ id: 'a', sort_order: 250 }])
  assertEquals(planRank(list, 'a', 2), [{ id: 'a', sort_order: 300 + RANK_STEP }])
})

Deno.test('planRank renumbers when there is no room or no rank', () => {
  const tight = [{ id: 'a', sort_order: 1 }, { id: 'b', sort_order: 1 }, { id: 'x', sort_order: 9 }]
  const out = planRank(tight, 'x', 1)
  assertEquals(out, [
    { id: 'a', sort_order: RANK_STEP },
    { id: 'x', sort_order: 2 * RANK_STEP },
    { id: 'b', sort_order: 3 * RANK_STEP },
  ])
  const unranked = [{ id: 'a' }, { id: 'b' }]
  assertEquals(planRank(unranked, 'b', 0), [{ id: 'b', sort_order: RANK_STEP }, { id: 'a', sort_order: 2 * RANK_STEP }])
})

Deno.test('byRank sorts ranked first, then newest', () => {
  const xs = [
    { id: 'u-old', created_at: '2026-01-01' },
    { id: 'r2', sort_order: 2 },
    { id: 'u-new', created_at: '2026-02-01' },
    { id: 'r1', sort_order: 1 },
  ]
  assertEquals(xs.sort(byRank).map((x) => x.id), ['r1', 'r2', 'u-new', 'u-old'])
})

Deno.test('card facts: sub-task progress, cover, overdue, estimate totals', () => {
  const group = (s: string) => ({ d: 'completed', t: 'unstarted', x: 'cancelled' } as Record<string, string>)[s]
  const prog = subtaskProgress([
    { id: '1', parent: 'p', state: 'd' },
    { id: '2', parent: 'p', state: 't' },
    { id: '3', parent: 'p', state: 'x' },
    { id: '4', state: 't' },
  ], group)
  assertEquals(prog.get('p'), { done: 1, total: 2 })
  assertEquals(coverFromHtml('<p>x</p><img alt="a" src="https://cdn/x.png"><img src="https://cdn/y.png">'), 'https://cdn/x.png')
  assertEquals(coverFromHtml('<img src="javascript:alert(1)">'), undefined)
  assertEquals(coverFromHtml(undefined), undefined)
  const now = Date.parse('2026-10-21T12:00:00Z')
  assertEquals(isOverdue('2026-10-20', 'started', now), true)
  assertEquals(isOverdue('2026-10-21', 'started', now), false)
  assertEquals(isOverdue('2026-10-20', 'completed', now), false)
  assertEquals(estimateTotal([{ estimate_point: 3 }, { estimate_point: null }, { estimate_point: 5 }]), { points: 8, estimated: 2, total: 3 })
})
