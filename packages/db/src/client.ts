import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'
import { env } from '@adhar-console/utils'
import * as schema from './schema.ts'
import { runInitDdl } from './migrate.ts'

/**
 * Postgres connection + Drizzle instance, lazily created from `DATABASE_URL`.
 *
 * Degrades gracefully: when `DATABASE_URL` is absent (dev SPA, or a deploy that
 * hasn't wired a DB yet) `getDb()` returns `null` and callers fall back to
 * their stub/localStorage behaviour instead of crashing the container.
 */
export type Db = PostgresJsDatabase<typeof schema>

let sqlClient: Sql | null = null
let dbInstance: Db | null = null
let migratePromise: Promise<void> | null = null

export function isDbConfigured(): boolean {
  return Boolean(env('DATABASE_URL'))
}

export function getDb(): Db | null {
  if (dbInstance) return dbInstance
  const url = env('DATABASE_URL')
  if (!url) return null
  sqlClient = postgres(url, {
    max: Number(env('DATABASE_POOL_MAX') ?? 10),
    idle_timeout: 30,
    // Disable prepared statements for compatibility with PgBouncer-style poolers.
    prepare: env('DATABASE_PREPARE') !== 'false' ? undefined : false,
    ssl: env('DATABASE_SSL') === 'true' ? 'require' : undefined,
  })
  dbInstance = drizzle(sqlClient, { schema })
  return dbInstance
}

/**
 * Ensure the schema exists. Runs the idempotent bootstrap DDL exactly once per
 * process. Call this before the first query in a request handler; it's cheap
 * after the first run (a resolved promise).
 */
export async function ensureMigrated(): Promise<void> {
  if (!getDb() || !sqlClient) return
  if (!migratePromise) {
    const sql = sqlClient
    migratePromise = runInitDdl(sql).catch((e) => {
      // Reset so a later request can retry after a transient DB outage.
      migratePromise = null
      throw e
    })
  }
  await migratePromise
}

/** Get the migrated DB, or null when no DB is configured. */
export async function getMigratedDb(): Promise<Db | null> {
  const db = getDb()
  if (!db) return null
  await ensureMigrated()
  return db
}

/** Best-effort connectivity check for /readyz. */
export async function pingDb(): Promise<boolean> {
  try {
    if (!getDb() || !sqlClient) return false
    await sqlClient`select 1`
    return true
  } catch {
    return false
  }
}
