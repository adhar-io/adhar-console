import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { metabase } from '@adhar-console/api-clients'

/**
 * Metabase BI hooks. Stub-backed in dev so the Decide module's BI
 * surfaces (dashboards, questions, SQL editor, pulses) render rich data
 * without a live Metabase instance.
 */

export const metabaseClient = metabase.MetabaseClient.auto({ tool: 'metabase' })

export function useDatabases() {
  return useQuery({
    queryKey: ['metabase', 'databases'],
    queryFn: () => metabaseClient.listDatabases(),
    staleTime: 60_000,
  })
}

export function useCollections() {
  return useQuery({
    queryKey: ['metabase', 'collections'],
    queryFn: () => metabaseClient.listCollections(),
    staleTime: 60_000,
  })
}

export function useQuestions(collectionId?: number) {
  return useQuery({
    queryKey: ['metabase', 'questions', collectionId ?? 'all'],
    queryFn: () => metabaseClient.listQuestions(collectionId ? { collectionId } : undefined),
    staleTime: 30_000,
  })
}

export function useQuestion(id?: number) {
  return useQuery({
    queryKey: ['metabase', 'question', id],
    queryFn: () => metabaseClient.getQuestion(id!),
    enabled: !!id,
    staleTime: 30_000,
  })
}

export function useDashboards() {
  return useQuery({
    queryKey: ['metabase', 'dashboards'],
    queryFn: () => metabaseClient.listDashboards(),
    staleTime: 30_000,
  })
}

export function useDashboard(id?: number) {
  return useQuery({
    queryKey: ['metabase', 'dashboard', id],
    queryFn: () => metabaseClient.getDashboard(id!),
    enabled: !!id,
    staleTime: 30_000,
  })
}

export function usePulses() {
  return useQuery({
    queryKey: ['metabase', 'pulses'],
    queryFn: () => metabaseClient.listPulses(),
    staleTime: 30_000,
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
