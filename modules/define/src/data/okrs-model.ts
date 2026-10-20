/**
 * OKR model + math (pure; tested in `okrs-model_test.ts`).
 *
 * Objectives live in the console's document store (Plane has no goals API).
 * They form an alignment tree — company → team → individual — through
 * `parentId`. Each objective owns key results of three kinds:
 *
 *   metric      a number moving from `start` to `target` (either direction)
 *   percentage  the same, on a 0–100 % scale
 *   milestone   a checklist; progress = share of milestones done
 *
 * A key result can be linked to Plane work (epics/modules, cycles, single
 * issues). With `auto` on, its progress is the linked work's completion,
 * recomputed from live Plane data every time it's shown.
 *
 * Check-ins record a value, a confidence (0–10) and a note; the objective's
 * history chart is drawn from them. Scores follow the Google convention:
 * 0.0–1.0, ≥ 0.7 is a hit, 0.4–0.69 progress, < 0.4 a miss.
 */

export type OkrLevel = 'company' | 'team' | 'individual'
export type KrType = 'metric' | 'percentage' | 'milestone'
export type OkrStatus = 'on-track' | 'at-risk' | 'off-track'

export interface KrLink {
  kind: 'module' | 'cycle' | 'issue'
  project: string
  id: string
  label: string
}

export interface CheckIn {
  id: string
  at: string
  by?: string
  /** The KR's value at check-in (metric / percentage) — milestone KRs store progress. */
  value: number
  /** Progress 0–100 at the moment of the check-in (drives the history chart). */
  progress: number
  /** 0–10. */
  confidence: number
  note?: string
}

export interface Milestone {
  id: string
  title: string
  done: boolean
}

export interface KeyResult {
  id: string
  title: string
  type?: KrType
  unit: string
  start: number
  target: number
  current: number
  ownerId?: string
  /** Relative weight in the objective's roll-up (default 1). */
  weight?: number
  milestones?: Milestone[]
  links?: KrLink[]
  /** Progress follows the linked Plane work. */
  auto?: boolean
  checkIns?: CheckIn[]
}

export interface Objective {
  id: string
  /** Plane project id; empty for company-level objectives. */
  project: string
  level?: OkrLevel
  /** Console team name for team-level objectives. */
  team?: string
  /** Objective this one aligns to. */
  parentId?: string
  title: string
  description?: string
  ownerId: string
  quarter: string
  key_results: KeyResult[]
  /** Final grade 0–1 set when the quarter closes; otherwise derived. */
  score?: number
  created_at: string
  updated_at: string
}

/** Completion of linked Plane work: done / in-scope, per link. */
export type LinkResolver = (link: KrLink) => { done: number; total: number } | undefined

/* ───── key results ───── */

const clamp = (v: number) => Math.max(0, Math.min(100, v))

/** Linked-work completion 0–100, or undefined when nothing resolves. */
export function linkedProgress(links: KrLink[] | undefined, resolve?: LinkResolver): number | undefined {
  if (!links?.length || !resolve) return undefined
  let done = 0
  let total = 0
  let any = false
  for (const l of links) {
    const r = resolve(l)
    if (!r) continue
    any = true
    done += r.done
    total += r.total
  }
  if (!any) return undefined
  return total > 0 ? Math.round((done / total) * 100) : 0
}

export function krProgress(kr: KeyResult, resolve?: LinkResolver): number {
  if (kr.auto) {
    const p = linkedProgress(kr.links, resolve)
    if (p !== undefined) return p
  }
  if ((kr.type ?? 'metric') === 'milestone') {
    const ms = kr.milestones ?? []
    return ms.length ? Math.round((ms.filter((m) => m.done).length / ms.length) * 100) : 0
  }
  const span = kr.target - kr.start
  if (span === 0) return kr.current >= kr.target ? 100 : 0
  return clamp(Math.round(((kr.current - kr.start) / span) * 100))
}

export function krConfidence(kr: KeyResult): number | undefined {
  const last = latestCheckIn(kr)
  return last?.confidence
}

export function latestCheckIn(kr: KeyResult): CheckIn | undefined {
  const cs = kr.checkIns ?? []
  return cs.length ? [...cs].sort((a, b) => a.at.localeCompare(b.at))[cs.length - 1] : undefined
}

/* ───── objectives + alignment ───── */

/**
 * Objective progress: weighted mean of its key results; an objective with no
 * key results of its own rolls up the mean of the objectives aligned to it.
 */
export function objectiveProgress(o: Objective, all: Objective[] = [], resolve?: LinkResolver, seen = new Set<string>()): number {
  if (seen.has(o.id)) return 0
  seen.add(o.id)
  if (o.key_results.length) {
    let w = 0
    let sum = 0
    for (const kr of o.key_results) {
      const wt = kr.weight && kr.weight > 0 ? kr.weight : 1
      w += wt
      sum += wt * krProgress(kr, resolve)
    }
    return Math.round(sum / w)
  }
  const kids = all.filter((c) => c.parentId === o.id)
  if (!kids.length) return 0
  return Math.round(kids.reduce((a, c) => a + objectiveProgress(c, all, resolve, new Set(seen)), 0) / kids.length)
}

export function objectiveConfidence(o: Objective): number | undefined {
  const cs = o.key_results.map(krConfidence).filter((c): c is number => c !== undefined)
  return cs.length ? Math.round((cs.reduce((a, b) => a + b, 0) / cs.length) * 10) / 10 : undefined
}

/** Google-style grade 0.0–1.0 (one decimal). */
export function objectiveScore(o: Objective, progress: number): number {
  if (typeof o.score === 'number') return Math.max(0, Math.min(1, o.score))
  return Math.round(progress / 10) / 10
}

export function scoreBand(score: number): 'hit' | 'progress' | 'miss' {
  return score >= 0.7 ? 'hit' : score >= 0.4 ? 'progress' : 'miss'
}

export interface OkrNode {
  objective: Objective
  children: OkrNode[]
  depth: number
}

const LEVEL_ORDER: Record<OkrLevel, number> = { company: 0, team: 1, individual: 2 }

/** Alignment tree; objectives whose parent is missing (or cyclic) become roots. */
export function alignmentTree(objectives: Objective[]): OkrNode[] {
  const byId = new Map(objectives.map((o) => [o.id, o]))
  const childrenOf = new Map<string, Objective[]>()
  const roots: Objective[] = []
  for (const o of objectives) {
    if (o.parentId && byId.has(o.parentId) && !createsCycle(o, byId)) {
      const list = childrenOf.get(o.parentId) ?? []
      list.push(o)
      childrenOf.set(o.parentId, list)
    } else roots.push(o)
  }
  const sort = (xs: Objective[]) =>
    [...xs].sort((a, b) => LEVEL_ORDER[a.level ?? 'team'] - LEVEL_ORDER[b.level ?? 'team'] || a.title.localeCompare(b.title))
  const build = (o: Objective, depth: number): OkrNode => ({
    objective: o,
    depth,
    children: sort(childrenOf.get(o.id) ?? []).map((c) => build(c, depth + 1)),
  })
  return sort(roots).map((o) => build(o, 0))
}

function createsCycle(o: Objective, byId: Map<string, Objective>): boolean {
  const seen = new Set([o.id])
  let cur = o.parentId ? byId.get(o.parentId) : undefined
  while (cur) {
    if (seen.has(cur.id)) return true
    seen.add(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return false
}

/** Objectives `o` may align to: not itself, not its descendants. */
export function alignableParents(o: Pick<Objective, 'id'> | null, all: Objective[]): Objective[] {
  if (!o) return all
  const banned = new Set([o.id])
  let grew = true
  while (grew) {
    grew = false
    for (const x of all) {
      if (x.parentId && banned.has(x.parentId) && !banned.has(x.id)) {
        banned.add(x.id)
        grew = true
      }
    }
  }
  return all.filter((x) => !banned.has(x.id))
}

/* ───── quarters + pace ───── */

export function currentQuarter(d = new Date()): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
}

export function quarterRange(quarter: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter)
  if (!m) return null
  const year = Number(m[1])
  const startMonth = (Number(m[2]) - 1) * 3
  return { start: new Date(year, startMonth, 1), end: new Date(year, startMonth + 3, 1) }
}

export function shiftQuarter(quarter: string, by: number): string {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter)
  if (!m) return quarter
  const idx = Number(m[1]) * 4 + Number(m[2]) - 1 + by
  return `${Math.floor(idx / 4)}-Q${(idx % 4) + 1}`
}

export function quarterElapsed(quarter: string, now = Date.now()): number {
  const r = quarterRange(quarter)
  if (!r) return 0.5
  return Math.max(0, Math.min(1, (now - r.start.getTime()) / (r.end.getTime() - r.start.getTime())))
}

/** Pace-aware status: progress against the share of the quarter elapsed. */
export function paceStatus(progress: number, quarter: string, now = Date.now()): OkrStatus {
  const elapsed = quarterElapsed(quarter, now)
  const expected = elapsed >= 1 ? 100 : elapsed * 100
  const delta = progress - expected
  if (delta >= -10) return 'on-track'
  if (delta >= -25) return 'at-risk'
  return 'off-track'
}

/* ───── history ───── */

/**
 * Objective progress over time from its key results' check-ins: at each
 * check-in date, the weighted mean of every KR's latest recorded progress
 * (KRs not yet checked in count as 0).
 */
export function progressHistory(o: Objective): Array<[number, number]> {
  const events = o.key_results.flatMap((kr) => (kr.checkIns ?? []).map((c) => ({ kr: kr.id, t: Date.parse(c.at), p: c.progress })))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t)
  if (!events.length) return []
  const latest = new Map<string, number>()
  const weights = new Map(o.key_results.map((kr) => [kr.id, kr.weight && kr.weight > 0 ? kr.weight : 1]))
  const total = [...weights.values()].reduce((a, b) => a + b, 0) || 1
  const out: Array<[number, number]> = []
  for (const e of events) {
    latest.set(e.kr, e.p)
    let sum = 0
    for (const [id, w] of weights) sum += w * (latest.get(id) ?? 0)
    const point: [number, number] = [e.t, Math.round(sum / total)]
    if (out.length && out[out.length - 1][0] === e.t) out[out.length - 1] = point
    else out.push(point)
  }
  return out
}

/** Upgrade a stored objective of the first OKR release (no level / type fields). */
export function upgradeObjective(o: Objective): Objective {
  return {
    ...o,
    level: o.level ?? (o.project ? 'team' : 'company'),
    key_results: o.key_results.map((kr) => ({ ...kr, type: kr.type ?? 'metric', checkIns: kr.checkIns ?? [], links: kr.links ?? [] })),
  }
}
