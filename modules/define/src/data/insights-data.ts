import { useEffect, useMemo, useState } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { plane } from '@adhar/api-clients'
import { docStore, DocStoreError, useOptionalUser, usePlaneWorkspace, useTeamProjects } from '@adhar/shell-ui'
import { planeClient, planeError, useMembers, useProjects } from './plane.ts'
import { dayKey, DAY, type Group, toWorkItems, type WorkItem } from './insights-math.ts'
import { type DayState, monthKey, monthsBetween, readDays, recordDay, SNAPSHOT_KIND, type SnapshotMonth, snapshotId } from './insights-snapshot.ts'

/**
 * Data loading for Define's insights pages — designed around Plane's ONE
 * shared API key (60 requests/minute for every console user together).
 *
 *   • Query keys are shared with the rest of Define (`['plane','states',…]`,
 *     `['plane','cycles',…]`, `['plane','activities',…]`, …), so a page never
 *     re-reads what another already holds.
 *   • Project issues are read with `listIssuesLite` (ONE request a project)
 *     instead of the membership-enriched list; when the Issues board has
 *     already loaded a project's full list, that cache is reused instead.
 *   • Multi-project reads are capped (`MAX_SCOPE_PROJECTS`) and slow-stale
 *     (2 min) with no refetch on focus; background refresh is silent.
 *   • Per-issue history is only read on request, a bounded batch, two at a
 *     time, each result cached under the drawer's own activities key.
 */

export const insightsClient = plane.PlaneInsightsClient.auto({ tool: 'plane' })

export const MAX_SCOPE_PROJECTS = 12
const STALE = 120_000
const SLOW = { staleTime: STALE, refetchOnWindowFocus: false, retry: (n: number, e: unknown) => n < 1 && !isRateLimited(e) } as const

export function isRateLimited(e: unknown): boolean {
  return (e as { status?: number } | undefined)?.status === 429
}

export type ErrorKind = 'rate' | 'permission' | 'not-configured' | 'store' | 'other'

/** Classify a Plane or docStore failure for an honest empty state. */
export function classifyError(e: unknown): { kind: ErrorKind; message: string } {
  if (e instanceof DocStoreError) {
    return e.code === 'store_unavailable'
      ? { kind: 'store', message: 'The console database is not configured, so console-side data (layouts, snapshots, pages, OKRs) cannot be saved.' }
      : { kind: e.status === 403 ? 'permission' : 'other', message: e.message }
  }
  const status = (e as { status?: number } | undefined)?.status
  const body = (e as { body?: { error?: string } } | undefined)?.body
  if (status === 429) return { kind: 'rate', message: planeError(e) }
  if (status === 401 || status === 403) return { kind: 'permission', message: planeError(e) }
  if (body?.error === 'tool_not_configured') return { kind: 'not-configured', message: planeError(e) }
  return { kind: 'other', message: planeError(e) }
}

/* ───── who am I in Plane ───── */

export interface Me {
  /** Console session user. */
  user: { id: string; name: string; email: string } | null
  /** Plane user id matched by email (assignees / created_by use it). */
  planeId?: string
  member?: plane.Member
  /** True once members are loaded and no Plane member has this email. */
  unmatched: boolean
}

export function useMe(): Me {
  const user = useOptionalUser()
  const members = useMembers()
  return useMemo(() => {
    const email = user?.email?.toLowerCase()
    const member = email ? (members.data ?? []).find((m) => (m.member?.email ?? m.email ?? '').toLowerCase() === email) : undefined
    return {
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
      planeId: member ? member.member?.id ?? member.id : undefined,
      member,
      unmatched: !!members.data && !member,
    }
  }, [user, members.data])
}

/* ───── scope ───── */

export type Scope = 'project' | 'team' | 'all'

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

export interface ScopeResult {
  projects: plane.Project[]
  /** Projects in scope before the cap. */
  total: number
  capped: boolean
  team: string
  /** Team lens active but no Plane project matched it. */
  teamUnmatched: boolean
  ready: boolean
}

/**
 * Plane projects in scope. `team` follows the console's team lens: a Plane
 * project is the team's when its name or identifier matches one of the
 * team's console projects (slug or name). A lens, not an access boundary.
 */
export function useScopeProjects(scope: Scope, activeProjectId?: string): ScopeResult {
  const projects = useProjects()
  const team = useTeamProjects()
  const teamKey = team.projects.map((p) => `${p.slug}:${p.name}`).join(',')
  return useMemo(() => {
    const all = (projects.data ?? []).filter((p) => !p.archived_at)
    let list: plane.Project[]
    let teamUnmatched = false
    if (scope === 'project') list = all.filter((p) => p.id === activeProjectId).slice(0, 1)
    else if (scope === 'team' && team.filtering) {
      const names = new Set(team.projects.flatMap((p) => [norm(p.slug), norm(p.name)]))
      list = all.filter((p) => names.has(norm(p.name)) || names.has(norm(p.identifier)))
      teamUnmatched = list.length === 0
    } else list = all
    return {
      projects: list.slice(0, MAX_SCOPE_PROJECTS),
      total: list.length,
      capped: list.length > MAX_SCOPE_PROJECTS,
      team: team.filtering ? team.team : '',
      teamUnmatched,
      ready: !!projects.data,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.data, scope, activeProjectId, team.filtering, team.team, teamKey])
}

/* ───── issues + states for many projects ───── */

export interface ProjectData {
  items: WorkItem[]
  states: plane.State[]
  labels: plane.Label[]
  isLoading: boolean
  isFetching: boolean
  errors: unknown[]
  /** When the newest issue data was read. */
  updatedAt: number
}

export function useProjectsData(projects: plane.Project[], opts: { labels?: boolean; snapshot?: boolean } = {}): ProjectData {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const ids = projects.map((p) => p.id)
  const issues = useQueries({
    queries: ids.map((pid) => ({
      queryKey: ['plane', 'issues-lite', slug, pid],
      queryFn: (): Promise<plane.Issue[]> => {
        // The Issues board's full list (membership-enriched) is a superset.
        const full = qc.getQueryState<plane.Issue[]>(['plane', 'issues', slug, pid, undefined])
        if (full?.data && Date.now() - full.dataUpdatedAt < STALE) return Promise.resolve(full.data)
        return insightsClient.listIssuesLite(slug, pid)
      },
      ...SLOW,
    })),
  })
  const states = useQueries({
    queries: ids.map((pid) => ({
      queryKey: ['plane', 'states', slug, pid],
      queryFn: () => planeClient.listStates(slug, pid),
      ...SLOW,
    })),
  })
  const labels = useQueries({
    queries: ids.map((pid) => ({
      queryKey: ['plane', 'labels', slug, pid],
      queryFn: () => planeClient.listLabels(slug, pid),
      enabled: !!opts.labels,
      ...SLOW,
    })),
  })
  // Story points kept console-side by Define's planning (`define.points`, same
  // query key as planning-store's useIssuePoints) fill in where Plane has no estimate.
  const points = useQueries({
    queries: ids.map((pid) => ({
      queryKey: ['define-store', 'define.points', pid],
      queryFn: async () => (await docStore.get<{ points: Record<string, number> }>('define.points', pid))?.data ?? null,
      staleTime: STALE,
      refetchOnWindowFocus: false,
      retry: false,
    })),
  })
  const stamp = issues.map((q) => q.dataUpdatedAt).join(',') + states.map((q) => q.dataUpdatedAt).join(',') + points.map((q) => q.dataUpdatedAt).join(',')
  const result = useMemo(() => {
    const items: WorkItem[] = []
    projects.forEach((p, k) => {
      const rows = issues[k]?.data
      const st = states[k]?.data
      if (!rows || !st) return
      const extra = points[k]?.data?.points
      for (const w of toWorkItems(rows, st, p.identifier)) {
        if (w.points == null && extra && typeof extra[w.id] === 'number') w.points = extra[w.id]
        items.push(w)
      }
    })
    return {
      items,
      states: states.flatMap((q) => q.data ?? []),
      labels: labels.flatMap((q) => q.data ?? []),
      isLoading: issues.some((q) => q.isLoading) || states.some((q) => q.isLoading),
      isFetching: issues.some((q) => q.isFetching),
      errors: [...issues, ...states].map((q) => q.error).filter(Boolean),
      updatedAt: Math.max(0, ...issues.map((q) => q.dataUpdatedAt)),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, labels.map((q) => q.dataUpdatedAt).join(','), ids.join(',')])
  useSnapshotRecorder(opts.snapshot === false ? [] : projects, result.items, !result.isLoading)
  return result
}

/* ───── daily snapshots ───── */

const recorded = new Set<string>()
const MARK = 'adhar.define.snapshot.'

function markedToday(id: string, day: string): boolean {
  if (recorded.has(`${id}|${day}`)) return true
  try {
    return localStorage.getItem(MARK + id) === day
  } catch {
    return false
  }
}
function markToday(id: string, day: string) {
  recorded.add(`${id}|${day}`)
  try {
    localStorage.setItem(MARK + id, day)
  } catch { /* private mode */ }
}

/**
 * Record today's issue states for each project (once per project per day, per
 * browser — and the document itself refuses a second write for the same day).
 * Uses data already loaded; costs no Plane request. Failures are silent: no
 * database just means no history.
 */
function useSnapshotRecorder(projects: plane.Project[], items: WorkItem[], ready: boolean) {
  const qc = useQueryClient()
  const key = projects.map((p) => p.id).join(',')
  useEffect(() => {
    if (!ready || !projects.length) return
    const now = Date.now()
    const day = dayKey(now)
    for (const p of projects) {
      if (markedToday(p.id, day)) continue
      const mine = items.filter((i) => i.project === p.id)
      if (!mine.length) continue
      markToday(p.id, day)
      const id = snapshotId(p.id, monthKey(now))
      void (async () => {
        try {
          const doc = await docStore.get<SnapshotMonth>(SNAPSHOT_KIND, id)
          const next = recordDay(doc?.data ?? null, p.id, mine, now)
          if (next) {
            await docStore.put(SNAPSHOT_KIND, id, next)
            qc.invalidateQueries({ queryKey: ['define', 'snapshot', p.id] })
          }
        } catch { /* no store: history simply doesn't accumulate */ }
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, items.length])
}

export interface SnapshotsResult {
  days: DayState[]
  firstDay?: number
  isLoading: boolean
  storeError?: { kind: ErrorKind; message: string }
}

/** Daily snapshots for one project over [from, to] (month documents read by id). */
export function useSnapshots(projectId: string | undefined, from: number, to: number): SnapshotsResult {
  const months = projectId ? monthsBetween(from, to) : []
  const qs = useQueries({
    queries: months.map((m) => ({
      queryKey: ['define', 'snapshot', projectId, m],
      queryFn: async () => (await docStore.get<SnapshotMonth>(SNAPSHOT_KIND, snapshotId(projectId!, m)))?.data ?? null,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: false,
    })),
  })
  const stamp = qs.map((q) => q.dataUpdatedAt).join(',')
  return useMemo(() => {
    const days = readDays(qs.map((q) => q.data)).filter((d) => d.t >= from - DAY && d.t <= to)
    const err = qs.find((q) => q.error)?.error
    return {
      days,
      firstDay: days[0]?.t,
      isLoading: qs.some((q) => q.isLoading),
      storeError: err ? classifyError(err) : undefined,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, from, to])
}

/* ───── cycles, modules, membership ───── */

export function useCyclesFor(projectIds: string[]) {
  const slug = usePlaneWorkspace()
  return useQueries({
    queries: projectIds.map((pid) => ({
      queryKey: ['plane', 'cycles', slug, pid],
      queryFn: () => planeClient.listCycles(slug, pid),
      ...SLOW,
    })),
  })
}

export function useModulesFor(projectIds: string[]) {
  const slug = usePlaneWorkspace()
  return useQueries({
    queries: projectIds.map((pid) => ({
      queryKey: ['plane', 'modules', slug, pid],
      queryFn: () => planeClient.listModules(slug, pid),
      ...SLOW,
    })),
  })
}

/** Issue ids in a cycle or module (one id-only request). */
export function useContainerIds(projectId: string | undefined, kind: 'cycle' | 'module', id: string | undefined) {
  const slug = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', `${kind}-issue-ids`, slug, projectId, id],
    queryFn: () =>
      kind === 'cycle' ? insightsClient.listCycleIssueIds(slug, projectId!, id!) : insightsClient.listModuleIssueIds(slug, projectId!, id!),
    enabled: !!projectId && !!id,
    ...SLOW,
  })
}

/** Ids for several containers at once (velocity points, sprint widgets). */
export function useContainersIds(projectId: string | undefined, kind: 'cycle' | 'module', ids: string[]) {
  const slug = usePlaneWorkspace()
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ['plane', `${kind}-issue-ids`, slug, projectId, id],
      queryFn: () =>
        kind === 'cycle' ? insightsClient.listCycleIssueIds(slug, projectId!, id) : insightsClient.listModuleIssueIds(slug, projectId!, id),
      enabled: !!projectId,
      ...SLOW,
    })),
  })
}

/** Issue ids of several (project, container) pairs — e.g. every active sprint in scope. */
export function usePairIds(kind: 'cycle' | 'module', pairs: Array<{ project: string; id: string }>) {
  const slug = usePlaneWorkspace()
  return useQueries({
    queries: pairs.map((p) => ({
      queryKey: ['plane', `${kind}-issue-ids`, slug, p.project, p.id],
      queryFn: () =>
        kind === 'cycle' ? insightsClient.listCycleIssueIds(slug, p.project, p.id) : insightsClient.listModuleIssueIds(slug, p.project, p.id),
      ...SLOW,
    })),
  })
}

/* ───── per-issue history (bounded, on request) ───── */

export const HISTORY_BATCH = 30

/**
 * Plane activity logs for up to `HISTORY_BATCH` issues, two requests at a
 * time. Each result is cached under the issue drawer's own key
 * (`['plane','activities',slug,project,issue]`) so neither reads it twice.
 */
export function useIssueHistories(projectId: string | undefined, issueIds: string[], enabled: boolean) {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const ids = issueIds.slice(0, HISTORY_BATCH)
  const [progress, setProgress] = useState(0)
  const q = useQuery({
    queryKey: ['define', 'history-batch', slug, projectId, ids.join(',')],
    enabled: enabled && !!projectId && ids.length > 0,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const out = new Map<string, plane.HistoryActivity[]>()
      let done = 0
      const queue = [...ids]
      const worker = async () => {
        while (queue.length) {
          const id = queue.shift()!
          const k = ['plane', 'activities', slug, projectId, id]
          let rows = qc.getQueryData<plane.HistoryActivity[]>(k)
          if (!rows) {
            rows = (await planeClient.listActivities(slug, projectId!, id)) as plane.HistoryActivity[]
            qc.setQueryData(k, rows)
          }
          out.set(id, rows)
          setProgress(++done)
        }
      }
      await Promise.all([worker(), worker()])
      return out
    },
  })
  return { ...q, progress, total: ids.length }
}

/* ───── intake ───── */

export function useIntakeCounts(projectIds: string[], enabled = true) {
  const slug = usePlaneWorkspace()
  return useQueries({
    queries: projectIds.map((pid) => ({
      queryKey: ['plane', 'intake', slug, pid, 'all'],
      queryFn: () => planeClient.listIntake(slug, pid),
      enabled,
      ...SLOW,
    })),
  })
}

/* ───── releases (planned in Define, docStore `define.release`) ───── */

export interface ReleaseLite {
  id: string
  name: string
  project?: string
  date?: string
  status?: string
  /** Plane work item ids in the release. */
  issues: string[]
}

/** Releases written by Define's release planning (read-only here; shape read defensively). */
export function useReleases(enabled = true) {
  return useQuery({
    // Same cache entry as planning-store's useStoreList('define.release').
    queryKey: ['define-store', 'define.release'],
    enabled,
    select: (docs: Array<{ id: string; data: Record<string, unknown> }>): ReleaseLite[] => {
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
      return docs.map((d) => {
        const x = d.data
        return {
          id: d.id,
          name: str(x.name) ?? str(x.title) ?? str(x.version) ?? 'Untitled release',
          project: str(x.project) ?? str(x.projectId),
          date: str(x.release_date) ?? str(x.targetDate) ?? str(x.target_date) ?? str(x.releaseDate) ?? str(x.date),
          status: str(x.status),
          issues: Array.isArray(x.issues) ? (x.issues as unknown[]).filter((i): i is string => typeof i === 'string') : [],
        }
      })
    },
    queryFn: () => docStore.list<Record<string, unknown>>('define.release'),
    staleTime: STALE,
    retry: false,
  })
}

/* ───── helpers ───── */

export function downloadText(filename: string, text: string, type = 'text/csv') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const GROUP_ORDER: Group[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled']

/** Member id → display name. */
export function useMemberNames(): (id: string) => string {
  const members = useMembers()
  return useMemo(() => {
    const map = new Map((members.data ?? []).map((m) => [m.member?.id ?? m.id, m.member?.display_name ?? m.display_name ?? m.email ?? 'Unknown']))
    return (id: string) => (id ? map.get(id) ?? 'Former member' : 'Unassigned')
  }, [members.data])
}
