/**
 * What the load generator was doing WHILE it ran, read from its own output.
 *
 * k6 prints a progress line roughly once a second for the whole test:
 *
 *     running (0m10.0s), 05/10 VUs, 120 complete and 0 interrupted iterations
 *     default   [  33% ] 05/10 VUs  0m10.0s/0m30.0s
 *
 * That is the only live signal this platform has. The k6 Prometheus
 * remote-write output is not enabled on the operator here — there are no
 * `k6_*` series in Prometheus — so a chart of VUs or throughput over time has
 * to come from stdout or not exist. Parsing it is exact rather than
 * approximate: these are k6's own counters, printed by k6, not a sample of
 * something else that correlates with them.
 *
 * What stdout does NOT carry is latency over time. The percentiles are
 * computed once, at the end, and printed in the summary block. So the live
 * view shows concurrency and throughput honestly and says plainly that
 * percentiles arrive when the test finishes, rather than drawing a p95 line
 * from numbers that do not exist.
 */

export interface ProgressPoint {
  /** Seconds since the test started, from k6's own clock. */
  elapsedSecs: number
  /** Virtual users active at that moment. */
  vus: number
  /** VUs the stage was aiming for, when k6 printed a target. */
  vusMax?: number
  /** Iterations finished since the test began. */
  complete: number
  /** Iterations abandoned when the test ended mid-flight. */
  interrupted: number
}

export interface ProgressSeries {
  points: ProgressPoint[]
  /** Iterations per second between consecutive points. */
  rate: Array<{ elapsedSecs: number; perSec: number }>
  /** Peak VUs actually reached. */
  peakVus: number
  /** Latest values, for the tiles above the charts. */
  last?: ProgressPoint
  /** Total test length k6 reported (`0m10.0s/0m30.0s`), when it printed one. */
  plannedSecs?: number
  /** 0–100 from k6's own percentage, when it printed one. */
  percent?: number
}

/**
 * `running (1m02.5s), 05/10 VUs, 120 complete and 3 interrupted iterations`
 *
 * The VU field is `05/10` while a stage is ramping and a bare `10` once it is
 * steady, so the second half is optional.
 */
const RUNNING_RE =
  /running\s+\((\d+)m([\d.]+)s\),\s*(\d+)(?:\/(\d+))?\s+VUs,\s*(\d+)\s+complete\s+and\s+(\d+)\s+interrupted\s+iterations/

/** `default   [  33% ] 05/10 VUs  0m10.0s/0m30.0s` — the planned total length. */
const PLAN_RE = /\[\s*(\d+)%\s*\].*?(\d+)m([\d.]+)s\s*\/\s*(\d+)m([\d.]+)s/

function secs(minutes: string, seconds: string): number {
  return Number(minutes) * 60 + Number(seconds)
}

/**
 * Read every progress line out of a runner's output.
 *
 * Tolerant by design: k6 redraws the progress line with carriage returns and
 * ANSI colour, the console's log stream may merge several pods, and a line can
 * arrive half-written. Anything that does not match is skipped rather than
 * guessed at.
 */
export function parseProgress(lines: readonly string[]): ProgressSeries {
  const byElapsed = new Map<number, ProgressPoint>()
  let plannedSecs: number | undefined
  let percent: number | undefined

  for (const raw of lines) {
    // One physical line can hold several redraws separated by \r, and ANSI
    // escapes sit between the fields.
    for (const part of stripAnsi(raw).split(/[\r\n]+/)) {
      const m = RUNNING_RE.exec(part)
      if (m) {
        const elapsedSecs = secs(m[1], m[2])
        const point: ProgressPoint = {
          elapsedSecs,
          vus: Number(m[3]),
          vusMax: m[4] ? Number(m[4]) : undefined,
          complete: Number(m[5]),
          interrupted: Number(m[6]),
        }
        // k6 reprints the same second while a stage redraws; the last write
        // for a given second is the most complete one.
        byElapsed.set(elapsedSecs, point)
      }
      const p = PLAN_RE.exec(part)
      if (p) {
        percent = Number(p[1])
        plannedSecs = secs(p[4], p[5])
      }
    }
  }

  const points = [...byElapsed.values()].sort((a, b) => a.elapsedSecs - b.elapsedSecs)
  const rate: ProgressSeries['rate'] = []
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].elapsedSecs - points[i - 1].elapsedSecs
    const di = points[i].complete - points[i - 1].complete
    // A counter that went backwards is a restarted runner, not negative work.
    if (dt > 0 && di >= 0) rate.push({ elapsedSecs: points[i].elapsedSecs, perSec: di / dt })
  }

  return {
    points,
    rate,
    peakVus: points.reduce((n, p) => Math.max(n, p.vus), 0),
    last: points[points.length - 1],
    plannedSecs,
    percent,
  }
}

/** Drop ANSI colour so the field regexes see plain text. */
function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, '')
}

/* ─────────────────────────── stage timings ─────────────────────────── */

export interface StageTiming {
  stage: string
  /** When the run entered this stage. */
  atMs?: number
  /** How long it stayed there, when a later stage says when it left. */
  secs?: number
}

/**
 * How long each stage took, from the operator's own condition transitions.
 *
 * The k6 TestRun carries one condition per stage with a `lastTransitionTime`.
 * Sorting those and differencing them gives a real duration per stage — the
 * thing a CI stage view exists to show — instead of a row of pills that say
 * only which stage is current.
 */
export function stageTimings(
  order: readonly string[],
  conditions: ReadonlyArray<{ type: string; status: string; lastTransitionTime?: string }>,
  endMs?: number,
): StageTiming[] {
  const at = new Map<string, number>()
  for (const c of conditions) {
    if (!c.lastTransitionTime) continue
    const ms = Date.parse(c.lastTransitionTime)
    if (!Number.isFinite(ms)) continue
    // Condition types are `TestRunRunning`, `CloudTestRunCreated`, … — match
    // the stage name inside the type, case-insensitively.
    const hit = order.find((s) => c.type.toLowerCase().includes(s.toLowerCase()))
    if (!hit) continue
    // The earliest transition into a stage is when it started.
    const prev = at.get(hit)
    if (prev === undefined || ms < prev) at.set(hit, ms)
  }

  const timings: StageTiming[] = order.map((stage) => ({ stage, atMs: at.get(stage) }))
  for (let i = 0; i < timings.length; i++) {
    const start = timings[i].atMs
    if (start === undefined) continue
    const nextStart = timings.slice(i + 1).find((t) => t.atMs !== undefined)?.atMs ?? endMs
    if (nextStart !== undefined && nextStart >= start) timings[i].secs = (nextStart - start) / 1000
  }
  return timings
}
