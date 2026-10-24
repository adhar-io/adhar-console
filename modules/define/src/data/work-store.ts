import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore, DocStoreError, type StoredDoc } from '@adhar/shell-ui'

/**
 * Console-side work-item data — everything Plane's public API cannot store.
 *
 * Kept in the console's tenant document store (`/api/store/<kind>`), keyed by
 * Plane ids, and always labelled "console-side" in the UI: Plane never sees
 * it, and Plane's own UI will not show it.
 *
 *   define.view         saved WQL views (shared or personal, starred)
 *   define.viewdefault  the default view per project      (id = project id)
 *   define.wip          board WIP limits per project       (id = project id)
 *   define.checklist    Trello-style checklists per item   (id = issue id)
 *   define.worklog      time tracking per item             (id = issue id)
 *   define.template     work-item templates
 *   define.sprint       sprint capacity + goal per cycle   (id = cycle id)
 *   define.watch        watchers per item                  (id = issue id)
 */

export const KINDS = {
  view: 'define.view',
  viewDefault: 'define.viewdefault',
  wip: 'define.wip',
  checklist: 'define.checklist',
  worklog: 'define.worklog',
  template: 'define.template',
  sprint: 'define.sprint',
  watch: 'define.watch',
} as const
export type Kind = (typeof KINDS)[keyof typeof KINDS]

export interface SavedView {
  name: string
  description?: string
  /** null → a cross-project view (its WQL names the projects). */
  projectId: string | null
  jql: string
  layout: 'list' | 'board'
  groupBy?: string
  columns?: string[]
  swimlane?: string
  visibility: 'shared' | 'personal'
  /** Console user email of the author. */
  owner: string
  ownerName?: string
  /** Console user emails who starred it. */
  starredBy: string[]
}

export interface ViewDefault {
  viewId: string
}

export interface WipDoc {
  projectId: string
  /** Column id (state id or `group:<name>`) → limit. */
  limits: Record<string, number>
}

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}
export interface ChecklistDoc {
  projectId: string
  issueId: string
  lists: Array<{ id: string; title: string; items: ChecklistItem[] }>
}

export interface WorklogEntry {
  id: string
  minutes: number
  note?: string
  /** YYYY-MM-DD the work was done. */
  date: string
  by: string
  byName?: string
}
export interface WorklogDoc {
  projectId: string
  issueId: string
  originalMinutes?: number | null
  remainingMinutes?: number | null
  entries: WorklogEntry[]
}

export type TemplateType = 'bug' | 'story' | 'task' | 'spike' | 'custom'
export type RequiredField = 'description' | 'priority' | 'assignee' | 'estimate' | 'due' | 'labels'
export interface TemplateDoc {
  name: string
  type: TemplateType
  projectId: string | null
  title?: string
  /** Markdown body, converted to Plane HTML on create. */
  description_md?: string
  priority?: string
  labelNames?: string[]
  required: RequiredField[]
}

export interface SprintDoc {
  projectId: string
  capacity: number | null
  goal?: string
}

export interface WatchDoc {
  projectId: string
  issueId: string
  watchers: Array<{ email: string; name?: string }>
}

/** Templates the console ships with (editable copies can be saved per project). */
export const BUILTIN_TEMPLATES: Array<TemplateDoc & { id: string }> = [
  {
    id: 'builtin-bug',
    name: 'Bug',
    type: 'bug',
    projectId: null,
    title: '',
    description_md: '## Steps to reproduce\n1. \n\n## Expected\n\n## Actual\n\n## Environment\n',
    priority: 'high',
    labelNames: ['bug'],
    required: ['description', 'priority'],
  },
  {
    id: 'builtin-story',
    name: 'Story',
    type: 'story',
    projectId: null,
    description_md: 'As a **<role>**, I want **<capability>** so that **<benefit>**.\n\n## Acceptance criteria\n- [ ] \n',
    priority: 'medium',
    labelNames: ['story', 'feature'],
    required: ['description'],
  },
  { id: 'builtin-task', name: 'Task', type: 'task', projectId: null, description_md: '', priority: 'none', labelNames: ['task'], required: [] },
  {
    id: 'builtin-spike',
    name: 'Spike',
    type: 'spike',
    projectId: null,
    description_md: '## Question to answer\n\n## Time box\n\n## Findings\n',
    priority: 'medium',
    labelNames: ['spike', 'research'],
    required: ['description', 'due'],
  },
]

/** A sentence for a document-store failure. */
export function storeError(e: unknown): string {
  if (e instanceof DocStoreError) {
    if (e.code === 'store_unavailable' || e.status === 503) {
      return "The console database isn't configured, so console-side data (saved views, checklists, worklogs, WIP limits, templates, sprint capacity) can't be stored."
    }
    if (e.status === 401 || e.status === 403) return "You don't have access to the console's document store."
    return e.message
  }
  return e instanceof Error ? e.message : 'Console store request failed.'
}

const qk = (kind: Kind) => ['define-store', kind] as const

/** Every document of a kind (one request, shared by all components). */
export function useDocs<T>(kind: Kind, enabled = true) {
  return useQuery({
    queryKey: qk(kind),
    queryFn: () => docStore.list<T>(kind),
    enabled,
    // The console's own Postgres store: documents change by someone saving
    // them, and our own writes update this cache (optimistically, then
    // invalidate). Read on open; no timer.
    staleTime: 60_000,
    retry: (n, e) => !(e instanceof DocStoreError && (e.status === 503 || e.status === 401 || e.status === 403 || e.code === 'store_unavailable')) && n < 2,
  })
}

/** One document by id out of the kind's list (undefined until loaded / when absent). */
export function useDocById<T>(kind: Kind, id: string | undefined) {
  const q = useDocs<T>(kind, !!id)
  return { ...q, doc: id ? q.data?.find((d) => d.id === id) : undefined }
}

/** Upsert with an optimistic cache update; `merge` reads the freshest copy first. */
export function usePutDoc<T>(kind: Kind) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; data: T } | { id: string; update(prev: T | undefined): T }) => {
      let data: T
      if ('update' in v) {
        const fresh = await docStore.get<T>(kind, v.id)
        data = v.update(fresh?.data)
      } else data = v.data
      return docStore.put<T>(kind, v.id, data)
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk(kind) })
      const prev = qc.getQueryData<StoredDoc<T>[]>(qk(kind))
      if (prev) {
        const cur = prev.find((d) => d.id === v.id)
        const data = 'update' in v ? v.update(cur?.data) : v.data
        const now = new Date().toISOString()
        const next = cur ? prev.map((d) => (d.id === v.id ? { ...d, data, updatedAt: now } : d)) : [...prev, { id: v.id, data, createdBy: null, updatedBy: null, createdAt: now, updatedAt: now }]
        qc.setQueryData(qk(kind), next)
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk(kind), ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk(kind) }),
  })
}

/** Create with a server-assigned id. */
export function useCreateDoc<T>(kind: Kind) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: T) => docStore.create<T>(kind, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk(kind) }),
  })
}

export function useRemoveDoc(kind: Kind) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => docStore.remove(kind, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk(kind) })
      const prev = qc.getQueryData<StoredDoc<unknown>[]>(qk(kind))
      if (prev) qc.setQueryData(qk(kind), prev.filter((d) => d.id !== id))
      return { prev }
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk(kind), ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk(kind) }),
  })
}

/** A short random id for nested items (checklist items, worklog entries). */
export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export { checklistProgress, formatMinutes, parseDuration } from './work-time.ts'
