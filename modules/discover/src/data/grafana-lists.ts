/**
 * List panels — alert list, dashboard list, annotation list — pure halves.
 *
 * Alert list reads Grafana-managed rules (`/api/prometheus/grafana/api/v1/
 * rules`) and the Prometheus datasource's rules (`/api/v1/rules`), both in
 * the Prometheus rules format, and applies the panel's options the way
 * Grafana's unified alert list does: `stateFilter`, `alertName`,
 * `onlyAlertsOnDashboard`, `alertInstanceLabelFilter`, `sortOrder`,
 * `maxItems`.
 */

export type AlertState = 'firing' | 'pending' | 'normal' | 'nodata' | 'error' | 'recovering'

export interface AlertItem {
  key: string
  name: string
  state: AlertState
  source: 'Grafana' | 'Prometheus'
  group: string
  folder?: string
  /** Earliest activeAt of the rule's alerting instances (ms). */
  activeAt?: number
  instances: Array<{ labels: Record<string, string>; state: string; value?: string }>
  labels: Record<string, string>
  summary?: string
  dashboardUid?: string
  panelId?: number
}

interface RuleGroup {
  name?: string
  file?: string
  rules?: Array<{
    name?: string
    state?: string
    health?: string
    type?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    alerts?: Array<{ labels?: Record<string, string>; state?: string; activeAt?: string; value?: string }>
  }>
}

function ruleState(state?: string, health?: string): AlertState {
  const h = (health ?? '').toLowerCase()
  if (h === 'error' || h === 'err') return 'error'
  if (h === 'nodata') return 'nodata'
  const s = (state ?? '').toLowerCase()
  if (s === 'firing' || s === 'alerting') return 'firing'
  if (s === 'pending') return 'pending'
  if (s === 'recovering') return 'recovering'
  if (s === 'nodata') return 'nodata'
  if (s === 'error') return 'error'
  return 'normal'
}

/** Prometheus-format rule groups → alert items (alerting rules only). */
export function normalizeRuleGroups(groups: RuleGroup[] | undefined, source: AlertItem['source']): AlertItem[] {
  const out: AlertItem[] = []
  for (const g of groups ?? []) {
    for (const r of g.rules ?? []) {
      if (r.type && r.type !== 'alerting') continue
      const active = (r.alerts ?? []).map((a) => Date.parse(a.activeAt ?? '')).filter((t) => Number.isFinite(t) && t > 0)
      out.push({
        key: `${source}:${g.file ?? ''}:${g.name ?? ''}:${r.name ?? ''}`,
        name: r.name ?? 'Unnamed rule',
        state: ruleState(r.state, r.health),
        source,
        group: g.name ?? '',
        folder: g.file,
        activeAt: active.length ? Math.min(...active) : undefined,
        instances: (r.alerts ?? []).map((a) => ({ labels: a.labels ?? {}, state: a.state ?? '', value: a.value })),
        labels: r.labels ?? {},
        summary: r.annotations?.summary ?? r.annotations?.description,
        dashboardUid: r.annotations?.__dashboardUid__,
        panelId: r.annotations?.__panelId__ ? Number(r.annotations.__panelId__) : undefined,
      })
    }
  }
  return out
}

export interface AlertListOptions {
  stateFilter?: Partial<Record<'firing' | 'pending' | 'noData' | 'normal' | 'error' | 'recovering', boolean>> | string[]
  onlyAlertsOnDashboard?: boolean
  maxItems?: number
  sortOrder?: number
  alertName?: string
  alertInstanceLabelFilter?: string
  viewMode?: 'list' | 'stat'
  folder?: { uid?: string; title?: string } | null
}

const IMPORTANCE: Record<AlertState, number> = { firing: 0, error: 1, nodata: 2, pending: 3, recovering: 4, normal: 5 }

/** Parse `{a="b", c=~"d.*"}` (or `a=b`) into matchers. */
export function parseLabelFilter(s: string | undefined): Array<{ name: string; op: string; value: string }> {
  const body = (s ?? '').trim().replace(/^\{|\}$/g, '')
  if (!body) return []
  const out: Array<{ name: string; op: string; value: string }> = []
  for (const m of body.matchAll(/([a-zA-Z_][\w]*)\s*(=~|!~|!=|=)\s*"?([^",}]*)"?/g)) out.push({ name: m[1], op: m[2], value: m[3] })
  return out
}

function labelsMatch(labels: Record<string, string>, ms: Array<{ name: string; op: string; value: string }>): boolean {
  return ms.every((m) => {
    const v = labels[m.name] ?? ''
    switch (m.op) {
      case '=':
        return v === m.value
      case '!=':
        return v !== m.value
      case '=~':
        try {
          return new RegExp(`^(?:${m.value})$`).test(v)
        } catch {
          return false
        }
      case '!~':
        try {
          return !new RegExp(`^(?:${m.value})$`).test(v)
        } catch {
          return true
        }
      default:
        return true
    }
  })
}

/** Apply alert list options. */
export function filterAlertItems(items: AlertItem[], o: AlertListOptions, dashboardUid?: string): AlertItem[] {
  let sf: Set<AlertState>
  if (Array.isArray(o.stateFilter)) {
    // Legacy alert list: ['alerting', 'no_data', 'pending', 'ok', ...]
    const map: Record<string, AlertState> = { alerting: 'firing', no_data: 'nodata', pending: 'pending', ok: 'normal', execution_error: 'error', paused: 'normal' }
    sf = new Set(o.stateFilter.map((x) => map[x]).filter(Boolean))
  } else {
    const f = o.stateFilter ?? { firing: true, pending: true, error: true }
    sf = new Set<AlertState>()
    if (f.firing) sf.add('firing')
    if (f.pending) sf.add('pending')
    if (f.noData) sf.add('nodata')
    if (f.normal) sf.add('normal')
    if (f.error) sf.add('error')
    if (f.recovering) sf.add('recovering')
  }
  const name = (o.alertName ?? '').trim().toLowerCase()
  const lf = parseLabelFilter(o.alertInstanceLabelFilter)
  let out = items.filter((i) => {
    if (sf.size && !sf.has(i.state)) return false
    if (name && !i.name.toLowerCase().includes(name)) return false
    if (o.onlyAlertsOnDashboard && (!dashboardUid || i.dashboardUid !== dashboardUid)) return false
    if (o.folder?.title && i.folder !== o.folder.title) return false
    if (lf.length && !(labelsMatch(i.labels, lf) || i.instances.some((x) => labelsMatch({ ...i.labels, ...x.labels }, lf)))) return false
    return true
  })
  const t = (i: AlertItem) => i.activeAt ?? 0
  switch (o.sortOrder ?? 1) {
    case 2:
      out = out.sort((a, b) => b.name.localeCompare(a.name))
      break
    case 3:
      out = out.sort((a, b) => IMPORTANCE[a.state] - IMPORTANCE[b.state] || a.name.localeCompare(b.name))
      break
    case 4:
      out = out.sort((a, b) => t(a) - t(b))
      break
    case 5:
      out = out.sort((a, b) => t(b) - t(a))
      break
    default:
      out = out.sort((a, b) => a.name.localeCompare(b.name))
  }
  return out.slice(0, Math.max(1, o.maxItems ?? 20))
}

/* ─────────── dashboard list ─────────── */

export interface DashListOptions {
  showStarred?: boolean
  showRecentlyViewed?: boolean
  showSearch?: boolean
  showHeadings?: boolean
  maxItems?: number
  query?: string
  tags?: string[]
  folderUID?: string
  folderId?: number
  includeVars?: boolean
  keepTime?: boolean
}

/** Grafana search URL for the dash list's "Search" section. */
export function dashSearchPath(o: DashListOptions): string {
  const qs = new URLSearchParams({ type: 'dash-db', limit: String(Math.max(1, o.maxItems ?? 10)) })
  if (o.query) qs.set('query', o.query)
  for (const t of o.tags ?? []) qs.append('tag', t)
  if (o.folderUID) qs.set('folderUIDs', o.folderUID)
  else if (o.folderId != null) qs.set('folderIds', String(o.folderId))
  return `/api/search?${qs}`
}

/* ─────────── annotation list ─────────── */

export interface AnnoListOptions {
  onlyFromThisDashboard?: boolean
  onlyInTimeRange?: boolean
  tags?: string[]
  limit?: number
  showUser?: boolean
  showTime?: boolean
  showTags?: boolean
}

export function annotationsPath(o: AnnoListOptions, dashboardUid: string, range: { start: number; end: number }): string {
  const qs = new URLSearchParams({ type: 'annotation', limit: String(Math.max(1, o.limit ?? 10)) })
  for (const t of o.tags ?? []) qs.append('tags', t)
  if (o.onlyFromThisDashboard) qs.set('dashboardUID', dashboardUid)
  if (o.onlyInTimeRange) {
    qs.set('from', String(Math.floor(range.start)))
    qs.set('to', String(Math.floor(range.end)))
  }
  return `/api/annotations?${qs}`
}
