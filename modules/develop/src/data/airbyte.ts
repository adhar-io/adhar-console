import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { airbyte } from '@adhar-console/api-clients'

/**
 * Airbyte data-pipeline hooks. Stub-backed in dev so the Develop pipelines
 * view renders rich connections, sources, destinations, and job history
 * without a live Airbyte instance behind it.
 */

export const airbyteClient = airbyte.AirbyteClient.auto({ tool: 'airbyte' })

const REFRESH_MS = 15_000

export function useSources() {
  return useQuery({
    queryKey: ['airbyte', 'sources'],
    queryFn: () => airbyteClient.listSources(),
    staleTime: 30_000,
  })
}

export function useDestinations() {
  return useQuery({
    queryKey: ['airbyte', 'destinations'],
    queryFn: () => airbyteClient.listDestinations(),
    staleTime: 30_000,
  })
}

/**
 * Airbyte's config API lists through `POST /api/v1/connections/list`, and the
 * BFF's server-side change detection issues GETs — so these two hooks keep
 * their browser timer rather than pretending to be push-driven. Moving them
 * over needs the live hub to support a POST body for the `poll` topic.
 */
export function useConnections() {
  return useQuery({
    queryKey: ['airbyte', 'connections'],
    queryFn: () => airbyteClient.listConnections(),
    refetchInterval: REFRESH_MS,
  })
}

export function useJobs(filter?: { connectionId?: string; status?: airbyte.JobStatus; limit?: number }) {
  return useQuery({
    queryKey: ['airbyte', 'jobs', filter?.connectionId ?? 'all', filter?.status ?? 'all', filter?.limit ?? 0],
    queryFn: () => airbyteClient.listJobs(filter),
    refetchInterval: REFRESH_MS,
  })
}

export function useTriggerSync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) => airbyteClient.triggerSync(connectionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['airbyte'] }),
  })
}

export function useToggleConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      airbyteClient.toggleConnection(id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['airbyte', 'connections'] }),
  })
}
