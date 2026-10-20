/**
 * Text helpers for work items: an allow-list HTML sanitiser for Plane's
 * `description_html` / `comment_html`, a small Markdown → HTML converter for
 * comments (with Plane-native @mentions), console attribution, and CSV.
 *
 * The sanitiser is string-based (no DOM) so it runs — and is tested — in Deno.
 * It rebuilds every allowed tag from scratch with escaped attributes and drops
 * everything else, so script, event handlers, styles and `javascript:` URLs
 * cannot survive it.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'hr', 'span', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'mention-component', 'label',
])
const VOID_TAGS = new Set(['br', 'img', 'hr'])
/** Whole elements (with their content) that never render. */
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|template|noscript|svg|math|textarea|select|button|form)\b[\s\S]*?<\/\1\s*>/gi

const ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  ul: ['data-type'],
  li: ['data-checked', 'data-type'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  'mention-component': ['entity_identifier', 'entity_name', 'id'],
  code: [],
  pre: [],
}

const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const decodeEntities = (v: string) =>
  v.replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n').replace(/&amp;/g, '&')

/** A URL attribute is kept only for http(s), mailto, same-site paths/anchors (and data images for src). */
export function safeUrl(raw: string, kind: 'href' | 'src'): string | undefined {
  // Strip whitespace/control chars browsers ignore inside schemes (`java\tscript:`).
  // deno-lint-ignore no-control-regex
  const v = decodeEntities(raw).replace(/[\u0000-\u001F\u007F\s]+/g, '').trim()
  if (!v) return undefined
  if (/^(https?:|mailto:)/i.test(v)) return raw.trim()
  if (kind === 'src' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) return raw.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return undefined // any other scheme
  if (v.startsWith('//')) return undefined // protocol-relative → arbitrary host
  return raw.trim() // relative path or #anchor
}

/** Allow-list sanitiser for Plane rich text. */
export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return ''
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(DROP_WITH_CONTENT, '')
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  const text = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  while ((m = tagRe.exec(src))) {
    out += text(src.slice(last, m.index))
    last = tagRe.lastIndex
    const name = m[1].toLowerCase()
    const closing = m[0].startsWith('</')
    if (!ALLOWED_TAGS.has(name)) continue
    if (closing) {
      if (!VOID_TAGS.has(name)) out += `</${name}>`
      continue
    }
    const allowed = ATTRS[name] ?? []
    const attrs: string[] = []
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
    let a: RegExpExecArray | null
    const rawAttrs = m[2].replace(/\/\s*$/, '')
    while ((a = attrRe.exec(rawAttrs))) {
      const key = a[1].toLowerCase()
      const value = a[3] ?? a[4] ?? a[5] ?? ''
      if (!allowed.includes(key)) continue
      if (key === 'href' || key === 'src') {
        const safe = safeUrl(value, key)
        if (!safe) continue
        attrs.push(`${key}="${escAttr(safe)}"`)
      } else {
        attrs.push(`${key}="${escAttr(value)}"`)
      }
    }
    if (name === 'a') attrs.push('target="_blank"', 'rel="noreferrer noopener"')
    out += `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`
  }
  out += text(src.slice(last))
  return out
}

/** Replace Plane mention components with readable `@name` chips (call on sanitised HTML). */
export function renderMentions(html: string, nameOf: (userId: string) => string | undefined): string {
  return html.replace(
    /<mention-component\b([^>]*)>\s*(?:<\/mention-component>)?/gi,
    (_all, attrs: string) => {
      const id = /entity_identifier="([^"]*)"/.exec(attrs)?.[1] ?? ''
      const name = nameOf(id) ?? 'someone'
      return `<span class="adhar-mention" data-user="${escAttr(id)}">@${escAttr(name)}</span>`
    },
  ).replace(/<\/mention-component>/gi, '')
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface MentionTarget {
  id: string
  /** What follows `@` — the member's display name without spaces. */
  handle: string
}

/** A member's @handle — display name with whitespace removed. */
export const mentionHandle = (name: string) => name.replace(/\s+/g, '')

function inline(s: string, mentions: MentionTarget[]): string {
  // Code spans first, so nothing inside them is formatted.
  const codes: string[] = []
  let t = escapeHtml(s).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  t = t
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, url) => {
      const safe = safeUrl(url.replace(/&amp;/g, '&'), 'href')
      return safe ? `<a href="${escAttr(safe)}">${label}</a>` : all
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
  if (mentions.length) {
    const byHandle = new Map(mentions.map((m) => [m.handle.toLowerCase(), m.id]))
    t = t.replace(/(^|[\s(])@([A-Za-z0-9._-]+)/g, (all, pre, handle: string) => {
      const id = byHandle.get(handle.toLowerCase())
      return id ? `${pre}<mention-component entity_identifier="${escAttr(id)}" entity_name="user_mention"></mention-component>` : all
    })
  }
  // deno-lint-ignore no-control-regex
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
}

/**
 * Markdown-flavoured text → HTML Plane stores. Supports paragraphs, line
 * breaks, headings, bullet / numbered / task lists, quotes, fenced code,
 * bold, italic, strike, inline code, links and @mentions of `mentions`.
 */
export function markdownToHtml(md: string, mentions: MentionTarget[] = []): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2], mentions)}</h${h[1].length}>`)
      i++
      continue
    }
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const mm = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i++])!
        items.push(`<li data-type="taskItem" data-checked="${mm[1] !== ' '}"><p>${inline(mm[2], mentions)}</p></li>`)
      }
      out.push(`<ul data-type="taskList">${items.join('')}</ul>`)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(`<li><p>${inline(lines[i++].replace(/^\s*[-*]\s+/, ''), mentions)}</p></li>`)
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(`<li><p>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ''), mentions)}</p></li>`)
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(inline(lines[i++].replace(/^>\s?/, ''), mentions))
      out.push(`<blockquote><p>${body.join('<br>')}</p></blockquote>`)
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|\s*[-*]\s+|\s*\d+[.)]\s+|>)/.test(lines[i])) para.push(inline(lines[i++], mentions))
    out.push(`<p>${para.join('<br>')}</p>`)
  }
  return out.join('')
}

/** Ids of members mentioned in Plane HTML. */
export function mentionedIds(html: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/<mention-component\b[^>]*entity_identifier="([^"]+)"/gi)) out.add(m[1])
  return [...out]
}

const ATTRIBUTION_MARK = 'data-adhar-actor'

/**
 * Plane records every console write as the API-key user. Append who really
 * did it, once, so Plane readers can tell.
 */
export function withAttribution(html: string, actor: { name?: string; email?: string } | null | undefined, verb = 'via Adhar console'): string {
  if (!actor || (!actor.name && !actor.email) || html.includes(ATTRIBUTION_MARK)) return html
  const who = escapeHtml(actor.name || actor.email || '')
  return `${html}<p ${ATTRIBUTION_MARK}=""><em>— ${escapeHtml(verb)} by ${who}</em></p>`
}

/** The console actor recorded in a comment/description footer, if any. */
export function attributedActor(html: string | null | undefined): string | undefined {
  if (!html) return undefined
  const m = /—\s*via Adhar console by ([^<]+)<\/em>/.exec(html)
  return m ? m[1].trim() : undefined
}

/** Plain-text excerpt length guard used by cards and CSV. */
export function excerpt(text: string | null | undefined, max = 140): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** RFC 4180 CSV — quotes fields with commas, quotes or newlines; guards formula injection. */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n')
}
