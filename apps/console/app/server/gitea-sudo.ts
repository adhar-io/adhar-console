/**
 * Gitea writes through `/api/svc/gitea` act as the signed-in user.
 *
 * The proxy reaches Gitea with the platform's ADMIN credentials (Basic
 * `GITEA_USERNAME`/`GITEA_PASSWORD`, or `GITEA_TOKEN`). Before this, every
 * signed-in console user could create and delete repositories, merge pull
 * requests, push files and change settings anywhere in Gitea as that admin.
 *
 * Now every non-safe request (POST/PUT/PATCH/DELETE) carries Gitea's `Sudo`
 * header with the user's own Gitea username, so Gitea runs it AS that user and
 * applies that user's repository, team and organisation permissions — and its
 * own audit trail names them. Reads stay on the admin identity: the org-wide
 * listings, mirrors and search the console shows depend on it.
 *
 * Gitea's `sudo()` API middleware (routers/api/v1/api.go) takes the target from
 * `ctx.FormString("sudo")` FIRST and only falls back to the `Sudo` header when
 * that is empty. `FormString` reads the URL query AND, for POST/PUT/PATCH, a
 * form-encoded or multipart body — where the body value wins. So:
 *   • a client-supplied `Sudo` header and `sudo` query parameter are stripped
 *     from EVERY request (reads included — an admin read sudo'd as someone else
 *     would leak what that person can see);
 *   • a write whose form body names `sudo` is refused outright;
 *   • writes are only proxied to `/api/v1/…` — the only router that honours
 *     `Sudo`. A web route or git smart-HTTP push would run as the admin.
 *
 * Username mapping. Keycloak runs with `registrationEmailAsUsername`, so
 * `preferred_username` is the email, and Gitea's OAuth source auto-registers
 * with `USERNAME=preferred_username` → `NormalizeUserName()` → the email's
 * local part (`ACCOUNT_LINKING=auto` can instead link an existing local
 * account by email). The AUTHORITATIVE mapping is therefore the email: the
 * account is looked up with the admin `GET /api/v1/admin/emails/search` (Gitea
 * email addresses are unique across users). Only when that endpoint is not
 * usable is the normalised `preferred_username` tried, and then only when the
 * account's email matches the session's — two people called `jane@…` must
 * never be confused.
 *
 * Platform admins get no bypass: they are Gitea admins through the OAuth
 * source's `--admin-group platform-admin`, so acting as themselves already
 * lets them do everything, and the audit trail stays uniform.
 */

/** Methods that do not change state, and therefore stay on the admin identity. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isGiteaWrite(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase())
}

/** Writes are only allowed on Gitea's REST API, the one router that honours `Sudo`. */
export function isGiteaApiPath(path: string): boolean {
  // No dot segments, literal or percent-encoded. (`%2F` stays allowed: it is
  // how a branch name with a slash is addressed, e.g. DELETE …/branches/feat%2Fx.)
  return /^\/api\/v1(\/|$)/.test(path) && !/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(path)
}

/**
 * Mirror of Gitea's `user_model.NormalizeUserName` (models/user/user.go):
 * keep the part before `@`, map `Æ`, strip diacritics, drop `'`/`` ` ``/`´`,
 * and turn whitespace, `~` and `+` into `-`.
 */
export function normalizeGiteaUsername(s: string): string {
  const local = s.split('@')[0].replaceAll('Æ', 'AE')
  const plain = local.normalize('NFD').replace(/\p{Mn}/gu, '').normalize('NFC')
  return plain.replace(/['`´]/g, '').replace(/[\s~+]/g, '-')
}

/**
 * Remove every client-supplied impersonation hint from a request: the `Sudo`
 * header (any casing) and the `sudo` query parameter (any encoding — the
 * params are decoded before the check, as Go decodes them). Returns the query
 * string to forward, re-serialised only when something was removed.
 */
export function stripClientSudo(search: string, headers: Headers): string {
  headers.delete('sudo')
  if (!search || search === '?') return search
  const params = new URLSearchParams(search)
  if (![...params.keys()].some((k) => k === 'sudo')) return search
  params.delete('sudo')
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}

/**
 * Whether a write's body names `sudo` as a form field — Gitea would read it
 * ahead of the header, so the proxy refuses such a request rather than guess.
 */
export async function bodyNamesSudo(contentType: string | null, body: ArrayBuffer | undefined): Promise<boolean> {
  if (!body || body.byteLength === 0 || !contentType) return false
  const ct = contentType.toLowerCase()
  if (ct.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(new TextDecoder().decode(body)).has('sudo')
  }
  if (ct.includes('multipart/form-data')) {
    // Raw scan first: no parser disagreement can hide a `name="sudo"` part.
    const raw = new TextDecoder('latin1').decode(body)
    if (/content-disposition:[^\r\n]*\bname\*?\s*=\s*"?sudo"?(\s*;|\s*$|\r|\n)/im.test(raw)) return true
    try {
      const form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
      return form.has('sudo')
    } catch {
      // Unparseable multipart: Gitea would reject it too; refusing is safe.
      return true
    }
  }
  return false
}

/* ───────────────────────── identity resolution ───────────────────────── */

export interface SessionIdentity {
  email?: string
  username?: string
}

/** `GET` against Gitea's API (`/api/v1` prefix included in `path`) with the admin credentials. */
export type AdminGet = (path: string) => Promise<Response>

export type Resolution =
  | { ok: true; username: string }
  | { ok: false; reason: 'no_account' | 'no_identity' }
  | { ok: false; reason: 'lookup_failed'; detail: string }

const POSITIVE_TTL_MS = 10 * 60_000
/** Short, so someone who just signed in to Gitea for the first time can retry. */
const NEGATIVE_TTL_MS = 20_000
const cache = new Map<string, { username: string | null; exp: number }>()

export function invalidateGiteaIdentity(email?: string): void {
  if (email) cache.delete(email.toLowerCase())
  else cache.clear()
}

/** Resolve the Gitea username for a console session — see the module comment. */
export async function resolveGiteaUsername(
  who: SessionIdentity,
  get: AdminGet,
  now: () => number = Date.now,
): Promise<Resolution> {
  const email = who.email?.trim().toLowerCase()
  if (!email) return { ok: false, reason: 'no_identity' }
  const hit = cache.get(email)
  if (hit && hit.exp > now()) {
    return hit.username ? { ok: true, username: hit.username } : { ok: false, reason: 'no_account' }
  }

  const remember = (username: string | null): Resolution => {
    cache.set(email, { username, exp: now() + (username ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) })
    return username ? { ok: true, username } : { ok: false, reason: 'no_account' }
  }

  // 1. Authoritative: the admin email search (covers secondary addresses too).
  try {
    const r = await get(`/api/v1/admin/emails/search?q=${encodeURIComponent(email)}&limit=50`)
    if (r.ok) {
      const rows = (await r.json().catch(() => [])) as Array<{ email?: string; username?: string }>
      const match = Array.isArray(rows)
        ? rows.find((e) => e.email?.toLowerCase() === email && typeof e.username === 'string' && e.username)
        : undefined
      return remember(match?.username ?? null)
    }
    await r.body?.cancel()
  } catch (e) {
    return { ok: false, reason: 'lookup_failed', detail: e instanceof Error ? e.message : String(e) }
  }

  // 2. Fallback: the name Gitea's OAuth auto-registration would have chosen,
  //    accepted only when the account's email is the session's.
  const candidate = normalizeGiteaUsername(who.username || email)
  if (!candidate) return remember(null)
  try {
    const r = await get(`/api/v1/users/${encodeURIComponent(candidate)}`)
    if (r.status === 404) {
      await r.body?.cancel()
      return remember(null)
    }
    if (!r.ok) {
      await r.body?.cancel()
      return { ok: false, reason: 'lookup_failed', detail: `Gitea answered ${r.status} looking up ${candidate}` }
    }
    const u = (await r.json().catch(() => ({}))) as { login?: string; email?: string }
    return remember(u.email?.toLowerCase() === email && u.login ? u.login : null)
  } catch (e) {
    return { ok: false, reason: 'lookup_failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

/* ───────────────────────── errors the UI shows ───────────────────────── */

/**
 * JSON error bodies. `message` is what every Gitea-aware caller already reads
 * (Gitea's own error shape) and `userMessage` tells `HttpError` to use it as
 * the whole error text, so a toast reads as a sentence, not a URL dump.
 */
function userError(status: number, error: string, message: string, extra?: Record<string, unknown>): Response {
  return Response.json({ error, message, userMessage: message, ...extra }, { status })
}

export function accountMissing(publicGiteaUrl: string): Response {
  const where = publicGiteaUrl ? ` at ${publicGiteaUrl}` : ''
  return userError(
    403,
    'gitea_account_missing',
    `You don't have a Gitea account yet — sign in to Gitea once${where} to create it, then try again.`,
    publicGiteaUrl ? { giteaUrl: publicGiteaUrl } : undefined,
  )
}

export function noIdentity(): Response {
  return userError(403, 'gitea_identity_unknown', 'Your console session has no email address, so Gitea cannot tell who you are. Sign out and in again.')
}

export function lookupFailed(detail: string): Response {
  return userError(502, 'gitea_identity_lookup_failed', `Could not confirm your Gitea account, so nothing was changed (${detail}).`)
}

export function writePathRefused(): Response {
  return userError(403, 'gitea_write_path_refused', 'The console only sends changes to Gitea through its REST API (/api/v1).')
}

export function sudoParamRefused(): Response {
  return userError(400, 'gitea_sudo_refused', 'Requests may not choose which Gitea user they run as.')
}

/**
 * Rewrite a sudo'd write's error into something the user can act on, or
 * return null to pass Gitea's answer through untouched. `bodyText` is the
 * upstream body (already read). `stillExists` re-checks the account on a 404 —
 * Gitea's sudo middleware answers a vanished target user with the same bare
 * 404 as a missing repository.
 */
export async function mapSudoFailure(
  status: number,
  bodyText: string,
  ctx: { giteaUser: string; publicGiteaUrl: string; stillExists: () => Promise<boolean> },
): Promise<Response | null> {
  let message = ''
  try {
    message = String((JSON.parse(bodyText) as { message?: unknown }).message ?? '')
  } catch {
    message = bodyText.slice(0, 300)
  }
  if (status === 403 && /only administrators allowed to sudo/i.test(message)) {
    return userError(
      503,
      'gitea_sudo_unavailable',
      "The console's Gitea credentials are not a Gitea administrator, so it cannot make changes as you. Ask a platform admin to fix GITEA_USERNAME/GITEA_PASSWORD.",
    )
  }
  if (status === 404 && !(await ctx.stillExists())) return accountMissing(ctx.publicGiteaUrl)
  if (status === 403) {
    const why = message ? ` (${message})` : ''
    return userError(
      403,
      'gitea_forbidden',
      `Gitea refused this for your account ${ctx.giteaUser}${why}. Ask an owner of the repository's team for access.`,
      { giteaMessage: message },
    )
  }
  return null
}

/* ───────────────────────── audit ───────────────────────── */

export function auditGiteaWrite(entry: {
  user: string
  giteaUser?: string
  method: string
  path: string
  status: number
  outcome?: string
}): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'gitea.audit', ...entry }))
  } catch {
    // never let logging break a request
  }
}
