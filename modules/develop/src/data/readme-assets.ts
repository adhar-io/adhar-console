/**
 * Resolving the images a README refers to.
 *
 * A README's images are written relative to the file: `./docs/arch.png`,
 * `../logo.svg`, `/screenshots/home.png`. None of those mean anything to a
 * browser pointed at the console, so every one of them had to be rendered as
 * alt text. Turned into a path on Gitea's raw endpoint — through the console's
 * authenticated proxy, so private repositories and air-gapped installs work —
 * they are just images.
 *
 * External URLs are returned unchanged and are the caller's decision to fetch.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export interface ReadmeContext {
  /** Gitea owner — an org or a user. */
  owner: string
  /** Repository name, without the owner. */
  repo: string
  /** Branch, tag or commit the README was read at. */
  ref?: string
  /** Directory of the README within the repository, '' at the root. */
  dir?: string
}

/** Collapse `.` and `..` without letting a path escape the repository. */
export function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      // A `..` at the root is a mistake in the README, not permission to walk
      // out of the repository.
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

const EXTERNAL = /^(https?:)?\/\//i

export function isExternal(src: string): boolean {
  return EXTERNAL.test(src.trim())
}

/**
 * The URL to load a README image from, or `undefined` when there is nothing
 * sensible to load — the renderer then keeps the alt text rather than showing
 * a broken image icon.
 */
export function resolveReadmeImage(src: string, ctx: ReadmeContext): string | undefined {
  const raw = (src ?? '').trim()
  if (!raw) return undefined

  // Inline data is already the image.
  if (/^data:/i.test(raw)) return raw
  // A bare anchor or query is not an image reference.
  if (raw.startsWith('#') || raw.startsWith('?')) return undefined

  if (isExternal(raw)) {
    // Protocol-relative URLs are https in every context this console runs in.
    return raw.startsWith('//') ? `https:${raw}` : raw
  }
  // Any other scheme — `mailto:`, `file:` — is not something to fetch.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined

  if (!ctx.owner || !ctx.repo) return undefined

  // Strip a query or fragment; Gitea takes the ref as a parameter of its own.
  const path = raw.split('#')[0].split('?')[0]
  // A leading slash means the repository root, not the server root.
  const joined = path.startsWith('/') ? path.slice(1) : `${ctx.dir ?? ''}/${path}`
  const normalized = normalizePath(joined)
  if (!normalized) return undefined

  const encoded = normalized.split('/').map(encodeURIComponent).join('/')
  const query = ctx.ref ? `?ref=${encodeURIComponent(ctx.ref)}` : ''
  return `/api/svc/gitea/api/v1/repos/${encodeURIComponent(ctx.owner)}/${
    encodeURIComponent(ctx.repo)
  }/raw/${encoded}${query}`
}

/** The directory part of a file path — `docs/a/readme.md` → `docs/a`. */
export function dirOf(path: string | undefined): string {
  if (!path) return ''
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}
