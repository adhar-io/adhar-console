import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  adrFileName,
  adrIndexMarkdown,
  type AdrDoc,
  adrToMarkdown,
  backlinks,
  filterAdrs,
  formatAdrNumber,
  markdownToAdr,
  nextAdrNumber,
  supersede,
} from './adr.ts'

const base = (over: Partial<AdrDoc> = {}): AdrDoc => ({
  id: 'a1',
  number: 7,
  title: 'Adopt Tekton for CI',
  status: 'accepted',
  authors: ['tapas'],
  updated_at: '2026-10-01T10:00:00Z',
  repo: 'adhar/docs',
  context: 'We need CI on-cluster.',
  decision: 'Use **Tekton**.',
  consequences: '- Good: native\n- Bad: verbose',
  tags: ['ci', 'platform'],
  ...over,
})

Deno.test('numbering and file names', () => {
  assertEquals(formatAdrNumber(7), 'ADR-0007')
  assertEquals(nextAdrNumber([{ number: 3 }, { number: 11 }]), 12)
  assertEquals(nextAdrNumber([]), 1)
  assertEquals(adrFileName(base()), '0007-adopt-tekton-for-ci.md')
  assertEquals(adrFileName(base({ title: 'Use Café/ÜML!!' })), '0007-use-cafeuml.md')
})

Deno.test('markdown round-trip keeps sections, status and tags', () => {
  const md = adrToMarkdown(base({ drivers: '- speed', options: '1. Tekton\n2. Jenkins', deciders: ['tapas', 'Maya R'] }))
  assert(md.startsWith('---\nstatus: accepted\n'))
  assert(md.includes('deciders: [tapas, "Maya R"]'))
  assert(md.includes('# ADR-0007: Adopt Tekton for CI'))
  assert(md.includes('### Consequences'))
  const back = markdownToAdr(md)
  assertEquals(back.number, 7)
  assertEquals(back.title, 'Adopt Tekton for CI')
  assertEquals(back.status, 'accepted')
  assertEquals(back.tags, ['ci', 'platform'])
  assertEquals(back.deciders, ['tapas', 'Maya R'])
  assertEquals(back.context, 'We need CI on-cluster.')
  assertEquals(back.drivers, '- speed')
  assertEquals(back.options, '1. Tekton\n2. Jenkins')
  assertEquals(back.decision, 'Use **Tekton**.')
  assertEquals(back.consequences, '- Good: native\n- Bad: verbose')
})

Deno.test('imports Nygard-style markdown', () => {
  const p = markdownToAdr(`# 3. Record architecture decisions

## Status

Accepted

## Context

We need to record decisions.

## Decision

We will use ADRs.

## Consequences

See Nygard.
`)
  assertEquals(p.number, 3)
  assertEquals(p.title, 'Record architecture decisions')
  assertEquals(p.status, 'accepted')
  assertEquals(p.decision, 'We will use ADRs.')
})

Deno.test('links render with numbers and titles', () => {
  const a = base()
  const b = base({ id: 'b2', number: 9, title: 'Move to Argo Workflows', supersedes: ['a1'] })
  const md = adrToMarkdown(b, (id) => (id === 'a1' ? a : undefined))
  assert(md.includes('Supersedes [ADR-0007 Adopt Tekton for CI](0007-adopt-tekton-for-ci.md)'))
})

Deno.test('supersede updates both sides and history', () => {
  const [o, n] = supersede(base(), base({ id: 'b2', number: 9, status: 'proposed' }), 'maya', '2026-10-02T00:00:00Z')
  assertEquals(o.status, 'superseded')
  assertEquals(o.supersededBy, 'b2')
  assertEquals(n.supersedes, ['a1'])
  assertEquals(o.history?.[0].action, 'Superseded')
  assertEquals(n.history?.[0].detail, 'ADR-0007')
  assertEquals(backlinks([o, n], 'a1').map((x) => x.id), ['b2'])
})

Deno.test('filter by status, tag and multi-term search', () => {
  const list = [base(), base({ id: 'x', number: 8, title: 'Use Postgres', status: 'proposed', tags: ['data'], decision: 'Postgres', consequences: 'ok' })]
  assertEquals(filterAdrs(list, { status: 'proposed' }).map((a) => a.id), ['x'])
  assertEquals(filterAdrs(list, { tag: 'ci' }).map((a) => a.id), ['a1'])
  assertEquals(filterAdrs(list, { q: 'tekton native' }).map((a) => a.id), ['a1'])
  assertEquals(filterAdrs(list, { q: 'adr-0008' }).map((a) => a.id), ['x'])
})

Deno.test('index lists ADRs in number order', () => {
  const md = adrIndexMarkdown([base({ number: 9, id: 'z' }), base()])
  assert(md.indexOf('ADR-0007') < md.indexOf('ADR-0009'))
})
