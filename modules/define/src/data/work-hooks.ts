import { useCallback, useMemo, useRef } from 'react'
import { keepPreviousData, type QueryClient, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { plane } from '@adhar/api-clients'
import { useOptionalUser, usePlaneWorkspace } from '@adhar/shell-ui'
import { memberDisplayName, planeClient, useMembers, useProjects } from './plane.ts'
import { type BulkExecutors, type BulkPlan, type BulkResult, runBulk } from './work-bulk.ts'
import type { QlContext } from './work-ql.ts'

/**
 * Work-item data hooks for Issues / Board / Backlog / the drawer.
 *
 * Reads share cache keys with `plane.ts` (`['plane','issues',slug,p,undefined]`,
 * states, labels, cycles, modules), so the rest of Define sees the same data.
 * Writes update those caches optimistically and do NOT refetch the whole
 * project list — Plane gives the console one 60-requests-a-minute key for
 * everyone, and a project list costs 3 + one request per cycle and module.
 * A slow silent poll keeps pages fresh instead.
 */

export const workClient = plane.PlaneWorkClient.auto({ tool: 'plane' })
export type WorkItem = plane.WorkItem

const STALE = 30_000
const POLL = 90_000

/** The page's own project — full list with sprint/epic membership; same cache as useIssues(). */
export function useProjectIssues(projectId?: string, enabled = true) {
  const slug = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'issues', slug, projectId, undefined],
    queryFn: () => planeClient.listIssues(slug, projectId!) as Promise<WorkItem[]>,
    enabled: !!projectId && enabled,
    staleTime: STALE,
    refetchInterval: POLL,
    placeholderData: keepPreviousData,
  })
}

export interface ScopeIssues {
  issues: WorkItem[]
  isLoading: boolean
  isFetching: boolean
  /** Project-level failures (rate limit, no permission) — shown, never hidden. */
  errors: Array<{ projectId: string; error: unknown }>
  /** Projects loaded without sprint/epic membership (cross-project, lite list). */
  liteProjects: string[]
}

/**
 * Items for a query scope: the primary project in full, plus any other
 * projects the query names via the light list (no membership fan-out).
 */
export function useScopeIssues(primary: string | undefined, others: string[]): ScopeIssues {
  const slug = usePlaneWorkspace()
  const main = useProjectIssues(primary)
  const extra = useQueries({
    queries: others.filter((p) => p !== primary).map((p) => ({
      queryKey: ['plane', 'issues-lite', slug, p],
      queryFn: () => workClient.listIssuesLite(slug, p),
      staleTime: STALE,
      refetchInterval: POLL,
      placeholderData: keepPreviousData,
    })),
  })
  const extraIds = others.filter((p) => p !== primary)
  const datas = [main.data, ...extra.map((q) => q.data)]
  const issues = useMemo(() => datas.flatMap((d) => (d ?? []) as WorkItem[]), datas) // eslint-disable-line react-hooks/exhaustive-deps
  const errors: ScopeIssues['errors'] = []
  if (primary && main.error) errors.push({ projectId: primary, error: main.error })
  extra.forEach((q, i) => {
    if (q.error) errors.push({ projectId: extraIds[i], error: q.error })
  })
  return {
    issues,
    isLoading: (!!primary && main.isLoading) || extra.some((q) => q.isLoading),
    isFetching: main.isFetching || extra.some((q) => q.isFetching),
    errors,
    liteProjects: extraIds,
  }
}

/** States / labels / cycles / modules for several projects (same keys as plane.ts hooks). */
export function useScopeMeta(projectIds: string[]) {
  const slug = usePlaneWorkspace()
  const ids = projectIds.filter(Boolean)
  const states = useQueries({ queries: ids.map((p) => ({ queryKey: ['plane', 'states', slug, p], queryFn: () => planeClient.listStates(slug, p), staleTime: STALE })) })
  const labels = useQueries({ queries: ids.map((p) => ({ queryKey: ['plane', 'labels', slug, p], queryFn: () => planeClient.listLabels(slug, p), staleTime: STALE })) })
  const cycles = useQueries({ queries: ids.map((p) => ({ queryKey: ['plane', 'cycles', slug, p], queryFn: () => planeClient.listCycles(slug, p), staleTime: STALE })) })
  const modules = useQueries({ queries: ids.map((p) => ({ queryKey: ['plane', 'modules', slug, p], queryFn: () => planeClient.listModules(slug, p), staleTime: STALE })) })
  const flat = <T,>(qs: Array<{ data?: T[] }>) => qs.flatMap((q) => q.data ?? [])
  const deps = [...states, ...labels, ...cycles, ...modules].map((q) => q.dataUpdatedAt).join(',')
  return useMemo(
    () => ({
      states: flat<plane.State>(states),
      labels: flat<plane.Label>(labels),
      cycles: flat<plane.Cycle>(cycles),
      modules: flat<plane.Module>(modules),
      isLoading: states.some((q) => q.isLoading),
    }),
    [deps], // eslint-disable-line react-hooks/exhaustive-deps
  )
}

/** The Plane member behind the signed-in console user (matched by email). */
export function useMeMember(): { id?: string; name?: string; email?: string; consoleName?: string } {
  const user = useOptionalUser()
  const members = useMembers()
  return useMemo(() => {
    if (!user) return {}
    const m = (members.data ?? []).find((x) => (x.member?.email ?? x.email ?? '').toLowerCase() === user.email.toLowerCase())
    return { id: m ? m.member?.id ?? m.id : undefined, name: m ? memberDisplayName(m) : undefined, email: user.email, consoleName: user.name }
  }, [user, members.data])
}

/** Everything WQL needs to resolve names, for the given scope. */
export function useQlContext(projectIds: string[]): QlContext & { ready: boolean } {
  const projects = useProjects()
  const members = useMembers()
  const meta = useScopeMeta(projectIds)
  const me = useMeMember()
  return useMemo(
    () => ({
      ready: !!projects.data && !meta.isLoading,
      projects: (projects.data ?? []).map((p) => ({ id: p.id, identifier: p.identifier, name: p.name })),
      states: meta.states.map((s) => ({ id: s.id, name: s.name, group: s.group, project: s.project, sequence: s.sequence })),
      labels: meta.labels.map((l) => ({ id: l.id, name: l.name, project: l.project })),
      members: (members.data ?? []).map((m) => ({ id: m.member?.id ?? m.id, name: memberDisplayName(m), email: m.member?.email ?? m.email })),
      cycles: meta.cycles.map((c) => ({ id: c.id, name: c.name, status: c.status, project: c.project })),
      modules: meta.modules.map((m) => ({ id: m.id, name: m.name, project: m.project })),
      me: me.id,
    }),
    [projects.data, members.data, meta, me.id],
  )
}

/* ───── cache patching ───── */

type Patchable = WorkItem & Record<string, unknown>

/** Apply `fn` to an item in every cached list / detail that holds it. */
export function patchItemCaches(qc: QueryClient, slug: string, projectId: string, id: string, fn: (i: Patchable) => Patchable) {
  const mapList = (old: unknown) => (Array.isArray(old) ? (old as Patchable[]).map((i) => (i && i.id === id ? fn(i) : i)) : old)
  qc.setQueriesData({ queryKey: ['plane', 'issues', slug, projectId] }, mapList)
  qc.setQueriesData({ queryKey: ['plane', 'issues-lite', slug, projectId] }, mapList)
  qc.setQueriesData({ queryKey: ['plane', 'issue', slug, projectId, id] }, (old: unknown) => (old && typeof old === 'object' ? fn(old as Patchable) : old))
}

/**
 * Stop in-flight reads of the caches `patchItemCaches` writes — the lists poll
 * every 90 s, and a poll that started before the edit would otherwise land
 * after it and flip a just-dragged card back until the next poll.
 */
function cancelItemQueries(qc: QueryClient, slug: string, projectId: string, id: string) {
  return Promise.all([
    qc.cancelQueries({ queryKey: ['plane', 'issues', slug, projectId] }),
    qc.cancelQueries({ queryKey: ['plane', 'issues-lite', slug, projectId] }),
    qc.cancelQueries({ queryKey: ['plane', 'issue', slug, projectId, id] }),
  ])
}

/** Coalesce follow-up refreshes after a burst of edits into one request per key. */
function useDebouncedInvalidate(delay = 4_000) {
  const qc = useQueryClient()
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  return useCallback((key: unknown[]) => {
    const h = JSON.stringify(key)
    const t = pending.current.get(h)
    if (t) clearTimeout(t)
    pending.current.set(h, setTimeout(() => {
      pending.current.delete(h)
      qc.invalidateQueries({ queryKey: key })
    }, delay))
  }, [qc, delay])
}

/**
 * PATCH fields stored on the item (state, priority, assignees, labels, dates,
 * parent, rank, name, description). Optimistic; rolls back on failure.
 */
export function usePatchWork() {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const later = useDebouncedInvalidate()
  return useMutation({
    mutationFn: (v: { projectId: string; id: string; patch: Record<string, unknown> }) => workClient.patchIssue(slug, v.projectId, v.id, v.patch),
    onMutate: async (v) => {
      await cancelItemQueries(qc, slug, v.projectId, v.id)
      const snapshot = qc.getQueriesData({ queryKey: ['plane'] })
      patchItemCaches(qc, slug, v.projectId, v.id, (i) => ({ ...i, ...v.patch, updated_at: new Date().toISOString() }))
      return { snapshot }
    },
    onError: (_e, _v, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data)
    },
    onSuccess: (server, v) => {
      // Keep console-derived fields (sprint, epic, estimate value) the PATCH response lacks.
      patchItemCaches(qc, slug, v.projectId, v.id, (i) => ({
        ...i,
        ...server,
        cycle: i.cycle,
        module: i.module,
        estimate_point: i.estimate_point,
        estimate_point_id: i.estimate_point_id,
      }))
      qc.invalidateQueries({ queryKey: ['plane', 'activities', slug, v.projectId, v.id] })
      if ('parent' in v.patch) later(['plane', 'sub-issues', slug, v.projectId])
    },
  })
}

/** Move one item between sprints / epics (membership endpoints). */
export function useMoveWork() {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const later = useDebouncedInvalidate()
  return useMutation({
    mutationFn: async (v: { projectId: string; item: Pick<WorkItem, 'id' | 'cycle' | 'module'>; cycle?: string | null; module?: string | null }) => {
      const { projectId: p, item } = v
      if ('cycle' in v && (v.cycle ?? null) !== (item.cycle ?? null)) {
        if (v.cycle) await workClient.addIssuesToCycle(slug, p, v.cycle, [item.id])
        else if (item.cycle) await workClient.removeIssueFromCycle(slug, p, item.cycle, item.id)
      }
      if ('module' in v && (v.module ?? null) !== (item.module ?? null)) {
        if (item.module) await workClient.removeIssueFromModule(slug, p, item.module, item.id)
        if (v.module) await workClient.addIssuesToModule(slug, p, v.module, [item.id])
      }
    },
    onMutate: async (v) => {
      await cancelItemQueries(qc, slug, v.projectId, v.item.id)
      const snapshot = qc.getQueriesData({ queryKey: ['plane'] })
      patchItemCaches(qc, slug, v.projectId, v.item.id, (i) => ({
        ...i,
        ...('cycle' in v ? { cycle: v.cycle ?? null } : {}),
        ...('module' in v ? { module: v.module ?? null } : {}),
      }))
      return { snapshot }
    },
    onError: (_e, _v, ctx) => {
      for (const [key, data] of ctx?.snapshot ?? []) qc.setQueryData(key, data)
    },
    onSuccess: (_r, v) => {
      later(['plane', 'cycles', slug, v.projectId])
      later(['plane', 'modules', slug, v.projectId])
      qc.invalidateQueries({ queryKey: ['plane', 'activities', slug, v.projectId, v.item.id] })
    },
  })
}

/** Set an estimate value (needs Plane's estimate-point mapping, so it goes through the main client). */
export function useSetEstimate() {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { projectId: string; item: Pick<WorkItem, 'id' | 'cycle' | 'module'>; value: number | null }) =>
      planeClient.updateIssue(slug, v.projectId, v.item.id, { estimate_point: v.value }, { cycle: v.item.cycle ?? null, module: v.item.module ?? null }),
    onSuccess: (server, v) => {
      patchItemCaches(qc, slug, v.projectId, v.item.id, (i) => ({ ...i, estimate_point: server.estimate_point, estimate_point_id: server.estimate_point_id }))
    },
  })
}

/** Run a bulk plan against Plane, then refresh the touched projects once. */
export function useBulkRunner() {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  return useCallback(
    async (plan: BulkPlan, onProgress?: (done: number, total: number) => void): Promise<BulkResult> => {
      const exec: BulkExecutors = {
        patch: (p) =>
          p.via === 'mapped'
            ? planeClient.updateIssue(slug, p.project, p.id, p.patch as Partial<plane.Issue>)
            : workClient.patchIssue(slug, p.project, p.id, p.patch),
        cycleAdd: (p, c, ids) => workClient.addIssuesToCycle(slug, p, c, ids),
        cycleRemove: (p, c, id) => workClient.removeIssueFromCycle(slug, p, c, id),
        moduleAdd: (p, m, ids) => workClient.addIssuesToModule(slug, p, m, ids),
        moduleRemove: (p, m, id) => workClient.removeIssueFromModule(slug, p, m, id),
        archive: (p, id) => workClient.archiveIssue(slug, p, id),
      }
      const res = await runBulk(plan, exec, { concurrency: 2, onProgress })
      const projects = new Set([
        ...plan.patches.map((x) => x.project),
        ...plan.cycleAdd.map((x) => x.project),
        ...plan.cycleRemove.map((x) => x.project),
        ...plan.moduleAdd.map((x) => x.project),
        ...plan.moduleRemove.map((x) => x.project),
        ...plan.archive.map((x) => x.project),
      ])
      for (const p of projects) {
        qc.invalidateQueries({ queryKey: ['plane', 'issues', slug, p] })
        qc.invalidateQueries({ queryKey: ['plane', 'issues-lite', slug, p] })
        if (plan.cycleAdd.length || plan.cycleRemove.length) qc.invalidateQueries({ queryKey: ['plane', 'cycles', slug, p] })
        if (plan.moduleAdd.length || plan.moduleRemove.length) qc.invalidateQueries({ queryKey: ['plane', 'modules', slug, p] })
      }
      return res
    },
    [slug, qc],
  )
}

/* ───── single reads ───── */

export function useAttachments(projectId?: string, issueId?: string) {
  const slug = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'attachments', slug, projectId, issueId],
    queryFn: () => workClient.listAttachments(slug, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: STALE,
    retry: false,
  })
}

/** The Plane user the console's API key acts as. */
export function usePlaneMe() {
  return useQuery({ queryKey: ['plane', 'me'], queryFn: () => workClient.me(), staleTime: 10 * 60_000, retry: false })
}

/** A work item by key (`CON-42`) — for keys outside the loaded projects. */
export function useIssueByKey(key?: string) {
  const slug = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'issue-key', slug, key],
    queryFn: () => workClient.getIssueByKey(slug, key!),
    enabled: !!key && !!plane.parseIssueKey(key),
    staleTime: STALE,
    retry: false,
  })
}

/* ───── sprints (Plane cycles) ───── */

const isoNow = () => new Date().toISOString()

/**
 * Sprint lifecycle on Plane cycles. Plane has no sprint status — it derives
 * one from dates — so "start" sets the dates to begin today and "complete"
 * ends the cycle now. Plane only lets a cycle hand its unfinished items to
 * another after it has ended, so completion ends it first, then transfers.
 */
export function useSprintActions(projectId?: string) {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['plane', 'cycles', slug, projectId] })
    qc.invalidateQueries({ queryKey: ['plane', 'issues', slug, projectId] })
  }
  const create = useMutation({
    mutationFn: (body: { name: string; start_date?: string | null; end_date?: string | null; description?: string }) =>
      planeClient.createCycle(slug, projectId!, body as Partial<plane.Cycle>),
    onSuccess: refresh,
  })
  const start = useMutation({
    mutationFn: (v: { id: string; start: string; end: string }) => planeClient.updateCycle(slug, projectId!, v.id, { start_date: v.start, end_date: v.end }),
    onSuccess: refresh,
  })
  const complete = useMutation({
    mutationFn: async (v: { id: string; unfinished: string[]; moveTo: string | 'backlog' }) => {
      if (v.moveTo === 'backlog') {
        // Remove before ending — a completed cycle can no longer be edited.
        for (const id of v.unfinished) await workClient.removeIssueFromCycle(slug, projectId!, v.id, id)
        await planeClient.updateCycle(slug, projectId!, v.id, { end_date: isoNow() })
      } else {
        await planeClient.updateCycle(slug, projectId!, v.id, { end_date: isoNow() })
        if (v.unfinished.length) await planeClient.transferCycleIssues(slug, projectId!, v.id, v.moveTo)
      }
    },
    onSuccess: refresh,
  })
  return { create, start, complete }
}
