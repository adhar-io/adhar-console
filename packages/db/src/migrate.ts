import type { Sql } from 'postgres'

/**
 * Idempotent bootstrap DDL, kept in lockstep with `schema.ts`.
 *
 * Why not only drizzle-kit migrations? The console ships as a single immutable
 * image that may be the first thing to touch a freshly-provisioned database
 * (e.g. a brand-new Crossplane `Database` claim). Running `CREATE TABLE IF NOT
 * EXISTS` on startup means the app self-heals an empty DB with no migration Job
 * to sequence. For richer schema evolution, generate versioned migrations with
 * `drizzle-kit` (see drizzle.config.ts) and run them ahead of rollout.
 */
export const INIT_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  name          text NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id     text NOT NULL,
  scope       text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);

CREATE TABLE IF NOT EXISTS notification_state (
  user_id          text NOT NULL,
  notification_id  text NOT NULL,
  read             boolean NOT NULL DEFAULT false,
  dismissed        boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);

CREATE INDEX IF NOT EXISTS notification_state_user_idx ON notification_state (user_id);

CREATE TABLE IF NOT EXISTS documents (
  tenant      text NOT NULL,
  kind        text NOT NULL,
  id          text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  text,
  updated_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, kind, id)
);

CREATE INDEX IF NOT EXISTS documents_tenant_kind_idx ON documents (tenant, kind);
`

/** Apply the bootstrap DDL. Safe to run repeatedly. */
export async function runInitDdl(sql: Sql): Promise<void> {
  await sql.unsafe(INIT_DDL)
}
