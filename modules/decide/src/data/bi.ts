import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { metabase } from '@adhar-console/api-clients'

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
