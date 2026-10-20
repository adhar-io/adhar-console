import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  averageAge,
  burn,
  controlChart,
  createdVsResolved,
  DAY,
  epicForecast,
  firstStarted,
  rollingAverage,
  sprintReport,
  timeInStatus,
  timelineFromHistory,
  toCsv,
  toWorkItems,
  velocity,
  type WorkItem,
  workload,
} from './insights-math.ts'
import { cfd, monthsBetween, readDays, recordDay, timelineFromDays } from './insights-snapshot.ts'

const T0 = Date.parse('2026-10-01T00:00:00Z')
const iso = (days: number, h = 12) => new Date(T0 + days * DAY + h * 3_600_000).toISOString()
const STATES = [
  { id: 'b', name: 'Backlog', group: 'backlog' },
  { id: 't', name: 'Todo', group: 'unstarted' },
  { id: 'p', name: 'In Progress', group: 'started' },
  { id: 'r', name: 'In Review', group: 'started' },
  { id: 'd', name: 'Done', group: 'completed' },
  { id: 'x', name: 'Cancelled', group: 'cancelled' },
]

function item(id: string, state: string, created: number, completed?: number, extra: Record<string, unknown> = {}): WorkItem {
  return toWorkItems([{
    id, name: id, state, project: 'p1', created_at: iso(created), updated_at: iso(completed ?? created),
    completed_at: completed !== undefined ? iso(completed) : null, sequence_id: Number(id.replace(/\D/g, '')) || 1, ...extra,
  }], STATES, 'CON')[0]
}

Deno.test('toWorkItems joins state groups and keys', () => {
  const [w] = toWorkItems([{ id: 'i1', name: 'n', state: 'p', project: 'p1', created_at: iso(0), sequence_id: 7, estimate_point: 3 }], STATES, 'CON')
  assertEquals(w.group, 'started')
  assertEquals(w.key, 'CON-7')
  assertEquals(w.points, 3)
  assertEquals(w.completedAt, undefined)
})

Deno.test('burndown: remaining falls on completion day; ideal is linear; future days carry only ideal', () => {
  const items = [
    item('i1', 'd', -1, 1, { estimate_point: 3 }),
    item('i2', 'd', -1, 3, { estimate_point: 5 }),
    item('i3', 't', -1, undefined, { estimate_point: 2 }),
    item('i4', 'x', -1, 2), // cancelled → out of scope
  ]
  const start = T0
  const end = T0 + 4 * DAY
  const now = T0 + 3 * DAY + 13 * 3_600_000
  const { points, total } = burn(items, start, end, now)
  assertEquals(total, 3)
  assertEquals(points.map((p) => p.remaining), [3, 2, 2, 1, undefined])
  assertEquals(points.map((p) => p.ideal), [3, 2.25, 1.5, 0.75, 0])
  const pts = burn(items, start, end, now, 'points')
  assertEquals(pts.total, 10)
  assertEquals(pts.points[3].remaining, 2)
  assertEquals(pts.points[3].completed, 8)
})

Deno.test('burnup: scope grows when work is created mid-sprint', () => {
  const items = [item('i1', 't', -3), item('i2', 'd', 2, 3)]
  const { points } = burn(items, T0, T0 + 4 * DAY, T0 + 4 * DAY)
  assertEquals(points.map((p) => p.scope), [1, 1, 2, 2, 2])
  assertEquals(points.map((p) => p.completed), [0, 0, 0, 1, 1])
})

Deno.test('velocity uses finished cycles only and averages the last three', () => {
  const cycles = [
    { id: 'c1', name: 'S1', end_date: '2026-09-01', total_issues: 10, completed_issues: 8, cancelled_issues: 1 },
    { id: 'c2', name: 'S2', end_date: '2026-09-15', total_issues: 10, completed_issues: 6 },
    { id: 'c3', name: 'S3', end_date: '2026-09-29', total_issues: 12, completed_issues: 10 },
    { id: 'c0', name: 'S0', end_date: '2026-08-15', total_issues: 4, completed_issues: 4 },
    { id: 'c4', name: 'Now', end_date: '2026-10-20', total_issues: 9, completed_issues: 2 },
  ]
  const v = velocity(cycles, T0 + 5 * DAY, new Map([['c3', [item('i1', 'd', -20, -10, { estimate_point: 5 }), item('i2', 't', -20, undefined, { estimate_point: 3 })]]]))
  assertEquals(v.rows.map((r) => r.name), ['S0', 'S1', 'S2', 'S3'])
  assertEquals(v.rows[1].committed, 9)
  assertEquals(v.average, 8)
  assertEquals(v.rows[3].completedPts, 5)
  assertEquals(v.rows[3].committedPts, 8)
})

Deno.test('created vs resolved buckets and running totals', () => {
  const items = [item('i1', 'd', 0, 1), item('i2', 't', 0), item('i3', 'd', 2, 2)]
  const b = createdVsResolved(items, T0, T0 + 2 * DAY)
  assertEquals(b.map((x) => [x.created, x.resolved]), [[2, 0], [0, 1], [1, 1]])
  assertEquals(b[2].cumCreated, 3)
  assertEquals(b[2].cumResolved, 2)
  assertEquals(createdVsResolved(items, T0, T0 + 6 * DAY, 'week').length, 1)
})

Deno.test('average age counts only items open at end of day', () => {
  const items = [item('i1', 'd', 0, 2), item('i2', 't', 1)]
  const a = averageAge(items, T0, T0 + 2 * DAY)
  assertEquals(a.map((x) => x.open), [1, 2, 1])
  assertAlmostEquals(a[0].age, 0.5, 1e-6)
  assertAlmostEquals(a[2].age, 1.5, 1e-6)
})

Deno.test('time in status + cycle time from Plane activity history', () => {
  const it = item('i1', 'd', 0, 5)
  const history = [
    { field: 'state', old_identifier: 'b', new_identifier: 't', created_at: iso(1) },
    { field: 'state', old_value: 'Todo', new_value: 'In Progress', created_at: iso(2) },
    { field: 'state', old_identifier: 'p', new_identifier: 'r', created_at: iso(4) },
    { field: 'state', old_identifier: 'r', new_identifier: 'd', created_at: iso(5) },
    { field: 'priority', created_at: iso(3) },
  ]
  const tl = timelineFromHistory(it, history, STATES, T0 + 10 * DAY)
  assertEquals(tl.map((s) => s.state), ['b', 't', 'p', 'r', 'd'])
  assertEquals(firstStarted(tl), Date.parse(iso(2)))
  const tis = timeInStatus([tl])
  assertEquals(tis.get('p')!.ms, 2 * DAY)
  assertEquals(tis.get('r')!.ms, DAY)
  assertEquals(tis.has('d'), false)
  const cc = controlChart([it], T0, T0 + 10 * DAY, () => firstStarted(tl))
  assertEquals(cc.points[0].days, 3)
  const lead = controlChart([it], T0, T0 + 10 * DAY)
  assertEquals(lead.points[0].days, 5)
})

Deno.test('control chart rolling average, mean and stdev', () => {
  assertEquals(rollingAverage([2, 4, 6, 8], 2), [2, 3, 5, 7])
  const items = [item('i1', 'd', 0, 2), item('i2', 'd', 0, 4), item('i3', 'd', 0, 6)]
  const cc = controlChart(items, T0, T0 + 10 * DAY, undefined, 3)
  assertEquals(cc.points.map((p) => p.days), [2, 4, 6])
  assertEquals(cc.mean, 4)
  assertEquals(cc.stdev, 2)
  assertEquals(cc.rolling.map((r) => r[1]), [2, 3, 4])
})

Deno.test('daily snapshots: once per day, CFD and day-granular timelines', () => {
  const day0 = [item('i1', 't', -5), item('i2', 'p', -5, undefined, { estimate_point: 3 })]
  let doc = recordDay(null, 'p1', day0, T0 + 3_600_000)!
  assertEquals(recordDay(doc, 'p1', day0, T0 + 5 * 3_600_000), null)
  const day1 = [item('i1', 'p', -5), item('i2', 'd', -5, 1, { estimate_point: 3 })]
  doc = recordDay(doc, 'p1', day1, T0 + DAY + 3_600_000)!
  const day2 = [item('i1', 'd', -5, 2), item('i2', 'd', -5, 1, { estimate_point: 3 })]
  doc = recordDay(doc, 'p1', day2, T0 + 2 * DAY + 3_600_000)!
  const days = readDays([doc])
  assertEquals(days.length, 3)
  const flow = cfd(days)
  assertEquals(flow.find((f) => f.group === 'completed')!.points.map((p) => p[1]), [0, 1, 2])
  assertEquals(flow.find((f) => f.group === 'started')!.points.map((p) => p[1]), [1, 1, 0])
  assertEquals(cfd(days, 'points').find((f) => f.group === 'completed')!.points.map((p) => p[1]), [0, 3, 3])
  const tl = timelineFromDays(1, days, T0 + 3 * DAY)
  assertEquals(tl.map((s) => [s.state, (s.to - s.from) / DAY]), [['t', 1], ['p', 1], ['d', 1]])
  assertEquals(timeInStatus([tl]).get('p')!.ms, DAY)
  assertEquals(monthsBetween(Date.parse('2026-11-20'), Date.parse('2027-01-02')), ['2026-11', '2026-12', '2027-01'])
})

Deno.test('workload, sprint report and epic forecast', () => {
  const now = T0 + 10 * DAY
  const items = [
    item('i1', 'p', 0, undefined, { assignees: ['u1'], target_date: '2026-10-05', estimate_point: 2 }),
    item('i2', 't', 0, undefined, { assignees: ['u1', 'u2'] }),
    item('i3', 'd', 0, 8, { assignees: ['u2'], estimate_point: 3 }),
    item('i4', 't', 5),
    item('i5', 'x', 0),
  ]
  const w = workload(items, now)
  assertEquals(w[0], { assignee: 'u1', open: 2, points: 2, overdue: 1, inProgress: 1 })
  assert(w.some((r) => r.assignee === '' && r.open === 1))
  const s = sprintReport(items, T0 + DAY)
  assertEquals([s.completed.length, s.notCompleted.length, s.cancelled.length, s.createdAfterStart.length], [1, 3, 1, 1])
  assertEquals(s.completion, 25)
  const f = epicForecast(items, now, 2)
  assertEquals([f.total, f.done, f.remaining], [4, 1, 3])
  assertEquals(f.ratePerWeek, 0.5)
  assertEquals(f.eta, now + 6 * 7 * DAY)
})

Deno.test('csv quotes separators and neutralises formulas', () => {
  assertEquals(toCsv([{ a: 'x,y', b: '=SUM(A1)', c: -3 }]), 'a,b,c\n"x,y",\'=SUM(A1),-3')
})

Deno.test('burndown ideal starts from work left on day one', () => {
  const items = [item('i1', 'd', -5, -2), item('i2', 't', -5), item('i3', 't', -5)]
  const { points } = burn(items, T0, T0 + 2 * DAY, T0 + 2 * DAY)
  assertEquals(points.map((p) => p.ideal), [2, 1, 0])
  assertEquals(points[0].remaining, 2)
})
