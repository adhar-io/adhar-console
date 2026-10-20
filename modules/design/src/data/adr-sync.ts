/**
 * ADR ↔ repository sync and the review round — pure logic, unit-tested in
 * `adr-sync_test.ts`.
 *
 * Sync compares the decisions in the document store with the MADR files in a
 * repository folder (`docs/adr/0007-adopt-tekton.md`). Each pair lands in one
 * state, so the UI can offer exactly the right action:
 *
 *   in-sync      — the file is what the console would write
 *   new-in-repo  — a file with no decision here → import
 *   local-only   — a decision with no file → export (PR)
 *   local-ahead  — the file is unchanged since the last sync, the decision was edited → export
 *   repo-ahead   — the file changed in the repo, the decision did not → import (update)
 *   conflict     — both changed since the last sync → the user picks
 *   differs      — they differ and there is no sync record to tell who moved
 */

import {
  type AdrDoc,
  type AdrReview,
  type AdrReviewEntry,
  type AdrReviewer,
  adrToMarkdown,
  markdownToAdr,
  type ParsedAdr,
} from './adr.ts'

export interface RemoteAdrFile {
  path: string
  text: string
  /** Blob sha as Gitea reports it. */
  sha?: string
}

export type SyncState = 'in-sync' | 'new-in-repo' | 'local-only' | 'local-ahead' | 'repo-ahead' | 'conflict' | 'differs'

export interface SyncRow {
  state: SyncState
  adr?: AdrDoc
  file?: RemoteAdrFile
  parsed?: ParsedAdr
}

/** `0007-adopt-tekton.md` (adr-tools / MADR naming); README and templates are not decisions. */
export function isAdrFile(path: string): boolean {
  const base = path.split('/').pop() ?? ''
  return /^\d{1,5}-[^/]+\.(md|markdown)$/i.test(base) && !/template/i.test(base)
}

/** Leading number of an ADR file name. */
export function numberFromPath(path: string): number | undefined {
  const m = /^(\d{1,5})-/.exec(path.split('/').pop() ?? '')
  return m ? Number(m[1]) : undefined
}

/** Whitespace-insensitive markdown comparison key. */
export function normalizeMd(s: string): string {
  return s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** A local edit within this window after a sync is the sync's own save. */
const SYNC_SLACK_MS = 2 * 60_000

function editedSinceSync(adr: AdrDoc): boolean {
  if (!adr.git?.at) return true
  const updated = Date.parse(adr.updated_at ?? '')
  const synced = Date.parse(adr.git.at)
  if (Number.isNaN(updated) || Number.isNaN(synced)) return true
  return updated > synced + SYNC_SLACK_MS
}

export function planAdrSync(
  local: readonly AdrDoc[],
  files: readonly RemoteAdrFile[],
  opts: { repo: string; lookup?: (id: string) => AdrDoc | undefined },
): SyncRow[] {
  const lookup = opts.lookup ?? ((id: string) => local.find((a) => a.id === id))
  const adrFiles = files.filter((f) => isAdrFile(f.path))
  const matched = new Set<string>()
  const rows: SyncRow[] = []
  for (const file of adrFiles) {
    const parsed = markdownToAdr(file.text)
    const num = parsed.number ?? numberFromPath(file.path)
    const adr = local.find((a) => !matched.has(a.id) && a.git?.repo === opts.repo && a.git.path === file.path) ??
      local.find((a) => !matched.has(a.id) && num !== undefined && a.number === num && (!a.git || a.git.repo !== opts.repo))
    if (!adr) {
      rows.push({ state: 'new-in-repo', file, parsed: { ...parsed, number: num } })
      continue
    }
    matched.add(adr.id)
    const same = normalizeMd(adrToMarkdown(adr, lookup)) === normalizeMd(file.text)
    let state: SyncState
    if (same) state = 'in-sync'
    else if (adr.git?.repo === opts.repo && adr.git.blob) {
      if (file.sha && adr.git.blob === file.sha) state = 'local-ahead'
      else state = editedSinceSync(adr) ? 'conflict' : 'repo-ahead'
    } else state = 'differs'
    rows.push({ state, adr, file, parsed: { ...parsed, number: num } })
  }
  for (const adr of local) if (!matched.has(adr.id)) rows.push({ state: 'local-only', adr })
  const order: Record<SyncState, number> = { conflict: 0, 'repo-ahead': 1, 'new-in-repo': 2, differs: 3, 'local-ahead': 4, 'local-only': 5, 'in-sync': 6 }
  return rows.sort((a, b) => order[a.state] - order[b.state] || (a.adr?.number ?? a.parsed?.number ?? 0) - (b.adr?.number ?? b.parsed?.number ?? 0))
}

/** Fields an import writes onto a decision from its file. */
export function fieldsFromParsed(p: ParsedAdr): Partial<AdrDoc> {
  const out: Partial<AdrDoc> = {}
  if (p.title) out.title = p.title
  if (p.number) out.number = p.number
  if (p.status) out.status = p.status
  if (p.date) out.date = p.date
  if (p.deciders?.length) out.deciders = p.deciders
  if (p.tags?.length) out.tags = p.tags
  out.context = p.context ?? ''
  out.decision = p.decision ?? ''
  out.consequences = p.consequences ?? ''
  if (p.drivers !== undefined) out.drivers = p.drivers
  if (p.options !== undefined) out.options = p.options
  if (p.notes !== undefined) out.notes = p.notes
  return out
}

export const SYNC_LABEL: Record<SyncState, string> = {
  'in-sync': 'In sync',
  'new-in-repo': 'Only in repo',
  'local-only': 'Only here',
  'local-ahead': 'Changed here',
  'repo-ahead': 'Changed in repo',
  conflict: 'Changed in both',
  differs: 'Differs',
}

/** What a row's default action is — `import` pulls the file, `export` writes it. */
export function defaultAction(state: SyncState): 'import' | 'export' | 'none' {
  if (state === 'new-in-repo' || state === 'repo-ahead') return 'import'
  if (state === 'local-only' || state === 'local-ahead') return 'export'
  return 'none'
}

/* ───────────────────────── review ───────────────────────── */

export interface ReviewSummary {
  open: boolean
  approvals: number
  changes: number
  rejects: number
  /** Reviewers who have not given a verdict yet. */
  pending: AdrReviewer[]
  approvedByAll: boolean
  /** Latest verdict per reviewer (comments do not count as a verdict). */
  verdicts: Map<string, AdrReviewEntry>
}

function reviewerKey(r: { id?: string; byId?: string; name?: string; by?: string }): string {
  return (r.id ?? r.byId ?? r.name ?? r.by ?? '').toLowerCase()
}

export function summarizeReview(review: AdrReview | undefined): ReviewSummary | null {
  if (!review) return null
  const verdicts = new Map<string, AdrReviewEntry>()
  // entries are newest-first; the first verdict seen per reviewer wins.
  for (const e of review.entries) {
    if (e.verdict === 'comment') continue
    const k = reviewerKey(e)
    if (!verdicts.has(k)) verdicts.set(k, e)
    const byName = (e.by ?? '').toLowerCase()
    if (byName && !verdicts.has(byName)) verdicts.set(byName, e)
  }
  const verdictOf = (r: AdrReviewer) => verdicts.get(reviewerKey(r)) ?? verdicts.get(r.name.toLowerCase())
  const pending = review.reviewers.filter((r) => !verdictOf(r))
  const latest = review.reviewers.map(verdictOf).filter(Boolean) as AdrReviewEntry[]
  const approvals = latest.filter((e) => e.verdict === 'approve').length
  return {
    open: !review.closedAt,
    approvals,
    changes: latest.filter((e) => e.verdict === 'changes').length,
    rejects: latest.filter((e) => e.verdict === 'reject').length,
    pending,
    approvedByAll: review.reviewers.length > 0 && approvals === review.reviewers.length,
    verdicts,
  }
}

/** Add a review entry (newest first). */
export function addReviewEntry(review: AdrReview, entry: AdrReviewEntry, cap = 100): AdrReview {
  return { ...review, entries: [entry, ...review.entries].slice(0, cap) }
}

/** Close the round with the decision's outcome. */
export function closeReview(review: AdrReview | undefined, outcome: 'accepted' | 'rejected', at: string): AdrReview | undefined {
  return review && !review.closedAt ? { ...review, closedAt: at, outcome } : review
}

/** True when a decision is in an open review round. */
export function inReview(adr: Pick<AdrDoc, 'status' | 'review'>): boolean {
  return adr.status === 'proposed' && !!adr.review && !adr.review.closedAt
}
