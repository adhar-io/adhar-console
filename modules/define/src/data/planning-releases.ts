/**
 * Releases (versions) — a console-side concept: Plane has no versions, so a
 * release is a document in the console's store (`define.release`) that names
 * a project, dates, a status and the Plane work items it ships ("fix
 * version" links by Plane id). Progress, burndown and notes are derived from
 * those work items' live Plane state.
 */

import { DAY_MS, dayKey, doneBy, eachDay, isCancelled, isDone, toMs, type WorkItem } from './planning-model.ts'

export type ReleaseStatus = 'unreleased' | 'released' | 'archived'

export interface Release {
  id: string
  project: string
  name: string
  description?: string
  start_date?: string | null
  release_date?: string | null
  status: ReleaseStatus
  /** Plane work item ids in this release. */
  issues: string[]
  /** Epics (Plane module ids) whose items ship in this release. */
  epics?: string[]
  released_at?: string | null
  /** Optional deployment link: a Deliver release / Kargo freight. */
  deliver?: { app?: string; stage?: string; freight?: string; url?: string }
  /** Notes as last published (markdown), when someone saved them. */
  notes?: string
}

export interface ReleaseProgress {
  total: number
  done: number
  open: number
  cancelled: number
  pct: number
}

export function releaseProgress(r: Pick<Release, 'issues'>, items: Map<string, WorkItem>): ReleaseProgress {
  let done = 0
  let open = 0
  let cancelled = 0
  for (const id of r.issues) {
    const i = items.get(id)
    if (!i) continue
    if (isCancelled(i)) cancelled++
    else if (isDone(i)) done++
    else open++
  }
  const total = done + open
  return { total, done, open, cancelled, pct: total ? Math.round((done / total) * 100) : 0 }
}

export type ReleaseHealth = 'released' | 'archived' | 'overdue' | 'due-soon' | 'on-schedule' | 'unscheduled'

export function releaseHealth(r: Pick<Release, 'status' | 'release_date'>, progress: ReleaseProgress, now = Date.now()): ReleaseHealth {
  if (r.status === 'released') return 'released'
  if (r.status === 'archived') return 'archived'
  const due = toMs(r.release_date)
  if (due === undefined) return 'unscheduled'
  if (due + DAY_MS <= now) return 'overdue'
  if (due - now < 7 * DAY_MS && progress.open > 0) return 'due-soon'
  return 'on-schedule'
}

/** Remaining open items per day from the release start to its date (or today). */
export function releaseBurndown(r: Release, items: Map<string, WorkItem>, now = Date.now()): { days: number[]; remaining: Array<number | null>; ideal: number[] } | null {
  const scoped = r.issues.map((id) => items.get(id)).filter((i): i is WorkItem => !!i && !isCancelled(i))
  const firstCreated = Math.min(...scoped.map((i) => toMs(i.created_at) ?? Infinity))
  const start = toMs(r.start_date) ?? (Number.isFinite(firstCreated) ? firstCreated : undefined)
  const end = toMs(r.release_date) ?? now
  if (start === undefined || end < start) return null
  const days = eachDay(start, end)
  const total = scoped.length
  const remaining = days.map((d) => (d > now ? null : scoped.filter((i) => !doneBy(i, d + DAY_MS - 1)).length))
  const n = Math.max(1, days.length - 1)
  return { days, remaining, ideal: days.map((_, k) => Math.round((total - (total * k) / n) * 10) / 10) }
}

export type NoteItem = WorkItem & { name: string; sequence_id?: number }

export interface NotesInput {
  release: Release
  items: Map<string, NoteItem>
  labelName(id: string): string
  identifier: string
  epicName?(id: string): string
  /** `YYYY-MM-DD` for the heading; defaults to the release date or today. */
  date?: string
}

const FEATURE = /\b(feature|enhancement|improvement|story)\b/i
const BUG = /\b(bug|defect|fix|regression|incident)\b/i

/**
 * Markdown release notes from the release's completed work items, grouped
 * into features, fixes and other changes by label; open items are listed
 * separately so the notes never claim unshipped work.
 */
export function releaseNotes(input: NotesInput): string {
  const { release, items, identifier } = input
  const rows = release.issues.map((id) => items.get(id)).filter((i): i is NoteItem => !!i)
  const key = (i: { sequence_id?: number }) => (i.sequence_id ? `${identifier}-${i.sequence_id}` : identifier)
  const line = (i: { name: string; sequence_id?: number }) => `- ${i.name} (${key(i)})`
  const done = rows.filter((i) => isDone(i))
  const open = rows.filter((i) => !isDone(i) && !isCancelled(i))
  const labelsOf = (i: WorkItem) => (i.labels ?? []).map(input.labelName).join(' ')
  const features = done.filter((i) => FEATURE.test(labelsOf(i)))
  const fixes = done.filter((i) => !features.includes(i) && BUG.test(labelsOf(i)))
  const other = done.filter((i) => !features.includes(i) && !fixes.includes(i))
  const date = input.date ?? (release.release_date ? dayKey(release.release_date) : dayKey(Date.now()))
  const out: string[] = [`# ${release.name}`, '', `_${date}_`]
  if (release.description?.trim()) out.push('', release.description.trim())
  if (release.epics?.length && input.epicName) {
    out.push('', `Epics: ${release.epics.map(input.epicName).join(', ')}`)
  }
  const section = (title: string, list: NoteItem[]) => {
    if (!list.length) return
    out.push('', `## ${title}`, '', ...list.map(line))
  }
  section('New features', features)
  section('Bug fixes', fixes)
  section('Other changes', other)
  if (!done.length) out.push('', 'No completed work items yet.')
  if (open.length) {
    out.push('', '## Not yet done', '', ...open.map(line))
  }
  return out.join('\n') + '\n'
}
