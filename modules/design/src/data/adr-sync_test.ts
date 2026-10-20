import { assert, assertEquals } from 'jsr:@std/assert@1'
import { type AdrDoc, type AdrReview, adrToMarkdown } from './adr.ts'
import {
  addReviewEntry,
  closeReview,
  defaultAction,
  fieldsFromParsed,
  inReview,
  isAdrFile,
  planAdrSync,
  summarizeReview,
} from './adr-sync.ts'

const T0 = '2026-10-01T10:00:00.000Z'
const T1 = '2026-10-05T10:00:00.000Z'

function adr(n: number, patch: Partial<AdrDoc> = {}): AdrDoc {
  return {
    id: `adr-${n}`,
    number: n,
    title: `Decision ${n}`,
    status: 'accepted',
    authors: ['ana'],
    updated_at: T0,
    repo: '',
    context: `Context ${n}`,
    decision: `Decide ${n}`,
    consequences: '',
    tags: [],
    date: '2026-10-01',
    ...patch,
  }
}

Deno.test('recognises ADR files and ignores the index and templates', () => {
  assert(isAdrFile('docs/adr/0007-adopt-tekton.md'))
  assert(isAdrFile('12-x.markdown'))
  assert(!isAdrFile('docs/adr/README.md'))
  assert(!isAdrFile('docs/adr/0000-template.md'))
  assert(!isAdrFile('docs/adr/notes.md'))
})

Deno.test('plans every sync state', () => {
  const synced = adr(1, { git: { repo: 'r', branch: 'main', path: 'docs/adr/0001-decision-1.md', blob: 'b1', at: T0 } })
  const editedHere = adr(2, { updated_at: T1, context: 'changed here', git: { repo: 'r', branch: 'main', path: 'docs/adr/0002-decision-2.md', blob: 'b2', at: T0 } })
  const repoMoved = adr(3, { git: { repo: 'r', branch: 'main', path: 'docs/adr/0003-decision-3.md', blob: 'old', at: T0 } })
  const bothMoved = adr(4, { updated_at: T1, context: 'x', git: { repo: 'r', branch: 'main', path: 'docs/adr/0004-decision-4.md', blob: 'old', at: T0 } })
  const neverSynced = adr(5, { context: 'local text' })
  const onlyHere = adr(6)
  const local = [synced, editedHere, repoMoved, bothMoved, neverSynced, onlyHere]
  const files = [
    { path: 'docs/adr/0001-decision-1.md', text: adrToMarkdown(synced), sha: 'b1' },
    { path: 'docs/adr/0002-decision-2.md', text: adrToMarkdown(adr(2)), sha: 'b2' },
    { path: 'docs/adr/0003-decision-3.md', text: adrToMarkdown(adr(3, { context: 'edited in repo' })), sha: 'new' },
    { path: 'docs/adr/0004-decision-4.md', text: adrToMarkdown(adr(4, { context: 'y' })), sha: 'new' },
    { path: 'docs/adr/0005-other-name.md', text: adrToMarkdown(adr(5, { context: 'repo text' })), sha: 'b5' },
    { path: 'docs/adr/0009-from-repo.md', text: '# 9. From the repo\n\n## Status\n\nProposed\n\n## Context\n\nWhy\n', sha: 'b9' },
    { path: 'docs/adr/README.md', text: '# index', sha: 'rd' },
  ]
  const rows = planAdrSync(local, files, { repo: 'r' })
  const stateOf = (n: number) => rows.find((r) => (r.adr?.number ?? r.parsed?.number) === n)?.state
  assertEquals(stateOf(1), 'in-sync')
  assertEquals(stateOf(2), 'local-ahead')
  assertEquals(stateOf(3), 'repo-ahead')
  assertEquals(stateOf(4), 'conflict')
  assertEquals(stateOf(5), 'differs')
  assertEquals(stateOf(6), 'local-only')
  assertEquals(stateOf(9), 'new-in-repo')
  assertEquals(rows.length, 7, 'README is not a decision')
  assertEquals(rows[0].state, 'conflict', 'conflicts sort first')
  assertEquals(defaultAction('repo-ahead'), 'import')
  assertEquals(defaultAction('local-only'), 'export')
  assertEquals(defaultAction('conflict'), 'none')
})

Deno.test('imports map MADR sections onto the decision', () => {
  const rows = planAdrSync([], [{ path: 'docs/adr/0009-x.md', text: '# 9. From the repo\n\n## Status\n\nProposed\n\n## Context\n\nWhy\n\n## Decision\n\nThis\n' }], { repo: 'r' })
  const f = fieldsFromParsed(rows[0].parsed!)
  assertEquals(f.title, 'From the repo')
  assertEquals(f.number, 9)
  assertEquals(f.status, 'proposed')
  assertEquals(f.context, 'Why')
  assertEquals(f.decision, 'This')
})

Deno.test('review summary tracks the latest verdict per reviewer', () => {
  let review: AdrReview = {
    requestedAt: T0,
    requestedBy: 'ana',
    reviewers: [{ id: 'u1', name: 'Bo' }, { id: 'u2', name: 'Cy' }],
    entries: [],
  }
  let s = summarizeReview(review)!
  assertEquals(s.pending.map((r) => r.name), ['Bo', 'Cy'])
  assert(!s.approvedByAll)
  review = addReviewEntry(review, { at: T0, by: 'Bo', byId: 'u1', verdict: 'changes', comment: 'tighten scope' })
  review = addReviewEntry(review, { at: T0, by: 'Cy', byId: 'u2', verdict: 'comment', comment: 'fyi' })
  s = summarizeReview(review)!
  assertEquals(s.changes, 1)
  assertEquals(s.pending.map((r) => r.name), ['Cy'], 'a comment is not a verdict')
  review = addReviewEntry(review, { at: T1, by: 'Bo', byId: 'u1', verdict: 'approve' })
  review = addReviewEntry(review, { at: T1, by: 'Cy', byId: 'u2', verdict: 'approve' })
  s = summarizeReview(review)!
  assertEquals(s.approvals, 2)
  assertEquals(s.changes, 0)
  assert(s.approvedByAll)
  const closed = closeReview(review, 'accepted', T1)!
  assertEquals(closed.outcome, 'accepted')
  assert(!summarizeReview(closed)!.open)
  assert(inReview({ status: 'proposed', review }))
  assert(!inReview({ status: 'proposed', review: closed }))
  assertEquals(summarizeReview(undefined), null)
})
