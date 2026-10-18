import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { gitea } from '@adhar/api-clients'
import type { Entity } from './catalog.ts'
import {
  type AppVersionHint,
  type CiSummary,
  type DetectedTech,
  describeDockerfile,
  detectAppVersions,
  detectTech,
  type DockerfileSummary,
  mergeDetections,
  NESTED_DIRS,
  parseCiFile,
  chooseFocus,
  planScan,
  SKIP_DIRS,
  tagVersion,
} from './catalog-techstack.ts'
import { lockfilesFor, MAX_LOCKFILE_BYTES, parseLockfile, resolveWithLocks } from './catalog-lockfiles.ts'
import { withManagedVersions } from './catalog-managed-versions.ts'

/**
 * TechDocs for a catalog entity — where the docs live, and how to read them
 * into the console as a whole site rather than one file.
 *
 * ---------------------------------------------------------------------------
 * WHERE DOCS LIVE
 * ---------------------------------------------------------------------------
 * In order of how explicitly the entity says so:
 *   1. `backstage.io/techdocs-ref`: `dir:.` / `dir:docs` (relative to the
 *      source repository) or `url:<repo>[/src/branch/<ref>/<dir>]`.
 *   2. `adhar.io/docs`, or a `docs` link: a repository (or a path inside
 *      one), a single Markdown file, or a published site.
 *   3. The source repository itself: its `docs/` folder, else its README.
 *
 * ---------------------------------------------------------------------------
 * HOW THEY ARE READ
 * ---------------------------------------------------------------------------
 * A repository on the platform's Gitea is read through the BFF's Gitea
 * proxy — the browser cannot fetch raw files from Gitea directly (no CORS),
 * and the proxy carries the user's session, so private repos work. GitHub
 * is read best-effort straight from raw.githubusercontent.com / the
 * contents API, which do allow cross-origin reads. Anything else is either
 * a Markdown file fetched as-is (same origin) or a site to be framed.
 */

export type DocsKind = 'gitea' | 'github' | 'markdown' | 'site'

export interface DocsSource {
  kind: DocsKind
  /** The URL the entity gave, made public, for "Open" links. */
  url: string
  org?: string
  repo?: string
  ref: string
  /** Directory inside the repository the docs are rooted at ('' = root). */
  dir: string
  /**
   * True when the ref came from the entity (a `/src/branch/<ref>` URL or an
   * `adhar.io/branch` annotation). Otherwise `ref` is only a guess ("main")
   * and the repository's real default branch should be read.
   */
  refExplicit?: boolean
}

export interface DocPage {
  /** Repository path of the Markdown file. */
  path: string
  /** Path relative to the docs root, without extension — the page id. */
  slug: string
  title: string
  /** Directory relative to the docs root ('' for top level). */
  section: string
}

const REFRESH_MS = 5 * 60_000
const MAX_PAGES = 80
const MAX_DEPTH = 3

function parseRepoUrl(raw: string): { host: string; org: string; repo: string; ref?: string; dir?: string; file?: string } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length < 2) return null
  const [org, repoRaw, ...rest] = parts
  const repo = repoRaw.replace(/\.git$/, '')
  let ref: string | undefined
  let dir: string | undefined
  let file: string | undefined
  // Gitea: /org/repo/src/branch/<ref>/<path>  ·  /raw/branch/<ref>/<path>
  // GitHub: /org/repo/tree/<ref>/<path>  ·  /blob/<ref>/<path>
  if (rest.length >= 3 && (rest[0] === 'src' || rest[0] === 'raw') && (rest[1] === 'branch' || rest[1] === 'tag' || rest[1] === 'commit')) {
    ref = decodeURIComponent(rest[2])
    const tail = rest.slice(3)
    if (tail.length && /\.mdx?$/i.test(tail[tail.length - 1])) file = tail.join('/')
    else dir = tail.join('/')
  } else if (rest.length >= 2 && (rest[0] === 'tree' || rest[0] === 'blob')) {
    ref = decodeURIComponent(rest[1])
    const tail = rest.slice(2)
    if (tail.length && /\.mdx?$/i.test(tail[tail.length - 1])) file = tail.join('/')
    else dir = tail.join('/')
  }
  return { host: u.host.toLowerCase(), org, repo, ref, dir, file }
}

function kindForHost(host: string, giteaHost: string): DocsKind | null {
  if (giteaHost && host === giteaHost.toLowerCase()) return 'gitea'
  if (host.includes('gitea') || host.startsWith('git.')) return 'gitea'
  if (host === 'github.com' || host === 'www.github.com') return 'github'
  return null
}

/**
 * Where this entity's docs are. `giteaPublicUrl` is the platform's Gitea
 * (from /api/config), so a repository there is recognised even when its
 * hostname does not say "gitea". Returns null when nothing points anywhere.
 */
export function resolveDocsSource(entity: Entity, giteaPublicUrl: string): DocsSource | null {
  const ann = entity.metadata.annotations ?? {}
  const links = entity.metadata.links ?? []
  const annotatedRepo = (ann['adhar.io/source-repo'] ?? ann['adhar.io/git-repo'] ?? ann['backstage.io/source-location'] ?? '')
    .replace(/^url:\s*/, '')
    .trim()
  const repoUrl = links.find((l) => l.icon === 'repo')?.url ?? (annotatedRepo || undefined)
  let giteaHost = ''
  try {
    giteaHost = giteaPublicUrl ? new URL(giteaPublicUrl).host.toLowerCase() : ''
  } catch {
    giteaHost = ''
  }
  const fromRepo = (url: string, dir?: string, ref?: string, file?: string): DocsSource | null => {
    const p = parseRepoUrl(url)
    if (!p) return null
    const kind = kindForHost(p.host, giteaHost)
    if (!kind) return null
    return {
      kind,
      url,
      org: p.org,
      repo: p.repo,
      ref: ref ?? p.ref ?? (ann['adhar.io/branch'] ?? ann['adhar.io/default-branch'] ?? 'main'),
      dir: file ? file.replace(/\/?[^/]+$/, '') : (dir ?? p.dir ?? ''),
    }
  }

  const techdocs = (ann['backstage.io/techdocs-ref'] ?? '').trim()
  if (techdocs) {
    const m = /^(dir|url):\s*(.+)$/i.exec(techdocs)
    if (m && m[1].toLowerCase() === 'dir' && repoUrl) {
      const dir = m[2].replace(/^\.\/?/, '').replace(/^\/+|\/+$/g, '')
      const src = fromRepo(repoUrl, dir)
      if (src) return src
    }
    if (m && m[1].toLowerCase() === 'url') {
      const src = fromRepo(m[2])
      if (src) return src
      return { kind: 'site', url: m[2], ref: '', dir: '' }
    }
  }

  const explicit = (links.find((l) => l.icon === 'docs')?.url ?? ann['adhar.io/docs'] ?? '').trim()
  if (explicit && /^https?:/i.test(explicit)) {
    const p = parseRepoUrl(explicit)
    const kind = p ? kindForHost(p.host, giteaHost) : null
    if (p && kind) {
      const src = fromRepo(explicit, p.dir, p.ref, p.file)
      if (src) return src
    }
    if (/\.mdx?(?:[?#].*)?$/i.test(explicit)) return { kind: 'markdown', url: explicit, ref: '', dir: '' }
    return { kind: 'site', url: explicit, ref: '', dir: '' }
  }

  if (repoUrl) {
    const src = fromRepo(repoUrl)
    if (src) return src
  }
  return null
}

/**
 * The entity's source repository itself (root, default branch) — for
 * reading build files rather than docs, so `techdocs-ref` and docs links
 * are ignored. Null when there is no repository the console can read.
 */
export function resolveRepoSource(entity: Entity, giteaPublicUrl: string): DocsSource | null {
  const ann = entity.metadata.annotations ?? {}
  const annotatedRepo = (ann['adhar.io/source-repo'] ?? ann['adhar.io/git-repo'] ?? ann['backstage.io/source-location'] ?? '')
    .replace(/^url:\s*/, '')
    .trim()
  const repoUrl = (entity.metadata.links ?? []).find((l) => l.icon === 'repo')?.url ?? (annotatedRepo || undefined)
  if (!repoUrl) return null
  const p = parseRepoUrl(repoUrl)
  if (!p) return null
  let giteaHost = ''
  try {
    giteaHost = giteaPublicUrl ? new URL(giteaPublicUrl).host.toLowerCase() : ''
  } catch {
    giteaHost = ''
  }
  const kind = kindForHost(p.host, giteaHost)
  if (!kind) return null
  const explicitRef = p.ref ?? ann['adhar.io/branch'] ?? ann['adhar.io/default-branch']
  // The entity's own folder in a monorepo: an explicit annotation, else the
  // tree path of a source-location / repo link (`…/src/branch/main/apps/api`).
  // A link to a file (`…/catalog-info.yaml`) names its folder, not itself.
  const dir = (ann['adhar.io/source-path'] ?? ann['adhar.io/path'] ?? p.dir ?? '')
    .replace(/^\.?\/+|\/+$/g, '')
    .replace(/(^|\/)[^/]+\.(ya?ml|json|xml|md|toml|txt)$/i, '')
  return { kind, url: repoUrl, org: p.org, repo: p.repo, ref: explicitRef ?? 'main', dir, refExplicit: Boolean(explicitRef) }
}

/* ─────────── reading a repository ─────────── */

const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

interface TreeEntry {
  path: string
  type: 'blob' | 'tree'
}

async function listDir(src: DocsSource, path: string): Promise<TreeEntry[]> {
  if (src.kind === 'gitea') {
    const entries = await giteaClient.listTree(src.org!, src.repo!, src.ref, path)
    return entries.map((e) => ({ path: e.path, type: e.type }))
  }
  if (src.kind === 'github') {
    const res = await fetch(`https://api.github.com/repos/${src.org}/${src.repo}/contents/${path}?ref=${encodeURIComponent(src.ref)}`, {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)
    const raw = (await res.json()) as Array<{ path: string; type: string }>
    return raw.map((e) => ({ path: e.path, type: e.type === 'dir' ? 'tree' : 'blob' }))
  }
  return []
}

async function readFile(src: DocsSource, path: string): Promise<string> {
  if (src.kind === 'gitea') {
    const f = await giteaClient.getFile(src.org!, src.repo!, src.ref, path)
    if (f.encoding === 'base64') {
      const bin = atob(f.content.replace(/\s/g, ''))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new TextDecoder().decode(bytes)
    }
    return f.content
  }
  if (src.kind === 'github') {
    const res = await fetch(`https://raw.githubusercontent.com/${src.org}/${src.repo}/${encodeURIComponent(src.ref)}/${path}`)
    if (!res.ok) throw new Error(`GitHub ${res.status}`)
    return res.text()
  }
  throw new Error('not a repository source')
}

function titleFromPath(path: string): string {
  const base = path.split('/').pop()!.replace(/\.mdx?$/i, '')
  if (/^(index|readme)$/i.test(base)) {
    const dir = path.split('/').slice(-2, -1)[0]
    return dir ? humanise(dir) : 'Overview'
  }
  return humanise(base)
}

function humanise(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/^\d+[.\s-]*/, '').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** First `# heading` of a document, else undefined. */
export function headingOf(text: string): string | undefined {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(text)
  return m ? m[1].replace(/[*_`]/g, '').trim() : undefined
}

/**
 * The pages under the docs root: every Markdown file, up to a sane depth,
 * ordered index/README first, then by path. A repository without a docs
 * folder still yields its README as one page — a service with a good README
 * has docs, whatever the folder is called.
 */
async function collectPages(src: DocsSource): Promise<DocPage[]> {
  const root = src.dir.replace(/^\/+|\/+$/g, '')
  const out: DocPage[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= MAX_PAGES) return
    let entries: TreeEntry[]
    try {
      entries = await listDir(src, dir)
    } catch {
      return
    }
    const blobs = entries.filter((e) => e.type === 'blob' && /\.mdx?$/i.test(e.path)).sort((a, b) => a.path.localeCompare(b.path))
    for (const b of blobs) {
      if (out.length >= MAX_PAGES) break
      const rel = root ? b.path.replace(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '') : b.path
      out.push({
        path: b.path,
        slug: rel.replace(/\.mdx?$/i, ''),
        title: titleFromPath(b.path),
        section: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
      })
    }
    for (const d of entries.filter((e) => e.type === 'tree').sort((a, b) => a.path.localeCompare(b.path))) {
      const name = d.path.split('/').pop() ?? ''
      if (/^(node_modules|\.git|assets|images|img|static|site|build|dist)$/i.test(name)) continue
      await walk(d.path, depth + 1)
    }
  }

  if (root) {
    await walk(root, 0)
  } else {
    // No docs dir named: prefer docs/ (then doc/), and always include the README.
    let entries: TreeEntry[] = []
    try {
      entries = await listDir(src, '')
    } catch {
      entries = []
    }
    const readme = entries.find((e) => e.type === 'blob' && /^readme\.mdx?$/i.test(e.path))
    if (readme) out.push({ path: readme.path, slug: 'readme', title: 'README', section: '' })
    const docsDir = entries.find((e) => e.type === 'tree' && /^(docs|doc|documentation)$/i.test(e.path))
    if (docsDir) {
      const before = out.length
      await walk(docsDir.path, 0)
      // Pages under docs/ are relative to docs/, so their slugs read cleanly.
      for (let i = before; i < out.length; i++) {
        const rel = out[i].path.slice(docsDir.path.length + 1)
        out[i] = { ...out[i], slug: rel.replace(/\.mdx?$/i, ''), section: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' }
      }
    }
  }

  const rank = (p: DocPage) => (/(^|\/)(index|readme)$/i.test(p.slug) ? 0 : 1)
  return out.sort((a, b) => a.section.localeCompare(b.section) || rank(a) - rank(b) || a.slug.localeCompare(b.slug))
}

export function useDocsPages(src: DocsSource | null) {
  const repo = src && (src.kind === 'gitea' || src.kind === 'github') ? src : null
  return useQuery({
    queryKey: ['catalog', 'docs', 'pages', repo?.kind, repo?.org, repo?.repo, repo?.ref, repo?.dir],
    queryFn: () => collectPages(repo!),
    enabled: Boolean(repo),
    staleTime: REFRESH_MS,
    retry: 1,
  })
}

export function useDocPage(src: DocsSource | null, path: string | undefined) {
  const repo = src && (src.kind === 'gitea' || src.kind === 'github') ? src : null
  return useQuery({
    queryKey: ['catalog', 'docs', 'page', repo?.kind, repo?.org, repo?.repo, repo?.ref, path],
    queryFn: () => readFile(repo!, path!),
    enabled: Boolean(repo && path),
    staleTime: REFRESH_MS,
    retry: 1,
  })
}

/** The file in the forge's UI, for "Edit this page". */
export function editUrl(src: DocsSource, path: string): string | undefined {
  const p = parseRepoUrl(src.url)
  if (!p) return undefined
  const origin = `${new URL(src.url).origin}/${p.org}/${p.repo}`
  if (src.kind === 'gitea') return `${origin}/_edit/${encodeURIComponent(src.ref)}/${path}`
  if (src.kind === 'github') return `${origin}/edit/${encodeURIComponent(src.ref)}/${path}`
  return undefined
}

/** The raw file URL a page's relative images and links resolve against. */
export function rawBase(src: DocsSource, path: string): string | undefined {
  const p = parseRepoUrl(src.url)
  if (!p) return undefined
  if (src.kind === 'gitea') return `${new URL(src.url).origin}/${p.org}/${p.repo}/raw/branch/${encodeURIComponent(src.ref)}/${path}`
  if (src.kind === 'github') return `https://raw.githubusercontent.com/${p.org}/${p.repo}/${encodeURIComponent(src.ref)}/${path}`
  return undefined
}

/** A file in the forge's UI (view, not edit) — for "from pom.xml" links. */
export function repoFileUrl(src: DocsSource, path: string): string | undefined {
  const p = parseRepoUrl(src.url)
  if (!p) return undefined
  const origin = `${new URL(src.url).origin}/${p.org}/${p.repo}`
  if (src.kind === 'gitea') return `${origin}/src/branch/${encodeURIComponent(src.ref)}/${path}`
  if (src.kind === 'github') return `${origin}/blob/${encodeURIComponent(src.ref)}/${path}`
  return undefined
}

/* ─────────── tech stack from the repository's build files ─────────── */

export interface RepoRelease {
  /** The version read from the tag (`v1.4.2` → `1.4.2`). */
  version: string
  tag: string
  kind: 'release' | 'tag'
  name?: string
  url?: string
  at?: string
}

export interface RepoTechScan {
  /** The branch actually read. */
  ref: string
  /** The repository's default branch, when the forge reported it. */
  defaultBranch?: string
  /** Why `ref` was used: the entity named it, it is the default branch, or the `master` fallback. */
  refSource: 'entity' | 'default-branch' | 'fallback'
  /** Files read, as repository paths. */
  files: string[]
  tech: DetectedTech[]
  /** The folder treated as this entity's app (monorepos), '' for the root. */
  focus: string
  /** How `focus` was chosen. */
  focusReason?: string
  /** Folders whose build files were read, focus first. */
  scannedDirs: string[]
  /** Paths in the repository listing (after vendor folders are skipped). */
  pathsSeen: number
  /** True when the forge capped the recursive listing. */
  truncated: boolean
  /** Bytes per language, from the forge's language statistics. */
  languages?: Record<string, number>
  /** The application's version as its build files give it, best first. */
  appVersions: AppVersionHint[]
  /** Latest published release (else newest tag). */
  release?: RepoRelease
  /** CI definitions read (Tekton first). */
  ci: CiSummary[]
  /** What each Dockerfile builds. */
  containers: DockerfileSummary[]
  /** Lockfiles read, with how many packages each pins. */
  locks: Array<{ source: string; kind: string; packages: number }>
  /** Lockfiles skipped for size (over MAX_LOCKFILE_BYTES). */
  skippedLocks: string[]
}

/** The repository's default branch, or undefined when the forge won't say. */
async function defaultBranchOf(src: DocsSource): Promise<string | undefined> {
  try {
    if (src.kind === 'gitea') return (await giteaClient.getRepo(src.org!, src.repo!)).default_branch || undefined
    if (src.kind === 'github') {
      const res = await fetch(`https://api.github.com/repos/${src.org}/${src.repo}`, { headers: { accept: 'application/vnd.github+json' } })
      if (!res.ok) return undefined
      return ((await res.json()) as { default_branch?: string }).default_branch || undefined
    }
  } catch {
    /* unknown — the caller falls back to the entity's ref */
  }
  return undefined
}

/** Every blob path at `ref`, in one request. Throws when the forge can't list recursively. */
async function listAll(src: DocsSource): Promise<{ paths: string[]; truncated: boolean; sizes: Map<string, number> }> {
  if (src.kind === 'gitea') {
    const t = await giteaClient.getTreeRecursive(src.org!, src.repo!, src.ref)
    return { paths: t.entries.map((e) => e.path), truncated: t.truncated, sizes: new Map(t.entries.filter((e) => e.size != null).map((e) => [e.path, e.size!])) }
  }
  if (src.kind === 'github') {
    const res = await fetch(`https://api.github.com/repos/${src.org}/${src.repo}/git/trees/${encodeURIComponent(src.ref)}?recursive=1`, {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!res.ok) throw new Error(`GitHub ${res.status}`)
    const raw = (await res.json()) as { tree?: Array<{ path: string; type: string; size?: number }>; truncated?: boolean }
    const blobs = (raw.tree ?? []).filter((e) => e.type === 'blob')
    return { paths: blobs.map((e) => e.path), truncated: Boolean(raw.truncated), sizes: new Map(blobs.filter((e) => e.size != null).map((e) => [e.path, e.size!])) }
  }
  throw new Error('not a repository source')
}

/** Older forges without the recursive tree: the root plus the usual service folders. */
async function listShallow(src: DocsSource): Promise<string[]> {
  const root = await listDir(src, '')
  const out = root.filter((e) => e.type === 'blob').map((e) => e.path)
  const dirs = root.filter((e) => e.type === 'tree').map((e) => e.path)
  const want = [
    ...(src.dir ? [src.dir] : []),
    ...dirs.filter((d) => NESTED_DIRS.test(d) || /^(\.tekton|\.gitea|\.github|gradle|\.mvn)$/.test(d)),
  ].slice(0, 6)
  for (const d of want) {
    try {
      const sub = await listDir(src, d)
      out.push(...sub.filter((e) => e.type === 'blob').map((e) => e.path))
      // one more level for CI workflow folders
      for (const w of sub.filter((e) => e.type === 'tree' && /\/(workflows|wrapper)$/.test(e.path))) {
        out.push(...(await listDir(src, w.path)).filter((e) => e.type === 'blob').map((e) => e.path))
      }
    } catch {
      /* folder unreadable — skip */
    }
  }
  return out
}

async function languagesOf(src: DocsSource): Promise<Record<string, number> | undefined> {
  try {
    if (src.kind === 'gitea') return await giteaClient.listLanguages(src.org!, src.repo!)
    if (src.kind === 'github') {
      const res = await fetch(`https://api.github.com/repos/${src.org}/${src.repo}/languages`, { headers: { accept: 'application/vnd.github+json' } })
      return res.ok ? ((await res.json()) as Record<string, number>) : undefined
    }
  } catch {
    /* no stats */
  }
  return undefined
}

/** Latest published release, else the newest tag. Gitea only (GitHub would need auth for rate limits). */
async function latestRelease(src: DocsSource): Promise<RepoRelease | undefined> {
  if (src.kind !== 'gitea') return undefined
  try {
    const rels = (await giteaClient.listReleases(src.org!, src.repo!)).filter((r) => !r.draft)
    const rel = rels.find((r) => !r.prerelease) ?? rels[0]
    const v = rel ? tagVersion(rel.tag_name) : undefined
    if (rel && v) return { version: v, tag: rel.tag_name, kind: 'release', name: rel.name || undefined, url: rel.html_url, at: rel.published_at ?? rel.created_at }
    const tags = await giteaClient.listTags(src.org!, src.repo!)
    const tag = tags.find((t) => tagVersion(t.name))
    if (tag) return { version: tagVersion(tag.name)!, tag: tag.name, kind: 'tag', at: tag.commit?.created }
  } catch {
    /* no releases readable */
  }
  return undefined
}

export async function scanRepoTech(src: DocsSource, entityName = ''): Promise<RepoTechScan> {
  const defaultBranch = await defaultBranchOf(src)
  let ref = src.refExplicit ? src.ref : defaultBranch ?? src.ref
  let refSource: RepoTechScan['refSource'] = src.refExplicit ? 'entity' : defaultBranch ? 'default-branch' : 'fallback'
  let paths: string[]
  let truncated = false
  let sizes = new Map<string, number>()
  const listAt = async (r: string) => {
    try {
      const all = await listAll({ ...src, ref: r })
      truncated = all.truncated
      sizes = all.sizes
      return all.paths
    } catch {
      return listShallow({ ...src, ref: r })
    }
  }
  try {
    paths = await listAt(ref)
  } catch (err) {
    // The named branch is gone, or the guess was wrong: try the default branch, then master.
    const next = defaultBranch && defaultBranch !== ref ? defaultBranch : ref !== 'master' ? 'master' : undefined
    if (!next) throw err
    ref = next
    refSource = next === defaultBranch ? 'default-branch' : 'fallback'
    paths = await listAt(ref)
  }
  const at = { ...src, ref }
  const { focus, reason } = chooseFocus(paths.filter((p) => !SKIP_DIRS.test(p)), entityName, src.dir)
  const plan = planScan(paths, focus)
  // Lockfiles pin the exact versions; a huge one is skipped (and said so) rather than stalling the tab.
  const lockPaths = lockfilesFor(plan.listing, plan.dirs, sizes)
  const skippedLocks = lockfilesFor(plan.listing, plan.dirs, undefined, 8).filter((p) => (sizes.get(p) ?? 0) > MAX_LOCKFILE_BYTES)
  const [read, lockRead, languages, release] = await Promise.all([
    Promise.allSettled(plan.want.map((p) => readFile(at, p))),
    Promise.allSettled(lockPaths.map((p) => readFile(at, p))),
    languagesOf(at),
    latestRelease(at),
  ])
  const locks = lockRead.flatMap((r, i) => (r.status === 'fulfilled' ? [parseLockfile(lockPaths[i], r.value)] : []))
  const files: Record<string, string> = {}
  read.forEach((r, i) => {
    if (r.status === 'fulfilled') files[plan.want[i]] = r.value
  })
  const ci: CiSummary[] = []
  const containers: DockerfileSummary[] = []
  for (const [path, text] of Object.entries(files)) {
    const c = parseCiFile(text, path)
    if (c) ci.push(c.summary)
    if (/^(docker|container)file(\.[\w.-]+)?$/i.test(path.split('/').pop() ?? '') || /\.dockerfile$/i.test(path)) containers.push(describeDockerfile(text, path))
  }
  return {
    ref,
    defaultBranch,
    refSource,
    files: Object.keys(files),
    tech: withManagedVersions(resolveWithLocks(mergeDetections(detectTech(files, plan.listing)), locks)),
    locks: locks.map((l) => ({ source: l.source, kind: l.kind, packages: l.packages.size })),
    skippedLocks,
    focus,
    focusReason: reason,
    scannedDirs: plan.dirs,
    pathsSeen: plan.listing.length,
    truncated,
    languages,
    appVersions: detectAppVersions(files, plan.dirs),
    release,
    ci,
    containers,
  }
}

/**
 * Languages, frameworks and their versions, read from the repository's build
 * files (pom.xml, build.gradle, package.json, go.mod, Dockerfile, …), plus
 * the forge's language statistics, the latest release, CI definitions and
 * Dockerfiles. One recursive tree request, a capped number of file reads,
 * cached like the docs tree.
 */
export function useRepoTechStack(entity: Entity, giteaPublicUrl: string) {
  const src = useMemo(() => resolveRepoSource(entity, giteaPublicUrl), [entity, giteaPublicUrl])
  const name = entity.metadata.name
  const query = useQuery({
    queryKey: ['catalog', 'tech', 'v3', src?.kind, src?.org, src?.repo, src?.ref, src?.refExplicit, src?.dir, name],
    queryFn: () => scanRepoTech(src!, name),
    enabled: Boolean(src),
    staleTime: REFRESH_MS,
    retry: 0,
  })
  return { source: src, ...query }
}

/** A stable hook wrapper so callers get a memoised source. */
export function useDocsSource(entity: Entity, giteaPublicUrl: string): DocsSource | null {
  return useMemo(() => resolveDocsSource(entity, giteaPublicUrl), [entity, giteaPublicUrl])
}
