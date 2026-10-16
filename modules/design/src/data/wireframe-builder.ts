import type { BuilderProject, CanvasNode, ProjectFile } from '@adhar/builder/project'
import type { Wireframe, WireframeBlock, WireframeBlockType } from './types.ts'

/**
 * Wireframe ⇄ builder project.
 *
 * A wireframe is a list of positioned low-fi blocks (the library thumbnails
 * draw them). Opening one in the Visual Builder turns the blocks into real
 * components on a page, top-to-bottom; saving stores the whole builder project
 * on the wireframe (`builder`) and re-derives the blocks from the page so the
 * thumbnail tracks what was designed.
 */

const VIEW_W = 720
const PAD = 24

let seq = 0
const nid = () => `wf_${Date.now().toString(36)}_${(seq++).toString(36)}`

function node(type: string, className: string, text?: string, extra: Record<string, unknown> = {}, children: CanvasNode[] = []): CanvasNode {
  return { id: nid(), type, props: { className, ...(text !== undefined ? { children: text } : {}), ...extra }, children, style: {} }
}

/** One wireframe block → one builder node, styled with the design-theme vocabulary. */
export function blockToNode(b: WireframeBlock): CanvasNode {
  const label = b.label ?? ''
  switch (b.type) {
    case 'logo': return node('span', 'text-lg font-bold', label || 'Logo')
    case 'h1': return node('h1', 'text-3xl font-bold tracking-tight', label || 'Heading')
    case 'h2': return node('h2', 'text-xl font-semibold', label || 'Subheading')
    case 'text': return node('p', 'text-sm text-muted-foreground', label || 'Body text')
    case 'link': return node('link', 'text-sm text-primary underline-offset-4 hover:underline', label || 'Link')
    case 'input':
    case 'search': return node('input', 'w-full px-3 py-2 rounded-lg border border-input bg-background text-sm', undefined, { placeholder: label || (b.type === 'search' ? 'Search…' : 'Input') })
    case 'dropdown': return node('button', 'w-full px-3 py-2 rounded-lg border border-input bg-background text-sm text-left', label || 'Select…')
    case 'button': return node('button', 'px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium', label || 'Button')
    case 'tag':
    case 'badge': return node('badge', 'inline-flex px-2 py-0.5 rounded-full bg-muted text-xs font-medium', label || 'Tag')
    case 'avatar': return node('avatar', 'w-10 h-10 rounded-full bg-muted flex items-center justify-center text-xs font-bold', (label || 'A').slice(0, 2))
    case 'image':
    case 'chart': return node('img-placeholder', 'w-full aspect-video rounded-xl bg-muted flex items-center justify-center text-muted-foreground text-sm', label || (b.type === 'chart' ? 'Chart' : 'Image'))
    case 'divider': return node('div', 'h-px w-full bg-border')
    case 'alert': return node('div', 'p-3 rounded-lg border border-border bg-muted text-sm', label || 'Alert')
    case 'navbar': return node('nav', 'flex items-center justify-between px-6 py-4 border-b border-border', undefined, {}, [node('span', 'font-semibold', label || 'Navigation')])
    case 'footer': return node('footer', 'px-6 py-8 border-t border-border text-sm text-muted-foreground', label || 'Footer')
    case 'sidebar': return node('div', 'w-56 p-4 border-r border-border flex flex-col gap-2', undefined, {}, [node('span', 'text-sm font-medium', label || 'Sidebar')])
    case 'stat': return node('card', 'p-5 rounded-xl border border-border bg-card', undefined, {}, [node('p', 'text-sm text-muted-foreground', label || 'Metric'), node('h3', 'text-2xl font-bold', '1,234')])
    case 'card':
    case 'list':
    case 'table':
    case 'tabs':
      return node('card', 'p-6 rounded-xl border border-border bg-card flex flex-col gap-2', undefined, {}, [node('h3', 'font-semibold', label || capital(b.type))])
    default: return node('div', 'p-3 rounded-lg border border-dashed border-border text-sm text-muted-foreground', label || capital(b.type))
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function wireframeToProject(wf: Wireframe, base: BuilderProject): BuilderProject {
  const blocks = [...(wf.blocks ?? [])].sort((a, b) => a.y - b.y || a.x - b.x)
  const pageName = `${wf.name.replace(/[^A-Za-z0-9]+/g, '') || 'Frame'}.tsx`
  const page: ProjectFile = { id: 'f_wireframe', name: pageName, type: 'file', language: 'tsx', nodes: blocks.map(blockToNode), home: true, route: '/' }
  const files = base.files.map((f) => replacePages(f, page))
  return { ...base, name: wf.name, files }
}

function replacePages(f: ProjectFile, page: ProjectFile): ProjectFile {
  if (f.id === 'f_pages') return { ...f, children: [page] }
  if (f.children) return { ...f, children: f.children.map((c) => replacePages(c, page)) }
  return f
}

/* ── project → blocks (for the library thumbnail) ── */

const TYPE_TO_BLOCK: Record<string, WireframeBlockType> = {
  h1: 'h1', h2: 'h2', h3: 'h2', h4: 'h2', p: 'text', span: 'text', link: 'link', a: 'link',
  input: 'input', textarea: 'input', button: 'button', badge: 'badge', avatar: 'avatar',
  'img-placeholder': 'image', nav: 'navbar', footer: 'footer', card: 'card', 'stat-card': 'stat',
  'pricing-card': 'card', 'feature-card': 'card',
}
const BLOCK_H: Partial<Record<WireframeBlockType, number>> = {
  h1: 36, h2: 28, text: 20, link: 18, input: 34, button: 34, badge: 22, avatar: 40, image: 120,
  navbar: 40, footer: 40, card: 80, stat: 70, divider: 2,
}

function firstPage(files: ProjectFile[]): ProjectFile | undefined {
  for (const f of files) {
    if (f.type === 'file' && f.nodes !== undefined) return f
    const hit = f.children ? firstPage(f.children) : undefined
    if (hit) return hit
  }
  return undefined
}

function textOf(n: CanvasNode): string | undefined {
  const t = n.props?.children
  if (typeof t === 'string' && t.trim()) return t.trim().slice(0, 60)
  for (const c of n.children) {
    const s = textOf(c)
    if (s) return s
  }
  return undefined
}

/** Lay the page's components out top-to-bottom as wireframe blocks. */
export function projectToBlocks(project: BuilderProject, max = 40): WireframeBlock[] {
  const page = firstPage(project.files)
  if (!page?.nodes) return []
  const out: WireframeBlock[] = []
  let y = PAD
  const visit = (n: CanvasNode) => {
    if (out.length >= max || n.hidden) return
    const type = TYPE_TO_BLOCK[n.type]
    if (type) {
      const h = BLOCK_H[type] ?? 24
      const narrow = type === 'button' || type === 'badge' || type === 'avatar'
      const w = type === 'avatar' ? 40 : narrow ? 140 : VIEW_W - PAD * 2
      out.push({ type, x: PAD, y, w, h, label: type === 'avatar' ? undefined : textOf(n) })
      y += h + 12
      if (type === 'navbar' || type === 'card' || type === 'stat' || type === 'footer') return
    }
    for (const c of n.children) visit(c)
  }
  page.nodes.forEach(visit)
  return out
}
