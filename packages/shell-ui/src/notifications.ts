import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type NotificationKind = 'info' | 'warning' | 'error' | 'success'

export interface Notification {
  id: string
  title: string
  description?: string
  /** ISO 8601 timestamp. */
  at: string
  kind: NotificationKind
  read?: boolean
  /** Optional deep link — rendered as a subtle link chevron on the row. */
  href?: string
  /** Dismissing a notification removes it from the list permanently. */
  dismissed?: boolean
}

const STORAGE_KEY = 'adhar.notifications'

interface StoredState {
  /** Client-side metadata keyed by notification id. */
  meta: Record<string, { read?: boolean; dismissed?: boolean }>
}

/**
 * In a production build, read/dismissed state is the DB-backed
 * `/api/notifications` endpoint (per-user, cookie-authenticated). localStorage
 * remains as an instant local cache + the sole store in dev (no server).
 */
function isProdBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { PROD?: boolean } }).env?.PROD)
  } catch {
    return false
  }
}

/** Fire-and-forget persist of a read/dismiss patch to the server. */
function postNotificationState(body: {
  id?: string
  ids?: string[]
  read?: boolean
  dismissed?: boolean
}): void {
  if (!isProdBuild()) return
  try {
    void fetch('/api/notifications', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    })
  } catch {
    /* best-effort */
  }
}

function loadStored(): StoredState {
  if (typeof localStorage === 'undefined') return { meta: {} }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { meta: {} }
    const parsed = JSON.parse(raw) as StoredState
    return parsed && typeof parsed === 'object' ? parsed : { meta: {} }
  } catch {
    return { meta: {} }
  }
}

function persistStored(state: StoredState) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage quota or private mode — ignore.
  }
}

export interface NotificationsApi {
  /** Visible notifications — filtered by dismissed + sorted newest-first. */
  items: Notification[]
  /** Count of non-dismissed, non-read items. */
  unreadCount: number
  markRead(id: string): void
  markAllRead(): void
  dismiss(id: string): void
  dismissAll(): void
}

/**
 * Merges a seed list (usually from the server loader) with client-side read /
 * dismissed state persisted to localStorage. Returns a consistent Notification[]
 * where each item's `read` and `dismissed` reflect the user's actions.
 *
 * The seed is the source of truth for content; localStorage only tracks the
 * three booleans (`read`, `dismissed`) per id. That keeps server-driven content
 * fresh while still respecting the user's clicks across reloads.
 */
export function useNotifications(seed: Notification[] = []): NotificationsApi {
  const [stored, setStored] = useState<StoredState>(() => loadStored())

  // Cross-tab sync — if a user marks-all-read in one tab, reflect it in others.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setStored(loadStored())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Prod: hydrate the durable per-user state from the API once on mount and
  // merge it over the localStorage cache.
  useEffect(() => {
    if (!isProdBuild()) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/notifications', {
          credentials: 'include',
          headers: { accept: 'application/json' },
        })
        if (!res.ok || cancelled) return
        const json = (await res.json()) as {
          state?: Array<{ notificationId: string; read: boolean; dismissed: boolean }>
        }
        if (!json.state?.length || cancelled) return
        setStored((s) => {
          const meta = { ...s.meta }
          for (const row of json.state!) {
            meta[row.notificationId] = { read: row.read, dismissed: row.dismissed }
          }
          return { ...s, meta }
        })
      } catch {
        /* offline — localStorage cache stands in */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced persist.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => persistStored(stored), 80)
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [stored])

  const items = useMemo(() => {
    return seed
      .map((n) => ({
        ...n,
        read: stored.meta[n.id]?.read ?? n.read ?? false,
        dismissed: stored.meta[n.id]?.dismissed ?? n.dismissed ?? false,
      }))
      .filter((n) => !n.dismissed)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  }, [seed, stored])

  const unreadCount = useMemo(() => items.filter((n) => !n.read).length, [items])

  const markRead = useCallback((id: string) => {
    setStored((s) => ({
      ...s,
      meta: { ...s.meta, [id]: { ...s.meta[id], read: true } },
    }))
    postNotificationState({ id, read: true })
  }, [])

  const markAllRead = useCallback(() => {
    setStored((s) => {
      const next = { ...s.meta }
      for (const n of seed) next[n.id] = { ...next[n.id], read: true }
      return { ...s, meta: next }
    })
    postNotificationState({ ids: seed.map((n) => n.id), read: true })
  }, [seed])

  const dismiss = useCallback((id: string) => {
    setStored((s) => ({
      ...s,
      meta: { ...s.meta, [id]: { ...s.meta[id], dismissed: true } },
    }))
    postNotificationState({ id, dismissed: true })
  }, [])

  const dismissAll = useCallback(() => {
    setStored((s) => {
      const next = { ...s.meta }
      for (const n of seed) next[n.id] = { ...next[n.id], dismissed: true }
      return { ...s, meta: next }
    })
    postNotificationState({ ids: seed.map((n) => n.id), dismissed: true })
  }, [seed])

  return { items, unreadCount, markRead, markAllRead, dismiss, dismissAll }
}
