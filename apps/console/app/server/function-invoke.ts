import { platformDomain } from './domain.ts'
import { requireUser, unauthorized } from './request-user.ts'
import { apiServerFetch, audit, type K8sIdentity } from './k8s/gateway.ts'
import { authorize, permissionDenied, type PermissionDecision } from './k8s/access.ts'
import type { AccessCheck } from '@adhar/auth/server'
import {
  type InvokableFunction,
  invokeTargets,
  isTextual,
  joinTarget,
  MAX_RESPONSE_BODY_BYTES,
  readCapped,
  responseHeaders,
  upstreamHeaders,
  validateInvokeRequest,
} from './function-invoke-model.ts'

/**
 * `POST /api/functions/invoke` — call a Function from Develop → Functions.
 *
 * Request:  `{ namespace, name, method?, path?, headers?, body?, timeoutMs? }`
 * Response: `{ ok: true, url, status, statusText, headers, body, binary,
 *             size, truncated, durationMs, attempts }` when the function
 *           answered (any HTTP status — a 500 from the function is a result,
 *           not a failure of this route), else `{ error, detail }` with
 *           400 / 401 / 403 / 404 / 405 / 409 / 502 / 503 / 504.
 *
 *   1. The caller must be signed in, and Kubernetes RBAC must let them `get`
 *      the Function (the same SelfSubjectAccessReview the page's `useCan`
 *      asks, so a visible Send button is a request that passes).
 *   2. The Function is read AS THE CALLER and the target is resolved here,
 *      from its `status.url` / in-cluster address (function-invoke-model.ts).
 *      The browser never names the host — only the path below it.
 *   3. The call goes out from the console with a timeout and size caps, no
 *      redirects followed, and none of the caller's cookies or tokens.
 */

export interface InvokeDeps {
  requireUser: typeof requireUser
  authorize(req: Request, check: AccessCheck): Promise<PermissionDecision>
  /** Read the Function as the caller: 200 with the object, or the apiserver's status. */
  getFunction(id: K8sIdentity, namespace: string, name: string): Promise<{ status: number; fn?: InvokableFunction }>
  fetch: typeof fetch
  baseDomain(): string | undefined
  now(): number
}

const FUNCTIONS = { group: 'platform.adhar.io', resource: 'functions' } as const

async function readFunction(id: K8sIdentity, namespace: string, name: string): Promise<{ status: number; fn?: InvokableFunction }> {
  const res = await apiServerFetch(
    id,
    `/apis/platform.adhar.io/v1alpha1/namespaces/${encodeURIComponent(namespace)}/functions/${encodeURIComponent(name)}`,
  )
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    return { status: res.status }
  }
  return { status: 200, fn: (await res.json()) as InvokableFunction }
}

const DEFAULT_DEPS: InvokeDeps = {
  requireUser,
  authorize: (req, check) => authorize(req, check),
  getFunction: readFunction,
  fetch: (input, init) => fetch(input, init),
  baseDomain: () => platformDomain()?.host,
  now: () => Date.now(),
}

function json(body: unknown, status: number, cookie?: string): Response {
  const res = Response.json(body, { status })
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export async function handleFunctionInvoke(req: Request, overrides: Partial<InvokeDeps> = {}): Promise<Response> {
  const deps: InvokeDeps = { ...DEFAULT_DEPS, ...overrides }
  if (req.method.toUpperCase() !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: 'POST' } })
  }
  const who = await deps.requireUser(req)
  if (!who.ok) return unauthorized(who.error)
  const cookie = who.refreshedCookie

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return json({ error: 'invalid_json', detail: 'The request body is not JSON.' }, 400, cookie)
  }
  const v = validateInvokeRequest(raw)
  if (!v.ok) return json({ error: v.error, detail: v.detail }, v.status, cookie)
  const r = v.request

  // RBAC as the caller: may they read this Function at all?
  const check: AccessCheck = { verb: 'get', group: FUNCTIONS.group, resource: FUNCTIONS.resource, namespace: r.namespace, name: r.name }
  const decision = await deps.authorize(req, check)
  if (!decision.allowed) {
    if (!decision.id) return unauthorized()
    return permissionDenied(check, decision.degraded)
  }

  let read: { status: number; fn?: InvokableFunction }
  try {
    read = await deps.getFunction(decision.id, r.namespace, r.name)
  } catch (e) {
    return json({ error: 'cluster_unreachable', detail: e instanceof Error ? e.message : String(e) }, 503, cookie)
  }
  if (read.status === 404) {
    return json({ error: 'function_not_found', detail: `Function ${r.namespace}/${r.name} does not exist.` }, 404, cookie)
  }
  if (!read.fn) {
    return json({ error: 'function_unreadable', detail: `Reading Function ${r.namespace}/${r.name} failed (HTTP ${read.status}).` }, 502, cookie)
  }

  const targets = invokeTargets(read.fn, deps.baseDomain())
  if (!targets.length) {
    return json({
      error: 'no_url',
      detail: 'This function has no URL the console may call yet: status.url is empty and no in-cluster address is known.',
    }, 409, cookie)
  }

  // Best target first; a target the console cannot reach at all (DNS, TLS,
  // refused) falls through to the next — the public URL from a laptop, the
  // in-cluster address from a pod. A timeout does not: it means the function
  // was reached and did not answer in time, and retrying would double it.
  const attempts: Array<{ url: string; error?: string }> = []
  const started = deps.now()
  for (const base of targets) {
    const url = joinTarget(base, r.path)
    try {
      const res = await deps.fetch(url, {
        method: r.method,
        headers: upstreamHeaders(r),
        body: r.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(r.timeoutMs),
      })
      const { bytes, truncated } = r.method === 'HEAD' ? { bytes: new Uint8Array(0), truncated: false } : await readCapped(res.body, MAX_RESPONSE_BODY_BYTES)
      const durationMs = deps.now() - started
      const contentType = res.headers.get('content-type')
      const textual = isTextual(contentType)
      attempts.push({ url })
      audit({
        action: 'function.invoke',
        user: who.user.email || who.user.id,
        namespace: r.namespace,
        name: r.name,
        method: r.method,
        url,
        status: res.status,
        durationMs,
      })
      return json({
        ok: true,
        url,
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders(res.headers),
        body: textual ? new TextDecoder().decode(bytes) : '',
        binary: !textual,
        size: bytes.length,
        truncated,
        durationMs,
        attempts,
      }, 200, cookie)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      attempts.push({ url, error: message })
      if (isTimeout(e)) {
        audit({ action: 'function.invoke', user: who.user.email || who.user.id, namespace: r.namespace, name: r.name, method: r.method, url, outcome: 'timeout' })
        return json({
          error: 'timeout',
          detail: `No answer from ${url} within ${Math.round(r.timeoutMs / 1000)}s. A function scaled to zero cold-starts on the first request — try again, or raise the timeout.`,
          attempts,
        }, 504, cookie)
      }
    }
  }
  return json({ error: 'unreachable', detail: 'The console could not reach the function at any of its addresses.', attempts }, 502, cookie)
}
