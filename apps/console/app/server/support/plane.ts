import { getTool } from '../tool-registry.ts'

/**
 * The slice of Plane's v1 REST API support tickets use, called with the
 * console's own API key (`PLANE_TOKEN`, the `plane` tool's `x-api-key`).
 *
 * RATE LIMIT. Plane throttles each API key (`API_KEY_RATE_LIMIT`, 60/minute on
 * this platform) and the console has ONE key, which every person browsing the
 * Define phase is also spending. So every call here goes through one serial
 * limiter that (1) spaces calls to `callsPerMinute` (default 20, a third of the
 * budget), (2) reads `X-RateLimit-Remaining` / `X-RateLimit-Reset` and waits
 * for the reset when the budget is nearly gone, and (3) on 429 or 5xx backs off
 * and retries a bounded number of times. Tickets are background work; a person
 * in the UI waiting on Plane is not.
 */

export interface PlaneProject { id: string; name: string; identifier: string }
export interface PlaneState { id: string; name: string; group: string }
export interface PlaneLabel { id: string; name: string }
export interface PlaneIssue { id: string; sequence_id?: number; name?: string; state?: string }

export interface PlaneApi {
  listProjects(): Promise<PlaneProject[]>
  createProject(body: { name: string; identifier: string; description?: string }): Promise<PlaneProject>
  listStates(project: string): Promise<PlaneState[]>
  listLabels(project: string): Promise<PlaneLabel[]>
  createLabel(project: string, body: { name: string; color?: string }): Promise<PlaneLabel>
  createIssue(project: string, body: { name: string; description_html: string; priority: string; labels?: string[] }): Promise<PlaneIssue>
  updateIssue(project: string, id: string, patch: { state?: string; priority?: string }): Promise<PlaneIssue>
  createComment(project: string, id: string, html: string): Promise<void>
  /** Relate two work items (best-effort; older Plane builds lack the endpoint). */
  relate(project: string, id: string, other: string): Promise<void>
  /** Upload a file to a work item (presigned upload, then mark uploaded). */
  attach(project: string, id: string, file: { name: string; type: string; bytes: Uint8Array }): Promise<void>
  /** Browser URL of a work item. */
  issueUrl(project: string, id: string): string
}

export class PlaneError extends Error {
  constructor(readonly status: number, readonly path: string, detail: string) {
    super(`Plane ${status} on ${path}${detail ? `: ${detail}` : ''}`)
  }
}

/* ─────────────────────────── limiter ─────────────────────────── */

export interface LimiterClock {
  now(): number
  sleep(ms: number): Promise<void>
}

const realClock: LimiterClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }

/**
 * Serial, spaced, header-aware. `run` resolves with the fetch Response the
 * caller then reads; retries are inside. Exported for tests.
 */
export class PlaneLimiter {
  private chain: Promise<unknown> = Promise.resolve()
  private nextAt = 0
  private pausedUntil = 0
  constructor(
    private readonly callsPerMinute = 20,
    private readonly clock: LimiterClock = realClock,
    private readonly maxAttempts = 4,
  ) {}

  run(call: () => Promise<Response>): Promise<Response> {
    const p = this.chain.then(() => this.attempt(call))
    // Keep the chain alive whatever this call does.
    this.chain = p.catch(() => undefined)
    return p
  }

  private async attempt(call: () => Promise<Response>): Promise<Response> {
    let res: Response | undefined
    for (let i = 0; i < this.maxAttempts; i++) {
      const wait = Math.max(this.nextAt, this.pausedUntil) - this.clock.now()
      if (wait > 0) await this.clock.sleep(wait)
      this.nextAt = this.clock.now() + Math.ceil(60_000 / Math.max(1, this.callsPerMinute))
      try {
        res = await call()
      } catch (e) {
        if (i === this.maxAttempts - 1) throw e
        await this.clock.sleep(backoff(i))
        continue
      }
      this.observe(res)
      if (res.status === 429 || res.status >= 500) {
        if (i === this.maxAttempts - 1) return res
        await res.body?.cancel()
        const retryAfter = Number(res.headers.get('retry-after'))
        const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.untilReset(res) ?? backoff(i)
        this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + Math.min(pause, 120_000))
        continue
      }
      return res
    }
    return res!
  }

  /** Milliseconds until the window resets, from `X-RateLimit-Reset` (epoch seconds). */
  private untilReset(res: Response): number | undefined {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    if (!Number.isFinite(reset) || reset <= 0) return undefined
    return Math.max(1_000, reset * 1000 - this.clock.now())
  }

  private observe(res: Response) {
    const remaining = Number(res.headers.get('x-ratelimit-remaining'))
    // Leave the last few calls of the window to the people using the UI.
    if (Number.isFinite(remaining) && res.headers.has('x-ratelimit-remaining') && remaining <= 5) {
      const until = this.untilReset(res)
      if (until) this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + until)
    }
  }
}

const backoff = (attempt: number) => Math.min(60_000, 2_000 * 2 ** attempt)

/* ─────────────────────────── client ─────────────────────────── */

export interface PlaneClientOptions {
  baseUrl: string
  headers: Record<string, string>
  workspace: string
  /** Browser-facing Plane origin, for links in notifications. */
  publicUrl: string
  fetch?: typeof fetch
  limiter?: PlaneLimiter
  timeoutMs?: number
}

/** Rows of a Plane list, bare array or `{results}` page. */
function rows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  const r = (raw as { results?: unknown })?.results
  return Array.isArray(r) ? (r as T[]) : []
}

export function createPlaneApi(opts: PlaneClientOptions): PlaneApi {
  const f = opts.fetch ?? fetch
  const limiter = opts.limiter ?? new PlaneLimiter()
  const ws = `/api/v1/workspaces/${encodeURIComponent(opts.workspace)}`
  const proj = (p: string) => `${ws}/projects/${encodeURIComponent(p)}`

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await limiter.run(() =>
      f(`${opts.baseUrl}${path}`, {
        method,
        headers: { ...opts.headers, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      })
    )
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      throw new PlaneError(res.status, path, text)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  return {
    listProjects: async () => rows<PlaneProject>(await call('GET', `${ws}/projects/?per_page=100`)),
    createProject: (body) => call('POST', `${ws}/projects/`, body),
    listStates: async (p) => rows<PlaneState>(await call('GET', `${proj(p)}/states/`)),
    listLabels: async (p) => rows<PlaneLabel>(await call('GET', `${proj(p)}/labels/?per_page=100`)),
    createLabel: (p, body) => call('POST', `${proj(p)}/labels/`, body),
    createIssue: (p, body) => call('POST', `${proj(p)}/issues/`, body),
    updateIssue: (p, id, patch) => call('PATCH', `${proj(p)}/issues/${encodeURIComponent(id)}/`, patch),
    createComment: async (p, id, html) => {
      await call('POST', `${proj(p)}/issues/${encodeURIComponent(id)}/comments/`, { comment_html: html })
    },
    relate: async (p, id, other) => {
      await call('POST', `${proj(p)}/work-items/${encodeURIComponent(id)}/relations/`, { relation_type: 'relates_to', issues: [other] })
    },
    attach: async (p, id, file) => {
      // Plane hands out a presigned S3 POST, the bytes go straight to object
      // storage, then the attachment is marked uploaded.
      const created = await call<{ upload_data?: { url?: string; fields?: Record<string, string> }; asset_id?: string }>(
        'POST',
        `${proj(p)}/issues/${encodeURIComponent(id)}/issue-attachments/`,
        { name: file.name, type: file.type, size: file.bytes.byteLength },
      )
      const up = created?.upload_data
      if (!up?.url || !created.asset_id) throw new Error('Plane returned no upload target for the attachment')
      const form = new FormData()
      for (const [k, v] of Object.entries(up.fields ?? {})) form.append(k, v)
      form.append('file', new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }), file.name)
      const res = await f(up.url, { method: 'POST', body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) })
      await res.body?.cancel()
      if (!res.ok) throw new Error(`attachment upload failed (HTTP ${res.status})`)
      await call('PATCH', `${proj(p)}/issues/${encodeURIComponent(id)}/issue-attachments/${encodeURIComponent(created.asset_id)}/`, { is_uploaded: true })
    },
    issueUrl: (p, id) =>
      opts.publicUrl ? `${opts.publicUrl.replace(/\/$/, '')}/${opts.workspace}/projects/${p}/issues/${id}` : '',
  }
}

/** The workspace the Define phase uses — same resolution as `/api/config`. */
export function planeWorkspace(env: (k: string) => string | undefined): string {
  return env('PLANE_WORKSPACE') ?? env('PLANE_WORKSPACE_SLUG') ?? env('GITEA_TEMPLATES_ORG') ?? env('GITEA_ORG') ?? 'adhar'
}

let shared: PlaneApi | null | undefined
const sharedLimiter = new PlaneLimiter()

/**
 * The console's Plane client, or null when Plane is not wired (no URL or no
 * API key) — in which case support tickets stay off and say so once.
 */
export function planeApiFromEnv(env: (k: string) => string | undefined, publicUrl: string): PlaneApi | null {
  if (shared !== undefined) return shared
  const tool = getTool('plane')
  if (!tool?.baseUrl || !tool.serviceToken) {
    shared = null
    return null
  }
  shared = createPlaneApi({
    baseUrl: tool.baseUrl,
    headers: { 'x-api-key': tool.serviceToken },
    workspace: planeWorkspace(env),
    publicUrl,
    limiter: sharedLimiter,
  })
  return shared
}
