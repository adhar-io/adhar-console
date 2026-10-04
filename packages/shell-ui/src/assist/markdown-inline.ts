/**
 * Inline markdown, as data.
 *
 * JSX-free so it can be unit-tested — the repo's Deno test runner has no
 * React in its import map, so anything reachable from a `.tsx` is untestable.
 * Same arrangement as `nav-ownership.ts` beside `nav-item.tsx`.
 */

/**
 * One run of inline markdown.
 *
 * Split out as data so it can be unit-tested — rendering returns React nodes,
 * which the repo's Deno test runner cannot inspect.
 */
export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'image'; alt: string }

/**
 * Order matters, and the image cases come first.
 *
 * A README's badge row is `[![Coverage](shields.io/…)](github.com/…)` — an
 * image inside a link. Matching the plain-link pattern first consumed the
 * INNER `[Coverage](shields.io/…)` and left the outer `[` and `](github.com/…)`
 * behind as literal text, which is exactly what every badge rendered as: a
 * stray bracket, a link, and a bare URL in parentheses.
 *
 * Images become their alt text rather than an `<img>`. Nearly all of them are
 * external badges, and this console has to work air-gapped — fetching them
 * would reintroduce the dependency on someone else's CDN that the rest of the
 * build has just removed.
 */
const INLINE_RE =
  /(`[^`]+`|\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)|!\[[^\]]*\]\([^)]*\)|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g

/** The URL out of `src "optional title"`, which is valid markdown. */
function srcOf(target: string): string {
  return target.trim().split(/\s+/)[0] ?? ''
}

export function tokenizeInline(text: string): InlineToken[] {
  const out: InlineToken[] = []
  let last = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ kind: 'text', text: text.slice(last, idx) })
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push({ kind: 'code', text: tok.slice(1, -1) })
    } else if (tok.startsWith('[![')) {
      // Linked image: a README's badge row. Both the badge and where it links
      // are kept; the renderer decides whether to fetch the badge.
      const mm = /^\[!\[([^\]]*)\]\(([^)]*)\)\]\(([^)]*)\)$/.exec(tok)
      if (mm) out.push({ kind: 'image-link', alt: mm[1], src: srcOf(mm[2]), href: mm[3] })
    } else if (tok.startsWith('![')) {
      const mm = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(tok)
      if (mm) out.push({ kind: 'image', alt: mm[1], src: srcOf(mm[2]) })
    } else if (tok.startsWith('**')) {
      out.push({ kind: 'strong', text: tok.slice(2, -2) })
    } else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      if (mm) out.push({ kind: 'link', text: mm[1], href: mm[2] })
    } else {
      out.push({ kind: 'em', text: tok.slice(1, -1) })
    }
    last = idx + tok.length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}
