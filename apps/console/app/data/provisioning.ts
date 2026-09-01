/**
 * Onboarding provisioning client — the two *real* BFF calls the onboarding
 * wizard makes when a new workspace is created. Nothing here fabricates
 * success: every function surfaces the server's actual response (or the real
 * failure) so the live provisioning screen can report honest per-step status.
 *
 *   1. `createOrganization(name)` → `POST /api/organizations` (create + activate).
 *      The BFF generates the slug + id, persists the org into the caller's
 *      per-user registry, and re-signs the session cookie with the new
 *      `activeTenant`. See `app/server/organizations.ts`.
 *   2. `toggleTool(name, enabled)` → `POST /api/platform/appset/toggle`. This is
 *      the GitOps marketplace write — it flips the tool's `enabled:` flag in the
 *      Adhar ApplicationSet YAML in Gitea and commits it; ArgoCD then reconciles.
 *      See `app/server/appset.ts`. In an environment where Gitea isn't wired
 *      (503) or the ApplicationSet element can't be located (404) the call
 *      resolves to an honest `unavailable` outcome rather than throwing — the UI
 *      shows "requested / not available here", never a fake ✓.
 */

export interface CreatedOrg {
  id: string
  name: string
  slug: string
  createdAt?: string
}

export interface CreateOrgResult {
  ok: boolean
  org?: CreatedOrg
  activeId?: string
  /** HTTP status, for the UI to distinguish auth/db failures from validation. */
  status: number
  /** Machine error code from the BFF (e.g. `name_required`, `store_unavailable`). */
  error?: string
  /** Human-readable detail, shown verbatim. */
  detail?: string
}

/** Outcome of a single tool toggle. `unavailable` = honestly requested, no backend here. */
export type ToggleOutcome = 'enabled' | 'already' | 'unavailable' | 'failed'

export interface ToggleResult {
  ok: boolean
  name: string
  outcome: ToggleOutcome
  status: number
  /** GitOps commit sha when the flip actually landed. */
  commit?: string
  commitUrl?: string
  repo?: string
  path?: string
  /** Human message — the server `note`/`detail`, shown verbatim. */
  detail?: string
  error?: string
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Create + activate a new organization via the real BFF endpoint. */
export async function createOrganization(name: string): Promise<CreateOrgResult> {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, status: 0, error: 'name_required', detail: 'Organization name is required.' }
  let res: Response
  try {
    res = await fetch('/api/organizations', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    })
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: 'network_error',
      detail: e instanceof Error ? e.message : 'Could not reach the console API.',
    }
  }
  const body = await readJson(res)
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : `http_${res.status}`,
      detail:
        (typeof body.detail === 'string' && body.detail) ||
        (typeof body.error === 'string' && body.error) ||
        `HTTP ${res.status}`,
    }
  }
  const org = body.organization as CreatedOrg | undefined
  return { ok: true, status: res.status, org, activeId: body.activeId as string | undefined }
}

/**
 * Enable (or disable) a platform tool through the GitOps ApplicationSet toggle.
 * Maps the BFF's real responses to an honest outcome:
 *   - 200 `{ changed:true }`  → `enabled` (commit landed)
 *   - 200 `{ changed:false }` → `already` (was already in the desired state)
 *   - 503 gitea_not_configured / 404 appset_file_not_found → `unavailable`
 *     (the tool is *requested* but this environment can't perform the GitOps write)
 *   - anything else → `failed` (retryable), with the server message verbatim
 */
export async function toggleTool(name: string, enabled = true, appset?: string): Promise<ToggleResult> {
  let res: Response
  try {
    res = await fetch('/api/platform/appset/toggle', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name, enabled, ...(appset ? { appset } : {}) }),
    })
  } catch (e) {
    return {
      ok: false,
      name,
      outcome: 'failed',
      status: 0,
      error: 'network_error',
      detail: e instanceof Error ? e.message : 'Could not reach the console API.',
    }
  }
  const body = await readJson(res)
  if (res.ok && body.ok) {
    const changed = body.changed !== false
    return {
      ok: true,
      name,
      outcome: changed ? 'enabled' : 'already',
      status: res.status,
      commit: body.commit as string | undefined,
      commitUrl: body.commitUrl as string | undefined,
      repo: body.repo as string | undefined,
      path: body.path as string | undefined,
      detail: body.note as string | undefined,
    }
  }
  const code = typeof body.error === 'string' ? body.error : `http_${res.status}`
  const detail =
    (typeof body.detail === 'string' && body.detail) ||
    (typeof body.error === 'string' && body.error) ||
    `HTTP ${res.status}`
  // Environments without the GitOps backend wired: honest "requested / unavailable",
  // not a failure the user can act on.
  const unavailable =
    res.status === 503 ||
    code === 'appset_file_not_found' ||
    code === 'gitea_not_configured' ||
    code === 'gitea_service_token_missing'
  return {
    ok: false,
    name,
    outcome: unavailable ? 'unavailable' : 'failed',
    status: res.status,
    error: code,
    detail,
  }
}
