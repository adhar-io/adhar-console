import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit config for generating versioned migrations as the schema evolves:
 *
 *   cd packages/db
 *   deno task generate   # emits SQL + journal under ./drizzle
 *   deno task migrate    # applies pending migrations to DATABASE_URL
 *
 * The container itself bootstraps an empty DB with the idempotent DDL in
 * migrate.ts (no migration Job required); use drizzle-kit migrations for
 * schema changes that need ordered, reversible steps.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://adhar:adhar@localhost:5432/adhar_console',
  },
  strict: true,
  verbose: true,
})
