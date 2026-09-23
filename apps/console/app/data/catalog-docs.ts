import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { gitea } from '@adhar-console/api-clients'
import type { Entity } from './catalog.ts'

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

/** A stable hook wrapper so callers get a memoised source. */
export function useDocsSource(entity: Entity, giteaPublicUrl: string): DocsSource | null {
  return useMemo(() => resolveDocsSource(entity, giteaPublicUrl), [entity, giteaPublicUrl])
}
