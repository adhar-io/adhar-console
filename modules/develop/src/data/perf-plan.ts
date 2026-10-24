/**
 * What a k6 test PLANS to do, read from its script and its CLI arguments.
 *
 * A run's progress bar, its "current VUs vs target" and the ramp-up / steady /
 * ramp-down timeline are only honest if the plan behind them is the one k6
 * will execute. k6 takes that plan from three places, highest priority first:
 *
 *   1. CLI flags on the TestRun (`--vus 50 --duration 30s`, `--stage 30s:10`,
 *      `--iterations 100`),
 *   2. the script's `export const options = { … }`,
 *   3. its own defaults (1 VU, 1 iteration).
 *
 * The script is JavaScript, not JSON, so the options object is read with a
 * small tolerant literal parser: strings, numbers, booleans, arrays and plain
 * objects are understood, and anything computed (`__ENV.VUS || 10`, a function
 * call) is treated as UNKNOWN rather than guessed. A plan that could not be
 * read says so (`source: 'none'`) and the UI shows elapsed time without a
 * progress bar — never a bar towards a number nobody declared.
 *
 * Pure — no React, no fetches — so every branch is unit-tested.
 */

export interface PlanStage {
  durationSecs: number
  /** VUs at the END of this stage; the stage ramps linearly towards it. */
  target: number
}

export interface PlanScenario {
  name: string
  executor: string
  /** Offset from the start of the test (`startTime`). */
  startSecs: number
  /** Planned length, when the executor has one. Iteration-based ones may finish early. */
  durationSecs?: number
  /** True when `durationSecs` is an upper bound (`maxDuration`) rather than a plan. */
  upperBound?: boolean
  /** VU curve for VU-based executors. Absent for arrival-rate executors. */
  startVus?: number
  stages?: PlanStage[]
  /** Peak VUs this scenario can use. */
  maxVus?: number
  iterations?: number
  /** Arrival-rate executors: iterations per `timeUnit`. */
  rate?: string
}

export interface PlanThreshold {
  metric: string
  expression: string
  /** `abortOnFail: true` — k6 stops the test the moment it is crossed. */
  abortOnFail?: boolean
}

export interface LoadPlan {
  /** Where the VU / duration plan came from. `none` = could not tell. */
  source: 'arguments' | 'script' | 'default' | 'none'
  scenarios: PlanScenario[]
  /** Planned length of the whole test, without graceful stop. */
  totalSecs?: number
  /** True when `totalSecs` is only an upper bound (iteration-based plans). */
  totalIsUpperBound?: boolean
  /** Highest VU count the plan reaches across VU-based scenarios. */
  maxVus?: number
  /** Declared thresholds (from the script). */
  thresholds: PlanThreshold[]
  /** Why the plan is partial, in a sentence, when it is. */
  note?: string
}

/* ─────────────────────────── durations ─────────────────────────── */

const UNIT_SECS: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001, us: 0.000001, µs: 0.000001, ns: 1e-9 }

/**
 * `1h2m3s`, `90s`, `500ms`, `1.5m` → seconds. k6 also accepts a bare number in
 * options, which it reads as MILLISECONDS; a bare numeric string on the CLI is
 * seconds is not a thing — k6 rejects it — so it is treated as unknown.
 */
export function parseK6Duration(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v / 1000 : undefined
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  const re = /(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g
  let total = 0
  let consumed = 0
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * UNIT_SECS[m[2]]
    consumed += m[0].length
  }
  return consumed === s.length && consumed > 0 ? total : undefined
}

/* ─────────────────────────── a tolerant JS literal reader ─────────────────────────── */

/** Marker for a value the reader could not evaluate (a computed expression). */
export const UNKNOWN: unique symbol = Symbol('unknown')
type Lit = string | number | boolean | null | typeof UNKNOWN | Lit[] | { [k: string]: Lit }

class Reader {
  i = 0
  constructor(readonly s: string) {}

  ws() {
    for (;;) {
      const c = this.s[this.i]
      if (c === undefined) return
      if (/\s/.test(c)) {
        this.i++
        continue
      }
      if (c === '/' && this.s[this.i + 1] === '/') {
        const nl = this.s.indexOf('\n', this.i)
        this.i = nl < 0 ? this.s.length : nl + 1
        continue
      }
      if (c === '/' && this.s[this.i + 1] === '*') {
        const end = this.s.indexOf('*/', this.i + 2)
        this.i = end < 0 ? this.s.length : end + 2
        continue
      }
      return
    }
  }

  value(top = false): Lit {
    this.ws()
    const c = this.s[this.i]
    let v: Lit
    if (c === '{') v = this.object()
    else if (c === '[') v = this.array()
    else if (c === '"' || c === "'" || c === '`') v = this.string()
    else {
      const m = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(this.s.slice(this.i, this.i + 40))
      const word = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 40))?.[0]
      if (m) {
        this.i += m[0].length
        v = Number(m[0].replace(/_/g, ''))
      } else if (word === 'true' || word === 'false' || word === 'null') {
        this.i += word.length
        v = word === 'true' ? true : word === 'false' ? false : null
      } else {
        this.skipExpression()
        return UNKNOWN
      }
    }
    // `'30s' + x`, `10 * 2`, `a || b`: anything after a literal makes it computed.
    if (top) return v
    this.ws()
    const next = this.s[this.i]
    if (next !== undefined && next !== ',' && next !== '}' && next !== ']') {
      this.skipExpression()
      return UNKNOWN
    }
    return v
  }

  /** Skip to the next `,`/`}`/`]` at this nesting depth. */
  skipExpression() {
    let depth = 0
    while (this.i < this.s.length) {
      const c = this.s[this.i]
      if (c === '"' || c === "'" || c === '`') {
        this.string()
        continue
      }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) return
        depth--
      } else if (c === ',' && depth === 0) return
      this.i++
    }
  }

  string(): string | typeof UNKNOWN {
    const q = this.s[this.i++]
    let out = ''
    let computed = false
    while (this.i < this.s.length) {
      const c = this.s[this.i++]
      if (c === '\\') {
        out += this.s[this.i++] ?? ''
        continue
      }
      if (q === '`' && c === '$' && this.s[this.i] === '{') computed = true
      if (c === q) break
      out += c
    }
    return computed ? UNKNOWN : out
  }

  array(): Lit[] {
    this.i++ // [
    const out: Lit[] = []
    for (;;) {
      this.ws()
      if (this.s[this.i] === ']') {
        this.i++
        return out
      }
      if (this.i >= this.s.length) return out
      if (this.s.startsWith('...', this.i)) {
        this.skipExpression()
        out.push(UNKNOWN)
      } else out.push(this.value())
      this.ws()
      if (this.s[this.i] === ',') this.i++
    }
  }

  object(): { [k: string]: Lit } {
    this.i++ // {
    const out: { [k: string]: Lit } = {}
    for (;;) {
      this.ws()
      const c = this.s[this.i]
      if (c === '}') {
        this.i++
        return out
      }
      if (c === undefined) return out
      if (this.s.startsWith('...', this.i)) {
        this.skipExpression()
        if (this.s[this.i] === ',') this.i++
        continue
      }
      let key: string | undefined
      if (c === '"' || c === "'") {
        const k = this.string()
        key = typeof k === 'string' ? k : undefined
      } else if (c === '[') {
        // Computed key — unknown, skip the whole property.
        this.skipExpression()
        if (this.s[this.i] === ',') this.i++
        continue
      } else {
        const m = /^[A-Za-z_$][\w$]*|^\d+/.exec(this.s.slice(this.i))
        if (!m) {
          this.skipExpression()
          if (this.s[this.i] === ',') this.i++
          continue
        }
        key = m[0]
        this.i += m[0].length
      }
      this.ws()
      if (this.s[this.i] === ':') {
        this.i++
        const v = this.value()
        if (key !== undefined) out[key] = v
      } else if (key !== undefined) {
        // Shorthand `{ stages }` or a method — the value is a variable.
        out[key] = UNKNOWN
        this.skipExpression()
      }
      this.ws()
      if (this.s[this.i] === ',') this.i++
    }
  }
}

/** Read one JS literal starting at `s[0]`. Exported for tests. */
export function readLiteral(s: string): Lit {
  return new Reader(s).value(true)
}

/**
 * The script's `options` object, as far as it is a literal. Undefined when
 * the script exports no options, or builds them in a way that cannot be read
 * statically (`export const options = buildOptions()`).
 */
export function extractOptions(script: string): Record<string, Lit> | undefined {
  const m = /export\s+(?:const|let|var)\s+options\s*(?::\s*[\w.<>]+\s*)?=\s*/.exec(script) ??
    /(?:^|\n)\s*(?:const|let|var)\s+options\s*=\s*/.exec(script)
  if (!m) return undefined
  const start = m.index + m[0].length
  if (script[start] !== '{') return undefined
  const v = readLiteral(script.slice(start))
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Lit>) : undefined
}

/* ─────────────────────────── the plan ─────────────────────────── */

const num = (v: Lit | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const obj = (v: Lit | undefined): Record<string, Lit> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Lit>) : undefined

function stagesOf(v: Lit | undefined): PlanStage[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: PlanStage[] = []
  for (const s of v) {
    const o = obj(s)
    const d = parseK6Duration(o?.duration)
    const t = num(o?.target)
    if (d === undefined || t === undefined) return undefined
    out.push({ durationSecs: d, target: t })
  }
  return out
}

const sumSecs = (stages: PlanStage[]) => stages.reduce((n, s) => n + s.durationSecs, 0)

/** One scenario from `options.scenarios.<name>`. Undefined when unreadable. */
function scenarioOf(name: string, raw: Lit): PlanScenario | undefined {
  const o = obj(raw)
  if (!o) return undefined
  const executor = typeof o.executor === 'string' ? o.executor : undefined
  if (!executor) return undefined
  const startSecs = parseK6Duration(o.startTime) ?? 0
  const base = { name, executor, startSecs }
  switch (executor) {
    case 'ramping-vus': {
      const stages = stagesOf(o.stages)
      if (!stages) return { ...base }
      const startVus = num(o.startVUs) ?? 1
      return {
        ...base,
        startVus,
        stages,
        durationSecs: sumSecs(stages),
        maxVus: Math.max(startVus, ...stages.map((s) => s.target)),
      }
    }
    case 'constant-vus': {
      const vus = num(o.vus) ?? 1
      const d = parseK6Duration(o.duration)
      return { ...base, startVus: vus, stages: d === undefined ? undefined : [{ durationSecs: d, target: vus }], durationSecs: d, maxVus: vus }
    }
    case 'per-vu-iterations':
    case 'shared-iterations': {
      const vus = num(o.vus) ?? 1
      return {
        ...base,
        maxVus: vus,
        iterations: num(o.iterations) ?? 1,
        durationSecs: parseK6Duration(o.maxDuration) ?? 600,
        upperBound: true,
      }
    }
    case 'constant-arrival-rate':
    case 'ramping-arrival-rate': {
      const stages = executor === 'ramping-arrival-rate' ? stagesOf(o.stages) : undefined
      const d = executor === 'constant-arrival-rate' ? parseK6Duration(o.duration) : stages ? sumSecs(stages) : undefined
      const rate = num(o.rate)
      return {
        ...base,
        durationSecs: d,
        maxVus: num(o.maxVUs) ?? num(o.preAllocatedVUs),
        rate: rate !== undefined ? `${rate}/${typeof o.timeUnit === 'string' ? o.timeUnit : '1s'}` : undefined,
      }
    }
    case 'externally-controlled': {
      const d = parseK6Duration(o.duration)
      return { ...base, durationSecs: d, maxVus: num(o.maxVUs) ?? num(o.vus) }
    }
    default:
      return { ...base }
  }
}

function thresholdsOf(v: Lit | undefined): PlanThreshold[] {
  const o = obj(v)
  if (!o) return []
  const out: PlanThreshold[] = []
  for (const [metric, rules] of Object.entries(o)) {
    const list = Array.isArray(rules) ? rules : [rules]
    for (const r of list) {
      if (typeof r === 'string') out.push({ metric, expression: r })
      else {
        const ro = obj(r as Lit)
        if (ro && typeof ro.threshold === 'string') {
          out.push({ metric, expression: ro.threshold, abortOnFail: ro.abortOnFail === true || undefined })
        }
      }
    }
  }
  return out
}

/** The CLI flags that override the script's execution plan. */
export function parsePlanArgs(args: string | undefined): { vus?: number; durationSecs?: number; iterations?: number; stages?: PlanStage[] } {
  const out: { vus?: number; durationSecs?: number; iterations?: number; stages?: PlanStage[] } = {}
  if (!args) return out
  const toks = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^["']|["']$/g, '')) ?? []
  const stages: PlanStage[] = []
  for (let i = 0; i < toks.length; i++) {
    let flag = toks[i]
    let val: string | undefined
    const eq = flag.indexOf('=')
    if (flag.startsWith('-') && eq > 0) {
      val = flag.slice(eq + 1)
      flag = flag.slice(0, eq)
    }
    const take = () => val ?? toks[++i]
    switch (flag) {
      case '-u':
      case '--vus': {
        const n = Number(take())
        if (Number.isFinite(n)) out.vus = n
        break
      }
      case '-d':
      case '--duration': {
        const d = parseK6Duration(take())
        if (d !== undefined) out.durationSecs = d
        break
      }
      case '-i':
      case '--iterations': {
        const n = Number(take())
        if (Number.isFinite(n)) out.iterations = n
        break
      }
      case '-s':
      case '--stage': {
        for (const part of (take() ?? '').split(',')) {
          const [d, t] = part.split(':')
          const secs = parseK6Duration(d)
          const target = Number(t)
          if (secs !== undefined && Number.isFinite(target)) stages.push({ durationSecs: secs, target })
        }
        break
      }
    }
  }
  if (stages.length) out.stages = stages
  return out
}

function finish(plan: Omit<LoadPlan, 'totalSecs' | 'maxVus' | 'totalIsUpperBound'>): LoadPlan {
  const ends = plan.scenarios.map((s) => (s.durationSecs === undefined ? undefined : s.startSecs + s.durationSecs))
  const known = ends.filter((e): e is number => e !== undefined)
  const totalSecs = known.length && known.length === ends.length ? Math.max(...known) : undefined
  const vuPeaks = plan.scenarios.map((s) => s.maxVus).filter((v): v is number => v !== undefined)
  return {
    ...plan,
    totalSecs,
    totalIsUpperBound: plan.scenarios.some((s) => s.upperBound) || undefined,
    maxVus: vuPeaks.length ? vuPeaks.reduce((a, b) => a + b, 0) : undefined,
    note: plan.note ??
      (known.length < ends.length ? 'Some scenarios have no fixed length, so the total duration is unknown.' : undefined),
  }
}

/**
 * The plan k6 will execute for this script and these arguments.
 *
 * `script` undefined means the script could not be read at all (the ConfigMap
 * is gone or unreadable) — the plan is then `none` unless the CLI flags alone
 * fully describe it.
 */
export function parsePlan(script: string | undefined, args?: string): LoadPlan {
  const cli = parsePlanArgs(args)
  const options = script ? extractOptions(script) : undefined
  const thresholds = thresholdsOf(options?.thresholds)

  // 1. CLI flags win over everything in the script.
  if (cli.stages) {
    const startVus = cli.vus ?? 1
    return finish({
      source: 'arguments',
      thresholds,
      scenarios: [{ name: 'default', executor: 'ramping-vus', startSecs: 0, startVus, stages: cli.stages, durationSecs: sumSecs(cli.stages), maxVus: Math.max(startVus, ...cli.stages.map((s) => s.target)) }],
    })
  }
  if (cli.durationSecs !== undefined) {
    const vus = cli.vus ?? 1
    return finish({
      source: 'arguments',
      thresholds,
      scenarios: [{ name: 'default', executor: 'constant-vus', startSecs: 0, startVus: vus, stages: [{ durationSecs: cli.durationSecs, target: vus }], durationSecs: cli.durationSecs, maxVus: vus }],
    })
  }
  if (cli.iterations !== undefined) {
    return finish({
      source: 'arguments',
      thresholds,
      scenarios: [{ name: 'default', executor: 'shared-iterations', startSecs: 0, maxVus: cli.vus ?? 1, iterations: cli.iterations, durationSecs: 600, upperBound: true }],
    })
  }

  if (!script) {
    return { source: 'none', scenarios: [], thresholds, note: 'The script could not be read, so the plan is unknown.' }
  }
  if (!options) {
    if (/export\s+(?:const|let|var)\s+options\b/.test(script)) {
      return { source: 'none', scenarios: [], thresholds, note: 'The script computes its options, so the plan cannot be read without running it.' }
    }
    // No options at all: k6's default is one VU running one iteration.
    return finish({ source: 'default', thresholds, scenarios: [{ name: 'default', executor: 'shared-iterations', startSecs: 0, maxVus: 1, iterations: 1, durationSecs: 600, upperBound: true }] })
  }

  // 2. Scenarios, when declared, replace the shortcut options entirely.
  const scenariosRaw = obj(options.scenarios)
  if (scenariosRaw) {
    const scenarios: PlanScenario[] = []
    let unreadable = 0
    for (const [name, raw] of Object.entries(scenariosRaw)) {
      const s = scenarioOf(name, raw)
      if (s) scenarios.push(s)
      else unreadable++
    }
    if (!scenarios.length) {
      return { source: 'none', scenarios: [], thresholds, note: 'The scenarios are computed in the script, so the plan cannot be read.' }
    }
    return finish({
      source: 'script',
      thresholds,
      scenarios,
      note: unreadable ? `${unreadable} scenario${unreadable === 1 ? '' : 's'} could not be read.` : undefined,
    })
  }

  // 3. The shortcut options: stages, or vus + duration, or iterations.
  if (options.stages !== undefined) {
    const stages = stagesOf(options.stages)
    if (!stages) return { source: 'none', scenarios: [], thresholds, note: 'The stages are computed in the script, so the plan cannot be read.' }
    const startVus = num(options.vus) ?? 1
    return finish({
      source: 'script',
      thresholds,
      scenarios: [{ name: 'default', executor: 'ramping-vus', startSecs: 0, startVus, stages, durationSecs: sumSecs(stages), maxVus: Math.max(startVus, ...stages.map((s) => s.target)) }],
    })
  }
  const vusLit = options.vus
  const durLit = options.duration
  if (vusLit === UNKNOWN || durLit === UNKNOWN || options.iterations === UNKNOWN) {
    return { source: 'none', scenarios: [], thresholds, note: 'The VUs or duration are computed in the script (e.g. from an environment variable), so the plan cannot be read.' }
  }
  const vus = num(vusLit) ?? 1
  const d = parseK6Duration(durLit)
  if (d !== undefined) {
    return finish({ source: 'script', thresholds, scenarios: [{ name: 'default', executor: 'constant-vus', startSecs: 0, startVus: vus, stages: [{ durationSecs: d, target: vus }], durationSecs: d, maxVus: vus }] })
  }
  return finish({
    source: 'script',
    thresholds,
    scenarios: [{ name: 'default', executor: 'shared-iterations', startSecs: 0, maxVus: vus, iterations: num(options.iterations) ?? 1, durationSecs: 600, upperBound: true }],
  })
}

/* ─────────────────────────── reading the plan at a moment ─────────────────────────── */

/** VUs one scenario plans at `t` seconds into the test. Undefined = not VU-planned. */
function scenarioVusAt(s: PlanScenario, t: number): number | undefined {
  if (!s.stages) return undefined
  const local = t - s.startSecs
  if (local < 0) return 0
  let from = s.startVus ?? 0
  let at = 0
  for (const st of s.stages) {
    if (local <= at + st.durationSecs) {
      const f = st.durationSecs > 0 ? (local - at) / st.durationSecs : 1
      return from + (st.target - from) * f
    }
    at += st.durationSecs
    from = st.target
  }
  return 0
}

/** Total planned VUs at `t` seconds. Undefined when no scenario plans VUs over time. */
export function plannedVusAt(plan: LoadPlan, t: number): number | undefined {
  let any = false
  let total = 0
  for (const s of plan.scenarios) {
    const v = scenarioVusAt(s, t)
    if (v === undefined) continue
    any = true
    total += v
  }
  return any ? total : undefined
}

/** The planned VU curve as `[secs, vus]` corner points — what a chart draws. */
export function plannedVuCurve(plan: LoadPlan): Array<[number, number]> {
  if (!plan.scenarios.some((s) => s.stages)) return []
  const corners = new Set<number>([0])
  for (const s of plan.scenarios) {
    if (!s.stages) continue
    corners.add(s.startSecs)
    let at = s.startSecs
    for (const st of s.stages) {
      at += st.durationSecs
      corners.add(at)
    }
  }
  return [...corners].sort((a, b) => a - b).map((t) => [t, Math.round((plannedVusAt(plan, t) ?? 0) * 100) / 100])
}

export type PlanSegmentKind = 'ramp-up' | 'steady' | 'ramp-down'

export interface PlanSegment {
  kind: PlanSegmentKind
  startSecs: number
  endSecs: number
  fromVus: number
  toVus: number
}

/**
 * The planned VU curve cut into ramp-up / steady / ramp-down segments, with
 * adjacent segments of the same kind merged — the timeline drawn under the
 * progress bar.
 */
export function planSegments(plan: LoadPlan): PlanSegment[] {
  const curve = plannedVuCurve(plan)
  const out: PlanSegment[] = []
  for (let i = 1; i < curve.length; i++) {
    const [t0, v0] = curve[i - 1]
    const [t1, v1] = curve[i]
    if (t1 <= t0) continue
    const kind: PlanSegmentKind = Math.abs(v1 - v0) < 0.01 ? 'steady' : v1 > v0 ? 'ramp-up' : 'ramp-down'
    const prev = out[out.length - 1]
    if (prev && prev.kind === kind) {
      prev.endSecs = t1
      prev.toVus = v1
    } else out.push({ kind, startSecs: t0, endSecs: t1, fromVus: v0, toVus: v1 })
  }
  return out
}

/** Which planned segment `t` falls in. */
export function segmentAt(plan: LoadPlan, t: number): PlanSegment | undefined {
  return planSegments(plan).find((s) => t >= s.startSecs && t < s.endSecs)
}
