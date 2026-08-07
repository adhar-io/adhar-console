/**
 * `@adhar-console/db` — server-only. Postgres + Drizzle for the console's own
 * relational state. Never import from the browser bundle.
 */
export { getDb, getMigratedDb, ensureMigrated, isDbConfigured, pingDb, type Db } from './client.ts'
export { INIT_DDL, runInitDdl } from './migrate.ts'
export {
  deleteDocument,
  getDocument,
  getNotificationState,
  getPreferences,
  listDocuments,
  putDocument,
  setNotificationState,
  setNotificationStateBulk,
  setPreferences,
  touchUser,
  type NotificationStateEntry,
  type StoredDocument,
} from './repo.ts'
export * as schema from './schema.ts'
export type { DocumentRow, NotificationStateRow, User, UserPreference } from './schema.ts'
