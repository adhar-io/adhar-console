import { assertEquals } from 'jsr:@std/assert@1'
import { type BulkIssue, planBulk, requestCount, retryAfterSeconds, runBulk } from './work-bulk.ts'

const mk = (id: string, extra: Partial<BulkIssue> = {}): BulkIssue => ({
  id, project: 'p1', state: 's-todo', priority: 'none', assignees: [], labels: [], cycle: null, module: null, ...extra,
})
const ISSUES = [
  mk('a', { assignees: ['u1'], labels: ['bug'], cycle: 'c1', module: 'm1', state: 's-done' }),
  mk('b', { priority: 'high', cycle: null }),
  mk('c', { project: 'p2', assignees: ['u1', 'u2'], labels: ['bug', 'ui'], cycle: 'c9' }),
]

Deno.test('state and priority patches skip unchanged items', () => {
  const p = planBulk(ISSUES, { kind: 'priority', priority: 'high' })
  assertEquals(p.patches.map((x) => [x.id, x.patch]), [['a', { priority: 'high' }], ['c', { priority: 'high' }]])
  assertEquals(p.skipped.map((s) => s.id), ['b'])
  const s = planBulk(ISSUES, { kind: 'state', state: 's-todo' }, { stateProject: () => 'p1' })
  assertEquals(s.patches.map((x) => x.id), ['a'])
  assertEquals(s.skipped.map((x) => [x.id, x.reason]), [['b', 'already in that state'], ['c', 'that state belongs to another project']])
})

Deno.test('assignee / label add, remove and set', () => {
  assertEquals(planBulk(ISSUES, { kind: 'assignees', mode: 'add', ids: ['u2'] }).patches.map((x) => [x.id, x.patch.assignees]), [['a', ['u1', 'u2']], ['b', ['u2']]])
  assertEquals(planBulk(ISSUES, { kind: 'assignees', mode: 'remove', ids: ['u1'] }).patches.map((x) => [x.id, x.patch.assignees]), [['a', []], ['c', ['u2']]])
  assertEquals(planBulk(ISSUES, { kind: 'assignees', mode: 'set', ids: [] }).patches.map((x) => x.id), ['a', 'c'])
  assertEquals(planBulk(ISSUES, { kind: 'labels', mode: 'add', ids: ['bug'] }).patches.map((x) => [x.id, x.patch.labels]), [['b', ['bug']]])
})

Deno.test('sprint moves batch into one POST per project+cycle; clearing removes from the old one', () => {
  const p = planBulk(ISSUES, { kind: 'cycle', cycle: 'c1' })
  assertEquals(p.cycleAdd, [{ project: 'p1', cycle: 'c1', ids: ['b'] }, { project: 'p2', cycle: 'c1', ids: ['c'] }])
  assertEquals(p.skipped.map((s) => s.id), ['a'])
  const clear = planBulk(ISSUES, { kind: 'cycle', cycle: null })
  assertEquals(clear.cycleRemove, [{ project: 'p1', cycle: 'c1', id: 'a' }, { project: 'p2', cycle: 'c9', id: 'c' }])
  assertEquals(requestCount(clear), 2)
})

Deno.test('epic moves remove the old module then add to the new one', () => {
  const p = planBulk(ISSUES, { kind: 'module', module: 'm2' })
  assertEquals(p.moduleRemove, [{ project: 'p1', module: 'm1', id: 'a' }])
  assertEquals(p.moduleAdd, [{ project: 'p1', module: 'm2', ids: ['a', 'b'] }, { project: 'p2', module: 'm2', ids: ['c'] }])
})

Deno.test('estimates go through the mapping client; archive only done/cancelled', () => {
  const e = planBulk(ISSUES, { kind: 'estimate', value: 3 })
  assertEquals(e.patches.every((x) => x.via === 'mapped'), true)
  const a = planBulk(ISSUES, { kind: 'archive' }, { stateGroup: (s) => (s === 's-done' ? 'completed' : 'unstarted') })
  assertEquals(a.archive, [{ project: 'p1', id: 'a' }])
  assertEquals(a.skipped.length, 2)
})

Deno.test('retryAfterSeconds reads DRF throttle messages', () => {
  assertEquals(retryAfterSeconds({ status: 429, body: { detail: 'Request was throttled. Expected available in 37 seconds.' } }), 37)
  assertEquals(retryAfterSeconds({ status: 429, body: {} }), 60)
  assertEquals(retryAfterSeconds({ status: 500 }), undefined)
})

Deno.test('runBulk: order, 429 wait-and-retry, per-item failures', async () => {
  const plan = planBulk(ISSUES, { kind: 'module', module: 'm2' })
  plan.patches.push({ id: 'z', project: 'p1', patch: { priority: 'low' }, via: 'raw' })
  const log: string[] = []
  let throttled = false
  const sleeps: number[] = []
  const res = await runBulk(plan, {
    patch: (p) => {
      log.push(`patch ${p.id}`)
      return Promise.reject(new Error('boom'))
    },
    cycleAdd: () => Promise.resolve(),
    cycleRemove: () => Promise.resolve(),
    moduleAdd: (_p, m, ids) => {
      log.push(`add ${m} ${ids.join(',')}`)
      if (!throttled) {
        throttled = true
        return Promise.reject({ status: 429, body: { detail: 'Expected available in 2 seconds.' } })
      }
      return Promise.resolve()
    },
    moduleRemove: (_p, m, id) => {
      log.push(`remove ${m} ${id}`)
      return Promise.resolve()
    },
    archive: () => Promise.resolve(),
  }, { concurrency: 1, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) })
  assertEquals(log[0], 'remove m1 a')
  assertEquals(sleeps, [2250])
  assertEquals(res.ok, 4) // a removed, a+b added (after retry), c added
  assertEquals(res.failed.map((f) => f.ids), [['z']])
})
