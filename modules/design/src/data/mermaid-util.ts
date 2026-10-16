/**
 * Pure helpers around Mermaid sources: detect the diagram syntax from the
 * header line, map it onto the stored `DiagramType`, and turn Mermaid's parse
 * errors into `{ line, message }` so the editor can mark the exact line.
 */

import type { DiagramType } from './types.ts'

export interface MermaidSyntax {
  /** Header keyword as written, e.g. `flowchart`, `C4Container`, `pie`. */
  keyword: string
  /** The closest stored diagram category. */
  type: DiagramType | null
}

const KEYWORD_TYPE: Record<string, DiagramType> = {
  flowchart: 'flowchart',
  graph: 'flowchart',
  sequenceDiagram: 'sequence',
  classDiagram: 'classDiagram',
  'classDiagram-v2': 'classDiagram',
  stateDiagram: 'stateDiagram',
  'stateDiagram-v2': 'stateDiagram',
  erDiagram: 'erDiagram',
  gantt: 'gantt',
  mindmap: 'mindmap',
  journey: 'journey',
  C4Context: 'C4Context',
  C4Container: 'C4Context',
  C4Component: 'C4Context',
  C4Dynamic: 'C4Context',
  C4Deployment: 'C4Context',
}

/** Friendly labels for syntaxes outside the stored categories. */
export const SYNTAX_LABEL: Record<string, string> = {
  pie: 'Pie',
  timeline: 'Timeline',
  gitGraph: 'Git graph',
  quadrantChart: 'Quadrant',
  requirementDiagram: 'Requirements',
  'architecture-beta': 'Architecture',
  'block-beta': 'Block',
  'sankey-beta': 'Sankey',
  'xychart-beta': 'XY chart',
  kanban: 'Kanban',
  'packet-beta': 'Packet',
  C4Container: 'C4 Container',
  C4Component: 'C4 Component',
  C4Dynamic: 'C4 Dynamic',
  C4Deployment: 'C4 Deployment',
}

/** Index (0-based) of the header line, skipping front-matter, directives and comments. */
function headerIndex(lines: string[]): number {
  let i = 0
  // YAML front-matter block `---\n…\n---`
  if (lines[0]?.trim() === '---') {
    i = 1
    while (i < lines.length && lines[i].trim() !== '---') i++
    i++
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('%%')) continue
    return i
  }
  return -1
}

export function detectSyntax(source: string): MermaidSyntax | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const idx = headerIndex(lines)
  if (idx < 0) return null
  const keyword = lines[idx].trim().split(/[\s;]+/)[0]
  if (!keyword) return null
  return { keyword, type: KEYWORD_TYPE[keyword] ?? null }
}

export interface MermaidIssue {
  /** 1-based line in the editor source. */
  line: number
  message: string
}

/**
 * Pull a line number + readable message out of whatever Mermaid threw.
 * Jison parse errors carry `hash.loc.first_line` and a message of the form
 * `Parse error on line 4:\n…\n----^\nExpecting 'X', got 'Y'`; Langium-based
 * grammars (pie, gitGraph, architecture…) report `line N` / `at line N`.
 */
export function parseMermaidError(err: unknown, source = ''): MermaidIssue {
  const e = err as { message?: unknown; hash?: { loc?: { first_line?: number }; line?: number } } | null
  const raw = typeof err === 'string'
    ? err
    : typeof e?.message === 'string'
    ? e.message
    : (() => {
      try {
        return JSON.stringify(err)
      } catch {
        return String(err)
      }
    })()
  let line: number | null = null
  if (e?.hash?.loc?.first_line) line = e.hash.loc.first_line
  else if (typeof e?.hash?.line === 'number') line = e.hash.line + 1
  if (line == null) {
    const m = /(?:on|at)? ?line[: ]+(\d+)/i.exec(raw)
    if (m) line = Number(m[1])
  }
  // Mermaid counts from the header line when front-matter is present; it
  // always counts lines of the text it was given, which is our source.
  const total = source ? source.split('\n').length : Infinity
  if (line != null && line > total) line = total
  // Drop the caret-art lines; keep the sentence that explains the problem.
  const message = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^-*\^$/.test(l) && !/^\.{3}/.test(l) && !/^Parse error on line/i.test(l))
    .join(' — ')
    .replace(/^Error:\s*/i, '')
  return { line: line ?? 1, message: message || 'Syntax error' }
}

/** File-name-safe slug. */
export function slugify(s: string, fallback = 'untitled'): string {
  const out = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return out || fallback
}

/**
 * Inject an init directive after any front-matter so a one-off render can
 * override config (used for raster export, where HTML labels would taint the
 * canvas).
 */
export function withDirective(source: string, directive: Record<string, unknown>): string {
  const line = `%%{init: ${JSON.stringify(directive)}}%%`
  const lines = source.split('\n')
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end > 0) return [...lines.slice(0, end + 1), line, ...lines.slice(end + 1)].join('\n')
  }
  return `${line}\n${source}`
}
