/**
 * Design coverage of a project's catalog applications (pure, tested).
 *
 * For every platform Application in scope: which journeys have a stage served
 * by it, which personas those journeys are for, which wireframes are for it,
 * whether the Visual Designer opened pull requests on its repository, and
 * which token set it is on (published to its repo, a project override, or the
 * workspace set). Derived only from links people made — nothing inferred.
 */

import { repoFromUrl } from './designer-catalog.ts'
import type { Journey, Persona, TokenPublishRecord, Wireframe } from './types.ts'

export interface CoverageApp {
  name: string
  project?: string
  team?: string
  repoUrl: string
}

export type TokenCoverage = 'published' | 'project' | 'workspace'

export interface AppCoverage {
  app: CoverageApp
  /** `owner/name` (or just name) of the app's repository, when its URL parses. */
  repo?: string
  journeys: string[]
  personas: string[]
  wireframes: string[]
  /** Visual Designer pull requests on the app's repository (from wireframes). */
  designPrs: number
  tokens: TokenCoverage
  /** Dimensions covered out of 5 (personas, journeys, wireframes, designs, tokens beyond workspace). */
  score: number
}

const norm = (s: string) => s.toLowerCase()

function repoKey(url: string): string | undefined {
  const r = repoFromUrl(url)
  return r ? (r.owner ? `${r.owner}/${r.name}` : r.name).toLowerCase() : undefined
}

function sameRepo(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = norm(a)
  const y = norm(b)
  if (x === y) return true
  // One side may lack the owner.
  return x.split('/').pop() === y.split('/').pop() && (!x.includes('/') || !y.includes('/'))
}

export function appCoverage(input: {
  apps: CoverageApp[]
  personas: Persona[]
  journeys: Journey[]
  wireframes: Wireframe[]
  /** Projects that have their own token overrides. */
  tokenProjects: Set<string>
  /** Token publishes (workspace + project scopes). */
  publishes: TokenPublishRecord[]
}): AppCoverage[] {
  const personaIds = new Set(input.personas.map((p) => p.id))
  return input.apps.map((app) => {
    const name = norm(app.name)
    const repo = repoKey(app.repoUrl)
    const journeys = input.journeys.filter((j) => j.stages.some((s) => (s.components ?? []).some((c) => norm(c) === name)))
    const personas = [...new Set(journeys.map((j) => j.persona).filter((p) => personaIds.has(p)))]
    const wireframes = input.wireframes.filter((w) => w.component && (norm(w.component.name) === name || sameRepo(w.component.repo, repo)))
    const designPrs = input.wireframes.reduce((n, w) => n + (w.prs ?? []).filter((pr) => sameRepo(pr.repo, repo)).length, 0)
    const tokens: TokenCoverage = input.publishes.some((p) => sameRepo(p.repo, repo))
      ? 'published'
      : app.project && input.tokenProjects.has(app.project)
      ? 'project'
      : 'workspace'
    const score = [personas.length > 0, journeys.length > 0, wireframes.length > 0, designPrs > 0, tokens !== 'workspace'].filter(Boolean).length
    return { app, repo, journeys: journeys.map((j) => j.id), personas, wireframes: wireframes.map((w) => w.id), designPrs, tokens, score }
  }).sort((a, b) => a.score - b.score || a.app.name.localeCompare(b.app.name))
}

export interface CoverageSummary {
  apps: number
  withPersonas: number
  withJourneys: number
  withWireframes: number
  withDesigns: number
  withTokens: number
}

export function coverageSummary(rows: AppCoverage[]): CoverageSummary {
  return {
    apps: rows.length,
    withPersonas: rows.filter((r) => r.personas.length).length,
    withJourneys: rows.filter((r) => r.journeys.length).length,
    withWireframes: rows.filter((r) => r.wireframes.length).length,
    withDesigns: rows.filter((r) => r.designPrs).length,
    withTokens: rows.filter((r) => r.tokens !== 'workspace').length,
  }
}

export interface ActivityRow {
  user: string
  count: number
  last: string
  lastTitle: string
  lastKey: string
}

/** Edits per user in the window, newest-first by last edit (pure). */
export function activityByUser(
  rows: Array<{ key: string; title: string; ts?: string; by?: string | null }>,
  since: Date,
): ActivityRow[] {
  const by = new Map<string, ActivityRow>()
  for (const r of rows) {
    if (!r.ts || !r.by) continue
    if (Date.parse(r.ts) < since.getTime()) continue
    const cur = by.get(r.by)
    if (!cur) by.set(r.by, { user: r.by, count: 1, last: r.ts, lastTitle: r.title, lastKey: r.key })
    else {
      cur.count++
      if (r.ts > cur.last) Object.assign(cur, { last: r.ts, lastTitle: r.title, lastKey: r.key })
    }
  }
  return [...by.values()].sort((a, b) => b.last.localeCompare(a.last))
}
