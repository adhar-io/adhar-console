import type { ColorToken, Journey, JourneyEmotion, JourneyStage, Persona } from './types.ts'
import { EMOTIONS } from './ux-lib.ts'

/**
 * Adhar AI drafts for the UX pages (pure, tested) — prompts and the
 * validation that turns a model reply into a persona, journey stages or a
 * colour palette. The transport (`askAdharAi`, `/api/ai/run`) lives in
 * `ai.ts`; drafts are always shown for review before anything is saved.
 */

/** The first JSON value in a model reply (fenced or bare). */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?[^\n]*\n([\s\S]*?)```/i)
  for (const c of [fence?.[1], text]) {
    if (!c) continue
    const start = c.search(/[[{]/)
    if (start < 0) continue
    const close = c[start] === '{' ? '}' : ']'
    const end = c.lastIndexOf(close)
    if (end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1))
    } catch { /* try the next candidate */ }
  }
  throw new Error('Adhar AI did not return JSON. Try rephrasing the request.')
}

const strs = (v: unknown, max = 8): string[] =>
  Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max) : []
const str = (v: unknown, max = 400): string => String(v ?? '').trim().slice(0, max)

/** Normalise a model persona into the stored shape. */
export function toPersona(raw: unknown): Omit<Persona, 'id'> {
  const r = (raw ?? {}) as Record<string, unknown>
  const name = str(r.name, 80)
  if (!name) throw new Error('The draft has no name.')
  return {
    name,
    avatar: '',
    role: str(r.role, 120) || 'Role',
    bio: str(r.bio, 800),
    quote: str(r.quote, 240) || undefined,
    location: str(r.location, 80) || undefined,
    goals: strs(r.goals),
    frustrations: strs(r.frustrations),
    behaviors: strs(r.behaviors ?? r.behaviours),
    needs: strs(r.needs),
    tech: strs(r.tech ?? r.tools, 10),
    jobs: strs(r.jobs ?? r.jobsToBeDone),
    tags: strs(r.tags ?? r.segments, 5),
  }
}

/** Normalise model journey stages. */
export function toStages(raw: unknown, newId: (p: string) => string): JourneyStage[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { stages?: unknown })?.stages) ? (raw as { stages: unknown[] }).stages : []
  return list.slice(0, 10).map((x) => {
    const s = (x ?? {}) as Record<string, unknown>
    const em = String(s.emotion ?? '').toLowerCase() as JourneyEmotion
    const score = Number(s.score)
    return {
      id: newId('stage'),
      name: str(s.name, 60) || 'Stage',
      emotion: EMOTIONS.includes(em) ? em : 'reflective',
      ...(s.score !== undefined && Number.isFinite(score) ? { score: Math.max(-2, Math.min(2, Math.round(score * 2) / 2)) } : {}),
      actions: strs(s.actions, 6),
      touchpoints: strs(s.touchpoints, 6),
      thoughts: strs(s.thoughts, 6),
      pains: strs(s.pains, 6),
      opportunities: strs(s.opportunities, 6),
    }
  })
}

/** Normalise a model palette into colour tokens; invalid colours are dropped. */
export function toPalette(raw: unknown): ColorToken[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { colors?: unknown })?.colors) ? (raw as { colors: unknown[] }).colors : []
  const hex = (v: unknown) => {
    const s = String(v ?? '').trim()
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s.toLowerCase() : null
  }
  const out: ColorToken[] = []
  const seen = new Set<string>()
  for (const x of list.slice(0, 24)) {
    const c = (x ?? {}) as Record<string, unknown>
    const value = hex(c.value ?? c.light ?? c.hex)
    if (!value) continue
    let name = str(c.name, 60).toLowerCase().replace(/^--/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!name) continue
    name = `--adhar-color-${name.replace(/^adhar-color-/, '')}`
    if (seen.has(name)) continue
    seen.add(name)
    const dark = hex(c.dark)
    out.push({ name, value, role: str(c.role, 120), ...(dark ? { dark } : {}) })
  }
  return out
}

export const PERSONA_PROMPT = [
  'Draft ONE user persona for a product team.',
  'Reply with one fenced ```json block containing an object with keys:',
  'name (full name), role, location, bio (2-3 sentences), quote (one sentence in their voice),',
  'goals, frustrations, behaviors, needs, tech (tools), jobs (each "When …, I want to …, so I can …"), tags (segments).',
  'Lists have 3-5 short items. Ground every claim in the context given; never invent statistics or numbers.',
].join(' ')

export const JOURNEY_PROMPT = [
  'Draft the stages of a customer journey map for the persona in context.',
  'Reply with one fenced ```json block: {"stages":[{"name","emotion","score","actions","touchpoints","thoughts","pains","opportunities"}]}.',
  `emotion is one of ${EMOTIONS.join(', ')}; score is -2..2. 4-7 stages, 2-4 short items per list.`,
].join(' ')

export const PALETTE_PROMPT = [
  'Propose a UI colour palette as design tokens.',
  'Reply with one fenced ```json block: {"colors":[{"name","value","dark","role"}]} with 6-digit hex values.',
  'Names are kebab-case without prefix. Include at least: primary, primary-foreground, background, surface, text, text-muted, border, success, warning, danger.',
  'Every text colour must reach WCAG AA (4.5:1) on its background in both the light value and the dark value.',
].join(' ')

export function personaContext(p: Persona) {
  return { description: 'Persona', value: JSON.stringify({ name: p.name, role: p.role, bio: p.bio, goals: p.goals, frustrations: p.frustrations, needs: p.needs, jobs: p.jobs }) }
}

export function journeyContext(j: Pick<Journey, 'name' | 'goal' | 'summary'>) {
  return { description: 'Journey', value: JSON.stringify({ name: j.name, goal: j.goal, summary: j.summary }) }
}
