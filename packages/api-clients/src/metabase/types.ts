/**
 * Wire shapes of the Metabase 0.51 REST API, as the console reads them.
 *
 * These mirror what Metabase actually returns (snake_case, nullable fields,
 * `dashcards`, `{ data, total }` envelopes) rather than an idealised model, so
 * the BI views can render a real instance without guessing. Every field the
 * console does not strictly need is optional: Metabase adds and renames keys
 * between minor versions, and a missing key must degrade, never throw.
 */

export type MbCell = string | number | boolean | null

/** One result column of a dataset. */
export interface MbColumn {
  name: string
  display_name?: string
  base_type?: string
  effective_type?: string
  semantic_type?: string | null
  /** Temporal bucketing unit for breakout columns (`day`, `month`, …). */
  unit?: string
  source?: string
  field_ref?: unknown
}

/** `POST /api/dataset`, `/api/card/:id/query` and dashcard queries. */
export interface MbDataset {
  data?: {
    rows: MbCell[][]
    cols: MbColumn[]
    native_form?: { query?: string }
    insights?: Array<{
      col: string
      'previous-value'?: number | null
      'last-value'?: number | null
      'last-change'?: number | null
      unit?: string
    }> | null
    rows_truncated?: number
  }
  row_count?: number
  running_time?: number
  status?: 'completed' | 'failed' | string
  error?: string | { message?: string } | null
  error_type?: string
  started_at?: string
}

export type MbCardType = 'question' | 'model' | 'metric'

export interface MbUserRef {
  id?: number
  email?: string
  first_name?: string | null
  last_name?: string | null
  common_name?: string
}

export interface MbModerationReview {
  status?: 'verified' | null
  most_recent?: boolean
}

export interface MbCollectionRef {
  id: number | 'root' | null
  name: string
  authority_level?: 'official' | null
  personal_owner_id?: number | null
  effective_ancestors?: Array<{ id: number | 'root'; name: string }>
}

/** A saved question / model / metric (`/api/card`). */
export interface MbCard {
  id: number
  name: string
  description?: string | null
  type?: MbCardType
  display: string
  collection_id?: number | null
  collection?: MbCollectionRef | null
  database_id?: number | null
  table_id?: number | null
  query_type?: 'native' | 'query' | string
  dataset_query?: {
    type?: 'native' | 'query'
    database?: number
    native?: { query?: string; 'template-tags'?: Record<string, MbTemplateTag> }
    query?: unknown
  }
  visualization_settings?: Record<string, unknown>
  result_metadata?: MbColumn[] | null
  parameters?: MbParameter[]
  archived?: boolean
  can_write?: boolean
  view_count?: number
  last_used_at?: string | null
  created_at?: string
  updated_at?: string
  creator?: MbUserRef | null
  moderation_reviews?: MbModerationReview[]
  /** Present on `/api/card?f=…` in some versions. */
  'last-edit-info'?: { timestamp?: string; first_name?: string; last_name?: string; email?: string }
}

export interface MbTemplateTag {
  id: string
  name: string
  'display-name': string
  type: 'text' | 'number' | 'date' | 'dimension' | 'snippet' | 'card' | string
  required?: boolean
  default?: unknown
  'snippet-name'?: string
  'snippet-id'?: number
}

/** A dashboard or native-question parameter. */
export interface MbParameter {
  id: string
  name: string
  slug: string
  type: string
  sectionId?: string
  default?: unknown
  required?: boolean
  target?: unknown
  values_query_type?: string
}

export interface MbParameterMapping {
  parameter_id: string
  card_id?: number
  target: unknown
}

/** A card placed on a dashboard. Text / heading / link cards have no `card_id`. */
export interface MbDashcard {
  id: number
  card_id: number | null
  card?: MbCard | null
  dashboard_tab_id?: number | null
  row: number
  col: number
  size_x: number
  size_y: number
  parameter_mappings?: MbParameterMapping[]
  visualization_settings?: Record<string, unknown>
  series?: MbCard[]
}

export interface MbDashboardTab {
  id: number
  name: string
  position?: number
}

export interface MbDashboardDetail {
  id: number
  name: string
  description?: string | null
  collection_id?: number | null
  collection?: MbCollectionRef | null
  dashcards: MbDashcard[]
  tabs?: MbDashboardTab[]
  parameters?: MbParameter[]
  can_write?: boolean
  archived?: boolean
  view_count?: number
  created_at?: string
  updated_at?: string
  moderation_reviews?: MbModerationReview[]
  'last-edit-info'?: { timestamp?: string; first_name?: string; last_name?: string; email?: string }
  cache_ttl?: number | null
}

/** A node of `/api/collection/tree`. */
export interface MbCollectionNode {
  id: number
  name: string
  description?: string | null
  location?: string
  personal_owner_id?: number | null
  authority_level?: 'official' | null
  archived?: boolean
  is_personal?: boolean
  children?: MbCollectionNode[]
  here?: string[]
  below?: string[]
}

/** An `/api/search` hit. */
export interface MbSearchItem {
  id: number
  model: 'dashboard' | 'card' | 'dataset' | 'metric' | 'collection' | 'table' | 'database' | string
  name: string
  description?: string | null
  collection?: MbCollectionRef | null
  collection_id?: number | null
  display?: string | null
  moderated_status?: 'verified' | null
  bookmark?: boolean | null
  dashboardcard_count?: number | null
  database_id?: number | null
  updated_at?: string
  created_at?: string
  last_edited_at?: string | null
  last_editor_common_name?: string | null
  creator_common_name?: string | null
  dataset_query?: MbCard['dataset_query'] | null
}

export interface MbBookmark {
  id: string | number
  type: 'card' | 'dashboard' | 'collection' | string
  item_id: number
  name: string
  card_type?: MbCardType
  display?: string
}

export interface MbRecentItem {
  model: string
  id: number
  name: string
  timestamp?: string
  display?: string
  moderated_status?: string | null
}

export interface MbCurrentUser {
  id: number
  email: string
  common_name?: string
  first_name?: string | null
  last_name?: string | null
  is_superuser?: boolean
  personal_collection_id?: number
}

export interface MbSessionProperties {
  version?: { tag?: string; date?: string }
  'site-url'?: string | null
  'report-timezone-short'?: string | null
  'report-timezone-long'?: string | null
  'email-configured?'?: boolean
  'slack-app-token'?: unknown
  [k: string]: unknown
}

export interface MbField {
  id: number
  name: string
  display_name?: string
  base_type?: string
  effective_type?: string
  semantic_type?: string | null
  database_type?: string
  description?: string | null
  visibility_type?: string
  fk_target_field_id?: number | null
  position?: number
}

export interface MbTable {
  id: number
  db_id?: number
  name: string
  schema?: string | null
  display_name?: string
  description?: string | null
  entity_type?: string | null
  visibility_type?: string | null
  rows?: number | null
  fields?: MbField[]
  initial_sync_status?: string
  updated_at?: string
}

export interface MbDatabase {
  id: number
  name: string
  engine: string
  description?: string | null
  is_sample?: boolean
  is_full_sync?: boolean
  is_on_demand?: boolean
  initial_sync_status?: 'complete' | 'incomplete' | 'aborted' | string
  native_permissions?: 'write' | 'none' | string
  can_upload?: boolean
  features?: string[]
  timezone?: string | null
  created_at?: string
  updated_at?: string
  tables?: MbTable[]
  details?: Record<string, unknown>
  /** Present when the caller may manage the database. */
  'can-manage'?: boolean
}

export interface MbDatabaseMetadata extends MbDatabase {
  tables: MbTable[]
}

/* ─────────── subscriptions & alerts ─────────── */

export interface MbRecipient {
  id?: number
  email: string
  common_name?: string
}

export type MbScheduleType = 'hourly' | 'daily' | 'weekly' | 'monthly'

export interface MbChannel {
  id?: number
  channel_type: 'email' | 'slack' | string
  enabled: boolean
  schedule_type: MbScheduleType
  schedule_hour?: number | null
  schedule_day?: 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | null
  schedule_frame?: 'first' | 'mid' | 'last' | null
  recipients?: MbRecipient[]
  details?: { channel?: string } | null
}

export interface MbPulseCard {
  id: number
  name?: string
  display?: string
  include_csv?: boolean
  include_xls?: boolean
  dashboard_card_id?: number | null
  dashboard_id?: number | null
}

/** A dashboard subscription (`/api/pulse`). */
export interface MbPulse {
  id: number
  name: string
  cards: MbPulseCard[]
  channels: MbChannel[]
  dashboard_id?: number | null
  collection_id?: number | null
  skip_if_empty?: boolean
  archived?: boolean
  parameters?: unknown[]
  creator?: MbUserRef | null
  created_at?: string
  updated_at?: string
  can_write?: boolean
}

export interface MbPulseInput {
  name: string
  cards: MbPulseCard[]
  channels: MbChannel[]
  dashboard_id?: number | null
  collection_id?: number | null
  skip_if_empty?: boolean
  parameters?: unknown[]
}

/** A question alert (`/api/alert`). */
export interface MbAlert {
  id: number
  card: { id: number; name?: string; display?: string; include_csv?: boolean; include_xls?: boolean }
  alert_condition: 'rows' | 'goal'
  alert_first_only?: boolean
  alert_above_goal?: boolean | null
  channels: MbChannel[]
  archived?: boolean
  creator?: MbUserRef | null
  created_at?: string
  updated_at?: string
}

export interface MbAlertInput {
  card: { id: number; include_csv?: boolean; include_xls?: boolean; dashboard_card_id?: number | null }
  alert_condition: 'rows' | 'goal'
  alert_first_only?: boolean
  alert_above_goal?: boolean | null
  channels: MbChannel[]
}

/** `/api/pulse/form_input` — which channels this Metabase can send through. */
export interface MbChannelSpec {
  type?: string
  name?: string
  configured?: boolean
  allows_recipients?: boolean
  schedules?: string[]
  fields?: Array<{ name: string; displayName?: string; options?: string[]; required?: boolean }>
}
export interface MbPulseFormInput {
  channels?: { email?: MbChannelSpec; slack?: MbChannelSpec; http?: MbChannelSpec }
}

export interface MbSnippet {
  id: number
  name: string
  content: string
  description?: string | null
  archived?: boolean
  collection_id?: number | null
  creator?: MbUserRef | null
  updated_at?: string
}

export interface MbNewCard {
  name: string
  description?: string | null
  type?: MbCardType
  display: string
  collection_id: number | null
  dataset_query: NonNullable<MbCard['dataset_query']>
  visualization_settings: Record<string, unknown>
  parameters?: MbParameter[]
}

/** A dataset parameter value, as dashcard and native queries take it. */
export interface MbParameterValue {
  id?: string
  type: string
  value: unknown
  target: unknown
}
