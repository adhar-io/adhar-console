/**
 * p99 for every run the console starts.
 *
 * k6's default `summaryTrendStats` is `avg,min,med,max,p(90),p(95)`: the
 * end-of-test summary — the ONLY durable result of a run — has no p99 unless
 * someone asked for it. Asking the user to edit every script is not a fix, so
 * every TestRun the console creates (Run test, a ConfigMap script, a rerun,
 * the schedule / CI template) requests the stats itself.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ENV VAR, NOT `--summary-trend-stats` IN `spec.arguments`
 * ---------------------------------------------------------------------------
 * The k6 operator (v1.6, pkg/resources/jobs) uses `spec.arguments` twice, in
 * two incompatible ways:
 *
 *   • the initializer joins them into `sh -c "k6 archive … <arguments>"`, so
 *     an unquoted `p(99)` is a shell syntax error — the run never starts;
 *   • the runner splits them on whitespace (`strings.Fields`) and execs k6
 *     with NO shell, so quoting it for the initializer leaves literal quotes
 *     in the value and k6 rejects `'avg`.
 *
 * There is no spelling of `p(99)` that survives both. `K6_SUMMARY_TREND_STATS`
 * on the runner's environment does: env values never pass through a shell
 * unquoted (the initializer references them as `"${NAME}"`), every operator
 * version supports `runner.env`, and the initializer inherits it.
 *
 * k6 ranks options: script `options` < environment < CLI flags. So the env
 * var would OVERRIDE a script that sets its own `summaryTrendStats` — when the
 * script is known and sets it, or the arguments pass `--summary-trend-stats`,
 * or the env already names it, the user's choice is kept and nothing is added.
 *
 * When the run remote-writes to Prometheus (`-o experimental-prometheus-rw`),
 * `K6_PROMETHEUS_RW_TREND_STATS` gets the same list: that output's default is
 * `p(99)` alone, and the live latency chart reads med/p90/p95/p99/avg.
 *
 * Pure: spec in, spec out.
 */

/** k6's defaults plus p(99). p(99.9) is left out: no view shows it. */
export const SUMMARY_TREND_STATS = 'avg,min,med,max,p(90),p(95),p(99)'
export const RW_TREND_STATS = SUMMARY_TREND_STATS

export const ENV_SUMMARY_TREND_STATS = 'K6_SUMMARY_TREND_STATS'
export const ENV_RW_TREND_STATS = 'K6_PROMETHEUS_RW_TREND_STATS'

type EnvVar = { name: string; value?: string; valueFrom?: unknown }
type Pod = Record<string, unknown> & { env?: EnvVar[] }

function argv(args: string | string[] | undefined): string[] {
  if (!args) return []
  return Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean)
}

/** The arguments set summary trend stats themselves (`--summary-trend-stats[=]…`). */
export function argsSetTrendStats(args: string | string[] | undefined): boolean {
  return argv(args).some((a) => /^--summary-trend-stats(=|$)/.test(a))
}

/** The script sets `summaryTrendStats` in its options (any spelling of the key). */
export function scriptSetsTrendStats(script: string | undefined | null): boolean {
  return Boolean(script && /\bsummaryTrendStats\b/.test(script))
}

/** The run remote-writes k6 metrics to Prometheus. */
export function usesPrometheusRw(args: string | string[] | undefined, env: EnvVar[] = []): boolean {
  const a = argv(args)
  for (let i = 0; i < a.length; i++) {
    const m = /^(?:-o|--out)(?:=(.*))?$/.exec(a[i])
    const value = m ? (m[1] ?? a[i + 1] ?? '') : ''
    if (value.split(',').some((v) => v.trim().startsWith('experimental-prometheus-rw'))) return true
  }
  return env.some((e) => e.name === 'K6_OUT' && /experimental-prometheus-rw/.test(e.value ?? ''))
}

/**
 * The spec with the trend stats requested on the runner's environment —
 * unless the user already chose them (arguments, env, or the script).
 *
 * `script` is the k6 source when the caller has it; without it the stats are
 * added (every console path that can read the script passes it).
 */
export function withTrendStats<S extends Record<string, unknown>>(spec: S, opts: { script?: string | null } = {}): S {
  const runner = (spec.runner ?? {}) as Pod
  const env = [...(runner.env ?? [])]
  const has = (name: string) => env.some((e) => e.name === name)
  const args = (spec.args as string[] | undefined)?.length ? spec.args as string[] : spec.arguments as string | undefined
  const add: EnvVar[] = []

  const userChose = argsSetTrendStats(args) || has(ENV_SUMMARY_TREND_STATS) || scriptSetsTrendStats(opts.script)
  if (!userChose) add.push({ name: ENV_SUMMARY_TREND_STATS, value: SUMMARY_TREND_STATS })
  if (usesPrometheusRw(args, env) && !has(ENV_RW_TREND_STATS)) add.push({ name: ENV_RW_TREND_STATS, value: RW_TREND_STATS })
  if (!add.length) return spec
  return { ...spec, runner: { ...runner, env: [...env, ...add] } }
}

/** True when a TestRun spec asks k6 for p(99) — so a missing p99 on its result is an anomaly, not history. */
export function requestsP99(spec: Record<string, unknown> | undefined): boolean {
  if (!spec) return false
  const env = ((spec.runner ?? {}) as Pod).env ?? []
  const stat = env.find((e) => e.name === ENV_SUMMARY_TREND_STATS)?.value
  if (stat && /p\(99\)/.test(stat)) return true
  const a = argv((spec.args as string[] | undefined)?.length ? spec.args as string[] : spec.arguments as string | undefined)
  return a.some((x, i) => /^--summary-trend-stats/.test(x) && /p\(99\)/.test(x.includes('=') ? x : a[i + 1] ?? ''))
}
