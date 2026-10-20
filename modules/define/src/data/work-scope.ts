import { useMemo } from 'react'
import type { plane } from '@adhar/api-clients'
import { useMembers, useProjects } from './plane.ts'
import { useQlContext, useScopeIssues, useScopeMeta, type WorkItem } from './work-hooks.ts'
import { compile, type Compiled, issueKey, type QlContext } from './work-ql.ts'

/**
 * One query scope for Issues and Board: which projects a WQL query needs,
 * their items and metadata, the compiled filter/sort, and id → record maps.
 */
export interface WorkScope {
  /** Items matching the query, sorted. */
  items: WorkItem[]
  /** Every loaded item in scope (for sub-task progress, parents, relations). */
  all: WorkItem[]
  compiled: Compiled
  ctx: QlContext
  primary?: string
  projectIds: string[]
  liteProjects: string[]
  isLoading: boolean
  isFetching: boolean
  errors: Array<{ projectId: string; error: unknown }>
  states: plane.State[]
  labels: plane.Label[]
  cycles: plane.Cycle[]
  modules: plane.Module[]
  members: plane.Member[]
  projects: plane.Project[]
  stateById: Map<string, plane.State>
  labelById: Map<string, plane.Label>
  memberById: Map<string, plane.Member>
  cycleById: Map<string, plane.Cycle>
  moduleById: Map<string, plane.Module>
  projectById: Map<string, plane.Project>
  itemById: Map<string, WorkItem>
  keyOf(i: Pick<WorkItem, 'project' | 'sequence_id'>): string
}

export function useWorkScope(projectId: string | undefined, jql: string, defaultOrder?: (a: WorkItem, b: WorkItem) => number): WorkScope {
  const projects = useProjects()
  const members = useMembers()
  const projectList = projects.data ?? []

  // Pass 1: which projects does the query name? (needs only the project list)
  const named = useMemo(() => {
    const c = compile(jql, { projects: projectList.map((p) => ({ id: p.id, identifier: p.identifier, name: p.name })), states: [], labels: [], members: [], cycles: [], modules: [] })
    return c.projectIds
  }, [jql, projectList])

  const primary = named ? (projectId && named.includes(projectId) ? projectId : named[0]) : projectId
  const others = named ? named.filter((p) => p !== primary) : []
  const projectIds = [primary, ...others].filter(Boolean) as string[]

  const loaded = useScopeIssues(primary, others)
  const meta = useScopeMeta(projectIds)
  const ctx = useQlContext(projectIds)

  const idByKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of loaded.issues) m.set(issueKey(i, ctx.projects), i.id)
    return m
  }, [loaded.issues, ctx.projects])

  const compiled = useMemo(() => compile(jql, { ...ctx, idByKey }), [jql, ctx, idByKey])

  const items = useMemo(() => {
    const out = loaded.issues.filter((i) => !i.archived_at && compiled.predicate(i))
    const hasOrder = /\border\s+by\b/i.test(jql)
    if (hasOrder) out.sort(compiled.compare)
    else if (defaultOrder) out.sort(defaultOrder)
    return out
  }, [loaded.issues, compiled, jql, defaultOrder])

  return useMemo(() => {
    const memberList = members.data ?? []
    return {
      items,
      all: loaded.issues,
      compiled,
      ctx,
      primary,
      projectIds,
      liteProjects: loaded.liteProjects,
      isLoading: loaded.isLoading || projects.isLoading,
      isFetching: loaded.isFetching,
      errors: loaded.errors,
      states: meta.states,
      labels: meta.labels,
      cycles: meta.cycles,
      modules: meta.modules,
      members: memberList,
      projects: projectList,
      stateById: new Map(meta.states.map((s) => [s.id, s])),
      labelById: new Map(meta.labels.map((l) => [l.id, l])),
      memberById: new Map(memberList.map((m) => [m.member?.id ?? m.id, m])),
      cycleById: new Map(meta.cycles.map((c) => [c.id, c])),
      moduleById: new Map(meta.modules.map((m) => [m.id, m])),
      projectById: new Map(projectList.map((p) => [p.id, p])),
      itemById: new Map(loaded.issues.map((i) => [i.id, i])),
      keyOf: (i: Pick<WorkItem, 'project' | 'sequence_id'>) => issueKey(i, ctx.projects),
    }
  }, [items, loaded, compiled, ctx, primary, projectIds.join(','), meta, members.data, projectList, projects.isLoading]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Default list order — most recently updated first. */
export const byUpdatedDesc = (a: WorkItem, b: WorkItem) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at)
