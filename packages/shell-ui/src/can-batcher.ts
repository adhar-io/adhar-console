import { accessCheckKey, type AccessCheck, CONSOLE_API_GROUP } from '@adhar/auth'

/**
 * The pure half of `<Can>` / `useCan`: coalesce every permission check asked
 * for in the same tick into ONE `POST /api/k8s/-/access-batch` per cluster.
 *
 * A page renders dozens of guarded actions (a row's Edit/Delete, a header's
 * Create, a drawer's Rollback). Each is its own TanStack query — so caching,
 * staleness and invalidation stay per check — but their fetchers all land
 * here, and a microtask later one request carries all of them. No React, no
 * fetch: the transport and the scheduler are injected so this tests in Deno.
 */

/** Same cap as the BFF (apps/console/app/server/k8s/access.ts MAX_BATCH). */
export const MAX_CHECKS_PER_REQUEST = 200

export interface BatchResponse {
  results: boolean[]
  degraded?: boolean
}

/** Sends one batch for one cluster (`undefined` = the console's own cluster). */
export type FetchBatch = (cluster: string | undefined, checks: AccessCheck[]) => Promise<BatchResponse>

/**
 * The batch itself was refused (signed out, malformed) — asking again will not
 * help, so it is NOT retried. The check stays hidden until the page re-asks
 * (sign-in, focus, remount).
 */
export class AccessRequestError extends Error {
  constructor(readonly status: number) {
    super(`access-batch ${status}`)
    this.name = 'AccessRequestError'
  }
}

/** Thrown for a check the server could not evaluate — retried, never cached as "no". */
export class AccessUnknownError extends Error {
  constructor(message = 'permission could not be checked') {
    super(message)
    this.name = 'AccessUnknownError'
  }
}

interface Waiter {
  resolve: (allowed: boolean) => void
  reject: (e: unknown) => void
}

export interface AccessBatcher {
  /** Resolve one check, sharing a request with every other check this tick. */
  check(cluster: string | undefined, check: AccessCheck): Promise<boolean>
}

/**
 * How long checks wait for company before going out.
 *
 * A microtask was enough for one render — every `<Can>` in a commit subscribes
 * in the same synchronous pass — but not for anything that arrives on its own
 * timer. Retries are the case that mattered: eight checks that failed together
 * were retried by eight separate TanStack timers, each landing in its own task,
 * and went back as eight single-check requests (then sixteen). A few
 * milliseconds of window joins them again, and costs nothing a person can see.
 */
export const BATCH_WINDOW_MS = 8

const defaultSchedule = (flush: () => void) => {
  setTimeout(flush, BATCH_WINDOW_MS)
}

export function createAccessBatcher(
  fetchBatch: FetchBatch,
  schedule: (flush: () => void) => void = defaultSchedule,
): AccessBatcher {
  // cluster → (checkKey → {check, waiters})
  let pending = new Map<string, Map<string, { check: AccessCheck; waiters: Waiter[] }>>()
  let scheduled = false

  const flush = () => {
    scheduled = false
    const batch = pending
    pending = new Map()
    for (const [clusterKey, byKey] of batch) {
      const entries = [...byKey.values()]
      for (let i = 0; i < entries.length; i += MAX_CHECKS_PER_REQUEST) {
        const chunk = entries.slice(i, i + MAX_CHECKS_PER_REQUEST)
        send(clusterKey || undefined, chunk)
      }
    }
  }

  const send = (cluster: string | undefined, chunk: Array<{ check: AccessCheck; waiters: Waiter[] }>) => {
    fetchBatch(cluster, chunk.map((e) => e.check)).then(
      (res) => {
        for (const [i, e] of chunk.entries()) {
          const allowed = res.results?.[i]
          // A degraded batch answers `false` for what it could not evaluate,
          // indistinguishable from a real "no" — so a degraded false is
          // UNKNOWN: hidden now (the query errors) and asked again, not cached
          // as a denial for the next minute.
          if (allowed === true) e.waiters.forEach((w) => w.resolve(true))
          else if (allowed === false && !res.degraded) e.waiters.forEach((w) => w.resolve(false))
          else e.waiters.forEach((w) => w.reject(new AccessUnknownError()))
        }
      },
      (err) => {
        for (const e of chunk) e.waiters.forEach((w) => w.reject(err))
      },
    )
  }

  return {
    check(cluster, check) {
      return new Promise<boolean>((resolve, reject) => {
        const clusterKey = cluster ?? ''
        const byKey = pending.get(clusterKey) ?? new Map()
        pending.set(clusterKey, byKey)
        const key = accessCheckKey(check)
        const entry = byKey.get(key) ?? { check: normaliseCheck(check), waiters: [] }
        entry.waiters.push({ resolve, reject })
        byKey.set(key, entry)
        if (!scheduled) {
          scheduled = true
          schedule(flush)
        }
      })
    },
  }
}

/** Drop empty optional fields so the wire shape matches the cache key. */
export function normaliseCheck(c: AccessCheck): AccessCheck {
  return {
    verb: c.verb,
    group: c.group ?? '',
    resource: c.resource,
    ...(c.subresource ? { subresource: c.subresource } : {}),
    ...(c.namespace ? { namespace: c.namespace } : {}),
    ...(c.name ? { name: c.name } : {}),
  }
}

/* ─────────────────────────── helpers for call sites ─────────────────────────── */

/** The GVR shape every api-client already uses (`@adhar/api-clients/k8s`). */
export interface GvrLike {
  group: string
  resource: string
  namespaced?: boolean
}

/**
 * The check for `verb` on a Kubernetes resource — the question the apiserver
 * will ask when the guarded button's request reaches it.
 *
 *   <Can check={canResource(DEPLOYMENTS, 'delete', { namespace, name })}>…</Can>
 *
 * A cluster-scoped GVR (`namespaced: false`) ignores the namespace, as the
 * apiserver does.
 */
export function canResource(
  gvr: GvrLike,
  verb: string,
  opts: { namespace?: string; name?: string; subresource?: string } = {},
): AccessCheck {
  return normaliseCheck({
    verb,
    group: gvr.group === 'core' ? '' : gvr.group,
    resource: gvr.resource,
    subresource: opts.subresource,
    namespace: gvr.namespaced === false ? undefined : opts.namespace,
    name: opts.name,
  })
}

/** Checks as a list, whether one or many were passed. */
export function asCheckList(check: AccessCheck | readonly AccessCheck[] | null | undefined): AccessCheck[] {
  if (!check) return []
  return (Array.isArray(check) ? [...check] : [check as AccessCheck]).map(normaliseCheck)
}

/**
 * ALL-of semantics with no flash: allowed only when every answer is a definite
 * `true`. Loading (`undefined`), unknown and denied all hide.
 */
export function allAllowed(answers: ReadonlyArray<boolean | undefined>): boolean {
  return answers.length > 0 && answers.every((a) => a === true)
}

/**
 * Which cluster answers a check.
 *
 * A Kubernetes object lives in the cluster the topbar points at, so its check
 * goes there. A console virtual resource (`console.adhar.io` — billing,
 * organisations, packages …) is granted on the CONSOLE's own cluster, and that
 * is the only cluster the BFF asks when it enforces it (`requirePermission`
 * with no cluster). Asking a workload cluster about `billing.console.adhar.io`
 * answered "no" for everyone — the rule is not granted there — so picking a
 * remote cluster in the topbar used to hide every console action. An explicit
 * `cluster` from the caller still wins for both.
 *
 * Returns `undefined` for "the console's own cluster" (no query parameter).
 */
export function clusterForCheck(
  check: AccessCheck,
  explicit: string | undefined,
  active: string | undefined,
): string | undefined {
  if (explicit !== undefined) return explicit || undefined
  if (check.group === CONSOLE_API_GROUP) return undefined
  return active || undefined
}
