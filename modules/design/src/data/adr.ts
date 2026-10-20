/**
 * Pure ADR logic: numbering, MADR markdown export / import, lifecycle,
 * supersession links, search and the repository index. Framework-free so it
 * is unit-tested in `adr_test.ts`.
 */

import type { Adr, AdrStatus, PlaneLink } from './types.ts'

export interface AdrEvent {
  at: string
  by: string
  action: string
  detail?: string
}

export interface AdrGitLink {
  repo: string
  branch: string
  path: string
  /** Commit sha of the last sync. */
  sha?: string
  /** Blob sha of the file as last synced — tells a repo edit from a local one. */
  blob?: string
  at: string
}

/** A pull request opened from the console for this ADR. */
export interface AdrPullRequest {
  repo: string
  number: number
  branch: string
  base: string
  at: string
}

export type ReviewVerdict = 'approve' | 'changes' | 'reject' | 'comment'

export interface AdrReviewer {
  /** Workspace member id (Keycloak subject). */
  id: string
  name: string
  email?: string
}

export interface AdrReviewEntry {
  at: string
  by: string
  byId?: string
  verdict: ReviewVerdict
  comment?: string
}

/** The review round of a proposed decision. */
export interface AdrReview {
  requestedAt: string
  requestedBy: string
  reviewers: AdrReviewer[]
  entries: AdrReviewEntry[]
  /** Set when the decision was accepted or rejected. */
  closedAt?: string
  outcome?: 'accepted' | 'rejected'
}


/** Stored ADR plus the optional MADR fields this editor adds. */
export type AdrDoc = Adr & {
  /** Decision drivers (markdown). */
  drivers?: string
  /** Considered options (markdown). */
  options?: string
  /** Free-form "More information" (markdown). */
  notes?: string
  deciders?: string[]
  /** Decision date, `YYYY-MM-DD`. */
  date?: string
  /** Id of the ADR that replaced this one. */
  supersededBy?: string
  /** Ids of ADRs this one replaces. */
  supersedes?: string[]
  /** Ids of related ADRs. */
  related?: string[]
  history?: AdrEvent[]
  git?: AdrGitLink
  /** Workspace project / team the decision belongs to. */
  project?: string
  team?: string
  /** Catalog entities this decision is about (canonical refs). */
  entities?: string[]
  review?: AdrReview
  pr?: AdrPullRequest
  /** Plane work items tracking follow-ups (shared `PlaneLink` shape). */
  workItems?: PlaneLink[]
}

export const STATUSES: AdrStatus[] = ['proposed', 'accepted', 'deprecated', 'superseded', 'rejected']

export const STATUS_LABEL: Record<AdrStatus, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  deprecated: 'Deprecated',
  superseded: 'Superseded',
  rejected: 'Rejected',
}

/** Suggested next steps in the lifecycle (supersede is its own flow). */
export const NEXT_STATUS: Record<AdrStatus, AdrStatus[]> = {
  proposed: ['accepted', 'rejected'],
  accepted: ['deprecated'],
  deprecated: ['accepted'],
  superseded: [],
  rejected: ['proposed'],
}

export function canSupersede(status: AdrStatus): boolean {
  return status === 'accepted' || status === 'deprecated'
}

export function formatAdrNumber(n: number): string {
  return `ADR-${String(Math.max(0, Math.floor(n))).padStart(4, '0')}`
}

export function nextAdrNumber(list: Pick<Adr, 'number'>[]): number {
  return list.reduce((m, a) => Math.max(m, Number(a.number) || 0), 0) + 1
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'decision'
  )
}

/** `0007-adopt-tekton.md` — the conventional adr-tools / MADR file name. */
export function adrFileName(adr: Pick<Adr, 'number' | 'title'>): string {
  return `${String(adr.number).padStart(4, '0')}-${slug(adr.title)}.md`
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

const EMPTY = /^\s*(—|-)?\s*$/

function section(title: string, body: string | undefined, level = 2): string {
  if (!body || EMPTY.test(body)) return ''
  return `${'#'.repeat(level)} ${title}\n\n${body.trim()}\n\n`
}

/**
 * MADR 3-style markdown with YAML front matter. `lookup` resolves linked ADR
 * ids to their number/title for the "More information" links.
 */
export function adrToMarkdown(adr: AdrDoc, lookup: (id: string) => AdrDoc | undefined = () => undefined): string {
  const fm: string[] = ['---', `status: ${adr.status}`]
  fm.push(`date: ${adr.date ?? (adr.updated_at ?? '').slice(0, 10)}`)
  const deciders = adr.deciders?.length ? adr.deciders : adr.authors
  if (deciders?.length) fm.push(`deciders: [${deciders.map(yamlInline).join(', ')}]`)
  if (adr.tags?.length) fm.push(`tags: [${adr.tags.map(yamlInline).join(', ')}]`)
  fm.push('---', '')

  const ref = (id: string) => {
    const a = lookup(id)
    return a ? `[${formatAdrNumber(a.number)} ${a.title}](${adrFileName(a)})` : id
  }
  const links: string[] = []
  if (adr.supersededBy) links.push(`- Superseded by ${ref(adr.supersededBy)}`)
  for (const id of adr.supersedes ?? []) links.push(`- Supersedes ${ref(id)}`)
  for (const id of adr.related ?? []) links.push(`- Related to ${ref(id)}`)
  const more = [adr.notes?.trim(), links.join('\n')].filter(Boolean).join('\n\n')

  return (
    fm.join('\n') +
    `# ${formatAdrNumber(adr.number)}: ${adr.title}\n\n` +
    section('Context and Problem Statement', adr.context) +
    section('Decision Drivers', adr.drivers) +
    section('Considered Options', adr.options) +
    section('Decision Outcome', adr.decision) +
    section('Consequences', adr.consequences, 3) +
    section('More Information', more)
  ).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function yamlInline(s: string): string {
  return /^[\w.@-]+$/.test(s) ? s : JSON.stringify(s)
}

function parseInlineList(v: string): string[] {
  const s = v.trim()
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
  return inner
    .split(',')
    .map((x) => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

const SECTION_KEYS: { key: keyof AdrDoc; match: RegExp }[] = [
  { key: 'context', match: /^context( and problem statement)?$|^problem( statement)?$/ },
  { key: 'drivers', match: /^decision drivers?$|^drivers$/ },
  { key: 'options', match: /^considered options$|^options( considered)?$|^alternatives( considered)?$|^pros and cons of the options$/ },
  { key: 'decision', match: /^decision( outcome)?$|^outcome$/ },
  { key: 'consequences', match: /^consequences$|^positive consequences|^negative consequences/ },
  { key: 'notes', match: /^more information$|^links$|^notes$/ },
]

export interface ParsedAdr {
  number?: number
  title?: string
  status?: AdrStatus
  date?: string
  deciders?: string[]
  tags?: string[]
  context?: string
  drivers?: string
  options?: string
  decision?: string
  consequences?: string
  notes?: string
}

/** Import MADR / Nygard-style markdown into ADR fields (best effort). */
export function markdownToAdr(md: string): ParsedAdr {
  const out: ParsedAdr = {}
  let text = md.replace(/\r\n?/g, '\n')
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (fm) {
    text = text.slice(fm[0].length)
    for (const line of fm[1].split('\n')) {
      const m = /^(\w[\w-]*):\s*(.*)$/.exec(line.trim())
      if (!m) continue
      const [, k, v] = m
      const val = v.trim().replace(/^["']|["']$/g, '')
      if (k === 'status') out.status = asStatus(val)
      else if (k === 'date') out.date = val
      else if (k === 'deciders' || k === 'authors') out.deciders = parseInlineList(v)
      else if (k === 'tags') out.tags = parseInlineList(v)
    }
  }
  const lines = text.split('\n')
  let current: keyof ParsedAdr | 'status-section' | null = null
  const buf: Partial<Record<string, string[]>> = {}
  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line)
    if (h1 && !out.title) {
      let t = h1[1].trim()
      const num = /^(?:ADR[-\s]?)?(\d+)[:.\s-]+\s*(.+)$/i.exec(t)
      if (num) {
        out.number = Number(num[1])
        t = num[2].trim()
      }
      out.title = t
      current = null
      continue
    }
    const h = /^#{2,3}\s+(.+?)\s*#*$/.exec(line)
    if (h) {
      const name = h[1].trim().toLowerCase()
      if (name === 'status') {
        current = 'status-section'
        continue
      }
      const hit = SECTION_KEYS.find((s) => s.match.test(name))
      if (hit) {
        current = hit.key as keyof ParsedAdr
        continue
      }
      // An unknown sub-heading stays inside the current section.
      if (current) (buf[current] ??= []).push(line)
      continue
    }
    if (current) (buf[current] ??= []).push(line)
  }
  for (const [k, v] of Object.entries(buf)) {
    const body = (v ?? []).join('\n').trim()
    if (!body) continue
    if (k === 'status-section') {
      const s = asStatus(body.split(/\s/)[0])
      if (s && !out.status) out.status = s
    } else {
      ;(out as Record<string, unknown>)[k] = body
    }
  }
  return out
}

function asStatus(v: string): AdrStatus | undefined {
  const s = v.toLowerCase().replace(/[^a-z]/g, '')
  return (STATUSES as string[]).includes(s) ? (s as AdrStatus) : undefined
}

/** Markdown index for `docs/adr/README.md`. */
export function adrIndexMarkdown(list: AdrDoc[]): string {
  const rows = [...list]
    .sort((a, b) => a.number - b.number)
    .map((a) => `| [${formatAdrNumber(a.number)}](${adrFileName(a)}) | ${a.title.replace(/\|/g, '\\|')} | ${STATUS_LABEL[a.status]} | ${a.date ?? (a.updated_at ?? '').slice(0, 10)} |`)
  return [
    '# Architecture Decision Records',
    '',
    'Decisions recorded with the [MADR](https://adr.github.io/madr/) template. Managed from the Adhar Console → Design → Architecture Decisions.',
    '',
    '| ADR | Title | Status | Date |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

export interface AdrFilter {
  q?: string
  status?: AdrStatus | 'all'
  tag?: string | null
}

export function filterAdrs<T extends AdrDoc>(list: T[], f: AdrFilter): T[] {
  const q = (f.q ?? '').trim().toLowerCase()
  const terms = q.split(/\s+/).filter(Boolean)
  return list.filter((a) => {
    if (f.status && f.status !== 'all' && a.status !== f.status) return false
    if (f.tag && !(a.tags ?? []).includes(f.tag)) return false
    if (!terms.length) return true
    const hay = [
      formatAdrNumber(a.number),
      String(a.number),
      a.title,
      a.context,
      a.decision,
      a.consequences,
      a.drivers ?? '',
      a.options ?? '',
      ...(a.tags ?? []).map((t) => `#${t}`),
      ...(a.authors ?? []),
      ...(a.deciders ?? []),
    ]
      .join(' ')
      .toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}

export function appendHistory<T extends AdrDoc>(adr: T, ev: AdrEvent, cap = 50): T {
  return { ...adr, history: [ev, ...(adr.history ?? [])].slice(0, cap) }
}

/**
 * Supersede `older` with `newer`: the old ADR becomes `superseded` and points
 * forward; the new one lists what it replaces. Returns both updated docs.
 */
export function supersede<T extends AdrDoc>(older: T, newer: T, by: string, at = new Date().toISOString()): [T, T] {
  const o = appendHistory(
    { ...older, status: 'superseded' as AdrStatus, supersededBy: newer.id, updated_at: at },
    { at, by, action: 'Superseded', detail: `by ${formatAdrNumber(newer.number)}` },
  )
  const n = appendHistory(
    {
      ...newer,
      supersedes: Array.from(new Set([...(newer.supersedes ?? []), older.id])),
      updated_at: at,
    },
    { at, by, action: 'Supersedes', detail: formatAdrNumber(older.number) },
  )
  return [o, n]
}

/** ADRs that reference `id` (supersession or related), excluding itself. */
export function backlinks<T extends AdrDoc>(list: T[], id: string): T[] {
  return list.filter(
    (a) => a.id !== id && (a.supersededBy === id || (a.supersedes ?? []).includes(id) || (a.related ?? []).includes(id)),
  )
}

export type AdrTemplateId = 'madr' | 'nygard' | 'lean'

export const ADR_TEMPLATES: { id: AdrTemplateId; label: string; description: string; fields: Partial<AdrDoc> }[] = [
  {
    id: 'madr',
    label: 'MADR (full)',
    description: 'Context, drivers, options with pros/cons, outcome and consequences.',
    fields: {
      context: 'Describe the context and the problem in two or three sentences. What forces are at play?',
      drivers: '- Driver 1 (e.g. a force, a facing concern)\n- Driver 2',
      options: '1. **Option A** — summary\n   - Good, because …\n   - Bad, because …\n2. **Option B** — summary\n   - Good, because …\n   - Bad, because …',
      decision: 'Chosen option: **Option A**, because it is the only one that meets driver 1 and …',
      consequences: '- Good, because …\n- Bad, because …',
    },
  },
  {
    id: 'nygard',
    label: 'Nygard (classic)',
    description: 'Context, decision, consequences — the original lightweight form.',
    fields: {
      context: 'What is the issue that motivates this decision or change?',
      decision: 'What is the change that we are proposing and/or doing?',
      consequences: 'What becomes easier or more difficult to do because of this change?',
    },
  },
  {
    id: 'lean',
    label: 'Blank',
    description: 'Empty sections — write it your way.',
    fields: { context: '', decision: '', consequences: '' },
  },
]
