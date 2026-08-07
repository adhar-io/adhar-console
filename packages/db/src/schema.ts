import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

/**
 * Adhar Console relational schema.
 *
 * The console reads live infrastructure state from the Kubernetes API (via the
 * BFF proxy) and from each backing tool. Postgres holds only the console's OWN
 * state — the things no cluster resource owns: user preferences, per-user
 * notification read/dismiss state, and a light user directory anchored on the
 * Keycloak subject.
 *
 * This file is the source of truth for the schema. `migrate.ts` keeps an
 * idempotent DDL in lockstep for runtime bootstrap; `drizzle.config.ts` lets
 * you generate versioned migrations with drizzle-kit for schema evolution.
 */

/** Lightweight user directory, upserted on each authenticated request. */
export const users = pgTable('users', {
  /** Keycloak `sub` claim. */
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

/**
 * Per-user, per-scope preference blobs (overview layout, catalog filters, …).
 * `scope` namespaces the JSON document so one row holds one feature's prefs.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: text('user_id').notNull(),
    scope: text('scope').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.scope] }),
  }),
)

/**
 * Per-user notification interaction state. The content of a notification is
 * server-seeded/ephemeral; this table only records the user's read/dismiss
 * actions per notification id so they survive reloads and sync across tabs.
 */
export const notificationState = pgTable(
  'notification_state',
  {
    userId: text('user_id').notNull(),
    notificationId: text('notification_id').notNull(),
    read: boolean('read').notNull().default(false),
    dismissed: boolean('dismissed').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.notificationId] }),
    byUser: index('notification_state_user_idx').on(t.userId),
  }),
)

/**
 * Generic tenant-scoped document store for the console's OWN domain entities
 * that no cluster resource or backing tool owns — OKRs, saved views, custom
 * roles, webhooks, design docs (ADRs/diagrams/personas/…), API specs, etc.
 *
 * One row = one entity, addressed by (tenant, kind, id). `kind` namespaces a
 * collection (e.g. `okr.objective`, `design.adr`, `workspace.webhook`); `data`
 * holds the typed JSON document. Tenant-scoping makes this shared/multi-user
 * (the whole tenant sees the same objectives), not per-browser. This is the
 * real persistence backing that replaces the former in-memory/localStorage
 * stubs across the feature modules.
 */
export const documents = pgTable(
  'documents',
  {
    tenant: text('tenant').notNull(),
    kind: text('kind').notNull(),
    id: text('id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenant, t.kind, t.id] }),
    byKind: index('documents_tenant_kind_idx').on(t.tenant, t.kind),
  }),
)

export type User = typeof users.$inferSelect
export type UserPreference = typeof userPreferences.$inferSelect
export type NotificationStateRow = typeof notificationState.$inferSelect
export type DocumentRow = typeof documents.$inferSelect
