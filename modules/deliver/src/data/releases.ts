import type { kargo } from '@adhar-console/api-clients'
import { orderStages } from './stage-order.ts'

/**
 * Turning Kargo freight into releases.
 *
 * The page listed nothing on a platform with freight promoted through two
 * stages, because it built a row per *image* — `for (const img of f.images)` —
 * and this platform's warehouse subscribes to a git repository. Freight with
 * commits and no images produced no rows at all, and the page said releases
 * appear once freight is promoted, which had already happened twice.
 *
 * A release is a piece of freight. What it carries — commits, images, charts,
 * or several at once — is its contents, not the condition of its existing.
 *
 * JSX-free so it can be unit-tested — the Deno test runner has no React.
 */

export type ContentKind = 'commit' | 'image' | 'chart'

export interface ReleaseContent {
  kind: ContentKind
  /** The identifying string: a short sha, a tag, a chart version. */
  title: string
  /** Where it came from — repository or registry. */
  source: string
  /** A commit subject, when there is one. */
  detail?: string
  author?: string
  branch?: string
}

export interface ReleaseStage {
  name: string
  /** Position in promotion order. */
  index: number
  /** This stage is holding this freight right now. */
  current: boolean
  /** Kargo verified the freight in this stage. */
  verified: boolean
  /** A human approved this freight for this stage. */
  approved: boolean
  promotedAt?: string
}

export interface Release {
  id: string
  /** First twelve characters, the way a commit is shortened. */
  short: string
  /** Kargo's generated two-word name, which is what people say out loud. */
  alias?: string
  project: string
  warehouse?: string
  created: string
  contents: ReleaseContent[]
  stages: ReleaseStage[]
  /** The furthest stage in promotion order that holds this freight. */
  furthest?: string
  /** It reached the end of the chain. */
  atEnd: boolean
  /** Nothing is holding it — built, never promoted. */
  unpromoted: boolean
  lastPromotedAt?: string
}

function short(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id
}

/** `http://host/adhar/environments` → `adhar/environments`. */
function repoName(url: string): string {
  const cleaned = (url ?? '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const parts = cleaned.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/').filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? url ?? '—'
  return parts.slice(-2).join('/')
}

export function readContents(f: kargo.Freight): ReleaseContent[] {
  const out: ReleaseContent[] = []
  for (const c of f.commits ?? []) {
    out.push({
      kind: 'commit',
      title: short(c.id ?? ''),
      source: repoName(c.repoURL ?? ''),
      // Only the subject line; a commit body in a list cell is noise.
      detail: c.message?.split('\n')[0],
      branch: c.branch,
    })
  }
  for (const i of f.images ?? []) {
    out.push({ kind: 'image', title: i.tag, source: repoName(i.repoURL ?? ''), detail: i.digest })
  }
  for (const c of f.charts ?? []) {
    out.push({
      kind: 'chart',
      title: c.version,
      source: c.name ? `${repoName(c.repoURL ?? '')}/${c.name}` : repoName(c.repoURL ?? ''),
    })
  }
  return out
}

export function buildReleases(
  freight: kargo.Freight[],
  stages: kargo.Stage[],
  promotions: kargo.Promotion[] = [],
): Release[] {
  const ordered = orderStages(stages)
  const position = new Map(ordered.map((s, i) => [s.name, i]))

  // The most recent successful promotion of each (freight, stage) pair, which
  // is when that stage actually took it.
  const promotedAt = new Map<string, string>()
  for (const p of promotions) {
    if (p.phase !== 'Succeeded') continue
    const key = `${p.freight}:${p.stage}`
    const at = p.finished ?? p.created
    const seen = promotedAt.get(key)
    if (!seen || (at && at > seen)) promotedAt.set(key, at)
  }

  const releases = freight.map((f) => {
    const stageRows: ReleaseStage[] = ordered.map((s, index) => ({
      name: s.name,
      index,
      current: s.currentFreight === f.id,
      verified: (f.verifiedIn ?? []).includes(s.name),
      approved: (f.approvedFor ?? []).includes(s.name),
      promotedAt: promotedAt.get(`${f.id}:${s.name}`),
    }))

    const holding = stageRows.filter((s) => s.current)
    const furthest = holding.length
      ? holding.reduce((a, b) => (b.index > a.index ? b : a)).name
      : undefined
    const times = stageRows.map((s) => s.promotedAt).filter((t): t is string => !!t).sort()

    return {
      id: f.id,
      short: short(f.id),
      alias: f.alias,
      project: f.project,
      warehouse: f.warehouse,
      created: f.created,
      contents: readContents(f),
      stages: stageRows,
      furthest,
      // The end of the chain is the last stage in promotion order, which is as
      // close to "in production" as the data actually says.
      atEnd: furthest !== undefined && position.get(furthest) === ordered.length - 1,
      unpromoted: holding.length === 0,
      lastPromotedAt: times[times.length - 1],
    }
  })

  // Newest first, with the id as a stable tie-break.
  return releases.sort((a, b) =>
    (a.created === b.created ? a.id.localeCompare(b.id) : a.created < b.created ? 1 : -1)
  )
}

export interface ReleaseSummary {
  total: number
  atEnd: number
  inFlight: number
  unpromoted: number
}

export function summariseReleases(list: Release[]): ReleaseSummary {
  return {
    total: list.length,
    atEnd: list.filter((r) => r.atEnd).length,
    // Held by a stage, but not the last one — still travelling.
    inFlight: list.filter((r) => !r.unpromoted && !r.atEnd).length,
    unpromoted: list.filter((r) => r.unpromoted).length,
  }
}
