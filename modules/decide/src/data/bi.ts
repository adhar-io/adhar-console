import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { metabase } from '@adhar/api-clients'

/**
 * Metabase BI hooks — REAL. `MetabaseClient.auto` is real by default: it talks
 * to the live Metabase instance through the console BFF proxy
 * (`/api/svc/metabase/…`, service-authenticated by the server; no client
 * token). There is no synthesized fallback here — when Metabase isn't
 * configured or is unreachable the proxy errors and these queries surface it,
 * so the BI surfaces (dashboards, questions, SQL editor, databases, pulses)
 * render an honest "Metabase not connected" state (see `bi-states.tsx`) rather
 * than fabricated data. `retry: false` keeps that state prompt instead of
 * spinning through retries.
 */

export const metabaseClient = metabase.MetabaseClient.auto({ tool: 'metabase' })

export function useDatabases() {
  return useQuery({
    queryKey: ['metabase', 'databases'],
    queryFn: () => metabaseClient.listDatabases(),
    staleTime: 60_000,
    retry: false,
  })
}

export function useCollections() {
  return useQuery({
    queryKey: ['metabase', 'collections'],
    queryFn: () => metabaseClient.listCollections(),
    staleTime: 60_000,
    retry: false,
  })
}

export function useQuestions(collectionId?: number) {
  return useQuery({
    queryKey: ['metabase', 'questions', collectionId ?? 'all'],
    queryFn: () => metabaseClient.listQuestions(collectionId ? { collectionId } : undefined),
    staleTime: 30_000,
    retry: false,
  })
}

export function useQuestion(id?: number) {
  return useQuery({
    queryKey: ['metabase', 'question', id],
    queryFn: () => metabaseClient.getQuestion(id!),
    enabled: !!id,
    staleTime: 30_000,
    retry: false,
  })
}

export function useDashboards() {
  return useQuery({
    queryKey: ['metabase', 'dashboards'],
    queryFn: () => metabaseClient.listDashboards(),
    staleTime: 30_000,
    retry: false,
  })
}

export function useDashboard(id?: number) {
  return useQuery({
    queryKey: ['metabase', 'dashboard', id],
    queryFn: () => metabaseClient.getDashboard(id!),
    enabled: !!id,
    staleTime: 30_000,
    retry: false,
  })
}

export function usePulses() {
  return useQuery({
    queryKey: ['metabase', 'pulses'],
    queryFn: () => metabaseClient.listPulses(),
    staleTime: 30_000,
    retry: false,
  })
}

export function useTogglePulse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      metabaseClient.togglePulse(id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['metabase', 'pulses'] }),
  })
}

export function useRunQuery() {
  return useMutation({
    mutationFn: ({ databaseId, sql }: { databaseId: number; sql: string }) =>
      metabaseClient.runQuery(databaseId, sql),
  })
}

/* ───────────────────────── Metabase 0.51 wire-shaped hooks ─────────────────────────
 *
 * Used by the rebuilt BI views. They read Metabase's own shapes
 * (`metabase.Mb*`) rather than the legacy summary model above, which the
 * Overview still uses. Lists refresh silently in the background (stale data
 * stays on screen while a refetch runs; failures don't blank the page).
 */


const LIST = { staleTime: 30_000, retry: false as const, refetchOnWindowFocus: true }

export function useMbUser() {
  return useQuery({ queryKey: ['metabase', 'me'], queryFn: () => metabaseClient.currentUser(), staleTime: 5 * 60_000, retry: false })
}

export function useMbProperties() {
  return useQuery({ queryKey: ['metabase', 'props'], queryFn: () => metabaseClient.sessionProperties(), staleTime: 10 * 60_000, retry: false })
}

export function useCollectionTree() {
  return useQuery({ queryKey: ['metabase', 'collection-tree'], queryFn: () => metabaseClient.collectionTree(), ...LIST, staleTime: 60_000 })
}

/**
 * Every dashboard, via search (it carries collection, verification, card
 * count and bookmark state in one call). Falls back to the plain list when
 * search is unavailable, so a narrower permission set still sees dashboards.
 */
export function useDashboardIndex() {
  return useQuery({
    queryKey: ['metabase', 'dashboard-index'],
    queryFn: async (): Promise<metabase.MbSearchItem[]> => {
      try {
        return await metabaseClient.search({ models: ['dashboard'] })
      } catch (e) {
        const list = await metabaseClient.listDashboards().catch(() => {
          throw e
        })
        return list.map((d) => ({
          id: d.id,
          model: 'dashboard',
          name: d.name,
          description: d.description ?? null,
          collection_id: d.collection_id ?? null,
          updated_at: d.updated_at,
          created_at: d.created_at,
        }))
      }
    },
    ...LIST,
  })
}

export function useCards() {
  return useQuery({ queryKey: ['metabase', 'cards'], queryFn: () => metabaseClient.listCards(), ...LIST })
}

export function useCard(id?: number) {
  return useQuery({
    queryKey: ['metabase', 'card', id],
    queryFn: () => metabaseClient.getCard(id!),
    enabled: id != null && Number.isFinite(id),
    staleTime: 30_000,
    retry: false,
  })
}

/** Run a saved card. Keyed on its parameters; `refreshKey` forces a re-run. */
export function useCardResult(id: number | undefined, parameters: metabase.MbParameterValue[] = [], refreshKey = 0) {
  return useQuery({
    queryKey: ['metabase', 'card-result', id, JSON.stringify(parameters), refreshKey],
    queryFn: () => metabaseClient.runCard(id!, parameters),
    enabled: id != null && Number.isFinite(id),
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev) => prev,
  })
}

export function useDashboardDetail(id?: number) {
  return useQuery({
    queryKey: ['metabase', 'dashboard-detail', id],
    queryFn: () => metabaseClient.getDashboardDetail(id!),
    enabled: id != null && Number.isFinite(id),
    staleTime: 30_000,
    retry: false,
  })
}

/**
 * One dashcard's data. Runs through the dashboard endpoint (not the card's)
 * so dashboard filters, per-dashboard permissions and caching apply exactly
 * as they do in Metabase.
 */
export function useDashcardResult(
  dashboardId: number,
  dashcardId: number,
  cardId: number | null,
  parameters: metabase.MbParameterValue[],
  refreshKey: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ['metabase', 'dashcard', dashboardId, dashcardId, cardId, JSON.stringify(parameters), refreshKey],
    queryFn: () => metabaseClient.runDashcard(dashboardId, dashcardId, cardId!, parameters),
    enabled: enabled && cardId != null,
    staleTime: 60_000,
    retry: false,
    // Keep the previous result on screen while a refresh / filter change runs.
    placeholderData: (prev) => prev,
  })
}

export function useBookmarks() {
  return useQuery({ queryKey: ['metabase', 'bookmarks'], queryFn: () => metabaseClient.listBookmarks(), ...LIST })
}

export function useToggleBookmark() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ type, id, on }: { type: 'card' | 'dashboard'; id: number; on: boolean; name?: string }) =>
      metabaseClient.setBookmark(type, id, on),
    onMutate: async ({ type, id, on, name }) => {
      await qc.cancelQueries({ queryKey: ['metabase', 'bookmarks'] })
      const prev = qc.getQueryData<metabase.MbBookmark[]>(['metabase', 'bookmarks'])
      qc.setQueryData<metabase.MbBookmark[]>(['metabase', 'bookmarks'], (cur = []) =>
        on ? [...cur, { id: `${type}-${id}`, type, item_id: id, name: name ?? '' }] : cur.filter((b) => !(b.type === type && b.item_id === id)),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['metabase', 'bookmarks'], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['metabase', 'bookmarks'] }),
  })
}

export function useRecentViews() {
  return useQuery({ queryKey: ['metabase', 'recents'], queryFn: () => metabaseClient.recentViews(), ...LIST, staleTime: 15_000 })
}

export function useDatabasesFull() {
  return useQuery({ queryKey: ['metabase', 'databases-full'], queryFn: () => metabaseClient.listDatabasesFull(), ...LIST, staleTime: 60_000 })
}

export function useDatabaseMetadata(id?: number) {
  return useQuery({
    queryKey: ['metabase', 'db-metadata', id],
    queryFn: () => metabaseClient.databaseMetadata(id!),
    enabled: id != null && Number.isFinite(id),
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useDatabaseHealth(id?: number) {
  return useQuery({
    queryKey: ['metabase', 'db-health', id],
    queryFn: () => metabaseClient.databaseHealth(id!),
    enabled: id != null && Number.isFinite(id),
    staleTime: 60_000,
    retry: false,
  })
}

export function useSubscriptions() {
  return useQuery({ queryKey: ['metabase', 'subscriptions'], queryFn: () => metabaseClient.listSubscriptions(), ...LIST })
}

export function useAlerts() {
  return useQuery({ queryKey: ['metabase', 'alerts'], queryFn: () => metabaseClient.listAlerts(), ...LIST })
}

export function useChannelSpecs() {
  return useQuery({ queryKey: ['metabase', 'pulse-form'], queryFn: () => metabaseClient.pulseFormInput(), staleTime: 5 * 60_000, retry: false })
}

export function useMbUsers() {
  return useQuery({ queryKey: ['metabase', 'users'], queryFn: () => metabaseClient.listUsers(), staleTime: 5 * 60_000, retry: false })
}

export function useSnippets() {
  return useQuery({ queryKey: ['metabase', 'snippets'], queryFn: () => metabaseClient.listSnippets(), ...LIST, staleTime: 60_000 })
}

/** Invalidate everything a card change can affect. */
export function useInvalidateBi() {
  const qc = useQueryClient()
  return (what: Array<'cards' | 'dashboards' | 'subscriptions' | 'alerts' | 'databases' | 'snippets' | 'bookmarks'>) => {
    for (const w of what) {
      if (w === 'cards') {
        void qc.invalidateQueries({ queryKey: ['metabase', 'cards'] })
        void qc.invalidateQueries({ queryKey: ['metabase', 'card'] })
        void qc.invalidateQueries({ queryKey: ['metabase', 'questions'] })
      }
      if (w === 'dashboards') {
        void qc.invalidateQueries({ queryKey: ['metabase', 'dashboard-index'] })
        void qc.invalidateQueries({ queryKey: ['metabase', 'dashboard-detail'] })
        void qc.invalidateQueries({ queryKey: ['metabase', 'dashboards'] })
      }
      if (w === 'subscriptions') void qc.invalidateQueries({ queryKey: ['metabase', 'subscriptions'] })
      if (w === 'alerts') void qc.invalidateQueries({ queryKey: ['metabase', 'alerts'] })
      if (w === 'databases') {
        void qc.invalidateQueries({ queryKey: ['metabase', 'databases-full'] })
        void qc.invalidateQueries({ queryKey: ['metabase', 'db-metadata'] })
        void qc.invalidateQueries({ queryKey: ['metabase', 'db-health'] })
      }
      if (w === 'snippets') void qc.invalidateQueries({ queryKey: ['metabase', 'snippets'] })
      if (w === 'bookmarks') void qc.invalidateQueries({ queryKey: ['metabase', 'bookmarks'] })
    }
  }
}

/* ─── local "recently opened" — a fallback when Metabase's recents are empty ─── */

export interface LocalRecent {
  model: 'dashboard' | 'card'
  id: number
  name: string
  at: number
}

function recentKey(user?: number) {
  return `adhar.decide.bi-recent.${user ?? 'anon'}`
}

export function readLocalRecents(user?: number): LocalRecent[] {
  try {
    const raw = globalThis.localStorage?.getItem(recentKey(user))
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function rememberRecent(user: number | undefined, item: Omit<LocalRecent, 'at'>) {
  try {
    const next = [{ ...item, at: Date.now() }, ...readLocalRecents(user).filter((r) => !(r.model === item.model && r.id === item.id))].slice(0, 20)
    globalThis.localStorage?.setItem(recentKey(user), JSON.stringify(next))
  } catch {
    /* storage blocked — recents are a convenience */
  }
}
