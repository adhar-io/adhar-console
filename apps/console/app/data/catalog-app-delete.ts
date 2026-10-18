import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { k8s } from '@adhar/api-clients'
import { APPLICATION_GVR, CONTROL_PLANE_NAMESPACE } from './catalog-custom-apps.ts'
export * from './catalog-app-delete-model.ts'

/**
 * Deleting a custom application — the Application XR the control plane keeps
 * for it in `adhar-system`, and optionally its Gitea repository.
 *
 * The XR is the source of truth: Crossplane composes the per-environment Argo
 * CD apps and the app's databases/caches from it, so deleting those directly
 * only gets them recreated. `/api/apps/delete` deletes the XR as the signed-in
 * user and lets Crossplane clean up (see app/server/app-delete.ts).
 */

const kube = k8s.K8sClient.auto()

/** The one query every live-catalog consumer reads Application XRs through (shared cache). */
export const applicationXRsQuery = {
  queryKey: ['catalog', 'live', 'applications'] as const,
  queryFn: () => kube.listGeneric(undefined, { ...APPLICATION_GVR, namespaced: true }, CONTROL_PLANE_NAMESPACE),
}

/** The Application XR named `name`, from the shared live query. */
export function useApplicationXR(name: string, enabled = true): { xr: k8s.Generic | undefined; isLoading: boolean } {
  const q = useQuery({ ...applicationXRsQuery, enabled, retry: false, staleTime: 15_000 })
  const xr = (q.data ?? []).find((a) => a.metadata?.name?.toLowerCase() === name.toLowerCase())
  return { xr, isLoading: q.isLoading }
}

export interface AppDeleteStep {
  id: 'application' | 'repo'
  label: string
  ok: boolean
  skipped?: boolean
  detail?: string
}

export interface AppDeleteResult {
  ok: boolean
  name: string
  deleting: boolean
  steps: AppDeleteStep[]
}

export function useDeleteApplication() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, deleteRepo }: { name: string; deleteRepo: boolean }): Promise<AppDeleteResult> => {
      const res = await fetch('/api/apps/delete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ name, deleteRepo, confirm: name }),
      })
      const body = (await res.json().catch(() => ({}))) as Partial<AppDeleteResult> & { error?: string; detail?: string }
      if (!res.ok) throw new Error(body.detail ?? body.error ?? `Delete failed (${res.status})`)
      return { ok: Boolean(body.ok), name: body.name ?? name, deleting: Boolean(body.deleting), steps: body.steps ?? [] }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['catalog'] })
    },
  })
}
