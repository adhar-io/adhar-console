import { and, eq } from 'drizzle-orm'
import type { Db } from './client.ts'
import { notificationState, userPreferences, users } from './schema.ts'

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
