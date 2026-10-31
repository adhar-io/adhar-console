import { accessCheckKey, type AccessCheck, type ConsolePermission } from '@adhar/auth/server'
import { apiServerFetch, type K8sIdentity, resolveClusterBase, resolveIdentity } from './gateway.ts'
import { getRequestContext } from '../request-user.ts'
import { decideOrgScoped, type OrgAccess, orgAdminGroup, orgScopedRole } from '../tenancy/org-access.ts'

/**
 * Authorization — the one place the console asks "may this person do X?".
 *
 * Almost every answer is a SelfSubjectAccessReview sent AS the signed-in user
 * (their OIDC token, or the console ServiceAccount impersonating them —
 * gateway.ts decides), so the apiserver's RBAC authorizer is the policy engine.
 * That covers Kubernetes objects and the console's own actions alike: the
 * latter are virtual resources in `console.adhar.io`
 * (packages/auth/src/console-permissions.ts).
 *
 * The exception is the ~20 permissions that belong to ONE organisation —
 * members, teams, projects, tokens, approvals, billing, org settings
 * (`ORG_SCOPED` in tenancy/org-access.ts). A ClusterRoleBinding cannot say
 * "admin of acme", only "admin of every organisation", so those are answered
 * from the caller's groups in the request's organisation (`org-<slug>-admin`,
 * or a platform admin) and never reach the apiserver or the cache below. The
 * question is still asked here, so `<Can>`/`useCan` and the handlers still ask
 * it the same way and cannot disagree.
 *
 * Two consumers, one cache, so they cannot disagree:
 *   - `POST /api/k8s/-/access-batch` — the browser's `<Can>` / `useCan` hide
 *     every action the user may not take, in one round trip per render tick;
 *   - `requirePermission` — the BFF handlers refuse the same actions.
 *
 * Fail closed: a review that cannot be made (apiserver unreachable, 5xx,
 * timeout) is a "no" and is never cached; the batch response says so with
 * `degraded: true` so the UI can tell "you may not" from "we could not ask".
 */

/** Most checks one batch may carry — a page needs dozens, not thousands. */
export const MAX_BATCH = 200
/** Parallel SSARs per batch. Bounded so one page load is not an apiserver burst. */
export const BATCH_CONCURRENCY = 8
/**
 * How long an answer is reused. RBAC changes are rare and a revocation taking
 * effect within half a minute is the same bargain the UI makes with its own
 * query cache; the hot path (every page render) stays off the apiserver.
 */
export const ACCESS_TTL_MS = 30_000
/** Entries across all users; least-recently-used are evicted beyond it. */
export const ACCESS_CACHE_MAX = 10_000
/** Per-review timeout — a hung review must not hold a whole page's batch. */
const REVIEW_TIMEOUT_MS = 10_000

/* ─────────────────────────── cache ─────────────────────────── */

/**
 * Bounded TTL + LRU map of definitive answers. `Map` keeps insertion order, so
 * re-inserting on read makes the first key the least recently used.
 */
export class AccessCache {
  readonly #ttl: number
  readonly #max: number
  readonly #now: () => number
  readonly #entries = new Map<string, { at: number; allowed: boolean }>()

  constructor(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.#ttl = opts.ttlMs ?? ACCESS_TTL_MS
    this.#max = Math.max(1, opts.max ?? ACCESS_CACHE_MAX)
    this.#now = opts.now ?? Date.now
  }

  get(key: string): boolean | undefined {
    const hit = this.#entries.get(key)
    if (!hit) return undefined
    if (this.#now() - hit.at >= this.#ttl) {
      this.#entries.delete(key)
      return undefined
    }
    this.#entries.delete(key)
    this.#entries.set(key, hit)
    return hit.allowed
  }

  set(key: string, allowed: boolean): void {
    this.#entries.delete(key)
    while (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    this.#entries.set(key, { at: this.#now(), allowed })
  }

  clear(): void {
    this.#entries.clear()
  }

  get size(): number {
    return this.#entries.size
  }
}

const sharedCache = new AccessCache()

/**
 * Who is asking, as RBAC sees it. The apiserver evaluates the user name and
 * group set (not the session), so two sessions of one person share answers and
 * a group change — a new token with different groups — gets fresh ones.
 */
export function identityKey(id: Pick<K8sIdentity, 'user'>, cluster?: string): string {
  const groups = [...(id.user.groups ?? [])].sort().join(',')
  return `${id.user.username || id.user.email || id.user.id}\u0000${groups}\u0000${cluster ?? ''}`
}

/* ─────────────────────────── validation ─────────────────────────── */

const VERB = /^(\*|[a-z][a-z-]{0,62})$/
// API group: '' (core) or a DNS subdomain.
const GROUP = /^$|^\*$|^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/
// Resource / subresource: plural lowercase names (`pods`, `scan-waivers`).
const RESOURCE = /^(\*|[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)$/
const NAMESPACE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
// Object names: DNS subdomains, plus `:` for RBAC objects like `system:…`.
const NAME = /^[A-Za-z0-9]([A-Za-z0-9._:-]{0,251}[A-Za-z0-9])?$/
const CHECK_KEYS = new Set(['verb', 'group', 'resource', 'subresource', 'namespace', 'name'])

export type BatchValidation =
  | { ok: true; checks: AccessCheck[] }
  | { ok: false; error: string; detail: string }

/**
 * Strict shape check of `{checks: AccessCheck[]}`. Every value ends up in an
 * SSAR the apiserver parses, so anything unexpected is refused rather than
 * passed along — unknown keys included, so a typo is an error, not a silently
 * broader question.
 */
export function validateBatch(body: unknown): BatchValidation {
  const bad = (detail: string): BatchValidation => ({ ok: false, error: 'invalid_checks', detail })
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Expected a JSON object {checks: [...]}.')
  const checks = (body as { checks?: unknown }).checks
  if (!Array.isArray(checks)) return bad('checks must be an array.')
  if (checks.length === 0) return bad('checks is empty.')
  if (checks.length > MAX_BATCH) return bad(`At most ${MAX_BATCH} checks per batch.`)
  const out: AccessCheck[] = []
  for (const [i, raw] of checks.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`checks[${i}] must be an object.`)
    const c = raw as Record<string, unknown>
    for (const k of Object.keys(c)) {
      if (!CHECK_KEYS.has(k)) return bad(`checks[${i}].${k} is not a check attribute.`)
      if (c[k] !== undefined && typeof c[k] !== 'string') return bad(`checks[${i}].${k} must be a string.`)
    }
    const s = (k: string) => (c[k] as string | undefined) || undefined
    const verb = s('verb')
    const resource = s('resource')
    if (!verb || !VERB.test(verb)) return bad(`checks[${i}].verb is missing or invalid.`)
    if (!resource || !RESOURCE.test(resource)) return bad(`checks[${i}].resource is missing or invalid.`)
    const group = (c.group as string | undefined) ?? ''
    if (!GROUP.test(group)) return bad(`checks[${i}].group is invalid.`)
    const subresource = s('subresource')
    if (subresource && !RESOURCE.test(subresource)) return bad(`checks[${i}].subresource is invalid.`)
    const namespace = s('namespace')
    if (namespace && !NAMESPACE.test(namespace)) return bad(`checks[${i}].namespace is invalid.`)
    const name = s('name')
    if (name && !NAME.test(name)) return bad(`checks[${i}].name is invalid.`)
    out.push({
      verb,
      group,
      resource,
      ...(subresource ? { subresource } : {}),
      ...(namespace ? { namespace } : {}),
      ...(name ? { name } : {}),
    })
  }
  return { ok: true, checks: out }
}

/* ─────────────────────────── evaluation ─────────────────────────── */

/** Answers one check; THROWS when it could not be answered (never cached). */
export type ReviewFn = (check: AccessCheck) => Promise<boolean>

/** A SelfSubjectAccessReview as `id` against `cluster`. */
export function ssarReviewer(id: K8sIdentity, cluster?: string): ReviewFn {
  return async (c) => {
    const res = await apiServerFetch(id, '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        spec: {
          resourceAttributes: {
            verb: c.verb,
            group: c.group ?? '',
            resource: c.resource,
            subresource: c.subresource,
            namespace: c.namespace,
            name: c.name,
          },
        },
      }),
      cluster,
      signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`access review failed (HTTP ${res.status})`)
    }
    const body = (await res.json()) as { status?: { allowed?: boolean } }
    return body.status?.allowed === true
  }
}

export interface BatchResult {
  results: boolean[]
  /** True when at least one check could not be evaluated (and was answered false). */
  degraded: boolean
}

/**
 * Evaluate `checks` in order: duplicates are asked once, cached answers are
 * reused, the rest run at most `concurrency` at a time. A check whose review
 * fails is `false` and flags the batch degraded.
 */
export async function evaluateBatch(
  checks: AccessCheck[],
  review: ReviewFn,
  opts: { cache?: AccessCache; scope?: string; concurrency?: number } = {},
): Promise<BatchResult> {
  const cache = opts.cache
  const scope = opts.scope ?? ''
  const keys = checks.map(accessCheckKey)
  const answers = new Map<string, boolean>()
  const pending: Array<{ key: string; check: AccessCheck }> = []
  for (const [i, key] of keys.entries()) {
    if (answers.has(key) || pending.some((p) => p.key === key)) continue
    const hit = cache?.get(`${scope}\u0000${key}`)
    if (hit !== undefined) answers.set(key, hit)
    else pending.push({ key, check: checks[i] })
  }

  let degraded = false
  let next = 0
  const worker = async () => {
    while (next < pending.length) {
      const { key, check } = pending[next++]
      try {
        const allowed = await review(check)
        answers.set(key, allowed)
        cache?.set(`${scope}\u0000${key}`, allowed)
      } catch {
        answers.set(key, false)
        degraded = true
      }
    }
  }
  const n = Math.max(1, Math.min(opts.concurrency ?? BATCH_CONCURRENCY, pending.length))
  await Promise.all(Array.from({ length: n }, worker))
  return { results: keys.map((k) => answers.get(k) === true), degraded }
}

/** Evaluate checks for a resolved identity, through the shared cache. */
export function checkAccess(id: K8sIdentity, checks: AccessCheck[], cluster?: string): Promise<BatchResult> {
  return evaluateBatch(checks, ssarReviewer(id, cluster), { cache: sharedCache, scope: identityKey(id, cluster) })
}

/** The caller's standing in the request's organisation, as the org-scoped checks need it. */
export interface OrgScope {
  access: OrgAccess
  /** The organisation could not be resolved (directory unreadable): answer no, and say why. */
  degraded: boolean
  /** The caller works in their personal tenant — no organisation at all. */
  personal?: boolean
  slug?: string
}

/** The org scope of `req`, or null when it has no session. */
export async function orgScopeOf(req: Request): Promise<OrgScope | null> {
  const ctx = await getRequestContext(req)
  if (!ctx) return null
  return { access: ctx.access, degraded: ctx.degraded, personal: ctx.personal, slug: ctx.org?.slug }
}

/**
 * Evaluate a mixed batch: org-scoped checks from `org` (never reviewed, never
 * cached — a membership change must show on the next ask, and these answers
 * depend on the organisation, which the cache key does not carry), the rest
 * through `evaluateBatch`. Order is preserved.
 */
export async function evaluateChecks(
  checks: AccessCheck[],
  review: ReviewFn,
  org: OrgScope | null,
  opts: { cache?: AccessCache; scope?: string; concurrency?: number } = {},
): Promise<BatchResult> {
  const results: boolean[] = new Array(checks.length).fill(false)
  const rest: AccessCheck[] = []
  const restAt: number[] = []
  let degraded = false
  checks.forEach((c, i) => {
    if (!orgScopedRole(c)) {
      rest.push(c)
      restAt.push(i)
      return
    }
    if (!org || org.degraded) {
      degraded ||= Boolean(org?.degraded)
      return
    }
    results[i] = decideOrgScoped(c, org.access) === true
  })
  if (rest.length > 0) {
    const r = await evaluateBatch(rest, review, opts)
    r.results.forEach((v, j) => (results[restAt[j]] = v))
    degraded ||= r.degraded
  }
  return { results, degraded }
}

/** `checkAccess`, with the org-scoped checks answered from the request's organisation. */
async function checkAccessFor(req: Request, id: K8sIdentity, checks: AccessCheck[], cluster?: string): Promise<BatchResult> {
  const org = checks.some((c) => orgScopedRole(c)) ? await orgScopeOf(req) : null
  return evaluateChecks(checks, ssarReviewer(id, cluster), org, { cache: sharedCache, scope: identityKey(id, cluster) })
}

/* ─────────────────────────── HTTP: /api/k8s/-/access-batch ─────────────────────────── */

/**
 * `POST /api/k8s/-/access-batch?cluster=` `{checks}` → `{results, degraded}`.
 * Called from gateway.ts's meta dispatch with the identity already resolved
 * and the cluster validated.
 */
export async function handleAccessBatch(req: Request, id: K8sIdentity, cluster?: string): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const v = validateBatch(body)
  if (!v.ok) return Response.json({ error: v.error, detail: v.detail }, { status: 400 })
  const out = await checkAccessFor(req, id, v.checks, cluster)
  return Response.json(out.degraded ? out : { results: out.results })
}

/* ─────────────────────────── server-side enforcement ─────────────────────────── */

export type PermissionDecision =
  | { allowed: true; id: K8sIdentity }
  | { allowed: false; degraded: boolean; id: K8sIdentity | null; org?: OrgScope | null }

/**
 * May the caller of `req` do `check`? Same identity, same SSAR, same cache as
 * the browser's `<Can>` — so a button that is shown is a request that passes.
 * Org-scoped checks are answered from the request's organisation instead (see
 * the header); the cluster does not enter into them.
 */
export async function authorize(
  req: Request,
  check: AccessCheck,
  opts: { cluster?: string; id?: K8sIdentity | null; org?: OrgScope | null } = {},
): Promise<PermissionDecision> {
  const id = opts.id !== undefined ? opts.id : await resolveIdentity(req)
  if (!id) return { allowed: false, degraded: false, id: null }
  if (orgScopedRole(check)) {
    const org = opts.org !== undefined ? opts.org : await orgScopeOf(req)
    if (!org || org.degraded) return { allowed: false, degraded: Boolean(org?.degraded), id, org }
    return decideOrgScoped(check, org.access) ? { allowed: true, id } : { allowed: false, degraded: false, id, org }
  }
  if (resolveClusterBase(opts.cluster) === null) return { allowed: false, degraded: false, id }
  const { results, degraded } = await checkAccess(id, [check], opts.cluster)
  return results[0] ? { allowed: true, id } : { allowed: false, degraded, id }
}

/** `verb resource.group` — the exact RBAC rule an operator has to grant. */
export function describeCheck(c: AccessCheck): string {
  const res = `${c.resource}${c.subresource ? `/${c.subresource}` : ''}${c.group ? `.${c.group}` : ''}`
  return `${c.verb} ${res}${c.namespace ? ` in namespace ${c.namespace}` : ''}`
}

/**
 * The refusal for a failed `authorize`: 403 naming the RBAC rule that is
 * missing, or 503 when the cluster could not be asked — never a silent pass.
 */
export function permissionDenied(check: AccessCheck | ConsolePermission, degraded: boolean): Response {
  if (degraded) {
    return Response.json({
      error: 'authorization_unavailable',
      detail: 'Your permissions could not be checked with the cluster, so the change was not made. Try again shortly.',
    }, { status: 503 })
  }
  const what = 'description' in check ? `${check.description.replace(/\.$/, '')} — ` : ''
  return Response.json({
    error: 'forbidden',
    detail: `${what}not permitted. It needs the Kubernetes RBAC permission "${describeCheck(check)}".`,
    permission: { verb: check.verb, group: check.group ?? '', resource: check.resource, ...(check.namespace ? { namespace: check.namespace } : {}) },
  }, { status: 403 })
}

/**
 * The refusal for an org-scoped check: there is no RBAC rule to name, only the
 * organisation's groups. No organisation at all (a personal tenant) is a 409 —
 * nothing to be refused in — and an admin action is 403 `requires_org_admin`.
 */
export function orgPermissionDenied(check: AccessCheck | ConsolePermission, org: OrgScope | null | undefined): Response {
  if (org?.degraded) return permissionDenied(check, true)
  if (!org || org.personal || !org.slug) {
    return Response.json({
      error: 'no_organisation',
      detail: 'You are not in an organisation yet. Ask an organisation admin to add you, or create one.',
    }, { status: 409 })
  }
  const what = 'description' in check ? `${check.description.replace(/\.$/, '')} — ` : ''
  if (orgScopedRole(check) === 'admin' && org.access.role) {
    return Response.json({
      error: 'requires_org_admin',
      detail: `${what}only organisation admins can do this (Keycloak group ${orgAdminGroup(org.slug)}, or a platform admin).`,
    }, { status: 403 })
  }
  return Response.json({
    error: 'not_a_member',
    detail: `${what}you are not a member of this organisation.`,
  }, { status: 403 })
}

/**
 * Gate a handler: `null` when allowed, otherwise the refusal to return.
 *
 *   const denied = await requirePermission(req, CONSOLE_PERMISSIONS.billingManage)
 *   if (denied) return denied
 */
export async function requirePermission(
  req: Request,
  check: AccessCheck | ConsolePermission,
  opts: { cluster?: string; namespace?: string; id?: K8sIdentity | null } = {},
): Promise<Response | null> {
  const c: AccessCheck = opts.namespace ? { ...check, namespace: opts.namespace } : check
  const d = await authorize(req, stripDescription(c), opts)
  if (d.allowed) return null
  if (!d.id) {
    return Response.json({ error: 'unauthenticated', detail: 'Sign in to continue.' }, { status: 401 })
  }
  if (orgScopedRole(c)) return orgPermissionDenied(check, d.org)
  return permissionDenied(c, d.degraded)
}

/** Many permissions in one round trip (e.g. a handler's `me.can` block). */
export async function permissionsFor<K extends string>(
  req: Request,
  checks: Record<K, AccessCheck>,
  opts: { cluster?: string; id?: K8sIdentity | null } = {},
): Promise<Record<K, boolean>> {
  const names = Object.keys(checks) as K[]
  const out = Object.fromEntries(names.map((n) => [n, false])) as Record<K, boolean>
  const id = opts.id !== undefined ? opts.id : await resolveIdentity(req)
  if (!id || !names.length) return out
  const { results } = await checkAccessFor(req, id, names.map((n) => stripDescription(checks[n])), opts.cluster)
  names.forEach((n, i) => (out[n] = results[i]))
  return out
}

function stripDescription(c: AccessCheck): AccessCheck {
  const { verb, group, resource, subresource, namespace, name } = c
  return {
    verb,
    group: group ?? '',
    resource,
    ...(subresource ? { subresource } : {}),
    ...(namespace ? { namespace } : {}),
    ...(name ? { name } : {}),
  }
}

/** Test seam: forget every cached answer. */
export function resetAccessCache(): void {
  sharedCache.clear()
}

