import { assertAlmostEquals, assertEquals } from 'jsr:@std/assert'
import { parseProgress, stageTimings } from './perf-progress.ts'

const RUN = [
  'time="2026-09-24T10:00:00Z" level=info msg="starting"',
  'running (0m01.0s), 05/10 VUs, 10 complete and 0 interrupted iterations',
  'default   [   3% ] 05/10 VUs  0m01.0s/0m30.0s',
  'running (0m02.0s), 10/10 VUs, 30 complete and 0 interrupted iterations',
  'default   [   6% ] 10/10 VUs  0m02.0s/0m30.0s',
  'running (0m03.0s), 10/10 VUs, 55 complete and 1 interrupted iterations',
]

Deno.test('parseProgress: reads VUs and iterations from k6 progress lines', () => {
  const s = parseProgress(RUN)
  assertEquals(s.points.length, 3)
  assertEquals(s.points[0], { elapsedSecs: 1, vus: 5, vusMax: 10, complete: 10, interrupted: 0 })
  assertEquals(s.last?.complete, 55)
  assertEquals(s.last?.interrupted, 1)
  assertEquals(s.peakVus, 10)
  assertEquals(s.plannedSecs, 30)
  assertEquals(s.percent, 6)
})

Deno.test('parseProgress: iteration rate is the difference between points', () => {
  const s = parseProgress(RUN)
  // 10 → 30 over one second, then 30 → 55.
  assertEquals(s.rate.map((r) => r.perSec), [20, 25])
})

Deno.test('parseProgress: a steady stage prints a bare VU count', () => {
  const s = parseProgress(['running (1m02.5s), 25 VUs, 900 complete and 0 interrupted iterations'])
  assertEquals(s.points.length, 1)
  assertAlmostEquals(s.points[0].elapsedSecs, 62.5)
  assertEquals(s.points[0].vus, 25)
  assertEquals(s.points[0].vusMax, undefined)
})

Deno.test('parseProgress: redraws of the same second collapse to the last one', () => {
  const s = parseProgress([
    'running (0m05.0s), 01/10 VUs, 1 complete and 0 interrupted iterations\rrunning (0m05.0s), 07/10 VUs, 9 complete and 0 interrupted iterations',
  ])
  assertEquals(s.points.length, 1)
  assertEquals(s.points[0].vus, 7)
  assertEquals(s.points[0].complete, 9)
})

Deno.test('parseProgress: ANSI colour does not hide the numbers', () => {
  const s = parseProgress(['[32mrunning (0m04.0s), 03/03 VUs, 12 complete and 0 interrupted iterations[0m'])
  assertEquals(s.points[0]?.vus, 3)
  assertEquals(s.points[0]?.complete, 12)
})

Deno.test('parseProgress: output with no progress lines yields nothing, not zeroes', () => {
  const s = parseProgress(['level=info msg="init"', 'some other output'])
  assertEquals(s.points, [])
  assertEquals(s.rate, [])
  assertEquals(s.last, undefined)
  assertEquals(s.peakVus, 0)
})

Deno.test('parseProgress: a restarted runner does not produce a negative rate', () => {
  const s = parseProgress([
    'running (0m01.0s), 05/05 VUs, 50 complete and 0 interrupted iterations',
    'running (0m02.0s), 05/05 VUs, 5 complete and 0 interrupted iterations',
    'running (0m03.0s), 05/05 VUs, 15 complete and 0 interrupted iterations',
  ])
  assertEquals(s.rate.map((r) => r.perSec), [10])
})

/* ─────────────────────────── stage timings ─────────────────────────── */

const ORDER = ['initialization', 'initialized', 'created', 'started', 'finished']

Deno.test('stageTimings: durations come from condition transitions', () => {
  const t = stageTimings(ORDER, [
    { type: 'TestRunInitialization', status: 'True', lastTransitionTime: '2026-09-24T10:00:00Z' },
    { type: 'TestRunInitialized', status: 'True', lastTransitionTime: '2026-09-24T10:00:10Z' },
    { type: 'TestRunCreated', status: 'True', lastTransitionTime: '2026-09-24T10:00:12Z' },
    { type: 'TestRunStarted', status: 'True', lastTransitionTime: '2026-09-24T10:00:15Z' },
    { type: 'TestRunFinished', status: 'True', lastTransitionTime: '2026-09-24T10:01:15Z' },
  ])
  assertEquals(t.map((x) => x.secs), [10, 2, 3, 60, undefined])
  assertEquals(t[0].stage, 'initialization')
})

Deno.test('stageTimings: the last stage closes against the run end when given one', () => {
  const end = Date.parse('2026-09-24T10:01:30Z')
  const t = stageTimings(ORDER, [
    { type: 'TestRunStarted', status: 'True', lastTransitionTime: '2026-09-24T10:01:00Z' },
  ], end)
  assertEquals(t.find((x) => x.stage === 'started')?.secs, 30)
})

Deno.test('stageTimings: stages never reached have no time, not zero', () => {
  const t = stageTimings(ORDER, [
    { type: 'TestRunInitialization', status: 'True', lastTransitionTime: '2026-09-24T10:00:00Z' },
  ])
  assertEquals(t.filter((x) => x.atMs !== undefined).length, 1)
  assertEquals(t.find((x) => x.stage === 'finished')?.secs, undefined)
})

Deno.test('stageTimings: an unparseable timestamp is ignored rather than dated to 1970', () => {
  const t = stageTimings(ORDER, [
    { type: 'TestRunStarted', status: 'True', lastTransitionTime: 'not-a-date' },
  ])
  assertEquals(t.every((x) => x.atMs === undefined), true)
})
