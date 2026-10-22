import { isPlatformRepo } from '../data/catalog-platform-repos.ts'
import { CONSOLE_PERMISSIONS } from '@adhar/auth/server'
import { authorize, requirePermission } from './k8s/access.ts'
import { getRequestUser, unauthorized } from './request-user.ts'
import { audit, originOk } from './k8s/gateway.ts'
import { giteaConn, giteaFetcher } from './gitea-auth.ts'
import {
  actorName,
  canApplyFix,
  declaredOwner,
  fixCommitMessage,
  refName,
  validateFixRequest,
} from './scorecard-fix-model.ts'

/**
 * `POST /api/scorecards/fix` — commit a scorecard fix to the entity's
 * repository, as a pull request (default) or a direct commit.
 *
 *   body  { entityRef, owner?, org, repo, branch?, mode: 'pr'|'commit',
 *           newBranch?, title, description?, descriptorPath?,
 *           files: [{ path, content, baseSha: string|null }] }
 *   200   { ok: true, mode, base, branch, commit?, pr?: { number, url } }
 *   403   { error: 'forbidden', detail }       — not the owning team / an admin
 *   409   { error: 'stale', detail, path }      — the file changed since the preview
 *
 * The browser computes the change (it showed the diff); this handler is the
 * gate and the writer. It writes with the console's Gitea credentials — the
 * same ones the `/api/svc/gitea` proxy uses — so it must decide who may ask:
 * platform admins, and developers of the team that owns the entity. The owner
 * is read from the repository's own `catalog-info.yaml` when it declares one
 * (a client cannot claim a different team); only when the repository declares
 * none does the owner the catalog showed stand in.
 *
 * Every write is optimistic-concurrency checked against the blob sha the
 * preview was built on, so a fix never lands over a change it did not see. The
 * commit message names the console user ("via Adhar console by <name>") and the
 * commit carries them as author when the session has an email.
 */

function json(body: unknown, status: number, cookie?: string): Response {
  const res = Response.json(body, { status })
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

function b64(s: string): string {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

function decode(content: string): string {
  const bin = atob(content.replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')

async function readErr(r: Response): Promise<string> {
  const t = await r.text().catch(() => '')
  try {
    const j = JSON.parse(t) as { message?: string }
    return (j.message ?? t).slice(0, 300)
  } catch {
    return t.slice(0, 300)
  }
}


/**
 * Files a scorecard fix never writes. The commit is made with the console's
 * Gitea credentials, so a "fix" that drops a workflow or pipeline definition
 * would run arbitrary code in CI with that repository's secrets. No scorecard
 * check fixes CI files today.
 */
const CI_PATH = /^(\.gitea|\.github|\.forgejo|\.tekton|\.woodpecker|\.circleci)\/|^(\.drone\.yml|\.gitlab-ci\.yml|\.woodpecker\.yml|Jenkinsfile)$/i

export function fixPathRefused(path: string): boolean {
  return CI_PATH.test(path)
}

export async function handleScorecardFix(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') return new Response('Method Not Allowed', { status: 405 })
  if (!originOk(req)) return json({ error: 'forbidden', detail: 'Cross-origin request refused.' }, 403)
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const cookie = auth.refreshedCookie
  // Applying fixes at all is RBAC (`update scorecards.console.adhar.io`, the
  // check the Scorecards page hides its Fix buttons on); WHICH entities a
  // permitted user may fix is still the ownership rule below.
  const denied = await requirePermission(req, CONSOLE_PERMISSIONS.scorecardsRun)
  if (denied) {
    if (cookie) denied.headers.append('set-cookie', cookie)
    return denied
  }

  const parsed = validateFixRequest(await req.json().catch(() => null))
  if (!parsed.ok) return json({ error: 'invalid_request', detail: parsed.detail }, 400, cookie)
  const fix = parsed.value
  const ciFile = fix.files.find((f) => fixPathRefused(f.path))
  if (ciFile) {
    return json({ error: 'path_refused', detail: `${ciFile.path} is a CI definition; scorecard fixes do not change CI.` }, 400, cookie)
  }

  const conn = giteaConn()
  if (!conn) return json({ error: 'gitea_not_configured', detail: 'Gitea is not configured on the console, so the fix cannot be committed.' }, 503, cookie)
  const gitea = giteaFetcher(conn)
  const repoPath = `/repos/${encodeURIComponent(fix.org)}/${encodeURIComponent(fix.repo)}`

  try {
    const repoRes = await gitea(repoPath)
    if (repoRes.status === 404) return json({ error: 'not_found', detail: `Repository ${fix.org}/${fix.repo} not found.` }, 404, cookie)
    if (!repoRes.ok) return json({ error: 'gitea_unavailable', detail: `Gitea: ${repoRes.status} ${await readErr(repoRes)}` }, 502, cookie)
    const repo = (await repoRes.json()) as { name?: string; default_branch?: string; archived?: boolean; mirror?: boolean }
    // Platform repositories (and pull mirrors) are not application code; a
    // fix is committed with admin credentials and would otherwise land there.
    // Whoever may manage platform packages owns them and keeps the ability.
    if (isPlatformRepo(repo.name ?? fix.repo, repo) && !(await authorize(req, CONSOLE_PERMISSIONS.packagesToggle)).allowed) {
      return json({ error: 'platform_repo', detail: `${fix.org}/${fix.repo} is a platform repository; scorecard fixes apply to application repositories only.` }, 403, cookie)
    }
    if (repo.archived) return json({ error: 'archived', detail: `${fix.org}/${fix.repo} is archived.` }, 409, cookie)
    const base = fix.branch || repo.default_branch || 'main'

    // Current state of every file — for the concurrency check and the
    // create/update split Gitea's multi-file API wants.
    const current = await Promise.all(fix.files.map(async (f) => {
      const r = await gitea(`${repoPath}/contents/${enc(f.path)}?ref=${encodeURIComponent(base)}`)
      if (r.status === 404) {
        await r.body?.cancel()
        return { sha: null as string | null }
      }
      if (!r.ok) throw new Error(`Gitea: reading ${f.path} failed (${r.status} ${await readErr(r)})`)
      const body = (await r.json()) as { sha?: string; type?: string }
      if (body.type && body.type !== 'file') throw new Error(`${f.path} is a ${body.type}, not a file.`)
      return { sha: body.sha ?? null }
    }))
    for (const [i, f] of fix.files.entries()) {
      if ((current[i].sha ?? null) !== f.baseSha) {
        return json({
          error: 'stale',
          path: f.path,
          detail: f.baseSha === null
            ? `${f.path} now exists in ${base} — reopen the fix to see it.`
            : `${f.path} changed in ${base} since the preview — reopen the fix to rebuild it on the latest version.`,
        }, 409, cookie)
      }
    }

    // Who owns this entity: the repository's own declaration wins. When it
    // declares none and this fix sets one, the team being set is the one the
    // user must belong to (a developer can claim an unowned service for their
    // own team, not for somebody else's). Only with neither does the owner the
    // catalog showed stand in.
    const name = refName(fix.entityRef)
    const descriptorPath = fix.descriptorPath ?? 'catalog-info.yaml'
    let declared: string | undefined
    const d = await gitea(`${repoPath}/contents/${enc(descriptorPath)}?ref=${encodeURIComponent(base)}`)
    if (d.ok) {
      const body = (await d.json()) as { content?: string; encoding?: string }
      const text = body.content ? (body.encoding === 'base64' ? decode(body.content) : body.content) : ''
      declared = declaredOwner(text, name)
    } else {
      await d.body?.cancel()
    }
    const written = fix.files.find((f) => f.path === descriptorPath)
    const owner = declared ?? (written ? declaredOwner(written.content, name) : undefined) ?? fix.owner
    const gate = canApplyFix(auth.user, owner)
    if (!gate.ok) {
      audit({ action: 'scorecard.fix', user: auth.user?.email ?? auth.user?.id, entity: fix.entityRef, repo: `${fix.org}/${fix.repo}`, outcome: 'forbidden' })
      return json({ error: 'forbidden', detail: gate.reason }, 403, cookie)
    }

    const who = actorName(auth.user as { name?: string; email?: string; username?: string; id?: string })
    const email = (auth.user as { email?: string }).email
    const commitRes = await gitea(`${repoPath}/contents`, {
      method: 'POST',
      body: JSON.stringify({
        branch: base,
        ...(fix.mode === 'pr' ? { new_branch: fix.newBranch } : {}),
        message: fixCommitMessage(fix.title, who, fix.description),
        ...(email ? { author: { name: who, email } } : {}),
        files: fix.files.map((f, i) => ({
          operation: current[i].sha ? 'update' : 'create',
          path: f.path,
          content: b64(f.content),
          ...(current[i].sha ? { sha: current[i].sha } : {}),
        })),
      }),
    })
    if (!commitRes.ok) {
      const detail = await readErr(commitRes)
      audit({ action: 'scorecard.fix', user: auth.user?.email ?? auth.user?.id, entity: fix.entityRef, repo: `${fix.org}/${fix.repo}`, outcome: 'commit_failed', detail })
      const status = commitRes.status === 409 || commitRes.status === 422 ? 409 : 502
      return json({ error: status === 409 ? 'conflict' : 'gitea_unavailable', detail: `Gitea refused the commit: ${detail}` }, status, cookie)
    }
    const committed = (await commitRes.json().catch(() => ({}))) as { commit?: { sha?: string; html_url?: string } }

    let pr: { number: number; url?: string } | undefined
    if (fix.mode === 'pr') {
      const prRes = await gitea(`${repoPath}/pulls`, {
        method: 'POST',
        body: JSON.stringify({
          head: fix.newBranch,
          base,
          title: fix.title,
          body: `${fix.description ? `${fix.description}\n\n` : ''}Opened from the Scorecards page for \`${fix.entityRef}\` via Adhar console by ${who}.`,
        }),
      })
      if (!prRes.ok) {
        const detail = await readErr(prRes)
        // The commit is on its branch; say so rather than pretending nothing happened.
        return json({
          error: 'pr_failed',
          branch: fix.newBranch,
          detail: `The change was committed to branch ${fix.newBranch}, but opening the pull request failed: ${detail}`,
        }, 502, cookie)
      }
      const created = (await prRes.json()) as { number: number; html_url?: string }
      pr = { number: created.number, ...(created.html_url ? { url: created.html_url } : {}) }
    }

    audit({
      action: 'scorecard.fix',
      user: auth.user?.email ?? auth.user?.id,
      entity: fix.entityRef,
      repo: `${fix.org}/${fix.repo}`,
      mode: fix.mode,
      files: fix.files.map((f) => f.path),
      outcome: 'ok',
      ...(pr ? { pr: pr.number } : {}),
    })
    return json({
      ok: true,
      mode: fix.mode,
      base,
      branch: fix.mode === 'pr' ? fix.newBranch : base,
      ...(committed.commit?.sha ? { commit: committed.commit.sha } : {}),
      ...(pr ? { pr } : {}),
    }, 200, cookie)
  } catch (e) {
    return json({ error: 'gitea_unavailable', detail: e instanceof Error ? e.message : String(e) }, 502, cookie)
  }
}
