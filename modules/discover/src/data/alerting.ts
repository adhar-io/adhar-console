/**
 * Alerting model — pure, React-free, unit tested.
 *
 * Merges what Alertmanager knows (firing alerts and whether each is silenced
 * or inhibited, plus which receivers it routes to) with what Prometheus knows
 * (pending alerts, which never reach Alertmanager, and each alert's current
 * value), groups the result, and derives an alert timeline from the
 * `ALERTS` series Prometheus records for every rule evaluation.
 */

export type UState = 'firing' | 'pending' | 'silenced' | 'inhibited'

export interface UAlert {
  key: string
  name: string
  state: UState
  severity: string
  labels: Record<string, string>
  annotations: Record<string, string>
  startsAt: string
  value?: number
  receivers: string[]
  silencedBy: string[]
  inhibitedBy: string[]
  generatorURL?: string
  source: 'alertmanager' | 'prometheus'
}

/* ─────────── raw shapes ─────────── */

export interface AmAlert {
  labels?: Record<string, string>
  annotations?: Record<string, string>
  startsAt?: string
  endsAt?: string
  fingerprint?: string
  generatorURL?: string
  receivers?: Array<{ name: string }>
  status?: { state?: string; silencedBy?: string[] | null; inhibitedBy?: string[] | null }
}

export interface PromAlert {
  labels?: Record<string, string>
  annotations?: Record<string, string>
  state?: string
  activeAt?: string
  value?: string
}

export interface AmMatcher {
  name: string
  value: string
  isRegex: boolean
  isEqual?: boolean
}

export interface AmSilence {
  id: string
  matchers: AmMatcher[]
  startsAt: string
  endsAt: string
  createdBy: string
  comment: string
  status?: { state?: 'active' | 'pending' | 'expired' | string }
  updatedAt?: string
}

export interface PromRule {
  name: string
  query: string
  type: 'alerting' | 'recording' | string
  duration?: number
  keepFiringFor?: number
  labels?: Record<string, string>
  annotations?: Record<string, string>
  health?: string
  lastError?: string
  state?: string
  alerts?: PromAlert[]
  lastEvaluation?: string
  evaluationTime?: number
}

export interface PromRuleGroup {
  name: string
  file: string
  interval?: number
  rules: PromRule[]
}

/* ─────────── merge ─────────── */

export function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .filter((k) => !k.startsWith('__'))
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',')
}

function subset(small: Record<string, string>, big: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(small)) if (big[k] !== v) return false
  return true
}

/**
 * Unified list. Alertmanager is authoritative for firing/silenced/inhibited
 * (it applies silences and inhibitions); Prometheus contributes pending alerts
 * and the expression value. When Alertmanager is unreachable (`am === null`)
 * Prometheus's firing alerts are shown as firing — silences can't be known.
 */
export function mergeAlerts(am: AmAlert[] | null, prom: PromAlert[]): UAlert[] {
  const out: UAlert[] = []
  const promByName = new Map<string, PromAlert[]>()
  for (const p of prom) {
    const n = p.labels?.alertname ?? ''
    const l = promByName.get(n) ?? []
    l.push(p)
    promByName.set(n, l)
  }
  const matchedProm = new Set<PromAlert>()
  for (const a of am ?? []) {
    const labels = a.labels ?? {}
    const st = a.status?.state
    const silencedBy = a.status?.silencedBy ?? []
    const inhibitedBy = a.status?.inhibitedBy ?? []
    const state: UState = st === 'suppressed' ? (silencedBy.length ? 'silenced' : 'inhibited') : 'firing'
    const p = (promByName.get(labels.alertname ?? '') ?? []).find((x) => subset(x.labels ?? {}, labels))
    if (p) matchedProm.add(p)
    const v = p?.value != null ? Number(p.value) : NaN
    out.push({
      key: a.fingerprint || labelKey(labels),
      name: labels.alertname ?? 'alert',
      state,
      severity: (labels.severity ?? 'none').toLowerCase(),
      labels,
      annotations: a.annotations ?? {},
      startsAt: a.startsAt ?? '',
      value: Number.isFinite(v) ? v : undefined,
      receivers: (a.receivers ?? []).map((r) => r.name),
      silencedBy,
      inhibitedBy,
      generatorURL: a.generatorURL,
      source: 'alertmanager',
    })
  }
  for (const p of prom) {
    if (matchedProm.has(p)) continue
    const s = (p.state ?? '').toLowerCase()
    // With Alertmanager present, a firing Prometheus alert it doesn't list is
    // in flight (not yet sent) — still firing from the rule's point of view.
    if (s !== 'pending' && s !== 'firing') continue
    const labels = p.labels ?? {}
    const v = p.value != null ? Number(p.value) : NaN
    out.push({
      key: `prom:${labelKey(labels)}`,
      name: labels.alertname ?? 'alert',
      state: s === 'pending' ? 'pending' : 'firing',
      severity: (labels.severity ?? 'none').toLowerCase(),
      labels,
      annotations: p.annotations ?? {},
      startsAt: p.activeAt ?? '',
      value: Number.isFinite(v) ? v : undefined,
      receivers: [],
      silencedBy: [],
      inhibitedBy: [],
      source: 'prometheus',
    })
  }
  return out
}

/* ─────────── grouping ─────────── */

export function severityRank(s: string): number {
  const x = s.toLowerCase()
  if (x === 'critical' || x === 'page' || x === 'error' || x === 'high' || x === 'p1') return 0
  if (x === 'warning' || x === 'warn' || x === 'medium' || x === 'p2') return 1
  if (x === 'info' || x === 'low' || x === 'p3') return 2
  return 3
}

export const STATE_RANK: Record<UState, number> = { firing: 0, pending: 1, inhibited: 2, silenced: 3 }

export type GroupBy = 'alertname' | 'severity' | 'namespace' | 'none'

export interface AlertGroup {
  key: string
  alerts: UAlert[]
  counts: Record<UState, number>
  worstSeverity: string
  worstState: UState
}

export function compareAlerts(a: UAlert, b: UAlert): number {
  return STATE_RANK[a.state] - STATE_RANK[b.state] ||
    severityRank(a.severity) - severityRank(b.severity) ||
    (b.startsAt || '').localeCompare(a.startsAt || '') ||
    a.name.localeCompare(b.name)
}

export function groupAlerts(alerts: UAlert[], by: GroupBy): AlertGroup[] {
  const m = new Map<string, UAlert[]>()
  for (const a of alerts) {
    const k = by === 'none' ? 'All alerts' : by === 'alertname' ? a.name : by === 'severity' ? a.severity : (a.labels.namespace ?? '(no namespace)')
    const l = m.get(k) ?? []
    l.push(a)
    m.set(k, l)
  }
  const groups: AlertGroup[] = []
  for (const [key, list] of m) {
    list.sort(compareAlerts)
    const counts: Record<UState, number> = { firing: 0, pending: 0, silenced: 0, inhibited: 0 }
    for (const a of list) counts[a.state]++
    groups.push({
      key,
      alerts: list,
      counts,
      worstSeverity: list.reduce((w, a) => (severityRank(a.severity) < severityRank(w) ? a.severity : w), list[0].severity),
      worstState: list[0].state,
    })
  }
  return groups.sort((a, b) =>
    STATE_RANK[a.worstState] - STATE_RANK[b.worstState] ||
    severityRank(a.worstSeverity) - severityRank(b.worstSeverity) ||
    b.alerts.length - a.alerts.length ||
    a.key.localeCompare(b.key)
  )
}

/* ─────────── silences ─────────── */

export function matcherMatches(m: AmMatcher, labels: Record<string, string>): boolean {
  const v = labels[m.name] ?? ''
  let hit: boolean
  if (m.isRegex) {
    try {
      hit = new RegExp(`^(?:${m.value})$`).test(v)
    } catch {
      hit = false
    }
  } else hit = v === m.value
  return m.isEqual === false ? !hit : hit
}

export function silenceMatches(s: Pick<AmSilence, 'matchers'>, labels: Record<string, string>): boolean {
  return s.matchers.length > 0 && s.matchers.every((m) => matcherMatches(m, labels))
}

/** Default matchers for silencing one alert: its identifying labels (not volatile ones). */
const VOLATILE = new Set(['endpoint', 'instance', 'pod', 'pod_ip', 'container_id', 'uid', 'prometheus', 'prometheus_replica', 'receive', 'tenant_id'])
export function silenceMatchersFor(labels: Record<string, string>, exact = false): AmMatcher[] {
  return Object.keys(labels)
    .filter((k) => !k.startsWith('__') && (exact || !VOLATILE.has(k)))
    .sort((a, b) => (a === 'alertname' ? -1 : b === 'alertname' ? 1 : a.localeCompare(b)))
    .map((k) => ({ name: k, value: labels[k], isRegex: false, isEqual: true }))
}

export function matcherText(m: AmMatcher): string {
  const op = m.isRegex ? (m.isEqual === false ? '!~' : '=~') : m.isEqual === false ? '!=' : '='
  return `${m.name}${op}"${m.value}"`
}

/** Parse `a="b", c=~"d.*"` into matchers (for the silence editor's free-form field). */
export function parseMatchers(text: string): AmMatcher[] | null {
  const out: AmMatcher[] = []
  const re = /\s*([A-Za-z_][\w]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"\s*(,|$)/y
  let pos = 0
  const s = text.trim().replace(/^\{|\}$/g, '')
  while (pos < s.length) {
    re.lastIndex = pos
    const m = re.exec(s)
    if (!m) return null
    out.push({ name: m[1], value: m[3].replace(/\\(.)/g, '$1'), isRegex: m[2].includes('~'), isEqual: !m[2].startsWith('!') })
    pos = re.lastIndex
  }
  return out
}

/* ─────────── timeline ─────────── */

export interface Interval {
  start: number
  end: number
  state: 'firing' | 'pending'
}
export interface Lane {
  name: string
  severity: string
  intervals: Interval[]
  /** Distinct label sets (instances) seen firing/pending in the window. */
  instances: number
}

/**
 * Lanes from `ALERTS` range-query series (one series per instance and state).
 * Consecutive samples (gap ≤ 1.5 × step) form one interval; instances of the
 * same alertname merge into one lane. Firing wins over pending on overlap at
 * render time (firing is drawn on top).
 */
export function lanesFromAlertsSeries(
  series: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>,
  stepSec: number,
): Lane[] {
  const lanes = new Map<string, Lane & { keys: Set<string> }>()
  const gap = stepSec * 1.5
  for (const s of series) {
    const name = s.metric.alertname ?? 'alert'
    const state = s.metric.alertstate === 'pending' ? 'pending' : 'firing'
    const lane = lanes.get(name) ?? { name, severity: s.metric.severity ?? 'none', intervals: [], instances: 0, keys: new Set<string>() }
    const { alertstate: _s, ...rest } = s.metric
    lane.keys.add(labelKey(rest))
    if (severityRank(s.metric.severity ?? 'none') < severityRank(lane.severity)) lane.severity = s.metric.severity
    let cur: Interval | null = null
    for (const [t] of s.values) {
      const ms = t * 1000
      if (cur && t - cur.end / 1000 <= gap) cur.end = ms
      else {
        if (cur) lane.intervals.push(cur)
        cur = { start: ms, end: ms, state }
      }
    }
    if (cur) lane.intervals.push(cur)
    lanes.set(name, lane)
  }
  return [...lanes.values()]
    .map(({ keys, ...l }) => ({
      ...l,
      instances: keys.size,
      intervals: mergeIntervals(l.intervals, stepSec * 1000),
    }))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || totalMs(b) - totalMs(a))
}

function mergeIntervals(iv: Interval[], stepMs: number): Interval[] {
  const out: Interval[] = []
  for (const state of ['pending', 'firing'] as const) {
    const xs = iv.filter((i) => i.state === state).sort((a, b) => a.start - b.start)
    let cur: Interval | null = null
    for (const i of xs) {
      if (cur && i.start <= cur.end + stepMs * 1.5) cur.end = Math.max(cur.end, i.end)
      else {
        if (cur) out.push(cur)
        cur = { ...i }
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

function totalMs(l: Lane): number {
  return l.intervals.reduce((a, i) => a + (i.end - i.start), 0)
}

/* ─────────── Alertmanager config (Grafana JSON form) ─────────── */

export interface AmRoute {
  receiver?: string
  group_by?: string[]
  matchers?: string[]
  object_matchers?: Array<[string, string, string]>
  match?: Record<string, string>
  match_re?: Record<string, string>
  continue?: boolean
  group_wait?: string
  group_interval?: string
  repeat_interval?: string
  routes?: AmRoute[]
  mute_time_intervals?: string[]
}

export interface AmInhibitRule {
  source_matchers?: string[]
  target_matchers?: string[]
  source_match?: Record<string, string>
  target_match?: Record<string, string>
  source_match_re?: Record<string, string>
  target_match_re?: Record<string, string>
  equal?: string[]
}

export interface AmReceiver {
  name: string
  integrations: string[]
}

/** Integration kinds a receiver declares (`slack_configs` → `slack`). */
export function receiverIntegrations(r: Record<string, unknown>): string[] {
  return Object.keys(r)
    .filter((k) => k.endsWith('_configs') && Array.isArray(r[k]) && (r[k] as unknown[]).length > 0)
    .map((k) => `${k.replace(/_configs$/, '')}${(r[k] as unknown[]).length > 1 ? ` ×${(r[k] as unknown[]).length}` : ''}`)
}

/** Human matchers for any route/inhibit matcher form. */
export function routeMatchers(r: { matchers?: string[]; object_matchers?: Array<[string, string, string]>; match?: Record<string, string>; match_re?: Record<string, string> }): string[] {
  return [
    ...(r.matchers ?? []),
    ...(r.object_matchers ?? []).map(([k, op, v]) => `${k}${op}"${v}"`),
    ...Object.entries(r.match ?? {}).map(([k, v]) => `${k}="${v}"`),
    ...Object.entries(r.match_re ?? {}).map(([k, v]) => `${k}=~"${v}"`),
  ]
}

export function inhibitSides(r: AmInhibitRule): { source: string[]; target: string[]; equal: string[] } {
  return {
    source: [
      ...(r.source_matchers ?? []),
      ...Object.entries(r.source_match ?? {}).map(([k, v]) => `${k}="${v}"`),
      ...Object.entries(r.source_match_re ?? {}).map(([k, v]) => `${k}=~"${v}"`),
    ],
    target: [
      ...(r.target_matchers ?? []),
      ...Object.entries(r.target_match ?? {}).map(([k, v]) => `${k}="${v}"`),
      ...Object.entries(r.target_match_re ?? {}).map(([k, v]) => `${k}=~"${v}"`),
    ],
    equal: r.equal ?? [],
  }
}

/** Flatten a route tree for display: depth-first with depth. */
export function flattenRoutes(root: AmRoute | undefined): Array<{ route: AmRoute; depth: number }> {
  const out: Array<{ route: AmRoute; depth: number }> = []
  const walk = (r: AmRoute, d: number) => {
    out.push({ route: r, depth: d })
    for (const c of r.routes ?? []) walk(c, d + 1)
  }
  if (root) walk(root, 0)
  return out
}

/** "2h 5m" style duration between two instants. */
export function since(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  let s = Math.max(0, Math.round((now - t) / 1000))
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m`
  return `${s}s`
}
