// deno-lint-ignore-file require-await -- the in-memory stub implements an async interface with synchronous bodies.
import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'
import type {
  MbAlert,
  MbAlertInput,
  MbBookmark,
  MbCard,
  MbCollectionNode,
  MbCurrentUser,
  MbDashboardDetail,
  MbDashcard,
  MbDatabase,
  MbDatabaseMetadata,
  MbDataset,
  MbField,
  MbNewCard,
  MbParameterValue,
  MbPulse,
  MbPulseFormInput,
  MbPulseInput,
  MbRecentItem,
  MbSearchItem,
  MbSessionProperties,
  MbSnippet,
  MbTable,
  MbTemplateTag,
  MbUserRef,
} from './types.ts'

export * from './types.ts'

/**
 * Metabase BI client.
 *
 * Surfaces databases, saved questions (cards), dashboards (collections of
 * cards), pulses (alerts/scheduled reports), and a `runQuery` endpoint for
 * the SQL editor.
 */

export const ChartTypeSchema = z.enum([
  'table',
  'line',
  'area',
  'bar',
  'pie',
  'scalar',
  'progress',
  'gauge',
])
export type ChartType = z.infer<typeof ChartTypeSchema>

export const DatabaseSchema = z.object({
  id: z.number(),
  name: z.string(),
  engine: z.string(),
  /** Connection state shorthand. */
  is_sample: z.boolean().optional(),
  schema_count: z.number().optional(),
  table_count: z.number().optional(),
  description: z.string().optional(),
})
export type Database = z.infer<typeof DatabaseSchema>

export const CollectionSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  description: z.string().optional(),
  color: z.string().optional(),
})
export type Collection = z.infer<typeof CollectionSchema>

export const QueryResultSchema = z.object({
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  cols: z.array(z.object({ name: z.string(), display_name: z.string().optional(), base_type: z.string().optional() })),
  row_count: z.number(),
  status: z.enum(['completed', 'failed']),
  running_time_ms: z.number().optional(),
  error: z.string().optional(),
})
export type QueryResult = z.infer<typeof QueryResultSchema>

export const QuestionSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  collection_id: z.number().optional(),
  display: ChartTypeSchema,
  database_id: z.number(),
  /** Native SQL when present, otherwise GUI query metadata. */
  sql: z.string().optional(),
  /** Cached most-recent run. */
  result: QueryResultSchema.optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  /** Number of times queried in last 30d. */
  view_count: z.number().optional(),
  /** Latest computed scalar — for KPI display. */
  scalar: z.number().optional(),
  scalar_unit: z.string().optional(),
  scalar_delta: z.number().optional(),
})
export type Question = z.infer<typeof QuestionSchema>

export const DashboardCardSchema = z.object({
  id: z.number(),
  card_id: z.number(),
  /** Position in 12-column grid. */
  col: z.number(),
  row: z.number(),
  size_x: z.number(),
  size_y: z.number(),
  visualization_settings: z.record(z.string(), z.unknown()).optional(),
})
export type DashboardCard = z.infer<typeof DashboardCardSchema>

export const DashboardSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  collection_id: z.number().optional(),
  /**
   * Only the DETAIL endpoint fills this in.
   *
   * `GET /api/dashboard` (the list) returns dashboard summaries with no
   * `cards` key at all; `GET /api/dashboard/:id` is what carries them. This
   * was declared required, and `listDashboards` casts the response with
   * `http.get<Dashboard[]>` rather than parsing it, so nothing — not zod, not
   * the compiler — ever noticed. Every consumer that reached for
   * `d.cards.length` off a list therefore threw against a real Metabase while
   * the stub, which does include `cards`, stayed perfectly happy.
   */
  cards: z.array(DashboardCardSchema).optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  view_count: z.number().optional(),
})
export type Dashboard = z.infer<typeof DashboardSchema>

export const PulseChannelSchema = z.object({
  channel_type: z.enum(['email', 'slack']),
  schedule: z.string(),
  recipients: z.array(z.string()).optional(),
})
export type PulseChannel = z.infer<typeof PulseChannelSchema>

export const PulseSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  card_ids: z.array(z.number()),
  channels: z.array(PulseChannelSchema),
  alert_condition: z.enum(['rows', 'goal']).optional(),
  alert_above_goal: z.boolean().optional(),
  goal: z.number().optional(),
  active: z.boolean(),
  last_run_at: z.string().optional(),
  created_at: z.string(),
})
export type Pulse = z.infer<typeof PulseSchema>

export interface MetabaseClient {
  listDatabases(): Promise<Database[]>
  listCollections(): Promise<Collection[]>
  listQuestions(filter?: { collectionId?: number }): Promise<Question[]>
  getQuestion(id: number): Promise<Question>
  listDashboards(): Promise<Dashboard[]>
  getDashboard(id: number): Promise<{ dashboard: Dashboard; cards: Question[] }>
  listPulses(): Promise<Pulse[]>
  togglePulse(id: number, active: boolean): Promise<void>
  /** Run native SQL against a database. */
  runQuery(databaseId: number, sql: string): Promise<QueryResult>

  /* ── Metabase 0.51 wire-shaped API (BI views) ── */
  currentUser(): Promise<MbCurrentUser>
  sessionProperties(): Promise<MbSessionProperties>
  collectionTree(): Promise<MbCollectionNode[]>
  search(opts: { q?: string; models?: string[]; collectionId?: number }): Promise<MbSearchItem[]>
  listCards(): Promise<MbCard[]>
  getCard(id: number): Promise<MbCard>
  runCard(id: number, parameters?: MbParameterValue[]): Promise<MbDataset>
  createCard(card: MbNewCard): Promise<MbCard>
  updateCard(id: number, patch: Partial<MbCard>): Promise<MbCard>
  /** Moves the card to the trash (`archived: true`) — recoverable in Metabase. */
  archiveCard(id: number): Promise<void>
  getDashboardDetail(id: number): Promise<MbDashboardDetail>
  runDashcard(
    dashboardId: number,
    dashcardId: number,
    cardId: number,
    parameters?: MbParameterValue[],
  ): Promise<MbDataset>
  createDashboard(input: { name: string; description?: string | null; collection_id: number | null }): Promise<MbDashboardDetail>
  /** Append a saved question below the dashboard's existing cards. */
  addCardToDashboard(dashboardId: number, cardId: number, opts?: { tabId?: number | null; sizeX?: number; sizeY?: number }): Promise<MbDashboardDetail>
  /** Suggested values of a list-backed dashboard filter (`[]` when it has none). */
  parameterValues(dashboardId: number, parameterId: string): Promise<string[]>
  listBookmarks(): Promise<MbBookmark[]>
  setBookmark(type: 'card' | 'dashboard' | 'collection', id: number, on: boolean): Promise<void>
  recentViews(): Promise<MbRecentItem[]>
  /** Native SQL with template tags (`{{var}}`) and their values. */
  runNative(
    databaseId: number,
    sql: string,
    opts?: { templateTags?: Record<string, MbTemplateTag>; parameters?: MbParameterValue[] },
  ): Promise<MbDataset>
  listDatabasesFull(): Promise<MbDatabase[]>
  databaseMetadata(id: number): Promise<MbDatabaseMetadata>
  syncSchema(id: number): Promise<void>
  rescanValues(id: number): Promise<void>
  /** `{ status: 'ok' }` or `{ status: 'error', message }`. */
  databaseHealth(id: number): Promise<{ status: string; message?: string }>
  updateTable(id: number, patch: Pick<Partial<MbTable>, 'description' | 'display_name'>): Promise<MbTable>
  updateField(id: number, patch: Pick<Partial<MbField>, 'description' | 'semantic_type' | 'display_name'>): Promise<MbField>
  listSubscriptions(): Promise<MbPulse[]>
  createSubscription(input: MbPulseInput): Promise<MbPulse>
  updateSubscription(id: number, patch: Partial<MbPulseInput> & { archived?: boolean }): Promise<MbPulse>
  /** Sends the subscription once, now, to its recipients. */
  testSubscription(input: MbPulseInput): Promise<void>
  pulseFormInput(): Promise<MbPulseFormInput>
  listAlerts(): Promise<MbAlert[]>
  createAlert(input: MbAlertInput): Promise<MbAlert>
  updateAlert(id: number, patch: Partial<MbAlertInput> & { archived?: boolean }): Promise<MbAlert>
  listUsers(): Promise<MbUserRef[]>
  listSnippets(): Promise<MbSnippet[]>
  createSnippet(input: { name: string; content: string; description?: string }): Promise<MbSnippet>
}

/**
 * A Metabase list response as an array. Metabase is not consistent across
 * endpoints or versions: `/api/database` has answered `{ data: [...], total }`
 * since 0.42 while `/api/card` and `/api/dashboard` are bare arrays. Reading
 * the envelope as an array crashed the SQL editor with
 * "(o.data ?? []).map is not a function".
 */
export function unwrapList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: T[] }).data
  }
  return []
}

function build(http: HttpClient): MetabaseClient {
  const list = async <T>(path: string) => unwrapList<T>(await http.get<unknown>(path))
  return {
    listDatabases: () => list<Database>(`/api/database`),
    listCollections: () => list<Collection>(`/api/collection`),
    listQuestions: (filter) => {
      const qs = filter?.collectionId ? `?collection=${filter.collectionId}` : ''
      return list<Question>(`/api/card${qs}`)
    },
    getQuestion: (id) => http.get<Question>(`/api/card/${id}`),
    listDashboards: () => list<Dashboard>(`/api/dashboard`),
    getDashboard: async (id) => {
      const dashboard = await http.get<Dashboard & { dashcards?: Dashboard['cards'] }>(`/api/dashboard/${id}`)
      // Metabase 0.47 renamed a dashboard's `cards` to `dashcards`.
      const dashcards = dashboard.dashcards ?? dashboard.cards ?? []
      const cards = await Promise.all(
        dashcards.filter((dc) => dc.card_id != null).map((dc) => http.get<Question>(`/api/card/${dc.card_id}`)),
      )
      return { dashboard: { ...dashboard, cards: dashcards }, cards }
    },
    listPulses: () => list<Pulse>(`/api/pulse`),
    togglePulse: async (id, active) => {
      await http.put<void>(`/api/pulse/${id}`, { active })
    },
    runQuery: (databaseId, sql) =>
      http.post<QueryResult>(`/api/dataset`, {
        database: databaseId,
        type: 'native',
        native: { query: sql },
      }),
    ...build51(http, list),
  }
}

/**
 * Highest row a new dashcard can start on: one below everything already
 * placed on the target tab.
 */
export function nextFreeRow(dashcards: Pick<MbDashcard, 'row' | 'size_y' | 'dashboard_tab_id'>[], tabId?: number | null): number {
  return dashcards
    .filter((d) => tabId == null || d.dashboard_tab_id == null || d.dashboard_tab_id === tabId)
    .reduce((m, d) => Math.max(m, (d.row ?? 0) + (d.size_y ?? 0)), 0)
}

/** Metabase 0.47 renamed a dashboard's `ordered_cards` / `cards` to `dashcards`. */
export function normalizeDashboard(raw: unknown): MbDashboardDetail {
  const d = (raw ?? {}) as MbDashboardDetail & { ordered_cards?: MbDashcard[]; cards?: MbDashcard[] }
  const dashcards = Array.isArray(d.dashcards) ? d.dashcards : Array.isArray(d.ordered_cards) ? d.ordered_cards : Array.isArray(d.cards) ? d.cards : []
  return { ...d, dashcards, tabs: Array.isArray(d.tabs) ? d.tabs : [], parameters: Array.isArray(d.parameters) ? d.parameters : [] }
}

/** Recent views across the three response shapes Metabase has used. */
export function normalizeRecents(raw: unknown): MbRecentItem[] {
  const r = raw as { recents?: unknown; recent_views?: unknown } | unknown[] | null
  const arr = Array.isArray(r) ? r : Array.isArray(r?.recents) ? r.recents : Array.isArray(r?.recent_views) ? r.recent_views : []
  return (arr as Array<Record<string, unknown>>).map((x) => {
    const model = String(x.model ?? '')
    const inner = (x.model_object ?? {}) as Record<string, unknown>
    return {
      model,
      id: Number(x.id ?? x.model_id ?? inner.id),
      name: String(x.name ?? inner.name ?? ''),
      timestamp: (x.timestamp as string | undefined) ?? (x.max_ts as string | undefined),
      display: (x.display ?? inner.display) as string | undefined,
      moderated_status: (x.moderated_status ?? inner.moderated_status) as string | null | undefined,
    }
  }).filter((x) => Number.isFinite(x.id) && x.name)
}

function build51(http: HttpClient, list: <T>(path: string) => Promise<T[]>) {
  const putDashcards = async (id: number, detail: MbDashboardDetail, extra: Partial<MbDashcard>[]) => {
    const keep = detail.dashcards.map((dc) => ({
      id: dc.id,
      card_id: dc.card_id,
      dashboard_tab_id: dc.dashboard_tab_id ?? null,
      row: dc.row,
      col: dc.col,
      size_x: dc.size_x,
      size_y: dc.size_y,
      parameter_mappings: dc.parameter_mappings ?? [],
      visualization_settings: dc.visualization_settings ?? {},
      series: (dc.series ?? []).map((s) => ({ id: s.id })),
    }))
    const body: Record<string, unknown> = { dashcards: [...keep, ...extra] }
    if (detail.tabs?.length) body.tabs = detail.tabs.map((t) => ({ id: t.id, name: t.name }))
    return normalizeDashboard(await http.put<unknown>(`/api/dashboard/${id}`, body))
  }
  return {
    currentUser: () => http.get<MbCurrentUser>(`/api/user/current`),
    sessionProperties: () => http.get<MbSessionProperties>(`/api/session/properties`),
    collectionTree: () => list<MbCollectionNode>(`/api/collection/tree?exclude-archived=true`),
    search: ({ q, models, collectionId }: { q?: string; models?: string[]; collectionId?: number }) => {
      const qs = new URLSearchParams()
      if (q) qs.set('q', q)
      for (const m of models ?? []) qs.append('models', m)
      if (collectionId != null) qs.set('collection', String(collectionId))
      const s = qs.toString()
      return list<MbSearchItem>(`/api/search${s ? `?${s}` : ''}`)
    },
    listCards: () => list<MbCard>(`/api/card?f=all`),
    getCard: (id: number) => http.get<MbCard>(`/api/card/${id}`),
    runCard: (id: number, parameters: MbParameterValue[] = []) =>
      http.post<MbDataset>(`/api/card/${id}/query`, { parameters, ignore_cache: false }, { timeoutMs: 120_000 }),
    createCard: (card: MbNewCard) => http.post<MbCard>(`/api/card`, card),
    updateCard: (id: number, patch: Partial<MbCard>) => http.put<MbCard>(`/api/card/${id}`, patch),
    archiveCard: async (id: number) => {
      await http.put<unknown>(`/api/card/${id}`, { archived: true })
    },
    getDashboardDetail: async (id: number) => normalizeDashboard(await http.get<unknown>(`/api/dashboard/${id}`)),
    runDashcard: (dashboardId: number, dashcardId: number, cardId: number, parameters: MbParameterValue[] = []) =>
      http.post<MbDataset>(
        `/api/dashboard/${dashboardId}/dashcard/${dashcardId}/card/${cardId}/query`,
        { parameters },
        { timeoutMs: 120_000 },
      ),
    createDashboard: async (input: { name: string; description?: string | null; collection_id: number | null }) =>
      normalizeDashboard(await http.post<unknown>(`/api/dashboard`, input)),
    addCardToDashboard: async (dashboardId: number, cardId: number, opts: { tabId?: number | null; sizeX?: number; sizeY?: number } = {}) => {
      const detail = normalizeDashboard(await http.get<unknown>(`/api/dashboard/${dashboardId}`))
      const tabId = opts.tabId ?? detail.tabs?.[0]?.id ?? null
      return putDashcards(dashboardId, detail, [{
        id: -1,
        card_id: cardId,
        dashboard_tab_id: tabId,
        row: nextFreeRow(detail.dashcards, tabId),
        col: 0,
        size_x: opts.sizeX ?? 12,
        size_y: opts.sizeY ?? 6,
        parameter_mappings: [],
        visualization_settings: {},
        series: [],
      }])
    },
    parameterValues: async (dashboardId: number, parameterId: string) => {
      const r = await http.get<{ values?: unknown[] }>(`/api/dashboard/${dashboardId}/params/${encodeURIComponent(parameterId)}/values`)
      return (Array.isArray(r?.values) ? r.values : []).map((v) => (Array.isArray(v) ? String(v[0]) : String(v)))
    },
    listBookmarks: () => list<MbBookmark>(`/api/bookmark`),
    setBookmark: async (type: 'card' | 'dashboard' | 'collection', id: number, on: boolean) => {
      if (on) await http.post<unknown>(`/api/bookmark/${type}/${id}`)
      else await http.delete<unknown>(`/api/bookmark/${type}/${id}`)
    },
    recentViews: async () => {
      try {
        return normalizeRecents(await http.get<unknown>(`/api/activity/recents?context=views`))
      } catch {
        // Metabase < 0.50 only has the older endpoint.
        return normalizeRecents(await http.get<unknown>(`/api/activity/recent_views`))
      }
    },
    runNative: (
      databaseId: number,
      sql: string,
      opts: { templateTags?: Record<string, MbTemplateTag>; parameters?: MbParameterValue[] } = {},
    ) =>
      http.post<MbDataset>(
        `/api/dataset`,
        {
          database: databaseId,
          type: 'native',
          native: { query: sql, 'template-tags': opts.templateTags ?? {} },
          parameters: opts.parameters ?? [],
        },
        { timeoutMs: 180_000 },
      ),
    listDatabasesFull: () => list<MbDatabase>(`/api/database?include=tables`),
    databaseMetadata: (id: number) => http.get<MbDatabaseMetadata>(`/api/database/${id}/metadata`),
    syncSchema: async (id: number) => {
      await http.post<unknown>(`/api/database/${id}/sync_schema`)
    },
    rescanValues: async (id: number) => {
      await http.post<unknown>(`/api/database/${id}/rescan_values`)
    },
    databaseHealth: (id: number) => http.get<{ status: string; message?: string }>(`/api/database/${id}/healthcheck`),
    updateTable: (id: number, patch: Pick<Partial<MbTable>, 'description' | 'display_name'>) => http.put<MbTable>(`/api/table/${id}`, patch),
    updateField: (id: number, patch: Pick<Partial<MbField>, 'description' | 'semantic_type' | 'display_name'>) =>
      http.put<MbField>(`/api/field/${id}`, patch),
    listSubscriptions: () => list<MbPulse>(`/api/pulse?archived=false`),
    createSubscription: (input: MbPulseInput) => http.post<MbPulse>(`/api/pulse`, input),
    updateSubscription: (id: number, patch: Partial<MbPulseInput> & { archived?: boolean }) => http.put<MbPulse>(`/api/pulse/${id}`, patch),
    testSubscription: async (input: MbPulseInput) => {
      await http.post<unknown>(`/api/pulse/test`, input, { timeoutMs: 120_000 })
    },
    pulseFormInput: () => http.get<MbPulseFormInput>(`/api/pulse/form_input`),
    listAlerts: () => list<MbAlert>(`/api/alert`),
    createAlert: (input: MbAlertInput) => http.post<MbAlert>(`/api/alert`, input),
    updateAlert: (id: number, patch: Partial<MbAlertInput> & { archived?: boolean }) => http.put<MbAlert>(`/api/alert/${id}`, patch),
    listUsers: () => list<MbUserRef>(`/api/user?status=active`),
    listSnippets: () => list<MbSnippet>(`/api/native-query-snippet?archived=false`),
    createSnippet: (input: { name: string; content: string; description?: string }) =>
      http.post<MbSnippet>(`/api/native-query-snippet`, input),
  }
}

/* ─────────── stub data ─────────── */

const ts = '2026-04-25T18:14:00Z'

const STUB_DATABASES: Database[] = [
  {
    id: 1,
    name: 'snowflake-warehouse',
    engine: 'snowflake',
    schema_count: 8,
    table_count: 142,
    description: 'Production warehouse — billing, product, marketing.',
  },
  {
    id: 2,
    name: 'bigquery-analytics',
    engine: 'bigquery',
    schema_count: 4,
    table_count: 86,
    description: 'Mixpanel + segment events landing zone.',
  },
  {
    id: 3,
    name: 'postgres-warehouse',
    engine: 'postgres',
    schema_count: 3,
    table_count: 24,
    description: 'Read-replica of OLTP — reporting only.',
  },
  {
    id: 4,
    name: 'sample-database',
    engine: 'h2',
    is_sample: true,
    schema_count: 1,
    table_count: 6,
  },
]

const STUB_COLLECTIONS: Collection[] = [
  { id: 1, name: 'Revenue', slug: 'revenue', description: 'MRR, ARR, churn, expansion.', color: 'emerald' },
  { id: 2, name: 'Product', slug: 'product', description: 'DAU, MAU, retention, feature adoption.', color: 'brand' },
  { id: 3, name: 'Operations', slug: 'operations', description: 'SLA, deploy frequency, incidents.', color: 'amber' },
  { id: 4, name: 'Customer Success', slug: 'customer-success', description: 'NPS, support volume, churn risk.', color: 'violet' },
]

function ts2(daysAgo: number) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString()
}
function gen(seed: number, count: number, min: number, max: number, trend: 'up' | 'down' | 'flat' = 'up') {
  let s = seed
  const span = max - min
  const trendStep = trend === 'up' ? span * 0.4 : trend === 'down' ? -span * 0.4 : 0
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    s = (s * 9301 + 49297) % 233280
    const r = s / 233280
    const wave = Math.sin((i / count) * Math.PI * 2) * span * 0.18
    const baseline = min + span * 0.5 + (trendStep * i) / count
    out.push(Math.max(min, Math.min(max, baseline + wave + (r - 0.5) * span * 0.4)))
  }
  return out
}

const TREND_LABELS = (() => {
  const out: string[] = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    out.push(`${d.getMonth() + 1}/${d.getDate()}`)
  }
  return out
})()

function mkSeriesResult(label: string, values: number[]): import('zod').infer<typeof QueryResultSchema> {
  return {
    cols: [
      { name: 'date', display_name: 'Date', base_type: 'type/Date' },
      { name: label, display_name: label, base_type: 'type/Float' },
    ],
    rows: TREND_LABELS.map((d, i) => [d, Math.round(values[i] ?? 0)]),
    row_count: values.length,
    status: 'completed',
    running_time_ms: 184,
  }
}

const STUB_QUESTIONS: Question[] = [
  {
    id: 101,
    name: 'Monthly recurring revenue',
    description: 'Sum of subscription line items, gross of refunds.',
    collection_id: 1,
    display: 'scalar',
    database_id: 1,
    sql: 'SELECT SUM(amount) AS mrr FROM finance.subscriptions WHERE active',
    scalar: 248_412,
    scalar_unit: 'USD',
    scalar_delta: 0.062,
    created_at: ts2(120),
    updated_at: ts,
    view_count: 412,
  },
  {
    id: 102,
    name: 'New paying customers · 14d',
    collection_id: 1,
    display: 'line',
    database_id: 1,
    sql: 'SELECT day, COUNT(*) FROM finance.first_payments WHERE day > current_date - 14 GROUP BY day',
    result: mkSeriesResult('count', gen(7, 14, 6, 28, 'up')),
    created_at: ts2(60),
    updated_at: ts,
    view_count: 211,
    scalar: 188,
  },
  {
    id: 103,
    name: 'Net revenue retention',
    description: 'Cohort revenue this month / cohort revenue 12m ago.',
    collection_id: 1,
    display: 'gauge',
    database_id: 1,
    scalar: 1.124,
    scalar_unit: '×',
    scalar_delta: 0.018,
    created_at: ts2(80),
    updated_at: ts,
    view_count: 96,
  },
  {
    id: 104,
    name: 'Daily active users',
    collection_id: 2,
    display: 'area',
    database_id: 2,
    sql: 'SELECT day, count(distinct user_id) FROM events.pageviews GROUP BY day',
    result: mkSeriesResult('dau', gen(11, 14, 1200, 2400, 'up')),
    created_at: ts2(140),
    updated_at: ts,
    view_count: 922,
    scalar: 2284,
    scalar_delta: 0.072,
  },
  {
    id: 105,
    name: 'Activation rate',
    description: '% signups who reach first project + first deploy in 7d.',
    collection_id: 2,
    display: 'progress',
    database_id: 2,
    scalar: 0.418,
    scalar_unit: '%',
    scalar_delta: 0.024,
    created_at: ts2(40),
    updated_at: ts,
    view_count: 188,
  },
  {
    id: 106,
    name: 'Top events · 24h',
    collection_id: 2,
    display: 'bar',
    database_id: 2,
    sql: 'SELECT event, count(*) FROM events.all WHERE day = current_date GROUP BY event ORDER BY 2 DESC LIMIT 8',
    result: {
      cols: [
        { name: 'event', display_name: 'Event', base_type: 'type/Text' },
        { name: 'count', display_name: 'Count', base_type: 'type/Integer' },
      ],
      rows: [
        ['$pageview', 4321],
        ['workspace.started', 1240],
        ['project.created', 612],
        ['rollout.promoted', 388],
        ['wireframe.saved', 240],
        ['pr.opened', 184],
        ['diagram.exported', 122],
        ['feature_flag.evaluated', 88],
      ],
      row_count: 8,
      status: 'completed',
      running_time_ms: 76,
    },
    created_at: ts2(30),
    updated_at: ts,
    view_count: 144,
  },
  {
    id: 107,
    name: 'Deploy frequency · 14d',
    collection_id: 3,
    display: 'line',
    database_id: 3,
    sql: 'SELECT day, count(*) FROM ops.deployments WHERE day > current_date - 14 GROUP BY day',
    result: mkSeriesResult('deploys', gen(13, 14, 4, 28, 'up')),
    created_at: ts2(20),
    updated_at: ts,
    view_count: 81,
    scalar: 12,
  },
  {
    id: 108,
    name: 'Mean time to restore (MTTR)',
    collection_id: 3,
    display: 'scalar',
    database_id: 3,
    scalar: 38,
    scalar_unit: 'min',
    scalar_delta: -0.18,
    created_at: ts2(50),
    updated_at: ts,
    view_count: 64,
  },
  {
    id: 109,
    name: 'NPS distribution',
    collection_id: 4,
    display: 'pie',
    database_id: 1,
    result: {
      cols: [
        { name: 'bucket', display_name: 'Bucket' },
        { name: 'count', display_name: 'Count' },
      ],
      rows: [
        ['promoter', 642],
        ['passive', 320],
        ['detractor', 88],
      ],
      row_count: 3,
      status: 'completed',
      running_time_ms: 42,
    },
    created_at: ts2(15),
    updated_at: ts,
    view_count: 52,
  },
  {
    id: 110,
    name: 'Churn risk cohort size',
    collection_id: 4,
    display: 'scalar',
    database_id: 1,
    scalar: 6,
    scalar_unit: 'accounts',
    scalar_delta: 0.5,
    created_at: ts2(10),
    updated_at: ts,
    view_count: 28,
  },
  {
    id: 111,
    name: 'Recent invoices',
    collection_id: 1,
    display: 'table',
    database_id: 1,
    sql: 'SELECT invoice_id, customer, amount, status FROM finance.invoices ORDER BY created_at DESC LIMIT 10',
    result: {
      cols: [
        { name: 'invoice_id', display_name: 'ID' },
        { name: 'customer', display_name: 'Customer' },
        { name: 'amount', display_name: 'Amount' },
        { name: 'status', display_name: 'Status' },
      ],
      rows: [
        ['INV-4012', 'Default Org · enterprise', 14_200, 'paid'],
        ['INV-4011', 'Globex · team', 3_400, 'paid'],
        ['INV-4010', 'Initech · enterprise', 28_800, 'open'],
        ['INV-4009', 'Stark Industries · team', 4_100, 'paid'],
        ['INV-4008', 'Wayne Enterprises · enterprise', 22_400, 'paid'],
        ['INV-4007', 'Soylent · team', 1_200, 'overdue'],
      ],
      row_count: 6,
      status: 'completed',
      running_time_ms: 98,
    },
    created_at: ts2(5),
    updated_at: ts,
    view_count: 21,
  },
]

const STUB_DASHBOARDS: Dashboard[] = [
  {
    id: 1,
    name: 'Revenue overview',
    description: 'Top-line MRR, NRR, paying customers — refreshed hourly.',
    collection_id: 1,
    cards: [
      { id: 1, card_id: 101, col: 0, row: 0, size_x: 4, size_y: 2 },
      { id: 2, card_id: 103, col: 4, row: 0, size_x: 4, size_y: 2 },
      { id: 3, card_id: 110, col: 8, row: 0, size_x: 4, size_y: 2 },
      { id: 4, card_id: 102, col: 0, row: 2, size_x: 8, size_y: 4 },
      { id: 5, card_id: 109, col: 8, row: 2, size_x: 4, size_y: 4 },
      { id: 6, card_id: 111, col: 0, row: 6, size_x: 12, size_y: 4 },
    ],
    created_at: ts2(120),
    updated_at: ts,
    view_count: 184,
  },
  {
    id: 2,
    name: 'Product engagement',
    description: 'DAU, activation, top events.',
    collection_id: 2,
    cards: [
      { id: 7, card_id: 104, col: 0, row: 0, size_x: 8, size_y: 4 },
      { id: 8, card_id: 105, col: 8, row: 0, size_x: 4, size_y: 2 },
      { id: 9, card_id: 106, col: 0, row: 4, size_x: 12, size_y: 4 },
    ],
    created_at: ts2(80),
    updated_at: ts,
    view_count: 122,
  },
  {
    id: 3,
    name: 'Engineering performance',
    description: 'DORA-style metrics — frequency, MTTR.',
    collection_id: 3,
    cards: [
      { id: 10, card_id: 107, col: 0, row: 0, size_x: 8, size_y: 4 },
      { id: 11, card_id: 108, col: 8, row: 0, size_x: 4, size_y: 2 },
    ],
    created_at: ts2(50),
    updated_at: ts,
    view_count: 88,
  },
]

const STUB_PULSES: Pulse[] = [
  {
    id: 1,
    name: 'MRR daily digest',
    description: '08:00 IST email with MRR + WoW delta.',
    card_ids: [101, 102],
    channels: [
      { channel_type: 'email', schedule: 'daily 08:00 IST', recipients: ['leads@adhar.dev', 'finance@adhar.dev'] },
    ],
    active: true,
    last_run_at: ts2(0.04),
    created_at: ts2(80),
  },
  {
    id: 2,
    name: 'DAU drop alert',
    description: 'Alert if DAU < 1500 for 2 consecutive days.',
    card_ids: [104],
    channels: [{ channel_type: 'slack', schedule: 'realtime', recipients: ['#growth'] }],
    alert_condition: 'goal',
    alert_above_goal: false,
    goal: 1500,
    active: true,
    last_run_at: ts2(0.2),
    created_at: ts2(40),
  },
  {
    id: 3,
    name: 'NPS weekly recap',
    card_ids: [109],
    channels: [{ channel_type: 'email', schedule: 'monday 09:00 IST', recipients: ['leads@adhar.dev'] }],
    active: true,
    last_run_at: ts2(2),
    created_at: ts2(15),
  },
  {
    id: 4,
    name: 'MTTR > 60 minutes',
    card_ids: [108],
    channels: [{ channel_type: 'slack', schedule: 'realtime', recipients: ['#oncall'] }],
    alert_condition: 'goal',
    alert_above_goal: true,
    goal: 60,
    active: false,
    created_at: ts2(20),
  },
]

/**
 * In-memory 0.51-shaped stub, derived from the legacy stub data above so the
 * two never disagree. Offline / tests only — the console is real by default.
 */
function stub51(runQuery: (db: number, sql: string) => Promise<QueryResult>) {
  const toDataset = (r?: QueryResult, scalar?: number): MbDataset => {
    if (r) {
      return {
        data: { rows: r.rows, cols: r.cols.map((c) => ({ ...c, base_type: c.base_type ?? 'type/Text' })) },
        row_count: r.row_count,
        running_time: r.running_time_ms ?? 0,
        status: r.status,
        error: r.error ?? null,
      }
    }
    return {
      data: { rows: [[scalar ?? null]], cols: [{ name: 'value', display_name: 'Value', base_type: 'type/Float' }] },
      row_count: 1,
      running_time: 12,
      status: 'completed',
    }
  }
  const cards: MbCard[] = STUB_QUESTIONS.map((q) => ({
    id: q.id,
    name: q.name,
    description: q.description ?? null,
    type: 'question',
    display: q.display === 'gauge' || q.display === 'progress' ? q.display : q.display,
    collection_id: q.collection_id ?? null,
    database_id: q.database_id,
    query_type: q.sql ? 'native' : 'query',
    dataset_query: q.sql
      ? { type: 'native', database: q.database_id, native: { query: q.sql, 'template-tags': {} } }
      : { type: 'query', database: q.database_id, query: {} },
    visualization_settings: {},
    view_count: q.view_count,
    created_at: q.created_at,
    updated_at: q.updated_at,
    can_write: true,
    archived: false,
  }))
  const datasetFor = (id: number) => {
    const q = STUB_QUESTIONS.find((x) => x.id === id)
    return toDataset(q?.result, q?.scalar)
  }
  const dashboards: MbDashboardDetail[] = STUB_DASHBOARDS.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description ?? null,
    collection_id: d.collection_id ?? null,
    dashcards: (d.cards ?? []).map((dc) => ({
      id: dc.id,
      card_id: dc.card_id,
      card: cards.find((c) => c.id === dc.card_id) ?? null,
      dashboard_tab_id: null,
      row: dc.row * 2,
      col: dc.col * 2,
      size_x: dc.size_x * 2,
      size_y: dc.size_y * 2,
      parameter_mappings: [],
      visualization_settings: {},
      series: [],
    })),
    tabs: [],
    parameters: [],
    can_write: true,
    view_count: d.view_count,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }))
  const bookmarks: MbBookmark[] = []
  const pulses: MbPulse[] = []
  const alerts: MbAlert[] = []
  const snippets: MbSnippet[] = []
  let seq = 1000
  const findDash = (id: number) => {
    const d = dashboards.find((x) => x.id === id)
    if (!d) throw new Error(`Stub: dashboard ${id} not found`)
    return d
  }
  return {
    currentUser: async (): Promise<MbCurrentUser> => ({ id: 1, email: 'stub@adhar.dev', common_name: 'Stub User', is_superuser: true }),
    sessionProperties: async (): Promise<MbSessionProperties> => ({ version: { tag: 'v0.51.0-stub' }, 'report-timezone-short': 'UTC' }),
    collectionTree: async (): Promise<MbCollectionNode[]> =>
      STUB_COLLECTIONS.map((c) => ({ id: c.id, name: c.name, description: c.description ?? null, children: [], here: ['card', 'dashboard'] })),
    search: async ({ q, models }: { q?: string; models?: string[] }): Promise<MbSearchItem[]> => {
      const f = (q ?? '').toLowerCase()
      const out: MbSearchItem[] = []
      if (!models?.length || models.includes('dashboard')) {
        for (const d of dashboards) {
          out.push({ id: d.id, model: 'dashboard', name: d.name, description: d.description, collection_id: d.collection_id, dashboardcard_count: d.dashcards.length, updated_at: d.updated_at, bookmark: bookmarks.some((b) => b.type === 'dashboard' && b.item_id === d.id) })
        }
      }
      if (!models?.length || models.includes('card')) {
        for (const c of cards) out.push({ id: c.id, model: 'card', name: c.name, description: c.description, collection_id: c.collection_id, display: c.display, updated_at: c.updated_at })
      }
      return out.filter((x) => !f || x.name.toLowerCase().includes(f))
    },
    listCards: async () => cards.filter((c) => !c.archived),
    getCard: async (id: number) => {
      const c = cards.find((x) => x.id === id)
      if (!c) throw new Error(`Stub: card ${id} not found`)
      return c
    },
    runCard: async (id: number) => datasetFor(id),
    createCard: async (card: MbNewCard) => {
      const c: MbCard = { ...card, id: ++seq, can_write: true, created_at: new Date().toISOString() }
      cards.push(c)
      return c
    },
    updateCard: async (id: number, patch: Partial<MbCard>) => {
      const c = cards.find((x) => x.id === id)
      if (!c) throw new Error(`Stub: card ${id} not found`)
      Object.assign(c, patch)
      return c
    },
    archiveCard: async (id: number) => {
      const c = cards.find((x) => x.id === id)
      if (c) c.archived = true
    },
    getDashboardDetail: async (id: number) => findDash(id),
    runDashcard: async (_d: number, _dc: number, cardId: number) => datasetFor(cardId),
    createDashboard: async (input: { name: string; description?: string | null; collection_id: number | null }) => {
      const d: MbDashboardDetail = { id: ++seq, ...input, dashcards: [], tabs: [], parameters: [], can_write: true, created_at: new Date().toISOString() }
      dashboards.push(d)
      return d
    },
    addCardToDashboard: async (dashboardId: number, cardId: number, opts: { tabId?: number | null; sizeX?: number; sizeY?: number } = {}) => {
      const d = findDash(dashboardId)
      d.dashcards.push({
        id: ++seq,
        card_id: cardId,
        card: cards.find((c) => c.id === cardId) ?? null,
        dashboard_tab_id: opts.tabId ?? null,
        row: nextFreeRow(d.dashcards, opts.tabId),
        col: 0,
        size_x: opts.sizeX ?? 12,
        size_y: opts.sizeY ?? 6,
      })
      return d
    },
    parameterValues: async (): Promise<string[]> => [],
    listBookmarks: async () => bookmarks,
    setBookmark: async (type: 'card' | 'dashboard' | 'collection', id: number, on: boolean) => {
      const i = bookmarks.findIndex((b) => b.type === type && b.item_id === id)
      if (on && i < 0) bookmarks.push({ id: `${type}-${id}`, type, item_id: id, name: String(id) })
      if (!on && i >= 0) bookmarks.splice(i, 1)
    },
    recentViews: async (): Promise<MbRecentItem[]> => [],
    runNative: async (databaseId: number, sql: string) => toDataset(await runQuery(databaseId, sql)),
    listDatabasesFull: async (): Promise<MbDatabase[]> =>
      STUB_DATABASES.map((d) => ({ id: d.id, name: d.name, engine: d.engine, description: d.description ?? null, is_sample: d.is_sample, initial_sync_status: 'complete', native_permissions: 'write', tables: [] })),
    databaseMetadata: async (id: number): Promise<MbDatabaseMetadata> => {
      const d = STUB_DATABASES.find((x) => x.id === id)
      if (!d) throw new Error(`Stub: database ${id} not found`)
      return { id: d.id, name: d.name, engine: d.engine, tables: [] }
    },
    syncSchema: async () => {},
    rescanValues: async () => {},
    databaseHealth: async () => ({ status: 'ok' }),
    updateTable: async (id: number, patch: Pick<Partial<MbTable>, 'description' | 'display_name'>): Promise<MbTable> => ({ id, name: String(id), ...patch }),
    updateField: async (id: number, patch: Pick<Partial<MbField>, 'description' | 'semantic_type' | 'display_name'>): Promise<MbField> => ({ id, name: String(id), ...patch }),
    listSubscriptions: async () => pulses.filter((p) => !p.archived),
    createSubscription: async (input: MbPulseInput) => {
      const p: MbPulse = { ...input, id: ++seq, created_at: new Date().toISOString() }
      pulses.push(p)
      return p
    },
    updateSubscription: async (id: number, patch: Partial<MbPulseInput> & { archived?: boolean }) => {
      const p = pulses.find((x) => x.id === id)
      if (!p) throw new Error(`Stub: subscription ${id} not found`)
      Object.assign(p, patch)
      return p
    },
    testSubscription: async () => {},
    pulseFormInput: async (): Promise<MbPulseFormInput> => ({ channels: { email: { configured: true }, slack: { configured: false } } }),
    listAlerts: async () => alerts.filter((a) => !a.archived),
    createAlert: async (input: MbAlertInput) => {
      const a: MbAlert = { ...input, id: ++seq, card: { ...input.card, name: cards.find((c) => c.id === input.card.id)?.name } }
      alerts.push(a)
      return a
    },
    updateAlert: async (id: number, patch: Partial<MbAlertInput> & { archived?: boolean }) => {
      const a = alerts.find((x) => x.id === id)
      if (!a) throw new Error(`Stub: alert ${id} not found`)
      Object.assign(a, patch, patch.card ? { card: { ...a.card, ...patch.card } } : {})
      return a
    },
    listUsers: async (): Promise<MbUserRef[]> => [{ id: 1, email: 'stub@adhar.dev', common_name: 'Stub User' }],
    listSnippets: async () => snippets,
    createSnippet: async (input: { name: string; content: string; description?: string }) => {
      const sn: MbSnippet = { id: ++seq, ...input }
      snippets.push(sn)
      return sn
    },
  }
}

export const MetabaseClient = defineClient<MetabaseClient>(build, () => {
  const pulses = STUB_PULSES.slice()
  const legacy = stubLegacy(pulses)
  return { ...legacy, ...stub51(legacy.runQuery) }
})

function stubLegacy(pulses: Pulse[]) {
  return {
    listDatabases: async () => STUB_DATABASES,
    listCollections: async () => STUB_COLLECTIONS,
    listQuestions: async (filter) =>
      filter?.collectionId
        ? STUB_QUESTIONS.filter((q) => q.collection_id === filter.collectionId)
        : STUB_QUESTIONS,
    getQuestion: async (id) => {
      const q = STUB_QUESTIONS.find((x) => x.id === id)
      if (!q) throw new Error(`Stub: question ${id} not found`)
      return q
    },
    listDashboards: async () => STUB_DASHBOARDS,
    getDashboard: async (id) => {
      const dashboard = STUB_DASHBOARDS.find((d) => d.id === id)
      if (!dashboard) throw new Error(`Stub: dashboard ${id} not found`)
      const cards = (dashboard.cards ?? [])
        .map((dc) => STUB_QUESTIONS.find((q) => q.id === dc.card_id))
        .filter((q): q is Question => !!q)
      return { dashboard, cards }
    },
    listPulses: async () => pulses,
    togglePulse: async (id, active) => {
      const p = pulses.find((x) => x.id === id)
      if (p) p.active = active
    },
    runQuery: async (_databaseId, sql) => {
      const start = Date.now()
      // Quick-and-dirty pattern matching for the demo.
      const lower = sql.toLowerCase()
      if (lower.includes('select') && lower.includes('count') && lower.includes('group by')) {
        return {
          cols: [
            { name: 'bucket', display_name: 'Bucket' },
            { name: 'count', display_name: 'Count' },
          ],
          rows: [
            ['enterprise', 28],
            ['team', 124],
            ['trial', 88],
          ],
          row_count: 3,
          status: 'completed',
          running_time_ms: Date.now() - start,
        }
      }
      if (lower.includes('show tables') || lower.includes('information_schema')) {
        return {
          cols: [{ name: 'table_name', display_name: 'Table' }],
          rows: [
            ['finance.subscriptions'],
            ['finance.invoices'],
            ['finance.first_payments'],
            ['events.all'],
            ['events.pageviews'],
            ['ops.deployments'],
            ['ops.incidents'],
          ],
          row_count: 7,
          status: 'completed',
          running_time_ms: Date.now() - start,
        }
      }
      if (lower.startsWith('select') && lower.includes('limit')) {
        return {
          cols: [
            { name: 'id', display_name: 'ID' },
            { name: 'name', display_name: 'Name' },
            { name: 'value', display_name: 'Value' },
          ],
          rows: Array.from({ length: 5 }).map((_, i) => [
            `row-${i + 1}`,
            `Sample row ${i + 1}`,
            Math.round(Math.random() * 1000),
          ]),
          row_count: 5,
          status: 'completed',
          running_time_ms: Date.now() - start,
        }
      }
      if (lower.startsWith('select')) {
        return {
          cols: [{ name: 'result', display_name: 'Result' }],
          rows: [['ok']],
          row_count: 1,
          status: 'completed',
          running_time_ms: Date.now() - start,
        }
      }
      return {
        cols: [],
        rows: [],
        row_count: 0,
        status: 'failed',
        error: 'Stub: only SELECT statements are supported in dev.',
        running_time_ms: Date.now() - start,
      }
    },
  } satisfies Omit<MetabaseClient, keyof ReturnType<typeof stub51>>
}
