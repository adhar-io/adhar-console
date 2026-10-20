/** Pure text helpers for Adhar AI drafts (tested in `ai_test.ts`). */

/**
 * The first fenced block in a reply (preferring one tagged with `lang`), or
 * the whole reply when the model answered without a fence.
 */
export function extractFenced(text: string, lang?: string | string[]): string {
  const langs = (Array.isArray(lang) ? lang : lang ? [lang] : []).map((l) => l.toLowerCase())
  const blocks = [...text.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g)].map((m) => ({ lang: m[1].toLowerCase(), body: m[2] }))
  const pick = blocks.find((b) => langs.includes(b.lang)) ?? blocks[0]
  return (pick ? pick.body : text).replace(/\s+$/, '') + '\n'
}

export type DraftKind = 'adr' | 'adr-improve' | 'diagram' | 'api' | 'stickies'

const RULES: Record<DraftKind, string> = {
  adr: [
    'You write Architecture Decision Records in the MADR 3 format.',
    'Reply with ONE fenced ```markdown block containing the ADR and nothing else of substance.',
    'Start with "# <short title>" then the sections "## Context and Problem Statement", "## Decision Drivers",',
    '"## Considered Options", "## Decision Outcome", "### Consequences". Use bullet lists.',
    'Ground the content in the platform context provided; never invent metrics, costs or dates.',
  ].join(' '),
  'adr-improve': [
    'You improve an existing Architecture Decision Record in MADR 3 format.',
    'Keep its decision and facts; tighten wording, fill gaps the context supports, and flag open questions.',
    'Reply with ONE fenced ```markdown block containing the complete revised ADR.',
  ].join(' '),
  diagram: [
    'You write Mermaid diagrams.',
    'Reply with ONE fenced ```mermaid block containing valid Mermaid source and nothing else of substance.',
    'Prefer flowchart, sequenceDiagram, C4Context/C4Container or erDiagram as fits the request.',
    'Use only the systems and names given in the context or the request; do not invent components.',
  ].join(' '),
  api: [
    'You design HTTP APIs as OpenAPI 3.0 documents.',
    'Reply with ONE fenced ```yaml block containing a complete, valid OpenAPI 3.0.3 document',
    '(info, paths with operationIds, request/response schemas under components.schemas). Nothing else of substance.',
  ].join(' '),
  stickies: [
    'You facilitate a brainstorming board.',
    'Reply with ONE fenced ```text block: one short idea per line (max 12 words each, at most 16 lines), no numbering.',
  ].join(' '),
}

export function draftPrompt(kind: DraftKind, request: string): string {
  return `${RULES[kind]}\n\nRequest:\n${request.trim()}`
}

/** Sticky-note lines from a reply: bullets, numbering and blanks removed. */
export function ideaLines(reply: string, max = 24): string[] {
  return extractFenced(reply, ['text', 'markdown', 'md'])
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l && !/^```/.test(l))
    .slice(0, max)
}
