import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { airbyte } from '@adhar/api-clients'

/**
 * Airbyte data-pipeline hooks. Stub-backed in dev so the Develop pipelines
 * view renders rich connections, sources, destinations, and job history
 * without a live Airbyte instance behind it.
 */

export const airbyteClient = airbyte.AirbyteClient.auto({ tool: 'airbyte' })

/** The console-wide poll floor (see the note on `useConnections`). */
const REFRESH_MS = 60_000

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

export function useJobLogs(jobId?: string) {
  return useQuery({
    queryKey: ['airbyte', 'job-logs', jobId],
    queryFn: () => airbyteClient.getJobLogs(jobId!),
    enabled: !!jobId,
  })
}

/** Generic Airbyte mutation — every one refreshes the whole Airbyte cache. */
function useAirbyteMutation<V, R = void>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['airbyte'] }),
  })
}

export const useCancelJob = () => useAirbyteMutation((jobId: string) => airbyteClient.cancelJob(jobId))
export const useResetConnection = () => useAirbyteMutation((id: string) => airbyteClient.resetConnection(id))
export const useUpdateSchedule = () =>
  useAirbyteMutation((v: { id: string; schedule: airbyte.ScheduleInput }) => airbyteClient.updateSchedule(v.id, v.schedule))
export const useRenameConnection = () =>
  useAirbyteMutation((v: { id: string; name: string }) => airbyteClient.renameConnection(v.id, v.name))
export const useDeleteConnection = () => useAirbyteMutation((id: string) => airbyteClient.deleteConnection(id))
export const useCheckSource = () => useMutation({ mutationFn: (id: string) => airbyteClient.checkSource(id) })
export const useCheckDestination = () => useMutation({ mutationFn: (id: string) => airbyteClient.checkDestination(id) })
