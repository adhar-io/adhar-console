import { type AccessCheck, canResource, useAccessReview } from '@adhar/shell-ui'

/**
 * RBAC checks for Deliver's write actions (docs/rbac.md). Each builder asks
 * the exact verb/resource the action's request hits, so a hidden button and a
 * 403 from the apiserver are the same answer. Views wrap actions in
 * `<Can check={…}>` / `useCan(…)` — blocked actions are hidden, not disabled.
 */

const ARGO_APPS = { group: 'argoproj.io', resource: 'applications', namespaced: true } as const
const ROLLOUTS = { group: 'argoproj.io', resource: 'rollouts', namespaced: true } as const
const KARGO_PROMOTIONS = { group: 'kargo.akuity.io', resource: 'promotions', namespaced: true } as const
const KARGO_STAGES = { group: 'kargo.akuity.io', resource: 'stages', namespaced: true } as const
const KARGO_FREIGHT = { group: 'kargo.akuity.io', resource: 'freights', namespaced: true } as const
const KARGO_WAREHOUSES = { group: 'kargo.akuity.io', resource: 'warehouses', namespaced: true } as const
const KYVERNO_CLUSTER = { group: 'kyverno.io', resource: 'clusterpolicies', namespaced: false } as const
const KYVERNO_NS = { group: 'kyverno.io', resource: 'policies', namespaced: true } as const

/**
 * Argo CD Application writes. Sync, refresh, rollback and terminate all
 * modify the Application (its `operation` / refresh annotation); delete
 * removes it. Asked in the Application's own namespace (Argo's `argocd`).
 */
export const argoAppCheck = (verb: 'patch' | 'delete', namespace: string | undefined, name?: string): AccessCheck =>
  canResource(ARGO_APPS, verb, { namespace: namespace || 'argocd', name })

/**
 * Argo Rollouts promote / abort / retry — merge patches on the Rollout's
 * `status` subresource (promote also un-pauses `spec`), as
 * `kubectl argo rollouts` does. Both must be allowed.
 */
export const rolloutControlChecks = (namespace: string | undefined, name?: string): AccessCheck[] => [
  canResource(ROLLOUTS, 'patch', { namespace, name }),
  canResource(ROLLOUTS, 'patch', { namespace, name, subresource: 'status' }),
]

/**
 * Kargo promote: the apiserver needs `create promotions` in the project
 * namespace, and Kargo's admission webhook additionally needs the custom
 * `promote` verb on the target Stage (Kargo's documented promoter verb).
 */
export const kargoPromoteChecks = (project: string | undefined, stage?: string): AccessCheck[] => [
  canResource(KARGO_PROMOTIONS, 'create', { namespace: project }),
  canResource(KARGO_STAGES, 'promote', { namespace: project, name: stage }),
]

/** Manual freight approval — a merge patch on the Freight's status subresource. */
export const kargoApproveCheck = (project: string | undefined, freight?: string): AccessCheck =>
  canResource(KARGO_FREIGHT, 'patch', { namespace: project, name: freight, subresource: 'status' })

/** Abort = the `kargo.akuity.io/abort` annotation patched onto the Promotion. */
export const kargoAbortCheck = (project: string | undefined, promotion?: string): AccessCheck =>
  canResource(KARGO_PROMOTIONS, 'patch', { namespace: project, name: promotion })

/** Refresh = the `kargo.akuity.io/refresh` annotation patched onto a Stage or Warehouse. */
export const kargoRefreshStageCheck = (project: string | undefined, stage?: string): AccessCheck =>
  canResource(KARGO_STAGES, 'patch', { namespace: project, name: stage })
export const kargoRefreshWarehouseCheck = (project: string | undefined, warehouse?: string): AccessCheck =>
  canResource(KARGO_WAREHOUSES, 'patch', { namespace: project, name: warehouse })

/** Kyverno Audit ⇄ Enforce — a strategic-merge patch on the (Cluster)Policy. */
export const kyvernoModeCheck = (name: string, namespace?: string): AccessCheck =>
  namespace ? canResource(KYVERNO_NS, 'patch', { namespace, name }) : canResource(KYVERNO_CLUSTER, 'patch', { name })

/**
 * Promote / abort answers for several Kargo project namespaces at once (a
 * page showing more than one project's stages). One batched review; each
 * lookup is a definite yes only — unknown and loading read as "no".
 */
export function useKargoProjectAccess(namespaces: readonly string[]) {
  const list = [...new Set(namespaces.filter(Boolean))].sort()
  const checks = list.flatMap((ns) => [...kargoPromoteChecks(ns), kargoAbortCheck(ns)])
  const { results } = useAccessReview(checks, { enabled: list.length > 0 })
  const at = (ns: string | undefined, offset: number) => {
    const i = ns ? list.indexOf(ns) : -1
    return i >= 0 && results[i * 3 + offset] === true
  }
  return {
    canPromote: (ns: string | undefined) => at(ns, 0) && at(ns, 1),
    canAbort: (ns: string | undefined) => at(ns, 2),
  }
}
