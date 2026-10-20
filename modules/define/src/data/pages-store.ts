import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore, type StoredDoc, useOptionalUser } from '@adhar/shell-ui'
import { extractIssueRefs, extractMentions, type PageMeta, plainText } from './pages-model.ts'

/**
 * Define Pages persistence — console-side, because Plane 1.4's public API has
 * no pages endpoints. Four docStore kinds:
 *
 *   define.page           page metadata + version log (listed per tenant; small)
 *   define.page-body      current markdown body, one doc per page (read on open)
 *   define.page-version   immutable snapshots `<pageId>.v<n>` (read on demand)
 *   define.page-comments  a page's comment thread
 *   define.page-settings  per project: the Gitea repo pages export to
 *
 * Saves are optimistic-concurrency checked: the editor remembers the version
 * it started from and a save is refused when someone else saved since, so a
 * concurrent edit is never silently overwritten.
 */

export const PAGE_KIND = 'define.page'
const BODY_KIND = 'define.page-body'
const VERSION_KIND = 'define.page-version'
const COMMENTS_KIND = 'define.page-comments'
const SETTINGS_KIND = 'define.page-settings'
const EXCERPT_CHARS = 4000
const HISTORY_CAP = 200

export type PageData = Omit<PageMeta, 'id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'>

function fromDoc(d: StoredDoc<PageData>): PageMeta {
  return {
    ...d.data,
    history: d.data.history ?? [],
    id: d.id,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    createdBy: d.createdBy,
    updatedBy: d.updatedBy,
  }
}

function toData(p: PageMeta | PageData): PageData {
  const { id: _i, createdAt: _c, updatedAt: _u, createdBy: _cb, updatedBy: _ub, ...rest } = p as PageMeta
  return rest
}

export class PageConflictError extends Error {
  constructor(readonly latest: PageMeta) {
    super(`${latest.updatedByName ?? 'Someone'} saved a newer version (v${latest.version}) while you were editing.`)
    this.name = 'PageConflictError'
  }
}

const LIST_KEY = ['define', 'pages'] as const

/** Every page of the tenant (metadata only); views filter by project. */
export function useAllPages() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => (await docStore.list<PageData>(PAGE_KIND)).map(fromDoc),
    staleTime: 30_000,
    retry: false,
  })
}

export function usePageBody(id: string | undefined) {
  return useQuery({
    queryKey: ['define', 'page-body', id],
    queryFn: async () => (await docStore.get<{ body: string; version: number }>(BODY_KIND, id!))?.data ?? { body: '', version: 0 },
    enabled: !!id,
    staleTime: 15_000,
    retry: false,
  })
}

export function usePageVersion(id: string | undefined, v: number | undefined) {
  return useQuery({
    queryKey: ['define', 'page-version', id, v],
    queryFn: async () => (await docStore.get<{ body: string; title: string; v: number }>(VERSION_KIND, `${id}.v${v}`))?.data ?? null,
    enabled: !!id && !!v,
    staleTime: Infinity,
    retry: false,
  })
}

function metaFor(body: string, issueKeys?: Set<string>) {
  return {
    excerpt: plainText(body).slice(0, EXCERPT_CHARS),
    mentions: extractMentions(body),
    issueRefs: extractIssueRefs(body, issueKeys),
  }
}

export function usePageMutations() {
  const qc = useQueryClient()
  const user = useOptionalUser()
  const by = user?.name
  const refresh = (id?: string) => {
    qc.invalidateQueries({ queryKey: LIST_KEY })
    if (id) qc.invalidateQueries({ queryKey: ['define', 'page-body', id] })
  }
  const patchList = (p: PageMeta) => qc.setQueryData<PageMeta[]>(LIST_KEY, (old) => (old ? old.some((x) => x.id === p.id) ? old.map((x) => (x.id === p.id ? p : x)) : [...old, p] : old))

  return {
    create: useMutation({
      mutationFn: async (v: { project: string; parent: string | null; title: string; body: string; template?: string; order: number; published?: boolean }) => {
        const now = new Date().toISOString()
        const data: PageData = {
          project: v.project,
          parent: v.parent,
          title: v.title,
          order: v.order,
          version: 1,
          template: v.template,
          published: v.published ?? true,
          updatedByName: by,
          history: [{ v: 1, at: now, by, title: v.title, chars: v.body.length, note: 'Created' }],
          ...metaFor(v.body),
        }
        const doc = fromDoc(await docStore.create<PageData>(PAGE_KIND, data))
        await Promise.all([
          docStore.put(BODY_KIND, doc.id, { body: v.body, version: 1 }),
          docStore.put(VERSION_KIND, `${doc.id}.v1`, { body: v.body, title: v.title, v: 1 }),
        ])
        return doc
      },
      onSuccess: (p) => {
        patchList(p)
        refresh()
      },
    }),

    /** Save a new version of the body (and title). Refuses on a concurrent save. */
    save: useMutation({
      mutationFn: async (v: { page: PageMeta; title: string; body: string; baseVersion: number; note?: string; issueKeys?: Set<string>; force?: boolean }) => {
        const fresh = await docStore.get<PageData>(PAGE_KIND, v.page.id)
        if (!fresh) throw new Error('This page was deleted.')
        const latest = fromDoc(fresh)
        if (latest.version !== v.baseVersion && !v.force) throw new PageConflictError(latest)
        if (latest.locked && !v.force) throw new Error('This page is locked. Unlock it to edit.')
        const next = latest.version + 1
        const at = new Date().toISOString()
        await docStore.put(VERSION_KIND, `${latest.id}.v${next}`, { body: v.body, title: v.title, v: next })
        await docStore.put(BODY_KIND, latest.id, { body: v.body, version: next })
        const meta: PageData = {
          ...toData(latest),
          title: v.title,
          version: next,
          updatedByName: by,
          history: [...latest.history, { v: next, at, by, title: v.title, chars: v.body.length, note: v.note }].slice(-HISTORY_CAP),
          ...metaFor(v.body, v.issueKeys),
        }
        return fromDoc(await docStore.put<PageData>(PAGE_KIND, latest.id, meta))
      },
      onSuccess: (p, v) => {
        patchList(p)
        qc.setQueryData(['define', 'page-body', p.id], { body: v.body, version: p.version })
        qc.invalidateQueries({ queryKey: LIST_KEY })
      },
    }),

    /** Metadata-only change: rename, move, reorder, lock, publish, archive. */
    update: useMutation({
      mutationFn: async (v: { page: PageMeta; patch: Partial<PageData> }) => {
        const fresh = await docStore.get<PageData>(PAGE_KIND, v.page.id)
        if (!fresh) throw new Error('This page was deleted.')
        return fromDoc(await docStore.put<PageData>(PAGE_KIND, v.page.id, { ...toData(fromDoc(fresh)), ...v.patch }))
      },
      onMutate: (v) => {
        const prev = qc.getQueryData<PageMeta[]>(LIST_KEY)
        patchList({ ...v.page, ...v.patch })
        return { prev }
      },
      onError: (_e, _v, ctx) => {
        if (ctx?.prev) qc.setQueryData(LIST_KEY, ctx.prev)
      },
      onSettled: () => refresh(),
    }),

    remove: useMutation({
      mutationFn: async (v: { pages: PageMeta[] }) => {
        for (const p of v.pages) {
          await docStore.remove(PAGE_KIND, p.id)
          await docStore.remove(BODY_KIND, p.id).catch(() => false)
          await docStore.remove(COMMENTS_KIND, p.id).catch(() => false)
          for (const h of p.history) await docStore.remove(VERSION_KIND, `${p.id}.v${h.v}`).catch(() => false)
        }
      },
      onSuccess: () => refresh(),
    }),
  }
}

/* ───── comments ───── */

export interface PageComment {
  id: string
  at: string
  by?: string
  byId?: string
  body: string
  /** Quoted text the comment is about (optional). */
  quote?: string
  resolved?: boolean
}

export function usePageComments(pageId: string | undefined) {
  const qc = useQueryClient()
  const user = useOptionalUser()
  const key = ['define', 'page-comments', pageId]
  const q = useQuery({
    queryKey: key,
    enabled: !!pageId,
    queryFn: async () => (await docStore.get<{ comments: PageComment[] }>(COMMENTS_KIND, pageId!))?.data.comments ?? [],
    staleTime: 15_000,
    retry: false,
  })
  const write = useMutation({
    mutationFn: async (fn: (cur: PageComment[]) => PageComment[]) => {
      const cur = (await docStore.get<{ comments: PageComment[] }>(COMMENTS_KIND, pageId!))?.data.comments ?? []
      const next = fn(cur)
      await docStore.put(COMMENTS_KIND, pageId!, { comments: next })
      return next
    },
    onSuccess: (next) => qc.setQueryData(key, next),
  })
  return {
    ...q,
    add: (body: string, quote?: string) =>
      write.mutateAsync((cur) => [...cur, { id: `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), by: user?.name, byId: user?.id, body, quote }]),
    resolve: (id: string, resolved: boolean) => write.mutateAsync((cur) => cur.map((c) => (c.id === id ? { ...c, resolved } : c))),
    remove: (id: string) => write.mutateAsync((cur) => cur.filter((c) => c.id !== id)),
    pending: write.isPending,
    userId: user?.id,
  }
}

/* ───── project → repo link (for "export as PR") ───── */

export interface PageRepoSettings {
  repo: string
  branch: string
  folder: string
}

export function usePageSettings(projectId: string | undefined) {
  const qc = useQueryClient()
  const key = ['define', 'page-settings', projectId]
  const q = useQuery({
    queryKey: key,
    enabled: !!projectId,
    queryFn: async () => (await docStore.get<PageRepoSettings>(SETTINGS_KIND, projectId!))?.data ?? null,
    staleTime: 60_000,
    retry: false,
  })
  const save = useMutation({
    mutationFn: (s: PageRepoSettings | null) => (s ? docStore.put(SETTINGS_KIND, projectId!, s).then(() => s) : docStore.remove(SETTINGS_KIND, projectId!).then(() => null)),
    onSuccess: (s) => qc.setQueryData(key, s),
  })
  return { ...q, save }
}
