import { type ReactNode, useEffect, useMemo } from 'react'
import { type QueryClient, useQueries, useQueryClient } from '@tanstack/react-query'
import { accessCheckKey, type AccessCheck, useOptionalSession } from '@adhar/auth'
import { globalSingleton } from '@adhar/utils'
import { type Capability, useCan as useRoleCan } from './roles.ts'
import { LOCAL_CLUSTER, useActiveCluster } from './selection-store.ts'
import { notifyUnauthorized } from './unauthorized.ts'
import { type AccessAnswers, type AccessGated, collectNavChecks, filterByAccess, filterSectionsByAccess } from './nav-access.ts'
import {
  AccessRequestError,
  AccessUnknownError,
  allAllowed,
  asCheckList,
  type BatchResponse,
  clusterForCheck,
  createAccessBatcher,
} from './can-batcher.ts'

/**
 * Permission-aware rendering — Kubernetes RBAC, asked as the signed-in user.
 *
 * The rule (docs/rbac.md): every mutating action in the UI is wrapped in
 * `<Can>` (or gated on `useCan`) with the check that matches the API it calls.
 * Blocked actions are HIDDEN, not disabled, and stay hidden while the answer
 * loads — a user never sees a button flash in and vanish.
 *
 *   <Can check={CONSOLE_PERMISSIONS.billingManage}><Button variant="primary">Change plan</Button></Can>
 *   <Can check={canResource(DEPLOYMENTS, 'delete', { namespace, name })}>…</Can>
 *   const canRun = useCan(consoleCheck(CONSOLE_PERMISSIONS.resilienceRun, ns))
 *
 * Every check is its own TanStack query (key `['k8s','can',cluster,checkKey,who]`)
 * so answers are cached and shared across the whole page — host and every
 * federated remote use the one QueryClient — while their fetchers meet in a
 * page-wide batcher that sends one `/api/k8s/-/access-batch` per tick.
 */

/** Answers are re-asked after this long; RBAC changes rarely and the BFF caches 30 s too. */
const STALE_MS = 60_000

/** Cluster as the BFF wants it: the console's own cluster is "no parameter". */
function clusterParam(cluster: string | undefined): string | undefined {
  return !cluster || cluster === LOCAL_CLUSTER || cluster === 'default' ? undefined : cluster
}

async function postBatch(cluster: string | undefined, checks: AccessCheck[]): Promise<BatchResponse> {
  const q = cluster ? `?cluster=${encodeURIComponent(cluster)}` : ''
  const res = await fetch(`/api/k8s/-/access-batch${q}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ checks }),
  })
  if (res.status === 401) notifyUnauthorized()
  // 4xx: the request will not succeed by repeating it — no retry storm while
  // signed out. 5xx / gateway: the cluster may answer in a moment — retried.
  if (res.status >= 400 && res.status < 500) throw new AccessRequestError(res.status)
  if (!res.ok) throw new AccessUnknownError(`access-batch ${res.status}`)
  return (await res.json()) as BatchResponse
}

/**
 * One batcher per PAGE, not per bundled copy of shell-ui: the host and each
 * remote carry their own copy, and checks from all of them should still share
 * a request (see globalSingleton).
 */
const batcher = globalSingleton('shell-ui.access-batcher', () => createAccessBatcher(postBatch))

/** Who is asking, as far as RBAC is concerned — a change means every answer is void. */
function useAccessIdentity(): string {
  const session = useOptionalSession()
  const u = session?.user
  if (!u) return 'anonymous'
  return `${u.id}|${[...(u.groups ?? [])].sort().join(',')}|${session.activeTenant ?? ''}`
}

/**
 * Drop answers that belong to a different identity. They could never be READ
 * (the identity is in the key), but holding them would keep a former user's
 * permissions in memory for the cache's lifetime.
 */
const lastIdentity = globalSingleton('shell-ui.access-identity', () => ({ value: '' }))
function useForgetOtherIdentities(qc: QueryClient, who: string) {
  useEffect(() => {
    if (lastIdentity.value && lastIdentity.value !== who) {
      qc.removeQueries({ queryKey: ['k8s', 'can'], predicate: (q) => q.queryKey[4] !== who })
    }
    lastIdentity.value = who
  }, [qc, who])
}

export interface CanOptions {
  /**
   * Cluster to ask. Defaults to the cluster selected in the topbar for
   * Kubernetes objects, and to the console's own cluster for console
   * permissions (`CONSOLE_PERMISSIONS`), which is where they are granted.
   */
  cluster?: string
  /** False skips the checks (they then read as not allowed). */
  enabled?: boolean
}

export interface AccessState {
  /** Every check is a definite yes. False while loading, on error, on any no. */
  allowed: boolean
  /** At least one answer is still being fetched for the first time. */
  loading: boolean
  /** Per-check answer, in the order given; undefined while unknown. */
  results: Array<boolean | undefined>
  /** At least one check could not be evaluated (network, cluster unreachable). */
  unknown: boolean
}

/**
 * The full state of a set of checks. Prefer `useCan` / `<Can>`; use this when
 * a view needs to tell "loading" or "couldn't check" apart from "no".
 */
export function useAccessReview(
  check: AccessCheck | readonly AccessCheck[] | null | undefined,
  opts: CanOptions = {},
): AccessState {
  const qc = useQueryClient()
  const who = useAccessIdentity()
  useForgetOtherIdentities(qc, who)
  const { cluster: selected } = useActiveCluster()
  const active = clusterParam(selected)
  // '' = "the console's own cluster, explicitly" — see clusterForCheck.
  const explicit = opts.cluster === undefined ? undefined : (clusterParam(opts.cluster) ?? '')
  const enabled = opts.enabled !== false
  // Callers pass inline objects; key on content so a re-render is not a new query.
  const checks = asCheckList(check)
  const sig = checks.map(accessCheckKey).join('\n')
  const stable = useMemo(() => checks, [sig])

  const answers = useQueries({
    queries: stable.map((c) => {
      // Per check: console permissions are answered by the console's cluster,
      // Kubernetes objects by the one selected in the topbar.
      const cluster = clusterForCheck(c, explicit, active)
      return {
        queryKey: ['k8s', 'can', cluster ?? '', accessCheckKey(c), who],
        queryFn: () => batcher.check(cluster, c),
        enabled: enabled && who !== 'anonymous',
        staleTime: STALE_MS,
        gcTime: 5 * 60_000,
        // By name, not `instanceof`: the batcher is one per page (the first
        // bundle's copy), so a remote's error class is a different object.
        retry: (n: number, e: unknown) => (e as Error | null)?.name === 'AccessUnknownError' && n < 2,
        retryDelay: (n: number) => 1_000 * 2 ** n,
      }
    }),
  })

  const results = answers.map((a) => (a.data === true ? true : a.data === false ? false : undefined))
  return {
    allowed: enabled && allAllowed(results),
    loading: enabled && answers.some((a) => a.isLoading),
    results,
    unknown: answers.some((a) => a.isError),
  }
}

/**
 * Is the signed-in user allowed to do this? `true` only when EVERY check is
 * allowed; `false` while loading — gate rendering on it, never disabling.
 *
 *   const canToggle = useCan(CONSOLE_PERMISSIONS.packagesToggle)
 *   const canEdit = useCan([canResource(gvr, 'update', { namespace, name }), canResource(gvr, 'patch', { namespace, name })])
 *
 * Passing a persona Capability string (`useCan('platform.manage')`) keeps the
 * older Keycloak-role behaviour for call sites not yet moved to RBAC checks.
 */
export function useCan(capability: Capability): boolean
export function useCan(check: AccessCheck | readonly AccessCheck[], opts?: CanOptions): boolean
export function useCan(arg: Capability | AccessCheck | readonly AccessCheck[], opts: CanOptions = {}): boolean {
  const legacy = typeof arg === 'string'
  // Both hooks run on every render (rules of hooks); only one answer is used.
  const roleAllows = useRoleCan(legacy ? arg : 'platform.manage')
  const state = useAccessReview(legacy ? null : arg, opts)
  return legacy ? roleAllows : state.allowed
}

export interface CanProps extends CanOptions {
  /** One check, or several that must ALL be allowed. */
  check: AccessCheck | readonly AccessCheck[]
  children: ReactNode
  /** Rendered instead when not allowed (and while loading). Default: nothing. */
  fallback?: ReactNode
}

/** Render `children` only when every check is allowed — hidden, not disabled. */
export function Can({ check, cluster, enabled, fallback = null, children }: CanProps) {
  const allowed = useCan(check, { cluster, enabled })
  return <>{allowed ? children : fallback}</>
}

/**
 * Forget every cached answer — after something that changes RBAC itself
 * (a role binding edited from the console), so the page re-asks at once.
 */
export function invalidateAccess(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ['k8s', 'can'] })
}

/**
 * Answers for a set of checks, keyed by `accessCheckKey` — for views that gate
 * many things at once (the nav tree) and need each answer, not just "all".
 * Shares the cache and the per-tick batch with every `<Can>` on the page.
 */
export function useAccessAnswers(checks: readonly AccessCheck[], opts: CanOptions = {}): AccessAnswers {
  const { results } = useAccessReview(checks.length ? checks : null, opts)
  const sig = results.map((r) => (r === undefined ? '?' : r ? '1' : '0')).join('')
  const keys = checks.map(accessCheckKey).join('\n')
  return useMemo(() => {
    const map = new Map<string, boolean | undefined>()
    checks.forEach((c, i) => map.set(accessCheckKey(c), results[i]))
    return map
  }, [keys, sig]) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The nav tree as this person may see it: rows with `access` are filtered by
 * RBAC (see nav-access.ts for the read/action rule). One batched request for
 * the whole tree; the same array back when nothing is hidden.
 */
export function useNavByAccess<S extends { items: readonly (AccessGated & { to?: string })[] }>(sections: readonly S[]): S[] {
  const checks = useMemo(() => collectNavChecks(sections.flatMap((s) => s.items)), [sections])
  const answers = useAccessAnswers(checks)
  return useMemo(() => filterSectionsByAccess(sections, answers), [sections, answers])
}

/** `useNavByAccess` for a flat command list (⌘K items). */
export function useItemsByAccess<T extends AccessGated & { to?: string }>(items: readonly T[]): T[] {
  const checks = useMemo(() => collectNavChecks(items), [items])
  const answers = useAccessAnswers(checks)
  return useMemo(() => filterByAccess(items, answers), [items, answers])
}
