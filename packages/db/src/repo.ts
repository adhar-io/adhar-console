import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import type { Db } from './client.ts'
import { documents, notificationState, userPreferences, users } from './schema.ts'
import type { DocumentRow } from './schema.ts'

/**
 * Data-access functions for the console's own state. Thin, typed wrappers over
 * Drizzle so the API routes stay declarative and the SQL lives in one place.
 */

/** Upsert the lightweight user directory row on each authenticated request. */
export async function touchUser(
  db: Db,
  user: { id: string; email: string; name: string },
): Promise<void> {
  await db
    .insert(users)
    .values({ id: user.id, email: user.email, name: user.name })
    .onConflictDoUpdate({
      target: users.id,
      set: { email: user.email, name: user.name, lastSeenAt: new Date() },
    })
}

/** Read a preference document for (user, scope). Returns null when unset. */
export async function getPreferences(
  db: Db,
  userId: string,
  scope: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ data: userPreferences.data })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.scope, scope)))
    .limit(1)
  return rows[0]?.data ?? null
}

/** Upsert a preference document for (user, scope). */
export async function setPreferences(
  db: Db,
  userId: string,
  scope: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(userPreferences)
    .values({ userId, scope, data })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.scope],
      set: { data, updatedAt: new Date() },
    })
}

export interface NotificationStateEntry {
  notificationId: string
  read: boolean
  dismissed: boolean
}

/** All notification interaction rows for a user. */
export async function getNotificationState(
  db: Db,
  userId: string,
): Promise<NotificationStateEntry[]> {
  const rows = await db
    .select({
      notificationId: notificationState.notificationId,
      read: notificationState.read,
      dismissed: notificationState.dismissed,
    })
    .from(notificationState)
    .where(eq(notificationState.userId, userId))
  return rows
}

/** Upsert one notification's read/dismissed flags (partial update). */
export async function setNotificationState(
  db: Db,
  userId: string,
  notificationId: string,
  patch: { read?: boolean; dismissed?: boolean },
): Promise<void> {
  await db
    .insert(notificationState)
    .values({
      userId,
      notificationId,
      read: patch.read ?? false,
      dismissed: patch.dismissed ?? false,
    })
    .onConflictDoUpdate({
      target: [notificationState.userId, notificationState.notificationId],
      set: {
        ...(patch.read !== undefined ? { read: patch.read } : {}),
        ...(patch.dismissed !== undefined ? { dismissed: patch.dismissed } : {}),
        updatedAt: new Date(),
      },
    })
}

/** Bulk-set a flag across many notifications (mark-all-read / dismiss-all). */
export async function setNotificationStateBulk(
  db: Db,
  userId: string,
  ids: string[],
  patch: { read?: boolean; dismissed?: boolean },
): Promise<void> {
  if (ids.length === 0) return
  for (const id of ids) {
    await setNotificationState(db, userId, id, patch)
  }
}

/* ─────────────── generic tenant-scoped document store ─────────────── */

export interface StoredDocument {
  id: string
  data: Record<string, unknown>
  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

function toStored(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    data: row.data,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** All documents of a kind for a tenant, oldest-first (stable ordering). */
export async function listDocuments(
  db: Db,
  tenant: string,
  kind: string,
): Promise<StoredDocument[]> {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.tenant, tenant), eq(documents.kind, kind)))
    .orderBy(asc(documents.createdAt))
  return rows.map(toStored)
}

export interface DocumentQuery {
  /** Case-insensitive substring match against the given JSON paths (`a.b.c`) OR'd together. */
  search?: { text: string; paths: string[] }
  /** Exact-match filters on JSON paths (`a.b` = value). */
  equals?: Array<{ path: string; value: string }>
  /** Prefix match on a JSON path (e.g. action starts with "team."). */
  startsWith?: Array<{ path: string; value: string }>
  /** ISO bounds on a JSON timestamp path (defaults to `created_at` when path is omitted). */
  range?: { path?: string; from?: string; to?: string }
  /** Sort by a JSON path or the row's created_at. */
  sort?: { path?: string; direction: 'asc' | 'desc' }
  limit: number
  offset: number
}

export interface DocumentPage {
  items: StoredDocument[]
  total: number
}

/** `data->'a'->>'b'` for a dotted path. */
function jsonPath(path: string): SQL {
  const parts = path.split('.').filter(Boolean)
  if (!parts.length) return sql`${documents.data}::text`
  let expr: SQL = sql`${documents.data}`
  parts.forEach((part, i) => {
    expr = i === parts.length - 1 ? sql`${expr}->>${part}` : sql`${expr}->${part}`
  })
  return expr
}

/**
 * Server-side paginated query over documents of one kind — filters, search
 * and ordering run in Postgres so a kind with millions of rows (the audit
 * trail) never gets loaded into memory. Returns the page plus the total
 * matching count for the pager.
 */
export async function queryDocuments(
  db: Db,
  tenant: string,
  kind: string,
  q: DocumentQuery,
): Promise<DocumentPage> {
  const where: SQL[] = [eq(documents.tenant, tenant), eq(documents.kind, kind)]
  if (q.search?.text.trim()) {
    const needle = `%${q.search.text.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    const ors = q.search.paths.map((path) => sql`${jsonPath(path)} ILIKE ${needle}`)
    if (ors.length) where.push(sql`(${sql.join(ors, sql` OR `)})`)
  }
  for (const f of q.equals ?? []) where.push(sql`${jsonPath(f.path)} = ${f.value}`)
  for (const f of q.startsWith ?? []) {
    const prefix = `${f.value.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    where.push(sql`${jsonPath(f.path)} ILIKE ${prefix}`)
  }
  if (q.range?.from || q.range?.to) {
    if (q.range.path) {
      if (q.range.from) where.push(sql`${jsonPath(q.range.path)} >= ${q.range.from}`)
      if (q.range.to) where.push(sql`${jsonPath(q.range.path)} <= ${q.range.to}`)
    } else {
      if (q.range.from) where.push(gte(documents.createdAt, new Date(q.range.from)))
      if (q.range.to) where.push(lte(documents.createdAt, new Date(q.range.to)))
    }
  }
  const cond = and(...where)
  const orderExpr = q.sort?.path ? jsonPath(q.sort.path) : documents.createdAt
  const order = q.sort?.direction === 'asc' ? asc(orderExpr) : desc(orderExpr)
  const [rows, counted] = await Promise.all([
    db.select().from(documents).where(cond).orderBy(order, desc(documents.createdAt)).limit(q.limit).offset(q.offset),
    db.select({ n: sql<number>`count(*)::int` }).from(documents).where(cond),
  ])
  return { items: rows.map(toStored), total: counted[0]?.n ?? 0 }
}

/** One document by (tenant, kind, id). Null when absent. */
export async function getDocument(
  db: Db,
  tenant: string,
  kind: string,
  id: string,
): Promise<StoredDocument | null> {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.tenant, tenant), eq(documents.kind, kind), eq(documents.id, id)))
    .limit(1)
  return rows[0] ? toStored(rows[0]) : null
}

/** Upsert a document. Preserves createdBy/createdAt on update. */
export async function putDocument(
  db: Db,
  tenant: string,
  kind: string,
  id: string,
  data: Record<string, unknown>,
  userId: string,
): Promise<StoredDocument> {
  const rows = await db
    .insert(documents)
    .values({ tenant, kind, id, data, createdBy: userId, updatedBy: userId })
    .onConflictDoUpdate({
      target: [documents.tenant, documents.kind, documents.id],
      set: { data, updatedBy: userId, updatedAt: new Date() },
    })
    .returning()
  return toStored(rows[0])
}

/** Delete a document. Returns true when a row was removed. */
export async function deleteDocument(
  db: Db,
  tenant: string,
  kind: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(documents)
    .where(and(eq(documents.tenant, tenant), eq(documents.kind, kind), eq(documents.id, id)))
    .returning({ id: documents.id })
  return rows.length > 0
}
