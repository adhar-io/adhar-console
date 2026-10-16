import { genId, type CanvasNode } from './builder-types.ts'

/**
 * HTML (Tailwind-classed) → builder nodes.
 *
 * Adhar AI answers a page request with an HTML fragment; this turns it into
 * the node tree the canvas edits. Structure and classes carry over; scripts,
 * styles, event handlers and unknown attributes are dropped — the canvas only
 * ever renders class names and text, never markup from the model.
 */

const KEEP_TAGS = new Set([
  'section', 'nav', 'footer', 'header', 'main', 'aside', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'button', 'input', 'textarea', 'label',
])
const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'svg', 'template'])

function typeFor(el: Element, hasElementChildren: boolean): string {
  const tag = el.tagName.toLowerCase()
  const cls = el.getAttribute('class') ?? ''
  if (tag === 'img') return 'img-placeholder'
  if (tag === 'a') return 'link'
  if (KEEP_TAGS.has(tag) && !(hasElementChildren && /^(h\d|p|span|button|label)$/.test(tag))) return tag
  if (/\bgrid\b/.test(cls)) return 'grid'
  if (/\bflex-col\b/.test(cls)) return 'flex-col'
  if (/\bflex\b/.test(cls)) return 'flex'
  return 'div'
}

function convert(el: Element): CanvasNode | null {
  const tag = el.tagName.toLowerCase()
  if (SKIP_TAGS.has(tag)) return null
  const elementKids = Array.from(el.children)
  const type = typeFor(el, elementKids.length > 0)
  const props: Record<string, unknown> = {}
  const cls = el.getAttribute('class')
  if (cls) props.className = cls.trim()
  if (tag === 'input' || tag === 'textarea') props.placeholder = el.getAttribute('placeholder') ?? ''
  if (tag === 'img') {
    props.children = el.getAttribute('alt') || 'Image'
    if (!cls) props.className = 'w-full aspect-video rounded-lg bg-muted flex items-center justify-center text-muted-foreground'
  }

  const children: CanvasNode[] = []
  if (elementKids.length === 0) {
    const text = el.textContent?.replace(/\s+/g, ' ').trim()
    if (text && tag !== 'img') props.children = text
  } else {
    // Mixed content: keep loose text runs as spans so nothing is lost.
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) {
        const t = n.textContent?.replace(/\s+/g, ' ').trim()
        if (t) children.push({ id: genId(), type: 'span', props: { children: t }, children: [], style: {} })
      } else if (n.nodeType === 1) {
        const c = convert(n as Element)
        if (c) children.push(c)
      }
    }
  }
  return { id: genId(), type, props, children, style: {} }
}

export function htmlToNodes(html: string): CanvasNode[] {
  if (typeof DOMParser === 'undefined') return []
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return Array.from(doc.body.children).map(convert).filter((n): n is CanvasNode => n !== null)
}

/** Pull the first fenced block of `lang` (or any fence) out of a model reply. */
export function extractFence(text: string, langs: string[] = []): string | null {
  const re = /```([\w-]*)\s*\n([\s\S]*?)```/g
  let first: string | null = null
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!langs.length || langs.includes(m[1].toLowerCase())) return m[2].trim()
    first ??= m[2].trim()
  }
  return first
}
