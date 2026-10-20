import { useCallback, useMemo } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { plane } from '@adhar/api-clients'
import { useIntegration, usePlaneWorkspace, useToolPublicUrl } from '@adhar/shell-ui'
import { KIND, useDoc, useUpsertDoc } from './store.ts'
import type { DesignSettings, PlaneLink } from './types.ts'
import { type IssueStatus, type PlaneDraft, statusOfGroup } from './plane-map.ts'

/**
 * Plane (work items) for the Design module — the same client and BFF proxy
 * the Define phase uses (`/api/svc/plane/…`, platform API key injected, reads
 * shared briefly so every console user together stays inside Plane's per-key
 * rate limit). Query keys match Define's (`['plane', part, slug, project]`),
 * so an item created here shows up there and vice versa.
 *
 * Which Plane project a Design scope files work into is a per-scope setting
 * (`design.settings`), defaulting to a Plane project whose name or identifier
 * matches the Adhar project — never a hard-coded one.
 */

export const planeClient = plane.PlaneClient.auto({ tool: 'plane' })
const STALE = 30_000

export function usePlaneEnabled(): boolean | undefined {
  return useIntegration('plane')
}

export function usePlaneProjects(enabled = true) {
  const slug = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'projects', slug],
    queryFn: () => planeClient.listProjects(slug),
    staleTime: STALE,
    enabled,
    retry: false,
  })
}

/** Pick the Plane project for an Adhar project: exact identifier/name/slug match first. */
export function guessPlaneProject(
  projects: Array<{ id: string; name: string; identifier: string }>,
  adhar: { slug?: string; name?: string } | undefined,
): string | undefined {
  if (!projects.length) return undefined
  if (adhar?.slug || adhar?.name) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const keys = [adhar.slug, adhar.name].filter(Boolean).map((s) => norm(s!))
    const hit = projects.find((p) => keys.includes(norm(p.identifier)) || keys.includes(norm(p.name)))
    if (hit) return hit.id
  }
  return projects.length === 1 ? projects[0].id : undefined
}

export interface PlaneTarget {
  enabled: boolean | undefined
  projects: plane.Project[]
  loading: boolean
  error: Error | null
  /** The chosen (or guessed) Plane project id. */
  projectId: string | undefined
  /** True when the id came from the stored setting, not a guess. */
  chosen: boolean
  setProjectId(id: string): Promise<void>
}

/** The Plane project a Design scope (project slug or workspace) files work into. */
export function usePlaneTarget(scope: { slug?: string; name?: string } | undefined): PlaneTarget {
  const enabled = usePlaneEnabled()
  const settingsId = scope?.slug || 'workspace'
  const settings = useDoc<DesignSettings>(KIND.settings, settingsId)
  const upsert = useUpsertDoc<DesignSettings>(KIND.settings, settingsId)
  const projects = usePlaneProjects(enabled !== false)
  const list = useMemo(() => projects.data ?? [], [projects.data])
  const stored = settings.data?.planeProjectId
  const valid = stored && list.some((p) => p.id === stored) ? stored : undefined
  const projectId = valid ?? guessPlaneProject(list, scope)
  const setProjectId = useCallback(async (id: string) => {
    await upsert.mutateAsync({ ...(settings.data ?? {}), planeProjectId: id })
  }, [upsert, settings.data])
  return {
    enabled,
    projects: list,
    loading: projects.isLoading || settings.isLoading,
    error: (projects.error as Error | null) ?? null,
    projectId,
    chosen: !!valid,
    setProjectId,
  }
}

export interface IssueInfo {
  id: string
  name: string
  key?: string
  status: IssueStatus
  stateName?: string
  stateColor?: string
  updatedAt?: string
  completedAt?: string | null
}

/**
 * Live state of linked work items: one issue list + one state list per Plane
 * project that has links (shared, cached reads), indexed by issue id. Items
 * that no longer exist in Plane are simply absent — the UI says "not found".
 */
export function usePlaneIssueIndex(links: PlaneLink[], enabled = true) {
  const slug = usePlaneWorkspace()
  const projectIds = useMemo(() => [...new Set(links.map((l) => l.projectId))].sort(), [links])
  const on = enabled && projectIds.length > 0
  const projectsQ = usePlaneProjects(on)
  const issues = useQueries({
    queries: projectIds.map((p) => ({
      queryKey: ['plane', 'issues', slug, p, undefined],
      queryFn: () => planeClient.listIssues(slug, p),
      staleTime: STALE,
      enabled: on,
      retry: false,
    })),
  })
  const states = useQueries({
    queries: projectIds.map((p) => ({
      queryKey: ['plane', 'states', slug, p],
      queryFn: () => planeClient.listStates(slug, p),
      staleTime: STALE,
      enabled: on,
      retry: false,
    })),
  })
  const loading = issues.some((q) => q.isLoading) || states.some((q) => q.isLoading)
  const error = (issues.find((q) => q.error)?.error ?? states.find((q) => q.error)?.error ?? null) as Error | null
  const stamp = issues.map((q) => q.dataUpdatedAt).join(',') + states.map((q) => q.dataUpdatedAt).join(',') + (projectsQ.dataUpdatedAt ?? 0)
  const index = useMemo(() => {
    const out = new Map<string, IssueInfo>()
    projectIds.forEach((p, i) => {
      const ident = projectsQ.data?.find((x) => x.id === p)?.identifier
      const st = new Map((states[i]?.data ?? []).map((s) => [s.id, s]))
      for (const it of issues[i]?.data ?? []) {
        const s = st.get(it.state)
        out.set(it.id, {
          id: it.id,
          name: it.name,
          key: ident && it.sequence_id != null ? `${ident}-${it.sequence_id}` : undefined,
          status: statusOfGroup(s?.group),
          stateName: s?.name,
          stateColor: s?.color,
          updatedAt: it.updated_at,
          completedAt: it.completed_at,
        })
      }
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, projectIds])
  return { index, loading, error }
}

/** A browser link to a work item in Plane's own UI ('' when Plane's URL is unknown). */
export function usePlaneItemUrl(): (link: Pick<PlaneLink, 'projectId' | 'issueId'>) => string {
  const base = useToolPublicUrl('plane')
  const slug = usePlaneWorkspace()
  return useCallback(
    (l) => (base ? `${base}/${slug}/projects/${l.projectId}/issues/${l.issueId}` : ''),
    [base, slug],
  )
}

export interface CreateResult {
  links: PlaneLink[]
  failed: Array<{ draft: PlaneDraft; error: string }>
}

/**
 * Create work items one by one (Plane's rate limit is shared — no burst),
 * optionally under a new parent item, and link each back to the Design
 * artifact. A failure on one item does not abort the rest; the caller reports
 * exactly what was and was not created.
 */
export function useCreateWorkItems() {
  const slug = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation<CreateResult, Error, { projectId: string; drafts: PlaneDraft[]; parent?: PlaneDraft; parentId?: string; backLink?: string }>({
    mutationFn: async ({ projectId, drafts, parent, parentId: existingParent, backLink }) => {
      const projects = qc.getQueryData<plane.Project[]>(['plane', 'projects', slug]) ?? []
      const ident = projects.find((p) => p.id === projectId)?.identifier
      const now = new Date().toISOString()
      const links: PlaneLink[] = []
      const failed: CreateResult['failed'] = []
      const make = async (d: PlaneDraft, parentId?: string): Promise<plane.Issue> => {
        const issue = await planeClient.createIssue(slug, projectId, {
          name: d.name,
          description_html: d.description_html,
          priority: d.priority,
          ...(parentId ? { parent: parentId } : {}),
        })
        if (backLink) {
          await planeClient.createLink(slug, projectId, issue.id, { url: backLink, title: 'Adhar Design' }).catch(() => undefined)
        }
        return issue
      }
      const toLink = (d: PlaneDraft, i: plane.Issue, isParent = false): PlaneLink => ({
        projectId,
        issueId: i.id,
        key: ident && i.sequence_id != null ? `${ident}-${i.sequence_id}` : undefined,
        name: i.name,
        source: d.source,
        createdAt: now,
        ...(isParent ? { parent: true } : {}),
      })
      let parentId: string | undefined = existingParent
      if (parent && !existingParent) {
        try {
          const p = await make(parent)
          parentId = p.id
          links.push(toLink(parent, p, true))
        } catch (e) {
          failed.push({ draft: parent, error: (e as Error).message })
        }
      }
      for (const d of drafts) {
        try {
          links.push(toLink(d, await make(d, parentId)))
        } catch (e) {
          failed.push({ draft: d, error: (e as Error).message })
        }
      }
      return { links, failed }
    },
    onSettled: (_r, _e, v) => {
      void qc.invalidateQueries({ queryKey: ['plane', 'issues', slug, v.projectId] })
    },
  })
}

/** Search Plane work items by name / `KEY-123` (to link an existing one). */
export function usePlaneSearch(query: string, projectId?: string) {
  const slug = usePlaneWorkspace()
  const q = query.trim()
  return useQuery({
    queryKey: ['plane', 'search', slug, projectId, q],
    queryFn: () => planeClient.searchIssues(slug, q, { project: projectId, limit: 8 }),
    enabled: q.length >= 2,
    staleTime: STALE,
    retry: false,
  })
}
