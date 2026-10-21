import { normaliseToken } from './role-tokens.ts'

/**
 * Pure parts of `POST /api/scorecards/fix` — who may apply a scorecard fix, and
 * what a fix request may contain. Dependency-free (beyond the shared token
 * normaliser) so the browser can mirror the gate and the tests can pin it.
 *
 * Who: platform admins (and engineers / application admins, who already hold
 * write on every application), and DEVELOPERS of the team that owns the
 * entity. A developer of another team, or a viewer, gets a 403 — the fix
 * writes to a repository with the console's own Gitea credentials, so the
 * console has to be the one asking "is this yours to change?".
 */

type UserLike = { roles?: readonly string[]; groups?: readonly string[] } | null | undefined

const ADMIN_TOKENS = new Set([
  'admin', 'super-admin', 'superadmin',
  'platform-admin', 'platform-admins',
  'platform-engineer', 'platform-engineers', 'platform-eng',
  'application-admin', 'application-admins', 'app-admin', 'tenant-admin',
])

const DEVELOPER_TOKENS = new Set(['developer', 'developers', 'platform-developer'])

function tokens(user: UserLike): Set<string> {
  const out = new Set<string>()
  for (const raw of [...(user?.roles ?? []), ...(user?.groups ?? [])]) {
    if (typeof raw === 'string' && raw.trim()) out.add(normaliseToken(raw))
  }
  return out
}

/** `group:default/payments` / `group:payments` / `payments` → `payments`. */
export function ownerTeam(owner: string | undefined): string | undefined {
  if (!owner) return undefined
  const t = owner.trim().toLowerCase().replace(/^group:/, '')
  const name = t.includes('/') ? t.split('/').pop() : t
  return name || undefined
}

/** True when the user's groups name the team (`payments`, `team-payments`, `payments-team`). */
export function inTeam(user: UserLike, team: string | undefined): boolean {
  if (!team) return false
  const t = tokens(user)
  return t.has(team) || t.has(`team-${team}`) || t.has(`${team}-team`)
}

export function isFixAdmin(user: UserLike): boolean {
  for (const t of tokens(user)) if (ADMIN_TOKENS.has(t)) return true
  return false
}

export type FixGate = { ok: true } | { ok: false; reason: string }

/** May this user write a scorecard fix for an entity owned by `owner`? */
export function canApplyFix(user: UserLike, owner: string | undefined): FixGate {
  if (!user) return { ok: false, reason: 'Sign in to apply fixes.' }
  if (isFixAdmin(user)) return { ok: true }
  const t = tokens(user)
  const developer = [...t].some((x) => DEVELOPER_TOKENS.has(x))
  const team = ownerTeam(owner)
  if (developer && team && inTeam(user, team)) return { ok: true }
  if (!team) return { ok: false, reason: 'This entity has no owner yet — only a platform admin can apply a fix to it.' }
  return {
    ok: false,
    reason: `Only developers of ${team} and platform admins can apply fixes to this entity.`,
  }
}

/**
 * May this user set the owner of an entity that has none? Admins, and any
 * developer — the server then checks them against the team they chose, so a
 * developer can only claim an unowned service for a team they are in.
 */
export function canClaimOwnership(user: UserLike): FixGate {
  if (!user) return { ok: false, reason: 'Sign in to apply fixes.' }
  if (isFixAdmin(user)) return { ok: true }
  if ([...tokens(user)].some((x) => DEVELOPER_TOKENS.has(x))) return { ok: true }
  return { ok: false, reason: 'Only developers and platform admins can apply fixes.' }
}

/* ─────────── request validation ─────────── */

export interface FixFile {
  path: string
  content: string
  /** Blob sha the preview was built on; `null` = the file must not exist yet. */
  baseSha: string | null
}

export interface FixRequest {
  entityRef: string
  owner?: string
  org: string
  repo: string
  /** Base branch; the repository default when absent. */
  branch?: string
  mode: 'pr' | 'commit'
  /** New branch for a PR. */
  newBranch?: string
  title: string
  description?: string
  files: FixFile[]
  /** Where the entity's catalog-info.yaml lives, so the server can read its declared owner. */
  descriptorPath?: string
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const MAX_FILES = 10
const MAX_BYTES = 256 * 1024

/** A repo-relative file path that cannot escape the repository. */
export function safePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 400) return false
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg !== '.git')
}

export type Validated = { ok: true; value: FixRequest } | { ok: false; detail: string }

export function validateFixRequest(body: unknown): Validated {
  if (!body || typeof body !== 'object') return { ok: false, detail: 'Expected a JSON object.' }
  const b = body as Record<string, unknown>
  const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
  const entityRef = str(b.entityRef, 300)
  if (!entityRef) return { ok: false, detail: 'entityRef is required.' }
  const org = str(b.org, 100)
  const repo = str(b.repo, 100)
  if (!org || !NAME.test(org) || !repo || !NAME.test(repo)) return { ok: false, detail: 'org and repo must be Gitea names.' }
  const mode = b.mode === 'commit' ? 'commit' : b.mode === 'pr' ? 'pr' : undefined
  if (!mode) return { ok: false, detail: 'mode must be "pr" or "commit".' }
  const branch = str(b.branch, 200)
  if (branch && !BRANCH.test(branch)) return { ok: false, detail: 'branch is not a valid branch name.' }
  const newBranch = str(b.newBranch, 200)
  if (mode === 'pr' && (!newBranch || !BRANCH.test(newBranch) || newBranch.includes('..'))) {
    return { ok: false, detail: 'A pull request needs a valid newBranch.' }
  }
  const title = str(b.title, 200)
  if (!title) return { ok: false, detail: 'title is required.' }
  if (!Array.isArray(b.files) || !b.files.length) return { ok: false, detail: 'files must be a non-empty array.' }
  if (b.files.length > MAX_FILES) return { ok: false, detail: `At most ${MAX_FILES} files per fix.` }
  const files: FixFile[] = []
  const seen = new Set<string>()
  for (const raw of b.files) {
    const f = (raw ?? {}) as Record<string, unknown>
    if (!safePath(f.path)) return { ok: false, detail: 'Every file needs a safe repository-relative path.' }
    if (seen.has(f.path)) return { ok: false, detail: `Duplicate path ${f.path}.` }
    seen.add(f.path)
    if (typeof f.content !== 'string') return { ok: false, detail: `${f.path}: content must be a string.` }
    if (new TextEncoder().encode(f.content).length > MAX_BYTES) return { ok: false, detail: `${f.path} is too large.` }
    if (!(f.baseSha === null || (typeof f.baseSha === 'string' && /^[0-9a-f]{7,64}$/i.test(f.baseSha)))) {
      return { ok: false, detail: `${f.path}: baseSha must be a blob sha or null.` }
    }
    files.push({ path: f.path, content: f.content, baseSha: f.baseSha as string | null })
  }
  const descriptorPath = b.descriptorPath === undefined ? undefined : b.descriptorPath
  if (descriptorPath !== undefined && !safePath(descriptorPath)) return { ok: false, detail: 'descriptorPath must be a safe repository-relative path.' }
  return {
    ok: true,
    value: {
      ...(descriptorPath ? { descriptorPath } : {}),
      entityRef,
      ...(str(b.owner, 200) ? { owner: str(b.owner, 200) } : {}),
      org,
      repo,
      ...(branch ? { branch } : {}),
      mode,
      ...(mode === 'pr' ? { newBranch } : {}),
      title,
      ...(str(b.description, 4000) ? { description: str(b.description, 4000) } : {}),
      files,
    },
  }
}

/** The commit message: the fix's title, then who asked for it. */
export function fixCommitMessage(title: string, who: string, description?: string): string {
  return `${title}\n\n${description ? `${description}\n\n` : ''}via Adhar console by ${who}`
}

/** A display name for the commit trailer — never empty. */
export function actorName(user: { name?: string; email?: string; username?: string; id?: string } | null | undefined): string {
  return user?.name?.trim() || user?.username?.trim() || user?.email?.trim() || user?.id?.trim() || 'unknown user'
}

/**
 * The owner a descriptor declares for an entity: `spec.owner` of the document
 * whose `metadata.name` matches (else the first document that has one). A tiny
 * scan rather than a YAML parse — only two scalars are needed.
 */
export function declaredOwner(text: string, entityName: string): string | undefined {
  const docs = text.split(/^---\s*$/m)
  let fallback: string | undefined
  for (const doc of docs) {
    const owner = /^spec:[ \t]*\n(?:(?:[ \t]+.*|[ \t]*#.*|[ \t]*)\n)*?[ \t]+owner:[ \t]*["']?([^"'#\n]+?)["']?[ \t]*(?:#.*)?$/m.exec(doc)?.[1]?.trim()
    if (!owner) continue
    const name = /^metadata:[ \t]*\n(?:(?:[ \t]+.*|[ \t]*#.*|[ \t]*)\n)*?[ \t]+name:[ \t]*["']?([^"'#\n]+?)["']?[ \t]*(?:#.*)?$/m.exec(doc)?.[1]?.trim()
    if (name && name.toLowerCase() === entityName.toLowerCase()) return owner
    fallback ??= owner
  }
  return fallback
}

/** `component:default/cart` → `cart`. */
export function refName(ref: string): string {
  const right = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref
  return right.includes('/') ? right.slice(right.lastIndexOf('/') + 1) : right
}
