import { env } from '@adhar-console/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { getTool } from './tool-registry.ts'
import { apiServerFetch, resolveIdentity } from './k8s/gateway.ts'

/**
 * Marketplace enable/disable — the GitOps write behind the Adhar Marketplace.
 *
 * The Marketplace lists the elements of the Adhar `helm-charts-*`
 * **ApplicationSet** (kind `ApplicationSet`, `argoproj.io/v1alpha1`, namespace
 * `adhar-system`). Each element is `{ name|packageName, enabled, namespace,
 * category, manifestPath, plane? }`; a generator `selector.matchLabels.enabled:
 * "true"` gates which elements actually deploy. Enabling/disabling an app is
 * therefore a single change: flip that element's `enabled` value in the
 * ApplicationSet YAML — **exactly what a platform engineer would do by editing
 * the file in Gitea directly**. ArgoCD then reconciles the change.
 *
 * Because the edit needs the platform Gitea **service token**, it MUST run
 * server-side (the browser only ever talks to the per-user k8s gateway). This
 * handler:
 *   1. authenticates the caller (`getRequestUser`) and requires Gitea to be
 *      configured (503 otherwise);
 *   2. discovers the ApplicationSet's Gitea repo + file path from the ArgoCD
 *      Application that manages the ApplicationSet resource (its
 *      `.spec.source.repoURL` + `.spec.source.path`, or the resource's
 *      `argocd.argoproj.io/tracking-id` annotation), read server-side through
 *      the k8s gateway;
 *   3. falls back to the `ADHAR_APPSET_REPO` / `ADHAR_APPSET_FILE` env vars when
 *      discovery can't pin the file (see below);
 *   4. GETs the file from Gitea, performs a **scoped** edit — it locates the
 *      `- name: "<name>"` (or `- packageName: "<name>"`) block and rewrites only
 *      that block's `enabled:` line, preserving all other YAML formatting and
 *      comments — and PUTs it back (a commit) with the service token.
 *
 * Environment (all optional — used for discovery fallback / overrides):
 *   - `ADHAR_APPSET_NAMESPACE` — namespace of the ApplicationSet(s). Default
 *     `adhar-system`.
 *   - `ADHAR_APPSET_REPO` — Gitea `<owner>/<repo>` holding the ApplicationSet
 *     YAML when it can't be discovered from ArgoCD. Default `adhar/registry`.
 *     In the reference stack the source of truth is `adhar/packages`, so set
 *     this to `adhar/packages` (or wherever your appset YAML is versioned).
 *   - `ADHAR_APPSET_FILE` — path to the ApplicationSet YAML inside that repo
 *     (e.g. `adhar-appset-local.yaml`). When unset a small set of conventional
 *     names is probed and the first file that actually contains the element is
 *     used.
 *   - `ADHAR_APPSET_BRANCH` — branch to read/commit. Default `main`.
 */

interface ToggleRequest {
  /** ApplicationSet name (e.g. `helm-charts-local`). Optional — discovered otherwise. */
  appset?: string
  /** App/package element name to flip. */
  name?: string
  /** Desired enabled state. */
  enabled?: boolean
}

const DEFAULT_NAMESPACE = 'adhar-system'
const DEFAULT_REPO = 'adhar/registry'
const DEFAULT_BRANCH = 'main'

/** UTF-8 safe base64 encode (Gitea contents API expects base64 bodies). */
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** UTF-8 safe base64 decode. */
function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function withCookie(res: Response, cookie?: string): Response {
  if (cookie) res.headers.append('set-cookie', cookie)
  return res
}

/** Escape a string for safe inclusion in a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scoped, formatting-preserving edit: find the `- name: "<name>"` (or
 * `- packageName: "<name>"`) list element and rewrite only its `enabled:` line.
 * Everything else in the document — indentation, quoting, comments, key order —
 * is left byte-identical. Returns the new text, or a reason it couldn't.
 */
export function flipElementEnabled(
  yaml: string,
  name: string,
  enabled: boolean,
): { ok: true; text: string; changed: boolean } | { ok: false; reason: string } {
  const lines = yaml.split('\n')
  const q = escapeRe(name)
  // The line declaring this element's name — either the block-opening
  // `- name: "<name>"` (Gitea source format) or a bare `name:`/`packageName:`
  // key when the `-` marker sits on a different (e.g. alphabetically-first) key.
  const nameLineRe = new RegExp(`^(\\s*)(-\\s+)?(?:name|packageName):\\s*(['"]?)${q}\\3\\s*$`)
  let ni = -1
  for (let i = 0; i < lines.length; i++) {
    if (nameLineRe.test(lines[i])) {
      ni = i
      break
    }
  }
  if (ni === -1) return { ok: false, reason: `element "${name}" not found in ApplicationSet` }

  // Column at which this element's keys are indented (the char after "- ").
  const nm = lines[ni].match(/^(\s*)(-\s+)?/) as RegExpMatchArray
  const keyCol = nm[1].length + (nm[2]?.length ?? 0)

  // Block start: the "- " marker line that opens this element. When the name
  // itself is the marker line we're already there; otherwise walk up to it.
  let bs = ni
  if (!nm[2]) {
    for (let i = ni - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.trim()) continue
      const indent = line.length - line.trimStart().length
      if (/^\s*-\s/.test(line) && indent < keyCol) {
        bs = i
        break
      }
      if (indent < keyCol) {
        bs = i + 1
        break
      }
    }
  }
  // Block end: the next sibling "- " marker (or any dedent below keyCol).
  let be = lines.length
  for (let i = bs + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (indent < keyCol) {
      be = i
      break
    }
  }

  // Rewrite this element's `enabled:` line only, preserving indent + quoting.
  const enabledRe = /^(\s*(?:-\s+)?enabled:\s*)(['"]?)(true|false)(\2)(\s*)$/
  for (let i = bs; i < be; i++) {
    const em = lines[i].match(enabledRe)
    if (em) {
      const nextVal = enabled ? 'true' : 'false'
      if (em[3] === nextVal) return { ok: true, text: yaml, changed: false }
      lines[i] = `${em[1]}${em[2]}${nextVal}${em[4]}${em[5]}`
      return { ok: true, text: lines.join('\n'), changed: true }
    }
  }
  return { ok: false, reason: `element "${name}" has no enabled: field to flip` }
}

/* ─────────────── ArgoCD-driven repo/path discovery ─────────────── */

interface DiscoveredSource {
  repo: string // owner/name
  path?: string // path inside the repo (dir or file)
  branch?: string
}

/** Parse a git repoURL into a Gitea `<owner>/<repo>` (strips host + `.git`). */
function repoFromUrl(repoURL: string | undefined): string | undefined {
  if (!repoURL) return undefined
  try {
    const u = new URL(repoURL)
    const segs = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/').filter(Boolean)
    if (segs.length >= 2) return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`
  } catch {
    // Not a URL (e.g. scp-style) — best effort split on the last two segments.
    const segs = repoURL.replace(/\.git$/, '').split(/[/:]/).filter(Boolean)
    if (segs.length >= 2) return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`
  }
  return undefined
}

function sourceOf(app: {
  spec?: { source?: { repoURL?: string; path?: string; targetRevision?: string }; sources?: Array<{ repoURL?: string; path?: string; targetRevision?: string }> }
}): DiscoveredSource | undefined {
  const src = app.spec?.source ?? app.spec?.sources?.[0]
  const repo = repoFromUrl(src?.repoURL)
  if (!repo) return undefined
  return { repo, path: src?.path, branch: src?.targetRevision }
}

/**
 * Best-effort: discover the Gitea repo (+ path) that version-controls the
 * ApplicationSet, by reading it and the ArgoCD Application that manages it
 * through the per-user k8s gateway. Returns undefined when nothing conclusive
 * is found (caller then uses the env fallback).
 */
async function discoverAppsetSource(
  req: Request,
  namespace: string,
  appsetName: string,
): Promise<DiscoveredSource | undefined> {
  const id = await resolveIdentity(req)
  if (!id) return undefined
  const argoRoot = `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(namespace)}`

  // 1) Read the ApplicationSet resource for a tracking-id annotation.
  let trackingApp: string | undefined
  try {
    const r = await apiServerFetch(id.token, `${argoRoot}/applicationsets/${encodeURIComponent(appsetName)}`)
    if (r.ok) {
      const obj = (await r.json()) as {
        metadata?: { annotations?: Record<string, string>; ownerReferences?: Array<{ kind?: string; name?: string }> }
      }
      const tracking = obj.metadata?.annotations?.['argocd.argoproj.io/tracking-id']
      // Format: "<appName>:<group>/<kind>:<namespace>/<name>"
      if (tracking) trackingApp = tracking.split(':')[0] || undefined
      if (!trackingApp) {
        const owner = obj.metadata?.ownerReferences?.find((o) => o.kind === 'Application')
        trackingApp = owner?.name
      }
    }
  } catch {
    /* gateway/apiserver unreachable — fall through to env */
  }

  // 2) If an owning/tracking Application is known, read its source.
  if (trackingApp) {
    try {
      const r = await apiServerFetch(id.token, `${argoRoot}/applications/${encodeURIComponent(trackingApp)}`)
      if (r.ok) {
        const app = await r.json()
        const src = sourceOf(app)
        if (src) return src
      }
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/* ─────────────── handler ─────────────── */

export async function handleAppsetToggle(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()

  let body: ToggleRequest
  try {
    body = (await req.json()) as ToggleRequest
  } catch {
    return withCookie(Response.json({ error: 'invalid_json' }, { status: 400 }), auth.refreshedCookie)
  }

  const name = String(body.name ?? '').trim()
  if (!name || !/^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,126})$/.test(name)) {
    return withCookie(Response.json({ error: 'invalid_name' }, { status: 400 }), auth.refreshedCookie)
  }
  if (typeof body.enabled !== 'boolean') {
    return withCookie(Response.json({ error: 'enabled_required' }, { status: 400 }), auth.refreshedCookie)
  }
  const enabled = body.enabled
  const appset = String(body.appset ?? '').trim() || undefined

  const gitea = getTool('gitea')
  if (!gitea?.baseUrl) {
    return withCookie(Response.json({ error: 'gitea_not_configured' }, { status: 503 }), auth.refreshedCookie)
  }
  if (!gitea.serviceToken) {
    return withCookie(
      Response.json({ error: 'gitea_service_token_missing', detail: 'set GITEA_TOKEN' }, { status: 503 }),
      auth.refreshedCookie,
    )
  }

  const namespace = env('ADHAR_APPSET_NAMESPACE') ?? DEFAULT_NAMESPACE
  const branch = env('ADHAR_APPSET_BRANCH') ?? DEFAULT_BRANCH

  const gitea_api = (path: string, init?: RequestInit) =>
    fetch(`${gitea.baseUrl}/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `token ${gitea.serviceToken}`,
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    })

  // ── resolve repo + candidate file paths (discovery → env fallback) ──
  const discovered = appset ? await discoverAppsetSource(req, namespace, appset) : undefined
  const envRepo = env('ADHAR_APPSET_REPO')
  const envFile = env('ADHAR_APPSET_FILE')
  const repoSpec = discovered?.repo || envRepo || DEFAULT_REPO
  const [owner, repoName] = repoSpec.split('/')
  if (!owner || !repoName) {
    return withCookie(
      Response.json({ error: 'appset_repo_unresolved', detail: `bad repo "${repoSpec}"` }, { status: 500 }),
      auth.refreshedCookie,
    )
  }
  const ref = discovered?.branch || branch

  // Candidate file paths, in priority order. A discovered `path` may be a
  // directory (ArgoCD tracks a dir) or a file; env override wins; otherwise we
  // probe conventional appset filenames and use the first that holds the element.
  const candidates: string[] = []
  const pushUnique = (p?: string) => {
    if (p && !candidates.includes(p)) candidates.push(p)
  }
  pushUnique(envFile)
  const dp = discovered?.path?.replace(/\/+$/, '')
  if (dp) {
    if (/\.(ya?ml)$/i.test(dp)) pushUnique(dp)
    else {
      for (const f of appsetFileGuesses(appset)) pushUnique(`${dp}/${f}`)
    }
  }
  for (const f of appsetFileGuesses(appset)) pushUnique(f)

  // ── GET the file that actually contains the element ──
  let filePath: string | undefined
  let fileSha: string | undefined
  let original: string | undefined
  let lastStatus = 0
  for (const cand of candidates) {
    let res: Response
    try {
      res = await gitea_api(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${cand}?ref=${encodeURIComponent(ref)}`,
      )
    } catch (e) {
      return withCookie(
        Response.json({ error: 'gitea_unreachable', detail: e instanceof Error ? e.message : '' }, { status: 502 }),
        auth.refreshedCookie,
      )
    }
    lastStatus = res.status
    if (!res.ok) continue
    const meta = (await res.json().catch(() => ({}))) as { content?: string; sha?: string; encoding?: string }
    if (!meta.content) continue
    const text = meta.encoding === 'base64' ? fromBase64(meta.content) : meta.content
    // Only accept a file that actually declares this element (so we edit the
    // right ApplicationSet even when several YAMLs live side by side).
    const probe = flipElementEnabled(text, name, enabled)
    if (probe.ok) {
      filePath = cand
      fileSha = meta.sha
      original = text
      break
    }
  }

  if (!filePath || original === undefined) {
    return withCookie(
      Response.json(
        {
          error: 'appset_file_not_found',
          detail:
            `Could not locate the ApplicationSet YAML containing "${name}" in ${repoSpec}. ` +
            'Set ADHAR_APPSET_REPO and ADHAR_APPSET_FILE to the repo + path that version-controls the ApplicationSet.',
          repo: repoSpec,
          tried: candidates,
          lastStatus,
        },
        { status: 404 },
      ),
      auth.refreshedCookie,
    )
  }

  // ── scoped edit ──
  const edit = flipElementEnabled(original, name, enabled)
  if (!edit.ok) {
    return withCookie(
      Response.json({ error: 'edit_failed', detail: edit.reason }, { status: 422 }),
      auth.refreshedCookie,
    )
  }
  if (!edit.changed) {
    // Already in the desired state — nothing to commit.
    return withCookie(
      Response.json({
        ok: true,
        name,
        enabled,
        gitops: true,
        changed: false,
        repo: repoSpec,
        path: filePath,
        note: `"${name}" is already ${enabled ? 'enabled' : 'disabled'} in ${repoSpec}/${filePath}.`,
      }),
      auth.refreshedCookie,
    )
  }

  // ── PUT (commit) the change back to Gitea ──
  let putRes: Response
  try {
    putRes = await gitea_api(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/${filePath}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          content: toBase64(edit.text),
          message: `chore(marketplace): ${enabled ? 'enable' : 'disable'} ${name} via Adhar Console`,
          sha: fileSha,
          branch: ref,
        }),
      },
    )
  } catch (e) {
    return withCookie(
      Response.json({ error: 'gitea_unreachable', detail: e instanceof Error ? e.message : '' }, { status: 502 }),
      auth.refreshedCookie,
    )
  }

  if (!putRes.ok) {
    const detail = (await putRes.text().catch(() => '')).slice(0, 300)
    return withCookie(
      Response.json({ error: 'commit_failed', status: putRes.status, detail }, { status: 502 }),
      auth.refreshedCookie,
    )
  }
  const commit = (await putRes.json().catch(() => ({}))) as { commit?: { sha?: string; html_url?: string } }

  return withCookie(
    Response.json({
      ok: true,
      name,
      enabled,
      gitops: true,
      changed: true,
      repo: repoSpec,
      path: filePath,
      commit: commit.commit?.sha,
      commitUrl: commit.commit?.html_url,
      note: `Committed to ${repoSpec}/${filePath}. ArgoCD will reconcile the ApplicationSet and ${enabled ? 'deploy' : 'remove'} ${name} shortly.`,
    }),
    auth.refreshedCookie,
  )
}

/** Conventional ApplicationSet filenames to probe, most-specific first. */
function appsetFileGuesses(appset?: string): string[] {
  const out: string[] = []
  if (appset) {
    out.push(`${appset}.yaml`, `${appset}.yml`)
    // helm-charts-local → adhar-appset-local.yaml (reference-stack convention)
    const suffix = appset.replace(/^helm-charts-?/, '')
    if (suffix && suffix !== appset) out.push(`adhar-appset-${suffix}.yaml`)
  }
  out.push(
    'adhar-appset-local.yaml',
    'adhar-appset-production.yaml',
    'applicationset.yaml',
    'appset.yaml',
  )
  return out
}
