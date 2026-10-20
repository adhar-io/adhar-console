import { assertEquals } from 'jsr:@std/assert@1'
import {
  alignableParents,
  alignmentTree,
  type KeyResult,
  krProgress,
  linkedProgress,
  type Objective,
  objectiveConfidence,
  objectiveProgress,
  objectiveScore,
  paceStatus,
  progressHistory,
  scoreBand,
  shiftQuarter,
  upgradeObjective,
} from './okrs-model.ts'

const kr = (p: Partial<KeyResult>): KeyResult => ({ id: Math.random().toString(36).slice(2), title: 'kr', unit: '', start: 0, target: 100, current: 0, ...p })
const obj = (p: Partial<Objective>): Objective => ({
  id: 'o', project: 'p1', title: 'o', ownerId: 'u', quarter: '2026-Q4', key_results: [], created_at: '', updated_at: '', ...p,
})

Deno.test('KR progress: metric both directions, percentage, milestone, auto-linked', () => {
  assertEquals(krProgress(kr({ start: 0, target: 200, current: 50 })), 25)
  assertEquals(krProgress(kr({ start: 800, target: 200, current: 500 })), 50) // reduce latency
  assertEquals(krProgress(kr({ start: 0, target: 10, current: 15 })), 100)
  assertEquals(krProgress(kr({ type: 'percentage', start: 20, target: 80, current: 50 })), 50)
  assertEquals(krProgress(kr({ type: 'milestone', milestones: [{ id: 'a', title: 'a', done: true }, { id: 'b', title: 'b', done: false }, { id: 'c', title: 'c', done: true }, { id: 'd', title: 'd', done: true }] })), 75)
  const links = [{ kind: 'module' as const, project: 'p1', id: 'm1', label: 'Auth' }, { kind: 'issue' as const, project: 'p1', id: 'i9', label: 'CON-9' }]
  const resolve = (l: { id: string }) => (l.id === 'm1' ? { done: 3, total: 9 } : { done: 1, total: 1 })
  assertEquals(linkedProgress(links, resolve), 40)
  assertEquals(krProgress(kr({ auto: true, links, current: 99 }), resolve), 40)
  // Auto with nothing resolvable falls back to the manual value.
  assertEquals(krProgress(kr({ auto: true, links, current: 30 }), () => undefined), 30)
})

Deno.test('objective roll-up: weighted KRs, else aligned children', () => {
  const o = obj({ key_results: [kr({ current: 100, weight: 3 }), kr({ current: 0 })] })
  assertEquals(objectiveProgress(o), 75)
  const company = obj({ id: 'c', project: '', level: 'company', key_results: [] })
  const t1 = obj({ id: 't1', parentId: 'c', key_results: [kr({ current: 60 })] })
  const t2 = obj({ id: 't2', parentId: 'c', key_results: [kr({ current: 20 })] })
  assertEquals(objectiveProgress(company, [company, t1, t2]), 40)
  assertEquals(objectiveScore(company, 40), 0.4)
  assertEquals(objectiveScore({ ...company, score: 0.85 }, 40), 0.85)
  assertEquals([scoreBand(0.7), scoreBand(0.5), scoreBand(0.2)], ['hit', 'progress', 'miss'])
})

Deno.test('alignment tree orders by level and survives cycles', () => {
  const a = obj({ id: 'a', level: 'company', title: 'A' })
  const b = obj({ id: 'b', level: 'team', parentId: 'a', title: 'B' })
  const c = obj({ id: 'c', level: 'individual', parentId: 'b', title: 'C' })
  const x = obj({ id: 'x', parentId: 'y', title: 'X' })
  const y = obj({ id: 'y', parentId: 'x', title: 'Y' })
  const tree = alignmentTree([c, b, a, x, y])
  assertEquals(tree.map((n) => n.objective.id).sort(), ['a', 'x', 'y'])
  const an = tree.find((n) => n.objective.id === 'a')!
  assertEquals(an.children[0].objective.id, 'b')
  assertEquals(an.children[0].children[0].depth, 2)
  assertEquals(alignableParents(a, [a, b, c]).map((o) => o.id), [])
  assertEquals(alignableParents(c, [a, b, c]).map((o) => o.id), ['a', 'b'])
})

Deno.test('check-in history and confidence', () => {
  const k1 = kr({ id: 'k1', checkIns: [
    { id: '1', at: '2026-10-01T00:00:00Z', value: 10, progress: 10, confidence: 6 },
    { id: '2', at: '2026-10-08T00:00:00Z', value: 40, progress: 40, confidence: 8 },
  ] })
  const k2 = kr({ id: 'k2', checkIns: [{ id: '3', at: '2026-10-05T00:00:00Z', value: 50, progress: 50, confidence: 4 }] })
  const o = obj({ key_results: [k1, k2] })
  assertEquals(progressHistory(o).map((p) => p[1]), [5, 30, 45])
  assertEquals(objectiveConfidence(o), 6)
})

Deno.test('quarters, pace and legacy upgrade', () => {
  assertEquals(shiftQuarter('2026-Q4', 1), '2027-Q1')
  assertEquals(shiftQuarter('2026-Q1', -1), '2025-Q4')
  const mid = new Date(2026, 10, 15).getTime() // ~50% through Q4
  assertEquals(paceStatus(48, '2026-Q4', mid), 'on-track')
  assertEquals(paceStatus(30, '2026-Q4', mid), 'at-risk')
  assertEquals(paceStatus(5, '2026-Q4', mid), 'off-track')
  const up = upgradeObjective(obj({ project: '', key_results: [kr({})] }))
  assertEquals(up.level, 'company')
  assertEquals(up.key_results[0].type, 'metric')
})
