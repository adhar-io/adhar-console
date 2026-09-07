import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useToast } from './toast.tsx'
import { useLiveInvalidate, usePollingInterval } from './live.ts'

/**
 * Notification Center — client side.
 *
 * The feed is server-backed (`/api/notifications`): every workspace mutation,
 * platform insight (Warning-event bursts, Argo CD drift, policy failures,
 * expiring certificates), Adhar AI proposal / diagnosis and any
 * client-created notice lands there, per tenant, with per-user read /
 * dismissed state. The hook polls, exposes actions, and toasts NEW
 * high-signal items as they arrive (once per browser, however many
 * components consume the hook).
 *
 * Dev / offline: falls back to the seed the route loader supplies plus a
 * localStorage cache of read/dismissed flags, so the UI stays usable.
 */

export type NotificationKind = 'info' | 'warning' | 'error' | 'success' | 'insight'
export type NotificationSource = 'workspace' | 'platform' | 'gitops' | 'policy' | 'security' | 'ai' | 'system' | 'user'

export interface Notification {
  id: string
  title: string
  description?: string
  /** ISO 8601 timestamp. */
  at: string
  kind: NotificationKind
  source?: NotificationSource
  severity?: 'low' | 'medium' | 'high' | 'critical'
  read?: boolean
  /** Optional deep link — rendered as a subtle link chevron on the row. */
  href?: string
  /** Dismissing a notification removes it from the list permanently. */
  dismissed?: boolean
  /** Suggested Adhar AI prompt. */
  prompt?: string
  target?: { type: string; id: string; label: string }
  actor?: { id: string; label: string }
}

export interface NotificationInput {
  title: string
  description?: string
  kind?: NotificationKind
  source?: NotificationSource
  href?: string
  key?: string
  severity?: Notification['severity']
  prompt?: string
  target?: Notification['target']
  /** Visible to everyone in the tenant (default: only you). */
  broadcast?: boolean
}

export interface NotificationPage {
  items: Notification[]
  total: number
  unread: number
  persisted?: boolean
}

export interface FeedParams {
  limit?: number
  offset?: number
  kind?: NotificationKind | ''
  source?: NotificationSource | ''
  unread?: boolean
  q?: string
}

const STORAGE_KEY = 'adhar.notifications'
const FEED_KEY = ['notifications', 'feed'] as const
const POLL_MS = 30_000

function isProdBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { PROD?: boolean } }).env?.PROD)
  } catch {
    return false
  }
}

/* ─────────── local fallback state (dev / offline) ─────────── */

interface StoredState {
  meta: Record<string, { read?: boolean; dismissed?: boolean }>
}
function loadStored(): StoredState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as StoredState) : null
    return parsed && typeof parsed === 'object' && parsed.meta ? parsed : { meta: {} }
  } catch {
    return { meta: {} }
  }
}
function persistStored(state: StoredState) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

/* ─────────── fetch helpers ─────────── */

function qs(p: FeedParams): string {
  const s = new URLSearchParams()
  if (p.limit) s.set('limit', String(p.limit))
  if (p.offset) s.set('offset', String(p.offset))
  if (p.kind) s.set('kind', p.kind)
  if (p.source) s.set('source', p.source)
  if (p.unread) s.set('unread', '1')
  if (p.q?.trim()) s.set('q', p.q.trim())
  const out = s.toString()
  return out ? `?${out}` : ''
}

async function fetchFeed(p: FeedParams): Promise<NotificationPage> {
  const res = await fetch(`/api/notifications${qs(p)}`, { credentials: 'include', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`notifications ${res.status}`)
  const json = (await res.json()) as NotificationPage & { state?: unknown }
  // Legacy shape guard (state-only servers) → treat as empty persisted feed.
  if (!Array.isArray(json.items)) return { items: [], total: 0, unread: 0, persisted: false }
  return json
}

function postJson(body: unknown): Promise<Response> {
  return fetch('/api/notifications', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  })
}

/* ─────────── new-arrival toasts (module-level so it fires once) ─────────── */

let lastSeenAt: string | null = null
let seenIds = new Set<string>()

function pickNewArrivals(items: Notification[]): Notification[] {
  if (lastSeenAt === null) {
    // First load: baseline, don't toast history.
    lastSeenAt = items[0]?.at ?? new Date(0).toISOString()
    seenIds = new Set(items.map((n) => n.id))
    return []
  }
  const fresh = items.filter((n) => !seenIds.has(n.id) && !n.read && n.at > lastSeenAt!)
  for (const n of items) seenIds.add(n.id)
  if (items[0]?.at && items[0].at > lastSeenAt) lastSeenAt = items[0].at
  return fresh
}

/* ─────────── the hooks ─────────── */

export interface NotificationsApi {
  /** Visible notifications — non-dismissed, newest first. */
  items: Notification[]
  unreadCount: number
  total: number
  loading: boolean
  /** True when the server feed is live (DB-backed); false on seed fallback. */
  live: boolean
  markRead(id: string): void
  markAllRead(): void
  dismiss(id: string): void
  dismissAll(): void
  refresh(): void
  /** Run the insights scan (RBAC-scoped). Resolves the number created, or null when unavailable. */
  scan(force?: boolean): Promise<number | null>
  /** Create a notification (private to you unless `broadcast`). */
  notify(input: NotificationInput): Promise<boolean>
  scanning: boolean
}

/**
 * Live feed of the latest notifications (polled), with actions. Pass the
 * route loader's `seed` to keep dev / offline builds populated.
 */
export function useNotifications(seed: Notification[] = []): NotificationsApi {
  const qc = useQueryClient()
  const toast = useToast()
  const prod = isProdBuild()
  const storedRef = useRef<StoredState>(loadStored())

  // Server pushes `invalidate` over /api/live when the tenant's newest
  // notification changes; the 30 s poll only runs while the socket is down.
  useLiveInvalidate('notifications', {}, [FEED_KEY as unknown as string[]], prod)
  const feed = useQuery<NotificationPage>({
    queryKey: [...FEED_KEY, { limit: 50 }],
    queryFn: () => fetchFeed({ limit: 50 }),
    refetchInterval: usePollingInterval(POLL_MS),
    staleTime: 10_000,
    retry: 1,
    enabled: prod || typeof fetch !== 'undefined',
  })

  const live = !!feed.data?.persisted
  const items = useMemo<Notification[]>(() => {
    if (live) return feed.data!.items
    const meta = storedRef.current.meta
    return seed
      .map((n) => ({ ...n, read: meta[n.id]?.read ?? n.read ?? false, dismissed: meta[n.id]?.dismissed ?? n.dismissed ?? false }))
      .filter((n) => !n.dismissed)
      .sort((a, b) => b.at.localeCompare(a.at))
  }, [live, feed.data, seed])

  const unreadCount = live ? feed.data!.unread : items.filter((n) => !n.read).length
  const total = live ? feed.data!.total : items.length

  // Toast newly arrived high-signal items (once per browser).
  useEffect(() => {
    if (!live) return
    const fresh = pickNewArrivals(feed.data!.items)
    for (const n of fresh.slice(0, 3)) {
      const fn = n.kind === 'error' ? toast.error : n.kind === 'warning' ? toast.warning : n.kind === 'insight' ? toast.info : n.kind === 'success' ? toast.success : toast.info
      fn(n.title, {
        description: n.description,
        action: n.href ? { label: 'View', onClick: () => globalThis.location.assign(n.href!) } : undefined,
        duration: n.kind === 'error' ? 9000 : 6000,
      })
    }
  }, [feed.data, live, toast])

  const setLocal = (id: string, patch: { read?: boolean; dismissed?: boolean }) => {
    const st = storedRef.current
    st.meta[id] = { ...st.meta[id], ...patch }
    persistStored(st)
  }

  const optimistic = useCallback(
    (ids: string[], patch: { read?: boolean; dismissed?: boolean }) => {
      qc.setQueriesData<NotificationPage>({ queryKey: FEED_KEY }, (prev) => {
        if (!prev) return prev
        const set = new Set(ids)
        const items = prev.items.map((n) => (set.has(n.id) ? { ...n, ...patch } : n)).filter((n) => !n.dismissed)
        return { ...prev, items, unread: items.filter((n) => !n.read).length, total: patch.dismissed ? Math.max(0, prev.total - ids.length) : prev.total }
      })
    },
    [qc],
  )

  const state = useMutation({
    mutationFn: async (v: { ids: string[]; read?: boolean; dismissed?: boolean }) => {
      if (!live) {
        for (const id of v.ids) setLocal(id, { read: v.read, dismissed: v.dismissed })
        return
      }
      await postJson(v.ids.length === 1 ? { id: v.ids[0], read: v.read, dismissed: v.dismissed } : { ids: v.ids, read: v.read, dismissed: v.dismissed })
    },
    onMutate: (v) => optimistic(v.ids, { read: v.read, dismissed: v.dismissed }),
    onSettled: () => qc.invalidateQueries({ queryKey: FEED_KEY }),
  })

  const scanM = useMutation({
    mutationFn: async (force: boolean) => {
      const res = await fetch(`/api/notifications/scan${force ? '?force=1' : ''}`, { method: 'POST', credentials: 'include', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`scan ${res.status}`)
      return (await res.json()) as { ok: boolean; created?: number; skipped?: boolean }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: FEED_KEY }),
  })

  const notifyM = useMutation({
    mutationFn: async (input: NotificationInput) => {
      const res = await postJson(input)
      if (!res.ok) throw new Error(`notify ${res.status}`)
      return true
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: FEED_KEY }),
  })

  const ids = useMemo(() => items.map((n) => n.id), [items])
  const unreadIds = useMemo(() => items.filter((n) => !n.read).map((n) => n.id), [items])

  return {
    items,
    unreadCount,
    total,
    loading: feed.isLoading && !feed.data,
    live,
    markRead: (id) => state.mutate({ ids: [id], read: true }),
    markAllRead: () => unreadIds.length && state.mutate({ ids: unreadIds, read: true }),
    dismiss: (id) => state.mutate({ ids: [id], dismissed: true }),
    dismissAll: () => ids.length && state.mutate({ ids, dismissed: true }),
    refresh: () => void qc.invalidateQueries({ queryKey: FEED_KEY }),
    scan: async (force = false) => {
      try {
        const r = await scanM.mutateAsync(force)
        return r.skipped ? 0 : r.created ?? 0
      } catch {
        return null
      }
    },
    notify: async (input) => {
      try {
        return await notifyM.mutateAsync(input)
      } catch {
        return false
      }
    },
    scanning: scanM.isPending,
  }
}

/** Paged, filtered feed for the Notification Center page. */
export function useNotificationFeed(params: FeedParams) {
  return useQuery<NotificationPage>({
    queryKey: [...FEED_KEY, 'page', params],
    queryFn: () => fetchFeed(params),
    placeholderData: (prev) => prev,
    refetchInterval: usePollingInterval(POLL_MS),
    staleTime: 10_000,
    retry: 1,
  })
}

/* ─────────── presentation helpers ─────────── */

export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  info: 'Info',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
  insight: 'Insight',
}

export const NOTIFICATION_SOURCE_LABEL: Record<NotificationSource, string> = {
  workspace: 'Workspace',
  platform: 'Platform',
  gitops: 'GitOps',
  policy: 'Policy',
  security: 'Security',
  ai: 'Adhar AI',
  system: 'System',
  user: 'You',
}

/** Tailwind classes for the kind dot / accent. */
export function notificationTone(kind: NotificationKind): { dot: string; bg: string; text: string } {
  switch (kind) {
    case 'error':
      return { dot: 'bg-rose-500', bg: 'bg-rose-50 dark:bg-rose-500/10', text: 'text-rose-700 dark:text-rose-300' }
    case 'warning':
      return { dot: 'bg-amber-500', bg: 'bg-amber-50 dark:bg-amber-500/10', text: 'text-amber-700 dark:text-amber-300' }
    case 'success':
      return { dot: 'bg-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-300' }
    case 'insight':
      return { dot: 'bg-violet-500', bg: 'bg-violet-50 dark:bg-violet-500/10', text: 'text-violet-700 dark:text-violet-300' }
    default:
      return { dot: 'bg-sky-500', bg: 'bg-sky-50 dark:bg-sky-500/10', text: 'text-sky-700 dark:text-sky-300' }
  }
}
