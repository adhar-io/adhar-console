import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

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
  cards: z.array(DashboardCardSchema),
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
}

function build(http: HttpClient): MetabaseClient {
  return {
    listDatabases: () => http.get<Database[]>(`/api/database`),
    listCollections: () => http.get<Collection[]>(`/api/collection`),
    listQuestions: async (filter) => {
      const qs = filter?.collectionId ? `?collection=${filter.collectionId}` : ''
      const res = await http.get<Question[]>(`/api/card${qs}`)
      return res
    },
    getQuestion: (id) => http.get<Question>(`/api/card/${id}`),
    listDashboards: () => http.get<Dashboard[]>(`/api/dashboard`),
    getDashboard: async (id) => {
      const dashboard = await http.get<Dashboard>(`/api/dashboard/${id}`)
      const cards = await Promise.all(dashboard.cards.map((dc) => http.get<Question>(`/api/card/${dc.card_id}`)))
      return { dashboard, cards }
    },
    listPulses: () => http.get<Pulse[]>(`/api/pulse`),
    togglePulse: async (id, active) => {
      await http.put<void>(`/api/pulse/${id}`, { active })
    },
    runQuery: (databaseId, sql) =>
      http.post<QueryResult>(`/api/dataset`, {
        database: databaseId,
        type: 'native',
        native: { query: sql },
      }),
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
        ['INV-4012', 'Acme · enterprise', 14_200, 'paid'],
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

export const MetabaseClient = defineClient<MetabaseClient>(build, () => {
  const pulses = STUB_PULSES.slice()
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
      const cards = dashboard.cards
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
  }
})
