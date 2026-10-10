import { assertEquals } from 'jsr:@std/assert@^1.0.0'
import { describeProgress, taskProgress } from './pipeline-progress.ts'

// The adhar-ui release of 2026-10-09: build failed, four tasks skipped. The
// old count read "3/7 tasks" and said nothing about the four that never ran.
Deno.test('a failed run counts its terminal tasks and names the failure and the skips', () => {
  const p = taskProgress('Tasks Completed: 3 (Failed: 1, Cancelled 0), Skipped: 4', 7, 3)
  assertEquals(p, { done: 3, total: 7, failed: 1, skipped: 4 })
  assertEquals(describeProgress(p!), '3/7 tasks · 1 failed · 4 skipped')
})

Deno.test('a running run reports the whole graph, not just what has started', () => {
  // Four child references exist (two done, two running) — the old count said 4/6.
  const p = taskProgress('Tasks Completed: 2 (Failed: 0, Cancelled 0), Incomplete: 4, Skipped: 0', 6, 4)
  assertEquals(p, { done: 2, total: 6 })
  assertEquals(describeProgress(p!), '2/6 tasks')
})

Deno.test('a run too young for a condition message falls back to child references', () => {
  assertEquals(taskProgress(undefined, 6, 1), { done: 1, total: 6 })
  assertEquals(taskProgress(undefined, undefined, 1), undefined)
})

Deno.test('a cancelled task counts as failed, not as progress', () => {
  const p = taskProgress('Tasks Completed: 2 (Failed: 0, Cancelled 1), Skipped: 3', 6, 2)
  assertEquals(p, { done: 2, total: 6, failed: 1, skipped: 3 })
})
