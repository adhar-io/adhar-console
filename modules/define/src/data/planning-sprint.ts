import { useEffect, useMemo, useRef } from 'react'
import type { plane } from '@adhar/api-clients'
import { burnSeries, type Metric, pointsOf, sprintOutcome, sprintStatus, velocity, wallDay, wallItems, wallNow, type WorkItem } from './planning-model.ts'
import { toWorkItem, useCycleIssueIds, useCyclesIssueIds, usePlanIssues, useSnapshotRecorder } from './planning-plane.ts'
import { useIssuePoints, useProjectMeta, useSprintMeta, useSprintMetas, useWorkSprintDoc } from './planning-store.ts'

/**
 * Everything a sprint view needs, assembled: its work items (Plane cycle
 * membership × the project's work items), the console-side meta (goal,
 * capacity, snapshots, commitment, retro), recorded points, the burn series
 * and the committed/completed outcome.
 */
export function useSprintData(projectId: string | undefined, cycle: plane.Cycle | undefined, metricOverride?: Metric) {
  const ids = useCycleIssueIds(projectId, cycle?.id)
  const issues = usePlanIssues(projectId)
  const meta = useSprintMeta(cycle?.id)
  const workDoc = useWorkSprintDoc(cycle?.id)
  const pts = useIssuePoints(projectId)
  const pmeta = useProjectMeta(projectId)

  const byId = useMemo(() => new Map((issues.data ?? []).map((i) => [i.id, i])), [issues.data])
  const plan = useMemo(() => (ids.data ?? []).map((id) => byId.get(id)).filter((i): i is plane.PlanIssue => !!i), [ids.data, byId])
  const items: WorkItem[] = useMemo(() => plan.map(toWorkItem), [plan])
  const hasPoints = useMemo(() => items.some((i) => pointsOf(i, pts.points) !== null), [items, pts.points])
  const metric: Metric = metricOverride ?? meta.data?.metric ?? (hasPoints ? 'points' : 'issues')

  const burn = useMemo(
    // Days are the viewer's calendar days (see wallNow in planning-model).
    () => (cycle ? burnSeries({ start: wallDay(cycle.start_date), end: wallDay(cycle.end_date), items: wallItems(items), snapshots: meta.data?.snapshots, metric, points: pts.points, now: wallNow() }) : null),
    [cycle, items, meta.data?.snapshots, metric, pts.points],
  )
  const outcome = useMemo(
    () =>
      cycle
        ? sprintOutcome({
          id: cycle.id,
          name: cycle.name,
          start: wallDay(cycle.start_date),
          end: wallDay(cycle.end_date),
          items: wallItems(items),
          snapshots: meta.data?.snapshots,
          commitment: meta.data?.commitment,
          metric,
          points: pts.points,
          now: wallNow(),
        })
        : null,
    [cycle, items, meta.data?.snapshots, meta.data?.commitment, metric, pts.points],
  )
  const status = cycle ? sprintStatus(cycle) : 'draft'

  // A running sprint records today's contents once per change per day.
  const record = useSnapshotRecorder()
  const recorded = useRef('')
  useEffect(() => {
    if (!cycle || !projectId || status !== 'active') return
    if (!ids.data || !issues.data || meta.isLoading || meta.isError || pts.isLoading) return
    const sig = `${cycle.id}:${items.map((i) => `${i.id}${i.state_group}`).join(',')}`
    if (recorded.current === sig) return
    recorded.current = sig
    record({ cycleId: cycle.id, projectId, meta: meta.data, items, points: pts.points })
  }, [cycle, projectId, status, ids.data, issues.data, meta.isLoading, meta.isError, meta.data, pts.isLoading, pts.points, items, record])

  return {
    ids,
    issues,
    meta,
    /** Goal from sprint planning, else the one the work-item views recorded. */
    goal: meta.data?.goal ?? workDoc.data?.goal,
    points: pts.points,
    pointsQuery: pts,
    scale: pmeta.data?.estimate,
    sprintDays: pmeta.data?.sprintDays ?? 14,
    plan,
    items,
    metric,
    hasPoints,
    burn,
    outcome,
    status,
    loading: ids.isLoading || issues.isLoading,
    error: ids.error ?? issues.error ?? null,
  }
}

/**
 * Committed vs completed for the last `limit` finished sprints — one Plane
 * call per sprint for its membership (shared cache), the rest from the
 * project's work items and the console's snapshots.
 */
export function useVelocityData(projectId: string | undefined, cycles: plane.Cycle[] | undefined, metric: Metric, limit = 8) {
  const finished = useMemo(
    () =>
      (cycles ?? [])
        .filter((c) => sprintStatus(c) === 'completed')
        .sort((a, b) => (a.end_date ?? '').localeCompare(b.end_date ?? ''))
        .slice(-limit),
    [cycles, limit],
  )
  const ids = useCyclesIssueIds(projectId, finished.map((c) => c.id))
  const issues = usePlanIssues(projectId)
  const metas = useSprintMetas()
  const pts = useIssuePoints(projectId)
  const outcomes = useMemo(() => {
    const byId = new Map((issues.data ?? []).map((i) => [i.id, toWorkItem(i)]))
    const metaBy = new Map((metas.data ?? []).map((d) => [d.id, d.data]))
    return finished
      .filter((c) => ids.ids.get(c.id))
      .map((c) => {
        const items = (ids.ids.get(c.id) ?? []).map((id) => byId.get(id)).filter((i): i is WorkItem => !!i)
        const m = metaBy.get(c.id)
        return sprintOutcome({ id: c.id, name: c.name, start: wallDay(c.start_date), end: wallDay(c.end_date), items: wallItems(items), snapshots: m?.snapshots, commitment: m?.commitment, metric, points: pts.points, now: wallNow() })
      })
  }, [finished, ids.ids, issues.data, metas.data, metric, pts.points])
  return { finished, outcomes, velocity: velocity(outcomes), loading: ids.loading || issues.isLoading, error: ids.error ?? issues.error ?? null }
}
