import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { kube } from '@adhar/api-clients/k8s'
import { canResource, useAccessReview } from '@adhar/shell-ui'
import { useCRD } from './k8s.ts'
import { type KubeLike, undoPatch } from './rollout-history.ts'

/**
 * Data the Rollouts page reads beyond the Rollout list itself: the
 * ReplicaSets and AnalysisRuns a rollout's history is derived from, whether
 * the user may patch the Rollout (rollback), the rollback itself, and the
 * page's deep-link params.
 *
 * Bounded on purpose: history is read for ONE namespace — the environment the
 * user opened — and only while the detail panel is open. Both lists ride the
 * apiserver watch (`useCRD` → `useWatchSignal`), so a new revision or a
 * finished AnalysisRun shows up without polling.
 */

const RS = { group: 'apps', version: 'v1', resource: 'replicasets', namespaced: true } as const
const ANALYSIS_RUNS = { group: 'argoproj.io', version: 'v1alpha1', resource: 'analysisruns', namespaced: true } as const
const ROLLOUTS = { group: 'argoproj.io', version: 'v1alpha1', resource: 'rollouts', namespaced: true } as const

export function errorStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

export function useRolloutHistorySources(namespace: string | undefined) {
  const enabled = Boolean(namespace)
  const rs = useCRD(RS, namespace, enabled)
  const runs = useCRD(ANALYSIS_RUNS, namespace, enabled)
  return {
    replicaSets: (rs.data ?? []) as unknown as KubeLike[],
    // No AnalysisRun CRD (404) or no right to list them (403) is not a reason
    // to hide the revisions — history renders without analysis.
    analysisRuns: (runs.data ?? []) as unknown as KubeLike[],
    loading: rs.isLoading && !rs.data,
    error: rs.isError && !rs.data ? rs.error : undefined,
    analysisUnavailable: runs.isError && !runs.data ? errorStatus(runs.error) ?? 0 : undefined,
  }
}

/**
 * May the signed-in user patch this Rollout? (SelfSubjectAccessReview, through
 * shell-ui's shared batched/cached access hook.) Keeps the `{ data, isLoading }`
 * shape the detail panel reads.
 */
export function useCanPatchRollout(namespace?: string, name?: string) {
  const state = useAccessReview(
    canResource(ROLLOUTS, 'patch', { namespace, name }),
    { enabled: Boolean(namespace && name) },
  )
  return { data: state.results[0], isLoading: state.loading }
}

/** `kubectl argo rollouts undo --to-revision`: put a revision's pod template back on the Rollout. */
export function useUndoRollout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ namespace, name, template }: { namespace: string; name: string; template: Record<string, unknown> }) =>
      kube.patch(ROLLOUTS, namespace, name, undoPatch(template), 'json'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rollouts'] })
      qc.invalidateQueries({ queryKey: ['deliver', 'apps', 'v1', 'replicasets'] })
    },
  })
}

/* ─────────── deep links ─────────── */

/**
 * `/deliver?section=rollouts&app=<project|namespace>/<app>&env=<env>`.
 *
 * The host route owns `?section=`; these params sit next to it, written with
 * the History API and announced with `popstate` (the host router listens) —
 * the same contract as `security-nav.ts`.
 */
export interface RolloutParams {
  app?: string
  env?: string
}

const KEYS = ['app', 'env'] as const

function read(): RolloutParams {
  if (typeof location === 'undefined') return {}
  const q = new URLSearchParams(location.search)
  const out: RolloutParams = {}
  for (const k of KEYS) {
    let v = q.get(k)
    // TanStack Router writes JSON-looking strings quoted.
    if (v && v.startsWith('"')) {
      try {
        const j = JSON.parse(v)
        if (typeof j === 'string') v = j
      } catch { /* keep raw */ }
    }
    if (v) out[k] = v
  }
  return out
}

export function useRolloutParams(): [RolloutParams, (patch: RolloutParams, opts?: { push?: boolean }) => void] {
  const [p, setP] = useState<RolloutParams>(read)
  useEffect(() => {
    const sync = () =>
      setP((cur) => {
        const next = read()
        return cur.app === next.app && cur.env === next.env ? cur : next
      })
    globalThis.addEventListener('popstate', sync)
    return () => globalThis.removeEventListener('popstate', sync)
  }, [])
  const set = useCallback((patch: RolloutParams, opts: { push?: boolean } = {}) => {
    if (typeof location === 'undefined') return
    const q = new URLSearchParams(location.search)
    for (const k of KEYS) {
      if (!(k in patch)) continue
      const v = patch[k]
      if (v) q.set(k, v)
      else q.delete(k)
    }
    const url = `${location.pathname}?${q.toString()}`
    if (opts.push) history.pushState(history.state, '', url)
    else history.replaceState(history.state, '', url)
    globalThis.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  }, [])
  return [p, set]
}

export function rolloutLink(app: string, env?: string): string {
  const q = new URLSearchParams({ section: 'rollouts', app })
  if (env) q.set('env', env)
  const origin = typeof location === 'undefined' ? '' : location.origin
  return `${origin}/deliver?${q.toString()}`
}
