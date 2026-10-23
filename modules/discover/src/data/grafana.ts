import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ALL_VALUE,
  applyPanelTime,
  applyVarRegex,
  builtinVars,
  computeStepMs,
  currentValues,
  dsKind,
  type GrafanaDashboard,
  type GrafanaDatasource,
  type GrafanaPanel,
  type GrafanaTarget,
  type GrafanaVariable,
  interpolate,
  orderVariables,
  parseCustomOptions,
  parseDuration,
  parsePromVarQuery,
  type PromSeries,
  reconcileSelection,
  resolveDatasource,
  type SearchHit,
  sortOptions,
  type VarMap,
  type VarState,
  variableQuery,
} from './grafana-board.ts'
import { normalizeRuleGroups } from './grafana-lists.ts'

/**
 * Grafana data layer for the "Grafana boards" page.
 *
 * Talks straight to the console BFF tool proxies with `fetch` (not through
 * `lgtmClient`) so each call targets the exact Grafana/datasource endpoint it
 * needs. These hooks always hit the real backend and surface its real status.
 *
 *   • library        → GET  /api/svc/grafana/api/search?type=dash-db
 *   • folders        → GET  /api/svc/grafana/api/folders
 *   • dashboard JSON → GET  /api/svc/grafana/api/dashboards/uid/<uid>
 *   • datasources    → GET  /api/svc/grafana/api/datasources
 *   • panel data     → GET  /api/svc/grafana/api/datasources/proxy/uid/<ds>/api/v1/query_range
 *                      (the panel's own datasource, so Mimir/Prometheus/Loki all work);
 *                      falls back to /api/svc/prometheus when Grafana won't list datasources
 *   • star / unstar  → POST|DELETE /api/svc/grafana/api/user/stars/dashboard/uid/<uid>
 *   • import         → POST /api/svc/grafana/api/dashboards/db
 */

const GRAFANA = '/api/svc/grafana'

/** Error carrying `.status` so `states.tsx#classify` can explain it. */
export class FetchError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message)
    this.name = 'HttpError'
  }
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      credentials: 'include',
      ...init,
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    })
  } catch (e) {
    const err = new Error(`Network error: ${(e as Error).message}`)
    err.name = 'NetworkError'
    throw err
  }
  const text = await res.text()
  let body: unknown = undefined
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  if (!res.ok) {
    const msg = (body as { message?: string; error?: string } | undefined)?.message ??
      (body as { error?: string } | undefined)?.error ??
      (typeof body === 'string' && body.length < 200 ? body : '')
    throw new FetchError(res.status, `HTTP ${res.status}${msg ? ` — ${msg}` : ''}`, body)
  }
  // Grafana behind an auth proxy answers 200 with the login page's HTML.
  if (typeof body === 'string' && /^\s*</.test(body)) {
    throw new FetchError(401, 'Grafana answered with an HTML page (a login redirect?) instead of JSON')
  }
  return body as T
}

/* ─────────── library ─────────── */

export function useGrafanaLibrary() {
  return useQuery({
    queryKey: ['grafana', 'search'],
    queryFn: async () => {
      const raw = await getJson<unknown>(`${GRAFANA}/api/search?type=dash-db&limit=5000`)
      if (!Array.isArray(raw)) throw new FetchError(502, 'Grafana search did not return a list')
      return (raw as Array<Record<string, unknown>>).map((d): SearchHit => ({
        uid: String(d.uid ?? ''),
        title: String(d.title ?? 'Untitled'),
        tags: Array.isArray(d.tags) ? (d.tags as string[]) : [],
        folderTitle: (d.folderTitle as string | undefined) || undefined,
        folderUid: (d.folderUid as string | undefined) || undefined,
        isStarred: Boolean(d.isStarred),
        url: d.url as string | undefined,
        type: d.type as string | undefined,
      })).filter((d) => d.uid)
    },
    staleTime: 60_000,
    retry: (n, e) => n < 1 && (e as FetchError).status !== 401 && (e as FetchError).status !== 403,
  })
}

export function useGrafanaFolders() {
  return useQuery({
    queryKey: ['grafana', 'folders'],
    queryFn: () => getJson<Array<{ uid: string; title: string }>>(`${GRAFANA}/api/folders?limit=1000`),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useGrafanaDatasources() {
  return useQuery({
    queryKey: ['grafana', 'datasources'],
    queryFn: () => getJson<GrafanaDatasource[]>(`${GRAFANA}/api/datasources`),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useGrafanaDashboard(uid: string | null | undefined) {
  return useQuery({
    queryKey: ['grafana', 'dashboard', uid],
    queryFn: () =>
      getJson<{ dashboard: GrafanaDashboard; meta?: { folderTitle?: string; url?: string; isStarred?: boolean; updated?: string; updatedBy?: string; version?: number } }>(
        `${GRAFANA}/api/dashboards/uid/${encodeURIComponent(uid!)}`,
      ),
    enabled: !!uid,
    staleTime: 5 * 60_000,
  })
}

export function useStarDashboard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ uid, star }: { uid: string; star: boolean }) =>
      getJson(`${GRAFANA}/api/user/stars/dashboard/uid/${encodeURIComponent(uid)}`, { method: star ? 'POST' : 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['grafana', 'search'] })
    },
  })
}

export function useImportDashboard() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (p: { dashboard: Record<string, unknown>; folderUid?: string; overwrite?: boolean }) =>
      getJson<{ uid: string; url: string; status: string }>(`${GRAFANA}/api/dashboards/db`, {
        method: 'POST',
        body: JSON.stringify({
          dashboard: p.dashboard,
          folderUid: p.folderUid || undefined,
          overwrite: !!p.overwrite,
          message: 'Imported from Adhar Console',
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['grafana', 'search'] }),
  })
}

/* ─────────── datasource HTTP ─────────── */

/** Base path that speaks the Prometheus HTTP API for a datasource. */
export function promBase(ds: GrafanaDatasource | null): string {
  return ds ? `${GRAFANA}/api/datasources/proxy/uid/${encodeURIComponent(ds.uid)}` : '/api/svc/prometheus'
}

function lokiBase(ds: GrafanaDatasource | null): string {
  return ds ? `${GRAFANA}/api/datasources/proxy/uid/${encodeURIComponent(ds.uid)}` : '/api/svc/loki'
}

async function promGet<T>(base: string, path: string, params: Record<string, string | string[]>): Promise<T> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) qs.append(k, x)
  const body = await getJson<{ status?: string; data?: T; error?: string }>(`${base}${path}?${qs}`)
  if (body?.status === 'error') throw new FetchError(400, body.error ?? 'query error')
  return body.data as T
}

/* ─────────── template variables ─────────── */

export interface BoardTime {
  start: number
  end: number
}

export interface BoardVariable {
  def: GrafanaVariable
  options: Array<{ text: string; value: string }>
  loading: boolean
  error?: unknown
}

async function loadQueryVarOptions(q: string, ds: GrafanaDatasource | null, time: BoardTime): Promise<string[]> {
  const kind = dsKind(ds)
  const start = String(Math.floor(time.start / 1000))
  const end = String(Math.floor(time.end / 1000))
  if (kind === 'loki') {
    const m = /^label_values\(\s*(?:([\s\S]+?)\s*,\s*)?([\w]+)\s*\)$/.exec(q.trim())
    const label = m?.[2] ?? q.trim()
    const params: Record<string, string> = { start: `${start}000000000`, end: `${end}000000000` }
    if (m?.[1]) params.query = m[1]
    return (await promGet<string[]>(lokiBase(ds), `/loki/api/v1/label/${encodeURIComponent(label)}/values`, params)) ?? []
  }
  if (kind !== 'prometheus') return []
  const base = promBase(ds)
  const p = parsePromVarQuery(q)
  switch (p.kind) {
    case 'label_values': {
      const params: Record<string, string | string[]> = { start, end }
      if (p.match) params['match[]'] = p.match
      return (await promGet<string[]>(base, `/api/v1/label/${encodeURIComponent(p.label)}/values`, params)) ?? []
    }
    case 'label_names': {
      const params: Record<string, string | string[]> = { start, end }
      if (p.match) params['match[]'] = p.match
      return (await promGet<string[]>(base, '/api/v1/labels', params)) ?? []
    }
    case 'metrics': {
      const all = (await promGet<string[]>(base, '/api/v1/label/__name__/values', { start, end })) ?? []
      try {
        const re = new RegExp(p.regex || '.*')
        return all.filter((n) => re.test(n))
      } catch {
        return all
      }
    }
    case 'query_result': {
      const data = await promGet<{ result: PromSeries[] }>(base, '/api/v1/query', { query: p.expr, time: end })
      return (data?.result ?? []).map((s) => {
        const { __name__, ...rest } = s.metric
        const lbl = Object.entries(rest).map(([k, v]) => `${k}="${v}"`).join(',')
        return `${__name__ ?? ''}{${lbl}} ${s.value?.[1] ?? ''} ${(s.value?.[0] ?? 0) * 1000}`
      })
    }
    default:
      // Bare PromQL (Grafana treats an unknown query as query_result-ish).
      if (!p.raw) return []
      return (await promGet<string[]>(base, '/api/v1/label/__name__/values', { start, end, 'match[]': p.raw }).catch(() => [])) ?? []
  }
}

/**
 * Resolve a board's template variables. Selections start from the URL, then
 * the dashboard's saved `current`, and are reconciled with each variable's
 * real options (chained variables refetch as their parents change).
 */
export function useBoardVariables(
  dashboard: GrafanaDashboard | undefined,
  datasources: GrafanaDatasource[],
  time: BoardTime,
  urlVars: Record<string, string[]>,
) {
  const defs = useMemo(
    () => orderVariables((dashboard?.templating?.list ?? []).filter((v) => v.type !== 'adhoc')),
    [dashboard],
  )
  const [selected, setSelected] = useState<Record<string, string[]>>({})

  // Seed selections whenever the board changes.
  useEffect(() => {
    const seed: Record<string, string[]> = {}
    for (const d of defs) seed[d.name] = urlVars[d.name]?.length ? urlVars[d.name] : currentValues(d)
    setSelected(seed)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseed per board, not per URL write
  }, [defs])

  // Static options (custom / constant / interval / datasource / textbox).
  const staticOptions = useMemo(() => {
    const out: Record<string, Array<{ text: string; value: string }>> = {}
    for (const d of defs) {
      const q = variableQuery(d)
      if (d.type === 'custom') out[d.name] = parseCustomOptions(q)
      else if (d.type === 'constant') out[d.name] = [{ text: q, value: q }]
      else if (d.type === 'interval') {
        const list = parseCustomOptions(q)
        out[d.name] = d.auto ? [{ text: 'auto', value: 'auto' }, ...list] : list
      } else if (d.type === 'datasource') {
        const names = applyVarRegex(datasources.filter((x) => x.type === q || (q === 'prometheus' && dsKind(x) === 'prometheus')).map((x) => x.name), d.regex)
        out[d.name] = names.map((n) => ({ text: n, value: n }))
      } else if (d.type === 'textbox') {
        const v = currentValues(d)[0] ?? q
        out[d.name] = [{ text: v, value: v }]
      }
    }
    return out
  }, [defs, datasources])

  // Build the VarMap in dependency order. A query variable's options come
  // from the query cache under the key its (already-resolved) parents give
  // it, so a chain like datasource → cluster → namespace resolves in one
  // render once each answer lands, rather than lagging a render per level.
  const qc = useQueryClient()
  const stepMs = computeStepMs(time.end - time.start)
  const builtins = builtinVars(time.end - time.start, stepMs)
  // Round the window to the minute so keys are stable between renders.
  const tKey = [Math.floor(time.start / 60_000), Math.floor(time.end / 60_000)]

  const vars: VarMap = {}
  const specs: Array<{ d: GrafanaVariable; ds: GrafanaDatasource | null; q: string; key: unknown[] }> = []
  for (const d of defs) {
    const state: VarState = {
      values: selected[d.name] ?? [],
      options: (staticOptions[d.name] ?? []).map((o) => o.value),
      includeAll: d.includeAll,
      allValue: d.allValue,
      multi: d.multi,
    }
    if (d.type === 'query') {
      const ds = resolveDatasource(d.datasource ?? null, datasources, vars)
      const q = interpolate(variableQuery(d), vars, builtins)
      const key = ['grafana', 'var', d.name, ds?.uid ?? 'prom', q, tKey]
      specs.push({ d, ds, q, key })
      state.options = qc.getQueryData<string[]>(key) ?? []
    }
    // `auto` interval → the computed step.
    if (d.type === 'interval' && state.values[0] === 'auto') state.values = [builtins.__interval]
    vars[d.name] = state
  }
  const queryDefs = specs.map((s) => s.d)

  const results = useQueries({
    queries: specs.map(({ d, ds, q, key }) => ({
      queryKey: key,
      queryFn: async () => {
        const raw = await loadQueryVarOptions(q, ds, time)
        return sortOptions(applyVarRegex(raw, d.regex), d.sort ?? 0)
      },
      staleTime: 60_000,
      // Wait while a parent reference is still unresolved.
      enabled: !/\$(?!__)\w|\$\{|\[\[/.test(q),
      retry: false,
    })),
  })

  const queryOptions: Record<string, { opts?: string[]; loading: boolean; error?: unknown }> = {}
  queryDefs.forEach((d, i) => {
    queryOptions[d.name] = { opts: results[i]?.data, loading: !!results[i]?.isLoading, error: results[i]?.error ?? undefined }
    if (results[i]?.data) vars[d.name] = { ...vars[d.name], options: results[i].data! }
  })

  // Reconcile selections with loaded options (first option / All).
  const optionsKey = JSON.stringify(defs.map((d) => vars[d.name]?.options ?? []))
  useEffect(() => {
    setSelected((cur) => {
      let changed = false
      const next = { ...cur }
      for (const d of defs) {
        if (d.type === 'textbox' || d.type === 'constant') continue
        if (d.type === 'query' && (queryOptions[d.name]?.opts === undefined)) continue
        let opts = d.type === 'query' ? queryOptions[d.name]?.opts ?? [] : (staticOptions[d.name] ?? []).map((o) => o.value)
        let sel = cur[d.name] ?? []
        if (d.type === 'datasource') {
          // Saved value may be a uid; the select shows names.
          sel = sel.map((s) => datasources.find((x) => x.uid === s)?.name ?? s)
          if (sel.length === 1 && sel[0] === 'default') sel = [datasources.find((x) => x.isDefault)?.name ?? sel[0]]
        }
        if (d.type === 'interval' && sel[0] === 'auto') continue
        if (d.type === 'query' && opts.length === 0) opts = []
        const r = reconcileSelection(sel, opts, !!d.includeAll)
        if (JSON.stringify(r) !== JSON.stringify(cur[d.name] ?? [])) {
          next[d.name] = r
          changed = true
        }
      }
      return changed ? next : cur
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- driven by the options fingerprint
  }, [optionsKey, defs, datasources])

  const list: BoardVariable[] = defs.map((d) => ({
    def: d,
    options: d.type === 'query'
      ? (queryOptions[d.name]?.opts ?? []).map((v) => ({ text: v, value: v }))
      : staticOptions[d.name] ?? [],
    loading: d.type === 'query' ? !!queryOptions[d.name]?.loading : false,
    error: d.type === 'query' ? queryOptions[d.name]?.error : undefined,
  }))

  return {
    variables: list,
    vars,
    selected,
    setValue: (name: string, values: string[]) => setSelected((cur) => ({ ...cur, [name]: values })),
  }
}

/* ─────────── panel data ─────────── */

export interface PanelFrame {
  refId: string
  legendFormat?: string
  series: PromSeries[]
  /** Log lines for Loki stream queries. */
  logs?: Array<{ ts: number; line: string; labels: Record<string, string> }>
  /** `format: table` — one table frame per query. */
  table?: boolean
  /** `format: heatmap` — classic histogram buckets. */
  heatmap?: boolean
  /** Query step (ms) — Grafana's field `interval`. */
  stepMs?: number
}

export interface PanelData {
  frames: PanelFrame[]
  /** The panel cannot be rendered natively (datasource kind / panel type). */
  unsupported?: string
  queries: string[]
  /** Effective window after the panel's timeFrom / timeShift. */
  range?: { start: number; end: number }
  stepMs?: number
}

export interface PanelContext {
  datasources: GrafanaDatasource[]
  /** False when Grafana refused `/api/datasources` — use the console proxies. */
  dsKnown: boolean
  vars: VarMap
  time: BoardTime
  /** Query refresh tick (bumps on manual refresh / interval). */
  tick: number
}

const INSTANT_TYPES = new Set(['gauge', 'bargauge', 'piechart', 'table', 'table-old', 'barchart'])

function targetQuery(t: GrafanaTarget): string {
  return (t.expr ?? (typeof t.query === 'string' ? t.query : '') ?? '').trim()
}

/** The panel's effective time window (timeFrom / timeShift) + header info. */
export function panelTime(panel: GrafanaPanel, ctx: PanelContext) {
  return applyPanelTime(ctx.time, panel.timeFrom, panel.timeShift, ctx.vars)
}

/**
 * Run every visible target of a panel through its datasource. `widthPx` is
 * the panel's width — Grafana's default `maxDataPoints`.
 */
export function usePanelData(panel: GrafanaPanel, ctx: PanelContext, enabled = true, widthPx = 0) {
  const time = panelTime(panel, ctx)
  const rangeMs = time.end - time.start
  const panelMin = parseDuration(interpolate(panel.interval ?? '', ctx.vars, {}, panel.scopedVars))
  // Grafana: maxDataPoints defaults to the panel width; Prometheus caps a range query at 11k points.
  const maxPoints = Math.min(panel.maxDataPoints ?? (widthPx > 0 ? Math.round(widthPx / 50) * 50 : 300), 11_000)
  const targets = (panel.targets ?? []).filter((t) => !t.hide && targetQuery(t))
  const tableish = panel.type === 'table' || panel.type === 'table-old'

  const plan = targets.map((t, i) => {
    const dsRef = t.datasource && !(typeof t.datasource === 'object' && t.datasource.uid === '-- Mixed --')
      ? t.datasource
      : panel.datasource
    const ds = ctx.dsKnown ? resolveDatasource(dsRef ?? null, ctx.datasources, ctx.vars) : null
    const kindFromRef = typeof dsRef === 'object' && dsRef?.type ? dsRef.type : undefined
    const kind = ds ? dsKind(ds) : kindFromRef === 'loki' ? 'loki' : kindFromRef && kindFromRef !== 'prometheus' ? 'other' : 'prometheus'
    // Min step: the target's own interval, else the panel's min interval, else the 15s scrape.
    const minStep = parseDuration(interpolate(t.interval ?? '', ctx.vars, {}, panel.scopedVars)) ?? panelMin ?? 15_000
    const stepMs = computeStepMs(rangeMs, maxPoints, minStep)
    // $__rate_interval uses the min step as the scrape interval when one is set (Grafana docs).
    const builtins = builtinVars(rangeMs, stepMs, Math.max(15_000, minStep))
    const q = interpolate(targetQuery(t), ctx.vars, builtins, panel.scopedVars)
    const instant = t.instant === true && t.range !== true
      ? true
      : t.format === 'table' || (INSTANT_TYPES.has(panel.type) && t.range !== true && t.instant !== false)
    // A table panel without transformations shows each query as label columns + value.
    const table = t.format === 'table' || (tableish && !(panel.transformations ?? []).length)
    return { t, ds, kind, q, instant, stepMs, table, heatmap: t.format === 'heatmap', refId: t.refId ?? String.fromCharCode(65 + i) }
  })
  const stepMs = plan[0]?.stepMs ?? computeStepMs(rangeMs, maxPoints, panelMin ?? 15_000)

  const unsupported = plan.find((p) => p.kind === 'other')
  return useQuery({
    queryKey: ['grafana', 'panel', panel.id, plan.map((p) => [p.ds?.uid, p.q, p.instant, p.stepMs, p.table]), Math.floor(time.start / 1000), Math.floor(time.end / 1000), ctx.tick],
    queryFn: async (): Promise<PanelData> => {
      if (unsupported && plan.every((p) => p.kind === 'other')) {
        return { frames: [], unsupported: `${unsupported.ds?.type ?? 'this'} datasource`, queries: plan.map((p) => p.q) }
      }
      const start = time.start / 1000
      const end = time.end / 1000
      const frames = await Promise.all(
        plan.filter((p) => p.kind !== 'other').map(async (p): Promise<PanelFrame> => {
          if (p.kind === 'loki') {
            const params = {
              query: p.q,
              start: `${Math.floor(start)}000000000`,
              end: `${Math.floor(end)}000000000`,
              limit: '200',
              step: `${Math.round(p.stepMs / 1000)}s`,
            }
            const data = await promGet<{ resultType: string; result: Array<{ stream?: Record<string, string>; metric?: Record<string, string>; values: Array<[string, string]> }> }>(
              lokiBase(p.ds),
              '/loki/api/v1/query_range',
              params,
            )
            if (data?.resultType === 'streams') {
              const logs = (data.result ?? []).flatMap((s) =>
                s.values.map(([ts, line]) => ({ ts: Number(ts) / 1e6, line, labels: s.stream ?? {} })),
              ).sort((a, b) => b.ts - a.ts)
              return { refId: p.refId, series: [], logs }
            }
            return {
              refId: p.refId,
              legendFormat: p.t.legendFormat,
              stepMs: p.stepMs,
              series: (data?.result ?? []).map((s) => ({ metric: s.metric ?? {}, values: s.values.map(([t, v]) => [Number(t), v] as [number, string]) })),
            }
          }
          const base = promBase(p.ds)
          if (p.instant) {
            const data = await promGet<{ resultType: string; result: PromSeries[] | [number, string] }>(base, '/api/v1/query', { query: p.q, time: String(end) })
            const result = data?.resultType === 'scalar'
              ? [{ metric: {}, value: data.result as [number, string] }]
              : (data?.result as PromSeries[]) ?? []
            return { refId: p.refId, legendFormat: p.t.legendFormat, series: result, table: p.table, heatmap: p.heatmap, stepMs: p.stepMs }
          }
          const data = await promGet<{ result: PromSeries[] }>(base, '/api/v1/query_range', {
            query: p.q,
            start: String(start),
            end: String(end),
            step: `${Math.round(p.stepMs / 1000)}s`,
          })
          return { refId: p.refId, legendFormat: p.t.legendFormat, series: data?.result ?? [], table: p.table, heatmap: p.heatmap, stepMs: p.stepMs }
        }),
      )
      return { frames, queries: plan.map((p) => p.q), range: { start: time.start, end: time.end }, stepMs }
    },
    enabled: enabled && plan.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: false,
  })
}

/* ─────────── list panels ─────────── */

/**
 * Alert rules for the alert list panel: Grafana-managed rules plus the
 * Prometheus datasource's rules (both Prometheus rules format). A source
 * that fails is reported, not fatal, so one missing API still lists the other.
 */
export function useAlertRules(enabled: boolean, tick: number) {
  return useQuery({
    queryKey: ['grafana', 'alertlist', tick],
    queryFn: async () => {
      type Groups = { data?: { groups?: Parameters<typeof normalizeRuleGroups>[0] } }
      const [g, p] = await Promise.allSettled([
        getJson<Groups>(`${GRAFANA}/api/prometheus/grafana/api/v1/rules`),
        getJson<Groups>('/api/svc/prometheus/api/v1/rules?type=alert'),
      ])
      if (g.status === 'rejected' && p.status === 'rejected') throw g.reason
      return {
        items: [
          ...(g.status === 'fulfilled' ? normalizeRuleGroups(g.value?.data?.groups, 'Grafana') : []),
          ...(p.status === 'fulfilled' ? normalizeRuleGroups(p.value?.data?.groups, 'Prometheus') : []),
        ],
        failed: [g.status === 'rejected' ? 'Grafana-managed rules' : '', p.status === 'rejected' ? 'Prometheus rules' : ''].filter(Boolean),
      }
    },
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? 30_000 : false,
    retry: false,
  })
}

/** Dashboard search for the dash list panel (`starred` or a search path). */
export function useDashSearch(path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['grafana', 'dashlist', path],
    queryFn: async () => {
      const raw = await getJson<Array<Record<string, unknown>>>(`${GRAFANA}${path}`)
      return (Array.isArray(raw) ? raw : []).map((d) => ({
        uid: String(d.uid ?? ''),
        title: String(d.title ?? 'Untitled'),
        folderTitle: (d.folderTitle as string | undefined) || 'General',
        tags: Array.isArray(d.tags) ? (d.tags as string[]) : [],
        isStarred: Boolean(d.isStarred),
      })).filter((d) => d.uid)
    },
    enabled: enabled && !!path,
    staleTime: 60_000,
    retry: false,
  })
}

export interface GrafanaAnnotation {
  id: number
  time: number
  timeEnd?: number
  text?: string
  tags?: string[]
  login?: string
  email?: string
  dashboardUID?: string
  panelId?: number
  alertId?: number
  newState?: string
}

export function useAnnotations(path: string, enabled: boolean, tick: number) {
  return useQuery({
    queryKey: ['grafana', 'annolist', path, tick],
    queryFn: () => getJson<GrafanaAnnotation[]>(`${GRAFANA}${path}`),
    enabled,
    staleTime: 15_000,
    retry: false,
  })
}

export { ALL_VALUE }
