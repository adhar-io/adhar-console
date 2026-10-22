import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
 * When the feed is not live (no console database, or the request failed) the
 * hook returns an EMPTY list with `live: false` / `error` set — never seeded or
 * sample notifications. Surfaces render an honest "feed unavailable" state.
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
  /** The Plane support ticket this notification opened, commented on or resolved. */
  ticket?: { key?: string; url?: string; state?: 'open' | 'resolved' }
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

const FEED_KEY = ['notifications', 'feed'] as const
const POLL_MS = 30_000

function isProdBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { PROD?: boolean } }).env?.PROD)
  } catch {
    return false
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

/* ─────────── the hooks ─────────── */

export interface NotificationsApi {
  /** Visible notifications — non-dismissed, newest first. */
  items: Notification[]
  unreadCount: number
  total: number
  loading: boolean
  /** True when the server feed is live (DB-backed). When false, `items` is empty. */
  live: boolean
  /** Set when `/api/notifications` could not be reached (network / 5xx). */
  error: Error | null
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
 * Live feed of the latest notifications (polled), with actions. Nothing is
 * ever seeded: an unreachable or non-persisted feed yields an empty list.
 */
export function useNotifications(): NotificationsApi {
  const qc = useQueryClient()
  const prod = isProdBuild()

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
  const items = useMemo<Notification[]>(() => (live ? feed.data!.items : []), [live, feed.data])

  const unreadCount = live ? feed.data!.unread : 0
  const total = live ? feed.data!.total : 0

  // Arriving notifications are NOT toasted. They land in the feed this hook
  // already exposes, which the bell badge counts and the notification centre
  // lists, so nothing has to be appended by hand: the server pushes
  // `invalidate` over /api/live, the feed refetches, and both the count and the
  // list update from the same query. Toasts remain for things the user just did
  // (a save, a copy), where the feedback belongs next to the action.

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
      if (!live) return
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
    error: feed.error instanceof Error ? feed.error : feed.error ? new Error(String(feed.error)) : null,
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
/** Sources whose notifications carry platform evidence a support ticket can be built from. */
export function canOpenSupportTicket(n: Pick<Notification, 'kind' | 'source' | 'ticket'>): boolean {
  if (n.ticket?.url || n.ticket?.key) return false
  if (n.source === 'workspace' || n.source === 'user') return false
  return n.kind === 'error' || n.kind === 'warning'
}

export interface SupportTicketResult {
  ok: boolean
  outcome?: 'created' | 'commented' | 'exists' | 'suppressed' | 'resolved'
  ticket?: { key?: string; url?: string; state?: 'open' | 'resolved' }
  detail?: string
}

/**
 * "Create support ticket" — `POST /api/support/tickets {notificationId}`. The
 * server collects the logs, metrics, traces and delivery context and files
 * (or finds) the Plane work item; the feed then shows the ticket link.
 */
export function useCreateSupportTicket() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (notificationId: string): Promise<SupportTicketResult> => {
      const res = await fetch('/api/support/tickets', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ notificationId }),
      })
      const json = (await res.json().catch(() => ({}))) as SupportTicketResult & { error?: string }
      if (!res.ok || !json.ok) throw new Error(json.detail ?? json.error ?? `HTTP ${res.status}`)
      return json
    },
    onSettled: () => qc.invalidateQueries({ queryKey: FEED_KEY }),
  })
}

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
