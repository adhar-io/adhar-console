import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { argocd } from '@adhar/api-clients'
import type { LiveWatchRef } from '@adhar/shell-ui'
import { useK8sListSync } from './live-k8s.ts'

/**
 * Every Argo CD Application, read once through the Argo CD API (its RBAC, its
 * normalised shape) and then kept current by the apiserver watch on the
 * Application CRs — a sync finishing updates the list in place, with no
 * re-list. Merge-only: the watch may see apps the Argo CD API would not show
 * this user, so an app the list does not hold triggers a (throttled) refetch
 * through the API rather than being added from the watch.
 *
 * One key for the catalog, the deployment tab and the Overview DORA tiles, so
 * a page showing all three makes one request.
 */

const argocdClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

export const ARGO_APPS_KEY = ['catalog', 'argocd', 'apps'] as const
export const ARGO_APPS_WATCH: LiveWatchRef = { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications' }

const normalize = (o: unknown) => argocd.normalizeApplication(o as Parameters<typeof argocd.normalizeApplication>[0])

export function useArgoApplications(enabled = true) {
  const refetchInterval = useK8sListSync<argocd.Application>(ARGO_APPS_KEY, ARGO_APPS_WATCH, {
    enabled,
    mergeOnly: true,
    map: normalize,
    minGapMs: 30_000,
  })
  return useQuery({
    queryKey: ARGO_APPS_KEY,
    queryFn: () => argocdClient.listApplications(),
    enabled,
    staleTime: 30_000,
    refetchInterval,
    retry: false,
    placeholderData: keepPreviousData,
    gcTime: 24 * 60 * 60_000,
  })
}
