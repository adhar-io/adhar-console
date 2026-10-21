import { createContext, useCallback, useContext, useMemo, useRef } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { docStore } from '@adhar/shell-ui'
import { usePlaneWorkspace } from '@adhar/shell-ui'
import { planning, toItemView } from './planning-plane.ts'
import { type AutomationDoc, KIND, patchDoc } from './planning-store.ts'
import { checkTransition, evaluateAutomation, type ItemView, type TransitionCheck, type WorkflowRules } from './planning-workflow.ts'
import type { StateGroup } from './planning-model.ts'

/**
 * Agent B's workflow rules and automation, applied to the work-item surfaces
 * (Issues, Board, Backlog, drawer, bulk edit) — for every project in scope,
 * not just the page's own. Reads the same documents (`define.workflow`,
 * `define.automation`, cache keys shared with `useStoreDoc`) and the same pure
 * functions as `useTransitionGuard` / `useRunAutomation`, so a rule behaves
 * identically wherever an item is moved.
 *
 * Automation PATCHes go through one queue spaced 3 s apart (≤ 20 a minute),
 * so a bulk edit's follow-up rules never take more than a third of the
 * console's shared 60-requests-a-minute Plane budget.
 */

type StateInfo = { id: string; name: string; group: string; project: string }

const AUTOMATION_GAP_MS = 3_000
let chain: Promise<unknown> = Promise.resolve()
let lastRun = 0
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastRun + AUTOMATION_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastRun = Date.now()
    return fn()
  })
  chain = run.catch(() => undefined)
  return run
}

export interface WorkRules {
  /** Whether a project enforces transition rules. */
  enforcing(projectId: string): boolean
  /** B's transition check for an item moving to `to`. */
  check(item: { project: string; state: string; assignees?: string[] }, to: string): TransitionCheck
  /** Run automation once for an item after a successful Plane write. */
  automate(kind: 'created' | 'updated', before: ItemView | undefined, after: ItemView & { project: string }): void
  /** Console story points (`define.points`, Agent B's store) for an item. */
  pointsOf(item: { id: string; project: string }): number | undefined
  /** Record / clear console story points. */
  setPoints(item: { id: string; project: string }, points: number | null): Promise<void>
}

export function useWorkRules(projectIds: string[], states: StateInfo[]): WorkRules {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  const ids = [...new Set(projectIds.filter(Boolean))]
  const doc = <T,>(kind: string, id: string) => ({
    queryKey: ['define-store', kind, id],
    queryFn: async () => (await docStore.get<T>(kind, id))?.data ?? null,
    staleTime: 30_000,
    retry: false,
  })
  const workflows = useQueries({ queries: ids.map((p) => doc<WorkflowRules>(KIND.workflow, p)) })
  const automations = useQueries({ queries: ids.map((p) => doc<AutomationDoc>(KIND.automation, p)) })
  const pointDocs = useQueries({ queries: ids.map((p) => doc<{ points: Record<string, number> }>(KIND.points, p)) })
  const stamp = [...workflows, ...automations, ...pointDocs].map((q) => q.dataUpdatedAt).join(',')
  const byProject = useMemo(() => {
    const m = new Map<string, { rules: WorkflowRules | null; auto: AutomationDoc | null; points: Record<string, number> }>()
    ids.forEach((p, i) => m.set(p, {
      rules: (workflows[i]?.data as WorkflowRules | null) ?? null,
      auto: (automations[i]?.data as AutomationDoc | null) ?? null,
      points: ((pointDocs[i]?.data as { points?: Record<string, number> } | null)?.points) ?? {},
    }))
    return m
  }, [stamp, ids.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
  const statesRef = useRef(states)
  statesRef.current = states

  const check = useCallback((item: { project: string; state: string; assignees?: string[] }, to: string) => {
    const rules = byProject.get(item.project)?.rules
    const name = (id: string) => statesRef.current.find((s) => s.id === id)?.name ?? 'that state'
    return checkTransition(rules, item.state, to, item, name)
  }, [byProject])

  const automate = useCallback((kind: 'created' | 'updated', before: ItemView | undefined, after: ItemView & { project: string }) => {
    const auto = byProject.get(after.project)?.auto
    if (!auto?.rules?.some((r) => r.enabled)) return
    const groupOf = (id: string) => statesRef.current.find((s) => s.id === id)?.group as StateGroup | undefined
    const res = evaluateAutomation(auto.rules, { kind, before, after: toItemView(after), groupOf })
    if (!res.fired.length || !Object.keys(res.patch).length) return
    void enqueue(async () => {
      await planning.patchIssue(slug, after.project, after.id, res.patch)
      const at = new Date().toISOString()
      await patchDoc<AutomationDoc>(KIND.automation, after.project, (cur) => ({
        ...(cur ?? { rules: [] }),
        rules: cur?.rules ?? [],
        log: [...res.fired.map((f) => ({ at, rule: f.name, issue: after.id, summary: Object.keys(res.patch).join(', ') })), ...(cur?.log ?? [])].slice(0, 50),
      }))
      qc.invalidateQueries({ queryKey: ['plane', 'issues', slug, after.project] })
      qc.invalidateQueries({ queryKey: ['plane', 'issues-lite', slug, after.project] })
      qc.invalidateQueries({ queryKey: ['define-store', KIND.automation, after.project] })
    }).catch(() => undefined)
  }, [byProject, slug, qc])

  const enforcing = useCallback((p: string) => !!byProject.get(p)?.rules?.enforce, [byProject])
  const pointsOf = useCallback((i: { id: string; project: string }) => byProject.get(i.project)?.points[i.id], [byProject])
  const setPoints = useCallback(async (i: { id: string; project: string }, points: number | null) => {
    const key = ['define-store', KIND.points, i.project]
    const apply = (cur: { points: Record<string, number> } | null) => {
      const next = { ...(cur?.points ?? {}) }
      if (points === null) delete next[i.id]
      else next[i.id] = points
      return { points: next }
    }
    const prev = qc.getQueryData<{ points: Record<string, number> } | null>(key)
    qc.setQueryData(key, apply(prev ?? null))
    try {
      await patchDoc<{ points: Record<string, number> }>(KIND.points, i.project, apply)
    } catch (e) {
      qc.setQueryData(key, prev)
      throw e
    } finally {
      qc.invalidateQueries({ queryKey: key })
    }
  }, [qc])
  return useMemo(() => ({ enforcing, check, automate, pointsOf, setPoints }), [enforcing, check, automate, pointsOf, setPoints])
}

const Ctx = createContext<WorkRules | null>(null)
/** Provide rules + points to the editors below (Issues, Board, Backlog, drawer). */
export const WorkRulesProvider = Ctx.Provider
export const useWorkRulesCtx = () => useContext(Ctx)

/** Estimate shown for an item: Plane's value when readable, else console story points. */
export function effectivePoints(i: { id: string; project: string; estimate_point?: number | null }, rules: WorkRules | null): { value?: number; source: 'plane' | 'console' | 'none' } {
  if (typeof i.estimate_point === 'number') return { value: i.estimate_point, source: 'plane' }
  const v = rules?.pointsOf(i)
  return typeof v === 'number' ? { value: v, source: 'console' } : { source: 'none' }
}

/** An item as automation sees it, with its project. */
export const viewOf = (i: { id: string; project: string; state: string; priority: string; labels: string[]; assignees: string[]; target_date?: string | null }) => ({ ...toItemView(i), project: i.project })

export type { ItemView }
