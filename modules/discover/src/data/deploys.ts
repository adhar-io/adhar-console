import { useQuery } from '@tanstack/react-query'
import { argocd } from '@adhar/api-clients'
import { useWatchSignal } from '@adhar/shell-ui'

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

/**
 * Argo CD Applications are CRs: a sync landing is pushed by the apiserver
 * watch (same params as Deliver, so the hub shares one upstream watch). The
 * change-filtered signal ignores the per-reconcile `reconciledAt` rewrite, and
 * a 30 s throttle bounds re-lists during a sync storm — these are chart
 * markers, not a deploy console. The timer only runs while the socket is down
 * or the watch is refused.
 */
const ARGO_APPS_WATCH = { group: 'argoproj.io', version: 'v1alpha1', resource: 'applications' }

export function useArgoApps() {
  const queryKey = ['discover', 'argocd', 'apps']
  const refetchInterval = useWatchSignal(ARGO_APPS_WATCH, [queryKey], { fallbackMs: 60_000, throttleMs: 30_000 })
  return useQuery({
    queryKey,
    queryFn: () => argoClient.listApplications(),
    staleTime: 30_000,
    refetchInterval,
    retry: false,
  })
}
