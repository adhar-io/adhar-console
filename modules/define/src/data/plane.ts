import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { plane } from '@adhar/api-clients'
import { usePlaneWorkspace, useToolPublicUrl } from '@adhar/shell-ui'

/**
 * Plane.so client + per-resource hooks for the Define module.
 *
 * The hook layer hides Plane's `(workspaceSlug, projectId)` ergonomics: every
 * hook reads the active project from `useActiveProject()` and skips the query
 * when nothing's selected. Pass an explicit `projectId` to override.
 *
 * Calls go through the console's BFF proxy (`/api/svc/plane/…`), which
 * injects the platform's Plane API key and shares reads for a few seconds so
 * every console user together stays inside Plane's per-key rate limit.
 *
 * Plane's public API has no Pages or Views endpoints: Pages open in Plane
 * itself (see `usePlaneLink`), and saved views are kept by the console in the
 * signed-in user's preferences.
 */

export const planeClient = plane.PlaneClient.auto({ tool: 'plane' })

/**
 * The Plane workspace slug is RUNTIME configuration — `/api/config.planeWorkspace`
 * (PLANE_WORKSPACE / PLANE_WORKSPACE_SLUG, defaulting to the Gitea org) — never a
 * hardcoded company. Every hook below reads it through usePlaneWorkspace(), so the
 * whole Define phase follows the real organization.
 */

// Console policy: Plane data is re-read at most once a minute (the whole console
// shares one 60-a-minute API key); writes invalidate what they touch instead.
const REFRESH_MS = 60_000

/* ───── selection state ───── */

export const ACTIVE_PROJECT_KEY = 'adhar.define.activeProject'

export function getStoredProjectId(): string | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return localStorage.getItem(ACTIVE_PROJECT_KEY) ?? undefined
}

export function setStoredProjectId(id: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(ACTIVE_PROJECT_KEY, id)
}

/* ───── queries ───── */

export function useProjects() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'projects', WORKSPACE_SLUG],
    queryFn: () => planeClient.listProjects(WORKSPACE_SLUG),
    staleTime: REFRESH_MS,
  })
}

export function useProject(id?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'project', WORKSPACE_SLUG, id],
    queryFn: () => planeClient.getProject(WORKSPACE_SLUG, id!),
    enabled: !!id,
    staleTime: REFRESH_MS,
  })
}

export function useStates(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'states', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listStates(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useLabels(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'labels', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listLabels(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useIssues(projectId?: string, params?: plane.IssueListParams) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId, params],
    queryFn: () => planeClient.listIssues(WORKSPACE_SLUG, projectId!, params),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useCycles(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listCycles(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useModules(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listModules(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

/**
 * A link into Plane's own UI for this workspace — `path` is appended after the
 * workspace slug, e.g. `projects/<id>/pages`. Empty when the console cannot
 * tell where Plane is published.
 */
export function usePlaneLink(path = ''): string {
  const base = useToolPublicUrl('plane')
  const slug = usePlaneWorkspace()
  if (!base) return ''
  return `${base}/${slug}/${path.replace(/^\/+/, '')}`
}

export function useMembers() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'members', WORKSPACE_SLUG],
    queryFn: () => planeClient.listMembers(WORKSPACE_SLUG),
    staleTime: REFRESH_MS,
  })
}

export function useIssue(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'issue', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.getIssue(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

export function useComments(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'comments', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listComments(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

export function useActivities(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'activities', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listActivities(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

export function useSubIssues(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'sub-issues', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listSubIssues(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}

/* ───── mutations ───── */

export function useUpdateIssue(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      patch,
      current,
    }: {
      id: string
      patch: Partial<plane.Issue>
      /** The issue as last read — needed to move it out of its old cycle or module. */
      current?: Pick<plane.Issue, 'cycle' | 'module'>
    }) => planeClient.updateIssue(WORKSPACE_SLUG, projectId!, id, patch, current),
    onSuccess: (issue) => {
      qc.invalidateQueries({ queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'issue', WORKSPACE_SLUG, projectId, issue.id] })
      qc.invalidateQueries({ queryKey: ['plane', 'activities', WORKSPACE_SLUG, projectId, issue.id] })
    },
  })
}

export function useCreateIssue(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Issue>) =>
      planeClient.createIssue(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] })
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] })
    },
  })
}

export function useDeleteIssue(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteIssue(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plane', 'issues', WORKSPACE_SLUG, projectId] })
    },
  })
}

/* ───── workspace + project mutations ───── */

export function useCreateProject() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Project>) => planeClient.createProject(WORKSPACE_SLUG, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'projects', WORKSPACE_SLUG] }),
  })
}

export function useUpdateProject() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<plane.Project> }) =>
      planeClient.updateProject(WORKSPACE_SLUG, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'projects', WORKSPACE_SLUG] }),
  })
}

export function useDeleteProject() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteProject(WORKSPACE_SLUG, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plane', 'projects', WORKSPACE_SLUG] }),
  })
}

/* ───── cycle / module / view mutations ───── */

export function useCreateCycle(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Cycle>) =>
      planeClient.createCycle(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] }),
  })
}
export function useDeleteCycle(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteCycle(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'cycles', WORKSPACE_SLUG, projectId] }),
  })
}

export function useCreateModule(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<plane.Module>) =>
      planeClient.createModule(WORKSPACE_SLUG, projectId!, body),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] }),
  })
}
export function useDeleteModule(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => planeClient.deleteModule(WORKSPACE_SLUG, projectId!, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'modules', WORKSPACE_SLUG, projectId] }),
  })
}

/* ───── saved views (console-side; Plane's API has none) ───── */

/**
 * Saved issue views live in the signed-in user's console preferences
 * (`/api/prefs/define-views`), keyed by Plane workspace and project. Plane's
 * public API exposes no views endpoint, so this is the only place a view
 * saved from the console can be kept.
 */
const VIEWS_SCOPE = 'define-views'
type ViewStore = Record<string, plane.View[]>

async function readViewStore(): Promise<ViewStore> {
  const res = await fetch(`/api/prefs/${VIEWS_SCOPE}`, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`Couldn't load saved views (${res.status})`)
  const body = (await res.json()) as { data?: { views?: ViewStore } | null }
  return body.data?.views ?? {}
}

async function writeViewStore(views: ViewStore): Promise<void> {
  const res = await fetch(`/api/prefs/${VIEWS_SCOPE}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { views } }),
  })
  if (!res.ok) throw new Error(`Couldn't save the view (${res.status})`)
  const body = (await res.json().catch(() => ({}))) as { persisted?: boolean }
  if (body.persisted === false) throw new Error('Saved views need the console database, which is not configured.')
}

const viewKey = (slug: string, projectId: string) => `${slug}/${projectId}`

export function useViews(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'views', WORKSPACE_SLUG, projectId],
    queryFn: async () => (await readViewStore())[viewKey(WORKSPACE_SLUG, projectId!)] ?? [],
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}

export function useCreateView(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: Partial<plane.View>) => {
      const store = await readViewStore()
      const key = viewKey(WORKSPACE_SLUG, projectId!)
      const view: plane.View = {
        id: `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: body.name?.trim() || 'Untitled view',
        description: body.description,
        query_data: body.query_data ?? {},
        access: 'private',
        project: projectId!,
        workspace: WORKSPACE_SLUG,
        created_at: new Date().toISOString(),
      }
      await writeViewStore({ ...store, [key]: [...(store[key] ?? []), view] })
      return view
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'views', WORKSPACE_SLUG, projectId] }),
  })
}

export function useDeleteView(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const store = await readViewStore()
      const key = viewKey(WORKSPACE_SLUG, projectId!)
      await writeViewStore({ ...store, [key]: (store[key] ?? []).filter((v) => v.id !== id) })
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['plane', 'views', WORKSPACE_SLUG, projectId] }),
  })
}

export function useCreateComment(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { comment_html: string }) =>
      planeClient.createComment(WORKSPACE_SLUG, projectId!, issueId!, body),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ['plane', 'comments', WORKSPACE_SLUG, projectId, issueId],
      })
    },
  })
}

/* ───── lookup helpers ───── */

export function memberDisplayName(m?: plane.Member): string {
  if (!m) return 'Unknown'
  return m.member?.display_name ?? m.display_name ?? m.member?.email ?? m.email ?? '—'
}

export function memberInitials(m?: plane.Member): string {
  const name = memberDisplayName(m)
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/** Plane workspace roles: 20 Admin, 15 Member, 5 Guest. */
export const ROLE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: plane.PLANE_ROLE.ADMIN, label: 'Admin' },
  { value: plane.PLANE_ROLE.MEMBER, label: 'Member' },
  { value: plane.PLANE_ROLE.GUEST, label: 'Guest' },
]

/** A role is not a status: neutral pills, Admin set apart (never the red "failed" ✕). */
export function rolePill(role: number): { label: string; tone: 'info' | 'unknown' } {
  switch (role) {
    case plane.PLANE_ROLE.ADMIN:
      return { label: 'Admin', tone: 'info' }
    case plane.PLANE_ROLE.MEMBER:
      return { label: 'Member', tone: 'unknown' }
    case plane.PLANE_ROLE.GUEST:
      return { label: 'Guest', tone: 'unknown' }
    default:
      return { label: `role ${role}`, tone: 'unknown' }
  }
}

/* Friendly mapping from Plane priority → StatusBadge kind. */
export function priorityKind(p: plane.Priority): 'failed' | 'degraded' | 'progressing' | 'info' | 'unknown' {
  switch (p) {
    case 'urgent':
      return 'failed'
    case 'high':
      return 'degraded'
    case 'medium':
      return 'progressing'
    case 'low':
      return 'info'
    default:
      return 'unknown'
  }
}

/* Friendly mapping from state group → StatusBadge kind. */
export function stateGroupKind(g: plane.StateGroup): 'unknown' | 'info' | 'progressing' | 'healthy' | 'failed' {
  switch (g) {
    case 'backlog':
      return 'unknown'
    case 'unstarted':
      return 'info'
    case 'started':
      return 'progressing'
    case 'completed':
      return 'healthy'
    case 'cancelled':
      return 'failed'
  }
}

/* ───── errors ───── */

export { planeError } from './plane-error.ts'

/* ───── triage, links, relations, search, workflow, lifecycle, stickies ───── */

/**
 * A Plane mutation bound to the workspace slug that refreshes the listed
 * query-key prefixes (`['plane', part, slug, ...rest]`) when it succeeds.
 */
function usePlaneMutation<V, R = unknown>(
  fn: (slug: string, v: V) => Promise<R>,
  keys: (v: V) => Array<unknown[]>,
) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: V) => fn(WORKSPACE_SLUG, v),
    onSuccess: (_r, v) => {
      for (const [part, ...rest] of keys(v)) qc.invalidateQueries({ queryKey: ['plane', part, WORKSPACE_SLUG, ...rest] })
    },
  })
}

export function useIntake(projectId?: string, status?: plane.IntakeStatus) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'intake', WORKSPACE_SLUG, projectId, status ?? 'all'],
    queryFn: () => planeClient.listIntake(WORKSPACE_SLUG, projectId!, status),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}
export function useCreateIntake(projectId?: string) {
  return usePlaneMutation(
    (slug, issue: { name: string; description_html?: string; priority?: plane.Priority }) => planeClient.createIntake(slug, projectId!, issue),
    () => [['intake', projectId], ['summary', projectId]],
  )
}
export function useUpdateIntake(projectId?: string) {
  return usePlaneMutation(
    (slug, v: { issue: string; patch: Parameters<plane.PlaneClient['updateIntake']>[3] }) => planeClient.updateIntake(slug, projectId!, v.issue, v.patch),
    () => [['intake', projectId], ['issues', projectId], ['summary', projectId]],
  )
}
export function useDeleteIntake(projectId?: string) {
  return usePlaneMutation((slug, issue: string) => planeClient.deleteIntake(slug, projectId!, issue), () => [['intake', projectId], ['summary', projectId]])
}

export function useLinks(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'links', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listLinks(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
  })
}
export function useCreateLink(projectId?: string, issueId?: string) {
  return usePlaneMutation(
    (slug, body: { url: string; title?: string }) => planeClient.createLink(slug, projectId!, issueId!, body),
    () => [['links', projectId, issueId], ['activities', projectId, issueId]],
  )
}
export function useDeleteLink(projectId?: string, issueId?: string) {
  return usePlaneMutation((slug, link: string) => planeClient.deleteLink(slug, projectId!, issueId!, link), () => [['links', projectId, issueId]])
}

export function useRelations(projectId?: string, issueId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'relations', WORKSPACE_SLUG, projectId, issueId],
    queryFn: () => planeClient.listRelations(WORKSPACE_SLUG, projectId!, issueId!),
    enabled: !!projectId && !!issueId,
    staleTime: REFRESH_MS,
    retry: false,
  })
}
export function useCreateRelation(projectId?: string, issueId?: string) {
  return usePlaneMutation(
    (slug, v: { type: plane.RelationType; issues: string[] }) => planeClient.createRelation(slug, projectId!, issueId!, v.type, v.issues),
    // Relations show on both issues, so refresh every relation view.
    () => [['relations'], ['activities', projectId, issueId]],
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Workspace search by title, number or `KEY-123`; empty until two characters. */
export function useIssueSearch(query: string, opts?: { project?: string; limit?: number }) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  // Debounced: a search box must not spend one of the shared key's 60
  // requests a minute on every keystroke.
  const q = useDebounced(query.trim(), 300)
  return useQuery({
    queryKey: ['plane', 'search', WORKSPACE_SLUG, q, opts?.project ?? '*', opts?.limit ?? 10],
    queryFn: () => planeClient.searchIssues(WORKSPACE_SLUG, q, opts),
    enabled: q.length >= 2,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  })
}

export function useProjectSummary(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'summary', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.getProjectSummary(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
    retry: false,
  })
}
export function useArchiveProject() {
  return usePlaneMutation(
    (slug, v: { id: string; archive: boolean }) =>
      v.archive ? planeClient.archiveProject(slug, v.id) : planeClient.unarchiveProject(slug, v.id),
    (v) => [['projects'], ['project', v.id]],
  )
}
export function useProjectMembers(projectId?: string) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'project-members', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listProjectMembers(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId,
    staleTime: REFRESH_MS,
  })
}
export function useAddProjectMember(projectId?: string) {
  return usePlaneMutation(
    (slug, v: { member: string; role: number }) => planeClient.addProjectMember(slug, projectId!, v.member, v.role),
    () => [['project-members', projectId], ['summary', projectId]],
  )
}

export function useStateMutations(projectId?: string) {
  const keys = () => [['states', projectId], ['summary', projectId]]
  return {
    create: usePlaneMutation((slug, body: Parameters<plane.PlaneClient['createState']>[2]) => planeClient.createState(slug, projectId!, body), keys),
    update: usePlaneMutation(
      (slug, v: { id: string; patch: Parameters<plane.PlaneClient['updateState']>[3] }) => planeClient.updateState(slug, projectId!, v.id, v.patch),
      keys,
    ),
    remove: usePlaneMutation((slug, id: string) => planeClient.deleteState(slug, projectId!, id), keys),
  }
}
export function useLabelMutations(projectId?: string) {
  const keys = () => [['labels', projectId], ['summary', projectId]]
  return {
    create: usePlaneMutation((slug, body: Parameters<plane.PlaneClient['createLabel']>[2]) => planeClient.createLabel(slug, projectId!, body), keys),
    update: usePlaneMutation(
      (slug, v: { id: string; patch: Parameters<plane.PlaneClient['updateLabel']>[3] }) => planeClient.updateLabel(slug, projectId!, v.id, v.patch),
      keys,
    ),
    remove: usePlaneMutation((slug, id: string) => planeClient.deleteLabel(slug, projectId!, id), keys),
  }
}

export function useArchivedCycles(projectId?: string, enabled = true) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'archived-cycles', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listArchivedCycles(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId && enabled,
    staleTime: REFRESH_MS,
  })
}
export function useCycleLifecycle(projectId?: string) {
  const keys = () => [['cycles', projectId], ['archived-cycles', projectId], ['issues', projectId]]
  return {
    transfer: usePlaneMutation((slug, v: { from: string; to: string }) => planeClient.transferCycleIssues(slug, projectId!, v.from, v.to), keys),
    archive: usePlaneMutation((slug, id: string) => planeClient.archiveCycle(slug, projectId!, id), keys),
    unarchive: usePlaneMutation((slug, id: string) => planeClient.unarchiveCycle(slug, projectId!, id), keys),
  }
}
export function useArchivedModules(projectId?: string, enabled = true) {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'archived-modules', WORKSPACE_SLUG, projectId],
    queryFn: () => planeClient.listArchivedModules(WORKSPACE_SLUG, projectId!),
    enabled: !!projectId && enabled,
    staleTime: REFRESH_MS,
  })
}
export function useModuleLifecycle(projectId?: string) {
  const keys = () => [['modules', projectId], ['archived-modules', projectId]]
  return {
    archive: usePlaneMutation((slug, id: string) => planeClient.archiveModule(slug, projectId!, id), keys),
    unarchive: usePlaneMutation((slug, id: string) => planeClient.unarchiveModule(slug, projectId!, id), keys),
  }
}

export function useStickies() {
  const WORKSPACE_SLUG = usePlaneWorkspace()
  return useQuery({
    queryKey: ['plane', 'stickies', WORKSPACE_SLUG],
    queryFn: () => planeClient.listStickies(WORKSPACE_SLUG),
    staleTime: REFRESH_MS,
    retry: false,
  })
}
export function useStickyMutations() {
  const keys = () => [['stickies']]
  return {
    create: usePlaneMutation((slug, body: Partial<plane.Sticky>) => planeClient.createSticky(slug, body), keys),
    update: usePlaneMutation((slug, v: { id: string; patch: Partial<plane.Sticky> }) => planeClient.updateSticky(slug, v.id, v.patch), keys),
    remove: usePlaneMutation((slug, id: string) => planeClient.deleteSticky(slug, id), keys),
  }
}
