import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { docStore } from '@adhar/shell-ui'
import type { BuilderProject } from '@adhar/builder/project'
import { BUILDER_KIND, summarize } from './builder-library.ts'

/** TanStack Query hooks over the Visual Builder's project library. */

const listKey = ['design', 'builder-projects'] as const

export function useBuilderProjects() {
  return useQuery({
    queryKey: listKey,
    queryFn: async () => summarize(await docStore.list<Record<string, unknown>>(BUILDER_KIND)),
    staleTime: 10_000,
  })
}

function clearDraft(id: string) {
  try {
    localStorage.removeItem(`adhar.builder.draft:${id}`)
  } catch {
    /* ignore */
  }
}

export function useSaveProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, project }: { id: string; project: BuilderProject }) =>
      docStore.put(BUILDER_KIND, id, project as unknown as Record<string, unknown>),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await docStore.remove(BUILDER_KIND, id)
      clearDraft(id)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  })
}

export function useInvalidateProjects() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: listKey })
}
