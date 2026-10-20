import { useCallback, useMemo } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { gitea, plane } from '@adhar/api-clients'
import { usePlaneWorkspace } from '@adhar/shell-ui'
import { planeClient, planeError } from './plane.ts'
import { dayKey, takeSnapshot, wallNow, withSnapshot, type WorkItem } from './planning-model.ts'
import { type AutomationEvent, checkTransition, evaluateAutomation, issueKeysIn, type ItemView } from './planning-workflow.ts'
import {
  type AutomationDoc,
  KIND,
  membershipId,
  type NotificationPrefs,
  patchDoc,
  type ProjectMeta,
  type SprintMeta,
  useAutomationDoc,
  useIssuePoints,
  usePatchAutomation,
  usePatchMembership,
  usePatchSprintMeta,
  useProjectMeta,
  useRemoveMembershipDoc,
  useWorkflowRules,
} from './planning-store.ts'

/**
 * Plane-backed hooks for Define's planning pages. Reads go through the BFF's
 * shared GET cache (one Plane key, ~60 requests a minute for everyone), so
 * the hooks share query keys with `plane.ts` where the data is the same and
 * keep cross-project reads to one call per project (`issues/?expand=state`).
 *
 * Exported for the work-item views (issues, board, backlog, drawer):
 *   useSprintActions      add/remove items to a sprint, start, complete
 *   useCycleIssueIds      ids of the items in a sprint
 *   useTransitionGuard    console-side workflow rules — check a state move
 *   useRunAutomation      apply console-side automation after an action
 *   useIssuePoints / useSetIssuePoints (planning-store.ts) — story points
 */

export const planning = plane.PlanningClient.auto({ tool: 'plane' })
const giteaClient = gitea.GiteaClient.auto({ tool: 'gitea' })

const REFRESH_MS = 30_000

/* ───── honest error states ───── */

export interface PlaneProblem {
  kind: 'rate-limit' | 'auth' | 'permission' | 'not-configured' | 'unreachable' | 'not-found' | 'other'
  title: string
  message: string
  /** Seconds until Plane accepts requests again (429 only, when it said). */
  retryAfter?: number
}

/** A titled, actionable description of a failed Plane call. */
export function planeProblem(e: unknown): PlaneProblem {
  const err = e as { status?: number; body?: unknown } | undefined
  const body = err?.body && typeof err.body === 'object' ? err.body as Record<string, unknown> : {}
  if (err?.status === 429) {
    const detail = typeof body.detail === 'string' ? body.detail : ''
    const m = /(\d+)\s*second/.exec(detail)
    const retryAfter = m ? Number(m[1]) : undefined
    return {
      kind: 'rate-limit',
      title: 'Plane is rate-limiting the console',
      message: `Every console user shares one Plane API key (about 60 requests a minute).${retryAfter ? ` Plane accepts requests again in ${retryAfter}s.` : ' Try again in a minute.'}`,
      retryAfter,
    }
  }
  if (body.error === 'tool_not_configured') return { kind: 'not-configured', title: 'Plane is not connected', message: 'The console has no Plane URL or API key configured.' }
  if (body.error === 'upstream_unreachable') return { kind: 'unreachable', title: 'Plane is unreachable', message: 'The console could not reach Plane. It may be restarting.' }
  if (err?.status === 401) return { kind: 'auth', title: 'Plane rejected the console', message: planeError(e) }
  if (err?.status === 403) {
    return { kind: 'permission', title: 'No permission in Plane', message: 'The console\'s Plane key is not allowed to do this in this project. A Plane workspace admin can grant it, or do it in Plane directly.' }
  }
  if (err?.status === 404) return { kind: 'not-found', title: 'Not found in Plane', message: planeError(e) }
  return { kind: 'other', title: 'Plane request failed', message: planeError(e) }
}

/* ───── reads ───── */

export function usePlanIssues(projectId?: string) {
  const slug = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'plan-issues', slug, projectId],
    queryFn: () => planning.listPlanIssues(slug, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
    refetchInterval: 60_000,
  })
}

/** Plan issues, cycles and labels for many projects at once (one call each). */
export function usePortfolio(projectIds: string[], opts: { labels?: boolean; modules?: boolean } = {}) {
  const slug = usePlaneWorkspace()
  const issues = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: ['plane', 'plan-issues', slug, id],
      queryFn: () => planning.listPlanIssues(slug, id),
      staleTime: REFRESH_MS,
      refetchInterval: 90_000,
    })),
  })
  const cycles = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: ['plane', 'cycles', slug, id],
      queryFn: () => planeClient.listCycles(slug, id),
      staleTime: REFRESH_MS,
    })),
  })
  const labels = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: ['plane', 'labels', slug, id],
      queryFn: () => planeClient.listLabels(slug, id),
      staleTime: 5 * 60_000,
      enabled: !!opts.labels,
    })),
  })
  const modules = useQueries({
    queries: projectIds.map((id) => ({
      queryKey: ['plane', 'modules', slug, id],
      queryFn: () => planeClient.listModules(slug, id),
      staleTime: REFRESH_MS,
      enabled: !!opts.modules,
    })),
  })
  return useMemo(() => {
    const by = <T,>(qs: Array<{ data?: T }>) => new Map(projectIds.map((id, k) => [id, qs[k]?.data] as const))
    const all = [...issues, ...cycles, ...(opts.labels ? labels : []), ...(opts.modules ? modules : [])]
    const failed = all.find((q) => q.isError)
    return {
      issues: by<plane.PlanIssue[]>(issues),
      cycles: by<plane.Cycle[]>(cycles),
      labels: by<plane.Label[]>(labels),
      modules: by<plane.Module[]>(modules),
      issuesLoading: new Map(projectIds.map((id, k) => [id, issues[k]?.isLoading ?? false] as const)),
      loading: all.some((q) => q.isLoading),
      fetching: all.some((q) => q.isFetching),
      error: failed?.error ?? null,
    }
  }, [projectIds.join(','), ...issues.map((q) => q.dataUpdatedAt), ...cycles.map((q) => q.dataUpdatedAt), ...labels.map((q) => q.dataUpdatedAt), ...modules.map((q) => q.dataUpdatedAt), issues.some((q) => q.isError), cycles.some((q) => q.isError)])
}

export function useCycleIssueIds(projectId?: string, cycleId?: string) {
  const slug = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'cycle-ids', slug, projectId, cycleId],
    queryFn: () => planning.listCycleIssueIds(slug, projectId!, cycleId!),
    enabled: !!projectId && !!cycleId,
    staleTime: REFRESH_MS,
  })
}

/** Item ids for several sprints (velocity, planning board). */
export function useCyclesIssueIds(projectId: string | undefined, cycleIds: string[]) {
  const slug = usePlaneWorkspace()
  const qs = useQueries({
    queries: cycleIds.map((c) => ({
      queryKey: ['plane', 'cycle-ids', slug, projectId, c],
      queryFn: () => planning.listCycleIssueIds(slug, projectId!, c),
      enabled: !!projectId,
      staleTime: REFRESH_MS,
    })),
  })
  return useMemo(() => ({
    ids: new Map(cycleIds.map((c, k) => [c, qs[k]?.data] as const)),
    loading: qs.some((q) => q.isLoading),
    error: qs.find((q) => q.isError)?.error ?? null,
  }), [cycleIds.join(','), ...qs.map((q) => q.dataUpdatedAt), qs.some((q) => q.isError)])
}

export function useModulesIssueIds(projectId: string | undefined, moduleIds: string[]) {
  const slug = usePlaneWorkspace()
  const qs = useQueries({
    queries: moduleIds.map((m) => ({
      queryKey: ['plane', 'module-ids', slug, projectId, m],
      queryFn: () => planning.listModuleIssueIds(slug, projectId!, m),
      enabled: !!projectId,
      staleTime: REFRESH_MS,
    })),
  })
  return useMemo(() => ({
    ids: new Map(moduleIds.map((m, k) => [m, qs[k]?.data] as const)),
    loading: qs.some((q) => q.isLoading),
    error: qs.find((q) => q.isError)?.error ?? null,
  }), [moduleIds.join(','), ...qs.map((q) => q.dataUpdatedAt), qs.some((q) => q.isError)])
}

/** Relations for a capped set of items — one Plane call per item, so opt-in. */
export function usePlanRelations(items: Array<{ id: string; project: string }>, enabled: boolean, cap = 30) {
  const slug = usePlaneWorkspace()
  const shown = enabled ? items.slice(0, cap) : []
  const qs = useQueries({
    queries: shown.map((i) => ({
      queryKey: ['plane', 'plan-relations', slug, i.project, i.id],
      queryFn: () => planning.relationsOf(slug, i.project, i.id),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  })
  return useMemo(() => {
    const map = new Map<string, plane.PlanRelations>()
    shown.forEach((i, k) => {
      const d = qs[k]?.data
      if (d) map.set(i.id, d)
    })
    return { relations: map, loading: qs.some((q) => q.isLoading), skipped: Math.max(0, items.length - cap), error: qs.find((q) => q.isError)?.error ?? null }
  }, [enabled, shown.map((i) => i.id).join(','), ...qs.map((q) => q.dataUpdatedAt), items.length])
}

export function useEstimatePoints(projectId?: string) {
  const slug = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'estimate-points', slug, projectId],
    queryFn: () => planning.estimatePoints(slug, projectId!),
    enabled: !!projectId,
    staleTime: 10 * 60_000,
    retry: false,
  })
}

/** WorkItem view of a plan issue for the planning math. */
export function toWorkItem(i: plane.PlanIssue): WorkItem {
  return {
    id: i.id,
    name: i.name,
    state_group: i.state_group,
    completed_at: i.completed_at,
    created_at: i.created_at,
    assignees: i.assignees,
    start_date: i.start_date,
    target_date: i.target_date,
    priority: i.priority,
    labels: i.labels,
    project: i.project,
    estimate_point: typeof i.estimate_point === 'number' ? i.estimate_point : null,
  }
}

/* ───── sprint actions (exported for the work-item views) ───── */

function useInvalidatePlanning() {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  return useCallback((projectId?: string) => {
    for (const part of ['cycles', 'cycle-ids', 'plan-issues', 'issues', 'issue', 'archived-cycles', 'modules', 'module-ids']) {
      qc.invalidateQueries({ queryKey: ['plane', part, slug, projectId] })
    }
  }, [qc, slug])
}

export function useSprintActions(projectId?: string) {
  const slug = usePlaneWorkspace()
  const invalidate = useInvalidatePlanning()
  const patchMeta = usePatchSprintMeta()
  const { points } = useIssuePoints(projectId)
  const notify = useDefineNotify(projectId)
  const qc = useQueryClient()
  const done = () => {
    invalidate(projectId)
    qc.invalidateQueries({ queryKey: ['define-store', KIND.sprint] })
  }

  const addIssues = useMutation({
    mutationFn: ({ cycle, issues }: { cycle: string; issues: string[] }) => planning.addCycleIssues(slug, projectId!, cycle, issues),
    onSettled: done,
  })
  const removeIssue = useMutation({
    mutationFn: ({ cycle, issue }: { cycle: string; issue: string }) => planning.removeCycleIssue(slug, projectId!, cycle, issue),
    onSettled: done,
  })
  /** Set the dates (now → now + days) and record the committed scope. */
  const start = useMutation({
    mutationFn: async (v: { cycle: plane.Cycle; endDate: string; items: WorkItem[]; goal?: string }) => {
      const now = new Date()
      const startIso = now.toISOString()
      // End of that day in the viewer's timezone.
      const endIso = new Date(`${v.endDate}T23:59:59`).toISOString()
      await planning.setCycleDates(slug, projectId!, v.cycle.id, { start_date: startIso, end_date: endIso })
      const snap = takeSnapshot(v.items, points)
      await patchDoc<SprintMeta>(KIND.sprint, v.cycle.id, (cur) => ({
        ...(cur ?? { project: projectId! }),
        project: projectId!,
        goal: v.goal ?? cur?.goal,
        startedAt: startIso,
        commitment: { ids: snap.ids, points: snap.points, at: startIso },
        snapshots: withSnapshot(cur?.snapshots, dayKey(wallNow()), snap) ?? cur?.snapshots,
      }))
      notify('sprintStarted', {
        title: `Sprint started: ${v.cycle.name}`,
        description: `${snap.ids.length} work items committed${v.goal ? ` · Goal: ${v.goal}` : ''}`,
        key: `define:sprint-start:${v.cycle.id}`,
      })
    },
    onSettled: done,
  })
  /**
   * Complete a sprint: end it now when still running (Plane only transfers
   * out of ended cycles), carry unfinished work to another sprint or back to
   * the backlog, and record the outcome + retrospective.
   */
  const complete = useMutation({
    mutationFn: async (v: { cycle: plane.Cycle; carryTo: string | 'backlog'; openIds: string[]; retro?: SprintMeta['retro']; items: WorkItem[] }) => {
      const endMs = Date.parse(v.cycle.end_date ?? '')
      const stillRunning = !Number.isFinite(endMs) || endMs + (v.cycle.end_date?.length === 10 ? 86_400_000 : 0) > Date.now()
      if (stillRunning) {
        await planning.setCycleDates(slug, projectId!, v.cycle.id, { end_date: new Date(Date.now() - 60_000).toISOString() })
      }
      if (v.openIds.length) {
        if (v.carryTo === 'backlog') {
          for (const id of v.openIds) await planning.removeCycleIssue(slug, projectId!, v.cycle.id, id)
        } else {
          await planning.transferCycle(slug, projectId!, v.cycle.id, v.carryTo)
        }
      }
      const snap = takeSnapshot(v.items, points)
      await patchDoc<SprintMeta>(KIND.sprint, v.cycle.id, (cur) => ({
        ...(cur ?? { project: projectId! }),
        project: projectId!,
        completedAt: new Date().toISOString(),
        carriedTo: v.openIds.length ? v.carryTo : undefined,
        retro: v.retro ?? cur?.retro,
        snapshots: withSnapshot(cur?.snapshots, dayKey(wallNow()), snap) ?? cur?.snapshots,
      }))
      notify('sprintCompleted', {
        title: `Sprint completed: ${v.cycle.name}`,
        description: `${snap.done.length} of ${snap.ids.length} done${v.openIds.length ? ` · ${v.openIds.length} carried ${v.carryTo === 'backlog' ? 'to the backlog' : 'over'}` : ''}`,
        key: `define:sprint-complete:${v.cycle.id}`,
      })
    },
    onSettled: done,
  })
  const transfer = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => planning.transferCycle(slug, projectId!, from, to),
    onSettled: done,
  })
  const setDates = useMutation({
    mutationFn: ({ cycle, start_date, end_date }: { cycle: string; start_date?: string; end_date?: string }) =>
      planning.setCycleDates(slug, projectId!, cycle, { start_date, end_date }),
    onSettled: done,
  })
  return { addIssues, removeIssue, start, complete, transfer, setDates, patchMeta }
}

/**
 * Record today's snapshot of a running sprint, at most once per change per
 * day — the only way the console can know scope changes, since Plane keeps no
 * per-cycle history its public API exposes.
 */
export function useSnapshotRecorder() {
  const patch = usePatchSprintMeta()
  return useCallback(
    (v: { cycleId: string; projectId: string; meta: SprintMeta | null | undefined; items: WorkItem[]; points: Record<string, number> }) => {
      const snap = takeSnapshot(v.items, v.points)
      const next = withSnapshot(v.meta?.snapshots, dayKey(wallNow()), snap)
      if (!next) return
      patch.mutate({ id: v.cycleId, fn: (cur) => ({ ...(cur ?? { project: v.projectId }), project: v.projectId, snapshots: withSnapshot(cur?.snapshots, dayKey(wallNow()), snap) ?? cur?.snapshots }) })
    },
    [patch],
  )
}

export function useEpicActions(projectId?: string) {
  const slug = usePlaneWorkspace()
  const invalidate = useInvalidatePlanning()
  const done = () => invalidate(projectId)
  return {
    addIssues: useMutation({
      mutationFn: ({ module, issues }: { module: string; issues: string[] }) => planning.addModuleIssues(slug, projectId!, module, issues),
      onSettled: done,
    }),
    removeIssue: useMutation({
      mutationFn: ({ module, issue }: { module: string; issue: string }) => planning.removeModuleIssue(slug, projectId!, module, issue),
      onSettled: done,
    }),
    update: useMutation({
      mutationFn: ({ module, patch }: { module: string; patch: Partial<plane.Module> }) => planeClient.updateModule(slug, projectId!, module, patch),
      onSettled: done,
    }),
  }
}

/** Drag-to-reschedule on the roadmap; optimistic on the plan-issues cache. */
export function useReschedule() {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { project: string; kind: 'issue' | 'epic'; id: string; start_date: string | null; target_date: string | null }) =>
      v.kind === 'issue'
        ? planning.setIssueDates(slug, v.project, v.id, { start_date: v.start_date, target_date: v.target_date })
        : planning.setModuleDates(slug, v.project, v.id, { start_date: v.start_date, target_date: v.target_date }),
    onMutate: (v) => {
      const k = v.kind === 'issue' ? ['plane', 'plan-issues', slug, v.project] : ['plane', 'modules', slug, v.project]
      const prev = qc.getQueryData<Array<{ id: string }>>(k)
      if (prev) qc.setQueryData(k, prev.map((x) => (x.id === v.id ? { ...x, start_date: v.start_date, target_date: v.target_date } : x)))
      return { k, prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.k, ctx.prev)
    },
    onSettled: (_d, _e, v) => {
      qc.invalidateQueries({ queryKey: ['plane', v.kind === 'issue' ? 'plan-issues' : 'modules', slug, v.project] })
      qc.invalidateQueries({ queryKey: ['plane', 'issues', slug, v.project] })
    },
  })
}

/* ───── project membership with recorded pks ───── */

export function useMembershipActions(projectId?: string) {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const record = usePatchMembership()
  const forget = useRemoveMembershipDoc()
  const refresh = () => qc.invalidateQueries({ queryKey: ['plane', 'project-members', slug, projectId] })
  return {
    add: useMutation({
      mutationFn: async ({ member, role }: { member: string; role: number }) => {
        const m = await planning.addProjectMembership(slug, projectId!, member, role)
        if (m?.id) {
          await record.mutateAsync({ id: membershipId(projectId!, member), fn: () => ({ project: projectId!, member, pk: m.id, role: m.role ?? role }) })
        }
        return m
      },
      onSettled: refresh,
    }),
    setRole: useMutation({
      mutationFn: async ({ member, pk, role }: { member: string; pk: string; role: number }) => {
        await planning.setProjectMemberRole(slug, projectId!, pk, role)
        await record.mutateAsync({ id: membershipId(projectId!, member), fn: (cur) => ({ project: projectId!, member, pk, ...(cur ?? {}), role }) })
      },
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: async ({ member, pk }: { member: string; pk: string }) => {
        await planning.removeProjectMembership(slug, projectId!, pk)
        await forget.mutateAsync(membershipId(projectId!, member))
      },
      onSettled: refresh,
    }),
  }
}

/* ───── workflow guard + automation (exported for the work-item views) ───── */

/**
 * Console-side transition rules for a project. `check(issue, toState)`
 * answers `{ok}` or `{ok: false, reason}` — call it before PATCHing a state
 * change and show the reason in a toast when refused. Moves made in Plane's
 * own UI are not checked.
 */
export function useTransitionGuard(projectId?: string) {
  const rules = useWorkflowRules(projectId)
  const slug = usePlaneWorkspace()
  const states = useQuery({
    queryKey: ['plane', 'states', slug, projectId],
    queryFn: () => planeClient.listStates(slug, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
  const name = useCallback((id: string) => states.data?.find((s) => s.id === id)?.name ?? 'that state', [states.data])
  const check = useCallback(
    (issue: { state: string; assignees?: string[] }, to: string) => checkTransition(rules.data, issue.state, to, issue, name),
    [rules.data, name],
  )
  return { rules: rules.data ?? null, enforcing: !!rules.data?.enforce, check }
}

/**
 * Apply the project's console-side automation after an action the console
 * performed. Pass the item before and after; the hook evaluates the rules,
 * PATCHes the resulting change in Plane once, and logs what fired.
 */
export function useRunAutomation(projectId?: string) {
  const slug = usePlaneWorkspace()
  const doc = useAutomationDoc(projectId)
  const patch = usePatchAutomation()
  const qc = useQueryClient()
  const states = useQuery({
    queryKey: ['plane', 'states', slug, projectId],
    queryFn: () => planeClient.listStates(slug, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
  return useMutation({
    mutationFn: async (e: Omit<AutomationEvent, 'groupOf'>) => {
      const groupOf = (id: string) => states.data?.find((s) => s.id === id)?.group
      const res = evaluateAutomation(doc.data?.rules, { ...e, groupOf })
      if (!res.fired.length || !Object.keys(res.patch).length) return res
      await planning.patchIssue(slug, projectId!, e.after.id, res.patch)
      const at = new Date().toISOString()
      patch.mutate({
        id: projectId!,
        fn: (cur) => ({
          ...(cur ?? { rules: [] }),
          rules: cur?.rules ?? [],
          log: [...res.fired.map((f) => ({ at, rule: f.name, issue: e.after.id, summary: Object.keys(res.patch).join(', ') })), ...(cur?.log ?? [])].slice(0, 50),
        }),
      })
      return res
    },
    onSuccess: (res) => {
      if (res.fired.length) {
        qc.invalidateQueries({ queryKey: ['plane', 'issues', slug, projectId] })
        qc.invalidateQueries({ queryKey: ['plane', 'plan-issues', slug, projectId] })
      }
    },
  })
}

export function toItemView(i: { id: string; state: string; priority: string; labels: string[]; assignees: string[]; target_date?: string | null }): ItemView {
  return { id: i.id, state: i.state, priority: i.priority, labels: [...i.labels], assignees: [...i.assignees], target_date: i.target_date ?? null }
}

/**
 * Pull-request automation: read recent pull requests of the repositories the
 * project watches in Gitea, find work item keys (`CON-42`) in their titles,
 * branches and bodies, and run the `pr-merged` / `pr-opened` rules once per
 * PR. Runs when someone presses "Sync now" — the console has no background
 * worker for this.
 */
export function useGitSync(projectId?: string, identifier?: string) {
  const slug = usePlaneWorkspace()
  const doc = useAutomationDoc(projectId)
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const d = doc.data
      if (!d?.repos?.length) throw new Error('Pick at least one Gitea repository to watch.')
      if (!identifier) throw new Error('The project has no identifier.')
      const [issues, states] = await Promise.all([planning.listPlanIssues(slug, projectId!), planeClient.listStates(slug, projectId!)])
      const bySeq = new Map(issues.map((i) => [i.sequence_id, i]))
      const groupOf = (id: string) => states.find((s) => s.id === id)?.group
      const processed = new Set(d.processed ?? [])
      const log: NonNullable<AutomationDoc['log']> = []
      let applied = 0
      for (const full of d.repos) {
        const [org, repo] = full.split('/')
        if (!org || !repo) continue
        const prs = await giteaClient.listPullRequests(org, repo, 'all')
        for (const pr of prs.slice(0, 50)) {
          const kind = pr.merged || pr.merged_at ? 'pr-merged' : pr.state === 'open' ? 'pr-opened' : null
          if (!kind) continue
          const pk = `${full}#${pr.number}:${kind}`
          if (processed.has(pk)) continue
          processed.add(pk)
          const keys = issueKeysIn(`${pr.title}\n${pr.head?.ref ?? ''}\n${pr.body ?? ''}`, [identifier])
          for (const k of keys) {
            const issue = bySeq.get(k.sequence)
            if (!issue) continue
            const view = toItemView(issue)
            const res = evaluateAutomation(d.rules, { kind, after: view, groupOf })
            if (!res.fired.length || !Object.keys(res.patch).length) continue
            await planning.patchIssue(slug, projectId!, issue.id, res.patch)
            applied++
            for (const f of res.fired) log.push({ at: new Date().toISOString(), rule: f.name, issue: issue.id, summary: `${full}#${pr.number} → ${Object.keys(res.patch).join(', ')}` })
          }
        }
      }
      await patchDoc<AutomationDoc>(KIND.automation, projectId!, (cur) => ({
        ...(cur ?? { rules: [] }),
        rules: cur?.rules ?? [],
        processed: [...processed].slice(-500),
        log: [...log, ...(cur?.log ?? [])].slice(0, 50),
      }))
      return { applied }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['define-store', KIND.automation, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'plan-issues', slug, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'issues', slug, projectId] })
    },
  })
}

/* ───── notifications ───── */

/**
 * Emit an in-console notification for a planning event when the project's
 * preferences ask for it. Notifications are keyed, so repeating an event
 * does not stack copies.
 */
/** Notification keys already sent from this tab — views re-render often. */
const SENT = new Set<string>()

export function useDefineNotify(projectId?: string) {
  const meta = useProjectMeta(projectId)
  const qc = useQueryClient()
  return useCallback(
    (event: keyof Omit<NotificationPrefs, 'broadcast'>, input: { title: string; description?: string; key: string; href?: string }) => {
      const prefs: ProjectMeta['notifications'] = meta.data?.notifications
      if (!prefs?.[event] || SENT.has(input.key)) return
      SENT.add(input.key)
      // Same endpoint the shell's notification centre posts to.
      void fetch('/api/notifications', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...input, kind: 'info', source: 'workspace', broadcast: !!prefs.broadcast }),
        keepalive: true,
      })
        .then(() => qc.invalidateQueries({ queryKey: ['notifications', 'feed'] }))
        .catch(() => undefined)
    },
    [meta.data, qc],
  )
}
