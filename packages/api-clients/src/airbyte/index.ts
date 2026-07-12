import { z } from 'zod'
import { defineClient, HttpClient } from '../base/index.ts'

/**
 * Airbyte data-pipeline client.
 *
 * Surfaces sources, destinations, connections (a source × destination pair
 * with sync schedule), and job history. Scoped to one Airbyte workspace.
 */

export const ConnectorTypeSchema = z.enum(['source', 'destination'])
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>

export const ConnectionStatusSchema = z.enum(['active', 'inactive', 'deprecated'])
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>

export const JobStatusSchema = z.enum([
  'pending',
  'running',
  'incomplete',
  'failed',
  'succeeded',
  'cancelled',
])
export type JobStatus = z.infer<typeof JobStatusSchema>

export const JobTypeSchema = z.enum(['sync', 'reset_connection', 'check_connection'])
export type JobType = z.infer<typeof JobTypeSchema>

export const SourceSchema = z.object({
  source_id: z.string(),
  name: z.string(),
  source_type: z.string(),
  connection_status: z.enum(['succeeded', 'failed']).optional(),
  workspace_id: z.string().optional(),
  icon: z.string().optional(),
  /** Synthetic — derived from connections. */
  connections: z.number().optional(),
})
export type Source = z.infer<typeof SourceSchema>

export const DestinationSchema = z.object({
  destination_id: z.string(),
  name: z.string(),
  destination_type: z.string(),
  connection_status: z.enum(['succeeded', 'failed']).optional(),
  workspace_id: z.string().optional(),
  icon: z.string().optional(),
  connections: z.number().optional(),
})
export type Destination = z.infer<typeof DestinationSchema>

export const ConnectionSchema = z.object({
  connection_id: z.string(),
  name: z.string(),
  source_id: z.string(),
  source_name: z.string(),
  source_type: z.string(),
  destination_id: z.string(),
  destination_name: z.string(),
  destination_type: z.string(),
  status: ConnectionStatusSchema,
  schedule: z.object({
    units: z.number().optional(),
    time_unit: z.enum(['minutes', 'hours', 'days', 'weeks', 'months']).optional(),
    cron_expression: z.string().optional(),
  }).optional(),
  schedule_type: z.enum(['manual', 'basic', 'cron']).optional(),
  /** Sync mode summary, e.g. "incremental | dedup". */
  sync_mode: z.string().optional(),
  streams_count: z.number(),
  last_sync_started_at: z.string().optional(),
  last_sync_finished_at: z.string().optional(),
  last_sync_status: JobStatusSchema.optional(),
  last_sync_records: z.number().optional(),
  last_sync_bytes: z.number().optional(),
  last_sync_duration_s: z.number().optional(),
  next_sync_at: z.string().optional(),
})
export type Connection = z.infer<typeof ConnectionSchema>

export const JobSchema = z.object({
  job_id: z.string(),
  connection_id: z.string(),
  connection_name: z.string(),
  job_type: JobTypeSchema,
  status: JobStatusSchema,
  created_at: z.string(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  duration_s: z.number().optional(),
  records_emitted: z.number().optional(),
  bytes_emitted: z.number().optional(),
  failure_message: z.string().optional(),
})
export type Job = z.infer<typeof JobSchema>

export interface AirbyteClient {
  listSources(): Promise<Source[]>
  listDestinations(): Promise<Destination[]>
  listConnections(): Promise<Connection[]>
  getConnection(id: string): Promise<Connection>
  listJobs(filter?: { connectionId?: string; status?: JobStatus; limit?: number }): Promise<Job[]>
  triggerSync(connectionId: string): Promise<void>
  toggleConnection(connectionId: string, active: boolean): Promise<void>
}

function build(http: HttpClient): AirbyteClient {
  return {
    listSources: async () => {
      const res = await http.post<{ sources: Source[] }>(`/api/v1/sources/list`, {})
      return res.sources
    },
    listDestinations: async () => {
      const res = await http.post<{ destinations: Destination[] }>(`/api/v1/destinations/list`, {})
      return res.destinations
    },
    listConnections: async () => {
      const res = await http.post<{ connections: Connection[] }>(`/api/v1/connections/list`, {})
      return res.connections
    },
    getConnection: async (id) =>
      http.post<Connection>(`/api/v1/connections/get`, { connectionId: id }),
    listJobs: async (filter) => {
      const res = await http.post<{ jobs: Job[] }>(`/api/v1/jobs/list`, {
        configId: filter?.connectionId,
        configTypes: ['sync'],
        pagination: { rowOffset: 0, pageSize: filter?.limit ?? 50 },
      })
      return res.jobs
    },
    triggerSync: async (connectionId) => {
      await http.post<void>(`/api/v1/connections/sync`, { connectionId })
    },
    toggleConnection: async (connectionId, active) => {
      await http.post<void>(`/api/v1/connections/update`, {
        connectionId,
        status: active ? 'active' : 'inactive',
      })
    },
  }
}

/* ─────────── stub data ─────────── */

const now = Date.now()
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString()
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString()
const minutesFromNow = (m: number) => new Date(now + m * 60_000).toISOString()

const STUB_SOURCES: Source[] = [
  {
    source_id: 'src-pg-billing',
    name: 'billing-postgres',
    source_type: 'Postgres',
    connection_status: 'succeeded',
    icon: '🐘',
    connections: 2,
  },
  {
    source_id: 'src-stripe',
    name: 'stripe-prod',
    source_type: 'Stripe',
    connection_status: 'succeeded',
    icon: '💳',
    connections: 1,
  },
  {
    source_id: 'src-mixpanel',
    name: 'mixpanel-product',
    source_type: 'Mixpanel',
    connection_status: 'succeeded',
    icon: '📊',
    connections: 1,
  },
  {
    source_id: 'src-salesforce',
    name: 'salesforce-revenue',
    source_type: 'Salesforce',
    connection_status: 'failed',
    icon: '☁️',
    connections: 1,
  },
  {
    source_id: 'src-gitea',
    name: 'gitea-events',
    source_type: 'HTTP API',
    connection_status: 'succeeded',
    icon: '🦊',
    connections: 1,
  },
  {
    source_id: 'src-segment',
    name: 'segment-prod',
    source_type: 'Segment',
    connection_status: 'succeeded',
    icon: '🟢',
    connections: 1,
  },
]

const STUB_DESTINATIONS: Destination[] = [
  {
    destination_id: 'dest-snowflake',
    name: 'snowflake-warehouse',
    destination_type: 'Snowflake',
    connection_status: 'succeeded',
    icon: '❄️',
    connections: 4,
  },
  {
    destination_id: 'dest-bigquery',
    name: 'bigquery-analytics',
    destination_type: 'BigQuery',
    connection_status: 'succeeded',
    icon: '☁️',
    connections: 2,
  },
  {
    destination_id: 'dest-postgres-dw',
    name: 'postgres-warehouse',
    destination_type: 'Postgres',
    connection_status: 'succeeded',
    icon: '🐘',
    connections: 1,
  },
  {
    destination_id: 'dest-s3-data-lake',
    name: 's3-raw-lake',
    destination_type: 'S3',
    connection_status: 'succeeded',
    icon: '🪣',
    connections: 1,
  },
]

const STUB_CONNECTIONS: Connection[] = [
  {
    connection_id: 'conn-billing-snowflake',
    name: 'billing-postgres → snowflake',
    source_id: 'src-pg-billing',
    source_name: 'billing-postgres',
    source_type: 'Postgres',
    destination_id: 'dest-snowflake',
    destination_name: 'snowflake-warehouse',
    destination_type: 'Snowflake',
    status: 'active',
    schedule_type: 'basic',
    schedule: { units: 1, time_unit: 'hours' },
    sync_mode: 'incremental | append + dedup',
    streams_count: 14,
    last_sync_started_at: minutesAgo(38),
    last_sync_finished_at: minutesAgo(35),
    last_sync_status: 'succeeded',
    last_sync_records: 124_320,
    last_sync_bytes: 78_212_400,
    last_sync_duration_s: 168,
    next_sync_at: minutesFromNow(22),
  },
  {
    connection_id: 'conn-stripe-snowflake',
    name: 'stripe → snowflake',
    source_id: 'src-stripe',
    source_name: 'stripe-prod',
    source_type: 'Stripe',
    destination_id: 'dest-snowflake',
    destination_name: 'snowflake-warehouse',
    destination_type: 'Snowflake',
    status: 'active',
    schedule_type: 'basic',
    schedule: { units: 6, time_unit: 'hours' },
    sync_mode: 'incremental | append',
    streams_count: 9,
    last_sync_started_at: hoursAgo(2),
    last_sync_finished_at: hoursAgo(2),
    last_sync_status: 'succeeded',
    last_sync_records: 8_412,
    last_sync_bytes: 12_482_000,
    last_sync_duration_s: 84,
    next_sync_at: hoursAgo(-4),
  },
  {
    connection_id: 'conn-mixpanel-bigquery',
    name: 'mixpanel → bigquery',
    source_id: 'src-mixpanel',
    source_name: 'mixpanel-product',
    source_type: 'Mixpanel',
    destination_id: 'dest-bigquery',
    destination_name: 'bigquery-analytics',
    destination_type: 'BigQuery',
    status: 'active',
    schedule_type: 'cron',
    schedule: { cron_expression: '0 */4 * * *' },
    sync_mode: 'incremental | dedup',
    streams_count: 6,
    last_sync_started_at: minutesAgo(12),
    last_sync_status: 'running',
    last_sync_records: 45_123,
    last_sync_bytes: 23_409_120,
  },
  {
    connection_id: 'conn-salesforce-snowflake',
    name: 'salesforce → snowflake',
    source_id: 'src-salesforce',
    source_name: 'salesforce-revenue',
    source_type: 'Salesforce',
    destination_id: 'dest-snowflake',
    destination_name: 'snowflake-warehouse',
    destination_type: 'Snowflake',
    status: 'active',
    schedule_type: 'basic',
    schedule: { units: 24, time_unit: 'hours' },
    sync_mode: 'incremental | append + dedup',
    streams_count: 22,
    last_sync_started_at: hoursAgo(8),
    last_sync_finished_at: hoursAgo(7),
    last_sync_status: 'failed',
    last_sync_records: 12_840,
    last_sync_bytes: 8_220_400,
    last_sync_duration_s: 3_140,
    next_sync_at: hoursAgo(-16),
  },
  {
    connection_id: 'conn-gitea-bigquery',
    name: 'gitea-events → bigquery',
    source_id: 'src-gitea',
    source_name: 'gitea-events',
    source_type: 'HTTP API',
    destination_id: 'dest-bigquery',
    destination_name: 'bigquery-analytics',
    destination_type: 'BigQuery',
    status: 'active',
    schedule_type: 'basic',
    schedule: { units: 30, time_unit: 'minutes' },
    sync_mode: 'incremental | append',
    streams_count: 4,
    last_sync_started_at: minutesAgo(8),
    last_sync_finished_at: minutesAgo(7),
    last_sync_status: 'succeeded',
    last_sync_records: 1_203,
    last_sync_bytes: 412_300,
    last_sync_duration_s: 28,
    next_sync_at: minutesFromNow(22),
  },
  {
    connection_id: 'conn-segment-s3',
    name: 'segment → s3-raw-lake',
    source_id: 'src-segment',
    source_name: 'segment-prod',
    source_type: 'Segment',
    destination_id: 'dest-s3-data-lake',
    destination_name: 's3-raw-lake',
    destination_type: 'S3',
    status: 'active',
    schedule_type: 'cron',
    schedule: { cron_expression: '*/15 * * * *' },
    sync_mode: 'full refresh | overwrite',
    streams_count: 18,
    last_sync_started_at: minutesAgo(4),
    last_sync_finished_at: minutesAgo(3),
    last_sync_status: 'succeeded',
    last_sync_records: 384_120,
    last_sync_bytes: 142_300_000,
    last_sync_duration_s: 41,
    next_sync_at: minutesFromNow(11),
  },
  {
    connection_id: 'conn-billing-postgres-dw',
    name: 'billing-postgres → postgres-warehouse',
    source_id: 'src-pg-billing',
    source_name: 'billing-postgres',
    source_type: 'Postgres',
    destination_id: 'dest-postgres-dw',
    destination_name: 'postgres-warehouse',
    destination_type: 'Postgres',
    status: 'inactive',
    schedule_type: 'manual',
    sync_mode: 'full refresh | overwrite',
    streams_count: 14,
    last_sync_started_at: hoursAgo(38),
    last_sync_finished_at: hoursAgo(38),
    last_sync_status: 'cancelled',
    last_sync_records: 0,
    last_sync_bytes: 0,
    last_sync_duration_s: 12,
  },
]

const STUB_JOBS: Job[] = (() => {
  const out: Job[] = []
  let s = 91
  for (let i = 0; i < 28; i++) {
    s = (s * 9301 + 49297) % 233280
    const conn = STUB_CONNECTIONS[(s >> 4) % STUB_CONNECTIONS.length]
    const fail = (s % 14) === 0
    const dur = 20 + (s % 600)
    const records = (s % 200_000)
    const start = hoursAgo((i * 0.5) + 0.2)
    out.push({
      job_id: `job-${i}-${conn.connection_id.slice(-4)}`,
      connection_id: conn.connection_id,
      connection_name: conn.name,
      job_type: 'sync',
      status: fail ? 'failed' : i === 0 && conn.last_sync_status === 'running' ? 'running' : 'succeeded',
      created_at: start,
      started_at: start,
      ended_at: i === 0 && conn.last_sync_status === 'running' ? undefined : new Date(new Date(start).getTime() + dur * 1000).toISOString(),
      duration_s: i === 0 && conn.last_sync_status === 'running' ? undefined : dur,
      records_emitted: records,
      bytes_emitted: records * 412,
      failure_message: fail
        ? 'Source connection failed: authentication expired (Salesforce: invalid grant)'
        : undefined,
    })
  }
  return out
})()

export const AirbyteClient = defineClient<AirbyteClient>(build, () => {
  const conns = STUB_CONNECTIONS.slice()
  return {
    listSources: async () => STUB_SOURCES,
    listDestinations: async () => STUB_DESTINATIONS,
    listConnections: async () => conns,
    getConnection: async (id) => {
      const c = conns.find((x) => x.connection_id === id)
      if (!c) throw new Error(`Stub: connection ${id} not found`)
      return c
    },
    listJobs: async (filter) => {
      let list = STUB_JOBS.slice()
      if (filter?.connectionId) list = list.filter((j) => j.connection_id === filter.connectionId)
      if (filter?.status) list = list.filter((j) => j.status === filter.status)
      if (filter?.limit) list = list.slice(0, filter.limit)
      return list.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
    },
    triggerSync: async (connectionId) => {
      const c = conns.find((x) => x.connection_id === connectionId)
      if (c) {
        c.last_sync_status = 'running'
        c.last_sync_started_at = new Date().toISOString()
      }
    },
    toggleConnection: async (connectionId, active) => {
      const c = conns.find((x) => x.connection_id === connectionId)
      if (c) c.status = active ? 'active' : 'inactive'
    },
  }
})
