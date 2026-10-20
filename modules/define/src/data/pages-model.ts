/**
 * Define Pages — the console-side project wiki (pure model; tested in
 * `pages-model_test.ts`).
 *
 * Plane 1.4's public API has no pages endpoints, so pages are console data in
 * the document store (see `pages-store.ts`). This file holds everything that
 * does not touch the network: the page tree, templates, a safe markdown
 * parser (it produces a block/inline AST that the view renders as React
 * elements — no HTML string is ever injected), @mention / issue-reference
 * extraction, line diffs between versions, and search.
 */

export interface PageMeta {
  id: string
  project: string
  parent: string | null
  title: string
  icon?: string
  /** Sort position among siblings. */
  order: number
  /** Monotonic version — bumped on every saved edit. */
  version: number
  locked?: boolean
  /** Published = readable by everyone in the tenant; drafts show only to their author. */
  published?: boolean
  template?: string
  /** Plain text (truncated) for search and previews. */
  excerpt: string
  mentions?: string[]
  issueRefs?: string[]
  createdBy?: string | null
  updatedBy?: string | null
  /** Display name of the last editor (the store keeps ids). */
  updatedByName?: string
  createdAt: string
  updatedAt: string
  /** Version metadata, newest last (bodies live in `define.page-version`). */
  history: Array<{ v: number; at: string; by?: string; title: string; chars: number; note?: string }>
  archived?: boolean
}

export interface PageNode {
  page: PageMeta
  children: PageNode[]
  depth: number
}

/* ───── tree ───── */

export function buildTree(pages: PageMeta[]): PageNode[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const kids = new Map<string | null, PageMeta[]>()
  for (const p of pages) {
    const parent = p.parent && byId.has(p.parent) && !isAncestor(p.id, p.parent, byId) ? p.parent : null
    const list = kids.get(parent) ?? []
    list.push(p)
    kids.set(parent, list)
  }
  const sort = (xs: PageMeta[]) => [...xs].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
  const build = (p: PageMeta, depth: number): PageNode => ({ page: p, depth, children: sort(kids.get(p.id) ?? []).map((c) => build(c, depth + 1)) })
  return sort(kids.get(null) ?? []).map((p) => build(p, 0))
}

/** Is `ancestor` on the parent chain of `id`? */
function isAncestor(ancestor: string, id: string, byId: Map<string, PageMeta>): boolean {
  const seen = new Set<string>()
  let cur: string | null | undefined = id
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true
    seen.add(cur)
    cur = byId.get(cur)?.parent
  }
  return false
}

/** Parent chain of a page, root first (breadcrumbs). */
export function ancestors(id: string, pages: PageMeta[]): PageMeta[] {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const out: PageMeta[] = []
  const seen = new Set<string>([id])
  let cur = byId.get(id)?.parent
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    out.unshift(byId.get(cur)!)
    cur = byId.get(cur)!.parent
  }
  return out
}

/** Can `id` move under `parent` (null = root) without creating a loop? */
export function canMove(id: string, parent: string | null, pages: PageMeta[]): boolean {
  if (parent === null) return true
  if (parent === id) return false
  return !isAncestor(id, parent, new Map(pages.map((p) => [p.id, p])))
}

export function descendants(id: string, pages: PageMeta[]): string[] {
  const out: string[] = []
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const p of pages) {
      if (p.parent === cur && !out.includes(p.id)) {
        out.push(p.id)
        stack.push(p.id)
      }
    }
  }
  return out
}

/* ───── templates ───── */

export interface PageTemplate {
  id: string
  name: string
  description: string
  icon: string
  body: (ctx: { title: string; date: string; author: string }) => string
}

export const TEMPLATES: PageTemplate[] = [
  {
    id: 'blank',
    name: 'Blank page',
    description: 'Start from nothing.',
    icon: '📄',
    body: ({ title }) => `# ${title}\n\n`,
  },
  {
    id: 'prd',
    name: 'Product requirements (PRD)',
    description: 'Problem, goals, users, requirements, success metrics.',
    icon: '🎯',
    body: ({ title, date, author }) =>
      `# ${title}\n\n> **Status:** Draft · **Owner:** @${author} · **Updated:** ${date}\n\n## Problem\n\nWhat problem are we solving, and for whom?\n\n## Goals\n\n- \n\n## Non-goals\n\n- \n\n## Users & scenarios\n\n| Persona | Scenario | Outcome |\n| --- | --- | --- |\n|  |  |  |\n\n## Requirements\n\n- [ ] Must: \n- [ ] Should: \n- [ ] Could: \n\n## Success metrics\n\n- \n\n## Open questions\n\n- \n\n## Linked work\n\nReference issues by key (e.g. PROJ-12) to show their live state here.\n`,
  },
  {
    id: 'rfc',
    name: 'RFC / technical design',
    description: 'Context, proposal, alternatives, risks, rollout.',
    icon: '🧩',
    body: ({ title, date, author }) =>
      `# RFC: ${title}\n\n> **Author:** @${author} · **Date:** ${date} · **Status:** Proposed\n\n## Summary\n\n## Context\n\n## Proposal\n\n## Alternatives considered\n\n1. \n\n## Risks & mitigations\n\n| Risk | Likelihood | Mitigation |\n| --- | --- | --- |\n|  |  |  |\n\n## Rollout plan\n\n- [ ] \n\n## Decision\n\n_Pending review._\n`,
  },
  {
    id: 'retro',
    name: 'Sprint retrospective',
    description: 'What went well, what didn\'t, actions.',
    icon: '🔁',
    body: ({ title, date }) =>
      `# ${title}\n\n**Date:** ${date}\n\n## What went well\n\n- \n\n## What didn't go well\n\n- \n\n## What we learned\n\n- \n\n## Actions\n\n- [ ]  — owner: @\n`,
  },
  {
    id: 'meeting',
    name: 'Meeting notes',
    description: 'Attendees, agenda, notes, decisions, action items.',
    icon: '🗒️',
    body: ({ title, date, author }) =>
      `# ${title}\n\n**Date:** ${date} · **Facilitator:** @${author}\n\n**Attendees:** \n\n## Agenda\n\n1. \n\n## Notes\n\n## Decisions\n\n- \n\n## Action items\n\n- [ ]  — @\n`,
  },
  {
    id: 'runbook',
    name: 'Runbook',
    description: 'Symptoms, diagnosis, remediation, escalation.',
    icon: '🛠️',
    body: ({ title, date }) =>
      `# Runbook: ${title}\n\n> Last reviewed ${date}\n\n## When to use this\n\n## Symptoms\n\n- \n\n## Diagnosis\n\n\`\`\`sh\n# commands to inspect the system\n\`\`\`\n\n## Remediation\n\n1. \n\n## Verification\n\n- [ ] \n\n## Escalation\n\n| Severity | Contact |\n| --- | --- |\n| SEV1 |  |\n`,
  },
]

/* ───── markdown → AST (safe) ───── */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 's'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'mention'; v: string }
  | { t: 'issue'; v: string }
  | { t: 'wiki'; v: string }

export type Block =
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul'; items: Array<{ c: Inline[]; checked?: boolean }> }
  | { t: 'ol'; items: Array<{ c: Inline[] }> }
  | { t: 'quote'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }

/** Only these URL forms become links; anything else (javascript:, data:…) is shown as text. */
export function safeHref(href: string): string | null {
  const h = href.trim()
  if (/^(https?:|mailto:)/i.test(h)) return h
  if (/^(\/(?!\/)|#|\.\/|\.\.\/)/.test(h)) return h
  return null
}

const ISSUE_RE = /^[A-Z][A-Z0-9]{1,11}-\d{1,6}\b/

/** Inline tokens. `issueKeys` limits which `KEY-123` prefixes become chips. */
export function parseInline(src: string, issueKeys?: Set<string>): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ t: 'text', v: text })
    text = ''
  }
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const prev = i > 0 ? src[i - 1] : ' '
    let m: RegExpExecArray | null
    if (rest[0] === '\\' && rest.length > 1) {
      text += rest[1]
      i += 2
      continue
    }
    if ((m = /^`([^`]+)`/.exec(rest))) {
      flush()
      out.push({ t: 'code', v: m[1] })
      i += m[0].length
      continue
    }
    if ((m = /^\[\[([^\]\n]{1,120})\]\]/.exec(rest))) {
      flush()
      out.push({ t: 'wiki', v: m[1].trim() })
      i += m[0].length
      continue
    }
    if ((m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest))) {
      const href = safeHref(m[2])
      flush()
      if (href) out.push({ t: 'link', href, c: parseInline(m[1], issueKeys) })
      else out.push({ t: 'text', v: m[1] })
      i += m[0].length
      continue
    }
    if ((m = /^\*\*([^*\n]+)\*\*/.exec(rest)) || (m = /^__([^_\n]+)__/.exec(rest))) {
      flush()
      out.push({ t: 'b', c: parseInline(m[1], issueKeys) })
      i += m[0].length
      continue
    }
    if ((m = /^~~([^~\n]+)~~/.exec(rest))) {
      flush()
      out.push({ t: 's', c: parseInline(m[1], issueKeys) })
      i += m[0].length
      continue
    }
    if (!/\w/.test(prev) && ((m = /^\*([^*\n]+)\*/.exec(rest)) || (m = /^_([^_\n]+)_(?!\w)/.exec(rest)))) {
      flush()
      out.push({ t: 'i', c: parseInline(m[1], issueKeys) })
      i += m[0].length
      continue
    }
    if (!/[\w@]/.test(prev) && (m = /^@\[([^\]\n]{1,80})\]/.exec(rest))) {
      flush()
      out.push({ t: 'mention', v: m[1] })
      i += m[0].length
      continue
    }
    if (!/[\w@]/.test(prev) && (m = /^@([A-Za-z0-9][\w.-]{0,63})/.exec(rest))) {
      flush()
      out.push({ t: 'mention', v: m[1].replace(/[.-]+$/, '') })
      i += 1 + m[1].replace(/[.-]+$/, '').length
      continue
    }
    if (!/[\w-]/.test(prev) && (m = ISSUE_RE.exec(rest)) && (!issueKeys || issueKeys.has(m[0].split('-')[0]))) {
      flush()
      out.push({ t: 'issue', v: m[0] })
      i += m[0].length
      continue
    }
    if ((m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest)) && !/\w/.test(prev)) {
      flush()
      out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] })
      i += m[0].length
      continue
    }
    text += rest[0]
    i++
  }
  flush()
  return out
}

const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

export function parseMarkdown(src: string, issueKeys?: Set<string>): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  const inl = (s: string) => parseInline(s, issueKeys)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let m: RegExpExecArray | null
    if (!line.trim()) {
      i++
      continue
    }
    if ((m = /^```\s*([\w+-]*)\s*$/.exec(line))) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      out.push({ t: 'code', lang: m[1], v: body.join('\n') })
      continue
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      out.push({ t: 'h', level: m[1].length, c: inl(m[2].trim()) })
      i++
      continue
    }
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
      out.push({ t: 'quote', c: inl(body.join(' ')) })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = splitRow(line).map(inl)
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]).map(inl))
      out.push({ t: 'table', head, rows })
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: Array<{ c: Inline[]; checked?: boolean }> = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const raw = lines[i++].replace(/^\s*[-*+]\s+/, '')
        const task = /^\[([ xX])\]\s?(.*)$/.exec(raw)
        items.push(task ? { c: inl(task[2]), checked: task[1] !== ' ' } : { c: inl(raw) })
      }
      out.push({ t: 'ul', items })
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: Array<{ c: Inline[] }> = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push({ c: inl(lines[i++].replace(/^\s*\d+[.)]\s+/, '')) })
      out.push({ t: 'ol', items })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]) &&
      !/^\s*\|.*\|\s*$/.test(lines[i])
    ) para.push(lines[i++])
    if (!para.length) {
      // A line no block rule consumed (e.g. a lone table row) — keep it as text.
      para.push(lines[i++])
    }
    out.push({ t: 'p', c: inl(para.join(' ')) })
  }
  return out
}

/** Collect inline nodes of a kind across the document. */
function collect(blocks: Block[], kind: 'mention' | 'issue' | 'wiki'): string[] {
  const out = new Set<string>()
  const walk = (xs: Inline[]) => {
    for (const x of xs) {
      if (x.t === kind) out.add(x.v)
      if ('c' in x && Array.isArray(x.c)) walk(x.c)
    }
  }
  for (const b of blocks) {
    if (b.t === 'h' || b.t === 'p' || b.t === 'quote') walk(b.c)
    else if (b.t === 'ul' || b.t === 'ol') b.items.forEach((it) => walk(it.c))
    else if (b.t === 'table') [b.head, ...b.rows].forEach((r) => r.forEach(walk))
  }
  return [...out]
}

export const extractMentions = (md: string) => collect(parseMarkdown(md), 'mention')
export const extractIssueRefs = (md: string, keys?: Set<string>) => collect(parseMarkdown(md, keys), 'issue')
export const extractWikiLinks = (md: string) => collect(parseMarkdown(md), 'wiki')

/** Markdown → plain text (search index, excerpts). */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ───── diff ───── */

export interface DiffLine {
  op: 'eq' | 'add' | 'del'
  text: string
}

/** Line diff (LCS). Bounded: very large inputs fall back to whole-block replace. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n')
  const y = b.split('\n')
  // Trim the common head and tail — most edits are local.
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head++
  let tail = 0
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  const xs = x.slice(head, x.length - tail)
  const ys = y.slice(head, y.length - tail)
  const pre: DiffLine[] = x.slice(0, head).map((text) => ({ op: 'eq', text }))
  const post: DiffLine[] = x.slice(x.length - tail).map((text) => ({ op: 'eq', text }))
  if (xs.length * ys.length > 4_000_000) {
    return [...pre, ...xs.map((text) => ({ op: 'del' as const, text })), ...ys.map((text) => ({ op: 'add' as const, text })), ...post]
  }
  const n = xs.length
  const m = ys.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = xs[i] === ys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const mid: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (xs[i] === ys[j]) {
      mid.push({ op: 'eq', text: xs[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ op: 'del', text: xs[i++] })
    else mid.push({ op: 'add', text: ys[j++] })
  }
  while (i < n) mid.push({ op: 'del', text: xs[i++] })
  while (j < m) mid.push({ op: 'add', text: ys[j++] })
  return [...pre, ...mid, ...post]
}

export function diffStats(d: DiffLine[]): { added: number; removed: number } {
  return { added: d.filter((l) => l.op === 'add').length, removed: d.filter((l) => l.op === 'del').length }
}

/* ───── search ───── */

export interface SearchHit {
  page: PageMeta
  score: number
  snippet: string
}

export function searchPages(pages: PageMeta[], query: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const hits: SearchHit[] = []
  for (const p of pages) {
    const title = p.title.toLowerCase()
    const body = p.excerpt.toLowerCase()
    let score = 0
    let ok = true
    for (const t of terms) {
      const inTitle = title.includes(t)
      const inBody = body.includes(t)
      if (!inTitle && !inBody) {
        ok = false
        break
      }
      score += (inTitle ? 10 : 0) + (title.startsWith(t) ? 5 : 0) + (inBody ? 1 : 0)
    }
    if (!ok) continue
    const at = body.indexOf(terms[0])
    const snippet = at < 0 ? p.excerpt.slice(0, 140) : `${at > 40 ? '…' : ''}${p.excerpt.slice(Math.max(0, at - 40), at + 100)}${at + 100 < p.excerpt.length ? '…' : ''}`
    hits.push({ page: p, score, snippet })
  }
  return hits.sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt))
}

/* ───── export ───── */

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'page'
}

/** Repo path for a page: its ancestors become folders (`docs/guides/setup.md`). */
export function exportPath(page: PageMeta, pages: PageMeta[], folder = 'docs'): string {
  const parts = [...ancestors(page.id, pages).map((a) => slugify(a.title)), slugify(page.title)]
  return `${folder.replace(/^\/+|\/+$/g, '')}/${parts.join('/')}.md`.replace(/^\//, '')
}

/** Toggle the n-th task checkbox (`- [ ]` / `- [x]`, outside code fences). */
export function toggleTaskAt(md: string, n: number): string {
  const lines = md.split('\n')
  let fence = false
  let k = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fence = !fence
    if (fence) continue
    const m = /^(\s*[-*+]\s+\[)([ xX])(\].*)$/.exec(lines[i])
    if (!m) continue
    if (k++ === n) {
      lines[i] = `${m[1]}${m[2] === ' ' ? 'x' : ' '}${m[3]}`
      break
    }
  }
  return lines.join('\n')
}

/** Ordinal of a task item among all task items, given its block / item position. */
export function taskOrdinal(blocks: Block[], blockIndex: number, itemIndex: number): number {
  let n = 0
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b]
    if (blk.t !== 'ul') continue
    for (let j = 0; j < blk.items.length; j++) {
      if (b === blockIndex && j === itemIndex) return n
      if (blk.items[j].checked !== undefined) n++
    }
  }
  return n
}
