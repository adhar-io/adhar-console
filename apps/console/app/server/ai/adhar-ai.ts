import { env } from '@adhar-console/utils'

/**
 * Client for **adhar-ai**, the platform's agentic runtime.
 *
 * The console already runs agents of its own: a tool loop against an
 * OpenAI-compatible endpoint, with read-only tools scoped to the signed-in
 * user, streamed to the browser as AG-UI. That stays. adhar-ai is a different
 * thing and worth having alongside it — a governed runtime with its own tool
 * contract, retrieval grounding, operators that react to cluster events, and
 * one structural guarantee the console's own loop cannot make:
 *
 *   **Read tools read. Write tools open a pull request. Nothing applies to a
 *   cluster.** That is enforced at adhar-ai's source level, not by prompting.
 *
 * So the integration is delegation, not duplication: a run addressed to the
 * `adhar-ai` agent is handed to the runtime whole, and its answer is
 * translated into the same AG-UI events every other agent emits. The browser
 * cannot tell the difference, which is the point — one protocol, one surface.
 *
 * **Identity travels with the request.** adhar-ai resolves a Principal from the
 * caller's bearer token and pins autonomy to what that principal is allowed
 * (`ceiling`). Forwarding the console's own credential would collapse every
 * user into one identity and hand anonymous callers the runtime's authority, so
 * the SIGNED-IN USER's access token goes instead — the same token the console
 * already forwards to the apiserver for per-user RBAC.
 *
 *   ADHAR_AI_URL   e.g. http://adhar-ai-runtime.adhar-system.svc.cluster.local:8080
 */

/**
 * The autonomy ladder, exactly as adhar-ai defines it
 * (`runtime/autonomy.py: LADDER`). Authority only ever narrows as it flows: the
 * ConfigMap sets a ceiling, a request may ask for LESS, and an unauthenticated
 * or non-write-group caller is pinned lower still. Sending a value outside this
 * set is an error there, not a silent downgrade — hence the exact spelling,
 * hyphens included.
 */
export const AUTONOMY_LADDER = ['read-only', 'suggest', 'approve-to-apply', 'scoped'] as const
export type Autonomy = (typeof AUTONOMY_LADDER)[number]

/**
 * One tool the runtime called.
 *
 * Field names verified against a live run, not guessed: adhar-ai emits
 * `{tool, args, decision}` — NOT the OpenAI-shaped `{name, arguments, result}`
 * an LLM tool call uses. `decision` is the outcome ("ok", "error", or a policy
 * refusal), and there is no result payload: the transcript records what was
 * asked and how it went, not what came back.
 */
export interface AdharAiToolCall {
  tool?: string
  args?: Record<string, unknown>
  decision?: string
  [k: string]: unknown
}

export interface AdharAiPullRequest {
  url?: string
  title?: string
  repo?: string
  branch?: string
  number?: number
  [k: string]: unknown
}

/** The `/chat` payload — `AgentResult.as_dict()` plus the route's additions. */
export interface AdharAiResult {
  kind: 'answer' | 'proposed' | 'budget_exhausted' | 'error'
  text: string
  pull_requests: AdharAiPullRequest[]
  tool_calls: AdharAiToolCall[]
  steps: number
  audit_id: string
  error: string
  /** First heading of each retrieved document the answer was grounded on. */
  grounded_on?: string[]
  principal?: {
    subject?: string
    method?: string
    authenticated?: boolean
    groups?: string[]
    write_allowed?: boolean
  }
  autonomy?: Autonomy
}

export interface AdharAiFinding {
  id?: string
  operator?: string
  severity?: string
  title?: string
  summary?: string
  created_at?: string
  [k: string]: unknown
}

export interface AdharAiRuntimeConfig {
  operators?: Record<string, { autonomy?: string; allowedTools?: string[] }>
  mcpServers?: unknown
  [k: string]: unknown
}

function baseUrl(): string | null {
  const raw = env('ADHAR_AI_URL')?.replace(/\/+$/, '')
  return raw || null
}

export function isAdharAiConfigured(): boolean {
  return baseUrl() !== null
}

/**
 * Timeout for a full agentic run.
 *
 * Generous on purpose: an adhar-ai run is a multi-step tool loop against a real
 * cluster, not one completion, and cutting it off at a typical HTTP default
 * would fail exactly the useful investigations. Still bounded, so a wedged
 * runtime surfaces as an error rather than a stream that never ends.
 */
const RUN_TIMEOUT_MS = 180_000
const META_TIMEOUT_MS = 10_000

async function call<T>(
  path: string,
  init: RequestInit & { bearer?: string; timeoutMs?: number },
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const base = baseUrl()
  if (!base) return { ok: false, status: 0, error: 'adhar-ai is not configured (ADHAR_AI_URL)' }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? META_TIMEOUT_MS)
  // Honour a caller's cancellation too — a closed browser tab should not leave
  // a three-minute request running server-side.
  init.signal?.addEventListener('abort', () => ctrl.abort(), { once: true })

  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    const text = await res.text()
    if (!res.ok) {
      // FastAPI puts the useful part in `detail`; fall back to the raw body.
      let detail = text.slice(0, 400)
      try {
        const parsed = JSON.parse(text) as { detail?: unknown }
        if (parsed.detail) detail = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail)
      } catch { /* not JSON — the raw body is the best we have */ }
      return { ok: false, status: res.status, error: detail || `HTTP ${res.status}` }
    }
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T }
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      error: aborted ? 'adhar-ai did not answer in time' : `adhar-ai unreachable: ${(e as Error).message}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Run one agentic turn. `bearer` is the signed-in user's access token. */
export function adharAiChat(
  body: { prompt: string; autonomy?: Autonomy; model?: string; session?: string; user?: string },
  opts: { bearer?: string; signal?: AbortSignal } = {},
) {
  return call<AdharAiResult>('/chat', {
    method: 'POST',
    body: JSON.stringify(body),
    bearer: opts.bearer,
    signal: opts.signal,
    timeoutMs: RUN_TIMEOUT_MS,
  })
}

/** Operators and MCP servers the runtime has loaded. */
export function adharAiRuntimeConfig(opts: { bearer?: string } = {}) {
  return call<AdharAiRuntimeConfig>('/config', { method: 'GET', bearer: opts.bearer })
}

/** Findings the operators have produced (newest first). */
export function adharAiFindings(opts: { bearer?: string; limit?: number; operator?: string } = {}) {
  const q = new URLSearchParams()
  if (opts.limit) q.set('limit', String(opts.limit))
  if (opts.operator) q.set('operator', opts.operator)
  const qs = q.toString()
  return call<{ findings?: AdharAiFinding[]; items?: AdharAiFinding[] }>(
    `/findings${qs ? `?${qs}` : ''}`,
    { method: 'GET', bearer: opts.bearer },
  )
}

/** Liveness, for the config endpoint's status pill. */
export async function adharAiHealthy(): Promise<boolean> {
  const res = await call<unknown>('/healthz', { method: 'GET', timeoutMs: 4_000 })
  return res.ok
}
