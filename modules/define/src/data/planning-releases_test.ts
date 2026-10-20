import { assert, assertEquals } from 'jsr:@std/assert@1'
import { type NoteItem, type Release, releaseBurndown, releaseHealth, releaseNotes, releaseProgress } from './planning-releases.ts'

const it = (id: string, name: string, seq: number, o: Partial<NoteItem> = {}): NoteItem => ({ id, name, sequence_id: seq, created_at: '2026-10-01T00:00:00Z', assignees: [], state_group: 'unstarted', ...o })
const items = new Map<string, NoteItem>([
  ['a', it('a', 'Team switcher', 1, { state_group: 'completed', completed_at: '2026-10-03T10:00:00Z', labels: ['l-feat'] })],
  ['b', it('b', 'Crash on empty board', 2, { state_group: 'completed', completed_at: '2026-10-04T10:00:00Z', labels: ['l-bug'] })],
  ['c', it('c', 'Bump deps', 3, { state_group: 'completed', completed_at: '2026-10-05T10:00:00Z' })],
  ['d', it('d', 'Audit export', 4)],
  ['e', it('e', 'Dropped idea', 5, { state_group: 'cancelled' })],
])
const rel: Release = { id: 'r1', project: 'p', name: 'v1.2.0', status: 'unreleased', start_date: '2026-10-01', release_date: '2026-10-06', issues: ['a', 'b', 'c', 'd', 'e', 'missing'] }

Deno.test('release progress ignores cancelled and unknown items', () => {
  assertEquals(releaseProgress(rel, items), { total: 4, done: 3, open: 1, cancelled: 1, pct: 75 })
})

Deno.test('release health: overdue, due soon, released', () => {
  const p = releaseProgress(rel, items)
  assertEquals(releaseHealth(rel, p, Date.parse('2026-10-08T00:00:00Z')), 'overdue')
  assertEquals(releaseHealth(rel, p, Date.parse('2026-10-02T00:00:00Z')), 'due-soon')
  assertEquals(releaseHealth({ ...rel, status: 'released' }, p), 'released')
  assertEquals(releaseHealth({ ...rel, release_date: null }, p), 'unscheduled')
})

Deno.test('release burndown counts open items per day up to today', () => {
  const b = releaseBurndown(rel, items, Date.parse('2026-10-04T12:00:00Z'))!
  assertEquals(b.remaining, [4, 4, 3, 2, null, null])
  assertEquals(b.ideal[0], 4)
  assertEquals(b.ideal[b.ideal.length - 1], 0)
})

Deno.test('release notes group shipped work by label and list open items separately', () => {
  const md = releaseNotes({ release: rel, items, identifier: 'CON', labelName: (id) => (id === 'l-feat' ? 'Feature' : id === 'l-bug' ? 'Bug' : id) })
  assertEquals(
    md,
    [
      '# v1.2.0',
      '',
      '_2026-10-06_',
      '',
      '## New features',
      '',
      '- Team switcher (CON-1)',
      '',
      '## Bug fixes',
      '',
      '- Crash on empty board (CON-2)',
      '',
      '## Other changes',
      '',
      '- Bump deps (CON-3)',
      '',
      '## Not yet done',
      '',
      '- Audit export (CON-4)',
      '',
    ].join('\n'),
  )
  assert(!md.includes('Dropped idea'))
})
