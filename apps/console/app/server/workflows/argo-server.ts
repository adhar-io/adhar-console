import { env } from '@adhar/utils'
import { apiServerFetch, k8sAuthState, type K8sIdentity } from '../k8s/gateway.ts'
import { getK8sServiceToken } from '../tool-registry.ts'

/**
 * The console's ONLY path to argo-server (design 0026 §4.4, D-4, D-5).
 *
 * Kubernetes objects (list, watch, submit, stop …) go through the user-identity
 * gateway. argo-server is called only for what it alone serves: the archive,
 * retry, memoized resubmit, `set`/`resume` for approvals, lint, artifacts and
 * the hydrated workflow. Every caller has already been authorised AS THE USER
 * (`authz.ts`); this module decides which bearer argo-server sees and builds
 * the URL so the namespace in it is the one that was authorised.
 *
 * Identity (D-5), decided per call and never cached across users:
 *   - the gateway forwards user tokens (`effective === 'user'`): argo-server in
 *     `--auth-mode=client` is then the user, and the API server applies their
 *     RBAC a second time;
 *   - otherwise (impersonation — managed control planes reject the Keycloak
 *     token): a short-lived TokenRequest for `adhar-system/adhar-console-argo`,
 *     minted with the console's own ServiceAccount (`create
 *     serviceaccounts/token`, resourceNames that one SA) and cached ≤ 8 min.
 *     That SA holds only argoproj.io rights; the SSAR already asked as the user
 *     is what limits it to the caller's namespaces.
 *
 * A user-mode call that argo-server answers 401 is retried once as the service
 * identity — the gateway's own `auto` mode latches impersonation only after
 * the API server has refused a user token, and argo-server can be the first to
 * find out.
 */

export const DEFAULT_ARGO_SERVER_URL = 'http://argo-server.adhar-system.svc.cluster.local:2746'
export const ARGO_SA_NAMESPACE = 'adhar-system'
export const ARGO_SA_NAME = 'adhar-console-argo'
/** The API server's floor for a bound token. */
const TOKEN_SECONDS = 600
/** Reuse a minted token for at most this long (it lives 10 min). */
const TOKEN_REUSE_MS = 8 * 60_000
const CALL_TIMEOUT_MS = 30_000

export type ArgoMode = 'user' | 'service'

export interface ArgoIdentity {
  bearer: string
  mode: ArgoMode
}

export interface ArgoClientOpts {
  /** argo-server base URL; '' = not configured (outside a cluster). */
  baseUrl: () => string
  /** The gateway's effective auth mode. */
  authState: () => { effective: 'user' | 'impersonate' | 'service' }
  /** Mint a token for the console's argo SA: `{token, expiresAt}` or null when it cannot. */
  mintToken: () => Promise<{ token: string; expiresAt: number } | null>
  fetch?: typeof fetch
  now?: () => number
  /** Per-call deadline (default 30 s); for a `stream` call, only until the headers arrive. */
  timeoutMs?: number
}

export class ArgoUnavailable extends Error {
  constructor(readonly code: 'not_configured' | 'no_identity' | 'unreachable', detail: string) {
    super(detail)
  }
}

/** The argo-server client: identity selection, the base URL, timeouts. */
export class ArgoClient {
  readonly #o: ArgoClientOpts
  #cached: { token: string; at: number; expiresAt: number } | null = null
  #minting: Promise<string | null> | null = null

  constructor(opts: ArgoClientOpts) {
    this.#o = opts
  }

  get configured(): boolean {
    return Boolean(this.#o.baseUrl())
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now()
  }

  /** The service identity's bearer, minted or reused. */
  async serviceToken(): Promise<string | null> {
    const c = this.#cached
    const now = this.#now()
    if (c && now - c.at < TOKEN_REUSE_MS && c.expiresAt - now > 60_000) return c.token
    this.#minting ??= (async () => {
      try {
        const t = await this.#o.mintToken()
        this.#cached = t ? { token: t.token, at: this.#now(), expiresAt: t.expiresAt } : null
        return t?.token ?? null
      } finally {
        this.#minting = null
      }
    })()
    return await this.#minting
  }

  /** D-5. `id` is the caller already authorised by the SSAR in `authz.ts`. */
  async identity(id: K8sIdentity): Promise<ArgoIdentity> {
    if (this.#o.authState().effective === 'user' && id.token) return { bearer: id.token, mode: 'user' }
    const tok = await this.serviceToken()
    if (!tok) throw new ArgoUnavailable('no_identity', 'The console could not obtain a token for its argo-server ServiceAccount (adhar-system/adhar-console-argo).')
    return { bearer: tok, mode: 'service' }
  }

  /**
   * One call. `path` must already be built from validated, authorised values
   * (see the path builders below); the query is passed separately and is
   * never taken from the caller's request.
   */
  async fetch(
    id: K8sIdentity,
    path: string,
    init: { method?: string; query?: URLSearchParams; body?: unknown; accept?: string; signal?: AbortSignal; stream?: boolean } = {},
  ): Promise<{ res: Response; mode: ArgoMode }> {
    const base = this.#o.baseUrl().replace(/\/+$/, '')
    if (!base) throw new ArgoUnavailable('not_configured', 'argo-server is not configured (ARGO_SERVER_URL).')
    if (!path.startsWith('/')) throw new Error('argo-server path must be absolute')
    const url = `${base}${path}${init.query && [...init.query].length ? `?${init.query}` : ''}`
    const timeout = this.#o.timeoutMs ?? CALL_TIMEOUT_MS
    const send = async (bearer: string) => {
      // A JSON call is bounded end to end. A STREAM (an artifact download) is
      // bounded only until argo-server answers: a deadline on the whole body
      // would cut every download that takes longer than the deadline.
      const ctl = new AbortController()
      const timer = init.signal || !init.stream ? undefined : setTimeout(() => ctl.abort(new DOMException('argo-server timed out', 'TimeoutError')), timeout)
      const signal = init.signal ?? (init.stream ? ctl.signal : AbortSignal.timeout(timeout))
      try {
        const res = await (this.#o.fetch ?? fetch)(url, {
          method: init.method ?? 'GET',
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: init.accept ?? 'application/json',
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          redirect: 'manual',
          signal,
        })
        clearTimeout(timer)
        return res
      } catch (e) {
        clearTimeout(timer)
        throw e
      }
    }
    let who = await this.identity(id)
    let res: Response
    try {
      res = await send(who.bearer)
    } catch (e) {
      throw new ArgoUnavailable('unreachable', `argo-server did not answer: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.status === 401 && who.mode === 'user') {
      const tok = await this.serviceToken()
      if (tok) {
        await res.body?.cancel()
        who = { bearer: tok, mode: 'service' }
        try {
          res = await send(tok)
        } catch (e) {
          throw new ArgoUnavailable('unreachable', `argo-server did not answer: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    return { res, mode: who.mode }
  }

  /** Test seam. */
  forgetToken(): void {
    this.#cached = null
  }
}

/* ─────────────────────────── the console's client ─────────────────────────── */

/** `ARGO_SERVER_URL`, else the in-cluster Service when running in a cluster. */
export function argoServerUrl(): string {
  const explicit = env('ARGO_SERVER_URL')
  if (explicit !== undefined) return explicit.replace(/\/+$/, '')
  return env('KUBERNETES_SERVICE_HOST') ? DEFAULT_ARGO_SERVER_URL : ''
}

/** TokenRequest for `adhar-system/adhar-console-argo`, as the console's own ServiceAccount. */
export async function mintArgoToken(): Promise<{ token: string; expiresAt: number } | null> {
  const sa = getK8sServiceToken()
  if (!sa) return null
  const ns = env('ARGO_CONSOLE_SA_NAMESPACE') ?? ARGO_SA_NAMESPACE
  const name = env('ARGO_CONSOLE_SA') ?? ARGO_SA_NAME
  try {
    const res = await apiServerFetch(sa, `/api/v1/namespaces/${encodeURIComponent(ns)}/serviceaccounts/${encodeURIComponent(name)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { expirationSeconds: TOKEN_SECONDS } }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.warn(`[workflows] TokenRequest for ${ns}/${name} failed (HTTP ${res.status}) — grant the console ServiceAccount create serviceaccounts/token on it`)
      await res.body?.cancel()
      return null
    }
    const body = (await res.json()) as { status?: { token?: string; expirationTimestamp?: string } }
    const token = body.status?.token
    if (!token) return null
    const exp = Date.parse(body.status?.expirationTimestamp ?? '')
    return { token, expiresAt: Number.isFinite(exp) ? exp : Date.now() + TOKEN_SECONDS * 1000 }
  } catch (e) {
    console.warn(`[workflows] TokenRequest for ${ns}/${name} failed: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

let shared: ArgoClient | null = null

export function argoClient(): ArgoClient {
  shared ??= new ArgoClient({ baseUrl: argoServerUrl, authState: k8sAuthState, mintToken: mintArgoToken })
  return shared
}

/* ─────────────────────────── pinned paths ─────────────────────────── */

const e = encodeURIComponent

/**
 * argo-server paths, each built from a namespace and names the route already
 * validated and authorised. These are the only paths this BFF sends: there is
 * no generic proxy.
 */
export const argoPath = {
  version: () => '/api/v1/version',
  workflow: (ns: string, name: string) => `/api/v1/workflows/${e(ns)}/${e(name)}`,
  workflowAction: (ns: string, name: string, action: 'retry' | 'resubmit' | 'set' | 'resume') =>
    `/api/v1/workflows/${e(ns)}/${e(name)}/${action}`,
  archived: () => '/api/v1/archived-workflows',
  archivedOne: (uid: string) => `/api/v1/archived-workflows/${e(uid)}`,
  archivedAction: (uid: string, action: 'retry' | 'resubmit') => `/api/v1/archived-workflows/${e(uid)}/${action}`,
  artifact: (ns: string, name: string, nodeId: string, artifact: string) =>
    `/artifact-files/${e(ns)}/workflows/${e(name)}/${e(nodeId)}/outputs/${e(artifact)}`,
}

/** argo-server's error body (`{code, message}` from grpc-gateway), as text. */
export async function argoErrorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const j = JSON.parse(text) as { message?: string; error?: string }
    return (j.message ?? j.error ?? text).slice(0, 500)
  } catch {
    return text.slice(0, 500)
  }
}
