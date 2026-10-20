import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  burnSeries,
  capacityPlan,
  daysOffIn,
  deriveHealth,
  effectiveHealth,
  isBugLabel,
  pointsOf,
  scopeChanges,
  slaState,
  sprintOutcome,
  sprintStatus,
  takeSnapshot,
  velocity,
  withSnapshot,
  type WorkItem,
  workdays,
  workload,
} from './planning-model.ts'

const T = (d: string) => Date.parse(`${d}T12:00:00Z`)
const item = (id: string, o: Partial<WorkItem> = {}): WorkItem => ({ id, created_at: '2026-10-01T00:00:00Z', assignees: [], state_group: 'unstarted', ...o })
const done = (id: string, at: string, o: Partial<WorkItem> = {}) => item(id, { state_group: 'completed', completed_at: `${at}T10:00:00Z`, ...o })

Deno.test('sprint status derives from dates; a date-only end lasts the whole day', () => {
  const now = T('2026-10-10')
  assertEquals(sprintStatus({}, now), 'draft')
  assertEquals(sprintStatus({ start_date: '2026-10-11', end_date: '2026-10-20' }, now), 'upcoming')
  assertEquals(sprintStatus({ start_date: '2026-10-01', end_date: '2026-10-10' }, now), 'active')
  assertEquals(sprintStatus({ start_date: '2026-10-01', end_date: '2026-10-09' }, now), 'completed')
  assertEquals(sprintStatus({ start_date: '2026-10-01T00:00:00Z', end_date: '2026-10-10T08:00:00Z' }, now), 'completed')
  assertEquals(sprintStatus({ end_date: '2026-10-20' }, now), 'draft')
})

Deno.test('points: numeric Plane estimate, else recorded console points, else null', () => {
  assertEquals(pointsOf({ id: 'a', estimate_point: 5 }), 5)
  assertEquals(pointsOf({ id: 'a', estimate_point: '7c0e-uuid' }, { a: 3 }), 3)
  assertEquals(pointsOf({ id: 'b', estimate_point: null }), null)
})

Deno.test('burndown without snapshots uses current scope and completed_at', () => {
  const items = [done('a', '2026-10-02'), done('b', '2026-10-04'), item('c'), item('x', { state_group: 'cancelled' })]
  const s = burnSeries({ start: '2026-10-01', end: '2026-10-05', items, metric: 'issues', now: T('2026-10-04') })!
  assertEquals(s.scopeSource, 'current')
  assertEquals(s.committed, 3)
  assertEquals(s.remaining, [3, 2, 2, 1, null])
  assertEquals(s.completed, [0, 1, 1, 2, null])
  assertEquals(s.ideal, [3, 2.3, 1.5, 0.8, 0])
})

Deno.test('burnup follows recorded scope changes; points metric weighs by points', () => {
  const items = [done('a', '2026-10-02'), item('b'), item('c')]
  const snaps = {
    '2026-10-01': { ids: ['a', 'b'], done: [], points: { a: 3, b: 5 } },
    '2026-10-03': { ids: ['a', 'b', 'c'], done: ['a'], points: { a: 3, b: 5, c: 2 } },
  }
  const s = burnSeries({ start: '2026-10-01', end: '2026-10-03', items, snapshots: snaps, metric: 'points', now: T('2026-10-03') })!
  assertEquals(s.scopeSource, 'snapshots')
  assertEquals(s.scope, [8, 8, 10])
  assertEquals(s.completed, [0, 3, 3])
  assertEquals(s.remaining, [8, 5, 7])
  assertEquals(s.committed, 8)
  assertEquals(scopeChanges(snaps), [{ day: '2026-10-03', added: ['c'], removed: [] }])
})

Deno.test('a snapshot is only rewritten when it changed', () => {
  const snap = takeSnapshot([done('a', '2026-10-02'), item('b', { estimate_point: 2 })], { a: 1 })
  assertEquals(snap, { ids: ['a', 'b'], done: ['a'], points: { a: 1, b: 2 } })
  const once = withSnapshot(undefined, '2026-10-02', snap)!
  assertEquals(withSnapshot(once, '2026-10-02', snap), null)
  assert(withSnapshot(once, '2026-10-03', snap))
})

Deno.test('sprint outcome: committed from the start snapshot, carry-over and scope churn', () => {
  const items = [done('a', '2026-10-03'), item('b'), item('c'), done('late', '2026-10-09')]
  const o = sprintOutcome({
    id: 's1',
    name: 'S1',
    start: '2026-10-01',
    end: '2026-10-05',
    items,
    snapshots: { '2026-10-01': { ids: ['a', 'b', 'gone'], done: [] } },
    metric: 'issues',
    now: T('2026-10-10'),
  })
  assertEquals([o.committed, o.completed, o.carried, o.added, o.removed, o.measured], [3, 1, 3, 2, 1, true])
  const unmeasured = sprintOutcome({ id: 's', name: 's', start: '2026-10-01', end: '2026-10-05', items, metric: 'issues', now: T('2026-10-10') })
  assertEquals([unmeasured.committed, unmeasured.measured], [4, false])
})

Deno.test('velocity averages the last sprints and reports say/do and trend', () => {
  const o = (completed: number, committed: number) => ({ id: '', name: '', committed, completed, carried: 0, added: 0, removed: 0, measured: true })
  const v = velocity([o(10, 12), o(12, 12), o(8, 10), o(14, 14)])
  assertEquals(v.average, 11.3)
  assertEquals(v.sayDo, 0.94)
  assertEquals(v.trend, 1)
  assertEquals(velocity([]).average, null)
})

Deno.test('capacity: days off reduce capacity; shared work splits; over-allocation flagged', () => {
  const items = [item('a', { assignees: ['u1'], estimate_point: 5 }), item('b', { assignees: ['u1', 'u2'], estimate_point: 4 }), item('c', { estimate_point: 3 }), done('d', '2026-10-02', { assignees: ['u2'], estimate_point: 8 })]
  const plan = capacityPlan({ entries: [{ member: 'u1', capacity: 10, daysOff: 5 }, { member: 'u2', capacity: 8 }], items, metric: 'points', workdays: 10 })
  const u1 = plan.rows.find((r) => r.member === 'u1')!
  const u2 = plan.rows.find((r) => r.member === 'u2')!
  assertEquals([u1.effective, u1.assigned, u1.over, u1.load], [5, 7, true, 1.4])
  assertEquals([u2.effective, u2.assigned, u2.over], [8, 2, false])
  assertEquals(plan.unassigned, 3)
  assertEquals(plan.totalCapacity, 13)
})

Deno.test('workdays and days off skip weekends', () => {
  // 2026-10-05 is a Monday.
  assertEquals(workdays(Date.parse('2026-10-05'), Date.parse('2026-10-18')), 10)
  assertEquals(daysOffIn([{ from: '2026-10-09', to: '2026-10-12' }], Date.parse('2026-10-05'), Date.parse('2026-10-18')), 2)
})

Deno.test('health: overdue work and a lagging sprint; a manual override wins until it expires', () => {
  const now = T('2026-10-20')
  const overdue = [1, 2, 3].map((n) => item(`o${n}`, { target_date: '2026-10-01' }))
  assertEquals(deriveHealth({ items: [...overdue, item('ok')], now }).health, 'off-track')
  assertEquals(deriveHealth({ items: [item('ok')], now }).health, 'on-track')
  const lag = deriveHealth({ items: [], activeSprint: { start_date: '2026-10-10', end_date: '2026-10-21', total: 4, done: 1 }, now })
  assertEquals(lag.health, 'off-track')
  const derived = deriveHealth({ items: [item('ok')], now })
  assertEquals(effectiveHealth(derived, { health: 'at-risk', note: 'vendor slip', at: '2026-10-19' }, now).health, 'at-risk')
  assertEquals(effectiveHealth(derived, { health: 'at-risk', at: '2026-10-01', until: '2026-10-10' }, now).overridden, false)
})

Deno.test('workload counts open work per person across projects', () => {
  const rows = workload({
    items: [item('a', { assignees: ['u1'], project: 'p1', state_group: 'started' }), item('b', { assignees: ['u1'], project: 'p2', estimate_point: 3 }), done('c', '2026-10-01', { assignees: ['u1'] })],
    capacity: { u1: 2 },
  })
  assertEquals(rows.length, 1)
  assertEquals([rows[0].open, rows[0].inProgress, rows[0].points, rows[0].projects.length, rows[0].over], [2, 1, 3, 2, true])
})

Deno.test('intake SLA uses the priority window', () => {
  const s = slaState('2026-10-20T00:00:00Z', 'urgent', undefined, Date.parse('2026-10-20T05:00:00Z'))!
  assertEquals([s.breached, Math.round(s.used * 100)], [true, 125])
  assertEquals(slaState('bad', 'low'), null)
  assert(isBugLabel('Bug') && isBugLabel('regressions') && !isBugLabel('debugger'))
})

Deno.test('epic burnup grows scope by creation and completed by completion', async () => {
  const { burnupByCreation } = await import('./planning-model.ts')
  const items = [item('a', { created_at: '2026-10-01T00:00:00Z' }), done('b', '2026-10-03', { created_at: '2026-10-02T00:00:00Z' }), item('x', { state_group: 'cancelled' })]
  const b = burnupByCreation({ items, start: '2026-10-01', end: '2026-10-05', now: T('2026-10-04') })!
  assertEquals(b.scope, [1, 2, 2, 2, null])
  assertEquals(b.completed, [0, 0, 1, 1, null])
  assertEquals(burnupByCreation({ items: [] }), null)
})

Deno.test('wall clock: a late-evening UTC instant is the next day in UTC+5:30', async () => {
  const { wallDay, wallNow, wallIso } = await import('./planning-model.ts')
  // 2026-10-20T19:13Z is 00:43 on the 21st in India (offset -330).
  assertEquals(wallDay('2026-10-20T19:13:00Z', -330), '2026-10-21')
  assertEquals(wallDay('2026-10-20', -330), '2026-10-20')
  assertEquals(new Date(wallNow(-330, Date.parse('2026-10-20T19:13:00Z'))).toISOString().slice(0, 10), '2026-10-21')
  assertEquals(wallIso(null), null)
})
