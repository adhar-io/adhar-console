import { defineClient, type HttpClient } from '../base/index.ts'
import { nextCursor, stripHtml, unwrapList } from './normalize.ts'
import type { Activity, Issue } from './index.ts'

/**
 * Read-only Plane calls for Define's insights (dashboard, My Work, reports).
 *
 * The main `PlaneClient.listIssues` enriches every row with cycle/module
 * membership, which costs one request per cycle and per module — right for
 * the Issues board, far too expensive when a dashboard reads several
 * projects through the console's one shared Plane API key (60 req/min for
 * everyone). These calls read exactly one list each:
 *
 *   • `listIssuesLite`     → `GET …/issues/?per_page=1000` (cursor-followed),
 *                            no membership, estimate ids resolved only when
 *                            present (2 extra calls, once per project).
 *   • `listCycleIssueIds`  → `GET …/cycles/<id>/cycle-issues/?fields=id`
 *   • `listModuleIssueIds` → `GET …/modules/<id>/module-issues/?fields=id`
 *   • `listIssueHistory`   → `GET …/issues/<id>/activities/` keeping the raw
 *                            `old_identifier` / `new_identifier` state ids.
 *
 * Verified against adhar-io/plane `adhar-v1.4.2-1`
 * (`apps/api/plane/api/urls/work_item.py`, `cycle.py`, `module.py`): Plane's
 * paginator defaults to and caps at 1000 rows a page.
 */

/** An activity row with the identifiers Plane sends but the base schema omits. */
export interface HistoryActivity extends Activity {
  old_identifier?: string | null
  new_identifier?: string | null
}

export interface PlaneInsights {
  listIssuesLite(slug: string, project: string): Promise<Issue[]>
  listCycleIssueIds(slug: string, project: string, cycle: string): Promise<string[]>
  listModuleIssueIds(slug: string, project: string, module: string): Promise<string[]>
  listIssueHistory(slug: string, project: string, issue: string): Promise<HistoryActivity[]>
}

const MAX_PAGES = 20

function build(http: HttpClient): PlaneInsights {
  const ws = (slug: string) => `/api/v1/workspaces/${slug}`
  const proj = (slug: string, p: string) => `${ws(slug)}/projects/${p}`

  const list = async <T>(path: string, params: Record<string, string> = {}): Promise<T[]> => {
    const out: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ ...params, ...(cursor ? { cursor } : {}) }).toString()
      const raw = await http.get<unknown>(`${path}${q ? `?${q}` : ''}`)
      out.push(...unwrapList<T>(raw))
      cursor = nextCursor(raw)
      if (!cursor) break
    }
    return out
  }

  // `estimates/` isn't registered in the fork's public API: stop asking after the first 404.
  let estimatesMissing = false
  const estimateValues = async (slug: string, p: string): Promise<Map<string, number>> => {
    if (estimatesMissing) return new Map()
    let estimate: { id?: string } | undefined
    try {
      estimate = await http.get<{ id?: string }>(`${proj(slug, p)}/estimates/`)
    } catch (e) {
      if ((e as { status?: number }).status === 404) estimatesMissing = true
      return new Map()
    }
    if (!estimate?.id) return new Map()
    const points = await list<{ id: string; value: string }>(`${proj(slug, p)}/estimates/${estimate.id}/estimate-points/`)
    const out = new Map<string, number>()
    for (const pt of points) {
      const v = Number(pt.value)
      if (Number.isFinite(v)) out.set(pt.id, v)
    }
    return out
  }

  const ids = async (path: string) => (await list<{ id: string }>(path, { fields: 'id' })).map((r) => r.id)

  return {
    listIssuesLite: async (slug, p) => {
      const rows = await list<Issue>(`${proj(slug, p)}/issues/`, { per_page: '1000' })
      const shaped = rows.map((i) => ({
        ...i,
        assignees: i.assignees ?? [],
        labels: i.labels ?? [],
        description_stripped: i.description_stripped ?? stripHtml(i.description_html),
      }))
      const raw = (i: Issue) => i.estimate_point as unknown
      if (!shaped.some((i) => typeof raw(i) === 'string')) return shaped
      const values = await estimateValues(slug, p).catch(() => new Map<string, number>())
      return shaped.map((i) => {
        const id = raw(i)
        if (typeof id !== 'string') return i
        return { ...i, estimate_point_id: id, estimate_point: values.get(id) ?? null }
      })
    },
    listCycleIssueIds: (slug, p, c) => ids(`${proj(slug, p)}/cycles/${c}/cycle-issues/`),
    listModuleIssueIds: (slug, p, m) => ids(`${proj(slug, p)}/modules/${m}/module-issues/`),
    listIssueHistory: (slug, p, i) => list<HistoryActivity>(`${proj(slug, p)}/issues/${i}/activities/`),
  }
}

export const PlaneInsightsClient = defineClient<PlaneInsights>(build, () => ({
  listIssuesLite: () => Promise.resolve([]),
  listCycleIssueIds: () => Promise.resolve([]),
  listModuleIssueIds: () => Promise.resolve([]),
  listIssueHistory: () => Promise.resolve([]),
}))
