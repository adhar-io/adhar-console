/**
 * Architecture patterns — byte-sized docs shown on the Help page.
 *
 * Each pattern is one Markdown file in `app/content/patterns/`. The file name
 * is the slug (`zero-downtime-deploys.md` → `?pattern=zero-downtime-deploys`)
 * and a small front-matter block carries what the card needs:
 *
 *   ---
 *   title: Zero-downtime deploys
 *   category: Resilience
 *   summary: One sentence for the card.
 *   tools: [Argo Rollouts, Kubernetes]
 *   order: 10
 *   ---
 *
 * Everything below the block is the body, rendered by the console's Markdown
 * component. This module is the pure half — parsing and validation — so the
 * Deno test can check every file without Vite. `patterns-content.ts` is the
 * half that loads them.
 */

export const CATEGORIES = [
  'Scale',
  'Resilience',
  'Delivery',
  'Data',
  'Security',
  'Tenancy',
  'Operations',
] as const
export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_BLURB: Record<Category, string> = {
  Scale: 'Grow capacity with demand — and shrink it when demand goes away.',
  Resilience: 'Keep serving while things fail, change or restart.',
  Delivery: 'Get changes from a commit to production safely and repeatably.',
  Data: 'Move, store and share data between services without coupling them.',
  Security: 'Trust nothing by default and make the safe path the easy one.',
  Tenancy: 'Share one platform between many teams without them colliding.',
  Operations: 'See, run and pay for the platform with confidence.',
}

export interface Pattern {
  slug: string
  title: string
  category: Category
  summary: string
  tools: string[]
  order: number
  /** Markdown below the front matter. */
  body: string
  /** Rough reading time, minutes (≥ 1). */
  minutes: number
}

export class PatternError extends Error {}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `[a, b]` or `a, b` → `['a', 'b']`. */
function list(v: string): string[] {
  return v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * Parse one file. Throws `PatternError` naming the file and the problem, so a
 * broken doc fails the test (and the build) with a message a writer can act on.
 */
export function parsePattern(slug: string, raw: string): Pattern {
  const where = `patterns/${slug}.md`
  if (!SLUG_RE.test(slug)) throw new PatternError(`${where}: file name must be kebab-case`)
  const m = raw.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) throw new PatternError(`${where}: missing front matter (a --- block at the top)`)
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const i = line.indexOf(':')
    if (i < 0) throw new PatternError(`${where}: front-matter line "${line}" is not "key: value"`)
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  for (const k of ['title', 'category', 'summary']) {
    if (!meta[k]) throw new PatternError(`${where}: front matter needs "${k}"`)
  }
  if (!(CATEGORIES as readonly string[]).includes(meta.category)) {
    throw new PatternError(`${where}: category "${meta.category}" is not one of ${CATEGORIES.join(', ')}`)
  }
  const body = m[2].trim()
  if (body.length < 80) throw new PatternError(`${where}: the body is empty or too short`)
  const words = body.split(/\s+/).length
  return {
    slug,
    title: meta.title,
    category: meta.category as Category,
    summary: meta.summary,
    tools: meta.tools ? list(meta.tools) : [],
    order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 100,
    body,
    minutes: Math.max(1, Math.round(words / 200)),
  }
}

/** Category order first, then `order`, then title. */
export function sortPatterns(list: Pattern[]): Pattern[] {
  return [...list].sort((a, b) =>
    CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.order - b.order || a.title.localeCompare(b.title)
  )
}

/** Case-insensitive match over everything a reader would search for. */
export function matchesPattern(p: Pattern, needle: string): boolean {
  if (!needle) return true
  const hay = `${p.title} ${p.category} ${p.summary} ${p.tools.join(' ')} ${p.body}`.toLowerCase()
  return needle.toLowerCase().split(/\s+/).every((w) => hay.includes(w))
}

/** Parse a `{ path: raw }` map (from Vite's glob or the test's directory walk). */
export function loadFromFiles(files: Record<string, string>): Pattern[] {
  const out: Pattern[] = []
  for (const [path, raw] of Object.entries(files)) {
    const slug = path.split('/').pop()!.replace(/\.md$/, '')
    if (slug.toLowerCase() === 'readme') continue
    out.push(parsePattern(slug, raw))
  }
  return sortPatterns(out)
}
