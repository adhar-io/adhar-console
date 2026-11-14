import { env, parseYaml } from '@adhar/utils'
import { getRequestUser, unauthorized } from './request-user.ts'
import { getK8sServiceToken, getTool } from './tool-registry.ts'
import { apiServerFetch, type K8sIdentity, resolveIdentity } from './k8s/gateway.ts'
import { requirePermission } from './k8s/access.ts'
import { CONSOLE_PERMISSIONS } from '@adhar/auth/server'

/*
 * Who may switch platform packages on and off is Kubernetes RBAC:
 * `update packages.console.adhar.io` (CONSOLE_PERMISSIONS.packagesToggle). A
 * toggle commits to the platform's own ApplicationSet with the console's Gitea
 * token, and Argo CD then installs or REMOVES that package for the whole
 * cluster (Kyverno, Keycloak, …) — a platform operation, not something any
 * signed-in user does. The Marketplace hides the switch on the same check.
 */

/** An ApplicationSet name: a DNS-1123-ish name, never a path. */
const APPSET_NAME = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/

/**
 * Map a console-facing component name onto the ApplicationSet element that
 * actually governs it — or say that nothing does.
 *
 * The console names platform components in several places (onboarding tool
 * picker, the Platform status page's health matchers) using names that are NOT
 * ApplicationSet elements. Toggling any of them used to fail with
 * `appset_file_not_found`, whose message blamed unset `ADHAR_APPSET_REPO` /
 * `ADHAR_APPSET_FILE` — so an operator saw five confident-looking configuration
 * errors for a repo and file that were configured correctly all along.
 *
 * Three cases, and they need different answers:
 *   * an ALIAS — a different spelling of a real package (`argo-rollouts` for the
 *     `argo-rollout` package). Toggle the real one.
 *   * a SUB-COMPONENT — shipped by a larger package (`grafana` and `prometheus`
 *     both come from `kube-prometheus`). Toggle the package that provides it.
 *   * ALWAYS INSTALLED — the bootstrap components the AdharPlatform controller
 *     installs imperatively before GitOps exists (`gitea`, `argocd`). There is no
 *     element to flip, and there could not be: ArgoCD cannot un-deploy itself.
 */
export function resolvePackageName(
  requested: string,
): { kind: 'package'; name: string } | { kind: 'always-installed'; why: string } {
  const ALWAYS_INSTALLED: Record<string, string> = {
    gitea: 'the adhar-controlplane Git server GitOps reads from',
    argocd: 'the GitOps engine itself',
    'argo-cd': 'the GitOps engine itself',
    cilium: 'the CNI',
    crossplane: 'the control plane',
  }
  // Alias or provided-by. Values must be real package directory names.
  const PROVIDED_BY: Record<string, string> = {
    'argo-rollouts': 'argo-rollout',
    grafana: 'kube-prometheus',
    prometheus: 'kube-prometheus',
    alertmanager: 'kube-prometheus',
    'kube-prometheus-stack': 'kube-prometheus',
    opentelemetry: 'alloy',
    otel: 'alloy',
  }
  const key = requested.toLowerCase()
  if (key in ALWAYS_INSTALLED) return { kind: 'always-installed', why: ALWAYS_INSTALLED[key] }
  return { kind: 'package', name: PROVIDED_BY[key] ?? requested }
}

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
 *      comments — and PUTs it back (a commit) with the service token;
 *   5. asks Argo CD to look now (`requestArgoRefresh`), because a Gitea push does
 *      not: the webhook names the repo by its public URL, every Application names
 *      it by the in-cluster Service, nothing matches, and the change would sit
 *      for the 120 s reconciliation period.
 *
 * `GET /api/platform/appset/desired` reads the same file back. The live
 * ApplicationSet object only changes once Argo CD has synced that commit, so for
 * those seconds Git is the only place that knows what was asked for, and it is
 * what lets a reload or a second tab show "Enabling…" instead of "Disabled".
 *
 * Environment (all optional — used for discovery fallback / overrides):
 *   - `ADHAR_APPSET_NAMESPACE` — namespace of the ApplicationSet(s). Default
 *     `adhar-system`.
 *   - `ADHAR_APPSET_REPO` — Gitea `<owner>/<repo>` holding the ApplicationSet
 *     YAML when it can't be discovered from ArgoCD. Default `adhar/packages`:
 *     seeding commits the profile's ApplicationSet there as
 *     `applicationset.yaml`, and the `adhar-platform-applicationset` Argo CD
 *     Application keeps the live object equal to it.
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
const DEFAULT_REPO = 'adhar/packages'
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

/**
 * ApplicationSet elements that are one package split in two, switched on and off
 * TOGETHER. `adhar-batch-volcano` carries the policies naming Volcano's kinds (the
 * queue binding, Volcano run integrity, prod-only classes); it is a separate element
 * only because Kyverno refuses a policy whose kind the cluster does not serve.
 * Enabling `volcano` alone would run Volcano with no queue binding — any team could
 * name any queue. Mirrors `companions` in the adhar CLI's cmd/stack/profile.go.
 */
export const COMPANION_ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  volcano: ['adhar-batch-volcano'],
  'adhar-batch-volcano': ['volcano'],
}

/**
 * Flip `name` and every companion this file declares, in one edit, so they land
 * in one commit. A companion the file does not wire is skipped (an older stack
 * still toggles the package); one that exists but cannot be flipped fails the
 * whole edit rather than committing half a package.
 */
export function flipElementWithCompanions(
  yaml: string,
  name: string,
  enabled: boolean,
): { ok: true; text: string; changed: boolean; companions: string[] } | { ok: false; reason: string } {
  const first = flipElementEnabled(yaml, name, enabled)
  if (!first.ok) return first
  let text = first.text
  let changed = first.changed
  const companions: string[] = []
  for (const c of COMPANION_ELEMENTS[name] ?? []) {
    const edit = flipElementEnabled(text, c, enabled)
    if (!edit.ok) {
      if (edit.reason.endsWith('not found in ApplicationSet')) continue
      return { ok: false, reason: `${c} (switched with ${name}): ${edit.reason}` }
    }
    text = edit.text
    if (edit.changed) {
      changed = true
      companions.push(c)
    }
  }
  return { ok: true, text, changed, companions }
}

/* ─────────────── ArgoCD-driven repo/path discovery ─────────────── */

interface DiscoveredSource {
  repo: string // owner/name
  path?: string // path inside the repo (dir or file)
  branch?: string
  /** The Argo CD Application that syncs the ApplicationSet from Git. */
  app?: string
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
    const r = await apiServerFetch(id, `${argoRoot}/applicationsets/${encodeURIComponent(appsetName)}`)
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
      const r = await apiServerFetch(id, `${argoRoot}/applications/${encodeURIComponent(trackingApp)}`)
      if (r.ok) {
        const app = await r.json()
        const src = sourceOf(app)
        if (src) return { ...src, app: trackingApp }
      }
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/* ─────────────── what Git says ─────────────── */

/** Every element's `enabled`, read the way the generator reads it: anything but `"true"` is off. */
export function readElementsEnabled(yaml: string): Record<string, boolean> {
  const doc = parseYaml(yaml) as
    | {
      spec?: {
        generators?: Array<{
          list?: { elements?: RawYamlElement[] }
          matrix?: { generators?: Array<{ list?: { elements?: RawYamlElement[] } }> }
        }>
      }
    }
    | null
  const out: Record<string, boolean> = {}
  for (const g of doc?.spec?.generators ?? []) {
    const lists = [g.list?.elements, ...(g.matrix?.generators ?? []).map((m) => m.list?.elements)]
    for (const els of lists) {
      for (const e of els ?? []) {
        const name = e.name ?? e.packageName
        if (name) out[name] = String(e.enabled) === 'true'
      }
    }
  }
  return out
}

interface RawYamlElement {
  name?: string
  packageName?: string
  enabled?: unknown
}

export interface DesiredState {
  appset: string
  repo: string
  path: string
  /** When the file last changed, which is when any toggle in it was last asked for. */
  changedAt?: string
  elements: Record<string, boolean>
}

/**
 * Brief, so one watch burst across several tabs is one Gitea read. A toggle on
 * this replica clears it; another replica's toggle shows after this long.
 */
const DESIRED_TTL_MS = 3_000
const desiredCache = new Map<string, { at: number; state: DesiredState }>()

export async function handleAppsetDesired(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'GET') return new Response('Method Not Allowed', { status: 405 })
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const reply = (body: unknown, status = 200) =>
    withCookie(Response.json(body, { status, headers: { 'cache-control': 'no-store' } }), auth.refreshedCookie)

  const appset = (new URL(req.url).searchParams.get('appset') ?? '').trim()
  if (!appset || !APPSET_NAME.test(appset) || appset.includes('..')) return reply({ error: 'invalid_appset' }, 400)

  const cached = desiredCache.get(appset)
  if (cached && Date.now() - cached.at < DESIRED_TTL_MS) return reply(cached.state)

  const gitea = getTool('gitea')
  if (!gitea?.baseUrl || !gitea.serviceToken) return reply({ error: 'gitea_not_configured' }, 503)
  const api = (path: string) =>
    fetch(`${gitea.baseUrl}/api/v1${path}`, {
      headers: { authorization: `token ${gitea.serviceToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })

  const at = Date.now()
  const { repoSpec, owner, repoName, ref, candidates } = await resolveAppsetFiles(req, appset)
  if (!owner || !repoName) return reply({ error: 'appset_repo_unresolved', detail: `bad repo "${repoSpec}"` }, 500)
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`

  try {
    for (const cand of candidates) {
      const res = await api(`${repoPath}/contents/${cand}?ref=${encodeURIComponent(ref)}`)
      if (!res.ok) {
        await res.body?.cancel()
        continue
      }
      const meta = (await res.json().catch(() => ({}))) as { content?: string; encoding?: string }
      if (!meta.content) continue
      const elements = readElementsEnabled(meta.encoding === 'base64' ? fromBase64(meta.content) : meta.content)
      if (Object.keys(elements).length === 0) continue
      const state: DesiredState = {
        appset,
        repo: repoSpec,
        path: cand,
        changedAt: await lastCommitDate(api, repoPath, cand, ref),
        elements,
      }
      desiredCache.set(appset, { at, state })
      return reply(state)
    }
  } catch (e) {
    return reply({ error: 'gitea_unreachable', detail: e instanceof Error ? e.message : '' }, 502)
  }
  return reply({ error: 'appset_file_not_found', repo: repoSpec, tried: candidates }, 404)
}

/** Best effort: without it a transition simply has no clock until Argo CD starts one. */
async function lastCommitDate(
  api: (path: string) => Promise<Response>,
  repoPath: string,
  file: string,
  ref: string,
): Promise<string | undefined> {
  try {
    const res = await api(
      `${repoPath}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(file)}&limit=1&stat=false&verification=false&files=false`,
    )
    if (!res.ok) {
      await res.body?.cancel()
      return undefined
    }
    const commits = (await res.json()) as Array<{ commit?: { committer?: { date?: string } }; created?: string }>
    return commits[0]?.commit?.committer?.date ?? commits[0]?.created
  } catch {
    return undefined
  }
}

/* ─────────────── asking Argo CD to look ─────────────── */

/** Syncs `applicationset.yaml` into the live ApplicationSet; used when the owner cannot be discovered. */
const DEFAULT_APPSET_APP = 'adhar-platform-applicationset'

/**
 * Annotate the Application that syncs the ApplicationSet, so the commit is
 * picked up in seconds rather than at the next reconciliation.
 *
 * Tried as the signed-in user first, so the audit log names them, then as the
 * console: a person allowed to toggle packages (`update packages`) need not have
 * `patch applications`. Best effort. If both are refused the change still lands,
 * only slower, and the Marketplace shows "Enabling…" for that long.
 */
export async function requestArgoRefresh(
  namespace: string,
  application: string,
  identities: Array<K8sIdentity | string | null | undefined>,
  call: typeof apiServerFetch = apiServerFetch,
): Promise<boolean> {
  const path = `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(namespace)}/applications/${encodeURIComponent(application)}`
  const init = {
    method: 'PATCH',
    headers: { 'content-type': 'application/merge-patch+json' },
    body: JSON.stringify({ metadata: { annotations: { 'argocd.argoproj.io/refresh': 'normal' } } }),
  }
  for (const auth of identities) {
    if (!auth) continue
    try {
      const res = await call(auth, path, init)
      await res.body?.cancel()
      if (res.ok) return true
    } catch {
      /* try the next identity */
    }
  }
  return false
}

/* ─────────────── locating the file ─────────────── */

/** The repo and the files to try for an ApplicationSet (discovery → env → conventional names). */
async function resolveAppsetFiles(req: Request, appset: string | undefined) {
  const namespace = env('ADHAR_APPSET_NAMESPACE') ?? DEFAULT_NAMESPACE
  const branch = env('ADHAR_APPSET_BRANCH') ?? DEFAULT_BRANCH
  const discovered = appset ? await discoverAppsetSource(req, namespace, appset) : undefined
  const repoSpec = discovered?.repo || env('ADHAR_APPSET_REPO') || DEFAULT_REPO
  const [owner, repoName] = repoSpec.split('/')

  // Candidate file paths, in priority order. A discovered `path` may be a
  // directory (ArgoCD tracks a dir) or a file; env override wins; otherwise we
  // probe conventional appset filenames and use the first that holds the element.
  const candidates: string[] = []
  const pushUnique = (p?: string) => {
    if (p && !candidates.includes(p)) candidates.push(p)
  }
  pushUnique(env('ADHAR_APPSET_FILE'))
  // `.` is the repo root, which is what the conventional names below already mean.
  const dp = discovered?.path?.replace(/\/+$/, '')
  if (dp && dp !== '.') {
    if (/\.(ya?ml)$/i.test(dp)) pushUnique(dp)
    else {
      for (const f of appsetFileGuesses(appset)) pushUnique(`${dp}/${f}`)
    }
  }
  for (const f of appsetFileGuesses(appset)) pushUnique(f)

  return {
    namespace,
    repoSpec,
    owner,
    repoName,
    ref: discovered?.branch || branch,
    candidates,
    application: discovered?.app ?? env('ADHAR_APPSET_APPLICATION') ?? DEFAULT_APPSET_APP,
  }
}

/* ─────────────── handler ─────────────── */

export async function handleAppsetToggle(req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const auth = await getRequestUser(req)
  if (!auth) return unauthorized()
  const denied = await requirePermission(req, CONSOLE_PERMISSIONS.packagesToggle)
  if (denied) return withCookie(denied, auth.refreshedCookie)

  let body: ToggleRequest
  try {
    body = (await req.json()) as ToggleRequest
  } catch {
    return withCookie(Response.json({ error: 'invalid_json' }, { status: 400 }), auth.refreshedCookie)
  }

  const requested = String(body.name ?? '').trim()
  if (!requested || !/^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,126})$/.test(requested)) {
    return withCookie(Response.json({ error: 'invalid_name' }, { status: 400 }), auth.refreshedCookie)
  }

  // Not everything the console can NAME is an ApplicationSet element.
  const resolved = resolvePackageName(requested)
  if (resolved.kind === 'always-installed') {
    // Reporting a 404 "could not locate the ApplicationSet YAML" here was
    // actively misleading: it blamed missing ADHAR_APPSET_* configuration for
    // something no configuration could fix, and told operators to go set env
    // vars that were already correct. These components are part of the platform
    // itself; "enabled" is the only state they have.
    return withCookie(
      Response.json({
        ok: true,
        name: requested,
        enabled: true,
        outcome: 'already-installed',
        detail: `${requested} is part of the platform foundation (${resolved.why}), so it is always installed and cannot be toggled.`,
      }),
      auth.refreshedCookie,
    )
  }
  const name = resolved.name
  if (typeof body.enabled !== 'boolean') {
    return withCookie(Response.json({ error: 'enabled_required' }, { status: 400 }), auth.refreshedCookie)
  }
  const enabled = body.enabled
  const appset = String(body.appset ?? '').trim() || undefined
  // It becomes a file name in a Gitea contents path; `../../other/repo/…`
  // would otherwise address a different repository with the admin token.
  if (appset && (!APPSET_NAME.test(appset) || appset.includes('..'))) {
    return withCookie(Response.json({ error: 'invalid_appset' }, { status: 400 }), auth.refreshedCookie)
  }

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
  const { namespace, repoSpec, owner, repoName, ref, candidates, application } = await resolveAppsetFiles(req, appset)
  if (!owner || !repoName) {
    return withCookie(
      Response.json({ error: 'appset_repo_unresolved', detail: `bad repo "${repoSpec}"` }, { status: 500 }),
      auth.refreshedCookie,
    )
  }
  // After the commit, and on the no-op path too: "already enabled in Git" is
  // exactly what a second click sees while Argo CD has not noticed the first one.
  const settled = async () => {
    desiredCache.clear()
    return await requestArgoRefresh(namespace, application, [await resolveIdentity(req), getK8sServiceToken()])
  }

  // ── GET the file that actually contains the element ──
  let filePath: string | undefined
  let fileSha: string | undefined
  let original: string | undefined
  let lastStatus = 0
  // Candidate files we could actually READ. Distinguishes "the ApplicationSet
  // file is somewhere else" from "the file is right here and has no such
  // element" — two very different problems that reported the same message.
  const readable: string[] = []
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
    readable.push(cand)
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
    // We read the ApplicationSet file(s) fine — they simply do not declare this
    // package. Telling the operator to go configure ADHAR_APPSET_REPO here sends
    // them to fix something that is not broken.
    const aliased = name !== requested ? ` (resolved from "${requested}")` : ''
    const detail = readable.length
      ? `"${name}"${aliased} is not an element of the ApplicationSet in ${repoSpec} ` +
        `(read: ${readable.join(', ')}). It may be a sub-component of another package, or not packaged at all — ` +
        'only names that appear as ApplicationSet elements can be enabled.'
      : `Could not locate the ApplicationSet YAML in ${repoSpec}. ` +
        'Set ADHAR_APPSET_REPO and ADHAR_APPSET_FILE to the repo + path that version-controls the ApplicationSet.'
    return withCookie(
      Response.json(
        {
          error: readable.length ? 'appset_element_not_found' : 'appset_file_not_found',
          detail,
          name,
          requested,
          repo: repoSpec,
          tried: candidates,
          read: readable,
          lastStatus,
        },
        { status: 404 },
      ),
      auth.refreshedCookie,
    )
  }

  // ── scoped edit ──
  // Companions (volcano ↔ adhar-batch-volcano) go in the same commit.
  const edit = flipElementWithCompanions(original, name, enabled)
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
        refreshed: await settled(),
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
          message: `chore(marketplace): ${enabled ? 'enable' : 'disable'} ${[name, ...edit.companions].join(', ')} via Adhar Console`,
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
      refreshed: await settled(),
      repo: repoSpec,
      path: filePath,
      commit: commit.commit?.sha,
      commitUrl: commit.commit?.html_url,
      companions: edit.companions,
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
    // Where seeding commits the profile's ApplicationSet — try it first.
    'applicationset.yaml',
    'adhar-appset-local.yaml',
    'adhar-appset-production.yaml',
    'appset.yaml',
  )
  return out
}
