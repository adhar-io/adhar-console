/**
 * Pure helpers for the UX research views (Personas, Journey Maps) and the
 * Design dashboard: initials, markdown export, the journey SVG export, emotion
 * scoring, and the coverage hints the dashboard surfaces. Framework-free and
 * unit-tested (`ux-lib_test.ts`).
 */

import type { Adr, Journey, JourneyEmotion, JourneyStage, Persona, TokenSet } from './types.ts'
import { contrastRatio, findColor } from './tokens-lib.ts'

/* ───────────────────────────── personas ───────────────────────────── */

/** Initials for an avatar: "Priya Sharma — Platform engineer" → "PS"; "Priya" → "P". */
export function initials(name: string): string {
  const head = name.split(/\s+[—–-]\s+/)[0] ?? name
  const words = head.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (!words.length) return '?'
  const first = [...words[0]].find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '?'
  const last = words.length > 1 ? [...words[words.length - 1]].find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '' : ''
  return (first + last).toUpperCase()
}

/** The persona's first name-ish label, for compact UI ("Priya — Platform Engineer" → "Priya"). */
export function shortPersonaName(name: string): string {
  return (name.split(/\s+[—–-]\s+/)[0] ?? name).trim()
}

function list(title: string, items: string[] | undefined): string[] {
  if (!items?.length) return []
  return [`### ${title}`, '', ...items.map((i) => `- ${i}`), '']
}

export function personaToMarkdown(p: Persona, journeys: Journey[] = []): string {
  const linked = journeys.filter((j) => j.persona === p.id)
  return [
    `## ${p.name}`,
    '',
    `**Role:** ${p.role}${p.location ? `  \n**Context:** ${p.location}` : ''}${
      p.tags?.length ? `  \n**Segments:** ${p.tags.join(', ')}` : ''
    }`,
    '',
    ...(p.quote ? [`> “${p.quote}”`, ''] : []),
    ...(p.bio ? [p.bio, ''] : []),
    ...list('Jobs to be done', p.jobs),
    ...list('Goals', p.goals),
    ...list('Frustrations', p.frustrations),
    ...list('Behaviours', p.behaviors),
    ...list('Needs', p.needs),
    ...(p.tech.length ? ['### Tools', '', p.tech.join(', '), ''] : []),
    ...(linked.length ? ['### Journeys', '', ...linked.map((j) => `- ${j.name}`), ''] : []),
  ].join('\n')
}

export function personasToMarkdown(ps: Persona[], journeys: Journey[] = []): string {
  return ['# Personas', '', ...ps.map((p) => personaToMarkdown(p, journeys))].join('\n')
}

/** Case-insensitive search over every text field of a persona. */
export function personaMatches(p: Persona, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const hay = [
    p.name,
    p.role,
    p.bio,
    p.quote ?? '',
    p.location ?? '',
    ...(p.tags ?? []),
    ...(p.jobs ?? []),
    ...p.goals,
    ...p.frustrations,
    ...p.behaviors,
    ...p.needs,
    ...p.tech,
  ].join('\n').toLowerCase()
  return needle.split(/\s+/).every((w) => hay.includes(w))
}

/** Completeness 0…1 — how much of the profile is filled in. */
export function personaCompleteness(p: Persona): number {
  const checks = [
    !!p.bio?.trim(),
    !!p.quote?.trim(),
    (p.jobs?.length ?? 0) > 0,
    p.goals.length > 0,
    p.frustrations.length > 0,
    p.behaviors.length > 0,
    p.needs.length > 0,
    p.tech.length > 0,
  ]
  return checks.filter(Boolean).length / checks.length
}

/* ───────────────────────────── journeys ───────────────────────────── */

export const EMOTION_SCORE: Record<JourneyEmotion, number> = {
  frustrated: -2,
  stressed: -1.5,
  urgent: -1,
  cautious: -0.5,
  reflective: 0,
  curious: 0.5,
  focused: 0.5,
  satisfied: 1.5,
  excited: 2,
}

export const EMOTION_EMOJI: Record<JourneyEmotion, string> = {
  excited: '😄',
  satisfied: '🙂',
  curious: '🤔',
  focused: '🧐',
  reflective: '😐',
  cautious: '😟',
  urgent: '😬',
  stressed: '😰',
  frustrated: '😤',
}

/** Emotions ordered from most positive to most negative (for pickers). */
export const EMOTIONS: JourneyEmotion[] = [
  'excited',
  'satisfied',
  'curious',
  'focused',
  'reflective',
  'cautious',
  'urgent',
  'stressed',
  'frustrated',
]

/** −2…+2 score of a stage: the explicit score when set, else the emotion's default. */
export function stageScore(s: JourneyStage): number {
  if (typeof s.score === 'number' && Number.isFinite(s.score)) return Math.max(-2, Math.min(2, s.score))
  return EMOTION_SCORE[s.emotion] ?? 0
}

/** The lanes of a journey map, in display order. */
export const LANES = [
  { key: 'actions', label: 'Actions', hint: 'What the user does' },
  { key: 'touchpoints', label: 'Touchpoints', hint: 'Channels and surfaces' },
  { key: 'thoughts', label: 'Thoughts', hint: 'What they think or ask' },
  { key: 'pains', label: 'Pain points', hint: 'Friction, blockers' },
  { key: 'opportunities', label: 'Opportunities', hint: 'Ideas to improve' },
] as const

export type LaneKey = (typeof LANES)[number]['key']

export function laneItems(s: JourneyStage, lane: LaneKey): string[] {
  return (s[lane] as string[] | undefined) ?? []
}

/** Move the item at `from` to index `to` (both clamped). Returns a new array. */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length) return arr
  const t = Math.max(0, Math.min(arr.length - 1, to))
  if (t === from) return arr
  const copy = arr.slice()
  const [x] = copy.splice(from, 1)
  copy.splice(t, 0, x)
  return copy
}

export function journeyToMarkdown(j: Journey, persona?: Persona): string {
  const out = [`# ${j.name}`, '']
  if (persona) out.push(`**Persona:** ${persona.name} (${persona.role})`)
  if (j.goal) out.push(`**Goal:** ${j.goal}`)
  if (persona || j.goal) out.push('')
  if (j.summary) out.push(j.summary, '')
  out.push('## Emotion curve', '', '| Stage | Emotion | Score |', '| --- | --- | ---: |')
  for (const s of j.stages) out.push(`| ${s.name} | ${s.emotion} | ${stageScore(s) > 0 ? '+' : ''}${stageScore(s)} |`)
  out.push('')
  j.stages.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.name}`, '')
    for (const l of LANES) out.push(...list(l.label, laneItems(s, l.key)))
  })
  return out.join('\n')
}

/* ─── SVG export (rasterised to PNG in the browser) ─── */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Greedy word wrap to `max` characters per line. */
export function wrapText(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (!cur) cur = w
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w
    else {
      lines.push(cur)
      cur = w
    }
    while (cur.length > max) {
      lines.push(cur.slice(0, max - 1) + '-')
      cur = cur.slice(max - 1)
    }
  }
  if (cur) lines.push(cur)
  return lines
}

/**
 * A self-contained, light-themed SVG of the whole journey map: stage header,
 * emotion curve, and one row per lane. Used for the SVG download and drawn
 * onto a canvas for PNG.
 */
export function journeyToSvg(j: Journey, persona?: Persona): { svg: string; width: number; height: number } {
  const COL = 230
  const LABEL = 150
  const PAD = 24
  const LINE = 17
  const CHARS = 30
  const n = Math.max(1, j.stages.length)
  const width = PAD * 2 + LABEL + COL * n
  const parts: string[] = []
  let y = PAD

  parts.push(`<text x="${PAD}" y="${y + 20}" font-size="20" font-weight="600" fill="#0f172a">${esc(j.name)}</text>`)
  y += 30
  const sub = [persona ? `Persona: ${persona.name}` : '', j.goal ? `Goal: ${j.goal}` : ''].filter(Boolean).join('   ·   ')
  if (sub) {
    parts.push(`<text x="${PAD}" y="${y + 14}" font-size="13" fill="#475569">${esc(sub)}</text>`)
    y += 24
  }
  y += 8

  // Stage headers
  j.stages.forEach((s, i) => {
    const x = PAD + LABEL + i * COL
    parts.push(`<rect x="${x + 4}" y="${y}" width="${COL - 8}" height="34" rx="8" fill="#eef2ff"/>`)
    parts.push(`<text x="${x + 16}" y="${y + 22}" font-size="13" font-weight="600" fill="#3730a3">${i + 1}. ${esc(s.name)}</text>`)
  })
  y += 46

  // Emotion curve
  const CURVE_H = 110
  parts.push(`<text x="${PAD}" y="${y + 16}" font-size="12" font-weight="600" fill="#334155">Emotion</text>`)
  const mid = y + CURVE_H / 2
  parts.push(`<line x1="${PAD + LABEL}" y1="${mid}" x2="${width - PAD}" y2="${mid}" stroke="#cbd5e1" stroke-dasharray="3 4"/>`)
  const pts = j.stages.map((s, i) => {
    const x = PAD + LABEL + i * COL + COL / 2
    const yy = mid - (stageScore(s) / 2) * (CURVE_H / 2 - 14)
    return [x, yy, s] as const
  })
  if (pts.length > 1) {
    parts.push(
      `<polyline fill="none" stroke="#6366f1" stroke-width="2" points="${pts.map(([x, yy]) => `${x},${yy}`).join(' ')}"/>`,
    )
  }
  for (const [x, yy, s] of pts) {
    parts.push(`<circle cx="${x}" cy="${yy}" r="5" fill="#ffffff" stroke="#6366f1" stroke-width="2"/>`)
    parts.push(`<text x="${x + 10}" y="${yy + 4}" font-size="11" fill="#475569">${esc(s.emotion)}</text>`)
  }
  y += CURVE_H + 10

  // Lanes
  for (const lane of LANES) {
    const cells = j.stages.map((s) => laneItems(s, lane.key).map((it) => wrapText(it, CHARS)))
    const lines = Math.max(1, ...cells.map((c) => c.reduce((a, l) => a + l.length, 0) + Math.max(0, c.length - 1) * 0.4))
    const h = Math.ceil(lines * LINE + 24)
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${width - PAD}" y2="${y}" stroke="#e2e8f0"/>`)
    parts.push(`<text x="${PAD}" y="${y + 20}" font-size="12" font-weight="600" fill="#334155">${esc(lane.label)}</text>`)
    cells.forEach((items, i) => {
      const x = PAD + LABEL + i * COL + 12
      let yy = y + 20
      for (const wrapped of items) {
        wrapped.forEach((line, k) => {
          parts.push(`<text x="${x + (k ? 10 : 0)}" y="${yy}" font-size="12" fill="#0f172a">${k ? '' : '• '}${esc(line)}</text>`)
          yy += LINE
        })
        yy += LINE * 0.4
      }
    })
    y += h
  }
  y += PAD
  const height = Math.ceil(y)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, system-ui, -apple-system, Segoe UI, sans-serif"><rect width="100%" height="100%" fill="#ffffff"/>${parts.join('')}</svg>`
  return { svg, width, height }
}

/* ───────────────────────────── journey templates ───────────────────────────── */

export const JOURNEY_TEMPLATES: Array<{ id: string; label: string; description: string; stages: string[] }> = [
  { id: 'blank', label: 'Blank', description: 'Four empty stages to start from.', stages: ['Discover', 'Try', 'Adopt', 'Win'] },
  {
    id: 'onboarding',
    label: 'Product onboarding',
    description: 'From first visit to the first meaningful outcome.',
    stages: ['Discover', 'Sign up', 'Set up', 'First value', 'Habit'],
  },
  {
    id: 'purchase',
    label: 'Purchase funnel',
    description: 'The classic awareness-to-advocacy journey.',
    stages: ['Aware', 'Consider', 'Buy', 'Use', 'Advocate'],
  },
  {
    id: 'incident',
    label: 'Incident response',
    description: 'An on-call engineer handling a production incident.',
    stages: ['Alerted', 'Triage', 'Mitigate', 'Resolve', 'Review'],
  },
  {
    id: 'support',
    label: 'Support request',
    description: 'A customer getting help with a problem.',
    stages: ['Problem', 'Search help', 'Contact', 'Resolution', 'Follow-up'],
  },
]

/* ───────────────────────────── dashboard coverage ───────────────────────────── */

export interface CoverageHint {
  id: string
  tone: 'warning' | 'info'
  title: string
  detail: string
  /** Where to fix it. */
  section: 'personas' | 'journeys' | 'adrs' | 'tokens'
  params?: Record<string, string>
}

type WithTime = { _updatedAt?: string }

/**
 * Gaps in the design workspace worth acting on, derived only from the stored
 * artifacts (nothing invented): unlinked journeys, personas without journeys,
 * stages missing pains/opportunities, stale proposed ADRs, and token pairs
 * that fail WCAG AA.
 */
export function coverageHints(input: {
  personas: Persona[]
  journeys: Journey[]
  adrs: Array<Adr & WithTime>
  tokens?: TokenSet | null
  now?: Date
  staleDays?: number
}): CoverageHint[] {
  const { personas, journeys, adrs, tokens } = input
  const now = input.now ?? new Date()
  const staleDays = input.staleDays ?? 14
  const hints: CoverageHint[] = []
  const personaIds = new Set(personas.map((p) => p.id))

  for (const j of journeys) {
    if (!j.persona || !personaIds.has(j.persona)) {
      hints.push({
        id: `journey-no-persona-${j.id}`,
        tone: 'warning',
        title: `“${j.name}” has no persona`,
        detail: 'Link it to the persona whose journey it is.',
        section: 'journeys',
        params: { journey: j.id },
      })
    }
    const thin = j.stages.filter((s) => !s.pains.length && !s.opportunities.length)
    if (j.stages.length && thin.length) {
      hints.push({
        id: `journey-thin-${j.id}`,
        tone: 'info',
        title: `“${j.name}”: ${thin.length} of ${j.stages.length} stages without pains or opportunities`,
        detail: thin.map((s) => s.name).join(', '),
        section: 'journeys',
        params: { journey: j.id },
      })
    }
  }

  const covered = new Set(journeys.map((j) => j.persona))
  for (const p of personas) {
    if (!covered.has(p.id)) {
      hints.push({
        id: `persona-no-journey-${p.id}`,
        tone: 'info',
        title: `${shortPersonaName(p.name)} has no journey map`,
        detail: 'Map how this persona moves through the product.',
        section: 'personas',
        params: { persona: p.id },
      })
    }
  }

  for (const a of adrs) {
    if (a.status !== 'proposed') continue
    const ts = Date.parse(a._updatedAt ?? a.updated_at)
    if (!Number.isFinite(ts)) continue
    const days = Math.floor((now.getTime() - ts) / 86_400_000)
    if (days >= staleDays) {
      hints.push({
        id: `adr-stale-${a.id}`,
        tone: 'warning',
        title: `ADR-${String(a.number).padStart(4, '0')} proposed ${days} days ago`,
        detail: a.title,
        section: 'adrs',
        params: { adr: a.id },
      })
    }
  }

  if (tokens) {
    for (const mode of ['light', 'dark'] as const) {
      const text = findColor(tokens, ['text', 'foreground', 'fg', 'primary'], mode, '')
      const surface = findColor(tokens, ['surface', 'background', 'bg'], mode, mode === 'light' ? '#ffffff' : '')
      if (!text || !surface) continue
      const r = contrastRatio(text, surface)
      if (r !== null && r < 4.5) {
        hints.push({
          id: `tokens-contrast-${mode}`,
          tone: 'warning',
          title: `Body text fails WCAG AA in ${mode} mode`,
          detail: `${r.toFixed(2)}:1 — at least 4.5:1 is needed for body text.`,
          section: 'tokens',
          params: { tab: 'color' },
        })
      }
    }
  }

  return hints.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'warning' ? -1 : 1))
}
