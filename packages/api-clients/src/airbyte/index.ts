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
  /** Selected streams, when the API returned the catalog. */
  streams: z.array(z.object({
    name: z.string(),
    namespace: z.string().optional(),
    sync_mode: z.string().optional(),
    destination_sync_mode: z.string().optional(),
    selected: z.boolean().optional(),
  })).optional(),
  namespace_definition: z.string().optional(),
  prefix: z.string().optional(),
})
export type Connection = z.infer<typeof ConnectionSchema>

export type ScheduleInput =
  | { type: 'manual' }
  | { type: 'basic'; units: number; time_unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months' }
  | { type: 'cron'; cron_expression: string; timezone?: string }

export interface CheckResult {
  status: 'succeeded' | 'failed'
  message?: string
}

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
  attempts: z.number().optional(),
})
export type Job = z.infer<typeof JobSchema>

export interface AirbyteClient {
  listSources(): Promise<Source[]>
  listDestinations(): Promise<Destination[]>
  listConnections(): Promise<Connection[]>
  getConnection(id: string): Promise<Connection>
  listJobs(filter?: { connectionId?: string; status?: JobStatus; limit?: number }): Promise<Job[]>
  /** Log lines of a job's latest attempt. */
  getJobLogs(jobId: string): Promise<string[]>
  triggerSync(connectionId: string): Promise<void>
  cancelJob(jobId: string): Promise<void>
  /** Clear the destination's data for this connection and re-sync from scratch. */
  resetConnection(connectionId: string): Promise<void>
  toggleConnection(connectionId: string, active: boolean): Promise<void>
  updateSchedule(connectionId: string, schedule: ScheduleInput): Promise<void>
  renameConnection(connectionId: string, name: string): Promise<void>
  deleteConnection(connectionId: string): Promise<void>
  checkSource(sourceId: string): Promise<CheckResult>
  checkDestination(destinationId: string): Promise<CheckResult>
}

/* ─────────── live: Airbyte config API (v1) ───────────
 *
 * The config API is POST-only, camelCase, and workspace-scoped. Every list
 * call needs a `workspaceId`, discovered once from `workspaces/list`. The
 * responses are normalised here into the snake_case shapes the console has
 * always rendered, so a view never sees Airbyte's wire format.
 */

// deno-lint-ignore no-explicit-any
type Raw = any

type TimeUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'
const TIME_UNIT: Record<string, TimeUnit> = {
  minutes: 'minutes',
  hours: 'hours',
  days: 'days',
  weeks: 'weeks',
  months: 'months',
}

const toIso = (v: unknown): string | undefined => {
  if (v == null || v === '') return undefined
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  return String(v)
}

function jobStatus(v: unknown): JobStatus {
  const s = String(v ?? '').toLowerCase()
  return (JobStatusSchema.options as string[]).includes(s) ? (s as JobStatus) : s === 'cancelled' || s === 'canceled' ? 'cancelled' : 'pending'
}

function normJob(r: Raw, names: Map<string, string>): Job {
  const job = r.job ?? r
  const attempts: Raw[] = r.attempts ?? []
  const last = attempts[attempts.length - 1]?.attempt ?? attempts[attempts.length - 1] ?? {}
  const records = attempts.reduce((s: number, a: Raw) => s + Number((a.attempt ?? a).recordsSynced ?? 0), 0)
  const bytes = attempts.reduce((s: number, a: Raw) => s + Number((a.attempt ?? a).bytesSynced ?? 0), 0)
  const created = toIso(job.createdAt) ?? new Date(0).toISOString()
  const ended = ['succeeded', 'failed', 'cancelled', 'incomplete'].includes(jobStatus(job.status)) ? toIso(last.endedAt ?? job.updatedAt) : undefined
  const failure = last.failureSummary?.failures?.[0]
  return {
    job_id: String(job.id ?? job.jobId),
    connection_id: String(job.configId ?? job.connectionId ?? ''),
    connection_name: names.get(String(job.configId ?? job.connectionId)) ?? String(job.configId ?? ''),
    job_type: String(job.configType ?? 'sync').toLowerCase().includes('reset') ? 'reset_connection' : 'sync',
    status: jobStatus(job.status),
    created_at: created,
    started_at: toIso(attempts[0]?.attempt?.createdAt ?? attempts[0]?.createdAt) ?? created,
    ended_at: ended,
    duration_s: ended ? Math.max(0, Math.round((Date.parse(ended) - Date.parse(created)) / 1000)) : undefined,
    records_emitted: records || undefined,
    bytes_emitted: bytes || undefined,
    failure_message: failure ? failure.externalMessage ?? failure.internalMessage : undefined,
    attempts: attempts.length || undefined,
  }
}

function normConnection(r: Raw, src: Map<string, Source>, dst: Map<string, Destination>): Connection {
  // Already in console shape (older BFFs, tests).
  if (r.connection_id) return r as Connection
  const s = r.source ? { name: r.source.name, type: r.source.sourceName } : { name: src.get(r.sourceId)?.name, type: src.get(r.sourceId)?.source_type }
  const d = r.destination ? { name: r.destination.name, type: r.destination.destinationName } : { name: dst.get(r.destinationId)?.name, type: dst.get(r.destinationId)?.destination_type }
  const basic = r.scheduleData?.basicSchedule ?? r.schedule
  const cron = r.scheduleData?.cron
  const scheduleType = (r.scheduleType ?? (basic ? 'basic' : 'manual')) as 'manual' | 'basic' | 'cron'
  const streams = (r.syncCatalog?.streams ?? []).map((x: Raw) => ({
    name: x.stream?.name ?? x.name,
    namespace: x.stream?.namespace ?? undefined,
    sync_mode: x.config?.syncMode,
    destination_sync_mode: x.config?.destinationSyncMode,
    selected: x.config?.selected ?? true,
  }))
  const selected = streams.filter((x: { selected?: boolean }) => x.selected !== false)
  const modes: string[] = [...new Set<string>(selected.map((x: { sync_mode?: string; destination_sync_mode?: string }) => `${x.sync_mode ?? '?'} | ${x.destination_sync_mode ?? '?'}`))]
  return {
    connection_id: r.connectionId,
    name: r.name ?? `${s.name} → ${d.name}`,
    source_id: r.sourceId ?? r.source?.sourceId,
    source_name: s.name ?? r.sourceId,
    source_type: s.type ?? '',
    destination_id: r.destinationId ?? r.destination?.destinationId,
    destination_name: d.name ?? r.destinationId,
    destination_type: d.type ?? '',
    status: r.status === 'active' ? 'active' : r.status === 'deprecated' ? 'deprecated' : 'inactive',
    schedule_type: scheduleType,
    schedule: scheduleType === 'cron'
      ? { cron_expression: cron?.cronExpression }
      : basic
      ? { units: basic.units, time_unit: TIME_UNIT[String(basic.timeUnit).toLowerCase()] }
      : undefined,
    sync_mode: modes.length === 1 ? modes[0].replace(/_/g, ' ') : modes.length ? 'mixed' : undefined,
    streams_count: selected.length,
    streams: streams.length ? streams : undefined,
    last_sync_status: r.latestSyncJobStatus ? jobStatus(r.latestSyncJobStatus) : r.isSyncing ? 'running' : undefined,
    last_sync_started_at: toIso(r.latestSyncJobCreatedAt),
    namespace_definition: r.namespaceDefinition,
    prefix: r.prefix,
  }
}

function build(http: HttpClient): AirbyteClient {
  let workspace: Promise<string> | null = null
  const workspaceId = () => {
    workspace ??= http.post<Raw>(`/api/v1/workspaces/list`, {}).then((r) => {
      const id = r.workspaces?.[0]?.workspaceId
      if (!id) throw new Error('Airbyte has no workspace yet — open Airbyte once to finish its setup.')
      return id as string
    }).catch((e) => {
      workspace = null
      throw e
    })
    return workspace
  }

  const listSources = async (): Promise<Source[]> => {
    const r = await http.post<Raw>(`/api/v1/sources/list`, { workspaceId: await workspaceId() })
    return (r.sources ?? []).map((x: Raw): Source =>
      x.source_id ? x : { source_id: x.sourceId, name: x.name, source_type: x.sourceName, workspace_id: x.workspaceId, icon: x.icon }
    )
  }
  const listDestinations = async (): Promise<Destination[]> => {
    const r = await http.post<Raw>(`/api/v1/destinations/list`, { workspaceId: await workspaceId() })
    return (r.destinations ?? []).map((x: Raw): Destination =>
      x.destination_id ? x : { destination_id: x.destinationId, name: x.name, destination_type: x.destinationName, workspace_id: x.workspaceId, icon: x.icon }
    )
  }
  const maps = async () => {
    const [s, d] = await Promise.all([listSources().catch(() => []), listDestinations().catch(() => [])])
    return { src: new Map(s.map((x) => [x.source_id, x])), dst: new Map(d.map((x) => [x.destination_id, x])) }
  }
  const listConnections = async (): Promise<Connection[]> => {
    const [r, m] = await Promise.all([http.post<Raw>(`/api/v1/connections/list`, { workspaceId: await workspaceId() }), maps()])
    const conns: Connection[] = (r.connections ?? []).map((c: Raw) => normConnection(c, m.src, m.dst))
    // Fill the last-sync columns from the newest job of each connection.
    const jobs = await listJobsRaw({ limit: 100 }, new Map(conns.map((c) => [c.connection_id, c.name]))).catch(() => [])
    for (const c of conns) {
      const last = jobs.find((j) => j.connection_id === c.connection_id && j.job_type === 'sync')
      if (!last) continue
      c.last_sync_status = last.status
      c.last_sync_started_at = last.started_at
      c.last_sync_finished_at = last.ended_at
      c.last_sync_records = last.records_emitted
      c.last_sync_bytes = last.bytes_emitted
      c.last_sync_duration_s = last.duration_s
    }
    return conns
  }
  const listJobsRaw = async (filter: { connectionId?: string; status?: JobStatus; limit?: number } | undefined, names: Map<string, string>): Promise<Job[]> => {
    const body: Raw = {
      configTypes: ['sync', 'reset_connection'],
      pagination: { rowOffset: 0, pageSize: filter?.limit ?? 50 },
      ...(filter?.connectionId ? { configId: filter.connectionId } : { workspaceIds: [await workspaceId()] }),
      ...(filter?.status ? { statuses: [filter.status] } : {}),
    }
    const r = await http.post<Raw>(`/api/v1/jobs/list`, body)
    return (r.jobs ?? []).map((j: Raw) => (j.job_id ? (j as Job) : normJob(j, names)))
  }
  const update = async (connectionId: string, patch: Raw) => {
    await http.post(`/api/v1/connections/update`, { connectionId, ...patch }, { response: 'raw' })
  }

  return {
    listSources,
    listDestinations,
    listConnections,
    getConnection: async (id) => {
      const [r, m] = await Promise.all([http.post<Raw>(`/api/v1/connections/get`, { connectionId: id }), maps()])
      return normConnection(r, m.src, m.dst)
    },
    listJobs: async (filter) => {
      const conns = await http.post<Raw>(`/api/v1/connections/list`, { workspaceId: await workspaceId() }).catch(() => ({ connections: [] }))
      const names = new Map<string, string>((conns.connections ?? []).map((c: Raw) => [c.connectionId ?? c.connection_id, c.name]))
      return listJobsRaw(filter, names)
    },
    getJobLogs: async (jobId) => {
      const r = await http.post<Raw>(`/api/v1/jobs/get`, { id: Number(jobId) })
      const attempts: Raw[] = r.attempts ?? []
      const last = attempts[attempts.length - 1]
      const lines: string[] = last?.logs?.logLines ?? last?.logs?.events?.map((e: Raw) => `${e.timestamp ?? ''} ${e.level ?? ''} ${e.message ?? ''}`) ?? []
      return lines
    },
    triggerSync: async (connectionId) => {
      await http.post(`/api/v1/connections/sync`, { connectionId }, { response: 'raw' })
    },
    cancelJob: async (jobId) => {
      await http.post(`/api/v1/jobs/cancel`, { id: Number(jobId) }, { response: 'raw' })
    },
    resetConnection: async (connectionId) => {
      await http.post(`/api/v1/connections/reset`, { connectionId }, { response: 'raw' })
    },
    toggleConnection: (connectionId, active) => update(connectionId, { status: active ? 'active' : 'inactive' }),
    updateSchedule: (connectionId, sch) =>
      update(
        connectionId,
        sch.type === 'manual'
          ? { scheduleType: 'manual' }
          : sch.type === 'basic'
          ? { scheduleType: 'basic', scheduleData: { basicSchedule: { timeUnit: sch.time_unit, units: sch.units } } }
          : { scheduleType: 'cron', scheduleData: { cron: { cronExpression: sch.cron_expression, cronTimeZone: sch.timezone ?? 'UTC' } } },
      ),
    renameConnection: (connectionId, name) => update(connectionId, { name }),
    deleteConnection: async (connectionId) => {
      await http.post(`/api/v1/connections/delete`, { connectionId }, { response: 'raw' })
    },
    checkSource: async (sourceId) => {
      const r = await http.post<Raw>(`/api/v1/sources/check_connection`, { sourceId })
      return { status: r.status === 'succeeded' ? 'succeeded' : 'failed', message: r.message }
    },
    checkDestination: async (destinationId) => {
      const r = await http.post<Raw>(`/api/v1/destinations/check_connection`, { destinationId })
      return { status: r.status === 'succeeded' ? 'succeeded' : 'failed', message: r.message }
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
    streams: ['invoices', 'invoice_lines', 'customers', 'subscriptions', 'plans', 'payments', 'refunds', 'credits', 'taxes', 'coupons', 'discounts', 'events', 'usage_records', 'accounts'].map((name) => ({ name, namespace: 'public', sync_mode: 'incremental', destination_sync_mode: 'append_dedup', selected: true })),
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
        STUB_JOBS.unshift({
          job_id: `job-${Date.now().toString(36)}`,
          connection_id: c.connection_id,
          connection_name: c.name,
          job_type: 'sync',
          status: 'running',
          created_at: c.last_sync_started_at,
          started_at: c.last_sync_started_at,
        })
      }
    },
    toggleConnection: async (connectionId, active) => {
      const c = conns.find((x) => x.connection_id === connectionId)
      if (c) c.status = active ? 'active' : 'inactive'
    },
    getJobLogs: async (jobId) => {
      const j = STUB_JOBS.find((x) => x.job_id === jobId)
      const t = j?.created_at ?? new Date().toISOString()
      return [
        `${t} INFO  Starting sync for ${j?.connection_name ?? 'connection'}`,
        `${t} INFO  Source: discovered 14 streams, 12 selected`,
        `${t} INFO  Replication: read ${j?.records_emitted ?? 0} records`,
        j?.status === 'failed' ? `${t} ERROR ${j.failure_message}` : `${t} INFO  Destination: committed ${j?.bytes_emitted ?? 0} bytes`,
        `${t} INFO  Sync ${j?.status ?? 'finished'}`,
      ]
    },
    cancelJob: async (jobId) => {
      const j = STUB_JOBS.find((x) => x.job_id === jobId)
      if (j) {
        j.status = 'cancelled'
        j.ended_at = new Date().toISOString()
      }
    },
    resetConnection: async (connectionId) => {
      const c = conns.find((x) => x.connection_id === connectionId)
      if (c) {
        c.last_sync_status = 'running'
        c.last_sync_started_at = new Date().toISOString()
      }
    },
    updateSchedule: async (connectionId, sch) => {
      const c = conns.find((x) => x.connection_id === connectionId)
      if (!c) return
      c.schedule_type = sch.type
      c.schedule = sch.type === 'basic' ? { units: sch.units, time_unit: sch.time_unit } : sch.type === 'cron' ? { cron_expression: sch.cron_expression } : undefined
      if (sch.type === 'manual') c.next_sync_at = undefined
    },
    renameConnection: async (connectionId, name) => {
      const c = conns.find((x) => x.connection_id === connectionId)
      if (c) c.name = name
    },
    deleteConnection: async (connectionId) => {
      const i = conns.findIndex((x) => x.connection_id === connectionId)
      if (i >= 0) conns.splice(i, 1)
    },
    checkSource: async (sourceId) => {
      const s = STUB_SOURCES.find((x) => x.source_id === sourceId)
      return s?.connection_status === 'failed'
        ? { status: 'failed', message: 'Authentication failed: invalid_grant (refresh token expired).' }
        : { status: 'succeeded' }
    },
    checkDestination: async () => ({ status: 'succeeded' }),
  }
})
