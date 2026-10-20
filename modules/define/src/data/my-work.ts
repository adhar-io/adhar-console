import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { plane } from '@adhar/api-clients'
import { docStore, useOptionalUser, usePlaneWorkspace } from '@adhar/shell-ui'
import { planeClient } from './plane.ts'
import { DAY, type WorkItem } from './insights-math.ts'

/**
 * My Work's console-side pieces.
 *
 *   • Watching — Plane's issue subscriptions are not in its public API, so a
 *     watch list is kept per console user in docStore (`define.watch`).
 *   • Recently viewed — per browser (localStorage); recorded whenever an
 *     issue is opened from Define's dashboard, My Work or Reports.
 *   • Mentions — Plane has no mention feed in its public API. On request, the
 *     comments of the most recently updated issues are scanned for the user's
 *     Plane id (Plane's editor stores mentions as
 *     `<mention-component entity_identifier="<user id>">`) or `@display name`.
 */

/* ───── watching ───── */

export interface WatchEntry {
  project: string
  id: string
  key: string
  name: string
  at: string
}

const WATCH_KIND = 'define.watch'
const watchId = (userId: string) => `u-${userId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120)

export function useWatchList() {
  const user = useOptionalUser()
  const qc = useQueryClient()
  const key = ['define', 'watch', user?.id]
  const q = useQuery({
    queryKey: key,
    enabled: !!user,
    queryFn: async () => (await docStore.get<{ issues: WatchEntry[] }>(WATCH_KIND, watchId(user!.id)))?.data.issues ?? [],
    staleTime: 60_000,
    retry: false,
  })
  const toggle = useMutation({
    mutationFn: async (item: Pick<WorkItem, 'project' | 'id' | 'key' | 'name'>) => {
      const cur = (await docStore.get<{ issues: WatchEntry[] }>(WATCH_KIND, watchId(user!.id)))?.data.issues ?? []
      const on = cur.some((w) => w.id === item.id)
      const next = on ? cur.filter((w) => w.id !== item.id) : [...cur, { project: item.project, id: item.id, key: item.key, name: item.name, at: new Date().toISOString() }]
      await docStore.put(WATCH_KIND, watchId(user!.id), { issues: next.slice(-200) })
      return { next, on: !on }
    },
    onSuccess: ({ next }) => qc.setQueryData(key, next),
  })
  return { ...q, toggle, ids: new Set((q.data ?? []).map((w) => w.id)) }
}

/* ───── recently viewed ───── */

export interface RecentEntry {
  project: string
  id: string
  key?: string
  name?: string
  at: number
}

const RECENT = 'adhar.define.recent'
const RECENT_EVENT = 'adhar:define-recent'

export function recordRecent(e: Omit<RecentEntry, 'at'>) {
  try {
    const cur = JSON.parse(localStorage.getItem(RECENT) ?? '[]') as RecentEntry[]
    const next = [{ ...e, at: Date.now() }, ...cur.filter((x) => x.id !== e.id)].slice(0, 30)
    localStorage.setItem(RECENT, JSON.stringify(next))
    globalThis.dispatchEvent(new Event(RECENT_EVENT))
  } catch { /* private mode */ }
}

export function useRecentlyViewed(): RecentEntry[] {
  const read = useCallback((): RecentEntry[] => {
    try {
      return JSON.parse(localStorage.getItem(RECENT) ?? '[]') as RecentEntry[]
    } catch {
      return []
    }
  }, [])
  const [list, setList] = useState(read)
  useEffect(() => {
    const sync = () => setList(read())
    globalThis.addEventListener(RECENT_EVENT, sync)
    globalThis.addEventListener('storage', sync)
    return () => {
      globalThis.removeEventListener(RECENT_EVENT, sync)
      globalThis.removeEventListener('storage', sync)
    }
  }, [read])
  return list
}

/* ───── mentions (on-request comment scan) ───── */

export const MENTION_SCAN_LIMIT = 15

export function mentionsMe(c: plane.Comment, planeId: string, displayName?: string): boolean {
  const html = c.comment_html ?? ''
  if (html.includes(planeId)) return true
  if (!displayName) return false
  const esc = displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${esc}\\b`, 'i').test(c.comment_stripped ?? html.replace(/<[^>]+>/g, ' '))
}

export interface MentionHit {
  item: WorkItem
  comment: plane.Comment
}

/**
 * Scan the comments of up to MENTION_SCAN_LIMIT issues updated in the last
 * 14 days, two at a time, reusing (and filling) the issue drawer's comment
 * cache. Runs only when `enabled` — the view asks first.
 */
export function useMentionScan(items: WorkItem[], planeId: string | undefined, displayName: string | undefined, enabled: boolean, now: number) {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const candidates = items
    .filter((i) => i.updatedAt >= now - 14 * DAY)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MENTION_SCAN_LIMIT)
  const [done, setDone] = useState(0)
  const q = useQuery({
    queryKey: ['define', 'mentions', slug, planeId, candidates.map((c) => c.id).join(',')],
    enabled: enabled && !!planeId && candidates.length > 0,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const hits: MentionHit[] = []
      const queue = [...candidates]
      let n = 0
      const worker = async () => {
        while (queue.length) {
          const item = queue.shift()!
          const k = ['plane', 'comments', slug, item.project, item.id]
          let rows = qc.getQueryData<plane.Comment[]>(k)
          if (!rows) {
            rows = await planeClient.listComments(slug, item.project, item.id)
            qc.setQueryData(k, rows)
          }
          for (const c of rows) if (mentionsMe(c, planeId!, displayName)) hits.push({ item, comment: c })
          setDone(++n)
        }
      }
      await Promise.all([worker(), worker()])
      return hits.sort((a, b) => b.comment.created_at.localeCompare(a.comment.created_at))
    },
  })
  return { ...q, scanned: done, candidates: candidates.length }
}
