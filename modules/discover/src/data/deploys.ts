import { useQuery } from '@tanstack/react-query'
import { argocd } from '@adhar/api-clients'

export { deployEvents, type DeployEvent, shortRev } from './deploy-events.ts'

/**
 * Recent deploys from Argo CD — the platform's CD tool — used as chart
 * annotations and the "Recent deploys" widget.
 *
 * A deploy is one entry of an Application's `.status.history` (each successful
 * sync records `deployedAt` + revision), plus the current operation when it is
 * still running or failed (those never reach history). Nothing is inferred
 * from metrics.
 */

const argoClient = argocd.ArgoCDClient.auto({ tool: 'argocd' })

export function useArgoApps(refreshMs: number | false = 60_000) {
  return useQuery({
    queryKey: ['discover', 'argocd', 'apps'],
    queryFn: () => argoClient.listApplications(),
    staleTime: 30_000,
    refetchInterval: refreshMs,
    retry: false,
  })
}
