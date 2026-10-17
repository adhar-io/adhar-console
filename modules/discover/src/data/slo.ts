/**
 * SLO model — definitions, PromQL generation, error-budget and burn-rate math,
 * status, and multi-window multi-burn-rate alert rules. Pure and unit tested.
 *
 * Terminology (Google SRE workbook):
 *   error budget  = 1 − objective                (e.g. 0.001 for 99.9 %)
 *   error ratio   = bad events / total events over a window
 *   burn rate     = error ratio / error budget   (1× spends the budget exactly
 *                                                 over the SLO window)
 *   budget left   = 1 − error ratio(SLO window) / error budget
 */

export type SliKind = 'availability' | 'latency' | 'custom'

export interface SloDefinition {
  id: string
  name: string
  service: string
  description?: string
  /** Percent, e.g. 99.9 */
  objective: number
  /** Rolling window in days. */
  windowDays: number
  sli:
    | {
      kind: 'availability'
      /** Counter of requests, e.g. `http_requests_total`. */
      metric: string
      /** Label matchers without braces, e.g. `namespace="shop", job="api"`. */
      selector: string
      /** Matcher(s) that mark a bad event, e.g. `code=~"5.."`. */
      errorSelector: string
    }
    | {
      kind: 'latency'
      /** Histogram base name, e.g. `http_request_duration_seconds` (no `_bucket`). */
      metric: string
      selector: string
      /** `le` bucket boundary that counts as good, as written in the metric (e.g. "0.3"). */
      threshold: string
    }
    | {
      kind: 'custom'
      /** PromQL for bad events; `$window` is replaced with the range (e.g. `5m`). */
      errorQuery: string
      /** PromQL for all events; `$window` is replaced. */
      totalQuery: string
    }
  labels?: Record<string, string>
  createdAt?: string
  updatedAt?: string
}

export const SLO_COLLECTION = 'discover.slo'

/* ─────────── PromQL ─────────── */

function sel(...parts: string[]): string {
  const s = parts.map((p) => p.trim().replace(/^\{|\}$/g, '').trim()).filter(Boolean).join(', ')
  return `{${s}}`
}

/** Events expression over `window` using `fn` (rate | increase). */
export function eventsExpr(def: SloDefinition, which: 'error' | 'total', window: string, fn: 'rate' | 'increase' = 'rate'): string {
  const s = def.sli
  if (s.kind === 'availability') {
    return which === 'total'
      ? `sum(${fn}(${s.metric}${sel(s.selector)}[${window}]))`
      : `sum(${fn}(${s.metric}${sel(s.selector, s.errorSelector)}[${window}]))`
  }
  if (s.kind === 'latency') {
    const total = `sum(${fn}(${s.metric}_count${sel(s.selector)}[${window}]))`
    if (which === 'total') return total
    const good = `sum(${fn}(${s.metric}_bucket${sel(s.selector, `le="${s.threshold}"`)}[${window}]))`
    return `(${total} - ${good})`
  }
  return `(${(which === 'error' ? s.errorQuery : s.totalQuery).replaceAll('$window', window)})`
}

/** Error ratio over a window (0..1). */
export function errorRatioExpr(def: SloDefinition, window: string): string {
  return `${eventsExpr(def, 'error', window)} / ${eventsExpr(def, 'total', window)}`
}

export const BURN_WINDOWS = ['5m', '30m', '1h', '2h', '6h', '1d', '3d'] as const
export type BurnWindow = (typeof BURN_WINDOWS)[number]

/**
 * One instant query returning the error ratio for every burn window plus the
 * whole SLO window, each tagged with a `w` label — a single round trip per SLO.
 */
export function windowsQuery(def: SloDefinition): string {
  const ws = [...BURN_WINDOWS, `${def.windowDays}d`]
  return ws.map((w) => `label_replace(${errorRatioExpr(def, w)}, "w", "${w}", "", "")`).join(' or ')
}

/* ─────────── math ─────────── */

export function errorBudget(objectivePct: number): number {
  return Math.max(1e-9, Math.round((1 - objectivePct / 100) * 1e12) / 1e12)
}

export function burnRate(errorRatio: number | null, objectivePct: number): number | null {
  if (errorRatio == null || !Number.isFinite(errorRatio)) return null
  return errorRatio / errorBudget(objectivePct)
}

/** Fraction of budget left (1 = untouched, 0 = spent, < 0 = overspent). */
export function budgetRemaining(windowErrorRatio: number | null, objectivePct: number): number | null {
  if (windowErrorRatio == null || !Number.isFinite(windowErrorRatio)) return null
  return 1 - windowErrorRatio / errorBudget(objectivePct)
}

/** SLI in percent from an error ratio. */
export function sliPct(errorRatio: number | null): number | null {
  return errorRatio == null || !Number.isFinite(errorRatio) ? null : (1 - errorRatio) * 100
}

/**
 * Multi-window multi-burn-rate alert policy (SRE workbook, table 5-8), tuned
 * for a 30-day window: each pair fires when both the long and the short
 * window burn above the factor — the long window proves significance, the
 * short one proves it is still happening.
 */
export const BURN_POLICY = [
  { severity: 'critical' as const, long: '1h' as BurnWindow, short: '5m' as BurnWindow, factor: 14.4, budget: '2% in 1h' },
  { severity: 'critical' as const, long: '6h' as BurnWindow, short: '30m' as BurnWindow, factor: 6, budget: '5% in 6h' },
  { severity: 'warning' as const, long: '1d' as BurnWindow, short: '2h' as BurnWindow, factor: 3, budget: '10% in 1d' },
  { severity: 'warning' as const, long: '3d' as BurnWindow, short: '6h' as BurnWindow, factor: 1, budget: '10% in 3d' },
]

/** Scale factors for windows other than 30 days (budget spent in the same wall time). */
export function policyFactor(base: number, windowDays: number): number {
  return Math.round(base * (windowDays / 30) * 100) / 100
}

export type SloStatus = 'breached' | 'burning' | 'at-risk' | 'healthy' | 'no-data'

export interface SloEval {
  ratios: Partial<Record<string, number | null>>
  burn: Partial<Record<BurnWindow, number | null>>
  sli: number | null
  remaining: number | null
  status: SloStatus
  /** Policy rows currently firing. */
  firing: Array<(typeof BURN_POLICY)[number]>
}

export function evaluate(def: SloDefinition, ratios: Partial<Record<string, number | null>>): SloEval {
  const burn: SloEval['burn'] = {}
  for (const w of BURN_WINDOWS) burn[w] = burnRate(ratios[w] ?? null, def.objective)
  const whole = ratios[`${def.windowDays}d`] ?? null
  const remaining = budgetRemaining(whole, def.objective)
  const firing = BURN_POLICY.filter((p) => {
    const f = policyFactor(p.factor, def.windowDays)
    const l = burn[p.long]
    const s = burn[p.short]
    return l != null && s != null && l > f && s > f
  })
  let status: SloStatus
  if (whole == null && Object.values(burn).every((v) => v == null)) status = 'no-data'
  else if (remaining != null && remaining <= 0) status = 'breached'
  else if (firing.some((p) => p.severity === 'critical')) status = 'burning'
  else if (firing.length || (remaining != null && remaining < 0.25)) status = 'at-risk'
  else status = 'healthy'
  return { ratios, burn, sli: sliPct(whole), remaining, status, firing }
}

/**
 * Budget burn-down from per-step bad/total increases across the SLO window:
 * remaining(t) = 1 − cumBad(t) / (budget × total over the window). Steps with
 * no data contribute nothing. Returns [] when there was no traffic at all.
 */
export function burnDown(
  bad: Array<[number, number]>,
  total: Array<[number, number]>,
  objectivePct: number,
): Array<[number, number]> {
  const totalSum = total.reduce((a, [, v]) => a + (Number.isFinite(v) ? v : 0), 0)
  if (totalSum <= 0) return []
  const budgetEvents = errorBudget(objectivePct) * totalSum
  const badBy = new Map(bad.map(([t, v]) => [t, Number.isFinite(v) ? Math.max(0, v) : 0]))
  const times = [...new Set([...bad.map(([t]) => t), ...total.map(([t]) => t)])].sort((a, b) => a - b)
  let cum = 0
  return times.map((t) => {
    cum += badBy.get(t) ?? 0
    return [t, (1 - cum / budgetEvents) * 100] as [number, number]
  })
}

/* ─────────── validation ─────────── */

export function validateSlo(d: Partial<SloDefinition>): string[] {
  const out: string[] = []
  if (!d.name?.trim()) out.push('Name is required.')
  if (!d.service?.trim()) out.push('Service is required.')
  if (!(typeof d.objective === 'number' && d.objective > 0 && d.objective < 100)) out.push('Objective must be between 0 and 100 (exclusive), e.g. 99.9.')
  if (!(typeof d.windowDays === 'number' && d.windowDays >= 1 && d.windowDays <= 90)) out.push('Window must be 1–90 days.')
  const s = d.sli
  if (!s) out.push('Pick an indicator.')
  else if (s.kind === 'availability') {
    if (!/^[a-zA-Z_:][\w:]*$/.test(s.metric)) out.push('Metric must be a Prometheus metric name.')
    if (!s.errorSelector.trim()) out.push('Say which events are errors, e.g. code=~"5..".')
  } else if (s.kind === 'latency') {
    if (!/^[a-zA-Z_:][\w:]*$/.test(s.metric)) out.push('Histogram must be a metric name (without _bucket).')
    if (/_bucket$/.test(s.metric)) out.push('Use the histogram base name — drop the _bucket suffix.')
    if (!/^\d+(\.\d+)?$/.test(s.threshold)) out.push('Threshold must be a number matching an `le` bucket, e.g. 0.3.')
  } else {
    if (!s.errorQuery.includes('$window') || !s.totalQuery.includes('$window')) out.push('Custom queries must use $window for the range, e.g. rate(x[$window]).')
  }
  return out
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'slo'
}

/* ─────────── alert rules (PrometheusRule YAML) ─────────── */

function yq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Recording rules for every burn window plus the multi-window multi-burn-rate
 * alerts, as a PrometheusRule the operator will pick up.
 */
export function alertRulesYaml(def: SloDefinition, namespace = 'adhar-system'): string {
  const slug = slugify(def.id || def.name)
  const rec = (w: string) => `slo:sli_error:ratio_rate${w}`
  const labels = { slo: slug, service: def.service, ...(def.labels ?? {}) }
  const labelYaml = (indent: string) => Object.entries(labels).map(([k, v]) => `${indent}${k}: ${yq(v)}`).join('\n')
  const sel = `{slo=${JSON.stringify(slug)}}`
  const lines: string[] = [
    'apiVersion: monitoring.coreos.com/v1',
    'kind: PrometheusRule',
    'metadata:',
    `  name: slo-${slug}`,
    `  namespace: ${namespace}`,
    '  labels:',
    '    release: prometheus',
    'spec:',
    '  groups:',
    `    - name: slo-${slug}-recording`,
    '      interval: 30s',
    '      rules:',
  ]
  for (const w of BURN_WINDOWS) {
    lines.push(`        - record: ${rec(w)}`, `          expr: ${yq(errorRatioExpr(def, w))}`, '          labels:', labelYaml('            '))
  }
  lines.push(`    - name: slo-${slug}-alerts`, '      rules:')
  const budget = errorBudget(def.objective)
  for (const p of BURN_POLICY) {
    const f = policyFactor(p.factor, def.windowDays)
    const name = `SLOErrorBudgetBurn${p.severity === 'critical' ? 'Fast' : 'Slow'}`
    lines.push(
      `        - alert: ${name}`,
      `          expr: ${yq(`${rec(p.long)}${sel} > (${f} * ${budget}) and ${rec(p.short)}${sel} > (${f} * ${budget})`)}`,
      `          for: ${p.severity === 'critical' ? '2m' : '15m'}`,
      '          labels:',
      `            severity: ${p.severity}`,
      labelYaml('            '),
      `            burn_window: ${yq(`${p.long}/${p.short}`)}`,
      '          annotations:',
      `            summary: ${yq(`${def.name}: error budget burning ${f}x (${p.long} and ${p.short})`)}`,
      `            description: ${yq(`${def.service} is spending the ${def.objective}% / ${def.windowDays}d error budget ${f}x faster than sustainable — ${p.budget} of the budget at this rate.`)}`,
    )
  }
  return lines.join('\n') + '\n'
}
