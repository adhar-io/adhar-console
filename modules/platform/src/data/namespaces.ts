import type { KubeObject } from '@adhar-console/api-clients/k8s'
import { useGeneric } from './hooks.ts'
import { useLiveList } from './live.ts'
import { GVRS } from './gvr.ts'

/**
 * Namespace-scoped governance data — ResourceQuotas + LimitRanges — read live
 * from the cluster through the per-user gateway. Everything here reuses the
 * existing data layer (`useLiveList` for the watch-backed namespace list,
 * `useGeneric` for the quota/limit queries); nothing is stubbed or fabricated.
 */

/* ─── typed shapes (core/v1, cast from the generic gateway objects) ────── */

export interface ResourceQuota extends KubeObject {
  spec?: { hard?: Record<string, string>; scopes?: string[] }
  status?: { hard?: Record<string, string>; used?: Record<string, string> }
}

export interface LimitRangeItem {
  type?: string
  max?: Record<string, string>
  min?: Record<string, string>
  default?: Record<string, string>
  defaultRequest?: Record<string, string>
  maxLimitRequestRatio?: Record<string, string>
}

export interface LimitRange extends KubeObject {
  spec?: { limits?: LimitRangeItem[] }
}

export interface NamespaceObject extends KubeObject {
  status?: { phase?: 'Active' | 'Terminating' | string }
}

/* ─── hooks ─────────────────────────────────────────────────────────────── */

/** Watch-backed namespace list — updates in place as namespaces come and go. */
export function useNamespacesLive() {
  const live = useLiveList<NamespaceObject>(GVRS.namespaces)
  return live
}

/**
 * ResourceQuotas — omit `namespace` to list across the whole cluster (one
 * query; the views group by `metadata.namespace`).
 */
export function useResourceQuotas(namespace?: string) {
  return useGeneric(GVRS.resourcequotas, namespace)
}

/** LimitRanges — same cluster-wide-or-scoped shape as `useResourceQuotas`. */
export function useLimitRanges(namespace?: string) {
  return useGeneric(GVRS.limitranges, namespace)
}

/* ─── quota helpers ─────────────────────────────────────────────────────── */

export interface QuotaUsage {
  resource: string
  used?: string
  hard?: string
}

/** Flatten a quota's status into per-resource used/hard rows (hard keys lead). */
export function quotaUsageRows(quota: ResourceQuota): QuotaUsage[] {
  const hard = quota.status?.hard ?? quota.spec?.hard ?? {}
  const used = quota.status?.used ?? {}
  const keys = [...new Set([...Object.keys(hard), ...Object.keys(used)])].sort()
  return keys.map((resource) => ({ resource, used: used[resource], hard: hard[resource] }))
}

/** Group a cluster-wide list by namespace for cheap per-row lookups. */
export function groupByNamespace<T extends KubeObject>(items: T[] | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items ?? []) {
    const ns = item.metadata?.namespace ?? ''
    const list = map.get(ns)
    if (list) list.push(item)
    else map.set(ns, [item])
  }
  return map
}
