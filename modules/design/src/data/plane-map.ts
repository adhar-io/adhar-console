/**
 * Design artifacts → Plane work items (pure, tested).
 *
 * Journey pain points become issues, opportunities become (lower-priority)
 * issues, persona jobs-to-be-done become issues; a bulk creation can be grouped
 * under one parent item (Plane's public API has no epics, so the parent plays
 * that role). Every draft carries a stable `source` key so an item is never
 * created twice for the same text — re-running "Create work items" only offers
 * what is not linked yet.
 */

import type { Journey, Persona, PlaneLink, Wireframe } from './types.ts'

export type DraftKind = 'pain' | 'opportunity' | 'job' | 'wireframe' | 'parent'

export interface PlaneDraft {
  /** Stable identity of what the item came from (dedupe key). */
  source: string
  kind: DraftKind
  name: string
  /** HTML body — Plane stores `description_html`. */
  description_html: string
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
  /** Context line for the confirm list (stage name, persona…). */
  context: string
}

const MAX_NAME = 240

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function clip(s: string, n = MAX_NAME): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** Normalise free text into a dedupe key fragment. */
export function sourceKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160)
}

function linkPara(label: string, url?: string): string {
  return url ? `<p><a href="${esc(url)}">${esc(label)}</a></p>` : ''
}

/** Drafts for a journey's pain points and opportunities, minus what is already linked. */
export function journeyDrafts(
  j: Journey,
  persona: Persona | undefined,
  opts: { include: Array<'pain' | 'opportunity'>; link?: string; existing?: PlaneLink[] } = { include: ['pain', 'opportunity'] },
): PlaneDraft[] {
  const linked = new Set((opts.existing ?? j.planeLinks ?? []).map((l) => l.source))
  const who = persona ? persona.name : 'the user'
  const out: PlaneDraft[] = []
  for (const s of j.stages) {
    for (const kind of opts.include) {
      const items = kind === 'pain' ? s.pains : s.opportunities
      for (const raw of items) {
        const text = raw.trim()
        if (!text) continue
        const source = `${kind}:${s.id}:${sourceKey(text)}`
        if (linked.has(source)) continue
        const name = kind === 'pain' ? clip(`Fix: ${text}`) : clip(text)
        const body = [
          `<p>${kind === 'pain' ? 'Pain point' : 'Opportunity'} for <strong>${esc(who)}</strong> in the <strong>${esc(s.name)}</strong> stage of the journey “${esc(j.name)}”.</p>`,
          `<blockquote>${esc(text)}</blockquote>`,
          s.components?.length ? `<p>Components serving this stage: ${s.components.map(esc).join(', ')}</p>` : '',
          j.goal ? `<p>Journey goal: ${esc(j.goal)}</p>` : '',
          linkPara('Open the journey map in Adhar Design', opts.link),
        ].join('')
        out.push({
          source,
          kind,
          name,
          description_html: body,
          // A pain in a stage the persona feels badly about is more urgent.
          priority: kind === 'pain' ? ((s.score ?? 0) <= -1 ? 'high' : 'medium') : 'low',
          context: s.name,
        })
      }
    }
  }
  return out
}

/** Drafts for a persona's jobs-to-be-done, minus what is already linked. */
export function personaDrafts(p: Persona, opts: { link?: string; existing?: PlaneLink[] } = {}): PlaneDraft[] {
  const linked = new Set((opts.existing ?? p.planeLinks ?? []).map((l) => l.source))
  const out: PlaneDraft[] = []
  for (const raw of p.jobs ?? []) {
    const text = raw.trim()
    if (!text) continue
    const source = `job:${sourceKey(text)}`
    if (linked.has(source)) continue
    out.push({
      source,
      kind: 'job',
      name: clip(`Enable: ${jobTitle(text)}`),
      description_html: [
        `<p>Job to be done for <strong>${esc(p.name)}</strong> (${esc(p.role)}).</p>`,
        `<blockquote>${esc(text)}</blockquote>`,
        p.needs.length ? `<p>Needs: ${p.needs.map(esc).join('; ')}</p>` : '',
        linkPara('Open the persona in Adhar Design', opts.link),
      ].join(''),
      priority: 'medium',
      context: p.role,
    })
  }
  return out
}

/** "When …, I want to X, so I can …" → "X" (falls back to the whole job). */
export function jobTitle(job: string): string {
  const m = job.match(/i want to ([^,.;]+)/i)
  const core = m ? m[1].trim() : job.trim()
  return core.charAt(0).toUpperCase() + core.slice(1)
}

/** One draft for a wireframe (screen) to be built. */
export function wireframeDraft(w: Wireframe, link?: string): PlaneDraft {
  return {
    source: `wireframe:${w.id}`,
    kind: 'wireframe',
    name: clip(`Build screen: ${w.name}`),
    description_html: [
      `<p>Screen <strong>${esc(w.name)}</strong> (flow ${esc(w.flow)}, step ${w.order}).</p>`,
      w.notes ? `<p>${esc(w.notes)}</p>` : '',
      w.component ? `<p>Component: ${esc(w.component.name)}${w.component.repo ? ` (${esc(w.component.repo)})` : ''}</p>` : '',
      linkPara('Open the wireframe in Adhar Design', link),
    ].join(''),
    priority: 'medium',
    context: w.flow,
  }
}

/** The parent ("epic") item a bulk creation is grouped under. */
export function parentDraft(title: string, summary: string, source: string, link?: string): PlaneDraft {
  return {
    source,
    kind: 'parent',
    name: clip(title),
    description_html: `<p>${esc(summary)}</p>${linkPara('Open in Adhar Design', link)}`,
    priority: 'none',
    context: 'Parent',
  }
}

/** Merge newly created links into an artifact's list (dedupe by source, newest wins). */
export function mergeLinks(existing: PlaneLink[] | undefined, added: PlaneLink[]): PlaneLink[] {
  const by = new Map<string, PlaneLink>()
  for (const l of existing ?? []) by.set(l.source, l)
  for (const l of added) by.set(l.source, l)
  return [...by.values()]
}

/** Is this stage item already tracked in Plane? */
export function linkFor(links: PlaneLink[] | undefined, kind: 'pain' | 'opportunity', stageId: string, text: string): PlaneLink | undefined {
  const src = `${kind}:${stageId}:${sourceKey(text)}`
  return (links ?? []).find((l) => l.source === src)
}

/** Plane state group → a coarse status for chips. */
export type IssueStatus = 'backlog' | 'todo' | 'in-progress' | 'done' | 'cancelled' | 'unknown'

export function statusOfGroup(group: string | undefined): IssueStatus {
  switch (group) {
    case 'backlog':
      return 'backlog'
    case 'unstarted':
      return 'todo'
    case 'started':
      return 'in-progress'
    case 'completed':
      return 'done'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** Summary counts of linked items by status (for dashboards). */
export function statusCounts(statuses: IssueStatus[]): Record<IssueStatus, number> {
  const out: Record<IssueStatus, number> = { backlog: 0, todo: 0, 'in-progress': 0, done: 0, cancelled: 0, unknown: 0 }
  for (const s of statuses) out[s]++
  return out
}
