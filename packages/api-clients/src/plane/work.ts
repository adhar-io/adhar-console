import { defineClient, type HttpClient } from '../base/index.ts'
import { nextCursor, stripHtml, unwrapList } from './normalize.ts'
import type { EstimatePoint, Issue } from './index.ts'

/**
 * Work-item extras for the Define module's Issues / Board / Backlog surfaces.
 *
 * Every route here was checked against the adhar fork of Plane
 * (`adhar-io/plane` tag `adhar-v1.4.2-1`, `apps/api/plane/api/urls/*.py`):
 *
 *   • `projects/<p>/issues/` (cursor-paginated) — the light list used for
 *     cross-project queries: no per-cycle/per-module membership fan-out, so a
 *     five-project query costs five lists, not five times (2 + cycles + modules);
 *   • `workspaces/<slug>/work-items/<KEY>-<n>/` — one work item by its key;
 *   • `issues/<id>/issue-attachments/` — attachment list (upload is a presigned
 *     S3 POST the console cannot proxy, so uploads stay in Plane);
 *   • `cycles/<c>/cycle-issues/` and `modules/<m>/module-issues/` — POST takes
 *     `{issues: [...]}`, so a bulk move into a sprint or epic is ONE request;
 *   • `issues/<id>/` PATCH — the serializer is exclude-based, so `sort_order`
 *     (rank), `parent` (sub-tasks) and `archived_at` are writable;
 *   • `users/me/` — the API-key owner every console write is recorded as.
 *
 * Plane's public API has NO worklogs, subscribers, issue-archive endpoint,
 * relation removal, views or pages; the console keeps what it can of those
 * in its own document store and says so in the UI.
 */

/** A work item as the list returns it, with the rank Plane's serializer includes. */
export type WorkItem = Issue & { sort_order?: number; type_id?: string | null }

export interface Attachment {
  id: string
  attributes?: { name?: string; type?: string; size?: number }
  asset?: string
  size?: number
  is_uploaded?: boolean
  created_at?: string
  created_by?: string | null
}

export interface PlaneUser {
  id: string
  display_name?: string
  email?: string
  first_name?: string
  last_name?: string
  is_bot?: boolean
}

export interface PlaneWorkClient {
  /** Every work item of a project, without cycle/module membership (cheap). */
  listIssuesLite(slug: string, project: string): Promise<WorkItem[]>
  /** One work item by its human key (`CON-42`), anywhere in the workspace. */
  getIssueByKey(slug: string, key: string): Promise<WorkItem>
  /** PATCH fields Plane stores on the item itself (rank, parent, archive…). */
  patchIssue(slug: string, project: string, issue: string, patch: Record<string, unknown>): Promise<WorkItem>
  /** Archive (Plane hides archived items from every list; restore in Plane). */
  archiveIssue(slug: string, project: string, issue: string, today?: string): Promise<void>
  /** Add many items to a sprint in one call (moves them out of any other sprint). */
  addIssuesToCycle(slug: string, project: string, cycle: string, issues: string[]): Promise<void>
  removeIssueFromCycle(slug: string, project: string, cycle: string, issue: string): Promise<void>
  addIssuesToModule(slug: string, project: string, module: string, issues: string[]): Promise<void>
  removeIssueFromModule(slug: string, project: string, module: string, issue: string): Promise<void>
  listAttachments(slug: string, project: string, issue: string): Promise<Attachment[]>
  /** The Plane user behind the console's API key. */
  me(): Promise<PlaneUser>
}

/** Pages a list may follow before giving up — a guard against a cursor loop. */
const MAX_PAGES = 50

/** `CON-42` → `{identifier: 'CON', sequence: 42}`; undefined for anything else. */
export function parseIssueKey(key: string): { identifier: string; sequence: number } | undefined {
  const m = /^([A-Za-z][A-Za-z0-9]{0,11})-(\d+)$/.exec(key.trim())
  if (!m) return undefined
  return { identifier: m[1].toUpperCase(), sequence: Number(m[2]) }
}

/** Today as a Plane date (`YYYY-MM-DD`, UTC). */
export function planeToday(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function buildWork(http: HttpClient): PlaneWorkClient {
  const ws = (slug: string) => `/api/v1/workspaces/${slug}`
  const proj = (slug: string, p: string) => `${ws(slug)}/projects/${p}`

  const list = async <T>(path: string): Promise<T[]> => {
    const out: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await http.get<unknown>(cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path)
      out.push(...unwrapList<T>(raw))
      cursor = nextCursor(raw)
      if (!cursor) break
    }
    return out
  }

  const shape = (i: WorkItem): WorkItem => ({
    ...i,
    assignees: i.assignees ?? [],
    labels: i.labels ?? [],
    description_stripped: i.description_stripped ?? stripHtml(i.description_html),
  })

  /** Resolve estimate point ids to values when the project exposes them (404 → leave as is). */
  const withEstimates = async (slug: string, p: string, rows: WorkItem[]): Promise<WorkItem[]> => {
    const raw = (i: WorkItem) => i.estimate_point as unknown
    if (!rows.some((i) => typeof raw(i) === 'string')) return rows
    let points: EstimatePoint[] = []
    try {
      const est = await http.get<{ id?: string }>(`${proj(slug, p)}/estimates/`)
      if (est?.id) points = await list<EstimatePoint>(`${proj(slug, p)}/estimates/${est.id}/estimate-points/`)
    } catch {
      points = []
    }
    const byId = new Map(points.map((pt) => [pt.id, Number(pt.value)]))
    return rows.map((i) => {
      const id = raw(i)
      if (typeof id !== 'string') return i
      const v = byId.get(id)
      return { ...i, estimate_point_id: id, estimate_point: v !== undefined && Number.isFinite(v) ? v : null }
    })
  }

  return {
    listIssuesLite: async (slug, p) => withEstimates(slug, p, (await list<WorkItem>(`${proj(slug, p)}/issues/`)).map(shape)),
    getIssueByKey: async (slug, key) => {
      const k = parseIssueKey(key)
      if (!k) throw new Error(`"${key}" is not a work item key like CON-42.`)
      const item = shape(await http.get<WorkItem>(`${ws(slug)}/work-items/${k.identifier}-${k.sequence}/`))
      return (await withEstimates(slug, item.project, [item]))[0]
    },
    patchIssue: async (slug, p, id, patch) => shape(await http.patch<WorkItem>(`${proj(slug, p)}/issues/${id}/`, patch)),
    archiveIssue: async (slug, p, id, today) => {
      await http.patch<unknown>(`${proj(slug, p)}/issues/${id}/`, { archived_at: today ?? planeToday() })
    },
    addIssuesToCycle: async (slug, p, cycle, issues) => {
      if (!issues.length) return
      await http.post<unknown>(`${proj(slug, p)}/cycles/${cycle}/cycle-issues/`, { issues })
    },
    removeIssueFromCycle: async (slug, p, cycle, issue) => {
      await http.delete<void>(`${proj(slug, p)}/cycles/${cycle}/cycle-issues/${issue}/`)
    },
    addIssuesToModule: async (slug, p, module, issues) => {
      if (!issues.length) return
      await http.post<unknown>(`${proj(slug, p)}/modules/${module}/module-issues/`, { issues })
    },
    removeIssueFromModule: async (slug, p, module, issue) => {
      await http.delete<void>(`${proj(slug, p)}/modules/${module}/module-issues/${issue}/`)
    },
    listAttachments: async (slug, p, issue) => unwrapList<Attachment>(await http.get<unknown>(`${proj(slug, p)}/issues/${issue}/issue-attachments/`)),
    me: () => http.get<PlaneUser>(`/api/v1/users/me/`),
  }
}

/** Offline stub: empty, never invented work. */
export const PlaneWorkClient = defineClient<PlaneWorkClient>(buildWork, () => ({
  listIssuesLite: () => Promise.resolve([]),
  getIssueByKey: (_slug, key) => Promise.reject(new Error(`No work item ${key}.`)),
  patchIssue: () => Promise.reject(new Error('Plane is not connected.')),
  archiveIssue: () => Promise.resolve(),
  addIssuesToCycle: () => Promise.resolve(),
  removeIssueFromCycle: () => Promise.resolve(),
  addIssuesToModule: () => Promise.resolve(),
  removeIssueFromModule: () => Promise.resolve(),
  listAttachments: () => Promise.resolve([]),
  me: () => Promise.resolve({ id: 'stub' }),
}))
