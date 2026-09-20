import { assertEquals } from 'jsr:@std/assert'
import {
  type AlertSeries,
  changeFailureRate,
  type DeployEvent,
  formatDuration,
  formatRate,
  type Incident,
  incidentsFromSeries,
  mttrSummary,
} from './dora-incidents.ts'

/**
 * These tiles are numbers someone will quote in a review, so the ways they
 * could be quietly wrong matter more than the happy path: a permanently
 * firing Watchdog dragging the mean to infinity, an open incident counted as
 * recovered, or a pre-existing alert blamed on the next deploy.
 */

const STEP = 5 * 60_000
const T0 = Date.UTC(2026, 8, 20, 0, 0, 0)

/** A series firing at `count` consecutive steps from `startOffsetSteps`. */
function firing(
  labels: Record<string, string>,
  startOffsetSteps: number,
  count: number,
): AlertSeries {
  return {
    metric: { alertname: 'KubePodNotReady', severity: 'warning', ...labels },
    values: Array.from({ length: count }, (_, i) => {
      const ms = T0 + (startOffsetSteps + i) * STEP
      return [ms / 1000, '1'] as [number, string]
    }),
  }
}

/** Window end far past every sample, so runs read as resolved. */
const END = T0 + 100 * STEP

/* ─────────── run detection ─────────── */

Deno.test('a contiguous run becomes one incident', () => {
  const inc = incidentsFromSeries([firing({ namespace: 'payments' }, 0, 6)], STEP, END)
  assertEquals(inc.length, 1)
  assertEquals(inc[0].namespace, 'payments')
  assertEquals(inc[0].resolved, true)
  // 5 steps between first and last sample, plus one for the step it stopped in.
  assertEquals(inc[0].durationMs, 6 * STEP)
})

Deno.test('a gap splits one series into two incidents', () => {
  // Firing, recovered, firing again is two incidents — merging them would
  // report a single recovery far longer than either.
  const s = firing({ namespace: 'payments' }, 0, 3)
  const later = firing({ namespace: 'payments' }, 20, 3)
  s.values.push(...later.values)
  const inc = incidentsFromSeries([s], STEP, END)
  assertEquals(inc.length, 2)
  assertEquals(inc[0].startMs, T0)
  assertEquals(inc[1].startMs, T0 + 20 * STEP)
})

Deno.test('jitter of one step does not split a run', () => {
  // The rule interval and the query step rarely line up exactly; a missed
  // sample must not read as a recovery.
  const s: AlertSeries = {
    metric: { alertname: 'A', severity: 'warning' },
    values: [0, 1, 3, 4].map((i) => [(T0 + i * STEP) / 1000, '1'] as [number, string]),
  }
  assertEquals(incidentsFromSeries([s], STEP * 2, END).length, 1)
})

Deno.test('a single-sample blip is one step long, not zero', () => {
  const inc = incidentsFromSeries([firing({ namespace: 'x' }, 0, 1)], STEP, END)
  assertEquals(inc[0].durationMs, STEP)
})

Deno.test('samples arriving out of order are still one run', () => {
  const s = firing({ namespace: 'x' }, 0, 4)
  s.values.reverse()
  assertEquals(incidentsFromSeries([s], STEP, END).length, 1)
})

/* ─────────── exclusions ─────────── */

Deno.test('Watchdog is never an incident', () => {
  // It fires forever by design; as an incident it is an unbounded outlier.
  const s = firing({ namespace: 'monitoring' }, 0, 500)
  s.metric.alertname = 'Watchdog'
  assertEquals(incidentsFromSeries([s], STEP, END), [])
})

Deno.test('InfoInhibitor is never an incident', () => {
  const s = firing({}, 0, 500)
  s.metric.alertname = 'InfoInhibitor'
  assertEquals(incidentsFromSeries([s], STEP, END), [])
})

Deno.test('info-severity alerts are notifications, not incidents', () => {
  const s = firing({}, 0, 5)
  s.metric.severity = 'info'
  assertEquals(incidentsFromSeries([s], STEP, END), [])
})

Deno.test('critical and warning both count', () => {
  const a = firing({ namespace: 'x' }, 0, 3)
  a.metric.severity = 'critical'
  const b = firing({ namespace: 'y' }, 0, 3)
  assertEquals(incidentsFromSeries([a, b], STEP, END).length, 2)
})

Deno.test('an empty series is skipped rather than producing a zero incident', () => {
  assertEquals(
    incidentsFromSeries([{ metric: { alertname: 'A', severity: 'warning' }, values: [] }], STEP, END),
    [],
  )
})

/* ─────────── MTTR ─────────── */

Deno.test('an incident still firing at the window end is not resolved', () => {
  const inc = incidentsFromSeries([firing({ namespace: 'x' }, 0, 4)], STEP, T0 + 3 * STEP)
  assertEquals(inc[0].resolved, false)
})

Deno.test('open incidents are excluded from MTTR, not counted as instant recoveries', () => {
  // This is the bias that matters: folding them in reports service being
  // restored FASTER than it is.
  const resolved = firing({ namespace: 'a' }, 0, 13) // 12 steps = 1h
  const open = firing({ namespace: 'b' }, 0, 90)
  const inc = incidentsFromSeries([resolved, open], STEP, T0 + 89 * STEP)
  const m = mttrSummary(inc)
  assertEquals(m.resolvedCount, 1)
  assertEquals(m.ongoingCount, 1)
  assertEquals(m.medianHours, 13 * STEP / 3_600_000)
})

Deno.test('MTTR is null when nothing has recovered yet', () => {
  const inc = incidentsFromSeries([firing({ namespace: 'x' }, 0, 5)], STEP, T0 + 4 * STEP)
  const m = mttrSummary(inc)
  assertEquals(m.medianHours, null)
  assertEquals(m.meanHours, null)
  assertEquals(m.resolvedCount, 0)
  assertEquals(m.ongoingCount, 1)
})

Deno.test('the median resists a single long outlier that the mean does not', () => {
  const mk = (steps: number, ns: string): Incident => ({
    alertname: 'A',
    severity: 'warning',
    namespace: ns,
    workload: null,
    startMs: T0,
    endMs: T0 + steps * STEP,
    durationMs: steps * STEP,
    resolved: true,
  })
  // Three quick recoveries and one that ran all weekend.
  const m = mttrSummary([mk(12, 'a'), mk(12, 'b'), mk(12, 'c'), mk(12 * 48, 'd')])
  assertEquals(m.medianHours, 1)
  assertEquals(m.meanHours! > 10, true)
})

Deno.test('an even number of recoveries averages the middle two', () => {
  const mk = (h: number): Incident => ({
    alertname: 'A',
    severity: 'warning',
    namespace: 'a',
    workload: null,
    startMs: T0,
    endMs: T0 + h * 3_600_000,
    durationMs: h * 3_600_000,
    resolved: true,
  })
  assertEquals(mttrSummary([mk(1), mk(2), mk(3), mk(6)]).medianHours, 2.5)
})

/* ─────────── change failure rate ─────────── */

const incident = (ns: string, atSteps: number, workload: string | null = 'api'): Incident => ({
  alertname: 'KubePodNotReady',
  severity: 'warning',
  namespace: ns,
  workload,
  startMs: T0 + atSteps * STEP,
  endMs: T0 + (atSteps + 2) * STEP,
  durationMs: 2 * STEP,
  resolved: true,
})

const deploy = (
  ns: string | null,
  atSteps: number,
  workloads: string[] = ['api'],
): DeployEvent => ({ namespace: ns, atMs: T0 + atSteps * STEP, workloads })

Deno.test('a deploy followed by a new incident on its workload is a failure', () => {
  const r = changeFailureRate([deploy('payments', 0)], [incident('payments', 2)])
  assertEquals(r, { rate: 1, failed: 1, total: 1 })
})

Deno.test('an incident already firing before the deploy is not blamed on it', () => {
  // Otherwise every deploy into an already-broken namespace looks like the
  // cause, and the rate says more about the cluster than about the changes.
  const r = changeFailureRate([deploy('payments', 10)], [incident('payments', 0)])
  assertEquals(r.failed, 0)
})

Deno.test('an incident long after the deploy is outside the attribution window', () => {
  const r = changeFailureRate([deploy('payments', 0)], [incident('payments', 100)])
  assertEquals(r.failed, 0)
})

Deno.test('an incident on a DIFFERENT workload in the same namespace is not attributed', () => {
  // This is the whole reason attribution is per-workload: on a real cluster
  // 80 of 81 Argo CD apps share the `adhar-system` namespace, and namespace
  // matching reported a 98.2% change failure rate.
  const r = changeFailureRate(
    [deploy('adhar-system', 0, ['payments-api'])],
    [incident('adhar-system', 2, 'unrelated-worker')],
  )
  assertEquals(r.failed, 0)
})

Deno.test("a pod-level alert maps back to its deployment", () => {
  // Alerts often name the pod: `payments-api-7d9f8b6c4-x2k9p`.
  const r = changeFailureRate(
    [deploy('x', 0, ['payments-api'])],
    [incident('x', 2, 'payments-api-7d9f8b6c4-x2k9p')],
  )
  assertEquals(r.failed, 1)
})

Deno.test('prefix matching is directional, and its limit is known', () => {
  // The prefix rule exists to map a pod back to its Deployment, and it cannot
  // tell `payments-<pod-hash>` from the sibling Deployment `payments-web`.
  // Pinned rather than hidden: over-attribution to a same-prefix sibling in
  // the same namespace within the hour is the accepted cost of catching
  // pod-level alerts at all.
  const sibling = changeFailureRate(
    [deploy('x', 0, ['payments'])],
    [incident('x', 2, 'payments-web')],
  )
  assertEquals(sibling.failed, 1)
  // It does not run the other way: a longer workload name never claims a
  // shorter alert target.
  const reverse = changeFailureRate(
    [deploy('x', 0, ['payments-web'])],
    [incident('x', 2, 'payments')],
  )
  assertEquals(reverse.failed, 0)
})

Deno.test('an incident in another namespace is not attributed', () => {
  const r = changeFailureRate([deploy('payments', 0)], [incident('search', 2)])
  assertEquals(r.failed, 0)
})

Deno.test('the rate is failures over measurable deploys', () => {
  const r = changeFailureRate(
    [deploy('a', 0, ['a']), deploy('a', 0, ['b']), deploy('a', 0, ['c']), deploy('a', 0, ['d'])],
    [incident('a', 1, 'a')],
  )
  assertEquals(r.total, 4)
  assertEquals(r.failed, 1)
  assertEquals(r.rate, 0.25)
})

Deno.test('two incidents after one deploy still count that deploy once', () => {
  const r = changeFailureRate([deploy('a', 0)], [incident('a', 1), incident('a', 2)])
  assertEquals(r.failed, 1)
})

Deno.test('no deploys means no rate, rather than a misleading zero', () => {
  assertEquals(changeFailureRate([], [incident('a', 1)]), { rate: null, failed: 0, total: 0 })
})

Deno.test('a deploy that owns no workloads is left out of both halves', () => {
  // A ConfigMap-only application cannot be attributed either way. Counting it
  // as a success would quietly drag the rate toward zero.
  const r = changeFailureRate(
    [deploy('a', 0, []), deploy('a', 0, ['api'])],
    [incident('a', 1, 'api')],
  )
  assertEquals(r.total, 1)
  assertEquals(r.failed, 1)
  assertEquals(r.rate, 1)
})

Deno.test('an incident naming no workload cannot be attributed', () => {
  const r = changeFailureRate([deploy('a', 0)], [incident('a', 1, null)])
  assertEquals(r.failed, 0)
})

/* ─────────── formatting ─────────── */

Deno.test('rates and durations read the way the tiles show them', () => {
  assertEquals(formatRate(0.0721), '7.2%')
  assertEquals(formatRate(0), '0.0%')
  assertEquals(formatDuration(0.5), '30m')
  assertEquals(formatDuration(1.58), '1.6h')
  assertEquals(formatDuration(72), '3.0d')
})
