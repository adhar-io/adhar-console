import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { coder } from '@adhar-console/api-clients'

/**
 * Coder hooks for cloud development environments.
 */

export const coderClient = coder.CoderClient.auto({ tool: 'coder' })

const REFRESH_MS = 15_000

export function useTemplates() {
  return useQuery({
    queryKey: ['coder', 'templates'],
    queryFn: () => coderClient.listTemplates(),
    staleTime: 60_000,
  })
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ['coder', 'workspaces'],
    queryFn: () => coderClient.listWorkspaces(),
    refetchInterval: REFRESH_MS,
  })
}

export function useWorkspace(id?: string) {
  return useQuery({
    queryKey: ['coder', 'workspace', id],
    queryFn: () => coderClient.getWorkspace(id!),
    enabled: !!id,
    refetchInterval: REFRESH_MS,
  })
}

export function useStartWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => coderClient.startWorkspace(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coder', 'workspaces'] }),
  })
}
export function useStopWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => coderClient.stopWorkspace(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coder', 'workspaces'] }),
  })
}
export function useDeleteWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => coderClient.deleteWorkspace(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coder', 'workspaces'] }),
  })
}
export function useCreateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; template_id: string }) => coderClient.createWorkspace(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coder', 'workspaces'] }),
  })
}
