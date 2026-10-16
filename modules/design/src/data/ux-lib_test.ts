import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  coverageHints,
  initials,
  journeyToMarkdown,
  journeyToSvg,
  moveItem,
  personaCompleteness,
  personaMatches,
  personaToMarkdown,
  stageScore,
  wrapText,
} from './ux-lib.ts'
import { SEED_ADRS, SEED_JOURNEYS, SEED_PERSONAS } from './seed.ts'
import { DEFAULT_TOKENS } from './tokens-seed.ts'
import type { Journey, Persona } from './types.ts'

const persona: Persona = {
  id: 'p1',
  name: 'Priya Sharma — Platform engineer',
  avatar: '',
  role: 'Platform engineer',
  bio: 'Owns the platform.',
  goals: ['Ship faster'],
  frustrations: ['Flaky CI'],
  behaviors: [],
  needs: [],
  tech: ['Kubernetes'],
  quote: 'Make the paved road the easy road.',
  tags: ['internal'],
}

Deno.test('initials', () => {
  assertEquals(initials('Priya Sharma — Platform engineer'), 'PS')
  assertEquals(initials('Priya'), 'P')
  assertEquals(initials('  '), '?')
  assertEquals(initials('rahul k. mehta'), 'RM')
})

Deno.test('persona search covers every field, all words must match', () => {
  assert(personaMatches(persona, 'flaky'))
  assert(personaMatches(persona, 'paved INTERNAL'))
  assert(!personaMatches(persona, 'paved designer'))
  assert(personaMatches(persona, ''))
})

Deno.test('persona completeness and markdown', () => {
  assertEquals(personaCompleteness(persona), 5 / 8)
  const j: Journey = { id: 'j', name: 'Onboarding', persona: 'p1', summary: '', stages: [] }
  const md = personaToMarkdown(persona, [j])
  assert(md.startsWith('## Priya Sharma'))
  assert(md.includes('> “Make the paved road the easy road.”'))
  assert(md.includes('### Goals\n\n- Ship faster'))
  assert(md.includes('### Journeys\n\n- Onboarding'))
  assert(!md.includes('### Needs'))
})

Deno.test('stage score prefers the explicit score, clamped', () => {
  const s = { id: 's', name: 'x', emotion: 'excited' as const, actions: [], thoughts: [], pains: [], opportunities: [] }
  assertEquals(stageScore(s), 2)
  assertEquals(stageScore({ ...s, score: -1 }), -1)
  assertEquals(stageScore({ ...s, score: 9 }), 2)
})

Deno.test('moveItem', () => {
  assertEquals(moveItem([1, 2, 3, 4], 0, 2), [2, 3, 1, 4])
  assertEquals(moveItem([1, 2, 3], 2, 0), [3, 1, 2])
  assertEquals(moveItem([1, 2, 3], 1, 9), [1, 3, 2])
  const same = [1, 2]
  assertEquals(moveItem(same, 5, 0), same)
})

Deno.test('wrapText wraps on words and splits long words', () => {
  assertEquals(wrapText('one two three four', 9), ['one two', 'three', 'four'])
  assert(wrapText('a'.repeat(25), 10).every((l) => l.length <= 10))
})

Deno.test('journey markdown + svg export', () => {
  const j = SEED_JOURNEYS[0]
  const p = SEED_PERSONAS.find((x) => x.id === j.persona)
  const md = journeyToMarkdown(j, p)
  assert(md.startsWith(`# ${j.name}`))
  for (const s of j.stages) assert(md.includes(`. ${s.name}`))
  const { svg, width, height } = journeyToSvg({ ...j, name: 'A <b> & "c"' }, p)
  assert(svg.startsWith('<svg'))
  assert(svg.includes('A &lt;b&gt; &amp; &quot;c&quot;'))
  assert(width > 0 && height > 0)
})

Deno.test('coverage hints come only from real gaps', () => {
  const now = new Date('2026-10-17T00:00:00Z')
  const orphan: Journey = { id: 'j2', name: 'Orphan', persona: 'missing', summary: '', stages: [] }
  const hints = coverageHints({
    personas: SEED_PERSONAS,
    journeys: [...SEED_JOURNEYS, orphan],
    adrs: [{ ...SEED_ADRS[0], status: 'proposed', updated_at: '2026-09-01T00:00:00Z' }],
    tokens: DEFAULT_TOKENS,
    now,
  })
  assert(hints.some((h) => h.id === 'journey-no-persona-j2'))
  assert(hints.some((h) => h.id.startsWith('adr-stale-')))
  // Defaults pass AA in both modes.
  assert(!hints.some((h) => h.section === 'tokens'))
  // Warnings sort first.
  const firstInfo = hints.findIndex((h) => h.tone === 'info')
  assert(firstInfo === -1 || hints.slice(firstInfo).every((h) => h.tone === 'info'))

  const bad = { ...DEFAULT_TOKENS, color: DEFAULT_TOKENS.color.map((c) => c.name.endsWith('-text') ? { ...c, value: '#cccccc' } : c) }
  const h2 = coverageHints({ personas: [], journeys: [], adrs: [], tokens: bad, now })
  assertEquals(h2.map((h) => h.id), ['tokens-contrast-light'])
})
